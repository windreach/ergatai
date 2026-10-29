#!/usr/bin/env bash
set -euo pipefail

# Development script - starts both backend and frontend
# Usage: ./scripts/dev.sh

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
FRONTEND_DIR="$ROOT_DIR/frontend"
API_HOST="${ERGATAI_API_HOST:-127.0.0.1}"
API_PORT="${ERGATAI_API_PORT:-3000}"
API_URL="http://${API_HOST}:${API_PORT}"

export ERGATAI_API_URL="$API_URL"

# Log directory
LOG_DIR="$ROOT_DIR/logs"
mkdir -p "$LOG_DIR"

BACKEND_LOG="$LOG_DIR/backend.log"
FRONTEND_LOG="$LOG_DIR/frontend.log"

# Clean up old logs
rm -f "$BACKEND_LOG" "$FRONTEND_LOG"

cleanup() {
  echo ""
  echo "── Shutting down... ──"

  # Kill child processes and their descendants
  # Use pkill with process tree to ensure all descendants are killed
  if [[ -n "${BACKEND_PID:-}" ]]; then
    pkill -P "$BACKEND_PID" 2>/dev/null || true
    kill "$BACKEND_PID" 2>/dev/null || true
  fi

  if [[ -n "${FRONTEND_PID:-}" ]]; then
    pkill -P "$FRONTEND_PID" 2>/dev/null || true
    kill "$FRONTEND_PID" 2>/dev/null || true
  fi

  # Give processes time to gracefully shutdown
  sleep 1

  # Force kill any remaining processes
  if [[ -n "${BACKEND_PID:-}" ]]; then
    kill -KILL "$BACKEND_PID" 2>/dev/null || true
  fi

  if [[ -n "${FRONTEND_PID:-}" ]]; then
    kill -KILL "$FRONTEND_PID" 2>/dev/null || true
  fi

  # Also kill any process using port 3000 (backend might have spawned children)
  if command -v lsof >/dev/null 2>&1; then
    local port_pid
    port_pid=$(lsof -ti:"$API_PORT" 2>/dev/null || true)
    if [[ -n "$port_pid" ]]; then
      kill "$port_pid" 2>/dev/null || true
      sleep 0.5
      kill -KILL "$port_pid" 2>/dev/null || true
    fi
  fi

  wait 2>/dev/null || true

  echo ""
  echo "── Logs saved to ──"
  echo "Backend:  $BACKEND_LOG"
  echo "Frontend: $FRONTEND_LOG"
}
trap cleanup EXIT INT TERM

echo "── Starting backend (ergatai-api) ──"
cd "$ROOT_DIR"
# Start backend without hot reload (use separate terminal for development)
RUST_LOG=info cargo run -p ergatai-api --bin ergatai-server -- --host "$API_HOST" --port "$API_PORT" >> "$BACKEND_LOG" 2>&1 &
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

echo "── Starting frontend (Electron dev) ──"
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
