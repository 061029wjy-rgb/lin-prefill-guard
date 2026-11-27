import { LIN_PROMPT_ID, PROTOCOL_NAMES } from './protocol.js?v=1.5.1';
import { gemini4Target } from './gemini4.js?v=1.5.1';

const GOOGLE = ['makersuite', 'vertexai'];
const PROXY_LABELS = { vertexai: 'Vertex AI 反代', makersuite: 'Google AI Studio 反代',
    openai: 'OpenAI 反代', custom: '自定义 OpenAI 兼容接口' };
export const PROXY_METHODS = ['google-proxy-model', 'compatible-prefix', 'compatible-assistant'];
const SPEAKERS = ['user', 'assistant', 'system', 'developer'];
const CLAUDE_WITH_PREFILL = /^claude-(?:3(?:-[57])?-(?:opus|sonnet|haiku)|(?:opus|sonnet|haiku)-4(?:-[015])?)(?:-\d{8}|-latest)?$/;
const LEGACY_NAME = '✮伪预填充｜剧情衔接（assistant）';
const nonempty = value => typeof value === 'string' && !!value.trim();
const list = value => Array.isArray(value) ? value : [];
const valueType = value => value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
const deepSeekBeta = url => /^https:\/\/api\.deepseek\.com\/beta\/?$/.test(url || '');

function connectionHash(fields) {
    const identity = JSON.stringify(fields);
    let hash = 14695981039346656037n;
    for (let i = 0; i < identity.length; i++) hash = BigInt.asUintN(64, (hash ^ BigInt(identity.charCodeAt(i))) * 1099511628211n);
    return hash.toString(16).padStart(16, '0');
}

export function identifyProxy(request = {}) {
    const { chat_completion_source: source, model } = request;
    const url = source === 'custom' ? request.custom_url : request.reverse_proxy;
    if (!Object.hasOwn(PROXY_LABELS, source) || !nonempty(model) || !nonempty(url) ||
        (source === 'custom' && deepSeekBeta(url))) return null;
    let endpoint;
    try { endpoint = new URL(url); } catch { return null; }
    if (!['http:', 'https:'].includes(endpoint.protocol) ||
        /(?:^|\.)(?:googleapis\.com|google\.com|api\.openai\.com)$/.test(endpoint.hostname.replace(/\.$/, ''))) return null;
    // Stock ST chooses Vertex proxy auth whenever reverse_proxy is populated,
    // including when the saved auth dropdown still says express or full.
    const google = GOOGLE.includes(source);
    const legacyKey = google ? connectionHash([source, model, endpoint.href]) : '';
    endpoint.hash = '';
    endpoint.pathname = endpoint.pathname.replace(/\/$/, '');
    const key = connectionHash([source, model.trim(), endpoint.href,
        request.custom_prompt_post_processing || '', source === 'custom' ? request.custom_include_body || '' : '',
        source === 'custom' ? request.custom_exclude_body || '' : '']);
    return { source, label: PROXY_LABELS[source], key, legacyKey, google };
}

export function proxyMethod(proxy, compatibleMethod) {
    if (!proxy) return null;
    if (proxy.google) return PROXY_METHODS[0];
    return compatibleMethod === 'compatible-assistant' ? 'compatible-assistant' : 'compatible-prefix';
}

export function googleProxyKey(request = {}) {
    return identifyProxy(request)?.legacyKey || '';
}

export function prefillRoute(request = {}, proxyKey = '', approval = null) {
    const source = request.chat_completion_source;
    const model = String(request.model || '').trim().toLowerCase();
    const unavailable = detail => ({ method: null, detail });
    if (source === 'custom' && deepSeekBeta(request.custom_url) && !nonempty(request.custom_include_body) &&
        !nonempty(request.custom_exclude_body) && (!request.custom_prompt_post_processing || request.custom_prompt_post_processing === 'none') && model)
        return { method: 'deepseek-beta', detail: 'DeepSeek Beta 的末尾 assistant + prefix:true。' };
    const proxy = identifyProxy(request);
    if (proxy) {
        const method = proxyMethod(proxy, approval?.method);
        const state = { connection: proxy.label, proxy: true };
        if (request.custom_prompt_post_processing === 'single')
            return { ...state, ...unavailable('已识别' + proxy.label + '。酒馆的单条消息后处理会合并回复前缀。') };
        const confirmed = approval?.key === proxy.key && approval.method === method;
        if (!confirmed && !(proxy.legacyKey && proxy.legacyKey === proxyKey))
            return { ...state, method: null, detail: '已识别' + proxy.label + '。请在插件面板测试当前反代的回复前缀。' };
        if (proxy.google && /gemini-3\.[67]-flash|gemini-3\.5-flash-lite/.test(model) &&
            !(confirmed && approval.evidence === 'test'))
            return { ...state, ...unavailable('已识别' + proxy.label + '。此型号在部分酒馆后端会将末尾前缀改为 user，请先实测。') };
        return { ...state, method, detail: '已识别' + proxy.label + '。' + (confirmed && approval.evidence === 'test'
            ? '当前连接的测试返回了预期续写。' : '按已确认的渠道协议组装回复前缀。') };
    }
    if (GOOGLE.includes(source)) return unavailable('当前 Google 连接没有已确认的自定义回复前缀能力。');
    if (source === 'deepseek' && (!request.reverse_proxy || deepSeekBeta(request.reverse_proxy)) && model)
        return { method: 'deepseek-beta', detail: '酒馆直连 DeepSeek Beta 的末尾 assistant + prefix:true。' };
    if (request.reverse_proxy) return unavailable('当前为转发连接，预填充协议未确认。');
    if (source === 'mistralai' && model) return { method: 'mistral-prefix', detail: 'Mistral 的末尾 assistant + prefix:true。' };
    if (source === 'claude' && CLAUDE_WITH_PREFILL.test(model)) {
        if (request.include_reasoning || nonempty(request.reasoning_effort) && request.reasoning_effort !== 'auto')
            return unavailable('当前 Claude 思考设置可能让宿主把末尾前缀转为 user。');
        return { method: 'claude-assistant', detail: 'Claude Messages API 的末尾 assistant 前缀。' };
    }
    return unavailable('当前连接和模型没有已确认的原生前缀协议。');
}

// Read the text portion even in a protected object. Only the original object
// can be moved, and only after the relevant tail is verified to be plain.
function matchesAnchor(message, anchor) {
    if (message?.role !== anchor.role) return false;
    const content = message.content;
    if (typeof content === 'string') return content === anchor.content;
    return list(content).filter(block => block?.type === 'text' && block.thought !== true)
        .map(block => typeof block.text === 'string' ? block.text : '').join('') === anchor.content;
}

function protections(messages, tailStart, prefixIndex = -1) {
    const fields = [];
    messages.forEach((message, index) => {
        const region = index < tailStart ? 'history' : 'tail';
        const add = (field, contentType) => fields.push({ index, role: message.role, field, contentType, region });
        for (const [field, value] of Object.entries(message)) {
            if (!['role', 'content'].includes(field) && !(index === prefixIndex && field === 'prefix' && value === true))
                add(field, valueType(value));
        }
        if (!SPEAKERS.includes(message.role)) add('role', 'tool-or-other-role');
        const value = message.content;
        if (Array.isArray(value) && value.length) {
            value.forEach((block, part) => {
                const field = `content[${part}]`;
                const contentType = typeof block?.type === 'string' ? block.type : valueType(block);
                if (block?.type !== 'text' || typeof block.text !== 'string') add(field, contentType);
                if (block && typeof block === 'object' && !Array.isArray(block)) {
                    for (const key of Object.keys(block)) {
                        if (!['type', 'text'].includes(key)) add(`${field}.${key}`, contentType);
                    }
                }
            });
        } else if (typeof value !== 'string') add('content', valueType(value));
    });
    return fields;
}

function matchTail(messages, definitions) {
    let index = messages.length - 1;
    const entries = [];
    for (const [anchor, optional] of [...definitions].reverse()) {
        if (matchesAnchor(messages[index], anchor)) {
            entries.unshift({ index, anchor });
            index--;
        } else if (!optional) return null;
    }
    return entries;
}

function singleCue(preset, type, activeOrderId) {
    const prompts = list(preset?.prompts);
    const byId = prompts.filter(prompt => prompt?.identifier === LIN_PROMPT_ID);
    const candidates = byId.length ? byId : prompts.filter(prompt => prompt?.name === LEGACY_NAME);
    if (!candidates.length) return { reason: 'not-lin' };
    const [cue] = candidates;
    if (candidates.length !== 1 || cue.role !== 'assistant' || !nonempty(cue.content) || cue.marker ||
        (cue.injection_position != null && cue.injection_position !== 0)) return { reason: 'g291-anchors' };
    const groups = list(preset?.prompt_order).filter(group => activeOrderId == null || String(group?.character_id) === String(activeOrderId));
    const orders = groups.map(group => list(group?.order).filter(entry => entry?.identifier === cue.identifier));
    if (!orders.length || orders.some(entries => entries.length !== 1 || typeof entries[0].enabled !== 'boolean'))
        return { reason: 'g291-order' };
    if (orders.some(entries => !entries[0].enabled)) return { reason: 'lin-disabled' };
    if (cue.injection_trigger != null && (!Array.isArray(cue.injection_trigger) ||
        (cue.injection_trigger.length && !cue.injection_trigger.includes(type)))) return { reason: 'trigger-excluded' };
    return { kind: 'single', cue, between: [], after: [] };
}

function envelopeRisk(request, native) {
    if ([request.continuationToken, request.continuation_token, request.cachedContent, request.cached_content].some(v => v != null))
        return 'continuation-or-cache';
    if (request.contents != null || request.input != null) return 'parallel-input';
    if ([request.n, request.generationConfig?.candidateCount].some(n => n != null && n !== 1)) return 'multiple-candidates';
    if (request.json_schema || request.responseSchema || request.responseJsonSchema ||
        request.generationConfig?.responseSchema || request.generationConfig?.responseJsonSchema ||
        [request.responseMimeType, request.generationConfig?.responseMimeType].some(v => v && v !== 'text/plain') ||
        (request.response_format != null && request.response_format.type !== 'text')) return 'structured';
    if (nonempty(request.assistant_prefill) || request.messages.some((message, index) =>
        message.prefix === true && !(native && index === request.messages.length - 1))) return 'native-prefill';
    if ([request.tools, request.functions, request.mcp_servers].some(v => v != null && (!Array.isArray(v) || v.length)) ||
        (request.tool_choice != null && request.tool_choice !== 'none') || (request.function_call != null && request.function_call !== 'none'))
        return 'tools';
    return null;
}

function lastToolTurn(history) {
    const last = history.findLast(message => !['system', 'developer'].includes(message.role));
    return last && (['tool', 'function'].includes(last.role) || last.tool_calls?.length || last.tool_call_id ||
        last.function_call || list(last.content).some(block => ['tool_use', 'tool_result', 'tool_calls', 'tool_call_id', 'functionCall', 'functionResponse'].includes(block?.type)));
}

export const usesPrefixFlag = method => ['mistral-prefix', 'deepseek-beta', 'compatible-prefix'].includes(method);

export function planNativePrefill(request, preset, layout, type, activeOrderId, proxyKey, approval) {
    const messages = request.messages;
    const route = prefillRoute(request, proxyKey, approval);
    const { method, detail } = route;
    const target = gemini4Target(request, { tailPair: true });
    const resolved = layout.candidate ? layout : singleCue(preset, type, activeOrderId);
    const base = { type, messages, changed: false, applied: false, injected: [], netChars: 0, removedOriginal: false,
        tailRoles: messages.slice(-2).map(message => message.role),
        protocol: resolved.kind || 'unknown', identification: PROTOCOL_NAMES[resolved.kind] || 'Lin 独立承接',
        ...(target ? { gemini4: target } : {}),
        ...(layout.candidate ? { lin291: layout.meta } : {}) };
    const done = (reason, extra = {}) => ({ ...base, reason, ...extra });
    if (resolved.reason) return done(resolved.reason, { detail: resolved.detail });
    if (type === 'continue') return done('g4-continue');

    const { cue, confirm, between, after } = resolved;
    const middle = between.map(prompt => [prompt, true]);
    const end = after.map(prompt => [prompt, true]);
    const rules = confirm ? [...middle, [confirm], ...end] : [];
    const tail = matchTail(messages, [[cue], ...rules]);
    const cueLast = confirm && matchTail(messages, [...rules, [cue]]);
    const entries = tail || cueLast;
    const flag = usesPrefixFlag(method);
    const cueAlreadyLast = !!cueLast || (!confirm && !!tail);
    const priorPrefix = cueAlreadyLast && flag && messages.at(-1)?.prefix === true;
    const start = entries?.[0].index ?? Math.max(0, messages.length - 2);
    const protectedFields = protections(messages, start, priorPrefix ? messages.length - 1 : -1);
    const prefill = { method, channel: detail, ...(route.connection ? { connection: route.connection } : {}),
        tailStart: start, order: entries ? (tail && confirm ? 'cue-before-user' : 'cue-last') : null };
    const result = (reason, extra = {}) => done(reason, { prefill, protectedFields, ...extra });
    if (!entries) return result('g291-anchors', { detail: '在当前尾段没有找到独立的原承接及确认，或尾部另有消息。' });

    const original = entries.map(({ anchor }) => anchor);
    const witness = (anchors, native = false) => ({ anchors: anchors.map(({ role, content }) => ({ role, content })),
        method: native ? method : null, proxyKey: native ? proxyKey : '', approval: native ? approval : null });
    const readOnly = (reason, description) => result(reason, { detail: description, prefillWitness: witness(original) });
    if (protectedFields.some(field => field.region === 'tail'))
        return readOnly('prefill-protected-tail');
    const risk = request.chat_completion_source === 'claude' && nonempty(preset?.assistant_prefill)
        ? 'native-prefill' : envelopeRisk(request, priorPrefix);
    if (risk) return readOnly(risk);

    const history = messages.slice(0, start);
    if (!history.some(message => message.role === 'user' &&
        (nonempty(message.content) || list(message.content).length))) return readOnly('no-user');
    if (lastToolTurn(history) || (method === 'claude-assistant' && request.enable_web_search === true)) return readOnly('tools');

    if (!method && (!cueLast || tail)) return readOnly(route.proxy ? 'prefill-proxy-unverified' : 'prefill-unavailable', detail);
    const cueSlot = entries.find(entry => entry.anchor === cue);
    const cueMessage = messages[cueSlot.index];
    if (method === 'claude-assistant' && /\s$/.test(cue.content))
        return readOnly('prefill-unavailable', '此 Claude 前缀带有不受接口支持的尾部空白，原文已保留。');
    if (method === 'deepseek-beta' && typeof cueMessage.content !== 'string')
        return readOnly('prefill-unavailable', 'DeepSeek 前缀需要字符串，当前保留预设原有的分块结构。');
    const rest = entries.filter(entry => entry !== cueSlot);
    const sorted = method ? [...rest, cueSlot] : [cueSlot, ...rest];
    const changed = sorted.some((entry, i) => entry !== entries[i]) || (flag && !priorPrefix);
    const planned = changed ? [...history, ...sorted.map(entry => entry === cueSlot && flag ?
        { ...cueMessage, prefix: true } : messages[entry.index])] : messages;
    return result(method ? changed ? 'prefill-converted' : 'prefill-ready' : 'prefill-compatible', {
        messages: planned, changed, applied: changed, tailRoles: planned.slice(-2).map(message => message.role),
        prefillWitness: witness(sorted.map(entry => entry.anchor), !!method),
    });
}

export function verifyPrefill(request, witness) {
    if (!witness) return null;
    const { anchors, method, proxyKey, approval } = witness;
    const offset = request.messages.length - anchors.length;
    const same = offset >= 0 && anchors.every((anchor, i) => matchesAnchor(request.messages[offset + i], anchor));
    if (!same) return { verified: false, native: false };
    const routeMatches = !method || (prefillRoute(request, proxyKey, approval).method === method &&
        !envelopeRisk(request, usesPrefixFlag(method)));
    const flagged = !usesPrefixFlag(method) || request.messages.at(-1)?.prefix === true;
    return { verified: routeMatches && flagged, native: !!method && routeMatches && flagged, tailStart: offset };
}
