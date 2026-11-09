// Deterministic rules that decide segments without calling a model.
// Pure module.

import { makeSchemeDecider } from './scheme-rules.js';

/**
 * @typedef {object} RuleConfig
 * @property {string[]} skipTags        tags whose whole content is never read (lower case)
 * @property {boolean} contentTagMode   when a content tag exists, skip everything outside it
 * @property {string[]} contentTags     story wrapper tags (lower case)
 * @property {boolean} skipCode
 * @property {boolean} skipComments
 * @property {boolean} skipImages
 * @property {boolean} skipTables
 * @property {boolean} skipDecor        lines with no letters or digits
 * @property {RegExp[]} keepRegex       a match keeps the segment (beats the rules below)
 * @property {RegExp[]} skipRegex       a match skips the segment
 * @property {import('./scheme-rules.js').SchemeRule[]} [schemeRules]  rules of the active format scheme
 */

/**
 * @typedef {object} Decision
 * @property {boolean} skip
 * @property {string} cat     category code (see CATEGORY_LABELS)
 * @property {'rule'|'llm'|'default'} src
 * @property {string} [tag]   the tag that caused a 'tag' or 'outside' decision
 * @property {string} [rule]  the scheme rule key that caused a 'scheme' decision
 */

export const DEFAULT_SKIP_TAGS = ['think', 'thinking', 'reasoning', '思考', '思维链', 'status', '状态栏', 'updatevariable', 'tableedit', 'style', 'script'];
export const DEFAULT_CONTENT_TAGS = ['content', '正文'];

/**
 * Splits a comma/space separated list into lower-case names.
 * @param {string|string[]} value
 * @returns {string[]}
 */
export function parseTagList(value) {
    const list = Array.isArray(value) ? value : String(value ?? '').split(/[\s,，、;；]+/);
    return [...new Set(list.map(s => String(s).trim().toLowerCase()).filter(Boolean))];
}

/**
 * One pattern per line. `/pattern/flags` or a bare pattern (compiled with 'u').
 * @param {string} value
 * @returns {{ regexes: RegExp[], errors: string[] }}
 */
export function parseRegexList(value) {
    const regexes = [];
    const errors = [];
    for (const raw of String(value ?? '').split('\n')) {
        const line = raw.trim();
        if (!line) {
            continue;
        }
        try {
            const m = line.match(/^\/(.+)\/([a-z]*)$/s);
            const flags = m ? m[2].replace(/[gy]/g, '') : 'u';
            regexes.push(new RegExp(m ? m[1] : line, flags));
        } catch (error) {
            errors.push(`${line}: ${error instanceof Error ? error.message : error}`);
        }
    }
    return { regexes, errors };
}

const TABLE_LINE = /^\s*\|.*\|\s*$/;
const HAS_WORD = /[\p{L}\p{N}]/u;

/**
 * @param {string} text
 * @param {import('./segmenter.js').Segment[]} segments
 * @param {RuleConfig} cfg
 * @returns {Map<number, Decision>} decided segments only
 */
export function applyRules(text, segments, cfg) {
    /** @type {Map<number, Decision>} */
    const decided = new Map();
    const skipTags = new Set(cfg.skipTags ?? []);
    const contentTags = new Set(cfg.contentTags ?? []);
    const lowerPath = (seg) => seg.path.map(p => p.toLowerCase());

    const schemeDecide = makeSchemeDecider(text, segments, cfg.schemeRules ?? []);

    const hasContent = cfg.contentTagMode && contentTags.size > 0
        && segments.some(seg => seg.kind !== 'markup' && lowerPath(seg).some(p => contentTags.has(p)));

    for (const seg of segments) {
        if (seg.kind === 'markup') {
            decided.set(seg.id, { skip: true, cat: 'markup', src: 'rule' });
            continue;
        }
        const segText = text.slice(seg.start, seg.end);
        if (cfg.keepRegex?.some(re => re.test(segText))) {
            decided.set(seg.id, { skip: false, cat: 'keep', src: 'rule' });
            continue;
        }
        if (cfg.skipRegex?.some(re => re.test(segText))) {
            decided.set(seg.id, { skip: true, cat: 'regex', src: 'rule' });
            continue;
        }
        const byScheme = schemeDecide(seg);
        if (byScheme) {
            decided.set(seg.id, { skip: true, cat: 'scheme', src: 'rule', rule: byScheme });
            continue;
        }
        const path = lowerPath(seg);
        const skipTagIndex = path.findIndex(p => skipTags.has(p));
        if (skipTagIndex !== -1) {
            decided.set(seg.id, { skip: true, cat: 'tag', src: 'rule', tag: seg.path[skipTagIndex] });
            continue;
        }
        if (hasContent && !path.some(p => contentTags.has(p))) {
            decided.set(seg.id, { skip: true, cat: 'outside', src: 'rule' });
            continue;
        }
        if (seg.kind === 'code' && cfg.skipCode) {
            decided.set(seg.id, { skip: true, cat: 'code', src: 'rule' });
            continue;
        }
        if (seg.kind === 'comment' && cfg.skipComments) {
            decided.set(seg.id, { skip: true, cat: 'comment', src: 'rule' });
            continue;
        }
        if (seg.kind === 'image' && cfg.skipImages) {
            decided.set(seg.id, { skip: true, cat: 'image', src: 'rule' });
            continue;
        }
        if (seg.kind === 'text' && cfg.skipTables && TABLE_LINE.test(segText)) {
            decided.set(seg.id, { skip: true, cat: 'table', src: 'rule' });
            continue;
        }
        if (cfg.skipDecor && !HAS_WORD.test(segText)) {
            decided.set(seg.id, { skip: true, cat: 'decor', src: 'rule' });
            continue;
        }
    }
    return decided;
}
