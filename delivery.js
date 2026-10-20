/** Lin 2.6 delivery contract. No preset, response, or chat mutations. */
export const COT_ID = '1f35567a-a144-4902-b12d-ba4d857c57ff';
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
    const cot = prompts.find(p => p?.identifier === COT_ID);
    const cue = prompts.find(p => p?.identifier === CUE_ID);
    // Exported Lin2.6 has no top-level name. Recognize the actual entries, not a filename.
    const known = cue?.role === 'assistant' && cue.content?.startsWith('[Lin｜本轮承接]')
        && cot?.role === 'system' && /^本条将\s*Lin2\.6(?:实际|\s)/.test(cot.content || '');
    const enabled = id => Array.isArray(order) && order.some(x => x?.identifier === id && x.enabled === true)
        && prompts.some(p => p?.identifier === id && (!p.injection_trigger?.length || p.injection_trigger.includes(type)));
    const components = COMPONENTS.filter(([id]) => enabled(id)).map(([, label]) => label);
    const summary = SUMMARIES.find(([id]) => enabled(id));
    if (summary) components.push(summary[1]);
    return { known: !!known, orderKnown: Array.isArray(order), cueEnabled: enabled(CUE_ID),
        cotEnabled: enabled(COT_ID), sceneEnabled: enabled(SCENE_ID), components,
        inputPromptChars: prompts.filter(p => enabled(p.identifier)).reduce((n, p) => n + (p.content?.length || 0), 0) };
}

export function deliveryCue(profile, type = 'normal') {
    if (!profile.known || !profile.orderKnown || !profile.cueEnabled) return '';
    if (type === 'continue') return '[Lin2.6｜断点交付]\n只补已有回复的实际缺口。若断在Lin_CoT注释中，简短补齐当前结论并闭合注释，接着交付正文；不重启整套前置摘要，不复述已完成内容。';
    const lines = ['[Lin2.6｜交付完整性]', `当前启用组件：${profile.components.join('、') || '无附加组件'}。仅在本轮适用且用户未取消时输出，沿用预设顺序；不额外启用其他组件。`];
    if (profile.cotEnabled) lines.push('Lin_CoT只写简短结论，保留原有栏目，整段注释（含栏目名）目标不超过500汉字；不展开逐步推演、不重复档案。不适用项简记不触发，及时以-->闭合并紧接正文。注释不计正文字数，但仍消耗输出预算。');
    if (!profile.sceneEnabled) lines.push('可选场景条目未启用，其专属阶段、停笔等要求不生效；CoT相关栏目只记未启用。');
    lines.push('剧情停在交互节点，只限制情节推进；仍须完成当前句子及本轮适用组件的闭合结构。为正文保留已有字数要求，不用前置摘要、承诺或空标签代替正文。');
    return lines.join('\n');
}
