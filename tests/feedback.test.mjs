import { test } from 'node:test';
import assert from 'node:assert/strict';
import { segmentText } from '../src/core/segmenter.js';
import {
    buildFeedbackMessages, parseFeedback, applyChanges, checkFeedbackRules, mergeNote, skippedCount, FEEDBACK_NOTE_MAX_CHARS,
} from '../src/core/feedback.js';

const TEXT = [
    '她推开门，雨还在下。',
    '【好感度：12 | 信任：3】',
    '“你回来了。”',
    '『他怎么现在才来……』',
    '<status>',
    '时间：夜',
    '地点：旧屋',
    '天气：雨',
    '</status>',
].join('\n');

/** Labels as a filter would leave them: the status block and the 【】 line not read. */
function startLabels(segments, text) {
    const labels = new Map();
    for (const seg of segments) {
        if (seg.kind === 'markup') continue;
        const body = text.slice(seg.start, seg.end);
        const skip = seg.path.includes('status') || body.startsWith('『');
        labels.set(seg.id, skip ? { skip: true, cat: seg.path.includes('status') ? 'status' : 'other' } : { skip: false, cat: 'read' });
    }
    return labels;
}

test('the request numbers every segment, collapses a not-read block and carries the opinion', () => {
    const segments = segmentText(TEXT);
    const labels = startLabels(segments, TEXT);
    const { messages, ids } = buildFeedbackMessages({ text: TEXT, segments, labels, opinion: '『』里的心声要读，【好感度】那行不要读', note: '旧说明', rules: [{ type: 'tag', name: 'status' }] });
    assert.equal(messages[0].role, 'system');
    const user = messages[1].content;
    assert.equal(ids.length, segments.filter(s => s.kind !== 'markup').length);
    assert.match(user, /1\. 【读】 她推开门/);
    assert.match(user, /4\. 【不读·other】 『他怎么/);
    assert.match(user, /5-7\. 【不读·status】 ‹status› 时间：夜（同一块共 3 段，都不读）/);
    assert.match(user, /用户的意见：『』里的心声要读/);
    assert.match(user, /已有的格式说明：旧说明/);
    assert.match(user, /<status> 标签里的内容整块不读/);
});

test('segments the user changed by hand are marked and never collapsed', () => {
    const segments = segmentText(TEXT);
    const labels = startLabels(segments, TEXT);
    const statusIds = segments.filter(s => s.kind !== 'markup' && s.path.includes('status')).map(s => s.id);
    const edited = new Set([statusIds[1]]);
    const { messages } = buildFeedbackMessages({ text: TEXT, segments, labels, opinion: '', edited });
    const user = messages[1].content;
    assert.match(user, /5\. 【不读·status】 ‹status› 时间：夜/);
    assert.match(user, /6\. 【不读·status】（用户已改） ‹status› 地点：旧屋/);
    assert.match(user, /7\. 【不读·status】 ‹status› 天气：雨/);
    assert.match(user, /只亲手改了/);
});

test('the answer becomes real changes only; ranges, unknown categories and conflicts handled', () => {
    const segments = segmentText(TEXT);
    const labels = startLabels(segments, TEXT);
    const { ids } = buildFeedbackMessages({ text: TEXT, segments, labels, opinion: 'x' });
    const answer = {
        content: '<think>想想</think>```json\n{"read":[4,1,"6-7"],"skip":{"status":[2],"weird":[3],"other":[7]},"rules":[{"type":"prefix","value":"【好感度"}],"note":"『』包着的是角色心声，要读。\\n"}\n```',
    };
    const parsed = parseFeedback(answer, ids, labels);
    // 1 is already read; 7 is told both ways; 6 changes to read; 2 and 3 change to not read.
    assert.deepEqual([...parsed.changes].map(([id, l]) => [ids.indexOf(id) + 1, l.skip, l.cat]).sort((a, b) => a[0] - b[0]), [
        [2, true, 'status'], [3, true, 'other'], [4, false, 'read'], [6, false, 'read'],
    ]);
    assert.equal(parsed.rules.length, 1);
    assert.equal(parsed.note, '『』包着的是角色心声，要读。');
});

test('answers without JSON, or of the wrong shape, are errors; long notes are cut', () => {
    assert.throws(() => parseFeedback('好的', [0], new Map()), /没有 JSON/);
    assert.throws(() => parseFeedback('[1,2]', [0], new Map()), /格式不对/);
    const parsed = parseFeedback(JSON.stringify({ note: '字'.repeat(300), read: [99, 'x', '5-2'] }), [0], new Map([[0, { skip: true, cat: 'other' }]]));
    assert.equal(Array.from(parsed.note).length, FEEDBACK_NOTE_MAX_CHARS);
    assert.equal(parsed.changes.size, 0);
});

test('applying changes leaves the original verdicts untouched', () => {
    const labels = new Map([[0, { skip: false, cat: 'read' }], [1, { skip: true, cat: 'status' }]]);
    const out = applyChanges(labels, new Map([[1, { skip: false, cat: 'read' }], [9, { skip: true, cat: 'other' }]]));
    assert.equal(labels.get(1)?.skip, true);
    assert.deepEqual([...out], [[0, { skip: false, cat: 'read' }], [1, { skip: false, cat: 'read' }]]);
    assert.equal(skippedCount(out), 0);
    assert.equal(skippedCount(labels), 1);
});

test('rules are checked on this message and on the other samples', () => {
    const segments = segmentText(TEXT);
    const labels = startLabels(segments, TEXT);
    const { ids } = buildFeedbackMessages({ text: TEXT, segments, labels, opinion: 'x' });
    const fixed = applyChanges(labels, parseFeedback('{"read":[4],"skip":{"status":[2]}}', ids, labels).changes);
    const message = { text: TEXT, segments, labels: fixed };

    const otherText = '【好感度：1 | 信任：0】\n【好感度提升了】他笑着说。';
    const otherSegs = segmentText(otherText);
    const other = { text: otherText, segments: otherSegs, labels: new Map(otherSegs.map(s => [s.id, { skip: otherText.slice(s.start, s.end).startsWith('【好感度：'), cat: 'status' }])) };
    for (const [id, l] of other.labels) if (!l.skip) other.labels.set(id, { skip: false, cat: 'read' });

    const raw = [
        { type: 'kv' },                         // fine: the 【好感度：12 | 信任：3】 line, and the one in the other sample
        { type: 'prefix', value: '【好感度' },   // also skips "【好感度提升了】…" in the other sample, which is read
        { type: 'bracket', open: '【' },         // the same
        { type: 'prefix', value: '“' },          // unsafe shape
        { type: 'tag', name: 'div' },            // generic tag
        { type: 'tag', name: 'status' },         // already in the scheme
        { type: 'prefix', value: '没有的开头' }, // hits nothing here
        { type: 'kv' },                          // duplicate: ignored
        'junk',
    ];
    const result = checkFeedbackRules(raw, { message, others: [other], existing: new Set(['tag:status']) });
    assert.deepEqual(result.accepted.map(r => [r.key, r.hits, r.otherHits, r.otherSamples]), [['kv', 1, 1, 1]]);
    const reasons = Object.fromEntries(result.rejected.map(r => [r.text.slice(0, 12), r.reason]));
    assert.equal(result.rejected.length, 7);
    assert.match(result.rejected[0].reason, /另外 1 份样例中 1 段要读/);
    assert.match(result.rejected[1].reason, /另外 1 份样例/);
    assert.ok(Object.values(reasons).some(r => /格式不认识/.test(r)));
    assert.ok(Object.values(reasons).some(r => /通用排版标签/.test(r)));
    assert.ok(Object.values(reasons).some(r => /已经有这条规则/.test(r)));
    assert.ok(Object.values(reasons).some(r => /一处都没有命中/.test(r)));
});

test('a rule that would skip a part of this message that is read is refused', () => {
    const segments = segmentText(TEXT);
    const labels = startLabels(segments, TEXT); // the 【好感度…】 line is still read here
    const result = checkFeedbackRules([{ type: 'kv' }], { message: { text: TEXT, segments, labels }, others: [], existing: new Set() });
    assert.equal(result.accepted.length, 0);
    assert.match(result.rejected[0].reason, /这条消息里 1 段要读/);
});

test('a note line is added once', () => {
    assert.equal(mergeNote('', ' 新的一句 '), '新的一句');
    assert.equal(mergeNote('旧的', '新的'), '旧的\n新的');
    assert.equal(mergeNote('旧的\n新的', '新的'), '旧的\n新的');
    assert.equal(mergeNote('旧的', ''), '旧的');
});

test('the "sample" kind asks only for changed verdicts and ignores rules and notes in the answer', () => {
    const segments = segmentText(TEXT);
    const labels = startLabels(segments, TEXT);
    const { messages, ids } = buildFeedbackMessages({ text: TEXT, segments, labels, opinion: '『』要读', note: '旧说明', rules: [{ type: 'tag', name: 'status' }], solidify: false });
    assert.match(messages[0].content, /不用总结规则/);
    assert.doesNotMatch(messages[0].content, /"rules"/);
    assert.doesNotMatch(messages[1].content, /已有的格式说明|已有的规则/);
    assert.match(messages[1].content, /用户的意见：『』要读/);
    const parsed = parseFeedback('{"read":[4],"rules":[{"type":"kv"}],"note":"不该出现"}', ids, labels, { solidify: false });
    assert.equal(parsed.changes.size, 1);
    assert.deepEqual(parsed.rules, []);
    assert.equal(parsed.note, '');
});
