// Filter-result cache: memory + IndexedDB (SillyTavern's bundled localforage).
// Entries hold only skipped segment ids and categories, never chat text.

const DB_NAME = 'SillyTavern_AiTtsFilter';
const STORE_NAME = 'filter_results';
const MEMORY_LIMIT = 300;
const EVICT_EVERY_WRITES = 50;

/**
 * @typedef {object} CacheEntry
 * @property {(string|number)[][]} k  skipped segments: [id, category, 'rule'|'llm', tag?] (tag = a markup tag name)
 * @property {'rules'|'llm'|'fallback'} s   how the result was made
 * @property {number} t   created (ms)
 * @property {number} u   last used (ms)
 */

/** @type {any} */
let store = null;
/** @type {Map<string, CacheEntry>} */
const memory = new Map();
let writes = 0;

function getStore() {
    if (store) {
        return store;
    }
    const lf = /** @type {any} */ (globalThis).localforage;
    if (!lf?.createInstance) {
        return null;
    }
    store = lf.createInstance({ name: DB_NAME, storeName: STORE_NAME });
    return store;
}

function remember(key, entry) {
    memory.delete(key);
    memory.set(key, entry);
    while (memory.size > MEMORY_LIMIT) {
        memory.delete(memory.keys().next().value);
    }
}

/**
 * @param {string} key
 * @returns {Promise<CacheEntry|null>}
 */
export async function cacheGet(key) {
    let entry = memory.get(key) ?? null;
    if (!entry) {
        try {
            entry = (await getStore()?.getItem(key)) ?? null;
        } catch (error) {
            console.warn('[AI TTS Filter] cache read failed', error);
        }
    }
    if (!entry || !Array.isArray(entry.k)) {
        return null;
    }
    const now = Date.now();
    // Refresh "last used" at most once an hour to avoid write churn.
    if (now - (entry.u ?? 0) > 3600_000) {
        entry.u = now;
        getStore()?.setItem(key, entry).catch(() => { });
    }
    remember(key, entry);
    return entry;
}

/**
 * @param {string} key
 * @param {CacheEntry} entry
 * @param {{ maxEntries: number, maxDays: number }} limits
 */
export async function cacheSet(key, entry, limits) {
    remember(key, entry);
    try {
        await getStore()?.setItem(key, entry);
        if (++writes % EVICT_EVERY_WRITES === 1) {
            evict(limits).catch(error => console.warn('[AI TTS Filter] cache eviction failed', error));
        }
    } catch (error) {
        console.warn('[AI TTS Filter] cache write failed', error);
    }
}

/**
 * Drops entries older than maxDays (by last use), then the least recently used
 * ones above maxEntries.
 * @param {{ maxEntries: number, maxDays: number }} limits
 */
export async function evict(limits) {
    const s = getStore();
    if (!s) {
        return;
    }
    const cutoff = Date.now() - Math.max(1, Number(limits.maxDays) || 60) * 86400_000;
    /** @type {[string, number][]} */
    const alive = [];
    const expired = [];
    await s.iterate((value, key) => {
        const used = value?.u ?? value?.t ?? 0;
        if (used < cutoff) {
            expired.push(key);
        } else {
            alive.push([key, used]);
        }
    });
    const max = Math.max(100, Number(limits.maxEntries) || 3000);
    if (alive.length > max) {
        alive.sort((a, b) => a[1] - b[1]);
        expired.push(...alive.slice(0, alive.length - max).map(([key]) => key));
    }
    for (const key of expired) {
        memory.delete(key);
        await s.removeItem(key);
    }
}

export async function cacheCount() {
    try {
        return (await getStore()?.length()) ?? 0;
    } catch {
        return 0;
    }
}

export async function cacheClear() {
    memory.clear();
    await getStore()?.clear();
}

/** Removes the whole database (used by the manifest "clean" hook). */
export async function cacheDropDatabase() {
    memory.clear();
    const lf = /** @type {any} */ (globalThis).localforage;
    try {
        await lf?.dropInstance?.({ name: DB_NAME });
    } catch (error) {
        console.warn('[AI TTS Filter] could not drop cache database', error);
    }
    store = null;
}
