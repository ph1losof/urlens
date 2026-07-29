import { decodeRange } from "./decode.js";
import { hexNibble } from "./internal.js";

const CH_PERCENT = 37;
const CH_AMP = 38;
const CH_PLUS = 43;
const CH_EQUALS = 61;

// Returns whether byte-equal key matching can disagree with form decoding.
// Ambiguous matches must be verified with compareDecodedValueRange.
export function keyIsAmbiguous(key: string): boolean {
  const len = key.length;
  for (let p = 0; p < len; p++) {
    const c = key.charCodeAt(p);
    if (c <= CH_EQUALS) {
      if (
        c === CH_PERCENT ||
        c === CH_AMP ||
        c === CH_PLUS ||
        c === CH_EQUALS
      ) {
        return true;
      }
    }
  }
  return false;
}

// Returns whether rawUrl[start, end) contains '%' or '+'.
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

// Non-reentrant scratch; callers must read both values immediately.
let CP = 0;
let CP_ADV = 0;

// Decodes a multi-byte UTF-8 sequence into CP and CP_ADV.
// fallow-ignore-next-line complexity
function decodeMultiByteUtf8(
  s: string,
  i: number,
  end: number,
  byte: number
): void {
  if (byte < 0xe0) {
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

// Compares s[start, end) with expected using form decoding and WHATWG UTF-8
// error handling. Invalid bytes emit U+FFFD; a non-continuation byte after an
// invalid lead is processed again.
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
          decodeMultiByteUtf8(s, i, end, byte);
          codepoint = CP;
          advance = CP_ADV;
        }
      }
    } else {
      codepoint = c;
      advance = 1;
    }

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

// Decoded fallback used after byte matching misses on an encoded query.

// Scratch slots for findDecodedFieldMatch — caller reads IMMEDIATELY after the
// call. FB_EQ = position of '=' for the matched field, or -1 if the field has
// no value ('?key' / '?key&...'); FB_AMP = position of the terminating '&' or
// `end` (one past the last field byte).
let FB_EQ = -1;
let FB_AMP = -1;

// Finds the first field whose decoded key matches and writes FB_EQ / FB_AMP.
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
    if (
      (keyLen !== 0 || eq === i) &&
      keyEnd - i >= keyLen &&
      compareDecodedValueRange(raw, i, keyEnd, key)
    ) {
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
