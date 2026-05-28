// Cross-engine benchmark harness. Bundled by bench/driver.ts via Bun.build
// (IIFE, target=browser) and eval'd inside Playwright pages (V8/SM/JSC).
//
// The driver injects `globalThis.print` to capture output into an array.
// `URL`, `URLSearchParams`, `performance.now`, and `navigator.userAgent` are
// browser globals provided by the Playwright page context.
//
// All functions under test are imported from ../src/index.js — single source
// of truth. The previous hand-translated copy in bench/bench.js drifted from
// src/ silently; this file does not.

import {
  hasScheme as _hasScheme,
  hasQueryParam,
  originMatches,
  pathnameStartsWith,
  queryParamEquals,
  readFragment,
  readHost,
  readHostname,
  readOrigin,
  readPathname,
  readPort,
  readQuery,
  readQueryParam,
  readQueryParams,
  readScheme,
  removeQueryParam,
  removeQueryParams,
  setPathname,
  setPort,
  setQueryParam,
  view,
} from "../src/index.js";

// Engine-provided globals — declared loosely since tsconfig has lib: ["ESNext"]
// (no DOM lib).
declare const URL: {
  new (
    input: string,
    base?: string
  ): {
    pathname: string;
    origin: string;
    protocol: string;
    host: string;
    hostname: string;
    port: string;
    hash: string;
    search: string;
    searchParams: {
      get(key: string): string | null;
      has(key: string): boolean;
      set(key: string, value: string): void;
      delete(key: string): void;
      toString(): string;
    };
    toString(): string;
  };
};
declare const URLSearchParams: {
  new (init: string): { get(key: string): string | null };
};
declare const navigator: { userAgent?: string };
declare const print: ((s: string) => void) | undefined;

const out =
  typeof print === "function"
    ? print
    : (s: string): void => {
        console.log(s);
      };

const hasURL = typeof URL !== "undefined";
const hasURLSearchParams = typeof URLSearchParams !== "undefined";

// Reference once so biome doesn't flag the import as unused — keeps `hasScheme`
// in the bundle for future cases without re-editing the import list.
void _hasScheme;

// --- fixtures ----------------------------------------------------------------
//
// To defeat aggressive constant-folding in modern JITs (JSC FTL / SpiderMonkey
// Warp will inline pure functions over constant string args and elide the call
// entirely), each case rotates through 8 similar-shape inputs via a counter
// the optimizer can't see through. Power of two so we can mask with `& 7`.

let IDX = 0;
const MASK = 7;

function ring(arr: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < 8; i++) {
    out.push(arr[i % arr.length]);
  }
  return out;
}

const FIX = {
  plainQuery: ring([
    "https://example.com/search?q=hello+world&utm_source=newsletter&page=2",
    "https://example.org/find?q=widgets&utm_source=ad&page=1",
    "https://a.test/s?q=apple+pie&utm_source=email&page=4",
    "https://b.test/search?q=tea&utm_source=tw&page=3",
    "https://c.test/s?q=banana&utm_source=ig&page=7",
    "https://d.test/q?q=red+fox&utm_source=rss&page=2",
    "https://e.test/s?q=mango&utm_source=fb&page=5",
    "https://f.test/search?q=cherry&utm_source=yt&page=6",
  ]),
  encodedQuery: ring([
    "https://example.com/search?q=caf%C3%A9%20%E2%98%95&lang=fr-FR&from=home",
    "https://example.com/s?q=na%C3%AFve%20resum%C3%A9&lang=fr-CA&from=app",
    "https://example.com/x?q=%E4%B8%AD%E6%96%87&lang=zh-CN&from=link",
    "https://example.com/y?q=%D0%BF%D1%80%D0%B8%D0%B2%D0%B5%D1%82&lang=ru-RU&from=src",
    "https://example.com/z?q=%E3%81%93%E3%82%93&lang=ja-JP&from=app",
    "https://example.com/a?q=%E0%A4%A8%E0%A4%AE&lang=hi-IN&from=ad",
    "https://example.com/b?q=%CE%B1%CE%B2%CE%B3&lang=el-GR&from=email",
    "https://example.com/c?q=%D8%B9%D8%B1%D8%A8%D9%8A&lang=ar-SA&from=home",
  ]),
  malformedQuery: ring([
    "https://example.com/x?q=100%25+off&bad=%ZZ%G1&u=https%3A%2F%2Fa.b%2Fc",
    "https://example.com/x?q=50%25+sale&bad=%QQ%XX&u=https%3A%2F%2Fb.b%2Fd",
    "https://example.com/x?q=20%25+disc&bad=%--%++&u=https%3A%2F%2Fc.b%2Fe",
    "https://example.com/x?q=10%25+save&bad=%@@%!!&u=https%3A%2F%2Fd.b%2Ff",
    "https://example.com/x?q=05%25+off2&bad=%ZZ%G2&u=https%3A%2F%2Fe.b%2Fg",
    "https://example.com/x?q=25%25+yes&bad=%YY%G3&u=https%3A%2F%2Ff.b%2Fh",
    "https://example.com/x?q=40%25+now&bad=%XX%G4&u=https%3A%2F%2Fg.b%2Fi",
    "https://example.com/x?q=60%25+max&bad=%WW%G5&u=https%3A%2F%2Fh.b%2Fj",
  ]),
  longQuery: ring([
    "https://example.com/api/v1/list?a=1&b=2&c=3&d=4&e=5&f=6&g=7&h=8&i=9&j=10&k=11&q=needle&z=last",
    "https://example.com/api/v2/find?a=1&b=2&c=3&d=4&e=5&f=6&g=7&h=8&i=9&j=10&k=11&q=apple&z=end",
    "https://example.com/api/v1/q?a=1&b=2&c=3&d=4&e=5&f=6&g=7&h=8&i=9&j=10&k=11&q=banana&z=fin",
    "https://example.com/api/v3/s?a=1&b=2&c=3&d=4&e=5&f=6&g=7&h=8&i=9&j=10&k=11&q=cherry&z=stop",
    "https://example.com/api/v1/g?a=1&b=2&c=3&d=4&e=5&f=6&g=7&h=8&i=9&j=10&k=11&q=date&z=halt",
    "https://example.com/api/v4/h?a=1&b=2&c=3&d=4&e=5&f=6&g=7&h=8&i=9&j=10&k=11&q=elder&z=done",
    "https://example.com/api/v2/p?a=1&b=2&c=3&d=4&e=5&f=6&g=7&h=8&i=9&j=10&k=11&q=fig&z=fini",
    "https://example.com/api/v1/r?a=1&b=2&c=3&d=4&e=5&f=6&g=7&h=8&i=9&j=10&k=11&q=grape&z=last",
  ]),
  twoKeyQuery: ring([
    "https://example.com/r?q=hello%20world&t=duck&utm_source=x&utm_campaign=y",
    "https://example.com/r?q=foo%20bar&t=goog&utm_source=a&utm_campaign=b",
    "https://example.com/r?q=red%20fox&t=bing&utm_source=c&utm_campaign=d",
    "https://example.com/r?q=blue%20jay&t=ddg&utm_source=e&utm_campaign=f",
    "https://example.com/r?q=tea%20pot&t=kagi&utm_source=g&utm_campaign=h",
    "https://example.com/r?q=ice%20cube&t=brv&utm_source=i&utm_campaign=j",
    "https://example.com/r?q=warm%20day&t=yan&utm_source=k&utm_campaign=l",
    "https://example.com/r?q=cold%20cup&t=pre&utm_source=m&utm_campaign=n",
  ]),
  pathOnly: ring([
    "/api/v1/users/42",
    "/api/v1/users/17",
    "/api/v2/items/108",
    "/api/v1/orders/9001",
    "/api/v3/posts/12",
    "/api/v1/teams/77",
    "/api/v2/users/55",
    "/api/v4/files/3",
  ]),
  fullUrl: ring([
    "https://example.com/api/v1/users/42?x=1#frag",
    "https://example.org/api/v1/users/17?x=2#a",
    "https://a.test/api/v2/items/108?y=3#b",
    "https://b.test/api/v1/orders/9001?z=4#c",
    "https://c.test/api/v3/posts/12?w=5#d",
    "https://d.test/api/v1/teams/77?v=6#e",
    "https://e.test/api/v2/users/55?u=7#f",
    "https://f.test/api/v4/files/3?t=8#g",
  ]),
  hostUrl: ring([
    "https://user:pass@example.com:8080/api?q=1",
    "https://u@example.org:443/path",
    "https://api.example.com:9000/route",
    "https://x.test:3000/v1",
    "https://y.test/v2",
    "https://z.test:8443/v3",
    "https://w.test:5000/v4",
    "https://q.test:65535/v5",
  ]),
  // Plain query but the looked-up key is NOT present (miss path).
  missQuery: ring([
    "https://example.com/?a=1&b=2&c=3",
    "https://example.org/?a=4&b=5&c=6",
    "https://a.test/?a=7&b=8&c=9",
    "https://b.test/?a=10&b=11&c=12",
    "https://c.test/?a=13&b=14&c=15",
    "https://d.test/?a=16&b=17&c=18",
    "https://e.test/?a=19&b=20&c=21",
    "https://f.test/?a=22&b=23&c=24",
  ]),
  // Encoded URL key — exercises pass 2 (WHATWG-decoded fallback). The user
  // key passed to readQueryParam is "weird key" with a literal space.
  decodedKeyQuery: ring([
    "https://example.com/?weird%20key=v1&utm=a",
    "https://example.org/?weird%20key=v2&utm=b",
    "https://a.test/?weird%20key=v3&utm=c",
    "https://b.test/?weird%20key=v4&utm=d",
    "https://c.test/?weird%20key=v5&utm=e",
    "https://d.test/?weird%20key=v6&utm=f",
    "https://e.test/?weird%20key=v7&utm=g",
    "https://f.test/?weird%20key=v8&utm=h",
  ]),
};

function nextIdx(): number {
  IDX = (IDX + 1) & MASK;
  return IDX;
}

// --- harness -----------------------------------------------------------------

// performance.now() gives sub-millisecond resolution in all three target
// engines (V8, SpiderMonkey, JSC).
const now: () => number =
  typeof performance !== "undefined" && typeof performance.now === "function"
    ? (): number => performance.now()
    : (): number => Date.now();

interface BenchResult {
  name: string;
  ops: number;
  perSec: number;
}

// Sink is module-level so engines can't dead-code-eliminate the work.
let SINK = 0;

// fallow-ignore-next-line complexity
function bench(name: string, fn: () => void, budgetMs: number): BenchResult {
  // Warmup: a longer window (up to 200ms) gives TurboFan / Warp / FTL the
  // headroom to tier up the inner function before the measurement window
  // opens, which tightens variance noticeably on the heavier setters.
  const warmEnd = now() + Math.max(200, budgetMs / 4);
  while (now() < warmEnd) {
    for (let i = 0; i < 256; i++) {
      fn();
    }
  }

  // measure: count ops over the budget, in batches to amortize timer cost.
  // Use the actual elapsed time so the reported ops/sec reflects the work
  // the runtime really did, not the requested budget.
  let ops = 0;
  const start = now();
  const deadline = start + budgetMs;
  while (now() < deadline) {
    for (let j = 0; j < 1024; j++) {
      fn();
    }
    ops += 1024;
  }
  const elapsed = now() - start;
  return { name, ops, perSec: (ops / elapsed) * 1000 };
}

function fmt(n: number): string {
  if (n >= 1e9) {
    return `${(n / 1e9).toFixed(2)}G`;
  }
  if (n >= 1e6) {
    return `${(n / 1e6).toFixed(2)}M`;
  }
  if (n >= 1e3) {
    return `${(n / 1e3).toFixed(2)}K`;
  }
  return n.toFixed(0);
}

function pad(s: string | number, n: number): string {
  let r = String(s);
  while (r.length < n) {
    r += " ";
  }
  return r;
}

// --- cases -------------------------------------------------------------------

interface Case {
  name: string;
  fn: () => void;
}
const cases: Case[] = [];

function add(name: string, fn: () => void): void {
  cases.push({ name, fn });
}

// readQueryParam — plain ASCII (fast path)
add("rq.plain", () => {
  const u = FIX.plainQuery[nextIdx()];
  SINK = (SINK + (readQueryParam(u, "q") || "").length) | 0;
});
if (hasURL) {
  add("URL.plain", () => {
    const u = FIX.plainQuery[nextIdx()];
    SINK = (SINK + (new URL(u).searchParams.get("q") || "").length) | 0;
  });
}
if (hasURLSearchParams) {
  add("URLSP.plain", () => {
    const u = FIX.plainQuery[nextIdx()];
    const q = u.split("?")[1];
    SINK = (SINK + (new URLSearchParams(q).get("q") || "").length) | 0;
  });
}

// readQueryParam — percent-encoded
add("rq.encoded", () => {
  const u = FIX.encodedQuery[nextIdx()];
  SINK = (SINK + (readQueryParam(u, "q") || "").length) | 0;
});
if (hasURL) {
  add("URL.encoded", () => {
    const u = FIX.encodedQuery[nextIdx()];
    SINK = (SINK + (new URL(u).searchParams.get("q") || "").length) | 0;
  });
}

// readQueryParam — malformed (tolerant fallback)
add("rq.malformed", () => {
  const u = FIX.malformedQuery[nextIdx()];
  SINK = (SINK + (readQueryParam(u, "bad") || "").length) | 0;
});
// Native URL throws on bad %, so no fair native comparison here.

// readQueryParam — long query, key near end
add("rq.long", () => {
  const u = FIX.longQuery[nextIdx()];
  SINK = (SINK + (readQueryParam(u, "q") || "").length) | 0;
});
if (hasURL) {
  add("URL.long", () => {
    const u = FIX.longQuery[nextIdx()];
    SINK = (SINK + (new URL(u).searchParams.get("q") || "").length) | 0;
  });
}

// readQueryParam — miss path (key absent). Exercises queryHasEncoding probe.
add("rq.miss", () => {
  const u = FIX.missQuery[nextIdx()];
  const v = readQueryParam(u, "missing");
  SINK = (SINK + (v === null ? 0 : v.length)) | 0;
});
if (hasURL) {
  add("URL.miss", () => {
    const u = FIX.missQuery[nextIdx()];
    const v = new URL(u).searchParams.get("missing");
    SINK = (SINK + (v === null ? 0 : v.length)) | 0;
  });
}

// readQueryParam — decoded-key fallback path (URL key is percent-encoded;
// user passes the decoded form). Exercises pass 2 with compareDecodedValueRange.
add("rq.decoded_key", () => {
  const u = FIX.decodedKeyQuery[nextIdx()];
  SINK = (SINK + (readQueryParam(u, "weird key") || "").length) | 0;
});
if (hasURL) {
  add("URL.decoded_key", () => {
    const u = FIX.decodedKeyQuery[nextIdx()];
    SINK = (SINK + (new URL(u).searchParams.get("weird key") || "").length) | 0;
  });
}

// readQueryParams (N-key) vs N separate URL lookups
const TWO_KEYS = ["q", "utm_source"] as const;
add("rqs.two", () => {
  const u = FIX.twoKeyQuery[nextIdx()];
  const r = readQueryParams(u, TWO_KEYS);
  SINK = (SINK + ((r[0] || "").length + (r[1] || "").length)) | 0;
});
if (hasURL) {
  add("URL.two", () => {
    const u = FIX.twoKeyQuery[nextIdx()];
    const sp = new URL(u).searchParams;
    SINK =
      (SINK +
        ((sp.get("q") || "").length + (sp.get("utm_source") || "").length)) |
      0;
  });
}

const FOUR_KEYS = ["q", "t", "utm_source", "utm_campaign"] as const;
// fallow-ignore-next-line complexity
add("rqs.four", () => {
  const u = FIX.twoKeyQuery[nextIdx()];
  const r = readQueryParams(u, FOUR_KEYS);
  SINK =
    (SINK +
      ((r[0] || "").length +
        (r[1] || "").length +
        (r[2] || "").length +
        (r[3] || "").length)) |
    0;
});
if (hasURL) {
  // fallow-ignore-next-line complexity
  add("URL.four", () => {
    const u = FIX.twoKeyQuery[nextIdx()];
    const sp = new URL(u).searchParams;
    SINK =
      (SINK +
        ((sp.get("q") || "").length +
          (sp.get("t") || "").length +
          (sp.get("utm_source") || "").length +
          (sp.get("utm_campaign") || "").length)) |
      0;
  });
}

// readPathname vs new URL(url).pathname
add("rp.full", () => {
  const u = FIX.fullUrl[nextIdx()];
  SINK = (SINK + readPathname(u).length) | 0;
});
if (hasURL) {
  add("URL.pathname", () => {
    const u = FIX.fullUrl[nextIdx()];
    SINK = (SINK + new URL(u).pathname.length) | 0;
  });
}

// readPathname on a pathname-only input — URL can't do this without a base.
add("rp.pathOnly", () => {
  const u = FIX.pathOnly[nextIdx()];
  SINK = (SINK + readPathname(u).length) | 0;
});
if (hasURL) {
  add("URL.pathOnly", () => {
    const u = FIX.pathOnly[nextIdx()];
    SINK = (SINK + new URL(u, "http://x").pathname.length) | 0;
  });
}

// readOrigin
add("ro.full", () => {
  const u = FIX.fullUrl[nextIdx()];
  SINK = (SINK + readOrigin(u).length) | 0;
});
if (hasURL) {
  add("URL.origin", () => {
    const u = FIX.fullUrl[nextIdx()];
    SINK = (SINK + new URL(u).origin.length) | 0;
  });
}

// readScheme
add("rs.full", () => {
  const u = FIX.hostUrl[nextIdx()];
  SINK = (SINK + readScheme(u).length) | 0;
});
if (hasURL) {
  add("URL.protocol", () => {
    const u = FIX.hostUrl[nextIdx()];
    SINK = (SINK + new URL(u).protocol.length) | 0;
  });
}

// readHost
add("rh.full", () => {
  const u = FIX.hostUrl[nextIdx()];
  SINK = (SINK + readHost(u).length) | 0;
});
if (hasURL) {
  add("URL.host", () => {
    const u = FIX.hostUrl[nextIdx()];
    SINK = (SINK + new URL(u).host.length) | 0;
  });
}

// readHostname
add("rhn.full", () => {
  const u = FIX.hostUrl[nextIdx()];
  SINK = (SINK + readHostname(u).length) | 0;
});
if (hasURL) {
  add("URL.hostname", () => {
    const u = FIX.hostUrl[nextIdx()];
    SINK = (SINK + new URL(u).hostname.length) | 0;
  });
}

// readPort
add("rport.full", () => {
  const u = FIX.hostUrl[nextIdx()];
  const p = readPort(u);
  SINK = (SINK + (p === null ? 0 : p)) | 0;
});
if (hasURL) {
  add("URL.port", () => {
    const u = FIX.hostUrl[nextIdx()];
    const p = new URL(u).port;
    SINK = (SINK + (p.length === 0 ? 0 : Number(p))) | 0;
  });
}

// setQueryParam: replace
add("sq.replace", () => {
  const u = FIX.plainQuery[nextIdx()];
  SINK = (SINK + setQueryParam(u, "q", "updated").length) | 0;
});
if (hasURL) {
  add("URL.sq.replace", () => {
    const u = FIX.plainQuery[nextIdx()];
    const parsed = new URL(u);
    parsed.searchParams.set("q", "updated");
    SINK = (SINK + parsed.toString().length) | 0;
  });
}

// setQueryParam: append
add("sq.append", () => {
  const u = FIX.plainQuery[nextIdx()];
  SINK = (SINK + setQueryParam(u, "added", "1").length) | 0;
});
if (hasURL) {
  add("URL.sq.append", () => {
    const u = FIX.plainQuery[nextIdx()];
    const parsed = new URL(u);
    parsed.searchParams.set("added", "1");
    SINK = (SINK + parsed.toString().length) | 0;
  });
}

// setQueryParam: delete
add("sq.delete", () => {
  const u = FIX.plainQuery[nextIdx()];
  SINK = (SINK + setQueryParam(u, "q", null).length) | 0;
});
if (hasURL) {
  add("URL.sq.delete", () => {
    const u = FIX.plainQuery[nextIdx()];
    const parsed = new URL(u);
    parsed.searchParams.delete("q");
    SINK = (SINK + parsed.toString().length) | 0;
  });
}

// setPathname: replace
add("sp.replace", () => {
  const u = FIX.fullUrl[nextIdx()];
  SINK = (SINK + setPathname(u, "/v2/items").length) | 0;
});
if (hasURL) {
  add("URL.sp.replace", () => {
    const u = FIX.fullUrl[nextIdx()];
    const parsed = new URL(u);
    parsed.pathname = "/v2/items";
    SINK = (SINK + parsed.toString().length) | 0;
  });
}

// hasQueryParam vs URLSearchParams.has
add("hq.full", () => {
  const u = FIX.plainQuery[nextIdx()];
  SINK = (SINK + (hasQueryParam(u, "q") ? 1 : 0)) | 0;
});
if (hasURL) {
  add("URL.has", () => {
    const u = FIX.plainQuery[nextIdx()];
    SINK = (SINK + (new URL(u).searchParams.has("q") ? 1 : 0)) | 0;
  });
}

// queryParamEquals ASCII fast path vs URL.searchParams.get === ...
add("qpe.ascii", () => {
  const u = FIX.plainQuery[nextIdx()];
  SINK = (SINK + (queryParamEquals(u, "page", "2") ? 1 : 0)) | 0;
});
if (hasURL) {
  add("URL.qpe.ascii", () => {
    const u = FIX.plainQuery[nextIdx()];
    SINK = (SINK + (new URL(u).searchParams.get("page") === "2" ? 1 : 0)) | 0;
  });
}

// pathnameStartsWith vs URL.pathname.startsWith
add("pss.full", () => {
  const u = FIX.fullUrl[nextIdx()];
  SINK = (SINK + (pathnameStartsWith(u, "/api") ? 1 : 0)) | 0;
});
if (hasURL) {
  add("URL.startsWith", () => {
    const u = FIX.fullUrl[nextIdx()];
    SINK = (SINK + (new URL(u).pathname.startsWith("/api") ? 1 : 0)) | 0;
  });
}

// originMatches vs new URL().origin === new URL().origin
const ORIGIN_FIX_A = FIX.hostUrl;
const ORIGIN_FIX_B = FIX.fullUrl;
add("om.full", () => {
  const i = nextIdx();
  SINK = (SINK + (originMatches(ORIGIN_FIX_A[i], ORIGIN_FIX_B[i]) ? 1 : 0)) | 0;
});
if (hasURL) {
  add("URL.origin.eq", () => {
    const i = nextIdx();
    SINK =
      (SINK +
        (new URL(ORIGIN_FIX_A[i]).origin === new URL(ORIGIN_FIX_B[i]).origin
          ? 1
          : 0)) |
      0;
  });
}

// readFragment vs URL.hash (native includes the leading '#')
add("rfrag.full", () => {
  const u = FIX.fullUrl[nextIdx()];
  SINK = (SINK + readFragment(u).length) | 0;
});
if (hasURL) {
  add("URL.hash", () => {
    const u = FIX.fullUrl[nextIdx()];
    SINK = (SINK + new URL(u).hash.length) | 0;
  });
}

// setPort vs URL.port = ...; toString()
add("sp.port.set", () => {
  const u = FIX.hostUrl[nextIdx()];
  SINK = (SINK + setPort(u, 9000).length) | 0;
});
if (hasURL) {
  add("URL.port.set", () => {
    const u = FIX.hostUrl[nextIdx()];
    const p = new URL(u);
    p.port = "9000";
    SINK = (SINK + p.toString().length) | 0;
  });
}

// view.read1: single read through view() — allocates UrlView. Expected to be
// slower than flat readPathname; establishes the wrapper breakeven.
add("view.read1", () => {
  const u = FIX.fullUrl[nextIdx()];
  SINK = (SINK + view(u).pathname().length) | 0;
});

// view.read5: five reads off a single view() — one scan, then cached offsets.
add("view.read5", () => {
  const u = FIX.fullUrl[nextIdx()];
  const v = view(u);
  SINK =
    (SINK +
      v.scheme().length +
      v.host().length +
      (v.port() || 0) +
      v.pathname().length +
      v.query().length) |
    0;
});

add("urlens.flat5", () => {
  const u = FIX.fullUrl[nextIdx()];
  SINK =
    (SINK +
      readScheme(u).length +
      readHost(u).length +
      (readPort(u) || 0) +
      readPathname(u).length +
      readQuery(u).length) |
    0;
});

if (hasURL) {
  add("URL.read5", () => {
    const u = FIX.fullUrl[nextIdx()];
    const p = new URL(u);
    SINK =
      (SINK +
        p.protocol.length +
        p.host.length +
        (p.port ? +p.port : 0) +
        p.pathname.length +
        p.search.length) |
      0;
  });
}

// view.qp1: single query read through view().
add("view.qp1", () => {
  const u = FIX.plainQuery[nextIdx()];
  SINK = (SINK + (view(u).queryParam("q") || "").length) | 0;
});

// view.qp.batch: two-key batched read via view().queryParams() object form.
const VIEW_TWO_KEYS = ["q", "utm_source"] as const;
add("view.qp.batch", () => {
  const u = FIX.twoKeyQuery[nextIdx()];
  const r = view(u).queryParams(VIEW_TWO_KEYS);
  SINK = (SINK + ((r.q || "").length + (r.utm_source || "").length)) | 0;
});

// rqp.remove1: sanity check that removeQueryParam alias matches setQueryParam.
add("rqp.remove1", () => {
  const u = FIX.plainQuery[nextIdx()];
  SINK = (SINK + removeQueryParam(u, "utm_source").length) | 0;
});

// rqp.removeN: bulk removal via removeQueryParams (single pass).
const REMOVE_KEYS = ["utm_source", "page"];
add("rqp.removeN", () => {
  const u = FIX.plainQuery[nextIdx()];
  SINK = (SINK + removeQueryParams(u, REMOVE_KEYS).length) | 0;
});

// rqp.removeN.seq: same as rqp.removeN but via N sequential setQueryParam(...null)
// calls — proves the bulk form wins for N≥2.
add("rqp.removeN.seq", () => {
  const u = FIX.plainQuery[nextIdx()];
  let s = setQueryParam(u, "utm_source", null);
  s = setQueryParam(s, "page", null);
  SINK = (SINK + s.length) | 0;
});

// --- run ---------------------------------------------------------------------

const BUDGET = 600;
const engineLabel = navigator?.userAgent ?? "unknown";
out(`engine=${engineLabel}`);
out(`budget=${BUDGET}ms per case`);
out("");
out(`${pad("case", 18)}${pad("ops/sec", 14)}ops`);

const results: BenchResult[] = [];
for (const c of cases) {
  const r = bench(c.name, c.fn, BUDGET);
  results.push(r);
  out(`${pad(r.name, 18)}${pad(`${fmt(r.perSec)}/s`, 14)}${String(r.ops)}`);
}

function findPerSec(name: string): number | null {
  for (const r of results) {
    if (r.name === name) {
      return r.perSec;
    }
  }
  return null;
}

out("");
out("--- speedup over native (higher = faster than native) ---");
const pairs: Array<[string, string]> = [
  ["rq.plain", "URL.plain"],
  ["rq.plain", "URLSP.plain"],
  ["rq.encoded", "URL.encoded"],
  ["rq.long", "URL.long"],
  ["rq.miss", "URL.miss"],
  ["rq.decoded_key", "URL.decoded_key"],
  ["rqs.two", "URL.two"],
  ["rqs.four", "URL.four"],
  ["rp.full", "URL.pathname"],
  ["rp.pathOnly", "URL.pathOnly"],
  ["ro.full", "URL.origin"],
  ["rs.full", "URL.protocol"],
  ["rh.full", "URL.host"],
  ["rhn.full", "URL.hostname"],
  ["rport.full", "URL.port"],
  ["sq.replace", "URL.sq.replace"],
  ["sq.append", "URL.sq.append"],
  ["sq.delete", "URL.sq.delete"],
  ["sp.replace", "URL.sp.replace"],
  ["hq.full", "URL.has"],
  ["qpe.ascii", "URL.qpe.ascii"],
  ["pss.full", "URL.startsWith"],
  ["om.full", "URL.origin.eq"],
  ["rfrag.full", "URL.hash"],
  ["sp.port.set", "URL.port.set"],
  // view() wrapper:
  ["view.read1", "rp.full"],
  ["view.read5", "urlens.flat5"],
  ["view.read5", "URL.read5"],
  ["view.qp1", "rq.plain"],
  ["view.qp.batch", "rqs.two"],
  // remove* aliases:
  ["rqp.remove1", "sq.delete"],
  ["rqp.removeN", "rqp.removeN.seq"],
];
for (const [ours, theirs] of pairs) {
  const a = findPerSec(ours);
  const b = findPerSec(theirs);
  if (a !== null && b !== null) {
    out(`${pad(`${ours} vs ${theirs}`, 32)}${(a / b).toFixed(2)}x`);
  }
}

out(`\nSINK=${SINK} (prevents DCE)`);
