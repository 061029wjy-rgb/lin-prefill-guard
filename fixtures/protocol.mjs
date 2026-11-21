// Invented, short strings only. No preset or third-party script is bundled.
import { LIN_PROMPT_ID as A, LIN_CONFIRM_ID as U } from '../gemini4.js';
export const cue='本轮承接样本。', confirmation='按本轮约定完成样本。', m=(role,content)=>({role,content});
export function preset() {
 const ps=[{identifier:'main',role:'system',content:'[nonce: {{random::a::b}}-{{roll::1d6}}]'},
 {identifier:'chatHistory',marker:true},{identifier:A,role:'assistant',attach_role:'user',injection_position:0,content:cue},
 {identifier:'jailbreak',role:'system',content:''},{identifier:U,role:'user',injection_position:0,content:confirmation},{identifier:'agentResults',marker:true}];
 return {name:'lin2.9.0-示例',use_sysprompt:true,prompts:ps,prompt_order:[100000,100001].map(character_id=>({character_id,order:ps.map(p=>({identifier:p.identifier,enabled:true}))}))};
}
export function payload({native=false,reverse=false,model='gemini-4-carbon',source='vertexai',type='normal'}={}) {
 const head=[m('system','版式规则。'),m('system','样本编号已由酒馆展开：17。')], q=m('user','两人在雨停后各自出门。');
 const end=[m('assistant',cue),m('user',confirmation)]; if(reverse)end.reverse();
 const base={type,model,chat_completion_source:source,stream:true,temperature:0.87,top_p:0.94,use_sysprompt:true,max_tokens:16384};
 if(!native)return {...base,messages:[...head,q,...end]};
 return {...base,systemInstruction:{parts:head.map(x=>({text:x.content}))},contents:[q,...end].map(x=>({role:x.role==='assistant'?'model':'user',parts:[{text:x.content}]}))};
}
