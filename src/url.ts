import {
  AUTH_PACK,
  CH_0,
  CH_9,
  CH_COLON,
  CH_HASH,
  CH_OPEN_BRACKET,
  CH_QUESTION,
  CH_SLASH,
  defaultPortFor,
  findAuthorityEnd,
  findSchemeEnd,
  parsePortRange,
} from "./internal.js";

// Non-reentrant pathname scratch; callers must read it immediately.
let PATH_S = 0;
let PATH_E = 0;

// Scratch slots for locateHostRange (see below). Read into locals IMMEDIATELY
// after each call; the next call overwrites them.
let HOST_S = 0;
let HOST_E = 0;
let PORT_C = -1;
let AUTH_E = 0;

// Writes hostStart, hostEnd, portColon (-1 if absent), and authEnd for the
// authority of `s` starting at `schemeEnd + 3` ("://"). Userinfo (`...@`) is
// stripped. IPv6 brackets are honored: the host range includes the brackets,
// and the port colon (if any) is the byte after `]`.
// fallow-ignore-next-line complexity
function locateHostRange(s: string, schemeEnd: number): void {
  const authStart = schemeEnd + 3;
  const len = s.length;
  let authEnd = len;
  let hostStart = authStart;
  let firstColon = -1;
  for (let i = authStart; i < len; i++) {
    const c = s.charCodeAt(i);
    if (c === CH_SLASH || c === CH_QUESTION || c === CH_HASH) {
      authEnd = i;
      break;
    }
    if (c === 64 /* @ */) {
      // A later '@' moves the host start, so any prior userinfo colon is moot.
      hostStart = i + 1;
      firstColon = -1;
    } else if (c === CH_COLON && firstColon === -1) {
      firstColon = i;
    }
  }
  let hostEnd: number;
  let portColon: number;
  if (s.charCodeAt(hostStart) === CH_OPEN_BRACKET) {
    const close = s.indexOf("]", hostStart + 1);
    if (close === -1 || close >= authEnd) {
      hostEnd = authEnd;
      portColon = -1;
    } else {
      hostEnd = close + 1;
      portColon =
        hostEnd < authEnd && s.charCodeAt(hostEnd) === CH_COLON ? hostEnd : -1;
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
  HOST_S = hostStart;
  HOST_E = hostEnd;
  PORT_C = portColon;
  AUTH_E = authEnd;
}

// Writes [PATH_S, PATH_E); an absent authority path produces an empty range.
// Keep the delimiter scan inline; helper extraction regresses this JSC path.
// fallow-ignore-next-line complexity
function locatePathnameRange(rawUrl: string): void {
  const schemePos = findSchemeEnd(rawUrl);
  let pathStart: number;
  if (schemePos !== -1) {
    const authorityStart = schemePos + 3;
    const slash = rawUrl.indexOf("/", authorityStart);
    let pathEnd = rawUrl.length;
    const qPos = rawUrl.indexOf("?", authorityStart);
    if (qPos !== -1) {
      pathEnd = qPos;
    }
    const hPos = rawUrl.indexOf("#", authorityStart);
    if (hPos !== -1 && hPos < pathEnd) {
      pathEnd = hPos;
    }
    if (slash === -1 || slash >= pathEnd) {
      PATH_S = pathEnd;
      PATH_E = pathEnd;
      return;
    }
    PATH_S = slash;
    PATH_E = pathEnd;
    return;
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
  PATH_S = pathStart;
  PATH_E = pathEnd;
}

/**
 * Returns the pathname portion of a URL.
 *
 * For a full URL, returns the substring between the authority and the first
 * `?` or `#` (e.g. `/api/v1/users/42`). For pathname-only inputs (request-line
 * shapes like `/api/v1/users`), the input is treated as a path and returned as
 * the literal substring up to any `?`/`#`. For URLs with no path at all
 * (`https://example.com`), returns `"/"`.
 * @example
 *   readPathname("https://example.com/api/v1?x=1#frag"); // → "/api/v1"
 *   readPathname("/api/v1/users");                       // → "/api/v1/users"
 *   readPathname("https://example.com");                 // → "/"
 */
// fallow-ignore-next-line complexity
export function readPathname(rawUrl: string): string {
  const schemePos = findSchemeEnd(rawUrl);
  let start: number;
  if (schemePos !== -1) {
    const authorityStart = schemePos + 3;
    const slash = rawUrl.indexOf("/", authorityStart);
    let end = rawUrl.length;
    const qPos = rawUrl.indexOf("?", authorityStart);
    if (qPos !== -1) {
      end = qPos;
    }
    const hPos = rawUrl.indexOf("#", authorityStart);
    if (hPos !== -1 && hPos < end) {
      end = hPos;
    }
    if (slash === -1 || slash >= end) {
      return "/";
    }
    return rawUrl.substring(slash, end);
  } else {
    start = 0;
  }
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
  const schemePos = findSchemeEnd(rawUrl);
  if (schemePos === -1) {
    return "";
  }

  const authorityStart = schemePos + 3;
  const packed = findAuthorityEnd(rawUrl, authorityStart);
  const packBase = rawUrl.length < AUTH_PACK ? AUTH_PACK : rawUrl.length + 1;
  const authorityEnd = packed < packBase ? packed : packed % packBase;

  // Strip userinfo. Per WHATWG URL, a literal '@' inside userinfo must be
  // percent-encoded, so the LAST literal '@' within the authority terminates
  // userinfo. IPv6 hosts ('[::1]') cannot contain '@', so this is also correct
  // for IPv6 without special casing.
  const at = packed < packBase ? -1 : ((packed / packBase) | 0) - 1;
  const hostStart = at >= authorityStart ? at + 1 : authorityStart;

  if (hostStart === authorityStart) {
    return rawUrl.substring(0, authorityEnd);
  }
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
  const schemePos = findSchemeEnd(rawUrl);
  return schemePos === -1 ? "" : rawUrl.substring(0, schemePos);
}

/**
 * Returns the raw authority host: `hostname:port` if a port is
 * present, or just `hostname` otherwise. IPv6 brackets are preserved
 * (`[::1]:8080`). Userinfo is stripped. Returns `""` if the input has no scheme.
 * @example
 *   readHost("https://example.com:8080/p");      // → "example.com:8080"
 *   readHost("https://user@example.com/p");      // → "example.com"
 *   readHost("https://[::1]:8080/");             // → "[::1]:8080"
 */
export function readHost(rawUrl: string): string {
  const schemePos = findSchemeEnd(rawUrl);
  if (schemePos === -1) {
    return "";
  }
  const authorityStart = schemePos + 3;
  const packed = findAuthorityEnd(rawUrl, authorityStart);
  const packBase = rawUrl.length < AUTH_PACK ? AUTH_PACK : rawUrl.length + 1;
  const authorityEnd = packed < packBase ? packed : packed % packBase;
  const at = packed < packBase ? -1 : ((packed / packBase) | 0) - 1;
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
  const schemePos = findSchemeEnd(rawUrl);
  if (schemePos === -1) {
    return "";
  }
  locateHostRange(rawUrl, schemePos);
  const hostStart = HOST_S;
  const hostEnd = HOST_E;
  if (rawUrl.charCodeAt(hostStart) === CH_OPEN_BRACKET) {
    // Return malformed bracketed authorities unchanged.
    if (rawUrl.charCodeAt(hostEnd - 1) === 93 /* ] */) {
      return rawUrl.substring(hostStart + 1, hostEnd - 1);
    }
    return rawUrl.substring(hostStart, AUTH_E);
  }
  return rawUrl.substring(hostStart, hostEnd);
}

/**
 * Returns the explicit port as a number, or `null` if no port is present or
 * the port is malformed (non-digit content). This raw reader does not enforce
 * the canonical 0–65535 range; {@link setPort} does.
 *
 * Implicit ports (the URL spec maps `https` → 443) are intentionally NOT
 * inferred — see {@link rawOriginsEqual} for a comparison that does.
 *
 * @example
 *   readPort("http://example.com:8080/"); // → 8080
 *   readPort("http://example.com/");      // → null (no explicit port)
 *   readPort("http://example.com:abc/");  // → null (malformed)
 */
export function readPort(rawUrl: string): number | null {
  const schemePos = findSchemeEnd(rawUrl);
  if (schemePos === -1) {
    return null;
  }
  locateHostRange(rawUrl, schemePos);
  if (PORT_C === -1) {
    return null;
  }
  // Keep digit parsing inline; a cross-module call regresses this JSC path.
  const portStart = PORT_C + 1;
  const authorityEnd = AUTH_E;
  if (portStart >= authorityEnd) {
    return null;
  }
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
 * Returns `true` if `rawUrl` uses `scheme` without slicing it.
 *
 * Comparison is ASCII case-insensitive.
 *
 * @example
 *   hasScheme("HTTPS://x/", "https");   // → true
 *   hasScheme("ws://x/", "wss");        // → false
 */
export function hasScheme(rawUrl: string, scheme: string): boolean {
  const schemePos = findSchemeEnd(rawUrl);
  if (schemePos !== scheme.length) {
    return false;
  }
  for (let i = 0; i < schemePos; i++) {
    let actual = rawUrl.charCodeAt(i);
    let expected = scheme.charCodeAt(i);
    if (actual >= 65 && actual <= 90) {
      actual += 32;
    }
    if (expected >= 65 && expected <= 90) {
      expected += 32;
    }
    if (actual !== expected) {
      return false;
    }
  }
  return true;
}

/**
 * Returns `true` if the pathname starts with
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
  locatePathnameRange(rawUrl);
  const pathLen = PATH_E - PATH_S;
  if (pathLen === 0) {
    return prefix.length === 0 || prefix === "/";
  }
  if (prefix.length > pathLen) {
    return false;
  }
  return rawUrl.startsWith(prefix, PATH_S);
}

/**
 * Returns `true` if the pathname ends with
 * `suffix`. Like {@link pathnameStartsWith}, treats an absent path as `"/"`.
 *
 * @example
 *   pathnameEndsWith("https://x/page.html", ".html"); // → true
 */
export function pathnameEndsWith(rawUrl: string, suffix: string): boolean {
  locatePathnameRange(rawUrl);
  const pathLen = PATH_E - PATH_S;
  if (pathLen === 0) {
    return suffix.length === 0 || suffix === "/";
  }
  if (suffix.length > pathLen) {
    return false;
  }
  return rawUrl.startsWith(suffix, PATH_E - suffix.length);
}

/**
 * Compares selected raw origin components from already-normalized hierarchical
 * URLs. This is not a parser, canonicalizer, or security-boundary same-origin
 * check. Normalize untrusted input with `URL` before calling it.
 *
 * Implicit ports are inferred for "special" schemes (`http`=80, `https`=443,
 * `ws`=80, `wss`=443, `ftp`=21), so `rawOriginsEqual("https://x/", "https://x:443/")`
 * is `true`. Scheme and hostname compare case-insensitively (both are
 * case-insensitive per spec). For non-special schemes (e.g. `custom://`),
 * there is no implicit port — both sides must have the same explicit port
 * (or both lack one).
 *
 * @example
 *   rawOriginsEqual("https://EXAMPLE.com/x", "https://example.com:443/y"); // → true
 *   rawOriginsEqual("https://a.test/", "https://b.test/");                 // → false
 */
// fallow-ignore-next-line complexity
export function rawOriginsEqual(a: string, b: string): boolean {
  const aS = findSchemeEnd(a);
  const bS = findSchemeEnd(b);
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

  // locateHostRange writes module-level scratch — must read into locals before
  // the next call overwrites them.
  locateHostRange(a, aS);
  const aHostStart = HOST_S;
  const aHostEnd = HOST_E;
  const aPortColon = PORT_C;
  const aAuthEnd = AUTH_E;
  locateHostRange(b, bS);
  const bHostStart = HOST_S;
  const bHostEnd = HOST_E;
  const bPortColon = PORT_C;
  const bAuthEnd = AUTH_E;

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

  if (aPortColon === -1 && bPortColon === -1) {
    return true;
  }

  let aPort: number;
  if (aPortColon === -1) {
    aPort = defaultPortFor(a, aS);
    if (aPort === -1) {
      return false;
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
 * `scheme` is written verbatim and must match the URL scheme grammar. Returns
 * the input unchanged when it has no scheme.
 *
 * @example
 *   setScheme("http://example.com/", "https");  // → "https://example.com/"
 *   setScheme("/path", "https");                // → "/path" (no-op)
 */
export function setScheme(rawUrl: string, scheme: string): string {
  const schemePos = findSchemeEnd(rawUrl);
  if (schemePos === -1) {
    return rawUrl;
  }
  if (schemePos === scheme.length && rawUrl.startsWith(scheme)) {
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
  const schemePos = findSchemeEnd(rawUrl);
  if (schemePos === -1) {
    return rawUrl;
  }
  locateHostRange(rawUrl, schemePos);
  const portColon = PORT_C;
  const authorityEnd = AUTH_E;

  if (port === null) {
    if (portColon === -1) {
      return rawUrl;
    }
    return rawUrl.substring(0, portColon) + rawUrl.substring(authorityEnd);
  }
  const portStr = String(port);
  if (
    portColon !== -1 &&
    authorityEnd - portColon - 1 === portStr.length &&
    rawUrl.startsWith(portStr, portColon + 1)
  ) {
    return rawUrl;
  }
  if (portColon === -1) {
    return (
      rawUrl.substring(0, authorityEnd) +
      ":" +
      portStr +
      rawUrl.substring(authorityEnd)
    );
  }
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
 * verbatim. Literal `?` and `#` change URL structure; pass `%3F` and `%23`
 * when those characters belong to the pathname.
 *
 * @example
 *   setPathname("https://x/old?q=1#frag", "/new");
 *   // → "https://x/new?q=1#frag"
 */
// fallow-ignore-next-line complexity
export function setPathname(rawUrl: string, newPathname: string): string {
  const normalized =
    newPathname.length === 0 || newPathname.charCodeAt(0) !== CH_SLASH
      ? `/${newPathname}`
      : newPathname;

  const schemePos = findSchemeEnd(rawUrl);
  let pathStart: number;
  if (schemePos !== -1) {
    const packed = findAuthorityEnd(rawUrl, schemePos + 3);
    const packBase = rawUrl.length < AUTH_PACK ? AUTH_PACK : rawUrl.length + 1;
    pathStart = packed < packBase ? packed : packed % packBase;
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
  if (
    pathEnd - pathStart === normalized.length &&
    rawUrl.startsWith(normalized, pathStart)
  ) {
    return rawUrl;
  }
  return (
    rawUrl.substring(0, pathStart) + normalized + rawUrl.substring(pathEnd)
  );
}
