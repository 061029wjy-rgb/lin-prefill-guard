import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { analyzeOutput, structureDiagnosis } from '../structure.js';
import { deliveryProfile, deliveryCue, COT_ID } from '../delivery.js';
import { planInjection, LIN_PROMPT_ID, LIN_24_PREFILL, DEFAULTS } from '../core.js';
import { inspectResponse } from '../observer.js';
import { responseDiagnosis, auditPreset } from '../diagnostics.js';

function preset() {
    const prompts = [
        { identifier: LIN_PROMPT_ID, role: 'assistant', content: LIN_24_PREFILL },
        { identifier: COT_ID, role: 'system', content: '本条将Lin2.6实际启用的规则汇总为一次创作核对。' },
        { identifier: '21ae8a8a-9291-46d1-8f69-f5d5a04016db', content: 'Options' },
    ];
    return { prompts, prompt_order: [{ character_id: 100001, order: prompts.map(p => ({ identifier: p.identifier, enabled: true })) }] };
}
const request = () => ({ type: 'normal', messages: [{ role: 'user', content: 'Continue an ordinary story.' },
    { role: 'assistant', content: LIN_24_PREFILL }, { role: 'user', content: 'Deliver the actual result.' }] });
const sse = frames => frames.map(f => 'data: ' + (typeof f === 'string' ? f : JSON.stringify(f)) + '\n\n').join('');
const chunked = text => {
    const bytes = new TextEncoder().encode(text);
    return new Response(new ReadableStream({ start(c) { for (let i = 0; i < bytes.length; i += 5) c.enqueue(bytes.slice(i, i + 5)); c.close(); } }));
};

test('5013 characters of Lin_CoT with STOP never count as story prose', async () => {
    const prefix = '<!-- Lin_CoT:\n', suffix = '\n-->';
    const body = prefix + 'x'.repeat(5013 - prefix.length - suffix.length) + suffix;
    const wire = await inspectResponse(chunked(sse([
        { candidates: [{ content: { parts: [{ text: body }] }, finishReason: 'STOP' }], usageMetadata: { candidatesTokenCount: 4081 } },
    ])));
    assert.equal(wire.visibleChars, 5013); assert.equal(wire.output.cotChars, 5013);
    assert.equal(wire.output.nonCommentChars, 0); assert.equal(wire.output.onlyNotes, true);
    assert.equal(wire.finishReason, 'STOP'); assert.equal(wire.reasoningChars, 0);
    assert.match(responseDiagnosis(wire), /尚无.*正文/); assert.match(responseDiagnosis(wire), /STOP/);
    assert.doesNotMatch(responseDiagnosis(wire), /达到输出上限/);
    assert.ok(!JSON.stringify(wire).includes('x'.repeat(100)));
});
test('split comment plus actual prose separates metadata from output', async () => {
    const wire = await inspectResponse(chunked(sse([
        { choices: [{ delta: { content: '<!-- Lin_' } }] },
        { choices: [{ delta: { content: 'CoT: brief -->\n正文继续。' }, finish_reason: 'stop' }] }, '[DONE]',
    ])));
    assert.equal(wire.output.cotCount, 1); assert.equal(wire.output.closedCotCount, 1);
    assert.equal(wire.output.onlyNotes, false); assert.equal(wire.output.nonCommentChars, 5);
});
test('unfinished comment is detected even with STOP', () => {
    const output = analyzeOutput('<!-- Lin_CoT: incomplete');
    assert.equal(output.openComment, true); assert.equal(output.onlyNotes, true);
    assert.match(structureDiagnosis(output), /未闭合/);
});
test('fenced HTML examples are not interpreted as hidden comments or components', () => {
    const output = analyzeOutput('```html\n<!-- Lin_CoT: example\n<Lin_options>\n```');
    assert.equal(output.openComment, false); assert.equal(output.onlyNotes, false);
    assert.deepEqual(output.openTags, []); assert.equal(output.openFence, false);
});
test('unclosed component and code fence are diagnosed without fabricating the missing suffix', () => {
    const output = analyzeOutput('正文。\n<Lin_options><choice1>next');
    assert.deepEqual(output.openTags, ['lin_options', 'choice1']);
    assert.equal(analyzeOutput('正文\n```html\n<div>').openFence, true);
});
test('native thinking tags inside content are not accepted as a completed body', () => {
    assert.equal(analyzeOutput('<think>plan only</think>').onlyNotes, true);
    assert.equal(analyzeOutput('<thinking>unfinished').openThinking, true);
    assert.equal(analyzeOutput('<think>plan</think>Actual answer.').onlyNotes, false);
});
test('SSE EOF without terminator is reported even when partial text exists', async () => {
    const wire = await inspectResponse(chunked(sse([{ choices: [{ delta: { content: 'Part of a sentence' } }] }])));
    assert.equal(wire.missingTerminal, true); assert.match(responseDiagnosis(wire), /缺少结束原因和结束标志/);
});
test('finish reason, DONE or provider message_stop are valid terminal evidence', async () => {
    for (const frames of [
        [{ choices: [{ delta: { content: 'Done.' }, finish_reason: 'stop' }] }],
        [{ choices: [{ delta: { content: 'Done.' } }] }, '[DONE]'],
        [{ type: 'content_block_delta', delta: { text: 'Done.' } }, { type: 'message_stop' }],
    ]) assert.notEqual((await inspectResponse(chunked(sse(frames)))).missingTerminal, true);
});
test('final snapshot after deltas replaces the count instead of counting the same text twice', async () => {
    const wire = await inspectResponse(chunked(sse([
        { choices: [{ delta: { content: 'Hello' } }] },
        { choices: [{ message: { content: 'Hello' }, finish_reason: 'stop' }] },
    ])));
    assert.equal(wire.visibleChars, 5); assert.equal(wire.output.rawChars, 5);
});
test('nameless Lin2.6 gets an actual delivery guard in both injection modes', () => {
    const p = preset(); const original = structuredClone(p);
    for (const mode of ['user', 'pair']) {
        const result = planInjection(request(), { ...DEFAULTS, mode }, { preset: p });
        assert.equal(result.deliveryGuard, true); assert.match(result.messages.at(-1).content, /500汉字/);
        assert.match(result.messages.at(-1).content, /未启用/);
        assert.match(result.messages.at(-1).content, /不是新剧情/);
    }
    assert.deepEqual(p, original);
});
test('guard is idempotent and respects its switch', () => {
    const p = preset(), first = planInjection(request(), DEFAULTS, { preset: p });
    const second = planInjection({ ...request(), messages: first.messages }, DEFAULTS, { preset: p });
    assert.equal(second.changed, false);
    assert.equal(planInjection(request(), { ...DEFAULTS, deliveryGuard: false }, { preset: p }).deliveryGuard, false);
});
test('module order switches and generation triggers override dormant prompt.enabled fields', () => {
    const p = preset(); p.prompts[1].enabled = true;
    p.prompt_order[0].order[1].enabled = false;
    const profile = deliveryProfile(p);
    assert.equal(profile.cotEnabled, false); assert.doesNotMatch(deliveryCue(profile), /500汉字/);
    p.prompt_order[0].order[1].enabled = true; p.prompts[1].injection_trigger = ['swipe'];
    assert.equal(deliveryProfile(p, 'normal').cotEnabled, false);
    assert.equal(deliveryProfile(p, 'swipe').cotEnabled, true);
});
test('unknown preset names do not activate Lin2.6 guard', () => {
    assert.equal(deliveryProfile({ name: 'Lin2.6' }).known, false);
    const p = preset(); p.prompts[1].content = 'Another custom prompt';
    assert.equal(planInjection(request(), DEFAULTS, { preset: p }).deliveryGuard, false);
});
test('absent order never implies that a module is enabled', () => {
    const p = preset(); delete p.prompt_order;
    assert.equal(deliveryCue(deliveryProfile(p)), '');
});
test('diagnostic labels input counts and warns about component stop sequences without altering them', () => {
    const p = preset(); p.prompts[1].content += 'x'.repeat(21000);
    const req = { stop: ['-->'] }; const original = structuredClone(req);
    const notes = auditPreset(p, req).join('\n');
    assert.match(notes, /输入侧.*不是模型输出/); assert.match(notes, /停止序列/);
    assert.deepEqual(req, original);
});

// Optional real-preset regression: no private presets are bundled into the public plugin.
for (const [env, guarded] of [['LIN25_PRESET_PATH', false], ['LIN26_PRESET_PATH', true], ['LIN26_FIXED_PRESET_PATH', true]]) {
    test(`real preset compatibility: ${env}`, { skip: !process.env[env] }, () => {
        const p = JSON.parse(fs.readFileSync(process.env[env], 'utf8'));
        const before = JSON.stringify(p);
        const order = p.prompt_order.find(o => o.character_id === 100001).order;
        const messages = [{ role: 'user', content: 'Continue an ordinary story.' }, ...order.filter(o => o.enabled).flatMap(o => {
            const prompt = p.prompts.find(x => x.identifier === o.identifier);
            return prompt?.content && prompt.role ? [{ role: prompt.role, content: prompt.content }] : [];
        })];
        for (const mode of ['pair', 'user']) for (const type of ['normal', 'regenerate', 'swipe']) {
            const result = planInjection({ type, messages, model: 'gemini-4-argon' }, { ...DEFAULTS, mode }, { preset: p });
            assert.equal(result.applied, true); assert.equal(result.deliveryGuard, guarded);
            assert.equal(result.removedOriginal, true);
            if (guarded) assert.match(result.messages.at(-1).content, /500汉字/);
        }
        assert.equal(JSON.stringify(p), before);
    });
}
