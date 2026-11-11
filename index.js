import { gemini4Target, lin282Layout } from './gemini4.js?v=1.2.8';
import { DEFAULT_PREFILL, DEFAULT_NUDGE, SETTINGS_KEY, VERSION, REASONS, normalizeSettings, migrateSettings } from './core.js?v=1.2.8';
import { createController } from './controller.js?v=1.2.8';
import { formatRecord, recordStatus } from './diagnostics.js?v=1.2.8';

const INSTANCE_KEY = Symbol.for('lin-prefill-guard.instance');
let controller;
let panel;
let pendingReady;
let lastView;
let selectedRecord = '';

function context() { return globalThis.SillyTavern.getContext(); }
function settings() {
    const ctx = context();
    if (!ctx.extensionSettings) throw new Error('Extension settings unavailable');
    const current = ctx.extensionSettings[SETTINGS_KEY];
    const migrated = migrateSettings(current);
    if (JSON.stringify(current) !== JSON.stringify(migrated)) {
        ctx.extensionSettings[SETTINGS_KEY] = migrated;
        ctx.saveSettingsDebounced?.();
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
    for (const key of ['scope', 'mode', 'reasoningMode', 'deliveryGuard', 'enhanceContinue', 'prefill', 'nudge']) {
        const input = panel.querySelector(`[data-setting="${key}"]`);
        if (input) input.disabled = state.requestMode !== 'enhance';
    }
    const last = lastView?.last;
    const badge = panel.querySelector('.lpg-badge');
    const outcome = last ? recordStatus(last) : { label: '等待请求', state: 'idle' };
    badge.textContent = state.enabled ? outcome.label : '已关闭';
    badge.dataset.state = state.enabled ? outcome.state : 'off';
    const status = panel.querySelector('.lpg-status');
    const lines = [];
    if (state.enabled && state.requestMode === 'observe') lines.push('原样诊断：保留预设的原承接、CoT、角色权限和输出顺序；不追加插件提示或调整思考参数。');
    if (state.enabled && state.requestMode === 'gemini4') lines.push('Gemini 4 兼容：只处理 Lin 2.8.2 的独立承接条目；不添加 user 催写，不更改生成预算。官方接口不接受自定义回复前缀。');
    if (!state.enabled) lines.push('扩展当前关闭，下次请求不注入。以下为最近记录。');
    if (last) {
        if (last.at) lines.push(`最近检查：${new Date(last.at).toLocaleTimeString()} · ${last.type || '未知类型'}`);
        lines.push(last.explanation);
        if (last.requestMode === 'gemini4') {
            if (last.dispatch?.label) lines.push(last.dispatch.label);
            else if (last.gemini4) lines.push('只看到组装事件，尚未核对浏览器发送。');
        } else if (last.applied) {
            lines.push(`原承接条目：${last.removedOriginal ? '仅在本次请求中替换' : '未移除'}；字符净变化：${last.netChars >= 0 ? '+' : ''}${last.netChars}`);
            lines.push(last.dispatch?.label || '已组装；尚未观察到发送，或网络取证未开启。');
        }
        if (last.note) lines.push(last.note);
    } else lines.push('选择 Lin 预设并正常发送一条消息后，这里会显示检查结果。');
    if (lastView?.response) lines.push(lastView.response);
    if (lastView?.lastSkip) lines.push(`后台检查：${lastView.lastSkip.explanation}`);
    if (lastView?.storageWarning) lines.push(lastView.storageWarning);
    if (state.captureNetwork && lastView?.networkAvailable === false) lines.push('当前页面无法安装网络取证；仅记录请求事件，不能核对实际发送。');
    status.textContent = lines.join('\n');
    panel.querySelector('.lpg-preview').textContent = last?.preview || '尚无本轮注入内容。';
    renderHistory();
}

function renderHistory() {
    const list = panel?.querySelector('.lpg-records');
    if (!list) return;
    const query = panel.querySelector('.lpg-search').value.trim().toLowerCase();
    const includeUnassociated = panel.querySelector('.lpg-unassociated')?.checked === true;
    const records = (lastView?.history || []).filter(r => (includeUnassociated || (r.origin !== 'unassociated' && r.reason !== 'unmatched-dispatch'))
        && (!query || formatRecord(r).toLowerCase().includes(query)));
    list.replaceChildren();
    for (const r of records) {
        const label = `${r.origin === 'unassociated' || r.reason === 'unmatched-dispatch' ? '[未关联] ' : ''}${new Date(r.at).toLocaleString()} · ${r.request?.model || r.type} · ${recordStatus(r).label} · ${r.id.slice(-8)}`;
        list.append(element('option', { value: r.id }, label));
    }
    if (!records.some(r => r.id === selectedRecord)) selectedRecord = records[0]?.id || '';
    list.value = selectedRecord;
    panel.querySelector('.lpg-history-count').textContent = `${records.length} 条匹配 / 最近 ${lastView?.history?.length || 0} 条`;
    panel.querySelector('.lpg-record-detail').textContent = formatRecord(records.find(r => r.id === selectedRecord), lastView?.history || []);
}

async function copyText(text) {
    if (navigator.clipboard?.writeText && globalThis.isSecureContext) {
        try { await navigator.clipboard.writeText(text); return; } catch { /* HTTP / mobile fallback */ }
    }
    const box = element('textarea', { value: text, readOnly: true });
    box.style.position = 'fixed'; box.style.opacity = '0';
    document.body.append(box); box.select(); box.setSelectionRange(0, text.length);
    const ok = document.execCommand('copy'); box.remove();
    if (!ok) throw new Error('copy unavailable');
}

function historyPanel() {
    const details = element('details', { className: 'lpg-advanced lpg-history' });
    details.append(element('summary', {}, '注入历史 · 查询 / 复制 / 导出'));
    details.append(hint('从本版启用后开始，最近 50 条随酒馆账户设置保存，刷新后可查询；不能恢复旧版记录。只记录插件提示、请求参数及响应统计，不记录完整聊天、密钥或思考原文。'));
    const unassociated = element('label', { className: 'lpg-check' });
    const showUnassociated = element('input', { type: 'checkbox', className: 'lpg-unassociated' });
    showUnassociated.addEventListener('change', renderHistory);
    unassociated.append(showUnassociated, element('span', {}, '显示未关联请求（可能来自后台任务）'));
    details.append(unassociated);
    const search = element('input', { type: 'search', className: 'text_pole lpg-search', placeholder: '搜索时间、模型、注入文字或诊断' });
    search.setAttribute('aria-label', '搜索注入历史');
    search.addEventListener('input', renderHistory);
    const list = element('select', { className: 'text_pole lpg-records', size: 4 });
    list.setAttribute('aria-label', '选择历史请求');
    list.addEventListener('change', () => { selectedRecord = list.value; renderHistory(); });
    const detail = element('pre', { className: 'lpg-record-detail lpg-preview' });
    const feedback = element('p', { className: 'lpg-hint', role: 'status' });
    const copy = element('button', { type: 'button', className: 'menu_button lpg-button' }, '复制所选记录');
    copy.addEventListener('click', async () => {
        try { await copyText(detail.textContent); feedback.textContent = '已复制。'; }
        catch { feedback.textContent = '浏览器未允许自动复制，可长按下方记录手动复制。'; }
    });
    const exportButton = element('button', { type: 'button', className: 'menu_button lpg-button' }, '导出全部诊断 JSON');
    exportButton.addEventListener('click', () => {
        const blob = new Blob([JSON.stringify({ version: VERSION, exportedAt: new Date().toISOString(), records: lastView?.history || [] }, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const link = element('a', { href: url, download: `Lin-prefill-history-${new Date().toISOString().slice(0, 10)}.json` });
        document.body.append(link); link.click(); link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 30000);
        feedback.textContent = '已导出；分享前请检查自定义注入文字。';
    });
    const clear = element('button', { type: 'button', className: 'menu_button lpg-button' }, '清空历史');
    clear.addEventListener('click', () => { controller.clearHistory(); feedback.textContent = '历史已清空。'; });
    const buttons = element('div', { className: 'lpg-actions' }); buttons.append(copy, exportButton, clear);
    details.append(search, element('p', { className: 'lpg-hint lpg-history-count' }), list, buttons, feedback, detail);
    return details;
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
    body.append(hint(`v${VERSION} · Lin 2.8.2 · Gemini 4 Argon / Carbon 承接兼容。`));
    body.append(checkbox('启用扩展', 'enabled'));
    body.append(select('请求处理', 'requestMode', [['gemini4', 'Lin 2.8.2 × Gemini 4（承接兼容）'], ['observe', '原样诊断（不改请求）'], ['enhance', '承接增强（旧版提示）']]));
    body.append(hint('新安装默认开启承接兼容；升级保留原先选择。使用 Lin 2.8.2 搭配 Argon / Carbon 时选择第一项。正常顺序不改；只有误放在末尾且能唯一核实的 Lin 承接才会被移回。'));
    body.append(select('适用范围', 'scope', [['lin', '仅已识别且启用的 Lin 承接条目'], ['all', '所有 Chat Completion 预设']]));
    body.append(select('注入方式', 'mode', [['user', '单条 user 提示（兼容优先）'], ['pair', 'assistant 承接 + user 执行']]));
    body.append(select('思考预算', 'reasoningMode', [['keep', '沿用当前参数'], ['balanced', '已识别 Gemini：高 / 最大思考降为适中']]));
    body.append(hint('上传的 Lin2.5 / 2.6 均为 auto，可保持“沿用当前参数”。可选降档只用于已识别的 Gemini 文本型号：3.0 Pro 用 low，其他支持型号用 medium；图像与未知型号不猜测。渠道仍可能忽略参数。'));
    body.append(checkbox('启用发送与接口取证（可查看实际发送提示）', 'captureNetwork'));
    body.append(checkbox('Lin2.6系列交付保护：识别三种CoT＋组件完整性', 'deliveryGuard'));
    body.append(hint('增强模式才追加交付提示；沿用所选CoT篇幅，不设500字上限。取证可区分短流缺结束原因、疑似文字拒答与未闭合注释；这些判断不删除文本、不触发自动请求。'));
    body.append(checkbox('对“继续补全”也加提示（默认关闭）', 'enhanceContinue'));
    body.append(hint('渠道排查：在酒馆原生连接设置中关闭流式，再手动重试一次。必须在生成前切换；仅修改请求中的 stream 字段会使酒馆解析方式与响应不一致。取证现在可识别无标头 SSE、JSON 及协议错配。'));
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
        if (normalizeSettings(settings()).requestMode === 'gemini4') {
            const ctx = context(), preset = ctx.chatCompletionSettings || {};
            const target = gemini4Target({ chat_completion_source: preset.chat_completion_source, model: ctx.getChatCompletionModel?.(preset), reverse_proxy: preset.reverse_proxy });
            const layout = lin282Layout(preset);
            selfResult.textContent = !target ? REASONS['g4-other'] : layout.reason ? REASONS[layout.reason]
                : '已识别 Lin 2.8.2 与 ' + target.model + (target.indirect ? '（按别名识别）' : '') + '。这里只核对配置；发送后才能核对两条消息的位置，不代表原生前缀已生效。';
            return;
        }
        const result = controller.preview({ type: 'normal', messages: [{ role: 'user', content: '本地自检样例：接着写一个普通场景。' }] });
        selfResult.textContent = result.applied
            ? `本地组装成功：末尾 ${result.tailRoles.join(' → ')}。未发送网络请求；实际模型效果需在聊天中验证。`
            : `本地自检：${REASONS[result.reason] || result.reason}`;
    });
    body.append(selftest, selfResult);
    const audit = element('button', { type: 'button', className: 'menu_button lpg-button' }, '检查当前预设');
    const auditResult = element('p', { className: 'lpg-hint lpg-audit', role: 'status' });
    audit.addEventListener('click', () => { auditResult.textContent = controller.audit().join('\n') || '未发现这些已知风险；仍需实际请求诊断。'; });
    body.append(audit, auditResult);
    const inspect = element('button', { type: 'button', className: 'menu_button lpg-button' }, '检查当前回复（不调用模型）');
    inspect.addEventListener('click', () => { auditResult.textContent = controller.inspectCurrent(); });
    body.append(inspect);
    const copyReply = element('button', { type: 'button', className: 'menu_button lpg-button' }, '复制当前回复原文（含注释）');
    copyReply.addEventListener('click', async () => {
        const message = context().chat?.findLast(m => m && !m.is_user && !m.is_system);
        if (!message || typeof message.mes !== 'string') { auditResult.textContent = '当前没有可复制的模型回复。'; return; }
        try { await copyText(message.mes); auditResult.textContent = '已复制当前回复原文（含隐藏注释）；没有调用模型或写入诊断历史。分享前请自行检查内容。'; }
        catch { auditResult.textContent = '浏览器未允许复制；可用酒馆编辑消息查看原文。'; }
    });
    body.append(copyReply);
    const recoveryBox = element('details', { className: 'lpg-advanced lpg-recovery' });
    recoveryBox.append(element('summary', {}, '手动补全 / 重生成'));
    recoveryBox.append(hint('先检查当前最后一条回复。补全会接写它，重生成会由酒馆替换它；都会调用当前连接并可能产生费用。原样诊断模式完全沿用酒馆原请求。每次点击仅发起一次酒馆生成操作，插件不自动循环重试。'));
    const recoveryFeedback = element('p', { className: 'lpg-hint lpg-audit', role: 'status' });
    const prepare = element('button', { type: 'button', className: 'menu_button lpg-button' }, '检查操作目标（免费）');
    const continueButton = element('button', { type: 'button', className: 'menu_button lpg-button', disabled: true }, '补全当前回复');
    const retryButton = element('button', { type: 'button', className: 'menu_button lpg-button', disabled: true }, '重生成并替换当前回复');
    let plan;
    prepare.addEventListener('click', () => {
        plan = controller.prepareRecovery();
        recoveryFeedback.textContent = plan.message;
        continueButton.disabled = !plan.ok || !plan.canContinue;
        retryButton.disabled = !plan.ok;
    });
    async function recover(action) {
        continueButton.disabled = true; retryButton.disabled = true; prepare.disabled = true;
        recoveryFeedback.textContent = '正在交给酒馆处理；可使用酒馆停止按钮中止。';
        try { const result = await controller.runRecovery(plan, action); recoveryFeedback.textContent = result.message; }
        catch { recoveryFeedback.textContent = '未完成，请查看酒馆错误提示；插件未自动再次调用。'; }
        finally { plan = undefined; prepare.disabled = false; }
    }
    continueButton.addEventListener('click', () => recover('continue'));
    retryButton.addEventListener('click', () => recover('regenerate'));
    const recoveryActions = element('div', { className: 'lpg-actions' });
    recoveryActions.append(prepare, continueButton, retryButton);
    recoveryBox.append(recoveryActions, recoveryFeedback);
    body.append(recoveryBox);
    const preview = element('details', { className: 'lpg-advanced' });
    preview.append(element('summary', {}, '查看最近实际注入的文本'), element('pre', { className: 'lpg-preview' }));
    body.append(preview);
    body.append(historyPanel());
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
    selectedRecord = '';
    controller = createController({ getContext: context, getSettings: settings, onStatus: updateStatus,
        hasDraft: () => !!document.querySelector('#send_textarea')?.value?.trim() });
    mount();
    const ctx = context();
    const ready = (ctx.eventTypes || ctx.event_types)?.APP_READY;
    if (ready) {
        const readyHandler = () => { controller?.restoreHistory(); mount(); };
        pendingReady = { event: ready, fn: readyHandler };
        ctx.eventSource.on(ready, readyHandler);
    }
}

onEnable();
