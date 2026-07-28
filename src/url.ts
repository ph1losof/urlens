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

// Module-level scratch slots — same allocation-free pattern as LOC_Q/LOC_F in
// query.ts. Sync-only: do NOT introduce await on paths that read these.
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

// Writes the pathname range [PATH_S, PATH_E) for `rawUrl`. When the URL has a
// scheme but no path slash (e.g. "https://x"), both slots are set to
// rawUrl.length so callers see pathLen === 0 and fall into the implicit "/"
// branch — matching the original inlined behavior.
//
// The indexOf("?") / indexOf("#") tail is inlined here even though setPathname
// uses the same shape — extracting it as a helper regressed pss.full by ~5%
// on JSC (a single-engine non-inlined call on this very hot path).
// fallow-ignore-next-line complexity
function locatePathnameRange(rawUrl: string): void {
  const schemePos = findSchemeEnd(rawUrl);
  let pathStart: number;
  if (schemePos !== -1) {
    const slash = rawUrl.indexOf("/", schemePos + 3);
    if (slash === -1) {
      PATH_S = rawUrl.length;
      PATH_E = rawUrl.length;
      return;
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
 *
 * Zero-copy: the returned string is a sliced-string view into the input on
 * V8/SpiderMonkey/JSC; only the small string header is allocated.
 *
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
  const schemePos = findSchemeEnd(rawUrl);
  if (schemePos === -1) {
    return "";
  }

  const authorityStart = schemePos + 3;
  const packed = findAuthorityEnd(rawUrl, authorityStart);
  const authorityEnd = packed < AUTH_PACK ? packed : packed % AUTH_PACK;

  // Strip userinfo. Per WHATWG URL, a literal '@' inside userinfo must be
  // percent-encoded, so the LAST literal '@' within the authority terminates
  // userinfo. IPv6 hosts ('[::1]') cannot contain '@', so this is also correct
  // for IPv6 without special casing.
  const at = packed < AUTH_PACK ? -1 : ((packed / AUTH_PACK) | 0) - 1;
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
  const schemePos = findSchemeEnd(rawUrl);
  return schemePos === -1 ? "" : rawUrl.substring(0, schemePos);
}

/**
 * Returns the host in canonical authority form: `hostname:port` if a port is
 * present, or just `hostname` otherwise. IPv6 brackets are preserved
 * (`[::1]:8080`). Userinfo is stripped. Returns `""` if the input has no scheme.
 *
 * Note: `readHost` and `readOrigin` keep the 4-line authority unpack inline
 * (rather than delegating to `locateHostRange` like `readHostname`/`readPort`
 * do) because they don't need the bracket/colon scan — the host range here is
 * just `[hostStart, authorityEnd)`. Calling `locateHostRange` would add an
 * unused `indexOf(":")` per call. For batched reads on one URL, prefer
 * {@link view}, which scans once and caches all offsets.
 *
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
  const authorityEnd = packed < AUTH_PACK ? packed : packed % AUTH_PACK;
  const at = packed < AUTH_PACK ? -1 : ((packed / AUTH_PACK) | 0) - 1;
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
    // Closed bracket: hostEnd points one past `]`, strip both. Malformed
    // bracket: locateHostRange leaves hostEnd === authEnd with no `]` at the
    // boundary; return the authority verbatim, matching the pre-dedup behavior.
    if (rawUrl.charCodeAt(hostEnd - 1) === 93 /* ] */) {
      return rawUrl.substring(hostStart + 1, hostEnd - 1);
    }
    return rawUrl.substring(hostStart, AUTH_E);
  }
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
  const schemePos = findSchemeEnd(rawUrl);
  if (schemePos === -1) {
    return null;
  }
  locateHostRange(rawUrl, schemePos);
  if (PORT_C === -1) {
    return null;
  }
  // Manual digit parse — inlined (a cross-module parsePortRange call regresses
  // rport.full by ~4% on JSC despite identical instruction count).
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
  const schemePos = findSchemeEnd(rawUrl);
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
 * Zero-allocation predicate: returns `true` if the pathname ends with
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
  // startsWith(needle, position) checks the bytes at `position` against
  // `needle` — perfect for verifying a suffix without allocating.
  return rawUrl.startsWith(suffix, PATH_E - suffix.length);
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
// fallow-ignore-next-line complexity
export function originMatches(a: string, b: string): boolean {
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
  const schemePos = findSchemeEnd(rawUrl);
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
    pathStart = packed < AUTH_PACK ? packed : packed % AUTH_PACK;
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
