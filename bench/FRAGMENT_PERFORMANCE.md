# Query reads before large fragments

This pass compares against the published commit
[`4d4dc02`](https://github.com/ph1losof/urlens/commit/4d4dc028a4b2adb065c6b2ad14b1072489090175).
The earlier optimization passes are recorded in [PERFORMANCE.md](PERFORMANCE.md).

## Finding and selected change

Native JavaScript `indexOf` accepts a start position but has no end position.
Clamping its result to the known query boundary does not prevent it from scanning
a large fragment first. That affected missing-key searches, the final field's
ampersand search, encoding detection, and batched field walkers.

For a fragment suffix of at least 256 UTF-16 code units, including `#`, the
read-only query APIs can now search a prefix ending at that boundary. Single-key
readers first check for an unambiguous match in the first field, avoiding prefix
allocation when that fast path can finish the operation. Its value-end helper
uses a bounded scalar scan for short ranges and native search for long ranges.
The batch field walkers bound their input before scanning; existing small-batch
delegations remain in place. `view()` retains its full
original string and component boundaries; no new persistent cache is added.

When the fragment begins with `&`, the old ampersand search already stops
immediately after the boundary. Those inputs retain the existing path. This
avoids an allocation penalty found in the supplemental controls. This exclusion
also means that misses in other large fragments beginning with `&` can still
scan their suffix; this change is not a universal complexity guarantee.

Setters, query-boundary parsing itself, and query-free fragment URLs retain
their existing algorithms. No new public API or runtime dependency is added.

## Measurement

Apple M4 Max, macOS arm64; Bun 1.4.3 and Node.js 26.10.0. Installed Playwright
1.62.0 uses Chromium 151.0.7922.34, Firefox 153.0, and WebKit 26.5.

The paired runner uses 60 ms windows, 5 rounds per source ordering, and 8
rotating inputs. Engines run sequentially. Both source orderings are built before
timing. The second ordering also reverses factory setup, warmup, and alternating
timing order, balancing the odd number of rounds. Each ratio geometrically
combines the two source-order medians. Higher ratios mean more operations per
second. Inputs and retained views are prepared before timing.

This pass has 56 cases: 29 ordinary controls, 18 opaque-fragment cases (including
already-fast first-field hits), and 9 cases with markers immediately after `#`.
Opaque fragments contain 8 KB or 128 KB of repeated ASCII plus a rotating digit;
the query has two short fields. The marker controls begin with `&%+missing=`.
These deliberately expose both expensive suffix searches and cases that already
stop early. They do not represent measured production traffic.

| Workload | V8 | SpiderMonkey | JavaScriptCore |
| --- | ---: | ---: | ---: |
| Read last key, 8 KB opaque fragment | 3.39× | 2.41× | 2.53× |
| Miss key, 8 KB opaque fragment | 8.91× | 5.61× | 7.98× |
| Test missing key, 8 KB opaque fragment | 9.05× | 5.51× | 8.17× |
| Compare last value, 8 KB opaque fragment | 3.35× | 2.43× | 2.63× |
| Read three keys, 8 KB opaque fragment | 4.60× | 3.36× | 3.79× |
| Retained view miss, 8 KB opaque fragment | 4.87× | 3.12× | 7.24× |
| Read last key, 128 KB opaque fragment | 40.02× | 23.27× | 28.26× |
| Miss key, 128 KB opaque fragment | 122.87× | 68.48× | 110.66× |
| Retained view miss, 128 KB opaque fragment | 68.76× | 33.92× | 99.89× |
| Read first key, 8 KB opaque fragment | 1.05× | 1.00× | 1.05× |
| Test first key, 8 KB opaque fragment | 0.97× | 0.91× | 1.02× |
| Read last key, markers immediately after # | 0.95× | 0.96× | 0.98× |
| Miss key, markers immediately after # | 0.99× | 0.96× | 0.99× |
| Retained view miss, markers immediately after # | 1.00× | 0.91× | 0.96× |

The following geometric means assign equal weight to each case within a group.
They describe this suite, not an application's overall speedup.

| Group | V8 | SpiderMonkey | JavaScriptCore |
| --- | ---: | ---: | ---: |
| All 56 cases | 2.05× | 1.80× | 1.98× |
| 29 ordinary controls | 0.99× | 1.00× | 1.00× |
| 18 opaque-fragment cases | 9.56× | 6.39× | 8.48× |
| 9 fragments with early markers | 0.97× | 0.96× | 0.98× |

The [full results](performance-fragments.txt) retain every case, throughput, and
both source-order deltas, including regressions. The gains apply most strongly
when the old searches traversed the fragment. Inputs that already stop early can
still have small costs from the added checks; no universal fastest result is
claimed.

A [balanced identical-source WebKit control](performance-control-balanced-aa.txt)
compares two byte-identical copies of the baseline using 80 ms windows and
5 rounds per ordering. Reversing setup and timing
addresses a fixed ordering asymmetry but does not eliminate runtime variation:
its CJK encoding control is about 15% slower despite identical source. Treat
small deltas cautiously, especially in allocating-string benchmarks. The large
fragment-query gains are substantially larger and stable across source orderings.

## Alternatives tested

- Clipping every large-fragment read up front accelerated misses but slowed
  already-fast first-key presence checks by about 44% in WebKit. Rejected.
- Putting range guards in shared key/encoding helpers preserved first hits but
  slowed some ordinary short comparisons by about 6–9% in V8. Rejected.
- Keeping the specialization behind the large-suffix condition preserved the
  normal paths, but initially slowed retained reads when markers were immediately
  after the fragment delimiter. Retaining the native path for a leading fragment
  ampersand addressed that case.

## Correctness and size

`BUN_OPTIONS= bun run ci` passes all 406 tests, formatting, linting, TypeScript,
the 99% coverage gate (2,595/2,615 lines, 76/76 functions), package inspection,
and installed-package consumer checks. Public exports remain at 28. New tests
cover the exact suffix cutoff, bare/empty fields, long values, decoded and
malformed keys, marker-rich fragments, and preservation of `view().toString()`
and `view().fragment()` after query reads.

The extended `scripts/verify-baseline.ts` passes 1,084,875 deterministic
comparisons per baseline (seed 123456789), including 60,000 added large-fragment
checks. It passes against both `4d4dc02` and the original `417c0c9` snapshot.
The component/encoding verifier also passes 446,304 comparisons against
`4d4dc02` (seed 987654321): 2,616,054 comparisons in total for the final source.

Local minified browser export bundles, gzip bytes:

| Import | Published checkpoint | Current | Change |
| --- | ---: | ---: | ---: |
| Full API | 8,218 | 8,543 | +325 |
| `readPathname` | 451 | 451 | 0 |
| `readQueryParam` | 1,973 | 2,120 | +147 |
| `queryParamEquals` | 1,477 | 1,635 | +158 |
| `view` | 3,642 | 3,851 | +209 |

The separate installed-package consumer fixture still measures 463 bytes gzip
for `readPathname`. The encoder remains unchanged.

## Reproduce

Create a separate baseline checkout of `4d4dc02` and run from the current source:

```sh
URLENS_BENCH_BASELINE=/path/to/checkpoint \
URLENS_BENCH_FILTER=boundary.,flat.query.,flat.has,flat.equals,extra.mixed.,view.query. \
URLENS_BENCH_BUDGET=60 URLENS_BENCH_ROUNDS=5 \
bun run bench:ab

BUN_OPTIONS= bun run ci
BUN_OPTIONS= URLENS_BENCH_BASELINE=/path/to/checkpoint bun scripts/verify-baseline.ts
BUN_OPTIONS= URLENS_BENCH_BASELINE=/path/to/checkpoint bun scripts/verify-components.ts
```

Both verifiers accept `URLENS_BENCH_CANDIDATE` for an isolated candidate source
snapshot. Preserve `package.json` in snapshots so bundling uses the same module
and `sideEffects` metadata. For an A/A control, provide two distinct directories
containing byte-identical baseline `src` and `package.json` files.
