// Sends the classification request through SillyTavern's own services.
// Keys live in SillyTavern's secret store; requests refer to them by id, so
// the key itself never passes through this extension when a request is made.

import { getSettings, DEFAULT_SETTINGS } from './settings.js';

/**
 * Secret id sent when no key was saved for the custom endpoint. It matches no
 * stored key, so SillyTavern sends no key instead of falling back to the
 * active chat key (which would leak the chat key to the filter endpoint).
 */
export const NO_SECRET_ID = 'ai-tts-filter-no-key';

/** @param {ReturnType<typeof getSettings>} s */
export function customSecretId(s) {
    return String(s.customSecretId || '') || NO_SECRET_ID;
}

/**
 * @returns {{ ok: boolean, reason?: string, profile?: any }}
 */
export function checkModelSource() {
    const s = getSettings();
    const ctx = SillyTavern.getContext();
    if (s.source === 'main') {
        return { ok: true };
    }
    if (s.source === 'custom') {
        if (!/^https?:\/\/\S+$/i.test(String(s.customUrl || '').trim())) {
            return { ok: false, reason: '还没有填写过滤模型的接口地址' };
        }
        if (!String(s.customModel || '').trim()) {
            return { ok: false, reason: '还没有填写过滤模型的名称' };
        }
        return { ok: true };
    }
    if (ctx.extensionSettings.disabledExtensions?.includes('connection-manager')) {
        return { ok: false, reason: '“连接配置”功能被停用了' };
    }
    if (!s.profileId) {
        return { ok: false, reason: '还没有选择过滤用的连接配置' };
    }
    const profile = ctx.extensionSettings.connectionManager?.profiles?.find(p => p.id === s.profileId);
    if (!profile) {
        return { ok: false, reason: '选择的连接配置已不存在' };
    }
    return { ok: true, profile };
}

/** Identifies the model for the cache key. */
export function modelIdentity() {
    const s = getSettings();
    if (s.source === 'main') {
        const ctx = SillyTavern.getContext();
        return `main:${ctx.mainApi}:${ctx.chatCompletionSettings?.chat_completion_source ?? ''}:${ctx.getChatCompletionModel?.() ?? ''}`;
    }
    if (s.source === 'custom') {
        return `custom:${String(s.customUrl).trim()}:${String(s.customModel).trim()}`;
    }
    const { profile } = checkModelSource();
    return `profile:${s.profileId}:${profile?.api ?? ''}:${profile?.['api-url'] ?? ''}:${profile?.model ?? ''}`;
}

/**
 * @param {AbortSignal|undefined} outer
 * @param {number} timeoutMs
 */
function withTimeout(outer, timeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error(`模型 ${Math.round(timeoutMs / 1000)} 秒内没有回答`)), timeoutMs);
    const onAbort = () => controller.abort(outer?.reason);
    outer?.addEventListener('abort', onAbort, { once: true });
    if (outer?.aborted) {
        onAbort();
    }
    return {
        signal: controller.signal,
        done: () => {
            clearTimeout(timer);
            outer?.removeEventListener('abort', onAbort);
        },
    };
}

/**
 * @param {{role:string, content:string}[]} messages
 * @param {AbortSignal} [signal]
 * @returns {Promise<unknown>} the raw answer ({content, reasoning} or a string)
 */
export async function classify(messages, signal) {
    const s = getSettings();
    const ctx = SillyTavern.getContext();
    const check = checkModelSource();
    if (!check.ok) {
        throw new Error(check.reason);
    }
    const timeoutMs = Math.max(5, Number(s.timeoutSec) || DEFAULT_SETTINGS.timeoutSec) * 1000;
    const maxTokens = Math.max(16, Number(s.maxTokens) || DEFAULT_SETTINGS.maxTokens);
    const t = withTimeout(signal, timeoutMs);
    try {
        if (s.source === 'main') {
            // generateRaw cannot be aborted; the timeout only stops waiting for it.
            const abortPromise = new Promise((_, reject) => {
                t.signal.addEventListener('abort', () => reject(t.signal.reason ?? new Error('aborted')), { once: true });
            });
            return await Promise.race([
                ctx.generateRaw({ prompt: messages, responseLength: maxTokens, trimNames: false }),
                abortPromise,
            ]);
        }
        const override = {};
        if (s.temperature !== '' && s.temperature !== null && Number.isFinite(Number(s.temperature))) {
            override.temperature = Number(s.temperature);
        }
        if (s.source === 'custom') {
            return await ctx.ChatCompletionService.processRequest({
                stream: false,
                messages,
                max_tokens: maxTokens,
                model: String(s.customModel).trim(),
                chat_completion_source: 'custom',
                custom_url: String(s.customUrl).trim(),
                secret_id: customSecretId(s),
                ...override,
            }, {}, true, t.signal);
        }
        return await ctx.ConnectionManagerRequestService.sendRequest(
            s.profileId,
            messages,
            maxTokens,
            { stream: false, signal: t.signal, extractData: true, includePreset: false, includeInstruct: true },
            override,
        );
    } catch (error) {
        if (t.signal.aborted && !signal?.aborted) {
            throw t.signal.reason instanceof Error ? t.signal.reason : new Error('模型请求超时');
        }
        throw error;
    } finally {
        t.done();
    }
}
