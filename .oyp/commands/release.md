# Release

Release all packages at specified version.

## Arguments

`$ARGUMENTS`: semver version, e.g. `3.13.0`.

## Version

- Last release: latest git tag (`vX.Y.Z`); confirm matches `packages/*/package.json` versions.
- No version: review commits since last tag; choose major/minor/patch; bump.
- `major`/`minor`/`patch`: bump last tag — major `X+1.0.0`; minor `X.Y+1.0`; patch `X.Y.Z+1`.

## Run

```bash
pnpm run release -- $ARGUMENTS
```

Script automatically:
1. Pre-flight: clean working dir; HEAD contains `origin/main`; `bazelisk` on PATH.
2. Update all `package.json`/`Cargo.toml` versions.
3. Regenerate `pnpm-lock.yaml`, `Cargo.lock`, `bazel/clippy.bazelrc`, and `MODULE.bazel.lock`.
4. Update CHANGELOGs: `[Unreleased] → [version] - date`.
5. Run `pnpm run check`; commit and tag.
6. Push branch and tag atomically.
7. Watch CI until all workflows pass.

## CI failures

CI failure → script exits with error. Fix, then repeat until CI passes:

```bash
git commit -m "fix: <brief description>"
git push origin main
git tag -f v$ARGUMENTS && git push origin v$ARGUMENTS --force
pnpm run release -- watch
```

`watch`: re-watches CI for current commit until all checks pass.
