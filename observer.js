/** Read-only observation of ST's single chat endpoint. Never retries or rewrites a response. */
import { analyzeOutput } from './structure.js?v=1.2.2';
const textBuffers = new WeakMap();
const textValue = value => typeof value === 'string' ? value : Array.isArray(value)
    ? value.filter(p => !p?.thought && p?.type !== 'thinking').map(p => typeof p?.text === 'string' ? p.text : '').join('') : '';
function observeText(stats, value, snapshot = false) {
    const text = textValue(value);
    const previous = textBuffers.get(stats) || '';
    const combined = snapshot ? text : previous + text;
    textBuffers.set(stats, combined);
    stats.visibleChars = combined.length; // Legacy field: raw text, not visible story prose.
}
const ENDPOINT = '/api/backends/chat-completions/generate';
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_MS = 600000;
const safeCode = value => typeof value === 'string' ? value.replace(/[^a-zA-Z0-9_.:-]/g, '').slice(0, 100) : '';
const chars = value => typeof value === 'string' ? value.length : Array.isArray(value)
    ? value.reduce((n, p) => n + (typeof p?.text === 'string' ? p.text.length : 0), 0) : 0;

export function addResponseData(stats, data) {
    if (!data || typeof data !== 'object') return;
    if (Array.isArray(data)) { data.forEach(item => addResponseData(stats, item)); return; }
    if (data.error) { stats.apiError = true; stats.recognized = true; }
    if (data.promptFeedback?.blockReason) { stats.recognized = true; stats.blockReason = safeCode(data.promptFeedback.blockReason); }
    const candidate = data.candidates?.[0];
    if (candidate) {
        stats.recognized = true;
        for (const p of candidate.content?.parts || []) {
            if (p.thought) stats.reasoningChars += chars(p.text);
            else observeText(stats, p.text);
            if (p.functionCall) stats.toolCalls = true;
        }
        if (candidate.finishReason) stats.finishReason = safeCode(candidate.finishReason);
    }
    const choice = data.choices?.find(c => c.index === 0) || data.choices?.[0];
    if (choice && (choice.index === undefined || choice.index === 0)) {
        stats.recognized = true;
        const message = choice.delta || choice.message || {};
        if (!choice.delta && choice.message) stats.messageEnvelopes = (stats.messageEnvelopes || 0) + 1;
        if (message.content !== undefined || choice.text !== undefined) observeText(stats, message.content ?? choice.text, !choice.delta && !!choice.message);
        stats.reasoningChars += chars(message.reasoning_content ?? message.reasoning);
        if (message.refusal) stats.refusal = true;
        if (message.tool_calls?.length || message.function_call) stats.toolCalls = true;
        if (choice.finish_reason) stats.finishReason = safeCode(choice.finish_reason);
    }
    // Anthropic native SSE and non-streaming messages.
    if (data.type === 'content_block_delta') {
        stats.recognized = true;
        observeText(stats, data.delta?.text);
        stats.reasoningChars += chars(data.delta?.thinking);
    }
    if (data.type === 'content_block_start' && data.content_block) {
        stats.recognized = true;
        if (data.content_block.type === 'tool_use') stats.toolCalls = true;
        observeText(stats, data.content_block.text);
        stats.reasoningChars += chars(data.content_block.thinking);
    }
    if (data.type === 'message' && Array.isArray(data.content)) {
        stats.recognized = true;
        observeText(stats, data.content, true);
        for (const p of data.content) {
            stats.reasoningChars += chars(p.thinking);
            if (p.type === 'tool_use') stats.toolCalls = true;
        }
    }
    if (data.type === 'message_stop') stats.providerEnd = true;
    if (data.delta?.stop_reason || data.stop_reason) stats.finishReason = safeCode(data.delta?.stop_reason || data.stop_reason);
    if (data.status === 'incomplete') stats.incomplete = true;
    const usage = data.usageMetadata || data.usage || data.message?.usage;
    const thought = usage?.thoughtsTokenCount ?? usage?.completion_tokens_details?.reasoning_tokens ?? usage?.output_tokens_details?.reasoning_tokens ?? usage?.total_thought_tokens;
    const output = usage?.candidatesTokenCount ?? usage?.completion_tokens ?? usage?.output_tokens ?? usage?.total_output_tokens;
    if (typeof thought === 'number') stats.thoughtTokens = thought;
    if (typeof output === 'number') stats.outputTokens = output;
}

export async function inspectResponse(response, { maxBytes = MAX_BYTES, timeoutMs = MAX_MS, expectedStream,
    register = () => () => {} } = {}) {
    const started = Date.now();
    const rawType = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    // Store only a MIME type, never arbitrary headers, text, URLs, or error messages.
    const contentType = /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(rawType) ? rawType.slice(0, 80) : 'missing';
    const stats = { httpStatus: response.status, contentType, expectedStream,
        visibleChars: 0, reasoningChars: 0, recognized: false, parseErrors: 0,
        receivedBytes: 0, networkReads: 0, maxGapMs: 0, transport: 'unknown', frames: 0, doneMarker: false, responseComplete: false };
    if (!response.body) return stats;
    const reader = response.body.getReader();
    let stopped = false;
    const cancel = () => { stopped = true; reader.cancel().catch(() => {}); };
    const unregister = register(cancel);
    const timer = setTimeout(() => { stats.captureLimited = true; stats.limitReason = 'time'; cancel(); }, timeoutMs);
    const decoder = new TextDecoder();
    let lastRead = null;
    let buffer = '';
    let dataLines = [];
    function parse(text) {
        if (!text.trim()) return;
        // A stream terminator alone does not identify the provider's payload format.
        if (text.trim() === '[DONE]') { stats.doneMarker = true; return; }
        try { addResponseData(stats, JSON.parse(text)); } catch { stats.parseErrors++; }
    }
    function frame() {
        if (dataLines.length) { stats.frames++; parse(dataLines.join('\n')); dataLines = []; }
    }
    function line(text) {
        if (!text) { frame(); return; }
        if (text.startsWith('data:')) dataLines.push(text.slice(5).replace(/^ /, ''));
        else if (text === 'data') dataLines.push('');
    }
    function drain(final = false) {
        if (stats.transport === 'unknown') {
            const head = buffer.replace(/^\uFEFF/, '').trimStart();
            // Sniff actual framing. ST's proxy need not forward Content-Type; a
            // proxy may also label SSE as JSON, or send JSON to a streaming request.
            if (/^(?:data:|event:|id:|retry:|:)/.test(head)) {
                stats.transport = 'sse'; buffer = head;
            } else if (/^[{[]/.test(head)) { stats.transport = 'json'; buffer = head; }
            else if (final && head) { stats.transport = 'unrecognized'; parse(head); buffer = ''; }
        }
        if (stats.transport !== 'sse') return;
        let end;
        while ((end = buffer.search(/[\r\n]/)) >= 0) {
            if (!final && buffer[end] === '\r' && end === buffer.length - 1) break;
            line(buffer.slice(0, end));
            const size = buffer[end] === '\r' && buffer[end + 1] === '\n' ? 2 : 1;
            buffer = buffer.slice(end + size);
        }
        if (final) { if (buffer) line(buffer); buffer = ''; frame(); }
    }
    try {
        while (!stopped) {
            const { done, value } = await reader.read();
            if (done) { if (!stopped) stats.responseComplete = true; break; }
            stats.receivedBytes += value.byteLength;
            const now = Date.now();
            stats.networkReads++;
            if (stats.firstByteMs === undefined) stats.firstByteMs = now - started;
            if (lastRead !== null) stats.maxGapMs = Math.max(stats.maxGapMs, now - lastRead);
            lastRead = now;
            if (stats.receivedBytes > maxBytes) { stats.captureLimited = true; stats.limitReason = 'bytes'; cancel(); break; }
            buffer += decoder.decode(value, { stream: true });
            drain();
        }
        if (!stopped) {
            buffer += decoder.decode();
            drain(true);
            if (stats.transport === 'json') {
                // NDJSON is observed for diagnosis only; do not rewrite it for ST.
                try { addResponseData(stats, JSON.parse(buffer)); }
                catch {
                    const lines = buffer.trim().split(/\r?\n/).filter(x => x.trim());
                    if (lines.length > 1 && lines.every(x => { try { JSON.parse(x); return true; } catch { return false; } })) {
                        stats.transport = 'ndjson'; lines.forEach(parse);
                    } else stats.parseErrors++;
                }
            }
        }
    } catch { stats.captureLimited = true; stats.limitReason = 'read-error'; }
    finally {
        clearTimeout(timer); unregister(); reader.releaseLock(); stats.durationMs = Date.now() - started;
        stats.output = analyzeOutput(textBuffers.get(stats) || '');
        textBuffers.delete(stats);
    }
    if (expectedStream === true && ['json', 'ndjson'].includes(stats.transport)) stats.protocolMismatch = 'stream-request-non-sse';
    if (expectedStream === false && stats.transport === 'sse') stats.protocolMismatch = 'json-request-sse';
    if (stats.transport === 'sse' && stats.messageEnvelopes) stats.streamMessageEnvelope = true;
    if (stats.transport === 'sse' && stats.responseComplete && stats.recognized
        && !stats.finishReason && !stats.doneMarker && !stats.providerEnd && !stats.blockReason && !stats.apiError) stats.missingTerminal = true;
    return stats;
}

export function installObserver({ target = globalThis, enabled, onDispatch, onResponse, onError }) {
    const original = target.fetch;
    let active = true;
    const readers = new Set();
    const tasks = new Set();
    if (typeof original !== 'function') return { available: false, dispose() {}, idle: async () => {} };
    async function wrapped(input, init) {
        let id;
        let expectedStream;
        try {
            const base = target.location?.href || 'http://localhost/';
            const url = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url, base);
            if (active && enabled() && url.origin === new URL(base).origin && url.pathname === ENDPOINT
                && String(init?.method || input?.method || 'GET').toUpperCase() === 'POST'
                && typeof init?.body === 'string') {
                const request = JSON.parse(init.body);
                expectedStream = typeof request.stream === 'boolean' ? request.stream : undefined;
                id = onDispatch(request);
            }
        } catch { /* Unsupported request shapes pass through unchanged. */ }
        let response;
        try { response = await original.call(this, input, init); }
        catch (error) {
            if (id && active) { try { onError(id, { aborted: error?.name === 'AbortError', networkError: error?.name !== 'AbortError' }); } catch { /* isolated */ } }
            throw error;
        }
        if (id && active) {
            try {
                const task = inspectResponse(response.clone(), {
                    expectedStream,
                    register(cancel) { readers.add(cancel); return () => readers.delete(cancel); },
                }).then(stats => { if (active) onResponse(id, stats); }).catch(() => {
                    if (active) onError(id, { captureLimited: true });
                });
                tasks.add(task);
                task.finally(() => tasks.delete(task)).catch(() => {});
            } catch { try { onError(id, { captureLimited: true }); } catch { /* isolated */ } }
        }
        return response;
    }
    try { target.fetch = wrapped; }
    catch { return { available: false, dispose() {}, idle: async () => {} }; }
    return {
        available: true,
        idle: () => Promise.allSettled([...tasks]),
        dispose() {
            active = false;
            for (const cancel of readers) cancel();
            readers.clear();
            // Preserve a later extension's wrapper. Our retained inner wrapper becomes inert.
            if (target.fetch === wrapped) target.fetch = original;
        },
    };
}
