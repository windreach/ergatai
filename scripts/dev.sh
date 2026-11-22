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

# Preserve previous run's logs instead of deleting them outright
if [[ -f "$BACKEND_LOG" ]]; then
  mv -f "$BACKEND_LOG" "$BACKEND_LOG.prev" 2>/dev/null || true
fi
if [[ -f "$FRONTEND_LOG" ]]; then
  mv -f "$FRONTEND_LOG" "$FRONTEND_LOG.prev" 2>/dev/null || true
fi

kill_tree() {
  local pid=$1
  [[ -z "$pid" ]] && return 0
  local children
  children=$(pgrep -P "$pid" 2>/dev/null || true)
  for c in $children; do
    kill_tree "$c"
  done
  kill -TERM "$pid" 2>/dev/null || true
}

kill_port() {
  local port=$1
  local pids
  pids=$(lsof -ti:"$port" 2>/dev/null || true)
  if [[ -n "$pids" ]]; then
    for pid in $pids; do
      kill_tree "$pid"
    done
  fi
}

force_kill_port() {
  local port=$1
  local pids
  pids=$(lsof -ti:"$port" 2>/dev/null || true)
  if [[ -n "$pids" ]]; then
    for pid in $pids; do
      kill -KILL "$pid" 2>/dev/null || true
    done
  fi
}

cleanup() {
  if [[ "${_CLEANUP_DONE:-0}" == "1" ]]; then
    return 0
  fi
  _CLEANUP_DONE=1
  echo ""
  echo "── Shutting down... ──"

  if [[ -n "${FRONTEND_PID:-}" ]]; then
    kill_tree "$FRONTEND_PID"
    kill -- -"$FRONTEND_PID" 2>/dev/null || true
  fi

  if [[ -n "${BACKEND_PID:-}" ]]; then
    kill_tree "$BACKEND_PID"
    kill -- -"$BACKEND_PID" 2>/dev/null || true
  fi

  # Give processes time to gracefully shutdown
  sleep 1

  # Force kill by port (backend may have spawned children that survived)
  for p in "$API_PORT" 4222 4223; do
    force_kill_port "$p"
  done

  wait 2>/dev/null || true

  echo ""
  echo "── Logs saved to ──"
  echo "Backend:  $BACKEND_LOG"
  echo "Frontend: $FRONTEND_LOG"
}

trap cleanup EXIT INT TERM

# ── Preflight: kill any stale instances from previous runs ──────────────
echo "── Cleaning up previous instances ──"
pkill -f "ergatai-server --host" 2>/dev/null || true
for pid in $(pgrep -f "nats-server" 2>/dev/null || true); do
  if tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null | grep -q "ergatai/nats-store"; then
    kill_tree "$pid"
  fi
done
pkill -f "code/ergatai/frontend" 2>/dev/null || true

for p in "$API_PORT" 4222 4223; do
  kill_port "$p"
done

# Wait until the API port is actually free before proceeding
for _ in $(seq 1 20); do
  if ! lsof -ti:"$API_PORT" >/dev/null 2>&1; then
    break
  fi
  sleep 0.5
done
if lsof -ti:"$API_PORT" >/dev/null 2>&1; then
  echo "ERROR: port $API_PORT is still in use after cleanup:"
  lsof -nP -iTCP:"$API_PORT" 2>/dev/null || true
  exit 1
fi

echo "── Starting backend (ergatai-api) ──"
cd "$ROOT_DIR"
# Start backend in its own process group so the whole tree can be killed reliably
RUST_LOG=debug setsid cargo run -p ergatai-api --bin ergatai-server -- --host "$API_HOST" --port "$API_PORT" >> "$BACKEND_LOG" 2>&1 &
BACKEND_PID=$!

echo "Waiting for backend at $API_URL/health..."
backend_ready=false
for _ in $(seq 1 600); do
  if ! kill -0 "$BACKEND_PID" 2>/dev/null; then
    echo "Backend exited before becoming healthy."
    wait "$BACKEND_PID" || true
    exit 1
  fi

  if curl -fsS --max-time 1 "$API_URL/health" >/dev/null 2>&1; then
    backend_ready=true
    break
  fi

  sleep 1
done

if [[ "$backend_ready" != true ]]; then
  echo "Timed out waiting for backend at $API_URL/health."
  exit 1
fi

# Electron's setuid sandbox helper needs root ownership/mode 4755. In
# containers or unprivileged environments it is usually not configured, so
# fall back to --no-sandbox instead of failing to launch.
SANDBOX_HELPER="$FRONTEND_DIR/node_modules/electron/dist/chrome-sandbox"
if [ ! -u "$SANDBOX_HELPER" ] || [ "$(stat -c %u "$SANDBOX_HELPER" 2>/dev/null || echo 1)" != "0" ]; then
  export NO_SANDBOX=1
fi

# Dev builds run more reliably with software rendering; avoids GPU process
# crashes on machines/containers without fully working GPU drivers (e.g.
# missing NVIDIA VA-API support).
export ELECTRON_DISABLE_GPU=1

# Refresh the desktop entry / dock icon used by the dev Electron runtime.
node "$ROOT_DIR/scripts/patch-electron-dev.mjs" || true

echo "── Starting frontend (Electron dev) ──"
cd "$FRONTEND_DIR"
setsid bun run dev:frontend >> "$FRONTEND_LOG" 2>&1 &
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