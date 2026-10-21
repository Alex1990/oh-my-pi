#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/../.."
ROOT_DIR="$(pwd)"
WORK_DIR="$(mktemp -d)"
TMP_WORK_DIR="$WORK_DIR/tmp"
mkdir -p "$TMP_WORK_DIR"
export TMPDIR="$TMP_WORK_DIR"

NATIVES_PACKAGE="$ROOT_DIR/packages/natives/package.json"
NATIVES_PACKAGE_INITIAL="$WORK_DIR/natives-package.initial.json"
cp "$NATIVES_PACKAGE" "$NATIVES_PACKAGE_INITIAL"
restore_workspace() {
   cp "$NATIVES_PACKAGE_INITIAL" "$NATIVES_PACKAGE"
   rm -rf "$WORK_DIR"
}
trap restore_workspace EXIT

section() {
   echo ""
   echo "=== $1 ==="
}

smoke_cli() {
   local omp_bin="$1"
   local runtime_dir
   runtime_dir="$(mktemp -d "$WORK_DIR/compiled-runtime.XXXXXX")"
   XDG_DATA_HOME="$runtime_dir/xdg" HOME="$runtime_dir/home" "$omp_bin" --version
   XDG_DATA_HOME="$runtime_dir/xdg" HOME="$runtime_dir/home" "$omp_bin" --help >/dev/null
   XDG_DATA_HOME="$runtime_dir/xdg" HOME="$runtime_dir/home" "$omp_bin" stats --summary >/dev/null
   # Spawns embedded workers and serves the stats dashboard once. Regression
   # probe for #1011/#1027 worker loading and for npm/compiled distributions
   # missing the dashboard assets that `stats --summary` never touches.
   XDG_DATA_HOME="$runtime_dir/xdg" HOME="$runtime_dir/home" "$omp_bin" --smoke-test
   node --experimental-transform-types --import "$ROOT_DIR/scripts/node-runtime-loader.mjs" \
      "$ROOT_DIR/scripts/install-tests/settings-session.ts" "$omp_bin"
}

find_tarball() {
   local pattern="$1"
   local matches=()
   shopt -s nullglob
   matches=("$pattern")
   shopt -u nullglob

   if [ "${#matches[@]}" -ne 1 ]; then
      echo "Expected exactly one tarball matching: $pattern"
      exit 1
   fi

   echo "${matches[0]}"
}

align_native_manifest() {
   local addon_version=""
   local addon
   local candidate_version
   local candidates=()
   shopt -s nullglob
   candidates=("$ROOT_DIR"/packages/natives/native/pi_natives.*.node)
   shopt -u nullglob

   if [ "${#candidates[@]}" -eq 0 ]; then
      echo "No native addon found for install smoke" >&2
      exit 1
   fi
   for addon in "${candidates[@]}"; do
      candidate_version="$(node --experimental-transform-types --import "$ROOT_DIR/scripts/node-runtime-loader.mjs" "$ROOT_DIR/scripts/install-tests/native-version.ts" "$addon")" || exit 1
      if [ -z "$addon_version" ]; then
         addon_version="$candidate_version"
      elif [ "$addon_version" != "$candidate_version" ]; then
         echo "Native addon version mismatch: $addon_version vs $candidate_version ($addon)" >&2
         exit 1
      fi
   done

   local declared_version
   declared_version="$(jq -r '.version' "$NATIVES_PACKAGE")"
   if [ "$declared_version" = "$addon_version" ]; then return; fi

   echo "Aligning install smoke native manifest $declared_version → $addon_version"
   jq --arg version "$addon_version" '.version = $version' "$NATIVES_PACKAGE" > "$WORK_DIR/natives-package.aligned.json"
   mv "$WORK_DIR/natives-package.aligned.json" "$NATIVES_PACKAGE"
}
section "Binary install smoke"
if [ "${OMP_INSTALL_TEST_SKIP_NATIVE_BUILD:-0}" != "1" ]; then
   pnpm --dir packages/natives run build
fi
align_native_manifest
pnpm --dir packages/coding-agent run build

BINARY_DIR="$WORK_DIR/binary-bin"
mkdir -p "$BINARY_DIR"
cp packages/coding-agent/dist/oyp "$BINARY_DIR/oyp"
cp packages/coding-agent/dist/cli.js "$BINARY_DIR/cli.js"
# cli.js keeps the native addon external and resolves it from node_modules next
# to the payload; provide the workspace tree beside the copied launcher.
ln -s "$ROOT_DIR/node_modules" "$BINARY_DIR/node_modules"
smoke_cli "$BINARY_DIR/oyp"

section "Source install smoke"
SOURCE_PNPM_HOME="$WORK_DIR/pnpm-source"
(
   export PNPM_HOME="$SOURCE_PNPM_HOME"
   export PATH="$PNPM_HOME:$PATH"
   # The repository manifest points `bin.oyp` at the TypeScript entrypoint, so
   # the linked command needs Node's type transform and the repo loader.
   export NODE_OPTIONS="--experimental-transform-types --import $ROOT_DIR/scripts/node-runtime-loader.mjs"
   pnpm --dir "$ROOT_DIR/packages/coding-agent" link --global
   smoke_cli "$(pnpm bin -g)/oyp"
)

section "Tarball install smoke"
TARBALL_DIR="$WORK_DIR/tarballs"
mkdir -p "$TARBALL_DIR"
host_tag="$(node -e 'process.stdout.write(`${process.platform}-${process.arch}`)')"

# Native addon split: the published core ships only the loader (no `.node`); the
# prebuilt binary lives in a per-platform leaf package pulled in as an optional
# dependency. Reproduce that exact published topology so this smoke proves the
# installed core resolves its addon through the leaf, not an embedded binary.

# 1. Generate + pack the host-platform leaf (carries the built `.node`).
pnpm --dir packages/natives run gen:npm --tag "$host_tag" >/dev/null
(
   cd "$ROOT_DIR/packages/natives/npm/$host_tag"
   pnpm pack --pack-destination "$TARBALL_DIR" --silent >/dev/null
)

# 2. Pack the core with its *published* manifest: the same rewrite release uses
#    drops `.node` from `files` and adds the leaf `optionalDependencies`. Always
#    restore the working-tree manifest so local runs aren't left mutated.
natives_pkg_backup="$WORK_DIR/natives-package.json.orig"
cp "$ROOT_DIR/packages/natives/package.json" "$natives_pkg_backup"
prepare_natives_script="$WORK_DIR/prepare-native-core.mts"
cat > "$prepare_natives_script" <<EOF
import { prepareNativeCorePackage } from "$ROOT_DIR/scripts/ci-release-publish.ts";
await prepareNativeCorePackage("packages/natives", true);
EOF
core_rc=0
{
   node --experimental-transform-types --import "$ROOT_DIR/scripts/node-runtime-loader.mjs" "$prepare_natives_script" &&
      (cd "$ROOT_DIR/packages/natives" && pnpm pack --pack-destination "$TARBALL_DIR" --silent >/dev/null)
} || core_rc=$?
cp "$natives_pkg_backup" "$ROOT_DIR/packages/natives/package.json"
[ "$core_rc" -eq 0 ] || exit "$core_rc"

# 3. Pack the remaining workspace packages (natives core and coding-agent
#    handled separately). `collab-web` is private but still packed here so its
#    prepack build and tarball file list stay release-safe.
for pkg in utils wire omptype catalog ai mnemopi snapcompact agent tui stats collab-web; do
   (
      cd "$ROOT_DIR/packages/$pkg"
      pnpm pack --pack-destination "$TARBALL_DIR" --silent >/dev/null
   )
done

# 4. Pack the coding agent with its *published* manifest: release swaps
#    `bin.oyp` from `src/cli.ts` to the prepack payload `dist/cli.js`. The repo
#    manifest keeps pointing at source so `pnpm link`/`install.sh --source`
#    work without a build, so the swap must be reproduced here for the smoke
#    to exercise the embedded worker-host entry the published package ships.
#    Always restore the working-tree manifest.
agent_pkg_backup="$WORK_DIR/coding-agent-package.json.orig"
cp "$ROOT_DIR/packages/coding-agent/package.json" "$agent_pkg_backup"
prepare_agent_script="$WORK_DIR/apply-publish-bin.mts"
cat > "$prepare_agent_script" <<EOF
import { applyPublishBin } from "$ROOT_DIR/scripts/ci-release-publish.ts";
await applyPublishBin("packages/coding-agent", true);
EOF
agent_rc=0
{
   node --experimental-transform-types --import "$ROOT_DIR/scripts/node-runtime-loader.mjs" "$prepare_agent_script" &&
      (cd "$ROOT_DIR/packages/coding-agent" && pnpm pack --pack-destination "$TARBALL_DIR" --silent >/dev/null)
} || agent_rc=$?
cp "$agent_pkg_backup" "$ROOT_DIR/packages/coding-agent/package.json"
[ "$agent_rc" -eq 0 ] || exit "$agent_rc"

utils_tgz="$(find_tarball "$TARBALL_DIR"/oh-my-pi-pi-utils-*.tgz)"
wire_tgz="$(find_tarball "$TARBALL_DIR"/oh-my-pi-pi-wire-*.tgz)"
omptype_tgz="$(find_tarball "$TARBALL_DIR"/oh-my-pi-omptype-*.tgz)"
natives_tgz="$(find_tarball "$TARBALL_DIR"/oh-my-pi-pi-natives-[0-9]*.tgz)"
natives_leaf_tgz="$(find_tarball "$TARBALL_DIR"/oh-my-pi-pi-natives-"$host_tag"-*.tgz)"
catalog_tgz="$(find_tarball "$TARBALL_DIR"/oh-my-pi-pi-catalog-*.tgz)"
ai_tgz="$(find_tarball "$TARBALL_DIR"/oh-my-pi-pi-ai-*.tgz)"
mnemopi_tgz="$(find_tarball "$TARBALL_DIR"/oh-my-pi-pi-mnemopi-*.tgz)"
snapcompact_tgz="$(find_tarball "$TARBALL_DIR"/oh-my-pi-snapcompact-*.tgz)"
agent_tgz="$(find_tarball "$TARBALL_DIR"/oh-my-pi-pi-agent-core-*.tgz)"
tui_tgz="$(find_tarball "$TARBALL_DIR"/oh-my-pi-pi-tui-*.tgz)"
stats_tgz="$(find_tarball "$TARBALL_DIR"/oh-my-pi-omp-stats-*.tgz)"
coding_agent_tgz="$(find_tarball "$TARBALL_DIR"/oh-my-pi-pi-coding-agent-*.tgz)"
collab_web_tgz="$(find_tarball "$TARBALL_DIR"/oh-my-pi-collab-web-*.tgz)"

TARBALL_APP_DIR="$WORK_DIR/tarball-install"
mkdir -p "$TARBALL_APP_DIR"
(
   cd "$TARBALL_APP_DIR"
   # A minimal manifest: `pnpm init` probes the registry for the latest pnpm
   # and pins it via packageManager, which would escape the repo's pinned
   # release (and fail offline).
   node -e "require('fs').writeFileSync('package.json', JSON.stringify({ name: 'oyp-install-smoke', private: true, version: '0.0.0' }, null, 2))"

   # Point inter-package deps at the tarballs so nothing resolves from the
   # registry (the version under test has not necessarily been published yet).
   # pnpm 10 reads overrides from pnpm-workspace.yaml, not package.json.
   cat > pnpm-workspace.yaml <<EOF
overrides:
  '@oh-my-pi/pi-utils': 'file:$utils_tgz'
  '@oh-my-pi/pi-wire': 'file:$wire_tgz'
  '@oh-my-pi/omptype': 'file:$omptype_tgz'
  '@oh-my-pi/pi-natives': 'file:$natives_tgz'
  '@oh-my-pi/pi-natives-$host_tag': 'file:$natives_leaf_tgz'
  '@oh-my-pi/pi-ai': 'file:$ai_tgz'
  '@oh-my-pi/pi-catalog': 'file:$catalog_tgz'
  '@oh-my-pi/pi-mnemopi': 'file:$mnemopi_tgz'
  '@oh-my-pi/snapcompact': 'file:$snapcompact_tgz'
  '@oh-my-pi/pi-agent-core': 'file:$agent_tgz'
  '@oh-my-pi/pi-tui': 'file:$tui_tgz'
  '@oh-my-pi/omp-stats': 'file:$stats_tgz'
  '@oh-my-pi/pi-coding-agent': 'file:$coding_agent_tgz'
  '@oh-my-pi/collab-web': 'file:$collab_web_tgz'
EOF

   pnpm add "$utils_tgz" "$wire_tgz" "$omptype_tgz" "$natives_tgz" "$catalog_tgz" "$ai_tgz" "$mnemopi_tgz" "$snapcompact_tgz" "$agent_tgz" "$tui_tgz" "$stats_tgz" "$coding_agent_tgz" "$collab_web_tgz"
   # The platform leaf must arrive through the core's optionalDependencies +
   # override, not as a direct dependency — assert it landed before smoking so a
   # resolution regression is distinguishable from a runtime loader bug.
   leaf_dir="node_modules/@oh-my-pi/pi-natives-$host_tag"
   [ -d "$leaf_dir" ] || {
      echo "Platform leaf package not installed: $leaf_dir"
      exit 1
   }
   cat > wire-probe.mts <<'PROBE'
import { COLLAB_PROTO } from "@oh-my-pi/pi-wire";
process.stdout.write(String(COLLAB_PROTO));
PROBE
   wire_proto="$(node --experimental-transform-types wire-probe.mts)"
   [ "$wire_proto" = "3" ] || {
      echo "Unexpected @oh-my-pi/pi-wire COLLAB_PROTO: $wire_proto"
      exit 1
   }
   cat > omptype-probe.mts <<'PROBE'
import { type } from "@oh-my-pi/omptype";
import { Type } from "@oh-my-pi/omptype/typebox";
const root = type({ name: "string", enabled: "boolean = false" }).assert({ name: "oyp" });
const typebox = Type.Object({ name: Type.String() }).assert({ name: "tb" });
process.stdout.write(`${root.name}:${root.enabled}:${typebox.name}`);
PROBE
   omptype_probe="$(node --experimental-transform-types omptype-probe.mts)"
   [ "$omptype_probe" = "oyp:false:tb" ] || {
      echo "Unexpected @oh-my-pi/omptype probe result: $omptype_probe"
      exit 1
   }
   [ -f "node_modules/@oh-my-pi/collab-web/dist/index.html" ] || {
      echo "Collab web tarball did not install built dist/index.html"
      exit 1
   }
   smoke_cli ./node_modules/.bin/oyp
)

echo ""
echo "All install method smoke tests passed"
