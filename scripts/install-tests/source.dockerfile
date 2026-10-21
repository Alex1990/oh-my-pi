# Test --source install from local repo
FROM debian:bookworm-slim

RUN apt-get update && apt-get install -y curl ca-certificates gnupg unzip build-essential && rm -rf /var/lib/apt/lists/*

# Install Node.js 22 and the pnpm release the repository pins.
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable && corepack prepare pnpm@10.18.0 --activate

# Install Rust — the host native addon builds through the default
# cargo/napi-rs backend, so no bazelisk is needed.
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --default-toolchain nightly
ENV PATH="/root/.cargo/bin:$PATH"

# Copy local repo
WORKDIR /repo
COPY . .

# Install dependencies, build native addon, and link globally
RUN pnpm install --frozen-lockfile
RUN pnpm --dir packages/natives run build
ENV PNPM_HOME="/root/.local/share/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN pnpm --dir packages/coding-agent link --global

# The repository manifest points bin.oyp at the TypeScript entrypoint, so the
# linked command needs Node's type transform and the repo loader.
ENV NODE_OPTIONS="--experimental-transform-types --import /repo/scripts/node-runtime-loader.mjs"

# Verify
RUN oyp --version
