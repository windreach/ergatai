#!/bin/bash
set -e

echo "── React Doctor 性能扫描脚本 ──"
echo ""
echo "此脚本会："
echo "1. 打开 Chrome 浏览器访问 http://localhost:5173"
echo "2. 录制你的操作（点击、滚动等）15-30 秒"
echo "3. 生成性能分析报告"
echo ""
echo "⚠️  注意："
echo "- 确保已通过 ./scripts/dev.sh 启动了前后端"
echo "- 扫描的是 web 版本，但 React 性能问题与 Electron 版本相同"
echo ""

# 检查后端是否运行
if ! curl -fsS --max-time 2 http://localhost:3000/health >/dev/null 2>&1; then
  echo "❌ 后端未运行 (http://localhost:3000)"
  echo "请先运行: ./scripts/dev.sh"
  exit 1
fi

echo "✅ 后端运行正常"

# 检查前端是否运行
if ! curl -fsS --max-time 2 http://localhost:5173 >/dev/null 2>&1; then
  echo "❌ 前端未运行 (http://localhost:5173)"
  echo "请先运行: ./scripts/dev.sh"
  exit 1
fi

echo "✅ 前端运行正常"
echo ""
echo "── 开始扫描 ──"
echo ""
echo "操作说明："
echo "1. Chrome 会自动打开"
echo "2. 在浏览器中操作应用（点击、滚动、触发慢的交互）"
echo "3. 操作 15-30 秒后，回到终端按 Enter 停止录制"
echo "4. 等待分析报告生成"
echo ""

cd frontend

# 运行扫描
npx react-doctor@latest scan http://localhost:5173 --format json

echo ""
echo "── 扫描完成 ──"
echo "查看生成的 .json.gz 文件获取详细 trace 数据"
