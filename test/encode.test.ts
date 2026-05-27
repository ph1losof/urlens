import { describe, expect, test } from "bun:test";
import { decodeQueryComponent } from "../src/decode.js";
import { encodeQueryComponent } from "../src/encode.js";

describe("encodeQueryComponent", () => {
  test("returns empty string for empty input", () => {
    expect(encodeQueryComponent("")).toBe("");
  });

  test("returns ASCII strings in the WHATWG safe set verbatim", () => {
    // The WHATWG application/x-www-form-urlencoded safe set is exactly:
    // * - . _ 0-9 A-Z a-z
    expect(encodeQueryComponent("hello")).toBe("hello");
    expect(encodeQueryComponent("abc-DEF_123.*")).toBe("abc-DEF_123.*");
  });

  test("escapes the WHATWG-specific chars that encodeURIComponent leaves alone", () => {
    // ! ' ( ) ~ are passed through by encodeURIComponent but escaped by WHATWG.
    expect(encodeQueryComponent("hi!")).toBe("hi%21");
    expect(encodeQueryComponent("it's")).toBe("it%27s");
    expect(encodeQueryComponent("(x)")).toBe("%28x%29");
    expect(encodeQueryComponent("~user")).toBe("%7Euser");
    expect(encodeQueryComponent("a!b'c(d)e~f")).toBe("a%21b%27c%28d%29e%7Ef");
  });

  test("encodes spaces as +", () => {
    expect(encodeQueryComponent("hello world")).toBe("hello+world");
    expect(encodeQueryComponent("  ")).toBe("++");
  });

  test("percent-encodes reserved characters", () => {
    expect(encodeQueryComponent("a&b")).toBe("a%26b");
    expect(encodeQueryComponent("a=b")).toBe("a%3Db");
    expect(encodeQueryComponent("a#b")).toBe("a%23b");
    expect(encodeQueryComponent("a?b")).toBe("a%3Fb");
  });

  test("percent-encodes UTF-8", () => {
    expect(encodeQueryComponent("café")).toBe("caf%C3%A9");
    expect(encodeQueryComponent("☕")).toBe("%E2%98%95");
    expect(encodeQueryComponent("中文")).toBe("%E4%B8%AD%E6%96%87");
  });

  test("roundtrips with decodeQueryComponent", () => {
    const cases = [
      "hello world",
      "café ☕",
      "100% off",
      "中文 текст",
      "a=b&c=d",
      "",
    ];
    for (const original of cases) {
      expect(decodeQueryComponent(encodeQueryComponent(original))).toBe(
        original
      );
    }
  });
});
