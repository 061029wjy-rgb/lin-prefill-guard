import test from 'node:test';
import assert from 'node:assert/strict';
import {host} from '../fixtures/host.mjs';
import {payload} from '../fixtures/protocol.mjs';
import {createController} from '../controller.js';
import {inspectResponse,installObserver} from '../observer.js';
import {createCoordinator} from '../coordinator.js';
import {shareResult} from '../current-result.js';
import {createHistory,HISTORY_KEY} from '../diagnostics.js';
import {observeConsumed} from '../wire-response.js';
import {verdict} from '../response-evidence.js';
import {TRACE_HEADER,drawAnchor,newHeaders,receiptAnchor,echoGuard,reset143,togglePause143,NEW_DEFAULTS,newFlags,eligibility} from '../shield-engine.js';
import {compat290} from '../lin290.js';
import {DEFAULTS,normalizeSettings,migrateSettings,VERSION} from '../core.js';
import {readDeclaredText} from '../scripts/lab-text-143.mjs';
const ep='/api/backends/chat-completions/generate',H={'Content-Type':'application/json'},Q='两人在雨停后各自出门。';
const make=(v,status=200,headers={})=>new Response(JSON.stringify({choices:[{index:0,message:{content:v},finish_reason:'stop'}]}),{status,headers:{...H,...headers}});
const findAux=r=>(r.messages||r.systemInstruction.parts).map(m=>m.content??m.text).find(t=>typeof t==='string'&&/^(?:LPG |\{"lin":)/.test(t));
function setup(settings={},handler=(r,h)=>make(findAux(r)||'合成正文。',200,h.has(TRACE_HEADER)?{[TRACE_HEADER]:h.get(TRACE_HEADER)}:{})){
    const a=host({guardMode:'standard',shield:'standard',...settings}),sent=[];
    a.ctx.characterId=1;a.ctx.name2='测试角色';a.ctx.chat.push({is_user:true,mes:Q});
    const original=async(input,init)=>{const r=JSON.parse(init.body),h=new Headers(init.headers);sent.push({r,h,init});return handler(r,h);};
    const net={location:{href:'https://fixture.invalid/'},fetch:original};
    const c=createController({getSettings:()=>a.settings,getContext:()=>a.ctx,networkTarget:net});
    const req=(type='normal',o={})=>({...payload({type,...o}),stream:false});
    async function prepare(r){await a.bus.emit('GENERATION_STARTED',r.type,{},false);await a.bus.emit('CHAT_COMPLETION_SETTINGS_READY',r);}
    async function post(r,body=JSON.stringify(r),headers=H){const out=await net.fetch(ep,{method:'POST',headers,body});const text=await out.text();await c.idle();return {text,last:c.snapshot().last,send:sent.at(-1)};}
    async function gen(r){await prepare(r);const result=await post(r);await a.bus.emit('GENERATION_ENDED');return result;}
    return {...a,c,req,net,sent,prepare,post,gen};
}
for(const source of ['vertexai','makersuite'])for(const native of [false,true])for(const kind of ['swipe','regenerate'])
test('only the previous proven echo suppresses our optional area; '+[source,native,kind],async()=>{
    const h=setup({macro:true});const r=h.req('normal',{source,native});const a=await h.gen(r);
    assert.equal(a.last.experiment.v143.guard,'echo-confirmed');const echoed=findAux(a.send.r);assert.ok(echoed);
    h.ctx.chat.push({is_user:false,mes:echoed});const v=h.req(kind,{source,native}),b=await h.gen(v);
    assert.equal(b.last.experiment.v143.guard,'omitted');assert.equal(b.send.init.body,JSON.stringify(v));assert.equal(JSON.parse(b.text).choices[0].message.content,'合成正文。');
    assert.equal(h.settings.shield,'standard');assert.equal(h.settings.macro,true);
    const next=await h.gen(v);assert.ok(findAux(next.send.r));assert.equal(h.sent.length,3);h.c.dispose();
});
for(const [label,mutate] of Object.entries({
    'new user':h=>h.ctx.chat.push({is_user:true,mes:Q}), 'different actor':h=>h.ctx.characterId=7,'edited user':h=>h.ctx.chat[0].mes='后来改了',
    'different room':h=>h.ctx.chatId='x','different swipe of user':h=>h.ctx.chat[0].swipe_id=3,
    'unrelated assistant':h=>h.ctx.chat.push({is_user:false,mes:'独立的故事'}),
    'stop event':h=>h.bus.emit('GENERATION_STOPPED'),'chat event':h=>h.bus.emit('CHAT_CHANGED'),
}))test('never omits for '+label,async()=>{const h=setup();await h.gen(h.req());await mutate(h);
    assert.ok(findAux((await h.gen(h.req('regenerate'))).send.r));h.c.dispose();});
for(const text of ['还有正文。LPG format=1','抱歉。','LPG format=1\n下雨了。','<!-- LPG format=1 -->',''])
test('not an entire marker: '+JSON.stringify(text),async()=>{const h=setup({},()=>make(text));const a=await h.gen(h.req());
    assert.notEqual(a.last.experiment.v143.guard,'echo-confirmed');assert.ok(findAux((await h.gen(h.req('swipe'))).send.r));h.c.dispose();});
for(const [label,handler] of Object.entries({
    length:()=>new Response('{"choices":[{"message":{"content":"LPG format=1"},"finish_reason":"length"}]}'),
    malformed:()=>new Response('data: bad\n\ndata: [DONE]\n\n'),refusal:()=>new Response('{"choices":[{"message":{"content":"LPG format=1","refusal":"x"},"finish_reason":"stop"}]}'),
    server:()=>make('LPG format=1',503), mismatched:()=>make('LPG format=1',200,{[TRACE_HEADER]:'wrong'}),
}))test('weak/foreign return cannot arm guard: '+label,async()=>{const h=setup({traceAnchor:true,passiveOutput:true},handler);
    const a=await h.gen(h.req());assert.notEqual(a.last.experiment.v143.guard,'echo-confirmed');if(label==='mismatched'){assert.equal(a.last.experiment.v143.ack,'mismatch');assert.equal(h.c.getVisibleOutput(),'');assert.ok(a.text.includes('LPG format=1'));}
    assert.ok(findAux((await h.gen(h.req('swipe'))).send.r));h.c.dispose();});
test('late same-room result cannot arm new question or re-enable after stop',async()=>{
    const h=setup();const r=h.req();await h.prepare(r);const late=await h.net.fetch(ep,{method:'POST',headers:H,body:JSON.stringify(r)});
    await h.prepare(h.req('swipe'));await late.text();await h.c.idle();assert.ok(findAux((await h.post(h.req('swipe'))).send.r));
    await h.prepare(r);const afterStop=await h.net.fetch(ep,{method:'POST',headers:H,body:JSON.stringify(r)});await h.bus.emit('GENERATION_STOPPED');await afterStop.text();await h.c.idle();
    assert.ok(findAux((await h.gen(h.req('swipe'))).send.r));h.c.dispose();
});
test('pure sample echo; previous model/connection or expired evidence cannot be inherited',async()=>{
    const h=setup({macro:true},r=>make(findAux(r)?.split('sample=')[1]||'ok'));const a=await h.gen(h.req());
    assert.equal(a.last.wire.ownedEchoOnly,'sample');assert.equal(a.last.experiment.v143.guard,'echo-confirmed');
    assert.ok(findAux((await h.gen(h.req('swipe',{model:'gemini-4-neon'}))).send.r));h.c.dispose();
    let time=0;const g=echoGuard(()=>time);g.start('normal');const ctx={characterId:1,chatId:'a',chat:[{is_user:true,mes:Q}]},r=payload();
    assert.equal(g.observe(g.bind(ctx,r),ctx,r,{httpStatus:200,responseComplete:true,recognized:true,finishReason:'stop',ownedEchoOnly:'whole'},'LPG format=1',''),true);
    time=180001;g.start('regenerate');const v={...r,type:'regenerate'};assert.equal(g.shouldOmit(g.bind(ctx,v),ctx,v),false);
});
for(const size of ['short','medium','long'])test('bounded transport trace '+size+' never modifies a model field; duplicate lifecycle draws once',async()=>{
    const h=setup({traceAnchor:true,anchorSize:size,shield:'off',guardMode:'off'});
    const r=h.req();await h.prepare(r);await h.bus.emit('CHAT_COMPLETION_SETTINGS_READY',r);
    const a=await h.post(r),b=await h.post(r);const v=a.send.h.get(TRACE_HEADER);
    assert.match(v,/^[0-9a-f]+$/);assert.equal(v.length,{short:16,medium:24,long:32}[size]);assert.equal(v,b.send.h.get(TRACE_HEADER));
    assert.equal(a.send.init.body,JSON.stringify(r));assert.equal(a.last.experiment.v143.ack,'matched');
    const c=await h.gen(h.req('swipe'));assert.notEqual(c.send.h.get(TRACE_HEADER),v);
    const d=await h.gen(h.req('continue'));assert.equal(d.send.h.has(TRACE_HEADER),false);
    assert.ok(![...h.db.values()].join().includes(v));h.c.dispose();
});
test('explicit content types, header collisions, size failures, missing/foreign return and throwing RNG',()=>{
    const s={traceAnchor:true,anchorSize:'medium',repairJsonMime:true};const init={method:'POST',body:'{}',headers:{}};
    let calls=0;const t={bytes(){calls++;throw Error('unavailable');}};
    for(let i=0;i<4;i++){const a=newHeaders(init,ep,s,t);assert.equal(a.mime,'added');assert.equal(a.anchor,'unavailable');assert.equal(a.init.body,init.body);}
    assert.equal(calls,1);assert.equal(init.headers['Content-Type'],undefined);
    const explicit={...init,headers:{'content-type':'text/plain'}};assert.equal(newHeaders(explicit,ep,s,{}).init,explicit);
    const old={...init,headers:{...H,[TRACE_HEADER]:'pre-existing'}};assert.equal(newHeaders(old,ep,s,{}).init,old);
    assert.throws(()=>drawAnchor('unbounded'));assert.throws(()=>drawAnchor('short',()=>new Uint8Array(99)));
    assert.equal(receiptAnchor('v',new Response(null)),'absent');assert.equal(receiptAnchor(null,new Response(null)),'none');
    assert.equal(receiptAnchor('v',{redirected:true}),'unknown');
});
for(const [label,edit] of Object.entries({
    photo:r=>r.messages[0].content=[{type:'image_url',image_url:{url:'fixture'}}],audio:r=>r.messages[0].content=[{type:'input_audio',input_audio:{data:'fixture'}}],
    tool:r=>r.tools=[{type:'function'}],signature:r=>r.messages[0].thoughtSignature='fixture',mcp:r=>r.mcp_servers=['fixture'],schema:r=>r.response_format={type:'json_schema'},
    prefill:r=>r.assistant_prefill='opened',cache:r=>r.cachedContent='existing',continuation:r=>r.continuationToken='opaque',custom:r=>r.chat_completion_source='custom',
    search:r=>r.enable_web_search=true,unrecognized:r=>r.model='unknown',mixed:r=>r.extra_property=true,
}))test('new layers do not modify protected/unknown '+label,async()=>{const h=setup({shield:'off',traceAnchor:true,repairJsonMime:true});
    const r=h.req();edit(r);await h.prepare(r);const a=await h.post(r,JSON.stringify(r),{});assert.equal(a.send.h.has(TRACE_HEADER),false);assert.equal(a.send.h.has('Content-Type'),false);
    assert.equal(a.send.init.body,JSON.stringify(r));h.c.dispose();});
test('malformed serialization, signing, config change and racing preparation do not acquire new headers',async()=>{
    const h=setup({shield:'off',traceAnchor:true,repairJsonMime:true});const r=h.req();
    for(const [body,headers] of [[JSON.stringify(r,null,1),{}],[JSON.stringify(r).replace('"type":"normal"','"type":"normal","type":"normal"'),{}],[JSON.stringify(r),{Signature:'fixture'}]]){
      await h.prepare(r);const a=await h.post(r,body,headers);assert.equal(a.send.init.body,body);assert.equal(a.send.h.has(TRACE_HEADER),false);
    }
    await h.prepare(r);await h.bus.emit('CHAT_COMPLETION_SETTINGS_READY',{...r,temperature:1});assert.equal((await h.post(r)).send.h.has(TRACE_HEADER),false);
    await h.prepare(r);h.settings.anchorSize='long';assert.equal((await h.post(r)).send.h.has(TRACE_HEADER),false);h.c.dispose();
});
for(const [name,body,status,wanted] of [
 ['400','',400,'http-error'],['403','{}',403,'http-error'],['429','{}',429,'http-error'],['503','{}',503,'http-error'],
 ['envelope','{"error":{"code":503,"message":"do-not-save"}}',200,'envelope-error'],['done','data: [DONE]\n\n',200,'done-only'],['empty','',200,'no-bytes'],
 ['malformed','data: bad\n\n',200,'parse-error'],['stop','{"choices":[{"message":{"content":"error 503 in the story"},"finish_reason":"stop"}]}',200,'stop'],
 ['safety','{"promptFeedback":{"blockReason":"SAFETY"}}',200,'filtered'],['budget','{"candidates":[{"finishReason":"MAX_TOKENS"}]}',200,'token-limit'],
 ['continuation','{"candidates":[{"finishReason":"CONTINUATION"}]}',200,'continuation'],['tool','{"choices":[{"message":{"tool_calls":[{}]},"finish_reason":"tool_calls"}]}',200,'tool'],
 ['unknown','data: {"unrecognized":1}\n\ndata: [DONE]\n\n',200,'unknown'],
])test('evidence without guesses: '+name,async()=>{const s=await inspectResponse(new Response(body,{status}));assert.equal(verdict(s),wanted);
    if(name==='envelope')assert.equal(s.apiStatus,503);assert.ok(!JSON.stringify(s).includes('do-not-save'));});
test('pause/resume, reset and old settings have disjoint effects; hashes and secrets do not enter new persistent/share records',()=>{
    const ini={...DEFAULTS,shield:'deep',macro:true,passiveOutput:true,protocolProfile:'standard',nudge:'owned-private',future:{a:1},traceAnchor:true,guardMode:'standard',repairJsonMime:true,detail143:true,anchorSize:'long'};
    const s=migrateSettings(ini);togglePause143(s);assert.deepEqual(s,{...ini,pause143:true});togglePause143(s);assert.deepEqual(s,ini);
    reset143(s);assert.deepEqual(s,{...ini,...NEW_DEFAULTS});
    const db=new Map(),hist=createHistory(()=>({getItem:k=>db.get(k),setItem:(k,v)=>db.set(k,v)}));
    hist.put({id:'id',version:VERSION,wire:{textDigest:'not-persisted'},rendered:{textDigest:'not-persisted'}});
    assert.ok(!db.get(HISTORY_KEY).includes('not-persisted'));assert.equal(JSON.parse(db.get(HISTORY_KEY))[0].digestAgreement,true);
    assert.equal(hist.list()[0].wire.textDigest,'not-persisted');const d=shareResult({wire:{textDigest:'private',apiError:true},experiment:{v143:{ack:'private',anchor:'private',value:'private',guard:'private'}}});
    assert.ok(!JSON.stringify(d).includes('private'));
});
test('text and tool-output prototypes are isolated: never reconstruct omitted words',()=>{
    const v={finish:'STOP',tool:false,parts:['[fixture text]\n本地已有文本。\n[/fixture text]']};
    assert.equal(readDeclaredText(v),'本地已有文本。');
    for(const t of [{...v,finish:'MAX_TOKENS'},{...v,tool:true},{...v,parts:[...v.parts,'more']},{...v,parts:['[fixture text]\n丢了结尾']},{...v,parts:['[fixture text]\n[fixture text]\n[/fixture text]']}])assert.equal(readDeclaredText(t),null);
});
test('unload stops observing an unfinished managed stream without closing host reader',async()=>{
    let emit;const src=new ReadableStream({start(c){emit=c;}},{highWaterMark:0});let dead=false,clear,finished=0;
    const r=observeConsumed(new Response(src),{live:()=>!dead,finish(){finished++;},failed(){finished++;},register:fn=>{clear=fn;return ()=>{};}});
    assert.equal(clear,undefined);const reader=r.body.getReader(),a=reader.read();emit.enqueue(new Uint8Array([11]));assert.equal((await a).value[0],11);
    dead=true;clear();emit.enqueue(new Uint8Array([23]));emit.close();assert.equal((await reader.read()).value[0],23);assert.equal((await reader.read()).done,true);assert.equal(finished,0);
});
for(const [kind,fn] of Object.entries({
 'explicit MIME':async(h,r)=>{await h.prepare(r);return h.post(r,JSON.stringify(r),{'content-type':'text/plain'});},
 'old settings changed':async(h,r)=>{h.settings.shield='deep';return h.gen(r);},
}))test('retry keeps old optional area when '+kind,async()=>{const h=setup({repairJsonMime:true});await h.gen(h.req());const z=await fn(h,h.req('swipe'));assert.ok(findAux(z.send.r));if(kind==='explicit MIME')assert.equal(z.last.experiment.v143.mime,'explicit');h.c.dispose();});
for(const [label,frames] of Object.entries({
 'unknown frame':[{unrecognizedOutput:'fixture'}], 'divergent terminal':[{choices:[{finish_reason:'length'}]}],
 'multiple stream indices':[{choices:[{index:1,delta:{content:'other'}}]}],
 'unknown visible part':[{choices:[{delta:{content:[{type:'image'}]}}]}],
}))test('cannot arm on '+label,async()=>{const s='data: '+[...frames,{choices:[{index:0,delta:{content:'LPG format=1'},finish_reason:'stop'}]}].map(x=>JSON.stringify(x)).join('\n\ndata: ')+'\n\ndata: [DONE]\n\n';
 const h=setup({},()=>new Response(s,{headers:{'Content-Type':'text/event-stream'}}));const r={...h.req(),stream:true};let a=await h.gen(r);assert.equal(a.last.wire.unverifiedEchoShape,true);assert.notEqual(a.last.experiment.v143.guard,'echo-confirmed');h.c.dispose();});
test('complete non-stream Google wrapper without terminal is explained, never guessed',async()=>{
 const h=setup({},()=>new Response(JSON.stringify({choices:[{message:{content:'LPG format=1'}}],responseContent:{parts:[{text:'LPG format=1'}]}}),{headers:H}));
 const a=await h.gen(h.req());assert.equal(a.last.experiment.v143.guard,'end-unverified');assert.equal(a.last.wire.finishReason,undefined);
 assert.ok(findAux((await h.gen(h.req('swipe'))).send.r));h.c.dispose();
});
test('unknown caller headers, malformed explicit charset and multi-candidate plans never acquire new tracing',async()=>{
 const h=setup({shield:'off',traceAnchor:true,repairJsonMime:true});
 for(const [r,headers] of [[h.req(),{...H,'X-Partner-Attestation':'test'}],[h.req(),{'Content-Type':'application/json; charset="utf-8'}],[{...h.req(),n:2},H],[{...h.req('normal',{native:true}),generationConfig:{candidateCount:2}},H]]){
   await h.prepare(r);const a=await h.post(r,JSON.stringify(r),headers);assert.equal(a.send.init.body,JSON.stringify(r));
   assert.equal(a.send.h.has(TRACE_HEADER),false);
 }h.c.dispose();
});
test('foreign payload alongside known text or contradictory second representation cannot arm',async()=>{
 for(const extra of [{unrecognized_answer:'other'},{responseContent:{parts:[{text:'different'}]}}]){
  const h=setup({},()=>new Response(JSON.stringify({choices:[{message:{content:'LPG format=1'},finish_reason:'stop'}],...extra}),{headers:H}));
  const a=await h.gen(h.req());assert.equal(a.last.experiment.v143.guard,'inconclusive');assert.ok(findAux((await h.gen(h.req('swipe'))).send.r));h.c.dispose();
 }
});
test('pausing only 1.4.3 while a send is staged keeps the 1.4.2 repair, reused sample and passive copy',async()=>{
 const h=setup({shield:'off',macro:true,macroWhen:'reuse',protocolProfile:'standard',traceAnchor:true,passiveOutput:true},()=>make('保留下来的合成正文。'));
 const first=await h.gen(h.req());const marker=findAux(first.send.r);assert.ok(marker);
 assert.equal(h.c.getVisibleOutput(),'保留下来的合成正文。');
 const v=h.req('swipe',{reverse:true});await h.prepare(v);h.settings.pause143=true;h.c.invalidateFresh();
 await h.bus.emit('CHAT_COMPLETION_SETTINGS_READY',v);const next=await h.post(v);
 assert.equal(findAux(next.send.r),marker);assert.equal(next.send.r.messages.at(-1).role,'user');assert.equal(next.send.h.get('accept'),'application/json');
 assert.equal(next.send.h.has(TRACE_HEADER),false);assert.equal(next.last.experiment.v143.anchor,'paused');assert.equal(h.c.getVisibleOutput(),'保留下来的合成正文。');
 h.settings.pause143=false;h.c.invalidateFresh();assert.equal(findAux((await h.gen(h.req('regenerate'))).send.r),marker);h.c.dispose();
});
