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
    const open = new Map(), stack = [];
    let misnestedTags = 0, orphanClosings = 0;
    for (const m of markup.matchAll(/<(\/?)(content|Lin_header|Lin_schedule|Lin_options|Lin_theater|choice[1-4]|details)\b[^>]*>/gi)) {
        const name = m[2].toLowerCase();
        open.set(name, Math.max(0, (open.get(name) || 0) + (m[1] ? -1 : 1)));
        if (!m[1]) stack.push(name);
        else {
            const index = stack.lastIndexOf(name);
            if (index < 0) orphanClosings++;
            else { if (index !== stack.length - 1) misnestedTags++; stack.splice(index, 1); }
        }
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
    const hasMedia = /<(?:img|svg|video|audio|iframe|canvas)\b/i.test(withoutThoughts);
    const onlyNotes = !!text.trim() && (commentChars > 0 || embeddedThinkingChars > 0)
        && !plainMarkup(withoutThoughts) && !hasMedia && !/```|~~~/.test(withoutComments);
    const noTextContent = text.length > 0 && !plainMarkup(withoutThoughts)
        && !hasMedia && !/```|~~~/.test(withoutComments);
    const ending = analyzeEnding(withoutThoughts, withoutComments);
    return { rawChars: text.length, commentChars, cotChars, cotCount, closedCotCount,
        nonCommentChars, nonThoughtChars, embeddedThinkingChars, onlyNotes,
        openComment: commentStart >= 0, openThinking, openFence: !!inCode, noTextContent,
        misnestedTags, orphanClosings,
        optionBlocks: optionBlocks.length, incompleteOptions, ending,
        openTags: [...open].filter(([, count]) => count > 0).map(([name]) => name).slice(0, 16) };
}

function plainMarkup(value) {
    return value.replace(/<(script|style)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi, '')
        .replace(/<(?:br|\/p|\/div|\/section|\/article)\b[^>]*>/gi, '\n')
        .replace(/<[^>]*>/g, '').replace(/&nbsp;|&#160;|&#xA0;/gi, ' ')
        .replace(/&quot;/gi, '"').replace(/&apos;/gi, "'").replace(/&amp;/gi, '&').trim();
}

/** Digest the exact received/saved text; never persist the text itself. Optional in older clients. */
export async function textDigest(text) {
    try {
        if (!globalThis.crypto?.subtle) return null;
        const bytes = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
        return [...new Uint8Array(bytes)].map(x => x.toString(16).padStart(2, '0')).join('');
    } catch { return null; }
}

/** Weak punctuation evidence, never semantic completeness. No reply text is retained. */
function analyzeEnding(markup, source) {
    const contents = [...markup.matchAll(/<content\b[^>]*>([\s\S]*?)(?:<\/content\s*>|$)/gi)];
    const scope = contents.length ? 'content' : 'plain';
    const unchecked = reason => ({ checked: false, scope, signals: [], reason });
    if (!contents.length && /(?:^|\n)\s*(?:`{3,}|~{3,})\s*$/.test(source)) return unchecked('code-ending');
    // Remove known ancillary components, including nested details, before checking
    // prose. Generic div/p/span wrappers are not a reason to skip the entire story.
    let candidate = contents.length ? contents.at(-1)[1] : markup;
    candidate = candidate.replace(/<(script|style)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi, '');
    if (!contents.length) {
        candidate = candidate.replace(/<(Lin_header|Lin_schedule|Lin_options|Lin_theater)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi, '');
        let depth = 0, output = '', cursor = 0;
        for (const m of candidate.matchAll(/<(\/?)details\b[^>]*>/gi)) {
            if (!m[1]) { if (depth++ === 0) output += candidate.slice(cursor, m.index); }
            else if (depth > 0 && --depth === 0) cursor = m.index + m[0].length;
        }
        candidate = output + (depth ? '' : candidate.slice(cursor));
    }
    const body = candidate.trim();
    if (!body || /<[^>]*$/.test(body)) return unchecked('no-prose-or-partial-tag');
    if (!contents.length && /<(?:table|ul|ol|pre|svg|iframe|script|style)\b/i.test(body)) return unchecked('structured-format');
    const lastLine = body.split(/\r?\n/).at(-1).trim();
    if (/^(?:#{1,6}\s|[-*+]\s|\d+[.)、]\s?|\||>)/.test(lastLine)) return unchecked('markdown-format');
    const plain = plainMarkup(body);
    // Avoid treating short answers, single words and non-Chinese formats as cuts.
    if (plain.length < 80 || !/[\u3400-\u9fff]/.test(plain) || !/[。！？.!?]/.test(plain)) return unchecked('short-or-non-prose');
    const tail = plain.replace(/[\s”’"'」』）)】\]*_]+$/g, '');
    const signals = [];
    if (/[，,、：:；;—-]$/.test(tail)) signals.push('trailing-separator');
    else if (/[\u3400-\u9fffA-Za-z0-9]$/.test(tail)) signals.push('no-terminal-punctuation');
    return { checked: true, scope, signals };
}

export function endingDiagnosis(output) {
    const signals = output?.ending?.signals || [];
    if (!signals.length) return '';
    return `疑似句尾未完：${signals.includes('trailing-separator') ? '正文以逗号、冒号等非句末符号收尾' : '较长正文末尾没有句末标点'}。这是弱提示，也可能是文风或格式；需核对实际末句，不自动续写。`;
}

export function structureDiagnosis(output) {
    if (!output) return '';
    const lines = [];
    if (output.openComment) lines.push('HTML注释未闭合，后续文本可能被隐藏；不能把注释算作正文');
    if (output.openThinking) lines.push('文本中的思考标签未闭合');
    if (output.onlyNotes) lines.push('只检测到思考/注释，尚无注释外正文');
    else if (output.noTextContent) lines.push('只检测到空白或空标签，未检测到正文文字');
    if (output.openTags?.length) lines.push(`结构未闭合：${output.openTags.join('、')}，疑似输出未完成`);
    if (output.misnestedTags) lines.push('组件标签闭合顺序错误，可能影响显示');
    if (output.orphanClosings) lines.push('存在没有对应开头的组件闭合标签，需核对原文');
    if (output.incompleteOptions) lines.push('四选项结构不完整：存在缺项、空项、重复或顺序不符；闭合外层标签不等于组件完整');
    if (output.openFence) lines.push('代码围栏未闭合，可能影响显示');
    if (output.cotCount > 1) lines.push('检测到多段Lin_CoT，可能重复生成前置摘要');
    return lines.join('；');
}
