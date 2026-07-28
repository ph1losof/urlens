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
| read query, plain ASCII | 19.3× | 17.5× | 15.2× |
| read query, percent-encoded UTF-8 | 5.2× | 7.9× | 7.6× |
| read query, 12 params, key near end | 55.6× | 28.4× | 39.3× |
| read query, key absent (miss path) | 23.4× | 26.2× | 12.4× |
| read query, encoded URL key (decoded match) | 8.8× | 12.0× | 9.2× |
| read 2 keys (`readQueryParams`) | 5.6× | 9.5× | 6.0× |
| read 4 keys (`readQueryParams`) | 3.3× | 6.9× | 3.8× |
| read pathname (full URL) | 12.5× | 20.5× | 9.4× |
| read pathname (path-only) | 26.9× | 76.2× | 18.2× |
| read origin | 14.7× | 44.5× | 20.1× |
| read scheme | 24.4× | 59.3× | 22.5× |
| read host | 9.1× | 20.6× | 9.0× |
| read hostname | 6.9× | 20.9× | 7.9× |
| read port | 6.9× | 22.7× | 15.5× |
| set query (replace) | 8.9× | 9.7× | 16.8× |
| set query (append) | 10.1× | 10.9× | 9.3× |
| set query (delete) | 11.6× | 13.7× | 12.5× |
| set pathname | 7.2× | 24.2× | 10.9× |
| `hasQueryParam` | 50.5× | 51.2× | 23.6× |
| `queryParamEquals` (ASCII fast path) | 12.7× | 27.0× | 21.1× |
| `pathnameStartsWith` | 7.3× | 19.2× | 8.8× |
| `originMatches` | 10.3× | 23.9× | 12.9× |
| read fragment | 18.6× | 131.0× | 21.7× |
| set port | 11.4× | 16.9× | 13.3× |
| `view().pathname()` vs flat `readPathname` (1 read) | 0.6× | 0.7× | 1.0× |
| `view()` 5 reads vs flat 5 reads | 2.0× | 1.8× | 1.5× |
| `view()` 5 reads vs `new URL()` + 5 props | 5.8× | 9.2× | 6.1× |
| `view().queryParam()` vs flat `readQueryParam` | 0.4× | 1.0× | 0.7× |
| `view().queryParams()` vs `readQueryParams` (2 keys) | 0.5× | 1.1× | 1.1× |
| `removeQueryParam` vs `setQueryParam(…, null)` | 0.5× | 2.1× | 1.8× |
| `removeQueryParams` (bulk) vs N sequential | 0.8× | 1.3× | 2.1× |

Absolute throughput on the hot path: **~2.7M / ~1.4M / ~2.3M ops/s** for `readQueryParam` (V8 / SpiderMonkey / JSC) on the benchmark host.

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
bun install --frozen-lockfile
bun test                     # unit tests
bun run test:coverage        # tests + enforced coverage floor
bun run typecheck            # strict TypeScript checks
bun run build                # clean + declarations + ESM build
bun run check                # Biome format/lint/assists + TypeScript
bun run fix                  # apply Biome fixes and import organization
bun run ci                   # complete local CI suite, including npm pack
bun run bench                # cross-engine benchmarks (Playwright)
bun run bench:update-readme  # bench + regenerate the table above
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for the release process and
[SECURITY.md](SECURITY.md) for private vulnerability reporting.

## License

MIT
