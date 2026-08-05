# Releasing

Releases are automated with [release-please](https://github.com/googleapis/release-please).
You do **not** tag by hand.

## How it works

1. Land changes on `main` via PR using [Conventional Commits](https://www.conventionalcommits.org/)
   (`feat:`, `fix:`, `perf:`, `build(deps):`, `docs:`, `chore:` …). Squash-merge titles are
   what release-please reads, so keep the squash title conventional.
2. On each push to `main`, the `release-please` workflow opens or updates a single
   **release PR** ("chore(main): release X.Y.Z") that rolls every change since the last
   release into one version bump + `CHANGELOG.md` update. Multiple fixes/features accumulate
   into that one PR.
3. **Merging the release PR** tags `vX.Y.Z` and publishes a GitHub Release with notes.
   That tag is what downstream pins to.

Version bumps (pre-1.0): `fix:` → patch, `feat:` → minor, breaking (`!` / `BREAKING CHANGE`)
→ minor while `0.x`. Adjust in `release-please-config.json`.

## Shipping a dependency/security fix immediately

`build(deps):` commits ride along in the next release but do **not** bump the version on
their own. To cut a release for a security dependency bump right away, give its squash-merge
title a `fix:` prefix (e.g. `fix(deps): bump <pkg> for CVE-XXXX`) — that forces a patch release.

## One-time repo setting

release-please needs **Settings → Actions → General → "Allow GitHub Actions to create and
approve pull requests" = ON**, otherwise the release PR can't be opened.

## How downstream consumes releases

This is a self-hosted **app**, not an npm package — consumers clone and run it. They should:

- **Watch → Releases** on GitHub to be notified of new versions, and
- pin to a release tag (`git checkout vX.Y.Z`) or track `main`.

Their own Dependabot (this repo ships a `.github/dependabot.yml` they inherit on fork) keeps
their dependency tree patched.

## Safety gate

Every commit/push must pass `npm run leak-gate` (provider-key scan + personal/infra identifier
scan). It runs in CI and should be wired as a local `pre-push` hook:

```sh
printf '#!/usr/bin/env sh\nnpm run leak-gate\n' > .git/hooks/pre-push
chmod +x .git/hooks/pre-push
```
