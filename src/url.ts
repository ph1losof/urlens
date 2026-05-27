const CH_SLASH = 47;
const CH_QUESTION = 63;
const CH_HASH = 35;
const CH_COLON = 58;
const CH_OPEN_BRACKET = 91;
const CH_0 = 48;
const CH_9 = 57;

// Returns the index of the first '/', '?', or '#' at or after `start`, or the
// string length if none are present. Used to locate the end of the authority
// section in URLs that have a scheme. One linear pass — faster than three
// separate indexOf calls when the authority is short, and never worse.
function findAuthorityEnd(rawUrl: string, start: number): number {
  const len = rawUrl.length;
  for (let i = start; i < len; i++) {
    const c = rawUrl.charCodeAt(i);
    if (c === CH_SLASH || c === CH_QUESTION || c === CH_HASH) {
      return i;
    }
  }
  return len;
}

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

// Returns the scheme without the trailing ':' (e.g. "https"). Returns "" for
// inputs with no scheme.
export function readScheme(rawUrl: string): string {
  const schemePos = rawUrl.indexOf("://");
  return schemePos === -1 ? "" : rawUrl.substring(0, schemePos);
}

// Returns the host in canonical authority form ("example.com:8080",
// "[::1]:8080", or just "example.com" when no port is present). Returns "" if
// the input has no scheme.
//
// All three host readers (readHost/readHostname/readPort) duplicate the
// authority-locating scan. Sharing it via a helper would allocate the
// returned tuple object on every call; inlining keeps each function
// allocation-free and lets the JIT specialize separately.
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

// Returns the bare hostname with IPv6 brackets stripped ("example.com",
// "::1"). Returns "" if the input has no scheme.
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

// Returns the port as a number, or null if no explicit port is present or the
// port is malformed (non-digit content). Implicit ports (the URL spec maps
// "https" → 443) are intentionally NOT inferred — that's a different feature.
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

// Zero-allocation predicate: returns true if `rawUrl` uses `scheme`. Schemes
// are compared case-insensitively (URL schemes are case-insensitive by RFC,
// and WHATWG normalizes them to lowercase). The `| 32` ASCII-lowercase trick
// is exact for the valid scheme alphabet (letters get lowercased; digits,
// '+', '-', '.' are unaffected).
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

// Zero-allocation predicate: returns true if the pathname starts with
// `prefix`. For origin-only URLs ("https://example.com"), the implicit
// pathname "/" is matched against prefixes "" and "/".
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

// Zero-allocation predicate: returns true if the pathname ends with
// `suffix`. Like `pathnameStartsWith`, treats an absent path as "/".
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

// Returns the WHATWG default port for a "special" scheme: http=80,
// https=443, ws=80, wss=443, ftp=21. Returns -1 for any other scheme.
// Case-insensitive ASCII byte compare; no allocation.
function defaultPortFor(rawUrl: string, schemeEnd: number): number {
  if (schemeEnd === 5) {
    if (
      (rawUrl.charCodeAt(0) | 32) === 104 /* h */ &&
      (rawUrl.charCodeAt(1) | 32) === 116 /* t */ &&
      (rawUrl.charCodeAt(2) | 32) === 116 /* t */ &&
      (rawUrl.charCodeAt(3) | 32) === 112 /* p */ &&
      (rawUrl.charCodeAt(4) | 32) === 115 /* s */
    ) {
      return 443;
    }
    return -1;
  }
  if (schemeEnd === 4) {
    if (
      (rawUrl.charCodeAt(0) | 32) === 104 /* h */ &&
      (rawUrl.charCodeAt(1) | 32) === 116 /* t */ &&
      (rawUrl.charCodeAt(2) | 32) === 116 /* t */ &&
      (rawUrl.charCodeAt(3) | 32) === 112 /* p */
    ) {
      return 80;
    }
    return -1;
  }
  if (schemeEnd === 3) {
    const c0 = rawUrl.charCodeAt(0) | 32;
    if (
      c0 === 102 /* f */ &&
      (rawUrl.charCodeAt(1) | 32) === 116 /* t */ &&
      (rawUrl.charCodeAt(2) | 32) === 112 /* p */
    ) {
      return 21; // ftp
    }
    if (
      c0 === 119 /* w */ &&
      (rawUrl.charCodeAt(1) | 32) === 115 /* s */ &&
      (rawUrl.charCodeAt(2) | 32) === 115 /* s */
    ) {
      return 443; // wss
    }
    return -1;
  }
  if (schemeEnd === 2) {
    if (
      (rawUrl.charCodeAt(0) | 32) === 119 /* w */ &&
      (rawUrl.charCodeAt(1) | 32) === 115 /* s */
    ) {
      return 80; // ws
    }
    return -1;
  }
  return -1;
}

// Parses ASCII digits in `[start, end)` as a decimal integer. Returns -1 on
// empty range or any non-digit content. No allocation.
function parsePortRange(s: string, start: number, end: number): number {
  if (start >= end) {
    return -1;
  }
  let port = 0;
  for (let i = start; i < end; i++) {
    const c = s.charCodeAt(i);
    if (c < CH_0 || c > CH_9) {
      return -1;
    }
    port = port * 10 + (c - CH_0);
  }
  return port;
}

// Zero-allocation origin equality. Scheme + hostname + port, userinfo
// stripped, IPv6 aware. Implicit ports are inferred for "special" schemes —
// `originMatches("https://x/", "https://x:443/")` is true because 443 is
// the implicit port for https. Schemes and hostnames compare
// case-insensitively (DNS hostnames and URL schemes are both case-insensitive
// per spec).
//
// For non-special schemes (anything other than http/https/ws/wss/ftp) there
// is no implicit port: `originMatches("custom://x/", "custom://x:9/")` is
// false unless both sides have the same explicit port.
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

// Returns the fragment without the leading '#', or "" if absent.
export function readFragment(rawUrl: string): string {
  const hPos = rawUrl.indexOf("#");
  return hPos === -1 ? "" : rawUrl.substring(hPos + 1);
}

// Returns `rawUrl` with the fragment removed. Returns the input unchanged
// when there is no fragment.
export function stripFragment(rawUrl: string): string {
  const hPos = rawUrl.indexOf("#");
  return hPos === -1 ? rawUrl : rawUrl.substring(0, hPos);
}

// Replaces the scheme. If `rawUrl` has no scheme, returns it unchanged.
export function setScheme(rawUrl: string, scheme: string): string {
  const schemePos = rawUrl.indexOf("://");
  if (schemePos === -1) {
    return rawUrl;
  }
  return scheme + rawUrl.substring(schemePos);
}

// Replaces the port. `null` removes any explicit port. Throws RangeError for
// non-integer or out-of-range ports. Returns the input unchanged when there
// is no scheme to attach the port to.
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

// Replaces the pathname of `rawUrl` with `newPathname`. Preserves the query
// and fragment, if present. Normalizes `newPathname` to start with "/".
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
