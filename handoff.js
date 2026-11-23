// A semantic handoff for the verified Lin 2.8.2 pair, not a provider prefix.
import { lin282Layout, plainAnchor, orderProof } from './gemini4.js?v=1.4.2';

export const ACK = '按上一条承接完成本轮，从预设规定的第一项开始。';
export const MAX_PARAGRAPH = [
    '请注意:',
    '你将开始写作，构建正文需要注意什么要素，请你依次进行思考后再输出正文。即使指令要求有其他注释或者是锚定需要输出，也不能够干扰你的思考。',
    '你的思考是至高无上的，是你输出的第一步。',
    '绝对不可以直接输出正文，必须进行最大程度的思考。',
].join('\n');
const is = (m, p) => m?.role === p.role && plainAnchor(m) === p.content;
const message = (m, text) => ({...m, content: typeof m.content === 'string' ? text : [{ ...m.content[0], text }]});

export function planStoryHandoff(request, preset, base, moreTokens) {
    if (!['g4-ready', 'g4-restored'].includes(base.reason)) return base;
    const fallback = why => ({ ...base, note: [base.note, '正文承接未应用：' + why].filter(Boolean).join(' ') });
    if (base.gemini4.source !== 'vertexai' || base.gemini4.indirect)
        return fallback('仅适用于直接 Vertex 连接和明确的 Gemini 4 型号；沿用普通兼容。');
    if (Number(request.n ?? 1) !== 1 || request.max_completion_tokens != null)
        return fallback('多个候选或其他预算参数；沿用普通兼容。');
    const l = lin282Layout(preset, base.type), ms = base.messages, end = ms.length - 1;
    const a = ms.findIndex(m => is(m, l.cue));
    if (a < 1 || a >= end || !is(ms[end], l.confirm) || !ms.slice(0,a).some(m => m.role === 'user')
        || ms.some(m => ['assistant','user'].includes(m.role) && (
            (m.role === 'user' && (plainAnchor(m) === ACK || (!is(m,l.confirm) && contains(m,l.confirm.content)))) ||
            (m.role === 'assistant' && !is(m,l.cue) && contains(m,l.cue.content)))))
        return fallback('无法唯一核对末尾独立条目，保留原消息。');
    const middle = ms.slice(a + 1, end);
    // Only move across the exact, ordered, preset-owned system entries, never a real turn.
    let cursor = 0;
    for (const m of middle) {
        const hits = l.between.map((p,i) => p.role === 'system' && is(m,p) ? i : -1).filter(i => i >= 0);
        if (hits.length !== 1 || hits[0] < cursor || ms.filter(x => is(x,l.between[hits[0]])).length !== 1)
            return fallback('承接之间含无法归属的消息，保留原顺序。');
        cursor = hits[0] + 1;
    }
    const original = l.confirm.content, newline = original.includes('\r\n') ? '\r\n' : '\n';
    const block = newline + newline + MAX_PARAGRAPH.replaceAll('\n',newline) + newline + newline;
    if (original.split(block).length !== 2) return fallback('未找到唯一的原版最大思考段，保留已编辑条目。');
    const rest = original.replace(block,newline + newline);
    if (ms.some(m => m.role === 'user' && plainAnchor(m) === rest)) return fallback('规则文本重复。');
    const rules = message(ms[end],rest), confirm = {role:'user',content:ACK};
    const messages = [...ms.slice(0,a), ...middle, rules, ms[a], confirm];
    const orderWitness = {cue:base.orderWitness.cue, confirm, rules:{role:'user',content:rest}};
    if (orderProof(messages,orderWitness) !== 'cue-before-user') return fallback('最终顺序无法核对。');
    const cap = moreTokens === true && request.max_tokens === 16384 ? {before:16384,after:32768} : null;
    return {...base, reason:'g4-handoff', changed:true, applied:true, messages, injected:[confirm], orderWitness,
        tailRoles:['assistant','user'], netChars: rest.length + ACK.length - original.length,
        handoff:{shortConfirmation:true, removedMaxDemand:true, cap, restored:base.reason==='g4-restored'}};
}
function contains(m,s) {
    return typeof m.content === 'string' ? m.content.includes(s) :
        Array.isArray(m.content) && m.content.some(b => typeof b?.text === 'string' && b.text.includes(s));
}
