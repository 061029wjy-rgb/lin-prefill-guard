import { identifyProxy, proxyMethod, usesPrefixFlag } from './prefill.js?v=1.5.1';
import { inspectResponse } from './observer.js?v=1.5.1';

const TOKEN_LIMIT = 1024;
const PROBE_PATH = '/api/backends/chat-completions/generate';
const TIMEOUT = 60_000;
const CUSTOM_FIELDS = ['custom_include_body', 'custom_exclude_body', 'custom_include_headers'];
const ROUTING_FIELDS = ['reverse_proxy', 'proxy_password', 'vertexai_auth_mode', 'vertexai_region',
    'vertexai_express_project_id', 'custom_url', 'custom_prompt_post_processing', ...CUSTOM_FIELDS];
const PROBE_FIELDS = ['messages', 'contents', 'input', 'prompt', 'model', 'stream', 'max_tokens',
    'max_completion_tokens', 'max_output_tokens', 'n', 'tools', 'functions', 'response_format'];

// The test uses a unique message. When the channel starts a fresh reply, the
// instruction asks for the whole string, including the already provided prefix.
function makeChallenge(method) {
    const nonce = globalThis.crypto.getRandomValues(new Uint32Array(1))[0].toString(16).padStart(8, '0');
    const prefix = `{"lin":"${nonce}","result":"`;
    const suffix = `OK-${nonce}"}`;
    const full = prefix + suffix;
    return {
        messages: [
            { role: 'user', content: 'For this connection test, the whole assistant reply must be exactly this single JSON object: ' + full },
            { role: 'assistant', content: prefix, ...(usesPrefixFlag(method) ? { prefix: true } : {}) },
        ],
        classifyText(text) {
            if (text.trimEnd() === suffix) return 'suffix';
            if (text.includes(full)) return 'full';
            return 'different';
        },
    };
}

function customOverridesProbe(request, parseYAML) {
    if (request.chat_completion_source !== 'custom') return false;
    const body = request.custom_include_body;
    const exclude = request.custom_exclude_body;
    if (!body?.trim() && !exclude?.trim()) return false;
    const keys = value => value && typeof value === 'object' ? Object.keys(value) : [];
    try {
        const included = body?.trim() ? parseYAML(body) : null;
        const excluded = exclude?.trim() ? parseYAML(exclude) : null;
        const added = Array.isArray(included) ? included.flatMap(keys) : keys(included);
        const removed = Array.isArray(excluded) ? excluded : typeof excluded === 'string' ? [excluded] : keys(excluded);
        return [...added, ...removed].some(key => PROBE_FIELDS.includes(key));
    } catch { return true; }
}

function fallbackPayload(connection, messages) {
    const routing = Object.fromEntries(ROUTING_FIELDS.filter(key => Object.hasOwn(connection, key))
        .map(key => [key, connection[key]]));
    return { ...routing, messages, chat_completion_source: connection.chat_completion_source, model: connection.model,
        reasoning_effort: connection.reasoning_effort, include_reasoning: connection.include_reasoning,
        use_sysprompt: connection.use_sysprompt, max_tokens: TOKEN_LIMIT };
}

export async function checkProxyPrefill({ connection, compatibleMethod, context, createGenerationParameters,
    parseYAML = JSON.parse, fetchRequest = (...args) => globalThis.fetch(...args), signal }) {
    const proxy = identifyProxy(connection);
    const method = proxyMethod(proxy, compatibleMethod);
    const result = (status, message, extra = {}) => ({ status, message, ...extra });
    if (!proxy || !method) return result('unavailable', '酒馆当前连接没有可测试的模型反代地址。');
    if (connection.custom_prompt_post_processing === 'single')
        return result('unavailable', '当前启用了单条消息后处理。酒馆会把末尾 assistant 合并为 user。');
    if (typeof context?.getRequestHeaders !== 'function')
        return result('unavailable', '此酒馆未提供连接测试所需的请求接口。');
    if (proxy.source === 'custom' && CUSTOM_FIELDS.some(key => typeof connection[key] === 'string' && /\{\{|<USER>|<BOT>/i.test(connection[key])))
        return result('unavailable', '自定义连接字段使用了酒馆宏，无法用独立测试消息复现此连接。');
    const { messages, classifyText } = makeChallenge(method);
    const abort = new AbortController();
    const cancel = () => abort.abort();
    if (signal?.aborted) return result('cancelled', '测试已取消。');
    signal?.addEventListener('abort', cancel, { once: true });
    const timer = setTimeout(cancel, TIMEOUT);
    try {
        const request = createGenerationParameters ? (await createGenerationParameters({
            ...connection, openai_max_tokens: TOKEN_LIMIT, bias_preset_selected: '', n: 1,
            enable_web_search: false, request_images: false,
        }, connection.model, 'quiet', messages)).generate_data : fallbackPayload(connection, messages);
        if (identifyProxy(request)?.key !== proxy.key)
            return result('unavailable', '酒馆组装的地址或模型与面板当前连接不一致。');
        if (customOverridesProbe(request, parseYAML))
            return result('unavailable', '自定义附加参数覆盖了测试用的模型、消息或生成字段。');
        // A quiet request is kept out of the regular chat diagnostic history.
        // Match the selected stream mode and send only the test messages.
        Object.assign(request, { type: 'quiet', messages, stream: connection.stream_openai === true,
            enable_web_search: false, request_images: false });
        for (const field of ['user_name', 'char_name', 'group_names', 'stop', 'tools', 'tool_choice', 'logit_bias', 'n'])
            delete request[field];
        if (abort.signal.aborted) return result('cancelled', '测试已取消。');
        const response = await fetchRequest(PROBE_PATH, { method: 'POST', body: JSON.stringify(request),
            headers: context.getRequestHeaders(), signal: abort.signal });
        const wire = await inspectResponse(response, { timeoutMs: TIMEOUT, maxBytes: 512 * 1024, signal: abort.signal,
            expectedStream: request.stream, classifyText });
        if (wire.prefillRejected) return result('rejected', '反代或上游明确拒绝了此回复前缀。');
        if (!response.ok || wire.apiError) return result('error', `测试请求失败（HTTP ${wire.apiStatus || wire.httpStatus}），前缀能力待确认。`);
        if (wire.protocolMismatch || wire.streamMessageEnvelope)
            return result('inconclusive', '反代回包格式与酒馆当前流式设置不匹配，前缀能力待确认。');
        if (!wire.responseComplete || wire.captureLimited || wire.aborted || wire.parseErrors || wire.blockReason || wire.refusal ||
            wire.missingTerminal || /LENGTH|MAX_TOKENS/i.test(wire.finishReason || ''))
            return result('inconclusive', '测试回包不完整或被中止，前缀能力待确认。');
        if (wire.textClassification === 'suffix')
            return result('passed', '测试返回了预期续写，已为这条反代启用预填充。', { approval: { key: proxy.key, method, evidence: 'test' } });
        if (wire.textClassification === 'full')
            return result('inconclusive', '反代返回了整段测试文本，无法确认它是否从前缀继续。');
        return result('inconclusive', '测试未取得预期续写，前缀能力待确认。');
    } catch {
        return result('error', signal?.aborted ? '测试已取消。'
            : '反代测试未完成，请检查酒馆连接。');
    } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', cancel);
        abort.abort();
    }
}
