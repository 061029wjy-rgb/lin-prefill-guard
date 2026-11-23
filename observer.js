/** Read-only observation of ST's single chat endpoint. Never retries or rewrites a response. */
import { analyzeOutput, textDigest } from './structure.js?v=1.4.2';
import { observeConsumed } from './wire-response.js?v=1.4.2';
const textBuffers = new WeakMap();
const textValue = value => typeof value === 'string' ? value : Array.isArray(value)
    ? value.filter(p => p && !p.thought && (p.type==null||p.type==='text'||p.type==='output_text')).map(p => typeof p?.text === 'string' ? p.text : '').join('') : '';
function observeText(stats, value, snapshot = false) {
    const text = textValue(value);
    const previous = textBuffers.get(stats) || '';
    // Some adapters end with message.content=null/"" plus a finish reason.
    // That frame does not retract text already delivered in previous deltas.
    if (snapshot && !text && previous) { stats.emptyFinalSnapshot = true; return; }
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
    if (data.error) {
        stats.apiError = true; stats.recognized = true;
        // Fixed categories only; never export arbitrary provider error messages.
        const status = Number(data.error?.code ?? data.error?.status);
        if (Number.isInteger(status) && status >= 400 && status <= 599) stats.apiStatus = status;
    }
    if (data.promptFeedback?.blockReason) { stats.recognized = true; stats.blockReason = safeCode(data.promptFeedback.blockReason); }
    if (data.candidates?.length>1 || data.choices?.length>1) stats.multipleCandidates=true;
    const candidate = data.candidates?.find(c=>(c.index??0)===0);
    if (candidate) {
        stats.recognized = true;
        for (const p of candidate.content?.parts || []) {
            if (p.thought) stats.reasoningChars += chars(p.text);
            else observeText(stats, p.text);
            if (p.functionCall) stats.toolCalls = true;
        }
        if (candidate.finishReason) stats.finishReason = safeCode(candidate.finishReason);
        if (typeof candidate.continuationToken === 'string' && candidate.continuationToken.length > 0
            || typeof candidate.continuation_token === 'string' && candidate.continuation_token.length > 0)
            stats.continuationTokenSeen = true;
    }
    const choice = data.choices?.find(c => c.index === 0) || data.choices?.[0];
    if (choice && (choice.index === undefined || choice.index === 0)) {
        stats.recognized = true;
        const message = choice.delta || choice.message || {};
        if (!choice.delta && choice.message) stats.messageEnvelopes = (stats.messageEnvelopes || 0) + 1;
        if (message.content !== undefined || choice.text !== undefined) observeText(stats, message.content ?? choice.text, !choice.delta && !!choice.message);
        stats.reasoningChars += chars(message.reasoning_content ?? message.reasoning);
        if (message.refusal || Array.isArray(message.content)&&message.content.some(x=>x?.type==='refusal')) stats.refusal = true;
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
    const prompt = usage?.promptTokenCount ?? usage?.prompt_tokens ?? usage?.input_tokens;
    const total = usage?.totalTokenCount ?? usage?.total_tokens;
    if (typeof thought === 'number' || typeof output === 'number') {
        const kind = usage === data.usageMetadata && (usage?.candidatesTokenCount != null || usage?.thoughtsTokenCount != null)
            ? 'google' : 'other';
        stats.usageKind = stats.usageKind && stats.usageKind !== kind ? 'mixed' : kind;
    }
    if (typeof thought === 'number') stats.thoughtTokens = thought;
    if (typeof output === 'number') stats.outputTokens = output;
    if (typeof prompt === 'number') stats.promptTokens = prompt;
    if (typeof total === 'number') stats.totalTokens = total;
    const cached=usage?.cachedContentTokenCount??usage?.prompt_tokens_details?.cached_tokens;
    if(Number.isFinite(cached))stats.cacheReadTokens=cached;
}

export async function inspectResponse(response, { maxBytes = MAX_BYTES, timeoutMs = MAX_MS, expectedStream, signal,
    register = () => () => {}, onVisible, needle = '', sampleNeedle = '' } = {}) {
    const started = Date.now();
    const rawType = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    // Store only a MIME type, never arbitrary headers, text, URLs, or error messages.
    const contentType = /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(rawType) ? rawType.slice(0, 80) : 'missing';
    const stats = { httpStatus: response.status, contentType, expectedStream,
        visibleChars: 0, reasoningChars: 0, recognized: false, parseErrors: 0,
        receivedBytes: 0, networkReads: 0, maxGapMs: 0, transport: 'unknown', frames: 0, doneMarker: false, responseComplete: false };
    const retry = Number(response.headers.get('retry-after'));
    if (response.headers.has('retry-after') && Number.isFinite(retry) && retry >= 0 && retry <= 86400) stats.retryAfterSeconds = retry;
    if (!response.body) { stats.responseComplete = true; stats.output = analyzeOutput(''); return stats; }
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
        // Snapshot at the end of reading; unrelated host cleanup during the
        // asynchronous digest must not relabel an already completed response.
        if (signal?.aborted) stats.aborted = true;
        const visible=textBuffers.get(stats)||'';
        stats.output = analyzeOutput(visible);
        if(needle)stats.anchorEcho=visible.includes(needle);
        if(sampleNeedle)stats.sampleEcho=visible.includes(sampleNeedle);
        if(onVisible)onVisible(visible);
        stats.textDigest = await textDigest(textBuffers.get(stats) || '');
        textBuffers.delete(stats);
    }
    if(stats.transport==='sse' && stats.doneMarker && !stats.finishReason)stats.doneWithoutReason=true;
    if (expectedStream === true && ['json', 'ndjson'].includes(stats.transport)) stats.protocolMismatch = 'stream-request-non-sse';
    if (expectedStream === false && stats.transport === 'sse') stats.protocolMismatch = 'json-request-sse';
    if (stats.transport === 'sse' && stats.messageEnvelopes) stats.streamMessageEnvelope = true;
    if (stats.transport === 'sse' && stats.responseComplete && stats.recognized
        && !stats.finishReason && !stats.doneMarker && !stats.providerEnd && !stats.blockReason && !stats.apiError) stats.missingTerminal = true;
    return stats;
}

export function installObserver({ target = globalThis, enabled, onDispatch, onResponse, onError, coordinator, onVisible }) {
    const original = target.fetch;
    let active = true;
    const readers = new Set();
    const tasks = new Set();
    if (typeof original !== 'function') return { available: false, dispose() {}, idle: async () => {} };
    function track(task) {
        tasks.add(task);
        task.finally(() => tasks.delete(task)).catch(() => {});
    }
    async function requestBody(input) {
        const reader = input.clone().body?.getReader();
        if (!reader) return null;
        let stopped = false, size = 0, text = '';
        const decoder = new TextDecoder();
        const cancel = () => { stopped = true; reader.cancel().catch(() => {}); };
        readers.add(cancel);
        // Limits affect observation only. Never delay/abort the actual fetch.
        const timer = setTimeout(cancel, 5000);
        try {
            while (!stopped) {
                const { done, value } = await reader.read();
                if (done) return stopped ? null : text + decoder.decode();
                size += value.byteLength;
                if (size > MAX_BYTES) { cancel(); return null; }
                text += decoder.decode(value, { stream: true });
            }
            return null;
        } catch { return null; }
        finally { clearTimeout(timer); readers.delete(cancel); reader.releaseLock(); }
    }
    async function wrapped(input, init) {
        if(!active)return original.apply(this,arguments);
        let id;
        let dispatch;
        let managed=null, sendInit=init, transport;
        let expectedStream;
        const signal = init?.signal || input?.signal;
        function observeRequest(body) {
            try {
                const request = body === null ? null : JSON.parse(body);
                if (request && active) {
                    expectedStream = typeof request.stream === 'boolean' ? request.stream : undefined;
                    managed=coordinator?.before(request,body) || null;
                    if(managed){
                        id=managed.id;
                        if(typeof managed.body==='string' && init){sendInit=Object.create(init);Object.defineProperty(sendInit,'body',{value:managed.body,enumerable:true});}
                        // This separate layer may only replace the request headers. A failure keeps
                        // sendInit and its already verified legacy body; original fetch is called exactly once.
                        if(managed.transport){try{const step=managed.transport(sendInit,input,init);sendInit=step.init;transport=step.why;}
                            catch{transport='rollback';}}
                    } else id = onDispatch(request);
                }
            } catch { /* Unsupported request shapes pass through unchanged. */ }
        }
        try {
            const base = target.location?.href || 'http://localhost/';
            const url = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url, base);
            if (active && enabled() && url.origin === new URL(base).origin && url.pathname === ENDPOINT && !url.search && !url.hash && !url.username && !url.password
                && String(init?.method || input?.method || 'GET').toUpperCase() === 'POST') {
                // Request objects are used by some host branches. Clone only for
                // read-only inspection; never consume or replace their body.
                if (typeof init?.body === 'string' && init.body.length<=4*1024*1024) observeRequest(init.body);
                else if(coordinator?.belongs()){managed={managed:true};coordinator.unavailable(typeof init?.body==='string'?'too-large':'request-object');}
                else if (init?.body === undefined && typeof input?.clone === 'function')
                    dispatch = requestBody(input).then(observeRequest);
            }
        } catch { /* Unsupported request shapes pass through unchanged. */ }
        let response;
        const sent = Date.now();
        try {
            const actual=original.call(this,input,sendInit);
            try{managed?.sent?.(transport);}catch{}
            response=await actual;
        }
        catch (error) {
            const report = () => { if (id && active && (!managed || managed.valid?.())) { try { onError(id, { aborted: error?.name === 'AbortError', networkError: error?.name !== 'AbortError' }); } catch { /* isolated */ } } };
            if (dispatch) track(dispatch.then(report)); else report();
            throw error;
        }
        if(managed){
            try {
                if(!managed.valid?.())return response;
                managed.receipt?.();
                if(!managed.capture||!active||!response.body){
                    if(managed.capture&&id&&active)onResponse(id,{httpStatus:response.status,responseComplete:true,receivedBytes:0,visibleChars:0});
                    return response;
                }
                const status=response.status;
                return observeConsumed(response,{live:()=>active&&managed.valid(),failed:stats=>onError(id,{httpStatus:status,...stats}),
                    finish(chunks,timing){
                        const headers={};for(const k of ['content-type','retry-after']){const v=response.headers.get(k);if(v)headers[k]=v;}
                        const copy=new Response(new Blob(chunks),{status,headers});
                        let recovered='';
                        track(inspectResponse(copy,{expectedStream,signal,needle:managed.needle,sampleNeedle:managed.sampleNeedle,
                          onVisible:managed.passive? s=>{recovered=s;}:undefined}).then(stats=>{
                            if(!active||!managed.valid())return;
                            if(managed.passive && status>=200&&status<300 && stats.recognized && !stats.apiError && !stats.blockReason && !stats.refusal &&
                                !stats.multipleCandidates && !stats.toolCalls && !stats.aborted && !stats.captureLimited && !stats.parseErrors &&
                                !stats.protocolMismatch && !stats.incomplete && /^(stop|end_turn|stop_sequence)$/i.test(stats.finishReason||'') && recovered)
                                onVisible?.(id,recovered);
                            onResponse(id,{...stats,...timing,totalDurationMs:Date.now()-sent});
                        }).catch(()=>{if(active&&managed.valid())onError(id,{httpStatus:status,captureLimited:true});}));
                    }});
            } catch {return response;}
        }
        if ((id || dispatch) && active) {
            try {
                const copy = response.clone();
                const task = Promise.resolve(dispatch).then(async () => {
                    if (!id || !active) { copy.body?.cancel().catch(() => {}); return; }
                    const stats = await inspectResponse(copy, {
                        expectedStream, signal,
                        register(cancel) { readers.add(cancel); return () => readers.delete(cancel); },
                    });
                    if (active) onResponse(id, { ...stats, totalDurationMs: Date.now() - sent });
                }).catch(() => {
                    if (id && active) onError(id, { captureLimited: true });
                });
                track(task);
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
