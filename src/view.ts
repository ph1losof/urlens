import { decodeRange } from "./decode.js";
import {
  AUTH_PACK,
  CH_AMP,
  CH_COLON,
  CH_OPEN_BRACKET,
  findAuthorityEnd,
  findKeyMatch,
  findSchemeEnd,
  parsePortRange,
} from "./internal.js";
import {
  compareDecodedValueRange,
  hasQueryParamDecodedFallback,
  keyIsAmbiguous,
  queryHasEncoding,
  queryParamDecodedFallback,
  queryParamEqualsDecodedFallback,
} from "./query-scan.js";

/**
 * A precomputed view over a URL string.
 *
 * `UrlView` pays the cost of one linear scan up front in the constructor and
 * caches every component boundary as an integer offset. Every subsequent
 * read (`pathname()`, `query()`, `host()`, …) is a single `substring` against
 * those offsets — no scanning.
 *
 * Allocation profile (one `view(url)` call):
 *   • one `UrlView` instance with a stable hidden class
 *     (raw string ref + 8 SMI offsets)
 *   • zero further allocations on predicate reads
 *   • one sliced-string header per non-predicate read (substring view)
 *
 * Use this when you need 2+ components off the same URL. For one-shot reads,
 * the flat top-level functions (`readPathname`, `readQueryParam`, …) are
 * strictly faster — they don't pay the wrapper-object allocation.
 *
 * @example
 *   const v = view("https://example.com:8080/api/v1?q=hello#frag");
 *   v.scheme();        // → "https"
 *   v.hostname();      // → "example.com"
 *   v.port();          // → 8080
 *   v.pathname();      // → "/api/v1"
 *   v.queryParam("q"); // → "hello"
 *   v.fragment();      // → "frag"
 */
export class UrlView {
  // Property order is part of the runtime contract: V8/SM/JSC assign a single
  // hidden class to instances of UrlView only if every property is written in
  // the same order on every construction. Absent components use -1 sentinels
  // so the shape never varies between instances.
  //
  // Underscore-prefixed (not #private) by design — TS marks them `private`
  // for callers, which is sufficient. `#private` access goes through a
  // WeakMap-style guard in the engines and is measurably slower in tight loops.
  private readonly _raw: string;
  private readonly _len: number;
  private readonly _schemeEnd: number;
  private readonly _hostStart: number;
  private readonly _hostEnd: number;
  private readonly _portColon: number;
  private readonly _authEnd: number;
  private readonly _queryStart: number;
  private readonly _fragStart: number;

  // fallow-ignore-next-line complexity
  constructor(rawUrl: string) {
    const len = rawUrl.length;
    const schemePos = findSchemeEnd(rawUrl);

    let hostStart: number;
    let hostEnd: number;
    let portColon: number;
    let authEnd: number;

    if (schemePos === -1) {
      hostStart = -1;
      hostEnd = -1;
      portColon = -1;
      authEnd = 0;
    } else {
      const authStart = schemePos + 3;
      const packed = findAuthorityEnd(rawUrl, authStart);
      authEnd = packed < AUTH_PACK ? packed : packed % AUTH_PACK;
      const at = packed < AUTH_PACK ? -1 : ((packed / AUTH_PACK) | 0) - 1;
      hostStart = at >= authStart ? at + 1 : authStart;

      if (rawUrl.charCodeAt(hostStart) === CH_OPEN_BRACKET) {
        const close = rawUrl.indexOf("]", hostStart + 1);
        if (close === -1 || close >= authEnd) {
          hostEnd = authEnd;
          portColon = -1;
        } else {
          hostEnd = close + 1;
          portColon =
            hostEnd < authEnd && rawUrl.charCodeAt(hostEnd) === CH_COLON
              ? hostEnd
              : -1;
        }
      } else {
        const colon = rawUrl.indexOf(":", hostStart);
        if (colon !== -1 && colon < authEnd) {
          hostEnd = colon;
          portColon = colon;
        } else {
          hostEnd = authEnd;
          portColon = -1;
        }
      }
    }

    // Locate '?' and '#' in [authEnd, len). For URLs with a scheme, the
    // authority cannot contain either character — findAuthorityEnd would have
    // terminated at them. Starting the scan at authEnd is strictly fewer
    // chars than from 0.
    let queryStart = rawUrl.indexOf("?", authEnd);
    if (queryStart >= len) {
      queryStart = -1;
    }
    let fragStart = rawUrl.indexOf("#", authEnd);
    if (fragStart >= len) {
      fragStart = -1;
    }
    if (queryStart !== -1 && fragStart !== -1 && fragStart < queryStart) {
      // '?' lies inside the fragment — there is no real query.
      queryStart = -1;
    }

    // Assign in the same order every time. The JIT pins this layout to a
    // single hidden class across all UrlView instances.
    this._raw = rawUrl;
    this._len = len;
    this._schemeEnd = schemePos;
    this._hostStart = hostStart;
    this._hostEnd = hostEnd;
    this._portColon = portColon;
    this._authEnd = authEnd;
    this._queryStart = queryStart;
    this._fragStart = fragStart;
  }

  /** Returns the raw URL string (the input passed to `view()`). */
  toString(): string {
    return this._raw;
  }

  /** Returns the scheme without the trailing `:`, or `""` for schemeless inputs. */
  scheme(): string {
    return this._schemeEnd === -1
      ? ""
      : this._raw.substring(0, this._schemeEnd);
  }

  /** Returns `scheme://host[:port]`, with userinfo stripped. `""` for schemeless inputs. */
  origin(): string {
    if (this._schemeEnd === -1) {
      return "";
    }
    const authStart = this._schemeEnd + 3;
    if (this._hostStart === authStart) {
      // No userinfo — one substring covers it.
      return this._raw.substring(0, this._authEnd);
    }
    return (
      this._raw.substring(0, authStart) +
      this._raw.substring(this._hostStart, this._authEnd)
    );
  }

  /** Returns `hostname[:port]` (canonical authority form), IPv6 brackets preserved. */
  host(): string {
    return this._schemeEnd === -1
      ? ""
      : this._raw.substring(this._hostStart, this._authEnd);
  }

  /** Returns the bare hostname with IPv6 brackets stripped. */
  hostname(): string {
    if (this._schemeEnd === -1) {
      return "";
    }
    const raw = this._raw;
    if (raw.charCodeAt(this._hostStart) === CH_OPEN_BRACKET) {
      // _hostEnd points one past the ']'. Strip both brackets.
      return raw.substring(this._hostStart + 1, this._hostEnd - 1);
    }
    return raw.substring(this._hostStart, this._hostEnd);
  }

  /** Returns the port as a number, or `null` if no explicit port is present (or it's malformed). */
  port(): number | null {
    if (this._portColon === -1) {
      return null;
    }
    const port = parsePortRange(this._raw, this._portColon + 1, this._authEnd);
    return port === -1 ? null : port;
  }

  /** Returns the pathname (e.g. `"/api/v1"`), or `"/"` if absent. */
  pathname(): string {
    const start = this._authEnd;
    const end =
      this._queryStart !== -1
        ? this._queryStart
        : this._fragStart !== -1
          ? this._fragStart
          : this._len;
    return end === start ? "/" : this._raw.substring(start, end);
  }

  /** Returns the raw query string without the leading `?`, or `""` if absent. */
  query(): string {
    if (this._queryStart === -1) {
      return "";
    }
    const end = this._fragStart !== -1 ? this._fragStart : this._len;
    return this._raw.substring(this._queryStart + 1, end);
  }

  /** Returns the fragment without the leading `#`, or `""` if absent. */
  fragment(): string {
    return this._fragStart === -1
      ? ""
      : this._raw.substring(this._fragStart + 1, this._len);
  }

  /**
   * Returns the decoded value of `key` in the query, or `null` if absent.
   *
   * Key matching is WHATWG-decoded (matches `URLSearchParams.get`): `+`
   * decodes to space, percent-encoded UTF-8 is decoded, both sides are
   * compared as decoded codepoints. Byte-strict pass runs first with
   * near-zero overhead; the decoded fallback only fires when the URL has
   * `%`/`+` in the query.
   */
  // fallow-ignore-next-line complexity
  queryParam(key: string): string | null {
    if (this._queryStart === -1) {
      return null;
    }
    const raw = this._raw;
    const end = this._fragStart !== -1 ? this._fragStart : this._len;
    const queryStart = this._queryStart + 1;
    const keyLen = key.length;

    // Fast path: clean ASCII key. Single SIMD indexOf with boundary check.
    if (!keyIsAmbiguous(key)) {
      const idx = findKeyMatch(raw, queryStart, end, key);
      if (idx !== -1) {
        const after = idx + keyLen;
        if (after === end || raw.charCodeAt(after) === CH_AMP) {
          return "";
        }
        let amp = raw.indexOf("&", after + 1);
        if (amp === -1 || amp > end) {
          amp = end;
        }
        return decodeRange(raw, after + 1, amp);
      }
      if (!queryHasEncoding(raw, queryStart, end)) {
        return null;
      }
      return queryParamDecodedFallback(raw, queryStart, end, key, keyLen);
    }

    // Ambiguous user key: verify each byte-equal hit with the WHATWG walker.
    let i = queryStart;
    while (i < end) {
      let amp = raw.indexOf("&", i);
      if (amp === -1 || amp > end) {
        amp = end;
      }
      const eq = raw.indexOf("=", i);
      const keyEnd = eq === -1 || eq > amp ? amp : eq;
      if (
        keyEnd - i === keyLen &&
        raw.startsWith(key, i) &&
        compareDecodedValueRange(raw, i, keyEnd, key)
      ) {
        if (eq === -1 || eq > amp) {
          return "";
        }
        return decodeRange(raw, eq + 1, amp);
      }
      i = amp + 1;
    }
    if (!queryHasEncoding(raw, queryStart, end)) {
      return null;
    }
    return queryParamDecodedFallback(raw, queryStart, end, key, keyLen);
  }

  /**
   * Returns an object mapping each input key to its decoded query value (or
   * `null` if absent). Single-pass scan with first-char/length prefilter —
   * roughly N× cheaper than calling `queryParam` N times.
   *
   * Unlike the top-level `readQueryParams`, this returns a keyed object so
   * callers can destructure by name:
   *
   * @example
   *   const v = view("https://x/r?q=hi&utm_source=ig");
   *   const { q, utm_source } = v.queryParams(["q", "utm_source"] as const);
   *   // q === "hi", utm_source === "ig"
   */
  // fallow-ignore-next-line complexity
  queryParams<const K extends readonly string[]>(
    keys: K
  ): { [P in K[number]]: string | null } {
    const n = keys.length;
    const out = {} as { [P in K[number]]: string | null };
    // Initialize every key to null first so the returned object's shape is
    // independent of which keys were actually found in the URL.
    for (let k = 0; k < n; k++) {
      (out as Record<string, string | null>)[keys[k]] = null;
    }
    if (n === 0 || this._queryStart === -1) {
      return out;
    }
    if (n === 1) {
      (out as Record<string, string | null>)[keys[0]] = this.queryParam(
        keys[0]
      );
      return out;
    }

    const raw = this._raw;
    const end = this._fragStart !== -1 ? this._fragStart : this._len;

    // Pack (firstChar << 16 | length) per key — inner-loop prefilter is one
    // int compare instead of two array reads + two compares. The `-1`
    // sentinel marks a slot as resolved: it can't equal a non-negative
    // fieldPacked, so the same prefilter check skips found keys without a
    // separate `found[]` allocation. Ambiguity flags use one scalar bit mask
    // for normal batch sizes instead of another array.
    const keyPacked: number[] = new Array(n);
    const useAmbigMask = n <= 32;
    let keyAmbigMask = 0;
    for (let k = 0; k < n; k++) {
      keyPacked[k] = keys[k].charCodeAt(0) * 65536 + keys[k].length;
      if (useAmbigMask && keyIsAmbiguous(keys[k])) {
        keyAmbigMask |= 1 << k;
      }
    }

    // Pass 1: byte-strict, with verification for ambiguous keys.
    let remaining = n;
    let i = this._queryStart + 1;
    while (i < end && remaining > 0) {
      let amp = raw.indexOf("&", i);
      if (amp === -1 || amp > end) {
        amp = end;
      }
      const eq = raw.indexOf("=", i);
      const keyEnd = eq === -1 || eq > amp ? amp : eq;
      const fieldPacked = raw.charCodeAt(i) * 65536 + (keyEnd - i);

      for (let k = 0; k < n; k++) {
        if (keyPacked[k] !== fieldPacked) {
          continue;
        }
        if (raw.startsWith(keys[k], i)) {
          if (
            (useAmbigMask
              ? (keyAmbigMask & (1 << k)) === 0
              : !keyIsAmbiguous(keys[k])) ||
            compareDecodedValueRange(raw, i, keyEnd, keys[k])
          ) {
            (out as Record<string, string | null>)[keys[k]] =
              eq === -1 || eq > amp ? "" : decodeRange(raw, eq + 1, amp);
            keyPacked[k] = -1;
            remaining--;
          }
        }
      }

      i = amp + 1;
    }

    // Pass 2: WHATWG-decoded fallback for unmatched slots, only if the URL
    // has `%`/`+` somewhere in the query.
    if (remaining > 0 && queryHasEncoding(raw, this._queryStart + 1, end)) {
      let j = this._queryStart + 1;
      while (j < end && remaining > 0) {
        let amp = raw.indexOf("&", j);
        if (amp === -1 || amp > end) {
          amp = end;
        }
        const eq = raw.indexOf("=", j);
        const keyEnd = eq === -1 || eq > amp ? amp : eq;
        const fieldLen = keyEnd - j;
        for (let k = 0; k < n; k++) {
          if (keyPacked[k] === -1) {
            continue;
          }
          if (fieldLen < keys[k].length) {
            continue;
          }
          if (compareDecodedValueRange(raw, j, keyEnd, keys[k])) {
            (out as Record<string, string | null>)[keys[k]] =
              eq === -1 || eq > amp ? "" : decodeRange(raw, eq + 1, amp);
            keyPacked[k] = -1;
            remaining--;
          }
        }
        j = amp + 1;
      }
    }

    return out;
  }

  /** Zero-allocation predicate: returns `true` if `key` is present in the query. Key matching is WHATWG-decoded. */
  // fallow-ignore-next-line complexity
  hasQueryParam(key: string): boolean {
    if (this._queryStart === -1) {
      return false;
    }
    const raw = this._raw;
    const end = this._fragStart !== -1 ? this._fragStart : this._len;
    const queryStart = this._queryStart + 1;
    const keyLen = key.length;

    if (!keyIsAmbiguous(key)) {
      if (findKeyMatch(raw, queryStart, end, key) !== -1) {
        return true;
      }
      if (!queryHasEncoding(raw, queryStart, end)) {
        return false;
      }
      return hasQueryParamDecodedFallback(raw, queryStart, end, key, keyLen);
    }

    let i = queryStart;
    while (i < end) {
      let amp = raw.indexOf("&", i);
      if (amp === -1 || amp > end) {
        amp = end;
      }
      const eq = raw.indexOf("=", i);
      const keyEnd = eq === -1 || eq > amp ? amp : eq;
      if (
        keyEnd - i === keyLen &&
        raw.startsWith(key, i) &&
        compareDecodedValueRange(raw, i, keyEnd, key)
      ) {
        return true;
      }
      i = amp + 1;
    }
    if (!queryHasEncoding(raw, queryStart, end)) {
      return false;
    }
    return hasQueryParamDecodedFallback(raw, queryStart, end, key, keyLen);
  }

  /**
   * Zero-allocation predicate: returns `true` if the value of `key` decodes to
   * `expected`. Key matching is WHATWG-decoded. Walks the URL's value bytes
   * one codepoint at a time and compares against `expected` in place — no
   * decoded string is materialized.
   */
  // fallow-ignore-next-line complexity
  queryParamEquals(key: string, expected: string): boolean {
    if (this._queryStart === -1) {
      return false;
    }
    const raw = this._raw;
    const end = this._fragStart !== -1 ? this._fragStart : this._len;
    const queryStart = this._queryStart + 1;
    const keyLen = key.length;

    if (!keyIsAmbiguous(key)) {
      const idx = findKeyMatch(raw, queryStart, end, key);
      if (idx !== -1) {
        const after = idx + keyLen;
        if (after === end || raw.charCodeAt(after) === CH_AMP) {
          return expected.length === 0;
        }
        let amp = raw.indexOf("&", after + 1);
        if (amp === -1 || amp > end) {
          amp = end;
        }
        return compareDecodedValueRange(raw, after + 1, amp, expected);
      }
      if (!queryHasEncoding(raw, queryStart, end)) {
        return false;
      }
      return queryParamEqualsDecodedFallback(
        raw,
        queryStart,
        end,
        key,
        keyLen,
        expected
      );
    }

    let i = queryStart;
    while (i < end) {
      let amp = raw.indexOf("&", i);
      if (amp === -1 || amp > end) {
        amp = end;
      }
      const eq = raw.indexOf("=", i);
      const keyEnd = eq === -1 || eq > amp ? amp : eq;
      if (
        keyEnd - i === keyLen &&
        raw.startsWith(key, i) &&
        compareDecodedValueRange(raw, i, keyEnd, key)
      ) {
        const valStart = eq === -1 || eq > amp ? amp : eq + 1;
        return compareDecodedValueRange(raw, valStart, amp, expected);
      }
      i = amp + 1;
    }

    if (!queryHasEncoding(raw, queryStart, end)) {
      return false;
    }
    return queryParamEqualsDecodedFallback(
      raw,
      queryStart,
      end,
      key,
      keyLen,
      expected
    );
  }

  /** Zero-allocation predicate: returns `true` if the pathname starts with `prefix`. */
  // fallow-ignore-next-line complexity
  pathnameStartsWith(prefix: string): boolean {
    const start = this._authEnd;
    const end =
      this._queryStart !== -1
        ? this._queryStart
        : this._fragStart !== -1
          ? this._fragStart
          : this._len;
    const pathLen = end - start;
    if (pathLen === 0) {
      return prefix.length === 0 || prefix === "/";
    }
    if (prefix.length > pathLen) {
      return false;
    }
    return this._raw.startsWith(prefix, start);
  }

  /** Zero-allocation predicate: returns `true` if the pathname ends with `suffix`. */
  // fallow-ignore-next-line complexity
  pathnameEndsWith(suffix: string): boolean {
    const start = this._authEnd;
    const end =
      this._queryStart !== -1
        ? this._queryStart
        : this._fragStart !== -1
          ? this._fragStart
          : this._len;
    const pathLen = end - start;
    if (pathLen === 0) {
      return suffix.length === 0 || suffix === "/";
    }
    if (suffix.length > pathLen) {
      return false;
    }
    return this._raw.startsWith(suffix, end - suffix.length);
  }
}

/**
 * Builds a {@link UrlView} over `url`. Pays one linear scan to cache every
 * component boundary; subsequent reads off the view are O(1) substring slices.
 *
 * Use when you need two or more components off the same URL string. For a
 * single read, prefer the top-level flat functions (e.g. `readPathname`,
 * `readQueryParam`) — they don't allocate the wrapper object.
 *
 * @example
 *   const v = view("https://example.com:8080/api?q=hi#frag");
 *   v.scheme();        // → "https"
 *   v.host();          // → "example.com:8080"
 *   v.pathname();      // → "/api"
 *   v.queryParam("q"); // → "hi"
 */
export function view(url: string): UrlView {
  return new UrlView(url);
}
