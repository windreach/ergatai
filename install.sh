#!/usr/bin/env bash
# install.sh — Install Ergatai (server + nats-server) on Linux
#
# Usage:
#   curl -sSL https://raw.githubusercontent.com/windreach/Ergatai/main/install.sh | bash
#   curl -sSL ... | bash -s -- v0.1.0 /usr/local/bin
#
# What this does:
#   1. Downloads the portable bundle (one zip per platform/arch) from GitHub
#      Releases. The bundle contains ergatai-server + nats-server + the desktop app.
#   2. Extracts ergatai-server and nats-server into the target directory
#      (default: /usr/local/bin).
#
# Notes:
#   - File locking no longer requires CAP_SYS_ADMIN / fanotify privileges;
#     the fanotify enforcer has been removed in favor of ACP pre-emptive locking.
#   - macOS/Windows are not supported by this script; download binaries manually.
#
# Arguments:
#   $1 — version tag (default: latest)
#   $2 — install directory (default: /usr/local/bin)

set -euo pipefail

VERSION="${1:-latest}"
INSTALL_DIR="${2:-/usr/local/bin}"
REPO="windreach/Ergatai"
SERVER_NAME="ergatai-server"

# ── Preflight checks ────────────────────────────────────────────────────────

if [[ "$(uname -s)" != "Linux" ]]; then
    echo "⚠️  This installer is for Linux only."
    echo "   Download the binaries manually from https://github.com/${REPO}/releases"
    exit 1
fi

for cmd in curl unzip; do
    if ! command -v "$cmd" &>/dev/null; then
        echo "❌ Required command not found: $cmd"
        exit 1
    fi
done

if [[ "$(uname -m)" == "x86_64" ]]; then
    ARCH="x86_64"
elif [[ "$(uname -m)" == "aarch64" || "$(uname -m)" == "arm64" ]]; then
    ARCH="aarch64"
else
    echo "❌ Unsupported architecture: $(uname -m)"
    exit 1
fi

# ── Resolve version ─────────────────────────────────────────────────────────

if [[ "$VERSION" == "latest" ]]; then
    echo "🔍 Resolving latest release..."
    VERSION=$(curl -sSL "https://api.github.com/repos/${REPO}/releases/latest" \
        | grep '"tag_name"' | sed -E 's/.*"([^"]+)".*/\1/')
    if [[ -z "$VERSION" ]]; then
        echo "❌ Failed to resolve latest version. Try specifying explicitly:"
        echo "   curl -sSL ... | bash -s -- v0.1.0"
        exit 1
    fi
fi

echo "📦 Ergatai Installer"
echo "   Version:   $VERSION"
echo "   Arch:      $ARCH"
echo "   Install:   $INSTALL_DIR/"
echo ""
echo "   Binaries to install:"
echo "     • $SERVER_NAME  (server — MCP/HTTP API)"
echo "     • nats-server   (JetStream bus, pre-bundled)"
echo ""

# ── Download ────────────────────────────────────────────────────────────────

BUNDLE_NAME="ergatai-portable-linux-${ARCH}.zip"
DOWNLOAD_URL="https://github.com/${REPO}/releases/download/${VERSION}/${BUNDLE_NAME}"

TMP_BUNDLE=$(mktemp)
TMP_EXTRACT=$(mktemp -d)
trap 'rm -f "$TMP_BUNDLE"; rm -rf "$TMP_EXTRACT"' EXIT

echo "⬇️  Downloading $BUNDLE_NAME from $DOWNLOAD_URL"
if ! curl -fL -o "$TMP_BUNDLE" "$DOWNLOAD_URL"; then
    echo "❌ Download failed for $BUNDLE_NAME. Check:"
    echo "   - Version exists: https://github.com/${REPO}/releases"
    echo "   - Network connection"
    exit 1
fi

echo "📦 Extracting bundle"
unzip -q "$TMP_BUNDLE" -d "$TMP_EXTRACT"

BUNDLE_ROOT=$(find "$TMP_EXTRACT" -type d -name 'ergatai-portable-*' | head -n 1)
if [[ -z "$BUNDLE_ROOT" ]]; then
    BUNDLE_ROOT="$TMP_EXTRACT"
fi

SERVER_SRC="$BUNDLE_ROOT/bin/ergatai-server"
NATS_SRC="$BUNDLE_ROOT/bin/nats-server"
if [[ ! -f "$SERVER_SRC" ]]; then
    echo "❌ ergatai-server not found in bundle" >&2
    exit 1
fi

# ── Install ─────────────────────────────────────────────────────────────────

echo "📁 Installing to $INSTALL_DIR"

install_binary() {
    local src="$1"
    local name="$2"
    if [[ -w "$INSTALL_DIR" ]]; then
        install -m 0755 "$src" "$INSTALL_DIR/$name"
    else
        sudo install -m 0755 "$src" "$INSTALL_DIR/$name"
    fi
}

install_binary "$SERVER_SRC" "$SERVER_NAME"
echo "   ✓ $SERVER_NAME  (server)"

if [[ -f "$NATS_SRC" ]]; then
    install_binary "$NATS_SRC" "nats-server"
    echo "   ✓ nats-server   (pre-bundled)"
else
    echo "   ⚠️  nats-server not bundled; will be downloaded separately below"
fi

# ── Pre-download nats-server (sibling of ergatai-server) ────────────────────

NATS_VERSION="2.10.27"
NATS_ASSET_ARCH="$ARCH"
case "$ARCH" in
    x86_64) NATS_ASSET_ARCH="amd64" ;;
    aarch64) NATS_ASSET_ARCH="arm64" ;;
esac
NATS_URL="https://github.com/nats-io/nats-server/releases/download/v${NATS_VERSION}/nats-server-v${NATS_VERSION}-linux-${NATS_ASSET_ARCH}.tar.gz"
TMP_NATS_DIR=$(mktemp -d)
echo ""
echo "⬇️  Pre-downloading nats-server v${NATS_VERSION} from $NATS_URL"
if curl -fL -o "$TMP_NATS_DIR/nats.tar.gz" "$NATS_URL"; then
    tar -xzf "$TMP_NATS_DIR/nats.tar.gz" -C "$TMP_NATS_DIR"
    NATS_BIN_PATH=$(find "$TMP_NATS_DIR" -type f -name nats-server | head -n 1)
    if [[ -n "$NATS_BIN_PATH" ]]; then
        if [[ -w "$INSTALL_DIR" ]]; then
            install -m 0755 "$NATS_BIN_PATH" "$INSTALL_DIR/nats-server"
        else
            sudo install -m 0755 "$NATS_BIN_PATH" "$INSTALL_DIR/nats-server"
        fi
        echo "   ✓ nats-server (pre-downloaded next to $SERVER_NAME)"
    else
        echo "   ⚠️  nats-server not found inside archive; runtime will require a manual install"
    fi
else
    echo "   ⚠️  Failed to download nats-server; runtime will require a manual install"
fi
rm -rf "$TMP_NATS_DIR"

# ── Verify ──────────────────────────────────────────────────────────────────

echo ""
echo "🔍 Verifying installation..."
echo ""
echo "   Server ($SERVER_NAME):"
echo "     Path:         $INSTALL_DIR/$SERVER_NAME"
echo ""
echo "✅ Installation successful!"
echo ""
echo "   Start the server:"
echo "     $INSTALL_DIR/$SERVER_NAME --port 3000"
echo ""
echo "   The desktop app (bundled in the same release zip) connects to it."
echo ""
echo "   📖 Documentation: https://github.com/${REPO}#readme"
