#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
FRONTEND_DIR="$PROJECT_ROOT/frontend"
API_PORT=${API_PORT:-3000}
DISPLAY_NUM=${DISPLAY_NUM:-99}
TEST_FILE="$1"

cleanup() {
    [ ! -z "$API_PID" ] && kill $API_PID 2>/dev/null || true
    [ ! -z "$XVFB_PID" ] && kill $XVFB_PID 2>/dev/null || true
}
trap cleanup EXIT

echo "[INFO] Checking dependencies..."
command -v cargo >/dev/null 2>&1 || { echo "[ERROR] No Rust"; exit 1; }
command -v bun >/dev/null 2>&1 || { echo "[ERROR] No bun"; exit 1; }
command -v Xvfb >/dev/null 2>&1 || { echo "[ERROR] No Xvfb"; exit 1; }
[ -f "$FRONTEND_DIR/out/main/index.js" ] || { echo "[ERROR] Electron not built"; exit 1; }

echo "[INFO] Starting backend..."
cd "$PROJECT_ROOT"
cargo run -p ergatai-api -- --port $API_PORT --host 127.0.0.1 > /tmp/ergatai-api.log 2>&1 &
API_PID=$!

# Wait for API to become healthy (with timeout)
echo "[INFO] Waiting for API to start..."
API_HEALTHY=false
for i in {1..30}; do
    if curl -s -f "http://127.0.0.1:$API_PORT/health" >/dev/null 2>&1; then
        API_HEALTHY=true
        echo "[INFO] API is healthy"
        break
    fi
    sleep 1
done

if [ "$API_HEALTHY" != "true" ]; then
    echo "[ERROR] API failed to start within 30 seconds"
    echo "[ERROR] Check /tmp/ergatai-api.log for details"
    exit 1
fi

echo "[INFO] Starting Xvfb..."
Xvfb :$DISPLAY_NUM -screen 0 1024x768x24 > /tmp/xvfb.log 2>&1 &
XVFB_PID=$!
export DISPLAY=:$DISPLAY_NUM
sleep 2

echo "[INFO] Running tests..."
cd "$FRONTEND_DIR"
if [ ! -z "$TEST_FILE" ]; then
    bun run test:e2e "$TEST_FILE"
else
    bun run test:e2e
fi
