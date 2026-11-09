// Extension settings (stored per account in extension_settings.aiTtsFilter).

import { DEFAULT_SKIP_TAGS, DEFAULT_CONTENT_TAGS, parseTagList, parseRegexList } from './core/rules.js';
import { SEGMENTER_VERSION } from './core/segmenter.js';
import { PROMPT_VERSION, DEFAULT_SYSTEM_PROMPT } from './core/prompt.js';
import { hashString } from './core/hash.js';

export const SETTINGS_KEY = 'aiTtsFilter';

export const DEFAULT_SETTINGS = Object.freeze({
    enabled: true,
    /** 'llm' = rules + model, 'rules' = rules only */
    mode: 'llm',
    /**
     * 'custom'  = an OpenAI-compatible endpoint filled in here (URL, model, key in SillyTavern's secret store)
     * 'profile' = a Connection Manager profile
     * 'main'    = the current chat connection
     */
    source: 'custom',
    customUrl: '',
    customModel: '',
    /** id of the key in SillyTavern's secret store (api_key_custom); never the key itself */
    customSecretId: '',
    profileId: '',
    autoNarrate: false,
    takeOverButton: true,
    prefilter: false,
    contentTagMode: true,
    contentTags: DEFAULT_CONTENT_TAGS.join(', '),
    skipTags: DEFAULT_SKIP_TAGS.join(', '),
    skipCode: true,
    skipComments: true,
    skipImages: true,
    skipTables: true,
    skipDecor: true,
    keepRegex: '',
    skipRegex: '',
    /** empty = built-in default prompt (kept empty so settings.json stays small) */
    prompt: '',
    maxSegmentChars: 200,
    maxTokens: 1024,
    /** number, or '' to not send a temperature */
    temperature: 0,
    timeoutSec: 30,
    /** 'rules' | 'original' | 'none' */
    onFailure: 'rules',
    /** format schemes (anchor samples + learned rules + note), see scheme.js */
    schemes: [],
    /** scheme used when no card/preset binding matches; '' = none */
    defaultSchemeId: '',
    /** max anchor samples per scheme (user adjustable, 1-10) */
    anchorLimit: 3,
    /** max characters of a sample's original text (user adjustable, 1000-200000) */
    anchorMaxChars: 50000,
    cacheMaxEntries: 3000,
    cacheMaxDays: 60,
});

/**
 * Returns the live settings object, filling in missing keys.
 * @returns {typeof DEFAULT_SETTINGS & Record<string, any>}
 */
export function getSettings() {
    const { extensionSettings } = SillyTavern.getContext();
    if (!extensionSettings[SETTINGS_KEY] || typeof extensionSettings[SETTINGS_KEY] !== 'object') {
        extensionSettings[SETTINGS_KEY] = {};
    }
    const s = extensionSettings[SETTINGS_KEY];
    for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
        if (!(key in s)) {
            s[key] = value && typeof value === 'object' ? structuredClone(value) : value;
        }
    }
    if (!Array.isArray(s.schemes)) {
        s.schemes = [];
    }
    return s;
}

export function saveSettings() {
    SillyTavern.getContext().saveSettingsDebounced();
}

/**
 * @param {ReturnType<typeof getSettings>} s
 * @returns {{ rules: import('./core/rules.js').RuleConfig, regexErrors: string[] }}
 */
export function buildRuleConfig(s) {
    const keep = parseRegexList(s.keepRegex);
    const skip = parseRegexList(s.skipRegex);
    return {
        rules: {
            skipTags: parseTagList(s.skipTags),
            contentTagMode: Boolean(s.contentTagMode),
            contentTags: parseTagList(s.contentTags),
            skipCode: Boolean(s.skipCode),
            skipComments: Boolean(s.skipComments),
            skipImages: Boolean(s.skipImages),
            skipTables: Boolean(s.skipTables),
            skipDecor: Boolean(s.skipDecor),
            keepRegex: keep.regexes,
            skipRegex: skip.regexes,
        },
        regexErrors: [...keep.errors, ...skip.errors],
    };
}

/** @param {ReturnType<typeof getSettings>} s */
export function effectivePrompt(s) {
    return String(s.prompt ?? '').trim() ? s.prompt : DEFAULT_SYSTEM_PROMPT;
}

/**
 * Hash of everything that changes the filter result. Part of every cache key.
 * @param {ReturnType<typeof getSettings>} s
 * @param {string} modelId  e.g. profile id + model name
 */
export function configHash(s, modelId) {
    return hashString(JSON.stringify([
        SEGMENTER_VERSION, PROMPT_VERSION, s.mode, s.mode === 'llm' ? modelId : '',
        s.mode === 'llm' ? effectivePrompt(s) : '', s.maxSegmentChars,
        s.contentTagMode, parseTagList(s.contentTags), parseTagList(s.skipTags),
        s.skipCode, s.skipComments, s.skipImages, s.skipTables, s.skipDecor, s.keepRegex, s.skipRegex,
    ]));
}
