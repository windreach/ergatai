#!/usr/bin/env bash
# Package Ergatai for release.
#
# Builds the Rust backend (release) and the Electron frontend, bundles the
# backend into the app resources, then runs electron-builder for the requested
# platform. The packaged app starts ergatai-server on demand.
#
# Usage:
#   scripts/package.sh [--platform mac|linux|win|all] [--skip-backend] [--skip-frontend]
#
# Notes:
#   - Self-contained packaging only supports the host platform/arch.
#   - Use --skip-backend for a frontend-only artifact.
#
# Output: frontend/release/

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
FRONTEND_DIR="$ROOT_DIR/frontend"

SKIP_BACKEND=0
SKIP_FRONTEND=0

HOST_PLATFORM=""
ELECTRON_PLATFORM=""
case "$(uname -s)" in
  Darwin) HOST_PLATFORM="mac"; ELECTRON_PLATFORM="darwin" ;;
  Linux) HOST_PLATFORM="linux"; ELECTRON_PLATFORM="linux" ;;
  MINGW*|MSYS*|CYGWIN*) HOST_PLATFORM="win"; ELECTRON_PLATFORM="win32" ;;
  *) echo "Unsupported host OS: $(uname -s)" >&2; exit 1 ;;
esac

case "$(uname -m)" in
  x86_64|amd64) HOST_ARCH="x64" ;;
  arm64|aarch64) HOST_ARCH="arm64" ;;
  *) echo "Unsupported host architecture: $(uname -m)" >&2; exit 1 ;;
esac

# Default to the host platform: the bundled backend is a native executable.
PLATFORM="$HOST_PLATFORM"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --platform) PLATFORM="$2"; shift 2 ;;
    --skip-backend) SKIP_BACKEND=1; shift ;;
    --skip-frontend) SKIP_FRONTEND=1; shift ;;
    -h|--help)
      sed -n '3,15p' "$0"
      exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

case "$PLATFORM" in
  mac|linux|win|all) ;;
  *) echo "Unsupported platform: $PLATFORM" >&2; exit 1 ;;
esac

# The backend is a native executable. electron-builder can package the app for
# another OS/arch, but it cannot conjure a matching Rust binary.
if [[ $SKIP_BACKEND -eq 0 ]]; then
  if [[ "$PLATFORM" == "all" ]]; then
    echo "ERROR: --platform all cannot bundle a native backend for every target." >&2
    echo "       Run this script once on each target OS, or use --skip-backend" >&2
    echo "       to produce a frontend-only build." >&2
    exit 1
  fi
  if [[ "$PLATFORM" != "$HOST_PLATFORM" ]]; then
    echo "ERROR: bundling ergatai-server for '$PLATFORM' requires building on $PLATFORM." >&2
    echo "       Current host: $HOST_PLATFORM/$HOST_ARCH. Use --skip-backend for a" >&2
    echo "       frontend-only artifact, or run this script on the target machine." >&2
    exit 1
  fi
fi

if [[ $SKIP_BACKEND -eq 0 ]]; then
  echo "==> Building Rust backend (release)"
  cd "$ROOT_DIR"
  cargo build --release -p ergatai-api

  BACKEND_EXE=""
  if [[ "$HOST_PLATFORM" == "win" ]]; then
    BACKEND_EXE=".exe"
  fi

  RESOURCE_BIN_DIR="$FRONTEND_DIR/resources/bin/${ELECTRON_PLATFORM}-${HOST_ARCH}"
  mkdir -p "$RESOURCE_BIN_DIR"

  echo "==> Bundling backend into $RESOURCE_BIN_DIR"
  cp "$ROOT_DIR/target/release/ergatai-server${BACKEND_EXE}" "$RESOURCE_BIN_DIR/"
  chmod +x "$RESOURCE_BIN_DIR/ergatai-server${BACKEND_EXE}"

  # ergatai-server launches nats-server from a sibling path first, then PATH.
  NATS_BIN="$(command -v nats-server 2>/dev/null || true)"
  if [[ -z "$NATS_BIN" ]]; then
    NATS_BIN="$(command -v nats-server.exe 2>/dev/null || true)"
  fi
  if [[ -n "$NATS_BIN" ]]; then
    cp "$NATS_BIN" "$RESOURCE_BIN_DIR/nats-server${BACKEND_EXE}"
    chmod +x "$RESOURCE_BIN_DIR/nats-server${BACKEND_EXE}"
    echo "   nats-server: $NATS_BIN"
  else
    echo "   WARNING: nats-server not found in PATH; the packaged backend will" >&2
    echo "            fall back to a system installation at runtime." >&2
  fi
fi

if [[ $SKIP_FRONTEND -eq 0 ]]; then
  echo "==> Building frontend"
  cd "$FRONTEND_DIR"
  if [[ ! -d node_modules ]]; then
    echo "   installing dependencies"
    bun install
  fi
  bun run build
fi

echo "==> Packaging ($PLATFORM/$HOST_ARCH)"
cd "$FRONTEND_DIR"

# Pin the target arch: the backend we just bundled only matches this machine.
ELECTRON_BUILDER="$FRONTEND_DIR/node_modules/.bin/electron-builder"
case "$PLATFORM" in
  mac) "$ELECTRON_BUILDER" --mac "--${HOST_ARCH}" ;;
  linux) "$ELECTRON_BUILDER" --linux "--${HOST_ARCH}" ;;
  win) "$ELECTRON_BUILDER" --win "--${HOST_ARCH}" ;;
  all) "$ELECTRON_BUILDER" "--${HOST_ARCH}" ;;
esac

echo ""
echo "✅ Package complete. Output: $FRONTEND_DIR/release/"