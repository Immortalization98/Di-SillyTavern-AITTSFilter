import { test } from 'node:test';
import assert from 'node:assert/strict';

const extensionSettings = {};
globalThis.SillyTavern = {
    getContext: () => ({ extensionSettings, saveSettingsDebounced() { } }),
};

const { getSettings, SETTINGS_KEY, DEFAULT_SETTINGS } = await import('../src/settings.js');

test('new installs get the roomy output limit', () => {
    delete extensionSettings[SETTINGS_KEY];
    assert.equal(getSettings().maxTokens, 8192);
    assert.equal(getSettings().timeoutSec, 60);
    assert.equal(DEFAULT_SETTINGS.maxTokens, 8192);
});

test('the old 1024 default is raised once, other values are kept', () => {
    extensionSettings[SETTINGS_KEY] = { maxTokens: 1024 };
    assert.equal(getSettings().maxTokens, 8192);

    extensionSettings[SETTINGS_KEY] = { maxTokens: 2048 };
    assert.equal(getSettings().maxTokens, 2048);

    // Set back to 1024 by hand after upgrading: left alone.
    const s = getSettings();
    s.maxTokens = 1024;
    assert.equal(getSettings().maxTokens, 1024);
});

test('the old 30 second timeout is raised once, other values are kept', () => {
    extensionSettings[SETTINGS_KEY] = { timeoutSec: 30, maxTokens: 4000 };
    const s = getSettings();
    assert.equal(s.timeoutSec, 60);
    assert.equal(s.maxTokens, 4000);

    extensionSettings[SETTINGS_KEY] = { timeoutSec: 90 };
    assert.equal(getSettings().timeoutSec, 90);

    // Settings already upgraded to version 2 still get the timeout step.
    extensionSettings[SETTINGS_KEY] = { settingsVersion: 2, maxTokens: 1024, timeoutSec: 30 };
    const t = getSettings();
    assert.equal(t.maxTokens, 1024);
    assert.equal(t.timeoutSec, 60);
});
