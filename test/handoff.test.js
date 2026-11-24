import test from 'node:test';
import assert from 'node:assert/strict';
import {planInjection,normalizeSettings} from '../core.js';
import {LIN_PROMPT_ID,LIN_CONFIRM_ID,orderProof} from '../gemini4.js';
import {ACK,MAX_PARAGRAPH} from '../handoff.js';
import {responseDiagnosis,compactStreamEvidence,recordStatus} from '../diagnostics.js';
import {createController} from '../controller.js';
const m=(role,content)=>({role,content}), cue=m('assistant','承接已定位的原任务。'), rules=m('user','服从既有格式。\n\n'+MAX_PARAGRAPH+'\n\n完成本轮。'), middle=m('system','沿用本轮格式。');
const preset={name:'Lin2.8.2',prompts:[{identifier:LIN_PROMPT_ID,...cue},{identifier:'format',...middle},{identifier:LIN_CONFIRM_ID,...rules}]};preset.prompt_order=[{character_id:100001,order:preset.prompts.map(x=>({identifier:x.identifier,enabled:true}))}];
const story=m('user','门口是谁？'), head=m('system','世界设定。');
const base=(model='gemini-4-carbon')=>({type:'normal',chat_completion_source:'vertexai',model,messages:[head,story,cue,middle,rules],max_tokens:16384,reasoning_effort:'auto',stream:true});
const opt={requestMode:'gemini4-story',storyMoreTokens:true}, go=(q,s=opt,p=preset)=>planInjection(q,s,{preset:p});
for(const model of ['gemini-4-carbon','gemini-4-hydrogen','gemini-4-argon'])test(model+' keeps Lin rules and real story, with assistant directly before final confirmation',()=>{
 const q=base(model),before=structuredClone(q),p=go(q);assert.equal(p.reason,'g4-handoff');assert.deepEqual(q,before);assert.deepEqual(p.messages.slice(0,3),[head,story,middle]);assert.equal(p.messages[3].content,'服从既有格式。\n\n完成本轮。');assert.equal(p.messages.at(-2),cue);assert.deepEqual(p.messages.at(-1),m('user',ACK));assert.equal(p.handoff.cap.after,32768);
 assert.equal(orderProof(p.messages,p.orderWitness),'cue-before-user');assert.equal(orderProof([...p.messages,m('user','后来加的')],p.orderWitness),'unknown');
 const shifted=go({...q,messages:[head,story,middle,rules,cue]});assert.equal(shifted.handoff.restored,true);assert.deepEqual(shifted.messages,p.messages);
});
test('observe, normal compatibility, host-only fields, non-chat, tools and ambiguous anchors never enter the new path',()=>{
 const q=base();for(const s of [{requestMode:'observe',storyMoreTokens:true},{requestMode:'gemini4',storyMoreTokens:true}])assert.equal(go(q,s).messages,q.messages);
 for(const x of [{type:'continue'},{type:'quiet'},{type:'impersonate'},{model:'gemini-4-carbon-custom'},{chat_completion_source:'custom'},{reverse_proxy:'proxy'},{tools:[{}]},{max_completion_tokens:16384},{n:2},{response_format:{type:'json_object'}},{assistant_prefill:'literal'},{messages:[head,story,cue,m('user','未知插入'),rules]},{messages:[head,story,cue,rules,m('user','真人补充')]},{messages:[story,cue,cue,rules]},{messages:[story,cue,m('system','未知'),rules]},{messages:[story,cue,{...rules,name:'player'}]},{messages:[story,cue,m('user','旧记录：'+rules.content),rules]}]){const a={...q,...x};assert.ok(!go(a).handoff);assert.equal(a.max_tokens,16384);}
 assert.equal(go(q,{...opt,storyMoreTokens:false}).handoff.cap,null);for(const value of [8192,32768,64000])assert.equal(go({...q,max_tokens:value}).handoff.cap,null);
 assert.equal(normalizeSettings({requestMode:'observe'}).requestMode,'observe');
});
test('host single-text block is preserved; edited or missing maximization paragraph is not removed',()=>{
 const q=base(), other=m('user','仅沿用原规则。');const p={...preset,prompts:preset.prompts.map(x=>x.identifier===LIN_CONFIRM_ID?{...x,...other}:x)};
 assert.equal(go({...q,messages:[story,cue,other]},opt,p).handoff,undefined);
 const plan=go({...q,messages:[story,cue,m('user',[{type:'text',text:rules.content}])]});assert.ok(Array.isArray(plan.messages.at(-3).content));
});
test('separate Google usage counts sum to cap; inclusive or conflicting formats never double count',()=>{
 const w={finishReason:'MAX_TOKENS',thoughtTokens:15445,outputTokens:939,promptTokens:52412,totalTokens:68796,output:{nonCommentChars:90}},req={source:'vertexai',maxTokens:16384};
 assert.match(responseDiagnosis(w,req),/15445 \+ 候选输出 939 = 16384/);assert.match(responseDiagnosis(w,req),/注释外文本 90/);
 for(const change of [{usageKind:'other'},{usageKind:'mixed'},{totalTokens:80000}])assert.doesNotMatch(responseDiagnosis({...w,...change},req),/候选输出/);
 assert.doesNotMatch(responseDiagnosis({...w,finishReason:'STOP'},req),/恰好用尽/);assert.equal(recordStatus({wire:{finishReason:'content_filter'}}).label,'服务端限制');
 const short={transport:'sse',httpStatus:200,responseComplete:true,doneMarker:true,frames:2,visibleChars:205};
 assert.match(compactStreamEvidence(short),/未提供/);assert.doesNotMatch(responseDiagnosis(short,req),/恰好用尽/);
});
test('live controller commits once and verifies both listener orders at the fetch boundary without altering the host response',async()=>{
 const note=m('system','〔人性阴暗面/情绪/随机性放大·角色演出〕 原有角色。');
 for(const timing of ['before','after','different-request']){
  const bus={subs:{},on(e,fn){this.subs[e]=fn},removeListener(){},emit(e,q){this.subs[e](q)}}, mem=new Map(), ctx={chat:[],chatCompletionSettings:preset,eventTypes:{CHAT_COMPLETION_SETTINGS_READY:'r'},eventSource:bus,accountStorage:{getItem:k=>mem.get(k),setItem:(k,v)=>mem.set(k,v)}};
  const response=new Response('data: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}});const host={location:{href:'http://localhost/'},fetch:async()=>response};
  const ctl=createController({getContext:()=>ctx,getSettings:()=>opt,networkTarget:host});const q=base();
  if(timing==='before')q.messages.splice(1,0,note);bus.emit('r',q);assert.equal(q.max_tokens,32768);const applied=q.messages;bus.emit('r',q);assert.equal(q.messages,applied);
  if(timing!=='before')q.messages=[q.messages[0],note,...q.messages.slice(1)];if(timing==='different-request')q.messages[2]=m('user','另一个请求。');
  assert.equal(await host.fetch('/api/backends/chat-completions/generate',{method:'POST',body:JSON.stringify(q)}),response);await ctl.idle();
  const records=ctl.snapshot().history, r=records.find(x=>x.reason==='g4-handoff');assert.ok(r);
  if(timing==='different-request'){assert.ok(!r.dispatch);assert.ok(records.some(x=>x.origin==='unassociated'));}
  else{assert.equal(r.dispatch.linOrder,'cue-before-user');assert.equal(r.dispatch.request.maxTokens,32768);assert.equal(r.dispatch.correlation,timing==='before'?'exact':'companion-front-note');}
  assert.deepEqual(r.injected,[m('user',ACK)]);ctl.dispose();
 }
});
