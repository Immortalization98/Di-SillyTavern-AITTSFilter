// Structured rules of a format scheme (learned from anchor samples or from
// the AI analysis). Only these fixed shapes exist: no free-form regex, so a
// bad rule cannot hang the page and every rule can be shown in plain words.
// Pure module.

/**
 * @typedef {{ type: 'tag', name: string }
 *   | { type: 'contentTag', name: string }
 *   | { type: 'prefix', value: string }
 *   | { type: 'bracket', open: string }
 *   | { type: 'kv' }} SchemeRule
 */

export const BRACKET_OPENS = ['【', '[', '{'];

/**
 * Layout / formatting tags that wrap story text as often as status panels.
 * They are never learned automatically and never accepted from the model.
 */
export const GENERIC_TAGS = new Set([
    'div', 'span', 'p', 'b', 'i', 'u', 's', 'em', 'strong', 'small', 'big', 'sup', 'sub', 'mark', 'center', 'font',
    'blockquote', 'q', 'cite', 'del', 'ins', 'a', 'li', 'ul', 'ol', 'pre', 'code', 'details', 'summary', 'br', 'hr',
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'section', 'article', 'header', 'footer', 'main', 'aside', 'nav',
    'table', 'thead', 'tbody', 'tr', 'td', 'th', 'img', 'figure', 'figcaption',
]);

/** @param {SchemeRule} rule */
export function isGenericTagRule(rule) {
    return (rule.type === 'tag' || rule.type === 'contentTag') && GENERIC_TAGS.has(rule.name.toLowerCase());
}

// "key：value | key：value" with at least two pairs.
const KV_LINE = /^[^：:|｜\n]{1,12}[：:][^|｜\n]*(?:[|｜][^：:|｜\n]{1,12}[：:][^|｜\n]*)+$/u;
const NAME_OK = /^[\p{L}\p{N}_:.-]{1,40}$/u;
// Prefixes that would also start ordinary dialogue or narration are refused.
const BAD_PREFIX_START = /^[\s“”"'‘’「」『』（(《〈—…\-—*_~]/u;

/** @param {SchemeRule} rule */
export function ruleKey(rule) {
    switch (rule.type) {
        case 'tag': return `tag:${rule.name.toLowerCase()}`;
        case 'contentTag': return `content:${rule.name.toLowerCase()}`;
        case 'prefix': return `prefix:${rule.value}`;
        case 'bracket': return `bracket:${rule.open}`;
        case 'kv': return 'kv';
        default: return 'unknown';
    }
}

/** @param {SchemeRule} rule */
export function describeRule(rule) {
    switch (rule.type) {
        case 'tag': return `<${rule.name}> 标签里的内容整块不读`;
        case 'contentTag': return `有 <${rule.name}> 标签时，只读标签里面的内容`;
        case 'prefix': return `以“${rule.value}”开头的行不读`;
        case 'bracket': return `整段被 ${rule.open}${closeOf(rule.open)} 括起来的内容不读`;
        case 'kv': return '“名称：数值 | 名称：数值”这样的数值行不读';
        default: return '未知规则';
    }
}

function closeOf(open) {
    return { '【': '】', '[': ']', '{': '}' }[open] ?? '';
}

/**
 * Validates and normalizes a rule from storage or from a model.
 * @param {any} raw
 * @returns {SchemeRule|null}
 */
export function sanitizeRule(raw) {
    if (!raw || typeof raw !== 'object') {
        return null;
    }
    const type = String(raw.type ?? '');
    if (type === 'tag' || type === 'contentTag') {
        const name = String(raw.name ?? '').trim().replace(/^<\/?|>$/g, '');
        return NAME_OK.test(name) ? { type, name } : null;
    }
    if (type === 'prefix') {
        const value = String(raw.value ?? '').replace(/\n/g, '').trimStart();
        const chars = Array.from(value);
        if (chars.length < 1 || chars.length > 12 || !value.trim() || BAD_PREFIX_START.test(value)) {
            return null;
        }
        // A single letter or digit ("她", "1") would start ordinary text.
        if (chars.length === 1 && /[\p{L}\p{N}]/u.test(chars[0])) {
            return null;
        }
        return { type, value };
    }
    if (type === 'bracket') {
        const open = String(raw.open ?? '');
        return BRACKET_OPENS.includes(open) ? { type, open } : null;
    }
    if (type === 'kv') {
        return { type };
    }
    return null;
}

/**
 * Decides segments with scheme rules. Only ever says "skip".
 * @param {string} text
 * @param {import('./segmenter.js').Segment[]} segments
 * @param {SchemeRule[]} rules
 * @returns {(seg: import('./segmenter.js').Segment) => string|null} returns the rule key that skips it
 */
export function makeSchemeDecider(text, segments, rules) {
    if (!rules?.length) {
        return () => null;
    }
    const lowerPath = (seg) => seg.path.map(p => p.toLowerCase());
    const contentTags = rules.filter(r => r.type === 'contentTag').map(r => r.name.toLowerCase());
    const presentContent = contentTags.filter(t => segments.some(seg => seg.kind !== 'markup' && lowerPath(seg).includes(t)));

    return (seg) => {
        if (seg.kind === 'markup') {
            return null;
        }
        const path = lowerPath(seg);
        const body = text.slice(seg.start, seg.end).trim();
        for (const rule of rules) {
            switch (rule.type) {
                case 'tag':
                    if (path.includes(rule.name.toLowerCase())) return ruleKey(rule);
                    break;
                case 'contentTag':
                    if (presentContent.includes(rule.name.toLowerCase()) && !path.some(p => presentContent.includes(p))) return ruleKey(rule);
                    break;
                case 'prefix':
                    if (body.startsWith(rule.value)) return ruleKey(rule);
                    break;
                case 'bracket':
                    if (seg.kind === 'bracket' && body.startsWith(rule.open)) return ruleKey(rule);
                    break;
                case 'kv':
                    if ((seg.kind === 'text' || seg.kind === 'bracket') && KV_LINE.test(body.replace(/^[【[{]|[】\]}]$/g, ''))) return ruleKey(rule);
                    break;
            }
        }
        return null;
    };
}
