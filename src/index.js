// AI TTS Filter — entry point.
// Filters thinking / calculation / status blocks out of a message with a
// configurable model, then reads the rest with SillyTavern's built-in TTS.
// The chat and the rendered messages are only ever read, never changed.

import { getSettings, saveSettings, buildRuleConfig, effectivePrompt, SETTINGS_KEY } from './settings.js';
import { DEFAULT_SYSTEM_PROMPT } from './core/prompt.js';
import { hashString } from './core/hash.js';
import { filterText, getMessageSource, saveManualResult } from './filter.js';
import { initSchemePanel, renderSchemePanel, chooseSchemeAndAdd, outputFromLabels } from './scheme-ui.js';
import { checkModelSource } from './llm.js';
import { cacheCount, cacheClear, cacheDropDatabase } from './cache.js';
import { initSpeaker, checkNativeTts, voiceFor, unlockAudio, speakNow, enqueue, stopAll, trackedSignal, isNativeBusy, queueLength } from './speaker.js';
import { openPreview, fillPreview, escapeHtml } from './preview.js';
import { openFeedback } from './feedback.js';
import { openFeedback } from './feedback.js';
import { settingsHtml } from './ui.js';
import { saveFilterKey, clearFilterKey, filterKeyStatus, listModels } from './endpoint.js';

const LOG = '[AI TTS Filter]';
const TITLE = 'AI 朗读过滤';

/** @type {{ chatId: string, mesId: number, swipeId: number, text: string } | null} */
let continueBase = null;
/** @type {Set<string>} */
const autoSeen = new Set();
let lastNativeWarnAt = 0;
/** Manual narrations still filtering (not yet handed to native TTS). */
let manualPending = 0;

const ctx = () => SillyTavern.getContext();

// ---------------------------------------------------------------- actions

/** Index of the last message that native TTS would consider. */
function lastReadableId() {
    const chat = ctx().chat ?? [];
    for (let i = chat.length - 1; i >= 0; i--) {
        if (!chat[i].is_system) {
            return i;
        }
    }
    return -1;
}

/**
 * @param {unknown} value  slash-command argument or attribute
 * @returns {number}
 */
function resolveMessageId(value) {
    const str = String(value ?? '').trim();
    if (str === '') {
        return lastReadableId();
    }
    const n = Number(str);
    const len = ctx().chat?.length ?? 0;
    if (!Number.isInteger(n)) {
        return -1;
    }
    return n < 0 ? len + n : n;
}

/**
 * Manual narration: interrupts automatic narration and reads one message.
 * Call unlockAudio() synchronously in the click handler before this.
 * @param {number} mesId
 * @param {Element} [button]
 */
async function narrateMessage(mesId, button) {
    const src = getMessageSource(mesId);
    if (!src) {
        toastr.warning('找不到这条消息', TITLE);
        return;
    }
    const native = checkNativeTts();
    if (!native.ok) {
        toastr.warning(native.reason, TITLE);
        return;
    }
    stopAll();
    const tracked = trackedSignal();
    button?.classList.add('aitts-busy');
    manualPending++;
    let counted = true;
    const settle = () => {
        if (counted) {
            counted = false;
            manualPending = Math.max(0, manualPending - 1);
        }
        tracked.release();
    };
    try {
        const outcome = await filterText(src.text, { signal: tracked.signal, message: src.message });
        if (tracked.signal.aborted) {
            return;
        }
        if (!outcome.output) {
            toastr.info('过滤后没有需要朗读的内容', TITLE);
            return;
        }
        settle();
        await speakNow(outcome.output, voiceFor(src.message));
    } catch (error) {
        if (!tracked.signal.aborted) {
            console.error(LOG, error);
            toastr.error(`朗读失败：${error instanceof Error ? error.message : error}`, TITLE);
        }
    } finally {
        settle();
        button?.classList.remove('aitts-busy');
    }
}

/** @param {number} mesId */
async function previewMessage(mesId) {
    const src = getMessageSource(mesId);
    if (!src) {
        toastr.warning('找不到这条消息', TITLE);
        return;
    }
    await openPreview({
        title: `朗读预览 · #${mesId}${src.message.name ? ` · ${src.message.name}` : ''}`,
        load: (force) => filterText(src.text, { force, message: src.message }),
        unlock: unlockAudio,
        speak: (output) => {
            unlockAudio();
            if (!output) {
                toastr.info('过滤后没有需要朗读的内容', TITLE);
                return;
            }
            stopAll();
            speakNow(output, voiceFor(src.message)).catch((error) => {
                toastr.error(`朗读失败：${error instanceof Error ? error.message : error}`, TITLE);
            });
        },
        saveCorrection: async (labels, outcome) => {
            await saveManualResult(src.text, { message: src.message }, labels);
            return outputFromLabels(src.text, outcome.segments, labels);
        },
        addToScheme: (labels, outcome) => chooseSchemeAndAdd(src.text, outcome.segments, labels, src.message),
        feedback: host => openFeedback({ ...host, text: src.text, message: src.message, unlock: unlockAudio }),
    });
}

// ---------------------------------------------------------------- automatic narration

/**
 * @param {number} mesId
 * @param {string} type  render type from SillyTavern ('normal', 'swipe', 'continue', 'first_message', 'user', ...)
 */
function scheduleAuto(mesId, type) {
    const c = ctx();
    const id = Number(mesId);
    const src = getMessageSource(id);
    if (!src) {
        return;
    }
    const message = src.message;
    const trimmed = src.text.trim();
    if (message.is_system || !trimmed || trimmed === '...') {
        return;
    }
    // Greetings: only while the chat has no user message yet (native does the same on a new chat).
    if (type === 'first_message' && c.chat.some(m => m.is_user)) {
        return;
    }
    const native = checkNativeTts();
    if (!native.ok) {
        if (Date.now() - lastNativeWarnAt > 60_000) {
            lastNativeWarnAt = Date.now();
            toastr.warning(`自动朗读暂停：${native.reason}`, TITLE);
        }
        return;
    }

    const chatId = String(c.getCurrentChatId() ?? '');
    let fromIndex = 0;
    if (type === 'continue' && continueBase && continueBase.chatId === chatId && continueBase.mesId === id
        && continueBase.swipeId === (message.swipe_id ?? 0) && src.text.startsWith(continueBase.text)) {
        fromIndex = continueBase.text.length;
    }
    continueBase = null;

    const key = `${chatId}|${id}|${message.swipe_id ?? 0}|${hashString(src.text)}`;
    if (autoSeen.has(key)) {
        return;
    }
    autoSeen.add(key);
    if (autoSeen.size > 500) {
        autoSeen.delete(autoSeen.values().next().value);
    }

    const text = src.text;
    const voice = voiceFor(message);
    enqueue({
        label: `#${id}`,
        prepare: async (signal) => {
            if (String(ctx().getCurrentChatId() ?? '') !== chatId) {
                return null;
            }
            const outcome = await filterText(text, { signal, fromIndex, message });
            return outcome.output ? { text: outcome.output, voice } : null;
        },
    });
}

/** Filters a new message in the background so a later click hits the cache. */
function prefilter(mesId) {
    const src = getMessageSource(Number(mesId));
    if (!src || src.message.is_system || !src.text.trim()) {
        return;
    }
    const tracked = trackedSignal();
    filterText(src.text, { signal: tracked.signal, quiet: true, message: src.message })
        .catch(() => { })
        .finally(() => tracked.release());
}

function onCharacterRendered(mesId, type) {
    const s = getSettings();
    if (!s.enabled || type === 'impersonate') {
        return;
    }
    if (s.autoNarrate) {
        scheduleAuto(mesId, type);
    } else if (s.prefilter && s.mode === 'llm') {
        prefilter(mesId);
    }
}

function onUserRendered(mesId) {
    const s = getSettings();
    if (s.enabled && s.autoNarrate && ctx().extensionSettings.tts?.narrate_user) {
        scheduleAuto(mesId, 'user');
    }
}

function onGenerationStarted(type, _params, dryRun) {
    if (dryRun || type !== 'continue') {
        return;
    }
    const c = ctx();
    const id = (c.chat?.length ?? 0) - 1;
    const src = getMessageSource(id);
    continueBase = src ? {
        chatId: String(c.getCurrentChatId() ?? ''),
        mesId: id,
        swipeId: src.message.swipe_id ?? 0,
        text: src.text,
    } : null;
}

// ---------------------------------------------------------------- page integration

/**
 * @param {Element} el an element inside a message
 * @returns {number|null}
 */
function messageIdOf(el) {
    const attr = el.closest('.mes')?.getAttribute('mesid');
    if (attr === null || attr === undefined || attr.trim() === '') {
        return null;
    }
    const id = Number(attr);
    return Number.isInteger(id) && id >= 0 ? id : null;
}

/** Capture-phase clicks: runs before SillyTavern's own handlers. */
function onDocumentClick(event) {
    const target = event.target instanceof Element ? event.target : null;
    if (!target) {
        return;
    }
    const s = getSettings();
    if (!s.enabled) {
        return;
    }

    const narrate = target.closest('.mes_narrate');
    if (narrate && s.takeOverButton) {
        const mesId = messageIdOf(narrate);
        if (mesId === null) {
            return;
        }
        event.stopImmediatePropagation();
        event.preventDefault();
        unlockAudio();
        narrateMessage(mesId, narrate);
        return;
    }

    const preview = target.closest('.aitts_preview');
    if (preview) {
        const mesId = messageIdOf(preview);
        if (mesId !== null) {
            event.stopPropagation();
            previewMessage(mesId);
        }
        return;
    }

    // Native "TTS Playback" wand item: when it is about to stop playback, also
    // drop our queue; when it would read the last message, read it filtered.
    const playback = target.closest('#ttsExtensionMenuItem');
    if (playback && s.takeOverButton) {
        if (isNativeBusy()) {
            stopAll();
            return; // let native stop the audio
        }
        if (queueLength() > 0 || manualPending > 0) {
            // Still filtering: native is idle and would read the last message unfiltered.
            event.stopImmediatePropagation();
            stopAll();
            setTimeout(() => document.documentElement.click(), 0);
            return;
        }
        const id = lastReadableId();
        if (id >= 0) {
            event.stopImmediatePropagation();
            unlockAudio();
            narrateMessage(id);
            // The wand menu closes on a click that bubbles to <html>; we stopped this one.
            setTimeout(() => document.documentElement.click(), 0);
        }
    }
}

const PREVIEW_BUTTON = '<div title="朗读预览（AI 过滤）" class="mes_button aitts_preview fa-solid fa-filter" tabindex="0" role="button"></div>';

function installMessageButtons() {
    const template = document.querySelector('#message_template .extraMesButtons');
    if (!template) {
        console.warn(LOG, '#message_template not found; preview button disabled');
        return;
    }
    const addTo = (container) => {
        if (container.querySelector('.aitts_preview')) {
            return;
        }
        const anchor = container.querySelector('.mes_narrate');
        const wrapper = document.createElement('div');
        wrapper.innerHTML = PREVIEW_BUTTON;
        const button = /** @type {Element} */ (wrapper.firstElementChild);
        if (anchor) {
            anchor.after(button);
        } else {
            container.prepend(button);
        }
    };
    addTo(template);
    document.querySelectorAll('#chat .mes .extraMesButtons').forEach(addTo);
}

function installWandMenu() {
    const menu = document.getElementById('extensionsMenu');
    if (!menu || document.getElementById('aitts_wand_container')) {
        return;
    }
    const container = document.createElement('div');
    container.id = 'aitts_wand_container';
    container.className = 'extension_container';
    container.innerHTML = `
        <div id="aitts_wand_narrate" class="list-group-item flex-container flexGap5" title="用 AI 过滤后朗读最新一条消息">
            <div class="fa-solid fa-filter extensionsMenuExtensionButton"></div>
            <span>AI 朗读最新消息</span>
        </div>`;
    menu.append(container);
    container.querySelector('#aitts_wand_narrate')?.addEventListener('click', () => {
        if (!getSettings().enabled) {
            toastr.info('AI 朗读过滤已关闭', TITLE);
            return;
        }
        unlockAudio();
        const id = lastReadableId();
        if (id >= 0) {
            narrateMessage(id);
        }
    });
}

function registerSlashCommands() {
    const { SlashCommandParser, SlashCommand, SlashCommandArgument, ARGUMENT_TYPE } = ctx();
    if (!SlashCommandParser?.addCommandObject) {
        return;
    }
    const mesArg = () => SlashCommandArgument.fromProps({
        description: '楼层号（默认最后一条；负数表示倒数）',
        typeList: [ARGUMENT_TYPE.NUMBER],
        isRequired: false,
    });
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'aitts',
        callback: async (_args, value) => {
            const id = resolveMessageId(value);
            unlockAudio();
            await narrateMessage(id);
            return '';
        },
        unnamedArgumentList: [mesArg()],
        helpString: 'AI 朗读过滤：过滤后用原生朗读读出一条消息。例：<code>/aitts</code>、<code>/aitts 12</code>',
    }));
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'aitts-preview',
        callback: async (_args, value) => {
            previewMessage(resolveMessageId(value));
            return '';
        },
        unnamedArgumentList: [mesArg()],
        helpString: 'AI 朗读过滤：打开一条消息的朗读预览。',
    }));
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'aitts-filter',
        callback: async (_args, value) => {
            const outcome = await filterText(String(value ?? ''));
            return outcome.output;
        },
        returns: '过滤后的文本',
        unnamedArgumentList: [SlashCommandArgument.fromProps({ description: '要过滤的文本', typeList: [ARGUMENT_TYPE.STRING], isRequired: true })],
        helpString: 'AI 朗读过滤：返回过滤后的文本，不朗读。',
    }));
}

// ---------------------------------------------------------------- settings panel

function nativeAdvice() {
    const tts = ctx().extensionSettings.tts ?? {};
    const s = getSettings();
    const notes = [];
    const native = checkNativeTts();
    if (!native.ok) {
        notes.push({ level: 'warn', text: native.reason });
    }
    if (s.mode === 'llm') {
        const model = checkModelSource();
        if (!model.ok) {
            notes.push({ level: 'warn', text: `${model.reason}。在选好之前只按规则过滤（模型出错时的处理方式生效）。` });
        }
    }
    const { regexErrors } = buildRuleConfig(s);
    for (const e of regexErrors) {
        notes.push({ level: 'warn', text: `正则无效：${e}` });
    }
    if (s.autoNarrate && tts.auto_generation) {
        notes.push({ level: 'warn', text: '原生“自动生成”也开着，新消息会被读两遍。' });
    }
    if (tts.narrate_quoted_only || tts.narrate_dialogues_only) {
        notes.push({ level: 'info', text: '原生开着“只读引号”或“只读对白”：过滤后仍然只读引号里的台词，旁白和描写不会读。想读旁白就关掉这两项。' });
    }
    if (tts.narrate_translated_only) {
        notes.push({ level: 'info', text: '原生开着“只读译文”：有译文的消息会过滤并朗读译文。' });
    }
    return notes;
}

async function refreshStatus() {
    const box = document.getElementById('aitts_status');
    if (box) {
        const notes = nativeAdvice();
        box.innerHTML = notes.length
            ? notes.map(n => `<div class="aitts-note aitts-note-${n.level}">${escapeHtml(n.text)}</div>`).join('')
            : '<div class="aitts-note aitts-note-ok">设置正常。</div>';
    }
    const count = document.getElementById('aitts_cache_count');
    if (count) {
        count.textContent = String(await cacheCount());
    }
    document.body.classList.toggle('aitts-enabled', Boolean(getSettings().enabled));
    const source = getSettings().source;
    const profileRow = document.getElementById('aitts_profile_row');
    if (profileRow) {
        profileRow.style.display = source === 'profile' ? '' : 'none';
    }
    const customRows = document.getElementById('aitts_custom_rows');
    if (customRows) {
        customRows.style.display = source === 'custom' ? '' : 'none';
    }
    const keyState = document.getElementById('aitts_key_state');
    if (keyState && source === 'custom') {
        const st = await filterKeyStatus();
        keyState.textContent = st.saved ? `（已保存：${st.masked ?? ''}）` : '（未保存；不需要密钥的接口可以不填）';
    }
}

async function onAutoNarrateEnabled() {
    const tts = ctx().extensionSettings.tts;
    if (!tts?.auto_generation) {
        return;
    }
    const c = ctx();
    const result = await c.callGenericPopup(
        '原生朗读的“自动生成”也开着，新消息会被读两遍。要关闭原生的自动生成吗？（只改这一项，之后可以在 TTS 设置里改回来）',
        c.POPUP_TYPE.CONFIRM, '', { okButton: '关闭原生自动生成', cancelButton: '保持不变' });
    if (result === c.POPUP_RESULT.AFFIRMATIVE) {
        tts.auto_generation = false;
        $('#tts_auto_generation').prop('checked', false);
        saveSettings();
    }
}

/** @param {HTMLSelectElement} select */
function renderProfileOptions(select) {
    const c = ctx();
    const s = getSettings();
    const service = c.ConnectionManagerRequestService;
    const disabled = c.extensionSettings.disabledExtensions?.includes('connection-manager');
    const profiles = disabled ? [] : (c.extensionSettings.connectionManager?.profiles ?? [])
        .filter(p => { try { return service.isProfileSupported(p); } catch { return false; } })
        .sort((a, b) => String(a.name).localeCompare(String(b.name)));
    select.innerHTML = '';
    const empty = document.createElement('option');
    empty.value = '';
    empty.textContent = disabled ? '（“连接配置”功能已停用）' : (profiles.length ? '请选择' : '（还没有连接配置，请先在“API 连接”里新建）');
    select.append(empty);
    for (const p of profiles) {
        const option = document.createElement('option');
        option.value = p.id;
        option.textContent = p.model ? `${p.name}（${p.model}）` : p.name;
        select.append(option);
    }
    select.value = profiles.some(p => p.id === s.profileId) ? s.profileId : '';
}

function readInput(el) {
    if (el.type === 'checkbox') {
        return el.checked;
    }
    if (el.type === 'number') {
        if (el.value === '' && el.dataset.allowEmpty) {
            return '';
        }
        const n = Number(el.value);
        return Number.isFinite(n) ? n : null;
    }
    return el.value;
}

function writeInput(el, value) {
    if (el.type === 'checkbox') {
        el.checked = Boolean(value);
    } else {
        el.value = value ?? '';
    }
}

async function buildSettingsPanel() {
    const host = document.getElementById('extensions_settings2') ?? document.getElementById('extensions_settings');
    if (!host) {
        return;
    }
    const wrapper = document.createElement('div');
    wrapper.innerHTML = settingsHtml();
    const root = /** @type {HTMLElement} */ (wrapper.firstElementChild);
    host.append(root);
    const s = getSettings();

    root.querySelectorAll('[data-aitts]').forEach((node) => {
        const el = /** @type {HTMLInputElement} */ (node);
        const key = el.dataset.aitts;
        writeInput(el, key === 'prompt' ? effectivePrompt(s) : s[key]);
        el.addEventListener(el.tagName === 'TEXTAREA' || el.type === 'text' ? 'input' : 'change', () => {
            let value = readInput(el);
            if (value === null) {
                return;
            }
            if (key === 'prompt' && String(value).trim() === DEFAULT_SYSTEM_PROMPT.trim()) {
                value = '';
            }
            const wasAuto = s.autoNarrate;
            s[key] = value;
            saveSettings();
            if (key === 'autoNarrate' && value && !wasAuto) {
                onAutoNarrateEnabled().then(refreshStatus);
            }
            if (key === 'enabled' && !value) {
                stopAll();
            }
            refreshStatus();
        });
    });

    // Own dropdown instead of ConnectionManagerRequestService.handleDropdown():
    // in 1.19.0 that helper never shows profiles created after it ran when the
    // list was empty at start-up (its option groups are not attached).
    const profileSelect = /** @type {HTMLSelectElement} */ (root.querySelector('#aitts_profile'));
    renderProfileOptions(profileSelect);
    profileSelect.addEventListener('change', () => {
        s.profileId = profileSelect.value;
        saveSettings();
        refreshStatus();
    });
    const { eventSource, eventTypes } = ctx();
    for (const type of [eventTypes.CONNECTION_PROFILE_CREATED, eventTypes.CONNECTION_PROFILE_UPDATED, eventTypes.CONNECTION_PROFILE_DELETED]) {
        if (type) {
            eventSource.on(type, () => {
                renderProfileOptions(profileSelect);
                refreshStatus();
            });
        }
    }

    root.querySelector('#aitts_key_save')?.addEventListener('click', async () => {
        const input = /** @type {HTMLInputElement} */ (root.querySelector('#aitts_key_input'));
        try {
            const { warnings } = await saveFilterKey(input.value);
            toastr.success('密钥已保存到酒馆的密钥库', TITLE);
            for (const w of warnings) {
                toastr.warning(w, TITLE, { timeOut: 15000 });
            }
        } catch (error) {
            toastr.error(`保存失败：${error instanceof Error ? error.message : error}`, TITLE);
        } finally {
            input.value = '';
            refreshStatus();
        }
    });
    root.querySelector('#aitts_key_clear')?.addEventListener('click', async () => {
        const c = ctx();
        const ok = await c.callGenericPopup('从酒馆的密钥库里删除过滤模型的密钥？', c.POPUP_TYPE.CONFIRM);
        if (ok === c.POPUP_RESULT.AFFIRMATIVE) {
            try {
                await clearFilterKey();
                toastr.success('已删除', TITLE);
            } catch (error) {
                toastr.error(`删除失败：${error instanceof Error ? error.message : error}`, TITLE);
            }
            refreshStatus();
        }
    });
    root.querySelector('#aitts_models_fetch')?.addEventListener('click', async () => {
        const list = /** @type {HTMLDataListElement} */ (root.querySelector('#aitts_model_list'));
        try {
            const models = await listModels();
            list.innerHTML = '';
            for (const m of models) {
                const option = document.createElement('option');
                option.value = m;
                list.append(option);
            }
            toastr.info(models.length ? `找到 ${models.length} 个模型，在“模型名称”里输入或选择` : '接口没有返回模型列表，请手动填写', TITLE);
        } catch (error) {
            toastr.error(`获取失败：${error instanceof Error ? error.message : error}`, TITLE);
        }
    });

    root.querySelector('#aitts_prompt_reset')?.addEventListener('click', () => {
        s.prompt = '';
        const area = /** @type {HTMLTextAreaElement} */ (root.querySelector('[data-aitts="prompt"]'));
        area.value = DEFAULT_SYSTEM_PROMPT;
        saveSettings();
    });

    root.querySelector('#aitts_cache_clear')?.addEventListener('click', async () => {
        const c = ctx();
        const ok = await c.callGenericPopup('清空本设备上的全部过滤缓存？之后的消息会重新过滤。', c.POPUP_TYPE.CONFIRM);
        if (ok === c.POPUP_RESULT.AFFIRMATIVE) {
            await cacheClear();
            toastr.success('缓存已清空', TITLE);
            refreshStatus();
        }
    });

    root.querySelector('#aitts_try_run')?.addEventListener('click', async () => {
        const input = /** @type {HTMLTextAreaElement} */ (root.querySelector('#aitts_try_input'));
        const out = /** @type {HTMLElement} */ (root.querySelector('#aitts_try_out'));
        if (!input.value.trim()) {
            out.textContent = '先粘贴一段消息原文。';
            return;
        }
        out.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> 正在过滤…';
        try {
            fillPreview(out, await filterText(input.value, { force: true }));
            refreshStatus();
        } catch (error) {
            out.textContent = `过滤失败：${error instanceof Error ? error.message : error}`;
        }
    });

    root.querySelector('.inline-drawer-toggle')?.addEventListener('click', () => {
        refreshStatus();
        renderSchemePanel();
    });
    initSchemePanel();
    await refreshStatus();
}

// ---------------------------------------------------------------- lifecycle

/** Manifest "clean" hook: removes this extension's cache and settings. */
export async function onClean() {
    await clearFilterKey().catch(error => console.warn(LOG, 'could not delete the filter key', error));
    await cacheDropDatabase();
    delete ctx().extensionSettings[SETTINGS_KEY];
    saveSettings();
}

async function init() {
    if (globalThis.__aiTtsFilterLoaded) {
        return;
    }
    globalThis.__aiTtsFilterLoaded = true;
    const c = ctx();
    getSettings();
    initSpeaker();
    await buildSettingsPanel();
    installMessageButtons();
    installWandMenu();
    registerSlashCommands();
    document.addEventListener('click', onDocumentClick, true);

    const { eventSource, eventTypes } = c;
    eventSource.on(eventTypes.CHARACTER_MESSAGE_RENDERED, onCharacterRendered);
    eventSource.on(eventTypes.USER_MESSAGE_RENDERED, onUserRendered);
    eventSource.on(eventTypes.GENERATION_STARTED, onGenerationStarted);
    for (const type of [eventTypes.CHAT_CHANGED, eventTypes.MESSAGE_SWIPED, eventTypes.MESSAGE_DELETED, eventTypes.GROUP_UPDATED]) {
        eventSource.on(type, () => {
            stopAll();
            continueBase = null;
        });
    }
    eventSource.on(eventTypes.CHAT_CHANGED, () => installMessageButtons());
    console.info(LOG, 'loaded');
}

jQuery(() => {
    init().catch(error => console.error(LOG, 'init failed', error));
});
