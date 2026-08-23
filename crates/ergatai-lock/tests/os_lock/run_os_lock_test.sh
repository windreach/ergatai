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
# This builds a minimal Rust toolchain container, copies the project,
# and runs the fanotify integration tests with full isolation.
# The container has its own mount namespace, so FAN_MARK_MOUNT only
# affects the container's filesystem — NOT the host.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
IMAGE_NAME="ergatai-os-lock-test"

echo "🔨 Building test container image..."

docker build -t "$IMAGE_NAME" -f "$SCRIPT_DIR/Dockerfile" "$PROJECT_ROOT"

echo "🔒 Running fanotify tests in isolated container..."
echo "   (mount namespace is isolated — FAN_MARK_MOUNT won't affect host)"
echo ""

docker run --rm \
    --privileged \
    --name ergatai-os-lock-test-$$ \
    "$IMAGE_NAME" \
    cargo test -p ergatai-lock --test os_lock_integration -- --ignored --nocapture

echo ""
echo "✅ Tests complete. Container destroyed."
