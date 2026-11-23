// The 2.9 adapter reads a preset; it never writes a prompt, a message, or a setting.
import { LIN_PROMPT_ID, LIN_CONFIRM_ID } from './gemini4.js?v=1.4.2';

export const GROUPS = ['100000','100001'];
const TEXT_TYPES = ['normal','regenerate','swipe'];
const own = (x,k) => Object.hasOwn(x,k);
const plain = x => !!x && typeof x === 'object' && !Array.isArray(x);
const only = (x, keys) => plain(x) && Object.keys(x).every(k => keys.includes(k));
const one = (xs,id) => { const found = xs.filter(x => x?.identifier === id); return found.length === 1 ? found[0] : null; };
function print(s) {
    let h=2166136261; for (let i=0;i<s.length;i++) h=Math.imul(h^s.charCodeAt(i),16777619);
    return s.length+':'+(h>>>0).toString(16);
}
function versionStrings(p) {
    return [p?.name,p?.preset_settings_openai].filter(x=>typeof x==='string')
        .flatMap(x=>Array.from(x.matchAll(/(?:^|[^a-z])lin\s*[-_v]?\s*(\d+\.\d+(?:\.\d+)?)(?![\d.])/gi),m=>m[1]));
}
export function family(p={}) {
    const vs=versionStrings(p);
    if(vs.length) {
        if(vs.every(x=>x==='2.9.0'))return '290';
        if(vs.some(x=>{const [a,b]=x.split('.').map(Number);return a>2||a===2&&b>=9;}))return 'protected';
        return 'legacy';
    }
    const ps=Array.isArray(p.prompts)?p.prompts:[];
    const cue=one(ps,LIN_PROMPT_ID)?.content, tail=one(ps,LIN_CONFIRM_ID)?.content;
    if(typeof tail==='string' && print(tail.replaceAll('\r\n','\n'))==='1260:9db1e9ad' &&
       typeof cue==='string' && print(cue.replaceAll('\r\n','\n'))==='271:ec26d121') return '290';
    // A renamed newer layout should never fall into the legacy cue replacement solely on its UUID.
    if(ps.some(x=>x.identifier==='main' && typeof x.content==='string' && x.content.includes('<request_metadata>')) &&
       ps.some(x=>x.identifier===LIN_CONFIRM_ID))return 'protected';
    return 'legacy';
}
export function detectedNonce(p={}) {
    const main=one(Array.isArray(p.prompts)?p.prompts:[],'main')?.content;
    return typeof main==='string' && main.includes('{{random::') && main.includes('{{roll::') && main.includes('[nonce:');
}
export function target290(r={}) {
    const source=r.chat_completion_source;
    if(!['makersuite','vertexai','custom'].includes(source)||typeof r.model!=='string')return null;
    const s=r.model.trim().toLowerCase();
    const m=/(?:^|[-/:\s])gemini[-_ ]?4[-_ ]?(argon|carbon|hydrogen|neon)(?:\/(?:vs|fc))?$/.exec(s);
    if(!m||(s.match(/gemini[-_ ]?4/g)||[]).length!==1)return null;
    return {source,model:'gemini-4-'+m[1],indirect:source==='custom'||!!r.reverse_proxy||s!=='gemini-4-'+m[1],upstreamVerified:false};
}
export function layout290(p={},type='normal',selectedGroup) {
    const bad={reason:'290-layout'};
    if(family(p)!=='290'||!Array.isArray(p.prompts)||!Array.isArray(p.prompt_order))return bad;
    const cue=one(p.prompts,LIN_PROMPT_ID), confirm=one(p.prompts,LIN_CONFIRM_ID);
    for(const [v,role] of [[cue,'assistant'],[confirm,'user']]) {
        if(!v||v.role!==role||v.marker||v.injection_position!==0||typeof v.content!=='string'||!v.content.trim())return bad;
        if(v.injection_trigger!=null&&(!Array.isArray(v.injection_trigger)||(v.injection_trigger.length&&!v.injection_trigger.includes(type))))return {reason:'trigger-excluded'};
    }
    const groups=selectedGroup==null?GROUPS:[String(selectedGroup)];
    if(groups.some(k=>!GROUPS.includes(k)))return bad;
    const layout=[];
    for(const g of groups) {
        const xs=p.prompt_order.filter(o=>String(o?.character_id)===g);
        if(xs.length!==1||!Array.isArray(xs[0].order))return bad;
        const o=xs[0].order, a=one(o,LIN_PROMPT_ID),u=one(o,LIN_CONFIRM_ID);
        if(!a||!u||o.indexOf(a)>=o.indexOf(u))return bad;
        if(a.enabled!==true||u.enabled!==true)return {reason:'g4-disabled'};
        // A real nonempty/unknown enabled suffix means we cannot infer adjacency. A marker is
        // never fabricated; a nonempty runtime marker will still fail the exact tail proof.
        for(const x of o.slice(o.indexOf(a)+1)) {
            if(x===u||x.enabled!==true)continue;
            const def=one(p.prompts,x.identifier);
            if(!def || (!def.marker && (typeof def.content!=='string'||def.content.trim())))return bad;
        }
        layout.push(g);
    }
    return {cue,confirm,groups:layout,nonce:detectedNonce(p)};
}
export const systemKey=r=>Object.hasOwn(r,'systemInstruction')?'systemInstruction':'system_instruction';
export function wireKind(r) {
    if(!r||typeof r!=='object')return null;
    if(Array.isArray(r.messages) && !own(r,'contents')&&!own(r,'systemInstruction')&&!own(r,'system_instruction'))return 'messages';
    if(!own(r,'messages') && Array.isArray(r.contents) && (own(r,'systemInstruction')!==own(r,'system_instruction')))return 'native';
    return null;
}
const ccText = v=>typeof v==='string'?v:Array.isArray(v)&&v.length===1&&only(v[0],['type','text'])&&v[0].type==='text'&&typeof v[0].text==='string'?v[0].text:null;
const nativeText = p => only(p,['text']) && typeof p.text==='string';
const declared=x=>Array.isArray(x)?x.length>0:x!=null && x!==false && x!=='none' && x!=='';
export function protocol290(r,p={},type=r?.type,{hostSearch=false}={}) {
    const kind=wireKind(r);
    if(!['normal','regenerate','swipe','continue','quiet','impersonate'].includes(type))return 'unsupported-type';
    if(!TEXT_TYPES.includes(type))return type==='continue'?'g4-continue':type;
    if(!kind)return '290-shape';
    if([r.assistant_prefill,p.assistant_prefill,r.prefill,r.prefix,r.continuationToken,r.continuation_token].some(declared))return 'native-prefill';
    // ST's Google backend adds its own search tool after the browser event. Leave that whole request intact.
    if(['makersuite','vertexai'].includes(r.chat_completion_source)&&r.enable_web_search&&!hostSearch)return '290-host-search';
    if([r.tools,r.functions,r.tool_choice,r.function_call,r.mcp_servers,r.toolConfig,r.tool_config].some(declared))return 'tools';
    const gen=r.generationConfig||{};
    if(r.responseMimeType&&r.responseMimeType!=='text/plain'||r.json_schema||r.jsonSchema||r.response_schema||r.responseSchema||r.responseJsonSchema||r.response_format&&r.response_format.type!=='text'||
        gen.responseSchema||gen.responseJsonSchema||gen.responseMimeType&&gen.responseMimeType!=='text/plain')return 'structured';
    if(r.thoughtSignature||r.thought_signature||r.continuation||r.continuation_token||r.response_mime_type&&r.response_mime_type!=='text/plain'||r.request_images||Number(r.n??gen.candidateCount??1)!==1||r.cachedContent||r.cached_content||r.generation_config||
        r.response_modalities||gen.responseModalities?.some?.(x=>x!=='TEXT'))return '290-shape';
    if(r.chat_completion_source==='custom'&&(r.custom_include_body||r.custom_exclude_body||r.custom_include_headers||r.custom_prompt_post_processing&&r.custom_prompt_post_processing!=='none'))return '290-postprocess';
    if(kind==='native'){
        const sys=r[systemKey(r)];
        if(!only(sys,['role','parts'])||(sys.role!=null&&sys.role!=='system')||!Array.isArray(sys.parts)||!sys.parts.length||!sys.parts.every(nativeText))return '290-shape';
        if(r.contents.some(m=>!only(m,['role','parts'])||!['user','model'].includes(m.role)||!Array.isArray(m.parts)||!m.parts.length||!m.parts.every(nativeText)))return '290-special';
    } else if(r.messages.some(m=>!only(m,['role','content','name'])||!['system','user','assistant'].includes(m.role)||
        (m.name!=null&&typeof m.name!=='string')||!(typeof m.content==='string'||Array.isArray(m.content)&&m.content.length&&m.content.every(x=>only(x,['type','text'])&&x.type==='text'&&typeof x.text==='string'))))return '290-special';
    return null;
}
export function proveTail(r,l) {
    const kind=wireKind(r), ms=kind==='messages'?r.messages:r.contents;
    const text=m=>kind==='messages'?ccText(m.content):(m.parts.length===1?m.parts[0].text:null);
    const roles=kind==='messages'?['assistant','user']:['model','user'];
    const end=ms.length-1, defs=[l.cue,l.confirm], ids=[];
    for(let n=0;n<2;n++){
        let i=-1;
        for(let j=0;j<ms.length;j++){
            const m=ms[j], parts=kind==='messages'?typeof m.content==='string'?[m.content]:m.content.map(x=>x.text):m.parts.map(x=>x.text);
            if(!parts.some(s=>s.includes(defs[n].content))&&!parts.join('').includes(defs[n].content))continue;
            if(i!==-1||m.role!==roles[n]||Object.hasOwn(m,'name')||text(m)!==defs[n].content)return null;
            i=j;
        }
        ids.push(i);
    }
    const [a,u]=ids;
    if(Math.min(a,u)!==end-1||Math.max(a,u)!==end||!ms.slice(0,end-1).some(x=>x.role==='user'))return null;
    return {a,u,kind,move:a>u};
}
// Named 2.9 or a fingerprint without a name: never enter 2.8.2 rewriting or legacy enhancement.
export function compat290(r,p,options={},group) {
    const type=r?.type||'normal', ms=Array.isArray(r?.messages)?r.messages:[], base={applied:false,changed:false,type,
        identification:'Lin 2.9.0',messages:ms,injected:[],tailRoles:ms.slice(-2).map(x=>x?.role),netChars:0,removedOriginal:false};
    const ret=(reason,extra={})=>({...base,reason,...extra});
    if(family(p)!=='290')return ret('290-unknown',{identification:'未适配的新版本'});
    if(!options.enabled || options.compat290===false)return ret('disabled');
    if(options.requestMode==='observe')return ret('observe-only');
    const gemini4=target290(r);if(!gemini4)return ret('g4-other');
    const l=layout290(p,type,group);if(l.reason)return ret(l.reason,{gemini4});
    const invalid=protocol290(r,p,type);if(invalid)return ret(invalid,{gemini4});
    const proof=proveTail(r,l);if(!proof)return ret('g4-uncertain',{gemini4});
    const k=proof.kind==='native'?'contents':'messages',arr=r[k];
    const ordered=proof.move?[...arr.slice(0,-2),arr.at(-1),arr.at(-2)]:arr;
    return ret(proof.move?'290-restored':'290-ready',{gemini4,proof,layout:l,ordered,kind:proof.kind,
        changed:proof.move,applied:proof.move,messages:k==='messages'?ordered:ms,tailRoles:['assistant','user']});
}
