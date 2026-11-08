import { deepStrictEqual } from "node:assert/strict";
import { join, resolve } from "node:path";
import type * as Api from "../src/index.js";

type API = typeof Api;
const baselineRoot = process.env.URLENS_BENCH_BASELINE;
if (!baselineRoot) {
  throw new Error("Set URLENS_BENCH_BASELINE to a baseline checkout");
}
const baseline: API = await import(join(resolve(baselineRoot), "src/index.ts"));
const candidate: API = await import(
  join(resolve(process.env.URLENS_BENCH_CANDIDATE ?? "."), "src/index.ts")
);
let seed = 987654321;
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
    throw new Error(`Component mismatch: ${JSON.stringify(input)}`, { cause });
  }
}

const schemes = [
  "",
  "https://",
  "http://",
  "HTTPS://",
  "ws://",
  "ftp://",
  "custom+1://",
  "1bad://",
  "a.b-c+1://",
];
const authorities = [
  "",
  "x",
  "example.test",
  "EXAMPLE.test",
  "user:pass@x",
  "a:b@c:d@x",
  "[::1]",
  "[::1]:8080",
  "[broken",
  "[bad]tail",
  "a".repeat(256),
  "@".repeat(256),
  ":".repeat(256),
  "[".repeat(256),
];
const ports = [
  "",
  ":",
  ":0",
  ":0000",
  ":80",
  ":443",
  ":8080",
  ":65535",
  ":99999",
  ":abc",
  ":1e3",
  ":8a80",
  ":+443",
  ":-123",
  ":１２３４",
  `:${"9".repeat(400)}`,
];
const tails = [
  "",
  "/",
  "/api/a",
  "/a#b?c#d",
  "?q=/path#?end",
  "#?q=a/b",
  "?q=1#end",
  `/?q=${"payload".repeat(1000)}`,
  `/${"path/".repeat(1000)}?q=1`,
  "/?q=#first#last",
  "/#first?query#last",
];
const otherUrls = [
  "https://example.test/",
  "https://example.test:443/",
  "HTTP://EXAMPLE.test:80/",
  "ftp://[::1]:21/",
  "/relative",
  "https://x:abc/",
];
const originEqual = (api: API, a: string, b: string): boolean =>
  (
    api.rawOriginsEqual ??
    (api as API & { originMatches: API["rawOriginsEqual"] }).originMatches
  )(a, b);

for (let sample = 0; sample < 15000; sample++) {
  const url = pick(schemes) + pick(authorities) + pick(ports) + pick(tails);
  for (const name of [
    "readOrigin",
    "readHost",
    "readHostname",
    "readPort",
    "readPathname",
    "readScheme",
    "readFragment",
    "stripFragment",
  ] as const) {
    equal(candidate[name](url), baseline[name](url), { url, name });
  }
  const actual = candidate.view(url);
  const expected = baseline.view(url);
  for (const name of [
    "origin",
    "host",
    "hostname",
    "port",
    "pathname",
    "scheme",
    "fragment",
    "toString",
  ] as const) {
    equal(actual[name](), expected[name](), { url, name });
  }
  const prefix = pick(["", "/", "/api", "a", "#", "?", "path"]);
  equal(
    candidate.pathnameStartsWith(url, prefix),
    baseline.pathnameStartsWith(url, prefix),
    { url, prefix }
  );
  equal(
    candidate.pathnameEndsWith(url, prefix),
    baseline.pathnameEndsWith(url, prefix),
    { url, prefix }
  );
  const scheme = pick([
    "",
    "https",
    "HTTPS",
    "ftp",
    "other",
    "custom+1",
    "a.b-c+1",
  ]);
  equal(candidate.hasScheme(url, scheme), baseline.hasScheme(url, scheme), {
    url,
    scheme,
  });
  const port = pick([null, 0, 80, 443, 8080, 65535]);
  equal(candidate.setPort(url, port), baseline.setPort(url, port), {
    url,
    port,
  });
  equal(candidate.setPathname(url, prefix), baseline.setPathname(url, prefix), {
    url,
    prefix,
  });
  equal(candidate.setScheme(url, scheme), baseline.setScheme(url, scheme), {
    url,
    scheme,
  });
  equal(originEqual(candidate, url, url), originEqual(baseline, url, url), {
    url,
  });
  const other = pick(otherUrls);
  equal(originEqual(candidate, url, other), originEqual(baseline, url, other), {
    url,
    other,
  });
}

// Control characters can collide with valid punctuation/digits under a blind
// ASCII bit mask. Compare every ASCII continuation against the old predicate.
for (const scheme of ["a+", "a-", "a.", "a0", "https", "CUSTOM+1"]) {
  const url = `${scheme}://x/`;
  for (let code = 0; code < 128; code++) {
    const expected = scheme.slice(0, -1) + String.fromCharCode(code);
    equal(
      candidate.hasScheme(url, expected),
      baseline.hasScheme(url, expected),
      { url, expected }
    );
  }
}

for (let code = 0; code <= 0xffff; code++) {
  const value = String.fromCharCode(code);
  equal(
    candidate.encodeQueryComponent(value),
    baseline.encodeQueryComponent(value),
    { code }
  );
}
const units = [
  "a",
  " ",
  "&",
  "=",
  "%",
  "é",
  "П",
  "☕",
  "中",
  "\ud800",
  "\udbff",
  "\udc00",
  "\udfff",
  "🌟",
];
for (let sample = 0; sample < 10000; sample++) {
  let value = "";
  const length = pick([0, 1, 2, 4, 16, 64, 256]);
  for (let i = 0; i < length; i++) {
    value += pick(units);
  }
  equal(
    candidate.encodeQueryComponent(value),
    baseline.encodeQueryComponent(value),
    { value }
  );
  const reference = new URLSearchParams([["q", value]]).toString().slice(2);
  equal(candidate.encodeQueryComponent(value), reference, { value });
}
console.log(
  `${comparisons.toLocaleString()} component/encoding comparisons passed (seed 987654321)`
);
