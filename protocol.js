// Protocol data comes from the selected preset. Display names never establish ownership.
export const LIN_PROMPT_ID = 'e898d676-f02e-4868-bc51-33761e294df6';
export const LIN_CONFIRM_ID = '68186c40-6f11-4c47-a036-58497d1d6795';
export const NPC291 = 'b62baac5-e695-5ce5-899b-edc7989babc8';
const CLOSURE_ID = '99dd9277-7d27-40fb-972f-a009ae4983e9';
export const PROTOCOL_NAMES = { pair: 'Lin 独立双尾承接', ordered: 'Lin 有序承接', unknown: '未确认承接协议' };
export const MAX_PARAGRAPH = [
    '请注意:',
    '你将开始写作，构建正文需要注意什么要素，请你依次进行思考后再输出正文。即使指令要求有其他注释或者是锚定需要输出，也不能够干扰你的思考。',
    '你的思考是至高无上的，是你输出的第一步。',
    '绝对不可以直接输出正文，必须进行最大程度的思考。',
].join('\n');

export function maxParagraphBlock(content) {
    const newline = content.includes('\r\n') ? '\r\n' : '\n';
    return newline + newline + MAX_PARAGRAPH.replaceAll('\n',newline) + newline + newline;
}

const list = v => Array.isArray(v) ? v : [];
const relative = p => p.injection_position == null || p.injection_position === 0;
const eligible = (p, type) => p.injection_trigger == null || (Array.isArray(p.injection_trigger) &&
    (!p.injection_trigger.length || p.injection_trigger.includes(type)));
const matches = (rows, id) => rows.filter(p => p?.identifier === id);
function flag(order, id) {
    const hits = matches(order, id);
    return hits.length === 1 && typeof hits[0].enabled === 'boolean' ? hits[0].enabled : null;
}

export function inspectProtocol(preset = {}, type = 'normal', activeId = null) {
    const prompts = list(preset?.prompts), groups = list(preset?.prompt_order);
    const cues = matches(prompts, LIN_PROMPT_ID), confirmations = matches(prompts, LIN_CONFIRM_ID);
    // Older single-cue installations still have an explicitly selected enhancement mode.
    const candidate = confirmations.length > 0 || groups.some(g => matches(list(g?.order), LIN_CONFIRM_ID).length);
    const meta = {order:null, cueEnabled:null, confirmEnabled:null, npcEnabled:null};
    const fail = (reason, detail) => ({candidate, kind:'unknown', reason, detail, meta});
    for (const [rows, role, label] of [[cues,'assistant','承接'], [confirmations,'user','确认']]) {
        if (rows.length !== 1) return fail('g291-anchors', label + (rows.length ? '定义重复。' : '定义缺失。'));
        const p = rows[0];
        if (p.role !== role) return fail('g291-anchors', label + '角色应为 ' + role + '。');
        if (p.marker) return fail('g291-anchors', label + '配置为占位符，缺少独立文本定义。');
        if (!relative(p)) return fail('g291-anchors', label + '采用深度或附着注入，未配置为相对位置。');
        if (typeof p.content !== 'string' || !p.content.trim()) return fail('g291-anchors', label + '定义缺少非空文本。');
    }
    const [cue] = cues, [confirm] = confirmations;
    if (cue.content === confirm.content) return fail('g291-anchors','承接和确认使用了同一段文字。');
    if (activeId != null && !['string','number'].includes(typeof activeId))
        return fail('g291-order','宿主报告的提示顺序组无效。');
    const selected = activeId == null ? groups : groups.filter(g => String(g?.character_id) === String(activeId));
    if (!selected.length) return fail('g291-order',activeId == null ? '缺少提示顺序组。' : '当前提示顺序组不存在。');
    if (selected.some(g => !g || g.character_id == null || !Array.isArray(g.order)) ||
        new Set(selected.map(g => String(g.character_id))).size !== selected.length)
        return fail('g291-order','提示顺序组重复或结构不完整。');

    meta.order = selected.length === 1 ? String(selected[0].character_id) : 'consensus';
    const commonFlag = id => {
        const flags = selected.map(g => flag(g.order, id));
        return flags.every(v => v === flags[0]) ? flags[0] : null;
    };
    meta.cueEnabled = commonFlag(LIN_PROMPT_ID);
    meta.confirmEnabled = commonFlag(LIN_CONFIRM_ID);
    meta.npcEnabled = commonFlag(NPC291);
    if (matches(prompts, CLOSURE_ID).length === 1) meta.closureEnabled = commonFlag(CLOSURE_ID);
    const lines = confirm.content.trim().split(/\r\n|[\r\n]/).map(line => line.trim());
    const open = lines.indexOf('<final_output_directive>');
    const directive = open >= 0 && lines.lastIndexOf('<final_output_directive>') === open &&
        lines.at(-1) === '</final_output_directive>' && lines.indexOf('</final_output_directive>') === lines.length - 1 &&
        lines.slice(open + 1,-1).some(Boolean);
    const authored = lines.includes('【生成交接】') || directive;
    if (authored) meta.authoredHandoff = true;
    for (const [id,label,enabled] of [[LIN_PROMPT_ID,'承接',meta.cueEnabled],[LIN_CONFIRM_ID,'确认',meta.confirmEnabled]]) {
        for (const {order} of selected) {
            const rows = matches(order,id);
            if (rows.length !== 1) return fail('g291-order',label + (rows.length ? '顺序项重复。' : '顺序项缺失。'));
            if (typeof rows[0].enabled !== 'boolean') return fail('g291-order',label + '顺序项的开关无效。');
        }
        if (enabled == null) return fail('g291-order',label + '开关在各组不一致。');
        if (!enabled) return fail('g4-disabled',label + '在所选顺序中已关闭。');
    }
    if (!eligible(cue, type) || !eligible(confirm, type))
        return fail('trigger-excluded','承接或确认的生成类型限制与本次请求不匹配。');

    // Only the bounded, preset-authored paragraph participates in the old optional edit.
    const classicTail = !authored && confirm.content.includes(maxParagraphBlock(confirm.content));
    let reference;
    for (const {order} of selected) {
        const ci = order.findIndex(e => e?.identifier === LIN_PROMPT_ID);
        const ui = order.findIndex(e => e?.identifier === LIN_CONFIRM_ID);
        if (ci >= ui) return fail('g291-order','配置中 user 确认排在 assistant 承接之前。');
        const between = [], after = [];
        for (let i = ci + 1; i < order.length; i++) {
            const e = order[i];
            if (i === ui || e?.enabled === false) continue;
            const found = matches(prompts, e?.identifier);
            if (e?.enabled !== true || !e.identifier || found.length !== 1 || matches(order,e.identifier).length !== 1)
                return fail('g291-other-tail','承接之后有启用状态或定义不明确的条目。');
            const p = found[0];
            if (!relative(p) || !eligible(p,type)) continue;
            if (p.content == null || p.content === '') continue; // A populated host placeholder is checked on the wire.
            if (typeof p.content !== 'string') return fail('g291-other-tail','尾部条目内容类型无效。');
            if (!p.content.trim()) continue;
            if (authored || p.role !== 'system' || p.marker)
                return fail('g291-other-tail','承接之后出现与该布局不符的启用条目。');
            (i < ui ? between : after).push(p);
        }
        // Some old presets use the explicit maximum-thinking contract with an empty middle slot.
        const kind = !authored && (between.length > 0 || classicTail) ? 'ordered' : 'pair';
        if (kind === 'pair' && after.length) return fail('g291-other-tail','独立双尾协议要求 user 确认为最后一条。');
        const same = (a,b) => a.length === b.length && a.every((v,i) => v === b[i]);
        if (reference && (reference.kind !== kind || !same(between,reference.between) || !same(after,reference.after)))
            return fail('g291-order','未取得活动组，候选组的承接布局不一致。');
        reference = {kind, between, after};
    }
    return {candidate:true, ...reference, cue, confirm, meta};
}

const onlyKeys = (value, allowed) => value && typeof value === 'object' && Object.keys(value).every(k => allowed.includes(k));
export function directGoogle4(target) {
    return !!target && !target.indirect && ['makersuite','vertexai'].includes(target.source) &&
        ['gemini-4-carbon','gemini-4-argon'].includes(target.model);
}

export function requestRisk(r, preset, target) {
    const prefix = v => typeof v === 'string' && !!v.trim();
    if (prefix(r.assistant_prefill) || r.messages.some(m => m.prefix === true))
        return directGoogle4(target) ? 'g291-unsupported-prefix' : 'native-prefill';
    if (!directGoogle4(target) && prefix(preset.assistant_prefill)) return 'native-prefill';
    if (r.json_schema || (r.response_format != null && r.response_format.type !== 'text') ||
        r.generationConfig?.responseSchema || r.generationConfig?.responseJsonSchema ||
        (r.generationConfig?.responseMimeType && r.generationConfig.responseMimeType !== 'text/plain')) return 'structured';
    if ([r.tools,r.functions,r.mcp_servers].some(v => v != null && (!Array.isArray(v) || v.length)) ||
        (r.tool_choice != null && r.tool_choice !== 'none') || (r.function_call != null && r.function_call !== 'none') ||
        r.messages.some(m => !['system','developer','user','assistant'].includes(m.role) ||
            m.tool_calls?.length || m.function_call || m.tool_call_id)) return 'tools';
    if (r.contents != null || r.input != null) return 'parallel-input';
    if ([r.n,r.generationConfig?.candidateCount].some(n => n != null && n !== 1)) return 'multiple-candidates';
    if ([r.continuationToken,r.continuation_token,r.cachedContent,r.cached_content].some(value => value != null)) return 'continuation-or-cache';
    if (r.messages.some(m => !onlyKeys(m,['role','content','name']) || !(typeof m.content === 'string' ||
        (Array.isArray(m.content) && m.content.length && m.content.every(b => b?.type === 'text' &&
            typeof b.text === 'string' && onlyKeys(b,['type','text'])))))) return 'g291-protected';
    return null;
}

// Text is joined for detecting an embedded quotation only. Matching anchors must still be independent.
export const containsText = (m, value) => (typeof m.content === 'string' ? m.content :
    list(m.content).map(b => b?.text ?? '').join('')).includes(value);
