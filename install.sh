#!/usr/bin/env bash
# install.sh — Install Ergatai (CLI + server) with fanotify capabilities
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
#   3. Grants CAP_SYS_ADMIN to `ergatai-server` only — REQUIRED for kernel-level
#      file locking via fanotify.
#
# Architecture:
#   ┌────────────────────┐        ┌────────────────────┐
#   │   ergatai (CLI)    │─HTTP─►│ergatai-server (API)│
#   │  workspace/agent   │        │  MCP + HTTP server │
#   │  management        │        │                    │
#   └────────────────────┘        │  ┌─ fanotify ───┐  │  ← needs CAP_SYS_ADMIN
#                                  │  │ (file locks) │  │
#   rmux-daemon ◄── rmux SDK ──── │  └──────────────┘  │  ← auto-managed, bundled
#   nats-server ◄── embedded ──── │  (JetStream bus)   │  ← auto-managed, bundled
#                                  └────────────────────┘
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
    echo "   Ergatai on macOS/Windows runs in advisory-only mode (no kernel locking)."
    echo "   Download the binaries manually from https://github.com/${REPO}/releases"
    exit 1
fi

for cmd in curl unzip getcap setcap; do
    if ! command -v "$cmd" &>/dev/null; then
        echo "❌ Required command not found: $cmd"
        case "$cmd" in
            getcap|setcap)
                echo "   Install with: sudo apt-get install libcap2-bin  (Debian/Ubuntu)"
                echo "                 sudo yum install libcap  (RHEL/CentOS)"
                ;;
        esac
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
echo "     • $SERVER_NAME  (server — MCP/HTTP API, needs CAP_SYS_ADMIN)"
echo "     • nats-server   (JetStream bus, pre-bundled)"
echo ""

# ── Download ────────────────────────────────────────────────────────────────

# ── Download portable bundle ────────────────────────────────────────────────

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

# The zip contains a single top-level directory; find the binaries inside.
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

# ── Grant CAP_SYS_ADMIN to SERVER only (REQUIRED for kernel-level file locking) ─

echo ""
echo "🔐 Granting CAP_SYS_ADMIN to $SERVER_NAME for fanotify..."
echo ""
echo "   ⚠️  This step requires sudo and is CRITICAL:"
echo "       WITHOUT this capability, file locking runs in ADVISORY MODE"
echo "       (locks can be bypassed by direct shell access)."
echo "   ℹ️  Note: only the SERVER needs this capability, not the CLI."
echo ""

SERVER_TARGET="$INSTALL_DIR/$SERVER_NAME"
if [[ -w "$INSTALL_DIR" ]]; then
    setcap 'cap_sys_admin+ep' "$SERVER_TARGET"
else
    sudo setcap 'cap_sys_admin+ep' "$SERVER_TARGET"
fi

# ── Verify ──────────────────────────────────────────────────────────────────

echo "🔍 Verifying installation..."
echo ""
echo "   Server ($SERVER_NAME):"
echo "     Path:         $SERVER_TARGET"
INSTALLED_CAPS=$(getcap "$SERVER_TARGET")
echo "     Capabilities: ${INSTALLED_CAPS:-<none>}"

echo ""
if [[ "$INSTALLED_CAPS" == *"cap_sys_admin"* ]]; then
    echo "✅ Installation successful!"
    echo ""
    echo "   File locking: MANDATORY (kernel-enforced via fanotify)"
    echo ""
    echo "   Start the server:"
    echo "     $SERVER_NAME --port 3000"
    echo ""
    echo "   The desktop app (bundled in the same release zip) connects to it."
    echo ""
    echo "   📖 Documentation: https://github.com/${REPO}#readme"
else
    echo "⚠️  WARNING: CAP_SYS_ADMIN not set on $SERVER_NAME!"
    echo ""
    echo "   File locking will run in ADVISORY MODE only."
    echo "   To enable mandatory locking, run manually:"
    echo ""
    echo "     sudo setcap 'cap_sys_admin+ep' $SERVER_TARGET"
    echo ""
    echo "   See: https://github.com/${REPO}#file-locking-permissions"
fi
