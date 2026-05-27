import { decodeRange } from "./decode.js";
import { encodeQueryComponent } from "./encode.js";

const CH_PERCENT = 37;
const CH_PLUS = 43;

// ---------------------------------------------------------------------------
// Locate the query string within a URL.
//
// Every public query/strip/setter function starts here. Two scans cover all
// cases correctly:
//
//   • `indexOf("?")` — locate the query delimiter.
//   • `indexOf("#")` — locate the fragment delimiter.
//
// If `#` appears *before* `?`, the `?` is content inside the fragment and
// there is no real query. We short-circuit on `qPos === -1` to skip the
// second scan entirely when no `?` exists — a meaningful saving for the
// many real-world URLs without query strings.
//
// Results are written into module-level ints (LOC_Q, LOC_F) instead of a
// returned object. JS is strictly single-threaded, so reading these two
// scalars right after a locate() call is safe across the codebase. This
// removes the per-call `{qPos, fragmentStart}` allocation that V8/SM/JSC
// were not always able to scalarize away.
// ---------------------------------------------------------------------------

let LOC_Q = -1;
let LOC_F = 0;

function locate(rawUrl: string): void {
  const qPos = rawUrl.indexOf("?");
  if (qPos === -1) {
    const hPos = rawUrl.indexOf("#");
    LOC_Q = -1;
    LOC_F = hPos === -1 ? rawUrl.length : hPos;
    return;
  }
  const hPos = rawUrl.indexOf("#");
  if (hPos !== -1 && hPos < qPos) {
    // '?' is content inside a fragment — treat as no query.
    LOC_Q = -1;
    LOC_F = hPos;
    return;
  }
  LOC_Q = qPos;
  LOC_F = hPos === -1 ? rawUrl.length : hPos;
}

export function readQueryParam(rawUrl: string, key: string): string | null {
  locate(rawUrl);
  const qPos = LOC_Q;
  if (qPos === -1) {
    return null;
  }
  const end = LOC_F;
  const keyLen = key.length;

  let i = qPos + 1;
  while (i < end) {
    let amp = rawUrl.indexOf("&", i);
    if (amp === -1 || amp > end) {
      amp = end;
    }
    const eq = rawUrl.indexOf("=", i);
    const keyEnd = eq === -1 || eq > amp ? amp : eq;

    if (keyEnd - i === keyLen && rawUrl.startsWith(key, i)) {
      if (eq === -1 || eq > amp) {
        return "";
      }
      // decodeRange returns the substring directly when no decoding is needed,
      // so we skip the substring → re-scan pattern of decodeQueryComponent.
      return decodeRange(rawUrl, eq + 1, amp);
    }

    i = amp + 1;
  }

  return null;
}

export function readQueryParams(
  rawUrl: string,
  keys: readonly string[]
): (string | null)[] {
  const n = keys.length;
  const out: (string | null)[] = new Array(n);
  if (n === 0) {
    return out;
  }

  // Precompute (firstChar, length) for each key. The inner loop can then
  // reject candidate params with two integer compares — far cheaper than a
  // startsWith call for every (param, key) pair.
  const firstChars: number[] = new Array(n);
  const keyLens: number[] = new Array(n);
  for (let k = 0; k < n; k++) {
    out[k] = null;
    const kk = keys[k];
    firstChars[k] = kk.charCodeAt(0);
    keyLens[k] = kk.length;
  }

  locate(rawUrl);
  const qPos = LOC_Q;
  if (qPos === -1) {
    return out;
  }
  const end = LOC_F;

  let remaining = n;
  let i = qPos + 1;
  while (i < end && remaining > 0) {
    let amp = rawUrl.indexOf("&", i);
    if (amp === -1 || amp > end) {
      amp = end;
    }
    const eq = rawUrl.indexOf("=", i);
    const keyEnd = eq === -1 || eq > amp ? amp : eq;
    const fieldLen = keyEnd - i;
    const fc = rawUrl.charCodeAt(i);

    for (let k = 0; k < n; k++) {
      if (out[k] !== null) {
        continue;
      }
      // Cheapest rejection first: int compare on length, then on first char.
      if (keyLens[k] !== fieldLen || firstChars[k] !== fc) {
        continue;
      }
      // Only now pay the startsWith cost.
      if (rawUrl.startsWith(keys[k], i)) {
        out[k] = eq === -1 || eq > amp ? "" : decodeRange(rawUrl, eq + 1, amp);
        remaining--;
      }
    }

    i = amp + 1;
  }

  return out;
}

// Returns a new URL string with `key` set to `value`, or with `key` removed
// when `value` is null. Matches URLSearchParams.set semantics for duplicates:
// the first occurrence is replaced, any subsequent occurrences are removed.
// The value is percent-encoded (with '+' for space). The key is written
// verbatim — callers with non-trivial keys should pre-encode them.
export function setQueryParam(
  rawUrl: string,
  key: string,
  value: string | null
): string {
  locate(rawUrl);
  const qPos = LOC_Q;
  const fragmentStart = LOC_F;

  if (qPos === -1) {
    if (value === null) {
      return rawUrl;
    }
    const pair = `${key}=${encodeQueryComponent(value)}`;
    return `${rawUrl.substring(0, fragmentStart)}?${pair}${rawUrl.substring(fragmentStart)}`;
  }

  const queryStart = qPos + 1;
  const queryEnd = fragmentStart;
  const keyLen = key.length;
  const encoded = value === null ? null : encodeQueryComponent(value);

  let newQuery = "";
  let replaced = false;
  let i = queryStart;

  while (i < queryEnd) {
    let amp = rawUrl.indexOf("&", i);
    if (amp === -1 || amp > queryEnd) {
      amp = queryEnd;
    }
    const eq = rawUrl.indexOf("=", i);
    const keyEnd = eq === -1 || eq > amp ? amp : eq;
    const isMatch = keyEnd - i === keyLen && rawUrl.startsWith(key, i);

    if (isMatch) {
      // First match: emit replacement (if value is non-null); skip the rest.
      if (!replaced && encoded !== null) {
        if (newQuery.length > 0) {
          newQuery += "&";
        }
        newQuery += `${key}=${encoded}`;
        replaced = true;
      }
    } else {
      if (newQuery.length > 0) {
        newQuery += "&";
      }
      newQuery += rawUrl.substring(i, amp);
    }

    i = amp + 1;
  }

  if (!replaced && encoded !== null) {
    if (newQuery.length > 0) {
      newQuery += "&";
    }
    newQuery += `${key}=${encoded}`;
  }

  const prefix = rawUrl.substring(0, qPos);
  const suffix = rawUrl.substring(queryEnd);
  if (newQuery.length === 0) {
    return prefix + suffix;
  }
  return `${prefix}?${newQuery}${suffix}`;
}

// Bulk version of setQueryParam. Single scan over the existing query: each
// existing param is either replaced (if its key is in `params`), skipped (if
// `params[key]` is null), or kept verbatim. Any keys in `params` not present
// in the URL are appended at the end.
export function setQueryParams(
  rawUrl: string,
  params: Record<string, string | null>
): string {
  const keys = Object.keys(params);
  const n = keys.length;
  if (n === 0) {
    return rawUrl;
  }

  // Pre-encode all non-null values + precompute first-char / length for the
  // matcher loop (same trick as readQueryParams).
  const encoded: (string | null)[] = new Array(n);
  const firstChars: number[] = new Array(n);
  const keyLens: number[] = new Array(n);
  const seen = new Array<boolean>(n).fill(false);
  for (let k = 0; k < n; k++) {
    const v = params[keys[k]];
    encoded[k] = v === null ? null : encodeQueryComponent(v);
    firstChars[k] = keys[k].charCodeAt(0);
    keyLens[k] = keys[k].length;
  }

  locate(rawUrl);
  const qPos = LOC_Q;
  const fragmentStart = LOC_F;

  if (qPos === -1) {
    let body = "";
    for (let k = 0; k < n; k++) {
      if (encoded[k] === null) {
        continue;
      }
      if (body.length > 0) {
        body += "&";
      }
      body += `${keys[k]}=${encoded[k]}`;
    }
    if (body.length === 0) {
      return rawUrl;
    }
    return `${rawUrl.substring(0, fragmentStart)}?${body}${rawUrl.substring(fragmentStart)}`;
  }

  const queryStart = qPos + 1;
  const queryEnd = fragmentStart;
  let newQuery = "";
  let i = queryStart;

  while (i < queryEnd) {
    let amp = rawUrl.indexOf("&", i);
    if (amp === -1 || amp > queryEnd) {
      amp = queryEnd;
    }
    const eq = rawUrl.indexOf("=", i);
    const keyEnd = eq === -1 || eq > amp ? amp : eq;
    const fieldLen = keyEnd - i;
    const fc = rawUrl.charCodeAt(i);

    let matchedSlot = -1;
    for (let k = 0; k < n; k++) {
      if (keyLens[k] !== fieldLen || firstChars[k] !== fc) {
        continue;
      }
      if (rawUrl.startsWith(keys[k], i)) {
        matchedSlot = k;
        break;
      }
    }

    if (matchedSlot !== -1) {
      const enc = encoded[matchedSlot];
      if (!seen[matchedSlot] && enc !== null) {
        if (newQuery.length > 0) {
          newQuery += "&";
        }
        newQuery += `${keys[matchedSlot]}=${enc}`;
      }
      seen[matchedSlot] = true;
      // Skip this param entirely (delete duplicates / null values).
    } else {
      if (newQuery.length > 0) {
        newQuery += "&";
      }
      newQuery += rawUrl.substring(i, amp);
    }

    i = amp + 1;
  }

  // Append any params that didn't already exist in the URL.
  for (let k = 0; k < n; k++) {
    if (seen[k] || encoded[k] === null) {
      continue;
    }
    if (newQuery.length > 0) {
      newQuery += "&";
    }
    newQuery += `${keys[k]}=${encoded[k]}`;
  }

  const prefix = rawUrl.substring(0, qPos);
  const suffix = rawUrl.substring(queryEnd);
  if (newQuery.length === 0) {
    return prefix + suffix;
  }
  return `${prefix}?${newQuery}${suffix}`;
}

// Zero-allocation predicate: returns true if `key` is present in the query
// (including bare "?key" with no value). Inlines the locate logic — saves
// the function call when the key/value sites are tight loops.
export function hasQueryParam(rawUrl: string, key: string): boolean {
  const qPos = rawUrl.indexOf("?");
  if (qPos === -1) {
    return false;
  }
  const hPos = rawUrl.indexOf("#");
  if (hPos !== -1 && hPos < qPos) {
    return false;
  }
  const fragmentStart = hPos === -1 ? rawUrl.length : hPos;

  const keyLen = key.length;
  let i = qPos + 1;
  while (i < fragmentStart) {
    let amp = rawUrl.indexOf("&", i);
    if (amp === -1 || amp > fragmentStart) {
      amp = fragmentStart;
    }
    const eq = rawUrl.indexOf("=", i);
    const keyEnd = eq === -1 || eq > amp ? amp : eq;
    if (keyEnd - i === keyLen && rawUrl.startsWith(key, i)) {
      return true;
    }
    i = amp + 1;
  }
  return false;
}

// Compares the value of `key` against `expected` without materializing the
// decoded value. Walks the URL's value bytes one codepoint at a time,
// decoding '+', percent-escapes, and multi-byte UTF-8 (including astral
// codepoints, i.e. surrogate pairs in JS) on the fly, and compares each
// codepoint against the next char(s) of `expected`. Zero allocation
// regardless of encoding — no substring, no TextDecoder, no decoded string.
//
// Caveat: malformed UTF-8 sequences (e.g. a lone `%C3` with no continuation,
// or `%AB` standing alone) cause this function to return `false` rather than
// the U+FFFD replacement that `decodeQueryComponent` would produce. This is
// an intentional perf/predictability tradeoff for a vanishingly rare input.
export function queryParamEquals(
  rawUrl: string,
  key: string,
  expected: string
): boolean {
  const qPos = rawUrl.indexOf("?");
  if (qPos === -1) {
    return false;
  }
  const hPos = rawUrl.indexOf("#");
  if (hPos !== -1 && hPos < qPos) {
    return false;
  }
  const fragmentStart = hPos === -1 ? rawUrl.length : hPos;

  const keyLen = key.length;
  let i = qPos + 1;
  while (i < fragmentStart) {
    let amp = rawUrl.indexOf("&", i);
    if (amp === -1 || amp > fragmentStart) {
      amp = fragmentStart;
    }
    const eq = rawUrl.indexOf("=", i);
    const keyEnd = eq === -1 || eq > amp ? amp : eq;
    if (keyEnd - i === keyLen && rawUrl.startsWith(key, i)) {
      const valStart = eq === -1 || eq > amp ? amp : eq + 1;
      return valueEquals(rawUrl, valStart, amp, expected);
    }
    i = amp + 1;
  }
  return false;
}

function hexNibble(code: number): number {
  if (code >= 48 && code <= 57) {
    return code - 48;
  }
  const lc = code | 32;
  if (lc >= 97 && lc <= 102) {
    return lc - 87;
  }
  return -1;
}

// Reads a `%XY` continuation byte at position `pos`. Returns the byte value
// if it parses to a valid UTF-8 continuation byte (top two bits 10), or -1
// otherwise (out of range, not a percent-escape, or doesn't satisfy 10xxxxxx).
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

// Compares the URL value bytes against `expected`, decoding the URL value one
// Unicode codepoint at a time and matching codepoints to chars (or surrogate
// pairs) in `expected`. Implements the WHATWG UTF-8 decoder error model: an
// invalid byte emits U+FFFD and any non-continuation byte "stolen" by a bad
// lead is re-processed at the next iteration. Zero allocation — no
// substring, no temporary decoded string, no TextDecoder.
function valueEquals(
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
          // sequence start. All invalid under WHATWG.
          codepoint = 0xfffd;
          advance = 3;
        } else if (byte < 0xe0) {
          // 2-byte sequence.
          const c1 = readContByte(s, i + 3, end);
          if (c1 === -1) {
            codepoint = 0xfffd;
            advance = 3;
          } else {
            codepoint = ((byte & 0x1f) << 6) | (c1 & 0x3f);
            advance = 6;
          }
        } else if (byte < 0xf0) {
          // 3-byte sequence. Apply WHATWG range constraints on the first
          // continuation: 0xE0 forbids overlong (cont must be 0xA0..0xBF);
          // 0xED forbids surrogates (cont must be 0x80..0x9F).
          const c1 = readContByte(s, i + 3, end);
          if (c1 === -1) {
            codepoint = 0xfffd;
            advance = 3;
          } else {
            const lower = byte === 0xe0 ? 0xa0 : 0x80;
            const upper = byte === 0xed ? 0x9f : 0xbf;
            if (c1 < lower || c1 > upper) {
              // First cont byte out of range: emit U+FFFD; re-process c1.
              codepoint = 0xfffd;
              advance = 3;
            } else {
              const c2 = readContByte(s, i + 6, end);
              if (c2 === -1) {
                codepoint = 0xfffd;
                advance = 6;
              } else {
                codepoint =
                  ((byte & 0x0f) << 12) | ((c1 & 0x3f) << 6) | (c2 & 0x3f);
                advance = 9;
              }
            }
          }
        } else if (byte < 0xf5) {
          // 4-byte sequence. 0xF0 forbids overlong (cont >= 0x90); 0xF4 caps
          // at U+10FFFF (cont <= 0x8F).
          const c1 = readContByte(s, i + 3, end);
          if (c1 === -1) {
            codepoint = 0xfffd;
            advance = 3;
          } else {
            const lower = byte === 0xf0 ? 0x90 : 0x80;
            const upper = byte === 0xf4 ? 0x8f : 0xbf;
            if (c1 < lower || c1 > upper) {
              codepoint = 0xfffd;
              advance = 3;
            } else {
              const c2 = readContByte(s, i + 6, end);
              if (c2 === -1) {
                codepoint = 0xfffd;
                advance = 6;
              } else {
                const c3 = readContByte(s, i + 9, end);
                if (c3 === -1) {
                  codepoint = 0xfffd;
                  advance = 9;
                } else {
                  codepoint =
                    ((byte & 0x07) << 18) |
                    ((c1 & 0x3f) << 12) |
                    ((c2 & 0x3f) << 6) |
                    (c3 & 0x3f);
                  advance = 12;
                }
              }
            }
          }
        } else {
          // byte >= 0xF5: invalid (would produce > U+10FFFF).
          codepoint = 0xfffd;
          advance = 3;
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

// Returns the raw query string without the leading '?', or "" if absent.
// Does NOT decode — callers that want decoded values should use readQueryParam.
export function readQuery(rawUrl: string): string {
  locate(rawUrl);
  const qPos = LOC_Q;
  if (qPos === -1) {
    return "";
  }
  return rawUrl.substring(qPos + 1, LOC_F);
}

// Returns `rawUrl` with the query string removed. Preserves the fragment.
// Returns the input unchanged when there is no query.
export function stripQuery(rawUrl: string): string {
  locate(rawUrl);
  const qPos = LOC_Q;
  if (qPos === -1) {
    return rawUrl;
  }
  return rawUrl.substring(0, qPos) + rawUrl.substring(LOC_F);
}
