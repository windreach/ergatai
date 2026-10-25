#!/usr/bin/env bash
set -e

# 切到项目根目录（Cargo.lock 所在目录，和你原来脚本保持一致）
cd "$(dirname "$0")/../.."

export CARGO_TERM_COLOR=always
export RUST_BACKTRACE=1

echo "==> 1. Auto fix rustfmt"
cargo fmt --all

echo "==> 2. Auto fix clippy (apply available fixes)"
# --allow-dirty：允许工作区有未提交修改（本地修复场景很常用）
# -- -D warnings：修复的时候依然按严格标准，能修的尽量修
cargo clippy --workspace --all-targets --all-features --fix --allow-dirty -- -D warnings

echo "==> 3. Re-check format after fix"
cargo fmt --all -- --check

echo "==> 4. Re-check clippy after fix"
cargo clippy --workspace --all-targets --all-features -- -D warnings

echo "==> ✅ fmt + clippy auto-fix done, basic check passed"

