import { describe, expect, test } from "bun:test";
import { readQueryParam } from "../src/query.js";
import {
  hasScheme,
  originMatches,
  pathnameEndsWith,
  pathnameStartsWith,
  readFragment,
  readHost,
  readHostname,
  readOrigin,
  readPathname,
  readPort,
  readScheme,
  setPathname,
  setPort,
  setScheme,
  stripFragment,
} from "../src/url.js";

describe("readPathname", () => {
  test("parses pathname from an absolute URL with query and hash", () => {
    expect(
      readPathname("https://example.com/suggest?q=cats&sp=none#frag")
    ).toBe("/suggest");
  });

  test("returns / for an origin-only absolute URL", () => {
    expect(readPathname("https://example.com")).toBe("/");
    expect(readPathname("https://example.com?q=1")).toBe("/");
  });

  test("parses pathname from a path-only URL", () => {
    expect(readPathname("/bench?x=1")).toBe("/bench");
    expect(readPathname("/")).toBe("/");
  });

  test("treats a URL without scheme and without leading slash as a relative path", () => {
    expect(readPathname("suggest?q=cats")).toBe("suggest");
    expect(readPathname("foo/bar?x=1#frag")).toBe("foo/bar");
    expect(readPathname("foo/bar")).toBe("foo/bar");
  });

  test("treats an empty pathname as /", () => {
    expect(readPathname("https://example.com#top")).toBe("/");
    expect(readPathname("?q=1")).toBe("/");
    expect(readPathname("")).toBe("/");
  });

  test("preserves multi-segment paths", () => {
    expect(readPathname("https://example.com/api/v1/users/42")).toBe(
      "/api/v1/users/42"
    );
  });

  test("strips query and fragment from the pathname", () => {
    expect(readPathname("https://example.com/p?q=1#x")).toBe("/p");
    expect(readPathname("https://example.com/p#x?notquery")).toBe("/p");
  });
});

describe("readOrigin", () => {
  test("returns origin for absolute URLs with and without paths", () => {
    expect(readOrigin("https://example.com/suggest?q=1")).toBe(
      "https://example.com"
    );
    expect(readOrigin("https://example.com")).toBe("https://example.com");
    expect(readOrigin("http://localhost:3000/path")).toBe(
      "http://localhost:3000"
    );
  });

  test("returns empty string for path-only URLs", () => {
    expect(readOrigin("/suggest?q=1")).toBe("");
    expect(readOrigin("suggest?q=1")).toBe("");
    expect(readOrigin("")).toBe("");
  });

  test("preserves a non-standard scheme", () => {
    expect(readOrigin("ws://example.com:8080/socket")).toBe(
      "ws://example.com:8080"
    );
  });

  test("strips userinfo from the origin", () => {
    expect(readOrigin("https://user:pass@example.com/path")).toBe(
      "https://example.com"
    );
    expect(readOrigin("https://user@example.com:8080/")).toBe(
      "https://example.com:8080"
    );
  });

  test("uses the last literal @ in the authority as the userinfo terminator", () => {
    // Per WHATWG: literal '@' in userinfo must be percent-encoded, so multiple
    // literal '@'s are pathological. We pick the last as the separator.
    expect(readOrigin("https://a@b@example.com/path")).toBe(
      "https://example.com"
    );
  });

  test("handles IPv6 bracketed hosts", () => {
    expect(readOrigin("http://[::1]:8080/path")).toBe("http://[::1]:8080");
    expect(readOrigin("http://[2001:db8::1]/path")).toBe(
      "http://[2001:db8::1]"
    );
    expect(readOrigin("http://[::1]")).toBe("http://[::1]");
  });

  test("strips userinfo from IPv6 URLs", () => {
    expect(readOrigin("http://user:pass@[::1]:8080/")).toBe(
      "http://[::1]:8080"
    );
  });

  test("does not confuse a path-segment @ with userinfo", () => {
    expect(readOrigin("https://example.com/user@no-userinfo")).toBe(
      "https://example.com"
    );
  });
});

describe("readScheme", () => {
  test("returns the scheme without the trailing colon", () => {
    expect(readScheme("https://example.com/")).toBe("https");
    expect(readScheme("http://localhost:3000/")).toBe("http");
    expect(readScheme("ws://example.com")).toBe("ws");
    expect(readScheme("file:///etc/hosts")).toBe("file");
  });

  test("returns empty string when there is no scheme", () => {
    expect(readScheme("/path?q=1")).toBe("");
    expect(readScheme("example.com/path")).toBe("");
    expect(readScheme("")).toBe("");
  });

  test("preserves the scheme's case", () => {
    expect(readScheme("HTTPS://example.com/")).toBe("HTTPS");
  });
});

describe("readHost", () => {
  test("returns hostname:port for URLs with explicit ports", () => {
    expect(readHost("https://example.com:8080/path")).toBe("example.com:8080");
    expect(readHost("http://localhost:3000")).toBe("localhost:3000");
  });

  test("returns just the hostname when no port is present", () => {
    expect(readHost("https://example.com/path?q=1#frag")).toBe("example.com");
    expect(readHost("https://example.com")).toBe("example.com");
  });

  test("keeps IPv6 brackets and includes the port", () => {
    expect(readHost("http://[::1]:8080/")).toBe("[::1]:8080");
    expect(readHost("http://[2001:db8::1]/")).toBe("[2001:db8::1]");
  });

  test("strips userinfo", () => {
    expect(readHost("https://user:pass@example.com:8080/")).toBe(
      "example.com:8080"
    );
    expect(readHost("http://user@[::1]:80/")).toBe("[::1]:80");
  });

  test("returns empty string when there is no scheme", () => {
    expect(readHost("/path")).toBe("");
    expect(readHost("example.com/path")).toBe("");
  });
});

describe("readHostname", () => {
  test("returns the bare hostname for IPv4/DNS hosts", () => {
    expect(readHostname("https://example.com:8080/path")).toBe("example.com");
    expect(readHostname("http://127.0.0.1:3000")).toBe("127.0.0.1");
    expect(readHostname("https://example.com")).toBe("example.com");
  });

  test("strips brackets from IPv6 hosts", () => {
    expect(readHostname("http://[::1]:8080/")).toBe("::1");
    expect(readHostname("http://[2001:db8::1]/")).toBe("2001:db8::1");
    expect(readHostname("http://[::1]")).toBe("::1");
  });

  test("strips userinfo", () => {
    expect(readHostname("https://user:pass@example.com/")).toBe("example.com");
    expect(readHostname("http://user@[::1]:80/")).toBe("::1");
  });

  test("returns empty string when there is no scheme", () => {
    expect(readHostname("/path")).toBe("");
    expect(readHostname("example.com")).toBe("");
  });
});

describe("readPort", () => {
  test("returns the explicit port as a number", () => {
    expect(readPort("https://example.com:8080/path")).toBe(8080);
    expect(readPort("http://localhost:3000")).toBe(3000);
    expect(readPort("http://example.com:80")).toBe(80);
  });

  test("returns null when no explicit port is present", () => {
    expect(readPort("https://example.com/path")).toBeNull();
    expect(readPort("https://example.com")).toBeNull();
  });

  test("handles IPv6 ports", () => {
    expect(readPort("http://[::1]:8080/")).toBe(8080);
    expect(readPort("http://[::1]/")).toBeNull();
  });

  test("ignores userinfo when extracting the port", () => {
    expect(readPort("https://user:pass@example.com:8080/")).toBe(8080);
    expect(readPort("https://user:1234@example.com/")).toBeNull();
  });

  test("returns null when there is no scheme", () => {
    expect(readPort("/path")).toBeNull();
    expect(readPort("example.com:8080")).toBeNull();
  });

  test("returns null for malformed ports", () => {
    expect(readPort("http://example.com:abc/")).toBeNull();
    expect(readPort("http://example.com:/path")).toBeNull();
    expect(readPort("http://example.com:80x/")).toBeNull();
  });

  test("returns null for an empty port", () => {
    expect(readPort("http://example.com:")).toBeNull();
  });
});

describe("setPathname", () => {
  test("replaces the pathname of an absolute URL", () => {
    expect(setPathname("https://example.com/old?q=1", "/new")).toBe(
      "https://example.com/new?q=1"
    );
  });

  test("preserves the fragment", () => {
    expect(setPathname("https://example.com/old#frag", "/new")).toBe(
      "https://example.com/new#frag"
    );
  });

  test("preserves query and fragment together", () => {
    expect(setPathname("https://example.com/old?q=1#frag", "/new")).toBe(
      "https://example.com/new?q=1#frag"
    );
  });

  test("adds a pathname to an origin-only URL", () => {
    expect(setPathname("https://example.com", "/api")).toBe(
      "https://example.com/api"
    );
    expect(setPathname("https://example.com?q=1", "/api")).toBe(
      "https://example.com/api?q=1"
    );
  });

  test("normalizes the leading slash", () => {
    expect(setPathname("https://example.com/old", "new")).toBe(
      "https://example.com/new"
    );
    expect(setPathname("https://example.com/old", "")).toBe(
      "https://example.com/"
    );
  });

  test("works on path-only URLs", () => {
    expect(setPathname("/old?q=1", "/new")).toBe("/new?q=1");
    expect(setPathname("old?q=1", "new")).toBe("/new?q=1");
  });

  test("preserves userinfo and IPv6 brackets when present", () => {
    expect(setPathname("https://user@[::1]:8080/old", "/new")).toBe(
      "https://user@[::1]:8080/new"
    );
  });
});

describe("hasScheme", () => {
  test("matches the exact scheme", () => {
    expect(hasScheme("https://example.com/", "https")).toBe(true);
    expect(hasScheme("http://localhost/", "http")).toBe(true);
    expect(hasScheme("ws://x.test/", "ws")).toBe(true);
  });

  test("returns false for a non-matching scheme", () => {
    expect(hasScheme("https://example.com/", "http")).toBe(false);
    expect(hasScheme("http://example.com/", "https")).toBe(false);
  });

  test("returns false when the URL has no scheme", () => {
    expect(hasScheme("/path", "https")).toBe(false);
    expect(hasScheme("example.com", "https")).toBe(false);
  });

  test("does not match a scheme that is a prefix of another", () => {
    expect(hasScheme("https://x.test/", "http")).toBe(false);
  });

  test("is case-insensitive (matches WHATWG scheme normalization)", () => {
    expect(hasScheme("HTTPS://x.test/", "https")).toBe(true);
    expect(hasScheme("https://x.test/", "HTTPS")).toBe(true);
    expect(hasScheme("HttP://x.test/", "http")).toBe(true);
    expect(hasScheme("FILE://x/", "file")).toBe(true);
  });

  test("rejects schemes that differ on more than case", () => {
    expect(hasScheme("https://x.test/", "ftps")).toBe(false);
    expect(hasScheme("https-x://x.test/", "https")).toBe(false);
  });
});

describe("pathnameStartsWith", () => {
  test("matches a prefix of the pathname", () => {
    expect(pathnameStartsWith("https://x.test/api/v1/users", "/api")).toBe(
      true
    );
    expect(pathnameStartsWith("https://x.test/api/v1/users", "/api/v1")).toBe(
      true
    );
    expect(pathnameStartsWith("https://x.test/api/v1/users", "/api/v2")).toBe(
      false
    );
  });

  test("matches the exact pathname", () => {
    expect(pathnameStartsWith("https://x.test/api", "/api")).toBe(true);
  });

  test("treats an origin-only URL as path '/'", () => {
    expect(pathnameStartsWith("https://x.test", "/")).toBe(true);
    expect(pathnameStartsWith("https://x.test", "")).toBe(true);
    expect(pathnameStartsWith("https://x.test", "/api")).toBe(false);
  });

  test("ignores query and fragment", () => {
    expect(pathnameStartsWith("https://x.test/api?q=1#frag", "/api")).toBe(
      true
    );
  });

  test("works on path-only URLs", () => {
    expect(pathnameStartsWith("/api/v1", "/api")).toBe(true);
    expect(pathnameStartsWith("api/v1", "api")).toBe(true);
  });

  test("returns false when prefix is longer than path", () => {
    expect(pathnameStartsWith("https://x.test/a", "/abc")).toBe(false);
  });
});

describe("pathnameEndsWith", () => {
  test("matches a suffix of the pathname", () => {
    expect(pathnameEndsWith("https://x.test/index.html", ".html")).toBe(true);
    expect(pathnameEndsWith("https://x.test/api/v1.json", ".json")).toBe(true);
    expect(pathnameEndsWith("https://x.test/index.html", ".css")).toBe(false);
  });

  test("matches the exact pathname", () => {
    expect(pathnameEndsWith("https://x.test/api", "/api")).toBe(true);
  });

  test("ignores query and fragment when finding the suffix", () => {
    expect(pathnameEndsWith("https://x.test/page.html?q=1#frag", ".html")).toBe(
      true
    );
  });

  test("treats an origin-only URL as path '/'", () => {
    expect(pathnameEndsWith("https://x.test", "/")).toBe(true);
    expect(pathnameEndsWith("https://x.test", "")).toBe(true);
  });

  test("returns false when suffix is longer than path", () => {
    expect(pathnameEndsWith("https://x.test/a", "/abc")).toBe(false);
  });
});

describe("originMatches", () => {
  test("returns true for identical origins", () => {
    expect(originMatches("https://x.test/a", "https://x.test/b")).toBe(true);
    expect(
      originMatches("https://x.test:8080/a", "https://x.test:8080/b")
    ).toBe(true);
  });

  test("returns false for different schemes", () => {
    expect(originMatches("https://x.test/", "http://x.test/")).toBe(false);
  });

  test("returns false for different hostnames", () => {
    expect(originMatches("https://a.test/", "https://b.test/")).toBe(false);
  });

  test("infers implicit ports for special schemes", () => {
    // https default port is 443.
    expect(originMatches("https://x.test:443/", "https://x.test/")).toBe(true);
    // http default port is 80.
    expect(originMatches("http://x.test:80/", "http://x.test/")).toBe(true);
    // ws/wss/ftp also recognized.
    expect(originMatches("ws://x.test:80/", "ws://x.test/")).toBe(true);
    expect(originMatches("wss://x.test:443/", "wss://x.test/")).toBe(true);
    expect(originMatches("ftp://x.test:21/", "ftp://x.test/")).toBe(true);
  });

  test("returns false for genuinely different ports", () => {
    expect(originMatches("https://x.test:8080/", "https://x.test/")).toBe(
      false
    );
    expect(originMatches("https://x.test:80/", "https://x.test/")).toBe(false);
  });

  test("does not infer implicit ports for non-special schemes", () => {
    expect(originMatches("custom://x.test:9/", "custom://x.test/")).toBe(false);
    expect(originMatches("custom://x.test:9/", "custom://x.test:9/")).toBe(
      true
    );
    expect(originMatches("custom://x.test/", "custom://x.test/")).toBe(true);
  });

  test("scheme comparison is case-insensitive", () => {
    expect(originMatches("HTTPS://x.test/", "https://x.test/")).toBe(true);
    expect(originMatches("HttP://x.test/", "http://x.test/")).toBe(true);
  });

  test("hostname comparison is case-insensitive", () => {
    expect(originMatches("https://EXAMPLE.com/", "https://example.com/")).toBe(
      true
    );
    expect(originMatches("https://Example.COM/", "https://example.com/")).toBe(
      true
    );
  });

  test("IPv6 host case-insensitive comparison", () => {
    expect(
      originMatches("http://[2001:DB8::1]/", "http://[2001:db8::1]/")
    ).toBe(true);
  });

  test("strips userinfo from both sides", () => {
    expect(originMatches("https://u:p@x.test/a", "https://x.test/b")).toBe(
      true
    );
    expect(originMatches("https://u1@x.test/a", "https://u2@x.test/b")).toBe(
      true
    );
  });

  test("handles IPv6 hosts", () => {
    expect(originMatches("http://[::1]:8080/a", "http://[::1]:8080/b")).toBe(
      true
    );
    expect(originMatches("http://[::1]/a", "http://[::1]/b")).toBe(true);
    expect(originMatches("http://[::1]:8080/a", "http://[::1]/b")).toBe(false);
  });

  test("returns false when either URL has no scheme", () => {
    expect(originMatches("/path", "https://x.test/")).toBe(false);
    expect(originMatches("https://x.test/", "")).toBe(false);
  });
});

describe("readFragment", () => {
  test("returns the part after #", () => {
    expect(readFragment("https://x.test/p#section")).toBe("section");
    expect(readFragment("https://x.test/p?q=1#frag")).toBe("frag");
  });

  test("returns empty string when no fragment is present", () => {
    expect(readFragment("https://x.test/p")).toBe("");
    expect(readFragment("/p?q=1")).toBe("");
  });

  test("returns empty string for an empty fragment", () => {
    expect(readFragment("https://x.test/p#")).toBe("");
  });

  test("preserves the fragment verbatim (does not decode)", () => {
    expect(readFragment("https://x.test/p#hello%20world")).toBe(
      "hello%20world"
    );
  });
});

describe("stripFragment", () => {
  test("removes the fragment", () => {
    expect(stripFragment("https://x.test/p?q=1#frag")).toBe(
      "https://x.test/p?q=1"
    );
    expect(stripFragment("https://x.test/p#frag")).toBe("https://x.test/p");
  });

  test("returns input unchanged when there is no fragment", () => {
    const u = "https://x.test/p?q=1";
    expect(stripFragment(u)).toBe(u);
  });

  test("strips an empty fragment", () => {
    expect(stripFragment("https://x.test/p#")).toBe("https://x.test/p");
  });
});

describe("setScheme", () => {
  test("replaces the scheme", () => {
    expect(setScheme("https://x.test/path", "http")).toBe("http://x.test/path");
    expect(setScheme("http://x.test/", "ws")).toBe("ws://x.test/");
  });

  test("returns input unchanged when there is no scheme", () => {
    expect(setScheme("/path", "https")).toBe("/path");
    expect(setScheme("relative/path", "https")).toBe("relative/path");
  });

  test("preserves userinfo, port, path, query, and fragment", () => {
    expect(setScheme("https://u:p@x.test:8080/api?q=1#frag", "http")).toBe(
      "http://u:p@x.test:8080/api?q=1#frag"
    );
  });

  test("round-trips with readScheme", () => {
    const u = setScheme("https://x.test/", "ws");
    expect(readScheme(u)).toBe("ws");
  });
});

describe("setPort", () => {
  test("inserts a port on a URL that has none", () => {
    expect(setPort("https://x.test/path", 8080)).toBe(
      "https://x.test:8080/path"
    );
    expect(setPort("https://x.test", 8080)).toBe("https://x.test:8080");
  });

  test("replaces an existing port", () => {
    expect(setPort("https://x.test:80/path", 8080)).toBe(
      "https://x.test:8080/path"
    );
  });

  test("removes the port when value is null", () => {
    expect(setPort("https://x.test:8080/path", null)).toBe(
      "https://x.test/path"
    );
    expect(setPort("https://x.test:80?q=1", null)).toBe("https://x.test?q=1");
  });

  test("returns input unchanged when removing a missing port", () => {
    const u = "https://x.test/path";
    expect(setPort(u, null)).toBe(u);
  });

  test("preserves IPv6 brackets when modifying the port", () => {
    expect(setPort("http://[::1]:8080/path", 9000)).toBe(
      "http://[::1]:9000/path"
    );
    expect(setPort("http://[::1]/path", 9000)).toBe("http://[::1]:9000/path");
    expect(setPort("http://[::1]:8080/path", null)).toBe("http://[::1]/path");
  });

  test("preserves userinfo when modifying the port", () => {
    expect(setPort("https://u:p@x.test/api", 8443)).toBe(
      "https://u:p@x.test:8443/api"
    );
  });

  test("returns input unchanged when URL has no scheme", () => {
    expect(setPort("/path", 8080)).toBe("/path");
  });

  test("round-trips with readPort", () => {
    expect(readPort(setPort("https://x.test/", 9090))).toBe(9090);
    expect(readPort(setPort("https://x.test:80/", null))).toBeNull();
  });

  test("throws RangeError for invalid ports", () => {
    expect(() => setPort("https://x.test/", -1)).toThrow(RangeError);
    expect(() => setPort("https://x.test/", 65536)).toThrow(RangeError);
    expect(() => setPort("https://x.test/", 1.5)).toThrow(RangeError);
    expect(() => setPort("https://x.test/", NaN)).toThrow(RangeError);
    expect(() => setPort("https://x.test/", Infinity)).toThrow(RangeError);
  });

  test("accepts 0 and 65535", () => {
    expect(setPort("https://x.test/", 0)).toBe("https://x.test:0/");
    expect(setPort("https://x.test/", 65535)).toBe("https://x.test:65535/");
  });
});

describe("scheme detection: embedded :// is not a scheme", () => {
  // Regression: a schemeless/relative input whose query (or path/fragment)
  // carries a URL must not have that embedded "://" read as its own scheme.
  const u = "/callback?redirect_uri=https://app.example.com/cb&state=x";

  test("relative input with :// in the query is schemeless", () => {
    expect(readScheme(u)).toBe("");
    expect(readPathname(u)).toBe("/callback");
    expect(readOrigin(u)).toBe("");
    expect(readHost(u)).toBe("");
    expect(readHostname(u)).toBe("");
    expect(readPort(u)).toBeNull();
  });

  test("query parsing on that input stays correct", () => {
    expect(readQueryParam(u, "state")).toBe("x");
    expect(readQueryParam(u, "redirect_uri")).toBe(
      "https://app.example.com/cb"
    );
  });

  test(":// inside a fragment is not a scheme", () => {
    expect(readScheme("/p#x=a://b")).toBe("");
    expect(readPathname("/p#x=a://b")).toBe("/p");
  });

  test(":// inside a relative path is not a scheme", () => {
    expect(readScheme("/a/b://c")).toBe("");
    expect(readPathname("/a/b://c")).toBe("/a/b://c");
  });

  test("leading :// has an empty scheme and is rejected", () => {
    expect(readScheme("://x")).toBe("");
  });

  test("a space before :// is not a valid scheme", () => {
    expect(readScheme("ht tp://x")).toBe("");
  });

  test("hasScheme is false for a relative input with :// in the query", () => {
    expect(hasScheme("/cb?u=https://x", "https")).toBe(false);
  });

  test("a real scheme is still parsed when :// also appears in the query", () => {
    const f = "https://a/p?u=x://y";
    expect(readScheme(f)).toBe("https");
    expect(readOrigin(f)).toBe("https://a");
    expect(readPathname(f)).toBe("/p");
    expect(hasScheme(f, "https")).toBe(true);
  });

  test("schemes with digits, +, -, . are accepted", () => {
    expect(readScheme("a+b-c.d1://host/p")).toBe("a+b-c.d1");
    expect(hasScheme("git+ssh://host/p", "git+ssh")).toBe(true);
  });
});
