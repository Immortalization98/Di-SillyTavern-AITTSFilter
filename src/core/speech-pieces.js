// Cuts the text to read into pieces a speech service accepts. Services refuse
// long input (OpenAI's tts-1 takes at most 4096 characters, and SillyTavern
// then answers 500), and native TTS sends a whole /speak text as one request
// unless "Narrate by paragraphs" is on, which sends each line on its own.

/** Characters per request; well below the limits of common services. */
export const MAX_SPEECH_CHARS = 1000;

/** Sentence ends: Chinese and other stops, and a full stop followed by a space or the end (not the one in 3.5). */
const END = String.raw`(?:[。！？!?…；;]|\.(?=\s|$))`;
const CLOSE = String.raw`[”’」』"'）)\]】]*`;
/** A sentence with its closing punctuation and quotes, or the rest of the line. */
const SENTENCE = new RegExp(String.raw`(?:(?!${END})[\s\S])+(?:${END}+${CLOSE})?|${END}+${CLOSE}`, 'gu');

/** @param {string} s */
const charCount = (s) => Array.from(s).length;

/**
 * Splits one line longer than `max` at sentence ends; a sentence still too
 * long is cut every `max` characters.
 * @param {string} line
 * @param {number} max
 * @returns {string[]}
 */
export function breakLongLine(line, max) {
    if (charCount(line) <= max) return [line];
    /** @type {string[]} */
    const out = [];
    let cur = '';
    let curLen = 0;
    for (const sentence of line.match(SENTENCE) ?? [line]) {
        const chars = Array.from(sentence);
        if (curLen + chars.length <= max) {
            cur += sentence;
            curLen += chars.length;
            continue;
        }
        if (cur) out.push(cur);
        cur = '';
        curLen = 0;
        for (let i = 0; i < chars.length; i += max) {
            const part = chars.slice(i, i + max);
            if (part.length === max) {
                out.push(part.join(''));
            } else {
                cur = part.join('');
                curLen = part.length;
            }
        }
    }
    if (cur) out.push(cur);
    return out;
}

/**
 * The texts to hand to /speak, one call each, in order. Text that is short
 * enough comes back unchanged as one piece.
 * - Native splits lines: one piece; only lines over the limit are broken onto new lines.
 * - It does not: lines are put together into pieces of at most `max` characters.
 * @param {string} text
 * @param {{ max?: number, nativeSplitsLines?: boolean }} [opts]
 * @returns {string[]}
 */
export function speechPieces(text, opts = {}) {
    const max = Math.max(1, opts.max ?? MAX_SPEECH_CHARS);
    const src = String(text ?? '');
    const lines = src.split('\n').filter(line => line.trim());
    if (!lines.length) return [];
    if (opts.nativeSplitsLines) {
        if (lines.every(line => charCount(line) <= max)) return [src];
        return [lines.flatMap(line => breakLongLine(line, max)).join('\n')];
    }
    if (charCount(src) <= max) return [src];
    /** @type {string[]} */
    const pieces = [];
    /** @type {string[]} */
    let cur = [];
    let curLen = 0;
    for (const line of lines.flatMap(l => breakLongLine(l, max))) {
        const n = charCount(line);
        if (cur.length && curLen + 1 + n > max) {
            pieces.push(cur.join('\n'));
            cur = [];
            curLen = 0;
        }
        curLen += (cur.length ? 1 : 0) + n;
        cur.push(line);
    }
    if (cur.length) pieces.push(cur.join('\n'));
    return pieces;
}
