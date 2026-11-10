import { test } from 'node:test';
import assert from 'node:assert/strict';

import { segmentText } from '../src/core/segmenter.js';
import { applyRules, DEFAULT_SKIP_TAGS, DEFAULT_CONTENT_TAGS } from '../src/core/rules.js';
import { sanitizeRule, makeSchemeDecider, describeRule, ruleKey } from '../src/core/scheme-rules.js';
import { alignBody, labelsFromRanges, rangesFromLabels, labelAnchor, extractRules, checkRule, compareWithLabels } from '../src/core/anchor.js';
import { buildAnalysisMessages, parseAnalysis, NOTE_MAX_CHARS } from '../src/core/analysis.js';
import { buildBatches, buildExample } from '../src/core/prompt.js';
import { runFilter, composeOutput } from '../src/core/pipeline.js';

const baseRules = (over = {}) => ({
    skipTags: DEFAULT_SKIP_TAGS, contentTagMode: true, contentTags: DEFAULT_CONTENT_TAGS,
    skipCode: true, skipComments: true, skipImages: true, skipTables: true, skipDecor: true,
    keepRegex: [], skipRegex: [], ...over,
});

const SAMPLE_A = [
    '<StatusBlock>体力：80 | 心情：好</StatusBlock>',
    '她推开门，雨水顺着伞尖滴落。',
    '“我回来了。”',
    '📍地点：旧城区',
    '❤️好感度：40',
    '结算：车费 12 + 晚饭 30 = 42',
].join('\n');
const BODY_A = '她推开门，雨水顺着伞尖滴落。\n“我回来了。”';

const SAMPLE_B = [
    '<StatusBlock>体力：60 | 心情：平静</StatusBlock>',
    '他把伞收好，靠在门边。“晚饭吃了吗？”',
    '📍地点：公寓',
    '❤️好感度：42',
    '结算：外卖 35 = 35',
].join('\n');
const BODY_B = '他把伞收好，靠在门边。“晚饭吃了吗？”';

function sampleFromBody(text, body) {
    const r = alignBody(text, body);
    assert.equal(r.ok, true, r.error);
    return { text, segments: r.segments, labels: r.labels };
}

test('sanitizeRule accepts only fixed shapes and refuses risky prefixes', () => {
    assert.deepEqual(sanitizeRule({ type: 'tag', name: '<StatusBlock>' }), { type: 'tag', name: 'StatusBlock' });
    assert.deepEqual(sanitizeRule({ type: 'prefix', value: '📍' }), { type: 'prefix', value: '📍' });
    assert.equal(sanitizeRule({ type: 'prefix', value: '“' }), null);
    assert.equal(sanitizeRule({ type: 'prefix', value: '（' }), null);
    assert.equal(sanitizeRule({ type: 'prefix', value: 'x'.repeat(13) }), null);
    assert.equal(sanitizeRule({ type: 'regex', value: '.*' }), null);
    assert.equal(sanitizeRule({ type: 'bracket', open: '(' }), null);
    assert.deepEqual(sanitizeRule({ type: 'kv' }), { type: 'kv' });
    assert.equal(sanitizeRule({ type: 'tag', name: 'a b' }), null);
    assert.match(describeRule({ type: 'prefix', value: '结算：' }), /结算：/);
});

test('scheme decider: prefix, bracket, kv, tag, content tag', () => {
    const text = '<正文区>故事。</正文区>\n结算：1+1=2\n【好感+1】\n时间：夜 | 地点：桥\n<X>y</X>\n外面的话';
    const segs = segmentText(text);
    const decide = makeSchemeDecider(text, segs, [
        { type: 'prefix', value: '结算：' }, { type: 'bracket', open: '【' }, { type: 'kv' },
        { type: 'tag', name: 'x' }, { type: 'contentTag', name: '正文区' },
    ]);
    const by = Object.fromEntries(segs.filter(s => s.kind !== 'markup').map(s => [text.slice(s.start, s.end), decide(s)]));
    assert.equal(by['故事。'], null);
    assert.equal(by['结算：1+1=2'], 'prefix:结算：');
    assert.equal(by['【好感+1】'], 'bracket:【');
    assert.equal(by['时间：夜 | 地点：桥'], 'kv');
    assert.equal(by.y, 'tag:x');
    assert.equal(by['外面的话'], 'content:正文区');
});

test('alignBody labels segments and reports text that is not in the original', () => {
    const r = alignBody(SAMPLE_A, BODY_A);
    assert.equal(r.ok, true);
    const read = [...r.labels].filter(([, l]) => !l.skip).map(([id]) => SAMPLE_A.slice(r.segments[id].start, r.segments[id].end));
    assert.deepEqual(read, ['她推开门，雨水顺着伞尖滴落。', '“我回来了。”']);
    const bad = alignBody(SAMPLE_A, '她推开门。');
    assert.equal(bad.ok, false);
    assert.match(bad.error, /找不到/);
    assert.equal(alignBody(SAMPLE_A, '  ').ok, false);
});

test('labels round-trip through ranges', () => {
    const s = sampleFromBody(SAMPLE_A, BODY_A);
    const ranges = rangesFromLabels(s.segments, s.labels);
    const back = labelsFromRanges(SAMPLE_A, s.segments, ranges);
    assert.deepEqual([...back].map(([id, l]) => [id, l.skip]), [...s.labels].map(([id, l]) => [id, l.skip]));
    const anchor = labelAnchor({ id: 'a', text: SAMPLE_A, skips: ranges, at: 0 });
    assert.equal(anchor.labels.size, s.labels.size);
});

test('extractRules finds tag, symbol and label prefixes but nothing that touches read text', () => {
    const samples = [sampleFromBody(SAMPLE_A, BODY_A), sampleFromBody(SAMPLE_B, BODY_B)];
    const found = extractRules(samples);
    const keys = found.map(r => ruleKey(r.rule));
    for (const k of ['tag:statusblock', 'prefix:📍', 'prefix:❤️', 'prefix:结算：', 'kv']) {
        assert.ok(keys.includes(k), `missing ${k} in ${keys}`);
    }
    for (const r of found) {
        assert.equal(checkRule(r.rule, samples).ok, true, ruleKey(r.rule));
    }
});

test('extractRules does not learn a prefix that also starts read text', () => {
    const text = '时间：夜\n时间：过得真快啊，她想。';
    const body = '时间：过得真快啊，她想。';
    const keys = extractRules([sampleFromBody(text, body)]).map(r => ruleKey(r.rule));
    assert.equal(keys.includes('prefix:时间：'), false);
});

test('content tag is learned when all read text is inside one tag', () => {
    const text = '前言说明\n<剧情>她笑了。</剧情>\n后记';
    const keys = extractRules([sampleFromBody(text, '她笑了。')]).map(r => ruleKey(r.rule));
    assert.ok(keys.includes('content:剧情'));
});

test('scheme rules run in the rule stage; only the story line goes to the model', async () => {
    const samples = [sampleFromBody(SAMPLE_A, BODY_A), sampleFromBody(SAMPLE_B, BODY_B)];
    const schemeRules = extractRules(samples).map(r => r.rule);
    const fresh = [
        '<StatusBlock>体力：50 | 心情：困</StatusBlock>',
        '她打了个哈欠。',
        '📍地点：图书馆',
        '❤️好感度：45',
        '结算：咖啡 18 = 18',
    ].join('\n');
    let sent = '';
    const r = await runFilter(fresh, {
        mode: 'llm', rules: baseRules({ schemeRules }),
        classify: async (messages) => { sent = messages[messages.length - 1].content; return '{"skip":{}}'; },
    });
    assert.equal(composeOutput(fresh, r.segments, r.decisions), '她打了个哈欠。');
    assert.match(sent, /\[1\] 她打了个哈欠。/);
    assert.equal(sent.includes('[2]'), false);
    const cats = new Set([...r.decisions.values()].filter(d => d.cat !== 'markup').map(d => d.cat));
    assert.deepEqual([...cats], ['scheme']);
});

test('compareWithLabels counts wrong skips and wrong reads', () => {
    const s = sampleFromBody(SAMPLE_A, BODY_A);
    const c = compareWithLabels(s, new Set(s.labels.keys()));
    assert.equal(c.wrongSkip.length, 2);
    assert.equal(c.wrongRead.length, 0);
    assert.equal(compareWithLabels(s, new Set()).wrongRead.length, s.labels.size - 2);
});

test('analysis prompt contains labels; parser keeps safe, correct rules only', () => {
    const samples = [sampleFromBody(SAMPLE_A, BODY_A)];
    const messages = buildAnalysisMessages(samples);
    assert.match(messages[1].content, /【读】 她推开门/);
    assert.match(messages[1].content, /【不读·other】 📍地点：旧城区/);
    const answer = '```json\n' + JSON.stringify({
        note: '状态在 StatusBlock 里；📍、❤️ 开头的行是状态；“结算：”开头是计算。' + '长'.repeat(400),
        rules: [
            { type: 'tag', name: 'StatusBlock' },
            { type: 'prefix', value: '📍' },
            { type: 'prefix', value: '她' },        // would delete read text
            { type: 'regex', value: '.*' },         // unknown shape
            { type: 'prefix', value: '“' },         // unsafe
        ],
    }) + '\n```';
    const r = parseAnalysis(answer, samples);
    assert.equal(Array.from(r.note).length, NOTE_MAX_CHARS);
    assert.deepEqual(r.accepted.map(ruleKey), ['tag:statusblock', 'prefix:📍']);
    assert.equal(r.rejected.length, 3);
    assert.throws(() => parseAnalysis('没有', samples), /JSON/);
});

test('format note and worked examples are placed in the request', () => {
    const s = sampleFromBody(SAMPLE_A, BODY_A);
    const decided = applyRules(SAMPLE_A, s.segments, baseRules());
    const ex = buildExample(SAMPLE_A, s.segments, decided, s.labels);
    assert.ok(ex);
    const answer = JSON.parse(ex.assistant);
    assert.ok(Object.values(answer.skip).flat().length >= 3);
    const text = '她坐下。\n📍地点：家';
    const segs = segmentText(text);
    const [batch] = buildBatches(text, segs, new Map(), { formatNote: '📍 开头是地点栏', examples: [ex] });
    assert.deepEqual(batch.messages.map(m => m.role), ['system', 'user', 'assistant', 'user']);
    assert.match(batch.messages[0].content, /格式说明[\s\S]*📍 开头是地点栏/);
    assert.match(batch.messages[1].content, /^（示例）/);
});

// ---- review follow-ups ----
import { defaultEnabled, refreshAutoRules, schemeFingerprint, buildExamples, anchorFor, FEW_SHOT_MAX_CHARS } from '../src/scheme.js';

const scheme = (over = {}) => ({ id: 'x', name: 'x', anchors: [], autoRules: [], aiRules: [], note: '', fewShot: false, cards: [], presets: [], analyzedAt: 0, ...over });
const anchorOf = (text, body, id = 'a1') => {
    const s = sampleFromBody(text, body);
    return { id, text, skips: rangesFromLabels(s.segments, s.labels), at: 0 };
};

test('generic layout tags and markdown symbols are never learned', () => {
    const text = '<div>体力：80</div>\n# 第一章\n> 引用\n她走了。';
    const keys = extractRules([sampleFromBody(text, '她走了。')]).map(r => ruleKey(r.rule));
    assert.equal(keys.some(k => k.startsWith('tag:div') || k.startsWith('content:div')), false);
    assert.equal(keys.includes('prefix:#'), false);
    assert.equal(keys.includes('prefix:>'), false);
});

test('single letters are refused as prefixes; zero-hit and generic AI rules are rejected', () => {
    assert.equal(sanitizeRule({ type: 'prefix', value: '他' }), null);
    const samples = [sampleFromBody(SAMPLE_A, BODY_A)];
    const r = parseAnalysis(JSON.stringify({ note: 'n', rules: [
        { type: 'prefix', value: '⏰' },            // never appears in the sample
        { type: 'contentTag', name: 'p' },          // generic
        { type: 'prefix', value: '❤️' },            // fine
    ] }), samples);
    assert.deepEqual(r.accepted.map(ruleKey), ['prefix:❤️']);
    assert.ok(r.rejected.some(x => /没有命中/.test(x.reason)));
    assert.ok(r.rejected.some(x => /通用排版标签/.test(x.reason)));
});

test('broad rules from one sample start switched off', () => {
    assert.equal(defaultEnabled({ rule: { type: 'tag', name: 'StatusBlock' }, samples: 1 }), true);
    assert.equal(defaultEnabled({ rule: { type: 'prefix', value: '结算：' }, samples: 1 }), true);
    assert.equal(defaultEnabled({ rule: { type: 'prefix', value: '📍' }, samples: 1 }), false);
    assert.equal(defaultEnabled({ rule: { type: 'bracket', open: '【' }, samples: 1 }), false);
    assert.equal(defaultEnabled({ rule: { type: 'kv' }, samples: 1 }), false);
    assert.equal(defaultEnabled({ rule: { type: 'prefix', value: '📍' }, samples: 2 }), true);
    assert.equal(defaultEnabled({ rule: { type: 'prefix', value: '他：' }, samples: 1 }), false);
    assert.equal(defaultEnabled({ rule: { type: 'prefix', value: '【记忆总结】' }, samples: 1 }), true);
});

test('adopted AI rules are re-checked when samples change', () => {
    const sc = scheme({ anchors: [anchorOf(SAMPLE_A, BODY_A)], aiRules: [{ rule: { type: 'prefix', value: '❤️' }, enabled: true }] });
    refreshAutoRules(sc);
    assert.equal(sc.aiRules[0].enabled, true);
    // A new sample where a ❤️ line is read: the AI rule must switch off.
    sc.anchors.push(anchorOf('❤️她笑着把花递给你。\n📍地点：花店', '❤️她笑着把花递给你。', 'a2'));
    refreshAutoRules(sc);
    assert.equal(sc.aiRules[0].enabled, false);
    assert.match(sc.aiRules[0].invalid, /要读的内容/);
});

test('scheme fingerprint changes with note, rules, few-shot and the excluded sample', () => {
    const sc = scheme({ anchors: [anchorOf(SAMPLE_A, BODY_A), anchorOf(SAMPLE_B, BODY_B, 'a2')] });
    refreshAutoRules(sc);
    const base = schemeFingerprint(sc);
    sc.note = '说明';
    const withNote = schemeFingerprint(sc);
    assert.notEqual(base, withNote);
    sc.autoRules[0].enabled = !sc.autoRules[0].enabled;
    assert.notEqual(schemeFingerprint(sc), withNote);
    sc.fewShot = true;
    const fs = schemeFingerprint(sc);
    assert.notEqual(fs, schemeFingerprint({ ...sc, fewShot: false }));
    assert.notEqual(schemeFingerprint(sc, 'a2'), fs);
    assert.equal(schemeFingerprint(null), '');
});

test('few-shot examples stay under the size budget, newest first', () => {
    // 30 lines of ~100 characters: segments are truncated per line, so size comes from line count.
    const long = Array.from({ length: 30 }, (_, i) => `第${i}行：${'她走过长长的街道，'.repeat(11)}`).join('\n');
    const anchors = Array.from({ length: 6 }, (_, i) => anchorOf(`结尾${i}\n${long}\n📍地点：${i}`, `结尾${i}\n${long}`, `a${i}`));
    const sc = scheme({ anchors, fewShot: true });
    const ex = buildExamples(sc, baseRules());
    const size = ex.reduce((n, e) => n + e.user.length + e.assistant.length, 0);
    assert.ok(ex.length >= 1 && ex.length < 6);
    assert.ok(size <= FEW_SHOT_MAX_CHARS || ex.length === 1);
    assert.match(ex[ex.length - 1].user, /结尾5/);
});

test('a sample text is answered by its own labels unless excluded', () => {
    const sc = scheme({ anchors: [anchorOf(SAMPLE_A, BODY_A)] });
    assert.equal(anchorFor(sc, SAMPLE_A)?.id, 'a1');
    assert.equal(anchorFor(sc, SAMPLE_A, 'a1'), null);
    assert.equal(anchorFor(sc, 'other'), null);
    assert.equal(anchorFor(null, SAMPLE_A), null);
});

test('stored generic-tag rules never take effect', async () => {
    const { effectiveRules } = await import('../src/scheme.js');
    const sc = scheme({ autoRules: [{ rule: { type: 'tag', name: 'div' }, enabled: true }], aiRules: [{ rule: { type: 'contentTag', name: 'p' }, enabled: true }] });
    assert.deepEqual(effectiveRules(sc), []);
    sc.anchors = [anchorOf(SAMPLE_A, BODY_A)];
    refreshAutoRules(sc);
    assert.equal(sc.aiRules[0].enabled, false);
    assert.match(sc.aiRules[0].invalid, /通用排版标签/);
});

test('alignBody tolerates words hidden by a display regex and lists them', () => {
    const text = [
        '📍地点：旧城区 | 时间：夜',
        '达妮娅眼尾弯起柔和的笑意，非但没有躲闪，反而伸出左手大拇指，极其自然地抹去你唇角沾着的一点深褐色猪排酱汁。',
        '❤️好感度：40',
        '“好吃吗？”她小声问道，眼睛亮亮的。',
    ].join('\n');
    const body = '达妮娅眼尾弯起柔和的笑意，非但没有躲闪，反而伸出左手大拇指，自然地抹去你唇角沾着的一点深褐色猪排酱汁。\n“好吃吗？”她问道，眼睛亮亮的。';
    const r = alignBody(text, body);
    assert.equal(r.ok, true, r.error);
    const read = [...r.labels].filter(([, l]) => !l.skip).map(([id]) => r.segments[id].line + 1);
    assert.deepEqual(read, [2, 4]);
    assert.deepEqual(r.diffs.map(d => [d.line, d.removed, d.added]), [[2, '极其', ''], [4, '小声', '']]);
    assert.match(r.diffs[0].before, /大拇指，$/);
});

test('alignBody does not mistake a status line for story text', () => {
    const text = '时间：夜晚 | 地点：酒馆\n夜晚的酒馆里，炉火正旺，时间仿佛停住了。';
    const r = alignBody(text, '夜晚的酒馆里，炉火正旺，时间仿佛停住了。');
    assert.equal(r.ok, true);
    assert.equal(r.labels.get(r.segments[0].id).skip, true);
    assert.equal(r.labels.get(r.segments[1].id).skip, false);
    assert.equal(r.diffs.length, 0);
});

test('alignBody reports text that is really not in the original', () => {
    const r = alignBody('她推开门。\n门外下着雨。', '她推开门。\n这是一段原文里完全没有的、很长很长的额外内容。');
    assert.equal(r.ok, false);
    assert.match(r.error, /找不到/);
});

test('alignBody: status-like lines sharing characters with the story are not read', () => {
    const text = [
        '地点：房间里的床边 | 状态：在发呆',
        '她在房间里的床边坐了一会儿，然后在发呆中睡着了。',
        '【她在房间里坐着发呆】',
    ].join('\n');
    const r = alignBody(text, '她在房间里的床边坐了一会儿，然后在发呆中睡着了。');
    assert.equal(r.ok, true, r.error);
    const read = [...r.labels].filter(([, l]) => !l.skip).map(([id]) => r.segments[id].line + 1);
    assert.deepEqual(read, [2]);
    assert.equal(r.diffs.length, 0);
});

test('alignBody: a scattered-character match is refused', () => {
    // Shares many single characters with the 正文 but no runs.
    const text = '的了在是我有他这中大来上\n她轻轻推开门，屋里的灯还亮着，桌上放着一封没有拆开的信。';
    const r = alignBody(text, '她轻轻推开门，屋里的灯还亮着，桌上放着一封没有拆开的信。');
    assert.equal(r.ok, true);
    assert.equal(r.labels.get(r.segments[0].id).skip, true);
});

test('alignBody: a few extra characters at the end of a line do not derail the next line', () => {
    const text = '她推开门，雨水顺着伞尖滴落下来。\n“我回来了，”她小声说，把伞靠在墙边。';
    const body = '她推开门，雨水顺着伞尖滴落下来啊。\n“我回来了，”她小声说，把伞靠在墙边。';
    const r = alignBody(text, body);
    assert.equal(r.ok, true, r.error);
    assert.equal([...r.labels.values()].every(l => !l.skip), true);
    assert.ok(r.diffs.some(d => d.added.includes('啊')));
});

test('analysis request collapses long "not read" blocks such as CSS', () => {
    const css = Array.from({ length: 400 }, (_, i) => `.c${i} { color: #${String(i).padStart(3, '0')}; margin: 0 auto; }`).join('\n');
    const text = `<style>\n${css}\n</style>\n她推开门，雨水顺着伞尖滴落。\n📍地点：旧城区`;
    const s = sampleFromBody(text, '她推开门，雨水顺着伞尖滴落。');
    const content = buildAnalysisMessages([s])[1].content;
    assert.ok(content.length < 2000, `too long: ${content.length}`);
    assert.match(content, /同一块里还有 \d+ 段，同样不读/);
    assert.match(content, /【读】 她推开门/);
    assert.match(content, /📍地点：旧城区/);
});

test('sample length limit is a setting', async () => {
    const { ANCHOR_MAX_CHARS_DEFAULT, ANCHOR_MAX_CHARS_MAX } = await import('../src/scheme.js');
    assert.equal(ANCHOR_MAX_CHARS_DEFAULT, 50000);
    assert.ok(ANCHOR_MAX_CHARS_MAX >= 100000);
});

test('parseAnalysis explains an empty answer from a thinking model', () => {
    assert.throws(() => parseAnalysis({ content: '', reasoning: '分析样例……' }, []), /思考上，正文是空的.*最大输出/);
});
