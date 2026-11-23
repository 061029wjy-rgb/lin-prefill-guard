// Synthetic ST event/record host for checking actual buttons without spending model quota.
import {host} from '../fixtures/host.mjs';
import {payload} from '../fixtures/protocol.mjs';
export async function attach(version) {
 const h=host({requestMode:'observe'}),ctx=h.ctx,actions=[];ctx.chat.push({is_user:true,mes:'本地样例'},{is_user:false,mes:'雨下到这里，',swipe_id:0});
 ctx.generate=async type=>{actions.push(type);const r=payload({type});
   await h.bus.emit('GENERATION_STARTED',type,{},false);await h.bus.emit('CHAT_COMPLETION_SETTINGS_READY',r);
   const a=await fetch('/api/backends/chat-completions/generate',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(r)});await a.text();await h.bus.emit('GENERATION_ENDED');};
 window.SillyTavern={getContext:()=>ctx};await import(version==='base'?'/qa-baseline/index.js':'/qa-tests/index.js');
 window.caseState={actions,ctx};
}
