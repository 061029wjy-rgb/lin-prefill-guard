"""Real ST browser + original preset + optional original companion + loopback model, without cloud keys.
Set LPG_ST_PATH (host with installed dependencies), LIN291_HOST_PRESET (or LIN291_PRESET),
CHROMIUM, LPG_EVIDENCE. Use separate evidence dirs for the two supplied revisions.
For the companion suite set LPG_COMPANION_ZIP to the user's original two-extension archive.
"""
import hashlib, json, os, shutil, socket, subprocess, tempfile, threading, time, urllib.request, zipfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from playwright.sync_api import sync_playwright
ROOT=Path(__file__).resolve().parents[1]
C='e898d676-f02e-4868-bc51-33761e294df6';U='68186c40-6f11-4c47-a036-58497d1d6795';N='b62baac5-e695-5ce5-899b-edc7989babc8'
ACK='按上一条承接完成本轮，从预设规定的第一项开始。'
class Peer(BaseHTTPRequestHandler):
    def log_message(self,*args):pass
    def do_POST(self):
        route=self.path.split('?',1)[0]
        assert route.startswith(('/v1/publishers/google/models/','/v1beta/models/')) and route.endswith((':generateContent',':streamGenerateContent'))
        p=json.loads(self.rfile.read(int(self.headers['content-length'])));self.server.payloads.append(p)
        v={'candidates':[{'index':0,'content':{'role':'model','parts':[{'text':'本地测试回复。'}]},'finishReason':'STOP'}]}
        stream='streamGenerateContent' in route
        body=(('data: '+json.dumps(v)+'\n\ndata: [DONE]\n\n') if stream else json.dumps(v)).encode()
        self.send_response(200);self.send_header('Content-Type','text/event-stream' if stream else 'application/json');self.send_header('Content-Length',str(len(body)));self.end_headers();self.wfile.write(body)
def main():
    st=Path(os.environ['LPG_ST_PATH']); presetbytes=Path(os.getenv('LIN291_HOST_PRESET') or os.environ['LIN291_PRESET']).read_bytes()
    digest=hashlib.sha256(presetbytes).hexdigest()
    hashes=['79425364f929723df789af37ddd9f9806db9e845ee14e27a4f919de8683c4f70','2cdd746b2e6e2a1197c51e010fdacdd1db750e5eaede1c9a7237fcc78ee7e2e8']
    assert digest in hashes, 'expected one of the supplied 2.9.1 exports'
    revised=digest==hashes[1]
    p=json.loads(presetbytes);defs={e['identifier']:e for e in p['prompts']};cue={'role':'assistant','content':defs[C]['content']};user={'role':'user','content':defs[U]['content']}
    out=Path(os.environ['LPG_EVIDENCE']);out.mkdir(exist_ok=True,parents=True)
    companion=os.getenv('LPG_COMPANION_ZIP');wire=[];rows=[];groups=[];full=[]
    with ThreadingHTTPServer(('127.0.0.1',0),Peer) as peer, tempfile.TemporaryDirectory() as tmp:
        th=threading.Thread(target=peer.serve_forever,daemon=True);th.start();peer.payloads=[];local='http://127.0.0.1:'+str(peer.server_port)
        t=Path(tmp);u=t/'data/default-user';ext=u/'extensions/lin-prefill-guard';ext.mkdir(parents=True);(u/'characters').mkdir()
        for f in [*ROOT.glob('*.js'),ROOT/'manifest.json',ROOT/'style.css']:shutil.copyfile(f,ext/f.name)
        if companion:
            with zipfile.ZipFile(companion) as z:
                assert json.loads(z.read('human-temper/manifest.json'))['version']=='1.2.0'
                for name in z.namelist():
                    parts=name.split('/')
                    if len(parts)==2 and parts[0]=='human-temper' and (parts[1].endswith(('.css','.js')) or parts[1]=='manifest.json'):
                        z.extract(name,u/'extensions')
        shutil.copyfile(st/'default/content/default_Seraphina.png',u/'characters/fixture.png')
        settings=json.loads((st/'default/content/settings.json').read_text());settings.update(firstRun=False,language='zh-cn');(u/'settings.json').write_text(json.dumps(settings))
        conf=t/'config.yaml';shutil.copyfile(st/'default/config.yaml',conf)
        with socket.socket() as s:s.bind(('127.0.0.1',0));port=s.getsockname()[1]
        endpoint='http://127.0.0.1:'+str(port)
        with (t/'server.log').open('w') as log:
            proc=subprocess.Popen(['node','server.js','--port',str(port),'--listen','false','--enableIPv4','true','--enableIPv6','false','--browserLaunchEnabled','false','--configPath',str(conf),'--dataRoot',str(t/'data')],cwd=st,stdout=log,stderr=subprocess.STDOUT)
            try:
                for _ in range(220):
                    if proc.poll() is not None:raise RuntimeError('test host stopped')
                    try:urllib.request.urlopen(endpoint,timeout=1).close();break
                    except OSError:time.sleep(.15)
                with sync_playwright() as pw:
                    browser=pw.chromium.launch(executable_path=os.environ['CHROMIUM'],headless=True,args=['--no-sandbox','--disable-dev-shm-usage','--disable-gpu'])
                    page=browser.new_page(viewport={'width':390,'height':844},has_touch=True,locale='zh-CN');pg=page
                    def route(rt):
                        url=rt.request.url
                        if not url.startswith(endpoint+'/'):return rt.abort()
                        path=url[len(endpoint):].split('?')[0]
                        if path=='/qa-291.mjs':return rt.fulfill(status=200,content_type='text/javascript',body=(ROOT/'scripts/host-291.mjs').read_bytes())
                        if path=='/api/backends/chat-completions/generate':
                            r=json.loads(rt.request.post_data);wire.append(r)
                            assert r.get('chat_completion_source') in ['vertexai','makersuite'] and not r.get('reverse_proxy')
                            # Test transport seam AFTER the extension's actual browser boundary.
                            # Only the disposable backend receives the loopback peer address. No live OAuth model is contacted.
                            return rt.continue_(post_data=json.dumps({**r,'reverse_proxy':local,'proxy_password':''},ensure_ascii=False))
                        return rt.continue_()
                    page.route('**/*',route);page.goto(endpoint,wait_until='domcontentloaded',timeout=90000)
                    panel=page.locator('#lin-prefill-guard-panel');panel.wait_for(state='attached',timeout=60000)
                    for _ in range(4):
                        d=page.locator('dialog[open]').last
                        if not d.count():break
                        if 'Initializing' in d.inner_text():d.wait_for(state='hidden',timeout=35000);continue
                        btn=d.locator('.popup-button-ok:visible,.popup-button-close:visible')
                        if btn.count():btn.first.click()
                        else:page.keyboard.press('Escape')
                        d.wait_for(state='hidden',timeout=8000)
                    page.evaluate("async p=>{window.test291=await import('/qa-291.mjs');await test291.setup(p)}",p)
                    for gid,on in [(100000,False),(100001,True)]:
                        group=page.evaluate('id=>test291.assemble(id)',gid)
                        assert group['settingsIdentity'] and group['active']==((60 if revised else 61) if on else 55) and group['npcOnWire']==on,group
                        assert group['closureOnWire']==(on and not revised), group
                        groups.append(group)
                        story='g291-authored-ready' if revised else 'g291-handoff'
                        cases=[({},'g291-ready'),({'rev':True},'g291-restored'),({'type':'regenerate','mode':'gemini4-story'},story),
                               ({'type':'swipe','mode':'gemini4-story','rev':True,'cap':True},'g291-authored-restored' if revised else story),
                               ({'mode':'gemini4-story','cap':True},story),({'mode':'observe','rev':True},'observe-only'),
                               ({'mode':'gemini4-story','provider':'makersuite','search':False,'stream':False},'g291-ready'),
                               ({'mode':'gemini4-story','type':'continue'},'g4-continue'),({'mode':'enhance'},'g291-ready')]
                        if companion:cases.append(({'mode':'gemini4-story','companion':True},story))
                        for opts,reason in cases:
                            start=len(wire);idx=len(peer.payloads);res=page.evaluate('opts=>test291.send(opts)',opts)
                            assert len(wire)==start+1 and len(peer.payloads)==idx+1 and res['visible']=='本地测试回复。',(opts,res,len(wire)-start,len(peer.payloads)-idx)
                            assert res['reason']==reason and res['group']==str(gid) and res['npc']==on,(gid,opts,res, list(wire[-1]),[list(m) for m in wire[-1]['messages'][-3:]])
                            w=wire[-1];before=page.evaluate('()=>qa291.before');ms=before['messages'];expected={**before}
                            if reason=='g291-handoff':
                                expected['messages']=[*ms[:-2],user,cue,{'role':'user','content':ACK}]
                            elif reason in ('g291-restored','g291-authored-restored'):expected['messages']=[*ms[:-2],cue,user]
                            if opts.get('cap'):expected['max_tokens']=32768
                            assert w==expected, (opts,'unexpected field or message change', sorted(k for k in w.keys()|expected.keys() if (k in w)!=(k in expected) or w.get(k)!=expected.get(k)))
                            up=peer.payloads[-1];contents=up['contents']
                            tags=[part.get('text','') for item in contents for part in item.get('parts',[])]
                            native_full=sum(t.count(user['content']) for t in tags)==1 and sum(t.count(cue['content']) for t in tags)==1
                            assert native_full and (sum(t.count(ACK) for t in tags)==int(reason=='g291-handoff')),(opts,'native texts')
                            if reason in ['g291-ready','g291-handoff','g291-restored','g291-authored-ready','g291-authored-restored']:
                                assert res['checked']=='cue-before-user',(opts,res)
                                assert contents[-1]['role']=='user' and contents[-2]['role']=='model',(opts,'roles')
                                if revised:assert contents[-1]['parts'][-1].get('text')==user['content'],(opts,'authored handoff did not remain last at native boundary')
                            assert any('google_search' in tool for tool in up.get('tools',[]))==(opts.get('search',True)),(opts,'search')
                            rows.append({'group':gid,**opts,'reason':reason,'nativeOriginalPairIntact':native_full,'settingsReadyToBrowserExact':True,'finish':res['terminal'],'requests':1})
                    # Actual user-facing selector and self-test in the host's native mobile layout.
                    if not page.locator('#rm_extensions_block').is_visible():page.locator('#extensions-settings-button .drawer-toggle').click()
                    panel.locator('[data-setting="requestMode"]').select_option('gemini4-story')
                    panel.get_by_role('button',name='本地自检（不调用模型）').click()
                    assert '已识别 Lin 2.9.1' in panel.locator('.lpg-selftest').inner_text()
                    i=len(wire);j=len(peer.payloads);result=pg.evaluate('()=>test291.full()')
                    assert len(wire)-i==len(peer.payloads)-j==3 and result['userTurns']==1,(len(wire)-i,len(peer.payloads)-j,result)
                    for row,raw in zip(result['rows'],wire[i:]):
                        assert row['stored'] and row['responseComplete'] and row['confirmationsInSavedChat']==0 and row['reason']==story,row
                        expected_tail=[cue,user] if revised else [user,cue,{'role':'user','content':ACK}]
                        assert raw['messages'][-len(expected_tail):]==expected_tail,row
                        row['companionNotePresent']=any(m['role']=='system' and isinstance(m['content'],str) and m['content'].startswith('〔人性阴暗面/情绪/随机性放大·角色演出〕') for m in raw['messages'])
                        full.append(row)
                    report={'plugin':'1.3.1','presetSHA256':digest,'host':json.loads((st/'package.json').read_text())['version'],'browser':browser.version,'realCloudCalls':0,
                        'testRelay':'direct-shaped browser POST captured, test transport then set the isolated server destination to the loopback model fixture',
                        'companionLoaded':bool(companion),'groups':groups,'scenarios':rows,'fullGeneration':full,'generationPOSTs':len(wire),'localModelCalls':len(peer.payloads),'uiSelfTest291':True}
                    (out/'host-291.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
                    print('PASS',report['host'],browser.version,len(rows),'adapter comparisons;',len(full),'full saved generations;',len(peer.payloads),'loopback calls; real cloud: 0');browser.close()
            finally:
                proc.terminate();proc.wait(timeout=15);peer.shutdown()
if __name__=='__main__':main()
