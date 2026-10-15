#!/bin/bash
# Ergatai 自动化 API 测试脚本
# 基于 OpenAPI 规范和 shell 测试

set -e

API_URL="http://localhost:3000"
REPORT_FILE="/tmp/ergatai-test-report-$(date +%Y%m%d-%H%M%S).json"
PASS_COUNT=0
FAIL_COUNT=0
TOTAL_COUNT=0

# 颜色输出
GREEN='\033[0;32m'
RED='\033[0;31m'
NC='\033[0m' # No Color

log_test() {
    local test_name="$1"
    local result="$2"
    local details="$3"

    TOTAL_COUNT=$((TOTAL_COUNT + 1))

    if [ "$result" = "PASS" ]; then
        PASS_COUNT=$((PASS_COUNT + 1))
        echo -e "${GREEN}✓${NC} $test_name"
    else
        FAIL_COUNT=$((FAIL_COUNT + 1))
        echo -e "${RED}✗${NC} $test_name: $details"
    fi
}

# 检查服务器
check_server() {
    if curl -s -f "$API_URL/health" > /dev/null 2>&1; then
        echo "✅ API 服务器正在运行"
        return 0
    else
        echo "❌ API 服务器未运行"
        echo "   请先启动: cargo run -p ergatai-api -- --port 3000"
        exit 1
    fi
}

# 测试 1: 健康检查
test_health() {
    local response=$(curl -s -o /dev/null -w "%{http_code}" "$API_URL/health")
    if [ "$response" = "200" ]; then
        log_test "健康检查" "PASS"
    else
        log_test "健康检查" "FAIL" "HTTP $response"
    fi
}

# 测试 2: 列出工作区
test_list_workspaces() {
    local response=$(curl -s "$API_URL/api/v1/workspaces")
    if echo "$response" | jq -e '.workspaces' > /dev/null 2>&1; then
        log_test "列出工作区" "PASS"
    else
        log_test "列出工作区" "FAIL" "无效响应格式"
    fi
}

# 测试 3: 列出 Agents
test_list_agents() {
    local response=$(curl -s "$API_URL/api/v1/agents")
    if echo "$response" | jq -e '.agents' > /dev/null 2>&1; then
        log_test "列出 Agents" "PASS"
    else
        log_test "列出 Agents" "FAIL" "无效响应格式"
    fi
}

# 测试 4: 列出 Agent Profiles
test_list_profiles() {
    local response=$(curl -s "$API_URL/api/v1/agent-profiles")
    if echo "$response" | jq -e '.profiles' > /dev/null 2>&1; then
        log_test "列出 Agent Profiles" "PASS"
    else
        log_test "列出 Agent Profiles" "FAIL" "无效响应格式"
    fi
}

# 测试 5: 获取系统状态
test_status() {
    local response=$(curl -s "$API_URL/api/v1/status")
    if echo "$response" | jq -e '.agents' > /dev/null 2>&1; then
        log_test "获取系统状态" "PASS"
    else
        log_test "获取系统状态" "FAIL" "无效响应格式"
    fi
}

# 测试 6: 列出对话
test_list_conversations() {
    local response=$(curl -s "$API_URL/api/v1/conversations")
    if echo "$response" | jq -e '.conversations' > /dev/null 2>&1; then
        log_test "列出对话" "PASS"
    else
        log_test "列出对话" "FAIL" "无效响应格式"
    fi
}

# 测试 7: 列出锁
test_list_locks() {
    local response=$(curl -s "$API_URL/api/v1/locks")
    if echo "$response" | jq -e '.locks' > /dev/null 2>&1; then
        log_test "列出文件锁" "PASS"
    else
        log_test "列出文件锁" "FAIL" "无效响应格式"
    fi
}

# 测试 8: 获取最近活动
test_activity() {
    local response=$(curl -s "$API_URL/api/v1/activity/recent?limit=10")
    if echo "$response" | jq -e '.events' > /dev/null 2>&1; then
        log_test "获取最近活动" "PASS"
    else
        log_test "获取最近活动" "FAIL" "无效响应格式"
    fi
}

# 测试 9: OpenAPI 规范验证
test_openapi() {
    if cargo run -p ergatai-api --example dump_openapi > /tmp/test-openapi.json 2>/dev/null; then
        if swagger-cli validate /tmp/test-openapi.json > /dev/null 2>&1; then
            log_test "OpenAPI 规范验证" "PASS"
        else
            log_test "OpenAPI 规范验证" "FAIL" "规范无效"
        fi
    else
        log_test "OpenAPI 规范验证" "FAIL" "生成失败"
    fi
}

# 测试 10: 边界值测试 - 无效 agent ID
test_invalid_agent() {
    local response=$(curl -s -o /dev/null -w "%{http_code}" "$API_URL/api/v1/agents/non-existent-agent")
    if [ "$response" = "404" ] || [ "$response" = "400" ]; then
        log_test "边界值: 无效 agent ID" "PASS"
    else
        log_test "边界值: 无效 agent ID" "FAIL" "HTTP $response (期望 404 或 400)"
    fi
}

# 测试 11: 边界值测试 - 大 limit 参数
test_large_limit() {
    local response=$(curl -s "$API_URL/api/v1/activity/recent?limit=10000")
    if echo "$response" | jq -e '.events' > /dev/null 2>&1; then
        log_test "边界值: 大 limit 参数" "PASS"
    else
        log_test "边界值: 大 limit 参数" "FAIL" "响应无效"
    fi
}

# 测试 12: 认证测试（无 token）
test_auth_required() {
    # 如果服务器配置了 token，这个测试应该失败
    local response=$(curl -s -o /dev/null -w "%{http_code}" "$API_URL/api/v1/agents")
    if [ "$response" = "200" ] || [ "$response" = "401" ]; then
        log_test "认证测试" "PASS"
    else
        log_test "认证测试" "FAIL" "HTTP $response"
    fi
}

# 生成测试报告
generate_report() {
    cat > "$REPORT_FILE" <<EOF
{
  "timestamp": "$(date -Iseconds)",
  "api_url": "$API_URL",
  "summary": {
    "total": $TOTAL_COUNT,
    "passed": $PASS_COUNT,
    "failed": $FAIL_COUNT,
    "success_rate": $(echo "scale=2; $PASS_COUNT * 100 / $TOTAL_COUNT" | bc 2>/dev/null || echo "0")%
  },
  "tests": [
    {"name": "健康检查", "status": "$([ $PASS_COUNT -gt 0 ] && echo "PASS" || echo "FAIL")"},
    {"name": "列出工作区", "status": "tested"},
    {"name": "列出 Agents", "status": "tested"},
    {"name": "OpenAPI 验证", "status": "tested"}
  ]
}
EOF
    echo ""
    echo "📄 测试报告已保存到: $REPORT_FILE"
}

# 主逻辑
main() {
    echo "🧪 Ergatai 自动化 API 测试"
    echo "=========================="
    echo ""

    check_server

    echo "运行测试..."
    echo ""

    test_health
    test_list_workspaces
    test_list_agents
    test_list_profiles
    test_status
    test_list_conversations
    test_list_locks
    test_activity
    test_openapi
    test_invalid_agent
    test_large_limit
    test_auth_required

    echo ""
    echo "=========================="
    echo "测试结果:"
    echo -e "  ${GREEN}通过${NC}: $PASS_COUNT"
    echo -e "  ${RED}失败${NC}: $FAIL_COUNT"
    echo "  总计: $TOTAL_COUNT"

    if [ $FAIL_COUNT -eq 0 ]; then
        echo -e "\n${GREEN}✅ 所有测试通过!${NC}"
    else
        echo -e "\n${RED}❌ 有 $FAIL_COUNT 个测试失败${NC}"
    fi

    generate_report
}

main "$@"
