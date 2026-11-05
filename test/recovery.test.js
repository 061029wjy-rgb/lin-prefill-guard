import test from 'node:test';
import assert from 'node:assert/strict';
import { createRecovery } from '../recovery.js';

function fixture() {
    const calls = [];
    const ctx = { chat: [{ is_user: true, mes: '接着写。' }, { is_user: false, mes: '她刚拿起书，', swipe_id: 0 }],
        chatId: 'chat-a', characterId: 1, groupId: null, mainApi: 'openai',
        generate: async type => { calls.push(type); } };
    const state = { busy: false, draft: false, record: null };
    const recovery = createRecovery({ getContext: () => ctx, isBusy: () => state.busy,
        hasDraft: () => state.draft, getRecord: () => state.record });
    return { ctx, state, calls, recovery };
}

test('checking a target is read-only; one explicit action invokes the native generator exactly once', async () => {
    const f = fixture(), before = JSON.stringify(f.ctx.chat);
    const plan = f.recovery.prepare();
    assert.equal(plan.ok, true); assert.equal(plan.canContinue, true);
    assert.equal(f.calls.length, 0); assert.equal(JSON.stringify(f.ctx.chat), before);
    assert.ok(!JSON.stringify(plan).includes('拿起书'));
    assert.equal((await f.recovery.run(plan, 'continue')).ok, true);
    assert.deepEqual(f.calls, ['continue']); assert.equal(JSON.stringify(f.ctx.chat), before);
    assert.equal((await f.recovery.run(plan, 'regenerate')).ok, false);
    assert.equal(f.calls.length, 1);
});

for (const [name, mutate] of [
    ['chat identity', f => { f.ctx.chat = structuredClone(f.ctx.chat); }],
    ['chat id', f => { f.ctx.chatId = 'chat-b'; }],
    ['character', f => { f.ctx.characterId = 2; }],
    ['new message', f => { f.ctx.chat.push({ is_user: true, mes: '下一轮' }); }],
    ['edited reply', f => { f.ctx.chat.at(-1).mes += '编辑'; }],
    ['selected swipe', f => { f.ctx.chat.at(-1).swipe_id = 1; }],
    ['replaced reply', f => { f.ctx.chat[1] = { ...f.ctx.chat[1] }; }],
    ['input draft', f => { f.state.draft = true; }],
    ['busy host', f => { f.state.busy = true; }],
    ['active stream', f => { f.ctx.streamingProcessor = { isFinished: false, isStopped: false }; }],
    ['group chat', f => { f.ctx.groupId = 0; }],
    ['unsupported API', f => { f.ctx.mainApi = 'textgenerationwebui'; }],
    ['missing generator', f => { delete f.ctx.generate; }],
    ['late restriction', f => { f.state.record = { wire: { finishReason: 'SAFETY' } }; }],
    ['late refusal', f => { f.state.record = { wire: { refusal: true } }; }],
    ['invalidated target', f => { f.recovery.invalidate(); }],
]) test(`stale or unavailable target cannot send: ${name}`, async () => {
    const f = fixture(), plan = f.recovery.prepare();
    assert.equal(plan.ok, true); mutate(f);
    assert.equal((await f.recovery.run(plan, 'continue')).ok, false);
    assert.equal(f.calls.length, 0);
});

test('an empty reply permits explicit regeneration, not continuation', async () => {
    const f = fixture(); f.ctx.chat[1].mes = ' \n';
    const plan = f.recovery.prepare();
    assert.equal(plan.canContinue, false);
    assert.equal((await f.recovery.run(plan, 'continue')).ok, false);
    assert.equal(f.calls.length, 0);
    assert.equal((await f.recovery.run(plan, 'regenerate')).ok, true);
    assert.deepEqual(f.calls, ['regenerate']);
});
test('only notes are eligible for user-initiated completion; a finished stream does not block it', () => {
    const f = fixture(); f.ctx.chat[1].mes = '<!-- Lin_CoT: unfinished';
    f.ctx.streamingProcessor = { isFinished: true, isStopped: false };
    const plan = f.recovery.prepare(); assert.equal(plan.canContinue, true);
    assert.match(plan.message, /注释/); assert.equal(f.calls.length, 0);
});
test('a user/system final message is never selected for replacement', () => {
    for (const flags of [{ is_user: true }, { is_system: true }]) {
        const f = fixture(); Object.assign(f.ctx.chat.at(-1), flags);
        assert.equal(f.recovery.prepare().ok, false); assert.equal(f.calls.length, 0);
    }
});
test('rapid duplicate actions cannot invoke a second generation', async () => {
    const f = fixture(); let finish;
    f.ctx.generate = async type => { f.calls.push(type); await new Promise(resolve => { finish = resolve; }); };
    const plan = f.recovery.prepare(), first = f.recovery.run(plan, 'continue');
    assert.equal((await f.recovery.run(plan, 'regenerate')).ok, false);
    assert.equal(f.recovery.prepare().ok, false);
    finish(); assert.equal((await first).ok, true); assert.deepEqual(f.calls, ['continue']);
});
test('host failure is not retried and does not expose the original error in feedback', async () => {
    const f = fixture(); f.ctx.generate = async type => { f.calls.push(type); throw new Error('PRIVATE_ERROR'); };
    const result = await f.recovery.run(f.recovery.prepare(), 'regenerate');
    assert.equal(result.ok, false); assert.ok(!JSON.stringify(result).includes('PRIVATE_ERROR'));
    assert.deepEqual(f.calls, ['regenerate']); assert.equal(f.recovery.prepare().ok, true);
});
test('unrecognized plans or actions cannot send', async () => {
    const f = fixture();
    assert.equal((await f.recovery.run({ ok: true, canContinue: true }, 'continue')).ok, false);
    assert.equal((await f.recovery.run(f.recovery.prepare(), 'quiet')).ok, false);
    assert.equal(f.calls.length, 0);
});
