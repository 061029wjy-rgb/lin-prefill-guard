import { eligibility, echoGuard, newFlags, newHeaders, headerPermission, isJsonType, receiptAnchor } from './shield-engine.js?v=1.4.3';
import {assess,negotiate,unambiguous,TRANSPORT_LABELS} from './transport.js?v=1.4.3';
import {sampleSession} from './sample-session.js?v=1.4.3';
import { compat290, detectedNonce, family, protocol290, target290, wireKind, systemKey } from './lin290.js?v=1.4.3';
import { encodeWire, project } from './auxiliary.js?v=1.4.3';
import { normalizeSettings, VERSION, REASONS } from './core.js?v=1.4.3';
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
export const label290=k=>reasons[k]||TRANSPORT_LABELS[k]||REASONS[k]||'未应用';
const flags=s=>JSON.stringify([s.enabled,s.compat290,s.requestMode,s.protocolProfile,s.shield,s.macro,s.macroSize,s.macroGroups,s.macroWhen,s.auxPosition,s.passiveOutput,s.captureNetwork]);
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
    const samples=sampleSession(), guard=echoGuard(clock);
    let turn=null, ticket=null, dead=false, epoch=0, freshEpoch=0, preview=null;
    function reset(){samples.dropPending();turn=null;ticket=null;}
    function invalidateFresh(){freshEpoch++;guard.clear();}
    function forget(){invalidateFresh();samples.clear();epoch++;reset();preview=null;}
    function start(type,dry){if(dry||type==null)return;guard.start(type);reset();if(['normal','regenerate','swipe','continue'].includes(type))turn={type,room:identity(getContext())};}
    function prepare(r){
        const ctx=getContext(),preset=ctx.chatCompletionSettings||{},f=family(preset);
        if(f==='legacy')return false;
        if(!r||typeof r!=='object')return true;
        const s=normalizeSettings(getSettings()),type=r.type||'normal';
        if(!s.enabled||['quiet','impersonate'].includes(type))return true;
        const g=group(ctx),originalBase=compat290(r,preset,s,g),gate=assess(r,preset,s,g,originalBase),base=gate.base,matched=turn&&turn.type===type&&sameRoom(ctx,turn.room);
        const ng=eligibility(r,originalBase,preset,s);
        const key=base.proof?wireKey(r):null,large=key&&key.length>WIRE_LIMIT;
        if(matched&&ticket){
            if(ticket.key!==(large?null:key)||ticket.disabled!==(!base.proof||!!large)||ticket.flags!==flags(s)||ticket.gate.why!==gate.why||ticket.gate.search!==!!gate.search||ticket.gate.stamp!==gate.stamp)ticket.conflict=true;
            if(ticket.freshEpoch!==freshEpoch||ticket.freshFlags!==JSON.stringify(newFlags(s))||ticket.ng.stamp!==ng.stamp||ticket.ng.reason!==ng.reason)ticket.freshConflict=true;
            return true;
        }
        const note=!matched?'no-lifecycle':large?'too-large':base.reason,target=target290(r);
        const meta={id:id(),version:VERSION,at:new Date(clock()).toISOString(),type:safeMeta(r,target).type,origin:'assembled',identification:f==='290'?'Lin 2.9.0':'未适配的新版本',
            reason:note,explanation:label290(note),note:'',requestMode:s.requestMode,applied:false,injected:[],warnings:[],request:safeMeta(r,target),gemini4:target,
            experiment:{planned:true,committed:false,browserSent:false,httpReceipt:false,upstreamConfirmed:false,nonce:detectedNonce(preset),
                profile:s.protocolProfile,transport:gate.why,search:!!r.enable_web_search,bodyStrategy:'none',shield:s.shield,macro:s.macro,passive:s.passiveOutput,groups:base.layout?.groups||[],kind:base.kind||wireKind(r)||'未知',
                v143:{guard:s.guardMode==='standard'?ng.reason:'off',mime:s.repairJsonMime?ng.reason:'off',anchor:s.traceAnchor?ng.reason:'off',chars:0,ack:'none'},status:note,addedBytes:0,addedChars:0}};
        preview=null;record(meta,ctx);
        if(matched)ticket={id:meta.id,at:clock(),room:turn.room,flags:flags(s),ng,freshEpoch,freshFlags:JSON.stringify(newFlags(s)),freshConflict:false,bytes:randomBytes,sends:0,gate:{eligible:gate.eligible,why:gate.why,stamp:gate.stamp,search:!!gate.search},type,source:r.chat_completion_source,model:r.model,
            key:large?null:key,disabled:!base.proof||!!large,baseReason:note,expected:null,conflict:false,state:meta.experiment,sample:null};
        return true;
    }
    function before(r,raw,init0,input0){
        const ctx=getContext(),p=ctx.chatCompletionSettings||{};
        if(dead||family(p)==='legacy'&&!ticket)return null;
        const s=normalizeSettings(getSettings()),t=ticket;
        // Foreign/quiet requests never acquire another request's ticket/response.
        if(!s.enabled||!t||!turn||!r||r.type!==t.type||r.model!==t.model||r.chat_completion_source!==t.source)return {managed:true};
        const metadata=(fields)=>{Object.assign(t.state,fields);update(t.id,{experiment:{...t.state}});};
        let canNegotiate=false,transportReason=t.gate.why,fresh=false,binding=null,omitted=false,stage=null;
        const freshStatus=(why)=>({guard:s.guardMode==='standard'?why:'off',mime:s.repairJsonMime?why:'off',anchor:s.traceAnchor?why:'off',ack:'none',chars:0});
        let details=freshStatus(t.ng.reason);
        function blocked(why){fresh=false;details=freshStatus(t.ng.reason==='ready'?why:t.ng.reason);}
        const detailPatch=()=>({v143:{...details}});
        const pass=(status,identical=false)=>{canNegotiate=false;blocked(status);if(!identical&&t.state.browserSent){update(t.id,{note:'另一份未匹配的请求原样放行；已核实的发送记录保留。'});return {managed:true};}metadata({...detailPatch(),status,transport:s.protocolProfile==='standard'?(transportReason==='waiting'?'unmatched':transportReason):'off',committed:false,browserSent:false,httpReceipt:false,addedChars:0,addedBytes:0});
            // Requests which fail the identity check are not credited to the story, even on a 200.
            return identical?wireResult(undefined, false, status, null):{managed:true};};
        function wireResult(body,changed,status,aux){
            let issued=false;const baseKind=t.state.kind,born=turn,scope=epoch,active=()=>!dead&&epoch===scope&&sameRoom(getContext(),t.room)&&normalizeSettings(getSettings()).enabled;
            return {managed:true,id:t.id,body,capture:s.captureNetwork||s.passiveOutput||!!aux?.sample||!!(fresh&&aux&&s.guardMode==='standard'),passive:s.passiveOutput&&!t.disabled&&['owned-slot','off','no-independent-slot','duplicate'].includes(status),
                needle:aux?.sample?aux.text:'',sampleNeedle:aux?.sample||'',
                owned:s.guardMode==='standard'&&fresh?aux?.text||'':'',get traceNeedle(){return stage?.value||'';},valid:active,turn:born,
                complete(stats){if(!active()||!issued||t.sends!==1||!fresh||t.conflict||t.freshConflict||t.freshEpoch!==freshEpoch||details.ack==='mismatch'||!binding)return;
                    if(guard.observe(binding,getContext(),r,stats,aux?.text,aux?.sample)){
                        details.guard='echo-confirmed';metadata(detailPatch());
                    }else if(aux&&details.guard==='monitoring'){
                        const only=stats?.ownedEchoOnly==='whole'||stats?.ownedEchoOnly==='sample';
                        details.guard=!stats?.responseComplete||stats.captureLimited||stats.parseErrors?'inconclusive':
                            !only?'not-echo':!stats.finishReason?'end-unverified':'inconclusive';
                        metadata(detailPatch());
                    }},
                transport(init,input,prior){
                    // Fresh headers are a separate transaction. Revert just this layer if its validation fails.
                    if(fresh&&baseKind!=='native'&&(s.traceAnchor||s.repairJsonMime)){
                        try{stage=newHeaders(init,input,s,t);init=stage.init;details.mime=stage.mime;details.anchor=stage.anchor;details.chars=stage.value?.length||0;}
                        catch{stage=null;details.mime=s.repairJsonMime?'rollback':'off';details.anchor=s.traceAnchor?'rollback':'off';}
                    }
                    if(!canNegotiate)return {init,why:transportReason==='waiting'?'out-of-scope':transportReason};
                    const step=negotiate(init,input,r.stream);
                    if(t.gate.search&&['rollback','request-shape','unknown-stream'].includes(step.why)){
                        // The original adapter skips this entire search case. Do not send half of this new transaction.
                        changed=false;status='wire-guard';t.expected=null;t.aux=null;t.addedBytes=0;
                        metadata({bodyStrategy:'none',repair:false,committed:false,addedBytes:0,addedChars:0});
                        return {init:prior,why:step.why};
                    }return step;},
                sent(decision){if(!active())return;issued=true;t.sends++;if(t.sends>1&&fresh){guard.clear();binding=null;details.guard=s.guardMode==='standard'?'ambiguous':'off';}if(aux?.sample)samples.submitted(aux.sample);const transport=decision||t.state.transport;
                    const httpChanged=transport==='sse'||transport==='json',freshChanged=omitted||details.mime==='added'||details.anchor==='sent';preview=aux?{id:t.id,text:aux.text}:null;metadata({...detailPatch(),browserSent:true,status,transport,committed:changed||httpChanged||freshChanged});update(t.id,{applied:changed||httpChanged||freshChanged,
                    dispatch:{at:new Date().toISOString(),label:freshChanged?'本次浏览器请求已按所选策略处理；各项实际结果见本轮诊断。':httpChanged?'已在浏览器出站请求声明接收格式；模型是否采用不可见。':changed?'在酒馆生成 fetch 边界核对到实际改动。':'在酒馆生成 fetch 边界核对：原字节放行。',injected:[],request:safeMeta(r,target290(r))}});},
                receipt(response){if(!active())return true;
                    if(response?.redirected&&binding){binding=null;if(details.guard==='monitoring')details.guard='inconclusive';}
                    details.ack=receiptAnchor(stage?.value,response);metadata({...detailPatch(),httpReceipt:true});
                    // The host still gets its original response. Only local evidence/copy is withheld.
                    return details.ack!=='mismatch';}};
        }
        if(!sameRoom(ctx,t.room))return pass('changed-chat');
        if(t.flags!==flags(s))return pass('changed-options');
        if(clock()-t.at>180000)return pass('expired');
        if(t.conflict)return pass('conflict');
        if(typeof raw!=='string')return pass('request-object');
        if(raw.length>WIRE_LIMIT)return pass('too-large');
        const legacy=compat290(r,p,s,group(ctx)), gate=assess(r,p,s,group(ctx),legacy);
        transportReason=gate.why;
        if(t.disabled)return pass(t.baseReason,true);
        const eligible=eligibility(r,legacy,p,s);
        const changedFresh=t.freshEpoch!==freshEpoch||t.freshFlags!==JSON.stringify(newFlags(s));
        const newStamp=!changedFresh&&!t.freshConflict&&t.ng.reason==='ready'&&eligible.reason==='ready'&&eligible.stamp===t.ng.stamp;
        const mayReadHeaders=newStamp&&unambiguous(raw,r)&&headerPermission(init0,input0);
        const wrongMime=mayReadHeaders&&!isJsonType(new Headers(init0.headers).get('Content-Type'));
        const rawOK=mayReadHeaders&&!wrongMime;
        if(!rawOK){
            if(changedFresh||t.freshConflict){details=freshStatus(s.pause143?'paused':changedFresh?'changed-options':'conflict');}
            else blocked('unverified');
        }
        if(wrongMime&&s.repairJsonMime)details.mime='explicit';
        const consistent=gate.eligible===t.gate.eligible&&!!gate.search===t.gate.search&&gate.stamp===t.gate.stamp;
        const clean=consistent&&gate.eligible&&unambiguous(raw,r);
        // On new-layer failure restart from the independent 1.4.1 decision, not from a partially edited body.
        if(!consistent)transportReason='unmatched';else if(gate.eligible&&!clean)transportReason='raw-guard';
        const base=clean?gate.base:legacy;
        if(!base.proof)return pass(consistent&&gate.search&&!clean?'raw-guard':'changed-input',consistent&&!!gate.search&&!clean);
        const k=wireKey(r);
        if(k!==t.key){
            if(t.expected&&k===t.expected){blocked('ambiguous');canNegotiate=!!clean;const a=t.aux;metadata({committed:true,status:'duplicate',addedChars:a?.text.length||0,addedBytes:t.addedBytes});return wireResult(undefined,true,'duplicate',a);}
            return pass('changed-input');
        }
        canNegotiate=!!clean;
        fresh=rawOK && !gate.search;
        if(fresh){
            // A positive source match is necessary for a model-visible decision but not for an HTTP trace.
            binding=s.guardMode==='standard'?guard.bind(ctx,r,JSON.stringify([s.shield,s.macro,s.macroWhen,s.macroSize,s.macroGroups,s.auxPosition])):null;
            if(s.guardMode==='standard')details.guard=binding?.identity?'monitoring':'no-question';
            if(base.kind==='native'){details.mime=s.repairJsonMime?'native-skip':'off';details.anchor=s.traceAnchor?'native-skip':'off';}
        }
        // Plan on the matched outgoing value only. Secure randomness is drawn at most once per actual generation;
        // retries carrying the same input reuse it. IDs used to match requests are never sent to the model.
        try {
            let cfg=clean&&gate.search?{...s,macro:false,shield:'off'}:s;
            // Prove the ordinary v1.4.2 projection would actually add something. A similar
            // marker in user/history data is never ours and cannot be removed or replaced.
            if(fresh&&binding){
                const regular=project(r,base,cfg,'probe');
                if(regular.note==='unowned-marker')blocked('unowned-marker');
                else if(regular.aux&&guard.shouldOmit(binding,ctx,r)){
                    cfg={...cfg,macro:false,shield:'off'};omitted=true;details.guard='omitted';
                }else if(!regular.aux)details.guard='no-aux';
            }
            const want=cfg.macro&&(cfg.macroWhen!=='normal'||t.type==='normal');
            const probe=project(r,base,cfg,want?'probe':'');
            if(want&&probe.aux&&t.sample==null) {
                try{t.sample=samples.take(cfg,ctx,t.type,randomBytes);}catch{
                    if(clean&&legacy.proof?.move){const bare=project(r,legacy,{...s,shield:'off',macro:false});
                        const encoded=encodeWire(raw,r,bare,legacy);canNegotiate=false;transportReason='rollback';
                        metadata({bodyStrategy:'legacy-tail',repair:true,addedBytes:0,addedChars:0,randomChars:0});
                        return wireResult(encoded,true,'random-unavailable',null);}
                    return pass('random-unavailable',true);}
            }
            const plan=want&&probe.aux?project(r,base,cfg,t.sample):probe;
            if(plan.note==='unowned-marker'){blocked('unowned-marker');canNegotiate=false;transportReason='unmatched';}
            const aux=plan.aux,changed=plan.out!==r;
            const encoded=changed?encodeWire(raw,r,plan,base):raw;
            const delta=changed?exp.encode(encoded).length-exp.encode(raw).length:0;
            if(changed){t.expected=wireKey(plan.out);t.aux=aux;t.addedBytes=delta;}
            metadata({bodyStrategy:base.proof.move&&changed?(gate.search?'search-tail':'legacy-tail'):'none',sampleSkipped:want&&t.sample===''?'no-turn-sample':null,committed:changed,browserSent:false,httpReceipt:false,status:plan.note,repair:changed&&base.proof.move,addedChars:aux?.text.length||0,addedBytes:delta,
                location:aux?aux.key+'['+aux.index+']':null,randomChars:aux?.sample?.length||0});
            return wireResult(changed?encoded:undefined,changed,plan.note,aux);
        } catch{canNegotiate=false;transportReason='raw-guard';return pass('wire-guard',true);}
    }
    return {prepare,before,start,reset,invalidateFresh,stop(){guard.clear();reset();},forget,peek:rid=>preview?.id===rid?preview?.text||'':'',belongs:()=>!dead&&(!!ticket||family(getContext().chatCompletionSettings||{})!=='legacy'),
        unavailable(why='request-object'){if(ticket){if(!ticket.state.browserSent)ticket.state.status=why;update(ticket.id,{experiment:{...ticket.state},note:label290(why)+'，原样放行。'});}},
        dispose(){dead=true;forget();}};
}
