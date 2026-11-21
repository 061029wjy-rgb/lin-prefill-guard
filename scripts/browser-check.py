"""Actual Chromium -> loopback HTTP acceptance, with an ST event double. Never contacts a model."""
from __future__ import annotations
import hashlib, json, os, re, shutil, sys, threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from playwright.sync_api import sync_playwright
ROOT=Path(__file__).resolve().parents[1]
def dumps(v): return json.dumps(v,ensure_ascii=False,separators=(',',':'))
def sha(v): return hashlib.sha256(v if isinstance(v,bytes) else v.encode()).hexdigest()
def frame(o):return 'data: '+(o if isinstance(o,str) else dumps(o))+'\r\n\r\n'
BODY=frame({'choices':[{'index':0,'delta':{'content':'雨停了。'},'finish_reason':'stop'}],'usage':{'prompt_tokens':27,'prompt_tokens_details':{'cached_tokens':0}}})+frame('[DONE]')
class Server(SimpleHTTPRequestHandler):
    def __init__(self,*args,**kw): super().__init__(*args,directory=str(ROOT),**kw)
    def log_message(self,*a): pass
    def reply(self,body,t='application/json',code=200):
        data=body.encode();self.send_response(code);self.send_header('Content-Type',t);self.send_header('Content-Length',str(len(data)));self.end_headers();self.wfile.write(data)
    def do_GET(self):
        if self.path=='/fixture':return self.reply('<!doctype html><meta charset="utf-8"><div id="extensions_settings"></div>','text/html')
        if self.path.split('?')[0].endswith(('.js','.mjs','.css')) and '..' not in self.path and not self.path.startswith('/.'):return super().do_GET()
        self.send_error(404)
    def do_POST(self):
        data=self.rfile.read(int(self.headers.get('Content-Length','0'))).decode()
        if self.path=='/api/backends/chat-completions/generate':
            self.server.captures.append((self.headers.get('X-Local-Fixture'),data));return self.reply(BODY,'text/event-stream')
        if self.path=='/api/files/upload':
            self.server.unrelated+=1;return self.reply(data,'text/plain')
        if self.path=='/lab/model':
            obj=json.loads(data);fmt=self.headers.get('X-Protocol');want=self.headers.get('X-Stream')=='true';text='雨后，钟响了一声。';args=dumps({'text':text})
            schema={'type':'object','properties':{'text':{'type':'string'}},'required':['text'],'additionalProperties':False}
            if fmt=='chat':
                tool=obj['tools'][0]['function'];assert tool['parameters']==schema
                call={'id':'wire-c1','type':'function','function':{'name':tool['name'],'arguments':args}}
                turn={'role':'assistant','tool_calls':[call]};self.server.lab=(fmt,turn,text)
                if want:
                    head={'choices':[{'index':0,'delta':{'tool_calls':[dict(call,index=0,function={'name':tool['name'],'arguments':args[:8]})]}}]}
                    tail={'choices':[{'index':0,'delta':{'tool_calls':[{'index':0,'function':{'arguments':args[8:]}}]},'finish_reason':'tool_calls'}]}
                    return self.reply(frame(head)+frame(tail)+frame('[DONE]'),'text/event-stream')
                return self.reply(dumps({'choices':[{'index':0,'finish_reason':'tool_calls','message':turn}]}))
            decl=obj['tools'][0]['functionDeclarations'][0];assert decl['parameters']==schema
            turn={'role':'model','parts':[{'thoughtSignature':'synthetic-signature','functionCall':{'id':'wire-g1','name':decl['name'],'args':{'text':text}}}]}
            self.server.lab=(fmt,turn,text);return self.reply(dumps({'candidates':[{'finishReason':'STOP','content':turn}]}))
        if self.path=='/lab/result':
            o=json.loads(data);fmt,turn,text=self.server.lab;assert o['turn']==turn and o['fmt']==fmt
            reply=o['result']
            if fmt=='google':
                fr=reply['parts'][0]['functionResponse'];assert (fr['id'],fr['response']['text'],fr['name'])==('wire-g1',text,'lin_preview_text')
            else: assert reply['tool_call_id']=='wire-c1' and json.loads(reply['content'])=={'text':text}
            self.server.lab_pairs+=1;return self.reply(dumps(reply))
        self.send_error(404)
def main():
    srv=ThreadingHTTPServer(('127.0.0.1',0),Server);srv.captures=[];srv.lab_pairs=srv.unrelated=0
    threading.Thread(target=srv.serve_forever,daemon=True).start()
    cases=[];evidence=[]
    for kind in ['chat','native']:
        for mode in ['off','standard','deep']:
            for random in [False,True]:
                cases.append(dict(name=f'{kind}-{mode}-'+('sample' if random else 'plain'),native=kind=='native',shield=mode,macro=random,expect=mode!='off' or random))
    for x in ['drift','chat','host-search','root-json','structured','signed','tools','prefix']:
        cases.append(dict(name='skip-'+x,native=x=='signed',special=x,shield='deep',macro=True,expect=False))
    for t in ['continue','quiet','impersonate','regenerate','swipe']:
        cases.append(dict(name='type-'+t,type=t,shield='standard',expect=t in ['swipe','regenerate']))
    cases.append(dict(name='swapped-off',reverse=True,expect=False));cases.append(dict(name='swapped-deep',reverse=True,shield='deep',expect=True))
    cases.append(dict(name='long-context',special='large',shield='standard',expect=True))
    for g,pos in [(1,'early'),(3,'boundary')]:
        for size in ['short','medium','long']:cases.append(dict(name=f'length-{g}-{pos}-{size}',groups=g,pos=pos,size=size,macro=True,expect=True))
    if os.environ.get('LIN290_PRESET'):
        ref=Path(os.environ['LIN290_PRESET']).read_bytes()
        assert sha(ref)=='bd5bb31893f8835a6d064b7be6fd03e6b5ad7f001cc8a75334486a47d1882766'
        for group in (100000,100001):
            for mode in ['off','standard','deep']:
                for random in [False,True]:cases.append(dict(name=f'original-{group}-{mode}-{random}',real=True,group=group,shield=mode,macro=random,expect=mode!='off' or random))
    try:
        with sync_playwright() as pw:
            br=pw.chromium.launch(executable_path=os.environ.get('CHROMIUM') or shutil.which('chromium') or None,headless=True,args=['--no-sandbox','--disable-dev-shm-usage'])
            page=br.new_page(viewport={'width':390,'height':844});page.set_default_timeout(8000);errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
            page.goto(f'http://127.0.0.1:{srv.server_port}/fixture');page.evaluate("async()=>{window.run=await import('/scripts/browser-driver.mjs')}")
            if os.environ.get('LIN290_PRESET'):page.evaluate('v=>window.privateReference=v',json.loads(ref))
            for c in cases:
                before=len(srv.captures);res=page.evaluate('c=>run.exercise(c)',dict(c,reply=BODY));assert len(srv.captures)==before+1 and srv.captures[-1][0]==c['name'],c['name']
                original=res['raw'];actual=srv.captures[-1][1];wanted=json.loads(original);received=json.loads(actual);exp=c['expect'];assert res['panels']==1 and res['status']==200
                if c.get('reverse'):wanted['messages'][-2:]=reversed(wanted['messages'][-2:])
                slot=None;sample=None
                if exp:
                    arr=received['systemInstruction']['parts'] if c.get('native') else received['messages'];field='text' if c.get('native') else 'content'
                    markers=[(i,a) for i,a in enumerate(arr) if isinstance(a.get(field),str) and (a[field].startswith('LPG ') or a[field].startswith('{"lin":'))]
                    assert len(markers)==1,c['name'];slot,part=markers[0];sample=part[field]
                    if not c.get('native'):assert part['role']=='system'
                    if c.get('macro'):
                        n={'short':8,'medium':16,'long':24}[c.get('size','short')];g=c.get('groups',1);assert re.search('(?<![a-f0-9])[a-f0-9]{'+str(n)+'}(?:-[a-f0-9]{'+str(n)+'}){'+str(g-1)+'}(?![a-f0-9])',sample),sample
                    if c.get('shield')=='standard' and not c.get('macro'):assert sample=='LPG format=1'
                    if c.get('shield')=='deep' and not c.get('macro'):assert sample=='{"lin":{"format":1}}'
                    arr.pop(slot)
                assert received==wanted,c['name']
                if not exp and not c.get('reverse'):assert actual==original,c['name']
                row={'case':c['name'],'http':res['status'],'changed':actual!=original,'originalSha256':sha(original),'receivedSha256':sha(actual),'auxIndex':slot,'auxText':sample,'netBytes':len(actual.encode())-len(original.encode()),'protectedMatch':True}
                evidence.append(row);print('PASS browser',c['name'],'deltaBytes',row['netBytes'])
            assert page.evaluate('()=>run.unrelated()') and srv.unrelated==1
            for fmt,stream in [('chat',False),('chat',True),('google',False)]:
                pair=page.evaluate('x=>run.toolLab(x)',dict(fmt=fmt,stream=stream));assert pair['text']=='雨后，钟响了一声。' and (fmt!='google' or pair['signature']=='synthetic-signature')
            life=page.evaluate('()=>run.lifecycle()');assert srv.lab_pairs==3 and life['ok'] and srv.captures[-1]==('after-reset',life['raw'])
            assert not errors,errors
            report={'browser':br.version,'host':'ST event fixture → real Chromium fetch → local HTTP receiver (no model)','caseCount':len(cases),'activeToolRoundTrips':3,'filesUploadUnchanged':True,'singleHookAfterReload':True,'resetControlsSettingsAndNextPostBytes':True,'pageErrors':errors,'cases':evidence}
            br.close()
            if os.environ.get('LPG_BROWSER_REPORT'):Path(os.environ['LPG_BROWSER_REPORT']).write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
            print('PASS original response bytes, three isolated tool round trips, upload passthrough, disable/reload; Chromium',report['browser'],'cases',len(cases))
    finally:srv.shutdown();srv.server_close()
if __name__=='__main__':main()
