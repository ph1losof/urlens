// Local micro-bench: compare current vs candidate fast-path approach for
// the hottest query helpers. Run with: bun bench/local.ts
//
// Not committed to bench/driver.ts — this is for tuning iteration only.

import { decodeRange } from "../src/decode.js";
import {
  hasQueryParam as currHas,
  queryParamEquals as currQpe,
  readQueryParam as currRead,
  readQueryParams as currReadN,
} from "../src/query.js";

// ---------------------------------------------------------------------------
// Candidate: indexOf + boundary check fast path for clean ASCII keys.
//
// One SIMD-vectorized indexOf(key) per scan iteration instead of per-field
// indexOf("&") + indexOf("=") + startsWith. Falls back to current logic for
// ambiguous keys and decoded-key matches.
// ---------------------------------------------------------------------------

const CH_QUESTION = 63;
const CH_HASH = 35;
const CH_AMP = 38;
const CH_EQ = 61;
const CH_PERCENT = 37;
const CH_PLUS = 43;

function keyIsAmbiguous(k: string): boolean {
  return k.indexOf("%") !== -1 || k.indexOf("+") !== -1;
}

function queryHasEncoding(s: string, start: number, end: number): boolean {
  const pct = s.indexOf("%", start);
  if (pct !== -1 && pct < end) return true;
  const plus = s.indexOf("+", start);
  return plus !== -1 && plus < end;
}

function fastHasQueryParam(rawUrl: string, key: string): boolean {
  const qPos = rawUrl.indexOf("?");
  if (qPos === -1) return false;
  const hPos = rawUrl.indexOf("#");
  if (hPos !== -1 && hPos < qPos) return false;
  const fragEnd = hPos === -1 ? rawUrl.length : hPos;

  if (keyIsAmbiguous(key)) {
    return currHas(rawUrl, key); // delegate
  }

  const keyLen = key.length;
  let pos = qPos + 1;
  while (pos < fragEnd) {
    const idx = rawUrl.indexOf(key, pos);
    if (idx === -1 || idx + keyLen > fragEnd) break;
    const prev = rawUrl.charCodeAt(idx - 1);
    if (prev === CH_QUESTION || prev === CH_AMP) {
      const after = idx + keyLen;
      if (after === fragEnd) return true;
      const next = rawUrl.charCodeAt(after);
      if (next === CH_EQ || next === CH_AMP) return true;
    }
    pos = idx + 1;
  }
  // Decoded-key fallback if URL has encoding.
  if (!queryHasEncoding(rawUrl, qPos + 1, fragEnd)) return false;
  return currHas(rawUrl, key); // rare path, delegate
}

function fastReadQueryParam(rawUrl: string, key: string): string | null {
  const qPos = rawUrl.indexOf("?");
  if (qPos === -1) return null;
  const hPos = rawUrl.indexOf("#");
  if (hPos !== -1 && hPos < qPos) return null;
  const fragEnd = hPos === -1 ? rawUrl.length : hPos;

  if (keyIsAmbiguous(key)) {
    return currRead(rawUrl, key);
  }

  const keyLen = key.length;
  let pos = qPos + 1;
  while (pos < fragEnd) {
    const idx = rawUrl.indexOf(key, pos);
    if (idx === -1 || idx + keyLen > fragEnd) break;
    const prev = rawUrl.charCodeAt(idx - 1);
    if (prev === CH_QUESTION || prev === CH_AMP) {
      const after = idx + keyLen;
      if (after === fragEnd) return "";
      const next = rawUrl.charCodeAt(after);
      if (next === CH_AMP) return "";
      if (next === CH_EQ) {
        // Value runs from `after + 1` to next '&' (or fragEnd).
        let amp = rawUrl.indexOf("&", after + 1);
        if (amp === -1 || amp > fragEnd) amp = fragEnd;
        return decodeRange(rawUrl, after + 1, amp);
      }
    }
    pos = idx + 1;
  }
  // Decoded-key fallback.
  if (!queryHasEncoding(rawUrl, qPos + 1, fragEnd)) return null;
  return currRead(rawUrl, key);
}

// ---------------------------------------------------------------------------
// harness
// ---------------------------------------------------------------------------

function bench(name: string, fn: () => void, budgetMs = 600): { name: string; perSec: number; ops: number } {
  const warmEnd = performance.now() + Math.max(200, budgetMs / 4);
  while (performance.now() < warmEnd) {
    for (let i = 0; i < 256; i++) fn();
  }
  let ops = 0;
  const start = performance.now();
  const deadline = start + budgetMs;
  while (performance.now() < deadline) {
    for (let j = 0; j < 1024; j++) fn();
    ops += 1024;
  }
  const elapsed = performance.now() - start;
  return { name, ops, perSec: (ops / elapsed) * 1000 };
}

const fmt = (n: number) =>
  n >= 1e9 ? (n / 1e9).toFixed(2) + "G" :
  n >= 1e6 ? (n / 1e6).toFixed(2) + "M" :
  n >= 1e3 ? (n / 1e3).toFixed(2) + "K" :
  n.toFixed(0);

const URLS_PLAIN = [
  "https://example.com/search?q=hello+world&utm_source=newsletter&page=2",
  "https://example.org/find?q=widgets&utm_source=ad&page=1",
  "https://a.test/s?q=apple+pie&utm_source=email&page=4",
  "https://b.test/search?q=tea&utm_source=tw&page=3",
  "https://c.test/s?q=banana&utm_source=ig&page=7",
  "https://d.test/q?q=red+fox&utm_source=rss&page=2",
  "https://e.test/s?q=mango&utm_source=fb&page=5",
  "https://f.test/search?q=cherry&utm_source=yt&page=6",
];
const URLS_LONG = [
  "https://example.com/api/v1/list?a=1&b=2&c=3&d=4&e=5&f=6&g=7&h=8&i=9&j=10&k=11&q=needle&z=last",
  "https://example.com/api/v2/find?a=1&b=2&c=3&d=4&e=5&f=6&g=7&h=8&i=9&j=10&k=11&q=apple&z=end",
  "https://example.com/api/v1/q?a=1&b=2&c=3&d=4&e=5&f=6&g=7&h=8&i=9&j=10&k=11&q=banana&z=fin",
  "https://example.com/api/v3/s?a=1&b=2&c=3&d=4&e=5&f=6&g=7&h=8&i=9&j=10&k=11&q=cherry&z=stop",
  "https://example.com/api/v1/g?a=1&b=2&c=3&d=4&e=5&f=6&g=7&h=8&i=9&j=10&k=11&q=date&z=halt",
  "https://example.com/api/v4/h?a=1&b=2&c=3&d=4&e=5&f=6&g=7&h=8&i=9&j=10&k=11&q=elder&z=done",
  "https://example.com/api/v2/p?a=1&b=2&c=3&d=4&e=5&f=6&g=7&h=8&i=9&j=10&k=11&q=fig&z=fini",
  "https://example.com/api/v1/r?a=1&b=2&c=3&d=4&e=5&f=6&g=7&h=8&i=9&j=10&k=11&q=grape&z=last",
];
const URLS_MISS = [
  "https://example.com/?a=1&b=2&c=3",
  "https://example.org/?a=4&b=5&c=6",
  "https://a.test/?a=7&b=8&c=9",
  "https://b.test/?a=10&b=11&c=12",
  "https://c.test/?a=13&b=14&c=15",
  "https://d.test/?a=16&b=17&c=18",
  "https://e.test/?a=19&b=20&c=21",
  "https://f.test/?a=22&b=23&c=24",
];

let IDX = 0;
const nextIdx = () => (IDX = (IDX + 1) & 7);

let SINK = 0;

const cases = [
  { name: "curr.has.plain", fn: () => { SINK = (SINK + (currHas(URLS_PLAIN[nextIdx()], "q") ? 1 : 0)) | 0; } },
  { name: "fast.has.plain", fn: () => { SINK = (SINK + (fastHasQueryParam(URLS_PLAIN[nextIdx()], "q") ? 1 : 0)) | 0; } },

  { name: "curr.has.long",  fn: () => { SINK = (SINK + (currHas(URLS_LONG[nextIdx()], "q") ? 1 : 0)) | 0; } },
  { name: "fast.has.long",  fn: () => { SINK = (SINK + (fastHasQueryParam(URLS_LONG[nextIdx()], "q") ? 1 : 0)) | 0; } },

  { name: "curr.has.miss",  fn: () => { SINK = (SINK + (currHas(URLS_MISS[nextIdx()], "missing") ? 1 : 0)) | 0; } },
  { name: "fast.has.miss",  fn: () => { SINK = (SINK + (fastHasQueryParam(URLS_MISS[nextIdx()], "missing") ? 1 : 0)) | 0; } },

  { name: "curr.read.plain", fn: () => { SINK = (SINK + (currRead(URLS_PLAIN[nextIdx()], "q") || "").length) | 0; } },
  { name: "fast.read.plain", fn: () => { SINK = (SINK + (fastReadQueryParam(URLS_PLAIN[nextIdx()], "q") || "").length) | 0; } },

  { name: "curr.read.long",  fn: () => { SINK = (SINK + (currRead(URLS_LONG[nextIdx()], "q") || "").length) | 0; } },
  { name: "fast.read.long",  fn: () => { SINK = (SINK + (fastReadQueryParam(URLS_LONG[nextIdx()], "q") || "").length) | 0; } },

  { name: "curr.read.miss",  fn: () => { const v = currRead(URLS_MISS[nextIdx()], "missing"); SINK = (SINK + (v === null ? 0 : v.length)) | 0; } },
  { name: "fast.read.miss",  fn: () => { const v = fastReadQueryParam(URLS_MISS[nextIdx()], "missing"); SINK = (SINK + (v === null ? 0 : v.length)) | 0; } },
];

console.log(`bun ${Bun.version}`);
console.log("");
console.log("case                 ops/sec       ops");
for (const c of cases) {
  const r = bench(c.name, c.fn, 600);
  console.log(c.name.padEnd(21) + (fmt(r.perSec) + "/s").padEnd(14) + r.ops);
}
console.log("SINK=" + SINK);
