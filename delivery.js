/** Lin 2.6 delivery contract. No preset, response, or chat mutations. */
export const COT_ID = '1f35567a-a144-4902-b12d-ba4d857c57ff';
export const COT_VARIANTS = Object.freeze([
    { id: COT_ID, label: '标准CoT' },
    { id: '5f251ef0-8539-48f1-90d3-439364dccbca', label: '中等CoT' },
    { id: '17aab69d-1afc-41f7-a7b0-fdae3e63f575', label: '超长CoT' },
]);
export const TASK_ID = '68186c40-6f11-4c47-a036-58497d1d6795';
const CUE_ID = 'e898d676-f02e-4868-bc51-33761e294df6';
const SCENE_ID = '71ff2759-92ff-4f6c-9c13-0d5b09ac41b6';
const COMPONENTS = [
    ['93d9b6ef-8b71-4548-8101-578efbd299ac', '顶部时间戳'],
    [COT_ID, 'Lin_CoT简短决策摘要'],
    ['89078319-2469-426a-929a-423666abad8c', '待办日程'],
    ['21ae8a8a-9291-46d1-8f69-f5d5a04016db', '四选项'],
    ['164f154d-833d-47c4-88af-6bcf3147423e', '随机小剧场'],
];
const SUMMARIES = [
    ['eba93aeb-9677-4c62-a933-9a63ea2970ac', '仅摘要'],
    ['89d8ba3c-315e-49d5-ace2-a56fcb9a6993', '笼统摘要'],
    ['04a9bfb9-2211-4bea-810b-48a5c3be675c', '丐版摘要'],
];

export function deliveryProfile(preset = {}, type = 'normal') {
    const prompts = Array.isArray(preset.prompts) ? preset.prompts : [];
    const order = preset.prompt_order?.find(o => String(o?.character_id) === '100001')?.order;
    const cot = prompts.find(p => p?.role === 'system' && /^本条将\s*Lin2\.6(?:\.\d+)*(?:实际|\s)/.test(p.content || ''));
    const cue = prompts.find(p => p?.identifier === CUE_ID);
    // Exported Lin2.6 has no top-level name. Recognize the actual entries, not a filename.
    const known = cue?.role === 'assistant' && cue.content?.startsWith('[Lin｜本轮承接]')
        && cot?.role === 'system' && /^本条将\s*Lin2\.6(?:\.\d+)*(?:实际|\s)/.test(cot.content || '');
    const enabled = id => Array.isArray(order) && order.some(x => x?.identifier === id && x.enabled === true)
        && prompts.some(p => p?.identifier === id && (!p.injection_trigger?.length || p.injection_trigger.includes(type)));
    // ID variants from the actual Lin2.6.2 export. Unknown copies need both a
    // family header and an output-format marker; a name alone is not evidence.
    const cotSources = prompts.filter(p => p?.role === 'system' && typeof p.content === 'string' && p.content.trim() && enabled(p.identifier)
        && (COT_VARIANTS.some(v => v.id === p.identifier)
            || (/^本条将\s*Lin2\.6(?:\.\d+)*(?:实际|\s)/.test(p.content || '') && /<!--\s*Lin_CoT\s*:/i.test(p.content || ''))))
        .map(p => ({ identifier: String(p.identifier).slice(0, 100),
            variant: COT_VARIANTS.find(v => v.id === p.identifier)?.label || '兼容CoT',
            columns: [...(p.content?.slice(p.content.lastIndexOf('<!--')) || '').matchAll(/^\s*\d{1,3}[｜|]/gm)].length }));
    const cotEnabled = cotSources.length > 0;
    const components = COMPONENTS.filter(([id]) => id === COT_ID ? cotEnabled : enabled(id)).map(([, label]) => label);
    const summary = SUMMARIES.find(([id]) => enabled(id));
    if (summary) components.push(summary[1]);
    return { known: !!known, orderKnown: Array.isArray(order), cueEnabled: enabled(CUE_ID),
        cotEnabled, cotSources, cotConflict: cotSources.length > 1, cotEvidence: 'preset-order',
        sceneEnabled: enabled(SCENE_ID), components,
        inputPromptChars: prompts.filter(p => enabled(p.identifier)).reduce((n, p) => n + (p.content?.length || 0), 0) };
}

export function deliveryCue(profile, type = 'normal') {
    if (!profile.known || !profile.orderKnown || !profile.cueEnabled) return '';
    if (type === 'continue') return '[Lin2.6｜断点交付]\n只补已有回复的实际缺口。若断在Lin_CoT注释中，简短补齐当前结论并闭合注释，接着交付正文；不重启整套前置摘要，不复述已完成内容。';
    const lines = ['[Lin2.6｜交付完整性]', '正文与适用组件以本轮实际生效的预设、世界书和用户要求为准；不将插件识别到的条目视为完整清单，未启用的模块不由本提示启用。'];
    if (!profile.cotEnabled) lines.push('若本轮实际要求输出Lin_CoT注释，只写简短结论并及时闭合，再交付正文；若无此要求，不新增注释。');
    if (profile.cotEnabled) lines.push('Lin_CoT仅在剧情续写或正文重写且本轮适用时输出；戏外讨论、纯摘要请求不追加。保留所选版本原有栏目及全部创作约束，只写简短结论，整段注释（含栏目名）目标不超过500汉字，不展开逐步推演、不复抄规则。不重复开启已完成的注释，以-->闭合后紧接正文；正文原有篇幅要求不变。注释不计正文字数，但仍消耗输出预算。');
    lines.push('保持本轮原有篇幅与输出顺序，完成正文及适用结构；不以注释、准备说明或空标签代替结果。本提示不新增剧情停笔条件。');
    return lines.join('\n');
}
