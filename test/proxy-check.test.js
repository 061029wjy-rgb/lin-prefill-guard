import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { planInjection } from '../core.js';
import { identifyProxy, prefillRoute, verifyPrefill } from '../prefill.js';
import { checkProxyPrefill } from '../proxy-check.js';
import { LIN_PROMPT_ID, LIN_CONFIRM_ID } from '../protocol.js';

const vertex = { chat_completion_source: 'vertexai', model: 'gemini-4-carbon',
    reverse_proxy: 'https://gateway.example/private', proxy_password: 'test-only-password', vertexai_auth_mode: 'express' };
const openai = { ...vertex, chat_completion_source: 'openai' };
const custom = { chat_completion_source: 'custom', model: 'carbon', custom_url: 'https://gateway.example/v1',
    custom_include_body: '{"continue_final_message":true,"add_generation_prompt":false}' };
const headers = () => ({ 'Content-Type': 'application/json' });
const context = { getRequestHeaders: headers, chat: [{ role: 'user', content: 'private user chat' }] };
const cue = { role: 'assistant', content: '原承接。' };
const confirm = { role: 'user', content: '完整确认。\n【生成交接】\n完成原任务。' };
const previous = { role: 'assistant', content: '旧回复。', signature: 'private-signature' };
const preset = { prompts: [{ identifier: LIN_PROMPT_ID, ...cue }, { identifier: LIN_CONFIRM_ID, ...confirm }],
    prompt_order: [{ character_id: 100001, order: [{ identifier: LIN_PROMPT_ID, enabled: true }, { identifier: LIN_CONFIRM_ID, enabled: true }] }] };
const story = { messages: [previous, { role: 'user', content: '当前剧情。' }, cue, confirm], type: 'normal',
    stream: true, max_tokens: 4000, reasoning_effort: 'max', include_reasoning: false, enable_web_search: true,
    stop: ['END'], temperature: .6 };

test('the proxy is recognized separately from its native prefix capability', () => {
    for (const vertexai_auth_mode of [undefined, 'express', 'full', 'proxy']) {
        const connection = { ...vertex, vertexai_auth_mode };
        assert.equal(identifyProxy(connection).label, 'Vertex AI 反代');
        assert.equal(identifyProxy(connection).key, identifyProxy(vertex).key);
        const request = { ...connection, ...story };
        const plan = planInjection(request, {}, { preset });
        assert.equal(plan.reason, 'prefill-proxy-unverified');
        assert.equal(plan.prefill.connection, 'Vertex AI 反代');
        assert.equal(plan.applied, false);
        assert.equal(plan.messages, story.messages);
        assert.equal(verifyPrefill(request, plan.prefillWitness).verified, true);
    }
    assert.equal(identifyProxy({ ...vertex, reverse_proxy: '' }), null);
    assert.equal(identifyProxy({ ...vertex, reverse_proxy: 'https://aiplatform.googleapis.com' }), null);
    assert.equal(identifyProxy(openai).label, 'OpenAI 反代');
    assert.equal(identifyProxy(custom).label, '自定义 OpenAI 兼容接口');
    assert.equal(identifyProxy({ ...custom, custom_url: custom.custom_url + '/' }).key, identifyProxy(custom).key);
    assert.notEqual(identifyProxy({ ...custom, custom_include_body: '' }).key, identifyProxy(custom).key);
});

test('an approved protocol applies only to the matching route and preserves history and parameters', () => {
    for (const [connection, method] of [[vertex, 'google-proxy-model'], [openai, 'compatible-prefix'],
        [custom, 'compatible-assistant']]) {
        const approval = { key: identifyProxy(connection).key, method, evidence: 'test' };
        for (const type of ['normal', 'regenerate', 'swipe']) {
            const request = { ...connection, ...story, type };
            const before = JSON.stringify(request);
            const plan = planInjection(request, { proxyPrefill: approval }, { preset });
            assert.equal(plan.reason, 'prefill-converted');
            assert.equal(plan.messages[0], previous);
            assert.equal(plan.messages[2], confirm);
            assert.deepEqual(plan.messages[3], method === 'compatible-prefix' ? { ...cue, prefix: true } : cue);
            if (method !== 'compatible-prefix') assert.equal(plan.messages[3], cue);
            assert.equal(plan.netChars, 0);
            assert.equal(JSON.stringify(request), before);
            assert.equal(verifyPrefill({ ...request, messages: plan.messages }, plan.prefillWitness).native, true);
            assert.equal(verifyPrefill({ ...request, model: 'new-model', messages: plan.messages }, plan.prefillWitness).native, false);
            assert.doesNotMatch(JSON.stringify(plan.prefill), /gateway|private|password|signature/);
        }
        const other = { ...connection, model: 'other' };
        assert.equal(prefillRoute(other, '', approval).method, null);
        if (method === 'compatible-assistant') {
            const otherMethod = planInjection({ ...connection, ...story },
                { proxyPrefill: approval, proxyCompatibleMethod: 'compatible-prefix' }, { preset });
            assert.equal(otherMethod.reason, 'prefill-proxy-unverified');
        }
    }
});

test('the test sends one isolated POST and only approves a completed suffix response', async t => {
    const sent = [];
    const endpoint = createServer(async (request, response) => {
        let body = '';
        for await (const chunk of request) body += chunk;
        const payload = JSON.parse(body);
        sent.push(payload);
        const prompt = payload.messages[0].content;
        const full = prompt.slice(prompt.indexOf('{"lin"'));
        const suffix = full.slice(payload.messages[1].content.length);
        if (payload.model === 'reject') {
            response.writeHead(500, { 'Content-Type': 'application/json' }).end(JSON.stringify({
                error: { code: 400, message: 'Requests ending with a model turn are not supported.' },
            }));
        } else if (payload.model === 'echo') {
            response.writeHead(200, { 'Content-Type': 'application/json' })
                .end(JSON.stringify({ choices: [{ message: { content: full } }] }));
        } else if (payload.stream) {
            const packet = text => 'data: ' + JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] }) + '\n\n';
            response.writeHead(200, { 'Content-Type': 'text/event-stream' });
            response.write(packet(suffix.slice(0, 3)));
            response.end(packet(suffix.slice(3)) + 'data: [DONE]\n\n');
        } else {
            response.writeHead(200, { 'Content-Type': 'application/json' })
                .end(JSON.stringify({ choices: [{ message: { content: suffix } }] }));
        }
    });
    endpoint.listen(0, '127.0.0.1');
    await once(endpoint, 'listening');
    t.after(() => new Promise(resolve => endpoint.close(resolve)));
    const fetchRequest = (path, init) => fetch(`http://127.0.0.1:${endpoint.address().port}${path}`, init);
    for (const [connection, compatibleMethod, expected, flagged] of [
        [{ ...vertex, stream_openai: true }, undefined, 'passed', false],
        [openai, 'compatible-prefix', 'passed', true],
        [custom, 'compatible-assistant', 'passed', false],
        [{ ...vertex, model: 'reject' }, undefined, 'rejected', false],
        [{ ...vertex, model: 'echo' }, undefined, 'inconclusive', false],
    ]) {
        const count = sent.length;
        const result = await checkProxyPrefill({ connection, compatibleMethod, context, fetchRequest });
        assert.equal(sent.length, count + 1);
        const request = sent.at(-1);
        assert.equal(request.messages.length, 2);
        assert.equal(request.messages[1].role, 'assistant');
        assert.equal(request.messages[1].prefix, flagged ? true : undefined);
        assert.equal(request.vertexai_auth_mode, connection.vertexai_auth_mode);
        assert.equal(request.type, 'quiet');
        assert.equal(request.max_tokens, 1024);
        assert.doesNotMatch(JSON.stringify(request), /private user chat/);
        assert.doesNotMatch(JSON.stringify(result), /gateway|private|password/);
        assert.equal(result.status, expected);
        assert.equal(!!result.approval, expected === 'passed');
    }
    assert.equal(sent.length, 5);
});

test('a test cannot approve a changed host route or send overridden test messages', async () => {
    const noFetch = () => assert.fail('test payload must not be sent');
    assert.equal((await checkProxyPrefill({ connection: { ...custom, custom_include_body: '{"messages":[]}' },
        context, fetchRequest: noFetch })).status, 'unavailable');
    assert.equal((await checkProxyPrefill({ connection: vertex, context, fetchRequest: noFetch,
        createGenerationParameters: async () => ({ generate_data: { ...vertex, reverse_proxy: 'https://other.example' } }),
    })).status, 'unavailable');
    assert.equal((await checkProxyPrefill({ connection: { ...custom, custom_include_headers: 'x: "{{lastMessage}}"' },
        context, fetchRequest: noFetch })).status, 'unavailable');
});
