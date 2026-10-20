import { getLinState, normalizeSettings, plainText, VERSION } from './core.js?v=1.2.2';
import { deliveryProfile } from './delivery.js?v=1.2.2';
import { structureDiagnosis } from './structure.js?v=1.2.2';

export const HISTORY_KEY = 'lin_prefill_guard_history_v2';
export const HISTORY_LIMIT = 50;

/** Only the extension's own text and allowlisted metadata enter persistent history. */
export function createHistory(getStorage = () => null) {
    let records = [];
    let warning = '';
    const copy = value => JSON.parse(JSON.stringify(value));
    function load() {
        try {
            const value = JSON.parse(getStorage()?.getItem(HISTORY_KEY) || '[]');
            if (Array.isArray(value)) {
                const existing = new Set(records.map(r => r.id));
                records.push(...value.filter(r => r && typeof r.id === 'string' && !existing.has(r.id)));
                records = records.slice(0, HISTORY_LIMIT);
            }
        } catch { warning = '历史记录读取失败；本次仍可在内存中记录。'; }
    }
    function persist() {
        try {
            const storage = getStorage();
            if (!storage) { warning = '当前分支没有账户存储，记录只保留在当前页面。'; return; }
            storage.setItem(HISTORY_KEY, JSON.stringify(records));
            warning = '';
        } catch { warning = '记录保存失败（可能空间不足）；本页记录仍可复制和导出。'; }
    }
    load();
    return {
        load,
        list: () => copy(records),
        warning: () => warning,
        put(record) {
            records = [copy(record), ...records.filter(r => r.id !== record.id)].slice(0, HISTORY_LIMIT);
            persist();
        },
        patch(id, patch) {
            const record = records.find(r => r.id === id);
            if (record) { Object.assign(record, copy(patch)); persist(); }
        },
        clear() { records = []; persist(); },
    };
}

export function requestMeta(request = {}) {
    return {
        model: String(request.model || '').slice(0, 160),
        source: String(request.chat_completion_source || '').slice(0, 60),
        type: typeof request.type === 'string' && request.type ? request.type : 'normal',
        stream: !!request.stream,
        maxTokens: Number.isFinite(Number(request.max_tokens)) ? Number(request.max_tokens) : null,
        reasoningEffort: String(request.reasoning_effort || 'auto').slice(0, 30),
        webSearch: request.enable_web_search === true,
        messageCount: request.messages?.length || 0,
        tailRoles: Array.isArray(request.messages) ? request.messages.slice(-6).map(m => String(m?.role || '')) : [],
    };
}

/** Non-cryptographic local correlation only; never a security or content-integrity claim. */
export function requestKey(request) {
    const value = JSON.stringify([request.type || 'normal', request.model, request.messages]);
    let hash = 2166136261;
    for (let i = 0; i < value.length; i++) hash = Math.imul(hash ^ value.charCodeAt(i), 16777619);
    return `${value.length}:${hash >>> 0}`;
}

export function captureInjection(messages, injected = []) {
    const result = [];
    if (!Array.isArray(messages)) return result;
    for (let index = 0; index < messages.length; index++) {
        const m = messages[index];
        const text = plainText(m);
        if (typeof text !== 'string') continue;
        for (const x of injected) {
            if (x.role !== m?.role || !x.content) continue;
            // Verify only our complete cue. Never persist the surrounding chat,
            // and never use this read-only segment match to delete a message.
            let from = 0;
            let start;
            while ((start = text.indexOf(x.content, from)) >= 0) {
                const end = start + x.content.length;
                if ((start === 0 || text[start - 1] === '\n') && (end === text.length || text[end] === '\n')) {
                    result.push({ index, role: m.role, content: x.content,
                        match: start === 0 && end === text.length ? 'exact' : 'segment', atEnd: !text.slice(end).trim() });
                }
                from = end;
            }
        }
    }
    return result;
}

export function auditPreset(preset = {}, request = {}) {
    const notes = [];
    const effort = request.reasoning_effort || preset.reasoning_effort;
    const limit = request.max_tokens ?? preset.openai_max_tokens;
    if (['max', 'high', 'xhigh'].includes(effort)) notes.push(`思考强度为 ${effort}，输出上限 ${limit || '未提供'}；若只有思考没有正文，先检查返回的结束原因与思考用量。`);
    const orders = preset.prompt_order?.find(o => String(o.character_id) === '100001')?.order || [];
    const active = (preset.prompts || []).filter(p => orders.some(o => o.identifier === p.identifier && o.enabled));
    const size = active.reduce((n, p) => n + (p.content?.length || 0), 0);
    if (size > 20000) notes.push(`输入侧固定提示约 ${size} 字符（不含世界书与聊天），这是发送给模型的提示词长度，不是模型输出或正文长度。`);
    if (active.some(p => /绝对不可以直接输出正文|必须进行最大程度的思考/.test(p.content || ''))) notes.push('尾部含强制最大思考要求；可与高思考参数叠加，且文字提示不能保证给正文预留 token。');
    if (preset.enable_web_search === true) notes.push('预设开启网页搜索；无联网需要时可关闭，减少工具及渠道兼容变量。');
    if (Number(preset.openai_max_context) > 1048576) notes.push('本地上下文设置超过 1M；实际可用窗口取决于接口及真实模型，不能从渠道别名推断。本地设置不会扩大服务商窗口。');
    if (request.chat_completion_source === 'custom') notes.push('当前为自定义接口；模型别名不能证明后端型号或参数支持范围。请以渠道实际响应为准。');
    const lin = getLinState(preset);
    if (!lin.known) notes.push('未识别到 Lin 承接条目；请核对当前实际加载的预设。');
    else if (lin.active === false) notes.push('Lin 承接条目已关闭。');
    const profile = deliveryProfile(preset, request.type || 'normal');
    if (profile.known && profile.cotEnabled) notes.push('Lin2.6启用了前置Lin_CoT注释；注释文本会消耗生成预算，旧版“正文字符数”包含这类文本，不能据此认定已有正文。');
    if (profile.known && profile.cotEnabled && !profile.sceneEnabled) notes.push('可选场景条目关闭：其专属阶段和停笔条件不应通过CoT被重新启用。');
    const stops = Array.isArray(request.stop) ? request.stop : typeof request.stop === 'string' ? [request.stop] : [];
    if (stops.some(x => typeof x === 'string' && /-->|<\/(?:content|Lin_\w+)>/.test(x))) notes.push('停止序列包含注释或组件结束标记，可能在正文前或组件中结束生成；插件只提示，不擅自删除自定义停止序列。');
    return notes;
}

/** Opt-in, request-only adjustment, limited to known Gemini families. */
export function planReasoning(request, settings) {
    if (normalizeSettings(settings).reasoningMode !== 'balanced') return null;
    if (!['max', 'high', 'xhigh'].includes(request.reasoning_effort)) return null;
    const model = String(request.model || '').toLowerCase();
    let value;
    const name = model.split('/').at(-1);
    // Image/TTS and unknown aliases may support different levels. Do not guess.
    if (/(?:^|[-_.])(?:image|tts)(?:[-_.]|$)/.test(name)) return null;
    if (/^gemini-3-pro(?:-|$)/.test(name)) value = 'low';
    else if (/^gemini-(?:2\.5-(?:pro|flash(?:-lite)?)|3\.1-pro|3(?:\.[568])?-flash(?:-lite)?|4-argon)(?:-|$)/.test(name)) value = 'medium';
    if (!value) return null;
    return { before: request.reasoning_effort, after: value };
}

export function responseDiagnosis(stats = {}) {
    if (stats.aborted) return '请求已中止；不据此判断模型空回。';
    if (stats.networkError) return '网络请求失败；没有取得可分析的响应。';
    if (stats.httpStatus >= 400 || stats.apiError) return `接口错误${stats.httpStatus ? `（HTTP ${stats.httpStatus}）` : ''}；查看酒馆原错误提示。`;
    if (stats.blockReason || /SAFETY|PROHIBITED|BLOCKLIST|RECITATION|CONTENT_FILTER/i.test(stats.finishReason || '')) return `接口报告拦截或限制：${stats.blockReason || stats.finishReason}。`;
    if (stats.refusal && !stats.visibleChars) return '接口返回了拒绝字段，未检测到正文；这与没有返回数据不同。';
    const structural = structureDiagnosis(stats.output);
    if (stats.output?.onlyNotes) return `接口文本字段 ${stats.visibleChars || 0} 字符，其中Lin_CoT ${stats.output.cotChars} 字符；${structural}。${/^(?:STOP|END_TURN)$/i.test(stats.finishReason || '') ? '渠道报告STOP/正常结束，但这不等于正文已交付。' : /MAX_TOKENS|LENGTH/i.test(stats.finishReason || '') ? '渠道同时报告输出上限；思考/注释阶段可能已耗尽预算。' : '还需结合结束原因判断提前停写或传输中断。'}`;
    if (structural) return `接口文本字段 ${stats.visibleChars || 0} 字符；${structural}。${stats.finishReason ? `结束原因：${stats.finishReason}。` : '渠道未提供结束原因。'}`;
    if (stats.missingTerminal) return `流式读取已结束，但缺少结束原因和结束标志；已识别文本 ${stats.visibleChars || 0} 字符，可能中途断流，不能确认完整交付。${stats.streamMessageEnvelope ? 'SSE使用message而非delta字段，需检查渠道适配。' : ''}${stats.parseErrors ? '存在解析错误，取证不完整。' : ''}`;
    if (stats.captureLimited && stats.visibleChars > 0) return `已识别部分文本 ${stats.visibleChars} 字符，但取证不完整（${stats.limitReason === 'read-error' ? '读取中断' : '受限或被停止'}），不能确认回复完整。`;
    if (stats.protocolMismatch) return `请求与响应协议不一致：${stats.protocolMismatch === 'stream-request-non-sse' ? '请求流式，却收到 JSON / NDJSON；可先在酒馆原生设置关闭流式再重试' : '请求 JSON，却收到 SSE；检查渠道协议'}。已识别正文 ${stats.visibleChars || 0} 字符，不能据此认定模型空回。`;
    if (stats.streamMessageEnvelope) return `SSE 帧使用 message 而非 delta 字段；检测到正文 ${stats.visibleChars || 0} 字符，需检查渠道流式格式，或在酒馆关闭流式后排查。`;
    if (stats.visibleChars > 0) return `接口文本字段 ${stats.visibleChars} 字符${stats.output?.commentChars ? `（注释 ${stats.output.commentChars}；注释外 ${stats.output.nonCommentChars}）` : ''}${/MAX_TOKENS|LENGTH/i.test(stats.finishReason || '') ? '，但达到输出上限，可能截断' : ''}${stats.captureLimited || stats.parseErrors ? '；取证不完整，该数值仅包含已识别部分' : ''}；文本长度不等于故事正文已完整交付。`;
    if (stats.captureLimited) return `取证未完成（${stats.limitReason === 'read-error' ? '读取中断' : '容量、时间限制或观察被停止'}）；尚不能据此判断空回。`;
    if (stats.responseComplete && stats.receivedBytes === 0) return 'HTTP 响应体为零字节；没有取得模型正文或结束原因。';
    if (stats.parseErrors || !stats.recognized) return '响应格式未完整识别；请查看酒馆原错误提示或渠道日志。';
    if (/MAX_TOKENS|LENGTH/i.test(stats.finishReason || '') || stats.incomplete) return '达到输出预算或返回不完整，未检测到正文；可能在思考阶段耗尽预算。';
    if (stats.toolCalls) return '接口返回工具调用，未检测到正文；请检查工具后续流程。';
    if (stats.reasoningChars > 0 || stats.thoughtTokens > 0) return '接口只有思考内容或思考用量，没有检测到正文。';
    return '接口没有返回可识别正文；仅凭空内容无法确定原因。';
}

/** Keep saved-text evidence visible even when a later clone inspection finishes. */
export function recordDiagnosis(record = {}) {
    const lines = [];
    if (record.rendered) lines.push(record.rendered.chars > 0
        ? `酒馆已保存 ${record.rendered.chars} 字符原始文本${record.rendered.output ? `；Lin_CoT注释 ${record.rendered.output.cotChars} 字符；注释外文本 ${record.rendered.output.nonCommentChars} 字符` : '（旧记录未区分注释）'}。${structureDiagnosis(record.rendered.output) || '显示效果仍取决于正则与样式，不能仅由字符数确认正文完整。'}`
        : `酒馆保存的正文为空${record.rendered.reasoningChars ? '，有思考内容' : ''}。`);
    if (record.wire) lines.push(responseDiagnosis(record.wire));
    else if (record.lifecycle) lines.push(record.lifecycle);
    return lines.join('\n');
}

export function formatRecord(record) {
    if (!record) return '尚无记录。正常发送一条消息后可在这里查询。';
    const lines = [`记录 ${record.id} · v${record.version || VERSION}`, `时间：${record.at}`, `类型：${record.type} · 模型：${record.request?.model || '未提供'}`, `组装：${record.explanation}`, `发送：${record.dispatch?.label || '未观察到浏览器发送，或未开启网络取证'}`];
    if (record.adjustment) lines.push(`本次思考参数：${record.adjustment.before} → ${record.adjustment.after}`);
    if (record.identification) lines.push(`条目识别：${record.identification}`);
    if (record.deliveryProfile?.known) lines.push(`Lin2.6交付约束：${record.deliveryGuard ? '已加入本次请求' : '未加入'}；启用组件：${record.deliveryProfile.components.join('、') || '无'}；输入提示词 ${record.deliveryProfile.inputPromptChars} 字符（不是输出）。`);
    if (record.presetState) lines.push(`设置快照：${record.presetState.promptCount} 条提示；识别=${record.presetState.known}；开关=${record.presetState.active ?? '未知'}`);
    if (record.wire) lines.push(`接口：${responseDiagnosis(record.wire)}`, `结束原因：${record.wire.finishReason || record.wire.blockReason || '渠道未提供'}`, `思考 token：${record.wire.thoughtTokens ?? '渠道未提供'} · 生成 token（渠道口径，可能含思考）：${record.wire.outputTokens ?? '渠道未提供'}`);
    if (record.wire?.transport) lines.push(`响应格式：${record.wire.transport}；Content-Type：${record.wire.contentType}；字节：${record.wire.receivedBytes}；SSE 帧：${record.wire.frames}；DONE：${record.wire.doneMarker ? '有' : '无'}；读取完成：${record.wire.responseComplete ? '是' : '否'}；解析错误：${record.wire.parseErrors}；取证耗时：${record.wire.durationMs ?? 0} ms`);
    if (record.possibleAssemblyIds?.length) lines.push(`邻近组装记录（仅候选，未证实同一请求）：${record.possibleAssemblyIds.join('、')}`);
    if (record.rendered) lines.push(`酒馆保存原始文本：${record.rendered.chars} 字符；原生思考字段：${record.rendered.reasoningChars} 字符（原生思考为0不排除文本内含Lin_CoT）。`, recordDiagnosis({ rendered: record.rendered }));
    if (record.lifecycle) lines.push(record.lifecycle);
    lines.push('', '—— 请求组装时的注入文本 ——');
    for (const m of record.injected || []) lines.push(`[${m.role}]\n${m.content}`);
    lines.push('', '—— 浏览器发送时核对到的注入文本 ——');
    if (record.dispatch) {
        for (const m of record.dispatch.injected || []) lines.push(`messages[${m.index}] · ${m.role}\n${m.content}`);
        if (!record.dispatch.injected?.length) lines.push('没有核对到原注入文本。');
    } else lines.push('无发送层记录。');
    if (record.warnings?.length) lines.push('', '—— 预设自查 ——', ...record.warnings);
    lines.push('', '发送层记录位于浏览器到酒馆后端的边界。后端、其他拦截器和中转仍可能转换请求；不等于模型必定执行。');
    return lines.join('\n\n');
}
