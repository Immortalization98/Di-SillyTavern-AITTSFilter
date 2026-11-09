// Splits a chat message into numbered segments with exact source offsets.
// Pure function: no DOM, no SillyTavern imports.
//
// Segment kinds:
//   markup  - a tag marker such as <status> or </status> (never read aloud)
//   code    - a fenced code block (``` or ~~~), including the fences
//   comment - an HTML comment <!-- ... -->
//   image   - <img ...> or a Markdown image ![alt](url)
//   text    - plain text (one line, or the part of a line outside brackets)
//   bracket - an inline 【...】, [...] (not a Markdown link) or {...}
//
// Every segment knows the stack of tags it sits in (`path`), which the rules
// and the model use as a hint.

/** Bump when the segmentation output changes, so cached results are not reused. */
export const SEGMENTER_VERSION = 1;

/**
 * @typedef {object} Segment
 * @property {number} id       0-based, in document order
 * @property {number} start    inclusive offset in the source text
 * @property {number} end      exclusive offset in the source text
 * @property {'markup'|'code'|'comment'|'image'|'text'|'bracket'} kind
 * @property {string[]} path   enclosing tag names, outermost first (original case)
 * @property {number} line     0-based line number of `start`
 * @property {string} [tag]    tag name for markup segments
 */

const VOID_TAGS = new Set(['br', 'hr', 'img', 'input', 'meta', 'link', 'wbr', 'source', 'col', 'area', 'embed', 'track', 'param', 'base']);

// Tag names: ASCII letters/underscore or CJK/kana/hangul first, then word chars, CJK, ':', '.', '-'.
const NAME_START = 'A-Za-z_\\u3040-\\u30ff\\u3400-\\u9fff\\uac00-\\ud7af';
const NAME_REST = '\\w\\u3040-\\u30ff\\u3400-\\u9fff\\uac00-\\ud7af:.\\-';
const TAG_RE = new RegExp(`<(\\/?)([${NAME_START}][${NAME_REST}]*)((?:\\s[^<>]*?)?)\\s*(\\/?)>`, 'g');

const INLINE_RE = /【[^【】\n]+】|!\[[^\]\n]*\]\([^)\n]*\)|\[[^[\]\n]+\](?!\()|\{[^{}\n]+\}/g;

/**
 * Finds fenced code blocks and HTML comments. Tags inside them are ignored.
 * An unclosed fence runs to the end of the text (as in Markdown); an
 * unclosed comment is treated as plain text.
 * @param {string} text
 * @returns {{start:number,end:number,kind:'code'|'comment'}[]}
 */
function findOpaqueRegions(text) {
    const regions = [];
    const startRe = /(^|\n)[ \t]{0,3}(`{3,}|~{3,})|<!--/g;
    let match;
    while ((match = startRe.exec(text)) !== null) {
        if (match[0] === '<!--') {
            const close = text.indexOf('-->', match.index + 4);
            if (close === -1) {
                continue;
            }
            regions.push({ start: match.index, end: close + 3, kind: 'comment' });
            startRe.lastIndex = close + 3;
            continue;
        }
        const lineStart = match.index + match[1].length;
        const fence = match[2];
        const openLineEnd = text.indexOf('\n', match.index + match[0].length);
        let end = text.length;
        if (openLineEnd !== -1) {
            const closeRe = new RegExp(`\\n[ \\t]{0,3}${fence[0] === '`' ? '`' : '~'}{${fence.length},}[ \\t]*(?=\\n|$)`, 'g');
            closeRe.lastIndex = openLineEnd;
            const closeMatch = closeRe.exec(text);
            if (closeMatch) {
                end = closeMatch.index + closeMatch[0].length;
            }
        }
        regions.push({ start: lineStart, end, kind: 'code' });
        startRe.lastIndex = end;
    }
    return regions;
}

/**
 * @param {number} pos
 * @param {number} endPos
 * @param {{start:number,end:number}[]} regions sorted, non-overlapping
 */
function overlapsRegion(pos, endPos, regions) {
    for (const r of regions) {
        if (r.start >= endPos) {
            return false;
        }
        if (r.end > pos) {
            return true;
        }
    }
    return false;
}

/**
 * Tokenizes tags outside the opaque regions and pairs them with a stack.
 * Unpaired open/close tags and void/self-closing tags become standalone nodes.
 * @param {string} text
 * @param {{start:number,end:number}[]} regions
 */
function findTags(text, regions) {
    /** @type {any[]} */
    const nodes = [];
    /** @type {{name:string,lower:string,start:number,end:number}[]} */
    const stack = [];
    TAG_RE.lastIndex = 0;
    let match;
    while ((match = TAG_RE.exec(text)) !== null) {
        const start = match.index;
        const end = start + match[0].length;
        if (overlapsRegion(start, end, regions)) {
            continue;
        }
        const isClose = match[1] === '/';
        const name = match[2];
        const lower = name.toLowerCase();
        const selfClosing = match[4] === '/';
        if (!isClose && (selfClosing || VOID_TAGS.has(lower))) {
            nodes.push({ type: lower === 'img' ? 'image' : 'markup', start, end, name });
            continue;
        }
        if (!isClose) {
            stack.push({ name, lower, start, end });
            continue;
        }
        let j = stack.length - 1;
        while (j >= 0 && stack[j].lower !== lower) {
            j--;
        }
        if (j < 0) {
            nodes.push({ type: 'markup', start, end, name });
            continue;
        }
        // Opens above j were never closed: keep their markers, but they hold no children.
        for (let k = j + 1; k < stack.length; k++) {
            nodes.push({ type: 'markup', start: stack[k].start, end: stack[k].end, name: stack[k].name });
        }
        const open = stack[j];
        stack.length = j;
        nodes.push({ type: 'pair', name: open.name, start: open.start, openEnd: open.end, closeStart: start, end });
    }
    for (const open of stack) {
        nodes.push({ type: 'markup', start: open.start, end: open.end, name: open.name });
    }
    return nodes;
}

/**
 * @param {string} text
 * @returns {Segment[]}
 */
export function segmentText(text) {
    const src = String(text ?? '');
    const regions = findOpaqueRegions(src);
    const nodes = [
        ...regions.map(r => ({ type: r.kind, start: r.start, end: r.end })),
        ...findTags(src, regions),
    ];
    nodes.sort((a, b) => a.start - b.start || b.end - a.end);

    // Build the tree: only pairs can hold children.
    const root = { type: 'root', start: 0, end: src.length, openEnd: 0, closeStart: src.length, children: [] };
    const open = [root];
    for (const node of nodes) {
        while (open.length > 1 && open[open.length - 1].end <= node.start) {
            open.pop();
        }
        const parent = open[open.length - 1];
        parent.children.push(node);
        if (node.type === 'pair') {
            node.children = [];
            open.push(node);
        }
    }

    const newlines = [];
    for (let i = 0; i < src.length; i++) {
        if (src.charCodeAt(i) === 10) {
            newlines.push(i);
        }
    }
    const lineOf = (pos) => {
        let lo = 0;
        let hi = newlines.length;
        while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (newlines[mid] < pos) {
                lo = mid + 1;
            } else {
                hi = mid;
            }
        }
        return lo;
    };

    /** @type {Segment[]} */
    const segments = [];
    const push = (start, end, kind, path, extra = {}) => {
        if (end <= start) {
            return;
        }
        segments.push({ id: segments.length, start, end, kind, path, line: lineOf(start), ...extra });
    };

    const emitPlain = (from, to, path) => {
        let lineStart = from;
        while (lineStart <= to) {
            let lineEnd = src.indexOf('\n', lineStart);
            if (lineEnd === -1 || lineEnd > to) {
                lineEnd = to;
            }
            emitLine(lineStart, lineEnd, path);
            lineStart = lineEnd + 1;
        }
    };

    const emitTrimmed = (from, to, kind, path) => {
        let a = from;
        let b = to;
        while (a < b && /\s/.test(src[a])) a++;
        while (b > a && /\s/.test(src[b - 1])) b--;
        push(a, b, kind, path);
    };

    const emitLine = (from, to, path) => {
        const line = src.slice(from, to);
        INLINE_RE.lastIndex = 0;
        let pos = 0;
        let match;
        while ((match = INLINE_RE.exec(line)) !== null) {
            emitTrimmed(from + pos, from + match.index, 'text', path);
            const kind = match[0].startsWith('![') ? 'image' : 'bracket';
            push(from + match.index, from + match.index + match[0].length, kind, path);
            pos = match.index + match[0].length;
        }
        emitTrimmed(from + pos, to, 'text', path);
    };

    const walk = (container, from, to, path) => {
        let pos = from;
        for (const child of container.children) {
            emitPlain(pos, child.start, path);
            if (child.type === 'pair') {
                push(child.start, child.openEnd, 'markup', path, { tag: child.name });
                walk(child, child.openEnd, child.closeStart, [...path, child.name]);
                push(child.closeStart, child.end, 'markup', path, { tag: child.name });
            } else if (child.type === 'markup') {
                push(child.start, child.end, 'markup', path, { tag: child.name });
            } else {
                push(child.start, child.end, child.type, path);
            }
            pos = child.end;
        }
        emitPlain(pos, to, path);
    };

    walk(root, 0, src.length, []);
    return segments;
}
