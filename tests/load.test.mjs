// The browser modules (src/*.js) need SillyTavern and are not imported by the
// other tests. This checks that every module parses and that every name it
// imports from another module of the extension is exported there, so a broken
// file cannot be released again (1.1.0 shipped with a duplicate import).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'src');
/** @param {string} dir @returns {string[]} */
const listJs = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const p = join(dir, e.name);
    return e.isDirectory() ? listJs(p) : e.name.endsWith('.js') ? [p] : [];
});
const files = listJs(root);

test('every module parses', () => {
    assert.ok(files.length > 10);
    for (const file of files) {
        const r = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
        assert.equal(r.status, 0, `${file}\n${r.stderr}`);
    }
});

test('every imported name is exported by its module', () => {
    const escape = (s) => s.replace(/[$]/g, '\\$');
    for (const file of files) {
        const src = readFileSync(file, 'utf8');
        for (const m of src.matchAll(/import\s*\{([^}]*)\}\s*from\s*'(\.[^']+)'/g)) {
            const target = readFileSync(resolve(dirname(file), m[2]), 'utf8');
            const names = m[1].split(',').map(s => s.trim().split(/\s+as\s+/)[0]).filter(Boolean);
            for (const name of names) {
                const n = escape(name);
                const re = new RegExp(String.raw`export\s+(async\s+)?(function\*?|const|let|class|var)\s+${n}\b|export\s*\{[^}]*\b${n}\b`);
                assert.match(target, re, `${file} imports ${name} from ${m[2]}, which does not export it`);
            }
        }
    }
});
