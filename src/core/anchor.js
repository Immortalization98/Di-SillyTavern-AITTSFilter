// Anchor samples: a message plus the user's verdict on which parts are read.
// Labels are stored as character ranges of the source (so they survive
// segmenter changes); per-segment labels are derived from them.
// Pure module.

import { segmentText } from './segmenter.js';
import { ruleKey, sanitizeRule, makeSchemeDecider, isGenericTagRule } from './scheme-rules.js';

/**
 * @typedef {object} Anchor
 * @property {string} id
 * @property {string} text                         the original message
 * @property {[number, number, string][]} skips    [start, end, category] ranges that are NOT read
 * @property {number} at                           created (ms)
 */

/**
 * @typedef {object} LabeledSample
 * @property {string} text
 * @property {import('./segmenter.js').Segment[]} segments
 * @property {Map<number, { skip: boolean, cat: string }>} labels  non-markup segments only
 */

const WS = /\s+/gu;

/**
 * Per-segment labels from stored ranges: a segment is "not read" when at
 * least half of its characters are inside skip ranges.
 * @param {string} text
 * @param {import('./segmenter.js').Segment[]} segments
 * @param {[number, number, string][]} skips
 */
export function labelsFromRanges(text, segments, skips) {
    /** @type {Map<number, { skip: boolean, cat: string }>} */
    const labels = new Map();
    for (const seg of segments) {
        if (seg.kind === 'markup') {
            continue;
        }
        let covered = 0;
        let cat = 'other';
        let best = 0;
        for (const [a, b, c] of skips) {
            const overlap = Math.max(0, Math.min(b, seg.end) - Math.max(a, seg.start));
            covered += overlap;
            if (overlap > best) {
                best = overlap;
                cat = c || 'other';
            }
        }
        const skip = covered * 2 >= seg.end - seg.start;
        labels.set(seg.id, skip ? { skip, cat } : { skip, cat: 'read' });
    }
    return labels;
}

/**
 * Stores per-segment verdicts as ranges.
 * @param {import('./segmenter.js').Segment[]} segments
 * @param {Map<number, { skip: boolean, cat?: string }>} labels
 * @returns {[number, number, string][]}
 */
export function rangesFromLabels(segments, labels) {
    return segments
        .filter(seg => labels.get(seg.id)?.skip)
        .map(seg => /** @type {[number, number, string]} */ ([seg.start, seg.end, labels.get(seg.id)?.cat || 'other']));
}

/** @param {Anchor} anchor @returns {LabeledSample} */
export function labelAnchor(anchor) {
    const segments = segmentText(anchor.text);
    return { text: anchor.text, segments, labels: labelsFromRanges(anchor.text, segments, anchor.skips) };
}

/**
 * Aligns a pasted "正文" (the part that should be read) to the segments of
 * the original. Whitespace is ignored. Segments are matched in order; a
 * segment whose text comes next in the body is "read", otherwise "not read".
 * @param {string} text
 * @param {string} body
 * @returns {{ ok: true, labels: Map<number, { skip: boolean, cat: string }>, segments: import('./segmenter.js').Segment[] }
 *   | { ok: false, error: string }}
 */
export function alignBody(text, body) {
    const segments = segmentText(text);
    const target = String(body ?? '').replace(WS, '');
    if (!target) {
        return { ok: false, error: '正文是空的' };
    }
    /** @type {Map<number, { skip: boolean, cat: string }>} */
    const labels = new Map();
    let cursor = 0;
    for (const seg of segments) {
        if (seg.kind === 'markup') {
            continue;
        }
        const piece = text.slice(seg.start, seg.end).replace(WS, '');
        if (piece && target.startsWith(piece, cursor)) {
            labels.set(seg.id, { skip: false, cat: 'read' });
            cursor += piece.length;
        } else {
            labels.set(seg.id, { skip: true, cat: 'other' });
        }
    }
    if (cursor < target.length) {
        const rest = Array.from(target.slice(cursor)).slice(0, 20).join('');
        return { ok: false, error: `正文里这一处在原文中按顺序找不到，或者只取了某一行的一部分：“${rest}…”` };
    }
    return { ok: true, labels, segments };
}

// No '#' or '>' here: Markdown headings and quotes start story text too.
const SYMBOL_PREFIX = /^(?:\p{Extended_Pictographic}️?|[※●■◆◇★☆▶►•▪|｜])/u;
const LABEL_PREFIX = /^[\p{L}\p{N}_]{1,8}[：:]/u;
const HEADER_PREFIX = /^【[^】\n]{1,10}】/u;

/** Candidate prefixes of a "not read" segment. @param {string} body */
function prefixCandidates(body) {
    const out = [];
    for (const re of [SYMBOL_PREFIX, LABEL_PREFIX, HEADER_PREFIX]) {
        const m = body.match(re);
        if (m) out.push(m[0]);
    }
    return out;
}

/**
 * Learns rules that are true for every sample: a feature is kept only when
 * it never touches a segment the user wants read.
 * @param {LabeledSample[]} samples
 * @returns {{ rule: import('./scheme-rules.js').SchemeRule, support: number, samples: number }[]}
 *   support = segments it skips; samples = how many samples it was seen in
 */
export function extractRules(samples) {
    /** @type {Map<string, { rule: any, skip: number, read: number, seen: Set<number> }>} */
    const stats = new Map();
    let sampleIndex = 0;
    const bump = (rule, skip) => {
        const clean = sanitizeRule(rule);
        if (!clean || isGenericTagRule(clean)) return;
        const key = ruleKey(clean);
        const entry = stats.get(key) ?? { rule: clean, skip: 0, read: 0, seen: new Set() };
        if (skip) {
            entry.skip++;
            entry.seen.add(sampleIndex);
        } else {
            entry.read++;
        }
        stats.set(key, entry);
    };

    for (const [index, sample] of samples.entries()) {
        sampleIndex = index;
        for (const seg of sample.segments) {
            const label = sample.labels.get(seg.id);
            if (!label) continue;
            const body = sample.text.slice(seg.start, seg.end).trim();
            const tags = [...new Set(seg.path.map(p => p.toLowerCase()))];
            for (const tag of tags) {
                bump({ type: 'tag', name: seg.path.find(p => p.toLowerCase() === tag) }, label.skip);
            }
            if (seg.kind === 'bracket') {
                bump({ type: 'bracket', open: body[0] }, label.skip);
            }
            if (makeSchemeDecider(sample.text, [seg], [{ type: 'kv' }])(seg) !== null) {
                bump({ type: 'kv' }, label.skip);
            }
            if (label.skip) {
                for (const p of prefixCandidates(body)) {
                    bump({ type: 'prefix', value: p }, true);
                }
            }
        }
    }

    // Prefix candidates must not start any segment the user reads.
    for (const [key, entry] of stats) {
        if (entry.rule.type !== 'prefix') continue;
        for (const sample of samples) {
            for (const seg of sample.segments) {
                const label = sample.labels.get(seg.id);
                if (label && !label.skip && sample.text.slice(seg.start, seg.end).trim().startsWith(entry.rule.value)) {
                    entry.read++;
                }
            }
        }
        stats.set(key, entry);
    }

    const found = [...stats.values()]
        .filter(e => e.skip > 0 && e.read === 0)
        .map(e => ({ rule: e.rule, support: e.skip, samples: e.seen.size }));

    // Content tags: every read segment sits inside the tag, and something outside it is not read.
    /** @type {Map<string, string>} */
    const tagNames = new Map();
    for (const sample of samples) {
        for (const seg of sample.segments) {
            for (const p of seg.path) tagNames.set(p.toLowerCase(), p);
        }
    }
    for (const [lower, name] of tagNames) {
        if (isGenericTagRule({ type: 'contentTag', name })) continue;
        let readInside = 0;
        let skipOutside = 0;
        let broken = false;
        let seenIn = 0;
        for (const sample of samples) {
            const present = sample.segments.some(seg => seg.path.some(p => p.toLowerCase() === lower));
            if (!present) continue;
            seenIn++;
            for (const seg of sample.segments) {
                const label = sample.labels.get(seg.id);
                if (!label) continue;
                const inside = seg.path.some(p => p.toLowerCase() === lower);
                if (!label.skip && inside) readInside++;
                if (!label.skip && !inside) broken = true;
                if (label.skip && !inside) skipOutside++;
            }
        }
        if (!broken && readInside > 0 && skipOutside > 0) {
            found.push({ rule: { type: 'contentTag', name }, support: skipOutside, samples: seenIn });
        }
    }

    return found.sort((a, b) => b.support - a.support);
}

/**
 * Checks a single rule against the samples: it must never skip a segment the
 * user reads.
 * @param {import('./scheme-rules.js').SchemeRule} rule
 * @param {LabeledSample[]} samples
 * @returns {{ ok: boolean, wrong: number, hits: number }}
 */
export function checkRule(rule, samples) {
    let wrong = 0;
    let hits = 0;
    for (const sample of samples) {
        const decide = makeSchemeDecider(sample.text, sample.segments, [rule]);
        for (const seg of sample.segments) {
            const label = sample.labels.get(seg.id);
            if (!label || !decide(seg)) continue;
            hits++;
            if (!label.skip) wrong++;
        }
    }
    return { ok: wrong === 0, wrong, hits };
}

/**
 * Compares filter decisions with the user's labels.
 * @param {LabeledSample} sample
 * @param {Set<number>|Map<number, unknown>} skipped  segment ids the filter skipped
 */
export function compareWithLabels(sample, skipped) {
    const has = (id) => (skipped instanceof Set ? skipped.has(id) : skipped.has(id));
    const wrongSkip = [];
    const wrongRead = [];
    let total = 0;
    for (const [id, label] of sample.labels) {
        total++;
        if (has(id) && !label.skip) wrongSkip.push(id);
        if (!has(id) && label.skip) wrongRead.push(id);
    }
    return { total, correct: total - wrongSkip.length - wrongRead.length, wrongSkip, wrongRead };
}
