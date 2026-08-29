#!/bin/bash
# Run fanotify OS lock tests in an isolated Docker container.
#
# Requirements:
#   - Docker installed and running
#   - Current user in docker group (or run with sudo)
#
# Usage:
#   ./run_os_lock_test.sh
#
# This compiles the test binary on the host (fast, uses cargo cache),
# then runs it in a minimal Docker container for isolation.
# The container has its own mount namespace, so FAN_MARK_MOUNT only
# affects the container's filesystem — NOT the host.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../../../.." && pwd)"
IMAGE_NAME="ergatai-os-lock-test"

echo "🔨 Building test binary on host..."
cd "$PROJECT_ROOT"
cargo test -p ergatai-lock --test os_lock_integration --no-run 2>&1 | grep -E "Compiling|Finished|error" || true

# Find the built test binary (use absolute path for Docker mount)
TEST_BINARY=$(find target/debug/deps -name "os_lock_integration-*" -type f -executable | head -1)
if [ -z "$TEST_BINARY" ]; then
    echo "❌ Failed to find test binary in target/debug/deps/"
    exit 1
fi
# Convert to absolute path
TEST_BINARY="$PROJECT_ROOT/$TEST_BINARY"
TEST_BINARY_NAME=$(basename "$TEST_BINARY")
echo "✅ Test binary: $TEST_BINARY"

echo ""
echo "🔨 Building minimal runtime container..."
docker build \
    --build-arg HTTP_PROXY=http://172.17.0.1:7890 \
    --build-arg HTTPS_PROXY=http://172.17.0.1:7890 \
    -t "$IMAGE_NAME" -f "$SCRIPT_DIR/Dockerfile" "$PROJECT_ROOT"

echo ""
echo "🔒 Running fanotify tests in isolated container..."
echo "   (mount namespace is isolated — FAN_MARK_MOUNT won't affect host)"
echo ""

# Mount the test binary into the container
docker run --rm \
    --privileged \
    --name ergatai-os-lock-test-$$ \
    -v "$TEST_BINARY:/app/os_lock_integration:ro" \
    "$IMAGE_NAME" \
    ./os_lock_integration --ignored --nocapture --test-threads=1

echo ""
echo "✅ Tests complete. Container destroyed."
