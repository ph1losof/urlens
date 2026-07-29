import { decodeRange } from "./decode.js";
import {
  CH_AMP,
  CH_COLON,
  CH_HASH,
  CH_OPEN_BRACKET,
  CH_QUESTION,
  CH_SLASH,
  findKeyMatch,
  findSchemeEnd,
} from "./internal.js";
import {
  compareDecodedValueRange,
  hasQueryParamDecodedFallback,
  keyIsAmbiguous,
  queryHasEncoding,
  queryParamDecodedFallback,
  queryParamEqualsDecodedFallback,
} from "./query-scan.js";
import type { UrlView as UrlViewType } from "./view-types.js";

interface QueryEncodingCache {
  _queryEncoding?: boolean;
}

function hasCachedQueryEncoding(
  owner: object,
  raw: string,
  start: number,
  end: number
): boolean {
  const cache = owner as QueryEncodingCache;
  let hasEncoding = cache._queryEncoding;
  if (hasEncoding === undefined) {
    hasEncoding = queryHasEncoding(raw, start, end);
    cache._queryEncoding = hasEncoding;
  }
  return hasEncoding;
}

function queryParamAfterBareField(
  raw: string,
  start: number,
  end: number,
  key: string,
  keyLen: number,
  nextEq: number
): string | null {
  let i = start;
  while (i < end) {
    let amp = raw.indexOf("&", i);
    if (amp === -1 || amp > end) {
      amp = end;
    }
    const keyEnd = nextEq === -1 || nextEq > amp ? amp : nextEq;
    if (
      keyEnd - i === keyLen &&
      (keyLen !== 0 || nextEq === i) &&
      raw.startsWith(key, i) &&
      compareDecodedValueRange(raw, i, keyEnd, key)
    ) {
      return nextEq === -1 || nextEq > amp
        ? ""
        : decodeRange(raw, nextEq + 1, amp);
    }
    const next = amp + 1;
    if (nextEq !== -1 && nextEq < amp) {
      nextEq = next < end ? raw.indexOf("=", next) : -1;
    }
    i = next;
  }
  return null;
}

function parseViewPort(raw: string, start: number, end: number): number {
  if (start >= end) {
    return -1;
  }
  let port = 0;
  for (let i = start; i < end; i++) {
    const c = raw.charCodeAt(i);
    if (c < 48 || c > 57) {
      return -1;
    }
    port = port * 10 + (c - 48);
  }
  return port;
}

/**
 * A precomputed view over a URL string.
 *
 * Caches component boundaries for repeated reads from the same URL.
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
class UrlView implements UrlViewType {
  private readonly _raw: string;
  private readonly _queryEnd: number;
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
      authEnd = len;
      hostStart = authStart;
      let firstColon = -1;
      for (let i = authStart; i < len; i++) {
        const c = rawUrl.charCodeAt(i);
        if (c === CH_SLASH || c === CH_QUESTION || c === CH_HASH) {
          authEnd = i;
          break;
        }
        if (c === 64 /* @ */) {
          hostStart = i + 1;
          firstColon = -1;
        } else if (c === CH_COLON && firstColon === -1) {
          firstColon = i;
        }
      }

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
        if (firstColon !== -1) {
          hostEnd = firstColon;
          portColon = firstColon;
        } else {
          hostEnd = authEnd;
          portColon = -1;
        }
      }
    }

    // Scan after the authority so '?' and '#' delimit URL components.
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

    // Keep assignment order stable so every instance has the same object shape.
    this._raw = rawUrl;
    this._queryEnd = fragStart !== -1 ? fragStart : len;
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
      return this._raw.substring(0, this._authEnd);
    }
    return (
      this._raw.substring(0, authStart) +
      this._raw.substring(this._hostStart, this._authEnd)
    );
  }

  /** Returns the raw `hostname[:port]` authority, with IPv6 brackets preserved. */
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
      if (raw.charCodeAt(this._hostEnd - 1) === 93 /* ] */) {
        return raw.substring(this._hostStart + 1, this._hostEnd - 1);
      }
      return raw.substring(this._hostStart, this._authEnd);
    }
    return raw.substring(this._hostStart, this._hostEnd);
  }

  /** Returns the port as a number, or `null` if no explicit port is present (or it's malformed). */
  port(): number | null {
    if (this._portColon === -1) {
      return null;
    }
    const raw = this._raw;
    const start = this._portColon + 1;
    const end = this._authEnd;
    if (end - start === 4) {
      const d0 = raw.charCodeAt(start) - 48;
      const d1 = raw.charCodeAt(start + 1) - 48;
      const d2 = raw.charCodeAt(start + 2) - 48;
      const d3 = raw.charCodeAt(start + 3) - 48;
      if (d0 >>> 0 > 9 || d1 >>> 0 > 9 || d2 >>> 0 > 9 || d3 >>> 0 > 9) {
        return null;
      }
      return ((d0 * 10 + d1) * 10 + d2) * 10 + d3;
    }
    const port = parseViewPort(raw, start, end);
    return port === -1 ? null : port;
  }

  /** Returns the pathname (e.g. `"/api/v1"`), or `"/"` if absent. */
  pathname(): string {
    const start = this._authEnd;
    const end = this._queryStart !== -1 ? this._queryStart : this._queryEnd;
    return end === start ? "/" : this._raw.substring(start, end);
  }

  /** Returns the raw query string without the leading `?`, or `""` if absent. */
  query(): string {
    if (this._queryStart === -1) {
      return "";
    }
    return this._raw.substring(this._queryStart + 1, this._queryEnd);
  }

  /** Returns the fragment without the leading `#`, or `""` if absent. */
  fragment(): string {
    return this._fragStart === -1
      ? ""
      : this._raw.substring(this._fragStart + 1);
  }

  /**
   * Returns the decoded value of `key` in the query, or `null` if absent.
   *
   * Key matching uses WHATWG `application/x-www-form-urlencoded` decoding.
   */
  // fallow-ignore-next-line complexity
  queryParam(key: string): string | null {
    if (this._queryStart === -1) {
      return null;
    }
    const raw = this._raw;
    const end = this._queryEnd;
    const queryStart = this._queryStart + 1;
    const keyLen = key.length;

    if (keyLen !== 0 && !keyIsAmbiguous(key)) {
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
      const cache = this as unknown as QueryEncodingCache;
      let hasEncoding = cache._queryEncoding;
      if (hasEncoding === undefined) {
        hasEncoding = queryHasEncoding(raw, queryStart, end);
        cache._queryEncoding = hasEncoding;
      }
      if (!hasEncoding) {
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
        (keyLen !== 0 || eq === i) &&
        raw.startsWith(key, i) &&
        compareDecodedValueRange(raw, i, keyEnd, key)
      ) {
        if (eq === -1 || eq > amp) {
          return "";
        }
        return decodeRange(raw, eq + 1, amp);
      }
      const next = amp + 1;
      if ((eq === -1 || eq > amp) && next < end) {
        const value = queryParamAfterBareField(raw, next, end, key, keyLen, eq);
        if (value !== null) {
          return value;
        }
        break;
      }
      i = next;
    }
    const cache = this as unknown as QueryEncodingCache;
    let hasEncoding = cache._queryEncoding;
    if (hasEncoding === undefined) {
      hasEncoding = queryHasEncoding(raw, queryStart, end);
      cache._queryEncoding = hasEncoding;
    }
    if (!hasEncoding) {
      return null;
    }
    return queryParamDecodedFallback(raw, queryStart, end, key, keyLen);
  }

  /**
   * Returns an object mapping each input key to its decoded query value, or
   * `null` when absent.
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
    if (n === 0) {
      return {} as { [P in K[number]]: string | null };
    }
    if (n === 2) {
      const key0 = keys[0];
      const key1 = keys[1];
      if (this._queryStart === -1) {
        return (
          key1 === key0 ? { [key0]: null } : { [key0]: null, [key1]: null }
        ) as {
          [P in K[number]]: string | null;
        };
      }
      const first = this.queryParam(key0);
      return (
        key1 === key0
          ? { [key0]: first }
          : { [key0]: first, [key1]: this.queryParam(key1) }
      ) as {
        [P in K[number]]: string | null;
      };
    }

    const out = {} as { [P in K[number]]: string | null };
    // Populate every requested key so absent values remain null.
    for (let k = 0; k < n; k++) {
      const key = keys[k];
      if (key === "__proto__") {
        Object.defineProperty(out, key, {
          configurable: true,
          enumerable: true,
          value: null,
          writable: true,
        });
      } else {
        (out as Record<string, string | null>)[key] = null;
      }
    }
    if (this._queryStart === -1) {
      return out;
    }
    if (n === 1) {
      (out as Record<string, string | null>)[keys[0]] = this.queryParam(
        keys[0]
      );
      return out;
    }

    const raw = this._raw;
    const end = this._queryEnd;

    // Pack each key's first character and length; -1 marks resolved slots.
    // Store ambiguity flags in a bit mask when possible.
    const keyPacked: number[] = new Array(n);
    const useAmbigMask = n <= 32;
    let keyAmbigMask = 0;
    for (let k = 0; k < n; k++) {
      keyPacked[k] =
        keys[k].length === 0
          ? 0
          : keys[k].charCodeAt(0) * 65536 + keys[k].length;
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
      const fieldPacked =
        keyEnd === i
          ? eq === i
            ? 0
            : -2
          : raw.charCodeAt(i) * 65536 + (keyEnd - i);

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
    if (
      remaining > 0 &&
      hasCachedQueryEncoding(this, raw, this._queryStart + 1, end)
    ) {
      let j = this._queryStart + 1;
      while (j < end && remaining > 0) {
        let amp = raw.indexOf("&", j);
        if (amp === -1 || amp > end) {
          amp = end;
        }
        const eq = raw.indexOf("=", j);
        const keyEnd = eq === -1 || eq > amp ? amp : eq;
        const fieldLen = keyEnd - j;
        if (fieldLen === 0 && eq !== j) {
          j = amp + 1;
          continue;
        }
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

  /** Returns `true` if `key` is present without materializing its value. */
  // fallow-ignore-next-line complexity
  hasQueryParam(key: string): boolean {
    if (this._queryStart === -1) {
      return false;
    }
    const raw = this._raw;
    const end = this._queryEnd;
    const queryStart = this._queryStart + 1;
    const keyLen = key.length;

    if (keyLen !== 0 && !keyIsAmbiguous(key)) {
      if (findKeyMatch(raw, queryStart, end, key) !== -1) {
        return true;
      }
      if (!hasCachedQueryEncoding(this, raw, queryStart, end)) {
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
        (keyLen !== 0 || eq === i) &&
        raw.startsWith(key, i) &&
        compareDecodedValueRange(raw, i, keyEnd, key)
      ) {
        return true;
      }
      i = amp + 1;
    }
    if (!hasCachedQueryEncoding(this, raw, queryStart, end)) {
      return false;
    }
    return hasQueryParamDecodedFallback(raw, queryStart, end, key, keyLen);
  }

  /**
   * Returns `true` if the value of `key` decodes to
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
    const end = this._queryEnd;
    const queryStart = this._queryStart + 1;
    const keyLen = key.length;

    if (keyLen !== 0 && !keyIsAmbiguous(key)) {
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
      if (!hasCachedQueryEncoding(this, raw, queryStart, end)) {
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
        (keyLen !== 0 || eq === i) &&
        raw.startsWith(key, i) &&
        compareDecodedValueRange(raw, i, keyEnd, key)
      ) {
        const valStart = eq === -1 || eq > amp ? amp : eq + 1;
        return compareDecodedValueRange(raw, valStart, amp, expected);
      }
      i = amp + 1;
    }

    if (!hasCachedQueryEncoding(this, raw, queryStart, end)) {
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

  /** Returns `true` if the pathname starts with `prefix`. */
  // fallow-ignore-next-line complexity
  pathnameStartsWith(prefix: string): boolean {
    const start = this._authEnd;
    const end = this._queryStart !== -1 ? this._queryStart : this._queryEnd;
    const pathLen = end - start;
    if (pathLen === 0) {
      return prefix.length === 0 || prefix === "/";
    }
    if (prefix.length > pathLen) {
      return false;
    }
    return this._raw.startsWith(prefix, start);
  }

  /** Returns `true` if the pathname ends with `suffix`. */
  // fallow-ignore-next-line complexity
  pathnameEndsWith(suffix: string): boolean {
    const start = this._authEnd;
    const end = this._queryStart !== -1 ? this._queryStart : this._queryEnd;
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
 * Builds a {@link UrlView} over `url` and caches its component boundaries.
 * Component reads then use those offsets directly; query-parameter methods
 * still scan fields within the cached query range.
 *
 * Use for repeated component reads from the same URL.
 *
 * @example
 *   const v = view("https://example.com:8080/api?q=hi#frag");
 *   v.scheme();        // → "https"
 *   v.host();          // → "example.com:8080"
 *   v.pathname();      // → "/api"
 *   v.queryParam("q"); // → "hi"
 */
export function view(url: string): UrlViewType {
  return new UrlView(url);
}
