import {
  CH_0,
  CH_9,
  CH_COLON,
  CH_OPEN_BRACKET,
  CH_SLASH,
  defaultPortFor,
  findAuthorityEnd,
  parsePortRange,
} from "./internal.js";

/**
 * Returns the pathname portion of a URL.
 *
 * For a full URL, returns the substring between the authority and the first
 * `?` or `#` (e.g. `/api/v1/users/42`). For pathname-only inputs (request-line
 * shapes like `/api/v1/users`), the input is treated as a path and returned as
 * the literal substring up to any `?`/`#`. For URLs with no path at all
 * (`https://example.com`), returns `"/"`.
 *
 * Zero-copy: the returned string is a sliced-string view into the input on
 * V8/SpiderMonkey/JSC; only the small string header is allocated.
 *
 * @example
 *   readPathname("https://example.com/api/v1?x=1#frag"); // → "/api/v1"
 *   readPathname("/api/v1/users");                       // → "/api/v1/users"
 *   readPathname("https://example.com");                 // → "/"
 */
export function readPathname(rawUrl: string): string {
  const schemePos = rawUrl.indexOf("://");
  let start: number;
  if (schemePos !== -1) {
    const slash = rawUrl.indexOf("/", schemePos + 3);
    if (slash === -1) {
      return "/";
    }
    start = slash;
  } else {
    // No scheme: treat the input as a path (absolute if leading '/', relative
    // otherwise). Returning the literal substring is what request-line and
    // relative-URL callers actually want.
    start = 0;
  }
  // Two SIMD-vectorized indexOf scans outperform a manual charCodeAt walk on
  // V8 and SpiderMonkey, even for short paths — benched & reverted.
  let end = rawUrl.length;
  const qPos = rawUrl.indexOf("?", start);
  if (qPos !== -1 && qPos < end) {
    end = qPos;
  }
  const hPos = rawUrl.indexOf("#", start);
  if (hPos !== -1 && hPos < end) {
    end = hPos;
  }
  return end === start ? "/" : rawUrl.substring(start, end);
}

/**
 * Returns the origin (`scheme://host[:port]`) of a URL.
 *
 * Strips userinfo (`user:pass@`). IPv6-aware: bracketed hosts (`[::1]`) are
 * preserved with their brackets. Returns `""` when the input has no scheme.
 *
 * @example
 *   readOrigin("https://user:pass@example.com:8080/api?x=1");
 *   // → "https://example.com:8080"
 */
export function readOrigin(rawUrl: string): string {
  const schemePos = rawUrl.indexOf("://");
  if (schemePos === -1) {
    return "";
  }

  const authorityStart = schemePos + 3;
  const authorityEnd = findAuthorityEnd(rawUrl, authorityStart);

  // Strip userinfo. Per WHATWG URL, a literal '@' inside userinfo must be
  // percent-encoded, so the LAST literal '@' within the authority terminates
  // userinfo. lastIndexOf is bounded by authorityEnd-1. IPv6 hosts ('[::1]')
  // cannot contain '@', so this is also correct for IPv6 without special casing.
  const at = rawUrl.lastIndexOf("@", authorityEnd - 1);
  const hostStart = at >= authorityStart ? at + 1 : authorityStart;

  if (hostStart === authorityStart) {
    return rawUrl.substring(0, authorityEnd);
  }
  // Build: scheme:// + host[:port]. One concat, two substrings.
  return (
    rawUrl.substring(0, authorityStart) +
    rawUrl.substring(hostStart, authorityEnd)
  );
}

/**
 * Returns the scheme without the trailing `:` (e.g. `"https"`).
 *
 * Differs from `URL.protocol`, which includes the trailing `:`. Returns `""`
 * for inputs with no scheme.
 *
 * @example
 *   readScheme("https://example.com"); // → "https"
 *   readScheme("/relative/path");      // → ""
 */
export function readScheme(rawUrl: string): string {
  const schemePos = rawUrl.indexOf("://");
  return schemePos === -1 ? "" : rawUrl.substring(0, schemePos);
}

/**
 * Returns the host in canonical authority form: `hostname:port` if a port is
 * present, or just `hostname` otherwise. IPv6 brackets are preserved
 * (`[::1]:8080`). Userinfo is stripped. Returns `""` if the input has no scheme.
 *
 * Note: each host reader (`readHost` / `readHostname` / `readPort`) duplicates
 * the authority-locating scan deliberately — sharing the scan via a helper
 * would allocate a returned tuple per call. For batched reads on one URL,
 * prefer {@link view}, which scans once and caches all offsets.
 *
 * @example
 *   readHost("https://example.com:8080/p");      // → "example.com:8080"
 *   readHost("https://user@example.com/p");      // → "example.com"
 *   readHost("https://[::1]:8080/");             // → "[::1]:8080"
 */
export function readHost(rawUrl: string): string {
  const schemePos = rawUrl.indexOf("://");
  if (schemePos === -1) {
    return "";
  }
  const authorityStart = schemePos + 3;
  const authorityEnd = findAuthorityEnd(rawUrl, authorityStart);
  const at = rawUrl.lastIndexOf("@", authorityEnd - 1);
  const hostStart = at >= authorityStart ? at + 1 : authorityStart;
  return rawUrl.substring(hostStart, authorityEnd);
}

/**
 * Returns the bare hostname with IPv6 brackets stripped.
 *
 * Returns `""` if the input has no scheme.
 *
 * @example
 *   readHostname("https://example.com:8080/p");  // → "example.com"
 *   readHostname("http://[::1]:8080/");          // → "::1"
 */
export function readHostname(rawUrl: string): string {
  const schemePos = rawUrl.indexOf("://");
  if (schemePos === -1) {
    return "";
  }
  const authorityStart = schemePos + 3;
  const authorityEnd = findAuthorityEnd(rawUrl, authorityStart);
  const at = rawUrl.lastIndexOf("@", authorityEnd - 1);
  const hostStart = at >= authorityStart ? at + 1 : authorityStart;

  if (rawUrl.charCodeAt(hostStart) === CH_OPEN_BRACKET) {
    const closeBracket = rawUrl.indexOf("]", hostStart + 1);
    if (closeBracket !== -1 && closeBracket < authorityEnd) {
      return rawUrl.substring(hostStart + 1, closeBracket);
    }
    return rawUrl.substring(hostStart, authorityEnd);
  }

  const colonPos = rawUrl.indexOf(":", hostStart);
  const hostEnd =
    colonPos !== -1 && colonPos < authorityEnd ? colonPos : authorityEnd;
  return rawUrl.substring(hostStart, hostEnd);
}

/**
 * Returns the explicit port as a number, or `null` if no port is present or
 * the port is malformed (non-digit content).
 *
 * Implicit ports (the URL spec maps `https` → 443) are intentionally NOT
 * inferred — see {@link originMatches} for a comparison that does.
 *
 * @example
 *   readPort("http://example.com:8080/"); // → 8080
 *   readPort("http://example.com/");      // → null (no explicit port)
 *   readPort("http://example.com:abc/");  // → null (malformed)
 */
export function readPort(rawUrl: string): number | null {
  const schemePos = rawUrl.indexOf("://");
  if (schemePos === -1) {
    return null;
  }
  const authorityStart = schemePos + 3;
  const authorityEnd = findAuthorityEnd(rawUrl, authorityStart);
  const at = rawUrl.lastIndexOf("@", authorityEnd - 1);
  const hostStart = at >= authorityStart ? at + 1 : authorityStart;

  let portStart: number;
  if (rawUrl.charCodeAt(hostStart) === CH_OPEN_BRACKET) {
    const closeBracket = rawUrl.indexOf("]", hostStart + 1);
    if (closeBracket === -1 || closeBracket >= authorityEnd) {
      return null;
    }
    const afterBracket = closeBracket + 1;
    if (
      afterBracket >= authorityEnd ||
      rawUrl.charCodeAt(afterBracket) !== CH_COLON
    ) {
      return null;
    }
    portStart = afterBracket + 1;
  } else {
    const colonPos = rawUrl.indexOf(":", hostStart);
    if (colonPos === -1 || colonPos >= authorityEnd) {
      return null;
    }
    portStart = colonPos + 1;
  }

  if (portStart >= authorityEnd) {
    return null;
  }
  // Manual digit parse: avoids `parseInt(substring(...))` (one allocation +
  // global lookup) in favor of a tight loop with no allocations at all.
  let port = 0;
  for (let i = portStart; i < authorityEnd; i++) {
    const c = rawUrl.charCodeAt(i);
    if (c < CH_0 || c > CH_9) {
      return null;
    }
    port = port * 10 + (c - CH_0);
  }
  return port;
}

/**
 * Zero-allocation predicate: returns `true` if `rawUrl` uses `scheme`.
 *
 * Comparison is case-insensitive (URL schemes are case-insensitive per RFC,
 * and WHATWG normalizes them to lowercase). The `| 32` ASCII-lowercase trick
 * is exact for the valid scheme alphabet (letters lowercase; digits, `+`,
 * `-`, `.` are unaffected).
 *
 * @example
 *   hasScheme("HTTPS://x/", "https");   // → true
 *   hasScheme("ws://x/", "wss");        // → false
 */
export function hasScheme(rawUrl: string, scheme: string): boolean {
  const schemePos = rawUrl.indexOf("://");
  if (schemePos !== scheme.length) {
    return false;
  }
  for (let i = 0; i < schemePos; i++) {
    if ((rawUrl.charCodeAt(i) | 32) !== (scheme.charCodeAt(i) | 32)) {
      return false;
    }
  }
  return true;
}

/**
 * Zero-allocation predicate: returns `true` if the pathname starts with
 * `prefix`.
 *
 * For origin-only URLs (`https://example.com`), the implicit pathname `"/"` is
 * matched against the prefixes `""` and `"/"`.
 *
 * @example
 *   pathnameStartsWith("https://x/api/v1/users", "/api"); // → true
 *   pathnameStartsWith("https://x", "/");                 // → true
 */
export function pathnameStartsWith(rawUrl: string, prefix: string): boolean {
  const schemePos = rawUrl.indexOf("://");
  let pathStart: number;
  if (schemePos !== -1) {
    const slash = rawUrl.indexOf("/", schemePos + 3);
    if (slash === -1) {
      // Implicit "/" pathname.
      return prefix.length === 0 || prefix === "/";
    }
    pathStart = slash;
  } else {
    pathStart = 0;
  }
  let pathEnd = rawUrl.length;
  const qPos = rawUrl.indexOf("?", pathStart);
  if (qPos !== -1 && qPos < pathEnd) {
    pathEnd = qPos;
  }
  const hPos = rawUrl.indexOf("#", pathStart);
  if (hPos !== -1 && hPos < pathEnd) {
    pathEnd = hPos;
  }
  const pathLen = pathEnd - pathStart;
  if (pathLen === 0) {
    return prefix.length === 0 || prefix === "/";
  }
  if (prefix.length > pathLen) {
    return false;
  }
  return rawUrl.startsWith(prefix, pathStart);
}

/**
 * Zero-allocation predicate: returns `true` if the pathname ends with
 * `suffix`. Like {@link pathnameStartsWith}, treats an absent path as `"/"`.
 *
 * @example
 *   pathnameEndsWith("https://x/page.html", ".html"); // → true
 */
export function pathnameEndsWith(rawUrl: string, suffix: string): boolean {
  const schemePos = rawUrl.indexOf("://");
  let pathStart: number;
  if (schemePos !== -1) {
    const slash = rawUrl.indexOf("/", schemePos + 3);
    if (slash === -1) {
      return suffix.length === 0 || suffix === "/";
    }
    pathStart = slash;
  } else {
    pathStart = 0;
  }
  let pathEnd = rawUrl.length;
  const qPos = rawUrl.indexOf("?", pathStart);
  if (qPos !== -1 && qPos < pathEnd) {
    pathEnd = qPos;
  }
  const hPos = rawUrl.indexOf("#", pathStart);
  if (hPos !== -1 && hPos < pathEnd) {
    pathEnd = hPos;
  }
  const pathLen = pathEnd - pathStart;
  if (pathLen === 0) {
    return suffix.length === 0 || suffix === "/";
  }
  if (suffix.length > pathLen) {
    return false;
  }
  // startsWith(needle, position) checks the bytes at `position` against
  // `needle` — perfect for verifying a suffix without allocating.
  return rawUrl.startsWith(suffix, pathEnd - suffix.length);
}

/**
 * Zero-allocation origin equality: scheme + hostname + port, userinfo
 * stripped, IPv6 aware.
 *
 * Implicit ports are inferred for "special" schemes (`http`=80, `https`=443,
 * `ws`=80, `wss`=443, `ftp`=21), so `originMatches("https://x/", "https://x:443/")`
 * is `true`. Scheme and hostname compare case-insensitively (both are
 * case-insensitive per spec). For non-special schemes (e.g. `custom://`),
 * there is no implicit port — both sides must have the same explicit port
 * (or both lack one).
 *
 * @example
 *   originMatches("https://EXAMPLE.com/x", "https://example.com:443/y"); // → true
 *   originMatches("https://a.test/", "https://b.test/");                 // → false
 */
export function originMatches(a: string, b: string): boolean {
  const aS = a.indexOf("://");
  const bS = b.indexOf("://");
  if (aS === -1 || bS === -1 || aS !== bS) {
    return false;
  }
  // Case-insensitive scheme compare. `| 32` lowercases ASCII letters and is a
  // no-op for digits, '+', '-', '.' — exactly the valid scheme alphabet —
  // so false positives are impossible.
  for (let i = 0; i < aS; i++) {
    if ((a.charCodeAt(i) | 32) !== (b.charCodeAt(i) | 32)) {
      return false;
    }
  }

  const aAuthStart = aS + 3;
  const bAuthStart = bS + 3;
  const aAuthEnd = findAuthorityEnd(a, aAuthStart);
  const bAuthEnd = findAuthorityEnd(b, bAuthStart);
  const aAt = a.lastIndexOf("@", aAuthEnd - 1);
  const bAt = b.lastIndexOf("@", bAuthEnd - 1);
  const aHostStart = aAt >= aAuthStart ? aAt + 1 : aAuthStart;
  const bHostStart = bAt >= bAuthStart ? bAt + 1 : bAuthStart;

  // Locate (hostEnd, portColon). portColon === -1 means no explicit port.
  let aHostEnd: number;
  let aPortColon: number;
  if (a.charCodeAt(aHostStart) === CH_OPEN_BRACKET) {
    const close = a.indexOf("]", aHostStart + 1);
    if (close === -1 || close >= aAuthEnd) {
      aHostEnd = aAuthEnd;
      aPortColon = -1;
    } else {
      aHostEnd = close + 1;
      aPortColon =
        aHostEnd < aAuthEnd && a.charCodeAt(aHostEnd) === CH_COLON
          ? aHostEnd
          : -1;
    }
  } else {
    const colon = a.indexOf(":", aHostStart);
    if (colon !== -1 && colon < aAuthEnd) {
      aHostEnd = colon;
      aPortColon = colon;
    } else {
      aHostEnd = aAuthEnd;
      aPortColon = -1;
    }
  }
  let bHostEnd: number;
  let bPortColon: number;
  if (b.charCodeAt(bHostStart) === CH_OPEN_BRACKET) {
    const close = b.indexOf("]", bHostStart + 1);
    if (close === -1 || close >= bAuthEnd) {
      bHostEnd = bAuthEnd;
      bPortColon = -1;
    } else {
      bHostEnd = close + 1;
      bPortColon =
        bHostEnd < bAuthEnd && b.charCodeAt(bHostEnd) === CH_COLON
          ? bHostEnd
          : -1;
    }
  } else {
    const colon = b.indexOf(":", bHostStart);
    if (colon !== -1 && colon < bAuthEnd) {
      bHostEnd = colon;
      bPortColon = colon;
    } else {
      bHostEnd = bAuthEnd;
      bPortColon = -1;
    }
  }

  // Case-insensitive hostname compare. We only lowercase ASCII A-Z; brackets
  // appear at fixed positions on both sides (or neither) so they can't cause
  // false positives between valid URLs.
  const aHostLen = aHostEnd - aHostStart;
  if (aHostLen !== bHostEnd - bHostStart) {
    return false;
  }
  for (let i = 0; i < aHostLen; i++) {
    let ac = a.charCodeAt(aHostStart + i);
    let bc = b.charCodeAt(bHostStart + i);
    if (ac >= 65 && ac <= 90) {
      ac += 32;
    }
    if (bc >= 65 && bc <= 90) {
      bc += 32;
    }
    if (ac !== bc) {
      return false;
    }
  }

  // Compare ports. Fast path: neither side has an explicit port.
  if (aPortColon === -1 && bPortColon === -1) {
    return true;
  }

  let aPort: number;
  if (aPortColon === -1) {
    aPort = defaultPortFor(a, aS);
    if (aPort === -1) {
      return false; // unknown scheme + no port — can't infer equality
    }
  } else {
    aPort = parsePortRange(a, aPortColon + 1, aAuthEnd);
    if (aPort === -1) {
      return false;
    }
  }
  let bPort: number;
  if (bPortColon === -1) {
    bPort = defaultPortFor(b, bS);
    if (bPort === -1) {
      return false;
    }
  } else {
    bPort = parsePortRange(b, bPortColon + 1, bAuthEnd);
    if (bPort === -1) {
      return false;
    }
  }
  return aPort === bPort;
}

/**
 * Returns the fragment without the leading `#`, or `""` if absent.
 *
 * Differs from `URL.hash`, which keeps the leading `#`.
 *
 * @example
 *   readFragment("https://x/p#section-2"); // → "section-2"
 *   readFragment("https://x/p");           // → ""
 */
export function readFragment(rawUrl: string): string {
  const hPos = rawUrl.indexOf("#");
  return hPos === -1 ? "" : rawUrl.substring(hPos + 1);
}

/**
 * Returns `rawUrl` with the fragment removed. Returns the input unchanged
 * when there is no fragment.
 *
 * @example
 *   stripFragment("https://x/p?q=1#frag"); // → "https://x/p?q=1"
 */
export function stripFragment(rawUrl: string): string {
  const hPos = rawUrl.indexOf("#");
  return hPos === -1 ? rawUrl : rawUrl.substring(0, hPos);
}

/**
 * Replaces the scheme of `rawUrl` with `scheme`.
 *
 * No-op when `rawUrl` has no scheme — this function does not synthesize a
 * scheme. Pass a fully-qualified URL or build one with string concat first.
 *
 * @example
 *   setScheme("http://example.com/", "https");  // → "https://example.com/"
 *   setScheme("/path", "https");                // → "/path" (no-op)
 */
export function setScheme(rawUrl: string, scheme: string): string {
  const schemePos = rawUrl.indexOf("://");
  if (schemePos === -1) {
    return rawUrl;
  }
  return scheme + rawUrl.substring(schemePos);
}

/**
 * Replaces the port of `rawUrl` with `port`. Passing `null` removes any
 * explicit port (and its colon). Preserves userinfo, IPv6 brackets, path,
 * query, and fragment.
 *
 * Throws `RangeError` for non-integer or out-of-range ports. No-op when
 * `rawUrl` has no scheme — pass a fully-qualified URL.
 *
 * @example
 *   setPort("https://x:80/api", 8443);  // → "https://x:8443/api"
 *   setPort("https://x:80/api", null);  // → "https://x/api"
 *   setPort("/api", 8080);              // → "/api" (no-op)
 */
export function setPort(rawUrl: string, port: number | null): string {
  if (port !== null) {
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
      throw new RangeError(
        `setPort: port must be an integer in [0, 65535] or null; got ${port}`
      );
    }
  }
  const schemePos = rawUrl.indexOf("://");
  if (schemePos === -1) {
    return rawUrl;
  }
  const authorityStart = schemePos + 3;
  const authorityEnd = findAuthorityEnd(rawUrl, authorityStart);
  const at = rawUrl.lastIndexOf("@", authorityEnd - 1);
  const hostStart = at >= authorityStart ? at + 1 : authorityStart;

  // Locate existing port boundaries.
  let portColon = -1;
  if (rawUrl.charCodeAt(hostStart) === CH_OPEN_BRACKET) {
    const closeBracket = rawUrl.indexOf("]", hostStart + 1);
    if (closeBracket !== -1 && closeBracket < authorityEnd) {
      const afterBracket = closeBracket + 1;
      if (
        afterBracket < authorityEnd &&
        rawUrl.charCodeAt(afterBracket) === CH_COLON
      ) {
        portColon = afterBracket;
      }
    }
  } else {
    const colonPos = rawUrl.indexOf(":", hostStart);
    if (colonPos !== -1 && colonPos < authorityEnd) {
      portColon = colonPos;
    }
  }

  if (port === null) {
    if (portColon === -1) {
      return rawUrl;
    }
    return rawUrl.substring(0, portColon) + rawUrl.substring(authorityEnd);
  }
  const portStr = String(port);
  if (portColon === -1) {
    // Insert ":port" right after the host.
    return (
      rawUrl.substring(0, authorityEnd) +
      ":" +
      portStr +
      rawUrl.substring(authorityEnd)
    );
  }
  // Replace existing port digits.
  return (
    rawUrl.substring(0, portColon + 1) +
    portStr +
    rawUrl.substring(authorityEnd)
  );
}

/**
 * Replaces the pathname of `rawUrl` with `newPathname`. Preserves the query
 * and fragment, if present. Normalizes `newPathname` to start with `/` if it
 * does not already.
 *
 * Does NOT collapse `..` or `.` segments — pass the path you want written
 * verbatim.
 *
 * @example
 *   setPathname("https://x/old?q=1#frag", "/new");
 *   // → "https://x/new?q=1#frag"
 */
export function setPathname(rawUrl: string, newPathname: string): string {
  const normalized =
    newPathname.length === 0 || newPathname.charCodeAt(0) !== CH_SLASH
      ? `/${newPathname}`
      : newPathname;

  const schemePos = rawUrl.indexOf("://");
  let pathStart: number;
  if (schemePos !== -1) {
    pathStart = findAuthorityEnd(rawUrl, schemePos + 3);
  } else {
    pathStart = 0;
  }

  let pathEnd = rawUrl.length;
  const qPos = rawUrl.indexOf("?", pathStart);
  if (qPos !== -1 && qPos < pathEnd) {
    pathEnd = qPos;
  }
  const hPos = rawUrl.indexOf("#", pathStart);
  if (hPos !== -1 && hPos < pathEnd) {
    pathEnd = hPos;
  }

  return (
    rawUrl.substring(0, pathStart) + normalized + rawUrl.substring(pathEnd)
  );
}
