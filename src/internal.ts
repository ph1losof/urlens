// Module-private helpers shared between url.ts, query.ts, and view.ts.
// NOT re-exported from index.ts. Cross-module function calls are inlined by
// V8/SpiderMonkey/JSC once the call site warms up, so factoring these out
// does not regress the hot path.

export const CH_SLASH = 47;
const CH_QUESTION = 63;
const CH_HASH = 35;
export const CH_COLON = 58;
export const CH_OPEN_BRACKET = 91;
export const CH_0 = 48;
export const CH_9 = 57;
export const CH_AMP = 38;
const CH_EQ = 61;

// Finds the position of `key` as a complete query-string field name within
// `rawUrl[start..end)`. Returns the index where `key` begins, or -1 if no
// boundary-valid match exists.
//
// A field-name match requires:
//   • prev byte is '?' or '&' (param boundary)
//   • next byte (or end-of-range) is '=' or '&' (key name terminator)
//
// Two-stage scan:
//   1. Direct startsWith at `start` — covers the very common "key is the
//      first field of the query" shape with zero indexOf overhead.
//   2. Otherwise, one SIMD-vectorized String.prototype.indexOf(key) per
//      iteration. V8/SM/JSC implement small-needle search with vectorized
//      scans, so for long queries with the key near the end this is
//      dramatically faster than walking each field separately.
//
// `start` MUST point one past the '?' (so prev==='?' at start is implicit).
// Returns -1 when no match is found within the range.
// fallow-ignore-next-line complexity
export function findKeyMatch(
  rawUrl: string,
  start: number,
  end: number,
  key: string
): number {
  const keyLen = key.length;
  // Stage 1: first-field probe. prev is implicitly '?' by the contract.
  const after0 = start + keyLen;
  if (after0 <= end && rawUrl.startsWith(key, start)) {
    if (after0 === end) {
      return start;
    }
    const next0 = rawUrl.charCodeAt(after0);
    if (next0 === CH_EQ || next0 === CH_AMP) {
      return start;
    }
  }
  // Stage 2: SIMD indexOf scan over the remaining range.
  let pos = start + 1;
  while (pos < end) {
    const idx = rawUrl.indexOf(key, pos);
    if (idx === -1 || idx + keyLen > end) {
      return -1;
    }
    const prev = rawUrl.charCodeAt(idx - 1);
    if (prev === CH_QUESTION || prev === CH_AMP) {
      const after = idx + keyLen;
      if (after === end) {
        return idx;
      }
      const next = rawUrl.charCodeAt(after);
      if (next === CH_EQ || next === CH_AMP) {
        return idx;
      }
    }
    pos = idx + 1;
  }
  return -1;
}

// Returns the index of the first '/', '?', or '#' at or after `start`, or the
// string length if none are present. One linear pass — faster than three
// separate indexOf calls when the authority is short, and never worse.
// fallow-ignore-next-line complexity
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
// fallow-ignore-next-line complexity
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
// fallow-ignore-next-line complexity
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
