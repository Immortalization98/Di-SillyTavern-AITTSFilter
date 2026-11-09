// Filter service: reads a message (read-only), checks the cache, runs the
// pipeline and returns the text to read. Never writes to the chat.

import { runFilter, composeOutput } from './core/pipeline.js';
import { segmentText } from './core/segmenter.js';
import { hashString } from './core/hash.js';
import { getSettings, buildRuleConfig, configHash, effectivePrompt } from './settings.js';
import { cacheGet, cacheSet } from './cache.js';
import { classify, modelIdentity } from './llm.js';
import { resolveScheme, effectiveRules, buildExamples, schemeFingerprint, anchorFor } from './scheme.js';
import { labelAnchor } from './core/anchor.js';

/**
 * @typedef {object} FilterOutcome
 * @property {string} text      the source text that was filtered
 * @property {string} output    the text to read ('' = nothing to read)
 * @property {import('./core/segmenter.js').Segment[]} segments
 * @property {Map<number, import('./core/rules.js').Decision>} decisions  skipped segments
 * @property {'rules'|'llm'|'fallback'|'manual'} source
 * @property {import('./scheme.js').Scheme|null} scheme  format scheme used
 * @property {'card'|'preset'|'default'|'explicit'|null} schemeVia
 * @property {'rules'|'original'|'none'} [fallbackAction]
 * @property {string} [error]
 * @property {boolean} fromCache
 * @property {number} ms
 */

/** @type {Map<string, Promise<FilterOutcome>>} */
const inflight = new Map();
let lastWarnAt = 0;

/**
 * Returns the text native TTS would read for a message, without changing it.
 * @param {number} mesId
 * @returns {{ text: string, message: any } | null}
 */
export function getMessageSource(mesId) {
    const ctx = SillyTavern.getContext();
    const message = ctx.chat?.[mesId];
    if (!message) {
        return null;
    }
    let text = String(message.mes ?? '');
    if (ctx.extensionSettings.tts?.narrate_translated_only && message.extra?.display_text) {
        text = String(message.extra.display_text);
    }
    return { text, message };
}

function warnOnce(message) {
    const now = Date.now();
    if (now - lastWarnAt > 15_000) {
        lastWarnAt = now;
        toastr.warning(message, 'AI 朗读过滤', { timeOut: 6000 });
    }
}

/**
 * @typedef {object} FilterOptions
 * @property {boolean} [force]       ignore the cache
 * @property {AbortSignal} [signal]
 * @property {number} [fromIndex]    read only what follows this offset
 * @property {boolean} [quiet]       no toasts
 * @property {any} [message]         chat message the text belongs to (picks the format scheme)
 * @property {import('./scheme.js').Scheme|null} [scheme]  use this scheme instead of resolving one
 * @property {string} [excludeAnchorId]  leave this sample out of the worked examples (back-test)
 * @property {boolean} [noCache]     do not write the result to the cache (back-test)
 */

/**
 * Which scheme applies, and the cache key for this text.
 * @param {string} text
 * @param {FilterOptions} opts
 */
function resolveFor(text, opts) {
    const s = getSettings();
    /** @type {{ scheme: import('./scheme.js').Scheme, via: any } | null} */
    let resolved = null;
    let fingerprint = '';
    try {
        resolved = 'scheme' in opts
            ? (opts.scheme ? { scheme: opts.scheme, via: /** @type {const} */ ('explicit') } : null)
            : resolveScheme(opts.message);
        fingerprint = schemeFingerprint(resolved?.scheme ?? null, opts.excludeAnchorId);
    } catch (error) {
        // A damaged scheme must not break narration: filter without it.
        console.warn('[AI TTS Filter] format scheme ignored', error);
        resolved = null;
        fingerprint = '';
    }
    const scheme = resolved?.scheme ?? null;
    const key = `${configHash(s, modelIdentity())}:${fingerprint}:${hashString(text)}`;
    return { s, scheme, via: resolved?.via ?? null, key };
}

/**
 * @param {string} text
 * @param {FilterOptions} [opts]
 * @returns {Promise<FilterOutcome>}
 */
export async function filterText(text, opts = {}) {
    const { s, scheme, via, key } = resolveFor(text, opts);
    const started = performance.now();

    // The text is one of the scheme's samples: the user's labels are the answer.
    const anchor = anchorFor(scheme, text, opts.excludeAnchorId);
    if (anchor) {
        try {
            const sample = labelAnchor(anchor);
            const decisions = new Map();
            for (const seg of sample.segments) {
                if (seg.kind === 'markup') decisions.set(seg.id, { skip: true, cat: 'markup', src: 'rule' });
                else if (sample.labels.get(seg.id)?.skip) decisions.set(seg.id, { skip: true, cat: sample.labels.get(seg.id)?.cat || 'other', src: 'manual' });
            }
            return finish({ text, segments: sample.segments, decisions, source: 'manual', fromCache: false, ms: performance.now() - started, scheme, schemeVia: via }, opts);
        } catch (error) {
            console.warn('[AI TTS Filter] sample labels ignored', error);
        }
    }

    if (!opts.force) {
        const entry = await cacheGet(key);
        if (entry) {
            const segments = segmentText(text);
            const decisions = new Map(entry.k
                .filter(([id]) => id >= 0 && id < segments.length)
                .map(([id, cat, src, tag]) => [id, { skip: true, cat, src: /** @type {any} */ (src), ...(tag ? { tag } : {}) }]));
            return finish({ text, segments, decisions, source: entry.s, fromCache: true, ms: performance.now() - started, scheme, schemeVia: via }, opts);
        }
        const pending = inflight.get(key);
        if (pending) {
            try {
                return finish({ ...(await pending), ms: performance.now() - started }, opts);
            } catch (error) {
                // The shared run was cancelled by its own caller; run again unless we were cancelled too.
                if (opts.signal?.aborted) {
                    throw error;
                }
            }
        }
    }

    const run = (async () => {
        const { rules } = buildRuleConfig(s);
        const maxSegmentChars = Number(s.maxSegmentChars) || 200;
        let examples = [];
        if (scheme) {
            try {
                rules.schemeRules = effectiveRules(scheme);
                examples = buildExamples(scheme, rules, { maxSegmentChars, excludeAnchorId: opts.excludeAnchorId });
            } catch (error) {
                console.warn('[AI TTS Filter] format scheme rules ignored', error);
                rules.schemeRules = [];
            }
        }
        const result = await runFilter(text, {
            mode: s.mode === 'rules' ? 'rules' : 'llm',
            rules,
            systemPrompt: effectivePrompt(s),
            maxSegmentChars,
            formatNote: scheme?.note ?? '',
            examples,
            classify,
            signal: opts.signal,
        });
        if (result.source !== 'fallback' && !opts.noCache) {
            await cacheSet(key, {
                k: [...result.decisions].map(([id, d]) => (d.tag ? [id, d.cat, d.src, d.tag] : [id, d.cat, d.src])),
                s: result.source,
                t: Date.now(),
                u: Date.now(),
            }, { maxEntries: s.cacheMaxEntries, maxDays: s.cacheMaxDays });
        }
        return /** @type {FilterOutcome} */ ({ text, segments: result.segments, decisions: result.decisions, source: result.source, error: result.error, fromCache: false, output: '', ms: 0, scheme, schemeVia: via });
    })();

    inflight.set(key, run);
    try {
        const outcome = await run;
        return finish({ ...outcome, ms: performance.now() - started }, opts);
    } finally {
        if (inflight.get(key) === run) {
            inflight.delete(key);
        }
    }
}

/**
 * @param {Omit<FilterOutcome, 'output'> & { output?: string }} o
 * @param {{ fromIndex?: number, quiet?: boolean }} opts
 * @returns {FilterOutcome}
 */
function finish(o, opts) {
    const s = getSettings();
    /** @type {FilterOutcome} */
    const outcome = { ...o, output: '' };
    if (o.source === 'fallback') {
        outcome.fallbackAction = s.onFailure;
        if (!opts.quiet) {
            const what = { rules: '改用规则过滤', original: '改为朗读原文', none: '本条不朗读' }[s.onFailure] ?? '改用规则过滤';
            warnOnce(`过滤模型出错，${what}。${o.error ?? ''}`);
        }
        if (s.onFailure === 'original') {
            outcome.output = o.text.slice(opts.fromIndex ?? 0).trim();
            return outcome;
        }
        if (s.onFailure === 'none') {
            return outcome;
        }
    }
    outcome.output = composeOutput(o.text, o.segments, o.decisions, opts.fromIndex ?? 0);
    return outcome;
}

/**
 * Remembers a hand-corrected result for this text (same cache key as a normal
 * filter run with the same options), so later narrations use it.
 * @param {string} text
 * @param {FilterOptions} opts
 * @param {Map<number, { skip: boolean, cat?: string }>} labels  non-markup segment verdicts
 */
export async function saveManualResult(text, opts, labels) {
    const { s, key } = resolveFor(text, opts);
    const segments = segmentText(text);
    const k = [];
    for (const seg of segments) {
        if (seg.kind === 'markup') {
            k.push([seg.id, 'markup', 'rule']);
        } else if (labels.get(seg.id)?.skip) {
            k.push([seg.id, labels.get(seg.id)?.cat || 'other', 'manual']);
        }
    }
    await cacheSet(key, { k, s: 'manual', t: Date.now(), u: Date.now() }, { maxEntries: s.cacheMaxEntries, maxDays: s.cacheMaxDays });
}
