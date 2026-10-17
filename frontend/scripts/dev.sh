#!/usr/bin/env bash
set -euo pipefail

FRONTEND_DIR="$(cd "$(dirname "$0")/.." && pwd)"
BACKEND_DIR="${ERGATAI_BACKEND_DIR:-"$FRONTEND_DIR/../ergatai"}"
API_HOST="${ERGATAI_API_HOST:-127.0.0.1}"
API_PORT="${ERGATAI_API_PORT:-3000}"
API_URL="http://${API_HOST}:${API_PORT}"

export ERGATAI_API_URL="$API_URL"

if [ ! -d "$BACKEND_DIR/crates" ]; then
  echo "Backend not found at $BACKEND_DIR"
  echo "Set ERGATAI_BACKEND_DIR=/path/to/ergatai or place it next to ergatai-ui."
  exit 1
fi

# 日志目录和文件
LOG_DIR="$FRONTEND_DIR/logs"
mkdir -p "$LOG_DIR"

BACKEND_LOG="$LOG_DIR/backend.log"
FRONTEND_LOG="$LOG_DIR/frontend.log"

# 删除上次的日志文件，避免日志爆炸
rm -f "$BACKEND_LOG" "$FRONTEND_LOG"

cleanup() {
  # Kill the entire process group to catch all descendants
  kill -- -$$ 2>/dev/null || true
  sleep 1
  kill -KILL -- -$$ 2>/dev/null || true
  wait 2>/dev/null || true
  echo ""
  echo "── Logs saved to ──"
  echo "Backend:  $BACKEND_LOG"
  echo "Frontend: $FRONTEND_LOG"
}
trap cleanup EXIT

echo "── Starting backend (ergatai-api) ──"
cd "$BACKEND_DIR"
# 重定向到日志文件（在另一个终端用 tail -f 查看）
RUST_LOG=debug cargo run -p ergatai-api -- --host "$API_HOST" --port "$API_PORT" >> "$BACKEND_LOG" 2>&1 &
BACKEND_PID=$!

echo "Waiting for backend at $API_URL/health..."
backend_ready=false
for _ in $(seq 1 600); do
  if curl -fsS --max-time 1 "$API_URL/health" >/dev/null 2>&1; then
    backend_ready=true
    break
  fi

  if ! kill -0 "$BACKEND_PID" 2>/dev/null; then
    echo "Backend exited before becoming healthy."
    wait "$BACKEND_PID" || true
    exit 1
  fi

  sleep 1
done

if [[ "$backend_ready" != true ]]; then
  echo "Timed out waiting for backend at $API_URL/health."
  exit 1
fi

echo "── Starting frontend (ergatai-ui) ──"
cd "$FRONTEND_DIR"
bun run dev:frontend >> "$FRONTEND_LOG" 2>&1 &
FRONTEND_PID=$!

echo ""
echo "Backend:  $API_URL"
echo "Frontend: Electron dev (bun)"
echo ""
echo "Logs:"
echo "  Backend:  $BACKEND_LOG"
echo "  Frontend: $FRONTEND_LOG"
echo ""
echo "Press Ctrl+C to stop both."
echo ""

wait
