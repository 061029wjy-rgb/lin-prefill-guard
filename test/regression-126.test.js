import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULTS as OBSERVE_DEFAULTS, DEFAULT_PREFILL, CONTINUE_PREFILL, planInjection, LIN_PROMPT_ID } from '../core.js';
const DEFAULTS = { ...OBSERVE_DEFAULTS, requestMode: 'enhance' };
import { analyzeOutput, endingDiagnosis, structureDiagnosis, textDigest } from '../structure.js';
import { recordStatus, recordDiagnosis, compareDelivery, shortReplyEvidence, requestMeta, responseDiagnosis } from '../diagnostics.js';
import { inspectResponse, installObserver } from '../observer.js';
import { createController } from '../controller.js';

const paragraph = '天色渐渐暗了下来，她把桌上的书放回书架，走到窗前看了一会儿街景。巷子里有人骑车经过，车铃响了两声。她回过头，把热茶放在桌角，等屋里的人收拾好书包，再一起去街口买晚饭。';
const cut = paragraph + '她拿起外套，转身对他说';
for (const [name, wrap] of [
    ['div', text => `<div>${text}</div>`],
    ['paragraph/span', text => `<section><p><span>${text}</span></p></section>`],
    ['styled wrapper', text => `<style>.prose { color: red; }</style><div class="prose">${text}</div>`],
    ['trailing details', text => `<div>${text}</div><details><summary>记录</summary>无变化。</details>`],
    ['nested details', text => `${text}<details>其他。<details>子项。</details></details>`],
    ['Lin components', text => `<Lin_header>当前场景。</Lin_header>${text}<Lin_schedule>安排。</Lin_schedule><Lin_theater>番外。</Lin_theater>`],
    ['prose after details', text => `<details>其他。</details><p>${text}</p>`],
]) test(`HTML wrappers do not hide unfinished prose: ${name}`, () => {
    const output = analyzeOutput(wrap(cut));
    assert.equal(output.ending.checked, true); assert.match(endingDiagnosis(output), /疑似句尾未完/);
    assert.equal(endingDiagnosis(analyzeOutput(wrap(paragraph))), '');
    assert.ok(!JSON.stringify(output).includes('外套'));
});
for (const value of ['   \n', '<div> &nbsp; </div>', '<content><p><br></p></content>']) {
    test(`blank markup is not treated as delivered prose: ${JSON.stringify(value)}`, () => {
        const output = analyzeOutput(value);
        assert.equal(output.noTextContent, true);
        assert.equal(recordStatus({ wire: { visibleChars: value.length, output, finishReason: 'STOP' } }).label, '尚无正文');
    });
}
test('media and fenced examples are not mislabeled as notes or empty tags', () => {
    for (const value of ['<!-- note --><img src="x">', '<svg></svg>', '```html\n<content>\n```']) {
        const output = analyzeOutput(value);
        assert.equal(output.onlyNotes, false); assert.equal(output.noTextContent, false);
        assert.deepEqual(output.openTags, []);
    }
});
test('misnested tags and stray closings are detected even if counts balance', () => {
    const output = analyzeOutput('<content><details>内容。</content></details>');
    assert.deepEqual(output.openTags, []); assert.equal(output.misnestedTags, 1);
    assert.match(structureDiagnosis(output), /顺序错误/);
    assert.equal(analyzeOutput('内容。</content>').orphanClosings, 1);
});
test('empty completed responses, refusals and protocol mismatches get different status', () => {
    assert.equal(recordStatus({ wire: { recognized: true, visibleChars: 0, responseComplete: true, finishReason: 'STOP' } }).label, '空响应·需排查');
    assert.equal(recordStatus({ wire: { visibleChars: 0, receivedBytes: 0, responseComplete: true } }).label, '空响应·需排查');
    assert.equal(recordStatus({ wire: { refusal: true, visibleChars: 0 } }).label, '接口拒答');
    assert.equal(recordStatus({ wire: { protocolMismatch: 'stream-request-non-sse', finishReason: 'STOP' } }).label, '响应协议异常');
});
test('the three reported short lengths are warnings, not automatic failure or refusal claims', () => {
    for (const size of [92, 176, 205]) {
        const record = { type: 'normal', deliveryProfile: { cotEnabled: true },
            wire: { responseComplete: true, finishReason: 'STOP', output: analyzeOutput('字'.repeat(size)) } };
        assert.equal(recordStatus(record).label, '短回复·请核对');
        assert.match(shortReplyEvidence(record), /不能据此认定空回或自动重试/);
        assert.equal(shortReplyEvidence({ ...record, deliveryProfile: { cotEnabled: false } }), '');
        assert.equal(shortReplyEvidence({ ...record, type: 'continue' }), '');
    }
});
test('digest comparison distinguishes identical text from equally long different text', async () => {
    const text = ' 确认文本。\n', same = await textDigest(text), different = await textDigest(' 内容不同。\n');
    assert.match(same, /^[a-f0-9]{64}$/); assert.notEqual(same, different);
    const record = { type: 'normal', wire: { visibleChars: text.length, responseComplete: true, textDigest: same },
        rendered: { output: analyzeOutput(text), textDigest: same } };
    assert.match(compareDelivery(record), /SHA-256 一致/);
    assert.match(compareDelivery({ ...record, rendered: { ...record.rendered, textDigest: different } }), /SHA-256 不一致/);
    assert.equal(compareDelivery({ ...record, type: 'continue' }), '');
    assert.equal(compareDelivery({ ...record, wire: { ...record.wire, captureLimited: true } }), '');
});
test('absence of browser crypto falls back to length-only evidence', async () => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
    try {
        Object.defineProperty(globalThis, 'crypto', { configurable: true, value: {} });
        assert.equal(await textDigest('text'), null);
    } finally { if (descriptor) Object.defineProperty(globalThis, 'crypto', descriptor); else delete globalThis.crypto; }
    assert.match(compareDelivery({ type: 'swipe', wire: { visibleChars: 4, responseComplete: true },
        rendered: { output: { rawChars: 4 }, textDigest: null } }), /长度一致/);
});
test('request counts and API error metadata retain neither raw request nor provider error text', async () => {
    const request = { messages: [{ content: 'PRIVATE_TEXT' }, { content: [{ type: 'text', text: 'hello' }, { type: 'image_url', image_url: { url: 'PRIVATE_URL' } }] }] };
    assert.equal(requestMeta(request).inputTextChars, 17);
    assert.ok(!JSON.stringify(requestMeta(request)).includes('PRIVATE'));
    const stats = await inspectResponse(new Response(JSON.stringify({ error: { code: 429, message: 'PRIVATE_ERROR' } }),
        { headers: { 'retry-after': '12' } }));
    assert.equal(stats.apiStatus, 429); assert.equal(stats.retryAfterSeconds, 12);
    assert.match(responseDiagnosis(stats), /12 秒/); assert.ok(!JSON.stringify(stats).includes('PRIVATE_ERROR'));
});
test('input token usage is retained independently of output and thinking tokens', async () => {
    const stats = await inspectResponse(new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: '完成。' }] }, finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 900, candidatesTokenCount: 3, thoughtsTokenCount: 20, totalTokenCount: 923 } })));
    assert.equal(stats.promptTokens, 900); assert.equal(stats.totalTokens, 923);
    assert.equal(stats.outputTokens, 3); assert.equal(stats.thoughtTokens, 20);
    assert.equal(stats.textDigest, await textDigest('完成。'));
});

function observerFixture(fetch) {
    const records = [], target = { location: { href: 'http://localhost/' }, fetch };
    const observer = installObserver({ target, enabled: () => true, onDispatch: () => 'id',
        onResponse: (_, wire) => records.push(wire), onError: (_, wire) => records.push(wire) });
    return { target, observer, records };
}
const endpoint = 'http://localhost/api/backends/chat-completions/generate';
test('Request-object observation leaves request bytes and response identity intact', async () => {
    let calls = 0, body;
    const response = new Response('{"choices":[{"message":{"content":"结果"},"finish_reason":"stop"}]}');
    const f = observerFixture(async req => { calls++; body = await req.text(); return response; });
    const payload = JSON.stringify({ stream: false, messages: [{ role: 'user', content: 'PRIVATE_INPUT' }] });
    const req = new Request(endpoint, { method: 'POST', body: payload });
    assert.equal(await f.target.fetch(req), response); assert.equal(await response.text(), '{"choices":[{"message":{"content":"结果"},"finish_reason":"stop"}]}');
    await f.observer.idle(); f.observer.dispose();
    assert.equal(calls, 1); assert.equal(body, payload); assert.equal(f.records[0].visibleChars, 2);
    assert.ok(!JSON.stringify(f.records).includes('PRIVATE_INPUT'));
});
test('request-body observation never holds up sending or receiving the original request', async () => {
    let bodyController, calls = 0;
    const req = new Request(endpoint, { method: 'POST', duplex: 'half', body: new ReadableStream({ start(c) { bodyController = c; } }) });
    const response = new Response('result'), f = observerFixture(async () => { calls++; return response; });
    const result = await f.target.fetch(req);
    assert.equal(calls, 1); assert.equal(result, response); assert.equal(await result.text(), 'result');
    bodyController.enqueue(new TextEncoder().encode('{"messages":[]}')); bodyController.close();
    await f.observer.idle(); f.observer.dispose();
});
test('unsupported body and failed fetch never trigger a second call', async () => {
    let calls = 0;
    const error = new TypeError('network failed');
    const f = observerFixture(async () => { calls++; throw error; });
    await assert.rejects(f.target.fetch(endpoint, { method: 'POST', body: new URLSearchParams({ a: 'b' }) }), e => e === error);
    await f.observer.idle(); f.observer.dispose(); assert.equal(calls, 1);
});
test('a Request clone beyond the observation limit does not truncate the original body', async () => {
    const payload = JSON.stringify({ messages: [{ content: 'x'.repeat(2 * 1024 * 1024 + 1) }] });
    let received;
    const f = observerFixture(async request => { received = await request.text(); return new Response('original'); });
    const result = await f.target.fetch(new Request(endpoint, { method: 'POST', body: payload }));
    assert.equal(await result.text(), 'original'); await f.observer.idle(); f.observer.dispose();
    assert.equal(received, payload); assert.equal(f.records.length, 0);
});
test('disposing a pending Request observation keeps the original request readable', async () => {
    let stream, received;
    const f = observerFixture(async request => { received = await request.text(); return new Response('original'); });
    const req = new Request(endpoint, { method: 'POST', duplex: 'half', body: new ReadableStream({ start(c) { stream = c; } }) });
    const work = f.target.fetch(req); f.observer.dispose();
    stream.enqueue(new TextEncoder().encode('{"messages":[]}')); stream.close();
    assert.equal(await (await work).text(), 'original'); await f.observer.idle();
    assert.equal(received, '{"messages":[]}'); assert.equal(f.records.length, 0);
});
test('a midstream abort is classified without discarding already observed text', async () => {
    const abort = new AbortController();
    const bytes = new TextEncoder().encode('data: {"choices":[{"delta":{"content":"部分文字"}}]}\n\n');
    let stream;
    const response = new Response(new ReadableStream({ start(c) { stream = c; c.enqueue(bytes); } }));
    const work = inspectResponse(response, { signal: abort.signal });
    await new Promise(resolve => setImmediate(resolve));
    abort.abort(); stream.error(new DOMException('Aborted', 'AbortError'));
    const stats = await work;
    assert.equal(stats.aborted, true); assert.equal(stats.visibleChars, 4);
    assert.equal(recordStatus({ wire: stats }).label, '请求已中止');
});

class Bus {
    listeners = new Map();
    on(e, fn) { this.listeners.set(e, [...(this.listeners.get(e) || []), fn]); }
    removeListener(e, fn) { this.listeners.set(e, (this.listeners.get(e) || []).filter(x => x !== fn)); }
    makeLast(e, fn) { this.removeListener(e, fn); this.on(e, fn); }
    async emit(e, ...args) { for (const fn of [...(this.listeners.get(e) || [])]) await fn(...args); }
}
function controllerFixture() {
    const bus = new Bus(), settings = { ...DEFAULTS, mode: 'pair' };
    const ctx = { eventSource: bus, eventTypes: { CHAT_COMPLETION_SETTINGS_READY: 'request', GENERATION_STARTED: 'start',
        MESSAGE_RECEIVED: 'message', GENERATION_ENDED: 'end', GENERATION_STOPPED: 'stop', CHAT_CHANGED: 'chat' },
        chat: [{ is_user: false, mes: '未完回复，' }],
        chatCompletionSettings: { prompts: [{ identifier: LIN_PROMPT_ID, role: 'assistant', content: '原承接' }],
            prompt_order: [{ character_id: 100001, order: [{ identifier: LIN_PROMPT_ID, enabled: true }] }] } };
    const target = { location: { href: 'http://localhost/' }, fetch: async () => new Response('{"choices":[{"message":{"content":"完整结果。"},"finish_reason":"STOP"}]}') };
    const controller = createController({ getContext: () => ctx, getSettings: () => settings, networkTarget: target });
    const request = type => ({ type: type || 'normal', model: 'gemini-4-argon', messages: [{ role: 'user', content: '写正文。' }, { role: 'assistant', content: '原承接' }] });
    const send = async req => { const response = await target.fetch(endpoint, { method: 'POST', body: JSON.stringify(req) }); await response.text(); await controller.idle(); };
    return { bus, ctx, settings, controller, request, send };
}
test('unassociated helper responses do not replace the story status or take its saved text', async () => {
    const f = controllerFixture(), req = f.request();
    await f.bus.emit('request', req); const id = f.controller.snapshot().last.id;
    await f.send({ type: 'normal', model: 'deepseek-flash', messages: [{ role: 'user', content: 'helper' }] });
    assert.equal(f.controller.snapshot().last.id, id);
    await f.send(req);
    f.ctx.chat.push({ is_user: false, mes: '完整结果。' }); await f.bus.emit('message', 1, 'normal');
    await f.send({ type: 'normal', model: 'deepseek-flash', messages: [{ role: 'user', content: 'helper again' }] });
    const view = f.controller.snapshot(); assert.equal(view.last.id, id); assert.equal(view.last.rendered.chars, 5);
    assert.match(recordDiagnosis(view.last), /SHA-256 一致/);
    assert.ok(view.history.filter(r => r.origin === 'unassociated').every(r => !r.rendered)); f.controller.dispose();
});
test('manual continuation is single-use and survives a duplicate click without changing settings', async () => {
    const f = controllerFixture(), before = JSON.stringify(f.settings); let release, calls = 0, sent;
    f.ctx.generate = async type => { calls++; await new Promise(resolve => { release = resolve; });
        sent = f.request(type); sent.messages.push({ role: 'user', content: '补全断点。' });
        await f.bus.emit('request', sent); };
    const plan = f.controller.prepareRecovery(), first = f.controller.runRecovery(plan, 'continue');
    assert.equal((await f.controller.runRecovery(plan, 'continue')).ok, false);
    release(); assert.equal((await first).ok, true); assert.equal(calls, 1);
    assert.ok(sent.messages.some(m => m.content.includes(CONTINUE_PREFILL)));
    assert.ok(!sent.messages.some(m => m.content.includes(DEFAULT_PREFILL)));
    const prepared = JSON.stringify(sent);
    await f.bus.emit('request', sent);
    assert.equal(JSON.stringify(sent), prepared); assert.equal(f.controller.snapshot().last.reason, 'already-present');
    assert.equal(JSON.stringify(f.settings), before);
    const ordinary = f.request('continue'), original = JSON.stringify(ordinary);
    await f.bus.emit('request', ordinary); assert.equal(JSON.stringify(ordinary), original); f.controller.dispose();
});
test('reloading retained history still favors the story over the newest helper call', async () => {
    const f = controllerFixture(), storage = new Map();
    f.ctx.accountStorage = { getItem: k => storage.get(k), setItem: (k, v) => storage.set(k, v) };
    const req = f.request(); await f.bus.emit('request', req); await f.send(req);
    const id = f.controller.snapshot().last.id;
    await f.send({ type: 'normal', model: 'deepseek-flash', messages: [{ role: 'user', content: 'helper' }] });
    f.controller.dispose();
    const restored = createController({ getContext: () => f.ctx, getSettings: () => f.settings, networkTarget: {} });
    assert.equal(restored.snapshot().last.id, id); assert.match(restored.snapshot().response, /接口文本字段/);
    restored.restoreHistory(); assert.equal(restored.snapshot().last.id, id); restored.dispose();
});
test('continuation preserves custom text and native/tool/structured request guards', () => {
    const req = { type: 'continue', messages: [{ role: 'user', content: '补全' }] };
    const settings = { ...DEFAULTS, scope: 'all', mode: 'pair', enhanceContinue: true, prefill: '用户自己的提示' };
    const result = planInjection(req, settings);
    assert.ok(result.injected.some(m => m.content.includes('用户自己的提示')));
    for (const extra of [{ assistant_prefill: 'prefix' }, { tools: [{ type: 'function', function: { name: 'f' } }] }, { response_format: { type: 'json_object' } }]) {
        const request = { ...req, ...extra }, before = JSON.stringify(request);
        assert.equal(planInjection(request, settings).changed, false); assert.equal(JSON.stringify(request), before);
    }
});
test('explicit stop remains visible after late transport completion and blocks stale message attribution', async () => {
    const f = controllerFixture(), req = f.request(); await f.bus.emit('start', 'normal'); await f.bus.emit('request', req);
    await f.bus.emit('stop'); await f.send(req);
    f.ctx.chat.push({ is_user: false, mes: '部分回复' }); await f.bus.emit('message', 1, 'normal');
    assert.equal(recordStatus(f.controller.snapshot().last).label, '客户端已停止');
    assert.equal(f.controller.snapshot().last.rendered, undefined); assert.equal(f.controller.snapshot().generating, false);
    f.controller.dispose();
});
test('a diagnostic planning exception leaves the outgoing payload untouched', async () => {
    const f = controllerFixture(), req = f.request();
    // A malformed setting fails the audit after the injection plan has been built.
    f.ctx.chatCompletionSettings.openai_max_context = { valueOf() { throw new Error('invalid setting'); } };
    const before = JSON.stringify(req); await f.bus.emit('request', req);
    assert.equal(JSON.stringify(req), before); assert.equal(f.controller.snapshot().last.reason, 'internal-error'); f.controller.dispose();
});
test('late saved-text hashing cannot overwrite evidence after an edit or chat switch', async () => {
    const f = controllerFixture(); await f.bus.emit('request', f.request());
    f.ctx.chat.push({ is_user: false, mes: 'first saved reply' });
    const first = f.bus.emit('message', 1, 'normal');
    f.ctx.chat[1].mes = 'new saved reply'; await first;
    assert.equal(f.controller.snapshot().last.rendered, undefined);
    const second = f.bus.emit('message', 1, 'normal');
    f.ctx.chat = [{ is_user: false, mes: 'another chat' }]; await f.bus.emit('chat'); await second;
    assert.equal(f.controller.snapshot().last.rendered, undefined); f.controller.dispose();
});
