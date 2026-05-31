# urlens

Zero-allocation URL slicing. **5-73× faster** than the native `URL` parser on V8, SpiderMonkey, and JSC.

`urlens` uses `indexOf` against the raw URL string instead of building a `URL` object. When you only need one query value or the pathname, it's much cheaper than `new URL()` / `URLSearchParams`. The predicates (`hasQueryParam`, `pathnameStartsWith`, `originMatches`, …) don't allocate at all; they byte-compare against the input in place. No runtime dependencies.

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

**Predicates** return `boolean` without allocating. They byte-compare against the input.

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

`view(url)` does one linear scan up front and caches every component boundary as an integer offset. Subsequent reads off the returned `UrlView` are O(1) `substring` slices; no rescanning. Use it when you want two or more components off the same URL. For a single read, the flat functions are faster.

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

- `readScheme` returns the scheme without the trailing `:` (unlike `URL.protocol`). `readFragment` and `readQuery` strip the leading `#` / `?` (unlike `URL.hash` / `URL.search`).
- `readHost` is `hostname:port` in canonical authority form, IPv6 brackets kept. `readHostname` strips the brackets. `readPort` returns `number | null`; null when no explicit port is set or the port is malformed.
- `readOrigin`, `readHost`, `readHostname`, `readPort`, and `originMatches` strip userinfo (`user:pass@`) and handle IPv6 bracketed hosts (`[::1]`).
- `setQueryParam(url, key, null)` deletes the key. With duplicates, the first is replaced and the rest are removed (matches `URLSearchParams.set`).
- `setQueryParams` is a single-pass bulk setter. `null` in the dict removes the key; new keys are appended in iteration order.
- `setPathname` / `setPort` / `setScheme` preserve every other URL part (userinfo, fragment, IPv6 brackets). `setPort(url, null)` removes the port and its colon. `setPort` throws `RangeError` for non-integer or out-of-range ports.
- Query keys are matched per WHATWG `application/x-www-form-urlencoded`: `+` decodes to space, percent-encoded UTF-8 is decoded, U+FFFD for malformed. A byte-strict pass runs first; the decoded fallback only fires when byte-strict misses and the URL contains `%` / `+` in the query. So `readQueryParam("https://x.test/?weird%20key=v", "weird key")` returns `"v"`.
- `hasScheme` and `originMatches` compare schemes and hostnames case-insensitively. `originMatches` also infers implicit ports for special schemes (http=80, https=443, ws=80, wss=443, ftp=21), so `https://x/` matches `https://x:443/`. Non-special schemes need an explicit port on both sides (or none).
- `encodeQueryComponent` is `application/x-www-form-urlencoded`: safe set is `* - . _ 0-9 A-Z a-z`, spaces become `+`, everything else is percent-encoded. This differs from `encodeURIComponent`, which leaves `! ' ( ) ~` unescaped.
- `readQueryParams` returns a tuple positionally aligned with the input `keys`; pass keys `as const` for full destructure-by-position typing. For destructure-by-name, use `view(url).queryParams(keys)`, which returns an object keyed by the input keys.
- `removeQueryParam` is an alias for `setQueryParam(url, key, null)`. `removeQueryParams` is a single-pass bulk form; cheaper than N sequential calls, which would rebuild the query string N times.

## Benchmarks

Real browser engines via Playwright, 600ms per case, inputs rotated through 8 distinct URLs each run so the JIT can't constant-fold.

**Speedup over native `URL` / `URLSearchParams`** (table auto-regenerated by CI on every push to `main`):

<!-- BENCH:START -->

| case | V8 (Chrome) | SpiderMonkey (Firefox) | JSC (WebKit) |
|---|---|---|---|
| read query, plain ASCII | 20.3× | 16.1× | 24.9× |
| read query, percent-encoded UTF-8 | 7.2× | 20.0× | 9.7× |
| read query, 12 params, key near end | 84.4× | 29.2× | 51.0× |
| read query, key absent (miss path) | 30.6× | 26.8× | 19.5× |
| read query, encoded URL key (decoded match) | 10.7× | 11.6× | 10.4× |
| read 2 keys (`readQueryParams`) | 6.6× | 7.4× | 7.5× |
| read 4 keys (`readQueryParams`) | 4.3× | 5.3× | 5.7× |
| read pathname (full URL) | 19.6× | 24.3× | 8.3× |
| read pathname (path-only) | 21.7× | 56.2× | 17.2× |
| read origin | 13.6× | 33.2× | 22.0× |
| read scheme | 21.0× | 46.1× | 20.7× |
| read host | 7.7× | 23.4× | 10.8× |
| read hostname | 4.2× | 19.6× | 8.3× |
| read port | 7.5× | 21.2× | 9.4× |
| set query (replace) | 12.5× | 14.9× | 20.1× |
| set query (append) | 13.0× | 16.2× | 21.6× |
| set query (delete) | 14.2× | 16.7× | 19.6× |
| set pathname | 9.0× | 32.1× | 12.6× |
| `hasQueryParam` | 49.9× | 58.3× | 39.8× |
| `queryParamEquals` (ASCII fast path) | 22.1× | 30.6× | 22.0× |
| `pathnameStartsWith` | 8.6× | 23.8× | 8.6× |
| `originMatches` | 10.7× | 24.1× | 14.4× |
| read fragment | 18.3× | 68.3× | 18.6× |
| set port | 10.1× | 20.4× | 11.6× |
| `view().pathname()` vs flat `readPathname` (1 read) | 0.5× | 0.6× | 0.7× |
| `view()` 5 reads vs flat 5 reads | 1.7× | 1.6× | 1.6× |
| `view()` 5 reads vs `new URL()` + 5 props | 6.7× | 13.4× | 5.7× |
| `view().queryParam()` vs flat `readQueryParam` | 0.9× | 0.6× | 0.6× |
| `view().queryParams()` vs `readQueryParams` (2 keys) | 0.7× | 0.8× | 0.8× |
| `removeQueryParam` vs `setQueryParam(…, null)` | 0.8× | 1.1× | 1.0× |
| `removeQueryParams` (bulk) vs N sequential | 1.4× | 1.5× | 2.3× |

Absolute throughput on the hot path: **~6.3M / ~4.1M / ~11.3M ops/s** for `readQueryParam` (V8 / SpiderMonkey / JSC) on the benchmark host.

<!-- BENCH:END -->

Run the bench yourself: `bun run bench`. To re-run and update this README in
one shot (useful after a local change), use `bun run bench:update-readme`.

## Allocation behavior

Predicates allocate nothing. They return `boolean` and byte-compare against the input. `queryParamEquals` implements WHATWG UTF-8 decoding inline (1/2/3/4-byte sequences, surrogate pairs, U+FFFD for malformed) so it never builds a decoded string.

Readers return sliced-string views. V8, SpiderMonkey, and JSC implement `String.prototype.substring` as a ~24-byte header pointing into the parent string's character storage, so `readQueryParam` allocates the header but never copies characters. `decodeQueryComponent` only allocates when the source contains `+` or `%`.

Setters allocate exactly one output string. The `+=` / concat chain is held as a cons-string (rope) and flattened at most once, when consumed.

`queryParamEquals(url, "q", "x")` exists because the read-then-compare equivalent (`readQueryParam(url, "q") === "x"`) still allocates a sliced-string header for the value. `queryParamEquals` walks the bytes and compares in place; no header.

## Why not `URL`?

`URL` parses everything: it validates structure, normalizes the host, builds a `URLSearchParams` map. That's right for general-purpose use, but on a hot path where you only want one query value, you're paying for 95% you'll throw away. `urlens` slices out (or rewrites) just the part you ask for: reading one query value is one `indexOf` walk over the query string, reading the pathname or origin is two or three `indexOf` calls, setters return a new string and never mutate the input.

In exchange, `urlens` skips validation, and `decodeQueryComponent` is tolerant (where `decodeURIComponent` throws on `%ZZ`, `urlens` keeps the literal text). For untrusted input, round-trip through `new URL(input).toString()` first.

## WHATWG compliance

Where `urlens` has a corresponding `URL` / `URLSearchParams` operation, the result matches byte-for-byte:

- Key matching follows `application/x-www-form-urlencoded` on both sides. `readQueryParam("?weird%20key=v", "weird key")` returns `"v"`, same as `URLSearchParams.get`. Byte-strict runs first; the decoded fallback only fires when needed.
- Value decoding is WHATWG UTF-8 with U+FFFD for malformed sequences (lone continuation bytes, overlong forms, surrogate-range encodings).
- `encodeQueryComponent` matches `application/x-www-form-urlencoded` exactly: safe set is `* - . _ 0-9 A-Z a-z`, spaces become `+`, everything else percent-encoded. Same output as `new URLSearchParams([[k, v]]).toString()`.
- `originMatches` infers implicit ports for special schemes (http=80, https=443, ws=80, wss=443, ftp=21), compares schemes and hostnames case-insensitively, and strips userinfo from both sides. Same semantics as `URL.origin === URL.origin`.

Scheme detection validates the full RFC alphabet, so a relative/schemeless input whose query, path, or fragment contains a `://` (an OAuth `redirect_uri`, a proxy `?url=`, etc.) is read as schemeless. `readScheme("/cb?redirect_uri=https://app.example.com")` returns `""`; `readPathname` returns `"/cb"`.

What `urlens` doesn't do:

- No IDN / Punycode (`xn--` ↔ Unicode hostname). Browsers ship ~50KB of Unicode tables for this.
- No IPv6 canonicalization. `[2001:0db8::0001]` is preserved verbatim and isn't byte-equal to `[2001:db8::1]`.
- No path normalization. `setPathname` doesn't collapse `..` / `.` segments.
- No scheme case-normalization on read. `readScheme("HTTPS://x/")` returns `"HTTPS"`. (`hasScheme` and `originMatches` still compare case-insensitively.)

Assume the input is already well-formed. URLs from `fetch`, `URL.toString()`, or a browser are already normalized. For raw user input, run `new URL(input).toString()` first.

## Limitations

- `urlens` never throws on malformed URLs. It returns best-effort substrings.
- `readOrigin` doesn't validate the host. It returns whatever lies between the scheme and the authority terminator.
- `setScheme` and `setPort` no-op on schemeless inputs. Build the URL with string concat first if you need to add a scheme.

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
