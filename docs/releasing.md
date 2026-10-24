# Releasing (Windows, local build and upload)

This repository is released **from a Windows workstation**. Version bump, artifacts, and
GitHub Release upload all happen locally. GitHub Actions is not the release path; do not
wait for or gate on CI.

Placeholders below use `X.Y.Z` (example: `18.12.3`).

## 0. Preconditions

```bash
git branch --show-current          # must be main
git status --porcelain             # must be empty
git fetch origin main
git merge-base --is-ancestor origin/main HEAD   # must succeed (fast-forward push)
```

Check for a tag collision. A fork can carry upstream tags that this repository never
released:

```bash
git ls-remote --tags origin | grep "vX\.Y\.Z"
gh release list --limit 5
```

If the tag exists but has no GitHub Release and does not point at this repo's history,
delete it (with user confirmation) before releasing:

```bash
git push origin :refs/tags/vX.Y.Z
```

The release script refuses to overwrite a tag because it pushes without `--force`.

Do **not** run `pnpm run release` on Windows. Its `sd` invocations are quoted for POSIX
shells and fail with `os error 123`; its bazel step also needs GitHub release downloads
that are blocked here. Follow the steps below instead.

## 1. Bump versions

Run one Node one-liner over the non-private packages (never `sd` — Windows argument
quoting breaks it):

```bash
node -e '
const fs=require("fs"),V="X.Y.Z";
for (const d of fs.readdirSync("packages",{withFileTypes:true})) {
  if (!d.isDirectory()) continue;
  const p="packages/"+d.name+"/package.json";
  if (!fs.existsSync(p)) continue;
  const o=JSON.parse(fs.readFileSync(p,"utf8"));
  if (o.private) { console.log("skip",o.name); continue; }
  fs.writeFileSync(p, fs.readFileSync(p,"utf8").replace(/"version": "[^"]+"/, `"version": "${V}"`));
}'
```

Private packages (`browser-relay`, `collab-web`, `pi-metaharness`,
`typescript-edit-benchmark`) keep their own versions.

Then update the pnpm catalog and the Rust workspace version:

```bash
# pnpm-workspace.yaml: every @oh-my-pi/* catalog entry
node -e 'const fs=require("fs"),V="X.Y.Z";let y=fs.readFileSync("pnpm-workspace.yaml","utf8");y=y.replace(/^(\s*"@oh-my-pi\/[^"]+":\s*)"[^"]+"/gm,`$1"${V}"`);fs.writeFileSync("pnpm-workspace.yaml",y)'

# Cargo.toml: [workspace.package] version
node -e 'const fs=require("fs"),V="X.Y.Z";let c=fs.readFileSync("Cargo.toml","utf8");c=c.replace(/^version = "[^"]+"/m,`version = "${V}"`);fs.writeFileSync("Cargo.toml",c)'
```

Keep `package.json`'s `"@oh-my-pi/pi-utils": "catalog:"` untouched. The upstream release
script rewrites that value to a concrete version; this repository keeps the catalog
protocol.

Verify all twelve public packages report `X.Y.Z`.

## 2. Refresh lockfiles

```bash
pnpm install
cargo update --workspace          # rewrites workspace crate versions in Cargo.lock
node --experimental-transform-types --import ./scripts/node-runtime-loader.mjs scripts/gen-clippy-bazelrc.ts
```

### MODULE.bazel.lock — run in WSL

`MODULE.bazel.lock` records hashes of `Cargo.toml`/`Cargo.lock`, so every version bump
invalidates it. Generate it on Linux (WSL), not on Windows:

- the CI check runs on Ubuntu, and a Linux-generated lock matches it;
- Windows cannot download `cargo-bazel.exe` / Rust nightly archives from GitHub here.

```bash
wsl.exe -d Ubuntu-26.04 -- bash -lc \
  'cd /mnt/c/Users/<user>/www/oh-your-pi && bazelisk fetch --repo=@crates --lockfile_mode=update'

# verify exactly what CI does
wsl.exe -d Ubuntu-26.04 -- bash -lc \
  'cd /mnt/c/Users/<user>/www/oh-your-pi && bazelisk fetch --repo=@crates --lockfile_mode=error'
```

The refresh may take an hour on a cold cache (Rust nightly host tools). Confirm the diff
only touches the two `FILE:@@//Cargo.*` hash lines plus the usual reordering, and that no
`ENV:CARGO_BAZEL_GENERATOR_URL` entry leaked into the lock.

## 3. Finalize changelogs

```bash
node --experimental-transform-types --import ./scripts/node-runtime-loader.mjs scripts/fix-changelogs.ts
```

Then promote each non-empty `## [Unreleased]` to a dated version section and leave a new
empty `## [Unreleased]` at the top:

```bash
node -e '
const fs=require("fs"),V="X.Y.Z";
const date=new Date().toISOString().split("T")[0];
const has=c=>{const m=c.match(/## \[Unreleased\]\s*\n([\s\S]*?)(?=## \[\d|$)/);return m?m[1].trim().length>0:false};
for (const d of fs.readdirSync("packages",{withFileTypes:true})) {
  const p="packages/"+d.name+"/CHANGELOG.md";
  if (!d.isDirectory()||!fs.existsSync(p)) continue;
  let c=fs.readFileSync(p,"utf8");
  if (!c.includes("## [Unreleased]")) continue;
  if (has(c)) {
    c=c.replace("## [Unreleased]",`## [${V}] - ${date}`).replace(/^(# Changelog\n\n)/,`$1## [Unreleased]\n\n`);
  }
  fs.writeFileSync(p,c);
}'
```

## 4. Checks

```bash
pnpm run check
```

Known Windows limitations (do not block the release on them; the release artifacts are
verified by the smoke test in step 5):

- `oxfmt --check` receives literal quotes through `cmd.exe`, so `check:tools` reports
  `Expected at least one target file`.
- `check:types` can fail on pre-existing ghost imports (`@sinclair/typebox`,
  `devtools-protocol`) that are not declared in the importing package's manifest.

## 5. Build artifacts locally

Two targets ship: `win32-x64` and `darwin-arm64`.

### 5a. Bundle and launchers

```bash
NODE_PATH="C:/Users/<user>/www/oh-your-pi/packages/coding-agent/node_modules" \
node --experimental-transform-types --import ./scripts/node-runtime-loader.mjs \
  scripts/ci-release-build-binaries.ts --targets win32-x64,darwin-arm64
```

`NODE_PATH` is required because `@huggingface/transformers` is not hoisted to the root
`node_modules`.

### 5b. Stamp native addons with the new version

Release archives embed the version stamp; a stale stamp is rejected at startup.

```bash
chmod u+w packages/natives/native/pi_natives.win32-x64-baseline.node \
           packages/natives/native/pi_natives.darwin-arm64.node

node --experimental-transform-types --import ./scripts/node-runtime-loader.mjs \
  scripts/stamp-native-version.ts \
  packages/natives/native/pi_natives.win32-x64-baseline.node \
  packages/natives/native/pi_natives.darwin-arm64.node
```

If `EPERM ... rename` appears, the file is read-only; run `chmod u+w` first. For the
Mach-O addon, stamp a writable copy if the in-place rename keeps failing, then move it
back.

### 5c. Runtime dependencies (hoisted)

`package-portable.ts` expects a flat `node_modules`; pnpm's virtual store has broken
symlinks for other platforms. Build a clean hoisted tree with npm:

```bash
mkdir -p /c/Users/<user>/oyp-build/appdeps && cd /c/Users/<user>/oyp-build/appdeps
npm init -y
npm install --omit=dev --no-audit --no-fund \
  onnxruntime-node@1.26.0 fastembed@3.0.0 prettier@3.9.10
```

Match the versions the bundle actually resolves (`node_modules/prettier/package.json`,
`node_modules/.pnpm/fastembed@3.0.0/...`). The npm packages carry their own
platform binaries under `bin/`.

### 5d. darwin runtime

Download the same Node version the Windows host uses:

```bash
curl -sSL -o /c/Users/<user>/oyp-build/node-darwin-arm64.tar.gz \
  https://nodejs.org/dist/v24.19.0/node-v24.19.0-darwin-arm64.tar.gz
cd /c/Users/<user>/oyp-build
tar -xzf node-darwin-arm64.tar.gz --strip-components=2 'node-v24.19.0-darwin-arm64/bin/node'
```

Use `node -e 'fetch(...)'` if `curl` fails with `client returned ERROR on write`.

### 5e. Stage and archive

```bash
node --experimental-transform-types --import ./scripts/node-runtime-loader.mjs \
  scripts/package-portable.ts --target win32-x64 \
  --node "C:/Program Files/nodejs/node.exe" \
  --deps "C:/Users/<user>/oyp-build/appdeps/node_modules" \
  --out "C:/Users/<user>/oyp-build/portable"

node --experimental-transform-types --import ./scripts/node-runtime-loader.mjs \
  scripts/package-portable.ts --target darwin-arm64 \
  --node "C:/Users/<user>/oyp-build/node" \
  --deps "C:/Users/<user>/oyp-build/appdeps/node_modules" \
  --out "C:/Users/<user>/oyp-build/portable"
```

Smoke test before archiving:

```bash
"C:/Users/<user>/oyp-build/portable/oyp-win32-x64/runtime/node.exe" \
  "C:/Users/<user>/oyp-build/portable/oyp-win32-x64/app/cli.js" --version
# expect: oyp/X.Y.Z
```

Archive with bsdtar (`tar.exe`), which handles both formats:

```bash
cd /c/Users/<user>/oyp-build/portable
tar -a -cf oyp-win32-x64.zip oyp-win32-x64
tar -czf oyp-darwin-arm64.tar.gz oyp-darwin-arm64
```

### 5f. Checksums

```bash
node --experimental-transform-types --import ./scripts/node-runtime-loader.mjs \
  scripts/ci-release-checksums.ts "C:/Users/<user>/oyp-build/portable/SHA256SUMS.txt" \
  "C:/Users/<user>/oyp-build/portable/oyp-darwin-arm64.tar.gz" \
  "C:/Users/<user>/oyp-build/portable/oyp-win32-x64.zip"
```

## 6. Commit, tag, publish

```bash
git add -A
git commit -m "chore: bump version to X.Y.Z"

git tag -f vX.Y.Z
git push --atomic origin refs/heads/main:refs/heads/main "$(git rev-parse HEAD):refs/tags/vX.Y.Z"
```

Generate the release body and fix Windows path separators:

```bash
node --experimental-transform-types --import ./scripts/node-runtime-loader.mjs \
  scripts/ci-release-notes.ts vX.Y.Z release-notes.md

node -e 'const fs=require("fs");let t=fs.readFileSync("release-notes.md","utf8");t=t.replace(/packages\\/g,"packages/").replace(/\\CHANGELOG\.md/g,"/CHANGELOG.md");fs.writeFileSync("release-notes.md",t)'
```

Create the Release and upload the assets (title matches previous releases):

```bash
gh release create vX.Y.Z --title "oyp X.Y.Z (portable)" --notes-file release-notes.md \
  "C:/Users/<user>/oyp-build/portable/oyp-win32-x64.zip" \
  "C:/Users/<user>/oyp-build/portable/oyp-darwin-arm64.tar.gz" \
  "C:/Users/<user>/oyp-build/portable/SHA256SUMS.txt"
```

Verify:

```bash
gh release view vX.Y.Z --json name,tagName,isDraft,isPrerelease,assets \
  --jq '{name,tagName,isDraft,isPrerelease,assets:[.assets[]|{name,size,state}]}'
```

Expect all three assets in state `uploaded`, sizes matching the local files.

## 7. Cleanup

```bash
rm -f release-notes.md
rm -rf /c/Users/<user>/oyp-build/appdeps \
       /c/Users/<user>/oyp-build/node \
       /c/Users/<user>/oyp-build/node-darwin-arm64.tar.gz \
       /c/Users/<user>/oyp-build/portable/oyp-win32-x64 \
       /c/Users/<user>/oyp-build/portable/oyp-darwin-arm64
```

Keep `oyp-*.zip`, `oyp-*.tar.gz`, and `SHA256SUMS.txt` for re-verification. `git status`
must be clean when done.
