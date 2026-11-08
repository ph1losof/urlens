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
  setPathname,
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

  test("retains both delimiter positions across question-mark collisions", () => {
    const collisions = "?targeted".repeat(1024);
    for (const query of [
      `q=${collisions}&target=right`,
      `q=${collisions}&other=1&q=${collisions}&target=right`,
      `q=${collisions}?target=right`,
    ]) {
      const url = `/?${query}#target=outside`;
      expect(readQueryParam(url, "target")).toBe("right");
      expect(hasQueryParam(url, "target")).toBe(true);
      expect(queryParamEquals(url, "target", "right")).toBe(true);
      expect(view(url).queryParam("target")).toBe("right");
    }
    for (const tail of ["", "&other=1", "?other=1", "&targeted=wrong"]) {
      const url = `/?q=${collisions}${tail}#target=outside`;
      expect(readQueryParam(url, "target")).toBeNull();
      expect(hasQueryParam(url, "target")).toBe(false);
      expect(queryParamEquals(url, "target", "outside")).toBe(false);
    }
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

describe("query scans before large fragments", () => {
  test("retains the native path when an ampersand starts the fragment", () => {
    const fragment = `&%+missing=${"z".repeat(8192)}`;
    const url = `/?first=one&flag&last=two#${fragment}`;
    const result = view(url);
    expect(readQueryParam(url, "last")).toBe("two");
    expect(result.queryParam("last")).toBe("two");
    expect(hasQueryParam(url, "missing")).toBe(false);
    expect(result.hasQueryParam("missing")).toBe(false);
    expect(queryParamEquals(url, "last", "two")).toBe(true);
    expect(result.queryParamEquals("last", "two")).toBe(true);
    expect(readQueryParams(url, ["first", "last"])).toEqual(["one", "two"]);
    expect(result.queryParams(["first", "last", "missing"])).toEqual({
      first: "one",
      last: "two",
      missing: null,
    });
    expect(result.fragment()).toBe(fragment);
  });

  test("bounds flat and retained reads and preserves the original view", () => {
    const fragment = `${"z".repeat(8192)}?last=outside&missing=outside%25+tail#end`;
    const url = `https://x.test/api?first=one&flag&last=two#${fragment}`;
    const result = view(url);
    for (const [key, value] of [
      ["first", "one"],
      ["flag", ""],
      ["last", "two"],
      ["missing", null],
    ] as const) {
      expect(readQueryParam(url, key)).toBe(value);
      expect(result.queryParam(key)).toBe(value);
      expect(hasQueryParam(url, key)).toBe(value !== null);
      expect(result.hasQueryParam(key)).toBe(value !== null);
      expect(queryParamEquals(url, key, value ?? "wrong")).toBe(value !== null);
      expect(result.queryParamEquals(key, value ?? "wrong")).toBe(
        value !== null
      );
    }
    expect(readQueryParams(url, ["first", "last"])).toEqual(["one", "two"]);
    expect(readQueryParams(url, ["first", "last", "missing"])).toEqual([
      "one",
      "two",
      null,
    ]);
    expect(result.queryParams(["first", "last", "missing"])).toEqual({
      first: "one",
      last: "two",
      missing: null,
    });
    expect(result.toString()).toBe(url);
    expect(result.fragment()).toBe(fragment);
  });

  test("handles bare keys, empty values, and both sides of the suffix cutoff", () => {
    for (const length of [0, 254, 255, 256, 257, 8192]) {
      const suffix = `#${"z".repeat(length)}`;
      for (const query of [
        "flag",
        "flag=",
        "flag&last=two",
        "flag=&last=two",
      ]) {
        const url = `/?${query}${suffix}`;
        const result = view(url);
        expect(readQueryParam(url, "flag")).toBe("");
        expect(result.queryParam("flag")).toBe("");
        expect(hasQueryParam(url, "flag")).toBe(true);
        expect(result.hasQueryParam("flag")).toBe(true);
        expect(queryParamEquals(url, "flag", "")).toBe(true);
        expect(queryParamEquals(url, "flag", "wrong")).toBe(false);
        expect(result.queryParamEquals("flag", "")).toBe(true);
        expect(result.queryParamEquals("flag", "wrong")).toBe(false);
      }
    }
  });

  test("bounds long values and retains decoded key matching", () => {
    const suffix = `#${"z".repeat(8192)}&first=outside`;
    const long = "value".repeat(30);
    for (const query of [`first=${long}`, `first=${long}&last=two`]) {
      const url = `/?${query}${suffix}`;
      expect(readQueryParam(url, "first")).toBe(long);
      expect(view(url).queryParam("first")).toBe(long);
      expect(queryParamEquals(url, "first", long)).toBe(true);
      expect(view(url).queryParamEquals("first", long)).toBe(true);
    }
    const url = `/?a+b=space&a%2Bb=plus&%ZZ=literal&=empty&☕=tea${suffix}`;
    const result = view(url);
    for (const [key, value] of [
      ["a b", "space"],
      ["a+b", "plus"],
      ["%ZZ", "literal"],
      ["", "empty"],
      ["☕", "tea"],
    ]) {
      expect(readQueryParam(url, key)).toBe(value);
      expect(result.queryParam(key)).toBe(value);
      expect(queryParamEquals(url, key, value)).toBe(true);
      expect(result.queryParamEquals(key, value)).toBe(true);
    }
  });
});

test("query-free batches initialize every slot without inspecting key metadata", () => {
  for (const count of [2, 3, 4, 8, 32, 33, 64]) {
    const keys = Array.from({ length: count }, (_, i) => `${i}%+&=☕`);
    for (const url of [
      "",
      "/path",
      "/path#fragment?not=a-query",
      "/path#end",
    ]) {
      expect(readQueryParams(url, keys)).toEqual(new Array(count).fill(null));
    }
    expect(readQueryParams("/?", keys)).toEqual(new Array(count).fill(null));
  }
});

test("duplicate batch slots share each field's decoded value and preserve byte priority", () => {
  for (const count of [3, 4, 32, 33]) {
    for (const [field, key] of [
      ["message", "message"],
      ["encoded%20key", "encoded key"],
      ["%ZZ", "%ZZ"],
      ["", ""],
    ]) {
      const keys = new Array<string>(count).fill(key);
      for (const raw of ["", "caf%C3%A9+".repeat(20), "%FF%ZZ+%41"]) {
        const expected = decodeQueryComponent(raw);
        expect(
          readQueryParams(`/?${field}=${raw}&${field}=second#end`, keys)
        ).toEqual(new Array(count).fill(expected));
      }
      if (key !== "") {
        expect(readQueryParams(`/?${field}&other=x#end`, keys)).toEqual(
          new Array(count).fill("")
        );
      }
    }
  }
  expect(readQueryParams("/?%61=decoded&a=raw", ["a", "a", "a"])).toEqual([
    "raw",
    "raw",
    "raw",
  ]);
});

describe("query mutation before large fragments", () => {
  test("preserves the exact fragment across the scan cutoff", () => {
    // The cutoff includes '#': 254 fragment characters stay on the native path,
    // while 255 characters use the bounded query string.
    for (const size of [254, 255, 256, 8192]) {
      for (const markers of ["", "&%+missing="]) {
        const tail = "?last=outside&missing=x%FF+end#tail";
        const suffix = `#${markers}${"z".repeat(size - markers.length - tail.length)}${tail}`;
        const url = `/?first=one&last=two${suffix}`;
        expect(setQueryParam(url, "last", "updated")).toBe(
          `/?first=one&last=updated${suffix}`
        );
        expect(setQueryParam(url, "last", "two")).toBe(url);
        expect(setQueryParam(url, "missing", "new")).toBe(
          `/?first=one&last=two&missing=new${suffix}`
        );
        expect(setQueryParam(url, "last", null)).toBe(`/?first=one${suffix}`);
        expect(setQueryParam(url, "missing", null)).toBe(url);
        expect(
          setQueryParams(url, { first: "updated", last: null, added: "new" })
        ).toBe(`/?first=updated&added=new${suffix}`);
        expect(removeQueryParams(url, ["first", "last"])).toBe(`/${suffix}`);
        expect(removeQueryParams(url, ["missing", "absent"])).toBe(url);
      }
    }
  });

  test("bounds bare-field and decoded-key scans and prefix normalization", () => {
    const suffix = `#${"z".repeat(8192)}&target=outside%25+end`;
    const url = `/?&&flag&bare&a%20b=1&a+b=2&%ZZ=3&%25ZZ=4&tail${suffix}`;
    expect(setQueryParam(url, "a b", "c d")).toBe(
      `/?flag&bare&a+b=c+d&%ZZ=3&%25ZZ=4&tail${suffix}`
    );
    expect(setQueryParam(url, "%ZZ", null)).toBe(
      `/?flag&bare&a%20b=1&a+b=2&tail${suffix}`
    );
    expect(setQueryParam(url, "missing", "new")).toBe(
      `/?flag&bare&a%20b=1&a+b=2&%ZZ=3&%25ZZ=4&tail&missing=new${suffix}`
    );
    expect(setQueryParams(url, { "a b": "new", "%ZZ": null })).toBe(
      `/?flag&bare&a+b=new&tail${suffix}`
    );
    expect(removeQueryParams(url, ["a b", "%ZZ"])).toBe(
      `/?flag&bare&tail${suffix}`
    );
    expect(setQueryParam(`/?&&last=1&${suffix}`, "last", null)).toBe(
      `/${suffix}`
    );
    expect(removeQueryParams(`/?&&last=1&${suffix}`, ["last", "x"])).toBe(
      `/${suffix}`
    );
    expect(setQueryParam(`/?${suffix}`, "x", "1")).toBe(`/?x=1${suffix}`);
    expect(setQueryParams(`/?${suffix}`, { x: "1", y: "2" })).toBe(
      `/?x=1&y=2${suffix}`
    );
  });
});

describe("pathname replacement before long query tails", () => {
  test("preserves suffixes at the URL length and query-position cutoffs", () => {
    for (const total of [255, 256, 257, 8192]) {
      for (const queryAt of [0, 1, 126, 127, 128, 129]) {
        for (const origin of ["", "https://x.test"]) {
          if (origin.length > queryAt) {
            continue;
          }
          const path = "/".repeat(queryAt - origin.length);
          const prefix = origin + path;
          const suffix = `?${"x".repeat(total - prefix.length - 1)}`;
          expect(setPathname(prefix + suffix, "new")).toBe(
            `${origin}/new${suffix}`
          );
          if (path.length !== 0) {
            expect(setPathname(prefix + suffix, path)).toBe(prefix + suffix);
          }
          expect(setPathname(`${prefix}${suffix}#end`, "/new")).toBe(
            `${origin}/new${suffix}#end`
          );
        }
      }
    }
  });

  test("keeps the first fragment when it precedes a query marker", () => {
    for (const origin of ["", "https://x.test"]) {
      const fragment = `#first#second?${"x".repeat(8192)}`;
      expect(setPathname(`${origin}/old${fragment}`, "/new")).toBe(
        `${origin}/new${fragment}`
      );
      expect(setPathname(`${origin}/old#?${"x".repeat(8192)}`, "/new")).toBe(
        `${origin}/new#?${"x".repeat(8192)}`
      );
    }
    const suffix = `#${"x".repeat(8192)}`;
    expect(setPathname(`https://x.test/old${suffix}`, "/new")).toBe(
      `https://x.test/new${suffix}`
    );
    expect(setPathname(`https://x.test?${"x".repeat(8192)}`, "")).toBe(
      `https://x.test/?${"x".repeat(8192)}`
    );
  });
});

describe("decoder handling of invalid UTF-8 lead bytes", () => {
  test("matches decodeURIComponent or the tolerant path for every lead shape", () => {
    const leads = [
      "%41",
      "%7F",
      "%80",
      "%BF",
      "%C1",
      "%C2",
      "%E9",
      "%F4",
      "%F5",
      "%FF",
      "%ZZ",
      "%4",
      "%",
    ];
    const nexts = [
      "",
      "%A9",
      "%80",
      "%BF",
      "%7F",
      "%C0",
      "%ZZ",
      "%A",
      "%",
      "+",
      "x",
      "%82%AC",
    ];
    for (const pad of ["", "x".repeat(70)]) {
      for (const lead of leads) {
        for (const next of nexts) {
          for (const tail of ["", "+y", "%41"]) {
            const raw = `${pad}${lead}${next}${tail}`;
            let expected: string;
            try {
              expected = decodeURIComponent(raw.replaceAll("+", " "));
            } catch {
              expected = decodeQueryComponentReference(raw);
            }
            expect(decodeQueryComponent(raw)).toBe(expected);
            expect(decodeRange(`?${raw}&`, 1, raw.length + 1)).toBe(expected);
          }
        }
      }
    }
    expect(decodeQueryComponent("caf%E9+cr%E8me")).toBe("caf\uFFFD cr\uFFFDme");
    expect(decodeQueryComponent("%C3%A9")).toBe("é");
    expect(decodeQueryComponent("%F0%9F%98%80")).toBe("😀");
  });
});

// Byte-wise WHATWG reference: percent-decode to bytes, then UTF-8 decode with
// replacement. Used only where decodeURIComponent rejects the input.
function decodeQueryComponentReference(raw: string): string {
  const bytes: number[] = [];
  const s = raw.replaceAll("+", " ");
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (
      c === 37 &&
      i + 2 < s.length &&
      /^[0-9a-fA-F]{2}$/.test(s.slice(i + 1, i + 3))
    ) {
      bytes.push(Number.parseInt(s.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      bytes.push(...new TextEncoder().encode(s[i]));
    }
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}
