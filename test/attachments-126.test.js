import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { DEFAULTS as OBSERVE_DEFAULTS, LIN_PROMPT_ID, planInjection } from '../core.js';
const DEFAULTS = { ...OBSERVE_DEFAULTS, requestMode: 'enhance' };
import { COT_VARIANTS, deliveryProfile } from '../delivery.js';
import { recordStatus, shortReplyEvidence } from '../diagnostics.js';

// Optional local fixtures. Private presets and logs are never bundled.
test('actual Lin2.6.3: 48 CoT/mode/generation combinations preserve source and budgets',
    { skip: !process.env.LIN263_PRESET_PATH }, () => {
        const path = process.env.LIN263_PRESET_PATH, bytes = fs.readFileSync(path);
        const source = JSON.parse(bytes);
        assert.equal(deliveryProfile(source).cotEnabled, true);
        for (let mask = 0; mask < 8; mask++) for (const mode of ['user', 'pair']) for (const type of ['normal', 'regenerate', 'swipe']) {
            const p = structuredClone(source), order = p.prompt_order.find(o => String(o.character_id) === '100001').order;
            COT_VARIANTS.forEach((v, i) => { order.find(o => o.identifier === v.id).enabled = !!(mask & (1 << i)); });
            const messages = [{ role: 'user', content: '写一段普通日常。' }, ...order.filter(o => o.enabled).flatMap(o => {
                const prompt = p.prompts.find(x => x.identifier === o.identifier);
                return prompt?.content && prompt.role ? [{ role: prompt.role, content: prompt.content }] : [];
            })];
            const request = { type, messages, model: 'gemini-4-argon', max_tokens: 16384, stream: true,
                reasoning_effort: 'auto', stop: ['END_CUSTOM'] }, before = JSON.stringify({ p, request });
            const result = planInjection(request, { ...DEFAULTS, mode }, { preset: p });
            assert.equal(result.applied, true); assert.equal(result.deliveryGuard, true);
            assert.equal(result.profile.cotSources.length, COT_VARIANTS.filter((_, i) => mask & (1 << i)).length);
            const originalCue = p.prompts.find(x => x.identifier === LIN_PROMPT_ID).content;
            assert.deepEqual(result.messages.slice(0, -result.injected.length), messages.filter(m => !(m.role === 'assistant' && m.content === originalCue)));
            assert.equal(JSON.stringify({ p, request }), before);
            assert.equal(planInjection({ ...request, messages: result.messages }, { ...DEFAULTS, mode }, { preset: p }).changed, false);
        }
        assert.deepEqual(fs.readFileSync(path), bytes);
    });

test('actual 1.2.5 feedback: three short replies are flagged; helper calls stay unassociated',
    { skip: !process.env.LIN126_HISTORY_PATH }, () => {
        const records = JSON.parse(fs.readFileSync(process.env.LIN126_HISTORY_PATH, 'utf8')).records;
        const before = JSON.stringify(records), story = records.filter(r => r.request?.model === 'gemini-4-argon');
        assert.equal(records.length, 50); assert.equal(story.length, 25);
        const short = story.filter(r => shortReplyEvidence(r));
        assert.deepEqual(short.map(r => r.wire.visibleChars).sort((a, b) => a - b), [92, 176, 205]);
        assert.ok(short.every(r => recordStatus(r).label === '短回复·请核对'));
        assert.ok(story.every(r => r.wire.visibleChars === r.rendered.chars));
        const helper = records.filter(r => r.request?.model === 'deepseek-flash');
        assert.equal(helper.length, 25); assert.ok(helper.every(r => r.reason === 'unmatched-dispatch' && !r.rendered));
        assert.equal(JSON.stringify(records), before);
    });
