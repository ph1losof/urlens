import { hexNibble } from "./internal.js";

const CH_PERCENT = 37;
const CH_PLUS = 43;

const UTF8_DECODER = new TextDecoder();
let DECODE_BYTES = new Uint8Array(64);

// Decodes the URL component within `[start, end)` of `s`. A single charCodeAt
// pass simultaneously detects `%` and `+`. When neither appears, returns a
// sliced substring directly — the only allocation is the slice header.
//
// This is the workhorse used by readQueryParam / readQueryParams to skip the
// "substring then re-scan in decodeQueryComponent" dance, which previously
// walked the value twice on every read of an unencoded value.
// fallow-ignore-next-line complexity
export function decodeRange(s: string, start: number, end: number): string {
  let pct = false;
  let plus = false;
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
      if (pct) {
        break;
      }
    }
  }
  if (!pct && !plus) {
    return s.substring(start, end);
  }
  if (!pct) {
    // '+' only — substitute via a single-pass char walker (no regex).
    return plusToSpace(s, start, end);
  }
  // Invalid % syntax would make decodeURIComponent throw. Detecting it in the
  // scan we already perform avoids constructing an intermediate string and an
  // exception on this otherwise disproportionately expensive path.
  if (malformedEscape) {
    return tolerantDecode(s, start, end);
  }
  // Has '%'. Substitute any '+' first (form-urlencoded semantics), then try
  // the native decoder. On malformed escapes, fall through to tolerant decode.
  const prepared = plus ? plusToSpace(s, start, end) : s.substring(start, end);
  try {
    return decodeURIComponent(prepared);
  } catch {
    // Fall through.
  }
  return tolerantDecode(prepared, 0, prepared.length);
}

// Replaces every '+' in `s[start..end)` with a space. Caller has already
// verified at least one '+' is present in the range. Builds the output by
// stitching together sliced substrings — each substring is a "sliced string"
// in V8/SM/JSC (no byte copy), so the only real allocation is the final
// flattened string.
function plusToSpace(s: string, start: number, end: number): string {
  let out = "";
  let runStart = start;
  for (let i = start; i < end; i++) {
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
  let byteCount = 0;

  for (let i = start; i < end; i++) {
    const c = raw.charCodeAt(i);

    if (c === CH_PLUS) {
      if (byteCount !== 0) {
        out += UTF8_DECODER.decode(DECODE_BYTES.subarray(0, byteCount));
        byteCount = 0;
      }
      out += " ";
      continue;
    }

    if (c === CH_PERCENT && i + 2 < end) {
      const hi = hexNibble(raw.charCodeAt(i + 1));
      const lo = hexNibble(raw.charCodeAt(i + 2));
      if (hi !== -1 && lo !== -1) {
        if (byteCount === DECODE_BYTES.length) {
          const grown = new Uint8Array(byteCount * 2);
          grown.set(DECODE_BYTES);
          DECODE_BYTES = grown;
        }
        DECODE_BYTES[byteCount++] = (hi << 4) | lo;
        i += 2;
        continue;
      }
    }

    if (byteCount !== 0) {
      out += UTF8_DECODER.decode(DECODE_BYTES.subarray(0, byteCount));
      byteCount = 0;
    }
    out += raw[i];
  }

  if (byteCount !== 0) {
    out += UTF8_DECODER.decode(DECODE_BYTES.subarray(0, byteCount));
  }
  return out;
}

/**
 * Decodes a percent-encoded URL component using form-urlencoded semantics:
 * `+` becomes space, `%XY` becomes the corresponding byte (UTF-8 decoded),
 * and malformed escapes (`%ZZ`, etc.) are preserved literally instead of
 * throwing.
 *
 * This is more tolerant than `decodeURIComponent`, which throws on `%ZZ` —
 * matching what most user-facing systems actually want.
 *
 * Prefer {@link readQueryParam} when reading a value out of a URL — it
 * skips this function's substring + re-scan dance.
 *
 * @example
 *   decodeQueryComponent("caf%C3%A9+%E2%98%95"); // → "café ☕"
 *   decodeQueryComponent("%ZZ");                 // → "%ZZ" (preserved)
 */
export function decodeQueryComponent(raw: string): string {
  return decodeRange(raw, 0, raw.length);
}
