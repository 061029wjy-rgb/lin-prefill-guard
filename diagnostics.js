import { isGemini4Segment } from './gemini4.js?v=1.2.9';
import { getLinState, normalizeSettings, plainText, VERSION } from './core.js?v=1.2.9';
import { deliveryProfile } from './delivery.js?v=1.2.9';
import { structureDiagnosis, endingDiagnosis, replySignalDiagnosis } from './structure.js?v=1.2.9';

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
    const stopCount = value => typeof value === 'string' ? Number(!!value.length)
        : Array.isArray(value) ? value.filter(x => typeof x === 'string' && x.length).length : 0;
    return {
        model: String(request.model || '').slice(0, 160),
        source: String(request.chat_completion_source || '').slice(0, 60),
        type: typeof request.type === 'string' && request.type ? request.type : 'normal',
        stream: !!request.stream,
        maxTokens: Number.isFinite(Number(request.max_tokens)) ? Number(request.max_tokens) : null,
        maxCompletionTokens: request.max_completion_tokens != null && Number.isFinite(Number(request.max_completion_tokens))
            ? Number(request.max_completion_tokens) : null,
        stopCounts: { stop: stopCount(request.stop), stopSequences: stopCount(request.stopSequences),
            generationConfig: stopCount(request.generationConfig?.stopSequences) },
        reasoningEffort: String(request.reasoning_effort || 'auto').slice(0, 30),
        webSearch: request.enable_web_search === true,
        messageCount: request.messages?.length || 0,
        inputTextChars: Array.isArray(request.messages) ? request.messages.reduce((n, m) => n + (typeof m?.content === 'string'
            ? m.content.length : Array.isArray(m?.content) ? m.content.reduce((a, p) => a + (typeof p?.text === 'string' ? p.text.length : 0), 0) : 0), 0) : 0,
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

export function auditPreset(preset = {}, request = {}, settings = {}) {
    const notes = [];
    const effort = request.reasoning_effort || preset.reasoning_effort;
    const limit = request.max_tokens ?? preset.openai_max_tokens;
    if (['max', 'high', 'xhigh'].includes(effort)) notes.push(`思考强度为 ${effort}，输出上限 ${limit || '未提供'}；若只有思考没有正文，先检查返回的结束原因与思考用量。`);
    const orders = preset.prompt_order?.find(o => String(o.character_id) === '100001')?.order || [];
    const active = (preset.prompts || []).filter(p => orders.some(o => o.identifier === p.identifier && o.enabled));
    const size = active.reduce((n, p) => n + (p.content?.length || 0), 0);
    if (size > 20000) notes.push(`输入侧固定提示约 ${size} 字符（不含世界书与聊天），这是发送给模型的提示词长度，不是模型输出或正文长度。`);
    if (active.some(p => /绝对不可以直接输出正文|必须进行最大程度的思考/.test(p.content || ''))) notes.push('尾部含强制最大思考要求；可与高思考参数叠加，且文字提示不能保证给正文预留 token。');
    if (active.some(p => /【Lin_CoT模式与交付】/.test(p.content || '') && /【断点续传】/.test(p.content || ''))) {
        notes.push(normalizeSettings(settings).requestMode === 'enhance'
            ? '预设已含CoT交付与断点续传规则；当前增强模式仍会替换原承接条目并追加提示，存在重复干预。可切换原样诊断保留预设原顺序与原文。'
            : '预设已含CoT交付与断点续传规则，当前模式不另加交付提示。预设中的“续传”文字不等于服务商的解码凭据。');
    }
    if (preset.enable_web_search === true) notes.push('预设开启网页搜索；无联网需要时可关闭，减少工具及渠道兼容变量。');
    if (Number(preset.openai_max_context) > 1048576) notes.push('本地上下文设置超过 1M；实际可用窗口取决于接口及真实模型，不能从渠道别名推断。本地设置不会扩大服务商窗口。');
    if (request.chat_completion_source === 'custom') notes.push('当前为自定义接口；模型别名不能证明后端型号或参数支持范围。请以渠道实际响应为准。');
    const lin = getLinState(preset);
    if (!lin.known) notes.push('未识别到 Lin 承接条目；请核对当前实际加载的预设。');
    else if (lin.active === false) notes.push('Lin 承接条目已关闭。');
    const profile = deliveryProfile(preset, request.type || 'normal');
    if (profile.cotConflict) notes.push(`同时启用了 ${profile.cotSources.length} 套Lin_CoT：${profile.cotSources.map(x => x.variant).join('、')}；重复规则可能增加预算与格式冲突。插件不擅自关闭条目，请只保留需要的一套。`);
    if (profile.known && profile.cotEnabled) notes.push('Lin预设启用了前置Lin_CoT注释；注释文本会消耗生成预算，旧版“正文字符数”包含这类文本，不能据此认定已有正文。');
    if (profile.known && profile.cotEnabled && !profile.sceneEnabled) notes.push('固定ID对应的可选场景条目关闭；未启用模块的专属要求不应由CoT间接启用。世界书或替代条目是否另有要求，需以实际请求为准。');
    const stops = Array.isArray(request.stop) ? request.stop : typeof request.stop === 'string' ? [request.stop] : [];
    const count = Object.values(requestMeta(request).stopCounts).reduce((a, b) => a + b, 0);
    if (count) notes.push(`发送前检测到 ${count} 条停止序列声明；STOP也可能由停止序列触发，不能仅凭STOP认定正文完整。插件不删除用户停止序列。`);
    if (stops.some(x => typeof x === 'string' && /-->|<\/(?:content|Lin_\w+)>/.test(x))) notes.push('停止序列包含注释或组件结束标记，可能在正文前或组件中结束生成；插件只提示，不擅自删除自定义停止序列。');
    return notes;
}

/** Opt-in, request-only adjustment, limited to known Gemini families. */
export function planReasoning(request, settings) {
    const state = normalizeSettings(settings);
    if (state.requestMode !== 'enhance' || state.reasoningMode !== 'balanced') return null;
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

export function hasServiceRestriction(stats = {}) {
    return !!stats?.blockReason || /SAFETY|PROHIBITED|BLOCKLIST|RECITATION|CONTENT_FILTER|SPII|MODEL_ARMOR/i.test(stats?.finishReason || '');
}

export function hasApiError(stats = {}) {
    return stats?.httpStatus >= 400 || stats?.apiError === true;
}

function apiErrorDiagnosis(stats) {
    const codes = [stats.httpStatus ? `HTTP ${stats.httpStatus}` : '',
        stats.apiStatus ? `上游错误 ${stats.apiStatus}` : ''].filter(Boolean).join('；');
    const status = stats.apiStatus || stats.httpStatus;
    const detail = status === 429 ? '接口报告限流或配额不足。'
        : status === 503 ? '上游服务暂时不可用。'
        : [500, 502, 504].includes(status) ? '服务端或网关处理失败。'
        : [401, 403].includes(status) ? '请检查连接的认证与访问权限。' : '';
    return `接口错误${codes ? `（${codes}）` : ''}；${detail}查看酒馆原错误提示。${stats.retryAfterSeconds != null ? `接口建议至少等待 ${stats.retryAfterSeconds} 秒；插件不会自动发送。` : ''}`;
}

/** This transport shape is not proof of a refusal or a server error. */
export function compactStreamEvidence(stats = {}) {
    return stats.transport === 'sse' && stats.responseComplete === true && stats.doneMarker === true
        && stats.frames >= 1 && stats.frames <= 3 && stats.visibleChars > 0 && stats.visibleChars <= 320
        && !stats.finishReason && !stats.blockReason && !stats.refusal && !stats.apiError
        && !stats.captureLimited && !stats.parseErrors && !stats.aborted && !stats.networkError
        && !(stats.httpStatus >= 400) && !stats.toolCalls
        && stats.outputTokens == null && stats.thoughtTokens == null
        ? '短流缺少结束原因：仅有少量文本帧和DONE，未提供生成用量。可能是渠道将错误提示放进content，也可能是简短回复；不能按正文标点认定截断，需核对原文。'
        : '';
}

/** Compare digests only; repeated text does not reveal why it was sent. */
export function repeatedReplyEvidence(record = {}, records = []) {
    const w = record.wire || {};
    if (!compactStreamEvidence(w) || !w.textDigest || record.reason === 'unmatched-dispatch') return '';
    const count = new Set(records.filter(r => r.reason !== 'unmatched-dispatch'
        && r.request?.model === record.request?.model && compactStreamEvidence(r.wire)
        && r.wire?.textDigest === w.textDigest).map(r => r.id)).size;
    return count > 1 ? `同一模型的相同短文本在最近记录中出现 ${count} 次（SHA-256一致）；可能是固定提示，摘要值不能还原内容或证明拒答。` : '';
}

/** Missing CoT plus a very short response is evidence to inspect, not proof of failure. */
export function shortReplyEvidence(record = {}) {
    const output = record.rendered?.output || record.wire?.output;
    const size = output?.nonCommentChars;
    return record.deliveryProfile?.cotEnabled === true && ['normal', 'regenerate', 'swipe'].includes(record.type)
        && (record.wire?.responseComplete === true || !!record.rendered) && output?.cotCount === 0
        && size > 0 && size < 240
        ? `短回复待核：收到 ${size} 字符且未发现预设所选的Lin_CoT。可能是简短答复、戏外任务、错误提示或拒答；不能据此认定空回或自动重试。` : '';
}

export function responseDiagnosis(stats = {}) {
    // Host error handling can abort a request after reading an error frame.
    // An abort signal must not hide an already observed provider result.
    if (hasApiError(stats)) return apiErrorDiagnosis(stats);
    if (hasServiceRestriction(stats)) return `接口报告拦截或限制：${stats.blockReason || stats.finishReason}；不是已证实的token耗尽或网络断流。插件不能解除服务端限制，不自动续写或重试。${structureDiagnosis(stats.output) ? `附带结构问题：${structureDiagnosis(stats.output)}。` : ''}`;
    if (stats.refusal) return '接口返回了明确拒绝字段；这是拒答而非空回，插件不针对该限制自动补全或重试。';
    if (String(stats.finishReason || '').toUpperCase() === 'CONTINUATION') return `接口要求凭据续传：本段已识别文本 ${stats.visibleChars || 0} 字符；需要后端携带上游续传凭据继续同一次生成，普通酒馆“继续”会新开一轮。`;
    if (stats.aborted) return '请求已中止；中止信号不能区分手动停止与客户端错误处理，不据此判断模型空回。';
    if (stats.networkError) return '网络请求失败；没有取得可分析的响应。';
    if (stats.incomplete && !/MAX_TOKENS|LENGTH/i.test(stats.finishReason || '')) return '接口标记响应未完成，具体原因未提供；不能直接认定输出预算耗尽。';
    const structural = structureDiagnosis(stats.output);
    const reply = replySignalDiagnosis(stats.output);
    if (stats.output?.onlyNotes) return `接口文本字段 ${stats.visibleChars || 0} 字符，其中Lin_CoT ${stats.output.cotChars} 字符；${structural}。${/^(?:STOP|END_TURN)$/i.test(stats.finishReason || '') ? '渠道报告STOP/正常结束，但这不等于正文已交付。' : /MAX_TOKENS|LENGTH/i.test(stats.finishReason || '') ? '渠道同时报告输出上限；思考/注释阶段可能已耗尽预算。' : '还需结合结束原因判断提前停写或传输中断。'}`;
    if (structural) return `接口文本字段 ${stats.visibleChars || 0} 字符${stats.output?.commentChars ? `（注释 ${stats.output.commentChars}；注释外 ${stats.output.nonCommentChars}）` : ''}；${structural}。${stats.finishReason ? `结束原因：${stats.finishReason}。` : '渠道未提供结束原因。'}${reply}`;
    if (stats.missingTerminal) return `流式读取已结束，但缺少结束原因和结束标志；已识别文本 ${stats.visibleChars || 0} 字符，可能中途断流，不能确认完整交付。${stats.streamMessageEnvelope ? 'SSE使用message而非delta字段，需检查渠道适配。' : ''}${stats.parseErrors ? '存在解析错误，取证不完整。' : ''}`;
    if (stats.captureLimited && stats.visibleChars > 0) return `已识别部分文本 ${stats.visibleChars} 字符，但取证不完整（${stats.limitReason === 'read-error' ? '读取中断' : '受限或被停止'}），不能确认回复完整。`;
    if (stats.protocolMismatch) return `请求与响应协议不一致：${stats.protocolMismatch === 'stream-request-non-sse' ? '请求流式，却收到 JSON / NDJSON；可先在酒馆原生设置关闭流式再重试' : '请求 JSON，却收到 SSE；检查渠道协议'}。已识别正文 ${stats.visibleChars || 0} 字符，不能据此认定模型空回。`;
    if (stats.streamMessageEnvelope) return `SSE 帧使用 message 而非 delta 字段；检测到正文 ${stats.visibleChars || 0} 字符，需检查渠道流式格式，或在酒馆关闭流式后排查。`;
    if (reply || compactStreamEvidence(stats)) return [reply, compactStreamEvidence(stats),
        stats.finishReason ? `接口结束原因：${stats.finishReason}；不能由该文字提示推断具体限制类别。` : '渠道未提供结束原因。'].filter(Boolean).join('');
    if (stats.responseComplete && stats.recognized && !stats.parseErrors && stats.visibleChars > 0 && !stats.finishReason) return `收到 ${stats.visibleChars} 字符原始文本，但渠道未提供结束原因；${stats.doneMarker ? 'DONE只说明流已结束' : '读取结束'}，不能确认正文完整，也不能单凭短回复判断拒绝。`;
    if (stats.visibleChars > 0) return `接口文本字段 ${stats.visibleChars} 字符${stats.output?.commentChars ? `（注释 ${stats.output.commentChars}；注释外 ${stats.output.nonCommentChars}）` : ''}${/MAX_TOKENS|LENGTH/i.test(stats.finishReason || '') ? '，但达到输出上限，可能截断' : ''}${stats.captureLimited || stats.parseErrors ? '；取证不完整，该数值仅包含已识别部分' : ''}；文本长度不等于故事正文已完整交付。${/^(?:STOP|END_TURN|STOP_SEQUENCE)$/i.test(stats.finishReason || '') ? '接口报告结束；STOP可能是自行停写或停止序列，不能证明正文写完，也不能排除中转映射。' : ''}${endingDiagnosis(stats.output)}`;
    if (stats.captureLimited) return `取证未完成（${stats.limitReason === 'read-error' ? '读取中断' : '容量、时间限制或观察被停止'}）；尚不能据此判断空回。`;
    if (stats.responseComplete && stats.receivedBytes === 0) return 'HTTP 响应体为零字节；没有取得模型正文或结束原因。';
    if (stats.parseErrors || !stats.recognized) return '响应格式未完整识别；请查看酒馆原错误提示或渠道日志。';
    if (/MAX_TOKENS|LENGTH/i.test(stats.finishReason || '') || stats.incomplete) return '达到输出预算或返回不完整，未检测到正文；可能在思考阶段耗尽预算。';
    if (stats.toolCalls) return '接口返回工具调用，未检测到正文；请检查工具后续流程。';
    if (stats.reasoningChars > 0 || stats.thoughtTokens > 0) return '接口只有思考内容或思考用量，没有检测到正文。';
    return '接口没有返回可识别正文；仅凭空内容无法确定原因。';
}

/** Keep saved-text evidence visible even when a later clone inspection finishes. */
export function recordStatus(record = {}) {
    const w = record.wire || {};
    if (hasApiError(w)) return { label: '请求失败', state: 'warn' };
    if (hasServiceRestriction(w))
        return { label: '服务端限制', state: 'warn' };
    if (w.refusal) return { label: '接口拒答', state: 'warn' };
    if (isGemini4Segment(record)) return { label: '上游要求续传', state: 'warn' };
    if (record.clientStopped) return { label: '客户端已停止', state: 'warn' };
    if (w.aborted) return { label: '请求已中止', state: 'warn' };
    if (w.networkError) return { label: '请求失败', state: 'warn' };
    if (/MAX_TOKENS|LENGTH/i.test(w.finishReason || ''))
        return { label: '输出预算结束', state: 'warn' };
    if (w.incomplete) return { label: '接口响应未完成', state: 'warn' };
    if (w.protocolMismatch || w.streamMessageEnvelope) return { label: '响应协议异常', state: 'warn' };
    const output = record.rendered?.output || w.output;
    if (w.missingTerminal || w.captureLimited || w.parseErrors) return { label: '取证不完整', state: 'warn' };
    if (output?.onlyNotes || output?.noTextContent) return { label: '尚无正文', state: 'warn' };
    if (structureDiagnosis(output)) return { label: '结构未完成', state: 'warn' };
    if (output?.replySignals?.includes('error-text')) return { label: '疑似接口提示', state: 'warn' };
    if (output?.replySignals?.includes('refusal-text')) return { label: '疑似文字拒答', state: 'warn' };
    if (compactStreamEvidence(w)) return { label: '短流·原因未知', state: 'warn' };
    if (endingDiagnosis(output)) return { label: '疑似句尾未完', state: 'warn' };
    if (w.toolCalls) return { label: '工具调用', state: 'idle' };
    if ((record.rendered?.chars === 0 && record.rendered?.reasoningChars > 0)
        || (w.visibleChars === 0 && (w.reasoningChars > 0 || w.thoughtTokens > 0)))
        return { label: '尚无正文', state: 'warn' };
    if (record.rendered?.chars === 0 || (w.responseComplete && w.visibleChars === 0 && (w.recognized || w.receivedBytes === 0)))
        return { label: '空响应·需排查', state: 'warn' };
    if (shortReplyEvidence(record)) return { label: '短回复·请核对', state: 'warn' };
    if (w.responseComplete && !w.finishReason) return { label: '结束原因未知', state: 'warn' };
    if (w.finishReason) return { label: '接口已结束·正文待核', state: 'idle' };
    if (record.dispatch) return { label: '等待结束证据', state: 'idle' };
    return { label: record.applied ? '已组装' : '未注入', state: 'idle' };
}

export function profileMismatch(record = {}) {
    const output = record.wire?.output || record.rendered?.output;
    return record.deliveryProfile?.cotEnabled === false && output?.cotCount > 0
        ? '条目识别与实际输出不一致：未识别到启用的固定CoT条目，但回复含Lin_CoT。可能来自其他条目、世界书或模型沿用格式；不能断言本轮没有CoT。'
        : '';
}

export function recordDiagnosis(record = {}) {
    const lines = [];
    if (record.origin === 'unassociated' || record.reason === 'unmatched-dispatch') lines.push('未关联请求：可能是后台任务或其他扩展调用，不用于判定当前聊天回复是否完成。');
    if (record.wire) lines.push(responseDiagnosis(record.wire));
    if (record.clientStopped) lines.push('客户端报告停止；事件未区分手动停止与错误处理，不会覆盖已观察到的接口错误或限制。');
    if (isGemini4Segment(record)) lines.push('上游分段要求凭据续传；普通酒馆继续会新开一次生成。');
    if (profileMismatch(record)) lines.push(profileMismatch(record));
    if (shortReplyEvidence(record) && !compactStreamEvidence(record.wire)) lines.push(shortReplyEvidence(record));
    if (record.rendered) lines.push(record.rendered.chars > 0
        ? `酒馆已保存 ${record.rendered.chars} 字符原始文本${record.rendered.output ? `；Lin_CoT注释 ${record.rendered.output.cotChars} 字符；注释外文本 ${record.rendered.output.nonCommentChars} 字符` : '（旧记录未区分注释）'}。${structureDiagnosis(record.rendered.output) || endingDiagnosis(record.rendered.output) || '显示效果仍取决于正则与样式，不能仅由字符数确认正文完整。'}`
        : `酒馆保存的正文为空${record.rendered.reasoningChars ? '，有思考内容' : ''}。`);
    if (record.rendered && replySignalDiagnosis(record.rendered.output)) lines.push(replySignalDiagnosis(record.rendered.output));
    if (!record.wire && record.lifecycle) lines.push(record.lifecycle);
    const comparison = compareDelivery(record);
    if (comparison) lines.push(comparison);
    return lines.join('\n');
}

/** Compare the same response only. Continue events contain the previous saved prefix. */
export function compareDelivery(record = {}) {
    const w = record.wire, saved = record.rendered?.output?.rawChars;
    if (!['normal', 'regenerate', 'swipe'].includes(record.type) || !w?.responseComplete
        || w.captureLimited || w.parseErrors || !Number.isFinite(w.visibleChars) || !Number.isFinite(saved)) return '';
    if (w.textDigest && record.rendered.textDigest) {
        return w.textDigest === record.rendered.textDigest
            ? '接收核对：本次解析文本与酒馆保存原文的 SHA-256 一致；文本一致仍不代表剧情完整，显示正则也可能改变显示效果。'
            : '接收核对：本次解析文本与酒馆保存原文的 SHA-256 不一致；即使等长也有文本差异，请核对渠道适配、保存处理及正则，不能直接归因于网络丢字。';
    }
    if (saved === w.visibleChars) return `接收核对：接口与酒馆保存原文均为 ${saved} 字符，长度一致；不等于逐字比对或语义完整。若实际末句仍未完，请检查停止序列、上游提前结束或显示正则；当前记录没有证明浏览器侧丢字。`;
    return `接收核对：接口 ${w.visibleChars} 字符，保存原文 ${saved} 字符，长度不一致。可能涉及保存处理、正则转换或事件关联，需要核对；不能直接归因于模型截断。`;
}

export function formatRecord(record, records = []) {
    if (!record) return '尚无记录。正常发送一条消息后可在这里查询。';
    const lines = [`记录 ${record.id} · v${record.version || VERSION}`, `时间：${record.at}`, `类型：${record.type} · 模型：${record.request?.model || '未提供'}`, `组装：${record.explanation}`, `发送：${record.dispatch?.label || '未观察到浏览器发送，或未开启网络取证'}`];
    const source = record.dispatch?.request?.source || record.request?.source;
    const sourceLabel = { makersuite: 'Google AI Studio', vertexai: 'Vertex AI', custom: '自定义接口', openai: 'OpenAI 兼容连接' }[source];
    lines.push(`连接来源：${sourceLabel || '其他或未提供'}（按酒馆请求参数；不证明实际上游服务）。`);
    if (record.requestMode) lines.push(`请求处理：${record.requestMode === 'gemini4' ? 'Lin 2.8.2 × Gemini 4 承接兼容' : record.requestMode === 'observe' ? '原样诊断（不改写提示与参数）' : '承接增强（旧版行为）'}`);
    if (record.gemini4) lines.push('适配目标：' + record.gemini4.model + (record.gemini4.indirect ? '（按连接别名识别，实际后端未知）' : '（按酒馆连接识别）'));
    if (isGemini4Segment(record)) lines.push('此响应为上游分段，需要由后端在原请求上携带续传凭据。' + (record.wire.continuationTokenSeen ? '浏览器看到了凭据字段，插件不保存或重发其值。' : '浏览器未确认收到凭据。'));
    if (repeatedReplyEvidence(record, records)) lines.push(repeatedReplyEvidence(record, records));
    if (record.origin === 'unassociated' || record.reason === 'unmatched-dispatch') lines.push('归属：未关联请求（可能来自后台任务；不自动归入当前正文生成）。');
    if (shortReplyEvidence(record) && !compactStreamEvidence(record.wire)) lines.push(shortReplyEvidence(record));
    if (record.adjustment) lines.push(`本次思考参数：${record.adjustment.before} → ${record.adjustment.after}`);
    if (record.identification) lines.push(`条目识别：${record.identification}`);
    if (record.applied && ['swipe', 'regenerate'].includes(record.type)) lines.push('本轮为重抽／重新生成；应重新完成原任务，不应仅接写被替换答案的末尾。');
    const sent = record.dispatch?.request || record.request;
    if (sent?.inputTextChars != null) lines.push(`请求文本约 ${sent.inputTextChars} 字符（非token数，图片等非文本内容不计）。`);
    if (sent?.stopCounts) lines.push(`发送参数快照：max_tokens=${sent.maxTokens ?? '未提供'}；max_completion_tokens=${sent.maxCompletionTokens ?? '未提供'}；停止序列声明数：stop=${sent.stopCounts.stop}、stopSequences=${sent.stopCounts.stopSequences}、generationConfig=${sent.stopCounts.generationConfig}。仅记录数量；后端仍可能另加停止条件。`);
    if (record.deliveryProfile?.known) lines.push(`Lin交付约束：${record.deliveryGuard ? '已加入本次请求' : '未加入'}；已识别的固定组件（非完整清单）：${record.deliveryProfile.components.join('、') || '未识别到'}；输入提示词 ${record.deliveryProfile.inputPromptChars} 字符（不是输出）。`);
    if (record.deliveryProfile?.cotSources) lines.push(`按预设启用顺序识别CoT：${record.deliveryProfile.cotSources.map(x => `${x.variant}（${x.columns || '未知'}栏）`).join('、') || '未识别到启用条目'}；这不是后端实际执行证明。`);
    if (record.wire?.emptyFinalSnapshot) lines.push('渠道最终空message帧未覆盖前面已收到的增量文本；原响应未被修改。');
    if (profileMismatch(record)) lines.push(profileMismatch(record));
    if (record.presetState) lines.push(`设置快照：${record.presetState.promptCount} 条提示；识别=${record.presetState.known}；开关=${record.presetState.active ?? '未知'}`);
    if (record.wire) lines.push(`接口：${responseDiagnosis(record.wire)}`, `结束原因：${record.wire.finishReason || record.wire.blockReason || '渠道未提供'}`, `思考 token：${record.wire.thoughtTokens ?? '渠道未提供'} · 生成 token（渠道口径，可能含思考）：${record.wire.outputTokens ?? '渠道未提供'}`);
    if (record.wire) lines.push(`输入 token：${record.wire.promptTokens ?? '渠道未提供'} · 总 token：${record.wire.totalTokens ?? '渠道未提供'} · 请求至取证结束：${record.wire.totalDurationMs ?? '旧记录未提供'} ms`);
    const ending = record.rendered?.output?.ending || record.wire?.output?.ending;
    if (ending?.checked === false) lines.push(`句尾检查未适用（${ending.reason || '旧记录未记录原因'}）；这不表示句尾完整。`);
    if (record.wire?.transport) lines.push(`响应格式：${record.wire.transport}；Content-Type：${record.wire.contentType}；字节：${record.wire.receivedBytes}；SSE 帧：${record.wire.frames}；DONE：${record.wire.doneMarker ? '有' : '无'}；读取完成：${record.wire.responseComplete ? '是' : '否'}；解析错误：${record.wire.parseErrors}；取证耗时：${record.wire.durationMs ?? 0} ms`);
    if (record.possibleAssemblyIds?.length) lines.push(`邻近组装记录（仅候选，未证实同一请求）：${record.possibleAssemblyIds.join('、')}`);
    if (record.rendered) lines.push(`酒馆保存原始文本：${record.rendered.chars} 字符；原生思考字段：${record.rendered.reasoningChars} 字符（原生思考为0不排除文本内含Lin_CoT）。`, recordDiagnosis({ rendered: record.rendered }));
    if (compareDelivery(record)) lines.push(compareDelivery(record));
    if (record.lifecycle && !record.rendered) lines.push(record.lifecycle);
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
