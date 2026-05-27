// Module-private helpers shared between url.ts, query.ts, and view.ts.
// NOT re-exported from index.ts. Cross-module function calls are inlined by
// V8/SpiderMonkey/JSC once the call site warms up, so factoring these out
// does not regress the hot path.

export const CH_SLASH = 47;
export const CH_QUESTION = 63;
export const CH_HASH = 35;
export const CH_COLON = 58;
export const CH_OPEN_BRACKET = 91;
export const CH_AT = 64;
export const CH_0 = 48;
export const CH_9 = 57;

// Returns the index of the first '/', '?', or '#' at or after `start`, or the
// string length if none are present. One linear pass — faster than three
// separate indexOf calls when the authority is short, and never worse.
export function findAuthorityEnd(rawUrl: string, start: number): number {
  const len = rawUrl.length;
  for (let i = start; i < len; i++) {
    const c = rawUrl.charCodeAt(i);
    if (c === CH_SLASH || c === CH_QUESTION || c === CH_HASH) {
      return i;
    }
  }
  return len;
}

// Returns the WHATWG default port for a "special" scheme: http=80, https=443,
// ws=80, wss=443, ftp=21. Returns -1 for any other scheme. Case-insensitive
// ASCII byte compare; no allocation. `schemeEnd` is the length of the scheme
// (i.e. the index of the first ':' in "scheme://...").
export function defaultPortFor(rawUrl: string, schemeEnd: number): number {
  if (schemeEnd === 5) {
    if (
      (rawUrl.charCodeAt(0) | 32) === 104 /* h */ &&
      (rawUrl.charCodeAt(1) | 32) === 116 /* t */ &&
      (rawUrl.charCodeAt(2) | 32) === 116 /* t */ &&
      (rawUrl.charCodeAt(3) | 32) === 112 /* p */ &&
      (rawUrl.charCodeAt(4) | 32) === 115 /* s */
    ) {
      return 443;
    }
    return -1;
  }
  if (schemeEnd === 4) {
    if (
      (rawUrl.charCodeAt(0) | 32) === 104 /* h */ &&
      (rawUrl.charCodeAt(1) | 32) === 116 /* t */ &&
      (rawUrl.charCodeAt(2) | 32) === 116 /* t */ &&
      (rawUrl.charCodeAt(3) | 32) === 112 /* p */
    ) {
      return 80;
    }
    return -1;
  }
  if (schemeEnd === 3) {
    const c0 = rawUrl.charCodeAt(0) | 32;
    if (
      c0 === 102 /* f */ &&
      (rawUrl.charCodeAt(1) | 32) === 116 /* t */ &&
      (rawUrl.charCodeAt(2) | 32) === 112 /* p */
    ) {
      return 21; // ftp
    }
    if (
      c0 === 119 /* w */ &&
      (rawUrl.charCodeAt(1) | 32) === 115 /* s */ &&
      (rawUrl.charCodeAt(2) | 32) === 115 /* s */
    ) {
      return 443; // wss
    }
    return -1;
  }
  if (schemeEnd === 2) {
    if (
      (rawUrl.charCodeAt(0) | 32) === 119 /* w */ &&
      (rawUrl.charCodeAt(1) | 32) === 115 /* s */
    ) {
      return 80; // ws
    }
    return -1;
  }
  return -1;
}

// Parses ASCII digits in `[start, end)` as a decimal integer. Returns -1 on
// empty range or any non-digit content. No allocation.
export function parsePortRange(s: string, start: number, end: number): number {
  if (start >= end) {
    return -1;
  }
  let port = 0;
  for (let i = start; i < end; i++) {
    const c = s.charCodeAt(i);
    if (c < CH_0 || c > CH_9) {
      return -1;
    }
    port = port * 10 + (c - CH_0);
  }
  return port;
}
