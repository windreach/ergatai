#!/bin/bash
# Run multi-agent concurrent edge case tests in an isolated Docker container.
#
# Requirements:
#   - Docker installed and running
#   - Current user in docker group (or run with sudo)
#
# Usage:
#   ./run_multi_agent_test.sh
#
# Tests cover:
#   T1: 8 agents race for WRITE lock on same file
#   T2: 8 agents concurrent FAN_MODIFY → auto_acquire (snapshot race)
#   T3: 100 rapid lock/unlock cycles across 4 agents
#   T4: 50 concurrent permission events (semaphore saturation)
#   T5: Mixed read/write contention (4 readers + 2 writers)
#   T6: 20 workspace registrations + 20 concurrent file opens
#   T7: 100 concurrent children stress test

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../../../.." && pwd)"
IMAGE_NAME="ergatai-multi-agent-test"

echo "🔨 Building test binary on host..."
cd "$PROJECT_ROOT"
cargo test -p ergatai-lock --test multi_agent_concurrent --no-run 2>&1 | grep -E "Compiling|Finished|error" || true

TEST_BINARY=$(find target/debug/deps -name "multi_agent_concurrent-*" -type f -executable | head -1)
if [ -z "$TEST_BINARY" ]; then
    echo "❌ Failed to find test binary in target/debug/deps/"
    exit 1
fi
TEST_BINARY="$PROJECT_ROOT/$TEST_BINARY"
echo "✅ Test binary: $TEST_BINARY"

echo ""
echo "🔨 Building Docker container..."
docker build \
    --build-arg HTTP_PROXY=http://172.17.0.1:7890 \
    --build-arg HTTPS_PROXY=http://172.17.0.1:7890 \
    -t "$IMAGE_NAME" -f "$SCRIPT_DIR/Dockerfile" "$PROJECT_ROOT"

echo ""
echo "🔒 Running multi-agent concurrent tests in isolated container..."
echo "   (T1-T7: race conditions, semaphore saturation, snapshot races, stress)"
echo ""

docker run --rm \
    --privileged \
    --name ergatai-multi-agent-test-$$ \
    -v "$TEST_BINARY:/app/multi_agent_concurrent:ro" \
    "$IMAGE_NAME" \
    ./multi_agent_concurrent --ignored --nocapture --test-threads=1

echo ""
echo "✅ Multi-agent concurrent tests complete. Container destroyed."
