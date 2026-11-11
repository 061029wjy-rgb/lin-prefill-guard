// Gemini 4 input compatibility. No provider credentials, generation or chat writes.
export const LIN_PROMPT_ID = 'e898d676-f02e-4868-bc51-33761e294df6';
export const LIN_CONFIRM_ID = '68186c40-6f11-4c47-a036-58497d1d6795';
const EVENT_ID = '2517270f-119f-4c44-aa89-87e53cf5f40c';
const RELATIVE = p => p && (p.injection_position == null || p.injection_position === 0);

export function gemini4Target(request = {}) {
    const source = request.chat_completion_source;
    if (!['makersuite', 'vertexai', 'custom'].includes(source)) return null;
    const model = String(request.model || '').trim().toLowerCase();
    // Match the two explicit IDs, including channel labels and their /fc and /vs variants.
    const match = /(?:^|[-/:\s])gemini[-_ ]?4[-_ ]?(argon|carbon)(?:\/(?:fc|vs))?$/.exec(model);
    if (!match || (model.match(/gemini[-_ ]?4/gi) || []).length !== 1) return null;
    return { model: 'gemini-4-' + match[1], source,
        indirect: source === 'custom' || !!request.reverse_proxy || model !== 'gemini-4-' + match[1] };
}

// A version hint only, never used as equality or provenance for modifying a message.
function fingerprint(s) {
    if (typeof s !== 'string') return '';
    s = s.replace(/\r\n/g, '\n');
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
    return s.length + ':' + (h >>> 0).toString(16);
}

export function lin282Layout(preset = {}, type = 'normal') {
    const ps = Array.isArray(preset.prompts) ? preset.prompts : [];
    const groups = (Array.isArray(preset.prompt_order) ? preset.prompt_order : []).filter(x => String(x?.character_id) === '100001');
    const order = groups.length === 1 && Array.isArray(groups[0].order) ? groups[0].order : [];
    const one = id => { const found = ps.filter(p => p?.identifier === id); return found.length === 1 ? found[0] : null; };
    const cue = one(LIN_PROMPT_ID), confirm = one(LIN_CONFIRM_ID);
    if (!RELATIVE(cue) || !RELATIVE(confirm) || cue.role !== 'assistant' || confirm.role !== 'user'
        || !cue.content?.trim?.() || !confirm.content?.trim?.()) return { reason: 'g4-not-lin282' };
    const versions = [preset.name, preset.preset_settings_openai].flatMap(s =>
        typeof s === 'string' ? Array.from(s.matchAll(/lin\s*[-_v]?\s*(\d+\.\d+(?:\.\d+)?)(?![\d.])/gi), m => m[1]) : []);
    if (versions.length ? versions.some(v => v !== '2.8.2')
        : fingerprint(confirm.content) !== '1332:9713939c' || fingerprint(one(EVENT_ID)?.content) !== '735:8795e2c7')
        return { reason: 'g4-not-lin282' };
    const ci = order.findIndex(e => e?.identifier === LIN_PROMPT_ID);
    const ui = order.findIndex(e => e?.identifier === LIN_CONFIRM_ID);
    const enabled = p => order.filter(e => e?.identifier === p.identifier).length === 1
        && order.find(e => e?.identifier === p.identifier)?.enabled === true;
    if (ci < 0 || ui < 0) return { reason: 'g4-uncertain' };
    if (!enabled(cue) || !enabled(confirm)) return { reason: 'g4-disabled' };
    if (ci >= ui) return { reason: 'g4-uncertain' };
    const relevant = p => !p.injection_trigger?.length || (Array.isArray(p.injection_trigger) && p.injection_trigger.includes(type));
    if (!relevant(cue) || !relevant(confirm)) return { reason: 'trigger-excluded' };
    const prompts = portion => portion.filter(e => e?.enabled === true).map(e => one(e.identifier))
        .filter(p => RELATIVE(p) && relevant(p) && typeof p.content === 'string' && p.content.trim());
    return { cue, confirm, between: prompts(order.slice(ci + 1, ui)), after: prompts(order.slice(ui + 1)) };
}

// Only plain, independent messages can establish an anchor. A role, marker or
// substring in a player message is not an anchor. Leave additional metadata intact.
function simpleText(m) {
    if (!m || Object.keys(m).some(k => !['role','content'].includes(k))) return null;
    if (typeof m.content === 'string') return m.content;
    const b = Array.isArray(m.content) && m.content.length === 1 && m.content[0];
    return b?.type === 'text' && typeof b.text === 'string' && Object.keys(b).every(k => k === 'type' || k === 'text') ? b.text : null;
}
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
    return a[0] < u[0] ? 'cue-before-user' : 'out-of-order';
}
function toolHistory(messages) {
    return messages.some(m => m.role === 'tool' || m.role === 'function' || m.tool_calls?.length || m.tool_call_id
        || m.function_call || (Array.isArray(m.content) && m.content.some(b => b && ['tool_use','tool_result','function_call','function_call_output'].includes(b.type))));
}

export function planGemini4(request, preset, type, skipReason) {
    const old = request.messages;
    const target = gemini4Target(request);
    const finish = (reason, extra = {}) => ({ reason, type, applied: false, changed: false, messages: old,
        injected: [], netChars: 0, removedOriginal: false, tailRoles: old.slice(-2).map(m => m.role), ...extra });
    if (!target) return finish('g4-other');
    const layout = lin282Layout(preset, type);
    if (layout.reason) return finish(layout.reason);
    const base = { identification: 'Lin 2.8.2', gemini4: target,
        note: target.indirect ? '该连接是别名或中转；仅核对酒馆请求，不推断上游服务能力。' : '' };
    if (skipReason || type === 'continue') return finish(skipReason || 'g4-continue', base);
    if (toolHistory(old) || request.function_call && request.function_call !== 'none'
        || request.mcp_servers?.length) return finish('tools', base);
    const a = locate(old, layout.cue), u = locate(old, layout.confirm);
    if (a.length !== 1 || u.length !== 1) return finish('g4-uncertain', base);
    const proof = { cue: { role: 'assistant', content: layout.cue.content }, confirm: { role: 'user', content: layout.confirm.content } };
    const known = { ...base, orderWitness: proof };
    let last = old.length - 1;
    while (last >= 0 && simpleText(old[last])?.trim() === '') last--;
    if (a[0] < u[0]) {
        const tail = old[last];
        return finish(tail.role === 'assistant' ? 'g4-foreign-tail' : 'g4-ready', known);
    }
    // A repair is permitted only for a misplaced, standalone Lin cue at the
    // last nonempty turn. Never move an ordinary assistant answer or any other message.
    if (a[0] !== last || !old.slice(0, u[0]).some(m => m.role === 'user'))
        return finish('g4-uncertain', known);
    // If the current preset text also occurs inside a decorated or merged message,
    // attribution is ambiguous. Never split that message or move a copy from history.
    const ambiguous = [layout.cue, layout.confirm, ...layout.between, ...layout.after].some(p =>
        old.some(m => m.role === p.role && !equal(m, p) &&
            (typeof m.content === 'string' ? m.content.includes(p.content) :
                Array.isArray(m.content) && m.content.some(b => typeof b?.text === 'string' && b.text.includes(p.content)))));
    if (ambiguous) return finish('g4-uncertain', known);
    function positions(defs) {
        const out = [];
        for (const p of defs) {
            const hits = locate(old, p);
            if (hits.length > 1) return null;
            if (hits.length) out.push(hits[0]);
        }
        return out;
    }
    const between = positions(layout.between), after = positions(layout.after);
    // Optional entries absent on the wire are fine. If present, all must form
    // the exact observed suffix in preset order; do not move across other chat.
    if (!between || !after || !between.every((n,i) => n === u[0] - between.length + i)
        || !after.every((n,i) => n === u[0] + 1 + i) || a[0] !== u[0] + 1 + after.length)
        return finish('g4-uncertain', known);
    const start = u[0] - between.length;
    const messages = [...old.slice(0, start), old[a[0]], ...old.slice(start, a[0]), ...old.slice(a[0] + 1)];
    return finish('g4-restored', { ...known, messages, applied: true, changed: true,
        tailRoles: messages.slice(-2).map(m => m.role) });
}

export function isGemini4Segment(r) {
    // Protocol evidence also applies in observe/enhance modes and older records.
    const request = r?.dispatch?.request || r?.request;
    const target = r?.gemini4 || gemini4Target({ model: request?.model, chat_completion_source: request?.source });
    return !!target && String(r?.wire?.finishReason || '').toUpperCase() === 'CONTINUATION';
}
