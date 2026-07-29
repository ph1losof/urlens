# urlens

Read and update query parameters, paths, origins, ports, and fragments directly
in URL strings.

`urlens` is a small ESM library for code that already has a URL string or HTTP
request target and needs a focused operation. It avoids constructing `URL` and
`URLSearchParams` objects, scans only the relevant part of the string, and never
mutates the input.

Use the platform `URL` class first when input is untrusted or still needs parsing,
validation, relative URL resolution, or normalization. Use `urlens` for repeated
work on the resulting string, or for request paths such as
`/search?q=hello+world`.

On the current cross-engine benchmark, `urlens` reads a plain query parameter
**16.9-24.7x faster**, checks parameter presence **33.4-41.9x faster**, and reads
pathnames **9.0-40.2x faster** than the equivalent `URL` or `URLSearchParams`
work. It has no runtime dependencies, and a tree-shaken `readPathname` import is
about **0.45 KB gzip**.

## Install

```sh
npm install urlens
# or: pnpm add urlens
# or: bun add urlens
```

## Quickstart

```ts
import { readPathname, readQueryParam, setQueryParam } from "urlens";

const url = "https://example.com/search?q=hello+world#results";

readPathname(url); // "/search"
readQueryParam(url, "q"); // "hello world"
setQueryParam(url, "page", "2");
// "https://example.com/search?q=hello+world&page=2#results"
```

## Why It Is Fast

- Flat functions avoid constructing a parser or wrapper object for one-off work.
- Readers locate only the requested boundaries instead of materializing every URL
  component.
- Query lookup uses byte-level fast paths and pays for form decoding only when the
  key or query requires it.
- Batched query APIs scan fields once rather than repeating a complete lookup.
- Predicates compare in place without creating the value they test.
- Immutable setters preserve untouched URL slices and return the original string
  when nothing changes.
- `view(url)` caches component boundaries so repeated reads can amortize one setup
  pass.

## Allocation And Size

The API is designed to avoid parsing an entire URL or constructing component
objects for small operations. Predicates avoid materializing a result string,
readers produce only the requested value, and unchanged setters can return the
original input. Exact string allocation is engine- and workload-dependent.

Local Bun bundler estimates, minified and gzip-compressed:

| Import | Estimated gzip size |
|---|---:|
| Full API | about 7.9 KB |
| `readPathname` | about 0.45 KB |
| `readQueryParam` | about 1.8 KB |
| `queryParamEquals` | about 1.3 KB |
| `view` | about 3.5 KB |
| `encodeQueryComponent` | about 0.5 KB |

Named ESM imports are tree-shakeable, the package declares `sideEffects: false`,
and there are no runtime dependencies. The installed-package test enforces a
1 KiB gzip ceiling for `readPathname`.

## Benchmarks

The benchmark uses Playwright browser engines, runs each case for 600 ms, and
rotates eight inputs to reduce constant-folding artifacts. The figures below
come from one shared benchmark runner and host. Ratios reduce some host effects
but do not predict application-level performance.

Rows through `set port` compare a focused `urlens` operation with native `URL`
or `URLSearchParams` work. The remaining rows compare internal API tradeoffs,
including flat versus view access and bulk versus sequential removal.

<!-- BENCH:START -->

| case | V8 (Chrome) | SpiderMonkey (Firefox) | JSC (WebKit) |
|---|---|---|---|
| read query, plain ASCII | 24.7× | 19.0× | 16.9× |
| read query, percent-encoded UTF-8 | 6.6× | 10.6× | 8.6× |
| read query, key in 12th field | 67.3× | 34.4× | 30.0× |
| read query, key absent (miss path) | 22.5× | 19.1× | 16.8× |
| read query, encoded URL key (decoded match) | 9.7× | 9.2× | 8.7× |
| read 2 keys (`readQueryParams`) | 6.1× | 9.7× | 7.0× |
| read 4 keys (`readQueryParams`) | 4.0× | 6.3× | 5.3× |
| read pathname (full URL) | 11.1× | 16.4× | 9.0× |
| read pathname (path-only) | 18.9× | 40.2× | 14.5× |
| read origin | 17.4× | 22.2× | 17.5× |
| read scheme | 21.9× | 33.9× | 23.2× |
| read host | 8.5× | 14.5× | 10.1× |
| read hostname | 7.3× | 14.2× | 8.1× |
| read port | 8.3× | 14.1× | 11.9× |
| set query (replace) | 9.7× | 10.2× | 15.5× |
| set query (append) | 10.1× | 11.4× | 17.4× |
| set query (delete) | 11.1× | 10.8× | 15.3× |
| set pathname | 9.0× | 22.8× | 12.0× |
| `hasQueryParam` | 37.2× | 41.9× | 33.4× |
| `queryParamEquals` (ASCII fast path) | 17.2× | 20.2× | 17.6× |
| `pathnameStartsWith` | 7.3× | 15.1× | 8.2× |
| `rawOriginsEqual` | 11.5× | 18.5× | 17.4× |
| read fragment | 18.7× | 67.0× | 18.4× |
| set port | 10.2× | 13.5× | 13.2× |
| `view().pathname()` vs flat `readPathname` (1 read) | 0.6× | 0.5× | 0.9× |
| `view()` 5 reads vs flat 5 reads | 1.7× | 1.3× | 1.7× |
| `view()` 5 reads vs `new URL()` + 5 props | 6.8× | 8.8× | 7.2× |
| `view().queryParam()` vs flat `readQueryParam` | 0.5× | 0.5× | 0.8× |
| `view().queryParams()` vs `readQueryParams` (2 keys) | 0.9× | 0.7× | 1.1× |
| `removeQueryParam` vs `setQueryParam(…, null)` | 1.0× | 1.2× | 1.0× |
| `removeQueryParams` (bulk) vs N sequential | 1.4× | 1.5× | 2.5× |

Hot-path throughput: **~26.3M / ~12.9M / ~18.7M ops/s** for `readQueryParam` (V8 / SpiderMonkey / JSC).

<!-- BENCH:END -->

Run `bun run bench` to reproduce the suite, `bun run bench:update-readme` to
regenerate the marked block, or
`URLENS_BENCH_BASELINE=/path/to/baseline bun run bench:ab` for paired
baseline/candidate profiling in one browser process.

## Runtime Requirements

- ESM only; CommonJS `require()` is not supported.
- Node.js 22 or newer.
- TypeScript 5 or newer when consuming the bundled declarations.
- Modern browsers with `TextDecoder`.
- No runtime dependencies.
- Bundlers must resolve package `exports`, accept ESM/ES2022 output, and should
  tree-shake named imports. Transpile the output if supporting older browsers.

## Input Contract

`urlens` accepts strings in either of these forms:

```text
scheme://[userinfo@]host[:port][/path][?query][#fragment]
[/]path[?query][#fragment]
```

The second form covers absolute and relative paths such as HTTP request targets.
For full URLs, `urlens` recognizes only hierarchical authority syntax containing
`://` after a valid scheme.

| Operation family | Hierarchical authority URL | Path or request target |
|---|---:|---:|
| Query reads and predicates | Yes | Yes |
| Query writes, removals, and `stripQuery` | Yes | Yes |
| Pathname reads, predicates, and `setPathname` | Yes | Yes |
| Fragment read and removal | Yes | Yes |
| Scheme, origin, host, hostname, and port reads | Yes | No |
| `hasScheme`, `rawOriginsEqual`, `setScheme`, `setPort` | Yes | No |
| `view` | Yes | Yes, with empty authority components |
| Query codec | Independent of URL shape | Independent of URL shape |

On path inputs, authority readers return `""`, `readPort` returns `null`,
`hasScheme` returns `false`, and `setScheme` is a no-op. `setPort` is also a
no-op after validating its port argument. `rawOriginsEqual` returns `false` if
either input has no recognized scheme.

The following URL features are deliberately outside the input grammar:

- Opaque schemes such as `mailto:` and `data:`.
- Protocol-relative authority parsing. `//example.com/path` is treated as a
  path, not as an authority.
- Base URL resolution.
- Host canonicalization, including IPv6 normalization and default-port removal.
- IDN or Punycode normalization.
- `.` and `..` path-segment normalization.

`urlens` deliberately leaves parsing and canonicalization out of the hot path.
Use the platform `URL` class first when input still needs either operation, then
reuse the normalized string with `urlens`.

## More Examples

```ts
import {
  decodeQueryComponent,
  encodeQueryComponent,
  readQueryParams,
  removeQueryParams,
  setQueryParams,
  view,
} from "urlens";

const [q, source] = readQueryParams("/search?q=hi&utm_source=docs", [
  "q",
  "utm_source",
] as const);

setQueryParams("https://example.com/?a=1&b=2", {
  a: "new",
  b: null,
  c: "3",
});
// "https://example.com/?a=new&c=3"

removeQueryParams("/?q=hi&utm_source=docs&utm_campaign=spring", [
  "utm_source",
  "utm_campaign",
]);
// "/?q=hi"

const v = view("https://example.com:8080/api?q=hello+world#frag");
v.pathname(); // "/api"
v.queryParam("q"); // "hello world"
v.port(); // 8080

decodeQueryComponent("caf%C3%A9+au+lait"); // "café au lait"
encodeQueryComponent("hello world"); // "hello+world"
```

## Query Semantics

- A missing key returns `null`. A present bare key (`?key`) or empty value
  (`?key=`) returns `""`.
- Reads and predicates use the first occurrence of a duplicate key.
- `setQueryParam` and `setQueryParams` replace the first matching occurrence
  and remove later duplicates. A `null` value removes every occurrence.
  `removeQueryParam` and `removeQueryParams` use the same removal behavior.
- Keys are compared after `application/x-www-form-urlencoded` decoding: `+`
  becomes space and percent-encoded UTF-8 is decoded. Values returned by query
  readers are decoded the same way.
- Setters encode keys and values using form semantics: spaces become `+`; the
  unescaped set is `*`, `-`, `.`, `_`, ASCII letters, and digits.
- Malformed percent escapes are tolerated and preserved literally. Malformed
  UTF-8 bytes decode with replacement characters rather than making malformed
  query data a parser error.
- Empty `&`-delimited query segments are ignored by field operations and can be
  omitted when a query is rebuilt. A field such as `=value` is an empty key, not
  an empty segment.
- Existing fields not selected by a setter or remover are preserved verbatim
  where the query is retained. Fragments are preserved.
- `readQuery` returns the raw query without `?`; it does not decode fields.

These are query-component semantics, not a claim of general WHATWG URL
equivalence.

## Flat Functions And Views

Flat functions have no view setup and are the simplest choice for independent
operations. `view(url)` creates an object that records component boundaries for
repeated access to the same string. Its query methods reuse the cached query
range but still scan query fields.

Choose based on the operations in your workload and measure if the distinction
matters. A view is created only by `view(url)`. `UrlView` is a public structural
TypeScript interface; there is no public constructor and it is not a class to
subclass.

## Raw Origin Comparison

`rawOriginsEqual(a, b)` compares selected components of already-normalized
hierarchical URL strings: scheme, hostname, and explicit or inferred port.
Scheme and hostname comparisons are ASCII case-insensitive, userinfo is
excluded, bracketed IPv6 is handled structurally, and default ports are inferred
for `http`, `https`, `ws`, `wss`, and `ftp`. Other schemes compare equal only
when their explicit ports match or both omit a port.

This is a raw-string optimization for normalized inputs, not native same-origin
logic or a replacement for the platform URL policy model.

## API Reference

All runtime APIs are named ESM exports from `urlens`. Functions return a new
string when rewriting and never mutate caller-owned state.

### Query API

| Function | Signature | Behavior |
|---|---|---|
| `readQueryParam` | `(url, key) => string \| null` | Returns the first decoded value. Missing keys return `null`; bare keys and empty values return `""`. |
| `readQueryParams` | `(url, keys) => (string \| null)[]` | Reads several keys together and preserves tuple order and inference for `as const` inputs. |
| `readQuery` | `(url) => string` | Returns the raw query without `?`, or `""` when absent. |
| `hasQueryParam` | `(url, key) => boolean` | Tests a decoded key without materializing its value. |
| `queryParamEquals` | `(url, key, expected) => boolean` | Compares the first decoded value in place. |
| `setQueryParam` | `(url, key, value) => string` | Sets one form-encoded key. `null` removes every occurrence. |
| `setQueryParams` | `(url, params) => string` | Applies several sets/removals in one query pass; `null` values remove keys. |
| `removeQueryParam` | `(url, key) => string` | Removes every decoded occurrence of one key. |
| `removeQueryParams` | `(url, keys) => string` | Removes several keys together. |
| `stripQuery` | `(url) => string` | Removes the complete query while preserving the fragment. |

Query keys and values use `application/x-www-form-urlencoded` rules. See
[Query Semantics](#query-semantics) for duplicate, malformed escape, and empty
field behavior.

### Component Readers And Predicates

| Function | Returns | Notes |
|---|---|---|
| `readPathname(url)` | `string` | Path without query or fragment; authority URLs without a path return `"/"`. Also accepts path-only inputs. |
| `readOrigin(url)` | `string` | Raw `scheme://host[:port]` with userinfo removed, or `""` for path-only input. |
| `readScheme(url)` | `string` | Scheme without `:`, or `""` when absent. |
| `readHost(url)` | `string` | Hostname plus explicit port, preserving IPv6 brackets and excluding userinfo. |
| `readHostname(url)` | `string` | Hostname without port or IPv6 brackets. |
| `readPort(url)` | `number \| null` | Explicit numeric port only; defaults are not inferred and malformed ports return `null`. |
| `readFragment(url)` | `string` | Fragment without `#`, or `""` when absent. |
| `hasScheme(url, scheme)` | `boolean` | ASCII case-insensitive scheme comparison. |
| `pathnameStartsWith(url, prefix)` | `boolean` | Tests the pathname without slicing it. |
| `pathnameEndsWith(url, suffix)` | `boolean` | Tests the pathname without slicing it. |
| `rawOriginsEqual(a, b)` | `boolean` | Compares raw scheme, hostname, and explicit/inferred special-scheme port. Requires normalized input. |

### Component Rewrites

| Function | Signature | Behavior |
|---|---|---|
| `setPathname` | `(url, pathname) => string` | Replaces the pathname and preserves query/fragment. Adds a leading `/`; does not normalize dot segments. Encode pathname `?` and `#` as `%3F` and `%23`. |
| `setScheme` | `(url, scheme) => string` | Replaces an existing scheme verbatim. The caller supplies valid scheme grammar; path-only input is unchanged. |
| `setPort` | `(url, port) => string` | Sets an integer from `0` to `65535`; `null` removes the explicit port. Invalid values throw `RangeError`. |
| `stripFragment` | `(url) => string` | Removes `#` and everything after it. |

### Views

`view(url)` returns the structural `UrlView` interface. It caches component
boundaries and is intended for repeated reads from the same string.

| Method | Returns or behavior |
|---|---|
| `toString()` | Original input string. |
| `scheme()` | Scheme without `:`. |
| `origin()` | Origin with userinfo removed. |
| `host()` | Hostname plus explicit port. |
| `hostname()` | Hostname without port or IPv6 brackets. |
| `port()` | Explicit numeric port or `null`. |
| `pathname()` | Pathname, using `"/"` for an absent authority path. |
| `query()` | Raw query without `?`. |
| `fragment()` | Fragment without `#`. |
| `queryParam(key)` | First decoded value, `null`, or `""` using flat-reader semantics. |
| `queryParams(keys)` | Object whose properties are the requested keys and whose values are decoded strings or `null`. |
| `hasQueryParam(key)` | Decoded-key presence test. |
| `queryParamEquals(key, expected)` | In-place decoded-value comparison. |
| `pathnameStartsWith(prefix)` | Pathname prefix test. |
| `pathnameEndsWith(suffix)` | Pathname suffix test. |

### Codec

| Function | Behavior |
|---|---|
| `encodeQueryComponent(value)` | Encodes one form component: space becomes `+`; bytes outside `* - . _ 0-9 A-Z a-z` are percent-encoded. |
| `decodeQueryComponent(raw)` | Decodes one form component. Malformed escapes remain literal and malformed UTF-8 uses replacement characters. |

## Development

```sh
bun install --frozen-lockfile
bun run ci
```

Project documentation:

- [Changelog](CHANGELOG.md)
- [Security policy](SECURITY.md)
- [Code of Conduct](CODE_OF_CONDUCT.md)
- [Contributing](CONTRIBUTING.md)
- [Support](SUPPORT.md)

## License

MIT
