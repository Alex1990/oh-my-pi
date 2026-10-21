# Test binary build from local source
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

# Build native addon and the launcher plus its shared cli.js bundle
RUN pnpm install --frozen-lockfile
RUN pnpm --dir packages/natives run build
RUN pnpm --dir packages/coding-agent run build

# Install the launcher and bundle to PATH
RUN mkdir -p /root/.local/bin && \
    cp packages/coding-agent/dist/oyp packages/coding-agent/dist/cli.js /root/.local/bin/
ENV PATH="/root/.local/bin:$PATH"

# Verify
RUN HOME=/tmp/oyp-home XDG_DATA_HOME=/tmp/oyp-xdg oyp --version
