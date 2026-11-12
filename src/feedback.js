// "意见修正" in the preview: the user says what is wrong, the filter model
// proposes changed verdicts, rules and a note line, the plugin checks them
// against the scheme's samples, and only what the user confirms is saved.
// All user/model text is escaped.

import { getSettings, saveSettings } from './settings.js';
import {
    getSchemes, findScheme, createScheme, deleteScheme, anchorLimit, anchorMaxChars, cardKeyOf, cardName, bind, FEW_SHOT_MAX_CHARS,
    effectiveRules, addAnchor, updateAnchorLabels, refreshAutoRules,
} from './scheme.js';
import { labelAnchor } from './core/anchor.js';
import { ruleKey, sanitizeRule, describeRule } from './core/scheme-rules.js';
import { NOTE_MAX_CHARS } from './core/analysis.js';
import {
    buildFeedbackMessages, parseFeedback, applyChanges, checkFeedbackRules, mergeNote, skippedCount, OPINION_MAX_CHARS,
} from './core/feedback.js';
import { classify } from './llm.js';
import { saveManualResult } from './filter.js';
import { escapeHtml, labelsFromOutcome, mountLabelEditor } from './preview.js';
import { renderSchemePanel, pickAnchorToReplace, outputFromLabels } from './scheme-ui.js';

const NEW_SCHEME = '__new';
const errText = (e) => (e instanceof Error ? e.message : String(e));

/**
 * @typedef {{ skip: boolean, cat: string }} Label
 * @typedef {object} FeedbackHost
 * @property {HTMLElement} body          where the feedback view is drawn
 * @property {import('./filter.js').FilterOutcome} outcome
 * @property {string} text               the message source
 * @property {any} message
 * @property {(output: string) => void} done   called after saving, with the text to read
 * @property {() => void} cancel
 * @property {() => void} [unlock]       unlocks audio inside the confirming tap (iOS)
 */

const MODE_KEY = 'aitts_feedback_mode_v1';

/** The kind of feedback chosen last on this device ('solid' or 'sample'). */
function readMode() {
    try {
        return localStorage.getItem(MODE_KEY) ?? 'solid';
    } catch {
        return 'solid';
    }
}

/** @param {string} mode */
function writeMode(mode) {
    try {
        localStorage.setItem(MODE_KEY, mode);
    } catch {
        // storage blocked: the choice is simply not remembered
    }
}

/**
 * Shows the opinion box; the rest of the flow follows from there.
 * @param {FeedbackHost} host
 */
export function openFeedback(host) {
    const { body, outcome } = host;
    const start = labelsFromOutcome(outcome);
    /** @type {Map<number, Label>} */
    const labels = new Map([...start].map(([id, l]) => [id, { ...l }]));
    let opinion = '';
    let busy = false;
    let solidify = readMode() !== 'sample';

    const edited = () => new Set([...labels].filter(([id, l]) => start.get(id)?.skip !== l.skip).map(([id]) => id));

    const drawInput = () => {
        body.innerHTML = `
<div class="aitts-feedback">
  <label>哪里不对？用一两句话告诉 AI，例如“【好感度】这种行不要读”“『』里的心声要读”。</label>
  <textarea class="text_pole aitts-fb-opinion" rows="3" maxlength="${OPINION_MAX_CHARS}" placeholder="写下你的意见"></textarea>
  <small class="aitts-hint">也可以先在下面点几段，直接改成读或不读，AI 会参考你改过的地方。意见和这条消息会发给过滤模型的服务商。</small>
  <div class="aitts-fb-mode">
    <label class="checkbox_label"><input type="radio" name="aitts-fb-mode" value="solid"${solidify ? ' checked' : ''}> <span><b>固化</b>：改这条消息，并总结成格式方案的规则和说明，以后同类消息直接按规则判定</span></label>
    <label class="checkbox_label"><input type="radio" name="aitts-fb-mode" value="sample"${solidify ? '' : ' checked'}> <span><b>补充样例</b>：只改这条消息，改好后存为格式方案的样例（锚点），以后过滤时给模型参考，不新增规则</span></label>
  </div>
  <div class="aitts-actions">
    <div class="menu_button" data-fb="ask"><i class="fa-solid fa-wand-magic-sparkles"></i> 让 AI 修正</div>
    <div class="menu_button" data-fb="cancel"><i class="fa-solid fa-xmark"></i> 取消</div>
  </div>
  <div class="aitts-fb-editor"></div>
</div>`;
        const box = /** @type {HTMLTextAreaElement} */ (body.querySelector('.aitts-fb-opinion'));
        box.value = opinion;
        box.addEventListener('input', () => { opinion = box.value; });
        body.querySelector('.aitts-fb-mode')?.addEventListener('change', (event) => {
            const t = event.target;
            if (t instanceof HTMLInputElement && t.checked) {
                solidify = t.value !== 'sample';
                writeMode(t.value);
            }
        });
        mountLabelEditor(/** @type {HTMLElement} */ (body.querySelector('.aitts-fb-editor')), outcome.text, outcome.segments, labels);
        body.querySelector('[data-fb="cancel"]')?.addEventListener('click', host.cancel);
        body.querySelector('[data-fb="ask"]')?.addEventListener('click', ask);
        box.focus();
    };

    const ask = async () => {
        if (busy) return;
        const words = opinion.trim();
        const changedByHand = edited();
        if (!words && !changedByHand.size) {
            toastr.info('先写一句意见，或在下面点几段');
            return;
        }
        busy = true;
        body.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> AI 正在按你的意见修正…';
        const scheme = outcome.scheme ?? null;
        try {
            const { messages, ids } = buildFeedbackMessages({
                text: outcome.text,
                segments: outcome.segments,
                labels,
                opinion: words,
                edited: changedByHand,
                note: scheme?.note ?? '',
                rules: scheme ? effectiveRules(scheme) : [],
                maxSegmentChars: Number(getSettings().maxSegmentChars) || 200,
                solidify,
            });
            const answer = await classify(messages);
            const parsed = parseFeedback(answer, ids, labels, { solidify });
            showProposal(host, { base: labels, start, parsed, words, solidify, back: () => { busy = false; drawInput(); } });
        } catch (error) {
            busy = false;
            drawInput();
            body.insertAdjacentHTML('afterbegin', `<div class="aitts-error">AI 修正失败：${escapeHtml(errText(error))}</div>`);
        }
    };

    drawInput();
}

/**
 * The model's proposal, checked, for the user to adjust and confirm.
 * @param {FeedbackHost} host
 * @param {{ base: Map<number, Label>, start: Map<number, Label>, parsed: ReturnType<typeof parseFeedback>, words: string, solidify: boolean, back: () => void }} p
 */
function showProposal(host, p) {
    const { body, outcome, text } = host;
    const labels = applyChanges(p.base, p.parsed.changes);
    const changed = new Set([...labels].filter(([id, l]) => p.start.get(id)?.skip !== l.skip).map(([id]) => id));
    const schemes = getSchemes();
    const card = cardKeyOf(host.message);
    const boundTo = card ? schemes.find(x => x.cards.includes(card)) ?? null : null;
    let target = outcome.scheme && findScheme(outcome.scheme.id) ? outcome.scheme.id : (schemes[0]?.id ?? NEW_SCHEME);
    /** @type {Map<string, boolean>} rule key -> chosen */
    const chosen = new Map();
    let noteOn = false;
    let note = '';
    let anchorOn = false;
    let anchorTouched = false;
    let fewShotOn = true;
    let saving = false;

    const targetScheme = () => (target === NEW_SCHEME ? null : findScheme(target));
    const sampleOf = () => ({ text, segments: outcome.segments, labels });
    /** @type {Map<string, import('./core/anchor.js').LabeledSample[]>} */
    const samplesCache = new Map();
    const otherSamples = () => {
        const scheme = targetScheme();
        if (!scheme) return [];
        if (!samplesCache.has(scheme.id)) {
            const list = [];
            for (const anchor of scheme.anchors) {
                if (anchor.text === text) continue; // this message itself: its new verdicts count
                try {
                    list.push(labelAnchor(anchor));
                } catch (error) {
                    console.warn('[AI TTS Filter] skipped a broken sample', error);
                }
            }
            samplesCache.set(scheme.id, list);
        }
        return samplesCache.get(scheme.id) ?? [];
    };
    const check = () => {
        const scheme = targetScheme();
        const existing = new Set(scheme ? effectiveRules(scheme).map(ruleKey) : []);
        return checkFeedbackRules(p.parsed.rules, { message: sampleOf(), others: otherSamples(), existing });
    };
    const resetNote = () => {
        const old = String(targetScheme()?.note ?? '').trim();
        note = mergeNote(old, p.parsed.note);
        noteOn = note !== old; // nothing new to add: left off
    };
    resetNote();

    const isSample = () => Boolean(targetScheme()?.anchors.some(a => a.text === text));

    /** @param {ReturnType<typeof check>} result */
    const solidHtml = result => `
<h4>建议的规则</h4>
${result.accepted.length ? result.accepted.map(r => `
<label class="checkbox_label aitts-fb-rule"><input type="checkbox" data-rule="${escapeHtml(r.key)}"${chosen.get(r.key) ? ' checked' : ''}>
  <span>${escapeHtml(describeChecked(r))}</span></label>`).join('') : '<small class="aitts-hint">没有可用的规则。</small>'}
${result.rejected.length ? `<details class="aitts-fb-rejected"><summary>没有采用的规则（${result.rejected.length} 条）</summary><ul>${result.rejected.map(r => `<li>${escapeHtml(r.text)}：${escapeHtml(r.reason)}</li>`).join('')}</ul></details>` : ''}
<small class="aitts-hint">规则只会让内容不读。以后同类消息先由规则判定，不再问模型；每条规则在方案里都能单独关掉。</small>
<h4>格式说明</h4>
${p.parsed.note ? `<div>AI 建议加一句：${escapeHtml(p.parsed.note)}</div>` : '<small class="aitts-hint">AI 没有建议格式说明。</small>'}
<label class="checkbox_label"><input type="checkbox" data-fb-note${noteOn ? ' checked' : ''}> 更新格式说明（下面是更新后的全文，可以修改，最多 ${NOTE_MAX_CHARS} 字）</label>
<textarea class="text_pole aitts-fb-note" rows="3"${noteOn ? '' : ' disabled'}>${escapeHtml(note)}</textarea>
${noteOn && Array.from(note).length > NOTE_MAX_CHARS ? `<div class="aitts-error">合并后有 ${Array.from(note).length} 字，超过 ${NOTE_MAX_CHARS} 字上限，请先删减再保存。</div>` : ''}`;

    const drawSide = () => {
        const side = /** @type {HTMLElement|null} */ (body.querySelector('.aitts-fb-side'));
        if (!side) return;
        const result = check();
        for (const r of result.accepted) if (!chosen.has(r.key)) chosen.set(r.key, true);
        const picked = result.accepted.filter(r => chosen.get(r.key));
        const sample = isSample();
        // "补充样例" keeps the corrected message as a sample: always saved.
        const needAnchor = picked.length > 0 || !p.solidify;
        if (!anchorTouched) anchorOn = needAnchor || noteOn || sample;
        const scheme = targetScheme();
        const before = skippedCount(p.start);
        const after = skippedCount(labels);
        const fewShotAlready = Boolean(scheme?.fewShot);
        side.innerHTML = `
<div class="aitts-meta">${p.solidify ? '固化' : '补充样例'} · 这条消息：AI 建议改 ${p.parsed.changes.size} 段${changed.size !== p.parsed.changes.size ? `，算上你的调整现在共改了 ${changed.size} 段` : ''}；不读的片段从 ${before} 段变成 ${after} 段。上面可以继续点选调整。</div>
${p.solidify ? solidHtml(result) : `
<h4>样例</h4>
<label class="checkbox_label"><input type="checkbox" data-fb-fewshot${fewShotAlready || fewShotOn ? ' checked' : ''}${fewShotAlready ? ' disabled' : ''}> 过滤时把方案的样例附给模型参考（方案设置“附带样例”${fewShotAlready ? '，已经开着' : (scheme ? '，现在关着，勾选会打开' : '')}）</label>
<small class="aitts-hint">不新增规则和说明。改好的这条消息存为方案的样例（锚点）：同一条消息以后直接按样例朗读；开着“附带样例”时，新消息过滤时会参考样例（附带的样例总共最多 ${FEW_SHOT_MAX_CHARS} 字，新的优先）。方案也会照常从全部样例里自动找规则，自动规则可以在方案里关掉。</small>`}
<h4>保存到格式方案</h4>
<select class="text_pole aitts-fb-scheme">
  ${getSchemes().map(x => `<option value="${escapeHtml(x.id)}"${target === x.id ? ' selected' : ''}>${escapeHtml(x.name)}（样例 ${x.anchors.length}/${anchorLimit()}）</option>`).join('')}
  <option value="${NEW_SCHEME}"${target === NEW_SCHEME ? ' selected' : ''}>新建方案${card ? `，并绑定到角色卡“${escapeHtml(cardName(card))}”${boundTo ? `（取代原来绑定的“${escapeHtml(boundTo.name)}”）` : ''}` : ''}</option>
</select>
<label class="checkbox_label"><input type="checkbox" data-fb-anchor${anchorOn ? ' checked' : ''}${needAnchor || sample ? ' disabled' : ''}> ${sample ? '更新这条消息在方案里的样例标注' : '把这条消息加入为样例'}</label>
<small class="aitts-hint">${!p.solidify ? '补充样例就是把这条消息存为样例。' : needAnchor ? '选了规则就要保存样例：规则靠样例检查，以后样例变化时也会重新检查。' :(sample ? '这条消息已是样例，会更新它的标注。' : '不保存规则和说明时，可以只记住这条消息的结果。')}${scheme ? '' : ' 新方案会按这次的结果建立。'}</small>
<div class="aitts-actions">
  <div class="menu_button" data-fb="apply"><i class="fa-solid fa-check"></i> ${saving ? '正在保存…' : '确认并朗读'}</div>
  <div class="menu_button" data-fb="again"><i class="fa-solid fa-comment-dots"></i> 重新提意见</div>
  <div class="menu_button" data-fb="cancel"><i class="fa-solid fa-xmark"></i> 取消</div>
</div>`;
    };

    body.innerHTML = `
<div class="aitts-feedback">
  ${p.words ? `<div class="aitts-meta">你的意见：${escapeHtml(p.words)}</div>` : ''}
  <div class="aitts-fb-editor"></div>
  <div class="aitts-fb-side"></div>
</div>`;
    const editor = mountLabelEditor(/** @type {HTMLElement} */ (body.querySelector('.aitts-fb-editor')), text, outcome.segments, labels, () => {
        changed.clear();
        for (const [id, l] of labels) if (p.start.get(id)?.skip !== l.skip) changed.add(id);
        editor.redraw(); // the editor drew before the marks were updated
        drawSide();
    }, changed);
    drawSide();

    const side = /** @type {HTMLElement} */ (body.querySelector('.aitts-fb-side'));
    side.addEventListener('change', (event) => {
        const t = event.target;
        if (!(t instanceof HTMLElement)) return;
        if (t instanceof HTMLInputElement && t.dataset.rule !== undefined) {
            chosen.set(t.dataset.rule, t.checked);
        } else if (t instanceof HTMLInputElement && t.hasAttribute('data-fb-note')) {
            noteOn = t.checked;
        } else if (t instanceof HTMLInputElement && t.hasAttribute('data-fb-fewshot')) {
            fewShotOn = t.checked;
        } else if (t instanceof HTMLInputElement && t.hasAttribute('data-fb-anchor')) {
            anchorOn = t.checked;
            anchorTouched = true;
        } else if (t instanceof HTMLSelectElement && t.classList.contains('aitts-fb-scheme')) {
            target = t.value;
            anchorTouched = false;
            resetNote();
        } else {
            return;
        }
        drawSide();
    });
    side.addEventListener('input', (event) => {
        const t = event.target;
        if (t instanceof HTMLTextAreaElement && t.classList.contains('aitts-fb-note')) note = t.value;
    });
    side.addEventListener('click', async (event) => {
        const t = event.target instanceof Element ? event.target.closest('[data-fb]') : null;
        const act = t?.getAttribute('data-fb');
        if (!act || saving) return;
        if (act === 'cancel') return host.cancel();
        if (act === 'again') return p.back();
        if (act !== 'apply') return;
        host.unlock?.(); // inside the tap, before any await (iOS)
        saving = true;
        drawSide();
        try {
            const picked = check().accepted.filter(r => chosen.get(r.key)).map(r => r.rule);
            const output = await applyFeedback(host, {
                labels,
                rules: picked,
                note: p.solidify && noteOn ? note : null,
                anchor: anchorOn || picked.length > 0 || isSample() || !p.solidify,
                fewShot: !p.solidify && fewShotOn,
                target,
                card,
                // A retry after a later failure must not create a second scheme.
                created: (id) => { target = id; },
            });
            host.done(output);
        } catch (error) {
            saving = false;
            drawSide();
            toastr.error(`保存失败：${errText(error)}`);
        }
    });
}

/** @param {import('./core/feedback.js').CheckedRule} r */
function describeChecked(r) {
    const others = r.otherSamples
        ? `；方案里另外 ${r.otherSamples} 份样例命中 ${r.otherHits} 段，没有误伤`
        : '；方案里还没有别的样例可以回测';
    return `${describeRule(r.rule)}（这条消息命中 ${r.hits} 段${others}）`;
}

/**
 * Saves what the user confirmed. Order matters: the scheme changes first,
 * because the remembered result of this message is stored under a key that
 * includes the scheme's rules and note.
 * @param {FeedbackHost} host
 * @param {{ labels: Map<number, Label>, rules: import('./core/scheme-rules.js').SchemeRule[], note: string|null, anchor: boolean, fewShot?: boolean, target: string, card: string|null, created?: (id: string) => void }} choice
 * @returns {Promise<string>} the text to read
 */
async function applyFeedback(host, choice) {
    const { text, outcome } = host;
    const segments = outcome.segments;
    const touchScheme = choice.anchor || choice.rules.length > 0 || choice.note !== null;
    let anchorAdded = false;
    let fewShotTurnedOn = false;
    if (touchScheme) {
        if (choice.note !== null && Array.from(choice.note).length > NOTE_MAX_CHARS) {
            throw new Error(`格式说明超过了 ${NOTE_MAX_CHARS} 字，请删减`);
        }
        if (choice.note !== null && !choice.note.trim() && String(findScheme(choice.target)?.note ?? '').trim()) {
            throw new Error('格式说明是空的，保存会清掉方案原来的说明。不想改说明就取消勾选“更新格式说明”');
        }
        let scheme = choice.target === NEW_SCHEME ? null : findScheme(choice.target);
        if (choice.target !== NEW_SCHEME && !scheme) {
            throw new Error('选择的格式方案已不存在');
        }
        // Ask before changing anything: a full scheme needs a sample to give way.
        let replaceId;
        const existing = scheme?.anchors.find(a => a.text === text) ?? null;
        if (choice.anchor && scheme && !existing && scheme.anchors.length >= anchorLimit()) {
            replaceId = await pickAnchorToReplace(scheme);
            if (!replaceId) throw new Error('样例已满，没有选择要替换的一份，所以什么都没有保存');
        }
        // A sample that is too long fails here, before a new scheme takes the card's binding.
        const length = Array.from(text).length;
        if (choice.anchor && !existing && length > anchorMaxChars()) {
            throw new Error(`这条消息有 ${length} 字，超过了样例原文字数上限 ${anchorMaxChars()} 字，不能存为样例。可以在“格式方案”设置里调高上限，或者不保存规则、只记住这条消息`);
        }
        if (!scheme) {
            const previous = choice.card ? getSchemes().find(x => x.cards.includes(String(choice.card))) ?? null : null;
            scheme = createScheme(choice.card ? cardName(choice.card) : '新方案');
            try {
                if (choice.card) bind(scheme, 'cards', choice.card);
                if (choice.anchor) {
                    addAnchor(scheme, text, segments, choice.labels);
                    anchorAdded = true;
                }
            } catch (error) {
                // Undo: no empty scheme left behind, the card goes back to its scheme.
                deleteScheme(scheme.id);
                if (previous && choice.card && findScheme(previous.id)) bind(previous, 'cards', choice.card);
                throw error;
            }
            choice.created?.(scheme.id);
        } else if (choice.anchor) {
            if (existing) {
                updateAnchorLabels(scheme, existing.id, choice.labels);
            } else {
                addAnchor(scheme, text, segments, choice.labels, replaceId);
                anchorAdded = true;
            }
        }
        const added = [];
        for (const rule of choice.rules) {
            const key = ruleKey(rule);
            const found = scheme.aiRules.find(r => {
                const ok = sanitizeRule(r.rule);
                return ok && ruleKey(ok) === key;
            });
            if (found) {
                found.enabled = true;
                delete found.invalid;
            } else {
                scheme.aiRules.push({ rule, enabled: true });
            }
            added.push(key);
        }
        if (choice.note !== null) {
            scheme.note = choice.note.trim();
        }
        if (choice.fewShot && !scheme.fewShot) {
            fewShotTurnedOn = true;
            scheme.fewShot = true; // only ever switched on here, never off
        }
        // Re-checks every AI rule against the samples as they are now.
        refreshAutoRules(scheme);
        saveSettings();
        const dropped = scheme.aiRules.filter(r => {
            const ok = sanitizeRule(r.rule);
            return ok && added.includes(ruleKey(ok)) && !r.enabled;
        });
        if (dropped.length) {
            toastr.warning(`${dropped.length} 条规则没有通过样例检查，已保存但处于关闭状态：${dropped.map(r => r.invalid ?? '').join('；')}`);
        }
    }
    // The message may also be a sample of the scheme that filtered it, and a
    // sample's labels win over a remembered result: keep that sample in step.
    const used = outcome.scheme ? findScheme(outcome.scheme.id) : null;
    const usedAnchor = used && !(touchScheme && choice.anchor && used.id === choice.target) ? used.anchors.find(a => a.text === text) : null;
    if (used && usedAnchor) {
        updateAnchorLabels(used, usedAnchor.id, choice.labels);
    }
    if (touchScheme || usedAnchor) {
        renderSchemePanel();
    }
    await saveManualResult(text, { message: host.message }, choice.labels);
    const changed = [...choice.labels].filter(([id, l]) => {
        const d = outcome.decisions.get(id);
        return Boolean(d) !== l.skip;
    }).length;
    return outputFromLabels(text, segments, choice.labels);
}
