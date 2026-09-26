#!/usr/bin/env bash
set -e

echo "==> 1. 生成 LCOV 报告"
cargo llvm-cov --workspace --all-features --lcov --output-path lcov.info

echo "==> 2. 生成 HTML 报告"
cargo llvm-cov --workspace --all-features --html

echo "==> 3. 检查覆盖率阈值"
COVERAGE_OUTPUT=$(cargo llvm-cov --workspace --all-features --summary-only)
COVERAGE=$(echo "$COVERAGE_OUTPUT" | grep "^TOTAL" | grep -oP '\d+\.\d+%' | head -1 | tr -d '%' || echo "")

if [ -z "$COVERAGE" ]; then
  echo "❌ 无法解析覆盖率输出"
  echo "$COVERAGE_OUTPUT"
  exit 1
fi

echo "当前覆盖率: ${COVERAGE}%"
MIN_COVERAGE=60.0

if (( $(echo "$COVERAGE < $MIN_COVERAGE" | bc -l) )); then
  echo "❌ 覆盖率 ${COVERAGE}% 低于阈值 ${MIN_COVERAGE}%"
  echo "请补充更多测试！"
  exit 1
else
  echo "✅ 覆盖率 ${COVERAGE}% 达标（>= ${MIN_COVERAGE}%）"
fi
