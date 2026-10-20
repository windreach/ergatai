#!/bin/bash
# UI 测试启动脚本
# 启动后端、Xvfb 虚拟显示，然后运行 Playwright Electron 测试

set -e  # 遇到错误立即退出

# 颜色输出
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# 日志函数
log_info() {
    echo -e "${GREEN}[INFO]${NC} $1"
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] INFO: $1" >> "$LOG_DIR/test.log"
}

log_warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] WARN: $1" >> "$LOG_DIR/test.log"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] ERROR: $1" >> "$LOG_DIR/test.log"
}

# 清理函数
cleanup() {
    log_info "清理资源..."

    # 停止后端
    if [ -f "$TMP_DIR/backend.pid" ]; then
        BACKEND_PID=$(cat "$TMP_DIR/backend.pid")
        if kill -0 "$BACKEND_PID" 2>/dev/null; then
            log_info "停止后端服务 (PID: $BACKEND_PID)"
            kill "$BACKEND_PID" 2>/dev/null || true
            sleep 1
            kill -9 "$BACKEND_PID" 2>/dev/null || true
        fi
        rm -f "$TMP_DIR/backend.pid"
    fi

    log_info "清理完成"
}

# 设置 trap，确保退出时清理
trap cleanup EXIT

# 项目根目录
PROJECT_ROOT="/root/ergatai"
FRONTEND_DIR="$PROJECT_ROOT/frontend"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG_DIR="$SCRIPT_DIR/logs"
TMP_DIR="$SCRIPT_DIR/tmp"
REPORTS_DIR="$SCRIPT_DIR/reports"

# 创建目录
mkdir -p "$LOG_DIR" "$TMP_DIR" "$REPORTS_DIR"

# 清空日志
> "$LOG_DIR/test.log"

log_info "========================================="
log_info "UI 测试启动脚本"
log_info "========================================="

# 检查后端是否已经在运行
if curl -s http://127.0.0.1:3000/health &> /dev/null; then
    log_warn "后端服务已在运行，跳过启动"
else
    # 启动后端
    log_info "启动后端服务..."
    cd "$PROJECT_ROOT"
    cargo run -p ergatai-api -- --port 3000 > "$LOG_DIR/backend.log" 2>&1 &
    BACKEND_PID=$!
    echo "$BACKEND_PID" > "$TMP_DIR/backend.pid"
    log_info "后端服务已启动 (PID: $BACKEND_PID)"

    # 等待后端就绪
    log_info "等待后端服务就绪..."
    MAX_WAIT=60
    WAITED=0
    while ! curl -s http://127.0.0.1:3000/health &> /dev/null; do
        sleep 1
        WAITED=$((WAITED + 1))
        if [ $WAITED -ge $MAX_WAIT ]; then
            log_error "后端服务启动超时（${MAX_WAIT}秒）"
            log_error "查看日志：$LOG_DIR/backend.log"
            exit 1
        fi
        if [ $((WAITED % 5)) -eq 0 ]; then
            log_info "已等待 ${WAITED}秒..."
        fi
    done
    log_info "后端服务已就绪"
fi

# 运行 Electron 测试（headless 模式，无需 xvfb）
log_info "========================================="
log_info "运行 Electron 测试 (Headless 模式)..."
log_info "========================================="
cd "$FRONTEND_DIR"
node e2e-tests/tests/agent/agent-registration-electron.js 2>&1 | tee "$LOG_DIR/node-test-output.log"
TEST_EXIT_CODE=${PIPESTATUS[0]}

log_info "========================================="
if [ $TEST_EXIT_CODE -eq 0 ]; then
    log_info "测试完成 ✅"
else
    log_error "测试失败 ❌ (退出码：$TEST_EXIT_CODE)"
fi
log_info "========================================="
log_info "日志文件:"
log_info "  - 测试日志：$LOG_DIR/test.log"
log_info "  - 后端日志：$LOG_DIR/backend.log"
log_info "  - 测试输出：$LOG_DIR/node-test-output.log"
log_info "  - 截图报告：$REPORTS_DIR/"
log_info "========================================="

exit $TEST_EXIT_CODE
