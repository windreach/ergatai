# Docker container for snapshot read tests with LD_PRELOAD support.
#
# Tests the complete flow:
# - Agent A locks and modifies file
# - Agent B reads with LD_PRELOAD → should get snapshot content
# - Verifies LD_PRELOAD interception and IPC query work

FROM rust:1.96-slim

# Set proxy for apt-get
ARG HTTP_PROXY=http://host.docker.internal:7890
ARG HTTPS_PROXY=http://host.docker.internal:7890
ENV http_proxy=${HTTP_PROXY}
ENV https_proxy=${HTTPS_PROXY}
ENV HTTP_PROXY=${HTTP_PROXY}
ENV HTTPS_PROXY=${HTTPS_PROXY}

# Install runtime dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    libsqlite3-0 \
    libssl3 \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Clear proxy env for runtime
ENV http_proxy=
ENV https_proxy=
ENV HTTP_PROXY=
ENV HTTPS_PROXY=

# Note: git CLI not needed - tests use git2 crate (Rust library) for repo operations

WORKDIR /app

# Test binary and preload library will be mounted at runtime
CMD ["./snapshot_read_integration", "--ignored", "--nocapture", "--test-threads=1"]
