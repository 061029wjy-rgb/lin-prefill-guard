import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { DEFAULTS, LIN_PROMPT_ID, LIN_24_PREFILL, migrateSettings, planInjection } from '../core.js';
import { deliveryProfile } from '../delivery.js';
import { analyzeOutput, replySignalDiagnosis } from '../structure.js';
import { auditPreset, compactStreamEvidence, repeatedReplyEvidence, recordStatus, responseDiagnosis, planReasoning, formatRecord } from '../diagnostics.js';
import { createController } from '../controller.js';
import { installObserver, inspectResponse } from '../observer.js';
import { createRecovery } from '../recovery.js';

const preset = () => ({ prompts: [{ identifier: LIN_PROMPT_ID, role: 'assistant', content: LIN_24_PREFILL }],
    prompt_order: [{ character_id: 100001, order: [{ identifier: LIN_PROMPT_ID, enabled: true }] }] });
const request = (type = 'normal') => ({ type, model: 'gemini-4-argon', stream: true, max_tokens: 16384,
    reasoning_effort: 'high', stop: ['END_CUSTOM'], messages: [{ role: 'user', content: '她拿起餐刀，切好苹果。' },
        { role: 'assistant', content: LIN_24_PREFILL }, { role: 'user', content: '预设原尾部要求。' }] });
const compact = () => ({ transport: 'sse', responseComplete: true, doneMarker: true, frames: 2,
    visibleChars: 223, recognized: true, httpStatus: 200, parseErrors: 0 });

for (const type of ['normal', 'swipe', 'regenerate', 'continue']) {
    test(`default ${type} preserves request objects, preset cue and settings even with old enhancements selected`, () => {
        const req = request(type), p = preset(), original = JSON.stringify({ req, p });
        const result = planInjection(req, migrateSettings({ mode: 'pair', enhanceContinue: true, reasoningMode: 'balanced' }), { preset: p });
        assert.equal(result.reason, 'observe-only'); assert.equal(result.applied, false); assert.equal(result.changed, false);
        assert.equal(result.messages, req.messages); assert.deepEqual(result.injected, []);
        assert.equal(JSON.stringify({ req, p }), original);
        assert.ok(result.messages.some(m => m.content.includes('不把失败回复当成情节')));
        assert.equal(planReasoning(req, { reasoningMode: 'balanced' }), null);
    });
}

test('mode migration retains custom text and disabled settings; explicit later choices persist', () => {
    const old = { prefill: '个人提示', nudge: '个人执行', enabled: false, captureNetwork: false, mode: 'pair' };
    const next = migrateSettings(old);
    assert.equal(next.requestMode, 'observe');
    for (const key of Object.keys(old)) assert.equal(next[key], old[key]);
    assert.deepEqual(migrateSettings(next), next);
    assert.equal(migrateSettings({ ...next, requestMode: 'enhance' }).requestMode, 'enhance');
    assert.equal(migrateSettings().requestMode, DEFAULTS.requestMode);
    assert.equal(DEFAULTS.requestMode, 'gemini4');
});

test('explicit legacy enhancement still works; diagnostic mode cannot mutate a frozen request', () => {
    const req = request();
    assert.equal(planInjection(req, { requestMode: 'enhance' }, { preset: preset() }).applied, true);
    Object.freeze(req.messages); Object.freeze(req);
    assert.equal(planInjection(req, {}, { preset: preset() }).messages, req.messages);
    assert.deepEqual(planReasoning(req, { requestMode: 'enhance', reasoningMode: 'balanced' }), { before: 'high', after: 'medium' });
});

for (const text of [
    '桌上有一把刀。', '她拿出菜刀切好苹果，把刀收回刀架。',
    '“抱歉，我不能帮助你。”他把话说完，收起了餐具。',
    '<content>我不能帮助你。他转身离开了房间。</content>',
    '<!-- Lin_CoT:\n我不能帮助生成某些文字。\n-->桌上有一把水果刀。',
    '```text\nI cannot help with that request.\n```',
]) test(`objects, quoted dialogue and notes are not refusal flags: ${text.slice(0, 18)}`, () => {
    assert.deepEqual(analyzeOutput(text).replySignals, []);
});

for (const text of ['抱歉，我不能提供这样的回答。', "I'm sorry, but I can't assist with that.", '请求失败：服务暂时不可用。']) {
    test(`direct reply wording creates a weak flag, never a protocol refusal: ${text.slice(0, 16)}`, async () => {
        const w = await inspectResponse(new Response(JSON.stringify({ choices: [{ message: { content: text }, finish_reason: 'stop' }] })));
        assert.equal(w.refusal, undefined); assert.equal(w.apiError, undefined);
        assert.equal(w.visibleChars, text.length); assert.equal(w.output.replySignals.length, 1);
        assert.ok(replySignalDiagnosis(w.output));
        assert.doesNotMatch(JSON.stringify(w), /这样的回答|assist with that|服务暂时不可用/);
        const ctx = { mainApi: 'openai', chat: [{ mes: text }], generate: async () => {} };
        const recovery = createRecovery({ getContext: () => ctx, getRecord: () => ({ wire: w }) });
        assert.equal(recovery.prepare().ok, true, 'weak wording flags must not add recovery restrictions');
    });
}

test('short two-frame streams outrank punctuation hints without inventing filtering', () => {
    const wire = { ...compact(), output: { ending: { signals: ['no-terminal-punctuation'] } } };
    assert.equal(recordStatus({ wire }).label, '短流·原因未知');
    assert.match(responseDiagnosis(wire), /可能是渠道/);
    assert.doesNotMatch(responseDiagnosis(wire), /疑似句尾未完|服务端限制/);
    for (const patch of [{ finishReason: 'STOP' }, { outputTokens: 1 }, { captureLimited: true }, { parseErrors: 1 },
        { httpStatus: 429 }, { refusal: true }, { blockReason: 'SAFETY' }, { aborted: true }, { frames: 4 }]) {
        assert.equal(compactStreamEvidence({ ...wire, ...patch }), '');
    }
});

test('repetition evidence requires same model and text digest, never just equal length', () => {
    const record = { id: 'a', request: { model: 'm' }, wire: { ...compact(), textDigest: 'digest-a' } };
    const copies = [record, { ...record, id: 'b' }, { ...record, id: 'c', request: { model: 'other' } },
        { ...record, id: 'd', wire: { ...record.wire, textDigest: 'digest-b' } },
        { ...record, id: 'e', reason: 'unmatched-dispatch' }];
    assert.match(repeatedReplyEvidence(record, copies), /2 次/);
    assert.match(formatRecord(record, copies), /摘要值不能还原/);
    assert.equal(repeatedReplyEvidence({ ...record, wire: compact() }, copies), '');
});

test('explicit service/transport evidence still takes priority over text heuristics', () => {
    const output = analyzeOutput('抱歉，我不能帮助完成这个请求。');
    for (const [patch, label] of [[{ finishReason: 'content_filter' }, '服务端限制'],
        [{ apiError: true }, '请求失败'], [{ finishReason: 'MAX_TOKENS' }, '输出预算结束'],
        [{ captureLimited: true }, '取证不完整']]) {
        assert.equal(recordStatus({ wire: { ...compact(), output, ...patch } }).label, label);
    }
});

test('new analysis cannot change the original SSE response or issue additional requests', async () => {
    const body = 'data: ' + JSON.stringify({ choices: [{ delta: { content: '她拿起一把餐刀。' } }] }) + '\n\ndata: [DONE]\n\n';
    const response = new Response(body, { headers: { 'content-type': 'text/event-stream' } });
    let calls = 0, observed;
    const target = { location: { href: 'http://localhost/' }, fetch: async () => { calls++; return response; } };
    const observer = installObserver({ target, enabled: () => true, onDispatch: () => 'r',
        onResponse: (_, w) => { observed = w; }, onError: () => assert.fail('unexpected observer error') });
    const returned = await target.fetch('/api/backends/chat-completions/generate', { method: 'POST', body: JSON.stringify(request()) });
    assert.equal(returned, response); assert.equal(await returned.text(), body); await observer.idle();
    assert.equal(calls, 1); assert.deepEqual(observed.output.replySignals, []); observer.dispose();
});

test('controller observes native requests, preserves identity and associates saved text without injection', async () => {
    const listeners = new Map();
    const bus = { on: (e, f) => listeners.set(e, f), removeListener: e => listeners.delete(e), makeLast() {} };
    const ctx = { eventSource: bus, eventTypes: { CHAT_COMPLETION_SETTINGS_READY: 'request', MESSAGE_RECEIVED: 'message' },
        chat: [], chatCompletionSettings: preset() };
    let calls = 0;
    const target = { location: { href: 'http://localhost/' }, fetch: async () => { calls++; return new Response(JSON.stringify({ choices: [{ message: { content: '桌上有一把刀。' }, finish_reason: 'stop' }] })); } };
    const controller = createController({ getContext: () => ctx, getSettings: () => ({ mode: 'pair', reasoningMode: 'balanced' }), networkTarget: target });
    const req = request(), original = JSON.stringify(req), messages = req.messages;
    listeners.get('request')(req);
    assert.equal(req.messages, messages); assert.equal(JSON.stringify(req), original);
    await target.fetch('/api/backends/chat-completions/generate', { method: 'POST', body: JSON.stringify(req) });
    ctx.chat.push({ mes: '桌上有一把刀。', is_user: false }); await listeners.get('message')(0, 'normal'); await controller.idle();
    const record = controller.snapshot().last;
    assert.equal(record.requestMode, 'observe'); assert.equal(record.reason, 'observe-only');
    assert.equal(record.dispatch.correlation, 'exact'); assert.equal(record.adjustment, null);
    assert.deepEqual(record.injected, []); assert.equal(record.rendered.chars, 7); assert.equal(calls, 1);
    controller.dispose();
});

test('actual Lin2.6.4: current 13-column preset and 16 mode/type combinations preserve private source',
    { skip: !process.env.LIN264_PRESET_PATH }, () => {
        const path = process.env.LIN264_PRESET_PATH, bytes = fs.readFileSync(path), p = JSON.parse(bytes);
        assert.equal(createHash('sha256').update(bytes).digest('hex'), '68aaed4f78a7cc04b780d00f20937e7c2fd5084e4b1f8fe7b8d77658883acaed');
        const profile = deliveryProfile(p);
        assert.equal(p.prompts.length, 91); assert.equal(profile.known, true); assert.equal(profile.cotSources.length, 1);
        assert.equal(profile.cotSources[0].columns, 13); assert.equal(profile.cotConflict, false);
        const order = p.prompt_order.find(o => String(o.character_id) === '100001').order;
        const base = [{ role: 'user', content: '她拿起水果刀切苹果。' }, ...order.filter(o => o.enabled).flatMap(o => {
            const prompt = p.prompts.find(v => v.identifier === o.identifier);
            return prompt?.role && prompt.content ? [{ role: prompt.role, content: prompt.content }] : [];
        })];
        for (const type of ['normal', 'swipe', 'regenerate', 'continue']) for (const mode of ['user', 'pair']) for (const requestMode of ['observe', 'enhance']) {
            const req = { ...request(type), messages: structuredClone(base) }, before = JSON.stringify({ req, p });
            const result = planInjection(req, { requestMode, mode, enhanceContinue: true }, { preset: p });
            assert.equal(JSON.stringify({ req, p }), before);
            if (requestMode === 'observe') {
                assert.equal(result.messages, req.messages); assert.equal(result.removedOriginal, false);
                assert.equal(result.deliveryGuard, false); assert.equal(result.applied, false);
                assert.equal(result.messages.find(m => m.content.startsWith('[Lin｜本轮承接]')).content,
                    p.prompts.find(v => v.identifier === LIN_PROMPT_ID).content);
            } else assert.equal(result.applied, true);
        }
        assert.match(auditPreset(p).join('\n'), /不再叠加插件提示/);
        assert.match(auditPreset(p, {}, { requestMode: 'enhance' }).join('\n'), /重复干预/);
        // Local replace behavior only; not an emulation of SillyTavern rendering.
        const sample = '她从厨房拿出一把刀，切好苹果后放回刀架。';
        for (const r of p.extensions.regex_scripts.filter(r => !r.disabled)) {
            const last = r.findRegex.lastIndexOf('/');
            const regex = new RegExp(r.findRegex.slice(1, last), r.findRegex.slice(last + 1));
            assert.equal(sample.replace(regex, r.replaceString), sample, r.scriptName);
        }
        assert.deepEqual(fs.readFileSync(path), bytes);
    });

test('actual latest 50 records: 10 compact streams, repeated 6/3 groups, no retroactive refusal claims',
    { skip: !process.env.LIN127_HISTORY_PATH }, () => {
        const records = JSON.parse(fs.readFileSync(process.env.LIN127_HISTORY_PATH, 'utf8')).records;
        const before = JSON.stringify(records), story = records.filter(r => r.request?.model === 'gemini-4-argon');
        assert.equal(records.length, 50); assert.equal(story.length, 31);
        assert.ok(story.every(r => r.wire.textDigest && r.wire.textDigest === r.rendered.textDigest));
        const shorts = story.filter(r => compactStreamEvidence(r.wire)); assert.equal(shorts.length, 10);
        for (const r of shorts) assert.equal(recordStatus(r).label, '短流·原因未知');
        assert.match(repeatedReplyEvidence(records[17], records), /6 次/);
        assert.match(repeatedReplyEvidence(records[12], records), /3 次/);
        assert.equal(recordStatus(records[0]).label, '结构未完成');
        assert.equal(records[0].wire.output.nonCommentChars, 39);
        assert.equal(records[1].wire.output.nonCommentChars, 39);
        assert.ok(story.every(r => !r.wire.refusal && !r.wire.blockReason));
        assert.equal(JSON.stringify(records), before);
    });
