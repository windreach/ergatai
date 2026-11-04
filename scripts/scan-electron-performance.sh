#!/bin/bash
set -e

echo "── Electron 性能扫描脚本 ──"
echo ""
echo "此脚本会："
echo "1. 重启 Electron 应用（带远程调试端口）"
echo "2. 使用 React Doctor 连接 Electron 内置浏览器"
echo "3. 录制操作并生成性能报告"
echo ""
echo "⚠️  注意：会先关闭当前运行的 Electron 应用"
echo ""

# 检查后端是否运行
if ! curl -fsS --max-time 2 http://localhost:3000/health >/dev/null 2>&1; then
  echo "❌ 后端未运行 (http://localhost:3000)"
  echo "请先运行: ./scripts/dev.sh"
  exit 1
fi

echo "✅ 后端运行正常"
echo ""

# 关闭当前 Electron 进程
echo "── 关闭当前 Electron 应用 ──"
pkill -f "electron.*ergatai" || true
sleep 2

echo "── 启动 Electron（带远程调试） ──"
cd frontend

# 启动 Electron 带远程调试端口
REMOTE_DEBUGGING_PORT=9222
nohup node_modules/electron/dist/electron . --remote-debugging-port=$REMOTE_DEBUGGING_PORT > /tmp/electron-debug.log 2>&1 &
ELECTRON_PID=$!

echo "等待 Electron 启动..."
sleep 3

# 检查是否成功启动
if ! kill -0 $ELECTRON_PID 2>/dev/null; then
  echo "❌ Electron 启动失败"
  exit 1
fi

echo "✅ Electron 已启动（PID: $ELECTRON_PID，调试端口: $REMOTE_DEBUGGING_PORT）"
echo ""
echo "── 开始扫描 ──"
echo ""
echo "操作说明："
echo "1. Electron 应用窗口会打开"
echo "2. 在应用中操作（点击、滚动、触发慢的交互）"
echo "3. 操作 15-30 秒后，回到终端按 Enter 停止录制"
echo "4. 等待分析报告生成"
echo ""
read -p "按 Enter 继续..."

# 使用 React Doctor 连接 Electron
npx react-doctor@latest scan --cdp http://localhost:$REMOTE_DEBUGGING_PORT --format json

echo ""
echo "── 扫描完成 ──"
echo "查看生成的 .json.gz 文件获取详细 trace 数据"
echo ""
echo "提示：下次启动可以直接运行："
echo "  cd frontend && node_modules/electron/dist/electron . --remote-debugging-port=9222"
