import { planInjection, REASONS, VERSION } from './core.js';

/** Connect the pure planner to the documented ST event, with no fetch monkey-patch. */
export function createController({ getContext, getSettings, onStatus = () => {} }) {
    const ctx = getContext();
    const events = ctx.eventTypes || ctx.event_types || {};
    const bus = ctx.eventSource;
    const requestEvent = events.CHAT_COMPLETION_SETTINGS_READY;
    const ownedMessages = new WeakSet();
    const subscriptions = [];
    let disposed = false;
    let last = null;
    let lastSkip = null;
    let response = null;

    function publish() {
        // A broken settings panel must never affect request construction.
        try { onStatus({ last, lastSkip, response, version: VERSION }); } catch { /* UI-only failure */ }
    }
    function handleRequest(request) {
        if (disposed) return;
        try {
            const context = getContext();
            const result = planInjection(request, getSettings(), {
                preset: context.chatCompletionSettings || {}, ownedMessages,
            });
            if (result.changed) {
                // Single commit: earlier checks and validation never mutate request or history.
                request.messages = result.messages;
                result.injected.forEach(m => ownedMessages.add(m));
            }
            const report = {
                at: new Date().toISOString(), type: result.type,
                applied: result.applied, reason: result.reason,
                explanation: REASONS[result.reason],
                removedOriginal: result.removedOriginal || false,
                netChars: result.netChars || 0,
                tailRoles: result.tailRoles || [],
                note: result.note || '',
                // Only our own injected prompts, never whole chats, headers, or keys.
                preview: result.applied ? result.injected.map(m => `${m.role}\n${m.content}`).join('\n\n') : '',
            };
            if (result.type === 'quiet' || result.type === 'impersonate') lastSkip = report;
            else { last = report; response = null; }
            publish();
        } catch {
            last = { at: new Date().toISOString(), applied: false, reason: 'internal-error', explanation: REASONS['internal-error'], preview: '' };
            publish();
        }
    }

    function lateRegistration() {
        if (disposed || !requestEvent) return;
        // makeLast repositions, rather than adding a second copy, in ST's EventEmitter.
        if (typeof bus.makeLast === 'function') bus.makeLast(requestEvent, handleRequest);
    }

    function onMessage(id, type) {
        if (disposed || !last?.applied || type === 'quiet' || type === 'impersonate') return;
        const message = getContext().chat?.[Number(id)];
        if (!message || message.is_user) return;
        const chars = typeof message.mes === 'string' ? message.mes.trim().length : 0;
        response = chars ? `收到可见正文（${chars} 字符）；是否符合要求需实际阅读。`
            : '收到空正文：检查 API 错误、输出预算与过滤规则。扩展不会自动重试或伪造正文。';
        publish();
    }

    function subscribe(event, fn) {
        if (!event) return;
        bus.on(event, fn);
        subscriptions.push([event, fn]);
    }

    if (!bus || typeof bus.on !== 'function' || !requestEvent) {
        last = { applied: false, reason: 'unsupported-client', explanation: '当前酒馆未提供所需的 Chat Completion 事件。请升级官方酒馆，或确认所用分支兼容。', preview: '' };
        publish();
    } else {
        subscribe(requestEvent, handleRequest);
        subscribe(events.GENERATION_STARTED, lateRegistration);
        subscribe(events.MESSAGE_RECEIVED, onMessage);
        lateRegistration();
    }

    return {
        snapshot: () => ({ last, lastSkip, response, version: VERSION }),
        preview(request) {
            return planInjection(request, getSettings(), { preset: getContext().chatCompletionSettings || {} });
        },
        dispose() {
            disposed = true;
            const remove = bus?.removeListener || bus?.off;
            if (remove) subscriptions.forEach(([event, fn]) => remove.call(bus, event, fn));
            subscriptions.length = 0;
        },
    };
}
