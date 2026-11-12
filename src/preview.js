// Preview: shows the source as escaped plain text with skipped parts struck
// through. Never renders message HTML, so card scripts and styles don't run.
// Correction mode: tap segments to switch read / not read.

import { CATEGORY_LABELS } from './core/prompt.js';
import { composeOutput } from './core/pipeline.js';

const SOURCE_LABELS = { llm: '模型', rules: '规则', fallback: '模型出错，已改用规则', manual: '手动纠正' };
const VIA_LABELS = { card: '角色卡绑定', preset: '预设绑定', default: '全局默认', explicit: '指定' };

/** @param {string} s */
export function escapeHtml(s) {
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

/** @param {import('./core/rules.js').Decision} d */
function bySource(d) {
    if (d.src === 'llm') return { cls: 'llm', name: '模型' };
    if (d.src === 'manual') return { cls: 'manual', name: '手动' };
    return { cls: 'rule', name: '规则' };
}

/**
 * Builds the annotated view of a filter outcome.
 * @param {import('./filter.js').FilterOutcome} o
 * @returns {string} HTML
 */
export function renderAnnotated(o) {
    const parts = [];
    let pos = 0;
    for (const seg of o.segments) {
        if (seg.start > pos) {
            parts.push(escapeHtml(o.text.slice(pos, seg.start)));
        }
        const body = escapeHtml(o.text.slice(seg.start, seg.end));
        const d = o.decisions.get(seg.id);
        if (!d) {
            parts.push(`<span class="aitts-keep">${body}</span>`);
        } else if (d.cat === 'markup') {
            parts.push(`<span class="aitts-skip aitts-markup">${body}</span>`);
        } else {
            const label = d.cat === 'tag' && d.tag ? `${d.tag}` : (CATEGORY_LABELS[d.cat] ?? d.cat);
            const by = bySource(d);
            parts.push(`<span class="aitts-skip aitts-by-${by.cls}" title="${escapeHtml(`${by.name}：${label}`)}">${body}</span><span class="aitts-cat aitts-by-${by.cls}">${escapeHtml(label)}</span>`);
        }
        pos = seg.end;
    }
    if (pos < o.text.length) {
        parts.push(escapeHtml(o.text.slice(pos)));
    }
    return parts.join('');
}

/** @param {import('./filter.js').FilterOutcome} o */
export function describeOutcome(o) {
    const bits = [];
    bits.push(`来源：${o.fromCache ? '缓存' : (SOURCE_LABELS[o.source] ?? o.source)}`);
    if (o.fromCache) {
        bits.push(`（原判定：${SOURCE_LABELS[o.source] ?? o.source}）`);
    }
    bits.push(`用时 ${Math.round(o.ms)} 毫秒`);
    const skipped = [...o.decisions.values()].filter(d => d.cat !== 'markup').length;
    bits.push(`跳过 ${skipped} 段`);
    bits.push(o.scheme ? `格式方案：${o.scheme.name}（${VIA_LABELS[o.schemeVia ?? ''] ?? ''}）` : '格式方案：无');
    if (o.fallbackAction === 'original') bits.push('（模型出错，按设置朗读原文）');
    if (o.fallbackAction === 'none') bits.push('（模型出错，按设置不朗读）');
    return bits.join(' · ');
}

/**
 * Fills a container with the preview body.
 * @param {HTMLElement} el
 * @param {import('./filter.js').FilterOutcome} o
 */
export function fillPreview(el, o) {
    el.innerHTML = `
        <div class="aitts-meta">${escapeHtml(describeOutcome(o))}${o.error ? `<div class="aitts-error">${escapeHtml(o.error)}</div>` : ''}</div>
        <div class="aitts-legend"><span class="aitts-skip aitts-by-rule">规则跳过</span> <span class="aitts-skip aitts-by-llm">模型跳过</span> <span class="aitts-skip aitts-by-manual">手动</span> 其余照常朗读（之后还会经过原生朗读自己的设置）</div>
        <div class="aitts-annotated">${renderAnnotated(o)}</div>
        <details class="aitts-output"><summary>送去朗读的文本（${Array.from(o.output).length} 字）</summary><pre>${escapeHtml(o.output || '（空，不朗读）')}</pre></details>`;
}

/**
 * Starting verdicts for correction: what the filter decided.
 * @param {import('./filter.js').FilterOutcome} o
 * @returns {Map<number, { skip: boolean, cat: string }>}
 */
export function labelsFromOutcome(o) {
    const labels = new Map();
    for (const seg of o.segments) {
        if (seg.kind === 'markup') continue;
        const d = o.decisions.get(seg.id);
        labels.set(seg.id, d ? { skip: true, cat: d.cat } : { skip: false, cat: 'read' });
    }
    return labels;
}

/**
 * Tap-to-toggle editor. Mutates `labels`.
 * @param {HTMLElement} el
 * @param {string} text
 * @param {import('./core/segmenter.js').Segment[]} segments
 * @param {Map<number, { skip: boolean, cat: string }>} labels
 * @param {() => void} [onChange]
 * @param {Set<number>} [changed]  segments to mark as changed (by a correction)
 */
export function mountLabelEditor(el, text, segments, labels, onChange, changed) {
    const draw = () => {
        const parts = [];
        let pos = 0;
        for (const seg of segments) {
            if (seg.start > pos) parts.push(escapeHtml(text.slice(pos, seg.start)));
            const body = escapeHtml(text.slice(seg.start, seg.end));
            const label = labels.get(seg.id);
            if (!label) {
                parts.push(`<span class="aitts-skip aitts-markup">${body}</span>`);
            } else {
                const mark = changed?.has(seg.id) ? ' aitts-seg-changed' : '';
                parts.push(`<span class="aitts-seg ${label.skip ? 'aitts-seg-skip' : 'aitts-seg-read'}${mark}" data-seg="${seg.id}" role="button" tabindex="0">${body}</span>`);
            }
            pos = seg.end;
        }
        if (pos < text.length) parts.push(escapeHtml(text.slice(pos)));
        const skipped = new Set([...labels].filter(([, l]) => l.skip).map(([id]) => id));
        for (const seg of segments) if (seg.kind === 'markup') skipped.add(seg.id);
        const output = composeOutput(text, segments, skipped);
        el.innerHTML = `
            <div class="aitts-legend">点一下片段在“读 / 不读”之间切换。<span class="aitts-seg aitts-seg-read">读</span> <span class="aitts-seg aitts-seg-skip">不读</span>${changed ? ' <span class="aitts-seg aitts-seg-read aitts-seg-changed">改过的</span>' : ''} · 将读出 ${Array.from(output).length} 字</div>
            <div class="aitts-annotated aitts-editing">${parts.join('')}</div>
            <details class="aitts-output"><summary>将读出的正文</summary><pre>${escapeHtml(output || '（空，不朗读）')}</pre></details>`;
    };
    el.addEventListener('click', (event) => {
        const target = event.target instanceof Element ? event.target.closest('[data-seg]') : null;
        if (!target) return;
        const id = Number(target.getAttribute('data-seg'));
        const label = labels.get(id);
        if (!label) return;
        labels.set(id, label.skip ? { skip: false, cat: 'read' } : { skip: true, cat: label.cat && label.cat !== 'read' ? label.cat : 'other' });
        draw();
        onChange?.();
    });
    draw();
    return { redraw: draw };
}

/**
 * Opens the preview popup.
 * @param {{
 *   title: string,
 *   load: (force: boolean) => Promise<import('./filter.js').FilterOutcome>,
 *   speak: (output: string) => void,
 *   unlock?: () => void,
 *   saveCorrection?: (labels: Map<number, { skip: boolean, cat: string }>, outcome: import('./filter.js').FilterOutcome) => Promise<string>,
 *   addToScheme?: (labels: Map<number, { skip: boolean, cat: string }>, outcome: import('./filter.js').FilterOutcome) => Promise<void>,
 *   feedback?: (host: { body: HTMLElement, outcome: import('./filter.js').FilterOutcome, done: (output: string) => void, cancel: () => void }) => void,
 *   feedback?: (host: { body: HTMLElement, outcome: import('./filter.js').FilterOutcome, done: (output: string) => void, cancel: () => void }) => void,
 * }} opts
 */
export async function openPreview(opts) {
    const ctx = SillyTavern.getContext();
    const root = document.createElement('div');
    root.className = 'aitts-preview';
    root.innerHTML = `
        <h3>${escapeHtml(opts.title)}</h3>
        <div class="aitts-actions aitts-view-actions">
            <div class="menu_button aitts-act-speak"><i class="fa-solid fa-volume-high"></i> 朗读结果</div>
            <div class="menu_button aitts-act-refilter"><i class="fa-solid fa-rotate"></i> 重新过滤</div>
            <div class="menu_button aitts-act-copy"><i class="fa-solid fa-copy"></i> 复制</div>
            ${opts.saveCorrection ? '<div class="menu_button aitts-act-edit"><i class="fa-solid fa-pen"></i> 纠错</div>' : ''}
            ${opts.feedback ? '<div class="menu_button aitts-act-feedback" title="用一句话说哪里不对，让 AI 修正这条消息，并把规律记进格式方案"><i class="fa-solid fa-comment-dots"></i> 提意见</div>' : ''}
            ${opts.feedback ? '<div class="menu_button aitts-act-feedback" title="用一句话说哪里不对，让 AI 修正这条消息，并把规律记进格式方案"><i class="fa-solid fa-comment-dots"></i> 提意见</div>' : ''}
        </div>
        <div class="aitts-actions aitts-edit-actions" style="display:none">
            <div class="menu_button aitts-act-save"><i class="fa-solid fa-check"></i> 按此朗读并记住</div>
            ${opts.addToScheme ? '<div class="menu_button aitts-act-anchor"><i class="fa-solid fa-anchor"></i> 加入样例</div>' : ''}
            <div class="menu_button aitts-act-cancel"><i class="fa-solid fa-xmark"></i> 取消</div>
        </div>
        <div class="aitts-body"><i class="fa-solid fa-spinner fa-spin"></i> 正在过滤…</div>`;
    const body = /** @type {HTMLElement} */ (root.querySelector('.aitts-body'));
    const viewActions = /** @type {HTMLElement} */ (root.querySelector('.aitts-view-actions'));
    const editActions = /** @type {HTMLElement} */ (root.querySelector('.aitts-edit-actions'));
    /** @type {import('./filter.js').FilterOutcome|null} */
    let current = null;
    /** @type {Map<number, { skip: boolean, cat: string }>|null} */
    let editing = null;
    let busy = false;

    const showView = () => {
        editing = null;
        viewActions.style.display = '';
        editActions.style.display = 'none';
        if (current) fillPreview(body, current);
    };

    const load = async (force) => {
        if (busy) return;
        busy = true;
        showView();
        body.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> 正在过滤…';
        try {
            current = await opts.load(force);
            fillPreview(body, current);
        } catch (error) {
            body.innerHTML = `<div class="aitts-error">过滤失败：${escapeHtml(error instanceof Error ? error.message : String(error))}</div>`;
        } finally {
            busy = false;
        }
    };

    root.querySelector('.aitts-act-speak')?.addEventListener('click', () => {
        if (current) opts.speak(current.output);
    });
    root.querySelector('.aitts-act-refilter')?.addEventListener('click', () => load(true));
    root.querySelector('.aitts-act-copy')?.addEventListener('click', async () => {
        if (!current) return;
        try {
            await navigator.clipboard.writeText(current.output);
            toastr.success('已复制');
        } catch {
            toastr.error('复制失败（浏览器不允许访问剪贴板）');
        }
    });
    root.querySelector('.aitts-act-edit')?.addEventListener('click', () => {
        if (!current || busy) return;
        editing = labelsFromOutcome(current);
        viewActions.style.display = 'none';
        editActions.style.display = '';
        body.innerHTML = '';
        const holder = document.createElement('div');
        body.append(holder);
        mountLabelEditor(holder, current.text, current.segments, editing);
    });
    root.querySelector('.aitts-act-feedback')?.addEventListener('click', () => {
        if (!current || busy || !opts.feedback) return;
        viewActions.style.display = 'none';
        editActions.style.display = 'none';
        body.innerHTML = '';
        const holder = document.createElement('div');
        body.append(holder);
        opts.feedback({
            body: holder,
            outcome: current,
            done: (output) => {
                opts.speak(output);
                load(false);
            },
            cancel: showView,
        });
    });
    root.querySelector('.aitts-act-feedback')?.addEventListener('click', () => {
        if (!current || busy || !opts.feedback) return;
        viewActions.style.display = 'none';
        editActions.style.display = 'none';
        body.innerHTML = '';
        const holder = document.createElement('div');
        body.append(holder);
        opts.feedback({
            body: holder,
            outcome: current,
            done: (output) => {
                opts.speak(output);
                load(false);
            },
            cancel: showView,
        });
    });
    root.querySelector('.aitts-act-cancel')?.addEventListener('click', showView);
    root.querySelector('.aitts-act-save')?.addEventListener('click', async () => {
        if (!current || !editing || !opts.saveCorrection) return;
        opts.unlock?.(); // inside the tap, before any await (iOS)
        try {
            const output = await opts.saveCorrection(editing, current);
            opts.speak(output);
            await load(false);
        } catch (error) {
            toastr.error(`保存失败：${error instanceof Error ? error.message : error}`);
        }
    });
    root.querySelector('.aitts-act-anchor')?.addEventListener('click', async () => {
        if (!current || !editing || !opts.addToScheme) return;
        try {
            await opts.addToScheme(editing, current);
        } catch (error) {
            toastr.error(error instanceof Error ? error.message : String(error));
        }
    });

    const shown = ctx.callGenericPopup(root, ctx.POPUP_TYPE.TEXT, '', { wide: true, large: true, allowVerticalScrolling: true, leftAlign: true, okButton: '关闭' });
    load(false);
    await shown;
}
