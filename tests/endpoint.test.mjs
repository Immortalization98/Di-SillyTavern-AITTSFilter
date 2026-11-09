import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// Minimal SillyTavern context + a fake /api/secrets backend.
const settings = {};
globalThis.SillyTavern = {
    getContext: () => ({ extensionSettings: settings, saveSettingsDebounced() { }, getRequestHeaders: () => ({}) }),
};

let store;      // [{ id, value, label, active }]
let failRotate; // number of rotate calls to fail
let failDelete;
let readBroken;
let calls;
let nextId;

function json(body, status = 200) {
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init?.body || '{}');
    calls.push([url, body]);
    switch (url) {
        case '/api/secrets/read':
            if (readBroken) return json({});
            return json({ api_key_custom: store.length ? store.map(x => ({ ...x, value: '****' + x.value.slice(-3) })) : null, api_key_openai: null });
        case '/api/secrets/write': {
            store.forEach(x => { x.active = false; });
            const id = `id${nextId++}`;
            store.push({ id, value: body.value, label: body.label, active: true });
            return json({ id });
        }
        case '/api/secrets/rotate':
            if (failRotate > 0) { failRotate--; return new Response('', { status: 500 }); }
            store.forEach(x => { x.active = x.id === body.id; });
            return new Response(null, { status: 204 });
        case '/api/secrets/delete': {
            if (failDelete) return new Response('', { status: 500 });
            const i = store.findIndex(x => x.id === body.id);
            const wasActive = store[i]?.active;
            if (i >= 0) store.splice(i, 1);
            if (wasActive && store.length && !store.some(x => x.active)) store[0].active = true;
            return new Response(null, { status: 204 });
        }
        default:
            return new Response('', { status: 404 });
    }
};

const { saveFilterKey, clearFilterKey, filterKeyStatus } = await import('../src/endpoint.js');
const { customSecretId, NO_SECRET_ID } = await import('../src/llm.js');
const { getSettings } = await import('../src/settings.js');

const active = () => store.find(x => x.active)?.id;

beforeEach(() => {
    for (const k of Object.keys(settings)) delete settings[k];
    store = [{ id: 'chat', value: 'chat-key-123', label: 'chat', active: true }];
    failRotate = 0;
    failDelete = false;
    readBroken = false;
    calls = [];
    nextId = 1;
});

test('no saved key -> a non-existent secret id, never empty', () => {
    const s = getSettings();
    assert.equal(customSecretId(s), NO_SECRET_ID);
    s.customSecretId = '';
    assert.equal(customSecretId(s), NO_SECRET_ID);
    s.customSecretId = 'abc';
    assert.equal(customSecretId(s), 'abc');
});

test('saving keeps the chat key active and stores only the id', async () => {
    const { warnings } = await saveFilterKey('filter-key-456');
    const s = getSettings();
    assert.equal(s.customSecretId, 'id1');
    assert.equal(active(), 'chat');
    assert.deepEqual(warnings, []);
    assert.equal(JSON.stringify(settings).includes('filter-key-456'), false);
    const st = await filterKeyStatus();
    assert.equal(st.saved, true);
    assert.match(st.masked, /^\*+/);
});

test('replacing the key deletes the old one and still keeps the chat key active', async () => {
    await saveFilterKey('first-key');
    await saveFilterKey('second-key');
    assert.deepEqual(store.map(x => x.id).sort(), ['chat', 'id2']);
    assert.equal(active(), 'chat');
    assert.equal(getSettings().customSecretId, 'id2');
});

test('rotate failing once is retried', async () => {
    failRotate = 1;
    const { warnings } = await saveFilterKey('k');
    assert.equal(active(), 'chat');
    assert.deepEqual(warnings, []);
});

test('rotate failing for good: id kept, warning given', async () => {
    failRotate = 99;
    const { warnings } = await saveFilterKey('k');
    assert.equal(getSettings().customSecretId, 'id1');
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /没能把聊天用的密钥切回去/);
});

test('no chat key yet: warning that the filter key is also the chat key', async () => {
    store = [];
    const { warnings } = await saveFilterKey('k');
    assert.equal(active(), 'id1');
    assert.match(warnings[0], /还没有自己的密钥/);
});

test('unreadable secret state is reported, not assumed safe', async () => {
    readBroken = true;
    const { warnings } = await saveFilterKey('k');
    assert.equal(getSettings().customSecretId, 'id1');
    assert.match(warnings[0], /无法确认/);
});

test('clear deletes only our key; a failed delete keeps the id', async () => {
    await saveFilterKey('k');
    failDelete = true;
    await assert.rejects(clearFilterKey());
    assert.equal(getSettings().customSecretId, 'id1');
    failDelete = false;
    await clearFilterKey();
    assert.equal(getSettings().customSecretId, '');
    assert.deepEqual(store.map(x => x.id), ['chat']);
});

test('plain key values (allowKeysExposure) are never shown', async () => {
    await saveFilterKey('k-plain');
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => url === '/api/secrets/read'
        ? json({ api_key_custom: store.map(x => ({ ...x })) })
        : realFetch(url, init);
    const st = await filterKeyStatus();
    globalThis.fetch = realFetch;
    assert.equal(st.saved, true);
    assert.equal(st.masked, '');
});

test('double click on save is refused while saving', async () => {
    const a = saveFilterKey('k1');
    await assert.rejects(saveFilterKey('k2'), /正在保存/);
    await a;
    assert.equal(store.filter(x => x.label === 'AI 朗读过滤').length, 1);
});

test('old filter key that could not be deleted never becomes the chat key', async () => {
    store = [];
    await saveFilterKey('old-filter');          // id1, active (no chat key yet)
    store.push({ id: 'chat', value: 'chat-key-123', label: 'chat', active: false });
    failDelete = true;
    const { warnings } = await saveFilterKey('new-filter'); // id2
    failDelete = false;
    assert.equal(active(), 'chat');
    assert.ok(warnings.some(w => /旧的过滤密钥没能删除/.test(w)));
});
