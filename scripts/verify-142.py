"""Fresh ST host, actual API adapters against a loopback double, same-stage A/B, on-device-width UI.
Required: LPG_ST_PATH, LIN290_PRESET, LPG_BASELINE (exact v1.4.1 tree), CHROMIUM. No remote traffic."""
import hashlib,importlib.util,json,os,shutil,subprocess,sys,tempfile,threading,time,urllib.request
from pathlib import Path
from http.server import ThreadingHTTPServer
from playwright.sync_api import sync_playwright
root=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('stqa',root/'scripts/st-check.py');stqa=importlib.util.module_from_spec(spec);spec.loader.exec_module(stqa)
st=Path(os.environ['LPG_ST_PATH']);base=Path(os.environ['LPG_BASELINE']);out=Path(os.environ['LPG_EVIDENCE']);out.mkdir(parents=True,exist_ok=True)
assert json.loads((base/'manifest.json').read_text())['version']=='1.4.1'
src=Path(os.environ['LIN290_PRESET']).read_bytes();assert hashlib.sha256(src).hexdigest()=='bd5bb31893f8835a6d064b7be6fd03e6b5ad7f001cc8a75334486a47d1882766'
pfx='#lin-prefill-guard-panel';key='lin_prefill_guard_v1';via='/api/backends/chat-completions/generate'
class Peer(stqa.Model):
 def do_POST(self):
  if self.path!='/negotiate':return super().do_POST()
  self.rfile.read(int(self.headers['content-length']));a=self.headers.get('accept','*/*');self.server.formats.append(a)
  if a=='text/event-stream':
   msg='data: '+json.dumps({'candidates':[{'index':0,'content':{'role':'model','parts':[{'text':'本地格式验证。'}]},'finishReason':'STOP'}]})+'\n\ndata: [DONE]\n\n';typ='text/event-stream'
  else:msg=json.dumps({'choices':[{'index':0,'message':{'role':'assistant','content':'本地格式验证。'},'finish_reason':'stop'}]});typ='application/json'
  data=msg.encode();self.send_response(200);self.send_header('Content-Type',typ);self.send_header('Content-Length',str(len(data)));self.end_headers();self.wfile.write(data)
def digest(o):return hashlib.sha256(json.dumps(o,ensure_ascii=False,separators=(',',':')).encode()).digest()
def ready(page):
 page.wait_for_selector(pfx,state='attached',timeout=60000)
 for _ in range(4):
  d=page.locator('dialog[open]').last
  if not d.count():break
  if 'Initializing' in d.inner_text():d.wait_for(state='hidden',timeout=35000);continue
  btn=d.locator('.popup-button-ok:visible,.popup-button-close:visible')
  if btn.count():btn.first.click()
  else:page.keyboard.press('Escape')
  d.wait_for(state='hidden',timeout=6000)
 if not page.locator('#rm_extensions_block').is_visible():page.locator('#extensions-settings-button .drawer-toggle').click()
def shot(page,name,selector):
 el=page.locator(selector);el.evaluate("n=>n.scrollIntoView({block:'start',behavior:'instant'})")
 if selector.endswith('.lpg-this-turn'):el.screenshot(path=str(out/(name+'.png')))
 else:page.screenshot(path=str(out/(name+'.png')))
def run(page,endpoint,origin,peer,wire,control):
 page.evaluate("""async ([p,base])=>{
  const ctx=SillyTavern.getContext(),s=ctx.chatCompletionSettings,oa=await import('/scripts/openai.js');
  Object.assign(s,p,{name:p.name,preset_settings_openai:p.name,chat_completion_source:'custom',custom_model:'gemini-4-carbon',custom_url:base+'/v1',
    stream_openai:false,function_calling:false,request_images:false,openai_max_context:250000,custom_prompt_post_processing:'',custom_include_body:'',custom_include_headers:'',custom_exclude_body:''});
  const q={role:'user',content:'本地验收场景。'};const ms=(await oa.prepareOpenAIMessages({name2:'样本乙',charDescription:'',charPersonality:'',scenario:'',worldInfoBefore:'',worldInfoAfter:'',bias:'',type:'normal',quietPrompt:'',quietImage:'',extensionPrompts:{},cyclePrompt:'',systemPromptOverride:'',jailbreakPromptOverride:'',messages:[q],messageExamples:[]},false))[0];
  if(!ms.some(m=>m.content===q.content)||ms.at(-1).role!=='user'||ms.at(-2).role!=='assistant')throw Error('unproved assembled snapshot');
  const pluginPath=performance.getEntriesByType('resource').map(x=>x.name).find(x=>x.includes('lin-prefill-guard/index.js'));
  window.Q={ctx,s,ms,oa,next:await import(pluginPath||'/scripts/extensions/third-party/lin-prefill-guard/index.js'),local:base};window.Q.last=()=>JSON.parse(ctx.accountStorage.getItem('lin_prefill_guard_history_v2')||'[]')[0];
 }""",[json.loads(src),origin])
 def client(version):
  page.evaluate("""async (x)=>{const q=window.Q;if(x==='base'){q.next.onDisable();q.prev=await import('/qa-baseline/index.js');q.prev.onEnable();}else{q.prev?.onDisable();q.next.onEnable();}}""",version)
 def send(version,provider,search,rev,profile,stream=False,macro=False):
  before=len(wire);n=len(peer.seen);control['double']=stream
  page.evaluate("""([provider,search,rev,profile,stream,macro])=>{const {ctx,s,ms,oa,local}=Q;let arr=structuredClone(ms);
    Object.assign(s,{chat_completion_source:provider,google_model:'gemini-4-carbon',vertexai_model:'gemini-4-carbon',reverse_proxy:local,proxy_password:'',use_sysprompt:true,enable_web_search:search,stream_openai:stream});
    Object.assign(ctx.extensionSettings.lin_prefill_guard_v1,{enabled:true,requestMode:'gemini4',compat290:true,protocolProfile:profile,shield:'off',macro,macroWhen:'each',experimentDetails:true,captureNetwork:true,passiveOutput:false});
    if(rev)[arr[arr.length-2],arr[arr.length-1]]=[arr.at(-1),arr.at(-2)];
    Q.run=(async()=>{await ctx.eventSource.emit(ctx.eventTypes.GENERATION_STARTED,'normal',{},false);
     const res=await oa.sendOpenAIRequest('normal',arr,null);let visible;
     if(typeof res==='function'){visible='';for await(const part of res())visible=part.text;}
     else visible=res.choices?.[0]?.message?.content;
     await ctx.eventSource.emit(ctx.eventTypes.GENERATION_ENDED);
     return {visible,...((({profile,transport,status,bodyStrategy,randomChars,httpReceipt,browserSent})=>({profile,transport,status,bodyStrategy,randomChars,httpReceipt,browserSent}))(Q.last().experiment))};})();
   }""",[provider,search,rev,profile,stream,macro])
  d=page.locator('dialog[open]').filter(has_text=origin)
  if not control['confirmed'] and not stream:d.locator('.popup-button-ok').click(timeout=18000);control['confirmed']=True
  res=page.evaluate('()=>Q.run');assert len(wire)==before+1,(version,provider,res);assert len(peer.seen)==n+(not stream)
  return res,wire[-1],None if stream else peer.seen[-1]
 parity={}; rows=[]; outcomes=[];lastwire=None
 for version in ['base','new']:
  client(version)
  for provider in ['makersuite','vertexai']:
   for search in [False,True]:
    for rev in [False,True]:
     for profile in (['off'] if version=='base' else ['off','standard']):
      res,(headers,raw),up=send(version,provider,search,rev,profile)
      assert res['visible']=='雨停了。'
      addr=(provider,search,rev);obj=json.loads(raw);has=any('google_search' in t for t in up.get('tools',[]));assert has==search
      if version=='base':parity[addr]=(headers,raw,up);continue
      a,b,c=parity[addr];baseobj=json.loads(b);assert [digest(m) for m in obj['messages'] if m['role']=='system']==[digest(m) for m in baseobj['messages'] if m['role']=='system']
      assert sorted(digest(m) for m in obj['messages'])==sorted(digest(m) for m in baseobj['messages'])
      diff=[k for k in obj if obj[k]!=baseobj[k]];udiff=sorted(k for k in set(up)|set(c) if up.get(k)!=c.get(k))
      moved=profile=='standard' and search and rev;assert diff==(['messages'] if moved else []),(provider,search,rev,profile,diff)
      assert (raw==b)==(not moved);assert obj['messages'][-1]['role']==('assistant' if search and rev and not moved else 'user')
      if profile=='off':assert headers==a and up==c
      else:
       assert headers=='application/json' and res['transport']=='json',res
       assert udiff==(['contents'] if moved else []),udiff
      rows.append({'providerAdapter':provider,'search':search,'reversedTail':rev,'profile':profile,'browserAccept':headers,'browserJsonDiff':diff,'upstreamJsonDiff':udiff,'allProtectedMessageDigestsMatch':True,'searchToolPresent':has,'responseVisible':True,'capture':'real host + loopback model'})
      if provider=='vertexai' and profile=='standard' and search:lastwire=obj
  # A real peer which chooses JSON as the default representation. Exercise ST's *actual* streaming consumer.
  res,(headers,raw),_=send(version,'vertexai',False,False,'off' if version=='base' else 'standard',True)
  assert peer.formats[-1]==headers;assert res['visible']==('' if version=='base' else '本地格式验证。'),res
  if version=='base':stream_control=raw
  else:assert raw==stream_control
  outcomes.append({'version':version,'bodyEqual':True,'actualAccept':headers,'peerFormat':'SSE' if headers=='text/event-stream' else 'JSON','visibleChars':len(res['visible']),'actualSTStreamParser':True})
  control['double']=True;i=len(wire)
  names=page.evaluate("async()=>await (await import('/qa-tests/scripts/parity-cases.mjs')).matrix()")
  bodies=[(a,raw) for a,raw in wire[i:]];assert len(bodies)==len(names)
  if version=='base':pnames=names;pbodies=bodies
  else:assert names==pnames and bodies==pbodies,'legacy/post bytes differ from v1.4.1'
  if version=='new':
   checks=[(name,json.loads(raw)) for name,(_,raw) in zip(names,bodies)]
   assert next(x['max_tokens'] for name,x in checks if name=='2.8.2:gemini4-story:budget=true')==32768
   assert next(x['max_tokens'] for name,x in checks if name=='2.8.2:gemini4-story:budget=false')==16384
   assert next(x['reasoning_effort'] for name,x in checks if name=='legacy:lin:pair:balanced')=='low'
   assert next(x['reasoning_effort'] for name,x in checks if name=='legacy:lin:pair:keep')=='high'
 control['double']=True
 # Exercise both genuine error and skip statuses on the running UI; no fake DOM text.
 def special(kind):
  page.evaluate("""async ([r,kind])=>{const {ctx,s}=Q;Object.assign(s,{chat_completion_source:'vertexai',enable_web_search:true});
    Object.assign(ctx.extensionSettings.lin_prefill_guard_v1,{protocolProfile:kind==='searchOff'?'off':'standard',enabled:true,requestMode:'gemini4',compat290:true,macro:false,experimentDetails:true});
    if(kind==='tools')r.tools=[{type:'function',function:{name:'fixture',parameters:{type:'object'}}}];
    r.type='normal';r.enable_web_search=true;await ctx.eventSource.emit(ctx.eventTypes.GENERATION_STARTED,'normal',{},false);
    await ctx.eventSource.emit(ctx.eventTypes.CHAT_COMPLETION_SETTINGS_READY,r);
    const resp=await fetch('/api/backends/chat-completions/generate',{method:'POST',headers:(await import('/script.js')).getRequestHeaders(),body:JSON.stringify(r,null,kind==='raw'?2:undefined)});await resp.text();
    await ctx.eventSource.emit(ctx.eventTypes.GENERATION_ENDED);return Q.last().experiment.transport;}""",[lastwire,kind])
 panel=page.locator(pfx);ready(page)
 assert not panel.locator('[role=tablist]').count();assert panel.locator('#lpg-profile-deep').is_disabled()
 def tap(sel):panel.locator(sel).tap()
 def settings():return page.evaluate('()=>Q.ctx.extensionSettings.lin_prefill_guard_v1')
 def pick(v):tap('label[for="lpg-profile-'+v+'"]')
 def reveal(locator):
  while True:
   ds=locator.locator('xpath=ancestor::details[not(@open)]')
   if not ds.count():break
   ds.first.locator(':scope > summary').tap()
 initial=settings().copy();pick('off');pick('standard')
 assert settings()['protocolProfile']=='standard' and '仅保存' in panel.locator('.lpg-outcome').inner_text()
 shot(page,'04-saved-pending',pfx+' .lpg-this-turn')
 sizes=[]
 for width in [320,375,390,1100]:
  page.set_viewport_size({'width':width,'height':820 if width<500 else 880})
  top=panel.locator('.lpg-profile').first;top.scroll_into_view_if_needed()
  metrics=panel.evaluate("""e=>({w:e.clientWidth,scroll:e.scrollWidth,targets:[...e.querySelectorAll('.lpg-quick,.lpg-profile,.lpg-main-actions button')].map(n=>Math.floor(n.getBoundingClientRect().height))})""")
  assert metrics['w']>0 and metrics['scroll']<=metrics['w']+1 and min(metrics['targets'])>=44,(width,metrics)
  sizes.append({'cssWidth':width,'panelWidth':metrics['w'],'scrollWidth':metrics['scroll'],'minimumTarget':min(metrics['targets'])})
  shot(page,'panel-'+str(width),pfx+' > summary')
 page.set_viewport_size({'width':375,'height':812})
 special('tools');assert '工具' in panel.locator('.lpg-outcome').inner_text(),panel.locator('.lpg-outcome').inner_text()
 shot(page,'05-search-with-tools',pfx+' .lpg-this-turn')
 special('raw');assert '回退' in panel.locator('.lpg-outcome').inner_text()
 shot(page,'06-runtime-fallback',pfx+' .lpg-this-turn')
 special('searchOff');assert '跳过' in panel.locator('.lpg-outcome').inner_text()
 shot(page,'08-google-search-off-mode',pfx+' .lpg-this-turn')
 special('ok');assert '整段' in panel.locator('.lpg-outcome').inner_text()
 shot(page,'07-current-diagnostics',pfx+' .lpg-this-turn')
 page.context.grant_permissions(['clipboard-read','clipboard-write'])
 panel.get_by_role('button',name='复制脱敏诊断').tap()
 copied=json.loads(page.evaluate('()=>navigator.clipboard.readText()'))
 assert copied['transport']=='json' and copied['search'] and copied['upstreamVerified'] is False and copied['sourceVersion']=='1.4.2'
 (out/'redacted-example.json').write_text(json.dumps(copied,ensure_ascii=False,indent=2)+'\n')
 # All retained switches accessible with real touch, including the three controls originally reported.
 for k,v in [('scope','all'),('mode','pair'),('reasoningMode','balanced')]:
  label=panel.locator('label[for="lpg-choice-'+k+'-'+v+'"]');reveal(label);label.tap();assert settings()[k]==v
 # Keep edited texts, unrelated settings and diagnostic history on recommendation reset.
 page.evaluate("""()=>{const s=Q.ctx.extensionSettings.lin_prefill_guard_v1;Object.assign(s,{prefill:'用户测试字段',nudge:'另一段自定义',shield:'deep',passiveOutput:true,captureNetwork:false,unknown142:{value:37}});}""")
 for k in ['macro','experimentDetails']:
  x=panel.locator('[data-setting='+k+']');x.set_checked(True)
 before=settings();hist=page.evaluate('()=>Q.ctx.accountStorage.getItem("lin_prefill_guard_history_v2")')
 panel.get_by_role('button',name='恢复新实验推荐设置').tap();after=settings()
 assert all(after[k]==before[k] for k in before if k not in ['macro','protocolProfile','experimentDetails'])
 assert [after[x] for x in ['macro','protocolProfile','experimentDetails']]==[False,'off',False]
 assert page.evaluate('()=>Q.ctx.accountStorage.getItem("lin_prefill_guard_history_v2")')==hist
 # Verify write-through before refresh on the same user account (ST debounces saving).
 return rows,outcomes,pnames,sizes
def main():
 peer=ThreadingHTTPServer(('127.0.0.1',0),Peer);peer.seen=[];peer.protocols=[];peer.formats=[]
 threading.Thread(target=peer.serve_forever,daemon=True).start();origin='http://127.0.0.1:'+str(peer.server_port);wire=[];control={'double':False,'confirmed':False}
 try:
  with tempfile.TemporaryDirectory() as t:
   t=Path(t);u=t/'data/default-user';extension=u/'extensions/lin-prefill-guard';extension.mkdir(parents=True)
   for f in [*root.glob('*.js'),root/'style.css',root/'manifest.json']:shutil.copy2(f,extension/f.name)
   conf=t/'config.yaml';shutil.copy2(st/'default/config.yaml',conf);cfg=json.loads((st/'default/content/settings.json').read_text());cfg['firstRun']=False;cfg['language']='zh-cn'
   (u/'settings.json').write_text(json.dumps(cfg));port=stqa.port();endpoint='http://127.0.0.1:'+str(port)
   with (t/'server.log').open('w') as log:
    proc=subprocess.Popen(['node','server.js','--port',str(port),'--listen','false','--enableIPv4','true','--enableIPv6','false','--browserLaunchEnabled','false','--configPath',str(conf),'--dataRoot',str(t/'data')],cwd=st,stdout=log,stderr=subprocess.STDOUT)
    try:
     for _ in range(200):
      if proc.poll() is not None:raise RuntimeError('ST stopped')
      try:urllib.request.urlopen(endpoint,timeout=1).close();break
      except OSError:time.sleep(.2)
     with sync_playwright() as pw:
      br=pw.chromium.launch(executable_path=os.environ['CHROMIUM'],headless=True,args=['--no-sandbox','--disable-dev-shm-usage','--disable-gpu'])
      page=br.new_page(viewport={'width':375,'height':812},is_mobile=True,has_touch=True,device_scale_factor=1,locale='zh-CN')
      def route(req):
       u=req.request.url
       if not u.startswith(endpoint+'/'):return req.abort()
       path=u[len(endpoint):].split('?')[0]
       if path=='/qa-actions':return req.fulfill(body='<!doctype html><meta charset="utf-8"><div id="extensions_settings"></div><textarea id="send_textarea"></textarea>',content_type='text/html')
       for prefix,folder in [('/qa-baseline/',base),('/qa-tests/',root)]:
        if path.startswith(prefix):
         f=(folder/path[len(prefix):]).resolve()
         assert f.is_relative_to(folder.resolve()) and f.suffix in ['.js','.mjs']
         return req.fulfill(body=f.read_bytes(),content_type='application/javascript')
       if path==via:
        rq=req.request;raw=rq.post_data;accept=rq.all_headers().get('accept','*/*');wire.append((accept,raw))
        if control['double']:
         # Send only the Accept header and generated body to OUR loopback fixture. Never forward credentials.
         x=urllib.request.Request(origin+'/negotiate',data=raw.encode(),headers={'Accept':accept,'Content-Type':'application/json'},method='POST')
         with urllib.request.urlopen(x,timeout=10) as rr:return req.fulfill(status=rr.status,content_type=rr.headers.get_content_type(),body=rr.read())
       return req.continue_()
      page.route('**/*',route);page.goto(endpoint,wait_until='domcontentloaded',timeout=90000);ready(page)
      rows,ab,names,sizes=run(page,endpoint,origin,peer,wire,control)
      for _ in range(100):
       saved=json.loads((u/'settings.json').read_text()).get('extension_settings',{}).get(key,{})
       if saved.get('unknown142',{}).get('value')==37 and saved.get('protocolProfile')=='off':break
       page.wait_for_timeout(120)
      else:raise AssertionError('preferences did not reach settings.json')
      page.reload(wait_until='domcontentloaded');ready(page);actual=page.evaluate('()=>SillyTavern.getContext().extensionSettings.lin_prefill_guard_v1')
      assert actual['scope']=='all' and actual['reasoningMode']=='balanced' and actual['unknown142']['value']==37 and actual['shield']=='deep'
      desktop=br.new_page(viewport={'width':1240,'height':900},is_mobile=False,has_touch=False,locale='zh-CN')
      desktop.route('**/*',route);desktop.goto(endpoint,wait_until='domcontentloaded',timeout=90000);ready(desktop)
      dp=desktop.locator(pfx);dp.locator('#lpg-profile-off').focus();desktop.keyboard.press('ArrowDown');assert dp.locator('#lpg-profile-standard').is_checked()
      desk=dp.evaluate('e=>({w:e.clientWidth,full:e.scrollWidth,touch:navigator.maxTouchPoints})')
      assert desk['w']>0 and desk['w']>=desk['full']-1 and desk['touch']==0;shot(desktop,'panel-desktop',pfx+' > summary')
      actionPairs=[];control['double']=True
      for version in ['base','new']:
       fixture=br.new_page();fixture.route('**/*',route);fixture.goto(endpoint+'/qa-actions')
       fixture.evaluate("async v=>(await import('/qa-tests/scripts/actions-142.mjs')).attach(v)",version)
       pp=fixture.locator(pfx)
       if version=='base':pp.locator('#lpg-tab-diag').click()
       else:pp.locator('summary').filter(has_text='诊断与补全').first.click()
       pp.get_by_role('button',name='检查当前回复（不调用模型）').click()
       assert '字符' in pp.locator('.lpg-audit').first.inner_text()
       pp.get_by_text('手动补全 / 重生成',exact=True).click()
       start=len(wire);target=pp.get_by_role('button',name='检查操作目标（免费）')
       for which,button in [('continue','补全当前回复'),('regenerate','重生成并替换当前回复')]:
        target.click();pp.get_by_role('button',name=button).click();fixture.wait_for_function("!document.querySelector('.lpg-recovery button').disabled")
       target.click();fixture.evaluate("()=>caseState.ctx.chat.at(-1).mes+='修订'");pp.get_by_role('button',name='补全当前回复').click()
       assert fixture.evaluate('()=>caseState.actions')==['continue','regenerate'];assert len(wire)==start+2
       actionPairs.append(wire[start:]);fixture.close()
      assert actionPairs[0]==actionPairs[1]
      report={'manualActions':{'host':'browser + synthetic ST generate -> loopback HTTP','oldNewBodyPairsEqual':2,'staleTargetExtraCalls':0},'desktopKeyboard':{'cssWidth':1240,'panel':desk,'arrowSelectsStandard':True},'host':json.loads((st/'package.json').read_text())['version'],'hostCommit':subprocess.check_output(['git','rev-parse','HEAD'],cwd=st,text=True).strip(),'browser':br.version,'liveCloud':False,'actualBrowserGenerationPOSTs':len(wire),'googleAdapterPOSTs':len(peer.seen),'nativeCases':rows,'responseNegotiationAB':ab,'baselineByteEqualCases':names,'layout':sizes,'settingsRestoredFromDisk':True}
      (out/'real-142.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n');print('PASS',len(names),'old-mode byte pairs;',len(rows),'native comparisons;',len(wire),'generation POSTs;',len(peer.seen),'Google-shaped localhost calls; visible negotiation A/B',ab,'; UI',sizes,flush=True);br.close()
    finally:proc.terminate();proc.wait(timeout=15)
 finally:peer.shutdown();peer.server_close()
if __name__=='__main__':main()
