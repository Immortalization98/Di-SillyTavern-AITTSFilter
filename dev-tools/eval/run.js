// Runs the accuracy samples through the real extension code inside a
// SillyTavern page (dev only). Usage from the browser console:
//   const { runEval } = await import('/scripts/extensions/third-party/Di-SillyTavern-AITTSFilter/dev-tools/eval/run.js');
//   await runEval();
// Uses whatever model the extension settings point to. Ignores the cache.

import { SAMPLES } from './samples.js';
import { filterText } from '../../src/filter.js';

/**
 * @param {{ ids?: string[] }} [opts]
 */
export async function runEval(opts = {}) {
    const samples = opts.ids ? SAMPLES.filter(s => opts.ids.includes(s.id)) : SAMPLES;
    const results = [];
    for (const sample of samples) {
        const started = Date.now();
        let outcome;
        try {
            outcome = await filterText(sample.text, { force: true, quiet: true });
        } catch (error) {
            results.push({ id: sample.id, error: String(error), pass: false });
            continue;
        }
        const missingKeep = sample.keep.filter(k => !outcome.output.includes(k));
        const leakedSkip = sample.skip.filter(k => outcome.output.includes(k));
        const skipped = [...outcome.decisions.entries()]
            .filter(([, d]) => d.cat !== 'markup')
            .map(([id, d]) => {
                const seg = outcome.segments[id];
                return `${d.src === 'llm' ? 'M' : 'R'}:${d.cat}: ${sample.text.slice(seg.start, seg.end).slice(0, 40)}`;
            });
        results.push({
            id: sample.id,
            pass: outcome.source !== 'fallback' && missingKeep.length === 0 && leakedSkip.length === 0,
            source: outcome.source,
            error: outcome.error,
            ms: Date.now() - started,
            missingKeep,
            leakedSkip,
            skipped,
        });
    }
    const keepTotal = samples.reduce((n, s) => n + s.keep.length, 0);
    const skipTotal = samples.reduce((n, s) => n + s.skip.length, 0);
    const wrongDrops = results.reduce((n, r) => n + (r.missingKeep?.length ?? 0), 0);
    const leaks = results.reduce((n, r) => n + (r.leakedSkip?.length ?? 0), 0);
    return {
        passed: results.filter(r => r.pass).length,
        total: results.length,
        keepKept: `${keepTotal - wrongDrops}/${keepTotal}`,
        skipRemoved: `${skipTotal - leaks}/${skipTotal}`,
        avgMs: Math.round(results.reduce((n, r) => n + (r.ms ?? 0), 0) / Math.max(1, results.length)),
        results,
    };
}
