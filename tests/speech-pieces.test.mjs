import { test } from 'node:test';
import assert from 'node:assert/strict';
import { speechPieces, breakLongLine, MAX_SPEECH_CHARS } from '../src/core/speech-pieces.js';

const len = (s) => Array.from(s).length;

test('short text comes back unchanged as one piece', () => {
    const text = '她推开门。\n\n“早。”';
    assert.deepEqual(speechPieces(text), [text]);
    assert.deepEqual(speechPieces(text, { nativeSplitsLines: true }), [text]);
    assert.deepEqual(speechPieces(' \n\n '), []);
    assert.equal(MAX_SPEECH_CHARS, 1000);
});

test('a long line is broken at sentence ends, a long sentence every max characters', () => {
    assert.deepEqual(breakLongLine('一二三。四五六！七八', 6), ['一二三。', '四五六！七八']);
    assert.deepEqual(breakLongLine('“走吧。”他说。好', 5), ['“走吧。”', '他说。好']);
    const parts = breakLongLine('字'.repeat(13), 5);
    assert.deepEqual(parts.map(len), [5, 5, 3]);
    assert.equal(parts.join(''), '字'.repeat(13));
    assert.deepEqual(breakLongLine('😀'.repeat(4), 3), ['😀😀😀', '😀']); // no broken surrogate pairs
    // a full stop ends a sentence only before a space or the end, not inside 3.5
    assert.deepEqual(breakLongLine('It is 3.5 m. Then we go. Ok', 14), ['It is 3.5 m.', ' Then we go.', ' Ok']);
});

test('native splits lines: one piece, only over-long lines are put on new lines', () => {
    const long = `${'甲'.repeat(8)}。${'乙'.repeat(8)}。`;
    const [piece, ...rest] = speechPieces(`短的。\n${long}`, { max: 10, nativeSplitsLines: true });
    assert.equal(rest.length, 0);
    assert.deepEqual(piece.split('\n'), ['短的。', `${'甲'.repeat(8)}。`, `${'乙'.repeat(8)}。`]);
});

test('native sends the whole text: lines are packed into pieces of at most max characters', () => {
    const lines = ['一'.repeat(4), '二'.repeat(4), '三'.repeat(4), '四'.repeat(12)];
    const pieces = speechPieces(lines.join('\n\n'), { max: 10 });
    assert.deepEqual(pieces, ['一一一一\n二二二二', '三三三三', '四'.repeat(10), '四四']);
    for (const p of pieces) assert.ok(len(p) <= 10);
    // nothing is lost or reordered
    assert.equal(pieces.join('').replace(/\n/g, ''), lines.join(''));
});
