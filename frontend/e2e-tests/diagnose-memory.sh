#!/bin/bash
# Electron 内存泄漏诊断脚本

echo "========================================="
echo "Electron 内存诊断"
echo "========================================="

# 1. 检查当前内存使用
echo ""
echo "1. 系统内存使用情况:"
free -h

# 2. 检查 Electron 进程
echo ""
echo "2. Electron 进程:"
ps aux | grep -i electron | grep -v grep

# 3. 检查 Node.js 进程（Playwright 也是 Node）
echo ""
echo "3. Node.js 进程:"
ps aux | grep -E "(node|playwright)" | grep -v grep

# 4. 检查僵尸进程
echo ""
echo "4. 僵尸进程:"
ps aux | awk '$8 ~ /Z/ {print}'

# 5. 统计内存占用
echo ""
echo "5. 内存占用 Top 10:"
ps aux --sort=-%mem | head -11

# 6. 清理建议
echo ""
echo "========================================="
echo "清理建议:"
echo "========================================="
echo ""
echo "如果有残留的 Electron 进程:"
echo "  pkill -9 electron"
echo ""
echo "如果有残留的 Node 进程:"
echo "  pkill -9 -f playwright"
echo ""
echo "清理临时文件:"
echo "  rm -rf /tmp/test-*"
echo ""

# 7. 自动清理（需要确认）
read -p "是否自动清理所有 Electron/Node 测试进程? (y/n): " -n 1 -r
echo
if [[ $REPLY =~ ^[Yy]$ ]]; then
    echo "清理中..."
    pkill -9 -f "electron.*e2e-tests" 2>/dev/null || true
    pkill -9 -f "playwright.*test" 2>/dev/null || true
    echo "✅ 清理完成"
fi
