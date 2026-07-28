import { describe, expect, test } from "bun:test";
import { UrlView, view } from "../src/view.js";

describe("view()", () => {
  test("returns an UrlView instance", () => {
    expect(view("https://example.com")).toBeInstanceOf(UrlView);
  });

  test("toString() returns the original input verbatim", () => {
    const url = "https://user:pass@example.com:8080/a?q=1#frag";
    expect(view(url).toString()).toBe(url);
  });
});

describe("UrlView.scheme()", () => {
  test("returns the scheme without the trailing ':'", () => {
    expect(view("https://example.com").scheme()).toBe("https");
  });

  test("returns '' for schemeless inputs", () => {
    expect(view("/api/v1").scheme()).toBe("");
    expect(view("").scheme()).toBe("");
  });

  test("preserves scheme case", () => {
    expect(view("HTTPS://example.com").scheme()).toBe("HTTPS");
  });
});

describe("UrlView.origin()", () => {
  test("returns scheme://host[:port]", () => {
    expect(view("https://example.com:8080/path?q=1").origin()).toBe(
      "https://example.com:8080"
    );
  });

  test("strips userinfo", () => {
    expect(view("https://user:pass@example.com:8080/api").origin()).toBe(
      "https://example.com:8080"
    );
  });

  test("returns '' for schemeless inputs", () => {
    expect(view("/path").origin()).toBe("");
  });

  test("preserves IPv6 brackets", () => {
    expect(view("https://[::1]:8080/p").origin()).toBe("https://[::1]:8080");
  });

  test("works for origin-only URLs (no path)", () => {
    expect(view("https://example.com").origin()).toBe("https://example.com");
  });
});

describe("UrlView.host()", () => {
  test("returns hostname:port in canonical form", () => {
    expect(view("https://example.com:8080/p").host()).toBe("example.com:8080");
  });

  test("returns just hostname when no port present", () => {
    expect(view("https://example.com/p").host()).toBe("example.com");
  });

  test("strips userinfo", () => {
    expect(view("https://u@example.com/p").host()).toBe("example.com");
  });

  test("preserves IPv6 brackets", () => {
    expect(view("https://[::1]:8080/p").host()).toBe("[::1]:8080");
  });

  test("returns '' for schemeless inputs", () => {
    expect(view("/path").host()).toBe("");
  });
});

describe("UrlView.hostname()", () => {
  test("returns the bare hostname", () => {
    expect(view("https://example.com:8080/p").hostname()).toBe("example.com");
  });

  test("strips IPv6 brackets", () => {
    expect(view("http://[::1]:8080/").hostname()).toBe("::1");
    expect(view("https://[2001:db8::1]/").hostname()).toBe("2001:db8::1");
  });

  test("strips userinfo", () => {
    expect(view("https://user:pass@example.com:8080/").hostname()).toBe(
      "example.com"
    );
  });

  test("returns '' for schemeless inputs", () => {
    expect(view("/api").hostname()).toBe("");
  });
});

describe("UrlView.port()", () => {
  test("returns the port as a number", () => {
    expect(view("https://example.com:8080/p").port()).toBe(8080);
  });

  test("returns null when no port is present", () => {
    expect(view("https://example.com/p").port()).toBeNull();
  });

  test("returns null for schemeless inputs", () => {
    expect(view("/path").port()).toBeNull();
  });

  test("returns null for malformed (non-digit) ports", () => {
    expect(view("https://example.com:abc/p").port()).toBeNull();
  });

  test("handles IPv6 ports", () => {
    expect(view("http://[::1]:8080/").port()).toBe(8080);
  });

  test("returns null for IPv6 host with no port", () => {
    expect(view("http://[::1]/").port()).toBeNull();
  });
});

describe("UrlView.pathname()", () => {
  test("returns the path without query or fragment", () => {
    expect(view("https://x/api/v1?q=1#frag").pathname()).toBe("/api/v1");
  });

  test("returns '/' for URLs with no path", () => {
    expect(view("https://example.com").pathname()).toBe("/");
    expect(view("https://example.com?q=1").pathname()).toBe("/");
  });

  test("returns the literal substring for schemeless inputs", () => {
    expect(view("/api/v1/users").pathname()).toBe("/api/v1/users");
  });

  test("preserves the path when only a fragment follows", () => {
    expect(view("https://x/path#frag").pathname()).toBe("/path");
  });

  test("returns '/' for empty pathnames", () => {
    expect(view("https://example.com/").pathname()).toBe("/");
  });
});

describe("UrlView.query()", () => {
  test("returns the raw query without the leading '?'", () => {
    expect(view("https://x/p?a=1&b=2#frag").query()).toBe("a=1&b=2");
  });

  test("returns '' when no query is present", () => {
    expect(view("https://x/p").query()).toBe("");
    expect(view("https://x/p#frag").query()).toBe("");
  });

  test("returns '' when '?' is inside the fragment", () => {
    expect(view("https://x/p#frag?notquery").query()).toBe("");
  });
});

describe("UrlView.fragment()", () => {
  test("returns the fragment without the leading '#'", () => {
    expect(view("https://x/p#section-2").fragment()).toBe("section-2");
  });

  test("returns '' when no fragment is present", () => {
    expect(view("https://x/p?q=1").fragment()).toBe("");
  });

  test("includes content after '?' when '?' is in the fragment", () => {
    expect(view("https://x/p#frag?notquery").fragment()).toBe("frag?notquery");
  });
});

describe("UrlView.queryParam()", () => {
  test("returns the decoded value", () => {
    expect(view("https://x/?q=hello+world").queryParam("q")).toBe(
      "hello world"
    );
  });

  test("decodes percent-encoded UTF-8", () => {
    expect(view("https://x/?q=caf%C3%A9").queryParam("q")).toBe("café");
  });

  test("returns null for missing keys", () => {
    expect(view("https://x/?a=1").queryParam("missing")).toBeNull();
  });

  test("returns null when no query is present", () => {
    expect(view("https://x/p").queryParam("q")).toBeNull();
  });

  test("returns '' for key-only params", () => {
    expect(view("https://x/?k").queryParam("k")).toBe("");
    expect(view("https://x/?k=").queryParam("k")).toBe("");
  });
});

describe("UrlView.queryParams()", () => {
  test("returns an object keyed by the input keys", () => {
    const v = view("https://x/r?q=hi&utm_source=ig");
    const out = v.queryParams(["q", "utm_source"] as const);
    expect(out.q).toBe("hi");
    expect(out.utm_source).toBe("ig");
  });

  test("matches an empty parameter name", () => {
    const out = view("https://x/?=value&a=1").queryParams(["", "a"] as const);
    expect(out[""]).toBe("value");
    expect(out.a).toBe("1");
  });

  test("returns null for missing keys", () => {
    const v = view("https://x/r?q=hi");
    const out = v.queryParams(["q", "missing"] as const);
    expect(out.q).toBe("hi");
    expect(out.missing).toBeNull();
  });

  test("returns all nulls when no query is present", () => {
    const v = view("https://x/p");
    const out = v.queryParams(["a", "b"] as const);
    expect(out.a).toBeNull();
    expect(out.b).toBeNull();
  });

  test("returns an empty object when keys is empty", () => {
    const v = view("https://x/?q=1");
    const out = v.queryParams([] as const);
    expect(Object.keys(out)).toHaveLength(0);
  });

  test("decodes UTF-8 values", () => {
    const v = view("https://x/?q=caf%C3%A9&t=na%C3%AFve");
    const out = v.queryParams(["q", "t"] as const);
    expect(out.q).toBe("café");
    expect(out.t).toBe("naïve");
  });

  test("stops scanning once every key has been found", () => {
    // Behavior assertion: this is the same single-pass guarantee as
    // readQueryParams. We can't observe early-exit directly, but we can
    // check the value comes back correctly even when the matching key is at
    // the start of a long query.
    const url = `https://x/?q=found&${"x=1&".repeat(50)}z=last`;
    expect(view(url).queryParams(["q"] as const).q).toBe("found");
  });
});

describe("UrlView.hasQueryParam()", () => {
  test("returns true when the key is present", () => {
    expect(view("https://x/?a=1").hasQueryParam("a")).toBe(true);
  });

  test("returns false when the key is absent", () => {
    expect(view("https://x/?a=1").hasQueryParam("b")).toBe(false);
  });

  test("returns false when no query is present", () => {
    expect(view("https://x/p").hasQueryParam("a")).toBe(false);
  });

  test("returns true for key-only params", () => {
    expect(view("https://x/?k").hasQueryParam("k")).toBe(true);
  });
});

describe("UrlView.queryParamEquals()", () => {
  test("returns true for matching plain ASCII values", () => {
    expect(view("https://x/?q=hello").queryParamEquals("q", "hello")).toBe(
      true
    );
  });

  test("returns true after decoding '+' as space", () => {
    expect(
      view("https://x/?q=hello+world").queryParamEquals("q", "hello world")
    ).toBe(true);
  });

  test("returns true after decoding percent-encoded UTF-8", () => {
    expect(view("https://x/?q=caf%C3%A9").queryParamEquals("q", "café")).toBe(
      true
    );
  });

  test("returns false on mismatch", () => {
    expect(view("https://x/?q=hello").queryParamEquals("q", "world")).toBe(
      false
    );
  });

  test("returns false for missing keys", () => {
    expect(view("https://x/?a=1").queryParamEquals("missing", "v")).toBe(false);
  });

  test("returns false when no query is present", () => {
    expect(view("https://x/p").queryParamEquals("a", "1")).toBe(false);
  });
});

describe("UrlView.pathnameStartsWith()", () => {
  test("returns true for matching prefixes", () => {
    expect(view("https://x/api/v1/users").pathnameStartsWith("/api")).toBe(
      true
    );
  });

  test("returns false for non-matching prefixes", () => {
    expect(view("https://x/api/v1").pathnameStartsWith("/other")).toBe(false);
  });

  test("treats absent path as '/'", () => {
    expect(view("https://example.com").pathnameStartsWith("/")).toBe(true);
    expect(view("https://example.com").pathnameStartsWith("")).toBe(true);
  });

  test("works for schemeless inputs", () => {
    expect(view("/api/v1").pathnameStartsWith("/api")).toBe(true);
  });
});

describe("UrlView.pathnameEndsWith()", () => {
  test("returns true for matching suffixes", () => {
    expect(view("https://x/page.html").pathnameEndsWith(".html")).toBe(true);
  });

  test("returns false for non-matching suffixes", () => {
    expect(view("https://x/page.html").pathnameEndsWith(".css")).toBe(false);
  });

  test("ignores query and fragment", () => {
    expect(view("https://x/page.html?q=1#frag").pathnameEndsWith(".html")).toBe(
      true
    );
  });
});

describe("UrlView consistency with flat functions", () => {
  // Lock in that view().method() returns the same value as the corresponding
  // flat function for a representative URL.
  const URL = "https://user:pass@example.com:8080/api/v1?q=hello+world#frag";

  test("scheme matches readScheme", () => {
    const { readScheme } = require("../src/url.js");
    expect(view(URL).scheme()).toBe(readScheme(URL));
  });

  test("origin matches readOrigin", () => {
    const { readOrigin } = require("../src/url.js");
    expect(view(URL).origin()).toBe(readOrigin(URL));
  });

  test("host matches readHost", () => {
    const { readHost } = require("../src/url.js");
    expect(view(URL).host()).toBe(readHost(URL));
  });

  test("hostname matches readHostname", () => {
    const { readHostname } = require("../src/url.js");
    expect(view(URL).hostname()).toBe(readHostname(URL));
  });

  test("port matches readPort", () => {
    const { readPort } = require("../src/url.js");
    expect(view(URL).port()).toBe(readPort(URL));
  });

  test("pathname matches readPathname", () => {
    const { readPathname } = require("../src/url.js");
    expect(view(URL).pathname()).toBe(readPathname(URL));
  });

  test("query matches readQuery", () => {
    const { readQuery } = require("../src/query.js");
    expect(view(URL).query()).toBe(readQuery(URL));
  });

  test("fragment matches readFragment", () => {
    const { readFragment } = require("../src/url.js");
    expect(view(URL).fragment()).toBe(readFragment(URL));
  });

  test("queryParam matches readQueryParam", () => {
    const { readQueryParam } = require("../src/query.js");
    expect(view(URL).queryParam("q")).toBe(readQueryParam(URL, "q"));
  });
});

describe("UrlView WHATWG-decoded key matching", () => {
  // Lock in that view query methods match URLSearchParams semantics — same
  // contract as the flat query.ts functions.

  test("queryParam matches percent-encoded URL key against plain user key", () => {
    expect(view("https://x.test/?weird%20key=v").queryParam("weird key")).toBe(
      "v"
    );
  });

  test("queryParam matches '+' URL key against space user key", () => {
    expect(view("https://x.test/?a+b=value").queryParam("a b")).toBe("value");
  });

  test("queryParam matches UTF-8 encoded URL key", () => {
    expect(view("https://x.test/?caf%C3%A9=hi").queryParam("café")).toBe("hi");
  });

  test("queryParam rejects ambiguous-user-key false positives", () => {
    // URL key is literal "a%20b", user key is "a%20b" — WHATWG sees URL as "a b"
    // so it should NOT match the literal "a%20b" user key.
    expect(view("https://x.test/?a%20b=v").queryParam("a%20b")).toBeNull();
  });

  test("queryParam matches when URL is double-encoded to user's encoded key", () => {
    // URL key "a%2520b" decodes to "a%20b". User key "a%20b" matches.
    expect(view("https://x.test/?a%2520b=v").queryParam("a%20b")).toBe("v");
  });

  test("hasQueryParam matches '+' URL key against space user key", () => {
    expect(view("https://x.test/?a+b=value").hasQueryParam("a b")).toBe(true);
  });

  test("hasQueryParam matches percent-encoded URL key", () => {
    expect(view("https://x.test/?caf%C3%A9=hi").hasQueryParam("café")).toBe(
      true
    );
  });

  test("queryParamEquals matches encoded key + decoded value", () => {
    expect(
      view("https://x.test/?caf%C3%A9=hello+world").queryParamEquals(
        "café",
        "hello world"
      )
    ).toBe(true);
  });

  test("queryParams returns object with decoded keys present", () => {
    // The user's input keys form the OBJECT keys regardless of URL encoding.
    const v = view("https://x.test/?caf%C3%A9=hi&a+b=value");
    const out = v.queryParams(["café", "a b"] as const);
    expect(out.café).toBe("hi");
    expect(out["a b"]).toBe("value");
  });

  test("queryParam matches flat readQueryParam on ambiguous-key inputs", () => {
    const { readQueryParam } = require("../src/query.js");
    const fixtures: Array<[string, string]> = [
      ["https://x.test/?weird%20key=v", "weird key"],
      ["https://x.test/?a+b=value", "a b"],
      ["https://x.test/?caf%C3%A9=hi", "café"],
      ["https://x.test/?a%20b=v", "a%20b"],
      ["https://x.test/?a%2520b=v", "a%20b"],
      ["https://x.test/?plain=ok", "plain"],
      ["https://x.test/?plain=ok", "missing"],
    ];
    for (const [u, k] of fixtures) {
      expect(view(u).queryParam(k)).toBe(readQueryParam(u, k));
    }
  });
});

describe("UrlView edge cases", () => {
  test("does not throw on malformed inputs", () => {
    // None of these should throw — readers return best-effort substrings.
    expect(() => {
      const v = view("not a url");
      v.scheme();
      v.host();
      v.hostname();
      v.port();
      v.pathname();
      v.query();
      v.fragment();
      v.queryParam("x");
      v.hasQueryParam("x");
    }).not.toThrow();
  });

  test("handles the empty string without throwing", () => {
    const v = view("");
    expect(v.scheme()).toBe("");
    expect(v.pathname()).toBe("/");
    expect(v.query()).toBe("");
    expect(v.fragment()).toBe("");
  });

  test("handles a URL with malformed IPv6 (missing close bracket)", () => {
    expect(view("https://[::1/path").hostname()).toBe("[::1");
  });

  test("handles fragment-only input", () => {
    const v = view("https://x/p#frag-only");
    expect(v.fragment()).toBe("frag-only");
    expect(v.query()).toBe("");
  });
});

describe("UrlView scheme detection: embedded :// is not a scheme", () => {
  test("relative input with :// in the query is schemeless", () => {
    const v = view("/callback?redirect_uri=https://app.example.com/cb&state=x");
    expect(v.scheme()).toBe("");
    expect(v.pathname()).toBe("/callback");
    expect(v.origin()).toBe("");
    expect(v.host()).toBe("");
    expect(v.hostname()).toBe("");
    expect(v.port()).toBeNull();
    expect(v.queryParam("state")).toBe("x");
    expect(v.queryParam("redirect_uri")).toBe("https://app.example.com/cb");
  });

  test("a real scheme is still parsed when :// also appears in the query", () => {
    const v = view("https://a/p?u=x://y");
    expect(v.scheme()).toBe("https");
    expect(v.origin()).toBe("https://a");
    expect(v.pathname()).toBe("/p");
  });
});
