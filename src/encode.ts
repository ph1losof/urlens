// Encodes a value per WHATWG `application/x-www-form-urlencoded`. The native
// `encodeURIComponent` does most of the work but leaves five characters that
// the WHATWG spec escapes: `!` `'` `(` `)` `~`. We also rewrite `%20` to `+`
// per form-urlencoded semantics. Single-pass post-process, no regex.
//
// Performance: a leading char-class scan returns the input verbatim when every
// byte is already in the WHATWG safe set — no native call, no allocation. For
// values that DO need encoding, we hand off to `encodeURIComponent` and
// post-process its output in a single walk.
export function encodeQueryComponent(value: string): string {
  const valueLen = value.length;
  if (valueLen === 0) {
    return value;
  }

  // Fast path: every byte is in the WHATWG safe set (a-z A-Z 0-9 - . _ *).
  // For typical query values like "updated", "true", "12345", this skips the
  // native call AND every allocation below.
  let allSafe = true;
  for (let p = 0; p < valueLen; p++) {
    const c = value.charCodeAt(p);
    // Hot ASCII ranges checked first; symbols last. Branch order matters here
    // because the JIT lays out the most-taken path inline.
    if (c >= 97 && c <= 122) continue; // a-z
    if (c >= 65 && c <= 90) continue; // A-Z
    if (c >= 48 && c <= 57) continue; // 0-9
    if (c === 45 || c === 46 || c === 95 || c === 42) continue; // - . _ *
    allSafe = false;
    break;
  }
  if (allSafe) {
    return value;
  }

  const initial = encodeURIComponent(value);

  let out = "";
  let runStart = 0;
  let i = 0;
  const len = initial.length;

  while (i < len) {
    const c = initial.charCodeAt(i);

    // Percent escapes: only `%20` needs rewriting (→ `+`). Every other `%XY`
    // is already in canonical WHATWG form — skip past it without inspection.
    if (c === CH_PERCENT) {
      if (
        i + 2 < len &&
        initial.charCodeAt(i + 1) === CH_2 &&
        initial.charCodeAt(i + 2) === CH_0
      ) {
        out += initial.substring(runStart, i);
        out += "+";
        i += 3;
        runStart = i;
      } else {
        // Canonical %XY — leave it alone. Advance past the two hex digits in
        // one step; encodeURIComponent never emits a bare `%`.
        i += 3;
      }
      continue;
    }

    // The five chars that encodeURIComponent leaves but WHATWG escapes.
    let replacement: string;
    switch (c) {
      case CH_BANG:
        replacement = "%21";
        break;
      case CH_QUOTE:
        replacement = "%27";
        break;
      case CH_LPAREN:
        replacement = "%28";
        break;
      case CH_RPAREN:
        replacement = "%29";
        break;
      case CH_TILDE:
        replacement = "%7E";
        break;
      default:
        i++;
        continue;
    }

    out += initial.substring(runStart, i);
    out += replacement;
    i++;
    runStart = i;
  }

  // `runStart` only moves past 0 when we made a replacement, so its value
  // doubles as a "did anything change?" flag — avoids the cons-string flatten
  // when the input was already canonical.
  if (runStart === 0) {
    return initial;
  }
  return out + initial.substring(runStart);
}

const CH_PERCENT = 0x25; // %
const CH_BANG = 0x21; // !
const CH_QUOTE = 0x27; // '
const CH_LPAREN = 0x28; // (
const CH_RPAREN = 0x29; // )
const CH_TILDE = 0x7e; // ~
const CH_2 = 0x32; // '2'
const CH_0 = 0x30; // '0'
