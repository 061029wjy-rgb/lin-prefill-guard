import test from 'node:test';import assert from 'node:assert/strict';import {createController} from '../controller.js';
import {inspectResponse} from '../observer.js';import {observeConsumed} from '../wire-response.js';import {recordStatus,formatRecord} from '../diagnostics.js';
import {host} from '../fixtures/host.mjs';import {payload} from '../fixtures/protocol.mjs';import {labRequest,labReply,verifyLabPair,readLabStream} from '../output-lab.js';
const url='/api/backends/chat-completions/generate',enc=new TextEncoder(),bits=x=>typeof x==='string'?x:JSON.stringify(x);
const make=(s,mode,code=200)=>new Response(s,{status:code,headers:{'content-type':mode}});
const frame=a=>'data: '+bits(a)+'\r\n\r\n', chat=(text,finish='stop')=>({choices:[{index:0,message:{role:'assistant',content:text},finish_reason:finish}]});
function setup(answer=(v)=>make(JSON.stringify(chat('雨停了。')),'application/json'),settings={}){
 const h=host({shield:'standard',passiveOutput:true,...settings}),sent=[];const orig=async(input,init)=>{sent.push({input,init});return answer(init?.body);};
 const net={location:{href:'http://fixture/'},fetch:orig},c=createController({getContext:()=>h.ctx,getSettings:()=>h.settings,networkTarget:net});
 return {...h,net,c,sent,orig,async plan(r){await h.bus.emit('GENERATION_STARTED',r.type,{},false);await h.bus.emit('CHAT_COMPLETION_SETTINGS_READY',r);},
 async post(r){return net.fetch(url,{method:'POST',body:JSON.stringify(r)});}};
}
test('one hook and one unchanged HTTP response: recover plain visible text; credential, story, sample and signatures never persist',async()=>{
 const h=setup(body=>{const parsed=JSON.parse(body),tag=parsed.messages.find(m=>m.content?.startsWith?.('LPG ')).content;
  return make([frame({choices:[{index:0,delta:{reasoning_content:'secret-thought',content:'雨'}}]}),frame({choices:[{index:0,delta:{content:'停了。'+tag},finish_reason:'stop'}],usage:{prompt_tokens:13,prompt_tokens_details:{cached_tokens:4}}}),frame('[DONE]')].join(''),'text/event-stream');},{shield:'standard',macro:true});
 const r=payload();r.messages[0].content='DO_NOT_STORE_STORY';r.proxy_password='DO_NOT_STORE_PASSWORD';const original=structuredClone(r);
 await h.plan(r);const res=await h.post(r),raw=await res.text();await h.c.idle();assert.equal(h.sent.length,1);assert.deepEqual(r,original);
 const e=h.c.snapshot().last;assert.equal(e.wire.anchorEcho,true);assert.equal(e.wire.cacheReadTokens,4);assert.equal(e.experiment.httpReceipt,true);
 const own=JSON.parse(h.sent[0].init.body).messages[2].content;assert.equal(h.c.getVisibleOutput(),'雨停了。'+own);assert.ok(raw.includes('secret-thought'));
 const saved=JSON.stringify([...h.db]);for(const privateValue of ['DO_NOT_STORE_STORY','DO_NOT_STORE_PASSWORD','secret-thought','雨停了。',own])assert.ok(!saved.includes(privateValue));
 assert.match(formatRecord(e),/缓存读取 token：4/);await h.bus.emit('CHAT_CHANGED');assert.equal(h.c.getVisibleOutput(),'');h.c.dispose();assert.equal(h.net.fetch,h.orig);
});
test('backpressure, original bytes, cancellation reason, read error and bounded capture are independent of the host',async()=>{
 let pulls=0,why,fail,success;const original=new ReadableStream({pull(c){pulls++;c.enqueue(enc.encode('逐字'));},cancel(r){why=r;}},{highWaterMark:0});
 const tapped=observeConsumed(new Response(original),{failed:f=>fail=f,finish:()=>success=true});await new Promise(r=>setTimeout(r,4));assert.equal(pulls,0);
 const reader=tapped.body.getReader();assert.deepEqual((await reader.read()).value,enc.encode('逐字'));assert.equal(pulls,1);await reader.cancel('手动');assert.equal(why,'手动');assert.ok(fail.aborted&&!success);
 const err=new Error('fixture failure'),broken=new ReadableStream({pull(c){c.error(err);}},{highWaterMark:0});
 await assert.rejects(observeConsumed(new Response(broken),{finish:()=>{},failed:f=>fail=f}).text(),e=>e===err);assert.equal(fail.limitReason,'read-error');
 let limited;assert.equal(await observeConsumed(make('abcdef','text/plain'),{limit:2,finish:()=>{},failed:f=>limited=f}).text(),'abcdef');assert.equal(limited.limitReason,'bytes');
});
test('non-generation fetch, Request body, foreign origins, queries, method, aborted transport and other wrappers',async()=>{
 const h=setup(),r=payload();await h.plan(r);
 for(const target of ['/api/secrets/write','/api/files/upload','/api/heartbeat','http://elsewhere'+url,url+'?x=1']){
  const init={method:'POST',body:'unchanged opaque',headers:{}};const resp=await h.net.fetch(target,init);assert.ok(resp);assert.equal(h.sent.at(-1).init,init);
 }
 const req=new Request('http://fixture'+url,{method:'POST',body:JSON.stringify(r)});await h.net.fetch(req);assert.equal(h.sent.at(-1).input,req);assert.ok(!req.bodyUsed);
 const ours=h.net.fetch,late=(...a)=>ours(...a);h.net.fetch=late;h.c.dispose();assert.equal(h.net.fetch,late);assert.equal(h.count('CHAT_COMPLETION_SETTINGS_READY'),0);
 const aborted=setup(()=>{throw new DOMException('stop','AbortError');});await aborted.plan(r);await assert.rejects(aborted.post(r),e=>e.name==='AbortError');assert.ok(aborted.c.snapshot().last.wire.aborted);assert.equal(aborted.sent.length,1);aborted.c.dispose();
});
test('plain HTTP status, wrapped upstream error, provider safety, budget, continuation, refusal and DONE without reason are distinct',async()=>{
 const cases=[[400,{},'请求失败'],[403,{},'请求失败'],[429,{},'请求失败'],[503,{},'请求失败'],[200,{error:{code:403}},'请求失败'],[200,{promptFeedback:{blockReason:'SAFETY'}},'服务端限制'],[200,chat('','length'),'输出预算结束'],[200,{candidates:[{finishReason:'CONTINUATION'}]},'上游要求续传'],
 [200,{choices:[{index:0,message:{refusal:'no'},finish_reason:'stop'}]},'接口拒答'],[200,chat('抱歉，我不能提供这样的内容。'),'疑似文字拒答'],[200,chat('','stop'),'空响应·需排查']];
 for(const [status,obj,expected] of cases){const stats=await inspectResponse(make(JSON.stringify(obj),'application/json',status));const label=recordStatus({wire:stats,gemini4:{model:'gemini-4-carbon',source:'vertexai'}}).label;assert.equal(label,expected,JSON.stringify([status,expected,label]));}
 const s=await inspectResponse(make(frame({choices:[{index:0,delta:{content:'完整的独立句子。'}}]})+frame('[DONE]'),'text/event-stream'));assert.ok(s.doneWithoutReason);assert.ok(!s.finishReason);
});
test('tool recovery lab verifies full OpenAI/Gemini pairs, visible text, SSE finish, preserved signature and negative paths',()=>{
 const spec=labRequest('chat').tools[0].function,g=labRequest('google').tools[0].functionDeclarations[0];assert.deepEqual(spec.parameters,g.parameters);
 const name=spec.name,text='灯熄了。',c={choices:[{index:0,finish_reason:'tool_calls',message:{role:'assistant',tool_calls:[{id:'c',type:'function',function:{name,arguments:JSON.stringify({text})}}]}}]};
 const google={candidates:[{finishReason:'STOP',content:{role:'model',parts:[{thoughtSignature:'fixture-opaque',functionCall:{id:'g',name,args:{text}}}]}}]};
 for(const [fmt,obj] of [['chat',c],['google',google]]){const snapshot=JSON.stringify(obj),a=labReply(fmt,obj);assert.equal(verifyLabPair(fmt,obj,a.reply),text);assert.equal(JSON.stringify(obj),snapshot);assert.throws(()=>verifyLabPair(fmt,obj,{}));
  if(fmt==='google'){assert.equal(a.turn,google.candidates[0].content);assert.equal(a.signature,'fixture-opaque');const broken=structuredClone(obj);delete broken.candidates[0].content.parts[0].thoughtSignature;assert.throws(()=>labReply(fmt,broken));}}
 const cmd=(delta,finish_reason=null)=>frame({choices:[{index:0,delta,finish_reason}]});
 const stream=cmd({tool_calls:[{index:0,id:'c',type:'function',function:{name,arguments:'{"text":'}}]})+cmd({tool_calls:[{index:0,function:{arguments:'"灯熄了。"}'}}]},'tool_calls')+frame('[DONE]');
 assert.equal(labReply('chat',readLabStream(stream)).text,text);assert.throws(()=>readLabStream(stream.split('data: [DONE]')[0]));assert.throws(()=>readLabStream(cmd({content:'text'})+stream));
});
test('wrong candidate, tool invocation, truncation, provider rejection, hidden reasoning: no plaintext recovery or forged success',async()=>{
 for(const obj of [{error:{code:503}},chat('暂','length'),{choices:[{index:1,message:{content:'其他候选'},finish_reason:'stop'}]},
 {choices:[{index:0,message:{content:[{type:'thinking',text:'hidden'}]},finish_reason:'stop'}]}, {choices:[{index:0,message:{content:'前文',tool_calls:[{}]},finish_reason:'tool_calls'}]}]){
 const h=setup(()=>make(JSON.stringify(obj),'application/json'));const r=payload();r.stream=false;await h.plan(r);assert.deepEqual(await (await h.post(r)).json(),obj);await h.c.idle();assert.equal(h.c.getVisibleOutput(),'');h.c.dispose();}
});
