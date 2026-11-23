// Synthetic, non-literary inputs. Exercised through ST's actual event bus and browser fetch.
import {LIN_PROMPT_ID as A,LIN_CONFIRM_ID as U} from '../gemini4.js';
import {MAX_PARAGRAPH} from '../handoff.js';
import {preset,payload} from '../fixtures/protocol.mjs';
export async function matrix(){
 const ctx=SillyTavern.getContext(),p=ctx.chatCompletionSettings,save={...p},key=ctx.extensionSettings.lin_prefill_guard_v1,old={...key},h=(await import('/script.js')).getRequestHeaders;
 const m=(role,content)=>({role,content}), cue=m('assistant','[Lin｜本轮承接]\n从测试花园接起。'),confirm=m('user','完成测试。\n\n'+MAX_PARAGRAPH+'\n\n结束测试。'),mid=m('system','使用测试格式。'),u=m('user','合成日常测试。');
 const defs=[{identifier:A,...cue},{identifier:'format',...mid},{identifier:U,...confirm}];
 const legacy={name:'Lin2.6',prompts:[defs[0]],prompt_order:[{character_id:100001,order:[{identifier:A,enabled:true}]}]};
 const v282={name:'Lin2.8.2',prompts:defs,prompt_order:[{character_id:100001,order:defs.map(x=>({identifier:x.identifier,enabled:true}))}]};
 const cases=[],add=(name,preset,req,settings)=>cases.push([name,preset,req,settings]);
 const rr=(type,model,ms,source='vertexai')=>({...payload({model,type,source}),messages:ms,reasoning_effort:'high',enable_web_search:false});
 for(const scope of ['lin','all'])for(const mode of ['user','pair'])for(const reasoningMode of ['keep','balanced'])
  add(['legacy',scope,mode,reasoningMode].join(':'),legacy,rr('normal','gemini-3-pro',[u,cue,mid]),{requestMode:'enhance',scope,mode,reasoningMode,deliveryGuard:true});
 for(const type of ['normal','regenerate','swipe','continue'])for(const search of [true,false]){
   add('2.9:'+type+':search='+search,preset(),{...payload({type,reverse:true}),enable_web_search:search},{requestMode:'gemini4'});
 }
 for(const mode of ['gemini4','gemini4-story'])for(const more of [false,true])add('2.8.2:'+mode+':budget='+more,v282,rr('normal','gemini-4-carbon',[u,mid,confirm,cue]),{requestMode:mode,storyMoreTokens:more});
 for(const opt of [false,true])add('legacy:continue:'+opt,legacy,rr('continue','gemini-3-pro',[u,cue,mid]),{requestMode:'enhance',scope:'lin',enhanceContinue:opt});
 for(const mode of ['observe','gemini4'])add('read-only:'+mode,legacy,rr('normal','gemini-3-pro',[u,cue,mid]),{requestMode:mode,enabled:mode==='observe'});
 const results=[];try{for(const [name,fixture,r,s] of cases){
  Object.assign(p,fixture,{preset_settings_openai:fixture.name,reverse_proxy:''});Object.assign(key,{...old,protocolProfile:'off',macro:false,shield:'off',enabled:true},s);
  await ctx.eventSource.emit(ctx.eventTypes.GENERATION_STARTED,r.type,{},false);
  await ctx.eventSource.emit(ctx.eventTypes.CHAT_COMPLETION_SETTINGS_READY,r);
  const a=await fetch('/api/backends/chat-completions/generate',{method:'POST',headers:h(),body:JSON.stringify(r)});await a.text();
  await ctx.eventSource.emit(ctx.eventTypes.GENERATION_ENDED);results.push(name);
 }}finally{Object.assign(p,save);Object.assign(key,old);}
 return results;
}
