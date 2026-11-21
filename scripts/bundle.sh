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

echo "==> Building backend (release)"
cd "$ROOT_DIR"
cargo build --release -p ergatai-api
cargo build --release -p ergatai-launcher

echo "==> Building frontend"
cd "$FRONTEND_DIR"
if [[ ! -d node_modules ]]; then bun install; fi
bun run build

echo "==> Unpacked app"
bun run package

BUNDLE_NAME="ergatai-portable-${PLATFORM}-${ARCH}"
BUNDLE_DIR="$FRONTEND_DIR/release/$BUNDLE_NAME"
rm -rf "$BUNDLE_DIR"
mkdir -p "$BUNDLE_DIR/bin" "$BUNDLE_DIR/app"

if [[ "$PLATFORM" == "windows" ]]; then
  cp "$ROOT_DIR/target/release/ergatai-server.exe" "$BUNDLE_DIR/bin/"
  LAUNCHER="$ROOT_DIR/target/release/ergatai-launcher.exe"
else
  cp "$ROOT_DIR/target/release/ergatai-server" "$BUNDLE_DIR/bin/"
  chmod +x "$BUNDLE_DIR/bin/ergatai-server"
  LAUNCHER="$ROOT_DIR/target/release/ergatai-launcher"
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
"$DIR/bin/ergatai-server" --port 3000 >"$DIR/server.log" 2>&1 &
SERVER_PID=$!
for _ in $(seq 1 60); do
  curl -fsS http://127.0.0.1:3000/health >/dev/null 2>&1 && break
  sleep 1
done
open "$DIR/app/Ergatai.app"
wait "$SERVER_PID"
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
"$DIR/bin/ergatai-server" --port 3000 >"$DIR/server.log" 2>&1 &
SERVER_PID=$!
for _ in $(seq 1 60); do
  curl -fsS http://127.0.0.1:3000/health >/dev/null 2>&1 && break
  sleep 1
done
exec "$DIR/app/ergatai"
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
start "" "%DIR%app\ergatai.exe"
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