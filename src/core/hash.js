// Pure-JS string hashing. crypto.subtle is not available on plain-http LAN
// origins, so the cache keys are built from two seeded cyrb53 hashes plus the
// length (about 106 bits, enough to avoid accidental collisions).

/**
 * cyrb53 (public domain, by bryc).
 * @param {string} str
 * @param {number} [seed]
 * @returns {number}
 */
export function cyrb53(str, seed = 0) {
    let h1 = 0xdeadbeef ^ seed;
    let h2 = 0x41c6ce57 ^ seed;
    for (let i = 0; i < str.length; i++) {
        const ch = str.charCodeAt(i);
        h1 = Math.imul(h1 ^ ch, 2654435761);
        h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
    h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
    h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

/**
 * @param {string} str
 * @returns {string}
 */
export function hashString(str) {
    const s = String(str ?? '');
    return `${cyrb53(s).toString(36)}${cyrb53(s, 0x9e3779b9).toString(36)}${s.length.toString(36)}`;
}
