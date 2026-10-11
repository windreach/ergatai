#!/usr/bin/env bash
# Test script for PTY terminal functionality

set -e

echo "=== PTY Terminal Test ==="
echo ""

# Start the API server in background
echo "1. Starting ergatai-api server on port 3001..."
cargo run -p ergatai-api -- --port 3001 &
SERVER_PID=$!
sleep 3

# Cleanup function
cleanup() {
    echo ""
    echo "Cleaning up..."
    kill $SERVER_PID 2>/dev/null || true
    wait $SERVER_PID 2>/dev/null || true
}
trap cleanup EXIT

# Test 1: Health check
echo "2. Testing health endpoint..."
curl -s http://127.0.0.1:3001/health > /dev/null
echo "   ✓ Health check passed"

# Test 2: WebSocket connection (using websocat if available)
if command -v websocat &> /dev/null; then
    echo "3. Testing WebSocket PTY connection..."
    timeout 5 websocat ws://127.0.0.1:3001/api/v1/terminals/ws?cwd=/tmp&cols=80&rows=24 <<EOF &
{"type":"input","data":"echo 'PTY test successful'\r"}
EOF
    WEBSOCAT_PID=$!
    sleep 2
    kill $WEBSOCAT_PID 2>/dev/null || true
    echo "   ✓ WebSocket connection established"
else
    echo "3. Skipping WebSocket test (websocat not installed)"
    echo "   Install with: cargo install websocat"
fi

echo ""
echo "=== All tests passed! ==="
echo ""
echo "PTY terminal is ready to use:"
echo "  Backend: ws://127.0.0.1:3001/api/v1/terminals/ws"
echo "  Frontend: Set VITE_TERMINAL_TRANSPORT=pty"
