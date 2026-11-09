// The filter pipeline: segment -> rules -> model -> compose.
// The model call is injected, so this module stays pure and testable.

import { segmentText } from './segmenter.js';
import { applyRules } from './rules.js';
import { buildBatches, parseAnswer } from './prompt.js';
import { skipRanges, applyRanges, isSubsequence } from './compose.js';

/**
 * @typedef {object} PipelineOptions
 * @property {'llm'|'rules'} mode
 * @property {import('./rules.js').RuleConfig} rules
 * @property {string} [systemPrompt]
 * @property {number} [maxSegmentChars]
 * @property {number} [maxBatchChars]
 * @property {string} [formatNote]     format scheme note appended to the system prompt
 * @property {{ user: string, assistant: string }[]} [examples]  worked examples (few-shot)
 * @property {number} [guardMinChars]   if the model skips everything it was sent and that was at
 *                                      least this many characters, treat the answer as broken
 * @property {(messages: {role:string,content:string}[], signal?: AbortSignal) => Promise<unknown>} [classify]
 * @property {AbortSignal} [signal]
 */

/**
 * @typedef {object} FilterResult
 * @property {import('./segmenter.js').Segment[]} segments
 * @property {Map<number, import('./rules.js').Decision>} decisions  skipped segments only
 * @property {'rules'|'llm'|'fallback'} source  'fallback' = the model failed, rules only
 * @property {string} [error]
 * @property {number} llmCalls
 */

export class GuardError extends Error { }

/**
 * Runs the pipeline. Never throws for model problems: they come back as
 * source 'fallback' with `error`. Throws only if aborted.
 * @param {string} text
 * @param {PipelineOptions} opts
 * @returns {Promise<FilterResult>}
 */
export async function runFilter(text, opts) {
    const segments = segmentText(text);
    const decided = applyRules(text, segments, opts.rules);
    const decisions = new Map([...decided].filter(([, d]) => d.skip));
    const undecided = segments.filter(seg => !decided.has(seg.id));

    if (opts.mode !== 'llm' || undecided.length === 0 || !opts.classify) {
        return { segments, decisions, source: 'rules', llmCalls: 0 };
    }

    const batches = buildBatches(text, segments, decided, opts);
    /** @type {Map<number, import('./rules.js').Decision>} */
    const fromModel = new Map();
    let llmCalls = 0;
    try {
        for (const batch of batches) {
            llmCalls++;
            const answer = await opts.classify(batch.messages, opts.signal);
            const picked = parseAnswer(answer, batch.ids.length);
            const guardMin = opts.guardMinChars ?? 300;
            if (picked.size === batch.ids.length && batch.sourceChars >= guardMin) {
                throw new GuardError('模型要跳过发给它的全部内容，视为异常');
            }
            for (const [n, cat] of picked) {
                fromModel.set(batch.ids[n - 1], { skip: true, cat, src: 'llm' });
            }
        }
    } catch (error) {
        if (opts.signal?.aborted) {
            throw error;
        }
        return { segments, decisions, source: 'fallback', error: describeError(error), llmCalls };
    }

    for (const [id, d] of fromModel) {
        decisions.set(id, d);
    }
    return { segments, decisions, source: 'llm', llmCalls };
}

/**
 * @param {unknown} error
 * @returns {string}
 */
export function describeError(error) {
    if (!(error instanceof Error)) {
        return String(error);
    }
    const cause = error.cause instanceof Error ? `：${error.cause.message}` : '';
    return `${error.message}${cause}`;
}

/**
 * Builds the text to read from a result (or from cached decisions).
 * @param {string} text
 * @param {import('./segmenter.js').Segment[]} segments
 * @param {Map<number, unknown>|Set<number>} skipped  keys are skipped segment ids
 * @param {number} [fromIndex]  read only what is after this offset (continue)
 * @returns {string}
 */
export function composeOutput(text, segments, skipped, fromIndex = 0) {
    const ids = skipped instanceof Set ? skipped : new Set(skipped.keys());
    const output = applyRanges(text, skipRanges(segments, ids), fromIndex);
    if (!isSubsequence(output, text)) {
        // Cannot happen by construction; refuse rather than read altered text.
        throw new Error('朗读文本不是原文的子序列');
    }
    return output;
}
