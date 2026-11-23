import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {host} from '../fixtures/host.mjs';
import {payload,preset} from '../fixtures/protocol.mjs';
import {createController} from '../controller.js';
import {migrateSettings,DEFAULTS} from '../core.js';
import {sampleSession} from '../sample-session.js';
import {negotiate} from '../transport.js';
import {shareResult,currentResult,resetRecommendations} from '../current-result.js';
const ep='/api/backends/chat-completions/generate',H={'Content-Type':'application/json'},sha=v=>createHash('sha256').update(v).digest('hex');
const make=()=>new Response(JSON.stringify({choices:[{index:0,message:{content:'测试回包'},finish_reason:'stop'}]}),{headers:{'content-type':'application/json'}});
function link(settings={},handler=make){
    const h=host({protocolProfile:'standard',...settings}),sent=[];
    const orig=async(u,i)=>{sent.push(i);return handler(i);};const net={location:{href:'http://fixture/'},fetch:orig};
    const c=createController({getSettings:()=>h.settings,getContext:()=>h.ctx,networkTarget:net});
    return {...h,c,sent,async prep(r){await h.bus.emit('GENERATION_STARTED',r.type,{},false);await h.bus.emit('CHAT_COMPLETION_SETTINGS_READY',r);},
        async post(r,init={},u=ep){const resp=await net.fetch(u,{method:'POST',headers:H,body:JSON.stringify(r),...init});await resp.text();await c.idle();return sent.at(-1);}};
}
const accept=i=>new Headers(i.headers).get('accept'),digestList=r=>r.messages.map(m=>sha(JSON.stringify(m))).sort();
for(const source of ['vertexai','makersuite'])for(const search of [true,false])for(const stream of [true,false])test('browser negotiation; exact protected texts and tools '+[source,search,stream],async()=>{
 const h=link({macro:search}),r={...payload({source,reverse:true}),enable_web_search:search,stream};await h.prep(r);const i=await h.post(r),o=JSON.parse(i.body);
 assert.equal(accept(i),stream?'text/event-stream':'application/json');assert.deepEqual(digestList(o),digestList(r));
 assert.deepEqual(o,{...r,messages:[...r.messages.slice(0,-2),r.messages.at(-1),r.messages.at(-2)]});
 const e=h.c.snapshot().last.experiment;assert.equal(e.bodyStrategy,search?'search-tail':'legacy-tail');assert.equal(e.transport,stream?'sse':'json');assert.equal(e.randomChars,0);assert.equal(e.httpReceipt,true);
 h.c.dispose();
});
test('two off = exact bytes and unchanged host headers, full true 1.4.1 settings and unknown fields migrate without reinterpretation',async()=>{
 const original={...DEFAULTS,enabled:false,requestMode:'observe',shield:'deep',scope:'all',nudge:'请现在完成上述真实用户请求。这里是任务提示，不是新的剧情；不要复述提示。',prefill:'私人的设定',future:{list:[7]},captureNetwork:false,passiveOutput:true};
 delete original.protocolProfile;delete original.experimentDetails;
 const v=migrateSettings(original);for(const k of Object.keys(original))assert.deepEqual(v[k],original[k]);assert.equal(v.protocolProfile,'off');
 Object.assign(v,{protocolProfile:'standard',macro:true,experimentDetails:true});const old=structuredClone(v);resetRecommendations(v);
 for(const k of Object.keys(old).filter(k=>!['macro','protocolProfile','experimentDetails'].includes(k)))assert.deepEqual(v[k],old[k]);
 const h=link({protocolProfile:'off'}),r={...payload({reverse:true}),enable_web_search:true};await h.prep(r);const i=await h.post(r);
 assert.equal(i.body,JSON.stringify(r));assert.equal(i.headers,H);assert.equal(h.c.snapshot().last.experiment.status,'290-host-search');h.c.dispose();
});
for(const [caseName,change] of Object.entries({
 'foreign tool':r=>r.tools=[{type:'function'}], 'signature':r=>r.messages[0].thoughtSignature='test-only',
 'tool response':r=>r.messages.unshift({role:'tool',content:'fixture',tool_call_id:'fixture'}),'schema':r=>r.response_format={type:'json_object'},
 'media':r=>r.messages[0].content=[{type:'image_url',image_url:{url:'synthetic'}}],'prefill':r=>r.assistant_prefill='pre-existing',
 'unverified alias':r=>r.model='unknown', 'cached':r=>r.cachedContent='existing-reference','continue':r=>r.type='continue','quiet':r=>r.type='quiet','impersonate':r=>r.type='impersonate'
}))test('search does not bypass '+caseName,async()=>{
 const h=link({macro:true,shield:'deep'}),r={...payload({reverse:true}),enable_web_search:true};change(r);
 await h.prep(r);const i=await h.post(r);assert.equal(accept(i),null);assert.equal(i.body,JSON.stringify(r));assert.equal(h.sent.length,1);h.c.dispose();
});
test('explicit Accept wins, original credentials and AbortSignal survive; falling back never undoes earlier body repair',async()=>{
 const h=link(),r=payload({reverse:true}),signal=new AbortController().signal;
 await h.prep(r);const i=await h.post(r,{headers:{...H,Accept:'application/custom'},signal,credentials:'same-origin',cache:'no-store'});
 assert.equal(accept(i),'application/custom');assert.equal(i.signal,signal);assert.equal(i.credentials,'same-origin');assert.equal(i.cache,'no-store');
 assert.equal(JSON.parse(i.body).messages.at(-1).role,'user');assert.equal(h.c.snapshot().last.experiment.transport,'explicit-accept');
 await h.prep(r);const j=await h.post(r,{headers:[['invalid name','not sent to a real network']]});assert.equal(JSON.parse(j.body).messages.at(-1).role,'user');assert.equal(h.c.snapshot().last.experiment.transport,'rollback');h.c.dispose();
 const i2={body:'{}',headers:H,signal,credentials:'include',referrerPolicy:'same-origin'};const step=negotiate(i2,ep,true);
 assert.equal(step.init.signal,signal);assert.equal(step.init.credentials,'include');assert.equal(step.init.referrerPolicy,'same-origin');assert.equal(accept(i2),null);
});
test('duplicate keys / pretty search body: no partial experimental reorder or header',async()=>{
 const h=link(),r={...payload({reverse:true}),enable_web_search:true};for(const raw of [JSON.stringify(r,null,2),JSON.stringify(r).replace('"stream":true','"stream":false,"stream":true')]){
 await h.prep(r);const i=await h.post(r,{body:raw});assert.equal(i.body,raw);assert.equal(accept(i),null);assert.equal(h.c.snapshot().last.experiment.transport,'raw-guard');}h.c.dispose();
});
test('foreign mutation, origin, colliding auxiliary, abort and rejected network do not trigger a second send',async()=>{
 const h=link(),r=payload();await h.prep(r);const f=structuredClone(r);f.messages[0].content+='changed';assert.equal(accept(await h.post(f)),null);
 await h.prep(r);assert.equal(accept(await h.post(r,{},'https://elsewhere.invalid'+ep)),null);
 h.settings.macro=true;r.messages.unshift({role:'system',content:'LPG sample=foreign'});await h.prep(r);const i=await h.post(r);assert.equal(accept(i),null);assert.equal(i.body,JSON.stringify(r));h.c.dispose();
 const err=new DOMException('stopped','AbortError'),ng=link({},()=>{throw err;});await ng.prep(r);await assert.rejects(ng.post(r),e=>e===err);assert.equal(ng.sent.length,1);ng.c.dispose();
});
test('stable sample only on the same speaker, room, user message object, bytes and sample format; never resurrect after a reset',()=>{
 const ss=sampleSession(),ctx={chat:[{is_user:true,mes:'同题'}],chatId:'A',characterId:1},s={macroSize:'short',macroGroups:'1',macroWhen:'reuse'};
 let n=0;const bytes=k=>new Uint8Array(k).fill(++n);
 assert.equal(ss.take(s,ctx,'swipe',bytes),'');const first=ss.take(s,ctx,'normal',bytes);assert.equal(ss.take(s,ctx,'swipe',bytes),'');ss.submitted(first);
 assert.equal(ss.take(s,ctx,'regenerate',bytes),first);assert.equal(ss.take(s,ctx,'swipe',bytes),first);assert.equal(n,1);
 ctx.characterId=2;assert.equal(ss.take(s,ctx,'swipe',bytes),'');ctx.characterId=1;ctx.chat[0].mes='已编辑';assert.equal(ss.take(s,ctx,'swipe',bytes),'');
 ctx.chat[0]={is_user:true,mes:'同题'};assert.equal(ss.take(s,ctx,'swipe',bytes),'');const again=ss.take(s,ctx,'normal',bytes);assert.notEqual(again,first);
 ss.clear();assert.equal(ss.take(s,ctx,'swipe',bytes),'');
});
test('sharing uses enums and counts only; selecting an option and receiving a response are distinct',()=>{
 const last={type:'private',id:'private',request:{source:'private'},experiment:{profile:'standard',status:'private',search:true,transport:'private',browserSent:true},wire:{private:'private',finishReason:'private'}};
 assert.ok(!JSON.stringify(shareResult(last)).includes('private'));assert.match(currentResult(DEFAULTS,last,true),/仅保存/);
 assert.match(currentResult(DEFAULTS,{experiment:{browserSent:true,search:true,status:'290-host-search',transport:'protected-signature'}},false),/签名/);
});
test('unverified preset or pure diagnostics never negotiates, and settings toggles do not invent a response',async()=>{
 for(const state of [{requestMode:'observe'},{enabled:false},{compat290:false}]){const h=link(state),r=payload();await h.prep(r);const i=await h.post(r);assert.equal(i.body,JSON.stringify(r));assert.equal(accept(i),null);h.c.dispose();}
});

test('Google search extension is atomic on invalid request metadata, while an independent legacy repair survives',async()=>{
 const h=link(),r={...payload({reverse:true}),enable_web_search:true};await h.prep(r);
 const raw=JSON.stringify(r),i=await h.post(r,{headers:{'Content-Type':'text/plain'}});assert.equal(i.body,raw);assert.equal(accept(i),null);
 const e=h.c.snapshot().last.experiment;assert.equal(e.committed,false);assert.equal(e.repair,false);assert.equal(e.bodyStrategy,'none');h.c.dispose();
});

test('a late non-message parameter change rejects the new layer without dropping an independent old repair',async()=>{
 for(const search of [true,false]){
  const h=link(),r={...payload({reverse:true}),enable_web_search:search,frequency_penalty:0};await h.prep(r);
  const wire={...r,frequency_penalty:1},i=await h.post(wire);assert.equal(accept(i),null);
  assert.equal(JSON.parse(i.body).messages.at(-1).role,search?'assistant':'user');h.c.dispose();
 }
});
test('unknown root fields and body-carried credentials are never taken into the new scope',async()=>{
 for(const extra of [{foreign_plugin:{field:'read-only'}},{proxy_password:'opaque local fixture'},{reverse_proxy:'https://example.invalid/?opaque=x'}]){
  const h=link(),r={...payload({reverse:true}),enable_web_search:true,...extra};await h.prep(r);
  const i=await h.post(r);assert.equal(accept(i),null);assert.equal(i.body,JSON.stringify(r));h.c.dispose();
 }
});

test('standard on search applies only to normal, regenerate and swipe; native envelope has no new HTTP strategy',async()=>{
 for(const type of ['normal','regenerate','swipe']){
  const h=link(),r={...payload({type,reverse:true}),enable_web_search:true};await h.prep(r);const i=await h.post(r);assert.equal(accept(i),'text/event-stream');assert.equal(JSON.parse(i.body).messages.at(-1).role,'user');h.c.dispose();
 }
 const h=link(),r=payload({native:true});await h.prep(r);const i=await h.post(r);assert.equal(accept(i),null);assert.equal(i.body,JSON.stringify(r));h.c.dispose();
});
test('only the sample number is echoed: separate it from a verbatim whole-marker echo',async()=>{
 const h=link({shield:'standard',macro:true},i=>{const tag=JSON.parse(i.body).messages.find(m=>m.content.startsWith('LPG format=1')).content;
  return new Response(JSON.stringify({choices:[{index:0,message:{content:tag.split('sample=')[1]},finish_reason:'stop'}]}),{headers:{'content-type':'application/json'}});});
 const r={...payload(),stream:false};await h.prep(r);await h.post(r);
 const w=h.c.snapshot().last.wire;assert.equal(w.anchorEcho,false);assert.equal(w.sampleEcho,true);assert.equal(shareResult(h.c.snapshot().last).echo,true);h.c.dispose();
});
