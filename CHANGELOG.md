# Changelog

Notable changes are documented here. Before 1.0, minor releases may include
breaking API changes; those changes will be identified below.

## [0.1.1] - 2026-11-08

### Changed

- Avoid repeated delimiter searches across bare query fields and substring collisions.
- Use bounded native searches for long query values and comparisons.
- Reuse untouched URL slices in single-key setters and reduce work in bulk query updates.
- Reduce `view()` initialization and reuse its fragment boundary storage.
- Improve pathname reads before long query strings and selected port and scheme checks.
- Bound read-only query scans before large opaque fragments while preserving first-field fast paths.

### Verification

- Add cross-engine paired benchmarks, identical-source controls, and reproducible performance reports.
- Expand regression coverage and deterministic comparisons against earlier source snapshots.

The public API and input-handling behavior are unchanged. Performance depends on the input and
engine; individual tradeoffs and measurements are documented in
[performance analysis](bench/PERFORMANCE.md) and
[fragment-boundary analysis](bench/FRAGMENT_PERFORMANCE.md).

## [0.1.0] - 2026-07-29

First public release.

### Added

- URL component readers, predicates, setters, removal helpers, query codecs, and batched `view`
  access.
- Focused string-boundary scans with form-compatible query matching and encoding.
- ESM output with TypeScript declarations and support for Node.js 22 and newer.
- Cross-engine benchmarks for V8, SpiderMonkey, and JavaScriptCore.
- The package has no runtime dependencies.

### Limitations

- Inputs must already be normalized; use `URL` when parsing or canonicalization is needed.
- The library does not canonicalize IDNs, IPv6 hosts, or paths and returns best-effort results for
  malformed strings.
