import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { inspectResponse, installObserver } from '../observer.js';
import { hasApiError, recordStatus, recordDiagnosis, responseDiagnosis, formatRecord, compactStreamEvidence } from '../diagnostics.js';
import { isGemini4Segment } from '../gemini4.js';
import { createRecovery } from '../recovery.js';
import { createController } from '../controller.js';

const failure = { httpStatus: 200, apiError: true, apiStatus: 503, aborted: true,
    visibleChars: 0, responseComplete: true, recognized: true };

for (const clientStopped of [false, true]) {
    test(`an upstream 503 outranks a subsequent abort or stop event (${clientStopped})`, () => {
        const r = { type: 'normal', clientStopped, wire: { ...failure } };
        assert.equal(recordStatus(r).label, '请求失败');
        assert.match(recordDiagnosis(r).split('\n')[0], /HTTP 200.*上游错误 503/);
        assert.match(responseDiagnosis(r.wire), /上游服务暂时不可用/);
    });
}
for (const [wire, label, pattern] of [
    [{ finishReason: 'SAFETY' }, '服务端限制', /SAFETY/],
    [{ blockReason: 'PROHIBITED_CONTENT' }, '服务端限制', /PROHIBITED_CONTENT/],
    [{ refusal: true }, '接口拒答', /拒绝字段/],
]) test(`provider result survives client error cleanup: ${label}`, () => {
    const r = { clientStopped: true, wire: { ...wire, aborted: true, captureLimited: true } };
    assert.equal(recordStatus(r).label, label);
    assert.match(recordDiagnosis(r).split('\n')[0], pattern);
});

test('transport-only interruption does not invent a provider error or a manual stop', () => {
    assert.equal(hasApiError(null), false);
    assert.equal(recordStatus({ wire: { aborted: true } }).label, '请求已中止');
    assert.equal(recordStatus({ clientStopped: true }).label, '客户端已停止');
    assert.match(responseDiagnosis({ aborted: true }), /不能区分手动停止/);
    assert.doesNotMatch(responseDiagnosis({ aborted: true }), /接口错误|503/);
    assert.match(responseDiagnosis({ httpStatus: 429, retryAfterSeconds: 12 }), /限流或配额不足.*12 秒/);
});

test('error SSE is passed through unchanged and retained despite an aborted host signal', async () => {
    const abort = new AbortController(); abort.abort();
    const body = 'data: ' + JSON.stringify({ error: { code: 503, message: 'PRIVATE_PROVIDER_ERROR' } }) + '\n\ndata: [DONE]\n\n';
    const response = new Response(body, { headers: { 'content-type': 'text/event-stream' } });
    let calls = 0, wire;
    const target = { location: { href: 'http://localhost/' }, fetch: async () => { calls++; return response; } };
    const observer = installObserver({ target, enabled: () => true, onDispatch: () => 'r',
        onResponse: (_, value) => { wire = value; }, onError: () => assert.fail('unexpected failure') });
    try {
        const original = await target.fetch('/api/backends/chat-completions/generate', {
            method: 'POST', signal: abort.signal,
            body: JSON.stringify({ stream: true, messages: [{ role: 'user', content: 'PRIVATE_INPUT' }] }),
        });
        assert.equal(original, response); assert.equal(await original.text(), body); await observer.idle();
        assert.equal(calls, 1); assert.equal(wire.apiStatus, 503); assert.equal(wire.aborted, true);
        assert.equal(recordStatus({ wire }).label, '请求失败');
        assert.doesNotMatch(JSON.stringify(wire), /PRIVATE/);
    } finally { observer.dispose(); }
});

test('aborting during the final digest cannot relabel a completed response', async t => {
    const abort = new AbortController();
    const digest = async (_, bytes) => { abort.abort(); return createHash('sha256').update(bytes).digest(); };
    t.mock.method(globalThis.crypto.subtle, 'digest', digest);
    const wire = await inspectResponse(new Response(JSON.stringify({ choices: [{ message: { content: '完成。' }, finish_reason: 'stop' }] })), { signal: abort.signal });
    assert.equal(abort.signal.aborted, true); assert.equal(wire.responseComplete, true);
    assert.equal(wire.aborted, undefined); assert.equal(wire.visibleChars, 3);
});

for (const model of ['gemini-4-carbon', 'gemini-4-argon']) {
    for (const requestMode of ['observe', 'enhance', 'gemini4']) {
        test(`${model} continuation is recognized in ${requestMode} mode without injection metadata`, async () => {
            const r = { requestMode, request: { model, source: 'makersuite' }, wire: { finishReason: 'CONTINUATION', aborted: true } };
            assert.equal(isGemini4Segment(r), true); assert.equal(recordStatus(r).label, '上游要求续传');
            assert.match(responseDiagnosis(r.wire), /凭据续传/);
            const f = recoveryFixture(r);
            assert.equal(f.recovery.prepare().ok, false); assert.equal(f.calls.length, 0);
            r.wire.finishReason = 'STOP'; assert.equal(f.recovery.prepare().ok, true);
            const plan = f.recovery.prepare(); r.wire.finishReason = 'CONTINUATION';
            assert.equal((await f.recovery.run(plan, 'continue')).ok, false); assert.equal(f.calls.length, 0);
        });
    }
}

function recoveryFixture(record = null) {
    const calls = [], state = { record };
    const ctx = { chat: [{ mes: '部分回复' }], mainApi: 'openai', generate: async type => { calls.push(type); } };
    const recovery = createRecovery({ getContext: () => ctx, getRecord: () => state.record });
    return { recovery, state, calls };
}
test('an explicit interface error permits a manual regenerate, but cannot be continued as prose', async () => {
    const f = recoveryFixture({ wire: failure }), plan = f.recovery.prepare();
    assert.equal(plan.ok, true); assert.equal(plan.canContinue, false); assert.match(plan.message, /接口错误/);
    assert.equal((await f.recovery.run(plan, 'continue')).ok, false); assert.deepEqual(f.calls, []);
    assert.equal((await f.recovery.run(plan, 'regenerate')).ok, true); assert.deepEqual(f.calls, ['regenerate']);
});
test('a late error invalidates continuation immediately before the explicit action', async () => {
    const f = recoveryFixture(), plan = f.recovery.prepare();
    assert.equal(plan.canContinue, true); f.state.record = { wire: failure };
    assert.equal((await f.recovery.run(plan, 'continue')).ok, false); assert.deepEqual(f.calls, []);
});
test('actual partial model text before a later API error remains eligible for manual continuation', async () => {
    const f = recoveryFixture({ wire: { ...failure, visibleChars: 4 } });
    const plan = f.recovery.prepare(); assert.equal(plan.canContinue, true);
    assert.equal((await f.recovery.run(plan, 'continue')).ok, true); assert.deepEqual(f.calls, ['continue']);
});

test('a saved host placeholder after an observed 503 cannot become a recovery prefix', async () => {
    const events = new Map(), bus = { on: (e, f) => events.set(e, f), removeListener: e => events.delete(e), makeLast() {} };
    const calls = [];
    const ctx = { eventSource: bus, eventTypes: { CHAT_COMPLETION_SETTINGS_READY: 'request', MESSAGE_RECEIVED: 'message' },
        chat: [], chatCompletionSettings: {}, mainApi: 'openai', generate: async type => { calls.push(type); } };
    const target = { location: { href: 'http://localhost/' }, fetch: async () => new Response(JSON.stringify({ error: { code: 503 } })) };
    const c = createController({ getContext: () => ctx, getSettings: () => ({ requestMode: 'observe' }), networkTarget: target });
    try {
        const req = { type: 'normal', messages: [{ role: 'user', content: '普通请求' }] };
        events.get('request')(req);
        ctx.chat.push({ mes: '...' }); await events.get('message')(0, 'normal');
        const plan = c.prepareRecovery(); assert.equal(plan.canContinue, true);
        const response = await target.fetch('/api/backends/chat-completions/generate', { method: 'POST', body: JSON.stringify(req) });
        await response.text(); await c.idle();
        assert.equal(c.prepareRecovery().canContinue, false);
        assert.equal((await c.runRecovery(plan, 'continue')).ok, false);
        assert.deepEqual(calls, []); assert.equal(ctx.chat[0].mes, '...');
    } finally { c.dispose(); }
});

test('stop events cannot hide a late 503 in the controller or cause a follow-up request', async () => {
    const events = new Map(), bus = { on: (e, f) => events.set(e, f), removeListener: e => events.delete(e), makeLast() {} };
    const ctx = { eventSource: bus, eventTypes: { CHAT_COMPLETION_SETTINGS_READY: 'request', GENERATION_STOPPED: 'stop' }, chat: [], chatCompletionSettings: {} };
    let calls = 0;
    const target = { location: { href: 'http://localhost/' }, fetch: async () => { calls++; return new Response(JSON.stringify({ error: { code: 503 } })); } };
    const c = createController({ getContext: () => ctx, getSettings: () => ({ requestMode: 'observe' }), networkTarget: target });
    try {
        const req = { type: 'normal', model: 'gemini-4-carbon', chat_completion_source: 'vertexai', messages: [{ role: 'user', content: '普通请求' }] };
        const before = JSON.stringify(req); events.get('request')(req); events.get('stop')();
        const response = await target.fetch('/api/backends/chat-completions/generate', { method: 'POST', body: JSON.stringify(req) });
        await response.text(); await c.idle();
        assert.equal(recordStatus(c.snapshot().last).label, '请求失败');
        assert.match(c.snapshot().response.split('\n')[0], /503/);
        assert.equal(JSON.stringify(req), before); assert.equal(calls, 1); assert.deepEqual(ctx.chat, []);
    } finally { c.dispose(); }
});

test('connection labels identify the observed boundary without exporting endpoints', () => {
    for (const [source, label] of [['makersuite', 'Google AI Studio'], ['vertexai', 'Vertex AI'], ['custom', '自定义接口']]) {
        assert.ok(formatRecord({ request: { source } }).includes(`连接来源：${label}`));
    }
    const r = { request: { source: 'makersuite' }, dispatch: { request: { source: 'vertexai' } } };
    assert.match(formatRecord(r), /连接来源：Vertex AI/);
    assert.doesNotMatch(formatRecord({ request: { source: 'PRIVATE_ENDPOINT' } }), /PRIVATE_ENDPOINT/);
});

test('optional November 11 attachment: distinguish known 503, SAFETY, aborts and short unknown text',
    { skip: !process.env.LIN129_HISTORY_PATH }, () => {
        const records = JSON.parse(fs.readFileSync(process.env.LIN129_HISTORY_PATH, 'utf8')).records;
        const before = JSON.stringify(records);
        assert.equal(records.length, 50);
        const failures = records.filter(r => r.wire?.apiStatus === 503);
        assert.equal(failures.length, 1); assert.equal(failures[0].wire.aborted, true);
        assert.equal(recordStatus(failures[0]).label, '请求失败');
        assert.match(recordDiagnosis(failures[0]).split('\n')[0], /503/);
        const restricted = records.filter(r => r.wire?.finishReason === 'SAFETY');
        assert.equal(restricted.length, 1); assert.equal(recordStatus(restricted[0]).label, '服务端限制');
        const short = records.filter(r => compactStreamEvidence(r.wire) && r.wire.visibleChars === 75);
        assert.equal(short.length, 19);
        assert.ok(short.every(r => recordStatus(r).label === '短流·原因未知'));
        assert.ok(records.every(r => r.request?.source !== 'makersuite'));
        assert.equal(JSON.stringify(records), before);
    });
