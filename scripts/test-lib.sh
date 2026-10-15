#!/usr/bin/env bash
# Ergatai API 测试共享库
# 提供 HTTP 请求、断言、资源管理等通用函数

set -e

# ============================================================================
# 颜色定义
# ============================================================================
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m'

# ============================================================================
# 全局配置
# ============================================================================
API_URL="${API_URL:-http://localhost:3000}"
if [ -z "$API_TOKEN" ] && [ -f "$HOME/.local/share/ergatai/.api-token" ]; then
    API_TOKEN=$(cat "$HOME/.local/share/ergatai/.api-token")
fi
API_TOKEN="${API_TOKEN:-}"
TEST_DIR="./test-results"
MOCK_AGENT_SCRIPT="./scripts/mock-acp-agent.py"
MOCK_PROFILE_NAME="mock-acp-agent"

# ============================================================================
# 全局计数器
# ============================================================================
TESTS_PASSED=0
TESTS_FAILED=0
TESTS_SKIPPED=0
MODULE_PASSED=0
MODULE_FAILED=0
CURRENT_MODULE=""
CURRENT_MODULE_PASSED=0
CURRENT_MODULE_FAILED=0
REPORT_FILE=""

# ============================================================================
# 资源追踪（自动清理）
# ============================================================================
_CLEANUP_WORKSPACES=()
_CLEANUP_AGENTS=()
_CLEANUP_CHATS=()
_CLEANUP_CONVERSATIONS=()
_CLEANUP_PROFILES=()

# ============================================================================
# 日志函数
# ============================================================================
log_info()    { echo -e "${BLUE}[INFO]${NC} $1"; }
log_success() { echo -e "${GREEN}[PASS]${NC} $1"; }
log_error()   { echo -e "${RED}[FAIL]${NC} $1"; }
log_warn()    { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_module()  { echo -e "${CYAN}[MODU]${NC} $1"; }

# ============================================================================
# 初始化
# ============================================================================
init_test_framework() {
    mkdir -p "$TEST_DIR"
    REPORT_FILE="$TEST_DIR/test-report-$(date +%Y%m%d-%H%M%S).json"
    echo "[]" > "$REPORT_FILE"
}

# ============================================================================
# HTTP 请求
# ============================================================================

# http_request METHOD PATH [BODY] [EXPECTED_STATUS]
# 返回 response body，通过返回值表示成功/失败
http_request() {
    local method=$1
    local endpoint=$2
    local data=${3:-}
    local expected_status=${4:-200}

    local response
    local status_code
    local body

    local curl_opts=(-s -w "\n%{http_code}" -X "$method")

    if [ -n "$API_TOKEN" ]; then
        curl_opts+=(-H "Authorization: Bearer $API_TOKEN")
    fi

    if [ -n "$data" ]; then
        response=$(curl "${curl_opts[@]}" \
            -H "Content-Type: application/json" \
            -d "$data" \
            "$API_URL$endpoint" 2>/dev/null)
    else
        response=$(curl "${curl_opts[@]}" \
            "$API_URL$endpoint" 2>/dev/null)
    fi

    status_code=$(echo "$response" | tail -n1)
    body=$(echo "$response" | sed '$d')

    if [ "$status_code" = "$expected_status" ]; then
        echo "$body"
        return 0
    else
        echo "Expected status $expected_status, got $status_code" >&2
        echo "Response: $body" >&2
        return 1
    fi
}

# http_request_raw METHOD PATH [BODY]
# 返回 status_code 和 body（不检查预期状态）
http_request_raw() {
    local method=$1
    local endpoint=$2
    local data=${3:-}

    local response
    local curl_opts=(-s -w "\n%{http_code}" -X "$method")

    if [ -n "$API_TOKEN" ]; then
        curl_opts+=(-H "Authorization: Bearer $API_TOKEN")
    fi

    if [ -n "$data" ]; then
        response=$(curl "${curl_opts[@]}" \
            -H "Content-Type: application/json" \
            -d "$data" \
            "$API_URL$endpoint" 2>/dev/null)
    else
        response=$(curl "${curl_opts[@]}" \
            "$API_URL$endpoint" 2>/dev/null)
    fi

    local status_code=$(echo "$response" | tail -n1)
    local body=$(echo "$response" | sed '$d')

    # 输出 status_code 和 body（用特殊分隔符）
    echo "$status_code"
    echo "$body"
}

# SSE 流测试（带超时）
http_sse_test() {
    local endpoint=$1
    local timeout_secs=${2:-3}

    local body
    body=$(timeout "$timeout_secs" curl -s -N \
        -H "Authorization: Bearer $API_TOKEN" \
        "$API_URL$endpoint" 2>/dev/null || true)

    if [ -n "$body" ]; then
        echo "$body"
        return 0
    else
        return 1
    fi
}

# ============================================================================
# 测试运行器
# ============================================================================

# run_test "测试名" test_func [args...]
run_test() {
    local test_name=$1
    shift
    local test_func=$1
    shift

    if [ -n "$CURRENT_MODULE" ]; then
        log_info "  测试: $test_name"
    else
        log_info "运行测试: $test_name"
    fi

    if $test_func "$@"; then
        log_success "$test_name"
        TESTS_PASSED=$((TESTS_PASSED + 1))
        CURRENT_MODULE_PASSED=$((CURRENT_MODULE_PASSED + 1))
        _add_test_result "$test_name" "passed"
    else
        log_error "$test_name"
        TESTS_FAILED=$((TESTS_FAILED + 1))
        CURRENT_MODULE_FAILED=$((CURRENT_MODULE_FAILED + 1))
        _add_test_result "$test_name" "failed"
    fi
}

# skip_test "测试名" "原因"
skip_test() {
    local test_name=$1
    local reason=${2:-"未实现"}

    log_warn "跳过: $test_name ($reason)"
    TESTS_SKIPPED=$((TESTS_SKIPPED + 1))
    _add_test_result "$test_name" "skipped"
}

_add_test_result() {
    local test_name=$1
    local status=$2
    local timestamp=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
    local module="${CURRENT_MODULE:-unknown}"

    if command -v jq &> /dev/null; then
        local temp_file=$(mktemp)
        jq --arg name "$test_name" \
           --arg status "$status" \
           --arg time "$timestamp" \
           --arg module "$module" \
           '. += [{"name": $name, "status": $status, "timestamp": $time, "module": $module}]' \
           "$REPORT_FILE" > "$temp_file" && mv "$temp_file" "$REPORT_FILE"
    fi
}

# ============================================================================
# 模块管理
# ============================================================================

# start_module "模块名"
start_module() {
    CURRENT_MODULE=$1
    CURRENT_MODULE_PASSED=0
    CURRENT_MODULE_FAILED=0
    echo ""
    log_module "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    log_module "模块: $CURRENT_MODULE"
    log_module "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
}

# end_module
end_module() {
    local total=$((CURRENT_MODULE_PASSED + CURRENT_MODULE_FAILED))
    if [ $CURRENT_MODULE_FAILED -eq 0 ]; then
        log_module "模块结果: $CURRENT_MODULE_PASSED/$total 通过 ✅"
    else
        log_module "模块结果: $CURRENT_MODULE_PASSED/$total 通过 ❌ ($CURRENT_MODULE_FAILED 失败)"
    fi
    CURRENT_MODULE=""
}

# ============================================================================
# 断言辅助
# ============================================================================

# assert_json_field BODY FIELD EXPECTED_VALUE
assert_json_field() {
    local body=$1
    local field=$2
    local expected=$3

    local actual
    actual=$(echo "$body" | jq -r "$field" 2>/dev/null)

    if [ "$actual" = "$expected" ]; then
        return 0
    else
        echo "  断言失败: $field 期望 '$expected', 实际 '$actual'" >&2
        return 1
    fi
}

# assert_json_not_null BODY FIELD
assert_json_not_null() {
    local body=$1
    local field=$2

    local actual
    actual=$(echo "$body" | jq -r "$field" 2>/dev/null)

    if [ -n "$actual" ] && [ "$actual" != "null" ]; then
        return 0
    else
        echo "  断言失败: $field 不应为空/null" >&2
        return 1
    fi
}

# assert_json_is_array BODY FIELD
assert_json_is_array() {
    local body=$1
    local field=$2

    local type
    type=$(echo "$body" | jq -r "$field | type" 2>/dev/null)

    if [ "$type" = "array" ]; then
        return 0
    else
        echo "  断言失败: $field 期望 array, 实际 $type" >&2
        return 1
    fi
}

# assert_array_length BODY FIELD MIN_LENGTH
assert_array_length() {
    local body=$1
    local field=$2
    local min_length=$3

    local length
    length=$(echo "$body" | jq -r "$field | length" 2>/dev/null)

    if [ "$length" -ge "$min_length" ] 2>/dev/null; then
        return 0
    else
        echo "  断言失败: $field 长度期望 >= $min_length, 实际 $length" >&2
        return 1
    fi
}

# assert_status_code METHOD PATH EXPECTED [BODY]
assert_status_code() {
    local method=$1
    local endpoint=$2
    local expected=$3
    local data=${4:-}

    local response
    local curl_opts=(-s -o /dev/null -w "%{http_code}" -X "$method")

    if [ -n "$API_TOKEN" ]; then
        curl_opts+=(-H "Authorization: Bearer $API_TOKEN")
    fi

    if [ -n "$data" ]; then
        response=$(curl "${curl_opts[@]}" \
            -H "Content-Type: application/json" \
            -d "$data" \
            "$API_URL$endpoint" 2>/dev/null)
    else
        response=$(curl "${curl_opts[@]}" \
            "$API_URL$endpoint" 2>/dev/null)
    fi

    if [ "$response" = "$expected" ]; then
        return 0
    else
        echo "  状态码断言失败: $method $endpoint 期望 $expected, 实际 $response" >&2
        return 1
    fi
}

# ============================================================================
# 资源管理（自动清理）
# ============================================================================

# setup_test_workspace [WORK_DIR]
# 设置测试 workspace，返回 workspace_id（格式化的 ID）
# 自动注册清理
setup_test_workspace() {
    local work_dir=${1:-"/tmp/ergatai-test-$$-$(date +%s)"}
    mkdir -p "$work_dir"

    local create_data=$(cat <<EOF
{
    "work_dir": "$work_dir"
}
EOF
)

    local body
    body=$(http_request POST "/api/v1/workspaces" "$create_data" 201) || {
        rm -rf "$work_dir"
        return 1
    }

    local ws_id=$(echo "$body" | jq -r '.id')
    if [ -z "$ws_id" ] || [ "$ws_id" = "null" ]; then
        rm -rf "$work_dir"
        return 1
    fi

    _CLEANUP_WORKSPACES+=("$ws_id|$work_dir")
    echo "$ws_id"
}

# cleanup_test_workspace WS_ID
cleanup_test_workspace() {
    local ws_id=$1
    http_request DELETE "/api/v1/workspaces/$ws_id" "" 204 > /dev/null 2>&1 || true

    # 清理本地目录
    for entry in "${_CLEANUP_WORKSPACES[@]}"; do
        local id="${entry%%|*}"
        local dir="${entry##*|}"
        if [ "$id" = "$ws_id" ]; then
            rm -rf "$dir" 2>/dev/null || true
        fi
    done
}

# setup_test_chat WS_ID
setup_test_chat() {
    local ws_id=$1
    local chat_name="test-chat-$(date +%s)"

    local create_data=$(cat <<EOF
{
    "name": "$chat_name",
    "workspace_id": "$ws_id"
}
EOF
)

    local body
    body=$(http_request POST "/api/v1/chats" "$create_data" 201) || return 1

    local chat_id=$(echo "$body" | jq -r '.id // .chat_id')
    if [ -z "$chat_id" ] || [ "$chat_id" = "null" ]; then
        return 1
    fi

    _CLEANUP_CHATS+=("$chat_id")
    echo "$chat_id"
}

# setup_test_conversation [CHAT_ID]
setup_test_conversation() {
    local chat_id=${1:-}

    local create_data="{}"
    if [ -n "$chat_id" ]; then
        create_data=$(cat <<EOF
{
    "chat_id": "$chat_id"
}
EOF
)
    fi

    local body
    body=$(http_request POST "/api/v1/conversations" "$create_data" 201) || return 1

    local conv_id=$(echo "$body" | jq -r '.id // .conversation_id')
    if [ -z "$conv_id" ] || [ "$conv_id" = "null" ]; then
        return 1
    fi

    _CLEANUP_CONVERSATIONS+=("$conv_id")
    echo "$conv_id"
}

# setup_test_agent WS_ID [AGENT_NAME]
setup_test_agent() {
    local ws_id=$1
    local agent_name=${2:-"test-agent-$(date +%s)"}

    local spawn_data=$(cat <<EOF
{
    "workspace_id": "$ws_id",
    "agent_name": "$agent_name",
    "command": "$MOCK_PROFILE_NAME"
}
EOF
)

    local body
    body=$(http_request POST "/api/v1/agents" "$spawn_data" 201) || return 1

    local agent_id=$(echo "$body" | jq -r '.agent_id')
    if [ -z "$agent_id" ] || [ "$agent_id" = "null" ]; then
        return 1
    fi

    _CLEANUP_AGENTS+=("$agent_id")
    echo "$agent_id"
}

# cleanup_test_agent AGENT_ID
cleanup_test_agent() {
    local agent_id=$1
    http_request DELETE "/api/v1/agents/$agent_id" "" 204 > /dev/null 2>&1 || true
}

# cleanup_all_resources - 清理所有注册的资源
cleanup_all_resources() {
    log_info "清理测试资源..."

    for agent_id in "${_CLEANUP_AGENTS[@]}"; do
        http_request DELETE "/api/v1/agents/$agent_id" "" 204 > /dev/null 2>&1 || true
    done

    for entry in "${_CLEANUP_WORKSPACES[@]}"; do
        local id="${entry%%|*}"
        local dir="${entry##*|}"
        http_request DELETE "/api/v1/workspaces/$id" "" 204 > /dev/null 2>&1 || true
        rm -rf "$dir" 2>/dev/null || true
    done

    for chat_id in "${_CLEANUP_CHATS[@]}"; do
        http_request DELETE "/api/v1/chats/$chat_id" "" 204 > /dev/null 2>&1 || true
    done

    for conv_id in "${_CLEANUP_CONVERSATIONS[@]}"; do
        http_request DELETE "/api/v1/conversations/$conv_id" "" 204 > /dev/null 2>&1 || true
    done

    for profile_name in "${_CLEANUP_PROFILES[@]}"; do
        http_request DELETE "/api/v1/agent-profiles/$profile_name" "" 204 > /dev/null 2>&1 || true
    done
}

# ============================================================================
# Mock Agent Profile 注册
# ============================================================================
register_mock_agent_profile() {
    log_info "注册 Mock ACP Agent Profile..."

    local abs_script_path
    abs_script_path=$(realpath "$MOCK_AGENT_SCRIPT" 2>/dev/null || echo "$MOCK_AGENT_SCRIPT")

    local profile_data=$(cat <<EOF
{
    "name": "$MOCK_PROFILE_NAME",
    "command": "python3 $abs_script_path {agent_name}",
    "instruction": "You are a mock ACP agent for testing.",
    "agent_type": "acp",
    "env_overrides": {}
}
EOF
)

    local response
    local curl_opts=(-s -w "\n%{http_code}" -X POST -H "Content-Type: application/json")

    if [ -n "$API_TOKEN" ]; then
        curl_opts+=(-H "Authorization: Bearer $API_TOKEN")
    fi

    response=$(curl "${curl_opts[@]}" \
        -d "$profile_data" \
        "$API_URL/api/v1/agent-profiles" 2>/dev/null)

    local status_code=$(echo "$response" | tail -n1)

    if [ "$status_code" = "201" ] || [ "$status_code" = "200" ]; then
        log_success "Mock Agent Profile 注册成功"
        return 0
    else
        log_warn "Profile 注册可能已存在: $status_code"
        return 0
    fi
}

# ============================================================================
# 前置条件检查
# ============================================================================
check_prerequisites() {
    local has_error=0

    if ! command -v python3 &> /dev/null; then
        log_error "需要 Python 3"
        has_error=1
    fi

    if ! command -v jq &> /dev/null; then
        log_error "需要 jq"
        has_error=1
    fi

    if ! command -v curl &> /dev/null; then
        log_error "需要 curl"
        has_error=1
    fi

    if [ ! -f "$MOCK_AGENT_SCRIPT" ]; then
        log_warn "Mock agent 脚本不存在: $MOCK_AGENT_SCRIPT (agent 测试将跳过)"
    fi

    return $has_error
}

check_server() {
    if ! curl -s -f "$API_URL/health" > /dev/null 2>&1; then
        log_error "API 服务器未运行或无法访问: $API_URL"
        return 1
    fi
    log_success "API 服务器连接成功 ($API_URL)"
    return 0
}

# ============================================================================
# 报告打印
# ============================================================================
print_test_report() {
    echo ""
    echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo -e "${CYAN}                  测试报告                        ${NC}"
    echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo ""
    log_info "通过: $TESTS_PASSED"
    log_info "失败: $TESTS_FAILED"
    log_info "跳过: $TESTS_SKIPPED"
    log_info "总计: $((TESTS_PASSED + TESTS_FAILED + TESTS_SKIPPED))"
    echo ""
    log_info "详细报告: $REPORT_FILE"
    echo ""

    if [ $TESTS_FAILED -eq 0 ]; then
        log_success "所有测试通过！"
        return 0
    else
        log_error "有 $TESTS_FAILED 个测试失败"
        return 1
    fi
}
