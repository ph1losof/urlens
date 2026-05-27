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

// Strip helpers -------------------------------------------------------------

stripQuery("https://example.com/p?q=1#frag");      // → "https://example.com/p#frag"
stripFragment("https://example.com/p?q=1#frag");   // → "https://example.com/p?q=1"

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
| `readQueryParams` | `(url: string, keys: readonly string[]) => (string \| null)[]` |
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

**Strip helpers**

| Function | Signature |
|---|---|
| `stripQuery` | `(url: string) => string` |
| `stripFragment` | `(url: string) => string` |

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
- `readQueryParams` returns a parallel array — same length and order as the input `keys`. It scans the query string once and exits as soon as every requested key is found.
- `setQueryParam(url, key, null)` removes the key. If the key has duplicates, the first occurrence is replaced and the rest are removed — matches `URLSearchParams.set`.
- `setQueryParams` is a single-pass bulk setter. `null` in the dict removes the key. Keys not yet in the URL are appended at the end.
- `setPathname` / `setPort` / `setScheme` preserve every other URL part (userinfo, fragment, IPv6 brackets, etc.). `setPort(url, null)` removes the port and its colon. `setPort` throws `RangeError` for non-integer or out-of-range ports.
- `setScheme` and `setPort` are no-ops when the URL has no scheme — they don't synthesize one.
- `readOrigin`, `readHost`, `readHostname`, `readPort`, `originMatches` all strip userinfo (`user:pass@`) and handle IPv6 bracketed hosts (`[::1]`).
- `readScheme` returns the scheme without the trailing `:` (unlike `URL.protocol`). `readFragment` and `readQuery` strip the leading `#`/`?` (unlike `URL.hash`/`URL.search`).
- `readHost` returns `hostname:port` if a port is present (canonical authority form, IPv6 brackets kept). `readHostname` returns the bare hostname with IPv6 brackets stripped. `readPort` returns a `number | null` — null when no explicit port is set or the port is malformed.
- **Keys are treated literally** for matching and writing. Callers with non-ASCII keys should pre-encode them via `encodeQueryComponent`. Values are encoded/decoded automatically.

## Benchmarks

Real browser engines via Playwright, 600ms per case, inputs rotated through 8 distinct URLs each run so the JIT can't constant-fold.

**Speedup over native `URL` / `URLSearchParams`** (table auto-regenerated by CI on every push to `main`):

<!-- BENCH:START -->

| case | V8 (Chrome) | SpiderMonkey (Firefox) | JSC (WebKit) |
|---|---|---|---|
| read query, plain ASCII | 24.3× | 20.0× | 18.4× |
| read query, percent-encoded UTF-8 | 7.1× | 11.7× | 7.1× |
| read query, 12 params, key near end | 17.9× | 6.6× | 11.2× |
| read 2 keys (`readQueryParams`) | 6.4× | 6.8× | 7.7× |
| read 4 keys (`readQueryParams`) | 4.7× | 4.5× | 5.7× |
| read pathname (full URL) | 9.4× | 16.1× | 9.5× |
| read pathname (path-only) | 14.4× | 37.4× | 11.3× |
| read origin | 11.4× | 17.4× | 13.2× |
| read scheme | 17.6× | 44.5× | 20.3× |
| read host | 6.2× | 12.6× | 7.7× |
| read hostname | 5.0× | 11.3× | 6.2× |
| read port | 5.2× | 11.2× | 6.5× |
| set query (replace) | 16.4× | 14.2× | 18.7× |
| set query (append) | 16.3× | 14.6× | 22.3× |
| set query (delete) | 16.3× | 15.6× | 20.2× |
| set pathname | 9.4× | 23.7× | 12.5× |
| `hasQueryParam` | 32.5× | 33.4× | 24.7× |
| `queryParamEquals` (ASCII fast path) | 14.9× | 16.0× | 13.5× |
| `pathnameStartsWith` | 7.0× | 14.3× | 7.7× |
| `originMatches` | 8.0× | 14.4× | 11.2× |
| read fragment | 22.6× | 66.7× | 18.6× |
| set port | 7.3× | 11.5× | 10.0× |

Absolute throughput on the hot path: **~27.6M / ~13.8M / ~20.6M ops/s** for `readQueryParam` (V8 / SpiderMonkey / JSC) on the benchmark host.

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

## Limitations

- **Keys are matched literally.** `readQueryParam(url, "weird key")` won't find `?weird%20key=v`. Pre-encode the key via `encodeQueryComponent` if it contains non-trivial chars. Values are encoded/decoded automatically.
- **No path normalization.** `setPathname` doesn't collapse `..` or `.` segments — pass the path you want written verbatim (after a leading `/` is added).
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
