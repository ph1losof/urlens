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

Publishing with npm provenance and GitHub attestations requires this repository to be public.
Before enabling releases, also create an `npm` GitHub environment restricted to protected `v*`
tags, require approval for that environment, and enable branch protection for `main`.

1. Update `version` in `package.json` and run `bun install` to update `bun.lock`.
2. Merge the version change to `main` after `ci` and `codeql` pass.
3. Create a GitHub release with tag `v<package version>` and generated release notes.
4. Mark versions containing a prerelease suffix as a GitHub prerelease. They publish with the
   npm `next` dist-tag; stable releases publish with `latest`.

The `release.yml` workflow rebuilds and tests from the tag, packs and smoke-tests the exact npm
tarball, publishes it with provenance, generates a CycloneDX SBOM and SHA-256 checksums, and
creates GitHub SLSA and SBOM attestations.

For the first npm publish, add a short-lived granular automation token as the `NPM_TOKEN` secret
on the `npm` GitHub environment. After the package exists, configure npm trusted publishing for
`ph1losof/urlens`, workflow `release.yml`, environment `npm`, then remove the token. npm trusted
publishing requires no repository secret and automatically uses the workflow's OIDC identity.

For the security jobs, enable the dependency graph, Dependabot alerts and security updates, and
private vulnerability reporting in the repository security settings. CodeQL and dependency review
skip while the repository is private on a plan without GitHub Code Security.
