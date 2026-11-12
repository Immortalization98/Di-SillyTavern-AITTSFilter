// Format scheme UI: list in the settings panel, scheme editor popup,
// "add as sample" from the preview. All user/model text is escaped.

import { getSettings, saveSettings, buildRuleConfig } from './settings.js';
import {
    getSchemes, findScheme, createScheme, deleteScheme, anchorLimit, ANCHOR_LIMIT_MAX,
    cardKeyOf, cardName, currentPresetKey, presetName, bind, unbind, resolveScheme,
    effectiveRules, addAnchor, updateAnchorLabels, removeAnchor,
} from './scheme.js';
import { labelAnchor, alignBody, compareWithLabels } from './core/anchor.js';
import { describeRule } from './core/scheme-rules.js';
import { applyRules } from './core/rules.js';
import { buildAnalysisMessages, parseAnalysis, NOTE_MAX_CHARS } from './core/analysis.js';
import { composeOutput } from './core/pipeline.js';
import { classify } from './llm.js';
import { filterText } from './filter.js';
import { escapeHtml, mountLabelEditor } from './preview.js';

const TITLE = 'AI 朗读过滤';
const VIA = { card: '角色卡绑定', preset: '预设绑定', default: '全局默认' };
const ctx = () => SillyTavern.getContext();
const errText = (e) => (e instanceof Error ? e.message : String(e));

/** First line of a sample, shortened. @param {string} text */
function headline(text) {
    const line = text.split('\n').map(l => l.replace(/<[^>]*>/g, '').trim()).find(Boolean) ?? text.trim();
    const chars = Array.from(line);
    return chars.length > 28 ? `${chars.slice(0, 28).join('')}…` : line;
}

/** @param {import('./core/anchor.js').LabeledSample} sample */
function readCount(sample) {
    const skipped = new Set(sample.segments.filter(seg => seg.kind === 'markup' || sample.labels.get(seg.id)?.skip).map(seg => seg.id));
    return Array.from(composeOutput(sample.text, sample.segments, skipped)).length;
}

/** @param {import('./scheme.js').Scheme} scheme */
function bindingSummary(scheme) {
    const parts = [
        ...scheme.cards.map(c => `卡：${cardName(c)}`),
        ...scheme.presets.map(p => `预设：${presetName(p)}`),
    ];
    if (getSettings().defaultSchemeId === scheme.id) parts.push('全局默认');
    return parts.length ? parts.join('、') : '未绑定';
}

// ---------------------------------------------------------------- settings panel

/** Fills the scheme group of the settings panel. */
export function renderSchemePanel() {
    const list = document.getElementById('aitts_scheme_list');
    const current = document.getElementById('aitts_scheme_current');
    const select = /** @type {HTMLSelectElement|null} */ (document.getElementById('aitts_default_scheme'));
    if (!list || !current || !select) return;
    const schemes = getSchemes();
    const s = getSettings();

    const resolved = resolveScheme(undefined);
    current.textContent = resolved
        ? `当前聊天使用：${resolved.scheme.name}（${VIA[resolved.via]}）`
        : '当前聊天没有使用格式方案（只用通用提示词）。';

    select.innerHTML = '';
    const none = document.createElement('option');
    none.value = '';
    none.textContent = '（不用方案）';
    select.append(none);
    for (const scheme of schemes) {
        const o = document.createElement('option');
        o.value = scheme.id;
        o.textContent = scheme.name;
        select.append(o);
    }
    select.value = schemes.some(x => x.id === s.defaultSchemeId) ? s.defaultSchemeId : '';

    list.innerHTML = schemes.length
        ? schemes.map(x => `
            <div class="aitts-scheme-row" data-id="${escapeHtml(x.id)}">
              <div class="aitts-scheme-info"><b>${escapeHtml(x.name)}</b>
                <small>样例 ${x.anchors.length}/${anchorLimit()} · 规则 ${effectiveRules(x).length} 条${x.note ? ' · 有格式说明' : ''}${x.fewShot ? ' · 附带样例' : ''}</small>
                <small>${escapeHtml(bindingSummary(x))}</small></div>
              <div class="menu_button aitts-scheme-edit">编辑</div>
              <div class="menu_button aitts-scheme-del">删除</div>
            </div>`).join('')
        : '<small class="aitts-hint">还没有格式方案。可以点“新建方案”，或在消息的朗读预览里点“纠错”→“加入样例”。</small>';
}

/** Binds the static controls of the scheme group (once). */
export function initSchemePanel() {
    const group = document.getElementById('aitts_scheme_group');
    if (!group) return;
    group.addEventListener('click', async (event) => {
        const target = event.target instanceof Element ? event.target : null;
        if (!target) return;
        const row = target.closest('.aitts-scheme-row');
        const scheme = row ? findScheme(row.getAttribute('data-id') ?? '') : null;
        if (target.closest('#aitts_scheme_new')) {
            const name = await ctx().callGenericPopup('新方案的名称：', ctx().POPUP_TYPE.INPUT, '新方案');
            if (typeof name === 'string' && name.trim()) {
                const created = createScheme(name.trim());
                renderSchemePanel();
                openSchemeEditor(created);
            }
        } else if (scheme && target.closest('.aitts-scheme-edit')) {
            openSchemeEditor(scheme);
        } else if (scheme && target.closest('.aitts-scheme-del')) {
            const ok = await ctx().callGenericPopup(`删除方案“${escapeHtml(scheme.name)}”及其全部样例？`, ctx().POPUP_TYPE.CONFIRM);
            if (ok === ctx().POPUP_RESULT.AFFIRMATIVE) {
                deleteScheme(scheme.id);
                renderSchemePanel();
            }
        }
    });
    document.getElementById('aitts_default_scheme')?.addEventListener('change', (event) => {
        getSettings().defaultSchemeId = /** @type {HTMLSelectElement} */ (event.target).value;
        saveSettings();
        renderSchemePanel();
    });
    const { eventSource, eventTypes } = ctx();
    eventSource.on(eventTypes.CHAT_CHANGED, () => renderSchemePanel());
    renderSchemePanel();
}

// ---------------------------------------------------------------- labelling popups

/**
 * Lets the user mark read / not read on a text. Resolves with the labels, or null.
 * @param {string} title
 * @param {string} text
 * @param {import('./core/segmenter.js').Segment[]} segments
 * @param {Map<number, { skip: boolean, cat: string }>} labels
 */
async function editLabels(title, text, segments, labels) {
    const c = ctx();
    const root = document.createElement('div');
    root.className = 'aitts-preview';
    root.innerHTML = `<h3>${escapeHtml(title)}</h3><div class="aitts-body"></div>`;
    const copy = new Map([...labels].map(([k, v]) => [k, { ...v }]));
    mountLabelEditor(/** @type {HTMLElement} */ (root.querySelector('.aitts-body')), text, segments, copy);
    const result = await c.callGenericPopup(root, c.POPUP_TYPE.CONFIRM, '', { wide: true, large: true, allowVerticalScrolling: true, leftAlign: true, okButton: '保存', cancelButton: '取消' });
    return result === c.POPUP_RESULT.AFFIRMATIVE ? copy : null;
}

/**
 * Asks which scheme a corrected message goes into, then adds it.
 * @param {string} text
 * @param {import('./core/segmenter.js').Segment[]} segments
 * @param {Map<number, { skip: boolean, cat: string }>} labels
 * @param {any} message
 */
export async function chooseSchemeAndAdd(text, segments, labels, message) {
    const c = ctx();
    const schemes = getSchemes();
    const resolved = resolveScheme(message);
    const card = cardKeyOf(message);
    const root = document.createElement('div');
    root.innerHTML = `
        <h3>加入格式方案的样例</h3>
        <select class="text_pole aitts-pick-scheme">
          ${schemes.map(x => `<option value="${escapeHtml(x.id)}"${resolved?.scheme.id === x.id ? ' selected' : ''}>${escapeHtml(x.name)}（样例 ${x.anchors.length}/${anchorLimit()}）</option>`).join('')}
          <option value="__new"${schemes.length ? '' : ' selected'}>新建方案${card ? `，并绑定到角色卡“${escapeHtml(cardName(card))}”` : ''}</option>
        </select>
        <small class="aitts-hint">样例会保存原文和你的标注（跟随账号保存在扩展设置里）。</small>`;
    const ok = await c.callGenericPopup(root, c.POPUP_TYPE.CONFIRM, '', { okButton: '加入', cancelButton: '取消' });
    if (ok !== c.POPUP_RESULT.AFFIRMATIVE) return;
    const picked = /** @type {HTMLSelectElement} */ (root.querySelector('.aitts-pick-scheme')).value;

    let scheme = findScheme(picked);
    if (!scheme) {
        scheme = createScheme(card ? cardName(card) : '新方案');
        if (card) bind(scheme, 'cards', card);
    }
    let replaceId;
    if (scheme.anchors.length >= anchorLimit()) {
        replaceId = await pickAnchorToReplace(scheme);
        if (!replaceId) return;
    }
    addAnchor(scheme, text, segments, labels, replaceId);
    renderSchemePanel();
    const open = await c.callGenericPopup(`已加入方案“${escapeHtml(scheme.name)}”。自动规则已更新；要打开方案重新做 AI 分析和回测吗？`, c.POPUP_TYPE.CONFIRM, '', { okButton: '打开方案', cancelButton: '稍后' });
    if (open === c.POPUP_RESULT.AFFIRMATIVE) openSchemeEditor(scheme);
}

/** @param {import('./scheme.js').Scheme} scheme @returns {Promise<string|undefined>} */
export async function pickAnchorToReplace(scheme) {
    const c = ctx();
    const root = document.createElement('div');
    root.innerHTML = `
        <h3>样例已满（${scheme.anchors.length}/${anchorLimit()}）</h3>
        <p>选择要替换的一份，或取消后在设置里调高上限（最多 ${ANCHOR_LIMIT_MAX}）。</p>
        <select class="text_pole aitts-pick-anchor">
          ${scheme.anchors.map((a, i) => `<option value="${escapeHtml(a.id)}">样例 ${i + 1}：${escapeHtml(headline(a.text))}</option>`).join('')}
        </select>`;
    const ok = await c.callGenericPopup(root, c.POPUP_TYPE.CONFIRM, '', { okButton: '替换', cancelButton: '取消' });
    return ok === c.POPUP_RESULT.AFFIRMATIVE ? /** @type {HTMLSelectElement} */ (root.querySelector('.aitts-pick-anchor')).value : undefined;
}

/**
 * Lists where the pasted 正文 differs from the original and asks to go on.
 * @param {import('./core/anchor.js').BodyDiff[]} diffs
 * @returns {Promise<boolean>}
 */
async function confirmDiffs(diffs) {
    const c = ctx();
    const item = (d) => {
        const where = d.line ? `第 ${d.line} 行` : '末尾';
        const what = [
            d.removed ? `原文有“<b>${escapeHtml(d.removed)}</b>”，正文没有` : '',
            d.added ? `正文多了“<b>${escapeHtml(d.added)}</b>”` : '',
        ].filter(Boolean).join('；');
        const ctxText = `…${escapeHtml(d.before)}【${escapeHtml(d.removed || d.added)}】${escapeHtml(d.after)}…`;
        return `<li>${where}：${what}<br><small>${ctxText}</small></li>`;
    };
    const root = document.createElement('div');
    root.innerHTML = `
        <h3>正文和原文有 ${diffs.length} 处不一致</h3>
        <p>常见原因是显示用的正则隐藏或替换了部分文字。这些行仍按“读”处理：朗读时会读原文整行，被隐藏的字可以交给原生朗读的正则去掉。</p>
        <details class="aitts-diffs"${diffs.length <= 3 ? ' open' : ''}>
          <summary>逐条查看（${diffs.length} 处）</summary>
          <ol>${diffs.map(item).join('')}</ol>
        </details>
        <p>继续加入这份样例吗？</p>`;
    const result = await c.callGenericPopup(root, c.POPUP_TYPE.CONFIRM, '', { wide: true, allowVerticalScrolling: true, leftAlign: true, okButton: '继续', cancelButton: '取消' });
    return result === c.POPUP_RESULT.AFFIRMATIVE;
}

// ---------------------------------------------------------------- scheme editor

/** @param {import('./scheme.js').Scheme} scheme */
export async function openSchemeEditor(scheme) {
    const c = ctx();
    const root = document.createElement('div');
    root.className = 'aitts-preview aitts-scheme-editor';
    /** @type {{ html: string } | null} */
    let analysis = null;
    let analysisResult = null;
    let backtest = '';
    let busy = false;
    let pasting = false;
    /** @type {any} */
    let lastToast = null;
    /** One message at a time: a new one replaces the previous. */
    const notify = (level, message, timeOut = 5000) => {
        if (lastToast) toastr.clear(lastToast);
        lastToast = toastr[level](message, TITLE, { timeOut });
    };

    const ruleStage = () => {
        const samples = scheme.anchors.map(labelAnchor);
        const { rules } = buildRuleConfig(getSettings());
        rules.schemeRules = effectiveRules(scheme);
        let skipTotal = 0;
        let handled = 0;
        let wrong = 0;
        for (const sample of samples) {
            const decided = applyRules(sample.text, sample.segments, rules);
            for (const [id, label] of sample.labels) {
                const d = decided.get(id);
                if (label.skip) {
                    skipTotal++;
                    if (d?.skip) handled++;
                } else if (d?.skip) {
                    wrong++;
                }
            }
        }
        return { skipTotal, handled, wrong };
    };

    const draw = () => {
        // Keep unsaved input and open sections across redraws.
        const keep = {
            text: /** @type {HTMLTextAreaElement|null} */ (root.querySelector('.aitts-add-text'))?.value ?? '',
            body: /** @type {HTMLTextAreaElement|null} */ (root.querySelector('.aitts-add-body'))?.value ?? '',
            open: /** @type {HTMLDetailsElement|null} */ (root.querySelector('details.aitts-group'))?.open ?? false,
        };
        drawInner();
        const t = /** @type {HTMLTextAreaElement|null} */ (root.querySelector('.aitts-add-text'));
        const b = /** @type {HTMLTextAreaElement|null} */ (root.querySelector('.aitts-add-body'));
        const d = /** @type {HTMLDetailsElement|null} */ (root.querySelector('details.aitts-group'));
        if (t) t.value = keep.text;
        if (b) b.value = keep.body;
        if (d) d.open = keep.open;
    };

    const drawInner = () => {
        const card = cardKeyOf(undefined);
        const preset = currentPresetKey();
        const stage = ruleStage();
        const ruleRow = (r, origin, i) => `
            <label class="checkbox_label aitts-rule">
              <input type="checkbox" data-rule="${origin}:${i}" ${r.enabled ? 'checked' : ''}>
              <span>${escapeHtml(describeRule(r.rule))}${origin === 'ai' ? ' <small class="aitts-tag">AI</small>' : ''}${r.support ? ` <small>（${r.samples ?? 1} 份样例里 ${r.support} 处）</small>` : ''}${r.invalid ? ` <small class="aitts-error">已停用：${escapeHtml(r.invalid)}</small>` : ''}</span>
            </label>`;
        root.innerHTML = `
            <h3>格式方案</h3>
            <label>名称</label>
            <input type="text" class="text_pole aitts-scheme-name" value="${escapeHtml(scheme.name)}" maxlength="40">

            <h4>绑定（随时可以换绑；同一张卡或同一个预设只属于一个方案）</h4>
            <div class="aitts-row">
              <span>当前角色卡：${card ? escapeHtml(cardName(card)) : '（群聊或未选角色）'}</span>
              ${card ? (scheme.cards.includes(card) ? '<div class="menu_button" data-act="unbind-card">解绑</div>' : '<div class="menu_button" data-act="bind-card">绑定到此方案</div>') : ''}
            </div>
            <div class="aitts-row">
              <span>当前预设：${preset ? escapeHtml(presetName(preset)) : '（读不到）'}</span>
              ${preset ? (scheme.presets.includes(preset) ? '<div class="menu_button" data-act="unbind-preset">解绑</div>' : '<div class="menu_button" data-act="bind-preset">绑定到此方案</div>') : ''}
            </div>
            <div class="aitts-chips">
              ${scheme.cards.map(k => `<span class="aitts-chip">卡：${escapeHtml(cardName(k))} <i class="fa-solid fa-xmark" data-act="drop-card" data-key="${escapeHtml(k)}"></i></span>`).join('')}
              ${scheme.presets.map(k => `<span class="aitts-chip">预设：${escapeHtml(presetName(k))} <i class="fa-solid fa-xmark" data-act="drop-preset" data-key="${escapeHtml(k)}"></i></span>`).join('')}
            </div>

            <h4>样例（${scheme.anchors.length}/${anchorLimit()}）</h4>
            ${scheme.anchors.map((a, i) => {
                const sample = labelAnchor(a);
                return `<div class="aitts-anchor-row">
                    <div class="aitts-scheme-info"><b>样例 ${i + 1}</b> <small>${escapeHtml(headline(a.text))}</small>
                      <small>原文 ${Array.from(a.text).length} 字 · 读出 ${readCount(sample)} 字</small></div>
                    <div class="menu_button" data-act="label" data-id="${escapeHtml(a.id)}">标注</div>
                    <div class="menu_button" data-act="drop-anchor" data-id="${escapeHtml(a.id)}">删除</div>
                  </div>`;
            }).join('') || '<small class="aitts-hint">还没有样例。</small>'}
            <details class="aitts-group">
              <summary>粘贴原文 + 正文来添加</summary>
              <label>原文（完整的一条消息）</label>
              <textarea class="text_pole aitts-add-text" rows="5"></textarea>
              <label>正文（其中应该读出来的部分，按原顺序；空白和换行不影响）</label>
              <textarea class="text_pole aitts-add-body" rows="4"></textarea>
              <div class="aitts-row"><div class="menu_button" data-act="add-pasted">对齐并加入</div></div>
              <small class="aitts-hint">也可以在消息的朗读预览里点“纠错”→“加入样例”。</small>
            </details>

            <h4>规则</h4>
            <small class="aitts-hint">在样例里，规则直接处理了 ${stage.handled}/${stage.skipTotal} 处不读的内容，误删 ${stage.wrong} 处；其余交给模型判断。</small>
            ${scheme.autoRules.map((r, i) => ruleRow(r, 'auto', i)).join('')}
            ${scheme.aiRules.map((r, i) => ruleRow(r, 'ai', i)).join('')}
            ${!scheme.autoRules.length && !scheme.aiRules.length ? '<small class="aitts-hint">暂无规则（样例越有规律，自动找到的规则越多）。</small>' : ''}

            <h4>AI 分析</h4>
            <div class="aitts-row">
              <div class="menu_button" data-act="analyze">${busy ? '<i class="fa-solid fa-spinner fa-spin"></i> 分析中…' : 'AI 分析样例'}</div>
              <small>${scheme.analyzedAt ? `上次：${new Date(scheme.analyzedAt).toLocaleString()}` : '还没有分析过'}</small>
            </div>
            ${analysis ? analysis.html : ''}
            <label>格式说明（每次过滤时附在提示词里，最多 ${NOTE_MAX_CHARS} 字，可修改）</label>
            <textarea class="text_pole aitts-scheme-note" rows="4" maxlength="${NOTE_MAX_CHARS}">${escapeHtml(scheme.note)}</textarea>
            <label class="checkbox_label"><input type="checkbox" class="aitts-scheme-fewshot" ${scheme.fewShot ? 'checked' : ''}><span>每次过滤都附带样例（最准，但每次请求多花样例那么多的字数）</span></label>

            <h4>回测</h4>
            <div class="aitts-row"><div class="menu_button" data-act="backtest">用当前设置重新过滤样例并对比</div></div>
            <small class="aitts-hint">会按样例数调用模型；开启“附带样例”时，测某份样例不会附带它自己。规则和格式说明是从全部样例学出来的，所以回测结果偏乐观，新消息的实际效果以预览为准。</small>
            <div class="aitts-backtest">${backtest}</div>`;
    };

    const runAnalysis = async () => {
        if (busy || !scheme.anchors.length) {
            if (!scheme.anchors.length) toastr.info('先加入至少一份样例', TITLE);
            return;
        }
        busy = true;
        draw();
        try {
            const samples = scheme.anchors.map(labelAnchor);
            const answer = await classify(buildAnalysisMessages(samples, { maxSegmentChars: 300 }));
            analysisResult = parseAnalysis(answer, samples);
            const r = analysisResult;
            analysis = {
                html: `<div class="aitts-analysis">
                    <div><b>格式说明：</b>${escapeHtml(r.note || '（模型没有给出说明）')}</div>
                    <div><b>可用的规则（已通过样例检查）：</b>${r.accepted.length ? `<ul>${r.accepted.map(x => `<li>${escapeHtml(describeRule(x))}</li>`).join('')}</ul>` : '无'}</div>
                    ${r.rejected.length ? `<div><b>未采用：</b><ul>${r.rejected.map(x => `<li>${escapeHtml(JSON.stringify(x.rule).slice(0, 80))}：${escapeHtml(x.reason)}</li>`).join('')}</ul></div>` : ''}
                    <div class="aitts-row"><div class="menu_button" data-act="adopt">采用</div><div class="menu_button" data-act="discard">放弃</div></div>
                  </div>`,
            };
        } catch (error) {
            analysis = { html: `<div class="aitts-error">分析失败：${escapeHtml(errText(error))}</div>` };
        } finally {
            busy = false;
            draw();
        }
    };

    const runBacktest = async () => {
        if (!scheme.anchors.length) return;
        backtest = '<i class="fa-solid fa-spinner fa-spin"></i> 正在回测…';
        draw();
        const lines = [];
        let correct = 0;
        let total = 0;
        for (const [i, anchor] of scheme.anchors.entries()) {
            const sample = labelAnchor(anchor);
            try {
                const o = await filterText(anchor.text, { scheme, force: true, quiet: true, noCache: true, excludeAnchorId: anchor.id });
                const cmp = compareWithLabels(sample, o.decisions);
                correct += cmp.correct;
                total += cmp.total;
                const show = (ids) => ids.map(id => `“${escapeHtml(headline(anchor.text.slice(sample.segments[id].start, sample.segments[id].end)))}”`).join('、');
                lines.push(`<div><b>样例 ${i + 1}</b>：正确 ${cmp.correct}/${cmp.total}${o.source === 'fallback' ? `（模型出错：${escapeHtml(o.error ?? '')}）` : ''}
                    ${cmp.wrongSkip.length ? `<div class="aitts-error">多删：${show(cmp.wrongSkip)}</div>` : ''}
                    ${cmp.wrongRead.length ? `<div class="aitts-error">漏删：${show(cmp.wrongRead)}</div>` : ''}</div>`);
            } catch (error) {
                lines.push(`<div class="aitts-error">样例 ${i + 1}：${escapeHtml(errText(error))}</div>`);
            }
        }
        backtest = `<div><b>合计：${correct}/${total} 段判断正确</b></div>${lines.join('')}`;
        draw();
    };

    root.addEventListener('input', (event) => {
        const t = event.target;
        if (t instanceof HTMLInputElement && t.classList.contains('aitts-scheme-name')) {
            scheme.name = t.value.slice(0, 40) || '未命名';
            saveSettings();
        } else if (t instanceof HTMLTextAreaElement && t.classList.contains('aitts-scheme-note')) {
            scheme.note = Array.from(t.value).slice(0, NOTE_MAX_CHARS).join('');
            saveSettings();
        }
    });
    root.addEventListener('change', (event) => {
        const t = event.target;
        if (!(t instanceof HTMLInputElement)) return;
        if (t.classList.contains('aitts-scheme-fewshot')) {
            scheme.fewShot = t.checked;
            saveSettings();
        } else if (t.dataset.rule) {
            const [origin, index] = t.dataset.rule.split(':');
            const list = origin === 'ai' ? scheme.aiRules : scheme.autoRules;
            if (list[Number(index)]) list[Number(index)].enabled = t.checked;
            saveSettings();
            draw();
        }
    });
    root.addEventListener('click', async (event) => {
        const t = event.target instanceof Element ? event.target.closest('[data-act]') : null;
        if (!t) return;
        const act = t.getAttribute('data-act');
        if (busy && act !== 'analyze') {
            toastr.info('正在分析，请稍候', TITLE);
            return;
        }
        const card = cardKeyOf(undefined);
        const preset = currentPresetKey();
        try {
            switch (act) {
                case 'bind-card': if (card) bind(scheme, 'cards', card); break;
                case 'unbind-card': if (card) unbind(scheme, 'cards', card); break;
                case 'bind-preset': if (preset) bind(scheme, 'presets', preset); break;
                case 'unbind-preset': if (preset) unbind(scheme, 'presets', preset); break;
                case 'drop-card': unbind(scheme, 'cards', t.getAttribute('data-key') ?? ''); break;
                case 'drop-preset': unbind(scheme, 'presets', t.getAttribute('data-key') ?? ''); break;
                case 'drop-anchor': {
                    const ok = await c.callGenericPopup('删除这份样例？', c.POPUP_TYPE.CONFIRM);
                    if (ok === c.POPUP_RESULT.AFFIRMATIVE) removeAnchor(scheme, t.getAttribute('data-id') ?? '');
                    break;
                }
                case 'label': {
                    const anchor = scheme.anchors.find(a => a.id === t.getAttribute('data-id'));
                    if (!anchor) break;
                    const sample = labelAnchor(anchor);
                    const labels = await editLabels('标注样例', sample.text, sample.segments, sample.labels);
                    if (labels) updateAnchorLabels(scheme, anchor.id, labels);
                    break;
                }
                case 'add-pasted': {
                    if (pasting) return;
                    pasting = true;
                    t.classList.add('disabled');
                    try {
                        const text = /** @type {HTMLTextAreaElement} */ (root.querySelector('.aitts-add-text')).value;
                        const bodyText = /** @type {HTMLTextAreaElement} */ (root.querySelector('.aitts-add-body')).value;
                        if (!text.trim()) { notify('info', '先粘贴原文'); return; }
                        const aligned = alignBody(text, bodyText);
                        if (!aligned.ok) { notify('warning', aligned.error, 10000); return; }
                        if (aligned.diffs.length && !(await confirmDiffs(aligned.diffs))) return;
                        const labels = await editLabels('检查对齐结果', text, aligned.segments, aligned.labels);
                        if (!labels) return;
                        let replaceId;
                        if (scheme.anchors.length >= anchorLimit()) {
                            replaceId = await pickAnchorToReplace(scheme);
                            if (!replaceId) return;
                        }
                        addAnchor(scheme, text, aligned.segments, labels, replaceId);
                        root.querySelector('.aitts-add-text').value = '';
                        root.querySelector('.aitts-add-body').value = '';
                        notify('success', '已加入样例');
                    } finally {
                        pasting = false;
                        t.classList.remove('disabled');
                    }
                    break;
                }
                case 'analyze': await runAnalysis(); return;
                case 'adopt':
                    if (analysisResult) {
                        scheme.note = analysisResult.note;
                        scheme.aiRules = analysisResult.accepted.map(rule => ({ rule, enabled: true }));
                        scheme.analyzedAt = Date.now();
                        saveSettings();
                        analysis = null;
                        analysisResult = null;
                        toastr.success('已采用；建议点“回测”看看效果', TITLE);
                    }
                    break;
                case 'discard': analysis = null; analysisResult = null; break;
                case 'backtest': await runBacktest(); return;
            }
        } catch (error) {
            toastr.error(errText(error), TITLE);
        }
        draw();
        renderSchemePanel();
    });

    draw();
    await c.callGenericPopup(root, c.POPUP_TYPE.TEXT, '', { wide: true, large: true, allowVerticalScrolling: true, leftAlign: true, okButton: '完成' });
    renderSchemePanel();
}

/** Used by index.js for "按此朗读并记住". @param {string} text @param {import('./core/segmenter.js').Segment[]} segments @param {Map<number, { skip: boolean }>} labels */
export function outputFromLabels(text, segments, labels) {
    const skipped = new Set(segments.filter(seg => seg.kind === 'markup' || labels.get(seg.id)?.skip).map(seg => seg.id));
    return composeOutput(text, segments, skipped);
}
