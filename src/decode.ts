import { hexNibble } from "./internal.js";

const CH_PERCENT = 37;
const CH_PLUS = 43;

const UTF8_DECODER = new TextDecoder();
let DECODE_BYTES = new Uint8Array(64);

// Decodes s[start, end), returning a substring directly when no decoding is needed.
// fallow-ignore-next-line complexity
export function decodeRange(s: string, start: number, end: number): string {
  let pct = false;
  let plus = false;
  let firstPlus = -1;
  let malformedEscape = false;
  for (let p = start; p < end; p++) {
    const c = s.charCodeAt(p);
    if (c === CH_PERCENT) {
      if (!pct) {
        pct = true;
        if (
          p + 2 >= end ||
          hexNibble(s.charCodeAt(p + 1)) === -1 ||
          hexNibble(s.charCodeAt(p + 2)) === -1
        ) {
          malformedEscape = true;
        }
      }
      if (plus) {
        break;
      }
    } else if (c === CH_PLUS) {
      plus = true;
      if (firstPlus === -1) {
        firstPlus = p;
      }
      if (pct) {
        break;
      }
    }
  }
  if (!pct && !plus) {
    return s.substring(start, end);
  }
  if (!pct) {
    return plusToSpace(s, start, end, firstPlus);
  }
  // Avoid decodeURIComponent for escapes already known to be malformed.
  if (malformedEscape) {
    return tolerantDecode(s, start, end);
  }
  const prepared = plus
    ? plusToSpace(s, start, end, firstPlus)
    : s.substring(start, end);
  try {
    return decodeURIComponent(prepared);
  } catch {
    return tolerantDecode(s, start, end);
  }
}

// Replaces '+' in s[start, end); firstPlus is the first known match.
function plusToSpace(
  s: string,
  start: number,
  end: number,
  firstPlus: number
): string {
  let out = s.substring(start, firstPlus);
  let runStart = firstPlus;
  for (let i = firstPlus; i < end; i++) {
    if (s.charCodeAt(i) === CH_PLUS) {
      out += s.substring(runStart, i);
      out += " ";
      runStart = i + 1;
    }
  }
  return out + s.substring(runStart, end);
}

// Tolerant decoder for inputs that decodeURIComponent rejects (e.g. `%ZZ`).
// Preserves the literal text for unparseable escapes, decodes valid bytes via
// TextDecoder, and treats '+' as space — matching the spec for query
// components while not throwing.
// fallow-ignore-next-line complexity
function tolerantDecode(raw: string, start: number, end: number): string {
  let out = "";
  let bytes = DECODE_BYTES;
  let byteCount = 0;
  let literalStart = start;

  for (let i = start; i < end; i++) {
    const c = raw.charCodeAt(i);

    if (c === CH_PLUS) {
      if (byteCount !== 0) {
        out += UTF8_DECODER.decode(bytes.subarray(0, byteCount));
        byteCount = 0;
      } else if (literalStart < i) {
        out += raw.substring(literalStart, i);
      }
      out += " ";
      literalStart = i + 1;
      continue;
    }

    if (c === CH_PERCENT && i + 2 < end) {
      const hi = hexNibble(raw.charCodeAt(i + 1));
      const lo = hexNibble(raw.charCodeAt(i + 2));
      if (hi !== -1 && lo !== -1) {
        if (byteCount === 0 && literalStart < i) {
          out += raw.substring(literalStart, i);
        }
        if (byteCount === bytes.length) {
          const grown = new Uint8Array(byteCount * 2);
          grown.set(bytes);
          bytes = grown;
          if (bytes.length <= 4096) {
            DECODE_BYTES = bytes;
          }
        }
        bytes[byteCount++] = (hi << 4) | lo;
        i += 2;
        literalStart = i + 1;
        continue;
      }
    }

    if (byteCount !== 0) {
      out += UTF8_DECODER.decode(bytes.subarray(0, byteCount));
      byteCount = 0;
      literalStart = i;
    }
  }

  if (byteCount !== 0) {
    out += UTF8_DECODER.decode(bytes.subarray(0, byteCount));
  } else if (literalStart < end) {
    out += raw.substring(literalStart, end);
  }
  return out;
}

/**
 * Decodes a percent-encoded URL component using form-urlencoded semantics:
 * `+` becomes space, `%XY` becomes the corresponding byte (UTF-8 decoded),
 * and malformed escapes (`%ZZ`, etc.) are preserved literally instead of
 * throwing.
 * @example
 *   decodeQueryComponent("caf%C3%A9+%E2%98%95"); // → "café ☕"
 *   decodeQueryComponent("%ZZ");                 // → "%ZZ" (preserved)
 */
export function decodeQueryComponent(raw: string): string {
  return decodeRange(raw, 0, raw.length);
}
