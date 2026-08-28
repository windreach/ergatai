# Isolated test environment for fanotify OS lock tests.
# Runs as root inside a container with its own mount namespace,
# so FAN_MARK_MOUNT only affects the container's filesystem.

FROM rust:1.96-slim

# fanotify needs libc headers for the syscall wrappers
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    pkg-config \
    libsqlite3-dev \
    libssl-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy dependency manifests first (cache layer)
COPY Cargo.toml Cargo.lock ./
COPY crates/ergatai-lock/Cargo.toml ./crates/ergatai-lock/Cargo.toml
COPY crates/ergatai-core/Cargo.toml ./crates/ergatai-core/Cargo.toml
COPY crates/ergatai-error/Cargo.toml ./crates/ergatai-error/Cargo.toml
COPY crates/ergatai-nats/Cargo.toml ./crates/ergatai-nats/Cargo.toml
COPY crates/ergatai-dag/Cargo.toml ./crates/ergatai-dag/Cargo.toml
COPY crates/ergatai-runtime/Cargo.toml ./crates/ergatai-runtime/Cargo.toml
COPY crates/ergatai-collab/Cargo.toml ./crates/ergatai-collab/Cargo.toml
COPY crates/ergatai-api/Cargo.toml ./crates/ergatai-api/Cargo.toml
COPY crates/ergatai-agent/Cargo.toml ./crates/ergatai-agent/Cargo.toml
COPY crates/ergatai-binary/Cargo.toml ./crates/ergatai-binary/Cargo.toml
COPY crates/ergatai-preload/Cargo.toml ./crates/ergatai-preload/Cargo.toml
COPY crates/ergatai-cli/Cargo.toml ./crates/ergatai-cli/Cargo.toml

# Create dummy lib.rs files so cargo can resolve the workspace
# Auto-detect from copied Cargo.toml files (no hardcoded crate list)
RUN for cargo_toml in crates/*/Cargo.toml; do \
      crate_dir=$(dirname "$cargo_toml"); \
      mkdir -p "$crate_dir/src" && echo "" > "$crate_dir/src/lib.rs"; \
    done

# Pre-build dependencies (cached unless Cargo.toml changes)
# Use pipefail to catch build errors; tail for cleaner output
RUN set -o pipefail && cargo build --tests 2>&1 | tail -20

# Now copy real source (invalidates dep cache only when source changes)
COPY . .

# Build test binary (fail loudly if compilation errors)
RUN cargo test -p ergatai-lock --test os_lock_integration --no-run

# Default: run the OS lock tests serially (fanotify requires single-threaded)
CMD ["cargo", "test", "-p", "ergatai-lock", "--test", "os_lock_integration", "--", "--ignored", "--nocapture", "--test-threads=1"]
