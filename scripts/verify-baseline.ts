import { deepStrictEqual } from "node:assert/strict";
import { join, resolve } from "node:path";
import * as candidate from "../src/index.js";
import { findKeyMatch } from "../src/internal.js";

const baselineRoot = process.env.URLENS_BENCH_BASELINE;
if (!baselineRoot) {
  throw new Error("Set URLENS_BENCH_BASELINE to a baseline checkout");
}
const baseline: typeof candidate = await import(
  join(resolve(baselineRoot), "src/index.ts")
);
const baselineInternal: typeof import("../src/internal.js") = await import(
  join(resolve(baselineRoot), "src/internal.ts")
);

let seed = 123456789;
let comparisons = 0;
function pick<T>(values: readonly T[]): T {
  seed = (Math.imul(seed, 1664525) + 1013904223) | 0;
  return values[(seed >>> 8) % values.length];
}

function equal(actual: unknown, expected: unknown, input: unknown): void {
  comparisons++;
  try {
    deepStrictEqual(actual, expected);
  } catch (cause) {
    throw new Error(`Baseline mismatch for ${JSON.stringify(input)}`, {
      cause,
    });
  }
}

const fields = [
  "",
  "a",
  "b=1",
  "a=2",
  "a=3",
  "a=b=c",
  "=empty",
  "%ZZ=value",
  "a+b=space",
  "%61=encoded",
  "caf%C3%A9=%FF",
  "%=percent",
  "%FF=bad",
  "☕=tea",
];
const keys = ["", "a", "b", "%ZZ", "a b", "café", "�", "%", "☕", "missing"];

for (let sample = 0; sample < 25000; sample++) {
  const parts: string[] = [];
  const count = pick([0, 1, 2, 3, 4, 8, 16, 32]);
  for (let field = 0; field < count; field++) {
    parts.push(pick(fields));
  }
  const url = `/path?${parts.join("&")}${pick(["", "#outside=a&b=2", "#?a=wrong"])}`;
  const key = pick(keys);
  const value = pick(["updated", "a b", "%FF", "", null]);
  const batch = [pick(keys), pick(keys), pick(keys)];
  const params = { [key]: value, [pick(keys)]: "new" };
  const input = { url, key, value, batch, params };
  equal(
    candidate.setQueryParam(url, key, value),
    baseline.setQueryParam(url, key, value),
    input
  );
  equal(
    candidate.setQueryParams(url, params),
    baseline.setQueryParams(url, params),
    input
  );
  equal(
    candidate.removeQueryParams(url, batch),
    baseline.removeQueryParams(url, batch),
    input
  );
  equal(
    candidate.readQueryParams(url, batch),
    baseline.readQueryParams(url, batch),
    input
  );
  equal(
    candidate.readQueryParams(url, batch.slice(0, 2)),
    baseline.readQueryParams(url, batch.slice(0, 2)),
    input
  );
  equal(
    candidate.view(url).queryParams(batch),
    baseline.view(url).queryParams(batch),
    input
  );
  equal(
    candidate.readQueryParam(url, key),
    baseline.readQueryParam(url, key),
    input
  );
  equal(
    candidate.hasQueryParam(url, key),
    baseline.hasQueryParam(url, key),
    input
  );
  equal(
    candidate.queryParamEquals(url, key, value ?? ""),
    baseline.queryParamEquals(url, key, value ?? ""),
    input
  );
  equal(
    candidate.view(url).queryParam(key),
    baseline.view(url).queryParam(key),
    input
  );
  equal(
    candidate.view(url).hasQueryParam(key),
    baseline.view(url).hasQueryParam(key),
    input
  );
  equal(
    candidate.view(url).queryParamEquals(key, value ?? ""),
    baseline.view(url).queryParamEquals(key, value ?? ""),
    input
  );
}

const choices = ["", "a=1", "q=old", "q", "=empty"];
for (let code = 0; code < 3125; code++) {
  let remainder = code;
  const parts: string[] = [];
  for (let field = 0; field < 5; field++) {
    parts.push(choices[remainder % 5]);
    remainder = Math.floor(remainder / 5);
  }
  const url = `/?${parts.join("&")}#q=outside`;
  for (const key of ["q", "missing", ""]) {
    for (const value of ["new", null]) {
      equal(
        candidate.setQueryParam(url, key, value),
        baseline.setQueryParam(url, key, value),
        { url, key, value }
      );
    }
  }
}

for (let sample = 0; sample < 3000; sample++) {
  const parts: string[] = [];
  const count = pick([0, 1, 5, 17, 40, 80]);
  for (let field = 0; field < count; field++) {
    parts.push(pick(fields));
  }
  const url = `/path?${parts.join("&")}#outside=a&b=2`;
  const requested = Array.from(
    { length: pick([33, 64, 129]) },
    (_, index) => `missing-key-${index}`
  );
  requested[pick([0, 5, 17, 25])] = pick(keys);
  requested[pick([1, 6, 18, 26])] = pick(keys);
  requested[pick([2, 7, 19, 27])] = pick(keys);
  equal(
    candidate.removeQueryParams(url, requested),
    baseline.removeQueryParams(url, requested),
    { url, requested }
  );
}

const alphabet = "ab&?=";
const searchKeys = ["a", "aa", "ab", "?", "?a", "a?", "a?a", "b", "x"];
for (let code = 0; code < 78125; code++) {
  let remainder = code;
  let raw = "?";
  for (let field = 0; field < 7; field++) {
    raw += alphabet[remainder % 5];
    remainder = Math.floor(remainder / 5);
  }
  for (const key of searchKeys) {
    equal(
      findKeyMatch(raw, 1, raw.length, key),
      baselineInternal.findKeyMatch(raw, 1, raw.length, key),
      { raw, key }
    );
  }
}

console.log(
  `${comparisons.toLocaleString("en-US")} deterministic baseline comparisons passed (seed 123456789).`
);
