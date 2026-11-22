import { compat290, detectedNonce, family, protocol290, target290, wireKind, systemKey } from './lin290.js?v=1.4.1';
import { drawSample, encodeWire, project } from './auxiliary.js?v=1.4.1';
import { normalizeSettings, VERSION, REASONS } from './core.js?v=1.4.1';
const now=()=>Date.now(), exp=new TextEncoder();
const WIRE_LIMIT=4*1024*1024;
const reasons={
 'off':'未增加实验区', 'owned-slot':'独立辅助区已核对', 'no-independent-slot':'没有可核验的独立系统位置',
 'unowned-marker':'已有相似标识，来源不明', 'changed-input':'请求在规划后变化', 'changed-options':'实验设置在发送前改变',
 'changed-chat':'聊天已经改变', 'conflict':'同轮出现多份不同的组装请求', 'no-lifecycle':'缺少可确认的生成开始事件',
 'no-ticket':'未关联到同轮设置事件', 'request-object':'请求体不是酒馆的字符串 JSON', 'too-large':'请求超过本地核对上限',
 'wire-guard':'无法证明可以无损改写（已使用原始字节）', 'random-unavailable':'安全随机源不可用',
 'expired':'规划已过期', 'duplicate':'本次发送已含本轮核验过的完整结果', 'unavailable':'没有可验证的最终提交点',
};
export const label290=k=>reasons[k]||REASONS[k]||'未应用';
const flags=s=>JSON.stringify([s.enabled,s.compat290,s.requestMode,s.shield,s.macro,s.macroSize,s.macroGroups,s.macroWhen,s.auxPosition,s.passiveOutput,s.captureNetwork]);
function identity(ctx){return {chat:ctx.chat,room:ctx.getCurrentChatId?.()??ctx.chatId??null};}
function sameRoom(ctx,prev){const next=identity(ctx);return next.chat===prev.chat&&next.room===prev.room;}
function wireKey(r) {
    // Only keep a transient, exact value for eligible model input. Never stringify auth/headers or other arbitrary body data.
    const k=wireKind(r);if(!k)return null;
    return JSON.stringify([r.model,r.chat_completion_source,r.type||'normal',r.stream,
        [r.use_sysprompt,r.n,r.max_tokens,r.max_completion_tokens,r.temperature,r.top_p,r.top_k,r.seed,r.stop,r.reasoning_effort,r.include_reasoning,r.enable_web_search,r.generationConfig],
        k==='messages'?r.messages:[systemKey(r),r[systemKey(r)],r.contents]]);
}
function safeMeta(r,target) {
    const ms=Array.isArray(r?.messages)?r.messages:Array.isArray(r?.contents)?r.contents:[];
    return {model:target?.model||'未识别',source:target?.source||'未识别',type:['normal','regenerate','swipe','continue','quiet','impersonate'].includes(r?.type)?r.type:'未知',
        stream:r?.stream===true,maxTokens:Number.isFinite(r?.max_tokens)?r.max_tokens:null,messageCount:ms.length,tailRoles:ms.slice(-2).map(m=>['system','assistant','model','user','tool'].includes(m?.role)?m.role:'其他')};
}
// The host's two global dummy groups have the same protected tail in the supplied preset.
// Where there is no positively identified host group, require agreement in BOTH instead of guessing.
function group(ctx){const pm=ctx.getChatCompletionPromptManager?.();const v=pm?.configuration?.promptOrder;
    return v?.strategy==='global' && [100000,100001].includes(Number(v.dummyId))?Number(v.dummyId):undefined;}
export function createCoordinator({getContext,getSettings,id,record,update,randomBytes,clock=now}) {
    let turn=null, ticket=null, dead=false, epoch=0, preview=null;
    function reset(){turn=null;ticket=null;}
    function forget(){epoch++;reset();preview=null;}
    function start(type,dry){if(dry||type==null)return;reset();if(['normal','regenerate','swipe','continue'].includes(type))turn={type,room:identity(getContext())};}
    function prepare(r){
        const ctx=getContext(),preset=ctx.chatCompletionSettings||{},f=family(preset);
        if(f==='legacy')return false;
        if(!r||typeof r!=='object')return true;
        const s=normalizeSettings(getSettings()),type=r.type||'normal';
        if(!s.enabled||['quiet','impersonate'].includes(type))return true;
        const g=group(ctx),base=compat290(r,preset,s,g),matched=turn&&turn.type===type&&sameRoom(ctx,turn.room);
        const key=base.proof?wireKey(r):null,large=key&&key.length>WIRE_LIMIT;
        if(matched&&ticket){
            if(ticket.key!==(large?null:key)||ticket.disabled!==(!base.proof||!!large)||ticket.flags!==flags(s))ticket.conflict=true;
            return true;
        }
        const note=!matched?'no-lifecycle':large?'too-large':base.reason,target=target290(r);
        const meta={id:id(),version:VERSION,at:new Date(clock()).toISOString(),type:safeMeta(r,target).type,origin:'assembled',identification:f==='290'?'Lin 2.9.0':'未适配的新版本',
            reason:note,explanation:label290(note),note:'',requestMode:s.requestMode,applied:false,injected:[],warnings:[],request:safeMeta(r,target),gemini4:target,
            experiment:{planned:true,committed:false,browserSent:false,httpReceipt:false,upstreamConfirmed:false,nonce:detectedNonce(preset),
                shield:s.shield,macro:s.macro,passive:s.passiveOutput,groups:base.layout?.groups||[],kind:base.kind||wireKind(r)||'未知',
                status:note,addedBytes:0,addedChars:0}};
        preview=null;record(meta,ctx);
        if(matched)ticket={id:meta.id,at:clock(),room:turn.room,flags:flags(s),type,source:r.chat_completion_source,model:r.model,
            key:large?null:key,disabled:!base.proof||!!large,baseReason:note,expected:null,conflict:false,state:meta.experiment,sample:null};
        return true;
    }
    function before(r,raw){
        const ctx=getContext(),p=ctx.chatCompletionSettings||{};
        if(dead||family(p)==='legacy'&&!ticket)return null;
        const s=normalizeSettings(getSettings()),t=ticket;
        // Foreign/quiet requests never acquire another request's ticket/response.
        if(!s.enabled||!t||!turn||!r||r.type!==t.type||r.model!==t.model||r.chat_completion_source!==t.source)return {managed:true};
        const metadata=(fields)=>{Object.assign(t.state,fields);update(t.id,{experiment:{...t.state}});};
        const pass=(status,identical=false)=>{if(!identical&&t.state.browserSent){update(t.id,{note:'另一份未匹配的请求原样放行；已核实的发送记录保留。'});return {managed:true};}metadata({status,committed:false,browserSent:false,httpReceipt:false,addedChars:0,addedBytes:0});
            // Requests which fail the identity check are not credited to the story, even on a 200.
            return identical?wireResult(undefined, false, status, null):{managed:true};};
        function wireResult(body,changed,status,aux){
            const born=turn,scope=epoch,active=()=>!dead&&epoch===scope&&sameRoom(getContext(),t.room)&&normalizeSettings(getSettings()).enabled;
            return {managed:true,id:t.id,body,capture:s.captureNetwork||s.passiveOutput||!!aux?.sample,passive:s.passiveOutput&&!t.disabled&&['owned-slot','off','no-independent-slot','duplicate'].includes(status),
                needle:aux?.sample?aux.text:'',valid:active,turn:born,
                sent(){if(!active())return;preview=aux?{id:t.id,text:aux.text}:null;metadata({browserSent:true,status});update(t.id,{applied:changed,
                    dispatch:{at:new Date().toISOString(),label:changed?'在酒馆生成 fetch 边界核对到实际改动。':'在酒馆生成 fetch 边界核对：原字节放行。',injected:[],request:safeMeta(r,target290(r))}});},
                receipt(){if(active())metadata({httpReceipt:true});}};
        }
        if(!sameRoom(ctx,t.room))return pass('changed-chat');
        if(t.flags!==flags(s))return pass('changed-options');
        if(clock()-t.at>180000)return pass('expired');
        if(t.conflict)return pass('conflict');
        if(typeof raw!=='string')return pass('request-object');
        if(raw.length>WIRE_LIMIT)return pass('too-large');
        const base=compat290(r,p,s,group(ctx));
        if(t.disabled)return pass(t.baseReason,true);
        if(!base.proof || protocol290(r,p,r.type))return pass('changed-input');
        const k=wireKey(r);
        if(k!==t.key){
            if(t.expected&&k===t.expected){const a=t.aux;metadata({committed:true,status:'duplicate',addedChars:a?.text.length||0,addedBytes:t.addedBytes});return wireResult(undefined,true,'duplicate',a);}
            return pass('changed-input');
        }
        // Plan on the matched outgoing value only. Secure randomness is drawn at most once per actual generation;
        // retries carrying the same input reuse it. IDs used to match requests are never sent to the model.
        try {
            const want=s.macro&&(s.macroWhen==='each'||t.type==='normal');
            const probe=project(r,base,s,want?'probe':'');
            if(want&&probe.aux&&t.sample==null) {
                try{t.sample=drawSample(s,randomBytes);}catch{return pass('random-unavailable',true);}
            }
            const plan=want&&probe.aux?project(r,base,s,t.sample):probe;
            const aux=plan.aux,changed=plan.out!==r;
            const encoded=changed?encodeWire(raw,r,plan,base):raw;
            const delta=changed?exp.encode(encoded).length-exp.encode(raw).length:0;
            if(changed){t.expected=wireKey(plan.out);t.aux=aux;t.addedBytes=delta;}
            metadata({committed:changed,browserSent:false,httpReceipt:false,status:plan.note,repair:changed&&base.proof.move,addedChars:aux?.text.length||0,addedBytes:delta,
                location:aux?aux.key+'['+aux.index+']':null,randomChars:aux?.sample?.length||0});
            return wireResult(changed?encoded:undefined,changed,plan.note,aux);
        } catch{return pass('wire-guard',true);}
    }
    return {prepare,before,start,reset,forget,peek:rid=>preview?.id===rid?preview?.text||'':'',belongs:()=>!dead&&(!!ticket||family(getContext().chatCompletionSettings||{})!=='legacy'),
        unavailable(why='request-object'){if(ticket){if(!ticket.state.browserSent)ticket.state.status=why;update(ticket.id,{experiment:{...ticket.state},note:label290(why)+'，原样放行。'});}},
        dispose(){dead=true;reset();}};
}
