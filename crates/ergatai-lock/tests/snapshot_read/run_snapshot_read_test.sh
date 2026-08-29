#!/bin/bash
# Run snapshot read tests in Docker with LD_PRELOAD support.
#
# Requirements:
#   - Docker installed and running
#   - Current user in docker group (or run with sudo)
#
# Usage:
#   ./run_snapshot_read_test.sh
#
# This tests the complete snapshot read flow:
# 1. Agent A locks file and modifies it
# 2. Agent B reads with LD_PRELOAD → should get original snapshot
# 3. Verifies LD_PRELOAD interception works correctly

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../../../.." && pwd)"
IMAGE_NAME="ergatai-snapshot-read-test"

echo "🔨 Building preload library on host..."
cd "$PROJECT_ROOT"
cargo build -p ergatai-preload 2>&1 | grep -E "Compiling|Finished|error" || true

PRELOAD_LIB="$PROJECT_ROOT/target/debug/libergatai_preload.so"
if [ ! -f "$PRELOAD_LIB" ]; then
    echo "❌ Failed to build preload library"
    exit 1
fi
echo "✅ Preload library: $PRELOAD_LIB"

echo ""
echo "🔨 Building test binary on host..."
cargo test -p ergatai-lock --test snapshot_read_integration --no-run 2>&1 | grep -E "Compiling|Finished|error" || true

TEST_BINARY=$(find target/debug/deps -name "snapshot_read_integration-*" -type f -executable | head -1)
if [ -z "$TEST_BINARY" ]; then
    echo "❌ Failed to find test binary"
    exit 1
fi
TEST_BINARY="$PROJECT_ROOT/$TEST_BINARY"
echo "✅ Test binary: $TEST_BINARY"

echo ""
echo "🔨 Building Docker container with LD_PRELOAD support..."
docker build \
    --build-arg HTTP_PROXY=http://172.17.0.1:7890 \
    --build-arg HTTPS_PROXY=http://172.17.0.1:7890 \
    -t "$IMAGE_NAME" -f "$SCRIPT_DIR/Dockerfile" "$PROJECT_ROOT"

echo ""
echo "🔒 Running snapshot read tests in Docker..."
echo "   (Testing LD_PRELOAD snapshot redirection)"
echo ""

# Mount both the test binary and preload library
docker run --rm \
    --privileged \
    --name ergatai-snapshot-read-$$ \
    -v "$TEST_BINARY:/app/snapshot_read_integration:ro" \
    -v "$PRELOAD_LIB:/app/libergatai_preload.so:ro" \
    "$IMAGE_NAME" \
    ./snapshot_read_integration --ignored --nocapture --test-threads=1

echo ""
echo "✅ Snapshot read tests complete. Container destroyed."
