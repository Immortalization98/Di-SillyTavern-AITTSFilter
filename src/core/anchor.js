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
 * @typedef {object} BodyDiff
 * @property {number} line      1-based line of the original
 * @property {string} removed   in the original but not in the 正文 (e.g. hidden by a display regex)
 * @property {string} added     in the 正文 but not in the original
 * @property {string} before    a little matching context before
 * @property {string} after     a little matching context after
 */

const FUZZY_MIN_CHARS = 6;      // shorter pieces must match exactly
const FUZZY_MAX_CHARS = 1500;   // longer pieces are not compared character by character
const FUZZY_MIN_RATIO = 0.75;   // share of the piece's characters found in the 正文
const FUZZY_MIN_RUN_SHARE = 0.8; // share of matched characters that sit in runs of 3 or more
const FUZZY_CELL_BUDGET = 2e7;   // total comparison cells per alignment (keeps the page responsive)
const KV_LIKE = /^[^：:|｜\n]{1,12}[：:][^|｜\n]*(?:[|｜][^：:|｜\n]{1,12}[：:][^|｜\n]*)+$/u;

/**
 * Longest common subsequence of `piece` against a prefix of `win`.
 * @param {string[]} p
 * @param {string[]} w
 * @returns {{ matched: number, consumed: number, ops: ['=' | '-' | '+', string][] }}
 */
function alignPiece(p, w) {
    const n = p.length;
    const m = w.length;
    const W = m + 1;
    const L = new Uint16Array((n + 1) * W);
    for (let i = 1; i <= n; i++) {
        for (let j = 1; j <= m; j++) {
            L[i * W + j] = p[i - 1] === w[j - 1] ? L[(i - 1) * W + j - 1] + 1 : Math.max(L[(i - 1) * W + j], L[i * W + j - 1]);
        }
    }
    let matched = 0;
    let consumed = 0;
    for (let j = 0; j <= m; j++) {
        if (L[n * W + j] > matched) {
            matched = L[n * W + j];
            consumed = j;
        }
    }
    /** @type {['=' | '-' | '+', string][]} */
    const ops = [];
    let i = n;
    let j = consumed;
    while (i > 0 || j > 0) {
        if (i > 0 && j > 0 && p[i - 1] === w[j - 1] && L[i * W + j] === L[(i - 1) * W + j - 1] + 1) {
            ops.push(['=', p[i - 1]]);
            i--;
            j--;
        } else if (i > 0 && (j === 0 || L[(i - 1) * W + j] >= L[i * W + j - 1])) {
            ops.push(['-', p[i - 1]]);
            i--;
        } else {
            ops.push(['+', w[j - 1]]);
            j--;
        }
    }
    ops.reverse();
    return { matched, consumed, ops };
}

/**
 * Groups edit operations into readable differences with a little context.
 * @param {['=' | '-' | '+', string][]} ops
 * @param {number} line
 * @returns {BodyDiff[]}
 */
function hunks(ops, line) {
    const out = [];
    let k = 0;
    while (k < ops.length) {
        if (ops[k][0] === '=') {
            k++;
            continue;
        }
        let removed = '';
        let added = '';
        const start = k;
        while (k < ops.length && ops[k][0] !== '=') {
            if (ops[k][0] === '-') removed += ops[k][1];
            else added += ops[k][1];
            k++;
        }
        const before = ops.slice(Math.max(0, start - 8), start).filter(o => o[0] === '=').map(o => o[1]).join('');
        const after = ops.slice(k, k + 8).filter(o => o[0] === '=').map(o => o[1]).join('');
        out.push({ line, removed, added, before, after });
    }
    return out;
}

/**
 * Aligns a pasted "正文" (the part that should be read) to the segments of
 * the original. Whitespace is ignored. Segments are matched in order: a
 * segment that comes next in the 正文 is "read", otherwise "not read".
 * A segment that matches only approximately (for example a display regex hid
 * a few words) still counts as "read"; the differences are returned so the
 * user can confirm them.
 * @param {string} text
 * @param {string} body
 * @returns {{ ok: true, labels: Map<number, { skip: boolean, cat: string }>, segments: import('./segmenter.js').Segment[], diffs: BodyDiff[] }
 *   | { ok: false, error: string }}
 */
export function alignBody(text, body) {
    const segments = segmentText(text);
    const target = Array.from(String(body ?? '').replace(WS, ''));
    if (!target.length) {
        return { ok: false, error: '正文是空的' };
    }
    /** @type {Map<number, { skip: boolean, cat: string }>} */
    const labels = new Map();
    /** @type {BodyDiff[]} */
    const diffs = [];
    let cursor = 0;
    let cells = 0;
    for (const seg of segments) {
        if (seg.kind === 'markup') {
            continue;
        }
        const piece = Array.from(text.slice(seg.start, seg.end).replace(WS, ''));
        const exact = piece.length > 0 && piece.every((ch, i) => target[cursor + i] === ch);
        if (exact) {
            labels.set(seg.id, { skip: false, cat: 'read' });
            cursor += piece.length;
            continue;
        }
        // Bracketed and "key：value | key：value" lines are status-like: exact match only.
        const plain = text.slice(seg.start, seg.end).trim();
        const fuzzyAllowed = seg.kind === 'text' && !KV_LIKE.test(plain)
            && piece.length >= FUZZY_MIN_CHARS && piece.length <= FUZZY_MAX_CHARS && cursor < target.length;
        const win = fuzzyAllowed ? target.slice(cursor, cursor + piece.length * 2 + 40) : [];
        if (fuzzyAllowed && cells + piece.length * win.length <= FUZZY_CELL_BUDGET) {
            cells += piece.length * win.length;
            const { matched, consumed, ops } = alignPiece(piece, win);
            let leading = 0;
            while (leading < ops.length && ops[leading][0] === '+') leading++;
            const span = consumed - leading;
            const dense = leading <= Math.max(4, piece.length * 0.2) && span <= piece.length * 1.5 + 8;
            // Matches must mostly come in runs, not as scattered common characters.
            let inRuns = 0;
            let run = 0;
            for (const [op] of [...ops, ['-', '']]) {
                if (op === '=') {
                    run++;
                } else {
                    if (run >= 3) inRuns += run;
                    run = 0;
                }
            }
            const contiguous = matched > 0 && inRuns / matched >= FUZZY_MIN_RUN_SHARE;
            if (matched / piece.length >= FUZZY_MIN_RATIO && dense && contiguous) {
                labels.set(seg.id, { skip: false, cat: 'read' });
                cursor += consumed;
                diffs.push(...hunks(ops, seg.line + 1));
                continue;
            }
        }
        labels.set(seg.id, { skip: true, cat: 'other' });
    }
    if (cursor < target.length) {
        const rest = target.slice(cursor);
        if (rest.length > 10 || rest.length > target.length * 0.3) {
            const head = rest.slice(0, 20).join('');
            return { ok: false, error: `正文里从“${head}…”开始的内容在原文中找不到。请确认原文和正文来自同一条消息（同一个滑动页）。` };
        }
        diffs.push({ line: 0, removed: '', added: rest.join(''), before: '', after: '' });
    }
    return { ok: true, labels, segments, diffs };
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
