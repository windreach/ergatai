#!/usr/bin/env bash
set -e  # 遇到错误立即退出，模拟 CI 的 fail-fast

# Ensure we run from the project root (where Cargo.lock lives)
cd "$(dirname "$0")/../.."

export CARGO_TERM_COLOR=always
export RUST_BACKTRACE=1

echo "==> 1. Format check"
cargo fmt --all -- --check

echo "==> 2. Build check"
cargo check --workspace --all-targets

echo "==> 3. Clippy"
cargo clippy --workspace --all-targets --all-features -- -D warnings

echo "==> 4. Unit tests"
cargo test --workspace --lib --all-features

echo "==> 5. Integration tests"
cargo test --workspace --tests --all-features

echo "==> 6. Documentation"
RUSTDOCFLAGS="-D warnings" cargo doc --workspace --no-deps --all-features

echo "==> 7. MSRV check"
rustup run 1.88 cargo check --workspace --all-targets

echo "==> 8. Bench smoke test"
cargo bench --workspace -- --test

echo "==> 9. Security audit"
cargo audit

echo "==> 10. Unused dependencies (machete)"
cargo machete || true

echo "✅ All CI steps passed locally!"
