// Shared query-string matching primitives used by both query.ts (flat
// functions) and view.ts (UrlView methods). These were previously
// "module-internal" exports of query.ts that view.ts reached into, plus a
// byte-identical copy of the slow-path fallbacks living in view.ts. Owning
// them here removes that duplication and the cross-file coupling.
//
// Only depends on decode.ts/internal.ts, so query.ts and view.ts can both
// import from here without a cycle.

import { decodeRange } from "./decode.js";
import { hexNibble } from "./internal.js";

const CH_PERCENT = 37;
const CH_PLUS = 43;

// Returns true if `key` contains any character that would make WHATWG
// disagree with byte-equal matching on the URL side (i.e. `%` or `+`).
// Used as the ambiguity gate at function entry: if false, byte-equal hits
// are WHATWG-correct and can be returned immediately; if true, each
// byte-equal hit is verified with compareDecodedValueRange.
//
// One charCodeAt loop instead of two SIMD indexOf calls. Keys are typically
// short (1–15 chars); SIMD's setup cost dominates the per-call work at that
// length, so a manual scan is measurably faster.
export function keyIsAmbiguous(key: string): boolean {
  const len = key.length;
  for (let p = 0; p < len; p++) {
    const c = key.charCodeAt(p);
    if (c === CH_PERCENT || c === CH_PLUS) {
      return true;
    }
  }
  return false;
}

// Returns true if `[start, end)` of `rawUrl` contains any character WHATWG
// `application/x-www-form-urlencoded` decoding would interpret (`%` or `+`).
// Gates the decoded-key fallback: when false, byte-strict was conclusive.
// Two SIMD-accelerated indexOf calls; the early return after the first hit
// makes the typical "encoded value, plain query" case ~5ns.
//
// A manual one-pass charCodeAt scan was benched and reverted: SIMD wins on
// the query-range inputs here (10–80 chars), unlike the short-key case in
// keyIsAmbiguous where SIMD setup cost dominated.
export function queryHasEncoding(
  rawUrl: string,
  start: number,
  end: number
): boolean {
  const pct = rawUrl.indexOf("%", start);
  if (pct !== -1 && pct < end) {
    return true;
  }
  const plus = rawUrl.indexOf("+", start);
  return plus !== -1 && plus < end;
}

// Reads a `%XY` continuation byte at position `pos`. Returns the byte value
// if it parses to a valid UTF-8 continuation byte (top two bits 10), or -1
// otherwise (out of range, not a percent-escape, or doesn't satisfy 10xxxxxx).
// fallow-ignore-next-line complexity
function readContByte(s: string, pos: number, end: number): number {
  if (pos + 2 >= end || s.charCodeAt(pos) !== CH_PERCENT) {
    return -1;
  }
  const hi = hexNibble(s.charCodeAt(pos + 1));
  const lo = hexNibble(s.charCodeAt(pos + 2));
  if (hi === -1 || lo === -1) {
    return -1;
  }
  const b = (hi << 4) | lo;
  if ((b & 0xc0) !== 0x80) {
    return -1;
  }
  return b;
}

// Scratch slots for decodeMultiByteUtf8 — same allocation-free pattern as
// locate() in query.ts. Sync-only: read into locals IMMEDIATELY after the call.
let CP = 0;
let CP_ADV = 0;

// Decodes a multi-byte UTF-8 sequence (2/3/4 bytes) starting at `i`, with the
// leading byte `byte` already extracted from `s[i+1..i+2]`. Writes scratch
// CP (codepoint, U+FFFD on invalid) and CP_ADV (chars to advance from `i`).
//
// Extracted from compareDecodedValueRange's per-iteration hot loop: the loop
// itself stays a tight ~50 lines, with the rare multi-byte path factored
// out. The 2/3/4-byte branches share no logic worth keeping inline — they
// only ever fire when the URL has actual Latin1+/Astral chars (uncommon
// vs. ASCII queries that dominate real-world traffic).
//
// The 3-byte and 4-byte branches each do "validate first cont byte against a
// byte-specific range, then load c2 from i+6" — fallow flags it as a clone,
// but the lower/upper byte values differ per branch (0xE0/0xED vs 0xF0/0xF4)
// and extracting a 6-arg helper with an ambiguous return sentinel loses more
// clarity than the 12-line repetition costs. Marked intentional in fallowrc.
// fallow-ignore-next-line complexity
function decodeMultiByteUtf8(
  s: string,
  i: number,
  end: number,
  byte: number
): void {
  if (byte < 0xe0) {
    // 2-byte sequence.
    const c1 = readContByte(s, i + 3, end);
    if (c1 === -1) {
      CP = 0xfffd;
      CP_ADV = 3;
      return;
    }
    CP = ((byte & 0x1f) << 6) | (c1 & 0x3f);
    CP_ADV = 6;
    return;
  }
  if (byte < 0xf0) {
    // 3-byte sequence. WHATWG range constraints on first cont byte:
    //   0xE0 → 0xA0..0xBF (no overlong); 0xED → 0x80..0x9F (no surrogates).
    const c1 = readContByte(s, i + 3, end);
    if (c1 === -1) {
      CP = 0xfffd;
      CP_ADV = 3;
      return;
    }
    const lower = byte === 0xe0 ? 0xa0 : 0x80;
    const upper = byte === 0xed ? 0x9f : 0xbf;
    if (c1 < lower || c1 > upper) {
      CP = 0xfffd;
      CP_ADV = 3;
      return;
    }
    const c2 = readContByte(s, i + 6, end);
    if (c2 === -1) {
      CP = 0xfffd;
      CP_ADV = 6;
      return;
    }
    CP = ((byte & 0x0f) << 12) | ((c1 & 0x3f) << 6) | (c2 & 0x3f);
    CP_ADV = 9;
    return;
  }
  if (byte < 0xf5) {
    // 4-byte sequence. 0xF0 → cont ≥ 0x90 (no overlong); 0xF4 → cont ≤ 0x8F
    // (caps at U+10FFFF).
    const c1 = readContByte(s, i + 3, end);
    if (c1 === -1) {
      CP = 0xfffd;
      CP_ADV = 3;
      return;
    }
    const lower = byte === 0xf0 ? 0x90 : 0x80;
    const upper = byte === 0xf4 ? 0x8f : 0xbf;
    if (c1 < lower || c1 > upper) {
      CP = 0xfffd;
      CP_ADV = 3;
      return;
    }
    const c2 = readContByte(s, i + 6, end);
    if (c2 === -1) {
      CP = 0xfffd;
      CP_ADV = 6;
      return;
    }
    const c3 = readContByte(s, i + 9, end);
    if (c3 === -1) {
      CP = 0xfffd;
      CP_ADV = 9;
      return;
    }
    CP =
      ((byte & 0x07) << 18) |
      ((c1 & 0x3f) << 12) |
      ((c2 & 0x3f) << 6) |
      (c3 & 0x3f);
    CP_ADV = 12;
    return;
  }
  // byte >= 0xF5: invalid (would produce > U+10FFFF).
  CP = 0xfffd;
  CP_ADV = 3;
}

// Compares the URL value bytes against `expected`, decoding the URL value one
// Unicode codepoint at a time and matching codepoints to chars (or surrogate
// pairs) in `expected`. Implements the WHATWG UTF-8 decoder error model: an
// invalid byte emits U+FFFD and any non-continuation byte "stolen" by a bad
// lead is re-processed at the next iteration. Zero allocation — no
// substring, no temporary decoded string, no TextDecoder.
// fallow-ignore-next-line complexity
export function compareDecodedValueRange(
  s: string,
  start: number,
  end: number,
  expected: string
): boolean {
  const expectedLen = expected.length;
  let i = start;
  let j = 0;

  while (i < end && j < expectedLen) {
    // Decode the next codepoint, producing `codepoint` and `advance` (chars
    // to consume). On WHATWG-invalid sequences, codepoint = 0xFFFD and we
    // advance past only what was validly read.
    let codepoint: number;
    let advance: number;

    const c = s.charCodeAt(i);

    if (c === CH_PLUS) {
      codepoint = 32; // space
      advance = 1;
    } else if (c === CH_PERCENT && i + 2 < end) {
      const hi = hexNibble(s.charCodeAt(i + 1));
      const lo = hexNibble(s.charCodeAt(i + 2));
      if (hi === -1 || lo === -1) {
        // Malformed %XY (e.g. %ZZ): treat '%' as a literal character. The
        // following two chars are matched as plain bytes on next iterations.
        codepoint = 37;
        advance = 1;
      } else {
        const byte = (hi << 4) | lo;
        if (byte < 0x80) {
          codepoint = byte;
          advance = 3;
        } else if (byte < 0xc2) {
          // 0x80–0xBF: lone continuation byte. 0xC0, 0xC1: overlong 2-byte
          // start. All invalid under WHATWG.
          codepoint = 0xfffd;
          advance = 3;
        } else {
          // Multi-byte UTF-8: cold branch, factored out.
          decodeMultiByteUtf8(s, i, end, byte);
          codepoint = CP;
          advance = CP_ADV;
        }
      }
    } else {
      // Plain ASCII (or non-percent literal): one char.
      codepoint = c;
      advance = 1;
    }

    // Compare codepoint to expected at position j.
    if (codepoint <= 0xffff) {
      if (expected.charCodeAt(j) !== codepoint) {
        return false;
      }
      j++;
    } else {
      // Astral: compare against a UTF-16 surrogate pair in `expected`.
      if (j + 1 >= expectedLen) {
        return false;
      }
      const offset = codepoint - 0x10000;
      if (expected.charCodeAt(j) !== 0xd800 + (offset >> 10)) {
        return false;
      }
      if (expected.charCodeAt(j + 1) !== 0xdc00 + (offset & 0x3ff)) {
        return false;
      }
      j += 2;
    }

    i += advance;
  }

  return i === end && j === expectedLen;
}

// Slow-path fallbacks: WHATWG-decoded field matching via compareDecodedValueRange.
// Only ever entered when byte-strict matching missed AND the query range is
// known to contain '%' or '+'. Decoded length is always <= encoded length, so
// `fieldLen < keyLen` prunes candidates without paying for the walker. A
// non-inlined helper call on this path is invisible cost.

// Scratch slots for findDecodedFieldMatch — caller reads IMMEDIATELY after the
// call. FB_EQ = position of '=' for the matched field, or -1 if the field has
// no value ('?key' / '?key&...'); FB_AMP = position of the terminating '&' or
// `end` (one past the last field byte).
let FB_EQ = -1;
let FB_AMP = -1;

// Scans `raw[queryStart..end)` for the first field whose decoded key matches
// `key`. On match, writes FB_EQ / FB_AMP and returns true. This is the slow
// path (only entered after byte-strict missed AND the query has '%'/'+'), so
// the same-module call is invisible cost — the three fallbacks below share
// this loop body.
function findDecodedFieldMatch(
  raw: string,
  queryStart: number,
  end: number,
  key: string,
  keyLen: number
): boolean {
  let i = queryStart;
  while (i < end) {
    let amp = raw.indexOf("&", i);
    if (amp === -1 || amp > end) {
      amp = end;
    }
    const eq = raw.indexOf("=", i);
    const keyEnd = eq === -1 || eq > amp ? amp : eq;
    if (keyEnd - i >= keyLen && compareDecodedValueRange(raw, i, keyEnd, key)) {
      FB_EQ = eq === -1 || eq > amp ? -1 : eq;
      FB_AMP = amp;
      return true;
    }
    i = amp + 1;
  }
  return false;
}

export function queryParamDecodedFallback(
  raw: string,
  queryStart: number,
  end: number,
  key: string,
  keyLen: number
): string | null {
  if (!findDecodedFieldMatch(raw, queryStart, end, key, keyLen)) {
    return null;
  }
  if (FB_EQ === -1) {
    return "";
  }
  return decodeRange(raw, FB_EQ + 1, FB_AMP);
}

export function hasQueryParamDecodedFallback(
  raw: string,
  queryStart: number,
  end: number,
  key: string,
  keyLen: number
): boolean {
  return findDecodedFieldMatch(raw, queryStart, end, key, keyLen);
}

export function queryParamEqualsDecodedFallback(
  raw: string,
  queryStart: number,
  end: number,
  key: string,
  keyLen: number,
  expected: string
): boolean {
  if (!findDecodedFieldMatch(raw, queryStart, end, key, keyLen)) {
    return false;
  }
  const valStart = FB_EQ === -1 ? FB_AMP : FB_EQ + 1;
  return compareDecodedValueRange(raw, valStart, FB_AMP, expected);
}
