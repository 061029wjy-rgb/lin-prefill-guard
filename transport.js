// Storage/UI get enums and counts only. No global hook, response rewriting or retry.
import {protocol290, layout290, proveTail, wireKind} from './lin290.js?v=1.4.3';

export const TRANSPORT_LABELS=Object.freeze({
    off:'已关闭', waiting:'尚未观察到发送', sse:'已向酒馆请求流式回复', json:'已向酒馆请求整段回复',
    'explicit-accept':'已有明确的接收格式，沿用原设置', 'unknown-stream':'无法确定回复格式',
    'request-shape':'无法核实请求或请求头，沿用原请求', 'protected-tool':'带有已有工具或工具回包',
    'protected-signature':'含签名或思考块，签名保持原样', 'protected-media':'含非文本内容',
    'protected-schema':'要求结构化结果', 'raw-guard':'出站序列化存在歧义，沿用原请求',
    'out-of-scope':'本轮不符合实验条件', 'search-only':'本轮使用 Google 网页搜索，样本和格式标记跳过',
    'unmatched':'组装与发送未能对应', 'rollback':'实验未提交，保留此前的请求'
});
const declared=x=>Array.isArray(x)?x.length>0:x!=null && x!==false && x!=='' && x!=='none';
export function risk(r){
    if(!r||typeof r!=='object')return 'request-shape';
    if(r.thoughtSignature||r.thought_signature||r.signature||r.toolSignatures||r.tool_signatures||r.continuationToken||r.continuation_token)return 'protected-signature';
    const ms=[...(Array.isArray(r.messages)?r.messages:[]),...(Array.isArray(r.contents)?r.contents:[])];
    const blocks=[...(r.systemInstruction?.parts||r.system_instruction?.parts||[])];
    for(const m of ms){if(!m)continue;if(m.thoughtSignature||m.thought_signature||m.signature||m.extra?.signature)return 'protected-signature';
        if(m.role==='tool'||m.role==='function'||m.tool_calls||m.tool_call_id||m.function_call)return 'protected-tool';
        if(Array.isArray(m.parts))blocks.push(...m.parts);
        if(Array.isArray(m.content))blocks.push(...m.content);}
    for(const b of blocks){if(!b)continue;if(b.thoughtSignature||b.thought_signature||b.signature||b.thought||b.type==='thinking')return 'protected-signature';
        if(b.functionCall||b.functionResponse||['tool_use','tool_result'].includes(b.type))return 'protected-tool';
        if(b.inlineData||b.fileData||b.type&&b.type!=='text')return 'protected-media';}
    if([r.tools,r.functions,r.tool_choice,r.function_call,r.mcp_servers,r.toolConfig,r.tool_config].some(declared))return 'protected-tool';
    if([r.json_schema,r.jsonSchema,r.response_schema,r.responseSchema,r.responseJsonSchema,r.generationConfig?.responseSchema,r.generationConfig?.responseJsonSchema].some(declared)||
       r.response_format&&r.response_format.type!=='text'||[r.responseMimeType,r.response_mime_type,r.generationConfig?.responseMimeType].some(x=>x&&x!=='text/plain'))return 'protected-schema';
    if(r.request_images)return 'protected-media';
    return null;
}
// Compare the remaining ST wire fields too: v1.4.1's message/parameter key was intentionally narrower.
// Never snapshot custom headers, body-carried passwords or arbitrary extension metadata.
const ROOTS=new Set(('type messages model stream temperature frequency_penalty presence_penalty top_p max_tokens max_completion_tokens logit_bias stop chat_completion_source n user_name char_name group_names include_reasoning reasoning_effort enable_web_search request_images request_image_resolution request_image_aspect_ratio custom_prompt_post_processing verbosity reverse_proxy proxy_password logprobs top_logprobs top_k seed use_sysprompt vertexai_auth_mode vertexai_express_project_id vertexai_region custom_url custom_include_body custom_include_headers custom_exclude_body min_p repetition_penalty top_a chat_id json_schema tools functions tool_choice mcp_servers function_call assistant_prefill').split(' '));
export function extraStamp(r){
    const fields=[];
    for(const k of Object.keys(r).sort()){
        const v=r[k];if(v===undefined||k==='messages')continue;
        if(!ROOTS.has(k))return null;
        if(['proxy_password','custom_include_headers','custom_include_body','custom_exclude_body'].includes(k)){if(v)return null;continue;}
        if(['custom_url','reverse_proxy'].includes(k)&&v){let url;try{url=new URL(v);}catch{return null;}if(url.username||url.password||url.search||url.hash)return null;}
        fields.push([k,v]);
    }
    const token=JSON.stringify(fields);return token.length<=65536?token:null;
}
// A narrowly scoped extension of the original tail proof. enable_web_search is NEVER toggled in the payload.
export function assess(r,p,s,group,baseline){
    try{return check(r,p,s,group,baseline);}catch{return {base:baseline,eligible:false,why:'request-shape'};}
}
function check(r,p,s,group,baseline){
    if(s.protocolProfile!=='standard')return {base:baseline,eligible:false,why:'off'};
    const out=why=>({base:baseline,eligible:false,why});
    if(!s.enabled||!s.compat290||s.requestMode==='observe'||!baseline.gemini4||!['normal','regenerate','swipe'].includes(r.type))return out('out-of-scope');
    if(typeof r.stream!=='boolean')return out('unknown-stream');
    const reason=risk(r);if(reason)return out(reason);
    if(wireKind(r)!=='messages')return out('request-shape'); // the verified ST browser endpoint
    const stamp=extraStamp(r);if(stamp==null)return out('request-shape');
    if(baseline.proof)return {base:baseline,eligible:true,search:false,stamp,why:'waiting'};
    if(baseline.reason!=='290-host-search'||r.enable_web_search!==true||!['makersuite','vertexai'].includes(r.chat_completion_source))return out('out-of-scope');
    if(protocol290(r,p,r.type,{hostSearch:true}))return out('request-shape');
    const l=layout290(p,r.type,group);if(l.reason)return out('out-of-scope');
    const proof=proveTail(r,l);if(!proof)return out('out-of-scope');
    const a=r.messages,ordered=proof.move?[...a.slice(0,-2),a.at(-1),a.at(-2)]:a;
    return {eligible:true,search:true,stamp,why:'waiting',base:{...baseline,proof,ordered,layout:l,kind:'messages',reason:proof.move?'290-restored':'290-ready'}};
}
// Only use ST's ordinary JSON serialization for a NEW strategy: eliminates duplicate fields and
// ambiguous nested representations. Differences leave independent legacy decisions intact.
export const unambiguous=(raw,r)=>typeof raw==='string'&&raw===JSON.stringify(r);
export function negotiate(init,input,stream){
    const skip=why=>({init,why});
    try{
        if(typeof stream!=='boolean')return skip('unknown-stream');
        if(!init||typeof init.body!=='string'||typeof input!=='string'&&!(input instanceof URL))return skip('request-shape');
        const headers=new Headers(init.headers);
        if(headers.get('content-type')?.split(';')[0].trim().toLowerCase()!=='application/json')return skip('request-shape');
        const old=headers.get('accept');if(old!=null&&old.trim()!=='*/*')return skip('explicit-accept');
        headers.set('Accept',stream?'text/event-stream':'application/json');
        // Keep AbortSignal, credentials, redirect, host options and the prepared body (including inherited fields).
        const next=Object.create(init);Object.defineProperty(next,'headers',{value:headers,enumerable:true});
        return {init:next,why:stream?'sse':'json'};
    }catch{return skip('rollback');}
}
