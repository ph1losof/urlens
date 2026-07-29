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

    if (c < 128 && SAFE[c] === 1) {
      i++;
      continue;
    }

    if (i > runStart) {
      out += value.substring(runStart, i);
    }

    if (c === 32) {
      out += "+";
      i++;
    } else if (c < 128) {
      out += PCT_HEX[c];
      i++;
    } else if (c < 0x800) {
      out += PCT_HEX[0xc0 | (c >> 6)] + PCT_HEX[0x80 | (c & 0x3f)];
      i++;
    } else if (c < 0xd800 || c >= 0xe000) {
      out +=
        PCT_HEX[0xe0 | (c >> 12)] +
        PCT_HEX[0x80 | ((c >> 6) & 0x3f)] +
        PCT_HEX[0x80 | (c & 0x3f)];
      i++;
    } else if (c < 0xdc00 && i + 1 < len) {
      const c2 = value.charCodeAt(i + 1);
      if (c2 >= 0xdc00 && c2 < 0xe000) {
        const cp = 0x10000 + ((c - 0xd800) << 10) + (c2 - 0xdc00);
        out +=
          PCT_HEX[0xf0 | (cp >> 18)] +
          PCT_HEX[0x80 | ((cp >> 12) & 0x3f)] +
          PCT_HEX[0x80 | ((cp >> 6) & 0x3f)] +
          PCT_HEX[0x80 | (cp & 0x3f)];
        i += 2;
      } else {
        // WHATWG replaces lone surrogates with U+FFFD.
        out += PCT_FFFD;
        i++;
      }
    } else {
      out += PCT_FFFD;
      i++;
    }

    runStart = i;
  }

  // Preserve the original string when no encoding was needed.
  if (runStart === 0) {
    return value;
  }
  if (runStart < len) {
    out += value.substring(runStart);
  }
  return out;
}
