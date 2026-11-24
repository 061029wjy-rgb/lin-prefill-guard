"""Fresh ST host, actual API adapters against a loopback double, same-stage A/B, on-device-width UI.
Required: LPG_ST_PATH, LIN290_PRESET, LPG_BASELINE (exact v1.4.2 tree), CHROMIUM. No remote traffic."""
import hashlib,importlib.util,json,os,shutil,subprocess,sys,tempfile,threading,time,urllib.request
from pathlib import Path
from http.server import ThreadingHTTPServer
from playwright.sync_api import sync_playwright
root=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('stqa',root/'scripts/st-check.py');stqa=importlib.util.module_from_spec(spec);spec.loader.exec_module(stqa)
st=Path(os.environ['LPG_ST_PATH']);base=Path(os.environ['LPG_BASELINE']);out=Path(os.environ['LPG_EVIDENCE']);out.mkdir(parents=True,exist_ok=True)
assert json.loads((base/'manifest.json').read_text())['version']=='1.4.2'
src=Path(os.environ['LIN290_PRESET']).read_bytes();assert hashlib.sha256(src).hexdigest()=='bd5bb31893f8835a6d064b7be6fd03e6b5ad7f001cc8a75334486a47d1882766'
pfx='#lin-prefill-guard-panel';key='lin_prefill_guard_v1';via='/api/backends/chat-completions/generate'
class Peer(stqa.Model):
 def do_POST(self):
  raw=self.rfile.read(int(self.headers['content-length']));o=json.loads(raw);a=self.headers.get('accept','*/*')
  if self.path=='/negotiate':
   v={'choices':[{'index':0,'message':{'role':'assistant','content':'合成本地回复。'},'finish_reason':'stop'}]}
  else:
   assert ('generateContent' in self.path or 'streamGenerateContent' in self.path),self.path
   self.server.seen.append(o);self.server.rawheaders.append(self.headers.get('x-lin-request-id') is not None)
   parts=(o.get('systemInstruction') or o.get('system_instruction') or {}).get('parts',[])
   marker=next((p.get('text') for p in parts if p.get('text')=='LPG format=1'),None)
   v={'candidates':[{'index':0,'content':{'role':'model','parts':[{'text':marker or '合成本地回复。'}]},'finishReason':'STOP'}]}
  stream='streamGenerateContent' in self.path;data=('data: '+json.dumps(v)+'\n\ndata: [DONE]\n\n' if stream else json.dumps(v)).encode();self.send_response(200);self.send_header('Content-Type','text/event-stream' if stream else 'application/json');self.send_header('Content-Length',str(len(data)));self.end_headers();self.wfile.write(data)
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
 page.evaluate("async args=>{window.host=await import('/qa-tests/scripts/host-143.mjs');await host.setup(...args)}",[json.loads(src),origin])
 def call(fn,*args):return page.evaluate("([fn,args])=>host[fn](...args)",[fn,args])
 def send(provider,search=False,opt=None,t='normal',rev=False,stream=False):
  call('configure',provider,search,opt or {},stream)
  page.evaluate("([t,rev])=>{Q.run=host.send(t,rev)}",[t,rev])
  if not control['confirmed']:
   page.locator('dialog[open]').filter(has_text=origin).locator('.popup-button-ok').click(timeout=18000);control['confirmed']=True
  a=page.evaluate("()=>Q.run");return a,wire[-1],peer.seen[-1]
 def chosen(h):return {k:v for k,v in h.items() if k not in ['content-length']}
 def marker(o):return {'role':'system','content':'LPG format=1'} in o['messages']
 def native_marker(u):return any(p.get('text')=='LPG format=1' for p in (u.get('systemInstruction') or u.get('system_instruction') or {}).get('parts',[]))
 rows=[];books=[];layout=[];ab=[];parity={}
 trace_env=os.environ.get('LPG_PRIVATE_DIGEST_DIR');trace_dir=Path(trace_env).resolve() if trace_env else None
 if trace_dir:
  assert not trace_dir.is_relative_to(root) and not trace_dir.is_relative_to(out.resolve())
  trace_dir.mkdir(mode=0o700,parents=True,exist_ok=False)
 call('assemble',100001,'本地验收场景。')
 for v in ['base','new']:
  call('version',v)
  for provider in ['makersuite','vertexai']:
   for search in [False,True]:
    for rev in [False,True]:
     res,(hdr,raw),up=send(provider,search,{'protocolProfile':'standard' if search else 'off'},rev=rev)
     assert res['visible']=='合成本地回复。' and any('google_search' in t for t in up.get('tools',[]))==search
     k=(provider,search,rev)
     if v=='base':parity[k]=(hdr,raw,up)
     else:
      h,b,u=parity[k];assert chosen(h)==chosen(hdr) and b==raw and u==up,k
      rows.append({'adapter':provider,'search':search,'correctedOldTailFixture':rev,'allBodyBytesEqual':True,'effectiveHeadersEqual':True,'nativeJSONEqual':True})
  control['double']=True;i=len(wire)
  names=page.evaluate("async()=>await (await import('/qa-tests/scripts/parity-cases.mjs')).matrix()")
  sampled=[(chosen(h),r) for h,r in wire[i:]];assert len(sampled)==len(names)==24
  if v=='base':oldnames=names;olds=sampled
  else:assert oldnames==names and olds==sampled
  control['double']=False
 for g,enabled in [(100000,56),(100001,61)]:
  for i,case in enumerate(json.loads((root/'fixtures/literary-cases.json').read_text())):
   length=[0,25,420][i%3];assert call('assemble',g,case['scene'],length)==enabled
   provider=['makersuite','vertexai'][i%2];vals=[];local_hashes=[]
   for v,mode in [('base','off'),('new','off'),('new','standard')]:
    call('version',v);res,(head,raw),up=send(provider,opt={'guardMode':mode,'traceAnchor':mode=='standard'})
    if trace_dir:
     obj=json.loads(raw)
     local_hashes.append({'version':v,'setting':mode,'roles':[m['role'] for m in obj['messages']],'messages':[digest(m).hex() for m in obj['messages']],'native':digest(up).hex()})
    vals.append((raw,up));assert res['visible']=='合成本地回复。'
    assert (head.get('x-lin-request-id') is not None)==(mode=='standard'),(g,i,mode,res)
    assert not peer.rawheaders[-1]
   assert vals[0]==vals[1]==vals[2],(g,case['id'])
   if trace_dir:
    trace=(trace_dir/(str(g)+'-'+case['id']+'.json'));trace.write_text(json.dumps(local_hashes,indent=2));trace.chmod(0o600)
   books.append({'case':case['id'],'order':g,'enabledEntries':enabled,'priorSyntheticRepeats':length,'adapter':provider,'browserBodyMatchesAllArms':True,'nativeMatchesAllArms':True,'allRolesAndContentsMatch':True,'literaryRating':None})
 call('assemble',100001,'本地验收场景。')
 for provider in ['makersuite','vertexai']:
  call('version','new');nonstream,_,_=send(provider,opt={'guardMode':'standard','shield':'standard'})
  assert nonstream['visible']=='LPG format=1' and nonstream['step']['guard']=='end-unverified'
  for kind in ['regenerate','swipe']:
   for v,mode in [('base','off'),('new','off'),('new','standard')]:
    call('version',v);opts={'guardMode':mode,'shield':'standard','traceAnchor':mode=='standard'}
    r,(h,raw),u=send(provider,opt=opts,stream=True)
    assert marker(json.loads(raw)) and native_marker(u) and r['visible']=='LPG format=1',(provider,v,mode,r)
    if mode=='standard':assert r['step']['guard']=='echo-confirmed',r
    r,(h,raw2),u2=send(provider,opt=opts,t=kind,stream=True)
    gone=mode=='standard'
    assert marker(json.loads(raw2))!=gone and native_marker(u2)!=gone and r['visible']==('合成本地回复。' if gone else 'LPG format=1'),(provider,kind,v,mode,r)
    first=json.loads(raw)['messages'];second=json.loads(raw2)['messages']
    assert [x for x in first if x!={'role':'system','content':'LPG format=1'}]==[x for x in second if x!={'role':'system','content':'LPG format=1'}]
    old_sender=json.loads(raw);new_sender=json.loads(raw2);old_sender.pop('type',None);new_sender.pop('type',None)
    native_without=json.loads(json.dumps(u))
    if gone:
     old_sender['messages'].remove({'role':'system','content':'LPG format=1'})
     container=native_without['systemInstruction'] if 'systemInstruction' in native_without else native_without['system_instruction']
     container['parts'].remove({'text':'LPG format=1'})
    assert old_sender==new_sender and native_without==u2
    assert not peer.rawheaders[-1];ab.append({'adapter':provider,'generation':kind,'stream':True,'version':v,'setting':mode,'normalEchoOnly':True,'retriedModelReceivedOwnedMarker':not gone,'nativeChanges':['systemInstruction.parts: omit owned element'] if gone else [],'ordinaryFixtureAnswerOnRetry':gone,'otherMessageBytesAndOrderEqual':True})
 # Independent switches on one post-expansion assembly. Ignore only the exact old sample slot.
 cross=[];first_body=None;first_native=None
 call('version','new')
 for name,old,trace,guard in [('nonce-only',False,False,'off'),('old-sample',True,False,'off'),('trace-only',False,True,'off'),('trace-and-guard',False,True,'standard'),('old-and-trace-and-guard',True,True,'standard')]:
  response,(head,raw),up=send('makersuite',opt={'guardMode':guard,'macro':old,'macroSize':'short','macroGroups':'1','traceAnchor':trace})
  d=json.loads(raw);u=json.loads(json.dumps(up));slot=[m for m in d['messages'] if m.get('role')=='system' and isinstance(m.get('content'),str) and m['content'].startswith('LPG sample=')]
  parts=(u.get('systemInstruction') or u.get('system_instruction'))['parts'];ns=[p for p in parts if isinstance(p.get('text'),str) and p['text'].startswith('LPG sample=')]
  assert len(slot)==len(ns)==int(old) and ('x-lin-request-id' in head)==trace and not peer.rawheaders[-1],name
  if old:
   assert slot[0]['content']==ns[0]['text'] and len(slot[0]['content'].removeprefix('LPG sample='))==8
   d['messages'].remove(slot[0]);parts.remove(ns[0])
  if first_body is None:first_body=d;first_native=u
  assert d==first_body and u==first_native and response['visible']=='合成本地回复。',name
  cross.append({'arm':name,'oldSampleInNative':old,'traceAtST':trace,'traceAtPeer':False,'nonPluginContentsIdentical':True,'normalFixtureTextUnchanged':True})
 # Same ST request, same body bytes; let the browser default a bare string to text/plain.
 call('version','new');res,(_,raw),_=send('vertexai');body=json.loads(raw);mime=[]
 for v,on in [('base',False),('new',False),('new',True)]:
  call('version',v);call('configure','vertexai',False,{'repairJsonMime':on});idx=len(peer.seen)
  code=call('direct',body,{'mime':True});h,b=wire[-1]
  assert b==raw and (code==200)==on and len(peer.seen)==idx+int(on),(v,on,code,h.get('content-type'))
  mime.append({'version':v,'repair':on,'hostHTTP':code,'browserMime':h.get('content-type'),'identicalJSONBytes':True,'nativeReceiverCalled':on})
 panel=page.locator(pfx);ready(page)
 def reveal(loc):
  for _ in range(6):
   ds=loc.locator('xpath=ancestor::details[not(@open)]')
   if not ds.count():return
   ds.first.locator(':scope > summary').tap()
 def button(s):loc=panel.get_by_role('button',name=s,exact=True,include_hidden=True);reveal(loc);loc.tap()
 def cfg():return page.evaluate('()=>Q.ctx.extensionSettings.lin_prefill_guard_v1')
 def inject(x):page.evaluate('x=>Object.assign(Q.ctx.extensionSettings.lin_prefill_guard_v1,x)',x)
 def diff(a,b):return sorted(k for k in a|b if a.get(k)!=b.get(k))
 assert not panel.locator('[role=tablist]').count() and panel.locator('#lpg-profile-deep').is_disabled()
 for k,v0 in [('scope','all'),('mode','pair'),('reasoningMode','balanced')]:
  x=panel.locator('label[for="lpg-choice-'+k+'-'+v0+'"]');reveal(x);x.tap();assert cfg()[k]==v0
 for k,val in [('guardMode','standard'),('traceAnchor',True),('detail143',True)]:
  if k=='guardMode':panel.locator('label[for=lpg-profile-standard]').tap()
  else:panel.locator('[data-setting='+k+']').set_checked(val)
  assert cfg()[k]==val
 shot(page,'saved-pending',pfx+' .lpg-this-turn')
 inject({'protocolProfile':'standard','repairJsonMime':True,'guardMode':'standard','traceAnchor':True,'anchorSize':'long','detail143':True,'shield':'deep','macro':True,'experimentDetails':True,'passiveOutput':True,'unknown143':{'value':37},'nudge':'自定义测试'})
 orig=cfg();hist=page.evaluate('()=>Q.ctx.accountStorage.getItem("lin_prefill_guard_history_v2")')
 button('暂停本版新实验');paused=cfg();assert diff(orig,paused)==['pause143']
 button('恢复运行本版新实验');assert cfg()==orig
 button('恢复本版新实验默认值');reset=cfg();assert diff(orig,reset)==sorted(['guardMode','traceAnchor','anchorSize','repairJsonMime','detail143'])
 button('恢复新实验推荐设置');oldreset=cfg();assert diff(reset,oldreset)==sorted(['protocolProfile','macro','experimentDetails'])
 inject({'protocolProfile':'standard','macro':True});pre=cfg()
 button('关闭全部新实验');off=cfg();assert diff(pre,off)==sorted(['shield','macro','passiveOutput','protocolProfile'])
 assert page.evaluate('()=>Q.ctx.accountStorage.getItem("lin_prefill_guard_history_v2")')==hist
 for width in [320,375,390,1100]:
  page.set_viewport_size({'width':width,'height':820 if width<500 else 900})
  m=panel.evaluate("""e=>({w:e.clientWidth,scroll:e.scrollWidth,targets:[...e.querySelectorAll('.lpg-quick,.lpg-profile,.lpg-main-actions button')].map(x=>Math.floor(x.getBoundingClientRect().height)).filter(x=>x>0)})""")
  assert m['w']>0 and m['scroll']<=m['w']+1 and min(m['targets'])>=44,(width,m)
  layout.append({'cssWidth':width,'panelWidth':m['w'],'scrollWidth':m['scroll'],'minControl':min(m['targets'])})
  shot(page,'panel-'+str(width),pfx+' > summary')
 page.set_viewport_size({'width':375,'height':812});shot(page,'guard-modes',pfx+' .lpg-profiles')
 res,(_,searchraw),_=send('vertexai',True,{'guardMode':'standard','detail143':True,'traceAnchor':True});assert res['step']['anchor']=='search',res
 shot(page,'search-skip',pfx+' .lpg-this-turn')
 control['double']=True
 call('configure','vertexai',False,{'guardMode':'standard','protocolProfile':'standard','detail143':True});call('direct',body,{'pretty':True})
 shot(page,'runtime-fallback',pfx+' .lpg-this-turn')
 control['double']=False
 send('vertexai',False,{'guardMode':'standard','detail143':True,'traceAnchor':True,'repairJsonMime':True})
 shot(page,'current-diagnostics',pfx+' .lpg-this-turn')
 page.context.grant_permissions(['clipboard-read','clipboard-write']);button('复制脱敏诊断')
 shared=json.loads(page.evaluate('()=>navigator.clipboard.readText()'));assert shared['schema']==2 and shared['run']['ack']=='absent' and not shared['upstreamVerified'],shared
 (out/'redacted-example.json').write_text(json.dumps(shared,ensure_ascii=False,indent=2)+'\n')
 # Select through real UI to persist, retaining unknown keys. No altering host application files.
 panel.locator('label[for=lpg-profile-off]').tap()
 return {'native':rows,'randomCross':cross,'echoAB':ab,'requestMimeAB':mime,'legacyMatrix':names,'literary':books,'layout':layout,'settingFieldChanges':{'pause':diff(orig,paused),'restore':diff(orig,reset),'oldRecommendations':diff(reset,oldreset),'oldBulkOff':diff(pre,off)}}
def main():
 peer=ThreadingHTTPServer(('127.0.0.1',0),Peer);peer.seen=[];peer.protocols=[];peer.formats=[];peer.rawheaders=[]
 threading.Thread(target=peer.serve_forever,daemon=True).start();origin='http://127.0.0.1:'+str(peer.server_port);wire=[];control={'double':False,'confirmed':False}
 try:
  with tempfile.TemporaryDirectory() as t:
   t=Path(t);u=t/'data/default-user';extension=u/'extensions/lin-prefill-guard';extension.mkdir(parents=True);(u/'characters').mkdir();shutil.copy2(st/'default/content/default_Seraphina.png',u/'characters/fixture.png')
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
        rq=req.request;raw=rq.post_data;accept=rq.all_headers().get('accept','*/*');hh=rq.all_headers();wire.append((hh,raw))
        if control['double']:
         # Send only the Accept header and generated body to OUR loopback fixture. Never forward credentials.
         x=urllib.request.Request(origin+'/negotiate',data=raw.encode(),headers={'Accept':accept,'Content-Type':'application/json'},method='POST')
         with urllib.request.urlopen(x,timeout=10) as rr:return req.fulfill(status=rr.status,content_type=rr.headers.get_content_type(),body=rr.read())
       return req.continue_()
      page.route('**/*',route);page.goto(endpoint,wait_until='domcontentloaded',timeout=90000);ready(page)
      report=run(page,endpoint,origin,peer,wire,control)
      for _ in range(100):
       saved=json.loads((u/'settings.json').read_text()).get('extension_settings',{}).get(key,{})
       if saved.get('unknown143',{}).get('value')==37 and saved.get('guardMode')=='off':break
       page.wait_for_timeout(120)
      else:raise AssertionError('preferences did not reach settings.json')
      page.reload(wait_until='domcontentloaded');ready(page);actual=page.evaluate('()=>SillyTavern.getContext().extensionSettings.lin_prefill_guard_v1')
      assert actual['scope']=='all' and actual['reasoningMode']=='balanced' and actual['unknown143']['value']==37 and actual['nudge']=='自定义测试' and actual['guardMode']=='off'
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
       pp.locator('summary').filter(has_text='诊断与补全').first.click()
       pp.get_by_role('button',name='检查当前回复（不调用模型）').click()
       assert '字符' in pp.locator('.lpg-audit').first.inner_text()
       pp.get_by_text('手动补全 / 重生成',exact=True).click()
       start=len(wire);target=pp.get_by_role('button',name='检查操作目标（免费）')
       for which,button in [('continue','补全当前回复'),('regenerate','重生成并替换当前回复')]:
        target.click();pp.get_by_role('button',name=button).click();fixture.wait_for_function("!document.querySelector('.lpg-recovery button').disabled")
       target.click();fixture.evaluate("()=>caseState.ctx.chat.at(-1).mes+='修订'");pp.get_by_role('button',name='补全当前回复').click()
       assert fixture.evaluate('()=>caseState.actions')==['continue','regenerate'];assert len(wire)==start+2
       actionPairs.append([b for _,b in wire[start:]]);fixture.close()
      assert actionPairs[0]==actionPairs[1]
      # Exercise the unmodified ST normal/re-generate/swipe machinery and the chosen, saved reply.
      full=desktop;control['double']=False
      full.evaluate("async args=>{window.host=await import('/qa-tests/scripts/host-143.mjs');await host.setup(...args)}",[json.loads(src),origin])
      full.evaluate("()=>host.assemble(100001,'完整宿主验收场景。')");flows=[]
      for kind in ['regenerate','swipe']:
       i=len(peer.seen);v=full.evaluate("k=>host.fullSequence(k)",kind)
       assert len(peer.seen)==i+2 and v['firstSavedMarker'] and v['firstGuard']=='echo-confirmed' and v['retrySavedAnswer'] and v['retryGuard']=='omitted',(kind,v,len(peer.seen)-i)
       flows.append({'retry':kind,'requests':2,**v})
      report['hostChatLifecycle']=flows
      report.update({'manualActionBytePairs':2,'staleTargetExtraCalls':0,'desktopKeyboard':desk,'host':json.loads((st/'package.json').read_text())['version'],'hostCommit':subprocess.check_output(['git','rev-parse','HEAD'],cwd=st,text=True).strip(),'browser':br.version,'liveCloudGenerations':0,'browserGenerationPOSTs':len(wire),'nativeLoopbackCalls':len(peer.seen),'preferencesSurvivedReload':True})
      (out/'real-143.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n');print('PASS', {k:v for k,v in report.items() if k not in ['literary','legacyMatrix','native','layout']},flush=True);br.close()
    finally:proc.terminate();proc.wait(timeout=15)
 finally:peer.shutdown();peer.server_close()
if __name__=='__main__':main()
