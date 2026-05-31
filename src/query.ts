import { decodeRange } from "./decode.js";
import { encodeQueryComponent } from "./encode.js";
import { CH_AMP, findKeyMatch } from "./internal.js";
import {
  compareDecodedValueRange,
  hasQueryParamDecodedFallback,
  keyIsAmbiguous,
  queryHasEncoding,
  queryParamDecodedFallback,
  queryParamEqualsDecodedFallback,
} from "./query-scan.js";

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

// fallow-ignore-next-line complexity
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

// Lazy gate for setQueryParams / removeQueryParams' decoded fallback:
// queryHasEncoding is computed at most once per public call. -1 = not yet
// computed; 0 = no '%'/'+' anywhere in the query (fallback can never fire);
// 1 = at least one present. Reset to -1 at every public-call entry; consumed
// inside matchFieldDecodedFallback. Same allocation-free pattern as locate().
let Q_ENC_STATE = -1;

// Cold-path WHATWG-decoded fallback shared by setQueryParams and
// removeQueryParams. Only invoked after the byte-equal prefilter misses;
// further short-circuited unless (a) at least one key has length ≤ fieldLen,
// (b) the query contains '%'/'+', and (c) THIS field contains '%'/'+'.
// Returns the matched key slot, or -1.
//
// Extracted because the hot byte-strict prefilter MUST stay inline at both
// call sites — function-call overhead per field shows up as ~3% on rqp.removeN.
// The fallback is cold (typically taken on < 1% of fields), so the call
// boundary here is invisible.
function matchFieldDecodedFallback(
  raw: string,
  fieldStart: number,
  keyEnd: number,
  fieldLen: number,
  keys: readonly string[],
  queryStart: number,
  queryEnd: number
): number {
  // Decoded length ≤ encoded length: prune when no key could possibly fit.
  let couldMatch = false;
  const n = keys.length;
  for (let k = 0; k < n; k++) {
    if (fieldLen >= keys[k].length) {
      couldMatch = true;
      break;
    }
  }
  if (!couldMatch) {
    return -1;
  }
  if (Q_ENC_STATE === -1) {
    Q_ENC_STATE = queryHasEncoding(raw, queryStart, queryEnd) ? 1 : 0;
  }
  if (Q_ENC_STATE === 0) {
    return -1;
  }
  let fieldEnc = false;
  for (let p = fieldStart; p < keyEnd; p++) {
    const c = raw.charCodeAt(p);
    if (c === CH_PERCENT || c === CH_PLUS) {
      fieldEnc = true;
      break;
    }
  }
  if (!fieldEnc) {
    return -1;
  }
  for (let k = 0; k < n; k++) {
    if (
      fieldLen >= keys[k].length &&
      compareDecodedValueRange(raw, fieldStart, keyEnd, keys[k])
    ) {
      return k;
    }
  }
  return -1;
}

// fallow-ignore-next-line complexity
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
// fallow-ignore-next-line complexity
export function readQueryParam(rawUrl: string, key: string): string | null {
  locate(rawUrl);
  const qPos = LOC_Q;
  if (qPos === -1) {
    return null;
  }
  const end = LOC_F;
  const keyLen = key.length;
  const queryStart = qPos + 1;

  // Fast path: clean ASCII key (no '%'/'+'). One SIMD-vectorized indexOf(key)
  // per iteration locates a candidate; cheap boundary chars confirm it's a
  // field-name match. Strictly fewer string ops per field than the previous
  // per-field walk (indexOf("&") + indexOf("=") + startsWith).
  if (!keyIsAmbiguous(key)) {
    const idx = findKeyMatch(rawUrl, queryStart, end, key);
    if (idx !== -1) {
      const after = idx + keyLen;
      if (after === end || rawUrl.charCodeAt(after) === CH_AMP) {
        return "";
      }
      // next is '=' (the only other byte findKeyMatch accepts as a boundary).
      let amp = rawUrl.indexOf("&", after + 1);
      if (amp === -1 || amp > end) {
        amp = end;
      }
      return decodeRange(rawUrl, after + 1, amp);
    }
    // Decoded-key fallback: only meaningful when URL has '%'/'+' encoding.
    if (!queryHasEncoding(rawUrl, queryStart, end)) {
      return null;
    }
    return queryParamDecodedFallback(rawUrl, queryStart, end, key, keyLen);
  }

  // Ambiguous user key: each byte-equal hit must be verified with the WHATWG
  // walker before being returned.
  let i = queryStart;
  while (i < end) {
    let amp = rawUrl.indexOf("&", i);
    if (amp === -1 || amp > end) {
      amp = end;
    }
    const eq = rawUrl.indexOf("=", i);
    const keyEnd = eq === -1 || eq > amp ? amp : eq;

    if (
      keyEnd - i === keyLen &&
      rawUrl.startsWith(key, i) &&
      compareDecodedValueRange(rawUrl, i, keyEnd, key)
    ) {
      if (eq === -1 || eq > amp) {
        return "";
      }
      return decodeRange(rawUrl, eq + 1, amp);
    }
    i = amp + 1;
  }

  if (!queryHasEncoding(rawUrl, queryStart, end)) {
    return null;
  }
  return queryParamDecodedFallback(rawUrl, queryStart, end, key, keyLen);
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
// fallow-ignore-next-line complexity
export function readQueryParams<const K extends readonly string[]>(
  rawUrl: string,
  keys: K
): { -readonly [I in keyof K]: string | null } {
  const n = keys.length;
  const out: (string | null)[] = new Array(n);
  if (n === 0) {
    return out as { -readonly [I in keyof K]: string | null };
  }

  // Precompute (firstChar << 16 | length) packed prefilter + ambig flag for
  // each key. The inner loop's hot reject is a single int compare against the
  // field's matching pack — half the array reads and compares vs. holding
  // firstChar and length as separate arrays.
  const keyPacked: number[] = new Array(n);
  const keyAmbig: boolean[] = new Array(n);
  for (let k = 0; k < n; k++) {
    out[k] = null;
    const kk = keys[k];
    keyPacked[k] = kk.charCodeAt(0) * 65536 + kk.length;
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
    const fieldPacked = rawUrl.charCodeAt(i) * 65536 + (keyEnd - i);

    for (let k = 0; k < n; k++) {
      if (keyPacked[k] !== fieldPacked) {
        // Also skips already-found slots: those are marked with the -1
        // sentinel below, which can't match a non-negative fieldPacked.
        continue;
      }
      if (rawUrl.startsWith(keys[k], i)) {
        if (
          !keyAmbig[k] ||
          compareDecodedValueRange(rawUrl, i, keyEnd, keys[k])
        ) {
          out[k] =
            eq === -1 || eq > amp ? "" : decodeRange(rawUrl, eq + 1, amp);
          keyPacked[k] = -1;
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
        if (keyPacked[k] === -1) {
          continue;
        }
        if (fieldLen < keys[k].length) {
          continue;
        }
        if (compareDecodedValueRange(rawUrl, j, keyEnd, keys[k])) {
          out[k] =
            eq === -1 || eq > amp ? "" : decodeRange(rawUrl, eq + 1, amp);
          keyPacked[k] = -1;
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
// fallow-ignore-next-line complexity
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
// fallow-ignore-next-line complexity
export function setQueryParams(
  rawUrl: string,
  params: Record<string, string | null>
): string {
  const keys = Object.keys(params);
  const n = keys.length;
  if (n === 0) {
    return rawUrl;
  }

  // Pre-encode keys + non-null values + precompute packed (firstChar<<16|len)
  // and ambig flag for the matcher loop. Single-int prefilter is half the
  // array reads and compares vs. holding firstChar and length separately.
  // Combined-scan per key (analyzeSetterKey) avoids double walks for clean
  // ASCII keys.
  const encoded: (string | null)[] = new Array(n);
  const encodedKeys: string[] = new Array(n);
  const keyPacked: number[] = new Array(n);
  const keyAmbig: boolean[] = new Array(n);
  const seen = new Array<boolean>(n).fill(false);
  for (let k = 0; k < n; k++) {
    const v = params[keys[k]];
    encoded[k] = v === null ? null : encodeQueryComponent(v);
    analyzeSetterKey(keys[k]);
    encodedKeys[k] = KEY_ENCODED;
    keyAmbig[k] = KEY_AMBIG;
    keyPacked[k] = keys[k].charCodeAt(0) * 65536 + keys[k].length;
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
  Q_ENC_STATE = -1;

  while (i < queryEnd) {
    let amp = rawUrl.indexOf("&", i);
    if (amp === -1 || amp > queryEnd) {
      amp = queryEnd;
    }
    const eq = rawUrl.indexOf("=", i);
    const keyEnd = eq === -1 || eq > amp ? amp : eq;
    const fieldLen = keyEnd - i;
    const fieldPacked = rawUrl.charCodeAt(i) * 65536 + fieldLen;

    let matchedSlot = -1;
    for (let k = 0; k < n; k++) {
      if (keyPacked[k] !== fieldPacked) {
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
    if (matchedSlot === -1) {
      matchedSlot = matchFieldDecodedFallback(
        rawUrl,
        i,
        keyEnd,
        fieldLen,
        keys,
        queryStart,
        queryEnd
      );
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
// fallow-ignore-next-line complexity
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

  const keyPacked: number[] = new Array(n);
  const keyAmbig: boolean[] = new Array(n);
  for (let k = 0; k < n; k++) {
    keyPacked[k] = keys[k].charCodeAt(0) * 65536 + keys[k].length;
    keyAmbig[k] = keyIsAmbiguous(keys[k]);
  }

  const queryStart = qPos + 1;
  let newQuery = "";
  let i = queryStart;
  Q_ENC_STATE = -1;

  while (i < queryEnd) {
    let amp = rawUrl.indexOf("&", i);
    if (amp === -1 || amp > queryEnd) {
      amp = queryEnd;
    }
    const eq = rawUrl.indexOf("=", i);
    const keyEnd = eq === -1 || eq > amp ? amp : eq;
    const fieldLen = keyEnd - i;
    const fieldPacked = rawUrl.charCodeAt(i) * 65536 + fieldLen;

    let isMatch = false;
    for (let k = 0; k < n; k++) {
      if (keyPacked[k] !== fieldPacked) {
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
    if (
      !isMatch &&
      matchFieldDecodedFallback(
        rawUrl,
        i,
        keyEnd,
        fieldLen,
        keys,
        queryStart,
        queryEnd
      ) !== -1
    ) {
      isMatch = true;
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
// fallow-ignore-next-line complexity
export function hasQueryParam(rawUrl: string, key: string): boolean {
  // Inlined locate — keeps the call sites tight for tight-loop callers.
  const qPos = rawUrl.indexOf("?");
  if (qPos === -1) {
    return false;
  }
  const hPos = rawUrl.indexOf("#");
  if (hPos !== -1 && hPos < qPos) {
    return false;
  }
  const fragmentStart = hPos === -1 ? rawUrl.length : hPos;
  const queryStart = qPos + 1;
  const keyLen = key.length;

  // Fast path: clean ASCII key. Single SIMD-vectorized indexOf(key) per
  // iteration; cheap boundary chars confirm a field-name match. Roughly
  // 5–6× faster on long queries with the key near the end vs the previous
  // per-field walk.
  if (!keyIsAmbiguous(key)) {
    if (findKeyMatch(rawUrl, queryStart, fragmentStart, key) !== -1) {
      return true;
    }
    if (!queryHasEncoding(rawUrl, queryStart, fragmentStart)) {
      return false;
    }
    return hasQueryParamDecodedFallback(
      rawUrl,
      queryStart,
      fragmentStart,
      key,
      keyLen
    );
  }

  // Ambiguous user key: each byte-equal hit must round-trip through the
  // WHATWG walker before being accepted.
  let i = queryStart;
  while (i < fragmentStart) {
    let amp = rawUrl.indexOf("&", i);
    if (amp === -1 || amp > fragmentStart) {
      amp = fragmentStart;
    }
    const eq = rawUrl.indexOf("=", i);
    const keyEnd = eq === -1 || eq > amp ? amp : eq;
    if (
      keyEnd - i === keyLen &&
      rawUrl.startsWith(key, i) &&
      compareDecodedValueRange(rawUrl, i, keyEnd, key)
    ) {
      return true;
    }
    i = amp + 1;
  }

  if (!queryHasEncoding(rawUrl, queryStart, fragmentStart)) {
    return false;
  }
  return hasQueryParamDecodedFallback(
    rawUrl,
    queryStart,
    fragmentStart,
    key,
    keyLen
  );
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
// fallow-ignore-next-line complexity
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
  const queryStart = qPos + 1;
  const keyLen = key.length;

  // Fast path: clean ASCII key. Single SIMD indexOf to locate the field, then
  // run the WHATWG value comparator over the value range.
  if (!keyIsAmbiguous(key)) {
    const idx = findKeyMatch(rawUrl, queryStart, fragmentStart, key);
    if (idx !== -1) {
      const after = idx + keyLen;
      if (after === fragmentStart || rawUrl.charCodeAt(after) === CH_AMP) {
        return expected.length === 0; // bare key, no '=' → empty value
      }
      // next is '='
      let amp = rawUrl.indexOf("&", after + 1);
      if (amp === -1 || amp > fragmentStart) {
        amp = fragmentStart;
      }
      return compareDecodedValueRange(rawUrl, after + 1, amp, expected);
    }
    if (!queryHasEncoding(rawUrl, queryStart, fragmentStart)) {
      return false;
    }
    return queryParamEqualsDecodedFallback(
      rawUrl,
      queryStart,
      fragmentStart,
      key,
      keyLen,
      expected
    );
  }

  // Ambiguous user key: each byte-equal hit verified via the WHATWG walker.
  let i = queryStart;
  while (i < fragmentStart) {
    let amp = rawUrl.indexOf("&", i);
    if (amp === -1 || amp > fragmentStart) {
      amp = fragmentStart;
    }
    const eq = rawUrl.indexOf("=", i);
    const keyEnd = eq === -1 || eq > amp ? amp : eq;
    if (
      keyEnd - i === keyLen &&
      rawUrl.startsWith(key, i) &&
      compareDecodedValueRange(rawUrl, i, keyEnd, key)
    ) {
      const valStart = eq === -1 || eq > amp ? amp : eq + 1;
      return compareDecodedValueRange(rawUrl, valStart, amp, expected);
    }
    i = amp + 1;
  }

  if (!queryHasEncoding(rawUrl, queryStart, fragmentStart)) {
    return false;
  }
  return queryParamEqualsDecodedFallback(
    rawUrl,
    queryStart,
    fragmentStart,
    key,
    keyLen,
    expected
  );
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
