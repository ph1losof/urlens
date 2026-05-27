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

// Returns true if `[start, end)` of `rawUrl` contains any character WHATWG
// `application/x-www-form-urlencoded` decoding would interpret (`%` or `+`).
// Gates the decoded-key fallback: when false, byte-strict was conclusive.
// Two SIMD-accelerated indexOf calls; the early return after the first hit
// makes the typical "encoded value, plain query" case ~5ns.
//
// Module-internal export: shared with UrlView via view.ts. Not in index.ts.
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

// Returns true if `key` contains any character that would make WHATWG
// disagree with byte-equal matching on the URL side (i.e. `%` or `+`).
// Used as the ambiguity gate at function entry: if false, byte-equal hits
// are WHATWG-correct and can be returned immediately; if true, each
// byte-equal hit is verified with compareDecodedValueRange.
//
// Module-internal export: shared with UrlView via view.ts. Not in index.ts.
export function keyIsAmbiguous(key: string): boolean {
  return key.indexOf("%") !== -1 || key.indexOf("+") !== -1;
}

// Setter combined-scan helper.
//
// Setters need TWO things about the user key: its WHATWG-canonical encoded
// form (for emission) and whether it contains `%`/`+` (ambiguity gate).
// Computing them separately walks the key twice. This routine does both in
// one pass and stashes the results in module-level scratch
// (KEY_ENCODED, KEY_AMBIG) — same allocation-free pattern as locate().
//
// For all-safe ASCII keys (the overwhelmingly common case) we short-circuit
// after the scan with `KEY_ENCODED = key` (the input itself) and
// `KEY_AMBIG = false`, avoiding the encoder's per-char emit work entirely.
const SAFE_KEY = new Uint8Array(128);
for (let c = 48; c <= 57; c++) {
  SAFE_KEY[c] = 1;
}
for (let c = 65; c <= 90; c++) {
  SAFE_KEY[c] = 1;
}
for (let c = 97; c <= 122; c++) {
  SAFE_KEY[c] = 1;
}
SAFE_KEY[42] = 1; // *
SAFE_KEY[45] = 1; // -
SAFE_KEY[46] = 1; // .
SAFE_KEY[95] = 1; // _

let KEY_ENCODED = "";
let KEY_AMBIG = false;

function analyzeSetterKey(key: string): void {
  const len = key.length;
  let allSafe = true;
  let hasAmbig = false;
  for (let p = 0; p < len; p++) {
    const c = key.charCodeAt(p);
    if (c === CH_PERCENT || c === CH_PLUS) {
      hasAmbig = true;
      allSafe = false;
    } else if (c >= 128 || SAFE_KEY[c] !== 1) {
      allSafe = false;
    }
  }
  KEY_AMBIG = hasAmbig;
  KEY_ENCODED = allSafe ? key : encodeQueryComponent(key);
}

/**
 * Returns the decoded value of `key` from the query string of `rawUrl`, or
 * `null` if absent. Returns `""` if the key is present without a value
 * (e.g. `?k` or `?k=`).
 *
 * Keys are matched per WHATWG `application/x-www-form-urlencoded` semantics:
 * `+` decodes to space, percent-encoded UTF-8 is decoded, both sides are
 * compared as decoded codepoints. Matches `URLSearchParams.get` exactly. A
 * byte-strict pass runs first with near-zero overhead; the decoded fallback
 * only fires when the byte-strict pass misses AND the URL has `%`/`+` in
 * the query.
 *
 * @example
 *   readQueryParam("https://x/?q=hello+world", "q");          // → "hello world"
 *   readQueryParam("https://x/?weird%20key=v", "weird key");  // → "v"
 *   readQueryParam("https://x/", "q");                        // → null
 *   readQueryParam("https://x/?k", "k");                      // → ""
 */
export function readQueryParam(rawUrl: string, key: string): string | null {
  locate(rawUrl);
  const qPos = LOC_Q;
  if (qPos === -1) {
    return null;
  }
  const end = LOC_F;
  const keyLen = key.length;
  // Cheap one-time ambiguity check: if the user key has no `%`/`+`, every
  // byte-equal match is WHATWG-correct; otherwise verify each hit before
  // returning to avoid false positives.
  const userAmbig = keyIsAmbiguous(key);

  // Pass 1: byte-strict matching. Hot path returns inside the loop without
  // touching the slow-path code below.
  let i = qPos + 1;
  while (i < end) {
    let amp = rawUrl.indexOf("&", i);
    if (amp === -1 || amp > end) {
      amp = end;
    }
    const eq = rawUrl.indexOf("=", i);
    const keyEnd = eq === -1 || eq > amp ? amp : eq;

    if (keyEnd - i === keyLen && rawUrl.startsWith(key, i)) {
      if (!userAmbig || compareDecodedValueRange(rawUrl, i, keyEnd, key)) {
        if (eq === -1 || eq > amp) {
          return "";
        }
        return decodeRange(rawUrl, eq + 1, amp);
      }
      // Ambiguous user key + byte-match disagreed with WHATWG; keep scanning.
    }

    i = amp + 1;
  }

  // Pass 1 missed. The URL must contain `%` or `+` somewhere in the query
  // for a decoded match to be possible — if not, the miss is conclusive.
  if (!queryHasEncoding(rawUrl, qPos + 1, end)) {
    return null;
  }

  // Pass 2: WHATWG-decoded key match via the existing UTF-8 walker. Decoded
  // length is always ≤ encoded length, so `fieldLen < keyLen` prunes
  // candidates without paying for the walker.
  i = qPos + 1;
  while (i < end) {
    let amp = rawUrl.indexOf("&", i);
    if (amp === -1 || amp > end) {
      amp = end;
    }
    const eq = rawUrl.indexOf("=", i);
    const keyEnd = eq === -1 || eq > amp ? amp : eq;
    if (
      keyEnd - i >= keyLen &&
      compareDecodedValueRange(rawUrl, i, keyEnd, key)
    ) {
      if (eq === -1 || eq > amp) {
        return "";
      }
      return decodeRange(rawUrl, eq + 1, amp);
    }
    i = amp + 1;
  }
  return null;
}

/**
 * Reads multiple query values in a single pass and returns them as a tuple
 * positionally aligned with the input `keys`.
 *
 * Roughly N× cheaper than calling {@link readQueryParam} N times for the same
 * URL — scans the query string once, with first-char / length prefilter, and
 * exits as soon as every key is resolved. WHATWG-decoded key matching falls
 * back via the same byte-strict-first + lazy-decoded-pass pattern as the
 * single-key reader; unmatched slots are filled by a second pass when the
 * URL contains `%`/`+`.
 *
 * The `const` generic preserves the input tuple shape so destructuring is
 * fully typed:
 *
 * @example
 *   const [q, src] = readQueryParams(
 *     "https://x/r?q=hi&utm_source=ig",
 *     ["q", "utm_source"] as const,
 *   );
 *   // q: string | null, src: string | null
 *
 * For destructuring by **name**, use `view(url).queryParams(keys)` — it
 * returns an object keyed by the input keys.
 */
export function readQueryParams<const K extends readonly string[]>(
  rawUrl: string,
  keys: K
): { -readonly [I in keyof K]: string | null } {
  const n = keys.length;
  const out: (string | null)[] = new Array(n);
  if (n === 0) {
    return out as { -readonly [I in keyof K]: string | null };
  }

  // Precompute (firstChar, length, ambig) for each key. The inner loop
  // rejects candidate params with two integer compares — far cheaper than a
  // startsWith call for every (param, key) pair — and only verifies ambiguous
  // keys with the decoded walker on hit.
  const firstChars: number[] = new Array(n);
  const keyLens: number[] = new Array(n);
  const keyAmbig: boolean[] = new Array(n);
  for (let k = 0; k < n; k++) {
    out[k] = null;
    const kk = keys[k];
    firstChars[k] = kk.charCodeAt(0);
    keyLens[k] = kk.length;
    keyAmbig[k] = keyIsAmbiguous(kk);
  }

  locate(rawUrl);
  const qPos = LOC_Q;
  if (qPos === -1) {
    return out as { -readonly [I in keyof K]: string | null };
  }
  const end = LOC_F;

  // Pass 1: byte-strict.
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
      if (keyLens[k] !== fieldLen || firstChars[k] !== fc) {
        continue;
      }
      if (rawUrl.startsWith(keys[k], i)) {
        if (
          !keyAmbig[k] ||
          compareDecodedValueRange(rawUrl, i, keyEnd, keys[k])
        ) {
          out[k] =
            eq === -1 || eq > amp ? "" : decodeRange(rawUrl, eq + 1, amp);
          remaining--;
        }
      }
    }

    i = amp + 1;
  }

  // Pass 2: WHATWG-decoded fallback for unmatched slots, only if the URL has
  // encoding (otherwise byte-strict was conclusive).
  if (remaining > 0 && queryHasEncoding(rawUrl, qPos + 1, end)) {
    let j = qPos + 1;
    while (j < end && remaining > 0) {
      let amp = rawUrl.indexOf("&", j);
      if (amp === -1 || amp > end) {
        amp = end;
      }
      const eq = rawUrl.indexOf("=", j);
      const keyEnd = eq === -1 || eq > amp ? amp : eq;
      const fieldLen = keyEnd - j;
      for (let k = 0; k < n; k++) {
        if (out[k] !== null) {
          continue;
        }
        if (fieldLen < keyLens[k]) {
          continue;
        }
        if (compareDecodedValueRange(rawUrl, j, keyEnd, keys[k])) {
          out[k] =
            eq === -1 || eq > amp ? "" : decodeRange(rawUrl, eq + 1, amp);
          remaining--;
        }
      }
      j = amp + 1;
    }
  }

  return out as { -readonly [I in keyof K]: string | null };
}

/**
 * Returns a new URL string with `key` set to `value`, or with `key` removed
 * when `value` is `null`. Matches `URLSearchParams.set` semantics for
 * duplicates: the first occurrence is replaced, any subsequent occurrences
 * are removed.
 *
 * Both the key and value are serialized per WHATWG
 * `application/x-www-form-urlencoded`: spaces become `+`, every byte outside
 * `* - . _ 0-9 A-Z a-z` is percent-encoded. Key matching is also WHATWG-
 * decoded — so `setQueryParam("?weird%20key=old", "weird key", "new")`
 * replaces the existing encoded key in place.
 *
 * @example
 *   setQueryParam("https://x/?a=1", "q", "hello world");
 *   // → "https://x/?a=1&q=hello+world"
 *
 *   setQueryParam("https://x/?q=old", "q", null);
 *   // → "https://x/" (delete)
 *
 *   setQueryParam("https://x/?weird%20key=old", "weird key", "new");
 *   // → "https://x/?weird+key=new"
 */
export function setQueryParam(
  rawUrl: string,
  key: string,
  value: string | null
): string {
  locate(rawUrl);
  const qPos = LOC_Q;
  const fragmentStart = LOC_F;
  // Single-pass analysis: produces canonical encoded form + ambiguity flag.
  analyzeSetterKey(key);
  const encodedKey = KEY_ENCODED;
  const userAmbig = KEY_AMBIG;

  if (qPos === -1) {
    if (value === null) {
      return rawUrl;
    }
    const pair = `${encodedKey}=${encodeQueryComponent(value)}`;
    return `${rawUrl.substring(0, fragmentStart)}?${pair}${rawUrl.substring(fragmentStart)}`;
  }

  const queryStart = qPos + 1;
  const queryEnd = fragmentStart;
  const keyLen = key.length;
  const encoded = value === null ? null : encodeQueryComponent(value);
  // Lazy: -1 uncomputed, 0 no encoding, 1 encoding present. Never reached if
  // every field byte-matches or has `fieldLen < keyLen` — that's the hot path.
  let queryEncodingState = -1;

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
    const fieldLen = keyEnd - i;
    let isMatch = fieldLen === keyLen && rawUrl.startsWith(key, i);

    // Verify ambiguous byte-equal hits. byte-equal can disagree with WHATWG
    // when both sides have identical encoded bytes that decode to something
    // else (e.g. user key "a%20b" vs URL key "a%20b" — WHATWG no-match).
    if (isMatch && userAmbig) {
      if (!compareDecodedValueRange(rawUrl, i, keyEnd, key)) {
        isMatch = false;
      }
    }

    // WHATWG-decoded fallback when byte-equal failed.
    if (!isMatch && fieldLen >= keyLen) {
      if (queryEncodingState === -1) {
        queryEncodingState = queryHasEncoding(rawUrl, queryStart, queryEnd)
          ? 1
          : 0;
      }
      if (queryEncodingState === 1) {
        // Per-field encoding presence check before paying for the full walker.
        let fieldEnc = false;
        for (let p = i; p < keyEnd; p++) {
          const c = rawUrl.charCodeAt(p);
          if (c === CH_PERCENT || c === CH_PLUS) {
            fieldEnc = true;
            break;
          }
        }
        if (fieldEnc && compareDecodedValueRange(rawUrl, i, keyEnd, key)) {
          isMatch = true;
        }
      }
    }

    if (isMatch) {
      // First match: emit replacement (if value is non-null); drop dupes.
      if (!replaced && encoded !== null) {
        if (newQuery.length > 0) {
          newQuery += "&";
        }
        newQuery += `${encodedKey}=${encoded}`;
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
    newQuery += `${encodedKey}=${encoded}`;
  }

  const prefix = rawUrl.substring(0, qPos);
  const suffix = rawUrl.substring(queryEnd);
  if (newQuery.length === 0) {
    return prefix + suffix;
  }
  return `${prefix}?${newQuery}${suffix}`;
}

/**
 * Bulk version of {@link setQueryParam}. Single-pass over the existing query:
 * each existing param is either replaced (if its key is in `params`), skipped
 * (if `params[key]` is `null`), or kept verbatim. Any keys in `params` not
 * present in the URL are appended at the end in iteration order.
 *
 * Keys are matched and serialized per WHATWG `application/x-www-form-urlencoded`.
 *
 * @example
 *   setQueryParams("https://x/?a=1&b=2", { a: "new", b: null, c: "3" });
 *   // → "https://x/?a=new&c=3"
 */
export function setQueryParams(
  rawUrl: string,
  params: Record<string, string | null>
): string {
  const keys = Object.keys(params);
  const n = keys.length;
  if (n === 0) {
    return rawUrl;
  }

  // Pre-encode keys + non-null values + precompute (firstChar, length, ambig)
  // for the matcher loop. Combined-scan per key (analyzeSetterKey) avoids
  // double walks for clean ASCII keys.
  const encoded: (string | null)[] = new Array(n);
  const encodedKeys: string[] = new Array(n);
  const firstChars: number[] = new Array(n);
  const keyLens: number[] = new Array(n);
  const keyAmbig: boolean[] = new Array(n);
  const seen = new Array<boolean>(n).fill(false);
  for (let k = 0; k < n; k++) {
    const v = params[keys[k]];
    encoded[k] = v === null ? null : encodeQueryComponent(v);
    analyzeSetterKey(keys[k]);
    encodedKeys[k] = KEY_ENCODED;
    keyAmbig[k] = KEY_AMBIG;
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
      body += `${encodedKeys[k]}=${encoded[k]}`;
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
  let queryEncodingState = -1;

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
        if (
          keyAmbig[k] &&
          !compareDecodedValueRange(rawUrl, i, keyEnd, keys[k])
        ) {
          continue;
        }
        matchedSlot = k;
        break;
      }
    }

    // WHATWG-decoded fallback when no byte-equal match.
    if (matchedSlot === -1) {
      let couldMatch = false;
      for (let k = 0; k < n; k++) {
        if (fieldLen >= keyLens[k]) {
          couldMatch = true;
          break;
        }
      }
      if (couldMatch) {
        if (queryEncodingState === -1) {
          queryEncodingState = queryHasEncoding(rawUrl, queryStart, queryEnd)
            ? 1
            : 0;
        }
        if (queryEncodingState === 1) {
          let fieldEnc = false;
          for (let p = i; p < keyEnd; p++) {
            const c = rawUrl.charCodeAt(p);
            if (c === CH_PERCENT || c === CH_PLUS) {
              fieldEnc = true;
              break;
            }
          }
          if (fieldEnc) {
            for (let k = 0; k < n; k++) {
              if (
                fieldLen >= keyLens[k] &&
                compareDecodedValueRange(rawUrl, i, keyEnd, keys[k])
              ) {
                matchedSlot = k;
                break;
              }
            }
          }
        }
      }
    }

    if (matchedSlot !== -1) {
      const enc = encoded[matchedSlot];
      if (!seen[matchedSlot] && enc !== null) {
        if (newQuery.length > 0) {
          newQuery += "&";
        }
        newQuery += `${encodedKeys[matchedSlot]}=${enc}`;
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
    newQuery += `${encodedKeys[k]}=${encoded[k]}`;
  }

  const prefix = rawUrl.substring(0, qPos);
  const suffix = rawUrl.substring(queryEnd);
  if (newQuery.length === 0) {
    return prefix + suffix;
  }
  return `${prefix}?${newQuery}${suffix}`;
}

/**
 * Removes `key` from the query string. Equivalent to
 * `setQueryParam(url, key, null)` — exists as a discoverability alias because
 * "remove" is the verb most callers search for.
 *
 * If `key` has duplicates, all occurrences are removed (matching
 * `URLSearchParams.delete`). Key matching is WHATWG-decoded.
 *
 * @example
 *   removeQueryParam("https://x/?a=1&utm=ig", "utm");
 *   // → "https://x/?a=1"
 */
export function removeQueryParam(rawUrl: string, key: string): string {
  return setQueryParam(rawUrl, key, null);
}

/**
 * Bulk removal: returns `rawUrl` with every key in `keys` stripped from the
 * query string. Single-pass scan with first-char / length prefilter — strictly
 * cheaper than calling {@link removeQueryParam} once per key, which would
 * rebuild the query string N times. Key matching is WHATWG-decoded.
 *
 * @example
 *   removeQueryParams(
 *     "https://x/?q=hi&utm_source=ig&utm_campaign=spring",
 *     ["utm_source", "utm_campaign"],
 *   );
 *   // → "https://x/?q=hi"
 */
export function removeQueryParams(
  rawUrl: string,
  keys: readonly string[]
): string {
  const n = keys.length;
  if (n === 0) {
    return rawUrl;
  }

  locate(rawUrl);
  const qPos = LOC_Q;
  if (qPos === -1) {
    return rawUrl;
  }
  const fragmentStart = LOC_F;
  const queryEnd = fragmentStart;

  const firstChars: number[] = new Array(n);
  const keyLens: number[] = new Array(n);
  const keyAmbig: boolean[] = new Array(n);
  for (let k = 0; k < n; k++) {
    firstChars[k] = keys[k].charCodeAt(0);
    keyLens[k] = keys[k].length;
    keyAmbig[k] = keyIsAmbiguous(keys[k]);
  }

  const queryStart = qPos + 1;
  let newQuery = "";
  let i = queryStart;
  let queryEncodingState = -1;

  while (i < queryEnd) {
    let amp = rawUrl.indexOf("&", i);
    if (amp === -1 || amp > queryEnd) {
      amp = queryEnd;
    }
    const eq = rawUrl.indexOf("=", i);
    const keyEnd = eq === -1 || eq > amp ? amp : eq;
    const fieldLen = keyEnd - i;
    const fc = rawUrl.charCodeAt(i);

    let isMatch = false;
    for (let k = 0; k < n; k++) {
      if (keyLens[k] !== fieldLen || firstChars[k] !== fc) {
        continue;
      }
      if (rawUrl.startsWith(keys[k], i)) {
        if (
          keyAmbig[k] &&
          !compareDecodedValueRange(rawUrl, i, keyEnd, keys[k])
        ) {
          continue;
        }
        isMatch = true;
        break;
      }
    }

    // WHATWG-decoded fallback when no byte-equal match.
    if (!isMatch) {
      let couldMatch = false;
      for (let k = 0; k < n; k++) {
        if (fieldLen >= keyLens[k]) {
          couldMatch = true;
          break;
        }
      }
      if (couldMatch) {
        if (queryEncodingState === -1) {
          queryEncodingState = queryHasEncoding(rawUrl, queryStart, queryEnd)
            ? 1
            : 0;
        }
        if (queryEncodingState === 1) {
          let fieldEnc = false;
          for (let p = i; p < keyEnd; p++) {
            const c = rawUrl.charCodeAt(p);
            if (c === CH_PERCENT || c === CH_PLUS) {
              fieldEnc = true;
              break;
            }
          }
          if (fieldEnc) {
            for (let k = 0; k < n; k++) {
              if (
                fieldLen >= keyLens[k] &&
                compareDecodedValueRange(rawUrl, i, keyEnd, keys[k])
              ) {
                isMatch = true;
                break;
              }
            }
          }
        }
      }
    }

    if (!isMatch) {
      if (newQuery.length > 0) {
        newQuery += "&";
      }
      newQuery += rawUrl.substring(i, amp);
    }
    // Else: skip this param entirely.

    i = amp + 1;
  }

  const prefix = rawUrl.substring(0, qPos);
  const suffix = rawUrl.substring(queryEnd);
  if (newQuery.length === 0) {
    return prefix + suffix;
  }
  return `${prefix}?${newQuery}${suffix}`;
}

/**
 * Zero-allocation predicate: returns `true` if `key` is present in the query
 * (including bare `?key` with no value). Key matching is WHATWG-decoded.
 *
 * @example
 *   hasQueryParam("https://x/?a=1", "a");                  // → true
 *   hasQueryParam("https://x/?weird%20key=v", "weird key"); // → true
 *   hasQueryParam("https://x/", "a");                      // → false
 */
export function hasQueryParam(rawUrl: string, key: string): boolean {
  // Inlines the locate logic — saves the function call when the key/value
  // sites are tight loops.
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
  const userAmbig = keyIsAmbiguous(key);

  // Pass 1: byte-strict.
  let i = qPos + 1;
  while (i < fragmentStart) {
    let amp = rawUrl.indexOf("&", i);
    if (amp === -1 || amp > fragmentStart) {
      amp = fragmentStart;
    }
    const eq = rawUrl.indexOf("=", i);
    const keyEnd = eq === -1 || eq > amp ? amp : eq;
    if (keyEnd - i === keyLen && rawUrl.startsWith(key, i)) {
      if (!userAmbig || compareDecodedValueRange(rawUrl, i, keyEnd, key)) {
        return true;
      }
    }
    i = amp + 1;
  }

  // Pass 2: WHATWG-decoded fallback, only when URL has encoding.
  if (!queryHasEncoding(rawUrl, qPos + 1, fragmentStart)) {
    return false;
  }
  i = qPos + 1;
  while (i < fragmentStart) {
    let amp = rawUrl.indexOf("&", i);
    if (amp === -1 || amp > fragmentStart) {
      amp = fragmentStart;
    }
    const eq = rawUrl.indexOf("=", i);
    const keyEnd = eq === -1 || eq > amp ? amp : eq;
    if (
      keyEnd - i >= keyLen &&
      compareDecodedValueRange(rawUrl, i, keyEnd, key)
    ) {
      return true;
    }
    i = amp + 1;
  }
  return false;
}

/**
 * Zero-allocation predicate: returns `true` if the decoded value of `key`
 * equals `expected`. Key matching is WHATWG-decoded.
 *
 * Byte-equivalent to `readQueryParam(url, key) === expected`, but never
 * materializes the decoded string — walks the URL's value bytes one
 * codepoint at a time and compares against `expected` in place.
 *
 * Implements the WHATWG UTF-8 decoder for valid 1/2/3/4-byte sequences and
 * surrogate pairs. Malformed UTF-8 sequences are matched against U+FFFD
 * (matching `decodeQueryComponent`).
 *
 * @example
 *   queryParamEquals("https://x/?q=hello+world", "q", "hello world"); // → true
 *   queryParamEquals("https://x/?q=caf%C3%A9", "q", "café");          // → true
 */
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
  const userAmbig = keyIsAmbiguous(key);

  // Pass 1: byte-strict key match, then value comparison via the same walker.
  let i = qPos + 1;
  while (i < fragmentStart) {
    let amp = rawUrl.indexOf("&", i);
    if (amp === -1 || amp > fragmentStart) {
      amp = fragmentStart;
    }
    const eq = rawUrl.indexOf("=", i);
    const keyEnd = eq === -1 || eq > amp ? amp : eq;
    if (keyEnd - i === keyLen && rawUrl.startsWith(key, i)) {
      if (!userAmbig || compareDecodedValueRange(rawUrl, i, keyEnd, key)) {
        const valStart = eq === -1 || eq > amp ? amp : eq + 1;
        return compareDecodedValueRange(rawUrl, valStart, amp, expected);
      }
    }
    i = amp + 1;
  }

  // Pass 2: WHATWG-decoded key match.
  if (!queryHasEncoding(rawUrl, qPos + 1, fragmentStart)) {
    return false;
  }
  i = qPos + 1;
  while (i < fragmentStart) {
    let amp = rawUrl.indexOf("&", i);
    if (amp === -1 || amp > fragmentStart) {
      amp = fragmentStart;
    }
    const eq = rawUrl.indexOf("=", i);
    const keyEnd = eq === -1 || eq > amp ? amp : eq;
    if (
      keyEnd - i >= keyLen &&
      compareDecodedValueRange(rawUrl, i, keyEnd, key)
    ) {
      const valStart = eq === -1 || eq > amp ? amp : eq + 1;
      return compareDecodedValueRange(rawUrl, valStart, amp, expected);
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
//
// Module-internal export: shared with UrlView.queryParamEquals via view.ts.
// Not re-exported from index.ts.
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

/**
 * Returns the raw query string without the leading `?`, or `""` if absent.
 *
 * Does NOT decode percent-escapes. Callers that want decoded values should
 * use {@link readQueryParam} or {@link readQueryParams}.
 *
 * @example
 *   readQuery("https://x/p?a=1&b=2#frag"); // → "a=1&b=2"
 *   readQuery("https://x/p");              // → ""
 */
export function readQuery(rawUrl: string): string {
  locate(rawUrl);
  const qPos = LOC_Q;
  if (qPos === -1) {
    return "";
  }
  return rawUrl.substring(qPos + 1, LOC_F);
}

/**
 * Returns `rawUrl` with the query string removed. Preserves the fragment.
 * Returns the input unchanged when there is no query.
 *
 * @example
 *   stripQuery("https://x/p?q=1#frag"); // → "https://x/p#frag"
 */
export function stripQuery(rawUrl: string): string {
  locate(rawUrl);
  const qPos = LOC_Q;
  if (qPos === -1) {
    return rawUrl;
  }
  return rawUrl.substring(0, qPos) + rawUrl.substring(LOC_F);
}
