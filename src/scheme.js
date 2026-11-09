// Format schemes: anchor samples + learned rules + format note, bound to
// character cards and/or presets (user can rebind at any time).
// Resolution: card binding > preset binding > global default > none.
// Stored in extension settings (follows the account).

import { getSettings, saveSettings } from './settings.js';
import { labelAnchor, extractRules, rangesFromLabels, checkRule } from './core/anchor.js';
import { ruleKey, sanitizeRule, isGenericTagRule } from './core/scheme-rules.js';
import { applyRules } from './core/rules.js';
import { buildExample } from './core/prompt.js';
import { hashString } from './core/hash.js';

export const ANCHOR_LIMIT_MAX = 10;
export const ANCHOR_MAX_CHARS = 6000;
/** Total characters of worked examples sent with every request (few-shot). */
export const FEW_SHOT_MAX_CHARS = 6000;

/**
 * @typedef {object} Scheme
 * @property {string} id
 * @property {string} name
 * @property {import('./core/anchor.js').Anchor[]} anchors
 * @property {{ rule: import('./core/scheme-rules.js').SchemeRule, enabled: boolean, support?: number, samples?: number }[]} autoRules
 * @property {{ rule: import('./core/scheme-rules.js').SchemeRule, enabled: boolean, invalid?: string }[]} aiRules
 * @property {string} note
 * @property {boolean} fewShot
 * @property {string[]} cards     character avatar file names
 * @property {string[]} presets   "<api>:<preset name>"
 * @property {number} analyzedAt
 */

const ctx = () => SillyTavern.getContext();

function newId() {
    return `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

/** @returns {Scheme[]} */
export function getSchemes() {
    const s = getSettings();
    // Tolerate damaged data: a broken scheme must never break narration.
    if (s.schemes.some(x => !x || typeof x !== 'object' || typeof x.id !== 'string')) {
        s.schemes = s.schemes.filter(x => x && typeof x === 'object' && typeof x.id === 'string');
    }
    for (const scheme of s.schemes) {
        if (typeof scheme.name !== 'string') scheme.name = '未命名';
        if (!Array.isArray(scheme.anchors)) scheme.anchors = [];
        if (scheme.anchors.some(a => !a || typeof a.text !== 'string')) {
            scheme.anchors = scheme.anchors.filter(a => a && typeof a.text === 'string');
        }
        for (const anchor of scheme.anchors) {
            if (!Array.isArray(anchor.skips)) anchor.skips = [];
        }
        for (const key of ['autoRules', 'aiRules', 'cards', 'presets']) {
            if (!Array.isArray(scheme[key])) scheme[key] = [];
        }
        scheme.note ??= '';
        scheme.fewShot ??= false;
    }
    return s.schemes;
}

/** @param {string} id */
export function findScheme(id) {
    return getSchemes().find(x => x.id === id) ?? null;
}

export function anchorLimit() {
    const n = Math.round(Number(getSettings().anchorLimit) || 3);
    return Math.min(ANCHOR_LIMIT_MAX, Math.max(1, n));
}

/** @param {string} name */
export function createScheme(name) {
    /** @type {Scheme} */
    const scheme = { id: newId(), name: String(name || '新方案').slice(0, 40), anchors: [], autoRules: [], aiRules: [], note: '', fewShot: false, cards: [], presets: [], analyzedAt: 0 };
    getSettings().schemes.push(scheme);
    saveSettings();
    return scheme;
}

/** @param {string} id */
export function deleteScheme(id) {
    const s = getSettings();
    s.schemes = s.schemes.filter(x => x.id !== id);
    if (s.defaultSchemeId === id) {
        s.defaultSchemeId = '';
    }
    saveSettings();
}

// ---------------------------------------------------------------- binding keys

/**
 * Character card of a message (or of the current chat when no message).
 * @param {any} [message]
 * @returns {string|null} avatar file name
 */
export function cardKeyOf(message) {
    const c = ctx();
    if (message?.is_user || message?.is_system) {
        return null;
    }
    if (message?.original_avatar) {
        return String(message.original_avatar);
    }
    if (c.characterId !== undefined && c.characters?.[c.characterId]) {
        return String(c.characters[c.characterId].avatar);
    }
    if (message?.name) {
        const found = c.characters?.find(ch => ch.name === message.name);
        if (found) return String(found.avatar);
    }
    return null;
}

/** @param {string} avatar */
export function cardName(avatar) {
    return ctx().characters?.find(ch => ch.avatar === avatar)?.name ?? avatar.replace(/\.png$/i, '');
}

/** Current preset of the main API, e.g. "openai:My preset". */
export function currentPresetKey() {
    const c = ctx();
    try {
        const name = c.getPresetManager?.()?.getSelectedPresetName?.();
        return name ? `${c.mainApi}:${name}` : null;
    } catch {
        return null;
    }
}

/** @param {string} key */
export function presetName(key) {
    const i = key.indexOf(':');
    return i === -1 ? key : key.slice(i + 1);
}

/**
 * Binds a card or preset to a scheme. A card/preset belongs to one scheme at a time.
 * @param {Scheme} scheme
 * @param {'cards'|'presets'} kind
 * @param {string} key
 */
export function bind(scheme, kind, key) {
    for (const other of getSchemes()) {
        other[kind] = other[kind].filter(k => k !== key);
    }
    scheme[kind].push(key);
    saveSettings();
}

/** @param {Scheme} scheme @param {'cards'|'presets'} kind @param {string} key */
export function unbind(scheme, kind, key) {
    scheme[kind] = scheme[kind].filter(k => k !== key);
    saveSettings();
}

/**
 * @param {any} [message]
 * @returns {{ scheme: Scheme, via: 'card'|'preset'|'default' } | null}
 */
export function resolveScheme(message) {
    const schemes = getSchemes();
    if (!schemes.length) {
        return null;
    }
    const card = cardKeyOf(message);
    if (card) {
        const hit = schemes.find(x => x.cards.includes(card));
        if (hit) return { scheme: hit, via: 'card' };
    }
    const preset = currentPresetKey();
    if (preset) {
        const hit = schemes.find(x => x.presets.includes(preset));
        if (hit) return { scheme: hit, via: 'preset' };
    }
    const def = findScheme(getSettings().defaultSchemeId);
    return def ? { scheme: def, via: 'default' } : null;
}

// ---------------------------------------------------------------- rules and samples

/** @param {Scheme} scheme */
export function effectiveRules(scheme) {
    const seen = new Set();
    const out = [];
    for (const r of [...scheme.autoRules, ...scheme.aiRules]) {
        const rule = sanitizeRule(r.rule);
        if (!r.enabled || !rule || isGenericTagRule(rule)) continue;
        const key = ruleKey(rule);
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(rule);
    }
    return out;
}

/**
 * Whether a newly learned rule starts switched on. Broad shapes (a single
 * symbol, a bracket type, key-value lines, a content tag) need evidence from
 * at least two samples; specific ones (a named tag, a "label：" or 【header】
 * prefix) are on from one sample. The user can always switch either way.
 * @param {{ rule: import('./core/scheme-rules.js').SchemeRule, samples?: number }} found
 */
export function defaultEnabled(found) {
    if ((found.samples ?? 0) >= 2) return true;
    const r = found.rule;
    if (r.type === 'tag') return !isGenericTagRule(r);
    if (r.type === 'prefix') {
        // "结算：" or 【记忆总结】; a one-character name such as "他：" could be dialogue.
        const name = Array.from(r.value.replace(/^【|[：:】]$/g, ''));
        return name.length >= 2 && /[：:】]$/.test(r.value);
    }
    return false;
}

/**
 * Re-learns the automatic rules after the samples changed (keeping on/off
 * choices), and re-checks adopted AI rules against the new samples.
 */
export function refreshAutoRules(scheme) {
    const previous = new Map(scheme.autoRules.map(r => [ruleKey(r.rule), r.enabled]));
    const samples = scheme.anchors.map(labelAnchor);
    scheme.autoRules = samples.length
        ? extractRules(samples).map(f => ({ rule: f.rule, support: f.support, samples: f.samples, enabled: previous.get(ruleKey(f.rule)) ?? defaultEnabled(f) }))
        : [];
    for (const r of scheme.aiRules) {
        const rule = sanitizeRule(r.rule);
        const check = rule && samples.length && !isGenericTagRule(rule) ? checkRule(rule, samples) : null;
        if (!rule || !check || !check.ok || check.hits === 0) {
            r.enabled = false;
            r.invalid = rule && isGenericTagRule(rule) ? '通用排版标签，容易误删'
                : (!check ? '没有样例可以检查' : (!check.ok ? `会删掉样例里 ${check.wrong} 处要读的内容` : '在样例里没有命中'));
        } else {
            delete r.invalid;
        }
    }
}

/**
 * Adds or replaces a sample.
 * @param {Scheme} scheme
 * @param {string} text
 * @param {import('./core/segmenter.js').Segment[]} segments
 * @param {Map<number, { skip: boolean, cat?: string }>} labels
 * @param {string} [replaceId]  anchor to replace (when the scheme is full)
 */
export function addAnchor(scheme, text, segments, labels, replaceId) {
    if (Array.from(text).length > ANCHOR_MAX_CHARS) {
        throw new Error(`样例太长（超过 ${ANCHOR_MAX_CHARS} 字），请先在“粘贴原文”里删掉一部分剧情再加入`);
    }
    const anchor = { id: newId(), text, skips: rangesFromLabels(segments, labels), at: Date.now() };
    if (replaceId) {
        const i = scheme.anchors.findIndex(a => a.id === replaceId);
        if (i === -1) throw new Error('要替换的样例不存在');
        scheme.anchors[i] = anchor;
    } else {
        if (scheme.anchors.length >= anchorLimit()) {
            throw new Error(`这个方案的样例已满（${anchorLimit()} 份），请替换一份或在设置里调高上限`);
        }
        scheme.anchors.push(anchor);
    }
    refreshAutoRules(scheme);
    saveSettings();
    return anchor;
}

/** @param {Scheme} scheme @param {string} anchorId @param {Map<number, { skip: boolean, cat?: string }>} labels */
export function updateAnchorLabels(scheme, anchorId, labels) {
    const anchor = scheme.anchors.find(a => a.id === anchorId);
    if (!anchor) return;
    const { segments } = labelAnchor(anchor);
    anchor.skips = rangesFromLabels(segments, labels);
    refreshAutoRules(scheme);
    saveSettings();
}

/** @param {Scheme} scheme @param {string} anchorId */
export function removeAnchor(scheme, anchorId) {
    scheme.anchors = scheme.anchors.filter(a => a.id !== anchorId);
    refreshAutoRules(scheme);
    saveSettings();
}

/**
 * Worked examples for few-shot mode, formatted like real requests.
 * @param {Scheme} scheme
 * @param {import('./core/rules.js').RuleConfig} ruleConfig  includes the scheme rules
 * @param {{ maxSegmentChars?: number, excludeAnchorId?: string }} [opts]
 */
export function buildExamples(scheme, ruleConfig, opts = {}) {
    if (!scheme.fewShot) return [];
    const out = [];
    let total = 0;
    // Newest samples first, until the size budget is used up.
    for (const anchor of [...scheme.anchors].reverse()) {
        if (anchor.id === opts.excludeAnchorId) continue;
        try {
            const sample = labelAnchor(anchor);
            const decided = applyRules(sample.text, sample.segments, ruleConfig);
            const ex = buildExample(sample.text, sample.segments, decided, sample.labels, opts);
            if (!ex) continue;
            const size = ex.user.length + ex.assistant.length;
            if (out.length > 0 && total + size > FEW_SHOT_MAX_CHARS) break;
            total += size;
            out.unshift(ex);
        } catch (error) {
            console.warn('[AI TTS Filter] skipped a broken sample', error);
        }
    }
    return out;
}

/** Changes to anything that affects filtering change this. @param {Scheme|null} scheme */
export function schemeFingerprint(scheme, excludeAnchorId = '') {
    if (!scheme) return '';
    return hashString(JSON.stringify([
        effectiveRules(scheme).map(ruleKey),
        String(scheme.note ?? '').trim(),
        scheme.fewShot ? scheme.anchors.filter(a => a.id !== excludeAnchorId).map(a => [hashString(a.text), a.skips]) : 0,
    ]));
}

/**
 * If the text is exactly one of the scheme's samples, the user's own labels
 * are the answer (unless that sample is being left out for a back-test).
 * @param {Scheme|null} scheme
 * @param {string} text
 * @param {string} [excludeAnchorId]
 */
export function anchorFor(scheme, text, excludeAnchorId) {
    if (!scheme) return null;
    return scheme.anchors.find(a => a.text === text && a.id !== excludeAnchorId) ?? null;
}
