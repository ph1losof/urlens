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
const CH_AT = 64;

// Lookup table for the "scheme continuation" alphabet: bytes that may legally
// follow the leading letter of an RFC 3986 / WHATWG scheme — ALPHA / DIGIT /
// "+" / "-" / ".". Indexed by char code; 1 = allowed, 0 = not. A single table
// read per char beats a branch ladder of range/equality comparisons in the hot
// scheme-detection path (see findSchemeEnd).
export const SCHEME_CONT = new Uint8Array(128);
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

// Returns the index of the scheme's "://" separator (which equals the scheme
// length), or -1 when `rawUrl` has no valid scheme.
//
// A valid scheme is RFC 3986 / WHATWG: ALPHA *( ALPHA / DIGIT / "+" / "-" / "." ).
// Validating the full alphabet — not just "is there a '://'" — is what stops an
// embedded "://" inside a query, path, or fragment (e.g. the redirect target in
// "/cb?u=https://x") from being misread as the input's own scheme: any "/", "?",
// "#", space, or other non-scheme byte before the "://" fails the scan and the
// input is correctly reported as schemeless.
//
// Returns the same value the bare `indexOf("://")` returned on the happy path
// (the index where "://" begins), so it is a drop-in for callers that branch on
// `=== -1` and derive `authStart = schemeEnd + 3` / `substring(0, schemeEnd)`.
//
// Single forward pass: validate each byte against the scheme alphabet until we
// reach the terminating ':' (which must be followed by "//"). Folding the search
// and the validation into one loop is what keeps this off the critical path —
// it never out-scans a bare `indexOf("://")` because it bails at the FIRST
// non-scheme byte. For a schemeless input that opens with '/', '?', '#', etc.
// (any relative path), that bail is at index 0, so the common "no scheme" answer
// is O(1) instead of an indexOf scan over the whole string.
export function findSchemeEnd(rawUrl: string): number {
  // Scheme must start with a letter.
  const c0 = rawUrl.charCodeAt(0) | 32; // ASCII-lowercase; NaN (empty) -> 32
  if (c0 < 97 || c0 > 122) {
    return -1;
  }
  const len = rawUrl.length;
  for (let i = 1; i < len; i++) {
    const c = rawUrl.charCodeAt(i);
    // Fast path: lowercase ASCII letter — by far the most common scheme byte
    // (http, https, ftp, ws, wss, file, ...). One range check, no table load.
    if (c >= 97 && c <= 122) {
      continue;
    }
    if (c === CH_COLON) {
      // Scheme separator only if followed by "//"; otherwise no authority form
      // (e.g. "mailto:foo") and we report schemeless, matching old indexOf.
      return rawUrl.charCodeAt(i + 1) === CH_SLASH &&
        rawUrl.charCodeAt(i + 2) === CH_SLASH
        ? i
        : -1;
    }
    if (c > 127 || SCHEME_CONT[c] === 0) {
      return -1;
    }
  }
  return -1;
}

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

// Multiplier used to pack two authority offsets into one return value (see
// findAuthorityEnd). Both packed offsets are in [0, len], so the encoding stays
// exact within Number.MAX_SAFE_INTEGER (2^53) as long as len < 2^21 (~2M chars)
// — far beyond any realistic URL.
//
// 2^21 (not a larger power) is deliberate: the packed value must stay a V8 Smi
// (31-bit, < 2^30) to keep the call-site decode in fast integer arithmetic. A
// URL with userinfo packs `(lastAt + 1) * AUTH_PACK + authEnd`; with 2^21 that
// stays a Smi whenever the terminating '@' sits within the first ~512 chars
// (i.e. always, in practice). A bigger multiplier (e.g. 2^26) boxes those URLs
// into a HeapNumber and the `%`/`/` decode falls back to slow double math.
export const AUTH_PACK = 0x200000; // 2^21

// Returns the authority boundary AND the last-'@' position packed into one
// integer, computed in a single linear pass:
//
//   packed = (lastAt + 1) * AUTH_PACK + authEnd
//
//   • authEnd: index of the first '/', '?', or '#' at or after `start`, or the
//     string length if none are present. One pass beats three separate indexOf
//     calls when the authority is short, and is never worse.
//   • lastAt: position of the LAST '@' in [start, authEnd), or -1 if absent.
//     WHATWG userinfo terminates at the last literal '@' (an '@' inside userinfo
//     must be percent-encoded), so this matches lastIndexOf("@", authEnd - 1)
//     but is folded into this scan — avoiding a second backward scan whose range
//     is wasted for the common URLs that have no userinfo.
//
// Decode at the call site (the quotient `lastAt + 1` is < 2^21, so `| 0` is a
// safe 32-bit truncation; never apply bitwise ops to the full packed value):
//   const authEnd = packed % AUTH_PACK;
//   const lastAt  = ((packed / AUTH_PACK) | 0) - 1;
// fallow-ignore-next-line complexity
export function findAuthorityEnd(rawUrl: string, start: number): number {
  const len = rawUrl.length;
  let lastAt = -1;
  for (let i = start; i < len; i++) {
    const c = rawUrl.charCodeAt(i);
    if (c === CH_SLASH || c === CH_QUESTION || c === CH_HASH) {
      return (lastAt + 1) * AUTH_PACK + i;
    }
    if (c === CH_AT) {
      lastAt = i;
    }
  }
  return (lastAt + 1) * AUTH_PACK + len;
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
