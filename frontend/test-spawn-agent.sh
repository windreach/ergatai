#!/usr/bin/env bash
# 测试 spawn agent 的各种场景

API_URL="http://127.0.0.1:3000"
TOKEN=$(cat ~/.ergatai/.api-token)

echo "=== 测试 1: 使用有效的 conversation_id ==="
curl -s -X POST "$API_URL/api/v1/agents" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{
    "conversation_id": "chat_be18c3a2bc4b40358d69ad74d4b2c526",
    "command": "claude-code"
  }' | python3 -m json.tool

echo ""
echo "=== 测试 2: 使用不存在的 conversation_id ==="
curl -s -X POST "$API_URL/api/v1/agents" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{
    "conversation_id": "non-existent-conv-id",
    "command": "claude-code"
  }' | python3 -m json.tool

echo ""
echo "=== 测试 3: 使用 workspace_id（不传 conversation_id）==="
curl -s -X POST "$API_URL/api/v1/agents" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{
    "workspace_id": "c76eca73-327f-4995-8b83-e1b6a76c484c",
    "command": "claude-code"
  }' | python3 -m json.tool

echo ""
echo "=== 测试 4: 两者都不传（应该失败）==="
curl -s -X POST "$API_URL/api/v1/agents" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{
    "command": "claude-code"
  }' | python3 -m json.tool

echo ""
echo "=== 列出当前所有 conversations ==="
curl -s "$API_URL/api/v1/workspaces/c76eca73-327f-4995-8b83-e1b6a76c484c/conversations" \
  -H "Authorization: Bearer $TOKEN" | python3 -c "
import sys, json
data = json.load(sys.stdin)
for conv in data:
    print(f\"ID: {conv['id']}, Name: {conv['name']}, Mode: {conv['mode']}\")
"
