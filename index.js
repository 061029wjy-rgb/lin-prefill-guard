import { DEFAULTS, DEFAULT_PREFILL, DEFAULT_NUDGE, SETTINGS_KEY, VERSION, REASONS, normalizeSettings } from './core.js';
import { createController } from './controller.js';

const INSTANCE_KEY = Symbol.for('lin-prefill-guard.instance');
let controller;
let panel;
let pendingReady;
let lastView;

function context() { return globalThis.SillyTavern.getContext(); }
function settings() {
    const ctx = context();
    if (!ctx.extensionSettings) throw new Error('Extension settings unavailable');
    const current = ctx.extensionSettings[SETTINGS_KEY];
    if (!current || typeof current !== 'object' || Array.isArray(current)) {
        ctx.extensionSettings[SETTINGS_KEY] = { ...DEFAULTS };
    }
    return ctx.extensionSettings[SETTINGS_KEY];
}
function save(key, value) {
    settings()[key] = value;
    context().saveSettingsDebounced();
    updateStatus(controller?.snapshot());
}
function element(tag, props = {}, text = '') {
    const node = document.createElement(tag);
    Object.assign(node, props);
    if (text) node.textContent = text;
    return node;
}
function hint(text) { return element('p', { className: 'lpg-hint' }, text); }

function updateStatus(view) {
    if (view) lastView = view;
    if (!panel) return;
    const state = normalizeSettings(settings());
    const last = lastView?.last;
    const badge = panel.querySelector('.lpg-badge');
    badge.textContent = !state.enabled ? '已关闭' : last?.applied ? '已注入' : last ? '未注入' : '等待请求';
    badge.dataset.state = !state.enabled ? 'off' : last?.applied ? 'ok' : 'idle';
    const status = panel.querySelector('.lpg-status');
    const lines = [];
    if (!state.enabled) lines.push('扩展当前关闭，下次请求不注入。以下为最近记录。');
    if (last) {
        if (last.at) lines.push(`最近检查：${new Date(last.at).toLocaleTimeString()} · ${last.type || '未知类型'}`);
        lines.push(last.explanation);
        if (last.applied) {
            lines.push(`原承接条目：${last.removedOriginal ? '仅在本次请求中替换' : '未移除'}；字符净变化：${last.netChars >= 0 ? '+' : ''}${last.netChars}`);
            lines.push('已注入只表示通过本扩展的本地检查，不代表服务器接收或模型执行。');
        }
        if (last.note) lines.push(last.note);
    } else lines.push('选择 Lin 预设并正常发送一条消息后，这里会显示检查结果。');
    if (lastView?.response) lines.push(lastView.response);
    if (lastView?.lastSkip) lines.push(`后台检查：${lastView.lastSkip.explanation}`);
    status.textContent = lines.join('\n');
    panel.querySelector('.lpg-preview').textContent = last?.preview || '尚无本轮注入内容。';
}

function checkbox(label, key) {
    const row = element('label', { className: 'lpg-check' });
    const input = element('input', { type: 'checkbox', checked: normalizeSettings(settings())[key] });
    input.dataset.setting = key;
    input.addEventListener('change', () => save(key, input.checked));
    row.append(input, element('span', {}, label));
    return row;
}
function select(label, key, options) {
    const row = element('label', { className: 'lpg-field' });
    row.append(element('span', {}, label));
    const input = element('select', { className: 'text_pole' });
    input.dataset.setting = key;
    options.forEach(([value, text]) => input.append(element('option', { value }, text)));
    input.value = normalizeSettings(settings())[key];
    input.addEventListener('change', () => save(key, input.value));
    row.append(input);
    return row;
}
function textarea(label, key, maxLength) {
    const row = element('label', { className: 'lpg-field' });
    row.append(element('span', {}, label));
    const input = element('textarea', { className: 'text_pole', rows: key === 'prefill' ? 5 : 3, maxLength, value: normalizeSettings(settings())[key] });
    input.dataset.setting = key;
    input.addEventListener('input', () => save(key, input.value));
    row.append(input);
    return row;
}

function mount() {
    if (panel?.isConnected) return;
    const host = document.querySelector('#extensions_settings2') || document.querySelector('#extensions_settings');
    if (!host) return;
    document.getElementById('lin-prefill-guard-panel')?.remove();
    panel = element('details', { id: 'lin-prefill-guard-panel', className: 'lpg-panel', open: true });
    const heading = element('summary', { className: 'lpg-heading' });
    heading.append(element('span', {}, 'Lin 预填充助手'), element('span', { className: 'lpg-badge' }, '等待请求'));
    panel.append(heading);
    const body = element('div', { className: 'lpg-body' });
    body.append(hint(`v${VERSION} · 请求发送前整理承接提示。普通消息引导，不是原生预填充。`));
    body.append(checkbox('启用扩展', 'enabled'));
    body.append(select('适用范围', 'scope', [['lin', '仅已识别且启用的 Lin 2.1 承接条目（推荐）'], ['all', '所有 Chat Completion 预设']]));
    body.append(select('注入方式', 'mode', [['pair', 'assistant 承接 + user 执行（推荐）'], ['user', '单条 user 提示（兼容模式）']]));
    body.append(checkbox('对“继续补全”也加提示（默认关闭）', 'enhanceContinue'));
    body.append(hint('原生继续预填充、后台摘要、用户代写、工具调用和 JSON 结构化请求会自动跳过。'));
    const advanced = element('details', { className: 'lpg-advanced' });
    advanced.append(element('summary', {}, '编辑承接提示'));
    advanced.append(textarea('承接文本（最多 700 字符）', 'prefill', 700));
    advanced.append(textarea('执行文本（最多 250 字符）', 'nudge', 250));
    const reset = element('button', { type: 'button', className: 'menu_button lpg-button' }, '恢复默认提示');
    reset.addEventListener('click', () => {
        save('prefill', DEFAULT_PREFILL);
        save('nudge', DEFAULT_NUDGE);
        panel.querySelector('[data-setting="prefill"]').value = DEFAULT_PREFILL;
        panel.querySelector('[data-setting="nudge"]').value = DEFAULT_NUDGE;
    });
    advanced.append(reset);
    body.append(advanced);
    const status = element('div', { className: 'lpg-status', role: 'status' });
    status.setAttribute('aria-live', 'polite');
    body.append(status);
    const selftest = element('button', { type: 'button', className: 'menu_button lpg-button' }, '本地自检（不调用模型）');
    const selfResult = element('p', { className: 'lpg-hint lpg-selftest', role: 'status' });
    selftest.addEventListener('click', () => {
        const result = controller.preview({ type: 'normal', messages: [{ role: 'user', content: '本地自检样例：接着写一个普通场景。' }] });
        selfResult.textContent = result.applied
            ? `本地组装成功：末尾 ${result.tailRoles.join(' → ')}。未发送网络请求；实际模型效果需在聊天中验证。`
            : `本地自检：${REASONS[result.reason] || result.reason}`;
    });
    body.append(selftest, selfResult);
    const preview = element('details', { className: 'lpg-advanced' });
    preview.append(element('summary', {}, '查看最近实际注入的文本'), element('pre', { className: 'lpg-preview' }));
    body.append(preview);
    body.append(hint('关闭扩展开关即可停止后续注入。原预设、世界书、聊天记录和回复内容均由酒馆原流程保存。'));
    panel.append(body);
    host.append(panel);
    updateStatus(controller?.snapshot());
}

export function onDisable() {
    controller?.dispose();
    controller = undefined;
    if (pendingReady && globalThis.SillyTavern?.getContext) {
        const bus = context().eventSource;
        const remove = bus.removeListener || bus.off;
        remove?.call(bus, pendingReady.event, pendingReady.fn);
        pendingReady = undefined;
    }
    panel?.remove();
    panel = undefined;
    if (globalThis[INSTANCE_KEY]?.dispose === onDisable) delete globalThis[INSTANCE_KEY];
}

export function onEnable() {
    if (!globalThis.SillyTavern?.getContext) {
        console.warn('[Lin Prefill Guard] 请通过酒馆扩展安装本模块。');
        return;
    }
    globalThis[INSTANCE_KEY]?.dispose?.();
    globalThis[INSTANCE_KEY] = { dispose: onDisable };
    lastView = undefined;
    controller = createController({ getContext: context, getSettings: settings, onStatus: updateStatus });
    mount();
    const ctx = context();
    const ready = (ctx.eventTypes || ctx.event_types)?.APP_READY;
    if (ready) {
        pendingReady = { event: ready, fn: mount };
        ctx.eventSource.on(ready, mount);
    }
}

onEnable();
