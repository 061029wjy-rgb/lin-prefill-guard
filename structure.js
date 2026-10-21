/** Structural evidence only. No extracted source or reasoning is returned/persisted. */
export function analyzeOutput(value = '') {
    const text = typeof value === 'string' ? value : '';
    let commentStart = -1, outsideStart = 0, fence = null;
    let commentChars = 0, cotChars = 0, cotCount = 0, closedCotCount = 0;
    const outside = [];
    const tokens = /<!--|-->|^ {0,3}(?:`{3,}|~{3,})[^\r\n]*/gm;
    for (const token of text.matchAll(tokens)) {
        const index = token.index, mark = token[0];
        if (commentStart >= 0) {
            if (mark !== '-->') continue;
            const end = index + 3, size = end - commentStart;
            commentChars += size;
            if (/^<!--\s*Lin_CoT\s*:/i.test(text.slice(commentStart, commentStart + 64))) { cotChars += size; cotCount++; closedCotCount++; }
            commentStart = -1; outsideStart = end;
        } else if (/^\s*[`~]/.test(mark)) {
            const run = mark.trimStart().match(/^(`+|~+)/)[0];
            if (!fence) fence = run;
            else if (run[0] === fence[0] && run.length >= fence.length && !mark.trimStart().slice(run.length).trim()) fence = null;
        } else if (!fence && mark === '<!--') {
            outside.push(text.slice(outsideStart, index)); commentStart = index;
        }
    }
    if (commentStart >= 0) {
        const size = text.length - commentStart; commentChars += size;
        if (/^<!--\s*Lin_CoT\s*:/i.test(text.slice(commentStart, commentStart + 64))) { cotChars += size; cotCount++; }
    } else outside.push(text.slice(outsideStart));
    const withoutComments = outside.join('');
    // Fenced examples are displayed code, not hidden HTML or actual component tags.
    let inCode = null;
    const markup = withoutComments.split(/\r?\n/).map(line => {
        const run = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
        if (run) {
            if (!inCode) inCode = run[1];
            else if (run[1][0] === inCode[0] && run[1].length >= inCode.length && !run[2].trim()) inCode = null;
            return '';
        }
        return inCode ? '' : line;
    }).join('\n');
    const open = new Map();
    for (const m of markup.matchAll(/<(\/?)(content|Lin_header|Lin_schedule|Lin_options|choice[1-4]|details)\b[^>]*>/gi)) {
        const name = m[2].toLowerCase();
        open.set(name, Math.max(0, (open.get(name) || 0) + (m[1] ? -1 : 1)));
    }
    let embeddedThinkingChars = 0, openThinking = false;
    const withoutThoughts = markup.replace(/<(think|thinking)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi, block => {
        embeddedThinkingChars += block.length;
        if (!/<\/(?:think|thinking)\s*>$/i.test(block)) openThinking = true;
        return '';
    });
    // This is a source estimate, not a claim about the host's Markdown/regex rendering.
    const nonCommentChars = withoutComments.trim().length;
    const nonThoughtChars = Math.max(0, nonCommentChars - embeddedThinkingChars);
    // Closed outer tags alone do not establish a complete four-choice block.
    const optionBlocks = [...markup.matchAll(/<Lin_options\b[^>]*>([\s\S]*?)(?:<\/Lin_options\s*>|$)/gi)];
    const incompleteOptions = optionBlocks.filter(block => {
        const choices = [...block[1].matchAll(/<choice([1-4])\b[^>]*>([\s\S]*?)<\/choice\1\s*>/gi)];
        return choices.map(c => c[1]).join('') !== '1234' || choices.some(c => !c[2].trim());
    }).length;
    const onlyNotes = !!text.trim() && (commentChars > 0 || embeddedThinkingChars > 0)
        && !withoutThoughts.replace(/<[^>]*>/g, '').trim() && !/```|~~~/.test(withoutComments);
    return { rawChars: text.length, commentChars, cotChars, cotCount, closedCotCount,
        nonCommentChars, nonThoughtChars, embeddedThinkingChars, onlyNotes,
        openComment: commentStart >= 0, openThinking, openFence: !!inCode,
        optionBlocks: optionBlocks.length, incompleteOptions,
        openTags: [...open].filter(([, count]) => count > 0).map(([name]) => name).slice(0, 16) };
}

export function structureDiagnosis(output) {
    if (!output) return '';
    const lines = [];
    if (output.openComment) lines.push('HTML注释未闭合，后续文本可能被隐藏；不能把注释算作正文');
    if (output.openThinking) lines.push('文本中的思考标签未闭合');
    if (output.onlyNotes) lines.push('只检测到思考/注释，尚无注释外正文');
    if (output.openTags?.length) lines.push(`结构未闭合：${output.openTags.join('、')}，疑似输出未完成`);
    if (output.incompleteOptions) lines.push('四选项结构不完整：存在缺项、空项、重复或顺序不符；闭合外层标签不等于组件完整');
    if (output.openFence) lines.push('代码围栏未闭合，可能影响显示');
    if (output.cotCount > 1) lines.push('检测到多段Lin_CoT，可能重复生成前置摘要');
    return lines.join('；');
}
