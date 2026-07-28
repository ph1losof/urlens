import { describe, expect, test } from "bun:test";
import {
  hasQueryParam,
  queryParamEquals,
  readQuery,
  readQueryParam,
  readQueryParams,
  removeQueryParam,
  removeQueryParams,
  setQueryParam,
  setQueryParams,
  stripQuery,
} from "../src/query.js";

describe("readQueryParam", () => {
  test("returns null when there is no query string", () => {
    expect(readQueryParam("https://example.com/path", "q")).toBeNull();
    expect(readQueryParam("/path", "q")).toBeNull();
  });

  test("returns null for a missing key", () => {
    expect(readQueryParam("https://example.com/?q=1", "missing")).toBeNull();
  });

  test("returns empty string for a key with no value", () => {
    expect(readQueryParam("https://example.com/?k", "k")).toBe("");
    expect(readQueryParam("https://example.com/?k=", "k")).toBe("");
  });

  test("returns plain ASCII values verbatim", () => {
    expect(readQueryParam("https://example.com/?q=hello", "q")).toBe("hello");
  });

  test("decodes + as space", () => {
    expect(readQueryParam("https://example.com/?q=hello+world", "q")).toBe(
      "hello world"
    );
  });

  test("decodes percent-encoded UTF-8", () => {
    expect(readQueryParam("https://example.com/?q=caf%C3%A9", "q")).toBe(
      "café"
    );
  });

  test("decodes mixed + and percent encoding", () => {
    expect(readQueryParam("https://example.com/?q=hello+%E2%98%95", "q")).toBe(
      "hello ☕"
    );
  });

  test("ignores a fragment after the query", () => {
    expect(readQueryParam("https://example.com/?q=cats#frag", "q")).toBe(
      "cats"
    );
  });

  test("does not match a key that is a prefix of another", () => {
    expect(readQueryParam("https://example.com/?qq=long&q=short", "q")).toBe(
      "short"
    );
    expect(readQueryParam("https://example.com/?q=short&qq=long", "qq")).toBe(
      "long"
    );
  });

  test("handles an empty query string", () => {
    expect(readQueryParam("https://example.com/?", "q")).toBeNull();
  });

  test("returns the first occurrence when a key repeats", () => {
    expect(readQueryParam("https://example.com/?q=a&q=b", "q")).toBe("a");
  });

  test("preserves equals inside the value", () => {
    expect(readQueryParam("https://example.com/?q=a=b", "q")).toBe("a=b");
  });

  test("falls back to tolerant decoding on malformed percent escapes", () => {
    expect(readQueryParam("https://example.com/?q=100%25+off", "q")).toBe(
      "100% off"
    );
    expect(readQueryParam("https://example.com/?q=%ZZ+raw", "q")).toBe(
      "%ZZ raw"
    );
  });

  test("treats a '?' inside the fragment as not a query", () => {
    // Fragment starts before query — '?' is fragment content, not a delimiter.
    expect(
      readQueryParam("https://example.com/#frag?q=ignored", "q")
    ).toBeNull();
  });
});

describe("readQueryParams", () => {
  test("returns an empty array when keys is empty", () => {
    expect(readQueryParams("https://example.com/?q=1", [])).toEqual([]);
  });

  test("matches an empty parameter name in a batch", () => {
    expect(
      readQueryParams("https://example.com/?=value&a=1", ["", "a"])
    ).toEqual(["value", "1"]);
  });

  test("returns all nulls when there is no query string", () => {
    expect(readQueryParams("https://example.com/", ["a", "b"])).toEqual([
      null,
      null,
    ]);
  });

  test("delegates a single requested key to the single-key reader", () => {
    expect(readQueryParams("https://example.com/?a=1", ["a"])).toEqual(["1"]);
  });

  test("matches keys in parallel-array order", () => {
    expect(
      readQueryParams("https://example.com/?b=second&a=first&c=third", [
        "a",
        "b",
        "c",
      ])
    ).toEqual(["first", "second", "third"]);
  });

  test("returns null for any key that is missing", () => {
    expect(
      readQueryParams("https://example.com/?a=1&c=3", ["a", "b", "c"])
    ).toEqual(["1", null, "3"]);
  });

  test("returns the same value in every slot when a key is duplicated", () => {
    expect(readQueryParams("https://example.com/?q=hello", ["q", "q"])).toEqual(
      ["hello", "hello"]
    );
  });

  test("decodes percent-encoded UTF-8 in each slot", () => {
    expect(
      readQueryParams("https://example.com/?q=caf%C3%A9&l=fr%2DFR", ["q", "l"])
    ).toEqual(["café", "fr-FR"]);
  });

  test("stops scanning once every requested key has been found", () => {
    expect(
      readQueryParams("https://example.com/?a=1&b=2&junk=%ZZ%QQ", ["a", "b"])
    ).toEqual(["1", "2"]);
  });

  test("ignores params after the fragment", () => {
    expect(
      readQueryParams("https://example.com/?a=1#b=ignored", ["a", "b"])
    ).toEqual(["1", null]);
  });

  test("treats a key-only param as empty string", () => {
    expect(
      readQueryParams("https://example.com/?flag&q=x", ["flag", "q"])
    ).toEqual(["", "x"]);
  });

  test("handles ambiguous keys in batches larger than the bit mask", () => {
    const keys = Array.from({ length: 33 }, (_, i) => `missing-${i}`);
    keys[32] = "%ZZ";
    expect(readQueryParams("https://example.com/?%ZZ=ok", keys)[32]).toBe("ok");
  });

  test("tracks ambiguous keys in the normal batch bit mask", () => {
    expect(
      readQueryParams("https://example.com/?%ZZ=ok", ["%ZZ", "missing"])
    ).toEqual(["ok", null]);
  });
});

describe("setQueryParam", () => {
  test("appends a param when no query is present", () => {
    expect(setQueryParam("https://example.com/path", "q", "hi")).toBe(
      "https://example.com/path?q=hi"
    );
  });

  test("appends before the fragment when no query is present", () => {
    expect(setQueryParam("https://example.com/path#frag", "q", "hi")).toBe(
      "https://example.com/path?q=hi#frag"
    );
  });

  test("appends when query exists but the key is absent", () => {
    expect(setQueryParam("https://example.com/?a=1", "q", "hi")).toBe(
      "https://example.com/?a=1&q=hi"
    );
  });

  test("replaces an existing value", () => {
    expect(setQueryParam("https://example.com/?q=old&a=1", "q", "new")).toBe(
      "https://example.com/?q=new&a=1"
    );
  });

  test("replaces the first occurrence and drops the rest (matches URLSearchParams.set)", () => {
    expect(setQueryParam("https://example.com/?q=a&q=b&q=c", "q", "new")).toBe(
      "https://example.com/?q=new"
    );
    expect(
      setQueryParam("https://example.com/?a=1&q=x&b=2&q=y", "q", "z")
    ).toBe("https://example.com/?a=1&q=z&b=2");
  });

  test("removes the key when value is null", () => {
    expect(setQueryParam("https://example.com/?q=hi&a=1", "q", null)).toBe(
      "https://example.com/?a=1"
    );
  });

  test("removes every occurrence when value is null and key is duplicated", () => {
    expect(setQueryParam("https://example.com/?q=a&q=b&r=1", "q", null)).toBe(
      "https://example.com/?r=1"
    );
  });

  test("strips the ? when removing the only param", () => {
    expect(setQueryParam("https://example.com/?q=hi", "q", null)).toBe(
      "https://example.com/"
    );
  });

  test("returns the input unchanged when removing a missing key", () => {
    const u = "https://example.com/?a=1";
    expect(setQueryParam(u, "missing", null)).toBe(u);
    const u2 = "https://example.com/path";
    expect(setQueryParam(u2, "missing", null)).toBe(u2);
  });

  test("percent-encodes the value", () => {
    expect(setQueryParam("https://example.com/", "q", "hello world")).toBe(
      "https://example.com/?q=hello+world"
    );
    expect(setQueryParam("https://example.com/", "q", "café ☕")).toBe(
      "https://example.com/?q=caf%C3%A9+%E2%98%95"
    );
  });

  test("preserves the fragment in every code path", () => {
    expect(setQueryParam("https://example.com/?q=old#x", "q", "new")).toBe(
      "https://example.com/?q=new#x"
    );
    expect(setQueryParam("https://example.com/?q=old#x", "q", null)).toBe(
      "https://example.com/#x"
    );
    expect(setQueryParam("https://example.com/#x", "q", "new")).toBe(
      "https://example.com/?q=new#x"
    );
  });

  test("roundtrips: set then read returns the value", () => {
    const u = setQueryParam("https://example.com/?a=1", "q", "café ☕");
    expect(readQueryParam(u, "q")).toBe("café ☕");
  });

  test("does not match a key that is a prefix of another", () => {
    expect(setQueryParam("https://example.com/?qq=long", "q", "short")).toBe(
      "https://example.com/?qq=long&q=short"
    );
  });
});

describe("setQueryParams", () => {
  test("returns the input unchanged when the dict is empty", () => {
    const u = "https://example.com/?a=1";
    expect(setQueryParams(u, {})).toBe(u);
  });

  test("replaces an empty parameter name", () => {
    expect(
      setQueryParams("https://example.com/?=old&a=1", { "": "new", a: null })
    ).toBe("https://example.com/?=new");
  });

  test("sets multiple new params in one pass", () => {
    expect(setQueryParams("https://example.com/path", { a: "1", b: "2" })).toBe(
      "https://example.com/path?a=1&b=2"
    );
  });

  test("returns an unchanged queryless URL when every value is null", () => {
    const url = "https://example.com/path";
    expect(setQueryParams(url, { a: null, b: null })).toBe(url);
  });

  test("replaces existing values and appends missing ones", () => {
    expect(
      setQueryParams("https://example.com/?a=old&c=keep", {
        a: "new",
        b: "added",
      })
    ).toBe("https://example.com/?a=new&c=keep&b=added");
  });

  test("removes keys whose value is null", () => {
    expect(
      setQueryParams("https://example.com/?a=1&b=2&c=3", {
        b: null,
      })
    ).toBe("https://example.com/?a=1&c=3");
  });

  test("supports mixed set/remove in one call", () => {
    expect(
      setQueryParams("https://example.com/?a=1&b=2&c=3", {
        a: "new",
        b: null,
        d: "added",
      })
    ).toBe("https://example.com/?a=new&c=3&d=added");
  });

  test("removes duplicates of a replaced key", () => {
    expect(setQueryParams("https://example.com/?q=a&q=b&q=c", { q: "z" })).toBe(
      "https://example.com/?q=z"
    );
  });

  test("encodes values with + for space", () => {
    expect(
      setQueryParams("https://example.com/", { q: "hello world", t: "x y" })
    ).toBe("https://example.com/?q=hello+world&t=x+y");
  });

  test("preserves the fragment", () => {
    expect(setQueryParams("https://example.com/?a=1#frag", { b: "2" })).toBe(
      "https://example.com/?a=1&b=2#frag"
    );
  });

  test("strips the ? when every existing param is removed and nothing is added", () => {
    expect(
      setQueryParams("https://example.com/?a=1&b=2", { a: null, b: null })
    ).toBe("https://example.com/");
  });

  test("rejects ambiguous byte matches while updating other fields", () => {
    expect(
      setQueryParams("https://example.com/?a%20b=old&q=1", {
        "a%20b": "new",
        q: "2",
      })
    ).toBe("https://example.com/?a%20b=old&q=2&a%2520b=new");
  });

  test("keeps plain fields when encoding elsewhere cannot produce a match", () => {
    expect(
      setQueryParams("https://example.com/?plain=1&encoded%20key=2", {
        absent: "3",
        other: null,
      })
    ).toBe("https://example.com/?plain=1&encoded%20key=2&absent=3");
  });
});

describe("hasQueryParam", () => {
  test("returns true when the key is present with a value", () => {
    expect(hasQueryParam("https://x.test/?a=1&b=2", "a")).toBe(true);
    expect(hasQueryParam("https://x.test/?a=1&b=2", "b")).toBe(true);
  });

  test("returns true for a key with an empty value", () => {
    expect(hasQueryParam("https://x.test/?k=", "k")).toBe(true);
  });

  test("returns true for a key with no = sign", () => {
    expect(hasQueryParam("https://x.test/?flag&b=2", "flag")).toBe(true);
  });

  test("returns false when the key is missing", () => {
    expect(hasQueryParam("https://x.test/?a=1", "missing")).toBe(false);
  });

  test("returns false when there is no query", () => {
    expect(hasQueryParam("https://x.test/", "a")).toBe(false);
    expect(hasQueryParam("/path", "a")).toBe(false);
  });

  test("does not match a key that is a prefix of another", () => {
    expect(hasQueryParam("https://x.test/?qq=1", "q")).toBe(false);
    expect(hasQueryParam("https://x.test/?q=1", "qq")).toBe(false);
  });

  test("ignores a fragment-only ?", () => {
    expect(hasQueryParam("https://x.test/#frag?q=1", "q")).toBe(false);
  });

  test("handles ambiguous literal and unencoded misses", () => {
    expect(hasQueryParam("https://x.test/?%ZZ=1", "%ZZ")).toBe(true);
    expect(hasQueryParam("https://x.test/?plain=1", "%ZZ")).toBe(false);
  });

  test("is consistent with readQueryParam", () => {
    const urls = [
      "https://x.test/?a=1&b=2",
      "https://x.test/",
      "https://x.test/?empty=",
      "https://x.test/#frag",
    ];
    for (const u of urls) {
      for (const k of ["a", "b", "missing", "empty"]) {
        expect(hasQueryParam(u, k)).toBe(readQueryParam(u, k) !== null);
      }
    }
  });
});

describe("queryParamEquals", () => {
  test("ASCII fast path: matches a plain value", () => {
    expect(queryParamEquals("https://x.test/?q=hello", "q", "hello")).toBe(
      true
    );
    expect(queryParamEquals("https://x.test/?q=hello", "q", "nope")).toBe(
      false
    );
  });

  test("ASCII fast path: returns false on length mismatch without decoding", () => {
    expect(queryParamEquals("https://x.test/?q=abc", "q", "abcd")).toBe(false);
    expect(queryParamEquals("https://x.test/?q=abcd", "q", "abc")).toBe(false);
  });

  test("decode fallback: matches + as space", () => {
    expect(
      queryParamEquals("https://x.test/?q=hello+world", "q", "hello world")
    ).toBe(true);
  });

  test("byte-walk: matches percent-encoded UTF-8 (2-byte and 3-byte)", () => {
    expect(queryParamEquals("https://x.test/?q=caf%C3%A9", "q", "café")).toBe(
      true
    );
    expect(
      queryParamEquals("https://x.test/?q=caf%C3%A9+%E2%98%95", "q", "café ☕")
    ).toBe(true);
    expect(
      queryParamEquals("https://x.test/?q=%E4%B8%AD%E6%96%87", "q", "中文")
    ).toBe(true);
  });

  test("byte-walk: matches 4-byte UTF-8 astral codepoints", () => {
    // 🌟 = U+1F31F, encoded as %F0%9F%8C%9F.
    expect(queryParamEquals("https://x.test/?q=%F0%9F%8C%9F", "q", "🌟")).toBe(
      true
    );
    expect(queryParamEquals("https://x.test/?q=%F0%9F%9A%80", "q", "🚀")).toBe(
      true
    );
    expect(
      queryParamEquals("https://x.test/?q=%F0%9F%8C%9F", "q", "wrong")
    ).toBe(false);
  });

  test("byte-walk: percent-encoded ASCII (%20 vs literal space)", () => {
    expect(
      queryParamEquals("https://x.test/?q=hello%20world", "q", "hello world")
    ).toBe(true);
  });

  test("byte-walk: literal %25 (encoded percent sign)", () => {
    expect(
      queryParamEquals("https://x.test/?q=100%25+off", "q", "100% off")
    ).toBe(true);
  });

  test("byte-walk: tolerates malformed %ZZ as literal", () => {
    expect(queryParamEquals("https://x.test/?q=%ZZ+raw", "q", "%ZZ raw")).toBe(
      true
    );
  });

  test("byte-walk: WHATWG-conformant U+FFFD emission for malformed UTF-8", () => {
    // Lone continuation byte → U+FFFD (matches decodeQueryComponent + TextDecoder).
    expect(queryParamEquals("https://x.test/?q=%AB", "q", "�")).toBe(true);
    // Lead byte without any continuation → U+FFFD.
    expect(queryParamEquals("https://x.test/?q=%C3", "q", "�")).toBe(true);
    // Lead followed by a non-continuation byte → U+FFFD then the stolen byte
    // is re-processed (here as ASCII space).
    expect(queryParamEquals("https://x.test/?q=%C3%20", "q", "� ")).toBe(true);
    // Overlong NUL (%C0%80): 0xC0 is invalid lead → U+FFFD; 0x80 is a lone
    // continuation → another U+FFFD.
    expect(queryParamEquals("https://x.test/?q=%C0%80", "q", "��")).toBe(true);
    // Surrogate-range 3-byte sequence (%ED%A0%80 would encode U+D800,
    // forbidden) — each invalid byte produces a U+FFFD.
    expect(queryParamEquals("https://x.test/?q=%ED%A0%80", "q", "���")).toBe(
      true
    );
    // Byte > 0xF4 (would exceed U+10FFFF).
    expect(queryParamEquals("https://x.test/?q=%F5", "q", "�")).toBe(true);
  });

  test("byte-walk: consistent with readQueryParam on malformed UTF-8", () => {
    const cases = [
      "https://x.test/?q=%AB",
      "https://x.test/?q=%C3",
      "https://x.test/?q=%C3%20",
      "https://x.test/?q=%C0%80",
      "https://x.test/?q=%ED%A0%80",
    ];
    for (const u of cases) {
      const v = readQueryParam(u, "q");
      expect(v).not.toBeNull();
      expect(queryParamEquals(u, "q", v as string)).toBe(true);
    }
  });

  test("returns false for missing key", () => {
    expect(queryParamEquals("https://x.test/?a=1", "missing", "1")).toBe(false);
  });

  test("returns true for empty-value key when comparing to empty string", () => {
    expect(queryParamEquals("https://x.test/?k=", "k", "")).toBe(true);
    expect(queryParamEquals("https://x.test/?k", "k", "")).toBe(true);
  });

  test("does not match a key that is a prefix of another", () => {
    expect(queryParamEquals("https://x.test/?qq=1&q=2", "q", "2")).toBe(true);
    expect(queryParamEquals("https://x.test/?qq=1&q=2", "qq", "1")).toBe(true);
  });

  test("returns false when there is no query", () => {
    expect(queryParamEquals("https://x.test/", "q", "x")).toBe(false);
  });

  test("returns false when ? appears inside the fragment", () => {
    expect(queryParamEquals("https://x.test/#frag?q=1", "q", "1")).toBe(false);
  });

  test("handles ambiguous keys and their decoded fallback", () => {
    expect(queryParamEquals("https://x.test/?%ZZ=ok", "%ZZ", "ok")).toBe(true);
    expect(queryParamEquals("https://x.test/?plain=ok", "%ZZ", "ok")).toBe(
      false
    );
    expect(queryParamEquals("https://x.test/?a%2520b=ok", "a%20b", "ok")).toBe(
      true
    );
    expect(
      queryParamEquals("https://x.test/?encoded%20key=ok", "missing", "ok")
    ).toBe(false);
  });

  test("is consistent with readQueryParam for present keys", () => {
    const u = "https://x.test/?a=hello+world&b=caf%C3%A9";
    for (const k of ["a", "b"]) {
      const v = readQueryParam(u, k);
      expect(v).not.toBeNull();
      expect(queryParamEquals(u, k, v as string)).toBe(true);
    }
  });
});

describe("readQuery", () => {
  test("returns the raw query without the leading ?", () => {
    expect(readQuery("https://x.test/?a=1&b=2")).toBe("a=1&b=2");
    expect(readQuery("/path?q=hello+world")).toBe("q=hello+world");
  });

  test("does NOT decode the value", () => {
    expect(readQuery("https://x.test/?q=caf%C3%A9")).toBe("q=caf%C3%A9");
  });

  test("returns empty string when there is no query", () => {
    expect(readQuery("https://x.test/")).toBe("");
    expect(readQuery("/path")).toBe("");
  });

  test("ignores content after a fragment", () => {
    expect(readQuery("https://x.test/?a=1#b=2")).toBe("a=1");
  });

  test("returns empty string when ? appears inside a fragment", () => {
    expect(readQuery("https://x.test/#frag?q=1")).toBe("");
  });

  test("returns empty string for an empty query", () => {
    expect(readQuery("https://x.test/?")).toBe("");
  });
});

describe("stripQuery", () => {
  test("removes the query", () => {
    expect(stripQuery("https://x.test/p?q=1")).toBe("https://x.test/p");
  });

  test("preserves the fragment", () => {
    expect(stripQuery("https://x.test/p?q=1#frag")).toBe(
      "https://x.test/p#frag"
    );
  });

  test("returns input unchanged when there is no query", () => {
    const u = "https://x.test/p#frag";
    expect(stripQuery(u)).toBe(u);
  });

  test("strips an empty query", () => {
    expect(stripQuery("https://x.test/p?")).toBe("https://x.test/p");
    expect(stripQuery("https://x.test/p?#frag")).toBe("https://x.test/p#frag");
  });
});

describe("removeQueryParam", () => {
  test("removes the key", () => {
    expect(removeQueryParam("https://x.test/?a=1&utm=ig", "utm")).toBe(
      "https://x.test/?a=1"
    );
  });

  test("returns input unchanged when the key is absent", () => {
    const u = "https://x.test/?a=1";
    expect(removeQueryParam(u, "missing")).toBe(u);
  });

  test("returns input unchanged when there is no query", () => {
    const u = "https://x.test/p";
    expect(removeQueryParam(u, "any")).toBe(u);
  });

  test("strips the '?' when removing the only param", () => {
    expect(removeQueryParam("https://x.test/?only=1", "only")).toBe(
      "https://x.test/"
    );
  });

  test("removes every occurrence when the key is duplicated", () => {
    expect(removeQueryParam("https://x.test/?a=1&a=2&b=3", "a")).toBe(
      "https://x.test/?b=3"
    );
  });

  test("preserves the fragment", () => {
    expect(removeQueryParam("https://x.test/?a=1#frag", "a")).toBe(
      "https://x.test/#frag"
    );
  });

  test("caches that an unencoded query cannot match decoded fallbacks", () => {
    const url = "https://example.com/?longfield=1&otherlong=2";
    expect(setQueryParams(url, { missing: null, absent: null })).toBe(url);
  });

  test("tracks matches beyond the 32-key seen mask", () => {
    const params = Object.fromEntries(
      Array.from({ length: 33 }, (_, i) => [`key-${i}`, null])
    );
    expect(setQueryParams("https://example.com/?key-32=old", params)).toBe(
      "https://example.com/"
    );
  });
});

describe("removeQueryParams", () => {
  test("removes every listed key in a single pass", () => {
    expect(
      removeQueryParams(
        "https://x.test/?q=hi&utm_source=ig&utm_campaign=spring&page=2",
        ["utm_source", "utm_campaign"]
      )
    ).toBe("https://x.test/?q=hi&page=2");
  });

  test("removes an empty parameter name", () => {
    expect(
      removeQueryParams("https://x.test/?=value&a=1", ["", "missing"])
    ).toBe("https://x.test/?a=1");
  });

  test("returns input unchanged when keys is empty", () => {
    const u = "https://x.test/?a=1";
    expect(removeQueryParams(u, [])).toBe(u);
  });

  test("returns input unchanged when there is no query", () => {
    const u = "https://x.test/p";
    expect(removeQueryParams(u, ["a", "b"])).toBe(u);
  });

  test("strips the '?' when every param is removed", () => {
    expect(removeQueryParams("https://x.test/?a=1&b=2", ["a", "b"])).toBe(
      "https://x.test/"
    );
  });

  test("removes every duplicate occurrence of a listed key", () => {
    expect(removeQueryParams("https://x.test/?a=1&a=2&b=3&a=4", ["a"])).toBe(
      "https://x.test/?b=3"
    );
  });

  test("preserves the fragment", () => {
    expect(removeQueryParams("https://x.test/?a=1&b=2#frag", ["a"])).toBe(
      "https://x.test/?b=2#frag"
    );
  });

  test("does not match keys that are prefixes of other params", () => {
    expect(removeQueryParams("https://x.test/?abc=1&ab=2", ["ab"])).toBe(
      "https://x.test/?abc=1"
    );
  });

  test("matches decoded URL key against plain user key (WHATWG)", () => {
    // URL "a+b" decodes to "a b" — matches user key "a b".
    expect(removeQueryParams("https://x.test/?a+b=1&c=2", ["a b"])).toBe(
      "https://x.test/?c=2"
    );
    // URL "a%2Bb" decodes to "a+b" — matches user key "a+b" (ambiguous).
    expect(removeQueryParams("https://x.test/?a%2Bb=1&c=2", ["a+b"])).toBe(
      "https://x.test/?c=2"
    );
  });

  test("returns the input when none of the bulk keys match", () => {
    const url = "https://x.test/?a=1&b=2";
    expect(removeQueryParams(url, ["missing", "other"])).toBe(url);
  });

  test("rejects ambiguous byte matches while removing another field", () => {
    expect(
      removeQueryParams("https://x.test/?a%20b=1&q=2", ["a%20b", "q"])
    ).toBe("https://x.test/?a%20b=1");
  });
});

describe("ambiguous readQueryParam keys", () => {
  test("reads malformed literal keys with and without values", () => {
    expect(readQueryParam("https://x.test/?%ZZ", "%ZZ")).toBe("");
    expect(readQueryParam("https://x.test/?%ZZ=value", "%ZZ")).toBe("value");
  });

  test("returns null when an unencoded query cannot match", () => {
    expect(readQueryParam("https://x.test/?plain=value", "%ZZ")).toBeNull();
  });
});

describe("WHATWG-decoded key matching", () => {
  describe("readQueryParam — decoded keys", () => {
    test("matches percent-encoded URL key against plain user key", () => {
      expect(readQueryParam("https://x.test/?weird%20key=v", "weird key")).toBe(
        "v"
      );
    });

    test("matches '+' URL key against space user key", () => {
      expect(readQueryParam("https://x.test/?a+b=v", "a b")).toBe("v");
    });

    test("matches UTF-8 encoded URL key", () => {
      expect(readQueryParam("https://x.test/?caf%C3%A9=v", "café")).toBe("v");
    });

    test("matches astral codepoint URL key", () => {
      // 🌟 = U+1F31F = %F0%9F%8C%9F
      expect(readQueryParam("https://x.test/?%F0%9F%8C%9F=v", "🌟")).toBe("v");
    });

    test("still returns null when no encoding can rescue a miss", () => {
      expect(readQueryParam("https://x.test/?foo=v", "bar")).toBeNull();
    });

    test("rejects ambiguous-user-key false positives (WHATWG semantics)", () => {
      // User key has literal '%20'. URL key bytes match but decode to "a b".
      // WHATWG would NOT consider this a match — and neither should we.
      expect(readQueryParam("https://x.test/?a%20b=v", "a%20b")).toBeNull();
      expect(readQueryParam("https://x.test/?a+b=v", "a+b")).toBeNull();
    });

    test("matches when URL is double-encoded to user's encoded key", () => {
      // URL "a%2520b" decodes to "a%20b" — match for user key "a%20b".
      expect(readQueryParam("https://x.test/?a%2520b=v", "a%20b")).toBe("v");
    });
  });

  describe("readQueryParams — decoded keys", () => {
    test("mixed batch of byte-strict and decoded keys", () => {
      expect(
        readQueryParams("https://x.test/?caf%C3%A9=fr&q=hi&weird+key=ok", [
          "q",
          "café",
          "weird key",
          "missing",
        ])
      ).toEqual(["hi", "fr", "ok", null]);
    });
  });

  describe("hasQueryParam — decoded keys", () => {
    test("returns true for percent-encoded URL key + plain user key", () => {
      expect(hasQueryParam("https://x.test/?weird%20key=v", "weird key")).toBe(
        true
      );
    });
    test("returns true for '+' URL key + space user key", () => {
      expect(hasQueryParam("https://x.test/?a+b=v", "a b")).toBe(true);
    });
    test("returns false for ambiguous-user-key false positive", () => {
      expect(hasQueryParam("https://x.test/?a%20b=v", "a%20b")).toBe(false);
    });
  });

  describe("queryParamEquals — decoded keys", () => {
    test("matches encoded key + checks value WHATWG-style", () => {
      expect(
        queryParamEquals("https://x.test/?weird%20key=hi", "weird key", "hi")
      ).toBe(true);
      expect(
        queryParamEquals(
          "https://x.test/?weird%20key=hi+world",
          "weird key",
          "hi world"
        )
      ).toBe(true);
    });
  });

  describe("setQueryParam — decoded keys", () => {
    test("replaces an encoded key (preserving URL's original encoding)", () => {
      // The URL author chose to encode the key as %20; we keep that and just
      // swap the value. Output: URL prefix + reformatted "key=value" pair.
      // Our setter writes `key` literally as given by the caller, so the
      // result uses the caller's representation ("weird key" with literal space).
      // This is WHATWG-correct serialization for a fresh URLSearchParams.
      expect(
        setQueryParam("https://x.test/?weird%20key=old", "weird key", "new")
      ).toBe("https://x.test/?weird+key=new");
    });

    test("removes encoded-key duplicates on replace", () => {
      // First match (either byte-equal or decoded) gets replaced; the rest
      // are dropped.
      expect(
        setQueryParam(
          "https://x.test/?weird%20key=a&weird+key=b&q=keep",
          "weird key",
          "z"
        )
      ).toBe("https://x.test/?weird+key=z&q=keep");
    });

    test("does not match ambiguous user key against literal byte form", () => {
      // User key has literal '%20' (3 chars: %, 2, 0). URL byte-equal but
      // decodes differently ("a%20b" decodes to "a b" ≠ "a%20b"). We must
      // NOT replace; we append, and the appended key is WHATWG-serialized
      // ("a%20b" → "a%2520b" because '%' gets percent-encoded as %25).
      expect(setQueryParam("https://x.test/?a%20b=old", "a%20b", "new")).toBe(
        "https://x.test/?a%20b=old&a%2520b=new"
      );
    });
  });

  describe("setQueryParams — decoded keys", () => {
    test("bulk replacement crossing encoded and byte keys", () => {
      // Replacement reuses the user key encoded via WHATWG rules
      // (café → caf%C3%A9), matching what URLSearchParams.toString() emits.
      expect(
        setQueryParams("https://x.test/?caf%C3%A9=fr&q=old", {
          café: "FR",
          q: "new",
        })
      ).toBe("https://x.test/?caf%C3%A9=FR&q=new");
    });
  });

  describe("cross-consistency vs URLSearchParams.get", () => {
    const fixtures: Array<[string, string]> = [
      ["https://x.test/?weird%20key=v", "weird key"],
      ["https://x.test/?a+b=value", "a b"],
      ["https://x.test/?caf%C3%A9=hi", "café"],
      ["https://x.test/?%F0%9F%8C%9F=star", "🌟"],
      ["https://x.test/?plain=ok", "plain"],
      ["https://x.test/?plain=ok", "missing"],
      // Ambiguous-user-key edge cases
      ["https://x.test/?a%20b=v", "a%20b"], // null (decoded URL key is "a b")
      ["https://x.test/?a+b=v", "a+b"], // null
      ["https://x.test/?a%2520b=v", "a%20b"], // "v" (URL decodes to "a%20b")
    ];

    for (const [u, k] of fixtures) {
      test(`${u} + "${k}" matches URLSearchParams.get`, () => {
        const ours = readQueryParam(u, k);
        const native = new URL(u).searchParams.get(k);
        expect(ours).toBe(native);
      });
    }
  });
});
