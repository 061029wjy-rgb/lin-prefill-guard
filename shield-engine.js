// No host hooks or network. The only model-input decision is whether to create our OWN
// optional legacy attachment on a user-initiated alternate reply. Never strips existing text.
import { extraStamp, risk } from './transport.js?v=1.4.3';

export const NEW_DEFAULTS=Object.freeze({guardMode:'off',traceAnchor:false,anchorSize:'short',repairJsonMime:false,detail143:false,pause143:false});
export const reset143=s=>Object.assign(s,NEW_DEFAULTS);
export const togglePause143=s=>(s.pause143=s.pause143!==true);
export const TRACE_HEADER='X-Lin-Request-Id';
const LEN=Object.freeze({short:16,medium:24,long:32});
const variants=new Set(['regenerate','swipe']);
// Only the caller-provided headers; browser-added network headers are not RequestInit fields.
const knownHeaders=new Set(['content-type','accept','x-csrf-token','x-lin-request-id']);
const only=(x,ks)=>x&&typeof x==='object'&&!Array.isArray(x)&&Object.keys(x).every(k=>ks.includes(k));
const nativeKeys=['type','model','chat_completion_source','stream','contents','systemInstruction','system_instruction','generationConfig','temperature','top_p','max_tokens','use_sysprompt','enable_web_search'];
const genKeys=['temperature','topP','topK','maxOutputTokens','candidateCount','stopSequences','responseMimeType'];
export const newFlags=s=>[s.guardMode,s.traceAnchor,s.anchorSize,s.repairJsonMime,s.pause143];
export function eligibility(r,base,p,s){
    const no=reason=>({reason,stamp:null});
    if(s.pause143)return no('paused');
    if(!s.traceAnchor&&!s.repairJsonMime&&s.guardMode!=='standard')return no('off');
    if(!s.enabled||!s.compat290||s.requestMode==='observe'||!base.gemini4||!['normal','swipe','regenerate'].includes(r.type))return no('scope');
    if(!['vertexai','makersuite'].includes(r.chat_completion_source))return no('indirect');
    if(r.enable_web_search || r.enable_web_search==null&&p.enable_web_search)return no('search');
    if(!base.proof || risk(r))return no('protected');
    if(typeof r.stream!=='boolean'||r.n!=null&&r.n!==1||r.generationConfig?.candidateCount!=null&&r.generationConfig.candidateCount!==1)return no('shape');
    // Native data must already have been seen in the ST settings event and independently proved at fetch.
    if(base.kind==='native'){
        if(!only(r,nativeKeys)||r.generationConfig&&!only(r.generationConfig,genKeys))return no('shape');
        return {reason:'ready',stamp:JSON.stringify(nativeKeys.filter(k=>!['contents','systemInstruction','system_instruction'].includes(k)).map(k=>r[k]))};
    }
    const stamp=extraStamp(r);
    return stamp===null?no('shape'):{reason:'ready',stamp};
}
export function headerPermission(init,input){
    try{
        if(!init||typeof init.body!=='string'||typeof input!=='string'&&!(input instanceof URL)||init.signal?.aborted)return false;
        const h=new Headers(init.headers);
        return [...h.keys()].every(name=>knownHeaders.has(name));
    }catch{return false;}
}
export function drawAnchor(size,bytes=n=>globalThis.crypto.getRandomValues(new Uint8Array(n))){
    if(!Object.hasOwn(LEN,size))throw Error('size');
    const n=LEN[size]/2,arr=bytes(n);
    if(!(arr instanceof Uint8Array)||arr.length!==n)throw Error('size');
    return Array.from(arr,b=>b.toString(16).padStart(2,'0')).join('');
}
// A header trace is not a prompt nonce. The client does not invent an acknowledgement.
export const isJsonType=ct=>ct===null||/^application\/json(?:\s*;\s*charset\s*=\s*(?:utf-8|"utf-8")\s*)?$/i.test(ct);
export function newHeaders(init,input,s,t){
    let mime=s.repairJsonMime?'unchanged':'off',anchor=s.traceAnchor?'unavailable':'off';
    if(!headerPermission(init,input))return {init,mime:s.repairJsonMime?'protected':'off',anchor:s.traceAnchor?'protected':'off'};
    const h=new Headers(init.headers);let value=null;
    const ct=h.get('content-type');
    if(!isJsonType(ct))
        return {init,mime:s.repairJsonMime?'explicit':'off',anchor:s.traceAnchor?'protected':'off'};
    if(ct===null&&s.repairJsonMime){h.set('Content-Type','application/json');mime='added';}
    if(s.traceAnchor){
        if(h.has(TRACE_HEADER))anchor='occupied';
        else if(ct===null&&mime!=='added')anchor='protected';
        else {
            // Memoize success AND failure per generation; never draw again on duplicate callbacks.
            if(!Object.hasOwn(t,'traceValue')){try{t.traceValue=drawAnchor(s.anchorSize,t.bytes);}catch{t.traceValue=null;}}
            if(t.traceValue){value=t.traceValue;h.set(TRACE_HEADER,value);anchor='sent';}
        }
    }
    if(!value&&mime!=='added')return {init,mime,anchor};
    const out=Object.create(init);Object.defineProperty(out,'headers',{value:h,enumerable:true});
    return {init:out,mime,anchor,value};
}
export function receiptAnchor(value,response){
    if(!value)return 'none';
    if(response?.redirected||!response?.headers)return 'unknown';
    const v=response.headers.get(TRACE_HEADER);
    return v===null?'absent':v===value?'matched':'mismatch';
}
function speaker(ctx){
    const char=ctx.characterId, group=ctx.groupId;
    if(char==null&&(!ctx.name2||group!=null))return null;
    return [char,ctx.characters?.[char]?.avatar??null,ctx.name2??null,group??null];
}
function scene(ctx,r,variant){
    const chat=ctx.chat,room=ctx.getCurrentChatId?.()??ctx.chatId,actor=speaker(ctx);
    if(!Array.isArray(chat)||room==null||!actor)return null;
    const i=chat.findLastIndex(m=>m?.is_user===true&&!m.is_system),u=chat[i];
    if(i<0||typeof u?.mes!=='string'||!u.mes.trim()||chat.length>i+2)return null;
    const history=(r.messages||r.contents||[]).slice(0,-2);
    const m=history.findLast(x=>x.role==='user'),body=typeof m?.content==='string'?m.content:
        (m?.parts||m?.content)?.length===1?(m.parts||m.content)[0]?.text:null;
    if(body!==u.mes)return null;
    const prev=chat[i-1];
    return [chat,room,...actor,i,u,u.mes,u.swipe_id,prev,prev?.mes,prev?.swipe_id,r.chat_completion_source,r.model,r.reverse_proxy??'',variant];
}
const equal=(a,b)=>a&&b&&a.length===b.length&&a.every((v,i)=>v===b[i]);
export function echoGuard(clock=Date.now){
    let serial=0,armed=null,retry=null;
    return {
        clear(){serial++;armed=null;retry=null;},
        start(type){serial++;retry=variants.has(type)?armed:null;armed=null;},
        bind(ctx,r,variant=''){return {serial,variant,identity:scene(ctx,r,variant)};},
        shouldOmit(binding,ctx,r){
            if(!binding||binding.serial!==serial||!variants.has(r.type)||!retry||clock()-retry.at>180000||!equal(retry.identity,binding.identity))return false;
            const last=ctx.chat.at(-1);
            return last?.is_user===true||(!last?.is_system&&typeof last?.mes==='string'&&last.mes.trim()===retry.echo);
        },
        observe(binding,ctx,r,stats,owned,sample){
            if(!binding||binding.serial!==serial||!equal(binding.identity,scene(ctx,r,binding.variant))||!stats||!owned)return false;
            if(!stats.responseComplete||!stats.recognized||stats.httpStatus<200||stats.httpStatus>=300||
                stats.aborted||stats.networkError||stats.parseErrors||stats.captureLimited||stats.protocolMismatch||stats.streamMessageEnvelope||
                stats.transport==='ndjson'||stats.unverifiedEchoShape||stats.continuationTokenSeen||stats.refusal||stats.blockReason||stats.apiError||stats.incomplete||stats.toolCalls||stats.multipleCandidates||
                !/^(?:stop|end_turn|stop_sequence)$/i.test(stats.finishReason||''))return false;
            const echo=stats.ownedEchoOnly==='whole'?owned:stats.ownedEchoOnly==='sample'?sample:null;
            if(!echo)return false;
            armed={identity:binding.identity,at:clock(),echo};return true;
        },
    };
}
export function matchesOwned(visible,owned,sample){
    if(!owned||typeof visible!=='string')return 'none';
    const v=visible.trim();return v===owned?'whole':sample&&v===sample?'sample':'none';
}
