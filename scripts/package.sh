#!/usr/bin/env bash
# Package Ergatai for release.
#
# Builds the Rust backend (release) and the Electron frontend, then runs
# electron-builder for the requested platform(s).
#
# Usage:
#   scripts/package.sh [--platform mac|linux|win|all] [--skip-backend] [--skip-frontend]
#
# Output: frontend/release/

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
FRONTEND_DIR="$ROOT_DIR/frontend"

PLATFORM="mac"
SKIP_BACKEND=0
SKIP_FRONTEND=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --platform) PLATFORM="$2"; shift 2 ;;
    --skip-backend) SKIP_BACKEND=1; shift ;;
    --skip-frontend) SKIP_FRONTEND=1; shift ;;
    -h|--help)
      sed -n '3,18p' "$0"
      exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

case "$PLATFORM" in
  mac|linux|win|all) ;;
  *) echo "Unsupported platform: $PLATFORM" >&2; exit 1 ;;
esac

if [[ $SKIP_BACKEND -eq 0 ]]; then
  echo "==> Building Rust backend (release)"
  cd "$ROOT_DIR"
  cargo build --release -p ergatai-api
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

echo "==> Packaging ($PLATFORM)"
cd "$FRONTEND_DIR"
case "$PLATFORM" in
  mac) bun run package:mac ;;
  linux) bun run package:linux ;;
  win) bun run package:win ;;
  all) bun run dist ;;
esac

echo ""
echo "✅ Package complete. Output: $FRONTEND_DIR/release/"