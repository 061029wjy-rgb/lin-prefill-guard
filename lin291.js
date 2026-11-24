// Compatibility branch for the user's Lin 2.9.1 preset. All returned messages are
// the host's original objects except the opt-in 1.3 short user acknowledgement.
import { LIN_PROMPT_ID, LIN_CONFIRM_ID, gemini4Target, plainAnchor, fingerprint } from './gemini4.js?v=1.3.2';
import { ACK } from './handoff.js?v=1.3.2';

export const NPC291 = 'b62baac5-e695-5ce5-899b-edc7989babc8';
const CLOSURE291 = '99dd9277-7d27-40fb-972f-a009ae4983e9';
const MULTI = 'dd5c8140-817e-4cb5-97cf-2ae100dd3b6d', MEDIUM = '5f251ef0-8539-48f1-90d3-439364dccbca';
const arr = x => Array.isArray(x) ? x : [];
const one = (xs, id) => { const found=xs.filter(x=>x?.identifier===id); return found.length===1 ? found[0] : null; };
const textDef = (p, role) => p?.role===role && !p.marker && typeof p.content==='string' && !!p.content.trim();
const relative = p => p.injection_position==null || p.injection_position===0;
const isKeys = (obj, keys) => !!obj && typeof obj==='object' && Object.keys(obj).every(k=>keys.includes(k));
const eligibleType = (p, type) => p.injection_trigger==null || (Array.isArray(p.injection_trigger) && (!p.injection_trigger.length || p.injection_trigger.includes(type)));

// A title alone or the two cue IDs reused across many Lin releases is not identification.
// For renamed files, the NPC entry and another independent revision marker can identify the
// supplied layout. Fingerprints are VERSION hints only, never permission to edit output.
export function identify291(preset={}) {
    const ps=arr(preset.prompts), npc=one(ps,NPC291);
    const ids=[preset.name,preset.preset_settings_openai].flatMap(s=>typeof s==='string'?
        [...s.replace(/\.json\s*$/i,'').matchAll(/(?:^|[^a-z0-9])lin[\s_-]*v?[\s_-]*(\d+(?:\.\d+)+(?:[a-z][a-z0-9]*)?)(?![\d.a-z])/gi)].map(m=>m[1]):[]);
    if (!ids.includes('2.9.1') && !ps.some(p=>p?.identifier===NPC291)) return null;
    if (ids.some(v=>v!=='2.9.1') || !textDef(npc,'system')) return 'conflict';
    if (ids.includes('2.9.1')) return 'title-and-entry';
    const second=[[MULTI,'718:a62a0d90'],[MEDIUM,'1010:fa7772e9']].some(([id,fp])=>{
        const x=one(ps,id);return textDef(x,'system')&&fingerprint(x.content)===fp;});
    return fingerprint(npc.content)==='321:b47e815a'&&second?'preset-entries':'conflict';
}

export function layout291(preset={}, type='normal', activeId=null, signature=identify291(preset)) {
    const unknown={ order:null, cueEnabled:null, confirmEnabled:null, npcEnabled:null };
    const fail=(reason,meta=unknown)=>({reason,meta});
    if (!signature||signature==='conflict') return fail('g291-unverified');
    const ps=arr(preset.prompts), groups=arr(preset.prompt_order);
    const cue=one(ps,LIN_PROMPT_ID),confirm=one(ps,LIN_CONFIRM_ID);
    if(!textDef(cue,'assistant')||!textDef(confirm,'user')||!relative(cue)||!relative(confirm)||cue.content===confirm.content)
        return fail('g291-anchors');
    if(typeof activeId!=='string'&&typeof activeId!=='number') activeId=null;
    const gs=activeId==null ? groups : groups.filter(g=>String(g?.character_id)===String(activeId));
    if(!gs.length || (activeId!=null&&gs.length!==1) || gs.some(g=>!g||g.character_id==null||!Array.isArray(g.order)) ||
        new Set(gs.map(g=>String(g.character_id))).size!==gs.length) return fail('g291-order');
    function inspect(g){
        const o=g.order;
        const flag=id=>{const x=one(o,id);return typeof x?.enabled==='boolean'?x.enabled:null;};
        const cueEnabled=flag(LIN_PROMPT_ID),confirmEnabled=flag(LIN_CONFIRM_ID),npcEnabled=flag(NPC291);
        const ci=o.indexOf(one(o,LIN_PROMPT_ID)),ui=o.indexOf(one(o,LIN_CONFIRM_ID));
        // No guesswork when settings explicitly put something ELSE at the end. Empty ST
        // placeholders may be filled by the host, in which case the actual tail test still vetoes.
        let issue=null;
        if(cueEnabled==null||confirmEnabled==null)issue='g291-order';
        else if(!cueEnabled||!confirmEnabled)issue='g4-disabled';
        else if(ci>=ui)issue='g291-order';
        else if(!eligibleType(cue,type)||!eligibleType(confirm,type))issue='trigger-excluded';
        else if(o.slice(ci+1).some(e=>{
            if(!e||e.identifier===LIN_CONFIRM_ID||e.enabled===false)return false;
            const p=one(ps,e.identifier);return !p||e.enabled!==true||
                (relative(p)&&eligibleType(p,type)&&typeof p.content==='string'&&!!p.content.trim());
        }))issue='g291-other-tail';
        return {cueEnabled,confirmEnabled,npcEnabled,closureEnabled:flag(CLOSURE291),issue};
    }
    const readings=gs.map(inspect);
    const same=k=>readings.every(v=>v[k]===readings[0][k]) ? readings[0][k] : null;
    // A fallback cannot attribute per-group NPC switches or assume a disabled cue is enabled.
    const meta={order:gs.length===1 ? String(gs[0].character_id) : 'consensus',
        cueEnabled:same('cueEnabled'),confirmEnabled:same('confirmEnabled'),npcEnabled:same('npcEnabled'),
        ...(one(ps,CLOSURE291)?{closureEnabled:same('closureEnabled')}:{}),
        // This is a user-owned section in the verified confirmation, not a magic
        // string to hunt for in chat. Keep the whole object, even if the prose
        // after the heading changes in a future edit. Never insert its contents.
        ...(confirm.content.split(/\r\n|[\r\n]/).some(line=>line.trim()==='【生成交接】')?{authoredHandoff:true}:{})};
    if(!readings.every(v=>v.issue===readings[0].issue) || meta.cueEnabled==null || meta.confirmEnabled==null) return fail('g291-order',meta);
    return readings[0].issue ? fail(readings[0].issue,meta) : {cue,confirm,meta};
}

export function directGoogle4(target) {
    return !!target && !target.indirect && ['makersuite', 'vertexai'].includes(target.source)
        && ['gemini-4-carbon', 'gemini-4-argon'].includes(target.model);
}

function risk291(r,preset,target){
    const hasPrefix = v => typeof v === 'string' && !!v.trim();
    if (hasPrefix(r.assistant_prefill) || r.messages.some(m => m?.prefix === true))
        return directGoogle4(target) ? 'g291-unsupported-prefix' : 'native-prefill';
    // ST only sends the preset's assistant_prefill field on its Claude route.
    if (!directGoogle4(target) && hasPrefix(preset.assistant_prefill)) return 'native-prefill';
    if(r.json_schema || (r.response_format&&r.response_format.type!=='text') || r.generationConfig?.responseSchema || r.generationConfig?.responseJsonSchema ||
        (r.generationConfig?.responseMimeType && r.generationConfig.responseMimeType!=='text/plain'))return 'structured';
    if([r.tools,r.functions,r.mcp_servers].some(x=>x!=null&&(!Array.isArray(x)||x.length>0)) ||
        (r.tool_choice!=null&&r.tool_choice!=='none') || (r.function_call!=null&&r.function_call!=='none') ||
        r.messages.some(m=>!['user','assistant','system','developer'].includes(m.role)||m.tool_calls?.length||m.function_call||m.tool_call_id))return 'tools';
    if(r.n!=null&&r.n!==1||r.continuationToken||r.continuation_token||r.cachedContent||r.cached_content||
        r.messages.some(m=>!isKeys(m,['role','content','name'])||!(typeof m.content==='string'||
            (Array.isArray(m.content)&&m.content.length&&m.content.every(x=>x?.type==='text'&&typeof x.text==='string'&&isKeys(x,['type','text']))))))return 'g291-protected';
    return null;
}
const parts=m=>typeof m?.content==='string'?[m.content]:arr(m?.content).map(b=>b?.text).filter(x=>typeof x==='string');
const has=(m,t)=>parts(m).some(s=>s.includes(t));

// Never infer a cue from the name of an NPC rule, from markers or from the last role alone.
export function plan291(r,preset,type,settings,activeId,signature) {
    const ms=r.messages,target=gemini4Target(r,{lin291:true}),l=layout291(preset,type,activeId,signature);
    const base={type,applied:false,changed:false,messages:ms,injected:[],netChars:0,removedOriginal:false,
        tailRoles:ms.slice(-2).map(m=>m.role),identification:signature==='conflict'?'none':'Lin 2.9.1',
        lin291:{...l.meta, identity:signature, path:settings.requestMode==='enhance'?'preserve-legacy':'original'},
        ...(target?{gemini4:target}:{}),
        note:settings.requestMode==='enhance'?'2.9.1 使用预设自带的交付与多线规则；本轮不追加旧版增强提示，不调整思考参数。':''};
    const done=(reason,extra={})=>({...base,reason,...extra});
    if(settings.requestMode==='observe')return done('observe-only');
    if(l.reason)return done(l.reason);
    if(!target)return done('g4-other');
    const risk=risk291(r,preset,target);
    if(type==='continue')return done('g4-continue',{plainContinue:!risk && ms.at(-1)?.role==='user'});
    if(risk)return done(risk);
    const end=ms.length-1, a=l.cue, u=l.confirm;
    if(end<2)return done('g291-anchors');
    const exact=(m,p)=>m.role===p.role && plainAnchor(m)===p.content;
    const rev=exact(ms[end-1],u)&&exact(ms[end],a);
    if(!(rev || exact(ms[end-1],a)&&exact(ms[end],u)))return done('g291-anchors');
    const posA=rev?end:end-1,posU=rev?end-1:end;
    if(ms.some((m,i)=>(i!==posA && has(m,a.content)) || (i!==posU && has(m,u.content))))return done('g291-anchors');
    if(!ms.slice(0,-2).some(m=>m.role==='user'&&parts(m).some(s=>s.trim())))return done('no-user');
    const cue=ms[posA],user=ms[posU],proof={cue:{role:'assistant',content:a.content},confirm:{role:'user',content:u.content},strictTail291:true};
    const normal=rev?[...ms.slice(0,-2),cue,user]:ms;
    const compat=(note=base.note)=>done(rev?'g291-restored':'g291-ready',{messages:normal,changed:rev,applied:rev,tailRoles:['assistant','user'],orderWitness:proof,note});
    if(settings.requestMode!=='gemini4-story')return compat();
    if(target.source!=='vertexai'||target.indirect||r.max_completion_tokens!=null||ms.some(m=>has(m,ACK)))
        return compat('正文承接未应用：需要直接 Vertex、明确预算且不可已有短确认。本轮仅核对原承接。');
    const cap=settings.storyMoreTokens===true&&r.max_tokens===16384?{before:16384,after:32768}:null;
    if (l.meta.authoredHandoff) {
        // The edited preset already owns the final user turn. Never move this
        // handoff to an earlier turn and never override it with our generic ACK.
        return done(rev?'g291-authored-restored':'g291-authored-ready',{
            messages:normal,changed:rev,applied:rev||!!cap,tailRoles:['assistant','user'],orderWitness:proof,
            lin291:{...base.lin291,path:'authored-tail'},
            handoff:{usingPresetTail:true,shortConfirmation:false,removedMaxDemand:false,cap,restored:rev}});
    }
    // The 2.9.1 rules already request concise delivery. Preserve the complete original
    // user object; never run the 2.8.2 paragraph deletion or replace the NPC/CoT instructions.
    const ack={role:'user',content:ACK}, messages=[...ms.slice(0,-2),user,cue,ack];
    return done('g291-handoff',{messages,changed:true,applied:true,injected:[ack],netChars:ACK.length,tailRoles:['assistant','user'],
        lin291:{...base.lin291,path:'story'},orderWitness:{strictTail291:true,cue:proof.cue,rules:proof.confirm,confirm:ack},
        handoff:{shortConfirmation:true,removedMaxDemand:false,cap,restored:rev}});
}
