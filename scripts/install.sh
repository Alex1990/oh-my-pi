#!/bin/sh
set -e

# OMP Coding Agent Installer
# Usage: curl -fsSL https://omp.sh/install | sh
#        curl -fsSL https://omp.sh/install | sh -s -- --binary --ref v18.8.9
#
# Options:
#   --source       Build from a git checkout via pnpm (requires --ref <tag>)
#   --binary       Always install prebuilt binary
#   --ref <ref>    Install specific tag/commit/branch (source mode); binary
#                  mode takes a release tag (v<version>)
#   -r <ref>       Shorthand for --ref
#
# Prebuilt distributions come from GitHub Releases: a platform launcher plus
# the shared `cli.js` payload the launcher runs on Node.js. Both are checked
# against the release's `SHA256SUMS.txt` before install. `OMP_RELEASE_REPO`
# selects the repository and `OMP_RELEASE_BASE` overrides the release base
# (mirrors and tests).

REPO="${OMP_RELEASE_REPO:-Alex1990/oh-my-pi}"
RELEASE_BASE="${OMP_RELEASE_BASE:-https://github.com/${REPO}/releases}"
while [ "${RELEASE_BASE%/}" != "$RELEASE_BASE" ]; do
    RELEASE_BASE="${RELEASE_BASE%/}"
done
INSTALL_DIR="${PI_INSTALL_DIR:-$HOME/.local/bin}"
MIN_NODE_VERSION="22.12.0"
PNPM_VERSION="10.18.0"

# Parse arguments
MODE=""
REF=""
while [ $# -gt 0 ]; do
    case "$1" in
        --source)
            MODE="source"
            shift
            ;;
        --binary)
            MODE="binary"
            shift
            ;;
        --ref)
            shift
            if [ -z "$1" ]; then
                echo "Missing value for --ref"
                exit 1
            fi
            REF="$1"
            shift
            ;;
        --ref=*)
            REF="${1#*=}"
            if [ -z "$REF" ]; then
                echo "Missing value for --ref"
                exit 1
            fi
            shift
            ;;
        -r)
            shift
            if [ -z "$1" ]; then
                echo "Missing value for -r"
                exit 1
            fi
            REF="$1"
            shift
            ;;
        *)
            echo "Unknown option: $1"
            exit 1
            ;;
    esac
done

# If a ref is provided, default to source install
if [ -n "$REF" ] && [ -z "$MODE" ]; then
    MODE="source"
fi

# Check if node is available
has_node() {
    command -v node >/dev/null 2>&1
}

# Normalized host architecture (x64|arm64). On macOS this uses
# `sysctl hw.optional.arm64` so it stays correct inside a Rosetta session,
# where `uname -m` reports the translated x86_64.
host_arch() {
    if [ "$(uname -s)" = "Darwin" ]; then
        if [ "$(sysctl -in hw.optional.arm64 2>/dev/null || /usr/sbin/sysctl -in hw.optional.arm64 2>/dev/null)" = "1" ]; then
            echo "arm64"
        else
            echo "x64"
        fi
        return
    fi
    case "$(uname -m)" in
        x86_64|amd64)  echo "x64" ;;
        arm64|aarch64) echo "arm64" ;;
        *)             uname -m ;;
    esac
}

# Node's own architecture (x64|arm64), or empty when it can't be determined.
node_arch() {
    node -e 'process.stdout.write(process.arch)' 2>/dev/null
}

# True when Node's architecture matches the host. If Node's arch can't be read,
# assume a match rather than block the install.
node_arch_matches_host() {
    na="$(node_arch)"
    [ -z "$na" ] && return 0
    [ "$na" = "$(host_arch)" ]
}

version_ge() {
    current="$1"
    minimum="$2"

    current_major="${current%%.*}"
    current_rest="${current#*.}"
    current_minor="${current_rest%%.*}"
    current_patch="${current_rest#*.}"
    current_patch="${current_patch%%.*}"

    minimum_major="${minimum%%.*}"
    minimum_rest="${minimum#*.}"
    minimum_minor="${minimum_rest%%.*}"
    minimum_patch="${minimum_rest#*.}"
    minimum_patch="${minimum_patch%%.*}"

    if [ "$current_major" -ne "$minimum_major" ]; then
        [ "$current_major" -gt "$minimum_major" ]
        return $?
    fi

    if [ "$current_minor" -ne "$minimum_minor" ]; then
        [ "$current_minor" -gt "$minimum_minor" ]
        return $?
    fi

    [ "$current_patch" -ge "$minimum_patch" ]
}

node_version_ok() {
    version_raw=$(node --version 2>/dev/null || true)
    if [ -z "$version_raw" ]; then
        return 1
    fi

    version_ge "${version_raw#v}" "$MIN_NODE_VERSION"
}

require_node_version() {
    version_raw=$(node --version 2>/dev/null || true)
    if [ -z "$version_raw" ]; then
        echo "Failed to read node version"
        exit 1
    fi

    version_clean=${version_raw#v}
    if ! version_ge "$version_clean" "$MIN_NODE_VERSION"; then
        echo "Node.js ${MIN_NODE_VERSION} or newer is required. Current version: ${version_clean}"
        echo "Upgrade Node.js at https://nodejs.org/en/download"
        exit 1
    fi
}

# Check if git is available
has_git() {
    command -v git >/dev/null 2>&1
}

# Install Node.js from the official distribution, verified against its
# SHASUMS256.txt, into a private directory and prepend it to PATH for this run.
install_node() {
    echo "Installing Node.js..."
    node_os="$(uname -s)"
    case "$node_os" in
        Linux) node_os="linux" ;;
        Darwin) node_os="darwin" ;;
        *)
            echo "Unsupported OS: $node_os"
            exit 1
            ;;
    esac
    node_arch_name="$(host_arch)"
    case "$node_arch_name" in
        x64|arm64) ;;
        *)
            echo "Unsupported architecture: $node_arch_name"
            exit 1
            ;;
    esac
    if [ "$node_os" = "linux" ] && [ -f /etc/alpine-release ]; then
        echo "Node.js ${MIN_NODE_VERSION} or newer is required, and the official Linux builds need glibc."
        echo "Install it with: apk add nodejs"
        exit 1
    fi
    if ! command -v tar >/dev/null 2>&1; then
        echo "tar is required to install Node.js"
        exit 1
    fi

    NODE_HOME="${PI_NODE_HOME:-$HOME/.oyp/node}"
    base_url="https://nodejs.org/dist/latest-v22.x"
    if ! sums="$(curl -fsSL --connect-timeout 10 --max-time 60 "$base_url/SHASUMS256.txt")"; then
        echo "Failed to download Node.js checksums from ${base_url}"
        exit 1
    fi
    archive="$(printf '%s\n' "$sums" | grep -E "  node-v[0-9.]+-${node_os}-${node_arch_name}\.tar\.gz$" | head -n 1 | awk '{print $2}')"
    expected="$(printf '%s\n' "$sums" | awk -v file="$archive" '$2 == file { print $1 }')"
    if [ -z "$archive" ] || ! printf '%s\n' "$expected" | grep -Eq '^[0-9a-f]{64}$'; then
        echo "Could not find a Node.js ${node_os}-${node_arch_name} archive in ${base_url}/SHASUMS256.txt"
        exit 1
    fi

    archive_path="${NODE_HOME}.tar.gz.$$"
    trap 'rm -f "$archive_path"' EXIT
    echo "Downloading ${archive}..."
    curl -fsSL --connect-timeout 10 --speed-limit 1024 --speed-time 30 "$base_url/$archive" -o "$archive_path"
    actual="$(sha256_of "$archive_path")"
    if [ "$actual" != "$expected" ]; then
        echo "Checksum mismatch for ${archive}: expected ${expected}, got ${actual}"
        exit 1
    fi
    rm -rf "$NODE_HOME"
    mkdir -p "$NODE_HOME"
    tar -xzf "$archive_path" -C "$NODE_HOME" --strip-components 1
    rm -f "$archive_path"
    export PATH="$NODE_HOME/bin:$PATH"
    require_node_version
}

# Install pnpm with the pinned release (corepack when available, npm otherwise).
install_pnpm() {
    echo "Installing pnpm..."
    if command -v corepack >/dev/null 2>&1 &&
        corepack enable >/dev/null 2>&1 &&
        corepack prepare "pnpm@${PNPM_VERSION}" --activate >/dev/null 2>&1; then
        :
    elif command -v npm >/dev/null 2>&1; then
        npm install -g "pnpm@${PNPM_VERSION}"
    else
        echo "corepack or npm is required to install pnpm"
        exit 1
    fi
    export PNPM_HOME="${PNPM_HOME:-$HOME/.local/share/pnpm}"
    export PATH="$PNPM_HOME:$PATH"
    if ! command -v pnpm >/dev/null 2>&1; then
        echo "Failed to install pnpm"
        exit 1
    fi
}

# Check if git-lfs is available
has_git_lfs() {
    command -v git-lfs >/dev/null 2>&1
}

# Install from a source checkout via pnpm
install_via_pnpm() {
    echo "Installing via pnpm..."
    if [ -z "$REF" ]; then
        echo "--source requires --ref <tag>; prebuilt installs need no options."
        exit 1
    fi
    if ! has_git; then
        echo "git is required for --ref when installing from source"
        exit 1
    fi

    TMP_DIR="$(mktemp -d)"
    trap 'rm -rf "$TMP_DIR"' EXIT

    if git clone --depth 1 --branch "$REF" "https://github.com/${REPO}.git" "$TMP_DIR" >/dev/null 2>&1; then
        :
    else
        git clone "https://github.com/${REPO}.git" "$TMP_DIR"
        (cd "$TMP_DIR" && git checkout "$REF")
    fi

    # Pull LFS files
    if has_git_lfs; then
        (cd "$TMP_DIR" && git lfs pull)
    fi

    if [ ! -d "$TMP_DIR/packages/coding-agent" ]; then
        echo "Expected package at ${TMP_DIR}/packages/coding-agent"
        exit 1
    fi

    pnpm add -g "$TMP_DIR/packages/coding-agent" || {
        echo "Failed to install from source"
        exit 1
    }
    echo ""
    echo "✓ Installed oyp via pnpm"
    echo "Run 'oyp' to get started!"
}

# Hex sha256 of file "$1".
sha256_of() {
    if command -v sha256sum >/dev/null 2>&1; then
        sha256sum "$1" | cut -d ' ' -f 1
    else
        shasum -a 256 "$1" | cut -d ' ' -f 1
    fi
}

# Install the prebuilt binary and cli.js from the GitHub release
install_binary() {
    if ! command -v sha256sum >/dev/null 2>&1 && ! command -v shasum >/dev/null 2>&1; then
        echo "sha256sum or shasum is required to verify the downloaded binary"
        exit 1
    fi

    # Detect platform
    OS="$(uname -s)"
    ARCH="$(host_arch)"

    case "$OS" in
        Linux)  PLATFORM="linux" ;;
        Darwin) PLATFORM="darwin" ;;
        *)      echo "Unsupported OS: $OS"; exit 1 ;;
    esac

    case "$ARCH" in
        x64|arm64) TARGET_ARCH="$ARCH" ;;
        *)         echo "Unsupported architecture: $ARCH"; exit 1 ;;
    esac

    if [ "$PLATFORM" = "linux" ]; then
        if [ -f /etc/alpine-release ] || { command -v ldd >/dev/null 2>&1 && ldd --version 2>&1 | grep -qi musl; }; then
            PLATFORM="linux-musl"
        fi
    fi

    TARGET="${PLATFORM}-${TARGET_ARCH}"
    if [ -n "$REF" ]; then
        if ! printf '%s\n' "$REF" | grep -Eq '^v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$'; then
            echo "Binary installs take a release tag (v<version>) for --ref, got: $REF"
            echo "For branch/commit installs, use --source with --ref."
            exit 1
        fi
        RELEASE_PATH="download/${REF}"
        VERSION="${REF#v}"
        echo "Fetching oyp ${VERSION}..."
    else
        RELEASE_PATH="latest/download"
        VERSION=""
        echo "Fetching latest release..."
    fi
    ASSET_NAME="oyp-${TARGET}.tar.gz"
    ASSET_URL="${RELEASE_BASE}/${RELEASE_PATH}/${ASSET_NAME}"
    SUMS_URL="${RELEASE_BASE}/${RELEASE_PATH}/SHA256SUMS.txt"
    if ! RELEASE_SUMS=$(curl -fsSL --connect-timeout 10 --max-time 60 "$SUMS_URL"); then
        echo "Failed to fetch ${SUMS_URL}"
        exit 1
    fi
    EXPECTED_SHA256=$(printf '%s\n' "$RELEASE_SUMS" |
        awk -v name="$ASSET_NAME" '$1 ~ /^[0-9a-fA-F]{64}$/ && ($2 == name || $2 == "*" name) { print tolower($1); exit }')
    if [ -z "$EXPECTED_SHA256" ]; then
        echo "No checksum for ${ASSET_NAME} in ${SUMS_URL}"
        exit 1
    fi
    if [ -n "$VERSION" ]; then
        echo "Using version: $VERSION"
    else
        echo "Using the latest release"
    fi

    mkdir -p "$INSTALL_DIR"
    # Download next to the destination and unpack into a scratch tree; only a
    # verified archive replaces the working install.
    DOWNLOAD_PATH="${INSTALL_DIR}/.oyp.download.$$"
    EXTRACT_DIR="${INSTALL_DIR}/.oyp.extract.$$"
    trap 'rm -rf "$DOWNLOAD_PATH" "$EXTRACT_DIR"' EXIT
    echo "Downloading ${ASSET_NAME}..."
    curl -fsSL --connect-timeout 10 --speed-limit 1024 --speed-time 30 "$ASSET_URL" -o "$DOWNLOAD_PATH"
    ACTUAL_SHA256="$(sha256_of "$DOWNLOAD_PATH")"
    if [ "$ACTUAL_SHA256" != "$EXPECTED_SHA256" ]; then
        echo "Checksum mismatch for ${ASSET_NAME}: expected ${EXPECTED_SHA256}, got ${ACTUAL_SHA256}"
        exit 1
    fi
    mkdir -p "$EXTRACT_DIR"
    tar -xzf "$DOWNLOAD_PATH" -C "$EXTRACT_DIR"
    SRC_DIR="${EXTRACT_DIR}/oyp-${TARGET}"
    if [ ! -f "${SRC_DIR}/oyp" ] || [ ! -f "${SRC_DIR}/runtime/node" ]; then
        echo "Archive ${ASSET_NAME} is missing oyp or runtime/node"
        exit 1
    fi
    # Replace only what this distribution owns; other files in INSTALL_DIR stay.
    rm -rf "${INSTALL_DIR}/app" "${INSTALL_DIR}/runtime"
    mv "${SRC_DIR}/app" "${INSTALL_DIR}/app"
    mv "${SRC_DIR}/runtime" "${INSTALL_DIR}/runtime"
    mv -f "${SRC_DIR}/oyp" "${INSTALL_DIR}/oyp"
    chmod +x "${INSTALL_DIR}/oyp" "${INSTALL_DIR}/runtime/node"
    rm -rf "$EXTRACT_DIR"

    # Verify the freshly installed launcher can actually start before reporting
    # success. The musl launcher runs a payload that loads native addons, so a
    # download can succeed while startup fails. Never claim success for an
    # install that cannot run.
    if ! SMOKE_OUTPUT="$("${INSTALL_DIR}/oyp" --version 2>&1)"; then
        echo ""
        echo "✗ oyp was downloaded to ${INSTALL_DIR}/oyp but cannot start:"
        echo "$SMOKE_OUTPUT" | sed 's/^/    /'
        if [ "$PLATFORM" = "linux-musl" ]; then
            echo ""
            echo "The musl build links libstdc++/libgcc dynamically. Install them, then re-run 'oyp':"
            if command -v apk >/dev/null 2>&1; then
                echo "    apk add libstdc++ libgcc"
            else
                echo "    (install the libstdc++ and libgcc runtime packages for your distro)"
            fi
        fi
        exit 1
    fi

    echo ""
    echo "✓ Installed oyp to ${INSTALL_DIR}/oyp"

    # Check if in PATH
    case ":$PATH:" in
        *":$INSTALL_DIR:"*) echo "Run 'oyp' to get started!" ;;
        *) echo "Add ${INSTALL_DIR} to your PATH, then run 'oyp'" ;;
    esac
}

# Main logic
case "$MODE" in
    source)
        if ! has_node; then
            install_node
        fi
        require_node_version
        if [ -n "${NODE_HOME:-}" ]; then
            # install_node only changed PATH for this process; expose node in the
            # install directory so later shells can find it once that is on PATH.
            mkdir -p "$INSTALL_DIR"
            ln -sf "$NODE_HOME/bin/node" "${INSTALL_DIR}/node"
            PATH="${INSTALL_DIR}:${PATH}"
            export PATH
        fi
        if ! node_arch_matches_host; then
            echo "Error: node reports architecture '$(node_arch)' but this host is '$(host_arch)'."
            echo "Installing from source with this node would produce a mismatched binary"
            echo "(e.g. x86_64 under Rosetta on Apple Silicon), causing slow startup and AVX warnings."
            echo "Install a native Node.js for your architecture, or re-run without --source to fetch the prebuilt $(host_arch) payload."
            exit 1
        fi
        if ! command -v pnpm >/dev/null 2>&1; then
            install_pnpm
        fi
        install_via_pnpm
        ;;
    binary)
        install_binary
        ;;
    *)
        # Default: the prebuilt launcher and cli.js from the latest release
        # (installing Node.js when the host has none). Release artifacts are
        # the only distribution channel; `--source --ref <tag>` builds from a
        # checkout instead.
        install_binary
        ;;
esac
