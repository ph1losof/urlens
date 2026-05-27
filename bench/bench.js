// Cross-engine benchmark for src/shared/raw-query.ts and raw-url.ts.
// Runs in node, SpiderMonkey `js`, and JavaScriptCore `jsc`.
// No imports, no Node/Bun APIs. Pure ECMAScript + Date.now().

"use strict";

var out =
  typeof print === "function"
    ? print
    : function (s) {
        console.log(s);
      };

var hasURL = typeof URL !== "undefined";
var hasURLSearchParams = typeof URLSearchParams !== "undefined";

// --- inlined source under test (raw-query.ts + raw-url.ts) -------------------

var CH_PERCENT = 37;
var CH_PLUS = 43;
var CH_SLASH = 47;

var UTF8_DECODER =
  typeof TextDecoder !== "undefined" ? new TextDecoder() : null;

function hexNibble(code) {
  if (code >= 48 && code <= 57) return code - 48;
  var lc = code | 32;
  if (lc >= 97 && lc <= 102) return lc - 87;
  return -1;
}

function tolerantDecode(raw) {
  var out2 = "";
  var bytes = [];
  function flush() {
    if (bytes.length) {
      if (UTF8_DECODER) {
        out2 += UTF8_DECODER.decode(new Uint8Array(bytes));
      } else {
        for (var k = 0; k < bytes.length; k++)
          out2 += String.fromCharCode(bytes[k]);
      }
      bytes.length = 0;
    }
  }
  for (var i = 0; i < raw.length; i++) {
    var c = raw.charCodeAt(i);
    if (c === CH_PLUS) {
      flush();
      out2 += " ";
      continue;
    }
    if (c === CH_PERCENT && i + 2 < raw.length) {
      var hi = hexNibble(raw.charCodeAt(i + 1));
      var lo = hexNibble(raw.charCodeAt(i + 2));
      if (hi !== -1 && lo !== -1) {
        bytes.push((hi << 4) | lo);
        i += 2;
        continue;
      }
    }
    flush();
    out2 += raw[i];
  }
  flush();
  return out2;
}

// Single-pass scan over [start, end) detects '%' and '+' simultaneously. When
// neither appears, returns a sliced substring directly with no extra work.
function decodeRange(s, start, end) {
  var pct = false;
  var plus = false;
  for (var p = start; p < end; p++) {
    var c = s.charCodeAt(p);
    if (c === CH_PERCENT) {
      if (plus) {
        pct = true;
        break;
      }
      pct = true;
    } else if (c === CH_PLUS) {
      if (pct) {
        plus = true;
        break;
      }
      plus = true;
    }
  }
  if (!pct && !plus) return s.substring(start, end);
  if (!pct) return plusToSpace(s, start, end);
  var prepared = plus ? plusToSpace(s, start, end) : s.substring(start, end);
  try {
    return decodeURIComponent(prepared);
  } catch (_e) {
    // fallthrough
  }
  return tolerantDecode(prepared);
}

function plusToSpace(s, start, end) {
  var out = "";
  var runStart = start;
  for (var i = start; i < end; i++) {
    if (s.charCodeAt(i) === CH_PLUS) {
      out += s.substring(runStart, i);
      out += " ";
      runStart = i + 1;
    }
  }
  return out + s.substring(runStart, end);
}

function decodeQueryComponent(raw) {
  return decodeRange(raw, 0, raw.length);
}

// Module-level out-params for the locate routine: a query can be located with
// zero object allocations. Single-threaded JS makes this safe across calls.
var LOC_Q = -1;
var LOC_F = 0;

function locate(rawUrl) {
  var qPos = rawUrl.indexOf("?");
  if (qPos === -1) {
    var hPos = rawUrl.indexOf("#");
    LOC_Q = -1;
    LOC_F = hPos === -1 ? rawUrl.length : hPos;
    return;
  }
  var hPos = rawUrl.indexOf("#");
  if (hPos !== -1 && hPos < qPos) {
    // '?' is inside a fragment — treat as no query.
    LOC_Q = -1;
    LOC_F = hPos;
    return;
  }
  LOC_Q = qPos;
  LOC_F = hPos === -1 ? rawUrl.length : hPos;
}

function readQueryParam(rawUrl, key) {
  locate(rawUrl);
  var qPos = LOC_Q;
  if (qPos === -1) return null;
  var end = LOC_F;
  var keyLen = key.length;
  var i = qPos + 1;
  while (i < end) {
    var amp = rawUrl.indexOf("&", i);
    if (amp === -1 || amp > end) amp = end;
    var eq = rawUrl.indexOf("=", i);
    var keyEnd = eq === -1 || eq > amp ? amp : eq;
    if (keyEnd - i === keyLen && rawUrl.startsWith(key, i)) {
      if (eq === -1 || eq > amp) return "";
      return decodeRange(rawUrl, eq + 1, amp);
    }
    i = amp + 1;
  }
  return null;
}

function readQueryParams(rawUrl, keys) {
  var n = keys.length;
  var out = new Array(n);
  if (n === 0) return out;

  var firstChars = new Array(n);
  var keyLens = new Array(n);
  for (var z = 0; z < n; z++) {
    out[z] = null;
    firstChars[z] = keys[z].charCodeAt(0);
    keyLens[z] = keys[z].length;
  }

  locate(rawUrl);
  var qPos = LOC_Q;
  if (qPos === -1) return out;
  var end = LOC_F;

  var remaining = n;
  var i = qPos + 1;
  while (i < end && remaining > 0) {
    var amp = rawUrl.indexOf("&", i);
    if (amp === -1 || amp > end) amp = end;
    var eq = rawUrl.indexOf("=", i);
    var keyEnd = eq === -1 || eq > amp ? amp : eq;
    var fieldLen = keyEnd - i;
    var fc = rawUrl.charCodeAt(i);

    for (var k = 0; k < n; k++) {
      if (out[k] !== null) continue;
      if (keyLens[k] !== fieldLen || firstChars[k] !== fc) continue;
      if (rawUrl.startsWith(keys[k], i)) {
        out[k] =
          eq === -1 || eq > amp ? "" : decodeRange(rawUrl, eq + 1, amp);
        remaining--;
      }
    }
    i = amp + 1;
  }
  return out;
}

var CH_QUESTION = 63;
var CH_HASH = 35;
var CH_COLON = 58;
var CH_OPEN_BRACKET = 91;
var CH_CLOSE_BRACKET = 93;
var CH_0 = 48;
var CH_9 = 57;

function findAuthorityEnd(rawUrl, start) {
  var len = rawUrl.length;
  for (var i = start; i < len; i++) {
    var c = rawUrl.charCodeAt(i);
    if (c === CH_SLASH || c === CH_QUESTION || c === CH_HASH) return i;
  }
  return len;
}

function readPathname(rawUrl) {
  var schemePos = rawUrl.indexOf("://");
  var start;
  if (schemePos !== -1) {
    var slash = rawUrl.indexOf("/", schemePos + 3);
    if (slash === -1) return "/";
    start = slash;
  } else {
    start = 0;
  }
  var end = rawUrl.length;
  var qPos = rawUrl.indexOf("?", start);
  if (qPos !== -1 && qPos < end) end = qPos;
  var hPos = rawUrl.indexOf("#", start);
  if (hPos !== -1 && hPos < end) end = hPos;
  return end === start ? "/" : rawUrl.substring(start, end);
}

function readOrigin(rawUrl) {
  var schemePos = rawUrl.indexOf("://");
  if (schemePos === -1) return "";
  var authorityStart = schemePos + 3;
  var authorityEnd = findAuthorityEnd(rawUrl, authorityStart);
  var at = rawUrl.lastIndexOf("@", authorityEnd - 1);
  var hostStart = at >= authorityStart ? at + 1 : authorityStart;
  if (hostStart === authorityStart) {
    return rawUrl.substring(0, authorityEnd);
  }
  return (
    rawUrl.substring(0, authorityStart) +
    rawUrl.substring(hostStart, authorityEnd)
  );
}

function readScheme(rawUrl) {
  var schemePos = rawUrl.indexOf("://");
  return schemePos === -1 ? "" : rawUrl.substring(0, schemePos);
}

function readHost(rawUrl) {
  var schemePos = rawUrl.indexOf("://");
  if (schemePos === -1) return "";
  var authorityStart = schemePos + 3;
  var authorityEnd = findAuthorityEnd(rawUrl, authorityStart);
  var at = rawUrl.lastIndexOf("@", authorityEnd - 1);
  var hostStart = at >= authorityStart ? at + 1 : authorityStart;
  return rawUrl.substring(hostStart, authorityEnd);
}

function readHostname(rawUrl) {
  var schemePos = rawUrl.indexOf("://");
  if (schemePos === -1) return "";
  var authorityStart = schemePos + 3;
  var authorityEnd = findAuthorityEnd(rawUrl, authorityStart);
  var at = rawUrl.lastIndexOf("@", authorityEnd - 1);
  var hostStart = at >= authorityStart ? at + 1 : authorityStart;
  if (rawUrl.charCodeAt(hostStart) === CH_OPEN_BRACKET) {
    var closeBracket = rawUrl.indexOf("]", hostStart + 1);
    if (closeBracket !== -1 && closeBracket < authorityEnd) {
      return rawUrl.substring(hostStart + 1, closeBracket);
    }
    return rawUrl.substring(hostStart, authorityEnd);
  }
  var colonPos = rawUrl.indexOf(":", hostStart);
  var hostEnd =
    colonPos !== -1 && colonPos < authorityEnd ? colonPos : authorityEnd;
  return rawUrl.substring(hostStart, hostEnd);
}

function readPort(rawUrl) {
  var schemePos = rawUrl.indexOf("://");
  if (schemePos === -1) return null;
  var authorityStart = schemePos + 3;
  var authorityEnd = findAuthorityEnd(rawUrl, authorityStart);
  var at = rawUrl.lastIndexOf("@", authorityEnd - 1);
  var hostStart = at >= authorityStart ? at + 1 : authorityStart;
  var portStart;
  if (rawUrl.charCodeAt(hostStart) === CH_OPEN_BRACKET) {
    var closeBracket = rawUrl.indexOf("]", hostStart + 1);
    if (closeBracket === -1 || closeBracket >= authorityEnd) return null;
    var afterBracket = closeBracket + 1;
    if (
      afterBracket >= authorityEnd ||
      rawUrl.charCodeAt(afterBracket) !== CH_COLON
    ) {
      return null;
    }
    portStart = afterBracket + 1;
  } else {
    var colonPos = rawUrl.indexOf(":", hostStart);
    if (colonPos === -1 || colonPos >= authorityEnd) return null;
    portStart = colonPos + 1;
  }
  if (portStart >= authorityEnd) return null;
  var port = 0;
  for (var i = portStart; i < authorityEnd; i++) {
    var c = rawUrl.charCodeAt(i);
    if (c < CH_0 || c > CH_9) return null;
    port = port * 10 + (c - CH_0);
  }
  return port;
}

var CH_BANG = 0x21;
var CH_QUOTE = 0x27;
var CH_LPAREN = 0x28;
var CH_RPAREN = 0x29;
var CH_TILDE = 0x7e;
var CH_2 = 0x32;
var CH_0CHAR = 0x30;

function encodeQueryComponent(value) {
  var valueLen = value.length;
  if (valueLen === 0) return value;
  // F1: WHATWG safe-set fast path. If every byte is alphanumeric or one of
  // - . _ * we return the input verbatim — no native call, no allocation.
  var allSafe = true;
  for (var p = 0; p < valueLen; p++) {
    var cs = value.charCodeAt(p);
    if (cs >= 97 && cs <= 122) continue; // a-z
    if (cs >= 65 && cs <= 90) continue; // A-Z
    if (cs >= 48 && cs <= 57) continue; // 0-9
    if (cs === 45 || cs === 46 || cs === 95 || cs === 42) continue; // - . _ *
    allSafe = false;
    break;
  }
  if (allSafe) return value;
  var initial = encodeURIComponent(value);
  var out = "";
  var runStart = 0;
  var i = 0;
  var len = initial.length;
  while (i < len) {
    var c = initial.charCodeAt(i);
    if (c === CH_PERCENT) {
      if (
        i + 2 < len &&
        initial.charCodeAt(i + 1) === CH_2 &&
        initial.charCodeAt(i + 2) === CH_0CHAR
      ) {
        out += initial.substring(runStart, i);
        out += "+";
        i += 3;
        runStart = i;
      } else {
        i += 3;
      }
      continue;
    }
    var replacement;
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
  if (runStart === 0) return initial;
  return out + initial.substring(runStart);
}

function setQueryParam(rawUrl, key, value) {
  locate(rawUrl);
  var qPos = LOC_Q;
  var fragmentStart = LOC_F;
  var encoded = value === null ? null : encodeQueryComponent(value);

  if (qPos === -1) {
    if (value === null) return rawUrl;
    return (
      rawUrl.substring(0, fragmentStart) +
      "?" +
      key +
      "=" +
      encoded +
      rawUrl.substring(fragmentStart)
    );
  }

  var queryStart = qPos + 1;
  var queryEnd = fragmentStart;
  var keyLen = key.length;
  var newQuery = "";
  var replaced = false;
  var i = queryStart;
  while (i < queryEnd) {
    var amp = rawUrl.indexOf("&", i);
    if (amp === -1 || amp > queryEnd) amp = queryEnd;
    var eq = rawUrl.indexOf("=", i);
    var keyEnd = eq === -1 || eq > amp ? amp : eq;
    var isMatch = keyEnd - i === keyLen && rawUrl.startsWith(key, i);
    if (isMatch) {
      if (!replaced && encoded !== null) {
        if (newQuery.length > 0) newQuery += "&";
        newQuery += key + "=" + encoded;
        replaced = true;
      }
    } else {
      if (newQuery.length > 0) newQuery += "&";
      newQuery += rawUrl.substring(i, amp);
    }
    i = amp + 1;
  }
  if (!replaced && encoded !== null) {
    if (newQuery.length > 0) newQuery += "&";
    newQuery += key + "=" + encoded;
  }
  var prefix = rawUrl.substring(0, qPos);
  var suffix = rawUrl.substring(queryEnd);
  if (newQuery.length === 0) return prefix + suffix;
  return prefix + "?" + newQuery + suffix;
}

function setPathname(rawUrl, newPathname) {
  var normalized =
    newPathname.length === 0 || newPathname.charCodeAt(0) !== CH_SLASH
      ? "/" + newPathname
      : newPathname;
  var schemePos = rawUrl.indexOf("://");
  var pathStart;
  if (schemePos !== -1) {
    pathStart = findAuthorityEnd(rawUrl, schemePos + 3);
  } else {
    pathStart = 0;
  }
  var pathEnd = rawUrl.length;
  var qPos = rawUrl.indexOf("?", pathStart);
  if (qPos !== -1 && qPos < pathEnd) pathEnd = qPos;
  var hPos = rawUrl.indexOf("#", pathStart);
  if (hPos !== -1 && hPos < pathEnd) pathEnd = hPos;
  return rawUrl.substring(0, pathStart) + normalized + rawUrl.substring(pathEnd);
}

function hasScheme(rawUrl, scheme) {
  var schemePos = rawUrl.indexOf("://");
  if (schemePos !== scheme.length) return false;
  for (var i = 0; i < schemePos; i++) {
    if ((rawUrl.charCodeAt(i) | 32) !== (scheme.charCodeAt(i) | 32)) return false;
  }
  return true;
}

function pathnameStartsWith(rawUrl, prefix) {
  var schemePos = rawUrl.indexOf("://");
  var pathStart;
  if (schemePos !== -1) {
    var slash = rawUrl.indexOf("/", schemePos + 3);
    if (slash === -1) return prefix.length === 0 || prefix === "/";
    pathStart = slash;
  } else {
    pathStart = 0;
  }
  var pathEnd = rawUrl.length;
  var qPos = rawUrl.indexOf("?", pathStart);
  if (qPos !== -1 && qPos < pathEnd) pathEnd = qPos;
  var hPos = rawUrl.indexOf("#", pathStart);
  if (hPos !== -1 && hPos < pathEnd) pathEnd = hPos;
  var pathLen = pathEnd - pathStart;
  if (pathLen === 0) return prefix.length === 0 || prefix === "/";
  if (prefix.length > pathLen) return false;
  return rawUrl.startsWith(prefix, pathStart);
}

function pathnameEndsWith(rawUrl, suffix) {
  var schemePos = rawUrl.indexOf("://");
  var pathStart;
  if (schemePos !== -1) {
    var slash = rawUrl.indexOf("/", schemePos + 3);
    if (slash === -1) return suffix.length === 0 || suffix === "/";
    pathStart = slash;
  } else {
    pathStart = 0;
  }
  var pathEnd = rawUrl.length;
  var qPos = rawUrl.indexOf("?", pathStart);
  if (qPos !== -1 && qPos < pathEnd) pathEnd = qPos;
  var hPos = rawUrl.indexOf("#", pathStart);
  if (hPos !== -1 && hPos < pathEnd) pathEnd = hPos;
  var pathLen = pathEnd - pathStart;
  if (pathLen === 0) return suffix.length === 0 || suffix === "/";
  if (suffix.length > pathLen) return false;
  return rawUrl.startsWith(suffix, pathEnd - suffix.length);
}

function defaultPortFor(rawUrl, schemeEnd) {
  if (schemeEnd === 5) {
    if (
      (rawUrl.charCodeAt(0) | 32) === 104 &&
      (rawUrl.charCodeAt(1) | 32) === 116 &&
      (rawUrl.charCodeAt(2) | 32) === 116 &&
      (rawUrl.charCodeAt(3) | 32) === 112 &&
      (rawUrl.charCodeAt(4) | 32) === 115
    ) return 443;
    return -1;
  }
  if (schemeEnd === 4) {
    if (
      (rawUrl.charCodeAt(0) | 32) === 104 &&
      (rawUrl.charCodeAt(1) | 32) === 116 &&
      (rawUrl.charCodeAt(2) | 32) === 116 &&
      (rawUrl.charCodeAt(3) | 32) === 112
    ) return 80;
    return -1;
  }
  if (schemeEnd === 3) {
    var c0 = rawUrl.charCodeAt(0) | 32;
    if (
      c0 === 102 &&
      (rawUrl.charCodeAt(1) | 32) === 116 &&
      (rawUrl.charCodeAt(2) | 32) === 112
    ) return 21;
    if (
      c0 === 119 &&
      (rawUrl.charCodeAt(1) | 32) === 115 &&
      (rawUrl.charCodeAt(2) | 32) === 115
    ) return 443;
    return -1;
  }
  if (schemeEnd === 2) {
    if (
      (rawUrl.charCodeAt(0) | 32) === 119 &&
      (rawUrl.charCodeAt(1) | 32) === 115
    ) return 80;
    return -1;
  }
  return -1;
}

function parsePortRange(s, start, end) {
  if (start >= end) return -1;
  var port = 0;
  for (var i = start; i < end; i++) {
    var c = s.charCodeAt(i);
    if (c < CH_0 || c > CH_9) return -1;
    port = port * 10 + (c - CH_0);
  }
  return port;
}

function originMatches(a, b) {
  var aS = a.indexOf("://");
  var bS = b.indexOf("://");
  if (aS === -1 || bS === -1 || aS !== bS) return false;
  for (var s = 0; s < aS; s++) {
    if ((a.charCodeAt(s) | 32) !== (b.charCodeAt(s) | 32)) return false;
  }
  var aAuthStart = aS + 3;
  var bAuthStart = bS + 3;
  var aAuthEnd = findAuthorityEnd(a, aAuthStart);
  var bAuthEnd = findAuthorityEnd(b, bAuthStart);
  var aAt = a.lastIndexOf("@", aAuthEnd - 1);
  var bAt = b.lastIndexOf("@", bAuthEnd - 1);
  var aHostStart = aAt >= aAuthStart ? aAt + 1 : aAuthStart;
  var bHostStart = bAt >= bAuthStart ? bAt + 1 : bAuthStart;

  var aHostEnd, aPortColon;
  if (a.charCodeAt(aHostStart) === CH_OPEN_BRACKET) {
    var aClose = a.indexOf("]", aHostStart + 1);
    if (aClose === -1 || aClose >= aAuthEnd) {
      aHostEnd = aAuthEnd;
      aPortColon = -1;
    } else {
      aHostEnd = aClose + 1;
      aPortColon =
        aHostEnd < aAuthEnd && a.charCodeAt(aHostEnd) === CH_COLON
          ? aHostEnd
          : -1;
    }
  } else {
    var aColon = a.indexOf(":", aHostStart);
    if (aColon !== -1 && aColon < aAuthEnd) {
      aHostEnd = aColon;
      aPortColon = aColon;
    } else {
      aHostEnd = aAuthEnd;
      aPortColon = -1;
    }
  }
  var bHostEnd, bPortColon;
  if (b.charCodeAt(bHostStart) === CH_OPEN_BRACKET) {
    var bClose = b.indexOf("]", bHostStart + 1);
    if (bClose === -1 || bClose >= bAuthEnd) {
      bHostEnd = bAuthEnd;
      bPortColon = -1;
    } else {
      bHostEnd = bClose + 1;
      bPortColon =
        bHostEnd < bAuthEnd && b.charCodeAt(bHostEnd) === CH_COLON
          ? bHostEnd
          : -1;
    }
  } else {
    var bColon = b.indexOf(":", bHostStart);
    if (bColon !== -1 && bColon < bAuthEnd) {
      bHostEnd = bColon;
      bPortColon = bColon;
    } else {
      bHostEnd = bAuthEnd;
      bPortColon = -1;
    }
  }

  var aHostLen = aHostEnd - aHostStart;
  if (aHostLen !== bHostEnd - bHostStart) return false;
  for (var h = 0; h < aHostLen; h++) {
    var ac = a.charCodeAt(aHostStart + h);
    var bc = b.charCodeAt(bHostStart + h);
    if (ac >= 65 && ac <= 90) ac += 32;
    if (bc >= 65 && bc <= 90) bc += 32;
    if (ac !== bc) return false;
  }

  if (aPortColon === -1 && bPortColon === -1) return true;
  var aPort;
  if (aPortColon === -1) {
    aPort = defaultPortFor(a, aS);
    if (aPort === -1) return false;
  } else {
    aPort = parsePortRange(a, aPortColon + 1, aAuthEnd);
    if (aPort === -1) return false;
  }
  var bPort;
  if (bPortColon === -1) {
    bPort = defaultPortFor(b, bS);
    if (bPort === -1) return false;
  } else {
    bPort = parsePortRange(b, bPortColon + 1, bAuthEnd);
    if (bPort === -1) return false;
  }
  return aPort === bPort;
}

function readFragment(rawUrl) {
  var hPos = rawUrl.indexOf("#");
  return hPos === -1 ? "" : rawUrl.substring(hPos + 1);
}

function stripFragment(rawUrl) {
  var hPos = rawUrl.indexOf("#");
  return hPos === -1 ? rawUrl : rawUrl.substring(0, hPos);
}

function setScheme(rawUrl, scheme) {
  var schemePos = rawUrl.indexOf("://");
  if (schemePos === -1) return rawUrl;
  return scheme + rawUrl.substring(schemePos);
}

function setPort(rawUrl, port) {
  if (port !== null) {
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
      throw new RangeError("setPort: invalid port");
    }
  }
  var schemePos = rawUrl.indexOf("://");
  if (schemePos === -1) return rawUrl;
  var authorityStart = schemePos + 3;
  var authorityEnd = findAuthorityEnd(rawUrl, authorityStart);
  var at = rawUrl.lastIndexOf("@", authorityEnd - 1);
  var hostStart = at >= authorityStart ? at + 1 : authorityStart;
  var portColon = -1;
  if (rawUrl.charCodeAt(hostStart) === CH_OPEN_BRACKET) {
    var closeBracket = rawUrl.indexOf("]", hostStart + 1);
    if (closeBracket !== -1 && closeBracket < authorityEnd) {
      var afterBracket = closeBracket + 1;
      if (
        afterBracket < authorityEnd &&
        rawUrl.charCodeAt(afterBracket) === CH_COLON
      ) {
        portColon = afterBracket;
      }
    }
  } else {
    var colonPos = rawUrl.indexOf(":", hostStart);
    if (colonPos !== -1 && colonPos < authorityEnd) portColon = colonPos;
  }
  if (port === null) {
    if (portColon === -1) return rawUrl;
    return rawUrl.substring(0, portColon) + rawUrl.substring(authorityEnd);
  }
  var portStr = String(port);
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

function hasQueryParam(rawUrl, key) {
  var qPos = rawUrl.indexOf("?");
  if (qPos === -1) return false;
  var hPos = rawUrl.indexOf("#");
  if (hPos !== -1 && hPos < qPos) return false;
  var fragmentStart = hPos === -1 ? rawUrl.length : hPos;
  var keyLen = key.length;
  var i = qPos + 1;
  while (i < fragmentStart) {
    var amp = rawUrl.indexOf("&", i);
    if (amp === -1 || amp > fragmentStart) amp = fragmentStart;
    var eq = rawUrl.indexOf("=", i);
    var keyEnd = eq === -1 || eq > amp ? amp : eq;
    if (keyEnd - i === keyLen && rawUrl.startsWith(key, i)) return true;
    i = amp + 1;
  }
  return false;
}

function readContByte(s, pos, end) {
  if (pos + 2 >= end || s.charCodeAt(pos) !== CH_PERCENT) return -1;
  var hi = hexNibble(s.charCodeAt(pos + 1));
  var lo = hexNibble(s.charCodeAt(pos + 2));
  if (hi === -1 || lo === -1) return -1;
  var b = (hi << 4) | lo;
  if ((b & 0xc0) !== 0x80) return -1;
  return b;
}

function valueEquals(s, start, end, expected) {
  var expectedLen = expected.length;
  var i = start;
  var j = 0;
  while (i < end && j < expectedLen) {
    var codepoint, advance;
    var c = s.charCodeAt(i);
    if (c === CH_PLUS) {
      codepoint = 32;
      advance = 1;
    } else if (c === CH_PERCENT && i + 2 < end) {
      var hi = hexNibble(s.charCodeAt(i + 1));
      var lo = hexNibble(s.charCodeAt(i + 2));
      if (hi === -1 || lo === -1) {
        codepoint = 37;
        advance = 1;
      } else {
        var byte = (hi << 4) | lo;
        if (byte < 0x80) {
          codepoint = byte;
          advance = 3;
        } else if (byte < 0xc2) {
          codepoint = 0xfffd;
          advance = 3;
        } else if (byte < 0xe0) {
          var c1 = readContByte(s, i + 3, end);
          if (c1 === -1) {
            codepoint = 0xfffd;
            advance = 3;
          } else {
            codepoint = ((byte & 0x1f) << 6) | (c1 & 0x3f);
            advance = 6;
          }
        } else if (byte < 0xf0) {
          var c1b = readContByte(s, i + 3, end);
          if (c1b === -1) {
            codepoint = 0xfffd;
            advance = 3;
          } else {
            var lower3 = byte === 0xe0 ? 0xa0 : 0x80;
            var upper3 = byte === 0xed ? 0x9f : 0xbf;
            if (c1b < lower3 || c1b > upper3) {
              codepoint = 0xfffd;
              advance = 3;
            } else {
              var c2 = readContByte(s, i + 6, end);
              if (c2 === -1) {
                codepoint = 0xfffd;
                advance = 6;
              } else {
                codepoint =
                  ((byte & 0x0f) << 12) |
                  ((c1b & 0x3f) << 6) |
                  (c2 & 0x3f);
                advance = 9;
              }
            }
          }
        } else if (byte < 0xf5) {
          var c1c = readContByte(s, i + 3, end);
          if (c1c === -1) {
            codepoint = 0xfffd;
            advance = 3;
          } else {
            var lower4 = byte === 0xf0 ? 0x90 : 0x80;
            var upper4 = byte === 0xf4 ? 0x8f : 0xbf;
            if (c1c < lower4 || c1c > upper4) {
              codepoint = 0xfffd;
              advance = 3;
            } else {
              var c2b = readContByte(s, i + 6, end);
              if (c2b === -1) {
                codepoint = 0xfffd;
                advance = 6;
              } else {
                var c3 = readContByte(s, i + 9, end);
                if (c3 === -1) {
                  codepoint = 0xfffd;
                  advance = 9;
                } else {
                  codepoint =
                    ((byte & 0x07) << 18) |
                    ((c1c & 0x3f) << 12) |
                    ((c2b & 0x3f) << 6) |
                    (c3 & 0x3f);
                  advance = 12;
                }
              }
            }
          }
        } else {
          codepoint = 0xfffd;
          advance = 3;
        }
      }
    } else {
      codepoint = c;
      advance = 1;
    }
    if (codepoint <= 0xffff) {
      if (expected.charCodeAt(j) !== codepoint) return false;
      j++;
    } else {
      if (j + 1 >= expectedLen) return false;
      var off = codepoint - 0x10000;
      if (expected.charCodeAt(j) !== 0xd800 + (off >> 10)) return false;
      if (expected.charCodeAt(j + 1) !== 0xdc00 + (off & 0x3ff)) return false;
      j += 2;
    }
    i += advance;
  }
  return i === end && j === expectedLen;
}

function queryParamEquals(rawUrl, key, expected) {
  var qPos = rawUrl.indexOf("?");
  if (qPos === -1) return false;
  var hPos = rawUrl.indexOf("#");
  if (hPos !== -1 && hPos < qPos) return false;
  var fragmentStart = hPos === -1 ? rawUrl.length : hPos;
  var keyLen = key.length;
  var i = qPos + 1;
  while (i < fragmentStart) {
    var amp = rawUrl.indexOf("&", i);
    if (amp === -1 || amp > fragmentStart) amp = fragmentStart;
    var eq = rawUrl.indexOf("=", i);
    var keyEnd = eq === -1 || eq > amp ? amp : eq;
    if (keyEnd - i === keyLen && rawUrl.startsWith(key, i)) {
      var valStart = eq === -1 || eq > amp ? amp : eq + 1;
      return valueEquals(rawUrl, valStart, amp, expected);
    }
    i = amp + 1;
  }
  return false;
}

function readQuery(rawUrl) {
  locate(rawUrl);
  if (LOC_Q === -1) return "";
  return rawUrl.substring(LOC_Q + 1, LOC_F);
}

function stripQuery(rawUrl) {
  locate(rawUrl);
  if (LOC_Q === -1) return rawUrl;
  return rawUrl.substring(0, LOC_Q) + rawUrl.substring(LOC_F);
}

// --- fixtures ----------------------------------------------------------------
//
// To defeat aggressive constant-folding in modern JITs (JSC FTL / SpiderMonkey Warp
// will inline pure functions over constant string args and elide the call entirely),
// each case rotates through an array of N similar-shape inputs via a counter the
// optimizer can't see through. Length 8 is a power of two so we can use bitwise &.

var IDX = 0;
var MASK = 7; // ring of 8

function ring(arr) {
  // Pad/truncate to exactly 8 entries.
  var out = [];
  for (var i = 0; i < 8; i++) out.push(arr[i % arr.length]);
  return out;
}

var FIX = {
  plainQuery: ring([
    "https://example.com/search?q=hello+world&utm_source=newsletter&page=2",
    "https://example.org/find?q=widgets&utm_source=ad&page=1",
    "https://a.test/s?q=apple+pie&utm_source=email&page=4",
    "https://b.test/search?q=tea&utm_source=tw&page=3",
    "https://c.test/s?q=banana&utm_source=ig&page=7",
    "https://d.test/q?q=red+fox&utm_source=rss&page=2",
    "https://e.test/s?q=mango&utm_source=fb&page=5",
    "https://f.test/search?q=cherry&utm_source=yt&page=6",
  ]),
  encodedQuery: ring([
    "https://example.com/search?q=caf%C3%A9%20%E2%98%95&lang=fr-FR&from=home",
    "https://example.com/s?q=na%C3%AFve%20resum%C3%A9&lang=fr-CA&from=app",
    "https://example.com/x?q=%E4%B8%AD%E6%96%87&lang=zh-CN&from=link",
    "https://example.com/y?q=%D0%BF%D1%80%D0%B8%D0%B2%D0%B5%D1%82&lang=ru-RU&from=src",
    "https://example.com/z?q=%E3%81%93%E3%82%93&lang=ja-JP&from=app",
    "https://example.com/a?q=%E0%A4%A8%E0%A4%AE&lang=hi-IN&from=ad",
    "https://example.com/b?q=%CE%B1%CE%B2%CE%B3&lang=el-GR&from=email",
    "https://example.com/c?q=%D8%B9%D8%B1%D8%A8%D9%8A&lang=ar-SA&from=home",
  ]),
  malformedQuery: ring([
    "https://example.com/x?q=100%25+off&bad=%ZZ%G1&u=https%3A%2F%2Fa.b%2Fc",
    "https://example.com/x?q=50%25+sale&bad=%QQ%XX&u=https%3A%2F%2Fb.b%2Fd",
    "https://example.com/x?q=20%25+disc&bad=%--%++&u=https%3A%2F%2Fc.b%2Fe",
    "https://example.com/x?q=10%25+save&bad=%@@%!!&u=https%3A%2F%2Fd.b%2Ff",
    "https://example.com/x?q=05%25+off2&bad=%ZZ%G2&u=https%3A%2F%2Fe.b%2Fg",
    "https://example.com/x?q=25%25+yes&bad=%YY%G3&u=https%3A%2F%2Ff.b%2Fh",
    "https://example.com/x?q=40%25+now&bad=%XX%G4&u=https%3A%2F%2Fg.b%2Fi",
    "https://example.com/x?q=60%25+max&bad=%WW%G5&u=https%3A%2F%2Fh.b%2Fj",
  ]),
  longQuery: ring([
    "https://example.com/api/v1/list?a=1&b=2&c=3&d=4&e=5&f=6&g=7&h=8&i=9&j=10&k=11&q=needle&z=last",
    "https://example.com/api/v2/find?a=1&b=2&c=3&d=4&e=5&f=6&g=7&h=8&i=9&j=10&k=11&q=apple&z=end",
    "https://example.com/api/v1/q?a=1&b=2&c=3&d=4&e=5&f=6&g=7&h=8&i=9&j=10&k=11&q=banana&z=fin",
    "https://example.com/api/v3/s?a=1&b=2&c=3&d=4&e=5&f=6&g=7&h=8&i=9&j=10&k=11&q=cherry&z=stop",
    "https://example.com/api/v1/g?a=1&b=2&c=3&d=4&e=5&f=6&g=7&h=8&i=9&j=10&k=11&q=date&z=halt",
    "https://example.com/api/v4/h?a=1&b=2&c=3&d=4&e=5&f=6&g=7&h=8&i=9&j=10&k=11&q=elder&z=done",
    "https://example.com/api/v2/p?a=1&b=2&c=3&d=4&e=5&f=6&g=7&h=8&i=9&j=10&k=11&q=fig&z=fini",
    "https://example.com/api/v1/r?a=1&b=2&c=3&d=4&e=5&f=6&g=7&h=8&i=9&j=10&k=11&q=grape&z=last",
  ]),
  twoKeyQuery: ring([
    "https://example.com/r?q=hello%20world&t=duck&utm_source=x&utm_campaign=y",
    "https://example.com/r?q=foo%20bar&t=goog&utm_source=a&utm_campaign=b",
    "https://example.com/r?q=red%20fox&t=bing&utm_source=c&utm_campaign=d",
    "https://example.com/r?q=blue%20jay&t=ddg&utm_source=e&utm_campaign=f",
    "https://example.com/r?q=tea%20pot&t=kagi&utm_source=g&utm_campaign=h",
    "https://example.com/r?q=ice%20cube&t=brv&utm_source=i&utm_campaign=j",
    "https://example.com/r?q=warm%20day&t=yan&utm_source=k&utm_campaign=l",
    "https://example.com/r?q=cold%20cup&t=pre&utm_source=m&utm_campaign=n",
  ]),
  pathOnly: ring([
    "/api/v1/users/42",
    "/api/v1/users/17",
    "/api/v2/items/108",
    "/api/v1/orders/9001",
    "/api/v3/posts/12",
    "/api/v1/teams/77",
    "/api/v2/users/55",
    "/api/v4/files/3",
  ]),
  fullUrl: ring([
    "https://example.com/api/v1/users/42?x=1#frag",
    "https://example.org/api/v1/users/17?x=2#a",
    "https://a.test/api/v2/items/108?y=3#b",
    "https://b.test/api/v1/orders/9001?z=4#c",
    "https://c.test/api/v3/posts/12?w=5#d",
    "https://d.test/api/v1/teams/77?v=6#e",
    "https://e.test/api/v2/users/55?u=7#f",
    "https://f.test/api/v4/files/3?t=8#g",
  ]),
  hostUrl: ring([
    "https://user:pass@example.com:8080/api?q=1",
    "https://u@example.org:443/path",
    "https://api.example.com:9000/route",
    "https://x.test:3000/v1",
    "https://y.test/v2",
    "https://z.test:8443/v3",
    "https://w.test:5000/v4",
    "https://q.test:65535/v5",
  ]),
};

function nextIdx() {
  IDX = (IDX + 1) & MASK;
  return IDX;
}

// --- harness -----------------------------------------------------------------

// performance.now() gives sub-millisecond resolution in all three target
// engines (V8, SpiderMonkey, JSC); we fall back to Date.now() only for
// shells that lack it (older standalone JSC).
var now =
  typeof performance !== "undefined" && typeof performance.now === "function"
    ? function () { return performance.now(); }
    : function () { return Date.now(); };

// run `fn` repeatedly for `budgetMs`. Returns ops/sec.
// Sink is a global so engines can't dead-code-eliminate the work.
var SINK = 0;
function bench(name, fn, budgetMs) {
  // Warmup: a longer window (up to 200ms) gives TurboFan / Warp / FTL the
  // headroom to tier up the inner function before the measurement window
  // opens, which tightens variance noticeably on the heavier setters.
  var warmEnd = now() + Math.max(200, budgetMs / 4);
  while (now() < warmEnd) {
    for (var i = 0; i < 256; i++) fn();
  }

  // measure: count ops over the budget, in batches to amortize timer cost.
  // Use the actual elapsed time (sub-ms via performance.now) so the reported
  // ops/sec reflects the work the runtime really did, not the requested budget.
  var ops = 0;
  var start = now();
  var deadline = start + budgetMs;
  while (now() < deadline) {
    for (var j = 0; j < 1024; j++) fn();
    ops += 1024;
  }
  var elapsed = now() - start;
  return { name: name, ops: ops, perSec: (ops / elapsed) * 1000 };
}

function fmt(n) {
  if (n >= 1e9) return (n / 1e9).toFixed(2) + "G";
  if (n >= 1e6) return (n / 1e6).toFixed(2) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(2) + "K";
  return n.toFixed(0);
}

function pad(s, n) {
  s = String(s);
  while (s.length < n) s += " ";
  return s;
}

// --- cases -------------------------------------------------------------------

var cases = [];

function add(name, fn) {
  cases.push({ name: name, fn: fn });
}

// readQueryParam — plain ASCII (fast path)
add("rq.plain", function () {
  var u = FIX.plainQuery[nextIdx()];
  SINK = (SINK + (readQueryParam(u, "q") || "").length) | 0;
});
if (hasURL) {
  add("URL.plain", function () {
    var u = FIX.plainQuery[nextIdx()];
    SINK = (SINK + (new URL(u).searchParams.get("q") || "").length) | 0;
  });
}
if (hasURLSearchParams) {
  add("URLSP.plain", function () {
    var u = FIX.plainQuery[nextIdx()];
    var q = u.split("?")[1];
    SINK = (SINK + (new URLSearchParams(q).get("q") || "").length) | 0;
  });
}

// readQueryParam — percent-encoded
add("rq.encoded", function () {
  var u = FIX.encodedQuery[nextIdx()];
  SINK = (SINK + (readQueryParam(u, "q") || "").length) | 0;
});
if (hasURL) {
  add("URL.encoded", function () {
    var u = FIX.encodedQuery[nextIdx()];
    SINK = (SINK + (new URL(u).searchParams.get("q") || "").length) | 0;
  });
}

// readQueryParam — malformed (tolerant fallback)
add("rq.malformed", function () {
  var u = FIX.malformedQuery[nextIdx()];
  SINK = (SINK + (readQueryParam(u, "bad") || "").length) | 0;
});
// Native URL throws on bad %, so no fair native comparison here.

// readQueryParam — long query, key near end
add("rq.long", function () {
  var u = FIX.longQuery[nextIdx()];
  SINK = (SINK + (readQueryParam(u, "q") || "").length) | 0;
});
if (hasURL) {
  add("URL.long", function () {
    var u = FIX.longQuery[nextIdx()];
    SINK = (SINK + (new URL(u).searchParams.get("q") || "").length) | 0;
  });
}

// readQueryParams (N-key) vs N separate URL lookups
var TWO_KEYS = ["q", "utm_source"];
add("rqs.two", function () {
  var u = FIX.twoKeyQuery[nextIdx()];
  var r = readQueryParams(u, TWO_KEYS);
  SINK = (SINK + ((r[0] || "").length + (r[1] || "").length)) | 0;
});
if (hasURL) {
  add("URL.two", function () {
    var u = FIX.twoKeyQuery[nextIdx()];
    var sp = new URL(u).searchParams;
    SINK = (SINK + ((sp.get("q") || "").length + (sp.get("utm_source") || "").length)) | 0;
  });
}

var FOUR_KEYS = ["q", "t", "utm_source", "utm_campaign"];
add("rqs.four", function () {
  var u = FIX.twoKeyQuery[nextIdx()];
  var r = readQueryParams(u, FOUR_KEYS);
  SINK =
    (SINK +
      ((r[0] || "").length +
        (r[1] || "").length +
        (r[2] || "").length +
        (r[3] || "").length)) |
    0;
});
if (hasURL) {
  add("URL.four", function () {
    var u = FIX.twoKeyQuery[nextIdx()];
    var sp = new URL(u).searchParams;
    SINK =
      (SINK +
        ((sp.get("q") || "").length +
          (sp.get("t") || "").length +
          (sp.get("utm_source") || "").length +
          (sp.get("utm_campaign") || "").length)) |
      0;
  });
}

// readPathname vs new URL(url).pathname
add("rp.full", function () {
  var u = FIX.fullUrl[nextIdx()];
  SINK = (SINK + readPathname(u).length) | 0;
});
if (hasURL) {
  add("URL.pathname", function () {
    var u = FIX.fullUrl[nextIdx()];
    SINK = (SINK + new URL(u).pathname.length) | 0;
  });
}

// readPathname on a pathname-only (request line) input — URL can't do this without a base.
add("rp.pathOnly", function () {
  var u = FIX.pathOnly[nextIdx()];
  SINK = (SINK + readPathname(u).length) | 0;
});
if (hasURL) {
  add("URL.pathOnly", function () {
    var u = FIX.pathOnly[nextIdx()];
    SINK = (SINK + new URL(u, "http://x").pathname.length) | 0;
  });
}

// readOrigin
add("ro.full", function () {
  var u = FIX.fullUrl[nextIdx()];
  SINK = (SINK + readOrigin(u).length) | 0;
});
if (hasURL) {
  add("URL.origin", function () {
    var u = FIX.fullUrl[nextIdx()];
    SINK = (SINK + new URL(u).origin.length) | 0;
  });
}

// readScheme
add("rs.full", function () {
  var u = FIX.hostUrl[nextIdx()];
  SINK = (SINK + readScheme(u).length) | 0;
});
if (hasURL) {
  add("URL.protocol", function () {
    var u = FIX.hostUrl[nextIdx()];
    SINK = (SINK + new URL(u).protocol.length) | 0;
  });
}

// readHost
add("rh.full", function () {
  var u = FIX.hostUrl[nextIdx()];
  SINK = (SINK + readHost(u).length) | 0;
});
if (hasURL) {
  add("URL.host", function () {
    var u = FIX.hostUrl[nextIdx()];
    SINK = (SINK + new URL(u).host.length) | 0;
  });
}

// readHostname
add("rhn.full", function () {
  var u = FIX.hostUrl[nextIdx()];
  SINK = (SINK + readHostname(u).length) | 0;
});
if (hasURL) {
  add("URL.hostname", function () {
    var u = FIX.hostUrl[nextIdx()];
    SINK = (SINK + new URL(u).hostname.length) | 0;
  });
}

// readPort
add("rport.full", function () {
  var u = FIX.hostUrl[nextIdx()];
  var p = readPort(u);
  SINK = (SINK + (p === null ? 0 : p)) | 0;
});
if (hasURL) {
  add("URL.port", function () {
    var u = FIX.hostUrl[nextIdx()];
    var p = new URL(u).port;
    SINK = (SINK + (p.length === 0 ? 0 : Number(p))) | 0;
  });
}

// setQueryParam: replace an existing value
add("sq.replace", function () {
  var u = FIX.plainQuery[nextIdx()];
  SINK = (SINK + setQueryParam(u, "q", "updated").length) | 0;
});
if (hasURL) {
  add("URL.sq.replace", function () {
    var u = FIX.plainQuery[nextIdx()];
    var parsed = new URL(u);
    parsed.searchParams.set("q", "updated");
    SINK = (SINK + parsed.toString().length) | 0;
  });
}

// setQueryParam: append a new param to an existing query
add("sq.append", function () {
  var u = FIX.plainQuery[nextIdx()];
  SINK = (SINK + setQueryParam(u, "added", "1").length) | 0;
});
if (hasURL) {
  add("URL.sq.append", function () {
    var u = FIX.plainQuery[nextIdx()];
    var parsed = new URL(u);
    parsed.searchParams.set("added", "1");
    SINK = (SINK + parsed.toString().length) | 0;
  });
}

// setQueryParam: delete a key
add("sq.delete", function () {
  var u = FIX.plainQuery[nextIdx()];
  SINK = (SINK + setQueryParam(u, "q", null).length) | 0;
});
if (hasURL) {
  add("URL.sq.delete", function () {
    var u = FIX.plainQuery[nextIdx()];
    var parsed = new URL(u);
    parsed.searchParams.delete("q");
    SINK = (SINK + parsed.toString().length) | 0;
  });
}

// setPathname: replace the path
add("sp.replace", function () {
  var u = FIX.fullUrl[nextIdx()];
  SINK = (SINK + setPathname(u, "/v2/items").length) | 0;
});
if (hasURL) {
  add("URL.sp.replace", function () {
    var u = FIX.fullUrl[nextIdx()];
    var parsed = new URL(u);
    parsed.pathname = "/v2/items";
    SINK = (SINK + parsed.toString().length) | 0;
  });
}

// hasQueryParam — zero-allocation predicate vs URLSearchParams.has
add("hq.full", function () {
  var u = FIX.plainQuery[nextIdx()];
  SINK = (SINK + (hasQueryParam(u, "q") ? 1 : 0)) | 0;
});
if (hasURL) {
  add("URL.has", function () {
    var u = FIX.plainQuery[nextIdx()];
    SINK = (SINK + (new URL(u).searchParams.has("q") ? 1 : 0)) | 0;
  });
}

// queryParamEquals ASCII fast path vs URL.searchParams.get === ...
add("qpe.ascii", function () {
  var u = FIX.plainQuery[nextIdx()];
  SINK = (SINK + (queryParamEquals(u, "page", "2") ? 1 : 0)) | 0;
});
if (hasURL) {
  add("URL.qpe.ascii", function () {
    var u = FIX.plainQuery[nextIdx()];
    SINK =
      (SINK +
        (new URL(u).searchParams.get("page") === "2" ? 1 : 0)) |
      0;
  });
}

// pathnameStartsWith vs URL.pathname.startsWith
add("pss.full", function () {
  var u = FIX.fullUrl[nextIdx()];
  SINK = (SINK + (pathnameStartsWith(u, "/api") ? 1 : 0)) | 0;
});
if (hasURL) {
  add("URL.startsWith", function () {
    var u = FIX.fullUrl[nextIdx()];
    SINK =
      (SINK + (new URL(u).pathname.startsWith("/api") ? 1 : 0)) | 0;
  });
}

// originMatches vs new URL().origin === new URL().origin
var ORIGIN_FIX_A = FIX.hostUrl;
var ORIGIN_FIX_B = FIX.fullUrl;
add("om.full", function () {
  var i = nextIdx();
  SINK = (SINK + (originMatches(ORIGIN_FIX_A[i], ORIGIN_FIX_B[i]) ? 1 : 0)) | 0;
});
if (hasURL) {
  add("URL.origin.eq", function () {
    var i = nextIdx();
    SINK =
      (SINK +
        (new URL(ORIGIN_FIX_A[i]).origin === new URL(ORIGIN_FIX_B[i]).origin
          ? 1
          : 0)) |
      0;
  });
}

// readFragment vs URL.hash (native includes the leading '#')
add("rfrag.full", function () {
  var u = FIX.fullUrl[nextIdx()];
  SINK = (SINK + readFragment(u).length) | 0;
});
if (hasURL) {
  add("URL.hash", function () {
    var u = FIX.fullUrl[nextIdx()];
    SINK = (SINK + new URL(u).hash.length) | 0;
  });
}

// setPort vs URL.port = ...; toString()
add("sp.port.set", function () {
  var u = FIX.hostUrl[nextIdx()];
  SINK = (SINK + setPort(u, 9000).length) | 0;
});
if (hasURL) {
  add("URL.port.set", function () {
    var u = FIX.hostUrl[nextIdx()];
    var p = new URL(u);
    p.port = "9000";
    SINK = (SINK + p.toString().length) | 0;
  });
}

// --- run ---------------------------------------------------------------------

var BUDGET = 600; // ms per case
out("engine=" + (typeof process !== "undefined" && process.versions && process.versions.node
  ? "node " + process.versions.node
  : typeof navigator !== "undefined" && navigator.userAgent
  ? navigator.userAgent
  : "unknown"));
out("budget=" + BUDGET + "ms per case");
out("");
out(pad("case", 18) + pad("ops/sec", 14) + "ops");

var results = [];
for (var ci = 0; ci < cases.length; ci++) {
  var r = bench(cases[ci].name, cases[ci].fn, BUDGET);
  results.push(r);
  out(pad(r.name, 18) + pad(fmt(r.perSec) + "/s", 14) + r.ops);
}

// pairwise summary: native / ours
function findPerSec(name) {
  for (var i = 0; i < results.length; i++)
    if (results[i].name === name) return results[i].perSec;
  return null;
}
out("");
out("--- speedup over native (higher = faster than native) ---");
var pairs = [
  ["rq.plain", "URL.plain"],
  ["rq.plain", "URLSP.plain"],
  ["rq.encoded", "URL.encoded"],
  ["rq.long", "URL.long"],
  ["rqs.two", "URL.two"],
  ["rqs.four", "URL.four"],
  ["rp.full", "URL.pathname"],
  ["rp.pathOnly", "URL.pathOnly"],
  ["ro.full", "URL.origin"],
  ["rs.full", "URL.protocol"],
  ["rh.full", "URL.host"],
  ["rhn.full", "URL.hostname"],
  ["rport.full", "URL.port"],
  ["sq.replace", "URL.sq.replace"],
  ["sq.append", "URL.sq.append"],
  ["sq.delete", "URL.sq.delete"],
  ["sp.replace", "URL.sp.replace"],
  ["hq.full", "URL.has"],
  ["qpe.ascii", "URL.qpe.ascii"],
  ["pss.full", "URL.startsWith"],
  ["om.full", "URL.origin.eq"],
  ["rfrag.full", "URL.hash"],
  ["sp.port.set", "URL.port.set"],
];
for (var pi = 0; pi < pairs.length; pi++) {
  var ours = findPerSec(pairs[pi][0]);
  var theirs = findPerSec(pairs[pi][1]);
  if (ours !== null && theirs !== null) {
    out(
      pad(pairs[pi][0] + " vs " + pairs[pi][1], 32) +
        (ours / theirs).toFixed(2) +
        "x"
    );
  }
}

out("\nSINK=" + SINK + " (prevents DCE)");
