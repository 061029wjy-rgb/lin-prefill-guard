import test from 'node:test';
import assert from 'node:assert/strict';
import { createController } from '../controller.js';
import { DEFAULTS, LIN_PROMPT_ID } from '../core.js';

class Bus {
    listeners = new Map();
    on(event, fn) { const entries = this.listeners.get(event) || []; entries.push(fn); this.listeners.set(event, entries); }
    removeListener(event, fn) { this.listeners.set(event, (this.listeners.get(event) || []).filter(x => x !== fn)); }
    makeLast(event, fn) { this.removeListener(event, fn); this.on(event, fn); }
    async emit(event, ...args) { for (const fn of [...(this.listeners.get(event) || [])]) await fn(...args); }
}
function fixture(extra = {}) {
    const bus = new Bus();
    const config = { ...DEFAULTS };
    const ctx = { eventSource: bus, eventTypes: { CHAT_COMPLETION_SETTINGS_READY: 'request', GENERATION_STARTED: 'start', MESSAGE_RECEIVED: 'message' },
        chatCompletionSettings: { prompts: [{ identifier: LIN_PROMPT_ID, role: 'assistant', content: '原承接' }], prompt_order: [{ character_id: 100001, order: [{ identifier: LIN_PROMPT_ID, enabled: true }] }] },
        chat: [{ is_user: false, mes: '书店里一片寂静。' }], ...extra };
    const views = [];
    const controller = createController({ getContext: () => ctx, getSettings: () => config, onStatus: x => views.push(x) });
    const request = () => ({ type: 'normal', messages: [{ role: 'user', content: '接着写。' }, { role: 'assistant', content: '原承接' }, { role: 'user', content: '尾部' }], stream: true });
    return { bus, config, ctx, controller, request, views };
}

test('event mutates only the temporary request.messages property, not saved chat or settings', async () => {
    const f = fixture(); const chat = structuredClone(f.ctx.chat); const preset = structuredClone(f.ctx.chatCompletionSettings);
    const req = f.request(); await f.bus.emit('request', req);
    assert.equal(req.messages.at(-1).role, 'user'); assert.equal(req.messages.length, 4); assert.equal(req.stream, true);
    assert.deepEqual(f.ctx.chat, chat); assert.deepEqual(f.ctx.chatCompletionSettings, preset);
    assert.equal(f.controller.snapshot().last.applied, true);
});
test('late registration does not accumulate listeners and follows already registered modifiers', async () => {
    const f = fixture();
    f.bus.on('request', req => req.messages.push({ role: 'user', content: '其他扩展' }));
    for (let i = 0; i < 10; i++) await f.bus.emit('start');
    assert.equal(f.bus.listeners.get('request').length, 2);
    const req = f.request(); await f.bus.emit('request', req);
    assert.equal(req.messages.at(-3).content, '其他扩展'); assert.equal(f.views.length, 1);
});
test('same request event twice is idempotent', async () => {
    const f = fixture(); const req = f.request();
    await f.bus.emit('request', req); const first = structuredClone(req);
    await f.bus.emit('request', req); assert.deepEqual(req, first);
    assert.equal(f.controller.snapshot().last.reason, 'already-present');
});
test('quiet requests use their own payload.type and do not overwrite the visible generation status', async () => {
    const f = fixture(); const normal = f.request(); const quiet = { ...f.request(), type: 'quiet' }; const before = structuredClone(quiet);
    await f.bus.emit('request', normal); await f.bus.emit('request', quiet);
    assert.deepEqual(quiet, before); assert.equal(f.controller.snapshot().last.type, 'normal'); assert.equal(f.controller.snapshot().lastSkip.reason, 'quiet');
});
test('dispose removes listeners and stops all request mutation', async () => {
    const f = fixture(); f.controller.dispose(); const req = f.request(); const before = structuredClone(req);
    await f.bus.emit('start'); await f.bus.emit('request', req); assert.deepEqual(req, before);
    assert.equal(f.bus.listeners.get('request').length, 0);
});
test('local preview neither sends nor mutates and does not masquerade as an actual injection', () => {
    const f = fixture(); const req = f.request(); const before = structuredClone(req);
    assert.equal(f.controller.preview(req).applied, true); assert.deepEqual(req, before); assert.equal(f.controller.snapshot().last, null);
});
test('empty text is reported without changing a response or triggering a new request', async () => {
    const f = fixture(); f.ctx.chat[0].mes = ''; await f.bus.emit('request', f.request()); await f.bus.emit('message', 0);
    assert.match(f.controller.snapshot().response, /空正文/); assert.equal(f.ctx.chat[0].mes, '');
});
test('unsupported event API is reported instead of guessed', () => {
    const f = fixture({ eventTypes: {} }); assert.equal(f.controller.snapshot().last.reason, 'unsupported-client');
});
test('frozen request is preserved and reported as an error', async () => {
    const f = fixture(); const req = Object.freeze(f.request()); const before = structuredClone(req);
    await f.bus.emit('request', req); assert.deepEqual(req, before); assert.equal(f.controller.snapshot().last.reason, 'internal-error');
});
test('a settings UI exception cannot break request preparation', async () => {
    const f = fixture(); f.controller.dispose();
    const c = createController({ getContext: () => f.ctx, getSettings: () => f.config, onStatus: () => { throw new Error('UI failure'); } });
    const req = f.request(); await f.bus.emit('request', req);
    assert.equal(c.snapshot().last.applied, true); assert.equal(req.messages.at(-1).role, 'user');
});
