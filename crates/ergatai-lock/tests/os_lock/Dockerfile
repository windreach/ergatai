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
RUN for d in ergatai-lock ergatai-core ergatai-error ergatai-nats ergatai-dag \
             ergatai-runtime ergatai-collab ergatai-api ergatai-agent ergatai-binary \
             ergatai-preload ergatai-cli; do \
      mkdir -p crates/$d/src && echo "" > crates/$d/src/lib.rs; \
    done

# Pre-build dependencies (cached unless Cargo.toml changes)
RUN cargo build --tests 2>&1 | tail -5 || true

# Now copy real source (invalidates dep cache only when source changes)
COPY . .

# Build test binary (fail loudly if compilation errors)
RUN cargo test -p ergatai-lock --test os_lock_integration --no-run

# Default: run the OS lock tests serially (fanotify requires single-threaded)
CMD ["cargo", "test", "-p", "ergatai-lock", "--test", "os_lock_integration", "--", "--ignored", "--nocapture", "--test-threads=1"]
