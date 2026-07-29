import { describe, expect, test } from "bun:test";
import {
  compareDecodedValueRange,
  queryParamDecodedFallback,
} from "../src/query-scan.js";

function compare(encoded: string, expected: string): boolean {
  return compareDecodedValueRange(encoded, 0, encoded.length, expected);
}

describe("decoded query byte comparison", () => {
  test("matches truncated and malformed multi-byte UTF-8 like TextDecoder", () => {
    expect(compare("%E2%GG", "�%GG")).toBe(true);
    expect(compare("%E2%82", "�")).toBe(true);
    expect(compare("%F0", "�")).toBe(true);
    expect(compare("%F0%80", "��")).toBe(true);
    expect(compare("%F1%80", "�")).toBe(true);
    expect(compare("%F1%80%80", "�")).toBe(true);
  });

  test("rejects incomplete and mismatched expected surrogate pairs", () => {
    expect(compare("%F0%9F%8C%9F", "\uD83C")).toBe(false);
    expect(compare("%F0%9F%8C%9F", "\uD83C\uDFFF")).toBe(false);
  });

  test("returns an empty value for a decoded bare field", () => {
    const raw = "?weird%20key";
    expect(queryParamDecodedFallback(raw, 1, raw.length, "weird key", 9)).toBe(
      ""
    );
  });
});
