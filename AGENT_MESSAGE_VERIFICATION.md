# Agent 消息存储验证报告

## 1. Agent 回复消息是否存储 ✅ 已实现

**位置**: `crates/ergatai-api/src/api/agents.rs:3446`

当 agent 完成响应（Done event）时，消息会被存储到 `messages` 表：

```rust
// stream_agent_output 函数中
if is_done {
    if let Some(ref cid) = conv_id {
        if !acc_text.is_empty() {
            let mut parts = vec![];
            if !thinking_to_persist.trim().is_empty() {
                parts.push(serde_json::json!({
                    "type": "reasoning",
                    "text": thinking_to_persist,
                }));
            }
            parts.push(serde_json::json!({
                "type": "text",
                "text": text_to_persist,
            }));
            let metadata = serde_json::json!({
                "source": "agent",
            });
            crate::user_data_db::messages::append(
                &cid_clone,
                "assistant",  // ← role 是 "assistant"
                serde_json::Value::Array(parts),
                metadata,
            )
        }
    }
}
```

**问题**: metadata 只包含 `{"source": "agent"}`，缺少以下字段：
- `messageType`: 未设置（应该是 "response" 或其他类型）
- `senderAgentId`: 未设置
- `senderAgentName`: 未设置

这会导致前端无法正确识别消息来源和类型。

---

## 2. Agent-to-Agent 消息存储 ✅ 已实现，但有角色验证问题

**位置**: `crates/ergatai-api/src/messaging/mod.rs:508, 594`

当 agent 之间发送消息时：

```rust
// MessageSender.send 函数中
let role = agent_message_role(&message_type);
let metadata = serde_json::json!({
    "source": "agent",
    "senderAgentId": from,
    "senderAgentName": sender_name,
    "messageType": message_type,
});
let mut parts = vec![];
if let Some(thinking) = recent_thinking {
    parts.push(serde_json::json!({
        "type": "reasoning",
        "text": thinking,
    }));
}
parts.push(serde_json::json!({ "type": "text", "text": message }));
user_data_db::messages::append(
    &conversation_id,
    role,  // ← "agent" 或 "assistant" 取决于 message_type
    serde_json::Value::Array(parts),
    metadata,
)
```

**agent_message_role 映射** (messaging/mod.rs:1240):
- `"request"` → `"agent"` (开启新对话组)
- `"response" | "broadcast"` → `"assistant"` (追加到当前组)
- 其他 → `"agent"`

### 🐛 问题 1: API 角色验证不完整

**位置**: `crates/ergatai-api/src/api/user_conversations.rs:1270`

```rust
// Validate role against allowed values
if !matches!(request.role.as_str(), "user" | "assistant" | "system") {
    return (
        StatusCode::BAD_REQUEST,
        Json(ErrorResponse {
            error: "Role must be one of: user, assistant, system".to_string(),
        }),
    )
        .into_response();
}
```

**问题**: 验证只允许 `"user" | "assistant" | "system"`，但根据 CLAUDE.md 规范和 `agent_message_role` 函数，还应该支持 `"agent"` 角色。

**影响**: 
- 通过 REST API (`POST /api/v1/conversations/{id}/messages`) 无法创建 `role="agent"` 的消息
- 前端无法区分"人类用户输入"和"agent 发起的请求"

**修复方案**:
```rust
if !matches!(request.role.as_str(), "user" | "agent" | "assistant" | "system") {
    // ...
}
```

---

## 3. 消息的 metadata 字段 ⚠️ 部分缺失

### ✅ Agent-to-Agent 消息 (正确)

```json
{
  "source": "agent",
  "senderAgentId": "ws1-agent-1",
  "senderAgentName": "Coder",
  "messageType": "request"  // 或 "response", "broadcast"
}
```

### ❌ Agent 普通回复 (不完整)

当前 metadata:
```json
{
  "source": "agent"
}
```

**缺失字段**:
- `messageType`: 应该设置为 `"response"` 或类似值
- `senderAgentId`: agent 的 ID
- `senderAgentName`: agent 的显示名称

**影响**: 前端无法：
1. 区分不同类型的 agent 回复
2. 显示发送者信息
3. 根据 messageType 应用不同样式

**修复方案**: 在 `stream_agent_output` 函数中补充 metadata:

```rust
let metadata = serde_json::json!({
    "source": "agent",
    "messageType": "response",
    "senderAgentId": agent_id,  // 需要从上下文中获取
    "senderAgentName": agent_name,  // 需要从上下文中获取
});
```

---

## 4. 消息的 parts 格式 ✅ 正确

**格式**: JSON 数组，包含多个 part 对象

### 标准结构

```json
[
  { "type": "reasoning", "text": "Thinking process..." },
  { "type": "text", "text": "Actual response..." },
  { "type": "tool_call_start", "id": "call_1", "name": "Edit" },
  { "type": "tool_call_input", "id": "call_1", "delta": "{\"file_path\": ..." },
  { "type": "tool_call_complete", "id": "call_1", "output": "..." }
]
```

### ✅ 验证通过

1. **parts 是数组**: 所有存储代码都使用 `serde_json::Value::Array(parts)`
2. **每个 part 都有 type 字段**: reasoning, text, tool_call_* 等
3. **前端兼容性**: `parts_text` 函数正确提取 text 类型的 part

---

## 5. Agent Bindings 查询 ✅ 需验证

**位置**: `crates/ergatai-runtime/src/runtime.rs`

Agent bindings 用于将 MCP 连接或 ACP workspace 映射到 conversation ID。

### 关键函数

- `insert_mcp_binding`: 绑定 MCP peer → conversation
- `insert_agent_with_stable_id`: 绑定 ACP agent → conversation

### 需要验证的点

1. **binding 是否正确创建**: 当 agent 启动或 MCP 连接时
2. **conversation_id 是否正确**: 绑定到正确的对话
3. **查询是否正确**: `GET /api/v1/chats/{chatId}/agent-binding` 返回正确数据

**建议**: 添加 API 端点或日志来验证 binding 状态。

---

## 6. 消息创建流程总结

### 流程 1: Agent 普通回复 (用户 prompt → agent 响应)

```
用户发送 prompt
  ↓
POST /api/v1/agents/{id}/prompt
  ↓
stream_agent_output 监听 AgentOutputEvent
  ↓
收到 Done event
  ↓
创建 parts: [reasoning?, text]
  ↓
创建 metadata: {"source": "agent"}  ← 不完整
  ↓
user_data_db::messages::append(conv_id, "assistant", parts, metadata)
  ↓
消息存储到 messages 表
```

**问题**: metadata 缺少 messageType, senderAgentId, senderAgentName

### 流程 2: Agent-to-Agent 消息

```
Agent A 调用 send_message tool
  ↓
MessageSender.send() 执行
  ↓
速率限制 + 对话防护 + MeshPolicy 检查
  ↓
发布到 NATS JetStream
  ↓
Message Delivery Consumer 拉取消息
  ↓
inject_message 到 Agent B
  ↓
存储消息到 Agent B 的 conversation
  ↓
user_data_db::messages::append(conv_id, role, parts, metadata)
  - role = agent_message_role(message_type)
  - metadata = {source, senderAgentId, senderAgentName, messageType}
```

**状态**: ✅ 正确实现，但受 API 角色验证问题影响

---

## 🎯 修复优先级

### 高优先级 (P0)

1. **修复角色验证** (user_conversations.rs:1270)
   - 添加 "agent" 到允许的角色列表
   - 影响：REST API 无法创建 agent 发起的消息

2. **补充 agent 回复的 metadata** (agents.rs:3446)
   - 添加 messageType, senderAgentId, senderAgentName
   - 影响：前端无法正确显示和样式化 agent 回复

### 中优先级 (P1)

3. **验证 agent bindings**
   - 添加 API 或日志验证 binding 状态
   - 确保 conversation_id 正确映射

### 低优先级 (P2)

4. **添加消息存储测试**
   - 单元测试：验证 metadata 和 parts 格式
   - 集成测试：验证端到端消息流程

---

## 📋 验证清单

使用以下 API 调用来验证消息存储：

### 1. 检查 agent 回复消息

```bash
# 获取 conversation 消息列表
curl -H "Authorization: Bearer $TOKEN" \
  http://localhost:3000/api/v1/conversations/{conversationId}/messages

# 期望：
# - role="assistant" 的消息存在
# - metadata 包含 source="agent"
# - parts 是 JSON 数组，包含 text 类型的对象
```

### 2. 检查 agent-to-agent 消息

```bash
# 检查 metadata 字段
curl -H "Authorization: Bearer $TOKEN" \
  http://localhost:3000/api/v1/conversations/{conversationId}/messages | \
  jq '.[] | select(.metadata.source == "agent") | {role, metadata}'

# 期望：
# - request 消息: role="agent", metadata.messageType="request"
# - response 消息: role="assistant", metadata.messageType="response"
# - 包含 senderAgentId 和 senderAgentName
```

### 3. 测试角色验证问题

```bash
# 尝试创建 role="agent" 的消息
curl -X POST -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"role": "agent", "text": "Test message", "metadata": {"source": "agent"}}' \
  http://localhost:3000/api/v1/conversations/{conversationId}/messages

# 当前结果：400 Bad Request (Role must be one of: user, assistant, system)
# 期望结果：201 Created
```

---

## 🔧 立即修复步骤

### Step 1: 修复角色验证

**文件**: `crates/ergatai-api/src/api/user_conversations.rs`

```rust
// 第 1270 行
if !matches!(request.role.as_str(), "user" | "agent" | "assistant" | "system") {
    return (
        StatusCode::BAD_REQUEST,
        Json(ErrorResponse {
            error: "Role must be one of: user, agent, assistant, system".to_string(),
        }),
    )
        .into_response();
}
```

### Step 2: 补充 agent 回复的 metadata

**文件**: `crates/ergatai-api/src/api/agents.rs`

在 `stream_agent_output` 函数的 Done event 处理中（约 3446 行），需要：

1. 从上下文中获取 agent_id 和 agent_name
2. 补充 metadata:

```rust
let metadata = serde_json::json!({
    "source": "agent",
    "messageType": "response",
    "senderAgentId": agent_id,
    "senderAgentName": agent_name,
});
```

**注意**: 需要从函数参数或上下文中提取 agent_id 和 agent_name，可能需要调整函数签名。

---

## 📊 测试建议

1. **单元测试**: 验证 `agent_message_role` 函数
2. **集成测试**: 验证消息存储和检索
3. **前端测试**: 验证消息渲染和样式
4. **API 测试**: 验证角色验证修复

---

## 结论

当前实现基本正确，但存在两个关键问题：

1. ✅ **消息已存储**：agent 回复和 agent-to-agent 消息都会被存储
2. ❌ **角色验证不完整**：REST API 不允许创建 `role="agent"` 的消息
3. ⚠️ **metadata 不完整**：agent 普通回复缺少 messageType, senderAgentId, senderAgentName
4. ✅ **parts 格式正确**：JSON 数组，包含正确的 part 类型
5. ⚠️ **agent bindings**：需要进一步验证

修复这些问题后，前端将能够正确显示和样式化所有类型的消息。
