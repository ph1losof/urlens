# Changelog

Notable changes are documented here. Before 1.0, minor releases may include
breaking API changes; those changes will be identified below.

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
