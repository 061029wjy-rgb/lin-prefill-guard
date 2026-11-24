import {reset143,togglePause143} from './shield-engine.js?v=1.4.3';
import {DECISIONS,ACKS,EVIDENCE} from './response-evidence.js?v=1.4.3';
import {currentResult,shareResult,resetRecommendations} from './current-result.js?v=1.4.3';
import { EFFECTS } from './setting-help.js?v=1.4.3';
import { el, note, action, intro, group, detail, notice, controls } from './panel-controls.js?v=1.4.3';
import { family, detectedNonce, target290, layout290 } from './lin290.js?v=1.4.3';
import { runLocalDemo } from './output-lab.js?v=1.4.3';
import { gemini4Target, lin282Layout } from './gemini4.js?v=1.4.3';
import { DEFAULT_PREFILL, DEFAULT_NUDGE, SETTINGS_KEY, VERSION, REASONS, normalizeSettings, migrateSettings } from './core.js?v=1.4.3';
import { createController } from './controller.js?v=1.4.3';
import { formatRecord, recordStatus } from './diagnostics.js?v=1.4.3';

const INSTANCE_KEY = Symbol.for('lin-prefill-guard.instance');
let controller;
let panel;
let pendingReady;
const viewEvents=[];
let lastView;
let selectedRecord = '';
let savedAfter=null;

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
    if(!['detail143','experimentDetails'].includes(key))savedAfter=controller?.snapshot()?.last?.id||'initial';
    if(['guardMode','traceAnchor','anchorSize','repairJsonMime','pause143'].includes(key))controller?.invalidateFresh();
    else if(key==='protocolProfile')controller?.invalidateProtocol();
    else if(['enabled','requestMode','compat290','shield','macro','macroSize','macroGroups','macroWhen','auxPosition','passiveOutput'].includes(key))controller?.resetExperiment();
    context().saveSettingsDebounced();
    updateStatus(controller?.snapshot());
    if (!['prefill','nudge'].includes(key)) announce('已写入酒馆设置。');
}
const element=el, hint=note;

function updateStatus(view) {
    if (view) lastView = view;
    if (!panel) return;
    const state = normalizeSettings(settings());
    syncMain(); updateControls(state);
    const last = lastView?.last;
    const badge = panel.querySelector('.lpg-badge');
    const outcome = last && last.id!==savedAfter ? recordStatus(last) : { label: '等待请求', state: 'idle' };
    badge.textContent = state.enabled ? outcome.label : '已关闭';
    badge.dataset.state = state.enabled ? outcome.state : 'off';
    const status = panel.querySelector('.lpg-status');
    const lines = [];
    if (state.enabled && state.requestMode === 'observe') lines.push('原样诊断：保留预设的原承接、CoT、角色权限和输出顺序；不追加插件提示或调整思考参数。');
    if (state.enabled && state.requestMode === 'gemini4') lines.push('Gemini 4 兼容：按版本核对 2.8.2 / 2.9.0；2.9.0 保留完整确认原文。');
    if (state.enabled && ['gemini4-story','enhance'].includes(state.requestMode) && family(context().chatCompletionSettings||{})==='290')lines.push(state.compat290?'按 2.9.0 规则核对，不缩短确认或调整预算。':'已关闭 2.9.0 核对，不使用旧版增强设置。');
    else if(state.enabled && state.requestMode==='gemini4-story')lines.push('Vertex 正文承接：仅对 Lin 2.8.2 使用已核实的短确认规则。');
    if (!state.enabled) lines.push('扩展当前关闭，下次请求不注入。以下为最近记录。');
    if (last) {
        if (last.at) lines.push(`最近检查：${new Date(last.at).toLocaleTimeString()} · ${last.type || '未知类型'}`);
        lines.push(last.explanation);
        if (['gemini4','gemini4-story'].includes(last.requestMode)) {
            if (last.dispatch?.label) lines.push(last.dispatch.label);
            else if (last.gemini4) lines.push('只看到组装事件，尚未核对浏览器发送。');
        } else if (last.applied) {
            lines.push(`原承接条目：${last.removedOriginal ? '仅在本次请求中替换' : '未移除'}；字符净变化：${last.netChars >= 0 ? '+' : ''}${last.netChars}`);
            lines.push(last.dispatch?.label || '已组装；尚未观察到发送，或网络取证未开启。');
        }
        if (last.note) lines.push(last.note);
    } else lines.push('选择 Lin 预设并正常发送一条消息后，这里会显示检查结果。');
    if(last?.experiment)lines.push(formatRecord(last));
    if (lastView?.response && !last?.experiment) lines.push(lastView.response);
    if (lastView?.lastSkip) lines.push(`后台检查：${lastView.lastSkip.explanation}`);
    if (lastView?.storageWarning) lines.push(lastView.storageWarning);
    if (state.captureNetwork && lastView?.networkAvailable === false) lines.push('当前页面无法安装网络取证；仅记录请求事件，不能核对实际发送。');
    status.textContent = lines.join('\n');
    panel.querySelector('.lpg-aux-preview').textContent = controller?.getAuxPreview() || last?.preview || '尚无本轮独立辅助区。';
    const report=panel.querySelector('.lpg-proof');report.hidden=!state.experimentDetails;
    const current=panel.querySelector('.lpg-evidence143');current.hidden=state.pause143||!state.detail143;
    const pending=savedAfter===last?.id||!last;
    panel.querySelector('.lpg-outcome').textContent=currentResult(state,last,pending);
    const v=shareResult(last),run=v.run,wait=pending||!v.observed;
    current.textContent=wait?'仅保存设置或等待发送；没有已核实的新执行。':!run?'本轮没有 1.4.3 实验记录。':[
        '同题回显保护：'+DECISIONS[run.guard], '请求类型：'+DECISIONS[run.mime],
        '传输随机锚：'+DECISIONS[run.anchor]+'；'+(run.chars??0)+' 字符。'+ACKS[run.ack],
        run.traceInText===true?'返回的文本含追踪号；不能确认哪一层写入，本插件未写入正文。':'',
        '回包：'+(v.response?EVIDENCE[v.response.kind]:'暂无报文可供核对')+(v.response?.http?'（HTTP '+v.response.http+'）':'')+(v.response?.reportedError?'；报文错误码 '+v.response.reportedError:''),
        '渠道报告的整轮输入 / 输出 token：'+(v.response?.wholeInputTokens??'未知')+' / '+(v.response?.wholeOutputTokens??'未知')+'。没有单独的锚用量。'
    ].filter(Boolean).join('\n');
    report.textContent=pending?'还没有可关联的新发送。':proofText(last);
    renderHistory();
}
function proofText(last){
    const v=shareResult(last);if(!v.record)return '还没有记录。';
    const sent=v.observed?'已观察':'未核实', rec=v.receipt?'已回包':'无回执',w=v.response;
    return ['浏览器发送：'+sent+'　酒馆：'+rec,'联网：'+(v.search===null?'未知':v.search?'开':'关')+'　新增样本：'+(v.sampleChars??0)+' 字符',
      '请求正文净增：'+(v.bodyDeltaBytes??'未知')+' 字节（不是故事字数）',w?'响应：HTTP '+(w.http??'未知')+'；结束标记 '+w.finish:'还没有可解析的响应统计。','Google 实际模型与路由：无法由此验证。'].join('\n');
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
    details.append(hint('最多保存最近 50 条账户记录，刷新后仍可查询；不能补录未开启记录时发生的请求。只记录插件提示、请求参数及响应统计，不记录完整聊天、密钥或思考原文。'));
    const unassociated = element('label', { className: 'lpg-check' });
    const showUnassociated = element('input', { type: 'checkbox', className: 'lpg-unassociated' });
    showUnassociated.addEventListener('change', renderHistory);
    unassociated.append(showUnassociated, element('span', {}, '显示未关联请求（可能来自后台任务）'));
    details.append(unassociated,hint('不勾时只看能关联到对话的记录；勾上还会列出可能来自摘要等后台任务的记录。只筛选列表，不发送请求。'));
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
    clear.addEventListener('click', () => { if(globalThis.confirm('清空这个账户的插件诊断记录？聊天内容会保留。')){controller.clearHistory();feedback.textContent='历史已清空。';} });
    const safeExport=action('导出脱敏统计',()=>{
        const data={version:VERSION,records:(lastView?.history||[]).map(shareResult)};
        const url=URL.createObjectURL(new Blob([JSON.stringify(data,null,2)],{type:'application/json'}));
        const link=el('a',{href:url,download:'Lin-prefill-redacted.json'});document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),30000);
        feedback.textContent='已导出统计，不含提示、回复或签名。';
    });
    const privateBox=element('details',{className:'lpg-advanced'});privateBox.append(el('summary',{},'完整历史备份（含自定义提示）'),hint('本地留档可用以下两个旧功能。要发给别人排查，请优先使用脱敏统计。'));
    const btns=element('div',{className:'lpg-actions'});btns.append(copy,exportButton);privateBox.append(btns);
    const buttons = element('div', { className: 'lpg-actions' }); buttons.append(safeExport,clear);
    details.append(hint('输入关键词只筛选下方列表；导出脱敏统计包含所有记录。清空只删除插件历史，不删除对话。'));
    details.append(search, element('p', { className: 'lpg-hint lpg-history-count' }), list, buttons, privateBox, feedback, detail);
    return details;
}

const form = controls(() => normalizeSettings(settings()), save);
const MODES = [
    ['gemini4', '承接兼容（Lin 2.9.0 / 2.8.2）', '核对预设自己的承接和确认。顺序正常就保留原样；只有能核实两条放反时才调整。'],
    ['observe', '只做诊断（不改请求）', '保留原请求，只看发送与返回。其他设置可以提前保存；不会因此开启注入。'],
    ['enhance', '旧版承接增强', '对符合条件的旧预设加入你配置的提示。适用范围、注入方式和思考预算在下方旧版设置中调整。'],
    ['gemini4-story', 'Vertex 正文承接（仅 2.8.2）', 'Lin 2.8.2 直接连接 Vertex 时可用短确认；其他连接仍按兼容规则核对。'],
];

function updateControls(state) {
    if (!panel?.querySelector('.lpg-mode-info')) return;
    const p = context().chatCompletionSettings || {}, fam = family(p);
    for (const n of panel.querySelectorAll('[data-effect]')) {
        const key=n.dataset.effect, val=state[key], message=EFFECTS[key][typeof val==='boolean'?(val?'on':'off'):val]||'';
        if(n.textContent!==message)n.textContent=message;
    }
    const mode = MODES.find(m => m[0]===state.requestMode);
    const is290=fam==='290', guarded=fam==='protected';
    const put=(cls,t)=>{const n=panel.querySelector(cls);if(n && n.textContent!==t)n.textContent=t;};
    const source=p.chat_completion_source,model=context().getChatCompletionModel?.(p),target=target290({model,chat_completion_source:source});
    const via={vertexai:'Vertex',makersuite:'AI Studio',custom:'自定义接口'}[source]||'未识别连接';
    const presetName=is290?'Lin 2.9.0':!lin282Layout(p).reason?'Lin 2.8.2':guarded?'未适配的新版预设':'未识别为 2.9.0 / 2.8.2';
    put('.lpg-current',(state.enabled?'扩展已启用':'扩展已关闭')+' · '+presetName+' · '+via+(target?' / '+target.model+'（连接名）':''));
    const pendingHint=!state.enabled?'要使用下方选项，先打开「启用扩展」。':
        !is290?'回显保护和追踪号只用于 Lin 2.9.0；旧版仍使用自己的承接设置。':
        state.requestMode==='observe'?'只做诊断：选项可保存，但不会改动发送。要使用，请在上方选择「承接兼容」。':
        !state.compat290?'2.9 承接核对已关闭。要使用回显保护或追踪号，请打开上方的「核对 Lin 2.9.0 承接」。':
        !target?'连接型号尚未核实；实际发送时重新判断。':
        ['makersuite','vertexai'].includes(source)&&p.enable_web_search===true?'网页搜索可以保留。原「响应格式兼容」可核对纯搜索错序；本版回显保护和随机锚不处理搜索回合。':'';
    put('.lpg-eligibility',pendingHint);const eligibility=panel.querySelector('.lpg-eligibility');if(eligibility)eligibility.hidden=!pendingHint;
    put('.lpg-mode-info', !state.enabled ? '扩展已关闭。可以先配置；重新启用后才会处理后续请求。' :
        is290 && ['enhance','gemini4-story'].includes(state.requestMode) ? '已保留你的模式。当前是 Lin 2.9.0，只走 2.9 的核对规则，旧版提示和短确认均不使用。' : mode[2]);
    put('.lpg-legacy-info', !state.enabled ? '仅保存备用：扩展已关闭。' :
        is290 ? '仅保存备用：当前是 Lin 2.9.0，它不使用下面三项。' :
        guarded ? '仅保存备用：当前预设版本未适配，不应用旧版增强。' :
        state.requestMode!=='enhance' ? '仅保存备用：当前模式不会使用下面三项。要在旧预设中使用，在上方选择「旧版承接增强」。' :
        '已选择旧版承接增强。符合下列范围及请求条件时才使用；实际发送结果见「诊断」。');
    const search=['makersuite','vertexai'].includes(p.chat_completion_source)&&p.enable_web_search===true;
    put('.lpg-experiment-info', !state.enabled ? '仅保存设置：扩展已关闭。' :
        state.requestMode==='observe' ? '仅保存设置：当前只做诊断。要比较实验效果，请在上方选择「承接兼容」。' :
        !state.compat290 ? '仅保存设置：请先在上方主面板开启「核对 Lin 2.9.0 承接」。' :
        !is290 ? '仅保存设置：当前未识别为 Lin 2.9.0；其他预设不会加入实验标识。' :
        search ? '已开启 Google 网页搜索。响应格式兼容可核对纯搜索文字请求；搜索回合不加随机样本。已有工具回包、签名或混合内容会跳过。' :
        '当前预设为 Lin 2.9.0。已开启的实验仍需满足实际请求条件；是否发出见「诊断」。');
    put('.lpg-nonce',detectedNonce(p)?'预设本来就有样本号；这里的开关只管插件额外加入的编号。':'当前配置未检测到预设自带样本号。');
    put('.lpg-choice-info-scope',state.scope==='lin'?'所选效果：换到普通预设时，不加旧版提示。':'所选效果：普通聊天预设也可能加上旧版提示。');
    put('.lpg-choice-info-mode',state.mode==='pair'?'所选效果：① 助手消息接回任务 → ② 用户消息要求交付结果。':'所选效果：承接和执行合在同一条用户消息里。');
    put('.lpg-choice-info-reasoningMode',state.reasoningMode==='keep'?'所选效果：酒馆原来传 auto、high 或其他值，就继续传原值。':'所选效果：例如识别到 Gemini 3 Pro 的 high 才降为 low；auto 保持不变。');
    put('.lpg-macro-info',state.macro?'以下选项控制插件新增的样本号。':'插件样本号已关闭；以下选项仅作为下次开启时的配置。');
    put('.lpg-story-info',!state.enabled||is290||guarded||state.requestMode!=='gemini4-story' ? '仅保存备用：只有「Vertex 正文承接」配合 Lin 2.8.2 和直接 Vertex 连接才会使用。' :
        '已选择 Vertex 正文承接；每次还会核对预设、连接、承接和请求上限。');
    put('.lpg-shield-info',({off:'关闭：不添加格式标识。',standard:'文本对照：在独立位置添加一行旧标识。',deep:'JSON 对照：只改变旧标识的写法。'})[state.shield]);
    put('.lpg-search-info',search?'网页搜索可以保留。开启响应格式兼容时可核对纯搜索文字请求；第三方工具和签名仍跳过。':'日常聊天不要求关闭网页搜索。工具、原生预填充和结构化请求会按实际请求条件跳过。');
}

function legacyPage(page,go) {
    const {choice,check,text}=form;
    page.append(intro('旧版承接设置','已有旧预设时再调整。点整行选择，保存配置不会替你切换模式。'));
    const config=group('旧版增强 · 三项选择');
    const info=notice();info.classList.add('lpg-legacy-info');
    config.append(info,
        choice('适用范围','scope','决定哪些聊天预设可以收到旧版提示。选「所有」会包含非 Lin 预设。',[
            ['lin','仅启用了承接条目的 Lin 预设'],['all','所有聊天补全预设']]),
        choice('注入方式','mode','决定提示放在哪种消息里。单条兼容性优先；两条会先放助手承接，再放用户执行提示。',[
            ['user','一条：用户提示'],['pair','两条：助手承接 + 用户执行']]),
        choice('思考预算','reasoningMode','只调可识别 Gemini 文本模型的高档思考参数，不能给正文预留字数。自动、未知或不支持的参数保持原样。',[
            ['keep','沿用酒馆当前参数'],['balanced','符合条件时降低高档思考']]),
        action('查看承接模式',()=>go('home'),'lpg-link'));
    const delivery=detail('旧版交付与自定义提示','本组只供旧版承接增强使用。保留自定义内容，切换模式不会清空。');
    delivery.append(check('Lin 2.6 交付提示','deliveryGuard','按检测到的设定提醒模型交付正文和已启用的组件；不保证回复完整。'),
        check('继续补全时也加提示','enhanceContinue','只影响酒馆的「继续」；默认关闭。若已用原生继续预填充，仍会跳过。'),
        text('承接文本','prefill',700,'用于说明如何接回本轮任务，最多 700 字符。'),
        text('执行文本','nudge',250,'用于提醒模型交付可见结果，最多 250 字符。'),
        action('恢复这两段默认文本',()=>{
            save('prefill',DEFAULT_PREFILL);save('nudge',DEFAULT_NUDGE);
            panel.querySelector('[data-setting=prefill]').value=DEFAULT_PREFILL;
            panel.querySelector('[data-setting=nudge]').value=DEFAULT_NUDGE;
        }),note('只重置上面两段插件提示，不会改写预设条目。'));
    const story=detail('Lin 2.8.2 · Vertex 输出上限','直接连接 Vertex 且能核对原承接时，用较短的最终确认，保留正文要求。');
    const st=notice();st.classList.add('lpg-story-info');
    story.append(st,check('把 16,384 的上限放宽到 32,768','storyMoreTokens','只在原上限恰好为 16,384 时调整。上限不是输出承诺，较长回复可能增加费用与等待时间。'));
    page.append(config,delivery,story);
}

function experimentPage(page,go) {
    const {select}=form;
    page.append(intro('Lin 2.9 请求实验','用于对比同一预设的发送格式。实验是可选项，不能确认或控制上游路由。'));
    const info=notice(); info.classList.add('lpg-experiment-info');
    page.append(info,action('查看日常模式与承接开关',()=>go('home'),'lpg-link'));
    const format=group('请求格式');
    const sh=note('');sh.classList.add('lpg-shield-info');
    format.append(select('1.4.1 格式对照','shield',[['off','关闭'],['standard','单行文本标识'],['deep','JSON 标识']], '比较发送格式时再开。标识放在独立位置，模型可以看到。'),sh,
        select('标识和样本放在哪里','auxPosition',[['boundary','自动 · 最后一条前置系统消息之后'],['early','第一条系统消息之后']],'两种实验共用一个位置；找不到独立位置就跳过，不插进角色对白。'));
    const random=group('旧样本编号（模型可见）');
    random.append(compactSwitch('macro','旧样本编号','开启：给合格文字请求添加 1.4.2 的辅助编号。关闭：不添加；不影响预设自带的 nonce。'));
    const nonce=note('');nonce.classList.add('lpg-nonce');
    random.append(nonce);
    const options=detail('样本号的长度、组数与触发时机');
    const mi=note('');mi.classList.add('lpg-macro-info');
    options.append(mi,select('每组长度','macroSize',[['short','短 · 8 位'],['medium','中 · 16 位'],['long','长 · 24 位']],'每组有多少个十六进制字符，越长占用的输入空间越多。'),
        select('每次几组','macroGroups',[['1','1 组'],['2','2 组'],['3','3 组']],'每个适用请求加入的编号组数，不是调用模型的次数。'),
        select('在哪些回复加入','macroWhen',[['each','普通回复、重生成、滑动重抽'],['normal','仅普通回复'],['reuse','同一条用户消息：重生成、滑动沿用上次样本']],'选择哪些生成动作带样本号；不会替你发起重试。'));
    random.append(options);
    const off=action('关闭全部新实验',()=>{
        const s=settings();Object.assign(s,{shield:'off',macro:false,passiveOutput:false,protocolProfile:'off'}); savedAfter=controller.snapshot()?.last?.id||'initial';
        context().saveSettingsDebounced();controller.resetExperiment();
        panel.querySelector('[data-setting=shield]').value='off';
        for(const k of ['macro','passiveOutput'])panel.querySelector('[data-setting='+k+']').checked=false;
        syncMain();updateStatus(controller.snapshot()); announce('已关闭旧格式标记、旧样本、被动保留和旧回复格式兼容。本版选项不变。');
    });
    const close=group('旧版批量设置','「关闭全部新实验」是旧按钮：关闭旧格式标记、旧样本编号、被动保留和 1.4.2 回复格式兼容；不碰上面 1.4.3 的选择。');
    close.append(off);page.append(format,random,close);
}

function homePage(page,mainPanel) {
    const main=group('承接模式');
    main.append(form.select('工作模式','requestMode',MODES,'决定插件只观察、核对承接，还是为旧预设加入提示。'),
        el('p',{className:'lpg-notice lpg-mode-info',role:'status'}));
    const lin=el('div');
    lin.append(form.check('核对 Lin 2.9.0 承接','compat290','在兼容模式保留预设完整的最终确认。关闭后跳过 2.9 核对与实验；不影响 2.8.2。'),
        el('p',{className:'lpg-hint lpg-search-info'}));
    const first=detail('我用 Lin 2.9，第一次怎么开？');
    const steps=el('ol',{className:'lpg-steps'});
    for(const instruction of ['勾「启用扩展」，工作模式选「承接兼容」。','勾「核对 Lin 2.9.0 承接」。平时写剧情到这里就够了，旧版三项不用开，网页搜索也可以照常用。','正常发下一条消息。想知道插件实际做了什么，点「诊断」看这次请求。'])
        steps.append(el('li',{},instruction));
    first.append(steps);main.append(lin);mainPanel.append(main);page.append(first);

}

function announce(message) {
    const n=panel?.querySelector('.lpg-feedback');if(n)n.textContent=message;
}

function compactSwitch(key,title,help,asProfile=false){
    const id='lpg-set-'+key,row=el('label',{htmlFor:id,className:'lpg-quick'}),c=el('span'),input=el('input',{id,type:'checkbox'});input.dataset.setting=key;
    c.append(el('strong',{},title),el('small',{id:id+'-help'},help));input.setAttribute('aria-describedby',id+'-help');
    input.addEventListener('change',()=>save(key,asProfile?(input.checked?'standard':'off'):input.checked));row.append(c,input);return row;
}
function syncMain(){
    if(!panel)return;const s=normalizeSettings(settings());
    for(const input of panel.querySelectorAll('[data-setting]')){
        const k=input.dataset.setting;
        if(input.type==='radio')input.checked=s[k]===input.value;
        else if(input.type==='checkbox')input.checked=k==='protocolProfile'?s[k]==='standard':s[k]===true;
        else if(input.tagName==='SELECT'&&input.value!==s[k])input.value=s[k];
    }
    const pause=panel.querySelector('.lpg-pause143');if(pause){pause.textContent=s.pause143?'恢复运行本版新实验':'暂停本版新实验';pause.setAttribute('aria-pressed',String(s.pause143));}
    const h=panel.querySelector('.lpg-pause-note');if(h)h.textContent=s.pause143?'已暂停：旧承接、响应格式和旧样本仍使用你的设置。':'暂停仅停用本版新功能，恢复运行后继续使用原选择。';
}
function mount() {
    if (panel?.isConnected) return;
    const host = document.querySelector('#extensions_settings2') || document.querySelector('#extensions_settings');
    if (!host) return;
    document.getElementById('lin-prefill-guard-panel')?.remove();
    panel=element('details',{id:'lin-prefill-guard-panel',className:'lpg-panel',open:true});
    const heading=element('summary',{className:'lpg-heading'});
    const names=element('span',{className:'lpg-title'});
    names.append(element('strong',{},'Lin 预填充助手'),element('small',{},'v'+VERSION));
    heading.append(names,element('span',{className:'lpg-badge'},'等待请求'));panel.append(heading);
    const body=element('div',{className:'lpg-body'});
    const mainPanel=el('section',{className:'lpg-main'});
    const groups={home:detail('承接与旧版预设','选择日常承接、旧版增强和输出上限。'), exp:detail('样本与旧格式对照','调整随机样本和 1.4.1 的格式实验。'),diag:detail('诊断与补全','查看历史、检查回复，或由你手动决定是否重新生成。')};
    const go=id=>{if(id==='home'){const mode=mainPanel.querySelector('[data-setting=requestMode]');mode?.focus({preventScroll:true});mode?.scrollIntoView({block:'center'});return;}const box=groups[id]||groups.home;box.open=true;box.querySelector('summary').focus();box.scrollIntoView({block:'nearest'});};
    mainPanel.append(el('p',{className:'lpg-current'}),compactSwitch('enabled','启用扩展','关闭后不再处理下一条请求；设置和历史保留。'));
    homePage(groups.home,mainPanel);
    const formats=group('请求与回复的格式');
    formats.append(compactSwitch('protocolProfile','响应格式兼容（1.4.2）','开：流式请求 SSE，整段请求 JSON，也核对纯 Google 搜索承接。关：沿用酒馆原行为。',true),
        compactSwitch('repairJsonMime','补齐缺失的 JSON 请求类型','开：只给缺少类型的合格 JSON 请求补上类型。关：原样发送。已经声明的类型不覆盖。'));
    mainPanel.append(formats);
    const modes=el('fieldset',{className:'lpg-profiles'});modes.append(el('legend',{},'回显保护实验'));
    for(const [v,title,description] of [
        ['off','关闭','使用原来的承接和样本设置，不检查是否要为重试省略标记。'],
        ['standard','标准 · 同题重试避开回显','只有上次整条回复都是插件标记、且接口报告正常停写，手动重生或滑动同一题才会省略它。'],
        ['deep','深度实验 · 暂不可用','尚无第二种经验证且不会改动 Lin 原文的处理。'],
    ]){
        const id='lpg-profile-'+v,input=el('input',{id,type:'radio',name:'lpg-profile',value:v,disabled:v==='deep'});input.dataset.setting='guardMode';
        input.addEventListener('change',()=>{if(input.checked&&!input.disabled)save('guardMode',v);});
        const label=el('label',{htmlFor:id,className:'lpg-profile'}),copy=el('span');copy.append(el('strong',{},title),el('small',{},description));label.append(input,copy);modes.append(label);
    }
    const result=el('section',{className:'lpg-this-turn'});result.append(el('h4',{},'本轮实际执行'),el('p',{className:'lpg-outcome',role:'status'}),el('p',{className:'lpg-evidence143',hidden:true}),el('p',{className:'lpg-proof',hidden:true}));
    const reset=action('恢复新实验推荐设置',()=>{resetRecommendations(settings());controller.invalidateProtocol();savedAfter=controller.snapshot()?.last?.id||'initial';
        context().saveSettingsDebounced();syncMain();updateStatus(controller.snapshot());announce('已关闭 1.4.2 回复格式兼容、旧样本编号和原实验详情。本版新选项及历史已保留。');});
    const copy=action('复制脱敏诊断',async()=>{
        const last=controller.snapshot()?.last;if(!last||last.id===savedAfter){announce('还没有与当前设置对应的新记录。');return;}
        const safe=JSON.stringify(shareResult(last),null,2);try{await copyText(safe);announce('已复制本轮诊断，不含提示、回复、密钥或签名。');}catch{const fallback=panel.querySelector('.lpg-share-fallback');fallback.hidden=false;fallback.value=safe;fallback.select();announce('请长按选中的脱敏记录复制。');}});
    const apply143=(mutate)=>{const cfg=settings();mutate(cfg);controller.invalidateFresh();savedAfter=controller.snapshot()?.last?.id||'initial';context().saveSettingsDebounced();updateStatus(controller.snapshot());};
    const pause=action('暂停本版新实验',()=>apply143(togglePause143),'lpg-pause143');
    const clear143=action('恢复本版新实验默认值',()=>{apply143(reset143);announce('已关闭本版回显保护、随机锚、请求类型修复和新详情，长度恢复为短。旧设置与历史不变。');});
    const trace=group('随机锚与本轮诊断');
    trace.append(compactSwitch('traceAnchor','追踪本轮回包（独立随机锚）','开：向酒馆发送一次性请求编号，可以对照回传头。关：不发编号。编号不进预设或模型提示。'),
        compactSwitch('detail143','显示本版诊断','开：查看回显处理、追踪锚、类型及回包证据。关：只收起详情。'));
    const buttons=el('div',{className:'lpg-main-actions'});buttons.append(copy,pause,clear143);
    mainPanel.append(modes,el('p',{className:'lpg-eligibility lpg-hint'}),trace,result,buttons,
        el('p',{className:'lpg-hint lpg-pause-note'}),el('textarea',{className:'lpg-share-fallback text_pole',readOnly:true,hidden:true,ariaLabel:'脱敏诊断'}));
    body.append(mainPanel,el('p',{className:'lpg-feedback',role:'status'}),groups.home,groups.exp,groups.diag);
    legacyPage(groups.home,go);experimentPage(groups.exp,go);
    const old=group('1.4.2 诊断与推荐值','下方推荐值仅关闭 1.4.2 回复格式兼容、旧样本编号和原实验详情，不影响本版选项。');
    old.append(compactSwitch('experimentDetails','显示 1.4.2 原实验详情','开：展开原版发送、流格式和样本统计。关：收起旧详情。'),reset);
    groups.exp.append(old,form.select('传输随机锚长度','anchorSize',[['short','短 · 16 字符'],['medium','中 · 24 字符'],['long','长 · 32 字符']],'仅影响新追踪头，和旧样本的长度、组数无关。'));
    const page=groups.diag;
    page.append(intro('检查回复与请求','空回或中途停下时，先看接口实际返回了什么，再决定要不要补写。'));
    const lastResult=group('最近一次请求');
    const status=element('div',{className:'lpg-status'});lastResult.append(status);
    const preview=detail('查看实际注入的文本','对照本轮独立辅助区或已有的提示预览。空白不表示正文丢失。');
    preview.append(element('pre',{className:'lpg-preview lpg-aux-preview'}));
    lastResult.append(preview);page.append(lastResult);
    const checks=group('本地检查','以下检查和复制只读已有内容，不调用模型。');
    checks.append(form.check('记录发送和返回','captureNetwork','开启后才有常规出站核对与响应统计。关掉不会关闭聊天本身。'));
    const checkItem=(button,description)=>{
        const wrap=element('div',{className:'lpg-action-item'});
        wrap.append(button,hint(description));return wrap;
    };
    const selftest = element('button', { type: 'button', className: 'menu_button lpg-button' }, '本地自检（不调用模型）');
    const selfResult = element('p', { className: 'lpg-hint lpg-selftest', role: 'status' });
    selftest.addEventListener('click', () => {
        const cfg=normalizeSettings(settings()), ctx=context(), preset=ctx.chatCompletionSettings||{}, f=family(preset);
        if(!cfg.enabled){selfResult.textContent='扩展已关闭。可以查看设置，但下一次请求不会使用它们。';return;}
        if(cfg.requestMode==='observe'){selfResult.textContent='只做诊断：不会注入提示。要查空回，可以在发下一条前勾选「记录发送和返回」。';return;}
        if(f==='protected'){selfResult.textContent=REASONS['290-unknown'];return;}
        if(f==='290'&&!cfg.compat290){selfResult.textContent='已识别 Lin 2.9.0，但没有勾选承接核对；旧版增强不会替代它。';return;}
        if(f==='290'||['gemini4','gemini4-story'].includes(cfg.requestMode)){
            const identity={chat_completion_source:preset.chat_completion_source,model:ctx.getChatCompletionModel?.(preset),reverse_proxy:preset.reverse_proxy};
            if(f==='290'){
                const order=ctx.getChatCompletionPromptManager?.()?.configuration?.promptOrder;
                const group=order?.strategy==='global'&&[100000,100001].includes(Number(order.dummyId))?Number(order.dummyId):undefined;
                const l=layout290(preset,'normal',group),t=target290(identity);
                selfResult.textContent=(!l.reason&&t)?'已核对 Lin 2.9.0 配置与 '+t.model+' 连接标识；承接原文及出站结构需实际发送核验。':(REASONS[l.reason||'g4-other']||'无法确认配置。');return;
            }
            const target=gemini4Target(identity);
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
    checks.append(checkItem(selftest,'用本地样例核对预设与模式，不会在聊天里产生回复。'),selfResult);
    const audit = element('button', { type: 'button', className: 'menu_button lpg-button' }, '检查当前预设');
    const auditResult = element('p', { className: 'lpg-hint lpg-audit', role: 'status' });
    audit.addEventListener('click', () => { auditResult.textContent = controller.audit().join('\n') || '未发现这些已知风险；仍需实际请求诊断。'; });
    checks.append(checkItem(audit,'查看当前预设的已知冲突或限制；不会改动预设。'));
    const inspect = element('button', { type: 'button', className: 'menu_button lpg-button' }, '检查当前回复（不调用模型）');
    inspect.addEventListener('click', () => { auditResult.textContent = controller.inspectCurrent(); });
    checks.append(checkItem(inspect,'区分酒馆保存的正文、注释与思考，排查为什么屏幕上看起来是空的。'));
    const copyReply = element('button', { type: 'button', className: 'menu_button lpg-button' }, '复制当前回复原文（含注释）');
    copyReply.addEventListener('click', async () => {
        const message = context().chat?.findLast(m => m && !m.is_user && !m.is_system);
        if (!message || typeof message.mes !== 'string') { auditResult.textContent = '当前没有可复制的模型回复。'; return; }
        try { await copyText(message.mes); auditResult.textContent = '已复制当前回复原文（含隐藏注释）；没有调用模型或写入诊断历史。分享前请自行检查内容。'; }
        catch { auditResult.textContent = '浏览器未允许复制；可用酒馆编辑消息查看原文。'; }
    });
    checks.append(checkItem(copyReply,'把酒馆已保存的原文连同注释复制出来，便于和屏幕对照；缺失的内容不会被补写。'),auditResult);
    page.append(checks,historyPanel());
    const passive=detail('被动保留与复制（Lin 2.9）','适合排查接口有完整文本、酒馆里却看不到的情况。');
    const passiveFeedback=element('p',{className:'lpg-hint',role:'status'});
    passive.append(form.check('临时保留本轮完整返回','passiveOutput','需在生成前开启。只保留可核实的完整文本供复制，不重发请求、不写回聊天。'),
        action('复制本轮已返回文本',async()=>{
            const output=controller.getVisibleOutput();
            if(!output){passiveFeedback.textContent='本轮没有可复制的完整文本。先开启保留，之后符合条件的完整回复才可复制。';return;}
            try {await copyText(output);passiveFeedback.textContent='已复制；没有改写聊天。';}
            catch {passiveFeedback.textContent='浏览器未允许复制。';}
        }),passiveFeedback);
    const lab=detail('开发用 · 本地工具演示','只用固定样例测试工具回包；不会接入你的聊天，也不能恢复线上缺失的回复。');
    const labResult=element('p',{className:'lpg-hint',role:'status'});
    lab.append(action('运行隔离工具演示（不联网）',()=>{
        try{labResult.textContent='本地样例回显：'+runLocalDemo();}catch{labResult.textContent='隔离演示失败。';}
    }),labResult);
    const recoveryBox = element('details', { className: 'lpg-advanced lpg-recovery' });
    recoveryBox.append(element('summary', {}, '手动补全 / 重生成'));
    recoveryBox.append(hint('先检查当前最后一条回复。补全会接写它，重生成会由酒馆替换它；都会调用当前连接并可能产生费用。原样诊断模式完全沿用酒馆原请求。每次点击仅发起一次酒馆生成操作，插件不自动循环重试。'));
    recoveryBox.append(hint('先点「检查操作目标」。想从断句接着写，选「补全」；想把整条重新写，选「重生成」。检查免费，后两项会请求模型。'));
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
    page.append(passive,recoveryBox,lab);
    panel.append(body);
    host.append(panel);
    panel.addEventListener('toggle',()=>{if(panel?.open)updateControls(normalizeSettings(settings()));});
    updateStatus(controller?.snapshot());
}

export function onDisable() {
    controller?.dispose();
    controller = undefined;
    for (const [bus,name,fn] of viewEvents.splice(0)) (bus.removeListener||bus.off)?.call(bus,name,fn);
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
    selectedRecord = ''; savedAfter=null;
    controller = createController({ getContext: context, getSettings: settings, onStatus: updateStatus,
        hasDraft: () => !!document.querySelector('#send_textarea')?.value?.trim() });
    savedAfter=controller.snapshot()?.last?.id||'initial';
    mount();
    const ctx = context();
    const ev=ctx.eventTypes||ctx.event_types||{};
    for(const name of new Set([ev.OAI_PRESET_CHANGED_AFTER,ev.CHATCOMPLETION_SOURCE_CHANGED,ev.PRESET_CHANGED,ev.CHAT_CHANGED].filter(Boolean))){
        const refresh=()=>{savedAfter=controller?.snapshot()?.last?.id||'initial';if(panel?.isConnected)updateStatus(controller?.snapshot());};
        ctx.eventSource.on(name,refresh);viewEvents.push([ctx.eventSource,name,refresh]);
    }
    const ready = (ctx.eventTypes || ctx.event_types)?.APP_READY;
    if (ready) {
        const readyHandler = () => { controller?.restoreHistory(); if(!lastView?.generating)savedAfter=controller?.snapshot()?.last?.id||'initial'; mount();updateStatus(controller?.snapshot()); };
        pendingReady = { event: ready, fn: readyHandler };
        ctx.eventSource.on(ready, readyHandler);
    }
}

onEnable();
