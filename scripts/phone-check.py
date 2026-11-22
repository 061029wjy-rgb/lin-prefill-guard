"""Touch/keyboard checks against an installed local SillyTavern, with no model endpoint."""
import argparse, json, os, shutil, socket, subprocess, tempfile, time, urllib.request
from pathlib import Path
from playwright.sync_api import sync_playwright

root = Path(__file__).resolve().parents[1]
st = Path(os.environ['LPG_ST_PATH']).resolve()
args = argparse.ArgumentParser()
args.add_argument('--old', type=Path, help='reproduce the three disabled selects on v1.4.0 instead')
args.add_argument('--out', type=Path, help='directory for optional screenshots and JSON evidence')
opt = args.parse_args()
plugin = opt.old.resolve() if opt.old else root
panel_id = '#lin-prefill-guard-panel'
key = 'lin_prefill_guard_v1'
seed = {'enabled':True, 'requestMode':'observe', 'scope':'lin','mode':'pair','reasoningMode':'keep'}
def free_port():
    with socket.socket() as s:
        s.bind(('127.0.0.1',0))
        return s.getsockname()[1]
def wait_for_host(url,proc):
    for _ in range(240):
        if proc.poll() is not None: raise RuntimeError('local ST stopped during startup')
        try:
            with urllib.request.urlopen(url,timeout=1):return
        except OSError:time.sleep(.25)
    raise RuntimeError('ST did not start')
def ready(page):
    page.wait_for_selector(panel_id,state='attached',timeout=55000)
    page.wait_for_function("!!window.SillyTavern?.getContext()?.extensionSettings?.lin_prefill_guard_v1")
    # A fresh ST profile can show its release notes or initial information dialog.
    for _ in range(3):
        opened=page.locator('dialog[open]').last
        if not opened.count():break
        heading=opened.inner_text()[:95].replace('\n',' ')
        if 'Initializing' in heading:
            opened.wait_for(state='hidden',timeout=35000);continue
        dismiss=opened.locator('.popup-button-ok:visible, .popup-button-close:visible')
        if dismiss.count():dismiss.first.tap()
        else:page.keyboard.press('Escape')
        opened.wait_for(state='hidden',timeout=6000)
    drawer = page.locator('#extensions-settings-button')
    if not page.locator('#rm_extensions_block').is_visible():
        drawer.locator('.drawer-toggle').tap(timeout=10000)
    page.locator(panel_id+' > summary').scroll_into_view_if_needed()
def scenario(page,reports,settings_file):
    p=page.locator(panel_id)
    settings=lambda:page.evaluate("()=>SillyTavern.getContext().extensionSettings.lin_prefill_guard_v1")
    assert settings()['requestMode']=='observe'
    if opt.old:
        for name in ('scope','mode','reasoningMode'):
            control=p.locator('[data-setting="'+name+'"]')
            control.scroll_into_view_if_needed()
            assert control.is_visible() and control.is_disabled(), name
            rect=control.bounding_box()
            page.touchscreen.tap(rect['x']+rect['width']/2,rect['y']+rect['height']/2)
        assert settings()['scope']=='lin' and settings()['mode']=='pair' and settings()['reasoningMode']=='keep'
        reports.append({'version':'1.4.0','mode':'observe','visibleButDisabled':['scope','mode','reasoningMode']})
        return
    verify_new(page,p,settings,reports,settings_file)

def verify_new(page,p,settings,reports,settings_file):
    def tab(code):
        button=p.locator('#lpg-tab-'+code)
        button.tap()
        assert button.get_attribute('aria-selected')=='true' and p.locator('#lpg-page-'+code).is_visible()
    def tap_choice(k,v):
        radio=p.locator('input[type=radio][data-setting="'+k+'"][value="'+v+'"]')
        label=p.locator('label[for="'+radio.get_attribute('id')+'"]')
        label.scroll_into_view_if_needed()
        rect=label.bounding_box();assert rect['height']>=44 and not radio.is_disabled()
        # Tap far from the radio itself; the entire labelled row must work.
        label.tap(position={'x':rect['width']*.74,'y':rect['height']/2})
        assert radio.is_checked() and settings()[k]==v
        return round(rect['height'],1)
    def wait_disk(vals):
        for _ in range(85):
            try:saved=json.loads(settings_file.read_text())['extension_settings'][key]
            except (KeyError,OSError,ValueError):saved={}
            if all(saved.get(k)==v for k,v in vals.items()):return
            page.wait_for_timeout(100)
        raise AssertionError('ST settings.json did not persist '+str(vals))
    def open_guide(k):
        # Expose any nested group via its summary; no programmatic opening or forced click.
        while True:
            closed=p.locator('details.lpg-advanced:not([open])').filter(has=page.locator('[data-guide="'+k+'"]'))
            if not closed.count():break
            closed.first.locator(':scope > summary').tap()
        guide=p.locator('[data-guide="'+k+'"]')
        summary=guide.locator('summary');summary.tap()
        assert guide.evaluate('d=>d.open')
        paragraphs=guide.locator('p')
        assert paragraphs.count()==2 and '实际例子' in paragraphs.last.inner_text()
        assert all(x.is_visible() for x in paragraphs.all())
        return summary
    tab('home')
    assert '只做诊断' in p.locator('.lpg-current').inner_text()
    assert p.get_by_role('tab').count()==4
    def defined_controls():
        return p.locator('[data-setting]').evaluate_all("xs=>[...new Set(xs.map(e=>e.dataset.setting))].sort()")
    names=defined_controls()
    guides=p.locator('[data-guide]').evaluate_all("xs=>xs.map(x=>x.dataset.guide).sort()")
    assert names==guides, (names,guides)
    # Navigation, opening all guides and reading instructions cannot change any plugin setting.
    original=settings()
    for name in ('home','exp','old','diag'):
        tab(name)
        all_keys=p.locator('#lpg-page-'+name+' [data-guide]').evaluate_all("a=>a.map(n=>n.dataset.guide)")
        for k in all_keys:open_guide(k).tap()
    assert settings()==original
    p.get_by_role('button',name='本地自检（不调用模型）').tap()
    assert '只做诊断' in p.locator('.lpg-selftest').inner_text()
    reports.append({'guideCount':len(guides),'tapOpenedGuideForEveryControl':True,'noSettingsChangedReadingHelp':True})
    tab('old')
    sizes={k:tap_choice(k,v) for k,v in [('scope','all'),('mode','user'),('reasoningMode','balanced')]}
    assert '仅保存备用' in p.locator('.lpg-legacy-info').inner_text() and '同一条用户消息' in p.locator('.lpg-choice-info-mode').inner_text()
    expected={'requestMode':'observe','scope':'all','mode':'user','reasoningMode':'balanced'}
    wait_disk(expected)
    page.reload(wait_until='domcontentloaded',timeout=90000);ready(page)
    assert p.locator('#lpg-tab-old').get_attribute('aria-selected')=='true'
    assert all(settings()[k]==v for k,v in expected.items())
    assert all(p.locator('[data-setting="'+k+'"][value="'+expected[k]+'"]').is_checked() for k in sizes)
    reports.append({'observeModeAfterTapAndReload':expected,'minRowHeightsCssPx':sizes})
    # Verify the touch target in both directions, and the example updates immediately.
    tap_choice('mode','pair')
    assert '① 助手消息' in p.locator('.lpg-choice-info-mode').inner_text()
    mode_help=open_guide('mode')
    if opt.out:
        p.locator('.lpg-setting').filter(has=page.locator('[data-guide="mode"]')).screenshot(path=str(opt.out/'lin-setting-example.png'))
    mode_help.tap()
    # Keyboard navigation stays inside the tablist and naturally focuses the selected tab.
    old=p.locator('#lpg-tab-old');old.focus();page.keyboard.press('ArrowRight')
    assert p.locator('#lpg-tab-diag').evaluate("n=>n===document.activeElement && n.getAttribute('aria-selected')==='true'")
    page.keyboard.press('Home');assert p.locator('#lpg-tab-home').get_attribute('aria-selected')=='true'
    # Use the current server settings exactly as the UI saved them. No configure action generates a reply.
    selector=p.locator('[data-setting=requestMode]');selector.select_option('enhance')
    tab('old')
    assert '已选择旧版承接增强' in p.locator('.lpg-legacy-info').inner_text()
    assert settings()['mode']=='pair'
    tab('home')
    p.locator('label[for=lpg-set-enabled]').tap()
    assert not settings()['enabled'] and '已关闭' in p.locator('.lpg-current').inner_text()
    tab('old'); assert '已关闭' in p.locator('.lpg-legacy-info').inner_text();tap_choice('scope','lin')
    tab('home');p.locator('label[for=lpg-set-enabled]').tap()
    # Seed a known family in the disposable real host, never on a user's ST data.
    pfile=os.environ.get('LIN290_PRESET')
    preset=json.loads(Path(pfile).read_text()) if pfile else {'name':'Lin 2.9.0','preset_settings_openai':'Lin 2.9.0'}
    page.evaluate("""p=>{const c=SillyTavern.getContext().chatCompletionSettings;Object.assign(c,p,{chat_completion_source:'vertexai',enable_web_search:true});}""",preset)
    fingerprint=page.evaluate("""async()=>{const c=SillyTavern.getContext().chatCompletionSettings;
       return [...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify([c.prompts,c.prompt_order,c.extensions,c.enable_web_search]))))].join(',');}""")
    tab('old')
    assert 'Lin 2.9.0' in p.locator('.lpg-legacy-info').inner_text() and '仅保存备用' in p.locator('.lpg-legacy-info').inner_text()
    tab('home');selector.select_option('gemini4')
    p.locator('label[for=lpg-set-compat290]').tap()
    tab('diag');p.get_by_role('button',name='本地自检（不调用模型）').tap()
    assert '没有勾选承接核对' in p.locator('.lpg-selftest').inner_text()
    tab('home');p.locator('label[for=lpg-set-compat290]').tap()
    tab('exp')
    assert '网页搜索' in p.locator('.lpg-experiment-info').inner_text()
    p.locator('label[for=lpg-set-macro]').tap()
    assert '4a81c27e' in p.locator('[data-effect=macro]').inner_text()
    if not p.locator('[data-setting=macroGroups]').is_visible():
        p.locator('.lpg-advanced').filter(has=page.locator('[data-setting=macroGroups]')).locator(':scope > summary').tap()
    p.locator('[data-setting=macroGroups]').select_option('3')
    assert '只调用一次' in p.locator('[data-effect=macroGroups]').inner_text()
    p.locator('button').filter(has_text='关闭全部新实验').tap()
    assert not settings()['macro'] and settings()['shield']=='off' and not settings()['passiveOutput']
    assert '关：' in p.locator('[data-effect=macro]').inner_text()
    after=page.evaluate("""async()=>{const c=SillyTavern.getContext().chatCompletionSettings;
        return [...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify([c.prompts,c.prompt_order,c.extensions,c.enable_web_search]))))].join(',');}""")
    assert fingerprint==after
    reports.append({'checkedPreset':'supplied Lin 2.9.0' if pfile else 'named test family','presetAndSearchUnchanged':True,
                    'disabledPluginStillEditable':True,'keyboardTabs':True,'switchAndResetFeedback':True,'selfTestMatchesModeAndToggle':True})
    widths=[]
    for width in (320,375,430,1024):
        page.set_viewport_size({'width':width,'height':812})
        for name in ('home','exp','old','diag'):
            tab(name)
            measurements=p.evaluate("""e=>({w:e.clientWidth,sw:e.scrollWidth,tw:[...e.querySelectorAll('.lpg-tab')].map(b=>b.getBoundingClientRect().height)})""")
            assert 0<measurements['w'] and measurements['sw']<=measurements['w']+1, (width,name,measurements)
            assert min(measurements['tw'])>=44,(width,name,measurements)
        widths.append(width)
    reports.append({'noPanelOverflowAtCssViewportWidths':widths,'tabMinCssPx':44})
    if opt.out:
        page.set_viewport_size({'width':375,'height':812});tab('home')
        page.locator(panel_id+' > summary').evaluate("n=>n.scrollIntoView({block:'start',behavior:'instant'})")
        page.screenshot(path=str(opt.out/'lin-mobile-home.png'))

def main():
    results=[]
    if opt.out:opt.out.mkdir(parents=True,exist_ok=True)
    with tempfile.TemporaryDirectory() as td:
        t=Path(td);user=t/'data/default-user';ext=user/'extensions/lin-prefill-guard';ext.mkdir(parents=True)
        for f in [*plugin.glob('*.js'),plugin/'style.css',plugin/'manifest.json']:shutil.copy2(f,ext/f.name)
        conf=t/'config.yaml';shutil.copy2(st/'default/config.yaml',conf)
        data=json.loads((st/'default/content/settings.json').read_text())
        data['firstRun']=False;data.setdefault('extension_settings',{})[key]=seed
        (user/'settings.json').write_text(json.dumps(data))
        port=free_port();url=f'http://127.0.0.1:{port}'
        with (t/'server.log').open('w') as log:
            proc=subprocess.Popen(['node','server.js','--port',str(port),'--listen','false','--enableIPv4','true','--enableIPv6','false','--browserLaunchEnabled','false','--configPath',str(conf),'--dataRoot',str(t/'data')],cwd=st,stdout=log,stderr=subprocess.STDOUT)
            try:
                wait_for_host(url,proc)
                with sync_playwright() as pw:
                    browser=pw.chromium.launch(executable_path=os.environ.get('CHROMIUM') or shutil.which('chromium'),headless=True,args=['--no-sandbox','--disable-dev-shm-usage','--disable-gpu',*os.environ.get('LPG_CHROME_FLAGS','').split()])
                    page=browser.new_page(viewport={'width':375,'height':812},has_touch=True,is_mobile=True,device_scale_factor=2)
                    generation=[]
                    def restricted(route):
                        if route.request.url.endswith('/api/backends/chat-completions/generate'):
                            generation.append('unexpected');return route.abort()
                        if route.request.url.startswith((url+'/','blob:','data:')):return route.continue_()
                        return route.abort()
                    page.route('**/*',restricted)
                    page.goto(url,wait_until='domcontentloaded',timeout=90000);page.wait_for_selector(panel_id,state='attached',timeout=55000);page.set_viewport_size({'width':375,'height':812});ready(page);scenario(page,results,user/'settings.json')
                    assert not generation,'editing settings sent a generation'
                    results.append({'modelRequests':len(generation),'browser':browser.version,'st':json.loads((st/'package.json').read_text())['version']})
                    browser.close()
            finally:
                proc.terminate()
                try:proc.wait(timeout=8)
                except subprocess.TimeoutExpired:proc.kill();proc.wait()
    report=json.dumps(results,ensure_ascii=False,indent=2)
    if opt.out:(opt.out/('before.json' if opt.old else 'after.json')).write_text(report+'\n')
    print(report)

if __name__=='__main__':main()
