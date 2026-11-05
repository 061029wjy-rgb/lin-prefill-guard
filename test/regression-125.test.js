import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULTS as OBSERVE_DEFAULTS, DEFAULT_PREFILL, REGENERATE_PREFILL, LIN_PROMPT_ID, LIN_24_PREFILL, planInjection, migrateSettings } from '../core.js';
const DEFAULTS = { ...OBSERVE_DEFAULTS, requestMode: 'enhance' };
import { COT_VARIANTS, deliveryProfile, deliveryCue } from '../delivery.js';
import { analyzeOutput, endingDiagnosis } from '../structure.js';
import { recordStatus, responseDiagnosis, recordDiagnosis, compareDelivery, requestMeta, formatRecord } from '../diagnostics.js';
import { inspectResponse, installObserver } from '../observer.js';
import { createController } from '../controller.js';

const preset = () => {
    const prompts = [{ identifier: LIN_PROMPT_ID, role: 'assistant', content: LIN_24_PREFILL },
        { identifier: COT_VARIANTS[1].id, role: 'system', content: '本条将Lin2.6实际启用的规则汇总。\n<!-- Lin_CoT:\n01｜任务：结论\n-->' }];
    return { prompts, prompt_order: [{ character_id: 100001, order: prompts.map(p => ({ identifier: p.identifier, enabled: true })) }] };
};
const paragraph = '天色渐渐暗了下来，她把桌上的书放回书架，走到窗前看了一会儿街景。巷子里有人骑车经过，车铃响了两声。她回过头，把热茶放在桌角，等屋里的人收拾好书包，再一起去街口买晚饭。';
const cut = paragraph + '她拿起外套，转身对他说';

for (const mode of ['user', 'pair']) for (const type of ['swipe', 'regenerate']) {
    test(`new attempt semantics and idempotence: ${mode}/${type}`, () => {
        const p = preset(), req = { type, max_tokens: 16384, stop: ['custom-stop'], stream: true,
            messages: [{ role: 'user', content: '请写普通日常。' }, { role: 'assistant', content: LIN_24_PREFILL }] };
        const before = JSON.stringify({ req, p }), settings = { ...DEFAULTS, mode };
        const result = planInjection(req, settings, { preset: p });
        assert.equal(result.applied, true);
        assert.ok(result.injected.some(m => m.content.includes(REGENERATE_PREFILL)));
        assert.match(result.messages.at(-1).content, /重抽／重新生成/);
        assert.ok(!result.injected.some(m => m.content.includes(DEFAULT_PREFILL)));
        assert.doesNotMatch(result.messages.at(-1).content, /500汉字/);
        assert.equal(JSON.stringify({ req, p }), before);
        assert.equal(planInjection({ ...req, messages: result.messages }, settings, { preset: p }).changed, false);
    });
}
test('normal and continue keep separate task semantics; user custom text and pair choice survive', () => {
    const p = preset(), req = { messages: [{ role: 'user', content: '日常。' }] };
    assert.ok(planInjection(req, DEFAULTS, { preset: p }).injected[0].content.includes(DEFAULT_PREFILL));
    const result = planInjection({ ...req, type: 'continue' }, { requestMode: 'enhance', enhanceContinue: true }, { preset: p });
    assert.match(result.messages.at(-1).content, /只补已有回复/);
    assert.doesNotMatch(result.messages.at(-1).content, /本次是重抽/);
    const custom = { ...DEFAULTS, mode: 'pair', prefill: '用户自定义承接', nudge: '用户自定义执行' };
    const migrated = migrateSettings(custom);
    assert.deepEqual(migrated, custom);
    const next = planInjection({ ...req, type: 'swipe' }, migrated, { preset: p });
    assert.match(next.injected[0].content, /用户自定义承接/);
    assert.match(next.injected[1].content, /用户自定义执行/);
    assert.match(next.injected[1].content, /本次是重抽/);
});
test('all CoT variants retain selected length instead of a shared 500-character target', () => {
    for (const v of COT_VARIANTS) {
        const p = preset(); p.prompts[1].identifier = v.id; p.prompt_order[0].order[1].identifier = v.id;
        const cue = deliveryCue(deliveryProfile(p));
        assert.match(cue, /原有栏目、篇幅与创作约束/);
        assert.match(cue, /写完当前句子、段落/);
        assert.doesNotMatch(cue, /500|目标不超过/);
    }
});
test('unpunctuated long prose is weak evidence even under STOP; it is not budget exhaustion', () => {
    const output = analyzeOutput(cut), wire = { visibleChars: cut.length, finishReason: 'STOP', responseComplete: true, output };
    assert.match(endingDiagnosis(output), /疑似句尾未完/);
    assert.match(endingDiagnosis(output), /弱提示/);
    assert.equal(recordStatus({ wire }).label, '疑似句尾未完');
    assert.match(responseDiagnosis(wire), /STOP可能/);
    assert.doesNotMatch(responseDiagnosis(wire), /达到输出上限/);
    assert.ok(!JSON.stringify(output).includes('天色'));
});
test('closed content wrapper still permits sentence-end checks before trailing components', () => {
    const output = analyzeOutput(`<content>${cut}</content>\n<details><summary>摘要</summary>完成。</details>`);
    assert.deepEqual(output.openTags, []);
    assert.equal(output.ending.scope, 'content');
    assert.match(endingDiagnosis(output), /疑似/);
});
test('comma ending and closing quotes do not conceal weak evidence', () => {
    assert.deepEqual(analyzeOutput(paragraph + '她说：“然后，').ending.signals, ['trailing-separator']);
    assert.deepEqual(analyzeOutput(paragraph + '她说：“还有一件事”').ending.signals, ['no-terminal-punctuation']);
    assert.deepEqual(analyzeOutput(paragraph + '她说：“我去拿钥匙。”').ending.signals, []);
});
for (const [name, text] of [
    ['short answer', '好的'], ['list', paragraph + '\n- 红茶'], ['heading', paragraph + '\n## 下一节'],
    ['table', paragraph + '\n| 茶 | 热 |'], ['code block', paragraph + '\n```js\nconst x = 1\n```'],
    ['standalone HTML component', '<details><summary>选项</summary>回家</details>'],
    ['only CoT', '<!-- Lin_CoT: ' + cut + ' -->'],
    ['native text thinking', '<think>' + cut + '</think>'],
    ['complete paragraph', paragraph],
]) test(`no invented sentence cutoff: ${name}`, () => {
    assert.equal(endingDiagnosis(analyzeOutput(text)), '');
});
test('transport/filter/structural reasons outrank weak sentence evidence', () => {
    const output = analyzeOutput(cut);
    for (const [extra, label] of [
        [{ finishReason: 'content_filter' }, '服务端限制'], [{ finishReason: 'MAX_TOKENS' }, '输出预算结束'],
        [{ captureLimited: true }, '取证不完整'], [{ parseErrors: 1 }, '取证不完整'], [{ aborted: true }, '请求已中止'],
    ]) assert.equal(recordStatus({ wire: { output, ...extra } }).label, label);
    assert.equal(recordStatus({ wire: { finishReason: 'STOP', output: analyzeOutput('<content>' + cut) } }).label, '结构未完成');
});
test('reported incident statistics stay inconclusive without original ending text', () => {
    // Reconstructed from the user-pasted report, not a reproduction of the original reply.
    const record = { type: 'swipe', wire: { visibleChars: 2912, finishReason: 'STOP', outputTokens: 2420,
        receivedBytes: 40777, frames: 98, doneMarker: true, responseComplete: true, parseErrors: 0 },
        rendered: { chars: 2912, output: { rawChars: 2912, cotChars: 544, nonCommentChars: 2368 } } };
    assert.equal(recordStatus(record).label, '接口已结束·正文待核');
    assert.match(recordDiagnosis(record), /长度一致/);
    assert.doesNotMatch(recordDiagnosis(record), /疑似句尾未完|达到输出上限|报告拦截/);
});
test('delivery comparison uses raw length; continuation and partial captures are excluded', () => {
    const record = { type: 'swipe', wire: { visibleChars: 10, responseComplete: true }, rendered: { chars: 8, output: { rawChars: 10 } } };
    assert.match(compareDelivery(record), /长度一致/);
    assert.equal(compareDelivery({ ...record, type: 'continue' }), '');
    assert.equal(compareDelivery({ ...record, wire: { ...record.wire, captureLimited: true } }), '');
    assert.match(compareDelivery({ ...record, rendered: { output: { rawChars: 9 } } }), /长度不一致/);
});
test('stop metadata is counts only, records all known fields and never changes the request', () => {
    const request = { max_tokens: 16384, max_completion_tokens: 8192, stop: ['SECRET-A'], stopSequences: 'SECRET-B',
        generationConfig: { stopSequences: ['SECRET-C', 'SECRET-D'] } };
    const before = JSON.stringify(request), meta = requestMeta(request);
    assert.deepEqual(meta.stopCounts, { stop: 1, stopSequences: 1, generationConfig: 2 });
    assert.equal(meta.maxCompletionTokens, 8192);
    assert.ok(!JSON.stringify(meta).includes('SECRET'));
    assert.equal(JSON.stringify(request), before);
    assert.match(formatRecord({ request: meta }), /停止序列声明数/);
    assert.doesNotMatch(formatRecord({ request: meta }), /SECRET/);
});
test('SSE STOP with unfinished prose passes through byte-for-byte and keeps only diagnostic signals', async () => {
    const frames = [
        { choices: [{ delta: { content: '<!-- Lin_CoT: 简要记录 -->\n' } }] },
        { choices: [{ delta: { content: cut }, finish_reason: 'stop' }] },
    ];
    const source = frames.map(x => `data: ${JSON.stringify(x)}\n\n`).join('') + 'data: [DONE]\n\n';
    const bytes = new TextEncoder().encode(source);
    const response = new Response(new ReadableStream({ start(c) {
        for (let i = 0; i < bytes.length; i += 7) c.enqueue(bytes.slice(i, i + 7));
        c.close();
    } }));
    let recorded;
    const target = { location: { href: 'http://localhost/' }, fetch: async () => response };
    const observer = installObserver({ target, enabled: () => true, onDispatch: () => 'test', onResponse: (_, w) => { recorded = w; } });
    const result = await target.fetch('/api/backends/chat-completions/generate', { method: 'POST', body: JSON.stringify({ stream: true }) });
    assert.equal(result, response);
    assert.equal(await result.text(), source);
    await observer.idle(); observer.dispose();
    assert.equal(recorded.doneMarker, true); assert.equal(recorded.parseErrors, 0);
    assert.match(endingDiagnosis(recorded.output), /疑似/);
    assert.ok(!JSON.stringify(recorded).includes('天色'));
});
test('manual inspection of an old saved reply adds ending evidence without requests or chat edits', () => {
    let requests = 0;
    const chat = [{ is_user: false, mes: cut }], before = JSON.stringify(chat);
    const ctx = { chat, eventSource: { on() {}, off() {} }, eventTypes: { CHAT_COMPLETION_SETTINGS_READY: 'ready' } };
    const controller = createController({ getContext: () => ctx, getSettings: () => DEFAULTS,
        networkTarget: { fetch: async () => { requests++; return new Response(''); } } });
    assert.match(controller.inspectCurrent(), /疑似句尾未完/);
    assert.equal(requests, 0); assert.equal(JSON.stringify(chat), before);
    assert.ok(!JSON.stringify(controller.snapshot()).includes('天色'));
    controller.dispose();
});
