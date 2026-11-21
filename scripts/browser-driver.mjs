import {host} from '../fixtures/host.mjs';import {payload,preset} from '../fixtures/protocol.mjs';import {labRequest,labReply,readLabStream,verifyLabPair} from '../output-lab.js';
const h=host({captureNetwork:true}),orig=window.fetch;
window.SillyTavern={getContext:()=>h.ctx};const entry=await import('../index.js');
const endpoint='/api/backends/chat-completions/generate';
function set(key,value){const el=document.querySelector('[data-setting="'+key+'"]');if(!el)throw Error('missing control '+key);
 if(el.type==='checkbox')el.checked=value;else el.value=value;el.dispatchEvent(new Event('change',{bubbles:true}));}
function realPayload(p,g){
 const expand=s=>s.replace(/\{\{(user|char|roll::[^{}]*|random::[^{}]*)\}\}/gi,(_,k)=>k==='user'?'读者甲':k==='char'?'人物乙':k.startsWith('random::')?k.slice(8).split('::')[0]:'317');
 const order=p.prompt_order.find(x=>x.character_id===g).order, ms=order.filter(e=>e.enabled).flatMap(e=>{
 if(e.identifier==='chatHistory')return [{role:'user',content:'合成本地用例。'},{role:'assistant',content:'上一句。'},{role:'user',content:'往下写。'}];
 const d=p.prompts.find(x=>x.identifier===e.identifier);return d?.content&&d.role?[{role:d.role,content:expand(d.content)}]:[];});
 return {...payload(),messages:ms};
}
const pause=ms=>new Promise(r=>setTimeout(r,ms));
export async function exercise(c){
 if(!document.getElementById('lin-prefill-guard-panel'))throw Error('missing panel');
 h.ctx.chatCompletionSettings=c.real?window.privateReference:preset();if(!h.ctx.chatCompletionSettings)throw Error('missing local reference');
 if(c.group)h.ctx.getChatCompletionPromptManager=()=>({configuration:{promptOrder:{strategy:'global',dummyId:c.group}}});else delete h.ctx.getChatCompletionPromptManager;
 for(const [k,v] of Object.entries({shield:c.shield||'off',macro:!!c.macro,passiveOutput:true,auxPosition:c.pos||'boundary',macroSize:c.size||'short',macroGroups:String(c.groups||1)}))set(k,v);
 const r=c.real?realPayload(h.ctx.chatCompletionSettings,c.group):payload(c);
 if(c.special==='host-search')r.enable_web_search=true;
 if(c.special==='root-json')r.responseMimeType='application/json';
 if(c.special==='tools')r.tools=[{type:'function',function:{name:'existing',parameters:{type:'object'}}}];
 if(c.special==='signed')r.contents.at(-1).parts[0].thoughtSignature='opaque-test';
 if(c.special==='structured')r.response_format={type:'json_object'};
 if(c.special==='large')r.messages[0].content='测试文本。'.repeat(20000);
 if(c.special==='prefix')r.assistant_prefill='外部原生前缀';
 const original=JSON.stringify(r);await h.bus.emit('GENERATION_STARTED',r.type,{},false);
 await h.bus.emit('CHAT_COMPLETION_SETTINGS_READY',r);if(JSON.stringify(r)!==original)throw Error('event changed original');
 if(c.special==='drift')r.messages[0].content+='外部修改。';if(c.special==='chat'){h.ctx.chatId+='n';await h.bus.emit('CHAT_CHANGED');}
 const raw=JSON.stringify(r);const headers={'Content-Type':'application/json','X-Local-Fixture':c.name};
 const response=await fetch(endpoint,{method:'POST',headers,body:raw});
 const bytes=await response.text();if(bytes!==c.reply)throw Error('response bytes changed');
 if(c.special!=='drift'&&c.special!=='chat'&&!['quiet','impersonate'].includes(r.type)){
 for(let n=0;n<80;n++){const rec=JSON.parse(h.ctx.accountStorage.getItem('lin_prefill_guard_history_v2')||'[]')[0];if(rec?.wire)break;await pause(4);}
 }
 await h.bus.emit('GENERATION_ENDED');return {raw,panels:document.querySelectorAll('#lin-prefill-guard-panel').length,
    diag:document.querySelector('.lpg-status').textContent.includes('上游路由：无确认'),status:response.status};
}
export async function unrelated(){
 const x='{ "upload" : "local-fixture" }',v=await fetch('/api/files/upload',{method:'POST',body:x});return (await v.text())===x;
}
export async function toolLab({fmt,stream}){
 const req=labRequest(fmt),response=await fetch('/lab/model',{method:'POST',headers:{'Content-Type':'application/json','X-Protocol':fmt,'X-Stream':String(stream)},body:JSON.stringify(req)});
 const input=stream?readLabStream(await response.text()):await response.json(),pair=labReply(fmt,input);
 const reply=await (await fetch('/lab/result',{method:'POST',body:JSON.stringify({fmt,turn:pair.turn,result:pair.reply})})).json();
 return {text:verifyLabPair(fmt,input,reply),signature:pair.signature||null};
}
export async function lifecycle(){
 const first=h.count('CHAT_COMPLETION_SETTINGS_READY');
 set('shield','deep');set('macro',true);set('passiveOutput',true);
 const revert=[...document.querySelectorAll('#lin-prefill-guard-panel button')].find(el=>el.textContent==='关闭全部新实验');
 if(!revert)throw Error('missing reset button');revert.click();
 const saved=h.ctx.extensionSettings.lin_prefill_guard_v1,ui=k=>document.querySelector('[data-setting="'+k+'"]');
 if(saved.shield!=='off'||saved.macro!==false||saved.passiveOutput!==false||ui('shield').value!=='off'||ui('macro').checked||ui('passiveOutput').checked)
   throw Error('experiment reset differed from the displayed or persisted state');
 h.ctx.chatCompletionSettings=preset();delete h.ctx.getChatCompletionPromptManager;
 const next=payload(),raw=JSON.stringify(next);await h.bus.emit('GENERATION_STARTED','normal',{},false);
 await h.bus.emit('CHAT_COMPLETION_SETTINGS_READY',next);
 const reply=await fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/json','X-Local-Fixture':'after-reset'},body:raw});await reply.text();
 await h.bus.emit('GENERATION_ENDED');entry.onDisable();
 const cleaned=window.fetch===orig && !document.getElementById('lin-prefill-guard-panel') && h.count('CHAT_COMPLETION_SETTINGS_READY')===0;
 entry.onEnable();entry.onEnable();const again=h.count('CHAT_COMPLETION_SETTINGS_READY')===1&&document.querySelectorAll('#lin-prefill-guard-panel').length===1;
 entry.onDisable();return {ok:first===1&&cleaned&&again&&window.fetch===orig,raw};
}
