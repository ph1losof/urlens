import { describe, expect, test } from "bun:test";
import { decodeQueryComponent, decodeRange } from "../src/decode.js";
import { encodeQueryComponent } from "../src/encode.js";
import {
  hasQueryParam,
  queryParamEquals,
  readQueryParam,
  readQueryParams,
  removeQueryParams,
  setQueryParam,
  setQueryParams,
} from "../src/query.js";
import {
  hasScheme,
  pathnameEndsWith,
  pathnameStartsWith,
  readFragment,
  readHost,
  readHostname,
  readOrigin,
  readPathname,
  readPort,
  readScheme,
} from "../src/url.js";
import { view } from "../src/view.js";

describe("substring collisions during query lookup", () => {
  test("skips repeated value hits and key prefixes before the first full key", () => {
    const url = `/?q=${"foo".repeat(1500)}&foooo=ignored&foo=right&foo=second#foo=outside`;
    expect(readQueryParam(url, "foo")).toBe("right");
    expect(hasQueryParam(url, "foo")).toBe(true);
    expect(queryParamEquals(url, "foo", "right")).toBe(true);
    expect(view(url).queryParam("foo")).toBe("right");
    expect(
      readQueryParam(`/?q=${"a".repeat(4096)}&z=1#a=outside`, "a")
    ).toBeNull();
  });

  test("handles question marks in a requested key after value collisions", () => {
    const url = `/?q=${"a?b".repeat(100)}&a?b=right#end`;
    expect(readQueryParam(url, "a?b")).toBe("right");
    expect(view(url).queryParam("a?b")).toBe("right");
  });
});

describe("large query removal lists", () => {
  const padding = Array.from({ length: 33 }, (_, i) => `missing-key-${i}`);

  test("removes duplicate raw and decoded keys without changing untouched fields", () => {
    expect(removeQueryParams("/?a=1&b=2&a=3#frag", [...padding, "a"])).toBe(
      "/?b=2#frag"
    );
    expect(
      removeQueryParams("/?keep=1&a%20b=x&a+b=y&tail=2#frag", [
        ...padding,
        "a b",
      ])
    ).toBe("/?keep=1&tail=2#frag");
    expect(removeQueryParams("/?%ZZ=1&%25ZZ=2&x=3", [...padding, "%ZZ"])).toBe(
      "/?x=3"
    );
    expect(
      removeQueryParams("/?%FF=1&%EF%BB%BF%FF=2&keep=3", [...padding, "�"])
    ).toBe("/?%EF%BB%BF%FF=2&keep=3");
  });

  test("preserves empty fields and fragments and returns unchanged misses", () => {
    expect(
      removeQueryParams("/?&&=empty&bare&&x=1#frag", [...padding, ""])
    ).toBe("/?bare&&x=1#frag");
    expect(
      removeQueryParams("/?&keep=1&&target=2", [...padding, "target"])
    ).toBe("/?keep=1");
    expect(
      removeQueryParams("/?bare&keep=1#frag", [...padding, "bare", "keep"])
    ).toBe("/#frag");
    expect(removeQueryParams("/?keep=1#missing=outside", padding)).toBe(
      "/?keep=1#missing=outside"
    );
    expect(removeQueryParams("/?", padding)).toBe("/?");
  });

  test("large lists preserve decoded matching and prefix formatting on many fields", () => {
    const prefix = "keep=1&".repeat(40);
    const url = `/?${prefix}a%20b=x&a+b=y&%ZZ=1&%25ZZ=2&%FF=3&%EF%BB%BF%FF=4&tail=2#end`;
    expect(removeQueryParams(url, [...padding, "a b", "%ZZ", "�"])).toBe(
      `/?${prefix}%EF%BB%BF%FF=4&tail=2#end`
    );
    expect(
      removeQueryParams(`/?&${prefix}target=2`, [...padding, "target"])
    ).toBe(`/?${prefix.slice(0, -1)}`);
    expect(
      removeQueryParams(`/?${prefix}=empty&bare&&x=1`, [...padding, ""])
    ).toBe(`/?${prefix}bare&&x=1`);
    expect(
      removeQueryParams(`/?${prefix}bare#end`, [...padding, "keep", "bare"])
    ).toBe("/#end");
    expect(removeQueryParams(`/?${prefix}tail=2`, padding)).toBe(
      `/?${prefix}tail=2`
    );
  });

  test("handles a long value with few fields and ignores fragment separators", () => {
    const raw = `/?q=${"x".repeat(1024)}#outside&missing-key-0=1`;
    expect(removeQueryParams(raw, padding)).toBe(raw);
  });
});

describe("long query values", () => {
  const prefix = "a".repeat(80);
  const values = [
    prefix,
    `${prefix}+tail`,
    `+${prefix}+tail+`,
    `${prefix}%20tail`,
    `${prefix}%C3%A9+%E2%98%95`,
    `${prefix}%ZZ+%41`,
    `${prefix}%A`,
    `${prefix}%41%ZZ`,
    `${prefix}%E2%82+%FF`,
    `${prefix}%F0%9F%8C%9F`,
    `${prefix}%EF%BB%BF`,
    `${prefix}%ED%A0%80`,
  ];

  test("decoding and predicates agree with URLSearchParams", () => {
    for (const raw of values) {
      const expected = new URLSearchParams(`q=${raw}`).get("q")!;
      const url = `https://x.test/?before=1&q=${raw}&after=%25+#ignored`;
      expect(decodeQueryComponent(raw)).toBe(expected);
      expect(readQueryParam(url, "q")).toBe(expected);
      expect(view(url).queryParam("q")).toBe(expected);
      expect(queryParamEquals(url, "q", expected)).toBe(true);
      expect(view(url).queryParamEquals("q", expected)).toBe(true);
      expect(queryParamEquals(url, "q", `${expected}!`)).toBe(false);
      expect(queryParamEquals(url, "q", `b${expected.slice(1)}`)).toBe(false);
    }
  });

  test("decoding stays within the requested range", () => {
    const raw = `${prefix}+%41`;
    const input = `ignored%FF+${raw}&next=%FF+#${"+%ZZ".repeat(1000)}`;
    expect(decodeRange(input, 11, 11 + raw.length)).toBe(`${prefix} A`);
    expect(decodeRange(`+${prefix}%FF`, 1, 1 + prefix.length)).toBe(prefix);
  });

  test("equal-length predicates distinguish plus and literal malformed escapes", () => {
    for (const [raw, expected, matches] of [
      [`${prefix}+tail`, `${prefix} tail`, true],
      [`${prefix}+tail`, `${prefix}+tail`, false],
      [`${prefix}%ZZ`, `${prefix}%ZZ`, true],
      [`${prefix}%20`, `${prefix}%20`, false],
      [`${prefix} tail`, `${prefix}+tail`, false],
      [`${prefix}x`, `${prefix}y`, false],
    ] as const) {
      const url = `/path?q=${raw}#%FF+`;
      expect(queryParamEquals(url, "q", expected)).toBe(matches);
      expect(view(url).queryParamEquals("q", expected)).toBe(matches);
    }
  });
});

describe("query walks across bare fields", () => {
  const flags = "flag&".repeat(1024);

  test("readers handle missing '=', later values, and '=' inside values", () => {
    for (const tail of [
      "",
      "last=1",
      "last=one=two",
      "last",
      "last=1&last=2",
    ]) {
      const query = `${flags}${tail}`;
      const native = new URLSearchParams(query);
      const url = `/?${query}#outside=ignored&missing=bad`;
      const retained = view(url);
      const keys = ["flag", "last", "missing", ""];
      expect(readQueryParams(url, keys)).toEqual(
        keys.map((key) => native.get(key))
      );
      expect(readQueryParams(url, ["last", "missing"])).toEqual([
        native.get("last"),
        null,
      ]);
      expect(retained.queryParams(keys)).toEqual({
        flag: "",
        last: native.get("last"),
        missing: null,
        "": null,
      });
    }
  });

  test("ambiguous and decoded keys work after bare fields", () => {
    const url = `/?${flags}%ZZ=value&encoded%20key=one%3Dtwo&=empty#%ZZ=wrong`;
    const keys = ["%ZZ", "encoded key", "", "missing"];
    const expected = ["value", "one=two", "empty", null];
    expect(readQueryParams(url, keys)).toEqual(expected);
    expect(readQueryParams(url, ["encoded key", "missing"])).toEqual([
      "one=two",
      null,
    ]);
    expect(view(url).queryParams(keys)).toEqual({
      "%ZZ": "value",
      "encoded key": "one=two",
      "": "empty",
      missing: null,
    });
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i];
      expect(readQueryParam(url, key)).toBe(expected[i]);
      expect(view(url).queryParam(key)).toBe(expected[i]);
      expect(hasQueryParam(url, key)).toBe(expected[i] !== null);
      expect(view(url).hasQueryParam(key)).toBe(expected[i] !== null);
      expect(queryParamEquals(url, key, expected[i] ?? "")).toBe(
        expected[i] !== null
      );
      expect(view(url).queryParamEquals(key, expected[i] ?? "")).toBe(
        expected[i] !== null
      );
    }
  });

  test("setters preserve bare fields, remove duplicates, and respect fragments", () => {
    const url = `/path?${flags}last=1&last=2#last=untouched`;
    expect(setQueryParam(url, "last", "updated")).toBe(
      `/path?${flags}last=updated#last=untouched`
    );
    expect(setQueryParams(url, { last: "updated", extra: "new" })).toBe(
      `/path?${flags}last=updated&extra=new#last=untouched`
    );
    expect(setQueryParam(url, "last", null)).toBe(
      `/path?${flags.slice(0, -1)}#last=untouched`
    );
    expect(removeQueryParams(url, ["last", "missing"])).toBe(
      `/path?${flags.slice(0, -1)}#last=untouched`
    );
    expect(removeQueryParams(url, ["missing", "other"])).toBe(url);
    expect(setQueryParam(`/?${flags}#last=outside`, "last", "new")).toBe(
      `/?${flags}last=new#last=outside`
    );
  });

  test("reused query prefixes preserve empty-field normalization", () => {
    expect(setQueryParam("/?&a=1&&q=old#frag", "q", "new")).toBe(
      "/?a=1&&q=new#frag"
    );
    expect(setQueryParam("/?&&a=1&&q=old&tail=2", "q", "new")).toBe(
      "/?a=1&&q=new&tail=2"
    );
    for (const [query, prefix] of [
      ["", ""],
      ["&", ""],
      ["&&", ""],
      ["a=1&", "a=1"],
      ["a=1&&", "a=1&"],
      ["&a=1&", "a=1"],
      ["&&a=1&&", "a=1&"],
      ["a=1&&b=2", "a=1&&b=2"],
    ]) {
      const separator = prefix.length > 0 ? "&" : "";
      expect(setQueryParam(`/?${query}#frag`, "added", "new")).toBe(
        `/?${prefix}${separator}added=new#frag`
      );
    }
  });
});

describe("URL component fast paths", () => {
  test("path boundaries precede long queries and honor the first fragment marker", () => {
    const tail = "payload/".repeat(1000);
    for (const prefix of ["https://x.test", ""]) {
      const url = `${prefix}/api?q=${tail}#first#last`;
      expect(readPathname(url)).toBe("/api");
      expect(pathnameStartsWith(url, "/api")).toBe(true);
      expect(pathnameEndsWith(url, "api")).toBe(true);
      const fragmentFirst = `${prefix}/api#first?query=${tail}#last`;
      expect(readPathname(fragmentFirst)).toBe("/api");
      expect(pathnameEndsWith(fragmentFirst, "api")).toBe(true);
      expect(view(fragmentFirst).fragment()).toBe(`first?query=${tail}#last`);
    }
    expect(readPathname(`https://x.test?q=${tail}`)).toBe("/");
    expect(view("/api?q=1#").fragment()).toBe("");
    expect(view("/api?q=1").fragment()).toBe("");
  });

  test("four-digit ports validate every character and preserve leading zeroes", () => {
    expect(readPort("https://x:0001/")).toBe(1);
    expect(readPort("https://x:9999/")).toBe(9999);
    for (const port of ["x080", "8x80", "80x0", "808x", "+443", "１２３４"]) {
      expect(readPort(`https://x:${port}/`)).toBeNull();
    }
  });
});

test("long encoding prefixes retain form rules and surrogate replacement", () => {
  const prefix = "*._-AZ09".repeat(16);
  for (const suffix of [
    "",
    " ",
    "&=+%",
    "café",
    "中文",
    "🌟",
    "\ud800",
    "\udfff",
  ]) {
    const input = prefix + suffix;
    expect(encodeQueryComponent(input)).toBe(
      new URLSearchParams([["q", input]]).toString().slice(2)
    );
  }
});

test("scheme case folding rejects control-character aliases", () => {
  expect(hasScheme("CUSTOM+1://x/", "custom+1")).toBe(true);
  expect(hasScheme("a+://x/", "a\u000b")).toBe(false);
  expect(hasScheme("a-://x/", "a\r")).toBe(false);
  expect(hasScheme("a.://x/", "a\u000e")).toBe(false);
  expect(hasScheme("a0://x/", "a\u0010")).toBe(false);
});

test("compact views agree with flat component readers on mixed authorities", () => {
  for (const url of [
    "https://x:/api?q=1#end",
    "https://x:80/api?q=1#end",
    "https://x:12345/api?q=1#end",
    "https://x:bad/api?q=1#end",
    "https://[broken/api?q=1#end",
    "https://u:p@a:b@host:443/api?q=1#end",
    "/relative?q=1#end",
  ]) {
    const result = Object.freeze(view(url));
    expect(result.scheme()).toBe(readScheme(url));
    expect(result.origin()).toBe(readOrigin(url));
    expect(result.host()).toBe(readHost(url));
    expect(result.hostname()).toBe(readHostname(url));
    expect(result.port()).toBe(readPort(url));
    expect(result.pathname()).toBe(readPathname(url));
    expect(result.fragment()).toBe(readFragment(url));
  }
});
