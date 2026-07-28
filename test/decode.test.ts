import { describe, expect, test } from "bun:test";
import { decodeQueryComponent } from "../src/decode.js";

describe("decodeQueryComponent", () => {
  test("returns input verbatim when there is nothing to decode", () => {
    expect(decodeQueryComponent("hello-world")).toBe("hello-world");
    expect(decodeQueryComponent("")).toBe("");
  });

  test("converts + to space when there is no percent encoding", () => {
    expect(decodeQueryComponent("hello+world+again")).toBe("hello world again");
  });

  test("decodes percent-encoded ASCII", () => {
    expect(decodeQueryComponent("a%20b")).toBe("a b");
    expect(decodeQueryComponent("100%25")).toBe("100%");
  });

  test("decodes percent-encoded UTF-8 multi-byte sequences", () => {
    expect(decodeQueryComponent("caf%C3%A9")).toBe("café");
    expect(decodeQueryComponent("%E2%98%95")).toBe("☕");
    expect(decodeQueryComponent("%E4%B8%AD%E6%96%87")).toBe("中文");
  });

  test("decodes mixed + and percent encoding", () => {
    expect(decodeQueryComponent("hello+%E2%98%95+world")).toBe(
      "hello ☕ world"
    );
  });

  test("tolerates malformed percent escapes by preserving them literally", () => {
    expect(decodeQueryComponent("%ZZ")).toBe("%ZZ");
    expect(decodeQueryComponent("%G1")).toBe("%G1");
    expect(decodeQueryComponent("%2Aok%ZZ")).toBe("*ok%ZZ");
  });

  test("tolerates a truncated percent at the end of input", () => {
    expect(decodeQueryComponent("ok%")).toBe("ok%");
    expect(decodeQueryComponent("ok%A")).toBe("ok%A");
  });

  test("reconstructs UTF-8 across adjacent valid escapes when one is malformed", () => {
    // The first three bytes form ☕; the trailing %ZZ stays literal.
    expect(decodeQueryComponent("%E2%98%95%ZZ")).toBe("☕%ZZ");
  });

  test("grows the tolerant byte buffer for long encoded runs", () => {
    expect(decodeQueryComponent(`${"%41".repeat(100)}%ZZ`)).toBe(
      `${"A".repeat(100)}%ZZ`
    );
  });

  test("handles + adjacent to valid UTF-8 escapes", () => {
    expect(decodeQueryComponent("+%C3%A9+")).toBe(" é ");
  });
});
