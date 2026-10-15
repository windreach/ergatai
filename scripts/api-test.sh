#!/usr/bin/env bash
# Ergatai API 全量测试 - 主调度器
# 按顺序加载并运行 scripts/tests/*.sh 中的所有测试模块

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
cd "$PROJECT_DIR"

# 加载共享库
source "$SCRIPT_DIR/test-lib.sh"

# ============================================================================
# 主测试流程
# ============================================================================
run_all_tests() {
    init_test_framework

    echo ""
    echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo -e "${CYAN}          Ergatai API 全量测试                    ${NC}"
    echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    log_info "API URL: $API_URL"
    log_info "Mock Agent: $MOCK_AGENT_SCRIPT"
    echo ""

    # 前置检查
    check_prerequisites || true
    check_server || {
        log_error "请先启动服务器"
        exit 1
    }

    # 注册 mock agent profile（用于需要真实 agent 的测试）
    register_mock_agent_profile
    echo ""

    # 设置退出清理
    trap cleanup_all_resources EXIT

    # 按顺序加载并运行测试模块
    local test_files=("$SCRIPT_DIR"/tests/*.sh)
    local module_count=0
    local total_modules=${#test_files[@]}

    for test_file in "${test_files[@]}"; do
        if [ -f "$test_file" ]; then
            module_count=$((module_count + 1))
            source "$test_file"

            # 每个模块必须暴露 run_module_tests 函数
            if type run_module_tests &> /dev/null; then
                run_module_tests
                unset -f run_module_tests 2>/dev/null || true
            else
                log_warn "模块 $(basename "$test_file") 缺少 run_module_tests 函数"
            fi
        fi
    done

    echo ""
    log_info "运行了 $module_count 个测试模块"

    # 打印报告
    print_test_report
}

# 显示帮助
show_help() {
    cat <<EOF
Ergatai API 全量测试框架

用法: $0 [命令]

说明:
  自动注册 Mock ACP Agent 并运行所有 124 个 API 端点测试。

  前置要求:
  1. 启动 API 服务器: ./target/release/ergatai-server --port 3000
  2. 确保 Python 3 和 jq 已安装

命令:
  all         运行所有测试（默认）
  help        显示此帮助信息

环境变量:
  API_URL     API 服务器 URL（默认: http://localhost:3000）
  API_TOKEN   API 认证 token（默认自动从 ~/.local/share/ergatai/.api-token 读取）
EOF
}

# 主逻辑
case "${1:-all}" in
    all)
        run_all_tests
        ;;
    help|*)
        show_help
        ;;
esac
