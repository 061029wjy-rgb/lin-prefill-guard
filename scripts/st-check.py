"""Optional integration: fresh isolated ST profile + real host + loopback model double, no external keys.
Set LPG_ST_PATH (ST release checkout with npm ci), LIN290_PRESET, CHROMIUM; optional LPG_ST_REPORT.
"""
import hashlib,json,os,shutil,socket,subprocess,tempfile,threading,time,urllib.request
from pathlib import Path
from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer
from playwright.sync_api import sync_playwright
ROOT=Path(__file__).resolve().parents[1]
def port():
    with socket.socket() as s:s.bind(('127.0.0.1',0));return s.getsockname()[1]
class Model(BaseHTTPRequestHandler):
    def log_message(self,*a):pass
    def do_POST(self):
        route=self.path.split('?',1)[0]
        routes={'/v1/chat/completions':'custom','/v1beta/models/gemini-4-carbon:generateContent':'makersuite','/v1/publishers/google/models/gemini-4-carbon:generateContent':'vertexai'}
        if route not in routes:return self.send_error(404)
        o=json.loads(self.rfile.read(int(self.headers['content-length'])));self.server.seen.append(o);self.server.protocols.append(routes[route])
        if routes[route]=='custom':
            reply={'id':'ordinary-test','object':'chat.completion','choices':[{'index':0,'message':{'role':'assistant','content':'雨停了。'},'finish_reason':'stop'}],'usage':{'prompt_tokens':20,'completion_tokens':4}}
        else:
            reply={'candidates':[{'content':{'role':'model','parts':[{'text':'雨停了。'}]},'finishReason':'STOP'}]}
        data=json.dumps(reply).encode();self.send_response(200);self.send_header('Content-Type','application/json');self.send_header('Content-Length',str(len(data)));self.end_headers();self.wfile.write(data)
def main():
    st=Path(os.environ['LPG_ST_PATH']).resolve();preset_path=Path(os.environ['LIN290_PRESET']).resolve();data=preset_path.read_bytes()
    assert hashlib.sha256(data).hexdigest()=='bd5bb31893f8835a6d064b7be6fd03e6b5ad7f001cc8a75334486a47d1882766'
    b=ThreadingHTTPServer(('127.0.0.1',0),Model);b.seen=[];b.protocols=[];threading.Thread(target=b.serve_forever,daemon=True).start()
    try:
      with tempfile.TemporaryDirectory() as tmp:
        tmp=Path(tmp);user=tmp/'data/default-user';ext=user/'extensions/lin-prefill-guard';ext.mkdir(parents=True)
        for f in [*ROOT.glob('*.js'),ROOT/'style.css',ROOT/'manifest.json']:shutil.copy2(f,ext/f.name)
        config=tmp/'config.yaml';shutil.copy2(st/'default/config.yaml',config);p=port();url=f'http://127.0.0.1:{p}'
        with (tmp/'server.log').open('w') as log:
          proc=subprocess.Popen(['node','server.js','--port',str(p),'--listen','false','--enableIPv4','true','--enableIPv6','false','--browserLaunchEnabled','false','--configPath',str(config),'--dataRoot',str(tmp/'data')],cwd=st,stdout=log,stderr=subprocess.STDOUT)
          try:
            for _ in range(180):
                if proc.poll() is not None:raise RuntimeError('test server exited')
                try:
                    with urllib.request.urlopen(url,timeout=1) as r:break
                except OSError:time.sleep(.25)
            with sync_playwright() as pw:
                br=pw.chromium.launch(executable_path=os.environ.get('CHROMIUM') or shutil.which('chromium'),headless=True,args=['--no-sandbox','--disable-dev-shm-usage'])
                page=br.new_page();page.route('**/*',lambda route: route.continue_() if route.request.url.startswith(url+'/') or route.request.url.startswith(('blob:','data:')) else route.abort())
                page.goto(url,wait_until='domcontentloaded',timeout=90000)
                page.wait_for_function("typeof window.SillyTavern?.getContext==='function' && !!SillyTavern.getContext().eventSource",timeout=45000)
                page.wait_for_function("document.querySelector('#lin-prefill-guard-panel')!=null",timeout=45000)
                page.evaluate("""async ([p,modelUrl])=>{
                    const ctx=SillyTavern.getContext(),oa=await import('/scripts/openai.js');
                    Object.assign(ctx.chatCompletionSettings,p,{name:p.name,preset_settings_openai:p.name,chat_completion_source:'custom',custom_model:'gemini-4-carbon',
                        custom_url:modelUrl,stream_openai:false,custom_prompt_post_processing:'',custom_include_body:'',custom_include_headers:'',custom_exclude_body:'',
                        function_calling:false,request_images:false,openai_max_context:250000});
                    const q={role:'user',content:'本地合成场景：两人进屋。'};
                    const ms=(await oa.prepareOpenAIMessages({name2:'样本乙',charDescription:'',charPersonality:'',scenario:'',worldInfoBefore:'',worldInfoAfter:'',bias:'',type:'normal',quietPrompt:'',quietImage:'',extensionPrompts:{},cyclePrompt:'',
                        systemPromptOverride:'',jailbreakPromptOverride:'',messages:[q],messageExamples:[]},false))[0];
                    if(!Array.isArray(ms)||!ms.some(m=>m.role==='user'&&m.content===q.content))throw Error('host did not assemble the fixture user message: '+ms?.length);
                    const ends=['e898d676-f02e-4868-bc51-33761e294df6','68186c40-6f11-4c47-a036-58497d1d6795'].map(id=>p.prompts.find(x=>x.identifier===id).content);
                    window.localHost={ctx,oa,ms,tails:ends.map(t=>ms.filter(m=>m.content===t).length)};
                }""",[json.loads(data),f'http://127.0.0.1:{b.server_port}/v1'])
                incoming=[];page.on('request',lambda rq:incoming.append(json.loads(rq.post_data)) if rq.url==url+'/api/backends/chat-completions/generate' else None)
                results=[]
                for sh in ['off','standard','deep']:
                  for macro in [False,True]:
                    status=page.evaluate("""async ([s,r])=>{
                        const {ctx,oa,ms,tails}=window.localHost;
                        Object.assign(ctx.extensionSettings.lin_prefill_guard_v1,{requestMode:'gemini4',enabled:true,compat290:true,shield:s,macro:r,captureNetwork:true,passiveOutput:true});
                        await ctx.eventSource.emit(ctx.eventTypes.GENERATION_STARTED,'normal',{},false);
                        const result=await oa.sendOpenAIRequest('normal',structuredClone(ms),null);
                        await ctx.eventSource.emit(ctx.eventTypes.GENERATION_ENDED,ms.length);
                        const rec=JSON.parse(ctx.accountStorage.getItem('lin_prefill_guard_history_v2')||'[]')[0];
                        return {visible:result.choices?.[0]?.message?.content,status:rec?.experiment?.status,loc:rec?.experiment?.location,anchorCounts:tails,assembledLength:ms.length};
                    }""",[sh,macro]);assert status.pop('visible')=='雨停了。';assert len(incoming)==len(results)+1==len(b.seen)
                    received=json.loads(json.dumps(b.seen[-1]));out=json.loads(json.dumps(incoming[-1]))
                    if not results:baseline=received;basewire=out
                    def strip(actual,ref):
                        if len(actual['messages'])==len(ref['messages']):return actual,None
                        extra=[(i,v) for i,v in enumerate(actual['messages']) if v['role']=='system' and isinstance(v['content'],str) and (v['content'].startswith('LPG ') or v['content'].startswith('{"lin":'))]
                        assert len(extra)==1;idx,part=extra[0];actual['messages'].pop(idx);return actual,idx
                    raw,ai=strip(received,baseline);wire,wi=strip(out,basewire)
                    assert raw==baseline and wire==basewire and ai==wi,'underlying ST changed outside the owned message'
                    expected=(sh!='off' or macro);assert (ai is not None)==expected,(status,ai,expected)
                    results.append({'shield':sh,'macro':macro,'auxIndex':ai,**status});print('PASS actual ST',sh,macro,'received independent system message index',ai,flush=True)
                # Use the real host provider adapters and their normal local reverse-proxy confirmation.
                # Only our loopback endpoint receives the provider body; it never logs query strings or headers.
                gresults=[];origin=f'http://127.0.0.1:{b.server_port}'
                for provider in ('makersuite','vertexai'):
                    controls={}
                    for search,shield,macro in [(False,'off',False),(False,'standard',False),(False,'deep',True),(True,'off',False),(True,'deep',True)]:
                        page.evaluate("""([provider,proxy,search,shield,macro])=>{
                          const {ctx,oa,ms}=window.localHost;
                          Object.assign(ctx.chatCompletionSettings,{chat_completion_source:provider,google_model:'gemini-4-carbon',vertexai_model:'gemini-4-carbon',reverse_proxy:proxy,proxy_password:'',use_sysprompt:true,enable_web_search:search});
                          Object.assign(ctx.extensionSettings.lin_prefill_guard_v1,{requestMode:'gemini4',enabled:true,compat290:true,shield,macro,captureNetwork:true,passiveOutput:false});
                          window.localRun=(async()=>{
                            await ctx.eventSource.emit(ctx.eventTypes.GENERATION_STARTED,'normal',{},false);
                            const out=await oa.sendOpenAIRequest('normal',structuredClone(ms),null);
                            await ctx.eventSource.emit(ctx.eventTypes.GENERATION_ENDED,ms.length);
                            const rec=JSON.parse(ctx.accountStorage.getItem('lin_prefill_guard_history_v2')||'[]')[0];
                            return {visible:out.choices?.[0]?.message?.content,status:rec?.experiment?.status};
                          })();
                        }""",[provider,origin,search,shield,macro])
                        if provider=='makersuite' and not gresults:
                            dialog=page.locator('dialog[open]').filter(has_text=origin)
                            dialog.locator('.popup-button-ok').click(timeout=15000)
                        reply=page.evaluate('()=>window.localRun')
                        assert reply.get('visible')=='雨停了。' and b.protocols[-1]==provider,provider
                        assert len(incoming)==len(b.seen)==len(results)+len(gresults)+1
                        src=json.loads(json.dumps(b.seen[-1]));wire=json.loads(json.dumps(incoming[-1]))
                        assert wire['enable_web_search']==search
                        if shield=='off':controls[search]=(json.loads(json.dumps(src)),json.loads(json.dumps(wire)))
                        base,baseWire=controls[search]
                        assert any('google_search' in t for t in src.get('tools',[]))==search
                        want=not search and shield!='off'
                        seen=[i for i,v in enumerate(src['systemInstruction']['parts']) if isinstance(v.get('text'),str) and (v['text'].startswith('LPG ') or v['text'].startswith('{"lin":'))]
                        assert len(seen)==int(want)
                        if seen:src['systemInstruction']['parts'].pop(seen[0])
                        wire,wi=strip(wire,baseWire)
                        assert (wi is not None)==want and src==base and wire==baseWire
                        assert reply['status']==('290-host-search' if search else 'owned-slot' if want else 'off')
                        gresults.append({'source':provider,'search':search,'shield':shield,'macro':macro,'status':reply['status'],'auxSystemPartIndex':seen[0] if seen else None,'preservedGoogleSearch':search,'allOtherFieldsMatch':True})
                        print('PASS actual ST adapter',provider,'search',search,'shield',shield,'sample',macro,'server tool preserved',search,flush=True)
                result={'hostVersion':json.loads((st/'package.json').read_text())['version'],'hostCommit':subprocess.check_output(['git','rev-parse','HEAD'],cwd=st,text=True).strip(),
                  'browser':br.version,'source':'ST custom, makersuite and vertexai (host reverse-proxy mode) → loopback protocol doubles','generatedByRealModel':False,'input':'uploaded preset, host Prompt Manager, one synthetic user message; same assembled snapshot replayed',
                  'realFrontendAndBackendRequests':len(results)+len(gresults),'results':results,'nativeAdapterResults':gresults}
                if os.environ.get('LPG_ST_REPORT'):Path(os.environ['LPG_ST_REPORT']).write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n')
                print('PASS real frontend, UI extension, settings event, browser POST, ST backend and local responder; no cloud model.',flush=True);br.close()
          finally:
            proc.terminate()
            try:proc.wait(timeout=8)
            except subprocess.TimeoutExpired:proc.kill();proc.wait()
    finally:b.shutdown();b.server_close()
if __name__=='__main__':main()
