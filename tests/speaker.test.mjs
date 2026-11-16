// How pieces of a long text are handed to native TTS: the next piece only after
// the previous one's speech came back, so a slow service cannot mix up the order.
// Runs src/speaker.js against a small fake of SillyTavern (events, /speak, settings).

import { test } from 'node:test';
import assert from 'node:assert/strict';

const handlers = new Map();
const eventSource = {
    on: (type, fn) => handlers.set(type, [...(handlers.get(type) ?? []), fn]),
    emit: (type) => (handlers.get(type) ?? []).forEach(fn => fn()),
};
const eventTypes = { TTS_JOB_STARTED: 'started', TTS_JOB_COMPLETE: 'complete' };
/** @type {{ at: number, text: string }[]} */
let calls = [];
let onSpeak = () => { };
const context = {
    eventSource,
    eventTypes,
    extensionSettings: { tts: { enabled: true, narrate_by_paragraphs: false } },
    SlashCommandParser: { commands: { speak: { callback: async (_args, text) => { calls.push({ at: Date.now(), text }); onSpeak(text); return ''; } } } },
};
globalThis.SillyTavern = { getContext: () => context };
globalThis.document = { getElementById: () => null };
globalThis.toastr = { info() { }, warning() { } };

const speaker = await import('../src/speaker.js');
speaker.initSpeaker();

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const started = () => eventSource.emit('started');
const complete = () => eventSource.emit('complete');
const twoPieces = ['甲'.repeat(900), '乙'.repeat(900)].join('\n');

test('the next piece follows once the previous one has finished', async () => {
    calls = [];
    onSpeak = () => {
        setTimeout(started, 20);
        setTimeout(complete, 200);
    };
    assert.equal(await speaker.speakNow(twoPieces, 'v'), true);
    assert.equal(calls.length, 1);
    await sleep(2600);
    assert.equal(calls.length, 2);
    assert.ok(calls[1].text.startsWith('乙'));
    speaker.stopAll();
});

test('a completion of another job in flight does not let the next piece go early', async () => {
    calls = [];
    const timers = [];
    onSpeak = () => {
        // Two jobs in flight (one left running by the reset of /speak): one completes early.
        timers.push(setTimeout(started, 20), setTimeout(started, 40), setTimeout(complete, 200));
    };
    await speaker.speakNow(twoPieces, 'v');
    await sleep(2500);
    assert.equal(calls.length, 1, 'the piece is still in flight');
    complete();
    await sleep(2200);
    assert.equal(calls.length, 2);
    speaker.stopAll();
    timers.forEach(clearTimeout);
});

test('stopAll keeps the remaining pieces back', async () => {
    calls = [];
    onSpeak = () => {
        setTimeout(started, 20);
        setTimeout(complete, 200);
    };
    await speaker.speakNow(twoPieces, 'v');
    speaker.stopAll();
    await sleep(2200);
    assert.equal(calls.length, 1);
});
