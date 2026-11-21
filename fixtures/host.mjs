import {preset} from './protocol.mjs';
export function host(initial={}){
 const subs=new Map(),db=new Map();const types=Object.fromEntries(['CHAT_COMPLETION_SETTINGS_READY','GENERATION_STARTED','GENERATION_ENDED','GENERATION_STOPPED','MESSAGE_RECEIVED','CHAT_CHANGED','APP_READY'].map(x=>[x,x]));
 const bus={on(k,f){const a=subs.get(k)||[];if(!a.includes(f))a.push(f);subs.set(k,a);},off(k,f){subs.set(k,(subs.get(k)||[]).filter(x=>x!==f));},
     makeLast(k,f){this.off(k,f);this.on(k,f);},async emit(k,...args){for(const f of [...(subs.get(k)||[])])await f(...args);}};
 const settings={enabled:true,requestMode:'gemini4',...initial},ctx={chat:[],chatId:'fixture-1',eventSource:bus,eventTypes:types,chatCompletionSettings:preset(),extensionSettings:{lin_prefill_guard_v1:settings},
   saveSettingsDebounced(){},accountStorage:{getItem:k=>db.get(k)||null,setItem:(k,v)=>db.set(k,v)}};
 return {ctx,settings,bus,db,count:k=>(subs.get(k)||[]).length};
}
