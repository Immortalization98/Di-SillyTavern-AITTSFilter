// Turns skip decisions into the text that is read aloud.
// Only deletes characters, so the result is always a subsequence of the source.
// Pure module.

/**
 * Merges the [start, end) ranges of skipped segments.
 * @param {import('./segmenter.js').Segment[]} segments
 * @param {Set<number>} skipIds
 * @returns {[number, number][]}
 */
export function skipRanges(segments, skipIds) {
    const ranges = segments
        .filter(seg => skipIds.has(seg.id))
        .map(seg => /** @type {[number, number]} */ ([seg.start, seg.end]))
        .sort((a, b) => a[0] - b[0]);
    /** @type {[number, number][]} */
    const merged = [];
    for (const r of ranges) {
        const last = merged[merged.length - 1];
        if (last && r[0] <= last[1]) {
            last[1] = Math.max(last[1], r[1]);
        } else {
            merged.push([r[0], r[1]]);
        }
    }
    return merged;
}

/**
 * Removes the ranges (and everything before `fromIndex`), then tidies lines:
 * a line that had text but is now blank disappears, original blank lines stay
 * as paragraph breaks, runs of blank lines collapse to one.
 * @param {string} text
 * @param {[number, number][]} ranges  merged and sorted
 * @param {number} [fromIndex]
 * @returns {string}
 */
export function applyRanges(text, ranges, fromIndex = 0) {
    const keep = new Uint8Array(text.length).fill(1);
    for (let i = 0; i < Math.min(fromIndex, text.length); i++) {
        keep[i] = 0;
    }
    for (const [a, b] of ranges) {
        keep.fill(0, Math.max(0, a), Math.min(text.length, b));
    }

    const lines = [];
    let lineStart = 0;
    while (lineStart <= text.length) {
        let lineEnd = text.indexOf('\n', lineStart);
        if (lineEnd === -1) {
            lineEnd = text.length;
        }
        let kept = '';
        for (let i = lineStart; i < lineEnd; i++) {
            if (keep[i]) {
                kept += text[i];
            }
        }
        const original = text.slice(lineStart, lineEnd);
        if (kept.trim()) {
            lines.push(kept.trim());
        } else if (!original.trim() && lineEnd >= fromIndex) {
            lines.push('');
        }
        lineStart = lineEnd + 1;
    }

    return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * True when every character of `sub` appears in `full` in order.
 * @param {string} sub
 * @param {string} full
 */
export function isSubsequence(sub, full) {
    let j = 0;
    for (let i = 0; i < full.length && j < sub.length; i++) {
        if (full[i] === sub[j]) {
            j++;
        }
    }
    return j === sub.length;
}
