# urlens

Zero-allocation URL slicing — **5-73× faster than the native `URL` parser** on V8, SpiderMonkey, and JavaScriptCore.

`urlens` reads, rewrites, and answers questions about URL strings via `indexOf` instead of constructing a `URL` object. For service workers, edge functions, request routers, and any hot path where you just need one query value, the pathname, or to check "does this URL have parameter X?", this is dramatically faster than `new URL()` / `URLSearchParams`. The predicate functions (`hasQueryParam`, `pathnameStartsWith`, `originMatches`, …) skip the string allocation entirely — they compare bytes in place against the input URL. Zero runtime dependencies.

## Install

```sh
bun add urlens
# or: npm install urlens / pnpm add urlens
```

## Usage

```ts
import {
  // predicates — zero allocation, answer questions without materializing strings
  hasQueryParam,
  hasScheme,
  queryParamEquals,
  pathnameStartsWith,
  pathnameEndsWith,
  originMatches,
  // readers
  readQueryParam,
  readQueryParams,
  readPathname,
  readOrigin,
  readScheme,
  readHost,
  readHostname,
  readPort,
  readFragment,
  readQuery,
  // setters
  setQueryParam,
  setQueryParams,
  setPathname,
  setScheme,
  setPort,
  // strip helpers
  stripQuery,
  stripFragment,
  removeQueryParam,
  removeQueryParams,
  // batched reads (one scan up front, then O(1) reads)
  view,
  // codec
  decodeQueryComponent,
  encodeQueryComponent,
} from "urlens";

// Predicates — strictly faster than reading and comparing -------------------

hasQueryParam("https://example.com/?a=1", "a");                       // → true
hasScheme("https://example.com/", "https");                           // → true
queryParamEquals("https://example.com/?q=hello+world", "q", "hello world");
// → true (ASCII fast path: byte-compares in place; no decoded string allocated)
pathnameStartsWith("https://example.com/api/v1/users", "/api");       // → true
pathnameEndsWith("https://example.com/page.html", ".html");           // → true
originMatches("https://a.test/x", "https://a.test/y");                // → true

// Read ----------------------------------------------------------------------

readQueryParam("https://example.com/search?q=hello+world", "q");
// → "hello world"

readQueryParams("https://example.com/r?q=hi&t=duck&utm_source=ig", [
  "q",
  "utm_source",
]);
// → ["hi", "ig"]

readPathname("https://example.com/api/v1/users/42?x=1#frag");         // → "/api/v1/users/42"
readOrigin("https://user:pass@example.com:8080/api?x=1");             // → "https://example.com:8080"
readScheme("https://example.com");                                    // → "https"
readHost("https://example.com:8080/p");                               // → "example.com:8080"
readHostname("http://[::1]:8080/");                                   // → "::1"
readPort("http://example.com:8080/");                                 // → 8080
readFragment("https://example.com/p#section-2");                      // → "section-2"
readQuery("https://example.com/p?a=1&b=2#frag");                      // → "a=1&b=2"

// Write ---------------------------------------------------------------------

setQueryParam("https://example.com/?a=1", "q", "hello world");
// → "https://example.com/?a=1&q=hello+world"

setQueryParam("https://example.com/?q=old", "q", null); // null = delete
// → "https://example.com/"

setQueryParams("https://example.com/?a=1&b=2", { a: "new", b: null, c: "3" });
// → "https://example.com/?a=new&c=3"

setPathname("https://example.com/old?q=1#frag", "/new");
// → "https://example.com/new?q=1#frag"

setScheme("https://example.com/", "wss");          // → "wss://example.com/"
setPort("https://example.com:80/api", 8443);       // → "https://example.com:8443/api"
setPort("https://example.com:80/api", null);       // → "https://example.com/api"

// Strip / remove ------------------------------------------------------------

stripQuery("https://example.com/p?q=1#frag");      // → "https://example.com/p#frag"
stripFragment("https://example.com/p?q=1#frag");   // → "https://example.com/p?q=1"

removeQueryParam("https://example.com/?a=1&utm=ig", "utm");
// → "https://example.com/?a=1"

removeQueryParams(
  "https://example.com/?q=hi&utm_source=ig&utm_campaign=spring",
  ["utm_source", "utm_campaign"],
);
// → "https://example.com/?q=hi"

// Batched reads — pay one scan, then O(1) reads ----------------------------
// For 2+ components off the same URL, view() amortizes the scan.

const v = view("https://example.com:8080/api/v1?q=hello+world#frag");
v.scheme();        // → "https"
v.host();          // → "example.com:8080"
v.hostname();      // → "example.com"
v.port();          // → 8080
v.pathname();      // → "/api/v1"
v.query();         // → "q=hello+world"
v.fragment();      // → "frag"
v.queryParam("q"); // → "hello world"

// Object-keyed batched read — destructure by name:
const { q, utm_source } = view(
  "https://example.com/r?q=hi&utm_source=ig",
).queryParams(["q", "utm_source"] as const);

// Codec ---------------------------------------------------------------------

decodeQueryComponent("caf%C3%A9+%E2%98%95");       // → "café ☕"
encodeQueryComponent("hello world");               // → "hello+world"
```

## API

**Predicates** — zero allocation, return `boolean`. Compare bytes in place; never construct an intermediate string.

| Function | Signature |
|---|---|
| `hasQueryParam` | `(url: string, key: string) => boolean` |
| `hasScheme` | `(url: string, scheme: string) => boolean` |
| `queryParamEquals` | `(url: string, key: string, expected: string) => boolean` |
| `pathnameStartsWith` | `(url: string, prefix: string) => boolean` |
| `pathnameEndsWith` | `(url: string, suffix: string) => boolean` |
| `originMatches` | `(a: string, b: string) => boolean` |

**Readers**

| Function | Signature |
|---|---|
| `readQueryParam` | `(url: string, key: string) => string \| null` |
| `readQueryParams` | `<const K extends readonly string[]>(url: string, keys: K) => { -readonly [I in keyof K]: string \| null }` |
| `readQuery` | `(url: string) => string` |
| `readPathname` | `(url: string) => string` |
| `readOrigin` | `(url: string) => string` |
| `readScheme` | `(url: string) => string` |
| `readHost` | `(url: string) => string` |
| `readHostname` | `(url: string) => string` |
| `readPort` | `(url: string) => number \| null` |
| `readFragment` | `(url: string) => string` |

**Setters**

| Function | Signature |
|---|---|
| `setQueryParam` | `(url: string, key: string, value: string \| null) => string` |
| `setQueryParams` | `(url: string, params: Record<string, string \| null>) => string` |
| `setPathname` | `(url: string, pathname: string) => string` |
| `setScheme` | `(url: string, scheme: string) => string` |
| `setPort` | `(url: string, port: number \| null) => string` |

**Strip / remove**

| Function | Signature |
|---|---|
| `stripQuery` | `(url: string) => string` |
| `stripFragment` | `(url: string) => string` |
| `removeQueryParam` | `(url: string, key: string) => string` |
| `removeQueryParams` | `(url: string, keys: readonly string[]) => string` |

**Batched reads**

`view(url)` pays one linear scan up front and caches every component boundary as an integer offset. Each method on the returned `UrlView` is a single `substring` (sliced-string view) against those offsets — no scanning. Use this when you need two or more components off the same URL string; for a single read, the flat top-level functions are strictly faster.

| Function | Signature |
|---|---|
| `view` | `(url: string) => UrlView` |
| `UrlView#scheme` | `() => string` |
| `UrlView#origin` | `() => string` |
| `UrlView#host` | `() => string` |
| `UrlView#hostname` | `() => string` |
| `UrlView#port` | `() => number \| null` |
| `UrlView#pathname` | `() => string` |
| `UrlView#query` | `() => string` |
| `UrlView#fragment` | `() => string` |
| `UrlView#queryParam` | `(key: string) => string \| null` |
| `UrlView#queryParams` | `<const K extends readonly string[]>(keys: K) => { [P in K[number]]: string \| null }` |
| `UrlView#hasQueryParam` | `(key: string) => boolean` |
| `UrlView#queryParamEquals` | `(key: string, expected: string) => boolean` |
| `UrlView#pathnameStartsWith` | `(prefix: string) => boolean` |
| `UrlView#pathnameEndsWith` | `(suffix: string) => boolean` |
| `UrlView#toString` | `() => string` |

**Codec**

| Function | Signature |
|---|---|
| `decodeQueryComponent` | `(raw: string) => string` |
| `encodeQueryComponent` | `(value: string) => string` |

Notes:

- **Predicates skip the string allocation entirely.** `hasQueryParam` answers in one query-string scan; `queryParamEquals` walks the URL's value bytes and decodes one Unicode codepoint at a time (1/2/3/4-byte UTF-8, astral surrogate pairs, and malformed sequences mapped to U+FFFD per WHATWG), comparing each against `expected` in place — zero allocation in all cases. The function is byte-equivalent to `readQueryParam(url, key) === expected` but never materializes a decoded string. `pathnameStartsWith` / `pathnameEndsWith` use native `String.prototype.startsWith` against the path range in place.
- **`originMatches` infers implicit ports for special schemes** (http=80, https=443, ws=80, wss=443, ftp=21). `https://x/` and `https://x:443/` are considered equal. For non-special schemes (e.g. `custom://`) there is no implicit port — both sides must have the same explicit port (or both lack one).
- `originMatches` compares **scheme + hostname case-insensitively** — `https://EXAMPLE.com/` matches `https://example.com/` and `[2001:DB8::1]` matches `[2001:db8::1]`. Userinfo is stripped from both sides.
- **`hasScheme` is case-insensitive** — `hasScheme("HTTPS://x/", "https")` is true. URL schemes are case-insensitive per RFC; WHATWG normalizes them to lowercase.
- **`encodeQueryComponent` is WHATWG `application/x-www-form-urlencoded`** — safe set is exactly `* - . _ 0-9 A-Z a-z`; spaces become `+`; everything else is percent-encoded. This differs from `encodeURIComponent`, which also leaves `! ' ( ) ~` unescaped.
- `readQueryParams` returns a tuple positionally aligned with the input `keys` — pass keys with `as const` for full destructure-by-position typing. It scans the query string once and exits as soon as every requested key is found. For destructure-by-**name**, use `view(url).queryParams(keys)` instead — it returns an object keyed by the input keys.
- **`view(url)`** trades one wrapper-object allocation for O(1) subsequent reads. Use it when you need ≥2 components off the same URL. For single reads, the flat top-level functions are strictly faster — they don't pay the wrapper cost.
- `removeQueryParam` is a discoverability alias for `setQueryParam(url, key, null)`. `removeQueryParams` is a single-pass bulk form — strictly cheaper than calling `removeQueryParam` N times, which would rebuild the query string N times.
- `setQueryParam(url, key, null)` removes the key. If the key has duplicates, the first occurrence is replaced and the rest are removed — matches `URLSearchParams.set`.
- `setQueryParams` is a single-pass bulk setter. `null` in the dict removes the key. Keys not yet in the URL are appended at the end.
- `setPathname` / `setPort` / `setScheme` preserve every other URL part (userinfo, fragment, IPv6 brackets, etc.). `setPort(url, null)` removes the port and its colon. `setPort` throws `RangeError` for non-integer or out-of-range ports.
- `setScheme` and `setPort` are no-ops when the URL has no scheme — they don't synthesize one.
- `readOrigin`, `readHost`, `readHostname`, `readPort`, `originMatches` all strip userinfo (`user:pass@`) and handle IPv6 bracketed hosts (`[::1]`).
- `readScheme` returns the scheme without the trailing `:` (unlike `URL.protocol`). `readFragment` and `readQuery` strip the leading `#`/`?` (unlike `URL.hash`/`URL.search`).
- `readHost` returns `hostname:port` if a port is present (canonical authority form, IPv6 brackets kept). `readHostname` returns the bare hostname with IPv6 brackets stripped. `readPort` returns a `number | null` — null when no explicit port is set or the port is malformed.
- **Keys are matched per WHATWG `application/x-www-form-urlencoded`** — `+` decodes to space, percent-encoded UTF-8 is decoded, U+FFFD for malformed. A byte-strict pass runs first with near-zero overhead; the WHATWG-decoded fallback only fires when the byte-strict pass misses *and* the URL has `%`/`+` in the query. So `readQueryParam("https://x.test/?weird%20key=v", "weird key")` returns `"v"`.

## Benchmarks

Real browser engines via Playwright, 600ms per case, inputs rotated through 8 distinct URLs each run so the JIT can't constant-fold.

**Speedup over native `URL` / `URLSearchParams`** (table auto-regenerated by CI on every push to `main`):

<!-- BENCH:START -->

| case | V8 (Chrome) | SpiderMonkey (Firefox) | JSC (WebKit) |
|---|---|---|---|
| read query, plain ASCII | 20.6× | 19.8× | 15.7× |
| read query, percent-encoded UTF-8 | 6.7× | 12.3× | 8.2× |
| read query, 12 params, key near end | 57.4× | 22.0× | 29.5× |
| read query, key absent (miss path) | 22.3× | 20.7× | 17.4× |
| read query, encoded URL key (decoded match) | 9.0× | 8.3× | 7.6× |
| read 2 keys (`readQueryParams`) | 6.2× | 5.8× | 6.4× |
| read 4 keys (`readQueryParams`) | 4.1× | 3.9× | 5.3× |
| read pathname (full URL) | 10.1× | 17.1× | 8.3× |
| read pathname (path-only) | 15.2× | 38.4× | 13.6× |
| read origin | 11.6× | 18.3× | 13.5× |
| read scheme | 17.3× | 44.7× | 20.7× |
| read host | 6.2× | 12.7× | 7.5× |
| read hostname | 5.0× | 11.2× | 6.4× |
| read port | 5.3× | 11.5× | 6.7× |
| set query (replace) | 11.8× | 10.4× | 15.4× |
| set query (append) | 11.2× | 11.8× | 17.9× |
| set query (delete) | 12.6× | 11.2× | 16.1× |
| set pathname | 9.4× | 23.2× | 12.7× |
| `hasQueryParam` | 28.7× | 44.3× | 28.1× |
| `queryParamEquals` (ASCII fast path) | 16.7× | 23.7× | 15.7× |
| `pathnameStartsWith` | 6.9× | 14.8× | 9.4× |
| `originMatches` | 7.7× | 15.0× | 11.0× |
| read fragment | 16.3× | 66.2× | 19.4× |
| set port | 7.4× | 10.9× | 10.3× |
| `view().pathname()` vs flat `readPathname` (1 read) | 0.5× | 0.6× | 0.6× |
| `view()` 5 reads vs flat 5 reads | 1.6× | 1.6× | 1.6× |
| `view()` 5 reads vs `new URL()` + 5 props | 5.9× | 9.5× | 5.2× |
| `view().queryParam()` vs flat `readQueryParam` | 0.5× | 0.4× | 0.6× |
| `view().queryParams()` vs `readQueryParams` (2 keys) | 0.7× | 0.8× | 0.8× |
| `removeQueryParam` vs `setQueryParam(…, null)` | 0.9× | 1.1× | 1.0× |
| `removeQueryParams` (bulk) vs N sequential | 1.5× | 1.5× | 2.3× |

Absolute throughput on the hot path: **~23.0M / ~13.5M / ~18.0M ops/s** for `readQueryParam` (V8 / SpiderMonkey / JSC) on the benchmark host.

<!-- BENCH:END -->

Run the bench yourself: `bun run bench`. To re-run and update this README in
one shot (useful after a local change), use `bun run bench:update-readme`.

## Zero-copy & zero-allocation guarantees

Three tiers of allocation behavior, by function category:

| Category | Allocation | Why |
|---|---|---|
| **Predicates** (`hasQueryParam`, `hasScheme`, `queryParamEquals`, `pathnameStartsWith`, `pathnameEndsWith`, `originMatches`) | **Truly zero allocation.** | They return `boolean`. No `substring`, no `+`, no `decodeQueryComponent`. Only `indexOf` / `lastIndexOf` / `startsWith` / `charCodeAt` against the input. `queryParamEquals` implements the WHATWG UTF-8 decoder algorithm inline with integer arithmetic — valid 1/2/3/4-byte sequences become codepoints, malformed sequences become U+FFFD per spec, surrogate pairs are compared two chars at a time against `expected`. Never builds a decoded string at any point. |
| **Readers** (`readQueryParam`, `readPathname`, `readHost`, `readFragment`, …) | **Byte-level zero-copy** via "sliced strings". | V8, SpiderMonkey, and JavaScriptCore all implement `String.prototype.substring(start, end)` as a small header (≈24 bytes) pointing into the parent string's character storage — no characters are copied. The function returns a value of type `string`; the only allocation is the header itself. `decodeQueryComponent` allocates the decoded string only when the source contains `+` or `%`. |
| **Setters** (`setQueryParam`, `setPathname`, `setPort`, `setScheme`, …) | **One output allocation, unavoidable.** | A new string must exist. The implementation minimizes intermediate work: a single `+=`/concat chain that V8/SM/JSC implement as a cons-string (rope), materialized at most once when the result is consumed or grows past the engine's flatten threshold. |

The predicates were specifically designed to defeat the "read-then-compare" pattern. Where `readQueryParam(url, "q") === "x"` causes one sliced-string header allocation for the value, `queryParamEquals(url, "q", "x")` is zero-allocation regardless of encoding.

## Why not `URL`?

The WHATWG `URL` parser is correctness-first: it parses the entire URL, normalizes the host, builds a `URLSearchParams` map, and produces a complete object. That's the right design for general-purpose use. But on a hot request path where you just want one query value — or to flip a single UTM tag — the parser does ~95% of work you'll throw away.

`urlens` flips the priority: it does the minimum work to slice out (or rewrite) the requested part. Reading one query value walks the query string once with `indexOf`. Setting one query value walks it once and splices the result. Reading the pathname or origin is two-to-three `indexOf` calls. Setters return a new string; the input is never mutated.

There are two real tradeoffs:

1. **No validation.** `urlens` never throws on malformed input — it returns a best-effort substring. If a URL is structurally broken, `urlens` won't tell you.
2. **`decodeQueryComponent` is tolerant.** Where `decodeURIComponent` throws on `%ZZ`, `urlens` preserves the literal text. This matches what most user-facing systems actually want.

## WHATWG compliance

`urlens` is **fully WHATWG-conformant on every operation it performs**. Where we have a corresponding `URL` / `URLSearchParams` operation we match its result byte-for-byte:

- **Key matching** follows `application/x-www-form-urlencoded` decoding on both sides. `readQueryParam("?weird%20key=v", "weird key")` returns `"v"` — same as `URLSearchParams.get`. Byte-strict is tried first (near-zero overhead); the decoded fallback only fires when needed.
- **Value decoding** is full WHATWG UTF-8 with U+FFFD replacement for malformed sequences (lone continuation bytes, overlong sequences, surrogate-range encodings).
- **`encodeQueryComponent`** matches `application/x-www-form-urlencoded` exactly — safe set is `* - . _ 0-9 A-Z a-z`, spaces become `+`, everything else percent-encoded. Same output as `new URLSearchParams([[k, v]]).toString()`.
- **`originMatches`** infers implicit ports for special schemes (http=80, https=443, ws=80, wss=443, ftp=21), compares schemes + hostnames case-insensitively, and strips userinfo from both sides — same semantics as `URL.origin === URL.origin`.

What we **deliberately don't do** (the *"where it's pragmatic"* cut — these would require sizable code and constant per-call work for very rare wins):

- **No IDN / Punycode** — `xn--` ↔ Unicode hostname conversion. Browsers ship ~50KB of Unicode tables for this; we don't.
- **No IPv6 canonicalization** — we preserve the input's `[…]` byte form. `[2001:0db8::0001]` is not byte-equal to `[2001:db8::1]`.
- **No path normalization** — `setPathname` doesn't collapse `..` / `.` segments.
- **No scheme case-normalization on *read*** — `readScheme("HTTPS://x/")` returns `"HTTPS"`. (`hasScheme` and `originMatches` compare case-insensitively, so this doesn't affect comparison semantics.)

The contract: **assume the input URL is already well-formed.** If it came from a browser, `fetch`, `URL`, or any WHATWG-conformant builder, it's already normalized — `urlens` reads and writes against it correctly without re-canonicalizing every byte. If you feed in raw user input, run it through `new URL(input).toString()` first to canonicalize.

## Limitations

- **No validation.** `urlens` never throws on malformed URLs — it returns best-effort substrings.
- **No host validation.** `readOrigin` doesn't verify that the host is well-formed — it returns the substring between scheme and authority terminator.
- **`setScheme` / `setPort` no-op on schemeless inputs.** They don't synthesize a scheme — pass a fully-qualified URL or build one with string concat first.

## Development

```sh
bun install
bun test                   # unit tests
bun run typecheck          # tsc --noEmit
bun run build              # tsc → dist/
bun run bench              # cross-engine benchmarks (Playwright)
bun run bench:update-readme  # bench + regenerate the table above
bun run check              # biome lint + format
```

## License

MIT
