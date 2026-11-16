// Hands filtered text to SillyTavern's built-in TTS through the registered
// /speak command, and queues automatic narration so messages don't cut each
// other off (/speak resets native playback every time it is called).
// Long text is handed over in pieces a speech service accepts.

import { speechPieces } from './core/speech-pieces.js';

const DEFAULT_VOICE = '[Default Voice]';
const IDLE_HOLD_MS = 1500;      // longer than native's 1 s polling, so gaps between paragraphs don't count
const START_TIMEOUT_MS = 10_000; // nothing started -> native skipped the text
// A TTS job that never reported completion (native reports no failed job) counts as done after
// this long. It must outlast a slow speech service: /speak resets native playback but does not
// cancel a request in flight, whose audio still arrives later, so speaking on early mixes up the
// order. Services behind Cloudflare give up after 100 s at most.
const STALE_EVENT_MS = 100_000;
const MAX_WAIT_MS = 10 * 60_000;

let inflightJobs = 0;
let startedJobs = 0;
let completedJobs = 0;
let lastTtsEventAt = 0;
let lastAudioActivityAt = 0;
let generation = 0;
/** Changes with every new narration, so a narration still speaking its pieces gives way. */
let speakToken = 0;
/** When playback was last stopped by hand (paused before its end). */
let stoppedAt = 0;
let piecesHintShown = false;
/** The token of a manual narration still speaking its pieces, or 0. */
let manualToken = 0;
/**
 * @typedef {{ text: string, voice: string } | null} PreparedJob
 * @typedef {{ prepare: (signal: AbortSignal) => Promise<PreparedJob>, label?: string }} QueueItem
 * @type {{ item: QueueItem, controller: AbortController, job: Promise<PreparedJob> }[]}
 */
const queue = [];
let pumping = false;
/** @type {Set<AbortController>} */
const controllers = new Set();

export function initSpeaker() {
    audioElement();
    const { eventSource, eventTypes } = SillyTavern.getContext();
    eventSource.on(eventTypes.TTS_JOB_STARTED, () => {
        // Jobs can overlap (a reset leaves the request in flight running). A count left by a
        // job that failed silently is dropped once nothing has happened for the stale time.
        if (Date.now() - lastTtsEventAt > STALE_EVENT_MS) inflightJobs = 0;
        inflightJobs++;
        startedJobs++;
        lastTtsEventAt = Date.now();
    });
    eventSource.on(eventTypes.TTS_JOB_COMPLETE, () => {
        inflightJobs = Math.max(0, inflightJobs - 1);
        completedJobs++;
        lastTtsEventAt = Date.now();
    });
}

/** @returns {{ ok: boolean, reason?: string }} */
export function checkNativeTts() {
    const ctx = SillyTavern.getContext();
    if (ctx.extensionSettings.disabledExtensions?.includes('tts')) {
        return { ok: false, reason: '原生朗读扩展被停用了' };
    }
    if (!ctx.extensionSettings.tts?.enabled) {
        return { ok: false, reason: '原生朗读没有开启（扩展面板 → TTS → 启用）' };
    }
    if (typeof ctx.SlashCommandParser?.commands?.speak?.callback !== 'function') {
        return { ok: false, reason: '找不到原生朗读命令 /speak' };
    }
    return { ok: true };
}

/** @param {any} message a chat message (read only) */
export function voiceFor(message) {
    if (!message || message.is_user || message.is_system || message.extra?.type === 'narrator') {
        return DEFAULT_VOICE;
    }
    return String(message.name || DEFAULT_VOICE);
}

function audioElement() {
    const audio = /** @type {HTMLAudioElement|null} */ (document.getElementById('tts_audio'));
    if (audio && !audio.dataset.aittsWatched) {
        audio.dataset.aittsWatched = '1';
        for (const type of ['play', 'playing', 'pause', 'ended', 'emptied']) {
            audio.addEventListener(type, () => { lastAudioActivityAt = Date.now(); });
        }
        audio.addEventListener('pause', () => {
            if (!audio.ended) stoppedAt = Date.now();
        });
    }
    return audio;
}

/**
 * Must be called synchronously inside a click handler: lets iOS play audio
 * later, after the model has answered (native TTS does the same).
 */
export function unlockAudio() {
    const audio = audioElement();
    if (audio) {
        audio.src = '/sounds/silence.mp3';
    }
}

function nativeIdleNow() {
    const audio = audioElement();
    const playing = audio ? !audio.paused && !audio.ended : false;
    const jobsDone = inflightJobs === 0 || Date.now() - lastTtsEventAt > STALE_EVENT_MS;
    return !playing && jobsDone;
}

export function isNativeBusy() {
    return !nativeIdleNow();
}

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Resolves when native TTS is idle and nothing has happened (TTS job or audio
 * event) for IDLE_HOLD_MS, or when the generation changed.
 */
async function waitIdle(gen) {
    const deadline = Date.now() + MAX_WAIT_MS;
    while (gen === generation && Date.now() < deadline) {
        const quietFor = Date.now() - Math.max(lastTtsEventAt, lastAudioActivityAt);
        if (nativeIdleNow() && quietFor >= IDLE_HOLD_MS) {
            return;
        }
        await sleep(200);
    }
}

/** Hands one text to native TTS (its playback is reset by /speak). */
async function callSpeak(text, voice) {
    const check = checkNativeTts();
    if (!check.ok) {
        toastr.warning(check.reason, 'AI 朗读过滤');
        return false;
    }
    const { SlashCommandParser } = SillyTavern.getContext();
    // Call the callback directly: no slash-command parsing, so '|', '{{' and quotes in the text are safe.
    await SlashCommandParser.commands.speak.callback({ voice }, text);
    return true;
}

/** @param {string} text */
function piecesOf(text) {
    const nativeSplitsLines = SillyTavern.getContext().extensionSettings.tts?.narrate_by_paragraphs === true;
    return speechPieces(text, { nativeSplitsLines });
}

function hintPieces() {
    if (piecesHintShown) return;
    piecesHintShown = true;
    toastr.info('这段文字较长，会分几次交给语音服务，中间可能有短暂停顿。在 TTS 设置里勾选“Narrate by paragraphs”可以更连贯。', 'AI 朗读过滤', { timeOut: 10000 });
}

/**
 * Waits until native TTS has started and then finished the text just handed over.
 * @param {{ started: number, completed: number }} before  job counts taken before handing it over
 * @returns {Promise<boolean>} whether the next piece may follow: not skipped by native, its
 *   speech reported done (else a request may still be in flight, and the next /speak would
 *   play out of order), no stopAll() or newer narration, and playback not stopped by hand
 */
async function waitPiece(before, gen, token) {
    const startDeadline = Date.now() + START_TIMEOUT_MS;
    while (gen === generation && startedJobs === before.started && Date.now() < startDeadline) {
        await sleep(200);
    }
    if (startedJobs === before.started) return false; // native skipped it
    // Counted from the start only: handing the text over resets playback, which pauses audio still playing.
    const since = Date.now();
    await waitIdle(gen);
    if (gen !== generation || token !== speakToken || stoppedAt >= since) return false;
    if (completedJobs === before.completed) {
        console.warn('[AI TTS Filter] the speech service did not finish a piece; the rest is not read');
        toastr.warning('语音服务没有返回这一段，后面的段不再朗读（以免顺序错乱）。可以稍后重新朗读。', 'AI 朗读过滤');
        return false;
    }
    return true;
}

const jobCounts = () => ({ started: startedJobs, completed: completedJobs });

/**
 * Speaks the pieces one after another, each after the previous one has finished.
 * @returns {Promise<boolean>} false when native TTS cannot be used
 */
async function speakPieces(pieces, voice, gen, token) {
    for (const piece of pieces) {
        if (gen !== generation || token !== speakToken) return true;
        const before = jobCounts();
        if (!(await callSpeak(piece, voice))) return false;
        if (!(await waitPiece(before, gen, token))) return true;
    }
    return true;
}

/**
 * Speaks right away. A long text is spoken piece by piece: this resolves once the
 * first piece is handed over (errors of that call reach the caller), the rest
 * follows in the background, and the automatic queue waits for it.
 * @returns {Promise<boolean>} false when native TTS cannot be used
 */
export async function speakNow(text, voice) {
    const token = ++speakToken;
    const pieces = piecesOf(text);
    if (pieces.length <= 1) return callSpeak(pieces[0] ?? text, voice);
    const gen = generation;
    const before = jobCounts();
    // Marked before handing over, so the queue cannot slip in while the first piece is on its way.
    manualToken = token;
    let handed = false;
    try {
        handed = await callSpeak(pieces[0], voice);
    } finally {
        if (!handed && manualToken === token) manualToken = 0;
    }
    if (!handed) return false;
    hintPieces();
    (async () => {
        try {
            if (await waitPiece(before, gen, token)) await speakPieces(pieces.slice(1), voice, gen, token);
        } catch (error) {
            console.error('[AI TTS Filter] narration failed', error);
        } finally {
            if (manualToken === token) manualToken = 0;
        }
    })();
    return true;
}

/**
 * Adds an automatic narration item. Filtering starts at once (so the next
 * message is ready while the current one plays); speaking is one at a time.
 * @param {QueueItem} item
 */
export function enqueue(item) {
    const controller = new AbortController();
    controllers.add(controller);
    const job = item.prepare(controller.signal);
    job.catch(() => { });
    queue.push({ item, controller, job });
    pump();
}

async function pump() {
    if (pumping) {
        return;
    }
    pumping = true;
    try {
        while (queue.length > 0) {
            const gen = generation;
            const { controller, job: pending } = /** @type {(typeof queue)[number]} */ (queue.shift());
            try {
                const job = await pending;
                if (gen !== generation || !job?.text) {
                    continue;
                }
                // A long manual narration keeps the stage until its last piece is done.
                while (manualToken && manualToken === speakToken && gen === generation) {
                    await sleep(200);
                }
                await waitIdle(gen);
                if (gen !== generation) {
                    continue;
                }
                const pieces = piecesOf(job.text);
                if (pieces.length > 1) hintPieces();
                await speakPieces(pieces, job.voice, gen, ++speakToken);
            } catch (error) {
                if (!controller.signal.aborted) {
                    console.error('[AI TTS Filter] narration failed', error);
                }
            } finally {
                controllers.delete(controller);
            }
        }
    } finally {
        pumping = false;
    }
}

/**
 * Creates an AbortController that stopAll() cancels.
 * @returns {{ signal: AbortSignal, release: () => void }}
 */
export function trackedSignal() {
    const controller = new AbortController();
    controllers.add(controller);
    return { signal: controller.signal, release: () => controllers.delete(controller) };
}

/** Drops queued items and cancels model requests in flight. Does not touch native playback. */
export function stopAll() {
    generation++;
    queue.length = 0;
    for (const c of controllers) {
        c.abort(new Error('stopped'));
    }
    controllers.clear();
}

export function queueLength() {
    return queue.length + (pumping ? 1 : 0);
}
