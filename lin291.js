// The strict two-turn planner keeps each preset object intact.
import { plainAnchor, containsNonemptyText } from './gemini4.js?v=1.5.1';
import { containsText, PROTOCOL_NAMES } from './protocol.js?v=1.5.1';
import { ACK } from './handoff.js?v=1.5.1';

export function planPair(r, type, settings, layout, target, risk) {
    const ms = r.messages, {cue, confirm, meta} = layout;
    const base = {type, applied:false, changed:false, messages:ms, injected:[], netChars:0, removedOriginal:false,
        tailRoles:ms.slice(-2).map(m => m.role), identification:PROTOCOL_NAMES.pair, protocol:'pair',
        lin291:{...meta, identity:'pair', path:settings.requestMode === 'enhance' ? 'preserve-legacy' : 'original'},
        ...(target ? {gemini4:target} : {})};
    const done = (reason, extra = {}) => ({...base, reason, ...extra});
    if (!target) return done('g4-other');
    if (risk) return done(risk);
    if (type === 'continue') return done('g4-continue',{
        plainContinue:ms.at(-1)?.role === 'user' && containsNonemptyText(ms.at(-1))});

    const fail = detail => done('g291-anchors',{detail, currentPair:{cue:cue.content,confirm:confirm.content}});
    const locate = p => {
        const hits = [];
        for (let i = 0; i < ms.length; i++) if (containsText(ms[i],p.content)) hits.push(i);
        return hits;
    };
    const [a, u] = [cue,confirm].map(locate);
    for (const [hits,p,label] of [[a,cue,'承接'],[u,confirm,'确认']]) {
        if (!hits.length) return fail(label + '原文未出现在本次请求中。');
        if (hits.length !== 1) return fail(label + '原文在多条消息中出现。');
        const match = ms[hits[0]];
        if (match.role !== p.role) return fail(label + '原文出现在错误的消息角色中。');
        if (plainAnchor(match) !== p.content) return fail(label + '原文已合并、带附加字段或分散在多个文本块中。');
    }
    const i = a[0], j = u[0], end = ms.length - 1;
    if (Math.min(i,j) !== end - 1 || Math.max(i,j) !== end) return fail('两条原文均存在，但未独占请求末尾两个位置。');
    if (!ms.slice(0,-2).some(m => m.role === 'user' && containsNonemptyText(m))) return done('no-user');
    const reversed = i > j, proof = {cue:{role:cue.role,content:cue.content},confirm:{role:confirm.role,content:confirm.content},strictTail291:true};
    const normal = reversed ? [...ms.slice(0,-2),ms[i],ms[j]] : ms;
    const compat = (note = '') => done(reversed ? 'g291-restored' : 'g291-ready',{
        messages:normal,changed:reversed,applied:reversed,tailRoles:['assistant','user'],orderWitness:proof,note});
    if (settings.requestMode !== 'gemini4-story') return compat();
    if (target.source !== 'vertexai' || target.indirect || r.vertexai_auth_mode === 'proxy' || r.max_completion_tokens != null)
        return compat('正文承接需要直接 Vertex 连接和单一预算字段。本轮已核对原承接。');
    const cap = settings.storyMoreTokens === true && r.max_tokens === 16384 ? {before:16384,after:32768} : null;
    if (meta.authoredHandoff) return done(reversed ? 'g291-authored-restored' : 'g291-authored-ready',{
        messages:normal,changed:reversed,applied:reversed || !!cap,tailRoles:['assistant','user'],orderWitness:proof,
        lin291:{...base.lin291,path:'authored-tail'},
        handoff:{usingPresetTail:true,shortConfirmation:false,removedMaxDemand:false,cap,restored:reversed}});
    if (ms.some(m => containsText(m,ACK))) return compat('本次请求已有短确认，本轮仅核对原承接。');
    // Existing opt-in 1.3.2 behavior for the unsectioned two-turn protocol.
    const ack = {role:'user',content:ACK}, messages = [...ms.slice(0,-2),ms[j],ms[i],ack];
    return done('g291-handoff',{messages,changed:true,applied:true,injected:[ack],netChars:ACK.length,tailRoles:['assistant','user'],
        lin291:{...base.lin291,path:'story'},orderWitness:{strictTail291:true,cue:proof.cue,rules:proof.confirm,confirm:ack},
        handoff:{shortConfirmation:true,removedMaxDemand:false,cap,restored:reversed}});
}
