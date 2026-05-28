// Hand-rolled WHATWG `application/x-www-form-urlencoded` encoder. No call to
// `encodeURIComponent` — we walk the JS string once, transcoding UTF-16 to
// UTF-8 inline and emitting `%XX` percent escapes via a precomputed lookup
// table.
//
// Why not just call `encodeURIComponent`? Each call crosses the JS/C++
// boundary (function-call overhead + observable side-effects); then we'd post-
// process the result to replace `%20` with `+` and to escape the five chars
// (`!` `'` `(` `)` `~`) that `encodeURIComponent` leaves but WHATWG escapes.
// Two passes, one of which is native, both walking the string. The pure-JS
// version below does it in **one pass** with predictable cost.
//
// Performance shape:
//   * All-ASCII safe input (`"q"`, `"utm_source"`, etc.) — single scan, no
//     allocation, returns input. ~3–10ns.
//   * Spaces / safe-mix — one cons-string concat per unsafe char + a sliced
//     substring for the preceding safe run.
//   * UTF-8 — inlined 2/3/4-byte transcode using the surrogate-pair-aware
//     branch ladder.
//
// SAFE: 128-entry Uint8Array, 1 iff the char is in the WHATWG safe set:
//   `* - . _ 0-9 A-Z a-z`. Membership check is a single array load.
//
// PCT_HEX: 256 precomputed `"%XX"` strings indexed by byte value. Avoids
// per-byte string concatenation for the hex characters.

const SAFE = new Uint8Array(128);
for (let c = 48; c <= 57; c++) {
  SAFE[c] = 1; // 0-9
}
for (let c = 65; c <= 90; c++) {
  SAFE[c] = 1; // A-Z
}
for (let c = 97; c <= 122; c++) {
  SAFE[c] = 1; // a-z
}
SAFE[42] = 1; // *
SAFE[45] = 1; // -
SAFE[46] = 1; // .
SAFE[95] = 1; // _

const PCT_HEX: string[] = new Array(256);
{
  const HEX = "0123456789ABCDEF";
  for (let b = 0; b < 256; b++) {
    PCT_HEX[b] = `%${HEX[(b >> 4) & 0xf]}${HEX[b & 0xf]}`;
  }
}

// U+FFFD (REPLACEMENT CHARACTER) in UTF-8: EF BF BD. Emitted for lone
// surrogates to match WHATWG behavior.
const PCT_FFFD = `${PCT_HEX[0xef]}${PCT_HEX[0xbf]}${PCT_HEX[0xbd]}`;

/**
 * Encodes `value` for safe use as a query-string component, per WHATWG
 * `application/x-www-form-urlencoded` rules.
 *
 * The safe set is exactly `* - . _ 0-9 A-Z a-z`; spaces become `+`;
 * everything else is percent-encoded. This differs from `encodeURIComponent`,
 * which also leaves `!` `'` `(` `)` `~` unescaped. Lone surrogates are
 * replaced with U+FFFD per the spec.
 *
 * When `value` contains no unsafe characters, the input is returned verbatim
 * — no allocation.
 *
 * @example
 *   encodeQueryComponent("hello world"); // → "hello+world"
 *   encodeQueryComponent("café");        // → "caf%C3%A9"
 *   encodeQueryComponent("q");           // → "q" (unchanged)
 */
// fallow-ignore-next-line complexity
export function encodeQueryComponent(value: string): string {
  const len = value.length;
  if (len === 0) {
    return value;
  }

  let out = "";
  let runStart = 0;
  let i = 0;

  while (i < len) {
    const c = value.charCodeAt(i);

    // Safe ASCII — extend the current safe run by one.
    if (c < 128 && SAFE[c] === 1) {
      i++;
      continue;
    }

    // Flush the safe run accumulated so far (sliced substring; no byte copy).
    if (i > runStart) {
      out += value.substring(runStart, i);
    }

    if (c === 32) {
      // Space → '+' per form-urlencoded.
      out += "+";
      i++;
    } else if (c < 128) {
      // Unsafe ASCII — single byte.
      out += PCT_HEX[c];
      i++;
    } else if (c < 0x800) {
      // 2-byte UTF-8.
      out += PCT_HEX[0xc0 | (c >> 6)] + PCT_HEX[0x80 | (c & 0x3f)];
      i++;
    } else if (c < 0xd800 || c >= 0xe000) {
      // 3-byte UTF-8 (BMP, non-surrogate).
      out +=
        PCT_HEX[0xe0 | (c >> 12)] +
        PCT_HEX[0x80 | ((c >> 6) & 0x3f)] +
        PCT_HEX[0x80 | (c & 0x3f)];
      i++;
    } else if (c < 0xdc00 && i + 1 < len) {
      // High surrogate — must be followed by a low surrogate.
      const c2 = value.charCodeAt(i + 1);
      if (c2 >= 0xdc00 && c2 < 0xe000) {
        const cp = 0x10000 + ((c - 0xd800) << 10) + (c2 - 0xdc00);
        // 4-byte UTF-8 (astral).
        out +=
          PCT_HEX[0xf0 | (cp >> 18)] +
          PCT_HEX[0x80 | ((cp >> 12) & 0x3f)] +
          PCT_HEX[0x80 | ((cp >> 6) & 0x3f)] +
          PCT_HEX[0x80 | (cp & 0x3f)];
        i += 2;
      } else {
        // Lone high surrogate — emit U+FFFD (WHATWG behavior).
        out += PCT_FFFD;
        i++;
      }
    } else {
      // Lone low surrogate, or unpaired high surrogate at end of input.
      out += PCT_FFFD;
      i++;
    }

    runStart = i;
  }

  // No unsafe chars encountered: return the input verbatim (no allocation).
  if (runStart === 0) {
    return value;
  }
  // Append any trailing safe run.
  if (runStart < len) {
    out += value.substring(runStart);
  }
  return out;
}
