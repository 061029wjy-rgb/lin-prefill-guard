// Test-only, run on a temporary loopback ST instance with a disposable character.
const key='lin_prefill_guard_v1',history='lin_prefill_guard_history_v2';
export async function setup(p,local){
 let ctx=SillyTavern.getContext();
 if(ctx.characterId==null||ctx.getCurrentChatId()==null)await ctx.selectCharacterById(0,{switchMenu:false});
 ctx=SillyTavern.getContext();
 if(ctx.getCurrentChatId()==null||ctx.characterId==null)throw Error('missing disposable test room');
 const s=ctx.chatCompletionSettings,oa=await import('/scripts/openai.js'),ch=ctx.chat;
 const path=performance.getEntriesByType('resource').map(x=>x.name).find(x=>x.includes('lin-prefill-guard/index.js'));
 window.Q={ctx,s,p,oa,ch,local,next:await import(path ?? '/scripts/extensions/third-party/lin-prefill-guard/index.js'),last:()=>JSON.parse(ctx.accountStorage.getItem(history)||'[]')[0]};
}
export async function assemble(id,question,repeat=0){
 const {ctx,s,p,oa,local,ch}=Q;
 Object.assign(s,p,{name:p.name,preset_settings_openai:p.name,chat_completion_source:'custom',custom_model:'gemini-4-carbon',custom_url:local+'/v1',stream_openai:false,function_calling:false,request_images:false,openai_max_context:250000,custom_prompt_post_processing:'',custom_include_body:'',custom_include_headers:'',custom_exclude_body:''});
 const pm=oa.promptManager;pm.configuration.promptOrder.dummyId=id;pm.activeCharacter={id};
 const older=repeat?[{role:'user',content:'合成的日常背景。'.repeat(repeat)},{role:'assistant',content:'上一次已写完。'}]:[];
 const q={role:'user',content:question};
 ch.splice(0,ch.length,...older.map(x=>({is_user:x.role==='user',is_system:false,name:'样本',mes:x.content})),{is_user:true,is_system:false,name:'样本甲',mes:question});
 const ms=(await oa.prepareOpenAIMessages({name2:'样本乙',charDescription:'',charPersonality:'',scenario:'',worldInfoBefore:'',worldInfoAfter:'',bias:'',type:'normal',quietPrompt:'',quietImage:'',extensionPrompts:{},cyclePrompt:'',systemPromptOverride:'',jailbreakPromptOverride:'',messages:[q,...older.toReversed()],messageExamples:[]},false))[0];
 const tails=['e898d676-f02e-4868-bc51-33761e294df6','68186c40-6f11-4c47-a036-58497d1d6795'].map(id=>p.prompts.find(x=>x.identifier===id).content);
 if(!ms.some(m=>m.content===question)||tails.some((t,i)=>ms.at(-2+i)?.content!==t))throw Error('actual grouped prompt did not contain verified tail/question');
 Q.ms=ms;Q.question=question;return pm.getPromptOrderForCharacter({id}).filter(x=>x.enabled).length;
}
export async function version(v){
 if(v==='base'){Q.next.onDisable();Q.prev??=await import('/qa-baseline/index.js');Q.prev.onEnable();}
 else{Q.prev?.onDisable();Q.next.onEnable();}
}
export function configure(provider,search,opt={},stream=false){
 const {ctx,s,local}=Q;
 Object.assign(s,{chat_completion_source:provider,google_model:'gemini-4-carbon',vertexai_model:'gemini-4-carbon',reverse_proxy:local,proxy_password:'',use_sysprompt:true,enable_web_search:search,stream_openai:stream});
 Object.assign(ctx.extensionSettings[key],{enabled:true,requestMode:'gemini4',compat290:true,protocolProfile:'off',guardMode:'off',pause143:false,repairJsonMime:false,traceAnchor:false,detail143:true,shield:'off',macro:false,macroWhen:'each',captureNetwork:true,passiveOutput:false},opt);
}
export async function send(type='normal',rev=false){
 const {ctx,oa,ms}=Q;const arr=structuredClone(ms);
 if(rev)[arr[arr.length-2],arr[arr.length-1]]=[arr.at(-1),arr.at(-2)];
 await ctx.eventSource.emit(ctx.eventTypes.GENERATION_STARTED,type,{},false);
 const res=await oa.sendOpenAIRequest(type,arr,null);
 let visible=res.choices?.[0]?.message?.content;
 if(typeof res==='function'){visible='';for await(const part of res())visible=part.text;}
 for(let i=0;i<100&&!Q.last()?.wire?.responseComplete;i++)await new Promise(r=>setTimeout(r,15));
 await ctx.eventSource.emit(ctx.eventTypes.GENERATION_ENDED);
 return {visible,step:Q.last()?.experiment?.v143,wire:!!Q.last()?.wire?.responseComplete};
}
export async function direct(r,{mime=false,pretty=false,tool=false}={}){
 const {ctx}=Q;r=structuredClone(r);
 if(tool)r.tools=[{type:'function',function:{name:'fixture',parameters:{type:'object'}}}];
 await ctx.eventSource.emit(ctx.eventTypes.GENERATION_STARTED,r.type,{},false);
 await ctx.eventSource.emit(ctx.eventTypes.CHAT_COMPLETION_SETTINGS_READY,r);
 const headers=(await import('/script.js')).getRequestHeaders(mime?{omitContentType:true}:undefined);
 const response=await fetch('/api/backends/chat-completions/generate',{method:'POST',headers,body:JSON.stringify(r,null,pretty?2:undefined)});await response.text();
 await ctx.eventSource.emit(ctx.eventTypes.GENERATION_ENDED);return response.status;
}
// Full host path (separate temporary chat). No hand-emitted generation/settings events in this test.
export async function fullSequence(kind){
 const ctx=SillyTavern.getContext(),app=await import('/script.js');
 await ctx.openCharacterChat('lpg-synthetic-'+kind);
 app.changeMainAPI('openai');configure('vertexai',false,{shield:'standard',guardMode:'standard',traceAnchor:true},true);
 app.setOnlineStatus('loopback-test'); // disposable peer, never indicates valid cloud credentials
 const box=document.querySelector('#send_textarea');box.value='合成验收：看一眼放在门边的伞。';box.dispatchEvent(new Event('input',{bubbles:true}));
 const state=()=>({e:Q.last()?.experiment?.v143?.guard,finish:Q.last()?.wire?.finishReason||null,stored:ctx.chat.at(-1)?.mes,why:Q.last()?.experiment?.status});
 const settle=async()=>{for(let i=0;i<140&&!Q.last()?.wire?.responseComplete;i++)await new Promise(r=>setTimeout(r,15));};
 await ctx.generate('normal');await settle();const a=state();
 if(kind==='swipe')await app.swipe_right(null,{source:(await import('/scripts/constants.js')).SWIPE_SOURCE.KEYBOARD});
 else await ctx.generate('regenerate');
 await settle();const b=state();
 // Do not export even the disposable character's/chat's words; only compare them here.
 return {firstSavedMarker:a.stored==='LPG format=1',firstGuard:a.e,firstTerminal:a.finish,firstReason:a.why,
   retrySavedAnswer:b.stored==='合成本地回复。',retryGuard:b.e,retryTerminal:b.finish,retryReason:b.why};
}
