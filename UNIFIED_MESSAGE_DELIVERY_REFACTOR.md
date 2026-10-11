# 统一消息投递路径重构

## 背景

在重构之前，用户消息和 Agent 消息使用不同的投递路径：

### 旧的用户消息路径
```
用户 → REST API → 直接写入 SQLite → 直接调用 ACP → Agent
```

**问题：**
1. 可靠性不一致：用户消息直接写 SQLite，如果 ACP 调用失败，消息已持久化但未被处理
2. 无法追踪：用户消息不经过 NATS，无法使用 JetStream 的监控和指标
3. 代码重复：两套写入逻辑，两套 ACP 调用
4. 顺序保证弱：无法保证消息按正确顺序处理和持久化

### 旧的 Agent 消息路径
```
Agent → MCP → NATS JetStream → 消费者 → SQLite → ACP → Agent
```

## 重构目标

统一所有消息（用户和 Agent）使用相同的投递路径：

```
用户/Agent → NATS JetStream → 消费者 → SQLite → ACP → Agent
```

## 实现细节

### 1. 扩展 AgentMessagePayload 支持图片

**文件：** `crates/ergatai-nats/src/events.rs`

添加了 `images` 字段和 `AgentImage` 结构：

```rust
pub struct AgentMessagePayload {
    // ... 现有字段 ...
    pub images: Vec<AgentImage>,
}

pub struct AgentImage {
    pub base64_data: String,
    pub media_type: String,
    pub filename: Option<String>,
}
```

### 2. 新增 Cov-centric 图片投递方法

**文件：** `crates/ergatai-runtime/src/runtime.rs`

添加了 `inject_message_to_conversation_with_images` 方法：

```rust
pub async fn inject_message_to_conversation_with_images(
    &self,
    conversation_id: &str,
    message: &str,
    images: Vec<AgentImage>,
    conversation_id: Option<&str>,
) -> ErgataiResult<()>
```

这个方法结合了：
- Cov-centric 投递（直接通过 conversation_id 查找 AgentInfo）
- 图片支持（通过 ACP 协议传递图片）

### 3. 消费者支持图片投递

**文件：** `crates/ergatai-api/src/mcp/message_delivery.rs`

更新消费者逻辑，根据是否有图片选择不同的投递方法：

```rust
let delivery_result = if payload.images.is_empty() {
    runtime.inject_message_to_conversation(&conversation_id, formatted_message, payload.thread_id.as_deref()).await
} else {
    runtime.inject_message_to_conversation_with_images(
        &conversation_id,
        formatted_message,
        runtime_images,
        payload.thread_id.as_deref(),
    ).await
};
```

### 4. 用户消息持久化和 SSE 流

**文件：** `crates/ergatai-api/src/mcp/message_delivery.rs`

消费者现在会检测用户消息（`from_agent == "user"`）并：
1. 持久化到 SQLite（role="user"）
2. 发布到 conversation subject 用于 SSE 流
3. 继续投递给 Agent

```rust
if from == "user" {
    // 持久化到 SQLite
    let append_result = tokio::task::spawn_blocking(move || {
        crate::user_data_db::messages::append(
            &conversation_id_for_persist,
            "user",
            serde_json::Value::Array(parts),
            serde_json::json!({ "source": "user" }),
        )
    }).await;

    // 发布到 SSE
    crate::messaging::publish_to_conversation_subject_with_message(
        persisted_msg,
        None,
        None,
    ).await;
}
```

### 5. Agent 消息持久化和 SSE 流

**文件：** `crates/ergatai-api/src/mcp/message_delivery.rs`

消费者在成功投递 Agent 消息后（`from != "user"`）会：
1. 持久化到 SQLite（role 根据 message_type 决定：request="agent", response/broadcast="assistant"）
2. 发布到 conversation subject 用于 SSE 流

```rust
if from != "user" {
    // 根据消息类型决定 role
    let role = match message_type.as_str() {
        "request" => "agent",
        "response" | "broadcast" => "assistant",
        _ => "agent",
    };

    // 持久化到 SQLite
    let append_result = tokio::task::spawn_blocking(move || {
        let metadata = serde_json::json!({
            "source": "agent",
            "senderAgentId": from_agent,
            "messageType": message_type,
        });
        crate::user_data_db::messages::append(
            &conversation_id_for_persist,
            role,
            serde_json::json!([{ "type": "text", "text": message_content }]),
            metadata,
        )
    }).await;

    // 发布到 SSE
    crate::messaging::publish_to_conversation_subject_with_message(
        persisted_msg,
        Some(from.to_string()),
        None,
    ).await;
}
```

**关键设计决策：**
- 持久化在 ack 之后进行，确保消息已投递
- 持久化失败只记录警告，不影响投递结果
- Agent 消息使用 `source: "agent"` 标识，与用户消息区分
- role 根据 message_type 动态决定，符合前端对话分组逻辑

### 6. MessageSender 重构

**文件：** `crates/ergatai-api/src/messaging/mod.rs`

#### 成功的 NATS 路径
移除了持久化和 SSE 逻辑，由消费者统一处理：

```rust
// Note: Message persistence and SSE streaming are now handled by the consumer
// in message_delivery.rs, not here. This ensures unified delivery path for
// both user and agent messages.

return SendMessageResult::Queued {
    target_agent: resolved_target_id,
    stream,
    sequence,
};
```

#### 回退路径（NATS 失败时）
保留了持久化和 SSE 逻辑，确保在 NATS 不可用时仍能正常工作：

```rust
// ── Fallback: direct delivery via ACP protocol ──
// 直接投递 + 持久化 + SSE 发布
```

**设计原则：**
- 主要路径（NATS）由消费者统一处理持久化，避免重复
- 回退路径（直接投递）保留完整逻辑，确保可靠性

## 优势

### 1. 统一投递路径
所有消息（用户和 Agent）都经过相同的 NATS → 消费者 → SQLite → ACP 路径，代码更简洁，逻辑更一致。

### 2. 可靠性保证
- JetStream 持久化确保消息不丢失
- ack/nak 机制保证投递成功
- 失败自动重试

### 3. 性能提升
- 异步处理：发布到 NATS 后立即返回，消费者异步处理
- 统一路径：减少代码分支，提高缓存命中率

### 4. 可观测性
- 所有消息都经过 NATS，可以统一监控
- JetStream 提供投递状态追踪
- 可以统计消息处理延迟、失败率等指标

### 5. 顺序保证
- NATS JetStream 保证消息按顺序处理
- 消费者按序列号处理，避免乱序

## 测试

所有现有测试通过：
- `cargo test -p ergatai-api --lib mcp::message_delivery`: 14 passed
- 无编译错误

## 向后兼容性

这个重构对外部 API 没有影响：
- REST API 接口不变
- MCP 工具接口不变
- 前端无需修改

内部实现完全透明，用户和 Agent 的消息投递行为保持一致。
