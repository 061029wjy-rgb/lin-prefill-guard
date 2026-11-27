import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { createController } from '../controller.js';
import { planInjection } from '../core.js';
import { LIN_PROMPT_ID, LIN_CONFIRM_ID } from '../protocol.js';
import { googleProxyKey, prefillRoute, verifyPrefill } from '../prefill.js';

const msg = (role, content) => ({ role, content });
const cue = msg('assistant', '原承接，继续当前任务。');
const confirm = msg('user', '确认全文。\n【生成交接】\n请交付。');
const user = msg('user', '接着写。');
const fixture = () => ({
    prompts: [{ identifier: LIN_PROMPT_ID, ...cue }, { identifier: LIN_CONFIRM_ID, ...confirm }],
    prompt_order: [{ character_id: 100001, order: [LIN_PROMPT_ID, LIN_CONFIRM_ID].map(identifier => ({ identifier, enabled: true })) }],
});
const req = (messages = [user, cue, confirm], patch = {}) => ({
    chat_completion_source: 'mistralai', model: 'mistral-large-latest', type: 'normal',
    messages, max_tokens: 4000, temperature: .9, top_p: .95, reasoning_effort: 'max',
    include_reasoning: false, stop: ['STOP'], stream: true, ...patch,
});
const run = (request, preset = fixture(), settings = {}, activeOrderId = 100001) =>
    planInjection(request, settings, { preset, activeOrderId });
const proxy = {
    chat_completion_source: 'vertexai', model: 'gemini-4-carbon', vertexai_auth_mode: 'proxy',
    reverse_proxy: 'https://gateway.example/forward', enable_web_search: true,
};

test('normal, regenerate and swipe move the preset cue to the native prefix on supported routes', () => {
    const routes = [
        [{}, 'mistral-prefix', true],
        [{ chat_completion_source: 'deepseek', model: 'deepseek-v4-flash' }, 'deepseek-beta', true],
        [{ chat_completion_source: 'claude', model: 'claude-haiku-4-5-20251001', reasoning_effort: 'auto' }, 'claude-assistant', false],
        [proxy, 'google-proxy-model', false],
    ];
    for (const [connection, method, flag] of routes) {
        for (const type of ['normal', 'regenerate', 'swipe']) {
            const request = req([user, cue, confirm], { ...connection, type });
            const original = JSON.stringify(request);
            const settings = { googleProxyPrefill: googleProxyKey(request), reasoningMode: 'balanced', storyMoreTokens: true };
            const result = run(request, fixture(), settings);
            assert.equal(result.reason, 'prefill-converted');
            assert.equal(result.prefill.method, method);
            assert.equal(result.messages[0], user);
            assert.equal(result.messages[1], confirm);
            if (!flag) assert.equal(result.messages[2], cue);
            else assert.deepEqual(result.messages[2], { ...cue, prefix: true });
            assert.equal(result.messages.length, request.messages.length);
            assert.deepEqual(result.injected, []);
            assert.equal(result.netChars, 0);
            assert.equal(JSON.stringify(request), original);
            const sent = { ...request, messages: result.messages };
            assert.deepEqual(verifyPrefill(sent, result.prefillWitness), { verified: true, native: true, tailStart: 1 });
            const repeated = run(sent, fixture(), settings);
            assert.equal(repeated.reason, 'prefill-ready');
            assert.equal(repeated.changed, false);
            assert.equal(repeated.messages, sent.messages);
        }
    }
});

test('ordinary Google and unconfirmed Google proxies preserve a correct original tail', () => {
    for (const connection of [
        { chat_completion_source: 'vertexai', model: 'gemini-4-carbon', vertexai_auth_mode: 'express' },
        { chat_completion_source: 'makersuite', model: 'gemini-4-argon', enable_web_search: true },
        proxy,
    ]) {
        const request = req([user, cue, confirm], connection);
        const plan = run(request);
        assert.equal(plan.reason, connection === proxy ? 'prefill-proxy-unverified' : 'prefill-unavailable');
        assert.equal(plan.messages, request.messages);
        assert.deepEqual(verifyPrefill(request, plan.prefillWitness), { verified: true, native: false, tailStart: 1 });
        const reversed = req([user, confirm, cue], connection);
        const fixed = run(reversed);
        assert.equal(fixed.reason, 'prefill-compatible');
        fixed.messages.forEach((message, index) => assert.equal(message, request.messages[index]));
    }
    assert.equal(googleProxyKey({ ...proxy, reverse_proxy: 'https://aiplatform.googleapis.com' }), '');
    const key = googleProxyKey(proxy);
    for (const alternate of [{ model: 'gemini-4-argon' }, { reverse_proxy: 'https://another.example' }])
        assert.equal(prefillRoute({ ...proxy, ...alternate }, key).method, null);
    for (const vertexai_auth_mode of ['full', 'express', undefined])
        assert.equal(prefillRoute({ ...proxy, vertexai_auth_mode }, key).method, 'google-proxy-model');
    for (const alternate of [
        { chat_completion_source: 'deepseek', model: 'deepseek-v4-flash', reverse_proxy: 'https://api.deepseek.com/' },
        { chat_completion_source: 'claude', model: 'claude-sonnet-4-6', reasoning_effort: 'auto' },
        { chat_completion_source: 'claude', model: 'claude-sonnet-4-5', reasoning_effort: 'high' },
        { chat_completion_source: 'custom', model: 'gemini-4-carbon', custom_url: 'https://gateway.example/v1' },
    ]) assert.equal(prefillRoute(alternate).method, null);
});

test('history images, signatures and tool pairs stay intact; positions identify protected tail fields', () => {
    const image = { type: 'image_url', image_url: { url: 'data:image/png;base64,not-a-real-image' } };
    const toolCalls = [{ id: 'id', type: 'function', function: { name: 'lookup', arguments: '{}' }, signature: 'tool-signature' }];
    const older = [msg('user', [image]), { ...msg('assistant', '旧消息。'), thoughtSignature: 'history-signature', tool_calls: toolCalls },
        { ...msg('tool', '历史工具结果。'), tool_call_id: 'id' }];
    const request = req([...older, user, cue, confirm]);
    const result = run(request);
    assert.equal(result.reason, 'prefill-converted');
    older.forEach((message, i) => assert.equal(result.messages[i], message));
    assert.equal(result.messages[0].content[0], image);
    assert.equal(result.messages[1].tool_calls, toolCalls);
    assert.deepEqual(result.protectedFields.find(field => field.field === 'content[0]'),
        { index: 0, role: 'user', field: 'content[0]', contentType: 'image_url', region: 'history' });
    assert.deepEqual(result.protectedFields.find(field => field.field === 'thoughtSignature'),
        { index: 1, role: 'assistant', field: 'thoughtSignature', contentType: 'string', region: 'history' });
    const signedCue = msg('assistant', [{ type: 'text', text: cue.content, thoughtSignature: 'private-signature' }]);
    const withProtectedTail = req([...older, user, signedCue, confirm]);
    const protectedResult = run(withProtectedTail);
    assert.equal(protectedResult.reason, 'prefill-protected-tail');
    assert.equal(protectedResult.messages, withProtectedTail.messages);
    assert.deepEqual(protectedResult.protectedFields.at(-1),
        { index: 4, role: 'assistant', field: 'content[0].thoughtSignature', contentType: 'text', region: 'tail' });
    assert.equal(verifyPrefill(withProtectedTail, protectedResult.prefillWitness).verified, true);
    assert.equal(verifyPrefill(withProtectedTail, protectedResult.prefillWitness).native, false);
    assert.doesNotMatch(JSON.stringify(protectedResult.protectedFields), /private-signature|history-signature|tool-signature|base64/);
    const onlyHistory = run(req([...older, user, cue, confirm], proxy));
    assert.equal(onlyHistory.reason, 'prefill-proxy-unverified');
    assert.ok(onlyHistory.protectedFields.every(field => field.region === 'history'));
});

test('protected or unrelated payload shapes are not turned into a different request', () => {
    for (const [patch, reason] of [
        [{ type: 'continue' }, 'g4-continue'], [{ type: 'quiet' }, 'quiet'], [{ type: 'impersonate' }, 'impersonate'],
        [{ assistant_prefill: 'existing native start' }, 'native-prefill'],
        [{ json_schema: { value: {} } }, 'structured'], [{ n: 2 }, 'multiple-candidates'],
        [{ continuationToken: 'opaque' }, 'continuation-or-cache'],
        [{ cachedContent: 'caches/1' }, 'continuation-or-cache'],
        [{ tools: [{}] }, 'tools'], [{ contents: [] }, 'parallel-input'],
        [{ messages: [user, cue, confirm, msg('assistant', '本轮已有的答案。')] }, 'g291-anchors'],
        [{ messages: [user, cue, msg('user', confirm.content + '另一个人的附注。')] }, 'g291-anchors'],
    ]) {
        const request = req(undefined, patch);
        const plan = run(request);
        assert.equal(plan.reason, reason);
        assert.equal(plan.changed, false);
        if (plan.messages) assert.equal(plan.messages, request.messages);
    }
    const p = fixture();
    p.prompt_order[0].order[0].enabled = false;
    assert.equal(run(req(), p).reason, 'g4-disabled');
    assert.equal(run(req()).applied, true);
    const sent = run(req());
    const wrong = { ...req(), messages: [user, confirm, cue] };
    assert.equal(verifyPrefill(wrong, sent.prefillWitness).native, false);
});

for (const env of ['LIN293_PRESET', 'LIN293_FY_PRESET', 'LIN26_PRESET_PATH']) {
    test(`real preset replay — ${env}`, { skip: !process.env[env] }, () => {
        const path = process.env[env], bytes = readFileSync(path), preset = JSON.parse(bytes);
        const snapshot = JSON.stringify(preset);
        for (const group of preset.prompt_order) {
            const groupMessages = group.order.filter(slot => slot.enabled).flatMap(slot => {
                const prompt = preset.prompts.find(row => row.identifier === slot.identifier);
                return prompt?.role && prompt.content?.trim() && !prompt.marker && !prompt.injection_position
                    ? [msg(prompt.role, prompt.content)] : [];
            });
            const text = preset.prompts.find(row => row.identifier === LIN_PROMPT_ID).content;
            const index = groupMessages.findIndex(message => message.role === 'assistant' && message.content === text);
            assert.ok(index >= 0);
            for (const type of ['normal', 'regenerate', 'swipe']) {
                const request = req([user, ...groupMessages], { type });
                const result = run(request, preset, {}, group.character_id);
                assert.equal(result.reason, 'prefill-converted');
                const expected = request.messages.filter((_, i) => i !== index + 1);
                expected.forEach((message, i) => assert.equal(result.messages[i], message));
                assert.deepEqual(result.messages.at(-1), { ...groupMessages[index], prefix: true });
                const google = req(request.messages, { ...proxy, type });
                assert.equal(run(google, preset, {}, group.character_id).messages, google.messages);
                assert.equal(run(google, preset, { googleProxyPrefill: googleProxyKey(google) }, group.character_id)
                    .messages.at(-1), groupMessages[index]);
            }
        }
        assert.equal(JSON.stringify(preset), snapshot);
        assert.deepEqual(readFileSync(path), bytes);
    });
}

test('one actual HTTP POST per generation; the fetch hook observes the native prefix and reported tokens', async t => {
    const packet = { choices: [{ delta: { content: '可见回复。' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 42, completion_tokens: 17, completion_tokens_details: { reasoning_tokens: 8 }, total_tokens: 59 } };
    const wire = `data: ${JSON.stringify(packet)}\n\ndata: [DONE]\n\n`;
    const sent = [];
    const endpoint = createServer(async (request, response) => {
        const chunks = [];
        for await (const part of request) chunks.push(part);
        sent.push(JSON.parse(Buffer.concat(chunks)));
        response.writeHead(200, { 'Content-Type': 'text/event-stream' }).end(wire);
    });
    endpoint.listen(0, '127.0.0.1');
    await once(endpoint, 'listening');
    t.after(() => new Promise(resolve => endpoint.close(resolve)));
    const origin = `http://127.0.0.1:${endpoint.address().port}`;
    const bus = new Map();
    const ctx = { chat: [], chatCompletionSettings: fixture(), eventTypes: { CHAT_COMPLETION_SETTINGS_READY: 'ready' },
        eventSource: { on: (event, fn) => bus.set(event, fn), removeListener: event => bus.delete(event) } };
    const target = { fetch, location: { href: origin } };
    const controller = createController({ getContext: () => ctx, getSettings: () => ({ reasoningMode: 'balanced', storyMoreTokens: true }),
        networkTarget: target, getOrderId: () => 100001 });
    t.after(() => controller.dispose());
    const request = req();
    const expected = { ...request, messages: [user, confirm, { ...cue, prefix: true }] };
    bus.get('ready')(request);
    bus.get('ready')(request);
    const response = await target.fetch(origin + '/api/backends/chat-completions/generate',
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request) });
    assert.equal(await response.text(), wire);
    await controller.idle();
    assert.deepEqual(sent, [expected]);
    const record = controller.snapshot().history[0];
    assert.equal(record.applied, true);
    assert.equal(record.reason, 'prefill-converted');
    assert.equal(record.dispatch.correlation, 'exact');
    assert.equal(record.dispatch.prefill.native, true);
    assert.equal(record.wire.finishReason, 'stop');
    assert.deepEqual([record.wire.promptTokens, record.wire.outputTokens, record.wire.thoughtTokens, record.wire.totalTokens], [42, 17, 8, 59]);
    assert.doesNotMatch(JSON.stringify(record), /确认全文|原承接，继续|可见回复/);
});
