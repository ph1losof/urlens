const CH_PERCENT = 37;
const CH_PLUS = 43;

const UTF8_DECODER = new TextDecoder();

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

// Decodes the URL component within `[start, end)` of `s`. A single charCodeAt
// pass simultaneously detects `%` and `+`. When neither appears, returns a
// sliced substring directly — the only allocation is the slice header.
//
// This is the workhorse used by readQueryParam / readQueryParams to skip the
// "substring then re-scan in decodeQueryComponent" dance, which previously
// walked the value twice on every read of an unencoded value.
export function decodeRange(s: string, start: number, end: number): string {
  let pct = false;
  let plus = false;
  for (let p = start; p < end; p++) {
    const c = s.charCodeAt(p);
    if (c === CH_PERCENT) {
      if (plus) {
        pct = true;
        break;
      }
      pct = true;
    } else if (c === CH_PLUS) {
      if (pct) {
        plus = true;
        break;
      }
      plus = true;
    }
  }
  if (!pct && !plus) {
    return s.substring(start, end);
  }
  if (!pct) {
    // '+' only — substitute via a single-pass char walker (no regex).
    return plusToSpace(s, start, end);
  }
  // Has '%'. Substitute any '+' first (form-urlencoded semantics), then try
  // the native decoder. On malformed escapes, fall through to tolerant decode.
  const prepared = plus ? plusToSpace(s, start, end) : s.substring(start, end);
  try {
    return decodeURIComponent(prepared);
  } catch {
    // Fall through.
  }
  return tolerantDecode(prepared);
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
function tolerantDecode(raw: string): string {
  let out = "";
  const bytes: number[] = [];

  const flush = (): void => {
    if (bytes.length) {
      out += UTF8_DECODER.decode(new Uint8Array(bytes));
      bytes.length = 0;
    }
  };

  for (let i = 0; i < raw.length; i++) {
    const c = raw.charCodeAt(i);

    if (c === CH_PLUS) {
      flush();
      out += " ";
      continue;
    }

    if (c === CH_PERCENT && i + 2 < raw.length) {
      const hi = hexNibble(raw.charCodeAt(i + 1));
      const lo = hexNibble(raw.charCodeAt(i + 2));
      if (hi !== -1 && lo !== -1) {
        bytes.push((hi << 4) | lo);
        i += 2;
        continue;
      }
    }

    flush();
    out += raw[i];
  }

  flush();
  return out;
}

// Public entry point retained for backwards compatibility and direct use on
// already-extracted substrings.
export function decodeQueryComponent(raw: string): string {
  return decodeRange(raw, 0, raw.length);
}
