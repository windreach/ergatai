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

# Copy project
COPY . .

# Pre-build dependencies (cache layer)
RUN cargo fetch --locked 2>/dev/null || cargo fetch

# Build test binary (cached unless source changes)
RUN cargo test -p ergatai-lock --test os_lock_integration --no-run 2>/dev/null || true

# Default: run the OS lock tests
CMD ["cargo", "test", "-p", "ergatai-lock", "--test", "os_lock_integration", "--", "--ignored", "--nocapture"]
