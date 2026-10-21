#!/bin/sh
# Install the dev `oyp` wrapper into pnpm's global bin directory.
#
# Links the wrapper at `packages/coding-agent/scripts/oyp`, which runs the
# TypeScript entrypoint on Node.
#
# We resolve pnpm's global bin path defensively because `pnpm bin -g` prints
# nothing on hosts where the global bin dir has not been created yet. Falling
# through that would expand `$(pnpm bin -g)/oyp` to `/oyp` and try to write
# under `/` — see https://github.com/can1357/oh-my-pi/issues/3701.
set -e

repo_root=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd -P)
target=$repo_root/packages/coding-agent/scripts/oyp

if [ ! -x "$target" ]; then
	echo "link-oyp: target wrapper not found or not executable: $target" >&2
	exit 1
fi

global_bin=$(pnpm bin -g 2>/dev/null || true)
if [ -z "$global_bin" ]; then
	global_bin=${PNPM_HOME:-$HOME/.local/share/pnpm}
fi

mkdir -p "$global_bin"
ln -sfn "$target" "$global_bin/oyp"
echo "link-oyp: linked $global_bin/oyp -> $target"
