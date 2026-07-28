import { describe, expect, test } from "bun:test";
import {
  defaultPortFor,
  findKeyMatch,
  findSchemeEnd,
  parsePortRange,
} from "../src/internal.js";

describe("internal URL scanners", () => {
  test("findSchemeEnd accepts lowercase continuation characters", () => {
    expect(findSchemeEnd("https://x.test")).toBe(5);
  });

  test("findKeyMatch accepts a later field at each valid boundary", () => {
    const bare = "?a=1&target";
    expect(findKeyMatch(bare, 1, bare.length, "target")).toBe(5);

    const valued = "?a=1&target=x";
    expect(findKeyMatch(valued, 1, valued.length, "target")).toBe(5);

    const prefixed = "?a=1&targeted=x&target=y";
    expect(findKeyMatch(prefixed, 1, prefixed.length, "target")).toBe(16);
  });

  test("defaultPortFor rejects lookalike special schemes", () => {
    expect(defaultPortFor("httpx://x.test", 5)).toBe(-1);
    expect(defaultPortFor("abc://x.test", 3)).toBe(-1);
    expect(defaultPortFor("ab://x.test", 2)).toBe(-1);
  });

  test("parsePortRange rejects an empty range", () => {
    expect(parsePortRange("", 0, 0)).toBe(-1);
  });
});
