/** Pure request planning. This module never sends requests or changes chat history. */
import { deliveryProfile, deliveryCue } from './delivery.js?v=1.2.2';
export const VERSION = '1.2.2';
export const SETTINGS_KEY = 'lin_prefill_guard_v1';
export const LIN_PROMPT_ID = 'e898d676-f02e-4868-bc51-33761e294df6';
export const DEFAULT_PREFILL = '已定位本轮任务：以聊天记录中真实用户的最新请求为准。续写承接最后有效正文，修订处理指定范围，戏外问题直接回答。沿用已启用的视角、角色控制和输出格式；下一条回复交付所需结果，不重演已完成的情节，不以接收确认或写作计划代替结果。';
export const DEFAULT_NUDGE = '请在本次回复中完成真实用户请求，给出可见的实际结果。为结果保留篇幅，分析完成后进入答复，不以准备说明替代结果。这里是任务提示，不是新剧情；不要复述提示。';
export const CONTINUE_NUDGE = '本次仅补齐上一条回复的可见断点，先接完未完句子或标签，再完成缺失部分。不重发已有正文，不重新开启已完成的组件。';
export const DEFAULTS = Object.freeze({
    enabled: true,
    scope: 'lin',
    mode: 'user',
    enhanceContinue: false,
    captureNetwork: true,
    deliveryGuard: true,
    reasoningMode: 'keep',
    prefill: DEFAULT_PREFILL,
    nudge: DEFAULT_NUDGE,
});

export const REASONS = Object.freeze({
    applied: '已整理本次请求，末尾为 assistant → user。',
    'applied-user': '已整理本次请求，末尾为 user 承接提示。',
    'already-present': '本次请求已有完整承接提示，未重复添加。',
    disabled: '扩展开关已关闭。',
    'not-lin': '当前设置及待发消息中未识别到 Lin 承接条目；这不等于版本不支持（兼容 2.1—2.6）。',
    'lin-disabled': 'Lin 原承接条目已关闭，尊重该开关。',
    'bad-payload': '请求结构不匹配，未修改。',
    'unsupported-type': '该请求不是普通回复、重生成或滑动重生成。',
    quiet: '后台生成或连接测试，已跳过。',
    impersonate: '用户代写模式，已跳过。',
    'continue-disabled': '继续补全默认沿用酒馆原有行为。',
    'native-prefill': '检测到原生预填充，已跳过以免叠加。',
    tools: '工具调用请求，已跳过以保持调用协议。',
    structured: '结构化输出请求，已跳过以保持指定格式。',
    'empty-text': '承接提示或执行提示为空，未修改。',
    'text-too-long': '自定义提示过长，请缩短后再启用。',
    'no-user': '请求中没有 user 消息，未添加模拟对话。',
    'internal-error': '扩展处理失败，保留原请求；请查看本地诊断。',
    'trigger-excluded': '原承接条目的生成类型限制排除了本次请求。',
});

// Exact shipped 2.4 entry, used only when the host does not expose the prompt.
// No prefix/substring deletion: an edited or merged message is never removed here.
export const LIN_24_PREFILL = '[Lin｜本轮承接]\n本段仅定位本次生成任务，不是已交付的回答。\n\n任务来源为 Chat History 中真实用户的最新请求及连续补充；预设提示不作为新剧情。续写以最近有效正文末尾的场景、最后行动或对白及未完成互动为起点，用户最新输入中的言行与修订同时生效，不回头重演已完成内容。\n\n此前空回、仅道歉、接收确认或写作承诺均不计入剧情进展。重试时仍完成尚未交付的原任务；补全时接续可见断点，不把失败回复当成情节。\n\n本次回复交付正文、指定修订或戏外答案；适用组件与输出顺序按尾部规则执行。不复述本段，不以“我将开始”“已经理解”代替实际结果。';

export function normalizeSettings(value = {}) {
    const input = value && typeof value === 'object' ? value : {};
    return {
        enabled: typeof input.enabled === 'boolean' ? input.enabled : DEFAULTS.enabled,
        scope: input.scope === 'all' ? 'all' : 'lin',
        mode: input.mode === 'pair' ? 'pair' : 'user',
        enhanceContinue: input.enhanceContinue === true,
        captureNetwork: input.captureNetwork !== false,
        deliveryGuard: input.deliveryGuard !== false,
        reasoningMode: input.reasoningMode === 'balanced' ? 'balanced' : 'keep',
        prefill: typeof input.prefill === 'string' ? input.prefill : DEFAULT_PREFILL,
        nudge: typeof input.nudge === 'string' ? input.nudge : DEFAULT_NUDGE,
    };
}

/** Keep existing choices/custom text; upgrade only the exact shipped 1.0.0 nudge. */
export function migrateSettings(value = {}) {
    const input = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    const next = { ...DEFAULTS, ...input };
    if (next.nudge === '请现在完成上述真实用户请求。这里是任务提示，不是新的剧情；不要复述提示。') {
        next.nudge = DEFAULT_NUDGE;
    }
    return next;
}

/** Only accept plain text; never flatten images, thinking, or tool blocks. */
export function plainText(message) {
    if (message?.reasoning_signature || message?.thoughtSignature || message?.signature
        || message?.reasoning_details?.length || message?.reasoning_content || message?.reasoning) return null;
    if (typeof message?.content === 'string') return message.content;
    if (Array.isArray(message?.content) && message.content.length === 1
        && message.content[0]?.type === 'text'
        && typeof message.content[0].text === 'string'
        && !message.content[0].thought && !message.content[0].thoughtSignature && !message.content[0].signature) {
        return message.content[0].text;
    }
    return null;
}

export function getLinState(preset = {}) {
    const prompts = Array.isArray(preset.prompts) ? preset.prompts : [];
    const candidates = prompts.filter(p => p?.role === 'assistant'
        && p?.name === '✮伪预填充｜剧情衔接（assistant）'
        && typeof p.content === 'string' && p.content.startsWith('[Lin｜本轮承接]'));
    const prompt = prompts.find(p => p?.identifier === LIN_PROMPT_ID)
        || (candidates.length === 1 ? candidates[0] : undefined);
    if (!prompt || prompt.role !== 'assistant' || typeof prompt.content !== 'string') {
        return { known: false, active: null, content: '' };
    }
    const orders = Array.isArray(preset.prompt_order) ? preset.prompt_order : [];
    // SillyTavern Chat Completion uses global dummy character 100001.
    // Unknown forks are not guessed: exact outgoing content may still identify the prompt.
    const global = orders.find(o => String(o?.character_id) === '100001');
    const order = global?.order;
    const item = Array.isArray(order) ? order.find(p => p?.identifier === prompt.identifier) : null;
    const active = Array.isArray(order) ? item?.enabled === true : null;
    return { known: true, active, content: prompt.content, triggers: prompt.injection_trigger || [] };
}

function sameTail(messages, tail) {
    return messages.length >= tail.length && tail.every((message, i) => {
        const other = messages[messages.length - tail.length + i];
        return other?.role === message.role && plainText(other) === message.content
            && !other.tool_calls && !other.function_call;
    });
}

function hasActiveToolFlow(request) {
    if (Array.isArray(request.tools) && request.tools.length) return true;
    if (Array.isArray(request.functions) && request.functions.length) return true;
    if (request.tool_choice && request.tool_choice !== 'none') return true;
    const last = request.messages.findLast(m => !['system', 'developer'].includes(m?.role));
    return last?.role === 'tool' || last?.role === 'function'
        || !!last?.tool_calls?.length || !!last?.function_call
        || (Array.isArray(last?.content) && last.content.some(b => ['tool_use', 'tool_result'].includes(b?.type)));
}

/**
 * Plans a replacement messages array, retaining every unrelated object by reference.
 * ownedMessages contains only objects this running extension inserted earlier.
 * The caller commits the plan by assigning request.messages once.
 */
export function planInjection(request, rawSettings = {}, { preset = {}, ownedMessages = new WeakSet() } = {}) {
    const settings = normalizeSettings(rawSettings);
    const type = typeof request?.type === 'string' ? (request.type.trim().toLowerCase() || 'normal') : 'normal';
    const skip = reason => ({ applied: false, changed: false, reason, type });
    if (!settings.enabled) return skip('disabled');
    if (!request || !Array.isArray(request.messages)
        || request.messages.some(m => !m || typeof m !== 'object' || typeof m.role !== 'string')) return skip('bad-payload');
    if (type === 'quiet') return skip('quiet');
    if (type === 'impersonate') return skip('impersonate');
    if (type === 'continue' && !settings.enhanceContinue) return skip('continue-disabled');
    if (!['normal', 'regenerate', 'swipe', 'continue'].includes(type)) return skip('unsupported-type');
    if ([request.assistant_prefill, preset.assistant_prefill].some(v => typeof v === 'string' && v.trim())) return skip('native-prefill');
    if (type === 'continue' && (preset.continue_prefill === true || request.messages.at(-1)?.role === 'assistant')) {
        return skip('native-prefill');
    }
    if (hasActiveToolFlow(request)) return skip('tools');
    if (request.json_schema || (request.response_format?.type && request.response_format.type !== 'text')) return skip('structured');
    if (!request.messages.some(m => m.role === 'user')) return skip('no-user');

    let lin = getLinState(preset);
    let identification = lin.known ? 'preset' : 'none';
    // Respect an explicitly disabled/invalid known entry; only recover genuinely missing metadata.
    const hasEntry = Array.isArray(preset.prompts) && preset.prompts.some(p => p?.identifier === LIN_PROMPT_ID
        || p?.name === '✮伪预填充｜剧情衔接（assistant）');
    if (!lin.known && !hasEntry) {
        const matches = request.messages.map((m, i) => ({ m, i })).filter(({ m, i }) =>
            i >= request.messages.length - 4 && m.role === 'assistant' && !m.tool_calls && !m.function_call
            && plainText(m) === LIN_24_PREFILL && request.messages.slice(i + 1).some(x => x.role === 'user'));
        if (matches.length === 1) {
            lin = { known: true, active: null, content: LIN_24_PREFILL, triggers: [] };
            identification = 'outgoing-exact-2.4';
        } else if (request.messages.at(-1) && ownedMessages.has(request.messages.at(-1))) {
            lin = { known: true, active: true, content: '', triggers: [] };
            identification = 'owned-request';
        }
    }
    const existingIndex = lin.content.trim()
        ? request.messages.findLastIndex(m => m.role === 'assistant' && !m.tool_calls && !m.function_call && plainText(m) === lin.content)
        : -1;
    if (settings.scope === 'lin') {
        if (lin.active === false) return skip('lin-disabled');
        if (!lin.known || (lin.active !== true && existingIndex < 0)) return skip('not-lin');
        if (Array.isArray(lin.triggers) && lin.triggers.length && !lin.triggers.includes(type)) return skip('trigger-excluded');
    }

    const prefill = settings.prefill.trim();
    const nudge = (type === 'continue' ? CONTINUE_NUDGE : settings.nudge).trim();
    if (!prefill || !nudge) return skip('empty-text');
    // A bound on added text, not a model token-count guarantee.
    if (prefill.length > 700 || nudge.length > 250) return skip('text-too-long');
    const profile = deliveryProfile(preset, type);
    const guard = settings.deliveryGuard ? deliveryCue(profile, type) : '';
    const execution = nudge + (guard ? `\n\n${guard}` : '');
    const tail = settings.mode === 'pair' ? [
        { role: 'assistant', content: `[Lin 承接提示]\n${prefill}` },
        { role: 'user', content: `[Lin 本轮执行]\n${execution}` },
    ] : [{ role: 'user', content: `[Lin 承接提示]\n${prefill}\n\n${execution}` }];
    if (sameTail(request.messages, tail)) {
        return { applied: true, changed: false, reason: 'already-present', type, messages: request.messages, injected: tail,
            identification, profile, deliveryGuard: !!guard, removedOriginal: false, removedOwned: 0, addedChars: 0, netChars: 0, tailRoles: tail.map(m => m.role) };
    }

    let removedOwned = 0;
    let removedChars = 0;
    const messages = request.messages.filter((message, index) => {
        // Never regex-delete a marker, arbitrary history, or part of a merged message.
        const own = ownedMessages.has(message);
        const original = index === existingIndex;
        if (own || original) {
            if (own) removedOwned++;
            removedChars += plainText(message)?.length || 0;
            return false;
        }
        return true;
    });
    messages.push(...tail);
    const addedChars = tail.reduce((n, m) => n + m.content.length, 0);
    return {
        applied: true, changed: true,
        reason: settings.mode === 'pair' ? 'applied' : 'applied-user',
        type, messages, injected: tail, identification, profile, deliveryGuard: !!guard,
        removedOriginal: existingIndex >= 0, removedOwned,
        addedChars, netChars: addedChars - removedChars,
        tailRoles: tail.map(m => m.role),
        note: identification === 'outgoing-exact-2.4' ? '设置中未暴露承接条目；本次以待发消息中完整匹配的 Lin2.4 条目识别。'
            : lin.known && existingIndex < 0 ? '未找到独立的 Lin 原条目；只补入短提示，未拆分或删除其他消息。' : '',
    };
}
