// Gemini 4 input compatibility. No provider credentials, generation or chat writes.
import { containsText, PROTOCOL_NAMES } from './protocol.js?v=1.5.1';
export { LIN_PROMPT_ID, LIN_CONFIRM_ID } from './protocol.js?v=1.5.1';

export function gemini4Target(request = {}, {tailPair=false} = {}) {
    const source = request.chat_completion_source;
    if (!['makersuite', 'vertexai', 'custom'].includes(source)) return null;
    const model = String(request.model || '').trim().toLowerCase();
    // Match the explicit model IDs, including channel labels and their /fc and /vs variants.
    const match = /(?:^|[-/:\s])gemini[-_ ]?4[-_ ]?(argon|carbon|hydrogen|neon)(?:\/(?:fc|vs))?$/.exec(model);
    if (!match || (match[1] === 'neon' && !tailPair) || (model.match(/gemini[-_ ]?4/gi) || []).length !== 1) return null;
    return { model: 'gemini-4-' + match[1], source,
        indirect: source === 'custom' || !!request.reverse_proxy || model !== 'gemini-4-' + match[1] };
}

// Only plain, independent messages can establish an anchor. A role, marker or
// substring in a player message is not an anchor. Leave additional metadata intact.
function simpleText(m) {
    if (!m || Object.keys(m).some(k => !['role','content'].includes(k))) return null;
    if (typeof m.content === 'string') return m.content;
    const b = Array.isArray(m.content) && m.content.length === 1 && m.content[0];
    return b?.type === 'text' && typeof b.text === 'string' && Object.keys(b).every(k => k === 'type' || k === 'text') ? b.text : null;
}
export const plainAnchor = simpleText;
const equal = (m, p) => m?.role === p.role && simpleText(m) === p.content;
function locate(messages, p) {
    const indices = [];
    for (let i = 0; i < messages.length; i++) if (equal(messages[i], p)) indices.push(i);
    return indices;
}
export function orderProof(messages, proof) {
    if (!proof || !Array.isArray(messages)) return null;
    const a = locate(messages, proof.cue), u = locate(messages, proof.confirm);
    if (a.length !== 1 || u.length !== 1) return 'unknown';
    if (proof.strictTail291 && (Math.min(a[0],u[0]) !== messages.length-2 || Math.max(a[0],u[0]) !== messages.length-1)) return 'unknown';
    if (proof.rules) {
        const r = locate(messages, proof.rules);
        if (r.length !== 1 || r[0] + 1 !== a[0] || a[0] + 1 !== u[0] || u[0] !== messages.length - 1) return 'unknown';
    }
    return a[0] < u[0] ? 'cue-before-user' : 'out-of-order';
}
// The ordered protocol allows only the configured system entries around the confirmed pair.
export function planGemini4(request, layout, type, target, risk) {
    const ms = request.messages;
    const finish = (reason, detail = '', extra = {}) => ({reason, detail, type, applied:false, changed:false,
        messages:ms, injected:[], netChars:0, removedOriginal:false, tailRoles:ms.slice(-2).map(m => m.role),
        protocol:'ordered', identification:PROTOCOL_NAMES.ordered, ...(target ? {gemini4:target} : {}), ...extra});
    if (!target) return finish('g4-other');
    if (risk || type === 'continue') return finish(risk || 'g4-continue');
    const {cue, confirm, between, after} = layout;
    const [a,u] = [cue,confirm].map(p => locate(ms,p));
    if (a.length !== 1 || u.length !== 1)
        return finish('g4-uncertain','承接或确认缺失、重复，或不是独立的原文消息。');
    const definitions = [cue,confirm,...between,...after];
    if (definitions.some(p => ms.some(m => !equal(m,p) && containsText(m,p.content))))
        return finish('g4-uncertain','历史或合并消息还含有承接、确认或尾部条目的原文。');
    let last = ms.length - 1;
    while (last >= 0 && simpleText(ms[last])?.trim() === '') last--;
    if (ms[last]?.role === 'assistant' && last !== a[0]) return finish('g4-foreign-tail');
    const reversed = a[0] > u[0];
    const prefix = Math.min(a[0],u[0]);
    if (!ms.slice(0,prefix).some(m => m.role === 'user' && containsNonemptyText(m)))
        return finish('no-user');
    function positions(entries) {
        const all = entries.map(p => locate(ms,p));
        return all.some(indices => indices.length > 1) ? null : all.flat();
    }
    const middle = positions(between), end = positions(after);
    if (!middle || !end) return finish('g4-uncertain','配置中的系统尾项在请求内重复。');
    const order = reversed ? [...middle,u[0],...end,a[0]] : [a[0],...middle,u[0],...end];
    if (order.at(-1) !== last || !order.every((value,i) => value === last - order.length + 1 + i))
        return finish('g4-uncertain','请求尾段与所选顺序组不符，夹有额外消息或尾项顺序不同。');
    const orderWitness = {cue:{role:cue.role,content:cue.content},confirm:{role:confirm.role,content:confirm.content}};
    const info = {orderWitness};
    if (!reversed) return finish('g4-ready','',info);
    const start = order[0];
    const messages = [...ms.slice(0,start),ms[a[0]],...ms.slice(start,a[0]),...ms.slice(a[0]+1)];
    return finish('g4-restored','',{...info,messages,changed:true,applied:true,tailRoles:messages.slice(-2).map(m=>m.role)});
}

export function containsNonemptyText(m) {
    return typeof m?.content === 'string' ? !!m.content.trim() :
        Array.isArray(m?.content) && m.content.some(b => typeof b?.text === 'string' && b.text.trim());
}

export function isGemini4Segment(r) {
    // Protocol evidence also applies in observe/enhance modes and older records.
    const request = r?.dispatch?.request || r?.request;
    const target = r?.gemini4 || gemini4Target({ model: request?.model, chat_completion_source: request?.source });
    return !!target && String(r?.wire?.finishReason || '').toUpperCase() === 'CONTINUATION';
}
