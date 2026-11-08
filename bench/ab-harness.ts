// @ts-expect-error -- ab-driver resolves this specifier to the baseline worktree.
import * as baselineModule from "urlens-baseline";
// @ts-expect-error -- ab-driver resolves this specifier to the candidate worktree.
import * as candidateModule from "urlens-candidate";
import type { view } from "../src/index.js";

interface Api {
  decodeQueryComponent(value: string): string;
  encodeQueryComponent(value: string): string;
  hasQueryParam(url: string, key: string): boolean;
  hasScheme(url: string, scheme: string): boolean;
  queryParamEquals(url: string, key: string, expected: string): boolean;
  rawOriginsEqual(a: string, b: string): boolean;
  readPathname(url: string): string;
  pathnameStartsWith(url: string, prefix: string): boolean;
  pathnameEndsWith(url: string, suffix: string): boolean;
  readOrigin(url: string): string;
  readHost(url: string): string;
  readHostname(url: string): string;
  readPort(url: string): number | null;
  readQueryParam(url: string, key: string): string | null;
  readQueryParams(
    url: string,
    keys: readonly string[]
  ): readonly (string | null)[];
  setPathname(url: string, pathname: string): string;
  setPort(url: string, port: number | null): string;
  setScheme(url: string, scheme: string): string;
  setQueryParam(url: string, key: string, value: string | null): string;
  setQueryParams(url: string, params: Record<string, string | null>): string;
  removeQueryParams(url: string, keys: readonly string[]): string;
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
    decodeQueryComponent: source.decodeQueryComponent,
    encodeQueryComponent: source.encodeQueryComponent,
    hasQueryParam: source.hasQueryParam,
    hasScheme: source.hasScheme,
    queryParamEquals: source.queryParamEquals,
    rawOriginsEqual,
    readPathname: source.readPathname,
    pathnameStartsWith: source.pathnameStartsWith,
    pathnameEndsWith: source.pathnameEndsWith,
    readOrigin: source.readOrigin,
    readHost: source.readHost,
    readHostname: source.readHostname,
    readPort: source.readPort,
    readQueryParam: source.readQueryParam,
    readQueryParams: source.readQueryParams,
    setPathname: source.setPathname,
    setPort: source.setPort,
    setScheme: source.setScheme,
    setQueryParam: source.setQueryParam,
    setQueryParams: source.setQueryParams,
    removeQueryParams: source.removeQueryParams,
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
const filters = filter.split(",").filter(Boolean);
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

// Reverse setup as well as measurement order: allocating both implementations
// in a fixed order can bias object shapes and GC-sensitive A/A controls.
function pairCases<T>(factory: (api: Api) => T): [T, T] {
  if (benchGlobals.URLENS_BENCH_INVERT) {
    const candidateCases = factory(candidate);
    return [factory(baseline), candidateCases];
  }
  return [factory(baseline), factory(candidate)];
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

const [baselineComponents, candidateComponents] = pairCases(componentCases);
const [baselineQueries, candidateQueries] = pairCases(queryCases);
const [baselineFlat, candidateFlat] = pairCases(flatCases);

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

// Exercise sizes and shapes that the short, ordinary URL cases do not cover.
// Inputs are built outside timed loops and results escape to prevent folding.
function scalingCases(api: Api): Record<string, BenchFn> {
  const plain = FULL_URLS.map((_, i) => `${"token".repeat(800)}${i}`);
  const plus = plain.map((value) => `${value}+tail`);
  const encoded = plain.map((value) => `${value}%C3%A9`);
  const urls = plain.map((value) => `https://x.test/?q=${value}&other=1#end`);
  const invalid = FULL_URLS.map((_, i) => `%E2%82+%FF%41%ZZ${i}`);
  const escaped = new Array<unknown>(4096);
  const result: Record<string, BenchFn> = {};
  for (const [name, values] of Object.entries({
    plain,
    plus,
    encoded,
    invalid,
  })) {
    result[`decode.${name}`] = () => {
      const value = api.decodeQueryComponent(next(values));
      escaped[position & 4095] = value;
      sink = (sink + value.length) | 0;
    };
  }
  result["read.long"] = () => {
    const value = api.readQueryParam(next(urls), "q");
    escaped[position & 4095] = value;
    sink = (sink + (value?.length ?? 0)) | 0;
  };
  result["equals.long"] = () => {
    const index = position & 7;
    sink =
      (sink + (api.queryParamEquals(next(urls), "q", plain[index]) ? 1 : 0)) |
      0;
  };
  for (const count of [128, 1024, 8192]) {
    const bare = FULL_URLS.map(
      (_, i) => `/?${"flag&".repeat(count)}last=${i}#end`
    );
    const retained = bare.map((url) => api.view(url));
    result[`bare${count}.batch`] = () => {
      const value = api.readQueryParams(next(bare), [
        "last",
        "missing",
        "other",
      ]);
      escaped[position & 4095] = value;
      sink = (sink + (value[0]?.length ?? 0)) | 0;
    };
    result[`bare${count}.view`] = () => {
      const value = next(retained).queryParams(["last", "missing", "other"]);
      escaped[position & 4095] = value;
      sink = (sink + (value.last?.length ?? 0)) | 0;
    };
    result[`bare${count}.set`] = () => {
      const value = api.setQueryParam(next(bare), "last", "updated");
      escaped[position & 4095] = value;
      sink = (sink + value.length) | 0;
    };
    result[`bare${count}.remove`] = () => {
      const value = api.removeQueryParams(next(bare), ["last", "other"]);
      escaped[position & 4095] = value;
      sink = (sink + value.length) | 0;
    };
  }
  result["set.short"] = () => {
    const value = api.setQueryParam(next(QUERY_URLS), "q", "updated");
    escaped[position & 4095] = value;
    sink = (sink + value.length) | 0;
  };
  result["set.late"] = () => {
    const value = api.setQueryParam(next(QUERY_URLS), "lang", "updated");
    escaped[position & 4095] = value;
    sink = (sink + value.length) | 0;
  };
  result["set.append"] = () => {
    const value = api.setQueryParam(next(QUERY_URLS), "added", "new");
    escaped[position & 4095] = value;
    sink = (sink + value.length) | 0;
  };
  result["set.batch"] = () => {
    const value = api.setQueryParams(next(QUERY_URLS), {
      q: "updated",
      lang: null,
    });
    escaped[position & 4095] = value;
    sink = (sink + value.length) | 0;
  };
  return result;
}

const [baselineScaling, candidateScaling] = pairCases(scalingCases);
for (const name of Object.keys(baselineScaling)) {
  add(`scale.${name}`, baselineScaling[name], candidateScaling[name]);
}

function additionalCases(api: Api): Record<string, BenchFn> {
  const {
    encodeQueryComponent,
    readQueryParam,
    readPathname,
    queryParamEquals,
    hasQueryParam,
    setQueryParam,
  } = api;
  const escaped = new Array<unknown>(4096);
  const result: Record<string, BenchFn> = {};
  const plain = FULL_URLS.map((_, i) => `${"token".repeat(800)}${i}`);
  for (const [name, values] of Object.entries({
    short: [
      "alpha",
      "bravo",
      "charlie",
      "delta",
      "echo",
      "foxtrot",
      "golf",
      "hotel",
    ],
    shortMixed: [
      "",
      "hello world",
      "AZ09_-.*",
      "a&b=1",
      "café",
      "🌟",
      "\uD800",
      "()!'~",
    ],
    plain,
    space: plain.map((value) => `${value} tail`),
    utf8: plain.map((value) => `${value} café ☕`),
    surrogate: plain.map((value) => `${value}\uD800`),
    dense: FULL_URLS.map((_, i) => `${"é ☕".repeat(512)}${i}`),
  })) {
    result[`encode.${name}`] = () => {
      const value = encodeQueryComponent(next(values));
      escaped[position & 4095] = value;
      sink = (sink + value.length) | 0;
    };
  }
  for (const size of [32, 4096]) {
    for (const hit of [true, false]) {
      const urls = FULL_URLS.map(
        (_, i) =>
          `https://x.test/?q=${"a".repeat(size)}${i}&${hit ? "a" : "z"}=value`
      );
      result[`collision.${size}.${hit ? "hit" : "miss"}`] = () => {
        const value = readQueryParam(next(urls), "a");
        sink = (sink + (value?.length ?? 0)) | 0;
      };
    }
  }
  const encodedValues = FULL_URLS.map(
    (_, i) =>
      `https://x.test/?q=hello+world+${i}&message=caf%C3%A9&value=%E2%98%95`
  );
  const fields = Array.from({ length: 128 }, (_, i) => `p${i}=value`).join("&");
  const removalUrls = FULL_URLS.map(
    (_, i) => `https://x.test/?${fields}&last=${i}#end`
  );
  for (const count of [16, 32, 64, 256]) {
    const keys = Array.from({ length: count }, (_, i) => `p${i * 2}`);
    result[`remove.${count}`] = () => {
      const value = api.removeQueryParams(next(removalUrls), keys);
      escaped[position & 4095] = value;
      sink = (sink + value.length) | 0;
    };
    if (count > 32) {
      result[`remove.short.${count}`] = () => {
        const value = api.removeQueryParams(next(QUERY_URLS), keys);
        escaped[position & 4095] = value;
        sink = (sink + value.length) | 0;
      };
      const longValues = plain.map((value) => `/?q=${value}#end`);
      result[`remove.value.${count}`] = () => {
        const value = api.removeQueryParams(next(longValues), keys);
        escaped[position & 4095] = value;
        sink = (sink + value.length) | 0;
      };
      const params = Object.fromEntries(keys.map((key) => [key, "updated"]));
      result[`set.batch.${count}`] = () => {
        const value = api.setQueryParams(next(removalUrls), params);
        escaped[position & 4095] = value;
        sink = (sink + value.length) | 0;
      };
    }
  }
  const retained = encodedValues.map((url) => api.view(url));
  result["encodedValues.miss"] = () => {
    sink =
      (sink + (readQueryParam(next(encodedValues), "missing")?.length ?? 0)) |
      0;
  };
  result["encodedValues.retain"] = () => {
    sink = (sink + (next(retained).queryParam("missing")?.length ?? 0)) | 0;
  };
  const mixed = [
    "https://x.test/api?q=alpha&utm_source=one&lang=en",
    "http://x.test/api?q=bravo&utm_source=two&lang=fr",
    "HTTPS://x.test/api?q=charlie&utm_source=three&lang=de",
    "ftp://x.test/api?q=delta&utm_source=four&lang=es",
    "ws://x.test/api?q=echo&utm_source=five&lang=it",
    "custom+1://x.test/api?q=foxtrot&utm_source=six&lang=pt",
    "/api?q=golf&utm_source=seven&lang=nl",
    "relative/api?q=hotel&utm_source=eight&lang=sv",
  ];
  result["mixed.request"] = () => {
    const url = next(mixed);
    sink =
      (sink +
        readPathname(url).length +
        (readQueryParam(url, "q")?.length ?? 0) +
        (hasQueryParam(url, "utm_source") ? 1 : 0) +
        (queryParamEquals(url, "lang", "en") ? 1 : 0)) |
      0;
  };
  result["mixed.rewrite"] = () => {
    const value = setQueryParam(next(mixed), "utm_source", "updated");
    escaped[position & 4095] = value;
    sink = (sink + value.length) | 0;
  };
  return result;
}

const [baselineAdditional, candidateAdditional] = pairCases(additionalCases);
for (const name of Object.keys(baselineAdditional)) {
  add(`extra.${name}`, baselineAdditional[name], candidateAdditional[name]);
}

function otherAreaCases(api: Api): Record<string, BenchFn> {
  const {
    readOrigin,
    readHost,
    readHostname,
    readPort,
    readPathname,
    setPort,
    encodeQueryComponent,
    view,
  } = api;
  const escaped = new Array<unknown>(4096);
  const result: Record<string, BenchFn> = {};
  const hosts = FULL_URLS.map(
    (_, i) =>
      `https://${"a".repeat(55)}.${"b".repeat(55)}.${"c".repeat(55)}.example${i}.test:8443/path?q=value#end`
  );
  const tails = FULL_URLS.map(
    (_, i) => `https://example${i}.test/api?q=${"payload".repeat(1000)}`
  );
  for (const [shape, urls] of Object.entries({
    short: FULL_URLS,
    complex: COMPLEX_URLS,
    longHost: hosts,
    longTail: tails,
  })) {
    result[`${shape}.origin`] = () => {
      sink = (sink + readOrigin(next(urls)).length) | 0;
    };
    result[`${shape}.host`] = () => {
      sink = (sink + readHost(next(urls)).length) | 0;
    };
    result[`${shape}.hostname`] = () => {
      sink = (sink + readHostname(next(urls)).length) | 0;
    };
    result[`${shape}.port`] = () => {
      sink = (sink + (readPort(next(urls)) ?? 0)) | 0;
    };
    result[`${shape}.path`] = () => {
      sink = (sink + readPathname(next(urls)).length) | 0;
    };
    result[`${shape}.setPort`] = () => {
      const value = setPort(next(urls), 8080);
      escaped[position & 4095] = value;
      sink = (sink + value.length) | 0;
    };
    result[`${shape}.construct`] = () => {
      const value = view(next(urls));
      escaped[position & 4095] = value;
      sink = (sink + value.toString().length) | 0;
    };
    result[`${shape}.read5`] = () => {
      const value = view(next(urls));
      sink =
        (sink +
          value.scheme().length +
          value.host().length +
          (value.port() ?? 0) +
          value.pathname().length +
          value.fragment().length) |
        0;
    };
  }
  for (const [shape, urls] of Object.entries({
    longPath: FULL_URLS.map(
      (_, i) => `https://x.test/${"segment/".repeat(1000)}${i}?q=1`
    ),
    noPath: FULL_URLS.map(
      (_, i) => `https://x.test?q=${"value".repeat(1400)}${i}`
    ),
    relative: FULL_URLS.map((_, i) => `/api?q=${"value".repeat(1400)}${i}`),
    longTail: tails,
  })) {
    result[`path.${shape}`] = () => {
      sink = (sink + readPathname(next(urls)).length) | 0;
    };
    result[`pathPredicates.${shape}`] = () => {
      const url = next(urls);
      sink =
        (sink +
          (api.pathnameStartsWith(url, "/api") ? 1 : 0) +
          (api.pathnameEndsWith(url, "api") ? 1 : 0)) |
        0;
    };
  }
  for (const [name, ports] of Object.entries({
    two: ["80", "21", "00", "99"],
    three: ["443", "123", "000", "999"],
    four: ["8080", "8443", "3000", "0000"],
    five: ["65535", "12345", "00000", "99999"],
    invalid: ["8a80", "+443", "-123", "１２３４"],
  })) {
    const urls = FULL_URLS.map(
      (_, i) => `https://example.test:${ports[i & 3]}/api?q=1`
    );
    result[`port.${name}`] = () => {
      sink = (sink + (readPort(next(urls)) ?? 0)) | 0;
    };
  }
  for (const [name, urls, scheme] of [
    ["exact", FULL_URLS, "https"],
    ["fold", FULL_URLS.map((url) => url.replace("https:", "HTTPS:")), "https"],
    ["miss", FULL_URLS, "other"],
    ["lengthMiss", FULL_URLS, "ws"],
    [
      "long",
      FULL_URLS.map((url) => url.replace("https:", "custom+extension:")),
      "custom+extension",
    ],
  ] as const) {
    result[`scheme.${name}`] = () => {
      sink = (sink + (api.hasScheme(next(urls), scheme) ? 1 : 0)) | 0;
    };
  }
  for (const [name, text] of Object.entries({
    latin1: "éàüñ",
    cyrillic: "Привет",
    cjk: "中文日本語",
    astral: "🌟😀",
    latin1Short: "café",
  })) {
    const values = FULL_URLS.map(
      (_, i) => `${name === "latin1Short" ? text : text.repeat(128)}${i}`
    );
    result[`encode.${name}`] = () => {
      const value = encodeQueryComponent(next(values));
      escaped[position & 4095] = value;
      sink = (sink + value.length) | 0;
    };
  }
  return result;
}

const [baselineOtherAreas, candidateOtherAreas] = pairCases(otherAreaCases);
for (const name of Object.keys(baselineOtherAreas)) {
  add(`area.${name}`, baselineOtherAreas[name], candidateOtherAreas[name]);
}

function boundaryCases(api: Api): Record<string, BenchFn> {
  const result: Record<string, BenchFn> = {};
  const escaped = new Array<unknown>(4096);
  for (const [name, size] of [
    ["short", 32],
    ["8k", 8192],
    ["128k", 131072],
    ["markers8k", 8192],
  ] as const) {
    const urls = FULL_URLS.map(
      (_, i) =>
        `https://x.test/api?first=one&last=two#${name === "markers8k" ? "&%+missing=" : ""}${"z".repeat(size)}${i}`
    );
    const retained = urls.map((url) => api.view(url));
    result[`${name}.first`] = () => {
      sink =
        (sink + (api.readQueryParam(next(urls), "first")?.length ?? 0)) | 0;
    };
    result[`${name}.hasFirst`] = () => {
      sink = (sink + (api.hasQueryParam(next(urls), "first") ? 1 : 0)) | 0;
    };
    result[`${name}.hit`] = () => {
      sink = (sink + (api.readQueryParam(next(urls), "last")?.length ?? 0)) | 0;
    };
    result[`${name}.miss`] = () => {
      sink =
        (sink + (api.readQueryParam(next(urls), "missing")?.length ?? 0)) | 0;
    };
    result[`${name}.has`] = () => {
      sink = (sink + (api.hasQueryParam(next(urls), "missing") ? 1 : 0)) | 0;
    };
    result[`${name}.equals`] = () => {
      sink =
        (sink + (api.queryParamEquals(next(urls), "last", "two") ? 1 : 0)) | 0;
    };
    result[`${name}.batch`] = () => {
      const value = api.readQueryParams(next(urls), [
        "first",
        "last",
        "missing",
      ]);
      escaped[position & 4095] = value;
      sink = (sink + value.length) | 0;
    };
    result[`${name}.retainedHit`] = () => {
      sink = (sink + (next(retained).queryParam("last")?.length ?? 0)) | 0;
    };
    result[`${name}.retainedMiss`] = () => {
      sink = (sink + (next(retained).queryParam("missing")?.length ?? 0)) | 0;
    };
  }
  return result;
}

const [baselineBoundaries, candidateBoundaries] = pairCases(boundaryCases);
for (const name of Object.keys(baselineBoundaries)) {
  add(`boundary.${name}`, baselineBoundaries[name], candidateBoundaries[name]);
}

// Reader-specific workloads: delimiters embedded in values, sparse batch hits,
// and fragments whose initial ampersand does not bound every native search.
function readerCases(api: Api): Record<string, BenchFn> {
  const result: Record<string, BenchFn> = {};
  const escaped = new Array<unknown>(4096);
  for (const count of [128, 1024, 8192]) {
    for (const hit of [true, false]) {
      const urls = FULL_URLS.map(
        (_, i) =>
          `/?q=${"?targeted".repeat(count)}${i}&${hit ? "target" : "other"}=right#end`
      );
      result[`collision.${count}.${hit ? "hit" : "miss"}`] = () => {
        sink =
          (sink + (api.readQueryParam(next(urls), "target")?.length ?? 0)) | 0;
      };
    }
  }
  for (const count of [50, 500]) {
    const fields = Array.from(
      { length: count },
      (_, i) => `utm_${i}=value`
    ).join("&");
    const urls = FULL_URLS.map((_, i) => `/?${fields}&last=${i}#end`);
    for (const keyCount of [3, 8, 32, 64]) {
      const keys = Array.from(
        { length: keyCount },
        (_, i) => `utm_${Math.floor((i * count) / keyCount)}`
      );
      result[`fields${count}.keys${keyCount}`] = () => {
        const value = api.readQueryParams(next(urls), keys);
        escaped[position & 4095] = value;
        sink = (sink + value.length) | 0;
      };
    }
  }
  for (const count of [3, 8, 32]) {
    for (const [name, field, key] of [
      ["plain", "message", "message"],
      ["decoded", "encoded%20key", "encoded key"],
    ] as const) {
      const keys = new Array<string>(count).fill(key);
      const urls = FULL_URLS.map(
        (_, i) => `/?${field}=${"caf%C3%A9+".repeat(128)}${i}&other=1#end`
      );
      result[`duplicates.${name}.${count}`] = () => {
        const value = api.readQueryParams(next(urls), keys);
        escaped[position & 4095] = value;
        sink = (sink + (value[0]?.length ?? 0)) | 0;
      };
    }
  }
  for (const count of [3, 8, 32, 64]) {
    const keys = Array.from({ length: count }, (_, i) => `utm_${i}`);
    result[`noquery.keys${count}`] = () => {
      const value = api.readQueryParams(next(NO_QUERY_URLS), keys);
      escaped[position & 4095] = value;
      sink = (sink + value.length) | 0;
    };
  }
  for (const marker of ["&", "&%+missing="]) {
    const urls = FULL_URLS.map(
      (_, i) => `/?first=one&last=two#${marker}${"z".repeat(8192)}${i}`
    );
    result[`fragment.${marker.length === 1 ? "amp" : "markers"}.miss`] = () => {
      sink =
        (sink + (api.readQueryParam(next(urls), "absent")?.length ?? 0)) | 0;
    };
  }
  return result;
}

const [baselineReaders, candidateReaders] = pairCases(readerCases);
for (const name of Object.keys(baselineReaders)) {
  add(`readers.${name}`, baselineReaders[name], candidateReaders[name]);
}

// Query mutators retain fragments while bounding their delimiter searches.
function mutatorCases(api: Api): Record<string, BenchFn> {
  const result: Record<string, BenchFn> = {};
  const escaped = new Array<unknown>(4096);
  for (const [name, size] of [
    ["short", 32],
    ["8k", 8192],
    ["128k", 131072],
    ["markers8k", 8192],
  ] as const) {
    const urls = FULL_URLS.map(
      (_, i) =>
        `https://x.test/api?first=one&last=two#${name === "markers8k" ? "&%+missing=" : ""}${"z".repeat(size)}${i}`
    );
    const operations: Record<string, (url: string) => string> = {
      set: (url) => api.setQueryParam(url, "last", "updated"),
      same: (url) => api.setQueryParam(url, "last", "two"),
      append: (url) => api.setQueryParam(url, "missing", "new"),
      delete: (url) => api.setQueryParam(url, "last", null),
      miss: (url) => api.setQueryParam(url, "missing", null),
      batchSet: (url) =>
        api.setQueryParams(url, { first: "updated", last: null, added: "new" }),
      batchDelete: (url) => api.removeQueryParams(url, ["first", "last"]),
      batchMiss: (url) => api.removeQueryParams(url, ["missing", "absent"]),
    };
    for (const [operation, run] of Object.entries(operations)) {
      result[`${name}.${operation}`] = () => {
        const value = run(next(urls));
        escaped[position & 4095] = value;
        sink = (sink + value.length) | 0;
      };
    }
  }
  return result;
}

const [baselineMutators, candidateMutators] = pairCases(mutatorCases);
for (const name of Object.keys(baselineMutators)) {
  add(`mutator.${name}`, baselineMutators[name], candidateMutators[name]);
}
// Component rewrite boundaries and long scheme-less inputs.
function componentRewriteCases(api: Api): Record<string, BenchFn> {
  const result: Record<string, BenchFn> = {};
  const escaped = new Array<unknown>(4096);
  for (const size of [8192, 131072]) {
    for (const [shape, prefix] of [
      ["absolute", "https://x.test/api"],
      ["relative", "/api"],
      ["noPath", "https://x.test"],
    ] as const) {
      const urls = FULL_URLS.map(
        (_, i) => `${prefix}?q=${"x".repeat(size)}${i}`
      );
      for (const [action, path] of [
        ["change", "/new"],
        ["same", "/api"],
      ] as const) {
        result[`setPath.${size}.${shape}.${action}`] = () => {
          const value = api.setPathname(next(urls), path);
          escaped[position & 4095] = value;
          sink = (sink + value.length) | 0;
        };
      }
    }
    for (const [shape, suffix] of [
      ["bare", ""],
      ["path", "/tail?q=1"],
      ["colonPath", "/tail?q=http://x"],
    ] as const) {
      const urls = FULL_URLS.map((_, i) => `${"a".repeat(size)}${i}${suffix}`);
      result[`scheme.${size}.${shape}`] = () => {
        sink = (sink + api.readOrigin(next(urls)).length) | 0;
      };
    }
  }
  for (const [shape, urls] of Object.entries({
    longPath: FULL_URLS.map(
      (_, i) => `https://x.test/${"path/".repeat(1600)}${i}?q=1`
    ),
    fragment: FULL_URLS.map(
      (_, i) => `https://x.test/api#${"x".repeat(8192)}${i}?q=1`
    ),
    short: FULL_URLS,
  })) {
    result[`setPath.${shape}`] = () => {
      const value = api.setPathname(next(urls), "/new");
      escaped[position & 4095] = value;
      sink = (sink + value.length) | 0;
    };
  }
  for (const [shape, token] of Object.entries({
    ascii: "%41%20",
    utf8: "%C3%A9",
    invalid: "%FF%41",
    latin1: "caf%E9+cr%E8me",
    truncated: "%E2%82+",
    continuation: "%80%41",
    malformed: "%ZZ%41",
  })) {
    for (const size of [0, 64, 8192]) {
      const values = FULL_URLS.map(
        (_, i) => `prefix${token}+${"x".repeat(size)}${i}`
      );
      result[`decode.${shape}.${size}`] = () => {
        const value = api.decodeQueryComponent(next(values));
        escaped[position & 4095] = value;
        sink = (sink + value.length) | 0;
      };
    }
  }
  return result;
}

const [baselineComponentRewrites, candidateComponentRewrites] = pairCases(
  componentRewriteCases
);
for (const name of Object.keys(baselineComponentRewrites)) {
  add(
    `components.${name}`,
    baselineComponentRewrites[name],
    candidateComponentRewrites[name]
  );
}
// Retained-view and constructor workloads for the view-specific pass.
function viewAreaCases(api: Api): Record<string, BenchFn> {
  const result: Record<string, BenchFn> = {};
  const escaped = new Array<unknown>(4096);
  for (const [shape, urls] of Object.entries({
    ipv4: FULL_URLS.map(
      (_, i) => `https://192.168.${i}.42:8080/api?q=one#done`
    ),
    ipv6: FULL_URLS.map(
      (_, i) => `https://[2001:db8:1234:5678::${i}]:8443/api?q=one#done`
    ),
    maxHost: FULL_URLS.map(
      (_, i) =>
        `https://${`${"a".repeat(62)}.`.repeat(3)}${"b".repeat(58)}${i}.test:8443/api?q=one#done`
    ),
    userinfo4096: FULL_URLS.map(
      (_, i) =>
        `https://user:${"credential".repeat(410)}@example${i}.test:8443/api?q=one#done`
    ),
  })) {
    result[`authority.${shape}`] = () => {
      const value = api.view(next(urls));
      escaped[position & 4095] = value;
      sink = (sink + value.toString().length) | 0;
    };
  }
  for (const size of [8192, 131072]) {
    for (const [shape, prefix, suffix] of [
      ["fragment", "https://x.test/api#", ""],
      ["fragmentQuestion", "https://x.test/api#", "?not=query"],
      ["queryFragment", "https://x.test/api?q=one#", ""],
      ["relativeFragment", "/api#", ""],
      ["ipv6Query", "https://[2001:db8::1]:8443/api?q=", ""],
      ["ipv6QueryFragment", "https://[2001:db8::1]:8443/api?q=one#", ""],
      ["longPathFragment", `https://x.test/${"segment/".repeat(512)}#`, ""],
      ["unclosedBracket", "https://[::1/api?q=one#", ""],
    ] as const) {
      const urls = FULL_URLS.map(
        (_, i) => `${prefix}${"z".repeat(size)}${i}${suffix}`
      );
      result[`construct.${shape}.${size}`] = () => {
        const value = api.view(next(urls));
        escaped[position & 4095] = value;
        sink = (sink + value.toString().length) | 0;
      };
    }
  }
  for (const [shape, urls, key] of [
    ["plain", QUERY_URLS, "q"],
    ["absent", NO_QUERY_URLS, "q"],
    [
      "proto",
      FULL_URLS.map((_, i) => `https://x.test/?__proto__=value${i}`),
      "__proto__",
    ],
  ] as const) {
    const retained = urls.map((url) => api.view(url));
    const keys = [key];
    result[`batchOne.${shape}`] = () => {
      const value = next(retained).queryParams(keys);
      escaped[position & 4095] = value;
      sink = (sink + (value[key]?.length ?? 0)) | 0;
    };
  }
  return result;
}

const [baselineViewArea, candidateViewArea] = pairCases(viewAreaCases);
for (const name of Object.keys(baselineViewArea)) {
  add(`viewArea.${name}`, baselineViewArea[name], candidateViewArea[name]);
}
function warm(fn: BenchFn, duration: number, batchSize: number): void {
  position = 0;
  const warmEnd = performance.now() + duration;
  while (performance.now() < warmEnd) {
    for (let i = 0; i < batchSize; i++) {
      fn();
    }
  }
}

function runFor(fn: BenchFn, duration: number, batchSize: number): number {
  position = 0;
  const start = performance.now();
  const end = start + duration;
  let operations = 0;
  while (performance.now() < end) {
    for (let i = 0; i < batchSize; i++) {
      fn();
    }
    operations += batchSize;
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
  if (value < 1_000_000) {
    return `${(value / 1000).toFixed(2)}K/s`;
  }
  return `${(value / 1_000_000).toFixed(2)}M/s`;
}

function pad(value: string, width: number): string {
  return `${value.padEnd(width)} `;
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
  if (
    filters.length > 0 &&
    !filters.some((prefix) => benchCase.name.startsWith(prefix))
  ) {
    continue;
  }
  const baselineRates: number[] = [];
  const candidateRates: number[] = [];
  const ratios: number[] = [];
  const batchSize =
    benchCase.name.startsWith("scale.bare") ||
    benchCase.name.startsWith("readers.collision")
      ? 16
      : 1024;
  const first = benchGlobals.URLENS_BENCH_INVERT
    ? benchCase.candidate
    : benchCase.baseline;
  const second = benchGlobals.URLENS_BENCH_INVERT
    ? benchCase.baseline
    : benchCase.candidate;
  warm(first, Math.min(200, budget), batchSize);
  warm(second, Math.min(200, budget), batchSize);
  for (let round = 0; round < rounds; round++) {
    let baselineRate: number;
    let candidateRate: number;
    if (((round + (benchGlobals.URLENS_BENCH_INVERT ? 1 : 0)) & 1) === 0) {
      baselineRate = runFor(benchCase.baseline, budget, batchSize);
      candidateRate = runFor(benchCase.candidate, budget, batchSize);
    } else {
      candidateRate = runFor(benchCase.candidate, budget, batchSize);
      baselineRate = runFor(benchCase.baseline, budget, batchSize);
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
