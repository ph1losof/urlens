// @ts-expect-error -- ab-driver resolves this specifier to the baseline worktree.
import * as baselineModule from "urlens-baseline";
// @ts-expect-error -- ab-driver resolves this specifier to the candidate worktree.
import * as candidateModule from "urlens-candidate";
import type { view } from "../src/index.js";

interface Api {
  hasQueryParam(url: string, key: string): boolean;
  queryParamEquals(url: string, key: string, expected: string): boolean;
  rawOriginsEqual(a: string, b: string): boolean;
  readPathname(url: string): string;
  readPort(url: string): number | null;
  readQueryParam(url: string, key: string): string | null;
  readQueryParams(
    url: string,
    keys: readonly string[]
  ): readonly (string | null)[];
  setPathname(url: string, pathname: string): string;
  setScheme(url: string, scheme: string): string;
  view: typeof view;
}
type BenchFn = () => void;

interface BenchCase {
  name: string;
  baseline: BenchFn;
  candidate: BenchFn;
}

interface BenchGlobals {
  URLENS_BENCH_BUDGET?: number;
  URLENS_BENCH_FILTER?: string;
  URLENS_BENCH_INVERT?: boolean;
  URLENS_BENCH_ROUNDS?: number;
  URLENS_BENCH_SILENT?: boolean;
}

const benchGlobals = globalThis as typeof globalThis & BenchGlobals;
function normalizeApi(module: object): Api {
  const source = module as Api & {
    originMatches?: (a: string, b: string) => boolean;
  };
  const rawOriginsEqual = source.rawOriginsEqual ?? source.originMatches;
  if (rawOriginsEqual === undefined) {
    throw new Error("origin comparison export is missing");
  }
  return {
    hasQueryParam: source.hasQueryParam,
    queryParamEquals: source.queryParamEquals,
    rawOriginsEqual,
    readPathname: source.readPathname,
    readPort: source.readPort,
    readQueryParam: source.readQueryParam,
    readQueryParams: source.readQueryParams,
    setPathname: source.setPathname,
    setScheme: source.setScheme,
    view: source.view,
  };
}

const baseline = normalizeApi(
  benchGlobals.URLENS_BENCH_INVERT ? candidateModule : baselineModule
);
const candidate = normalizeApi(
  benchGlobals.URLENS_BENCH_INVERT ? baselineModule : candidateModule
);
const budget = benchGlobals.URLENS_BENCH_BUDGET ?? 300;
const filter = benchGlobals.URLENS_BENCH_FILTER ?? "";
const rounds = benchGlobals.URLENS_BENCH_ROUNDS ?? 7;
const cases: BenchCase[] = [];

const FULL_URLS = [
  "https://example.com/api/v1/users?q=hello#top",
  "https://api.example.org/items/42?sort=asc#details",
  "https://cdn.example.net/assets/app.js?v=3#load",
  "https://docs.example.com/guide/start?lang=en#intro",
  "https://shop.example.org/products/7?ref=home#buy",
  "https://status.example.net/incidents/latest?zone=eu#summary",
  "https://blog.example.com/posts/performance?draft=0#comments",
  "https://auth.example.org/callback?code=abc#done",
];
const COMPLEX_URLS = [
  "https://user:pass@example.com:8080/api?q=1#frag",
  "https://[2001:db8::1]:8443/items?q=2#part",
  "https://example.org?direct=1#frag",
  "https://example.net#fragment?not-query",
  "/relative/path?q=3#frag",
  "https://user@example.test/deep/path?q=4",
  "https://[::1]/health#ready",
  "https://example.com:9000/metrics",
];
const QUERY_URLS = [
  "https://x.test/?q=alpha&utm_source=one&page=1&lang=en",
  "https://x.test/?q=bravo&utm_source=two&page=2&lang=fr",
  "https://x.test/?q=charlie&utm_source=three&page=3&lang=de",
  "https://x.test/?q=delta&utm_source=four&page=4&lang=es",
  "https://x.test/?q=echo&utm_source=five&page=5&lang=it",
  "https://x.test/?q=foxtrot&utm_source=six&page=6&lang=pt",
  "https://x.test/?q=golf&utm_source=seven&page=7&lang=nl",
  "https://x.test/?q=hotel&utm_source=eight&page=8&lang=sv",
];
const ENCODED_QUERY_URLS = QUERY_URLS.map(
  (url, index) => `${url}&encoded%20key=${index}&value=hello+world`
);
const NO_QUERY_URLS = FULL_URLS.map((url) => url.slice(0, url.indexOf("?")));
const BARE_QUERY_URLS = QUERY_URLS.map(
  (_, index) =>
    `https://x.test/?a&b&c&d&e&f&g&h&i&j&k&l&m&n&o&p&%ZZ=value-${index}`
);
const TWO_KEYS = ["q", "utm_source"] as const;
const DUPLICATE_KEYS = ["q", "q"] as const;
const THREE_KEYS = ["q", "utm_source", "lang"] as const;

let position = 0;
let sink = 0;

function next<T>(values: readonly T[]): T {
  const value = values[position & 7];
  position++;
  return value;
}

function add(name: string, baselineFn: BenchFn, candidateFn: BenchFn): void {
  cases.push({ name, baseline: baselineFn, candidate: candidateFn });
}

function componentCases(api: Api): Record<string, BenchFn> {
  const retained = COMPLEX_URLS.map((url) => api.view(url));
  const escaped = new Array<ReturnType<Api["view"]>>(4096);
  return {
    constructEscape: () => {
      const value = api.view(next(COMPLEX_URLS));
      escaped[position & 4095] = value;
      sink = (sink + value.toString().length) | 0;
    },
    read1: () => {
      sink = (sink + api.view(next(FULL_URLS)).pathname().length) | 0;
    },
    read5: () => {
      const value = api.view(next(COMPLEX_URLS));
      sink =
        (sink +
          value.scheme().length +
          value.host().length +
          (value.port() ?? 0) +
          value.pathname().length +
          value.fragment().length) |
        0;
    },
    retainedRead5: () => {
      const value = next(retained);
      sink =
        (sink +
          value.scheme().length +
          value.host().length +
          (value.port() ?? 0) +
          value.pathname().length +
          value.fragment().length) |
        0;
    },
    retainedPort: () => {
      sink = (sink + (next(retained).port() ?? 0)) | 0;
    },
    retainedFragment: () => {
      sink = (sink + next(retained).fragment().length) | 0;
    },
  };
}

function queryCases(api: Api): Record<string, BenchFn> {
  const retainedPlain = QUERY_URLS.map((url) => api.view(url));
  const retainedEncoded = ENCODED_QUERY_URLS.map((url) => api.view(url));
  const retainedBare = BARE_QUERY_URLS.map((url) => api.view(url));
  const escaped = new Array<unknown>(4096);
  return {
    one: () => {
      const result = api.view(next(QUERY_URLS)).queryParams(["q"] as const);
      escaped[position & 4095] = result;
      sink = (sink + (result.q?.length ?? 0)) | 0;
    },
    two: () => {
      const result = api.view(next(QUERY_URLS)).queryParams(TWO_KEYS);
      escaped[position & 4095] = result;
      sink =
        (sink + (result.q?.length ?? 0) + (result.utm_source?.length ?? 0)) | 0;
    },
    twoNoQuery: () => {
      const result = api.view(next(NO_QUERY_URLS)).queryParams(TWO_KEYS);
      escaped[position & 4095] = result;
      sink =
        (sink + (result.q?.length ?? 0) + (result.utm_source?.length ?? 0)) | 0;
    },
    duplicate: () => {
      const result = api.view(next(QUERY_URLS)).queryParams(DUPLICATE_KEYS);
      escaped[position & 4095] = result;
      sink = (sink + (result.q?.length ?? 0)) | 0;
    },
    three: () => {
      const result = api.view(next(QUERY_URLS)).queryParams(THREE_KEYS);
      escaped[position & 4095] = result;
      sink =
        (sink +
          (result.q?.length ?? 0) +
          (result.utm_source?.length ?? 0) +
          (result.lang?.length ?? 0)) |
        0;
    },
    miss: () => {
      sink =
        (sink +
          (api.view(next(ENCODED_QUERY_URLS)).queryParam("missing")?.length ??
            0)) |
        0;
    },
    retainedHit: () => {
      sink =
        (sink + (next(retainedPlain).queryParam("utm_source")?.length ?? 0)) |
        0;
    },
    retainedMiss: () => {
      sink =
        (sink + (next(retainedPlain).queryParam("missing")?.length ?? 0)) | 0;
    },
    retainedEncodedMiss: () => {
      sink =
        (sink + (next(retainedEncoded).queryParam("missing")?.length ?? 0)) | 0;
    },
    retainedEqualsMiss: () => {
      sink =
        (sink +
          (next(retainedPlain).queryParamEquals("missing", "value") ? 1 : 0)) |
        0;
    },
    retainedHasMiss: () => {
      sink =
        (sink + (next(retainedPlain).hasQueryParam("missing") ? 1 : 0)) | 0;
    },
    retainedBareAmbiguous: () => {
      sink = (sink + (next(retainedBare).queryParam("%ZZ")?.length ?? 0)) | 0;
    },
    retainedAmbiguousMiss: () => {
      sink =
        (sink + (next(retainedEncoded).queryParam("%ZZ")?.length ?? 0)) | 0;
    },
    retainedBareBatch: () => {
      const result = next(retainedBare).queryParams([
        "%ZZ",
        "missing",
        "other",
      ] as const);
      escaped[position & 4095] = result;
      sink = (sink + (result["%ZZ"]?.length ?? 0)) | 0;
    },
  };
}

function flatCases(api: Api): Record<string, BenchFn> {
  const {
    hasQueryParam,
    queryParamEquals,
    rawOriginsEqual,
    readPathname,
    readPort,
    readQueryParam,
    readQueryParams,
    setPathname,
    setScheme,
  } = api;
  const escaped = new Array<unknown>(4096);
  return {
    equals: () => {
      sink =
        (sink +
          (queryParamEquals(next(QUERY_URLS), "utm_source", "four") ? 1 : 0)) |
        0;
    },
    has: () => {
      sink =
        (sink + (hasQueryParam(next(QUERY_URLS), "utm_source") ? 1 : 0)) | 0;
    },
    origins: () => {
      const url = next(COMPLEX_URLS);
      sink = (sink + (rawOriginsEqual(url, url) ? 1 : 0)) | 0;
    },
    pathname: () => {
      sink = (sink + readPathname(next(FULL_URLS)).length) | 0;
    },
    port: () => {
      sink = (sink + (readPort(next(COMPLEX_URLS)) ?? 0)) | 0;
    },
    queryBatch2: () => {
      const result = readQueryParams(next(QUERY_URLS), TWO_KEYS);
      escaped[position & 4095] = result;
      sink = (sink + (result[0]?.length ?? 0) + (result[1]?.length ?? 0)) | 0;
    },
    queryBatch3: () => {
      const result = readQueryParams(next(QUERY_URLS), THREE_KEYS);
      escaped[position & 4095] = result;
      sink =
        (sink +
          (result[0]?.length ?? 0) +
          (result[1]?.length ?? 0) +
          (result[2]?.length ?? 0)) |
        0;
    },
    queryHit: () => {
      sink =
        (sink + (readQueryParam(next(QUERY_URLS), "utm_source")?.length ?? 0)) |
        0;
    },
    queryMiss: () => {
      sink =
        (sink + (readQueryParam(next(QUERY_URLS), "missing")?.length ?? 0)) | 0;
    },
    setPathname: () => {
      const result = setPathname(next(FULL_URLS), "/updated/path");
      escaped[position & 4095] = result;
      sink = (sink + result.length) | 0;
    },
    setScheme: () => {
      const result = setScheme(next(FULL_URLS), "http");
      escaped[position & 4095] = result;
      sink = (sink + result.length) | 0;
    },
  };
}

const baselineComponents = componentCases(baseline);
const candidateComponents = componentCases(candidate);
const baselineQueries = queryCases(baseline);
const candidateQueries = queryCases(candidate);
const baselineFlat = flatCases(baseline);
const candidateFlat = flatCases(candidate);

add(
  "view.construct.escape",
  baselineComponents.constructEscape,
  candidateComponents.constructEscape
);
add("view.read1", baselineComponents.read1, candidateComponents.read1);
add("view.read5", baselineComponents.read5, candidateComponents.read5);
add(
  "view.retain.read5",
  baselineComponents.retainedRead5,
  candidateComponents.retainedRead5
);
add(
  "view.retain.port",
  baselineComponents.retainedPort,
  candidateComponents.retainedPort
);
add(
  "view.retain.fragment",
  baselineComponents.retainedFragment,
  candidateComponents.retainedFragment
);
add("view.query.one", baselineQueries.one, candidateQueries.one);
add("view.query.two", baselineQueries.two, candidateQueries.two);
add(
  "view.query.two.noquery",
  baselineQueries.twoNoQuery,
  candidateQueries.twoNoQuery
);
add(
  "view.query.duplicate",
  baselineQueries.duplicate,
  candidateQueries.duplicate
);
add("view.query.three", baselineQueries.three, candidateQueries.three);
add("view.query.miss", baselineQueries.miss, candidateQueries.miss);
add(
  "view.query.retain.hit",
  baselineQueries.retainedHit,
  candidateQueries.retainedHit
);
add(
  "view.query.retain.miss",
  baselineQueries.retainedMiss,
  candidateQueries.retainedMiss
);
add(
  "view.query.retain.encmiss",
  baselineQueries.retainedEncodedMiss,
  candidateQueries.retainedEncodedMiss
);
add(
  "view.has.retain.miss",
  baselineQueries.retainedHasMiss,
  candidateQueries.retainedHasMiss
);
add(
  "view.equals.retain.miss",
  baselineQueries.retainedEqualsMiss,
  candidateQueries.retainedEqualsMiss
);
add(
  "view.query.bare.ambiguous",
  baselineQueries.retainedBareAmbiguous,
  candidateQueries.retainedBareAmbiguous
);
add(
  "view.query.ambiguous.miss",
  baselineQueries.retainedAmbiguousMiss,
  candidateQueries.retainedAmbiguousMiss
);
add(
  "view.query.bare.batch",
  baselineQueries.retainedBareBatch,
  candidateQueries.retainedBareBatch
);
add("flat.query.hit", baselineFlat.queryHit, candidateFlat.queryHit);
add("flat.query.miss", baselineFlat.queryMiss, candidateFlat.queryMiss);
add("flat.query.batch2", baselineFlat.queryBatch2, candidateFlat.queryBatch2);
add("flat.query.batch3", baselineFlat.queryBatch3, candidateFlat.queryBatch3);
add("flat.has", baselineFlat.has, candidateFlat.has);
add("flat.equals", baselineFlat.equals, candidateFlat.equals);
add("flat.pathname", baselineFlat.pathname, candidateFlat.pathname);
add("flat.port", baselineFlat.port, candidateFlat.port);
add("flat.origins", baselineFlat.origins, candidateFlat.origins);
add("flat.set.pathname", baselineFlat.setPathname, candidateFlat.setPathname);
add("flat.set.scheme", baselineFlat.setScheme, candidateFlat.setScheme);

function warm(fn: BenchFn, duration: number): void {
  position = 0;
  const warmEnd = performance.now() + duration;
  while (performance.now() < warmEnd) {
    for (let i = 0; i < 1024; i++) {
      fn();
    }
  }
}

function runFor(fn: BenchFn, duration: number): number {
  position = 0;
  const start = performance.now();
  const end = start + duration;
  let operations = 0;
  while (performance.now() < end) {
    for (let i = 0; i < 1024; i++) {
      fn();
    }
    operations += 1024;
  }
  return (operations * 1000) / (performance.now() - start);
}

function median(values: number[]): number {
  values.sort((a, b) => a - b);
  const middle = values.length >> 1;
  return values.length % 2 === 0
    ? (values[middle - 1] + values[middle]) / 2
    : values[middle];
}

function formatRate(value: number): string {
  return `${(value / 1_000_000).toFixed(2)}M/s`;
}

function pad(value: string, width: number): string {
  return value.padEnd(width);
}

function output(message: string): void {
  if (!benchGlobals.URLENS_BENCH_SILENT) {
    console.log(message);
  }
}

interface AbResult {
  baseline: number;
  candidate: number;
  name: string;
  ratio: number;
}

const results: AbResult[] = [];
output(`engine=${navigator.userAgent}`);
output(`budget=${budget}ms rounds=${rounds}`);
output(`${pad("case", 28)}${pad("baseline", 13)}${pad("candidate", 13)}delta`);

for (const benchCase of cases) {
  if (filter && !benchCase.name.startsWith(filter)) {
    continue;
  }
  const baselineRates: number[] = [];
  const candidateRates: number[] = [];
  const ratios: number[] = [];
  warm(benchCase.baseline, Math.min(200, budget));
  warm(benchCase.candidate, Math.min(200, budget));
  for (let round = 0; round < rounds; round++) {
    let baselineRate: number;
    let candidateRate: number;
    if ((round & 1) === 0) {
      baselineRate = runFor(benchCase.baseline, budget);
      candidateRate = runFor(benchCase.candidate, budget);
    } else {
      candidateRate = runFor(benchCase.candidate, budget);
      baselineRate = runFor(benchCase.baseline, budget);
    }
    baselineRates.push(baselineRate);
    candidateRates.push(candidateRate);
    ratios.push(candidateRate / baselineRate);
  }
  const baselineRate = median(baselineRates);
  const candidateRate = median(candidateRates);
  const ratio = median(ratios);
  results.push({
    baseline: baselineRate,
    candidate: candidateRate,
    name: benchCase.name,
    ratio,
  });
  output(
    `${pad(benchCase.name, 28)}${pad(formatRate(baselineRate), 13)}${pad(
      formatRate(candidateRate),
      13
    )}${ratio >= 1 ? "+" : ""}${((ratio - 1) * 100).toFixed(2)}%`
  );
}

Object.assign(globalThis, { URLENS_AB_RESULTS: results });
output(`SINK=${sink}`);
