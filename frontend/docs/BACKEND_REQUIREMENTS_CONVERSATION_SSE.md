# 后端架构改进需求：Conversation 级别的实时消息推送

## 背景

### 当前问题

1. **NATS 设计不完整**：当前 NATS 只支持 Agent 间消息传递（`ergatai.agent.message.{agent_id}`），缺少 Conversation 级别的订阅能力
2. **前端轮询效率低**：前端需要实时接收用户与 Agent 的对话消息，但目前只能通过轮询 REST API（每 4 秒），导致：
   - 高延迟（最坏 4 秒）
   - 服务器负载大
   - 网络带宽浪费
3. **消息模型不一致**：用户消息不经过 NATS，直接进入 SQLite；Agent 消息通过 NATS 转发后存入 SQLite

### 设计原则

- **Conversation 是执行单元**：所有消息都属于某个 conversation
- **Agent 只是角色来源**：Agent 信息（`sender_agent_id`）只是消息的元数据，不是独立的实体
- **NATS 是信息交换基础设施**：所有消息（用户 + Agent）都应该通过 NATS

## 需求

### 1. Conversation 级别的 NATS Subject

**新增：**
```
ergatai.conversation.message.{conversation_id}
```

**移除（或废弃）：**
```
ergatai.agent.message.{agent_id}  // 不再需要
```

**理由：**
- Conversation 是执行单元，Agent 只是角色来源
- 前端只需要按 conversation 订阅，不需要按 agent 订阅
- 简化架构，减少不必要的 subject

### 2. 消息模型

所有消息都必须包含 `conversation_id`：

```rust
pub struct ConversationMessagePayload {
    pub conversation_id: String,  // ✅ 必填
    pub message_id: String,
    pub role: String,  // "user" | "assistant" | "system"
    pub content: String,
    pub parts: Option<serde_json::Value>,
    pub metadata: Option<serde_json::Value>,
    pub timestamp: u64,
    pub sequence: u64,  // 消息在 conversation 中的序号
    
    // Agent 信息只是可选的元数据
    pub sender_agent_id: Option<String>,  // ✅ 可选
    pub sender_agent_name: Option<String>,
}
```

### 3. JetStream Stream 配置

```rust
pub fn conversation_message_stream_config() -> Config {
    Config {
        name: "CONVERSATION_MESSAGES",
        subjects: vec!["ergatai.conversation.message.*"],
        retention: RetentionPolicy::WorkQueue,
        max_age: Duration::from_secs(86_400),  // 24h
        storage: StorageType::File,
        num_replicas: 1,
    }
}
```

### 4. MessageSender 改动

所有消息发送（用户 + Agent）都必须：

1. **存储到 SQLite**（永久历史）
2. **发布到 NATS**（实时推送）

```rust
// messaging/mod.rs
pub async fn send(&self, req: SendRequest) -> SendMessageResult {
    // 1. 所有消息都必须有 conversation_id
    let conversation_id = req.conversation_id
        .ok_or_else(|| Error::MissingConversationId)?;
    
    // 2. 存储到 SQLite
    let message = user_data_db::messages::append(
        &conversation_id,
        &req.role,
        &req.content,
        &req.metadata,
    )?;
    
    // 3. 发布到 NATS conversation subject
    let bus = EventBus::new(get_nats_connection()?);
    bus.publish_conversation_message(&ConversationMessagePayload {
        conversation_id,
        message_id: message.id,
        role: req.role,
        content: req.content,
        parts: req.parts,
        metadata: req.metadata,
        timestamp: message.created_at,
        sequence: message.sequence,
        sender_agent_id: req.sender_agent_id,
        sender_agent_name: req.sender_agent_name,
    }).await?;
    
    // 4. 如果是 Agent 间消息，同时发送给目标 Agent
    if let Some(target_agent) = req.target_agent_id {
        runtime.inject_message(&target_agent, &req.content).await?;
    }
    
    SendMessageResult::Queued { 
        conversation_id, 
        message_id: message.id 
    }
}
```

### 5. SSE 端点

**新增路由：**
```
GET /api/v1/conversations/{id}/sse
```

**实现：**
```rust
// api/sse.rs
#[handler]
async fn conversation_sse(
    Path(conversation_id): Path<String>,
    Query(query): Query<SseQuery>,
) -> impl IntoResponse {
    let stream = async_stream::stream! {
        let conn = get_nats_connection().unwrap();
        let subject = format!("ergatai.conversation.message.{}", conversation_id);
        let mut subscriber = conn.subscribe(&subject).await.unwrap();
        
        // 过滤：只推送 after_sequence 之后的消息
        let after_sequence = query.after_sequence.unwrap_or(0);
        
        while let Some(msg) = subscriber.next().await {
            let payload: ConversationMessagePayload = 
                serde_json::from_slice(&msg.payload).unwrap();
            
            if payload.sequence > after_sequence {
                yield Ok(Event::default().data(serde_json::to_string(&payload).unwrap()));
            }
        }
    };
    
    Sse::new(stream)
}

#[derive(Deserialize)]
struct SseQuery {
    after_sequence: Option<u64>,
}
```

**路由注册：**
```rust
// lib.rs
Router::new()
    .route(
        "/api/v1/conversations/:id/sse",
        get(api::sse::conversation_sse)
    )
```

### 6. EventBus 新增方法

```rust
// event_bus.rs
pub async fn publish_conversation_message(
    &self,
    payload: &ConversationMessagePayload,
) -> ErgataiResult<PublishAck> {
    let subject = format!(
        "ergatai.conversation.message.{}",
        sanitize_agent_name(&payload.conversation_id)
    );
    
    self.publish_jetstream(&subject, payload).await
}

pub async fn subscribe_conversation_messages(
    &self,
    conversation_id: &str,
) -> ErgataiResult<Subscriber> {
    let subject = format!(
        "ergatai.conversation.message.{}",
        sanitize_agent_name(conversation_id)
    );
    
    self.connection.subscribe(&subject).await
}
```

### 7. 数据库改动

```sql
-- messages 表已经有 conversation_id，不需要改表结构
-- 但需要确保所有消息都有 conversation_id

-- 添加索引（如果还没有）
CREATE INDEX IF NOT EXISTS idx_messages_conversation_sequence 
ON messages(conversation_id, sequence);
```

## 迁移策略

### 阶段 1：向后兼容（1-2 周）

1. 新增 `ergatai.conversation.message.*` subject
2. 保留 `ergatai.agent.message.*` subject（标记为 deprecated）
3. 双写：消息同时发布到两个 subject
4. 前端逐步迁移到 conversation 订阅

### 阶段 2：完全迁移（1-2 月）

1. 前端完全使用 conversation 订阅
2. 移除 `ergatai.agent.message.*` subject
3. 清理旧代码

## 测试计划

### 单元测试

1. `MessageSender.send()` 必须发布到 conversation subject
2. SSE 端点必须正确推送消息
3. 消息去重：同一消息不重复推送

### 集成测试

1. 用户发送消息 → 前端实时接收
2. Agent 回复 → 前端实时接收
3. 多个前端同时订阅同一 conversation

### 性能测试

1. 1000 个并发 SSE 连接
2. 每秒 100 条消息的推送延迟
3. NATS JetStream 的背压控制

## 时间线

- **短期（1-2 周）**：前端先用轮询优化（增量查询）
- **中期（1-2 月）**：后端实现 SSE 端点 + conversation subject
- **长期（3-6 月）**：移除 Agent-level subject，全面使用 Conversation-level

## 验收标准

- [ ] 所有消息都包含 `conversation_id`
- [ ] 所有消息都发布到 `ergatai.conversation.message.{conversation_id}`
- [ ] SSE 端点正常工作，延迟 < 100ms
- [ ] 前端移除轮询代码，改用 SSE 订阅
- [ ] 消息不丢失，不重复
- [ ] 支持 1000+ 并发 SSE 连接

## 参考

- NATS JetStream 文档：https://docs.nats.io/nats-concepts/jetstream
- SSE 规范：https://html.spec.whatwg.org/multipage/server-sent-events.html
- 当前 NATS 实现：`crates/ergatai-nats/src/event_bus.rs`
- 当前消息发送：`crates/ergatai-api/src/messaging/mod.rs`
