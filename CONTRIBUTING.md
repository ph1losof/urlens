# Contributing

## Setup

Install the Bun version declared in `package.json`, then install dependencies:

```sh
bun install --frozen-lockfile
```

Run the same validation used by CI:

```sh
bun run ci
```

Useful focused commands are listed in the README. Use `bun run fix` to apply safe Biome
formatting, lint fixes, and import organization before opening a pull request.

## Releases

One-time setup:

- Enable private vulnerability reporting, then make the repository public.
- Protect `main` and `v*` tags.
- Create an `npm` environment with reviewer approval and restrict it to `main`.
- Configure npm trusted publishing for `ph1losof/urlens`, workflow `release.yml`, environment `npm`,
  with `npm publish` permission.

1. Update `package.json`, replace the changelog's `Unreleased` marker with the release date, update
   the supported line in `SECURITY.md`, and update the bug report version placeholder. Run
   `bun install`; commit `bun.lock` only if it changes.
2. Merge the release preparation to `main` after `ci` and `codeql` pass.
3. Create and push an exact `v<package version>` tag pointing to that commit.
4. Run the `release` workflow from `main` and enter the package version without the `v` prefix.

The workflow validates the tag and package metadata, runs CI, publishes the tested artifact,
verifies npm integrity, and creates the GitHub release with provenance, an SBOM, checksums, and
attestations. Stable versions use `latest`; prereleases use `next`.

Publishing uses npm trusted publishing through GitHub OIDC. Do not store an npm publish token in
GitHub. Require 2FA and disallow traditional publish tokens in the npm package settings. The
workflow pins npm 11.5.1 on Node.js 24.

Before tagging, enable the dependency graph, Dependabot alerts and updates, private vulnerability
reporting, approved Actions with full-SHA pinning, and run the cross-engine benchmark.
