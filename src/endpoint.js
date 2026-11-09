// Custom filter endpoint: key storage and model list.
// The key goes straight from the input box to SillyTavern's secret store
// (/api/secrets/write) and is referred to by id afterwards. It is never kept
// in extension settings, settings.json or browser storage.

import { getSettings, saveSettings } from './settings.js';
import { customSecretId } from './llm.js';

const SECRET_KEY = 'api_key_custom';
const LABEL = 'AI 朗读过滤';

function headers() {
    return SillyTavern.getContext().getRequestHeaders();
}

async function post(url, body) {
    const response = await fetch(url, { method: 'POST', headers: headers(), body: JSON.stringify(body) });
    if (!response.ok) {
        throw new Error(`${url} → HTTP ${response.status}`);
    }
    return response;
}

/** @returns {Promise<{id:string,value:string,label:string,active:boolean}[]>} masked entries */
async function customSecrets() {
    const state = await (await post('/api/secrets/read', {})).json();
    // The server lists every known key (null when empty); on an internal error it sends {}.
    if (!state || typeof state !== 'object' || !(SECRET_KEY in state)) {
        throw new Error('读不到酒馆的密钥状态');
    }
    return Array.isArray(state[SECRET_KEY]) ? state[SECRET_KEY] : [];
}

/** Lets SillyTavern's own UI pick up the change (key indicators, secret lists). */
async function refreshSillyTavernSecrets() {
    try {
        const mod = await import('../../../../secrets.js');
        await mod.readSecretState?.();
    } catch {
        // Not critical: the UI refreshes on next load.
    }
}

let saving = false;

/**
 * Makes sure the filter key is not the active `api_key_custom` (the chat
 * connection uses the active one). Prefers `preferredId`, else any other key.
 * @param {string} ourId
 * @param {string|undefined} preferredId  the chat key that was active before
 * @param {string[]} exclude  other ids that must not become active (e.g. an old filter key)
 * @returns {Promise<string|null>} a warning, or null when the chat key is safe
 */
async function ensureNotActive(ourId, preferredId, exclude = []) {
    let guessed = null;
    for (let attempt = 0; attempt < 2; attempt++) {
        const list = await customSecrets();
        const active = list.find(x => x.active);
        if (!active || active.id !== ourId) {
            return guessed;
        }
        const candidates = list.filter(x => x.id !== ourId && !exclude.includes(x.id));
        const preferred = candidates.find(x => x.id === preferredId);
        const target = preferred ?? candidates[0];
        if (!preferred && candidates.length > 1) {
            guessed = `原来聊天用的是哪把密钥没能确认，已切到“${target.label}”。请到“API 连接”的密钥管理里确认。`;
        }
        if (!target) {
            return '聊天的“自定义接口”还没有自己的密钥，所以这把密钥现在也是聊天连接的当前密钥。以后在“API 连接”里给聊天另存密钥即可分开。';
        }
        try {
            await post('/api/secrets/rotate', { key: SECRET_KEY, id: target.id });
        } catch {
            // retry once below
        }
    }
    const still = (await customSecrets().catch(() => [])).find(x => x.active)?.id === ourId;
    return still ? '没能把聊天用的密钥切回去，聊天现在可能在用这把密钥。请到“API 连接”的密钥管理里检查当前密钥。' : null;
}

/**
 * Saves the filter key. Writing a secret makes it the active one, which would
 * switch the chat connection's custom key too, so the previously active key
 * is re-activated right away and the result is checked.
 * @param {string} value
 * @returns {Promise<{ warnings: string[] }>}
 */
export async function saveFilterKey(value) {
    const key = String(value ?? '').trim();
    if (!key) {
        throw new Error('密钥为空');
    }
    if (saving) {
        throw new Error('正在保存，请稍候');
    }
    saving = true;
    const warnings = [];
    try {
        const s = getSettings();
        const oldId = s.customSecretId;
        const before = await customSecrets().catch(() => []);
        const previouslyActive = before.find(x => x.active && x.id !== oldId)?.id;

        const { id } = await (await post('/api/secrets/write', { key: SECRET_KEY, value: key, label: LABEL })).json();
        if (!id) {
            throw new Error('酒馆没有返回密钥编号');
        }
        // Record the id first, so the key can always be found and removed later.
        s.customSecretId = id;
        saveSettings();

        if (oldId) {
            try {
                await post('/api/secrets/delete', { key: SECRET_KEY, id: oldId });
            } catch {
                warnings.push('旧的过滤密钥没能删除，可以在“API 连接”的密钥管理里手动删除（标签“AI 朗读过滤”）。');
            }
        }
        const activeWarning = await ensureNotActive(id, previouslyActive, oldId ? [oldId] : []).catch(() => '无法确认聊天用的密钥是否被切换，请到“API 连接”的密钥管理里检查。');
        if (activeWarning) {
            warnings.push(activeWarning);
        }
        return { warnings };
    } finally {
        saving = false;
        await refreshSillyTavernSecrets();
    }
}

/** Deletes the filter key. Keeps the id if the deletion fails. */
export async function clearFilterKey() {
    const s = getSettings();
    if (s.customSecretId) {
        // If ours was active, SillyTavern re-activates the first remaining key on its own.
        await post('/api/secrets/delete', { key: SECRET_KEY, id: s.customSecretId });
    }
    s.customSecretId = '';
    saveSettings();
    await refreshSillyTavernSecrets();
}

/** @returns {Promise<{ saved: boolean, masked?: string }>} */
export async function filterKeyStatus() {
    const s = getSettings();
    if (!s.customSecretId) {
        return { saved: false };
    }
    try {
        const entry = (await customSecrets()).find(x => x.id === s.customSecretId);
        // With allowKeysExposure the server returns the plain key: never show that.
        const masked = entry && String(entry.value).includes('*') ? String(entry.value) : '';
        return entry ? { saved: true, masked } : { saved: false };
    } catch {
        return { saved: false };
    }
}

/**
 * Lists models of the custom endpoint (GET {url}/models through SillyTavern).
 * @returns {Promise<string[]>}
 */
export async function listModels() {
    const s = getSettings();
    const url = String(s.customUrl || '').trim();
    if (!url) {
        throw new Error('先填写接口地址');
    }
    const response = await fetch('/api/backends/chat-completions/status', {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({ chat_completion_source: 'custom', custom_url: url, secret_id: customSecretId(s) }),
    });
    const data = await response.json().catch(() => null);
    if (!response.ok || data?.error) {
        throw new Error(data?.message || `HTTP ${response.status}`);
    }
    const list = Array.isArray(data?.data) ? data.data : (Array.isArray(data) ? data : []);
    return list.map(m => String(m?.id ?? m?.name ?? m)).filter(Boolean).sort((a, b) => a.localeCompare(b));
}
