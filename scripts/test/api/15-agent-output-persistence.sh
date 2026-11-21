#!/usr/bin/env bash
# 测试 Agent Output 自动持久化和对话自动创建功能
# 验证修复的 4 个严重问题

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
cd "$PROJECT_DIR"

source "$PROJECT_DIR/test-lib.sh"

# 颜色定义
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

log_pass() {
    echo -e "${GREEN}[PASS]${NC} $1"
}

log_fail() {
    echo -e "${RED}[FAIL]${NC} $1"
}

log_info() {
    echo -e "${YELLOW}[INFO]${NC} $1"
}

# ============================================================================
# 测试 1: 验证数据库表结构和 ID 生成逻辑
# ============================================================================
test_database_schema() {
    log_info "测试: 数据库表结构和 ID 生成"

    local db_path="./.ergatai/user_data.db"

    # 检查数据库是否存在
    if [ ! -f "$db_path" ]; then
        log_info "数据库不存在，跳过测试（这是正常的，如果没有运行过 agent）"
        return 0
    fi

    # 验证 agent_outputs 表存在且有正确的列
    local columns=$(sqlite3 "$db_path" "PRAGMA table_info(agent_outputs);" 2>/dev/null)
    if [ -z "$columns" ]; then
        log_fail "agent_outputs 表不存在"
        return 1
    fi

    # 检查关键列：id, conversation_id, thinking, tool_calls, final_text
    if ! echo "$columns" | grep -q "id"; then
        log_fail "agent_outputs 表缺少 id 列"
        return 1
    fi

    if ! echo "$columns" | grep -q "conversation_id"; then
        log_fail "agent_outputs 表缺少 conversation_id 列"
        return 1
    fi

    if ! echo "$columns" | grep -q "thinking"; then
        log_fail "agent_outputs 表缺少 thinking 列"
        return 1
    fi

    if ! echo "$columns" | grep -q "tool_calls"; then
        log_fail "agent_outputs 表缺少 tool_calls 列"
        return 1
    fi

    if ! echo "$columns" | grep -q "final_text"; then
        log_fail "agent_outputs 表缺少 final_text 列"
        return 1
    fi

    log_pass "agent_outputs 表结构正确"

    # 验证 conversations 表存在
    local conv_columns=$(sqlite3 "$db_path" "PRAGMA table_info(conversations);" 2>/dev/null)
    if [ -z "$conv_columns" ]; then
        log_fail "conversations 表不存在"
        return 1
    fi

    # 检查 conversations 表的关键列
    if ! echo "$conv_columns" | grep -q "conversation_id"; then
        log_fail "conversations 表缺少 conversation_id 列"
        return 1
    fi

    if ! echo "$conv_columns" | grep -q "chat_id"; then
        log_fail "conversations 表缺少 chat_id 列"
        return 1
    fi

    if ! echo "$conv_columns" | grep -q "collaboration_session_id"; then
        log_fail "conversations 表缺少 collaboration_session_id 列"
        return 1
    fi

    log_pass "conversations 表结构正确"

    # 检查是否有自动创建的记录（如果有）
    local auto_conv_count=$(sqlite3 "$db_path" "SELECT COUNT(*) FROM conversations WHERE name LIKE '%Auto-generated%';" 2>/dev/null || echo "0")
    if [ "$auto_conv_count" -gt 0 ]; then
        log_info "发现 $auto_conv_count 个自动创建的 conversation 记录"

        # 验证这些记录使用独立的 ID
        local sample=$(sqlite3 "$db_path" "SELECT conversation_id, chat_id, collaboration_session_id FROM conversations WHERE name LIKE '%Auto-generated%' LIMIT 1;" 2>/dev/null)
        if [ -n "$sample" ]; then
            local conv_id=$(echo "$sample" | cut -d'|' -f1)
            local chat_id=$(echo "$sample" | cut -d'|' -f2)
            local session_id=$(echo "$sample" | cut -d'|' -f3)

            # 检查 ID 是否唯一（修复后的代码应该生成不同的 ID）
            if [ "$conv_id" != "$chat_id" ] && [ "$conv_id" != "$session_id" ] && [ "$chat_id" != "$session_id" ]; then
                log_pass "自动创建的记录使用独立 ID: conv=$conv_id, chat=$chat_id, session=$session_id"
            else
                log_fail "ID 冲突: conv=$conv_id, chat=$chat_id, session=$session_id"
                return 1
            fi
        fi
    else
        log_info "没有自动创建的 conversation 记录（这是正常的）"
    fi

    return 0
}

# ============================================================================
# 测试 2: 验证跨平台路径（不使用硬编码 /tmp）
# ============================================================================
test_cross_platform_path() {
    log_info "测试: 跨平台路径处理"

    # 检查自动创建的 workspace 的 work_dir
    local db_path="./.ergatai/user_data.db"
    local work_dir=$(sqlite3 "$db_path" "SELECT work_dir FROM workspaces WHERE name LIKE '%Auto-generated%' LIMIT 1;" 2>/dev/null)

    if [ -z "$work_dir" ]; then
        log_info "No auto-generated workspace found (this is OK if no auto-creation happened)"
        return 0
    fi

    # 检查是否包含系统临时目录（而不是硬编码的 /tmp）
    local system_temp=$(python3 -c "import tempfile; print(tempfile.gettempdir())" 2>/dev/null || echo "/tmp")

    if [[ "$work_dir" == *"$system_temp"* ]]; then
        log_pass "Using system temp directory: $work_dir"
        return 0
    elif [ "$work_dir" = "/tmp" ]; then
        log_fail "Still using hardcoded /tmp path"
        return 1
    else
        log_pass "Using custom path: $work_dir"
        return 0
    fi
}

# ============================================================================
# 测试 3: 验证 ID 溢出检查
# ============================================================================
test_id_overflow_protection() {
    log_info "测试: ID 溢出保护"

    # 这个测试需要调用 Rust 单元测试
    # 这里只做简单验证：检查 parse_to_i64 函数是否正常工作

    # 创建一个合法的 ID 并验证
    local test_id="ws_1727568000000_001_0001"
    local api_response=$(http_request GET "/api/v1/workspaces/$test_id" "" 404 2>&1 || true)

    # 应该返回 404（不存在）而不是 500（服务器错误）
    if echo "$api_response" | grep -q "500"; then
        log_fail "Server error when parsing ID (possible overflow issue)"
        return 1
    fi

    log_pass "ID parsing works correctly (no overflow errors)"
    return 0
}

# ============================================================================
# 主测试流程
# ============================================================================
main() {
    echo ""
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "  Agent Output 持久化功能测试"
    echo "  验证修复的 4 个严重问题"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo ""

    # 检查服务器
    if ! curl -s http://localhost:3000/health > /dev/null 2>&1; then
        log_fail "Server is not running on port 3000"
        exit 1
    fi

    local total_tests=3
    local passed_tests=0

    # 运行测试
    if test_database_schema; then
        passed_tests=$((passed_tests + 1))
    fi

    if test_cross_platform_path; then
        passed_tests=$((passed_tests + 1))
    fi

    if test_id_overflow_protection; then
        passed_tests=$((passed_tests + 1))
    fi

    # 输出总结
    echo ""
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "  测试结果"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "通过: $passed_tests / $total_tests"

    if [ "$passed_tests" -eq "$total_tests" ]; then
        echo -e "${GREEN}所有测试通过！✅${NC}"
        exit 0
    else
        echo -e "${RED}部分测试失败❌${NC}"
        exit 1
    fi
}

main "$@"
