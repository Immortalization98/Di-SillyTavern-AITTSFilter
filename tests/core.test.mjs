import { test } from 'node:test';
import assert from 'node:assert/strict';

import { segmentText } from '../src/core/segmenter.js';
import { applyRules, parseTagList, parseRegexList, DEFAULT_SKIP_TAGS, DEFAULT_CONTENT_TAGS } from '../src/core/rules.js';
import { buildBatches, parseAnswer, truncateMiddle } from '../src/core/prompt.js';
import { applyRanges, skipRanges, isSubsequence } from '../src/core/compose.js';
import { runFilter, composeOutput } from '../src/core/pipeline.js';
import { hashString } from '../src/core/hash.js';

const rulesCfg = (over = {}) => ({
    skipTags: DEFAULT_SKIP_TAGS,
    contentTagMode: true,
    contentTags: DEFAULT_CONTENT_TAGS,
    skipCode: true,
    skipComments: true,
    skipImages: true,
    skipTables: true,
    skipDecor: true,
    keepRegex: [],
    skipRegex: [],
    ...over,
});

const view = (text, segs) => segs.map(s => [s.kind, text.slice(s.start, s.end), s.path.join('/')]);

test('segments cover tags, nesting, CJK tag names and plain lines', () => {
    const text = '<thinking>想一想\n再想</thinking>\n她笑了。\n<content>\n“你好。”<状态栏>好感：5</状态栏>\n</content>';
    const segs = segmentText(text);
    assert.deepEqual(view(text, segs), [
        ['markup', '<thinking>', ''],
        ['text', '想一想', 'thinking'],
        ['text', '再想', 'thinking'],
        ['markup', '</thinking>', ''],
        ['text', '她笑了。', ''],
        ['markup', '<content>', ''],
        ['text', '“你好。”', 'content'],
        ['markup', '<状态栏>', 'content'],
        ['text', '好感：5', 'content/状态栏'],
        ['markup', '</状态栏>', 'content'],
        ['markup', '</content>', ''],
    ]);
    segs.forEach((s, i) => assert.equal(s.id, i));
});

test('unclosed tags become markup only and hold no children', () => {
    const text = '<content>正文开始\n还没结束';
    const segs = segmentText(text);
    assert.deepEqual(view(text, segs), [
        ['markup', '<content>', ''],
        ['text', '正文开始', ''],
        ['text', '还没结束', ''],
    ]);
});

test('mismatched close pops unclosed inner tags', () => {
    const text = '<a>x<b>y</a>z';
    assert.deepEqual(view(text, segmentText(text)), [
        ['markup', '<a>', ''],
        ['text', 'x', 'a'],
        ['markup', '<b>', 'a'],
        ['text', 'y', 'a'],
        ['markup', '</a>', ''],
        ['text', 'z', ''],
    ]);
});

test('code fences and comments are opaque; tags inside are ignored', () => {
    const text = '前\n```js\nconst a = "<b>";\n```\n<!-- <status>x</status> -->后';
    assert.deepEqual(view(text, segmentText(text)), [
        ['text', '前', ''],
        ['code', '```js\nconst a = "<b>";\n```', ''],
        ['comment', '<!-- <status>x</status> -->', ''],
        ['text', '后', ''],
    ]);
});

test('unclosed fence runs to the end; unclosed comment is text', () => {
    const t1 = 'a\n~~~\nb';
    assert.deepEqual(view(t1, segmentText(t1)), [['text', 'a', ''], ['code', '~~~\nb', '']]);
    const t2 = 'x <!-- y';
    assert.deepEqual(view(t2, segmentText(t2)), [['text', 'x <!-- y', '']]);
});

test('inline brackets split lines; Markdown links stay; images detected', () => {
    const text = '她笑了。【好感度+5】看[链接](http://a) {"hp":3} ![图](x.png) [时间：夜]';
    assert.deepEqual(view(text, segmentText(text)), [
        ['text', '她笑了。', ''],
        ['bracket', '【好感度+5】', ''],
        ['text', '看[链接](http://a)', ''],
        ['bracket', '{"hp":3}', ''],
        ['image', '![图](x.png)', ''],
        ['bracket', '[时间：夜]', ''],
    ]);
});

test('void and self-closing tags; comparisons are not tags', () => {
    const text = '一<br>二<img src="a.png"/>三 a < b <3';
    assert.deepEqual(view(text, segmentText(text)), [
        ['text', '一', ''],
        ['markup', '<br>', ''],
        ['text', '二', ''],
        ['image', '<img src="a.png"/>', ''],
        ['text', '三 a < b <3', ''],
    ]);
});

test('rules: skip tags, content mode, code, tables, decor, regex', () => {
    const text = '前言\n<content>\n正文\n| a | b |\n———\n[选项]\n</content>\n<thinking>t</thinking>\n```\nx\n```';
    const segs = segmentText(text);
    const decided = applyRules(text, segs, rulesCfg({ skipRegex: parseRegexList('/^\\[选项\\]$/').regexes }));
    const byText = Object.fromEntries(segs.map(s => [text.slice(s.start, s.end), decided.get(s.id)?.cat ?? null]));
    assert.equal(byText['前言'], 'outside');
    assert.equal(byText['正文'], null);
    assert.equal(byText['| a | b |'], 'table');
    assert.equal(byText['———'], 'decor');
    assert.equal(byText['[选项]'], 'regex');
    assert.equal(byText['t'], 'tag');
    assert.equal(byText['```\nx\n```'], 'outside');
});

test('rules: keep regex beats skip tags; content mode off keeps outside text undecided', () => {
    const text = '外面<thinking>重要台词</thinking>';
    const segs = segmentText(text);
    const decided = applyRules(text, segs, rulesCfg({ keepRegex: parseRegexList('重要').regexes, contentTagMode: false }));
    assert.equal(decided.get(1).cat, 'markup');
    assert.equal(decided.get(2).cat, 'keep');
    assert.equal(decided.has(0), false);
});

test('parseTagList and parseRegexList', () => {
    assert.deepEqual(parseTagList('Think, 思考，status  status'), ['think', '思考', 'status']);
    const { regexes, errors } = parseRegexList('/abc/gi\n(\nplain');
    assert.equal(regexes.length, 2);
    assert.equal(regexes[0].flags, 'i');
    assert.equal(errors.length, 1);
});

test('buildBatches numbers undecided segments and adds placeholders', () => {
    const text = '<thinking>a\nb</thinking>\n她说：“走吧。”\n【好感+1】';
    const segs = segmentText(text);
    const decided = applyRules(text, segs, rulesCfg());
    const batches = buildBatches(text, segs, decided, {});
    assert.equal(batches.length, 1);
    const user = batches[0].messages[1].content;
    assert.match(user, /\[已跳过：thinking 块\]\n\[1\] 她说：“走吧。”\n\[2\] 【好感\+1】/);
    assert.equal(user.match(/已跳过/g).length, 1);
    assert.deepEqual(batches[0].ids.map(id => text.slice(segs[id].start, segs[id].end)), ['她说：“走吧。”', '【好感+1】']);
});

test('buildBatches splits by budget and truncates long segments', () => {
    const long = '字'.repeat(500);
    const text = `${long}\n${long}\n${long}`;
    const segs = segmentText(text);
    const batches = buildBatches(text, segs, new Map(), { maxSegmentChars: 100, maxBatchChars: 250 });
    assert.equal(batches.length, 2);
    assert.match(batches[0].messages[1].content, /中间省略 400 字/);
    assert.equal(truncateMiddle('abcdef', 10), 'abcdef');
});

test('parseAnswer tolerates fences, think blocks, shorthand, ranges and junk ids', () => {
    assert.deepEqual([...parseAnswer('```json\n{"skip":{"think":[1,2],"status":["4"]}}\n```', 5)], [[1, 'think'], [2, 'think'], [4, 'status']]);
    assert.deepEqual([...parseAnswer('<think>{"skip":[9]}</think>好的：{"skip":[1, 99, 0, "x"]}', 3)], [[1, 'other']]);
    assert.deepEqual([...parseAnswer({ content: '{"skip":{"weird":["2-3"]}}', reasoning: '{"skip":[1]}' }, 3)], [[2, 'other'], [3, 'other']]);
    assert.deepEqual([...parseAnswer('[3]', 3)], [[3, 'other']]);
    assert.equal(parseAnswer('{"skip":{}}', 3).size, 0);
    assert.throws(() => parseAnswer('我觉得都该读', 3), /没有 JSON/);
    assert.throws(() => parseAnswer('{"skip": [1,}', 3));
});

test('applyRanges deletes, drops emptied lines, keeps paragraph breaks', () => {
    const text = '第一段。【状态】\n<s>x</s>\n\n第二段';
    const segs = segmentText(text);
    const skip = new Set(segs.filter(s => /【|<|x/.test(text.slice(s.start, s.end))).map(s => s.id));
    const out = applyRanges(text, skipRanges(segs, skip));
    assert.equal(out, '第一段。\n\n第二段');
    assert.ok(isSubsequence(out, text));
    assert.equal(applyRanges('abc\ndef', [], 4), 'def');
    assert.equal(isSubsequence('ac', 'abc'), true);
    assert.equal(isSubsequence('ca', 'abc'), false);
});

test('runFilter uses rules only when nothing is left for the model', async () => {
    let calls = 0;
    const r = await runFilter('<thinking>x</thinking>', { mode: 'llm', rules: rulesCfg(), classify: async () => { calls++; return '{}'; } });
    assert.equal(calls, 0);
    assert.equal(r.source, 'rules');
});

test('runFilter applies the model answer and composes the text', async () => {
    const text = '<thinking>想</thinking>\n她推开门。\n“早。”\n力量检定：12+3=15，成功\n【时间：清晨】';
    const r = await runFilter(text, {
        mode: 'llm',
        rules: rulesCfg(),
        classify: async (messages) => {
            assert.match(messages[1].content, /\[3\] 力量检定/);
            return '{"skip":{"calc":[3],"status":[4]}}';
        },
    });
    assert.equal(r.source, 'llm');
    assert.equal(composeOutput(text, r.segments, r.decisions), '她推开门。\n“早。”');
    const cats = [...r.decisions.values()].map(d => d.cat);
    assert.ok(cats.includes('calc') && cats.includes('status') && cats.includes('tag'));
});

test('runFilter falls back on errors and on the all-skipped guard; abort rethrows', async () => {
    const text = `${'正文'.repeat(200)}\n另一段`;
    const broken = await runFilter(text, { mode: 'llm', rules: rulesCfg(), classify: async () => 'nope' });
    assert.equal(broken.source, 'fallback');
    assert.match(broken.error, /JSON/);

    const greedy = await runFilter(text, { mode: 'llm', rules: rulesCfg(), classify: async () => '{"skip":[1,2]}' });
    assert.equal(greedy.source, 'fallback');

    const small = await runFilter('【HP：5】', { mode: 'llm', rules: rulesCfg(), classify: async () => '{"skip":{"status":[1]}}' });
    assert.equal(small.source, 'llm');
    assert.equal(composeOutput('【HP：5】', small.segments, small.decisions), '');

    const ac = new AbortController();
    await assert.rejects(runFilter('正文', {
        mode: 'llm', rules: rulesCfg(), signal: ac.signal,
        classify: async () => { ac.abort(); throw new Error('aborted'); },
    }));
});

test('continue: read only what follows the old length', () => {
    const text = '旧的一段。\n新的一段。【状态】';
    const segs = segmentText(text);
    const skip = new Set([segs.find(s => s.kind === 'bracket').id]);
    assert.equal(composeOutput(text, segs, skip, '旧的一段。\n'.length), '新的一段。');
});

test('hashString is stable and distinguishes inputs', () => {
    assert.equal(hashString('abc'), hashString('abc'));
    assert.notEqual(hashString('abc'), hashString('abd'));
    assert.notEqual(hashString(''), hashString(' '));
});

test('fuzz: output is always a subsequence and segments never overlap', () => {
    const parts = ['<a>', '</a>', '<状态栏>', '</状态栏>', '```', '\n', '【x】', '[y]', '{z}', '<!--', '-->', '文字', ' ', '<br>', '![i](u)', '~~~', '|', '<'];
    let seed = 7;
    const rnd = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
    for (let round = 0; round < 500; round++) {
        let text = '';
        for (let i = 0, n = rnd(30); i < n; i++) text += parts[rnd(parts.length)];
        const segs = segmentText(text);
        for (let i = 1; i < segs.length; i++) {
            assert.ok(segs[i].start >= segs[i - 1].end, `overlap in ${JSON.stringify(text)}`);
        }
        const skip = new Set(segs.filter(() => rnd(2)).map(s => s.id));
        const out = composeOutput(text, segs, skip);
        assert.ok(isSubsequence(out, text));
    }
});

test('parseAnswer explains empty or cut-off answers from thinking models', () => {
    assert.throws(() => parseAnswer({ content: '', reasoning: '先看第一段……' }, 3), /思考上，正文是空的.*最大输出/);
    assert.throws(() => parseAnswer('', 3), /正文是空的.*最大输出/);
    assert.throws(() => parseAnswer('<think>先看第一段，再看', 3), /还在思考.*最大输出/);
    assert.throws(() => parseAnswer('{"skip":{"think":[1,', 3), /截断.*最大输出/);
    assert.throws(() => parseAnswer('我觉得都该读', 3), /^Error: 模型回答里没有 JSON$/);
});
