export const CH_SLASH = 47;
export const CH_QUESTION = 63;
export const CH_HASH = 35;
export const CH_COLON = 58;
export const CH_OPEN_BRACKET = 91;
export const CH_0 = 48;
export const CH_9 = 57;
export const CH_AMP = 38;
const CH_EQ = 61;
const CH_AT = 64;

// RFC 3986 scheme-continuation characters, indexed by ASCII code.
const SCHEME_CONT = new Uint8Array(128);
for (let c = 48 /* 0 */; c <= 57 /* 9 */; c++) {
  SCHEME_CONT[c] = 1;
}
for (let c = 65 /* A */; c <= 90 /* Z */; c++) {
  SCHEME_CONT[c] = 1;
}
for (let c = 97 /* a */; c <= 122 /* z */; c++) {
  SCHEME_CONT[c] = 1;
}
SCHEME_CONT[43] = 1; // +
SCHEME_CONT[45] = 1; // -
SCHEME_CONT[46] = 1; // .

// Returns the index of a valid hierarchical scheme's "://" separator, or -1.
// Validating the scheme alphabet prevents embedded "://" in a path, query, or
// fragment from being mistaken for the URL's scheme.
export function findSchemeEnd(rawUrl: string): number {
  const c0 = rawUrl.charCodeAt(0) | 32; // ASCII lowercase; empty input becomes 32.
  if (c0 < 97 || c0 > 122) {
    return -1;
  }
  const len = rawUrl.length;
  for (let i = 1; i < len; i++) {
    const c = rawUrl.charCodeAt(i);
    if (c < 97 || c > 122) {
      if (c === CH_COLON) {
        // Only hierarchical schemes with "//" are recognized.
        return rawUrl.charCodeAt(i + 1) === CH_SLASH &&
          rawUrl.charCodeAt(i + 2) === CH_SLASH
          ? i
          : -1;
      }
      if (c > 127 || SCHEME_CONT[c] === 0) {
        return -1;
      }
    }
  }
  return -1;
}

// Finds `key` at a complete query-field boundary in `rawUrl[start, end)`.
// `start` must point immediately after `?`; returns -1 if no match exists.
// fallow-ignore-next-line complexity
export function findKeyMatch(
  rawUrl: string,
  start: number,
  end: number,
  key: string
): number {
  const keyLen = key.length;
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
  let pos = start + 1;
  let match = -1;
  while (pos < end) {
    const idx = rawUrl.indexOf(key, pos);
    if (idx === -1 || idx + keyLen > end) {
      return -1;
    }
    const prev = rawUrl.charCodeAt(idx - 1);
    if (prev === CH_QUESTION || prev === CH_AMP) {
      const after = idx + keyLen;
      const next = after === end ? CH_EQ : rawUrl.charCodeAt(after);
      if (next === CH_EQ || next === CH_AMP) {
        match = idx;
        pos = end;
      } else {
        pos = idx + 1;
      }
    } else {
      pos = idx + 1;
    }
  }
  return match;
}

// Packing base for authority offsets; longer URLs use length + 1.
// 2^21 keeps common packed offsets in the 31-bit integer range.
export const AUTH_PACK = 0x200000; // 2^21

// Returns `(lastAt + 1) * base + authEnd`, using the caller's base.
// `lastAt` is the last literal `@` before the authority boundary. Decode with
// `% base` and `((packed / base) | 0) - 1`; do not apply bitwise operations to
// the full packed value.
// fallow-ignore-next-line complexity
export function findAuthorityEnd(rawUrl: string, start: number): number {
  const len = rawUrl.length;
  const base = len < AUTH_PACK ? AUTH_PACK : len + 1;
  let lastAt = -1;
  for (let i = start; i < len; i++) {
    const c = rawUrl.charCodeAt(i);
    if (c === CH_SLASH || c === CH_QUESTION || c === CH_HASH) {
      return (lastAt + 1) * base + i;
    }
    if (c === CH_AT) {
      lastAt = i;
    }
  }
  return (lastAt + 1) * base + len;
}

// Returns the default port for a special scheme, or -1. schemeEnd is the colon index.
export function defaultPortFor(rawUrl: string, schemeEnd: number): number {
  if (schemeEnd === 4 || schemeEnd === 5) {
    if (
      (rawUrl.charCodeAt(0) | 32) === 104 /* h */ &&
      (rawUrl.charCodeAt(1) | 32) === 116 /* t */ &&
      (rawUrl.charCodeAt(2) | 32) === 116 /* t */ &&
      (rawUrl.charCodeAt(3) | 32) === 112 /* p */
    ) {
      if (schemeEnd === 4) {
        return 80;
      }
      if ((rawUrl.charCodeAt(4) | 32) === 115 /* s */) {
        return 443;
      }
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

// Decodes a single ASCII hex digit to its value 0–15, or -1 if not a hex
// digit. `| 32` lowercases A–F so one range check covers both cases.
export function hexNibble(code: number): number {
  if (code >= 48 && code <= 57) {
    return code - 48;
  }
  const lc = code | 32;
  if (lc >= 97 && lc <= 102) {
    return lc - 87;
  }
  return -1;
}

// Parses ASCII digits in `[start, end)`. Returns -1 for empty or invalid input.
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
