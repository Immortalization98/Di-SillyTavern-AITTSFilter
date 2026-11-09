// Hands filtered text to SillyTavern's built-in TTS through the registered
// /speak command, and queues automatic narration so messages don't cut each
// other off (/speak resets native playback every time it is called).

const DEFAULT_VOICE = '[Default Voice]';
const IDLE_HOLD_MS = 1500;      // longer than native's 1 s polling, so gaps between paragraphs don't count
const START_TIMEOUT_MS = 10_000; // nothing started -> native skipped the text
const STALE_EVENT_MS = 20_000;   // a TTS job that never reported completion
const MAX_WAIT_MS = 10 * 60_000;

let inflightJobs = 0;
let startedJobs = 0;
let lastTtsEventAt = 0;
let lastAudioActivityAt = 0;
let generation = 0;
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
        inflightJobs++;
        startedJobs++;
        lastTtsEventAt = Date.now();
    });
    eventSource.on(eventTypes.TTS_JOB_COMPLETE, () => {
        inflightJobs = Math.max(0, inflightJobs - 1);
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

/** Speaks right away (native playback is reset by /speak). */
export async function speakNow(text, voice) {
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

/** Speaks and waits until native TTS has finished with it. */
async function speakAndWait(text, voice, gen) {
    const before = startedJobs;
    if (!(await speakNow(text, voice))) {
        return;
    }
    const startDeadline = Date.now() + START_TIMEOUT_MS;
    while (gen === generation && startedJobs === before && Date.now() < startDeadline) {
        await sleep(200);
    }
    if (startedJobs === before) {
        return;
    }
    await waitIdle(gen);
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
                await waitIdle(gen);
                if (gen !== generation) {
                    continue;
                }
                await speakAndWait(job.text, job.voice, gen);
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
