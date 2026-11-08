# Performance analysis

This report records the optimization passes published at `4d4dc02`. See the
[latest fragment-boundary pass](FRAGMENT_PERFORMANCE.md) for current measurements,
validation, and sizes. Historical tables below retain their original harness;
the current runner additionally balances factory setup, warmup, and timing order.

The selected changes remove repeated scans and defer work until a match is
plausible. They preserve the public API and add no runtime dependencies or
persistent caches. Timing results are workload-specific; an absolute fastest
implementation for every engine and input shape is not established by these
measurements.

## Selected changes

- Query walkers retain the next `=` position across bare fields. Previously,
  `?flag&flag&…&last=1` repeatedly searched the same remaining suffix. Fixed-size
  bare fields exposed quadratic delimiter-scanning work. Each pass now advances
  monotonically; batched key comparisons still depend on the requested key count.
- Long values use native searches over a bounded raw slice to detect `%` and `+`.
  Plain values avoid a JavaScript iteration per character. Long plus replacements
  use `replaceAll`; malformed escapes retain the tolerant decoder.
- Long value equality uses native raw string comparison when decoding cannot
  change the answer. Short values call the original scalar walker directly,
  avoiding the extra dispatch through the long-value helper. Ambiguous escapes
  and plus/space matches retain the decoding walker.
- Single-key setters reuse the untouched prefix before their first match, or
  the existing query when appending a missing key. Duplicate removal, empty-field
  formatting, and fragments remain covered by regression tests.
- After a false substring hit inside a query field, key lookup jumps to the next
  possible boundary instead of examining every repeated occurrence in a value.
  The helper caches question-mark searches to keep its scans monotonic. Ordinary
  first-field hits, direct later-field hits, and misses avoid this helper.
- Bulk setters and removals test packed key metadata and the raw prefix before
  checking ambiguity. In particular, large batches no longer rescan every
  requested key for encoding characters on every nonmatching field.
- The redundant view helper for bare-field walking was removed.
- `view()` erases type-only field declarations instead of emitting nine undefined
  initializations before constructor assignments. The fragment boundary reuses
  `_queryEnd`, reducing each instance from nine component slots to eight.
- Path readers and predicates use a bounded backwards fragment probe when a long
  URL has an early query. This avoids searching a large query suffix for `#`.
  Short URLs and long paths retain native forward searching.
- Four-digit explicit ports use the same validated arithmetic fast path already
  used by `view().port()`. Other lengths retain the digit loop.
- Scheme comparison folds validated scheme bytes with an ASCII mask. Expected
  control characters are explicitly rejected because some would otherwise alias
  valid punctuation or digits under that mask.

The encoder, scheme detector, and authority scanners remain unchanged. Hash-table
removal variants and Unicode encoding caches are excluded from the final implementation.

## Measurement

Baseline commit: `417c0c9f4e979471ec0366622b46ccd2c5e9e591`.
Host: Apple M4 Max, macOS arm64. Runner: Bun 1.4.3, Node.js 26.10.0.
Installed Playwright 1.62.0 engines: Chromium 151.0.7922.34, Firefox 153.0,
WebKit 26.5.

The paired harness rotates eight inputs, warms both implementations, alternates
measurement order, takes median ratios, and repeats with module source order
inverted. Each displayed ratio combines both source orderings geometrically.
Above 1.00× means higher throughput. Engines run sequentially.

The full comparison uses 78 cases, 60 ms per timing window, and 5 rounds per
source ordering. Inputs are prepared before timing and allocations escape into
retained arrays. Expensive bare-field cases use batches of 16 calls rather than
1,024 to limit timing-budget overshoot.

## Query optimization passes against the original code

| Workload | V8 | SpiderMonkey | JavaScriptCore |
| --- | ---: | ---: | ---: |
| Decode a 4 KB plain value | 23.34× | 32.56× | 13.48× |
| Read a 4 KB query value | 14.57× | 16.37× | 6.75× |
| Compare a 4 KB query value | 19.29× | 22.59× | 9.19× |
| Read 3 keys after 8,192 bare fields | 31.31× | 22.60× | 48.04× |
| Replace a key after 8,192 bare fields | 35.85× | 19.82× | 35.93× |
| Short query: replace the last key | 1.08× | 1.17× | 1.15× |
| Short query: append a missing key | 1.17× | 1.19× | 1.17× |
| Short query: read an existing key | 1.00× | 1.02× | 1.00× |
| Short query: test value equality | 0.99× | 1.03× | 1.05× |

The complete [original-baseline measurements](performance-ab.txt) include all
78 cases, throughput, and both source-order deltas. These historical measurements
compare the original source with the two query optimization passes, reconstructed
using [round2-source.patch](round2-source.patch). The component pass is
measured separately below against that exact snapshot.

## Second query pass compared with the first

The incremental baseline is the exact source snapshot from the previous pass.
It can be reconstructed from the baseline commit using
[round1-source.patch](round1-source.patch). This comparison uses 36 cases,
80 ms per timing window, and 5 rounds per ordering.

| Workload | V8 | SpiderMonkey | JavaScriptCore |
| --- | ---: | ---: | ---: |
| Read a key repeated in a 32-character value | 5.86× | 4.53× | 3.05× |
| Read a key repeated in a 4 KB value | 125.37× | 134.84× | 65.82× |
| Miss a key repeated in a 4 KB value | 83.46× | 93.72× | 43.37× |
| Remove 64 requested keys from 128 fields | 2.09× | 1.86× | 1.95× |
| Remove 256 requested keys from 128 fields | 2.99× | 2.63× | 2.31× |
| Remove 64 requested keys from a short query | 2.83× | 2.41× | 2.42× |
| Remove 256 requested keys from a short query | 3.26× | 2.76× | 2.48× |
| Set 64 requested keys across 128 fields | 1.83× | 1.77× | 1.74× |
| Set 256 requested keys across 128 fields | 2.40× | 2.21× | 2.24× |
| Short value equality | 1.00× | 1.09× | 1.09× |
| Mixed schemes: path, value, presence, equality | 0.98× | 1.02× | 0.99× |
| Mixed schemes: replace a query value | 1.00× | 1.02× | 1.02× |

For an explicit net comparison, the following geometric means weight every
case in each stated group equally. These weights describe this suite, not an
application's production traffic. The full 36-case group includes seven
unchanged encoder controls as well as the ordinary flat and mixed workloads.

| Incremental workload group | V8 | SpiderMonkey | JavaScriptCore |
| --- | ---: | ---: | ---: |
| All 36 equally weighted cases | 1.74× | 1.69× | 1.56× |
| 11 ordinary flat operations | 1.00× | 1.03× | 1.02× |
| 2 mixed workloads | 0.99× | 1.02× | 1.00× |

See the complete [incremental measurements](performance-incremental.txt).
Unchanged encoder and authority functions provide controls for source-layout,
warmup, allocation, and engine variation. Differences of only a few percent
need cautious interpretation; the individual rows retain small slowdowns rather
than claiming every operation improves.

## Component improvements beyond the query passes

The baseline for this pass is the exact two-query-pass snapshot, reconstructed
by applying [round2-source.patch](round2-source.patch) to the original commit.
The comparison uses 51 cases, 60 ms timing windows, 5 rounds, both source
orderings, and sequential browser engines. The path-tail cases use about 7 KB
of query text; unchanged encoder controls include 4 KB safe prefixes.
Constructors escape into retained arrays to prevent allocation removal.

| Workload | V8 | SpiderMonkey | JavaScriptCore |
| --- | ---: | ---: | ---: |
| Read pathname before a long query | 3.76× | 3.08× | 4.27× |
| Read relative pathname before a long query | 5.66× | 5.16× | 8.05× |
| Check two path predicates before a long query | 3.60× | 3.09× | 4.06× |
| Read a genuinely long path (control) | 0.99× | 0.99× | 1.01× |
| Construct an escaping view | 1.03× | 1.29× | 1.05× |
| Construct a view and read five components | 1.02× | 1.28× | 1.09× |
| Read five components from a retained view | 1.01× | 1.07× | 1.03× |
| Read a four-digit port | 0.97× | 1.05× | 1.17× |
| Test a case-folded scheme | 1.04× | 0.98× | 1.31× |
| Encode a short mixed string | 1.05× | 0.99× | 1.03× |

The geometric means below weight each case in the named group equally. These
weights describe the benchmark suite, not a production traffic model or an
end-to-end application speedup.

| Component-pass group | V8 | SpiderMonkey | JavaScriptCore |
| --- | ---: | ---: | ---: |
| All 51 cases | 1.16× | 1.17× | 1.21× |
| 11 ordinary flat operations | 1.01× | 1.01× | 1.01× |
| 2 mixed request/rewrite workloads | 1.00× | 1.01× | 0.99× |
| 12 encoding cases | 1.04× | 1.01× | 0.96× |
| 8 view cases | 1.01× | 1.19× | 1.03× |
| 8 path cases | 2.44× | 2.21× | 2.77× |
| 5 port cases | 0.95× | 1.03× | 1.15× |
| 5 scheme cases | 1.03× | 1.00× | 1.17× |

Individual regressions are retained in the [complete paired results](performance-other-areas.txt).
The five V8 port cases average 0.95×, including malformed-port rejection at
0.91×; the corresponding WebKit group averages 1.15×. Scheme matching and view
reads also have engine-specific tradeoffs.

A separate [identical-source WebKit control](performance-control-aa.txt) uses two
copies of the query-pass baseline with the same 60 ms/5-round settings and both
source orderings. Despite identical implementations, it reports dense encoding
at 0.83×, Latin text at 0.82×, CJK text at 1.21×, and retained port reads at 0.94×.
Its long-query pathname control is 1.01×. These results expose substantial
benchmark sensitivity for allocating strings and some retained-object calls;
they do not identify a single cause. Do not attribute small microbenchmark
changes or those Unicode-control deltas to an algorithm. The 3–8× path gains
are much larger than the corresponding identical-source control variation.
The suite geometric means above describe the recorded run; they are not a
universal or production-weighted speed guarantee.

The selected implementation adds no dependencies, Unicode lookup caches, or
public exports. Gzip and correctness costs are recorded below.

## Alternatives measured and rejected

| Alternative | Reason excluded |
| --- | --- |
| Unconditional regex encoding | A focused trial made short ASCII encoding about 48% slower in V8. |
| Native URI encoding for long strings | One variant made dense Unicode encoding about 75% slower in WebKit. Other variants also lost on short strings. |
| Unrolled HTTP scheme detection | Small, inconsistent gains across engines did not justify the added path. |
| Hash lookup for bulk removal | It accelerated large lists on large queries but lost materially on short queries. Guarded variants still slowed medium lists in focused V8 trials. The compact filtered loop was retained. |
| Native authority regex scans | They accelerated long hosts several-fold, but short hostname/port reads and view construction lost about 20–30% in the initial trial. A scalar-prefix hybrid still slowed short construction in V8. |
| Precomputed UTF-8 two-byte strings | Latin/Cyrillic gains came with about a 31% CJK regression in SpiderMonkey and 22–25% regressions on long ASCII in V8. Lazy caching also regressed CJK. The caches add startup work or retained memory. |
| Separate percent-byte appends | A focused trial lost about 23% on dense encoding in V8 and 21–25% on Cyrillic/Latin text in WebKit. |
| Exact-case `startsWith` scheme shortcut | It improved exact matches but slowed WebKit case-folded matches by about 18% and same-length misses by 27%. The validated ASCII-mask loop was selected instead. |
| Guarded native encoding-prefix scans | Trials showed about 2–3.4× gains on long safe prefixes but did not establish a balanced result across short and Unicode inputs. An isolated scalar helper slowed short strings by about 8–10%. Some Unicode deltas are confounded by the identical-source control variation above. The original encoder was retained. |

## Component-pass correctness and packaging

At `4d4dc02`, the complete CI command passed: formatting, linting, TypeScript, 402 tests, the
99% coverage gate, package build/inspection, and installed-package consumer
checks. Public exports remain at 28. Regression cases cover long values,
malformed and truncated UTF-8, plus/space equality, bounded ranges, duplicate and
empty fields, literal question marks, substring collisions, large removal lists,
and fragments. Additional cases cover long-query pathname boundaries, frozen
views, malformed authorities, each digit of four-character ports, scheme control
characters, and long encoding prefixes with lone surrogates (encoder controls).

The `4d4dc02` version of `scripts/verify-baseline.ts` performs 1,024,875 deterministic comparisons against
the original code, including generated API calls, exhaustive empty-field layouts,
large key lists, and 703,125 exhaustive raw-key searches. Its fixed seed is
123456789. Run it against the original or reconstructed previous-pass baseline.

`scripts/verify-components.ts` adds 446,304 deterministic comparisons per
baseline (seed 987654321): mixed/malformed URL components, view methods, setters,
path predicates, origin comparison, scheme aliases, all 65,536 individual UTF-16
code units, and 10,000 generated Unicode strings checked against both the
baseline and `URLSearchParams`. It passes against the original and query-pass
snapshots (892,608 comparisons).

Local minified browser export bundles, gzip bytes:

| Import | Original | First pass | Query passes | Component pass |
| --- | ---: | ---: | ---: | ---: |
| Full API | 7,877 | 8,074 | 8,172 | 8,218 |
| `readPathname` | 408 | 408 | 408 | 451 |
| `readQueryParam` | 1,762 | 1,883 | 1,973 | 1,973 |
| `queryParamEquals` | 1,295 | 1,366 | 1,477 | 1,477 |
| `view` | 3,509 | 3,564 | 3,675 | 3,642 |

The component pass adds 46 gzip bytes to the full API and removes
33 gzip bytes from `view`. The focused pathname bundle adds 43 bytes. The
focused port reader adds 60 bytes and the scheme predicate removes 14 bytes.
The encoder remains at 494 bytes.
The installed-package consumer fixture measures 463 bytes gzip for `readPathname`;
that fixture differs from the export-only bundles above.

## Reproduce

Run from the candidate checkout with the original commit checked out in a
separate baseline directory. Preserve its `package.json` so both builds use the
same module and `sideEffects` metadata.

```sh
URLENS_BENCH_BASELINE=/path/to/original-baseline \
URLENS_BENCH_BUDGET=60 URLENS_BENCH_ROUNDS=5 \
bun run bench:ab
```

For the incremental baseline, apply `bench/round1-source.patch` to a separate
checkout of the same commit, then run:

```sh
URLENS_BENCH_BASELINE=/path/to/previous-pass \
URLENS_BENCH_FILTER=flat.,extra. \
URLENS_BENCH_BUDGET=80 URLENS_BENCH_ROUNDS=5 \
bun run bench:ab
```

For the component comparison, apply `bench/round2-source.patch` to a
separate clean checkout of the baseline commit, then run:

```sh
URLENS_BENCH_BASELINE=/path/to/query-pass-baseline \
URLENS_BENCH_FILTER=flat.,view.construct.escape,view.read1,view.read5,view.retain.,area.path,area.port.,area.scheme.,area.encode.,extra.encode.,extra.mixed.,area.short.construct,area.complex.construct \
URLENS_BENCH_BUDGET=60 URLENS_BENCH_ROUNDS=5 \
bun run bench:ab
```

`URLENS_BENCH_FILTER` accepts comma-separated name prefixes. Examples: `flat.`,
`view.`, `scale.`, `extra.collision.`, `extra.remove.`, `extra.set.`, and `area.`.
`URLENS_BENCH_ENGINE=chromium`, `firefox`, or `webkit` selects one engine.

```sh
BUN_OPTIONS= bun run ci
BUN_OPTIONS= URLENS_BENCH_BASELINE=/path/to/original-baseline bun scripts/verify-baseline.ts
BUN_OPTIONS= URLENS_BENCH_BASELINE=/path/to/query-pass-baseline bun scripts/verify-components.ts
```

Clearing unrelated local Bun preloads keeps them out of the coverage totals.
