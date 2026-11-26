#!/usr/bin/env bash
# Create a self-contained, portable Ergatai bundle for the current platform.
#
# The bundle contains the backend server, the (unpacked) desktop app and a
# launcher that starts the server and opens the app, so users only need to
# unzip and run one script.
#
# Usage:
#   scripts/bundle.sh
#
# Output: frontend/release/ergatai-portable-<platform>.zip

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
FRONTEND_DIR="$ROOT_DIR/frontend"

OS="$(uname -s)"
ARCH="$(uname -m)"
case "$OS" in
  Darwin) PLATFORM="mac" ;;
  Linux) PLATFORM="linux" ;;
  MINGW*|MSYS*|CYGWIN*) PLATFORM="windows" ;;
  *) echo "Unsupported OS: $OS" >&2; exit 1 ;;
esac

case "$PLATFORM" in
  mac) ELECTRON_PLATFORM="darwin" ;;
  linux) ELECTRON_PLATFORM="linux" ;;
  windows) ELECTRON_PLATFORM="win32" ;;
esac
case "$ARCH" in
  x86_64|amd64) ELECTRON_ARCH="x64" ;;
  arm64|aarch64) ELECTRON_ARCH="arm64" ;;
  *) echo "Unsupported architecture: $ARCH" >&2; exit 1 ;;
esac
RESOURCE_BIN_DIR="$FRONTEND_DIR/resources/bin/${ELECTRON_PLATFORM}-${ELECTRON_ARCH}"

echo "==> Building backend (release)"
cd "$ROOT_DIR"
cargo build --release -p ergatai-api
cargo build --release -p ergatai-launcher

echo "==> Building frontend"
cd "$FRONTEND_DIR"
if [[ ! -d node_modules ]]; then bun install; fi
bun run build

echo "==> Preparing bundled Node runtime and ACP adapters"
node "$ROOT_DIR/scripts/prepare-runtime.mjs"
node "$ROOT_DIR/scripts/prepare-adapters.mjs"

echo "==> Unpacked app"
bun run package

BUNDLE_NAME="ergatai-portable-${PLATFORM}-${ARCH}"
BUNDLE_DIR="$FRONTEND_DIR/release/$BUNDLE_NAME"
rm -rf "$BUNDLE_DIR"
mkdir -p "$BUNDLE_DIR/bin" "$BUNDLE_DIR/app"

if [[ "$PLATFORM" == "windows" ]]; then
  cp "$ROOT_DIR/target/release/ergatai-server.exe" "$BUNDLE_DIR/bin/"
  LAUNCHER="$ROOT_DIR/target/release/ergatai-launcher.exe"
  NATS_BIN="$(command -v nats-server.exe 2>/dev/null || true)"
else
  cp "$ROOT_DIR/target/release/ergatai-server" "$BUNDLE_DIR/bin/"
  chmod +x "$BUNDLE_DIR/bin/ergatai-server"
  LAUNCHER="$ROOT_DIR/target/release/ergatai-launcher"
  NATS_BIN="$(command -v nats-server 2>/dev/null || true)"
fi
# ergatai-server looks for nats-server next to itself before falling back to PATH.
if [[ -n "$NATS_BIN" ]]; then
  cp "$NATS_BIN" "$BUNDLE_DIR/bin/"
  chmod +x "$BUNDLE_DIR/bin/$(basename "$NATS_BIN")" 2>/dev/null || true
else
  echo "   WARNING: nats-server not found in PATH; runtime will need it installed" >&2
fi
if [[ -f "$RESOURCE_BIN_DIR/node" ]]; then
  cp "$RESOURCE_BIN_DIR/node" "$BUNDLE_DIR/bin/node"
  chmod +x "$BUNDLE_DIR/bin/node"
fi
if [[ -d "$RESOURCE_BIN_DIR/adapters" ]]; then
  cp -R "$RESOURCE_BIN_DIR/adapters" "$BUNDLE_DIR/bin/adapters"
fi
if [[ -f "$LAUNCHER" ]]; then
  cp "$LAUNCHER" "$BUNDLE_DIR/"
  chmod +x "$BUNDLE_DIR/ergatai-launcher" 2>/dev/null || true
fi

# Copy unpacked app
case "$PLATFORM" in
  mac)
    APP_DIR="$(ls -d "$FRONTEND_DIR/release"/mac-*/Ergatai.app 2>/dev/null | head -1)"
    if [[ -z "${APP_DIR:-}" ]]; then echo "Unpacked .app not found" >&2; exit 1; fi
    cp -R "$APP_DIR" "$BUNDLE_DIR/app/"
    cat > "$BUNDLE_DIR/start.sh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
export PATH="$DIR/bin:$PATH"
"$DIR/bin/ergatai-server" --port 3000 >"$DIR/server.log" 2>&1 &
SERVER_PID=$!
for _ in $(seq 1 60); do
  curl -fsS http://127.0.0.1:3000/health >/dev/null 2>&1 && break
  sleep 1
done
open -W "$DIR/app/Ergatai.app"
kill "$SERVER_PID" 2>/dev/null || true
wait "$SERVER_PID" 2>/dev/null || true
EOF
    ;;
  linux)
    APP_DIR="$FRONTEND_DIR/release/linux-unpacked"
    if [[ ! -d "$APP_DIR" ]]; then echo "Unpacked linux app not found" >&2; exit 1; fi
    cp -R "$APP_DIR/." "$BUNDLE_DIR/app/"
    cat > "$BUNDLE_DIR/start.sh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
export PATH="$DIR/bin:$PATH"
"$DIR/bin/ergatai-server" --port 3000 >"$DIR/server.log" 2>&1 &
SERVER_PID=$!
cleanup() {
  kill "$SERVER_PID" 2>/dev/null || true
  wait "$SERVER_PID" 2>/dev/null || true
}
trap cleanup EXIT
for _ in $(seq 1 60); do
  curl -fsS http://127.0.0.1:3000/health >/dev/null 2>&1 && break
  sleep 1
done

# Electron's SUID sandbox helper must be root-owned and mode 4755.
# A portable bundle cannot preserve that ownership through a zip, so fall
# back to --no-sandbox (Chromium still applies its other isolation layers).
SANDBOX_ARGS=()
if [[ -f "$DIR/app/chrome-sandbox" ]]; then
  SANDBOX_STATE="$(stat -c '%u:%a' "$DIR/app/chrome-sandbox" 2>/dev/null || true)"
  if [[ "$SANDBOX_STATE" != "0:4755" ]]; then
    echo "⚠️  chrome-sandbox is not root:root 4755; starting with --no-sandbox."
    echo "    To enable the Chromium sandbox:"
    echo "      sudo chown root:root \"$DIR/app/chrome-sandbox\""
    echo "      sudo chmod 4755 \"$DIR/app/chrome-sandbox\""
    SANDBOX_ARGS=(--no-sandbox)
  fi
fi

set +e
"$DIR/app/ergatai" "${SANDBOX_ARGS[@]}"
APP_STATUS=$?
set -e
exit "$APP_STATUS"
EOF
    ;;
  windows)
    APP_DIR="$FRONTEND_DIR/release/win-unpacked"
    if [[ ! -d "$APP_DIR" ]]; then echo "Unpacked windows app not found" >&2; exit 1; fi
    cp -R "$APP_DIR/." "$BUNDLE_DIR/app/"
    if [[ -f "$ROOT_DIR/target/release/ergatai-server.exe" ]]; then
      cp "$ROOT_DIR/target/release/ergatai-server.exe" "$BUNDLE_DIR/bin/"
    fi
    cat > "$BUNDLE_DIR/start.bat" <<'EOF'
@echo off
setlocal
set DIR=%~dp0
start "" "%DIR%bin\ergatai-server.exe" --port 3000
timeout /t 5 /nobreak >nul
start "" /wait "%DIR%app\ergatai.exe"
taskkill /IM ergatai-server.exe /F >nul 2>&1
EOF
    ;;
esac
[[ -f "$BUNDLE_DIR/start.sh" ]] && chmod +x "$BUNDLE_DIR/start.sh"

echo "==> Creating archive"
cd "$FRONTEND_DIR/release"
rm -f "$BUNDLE_NAME.zip"
python3 - "$BUNDLE_DIR" "$BUNDLE_NAME.zip" <<'PY'
import os, sys, zipfile
src, dst = sys.argv[1], sys.argv[2]
base = os.path.dirname(src)
with zipfile.ZipFile(dst, "w", zipfile.ZIP_DEFLATED) as z:
    for root, _, files in os.walk(src):
        for f in files:
            full = os.path.join(root, f)
            arc = os.path.relpath(full, base)
            z.write(full, arc)
PY

echo ""
echo "✅ Portable bundle: $FRONTEND_DIR/release/$BUNDLE_NAME.zip"