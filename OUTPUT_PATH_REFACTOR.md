# Agent 输出路径重构 - 依赖注入方案

## 重构目标

将 Agent 输出从 broadcast channel 直接推送到前端，重构为经过 NATS 统一消息路由：

```
重构前：
ACP → broadcast channel → SSE（直接推送）

重构后：
ACP → OutputPublisher trait → NATS → SSE（统一路径）
```

## 已完成的改动

### 1. 定义 OutputPublisher trait（ergatai-runtime）

**文件**: `crates/ergatai-runtime/src/output_publisher.rs`

```rust
pub trait OutputPublisher: Send + Sync {
    fn publish(&self, agent_id: &str, event: AgentOutputEvent) -> ErgataiResult<()>;
}

pub struct NoOpOutputPublisher;
impl OutputPublisher for NoOpOutputPublisher { ... }
```

**作用**: 
- 抽象消息发布机制，解耦 runtime 和具体消息系统
- 提供 NoOp 实现用于测试

### 2. 修改 AcpBackend 支持 OutputPublisher（ergatai-runtime）

**文件**: `crates/ergatai-runtime/src/backends/acp.rs`

**改动**:
1. 添加 `output_publisher` 字段到 `AcpBackend`
2. 添加 `with_output_publisher()` 方法用于注入 publisher
3. 创建 `send_output_event()` 辅助函数，同时发送到 broadcast channel 和 output publisher
4. 替换所有 `output_tx.send()` 调用为 `send_output_event()`

**关键代码**:
```rust
fn send_output_event(
    output_tx: &broadcast::Sender<AgentOutputEvent>,
    output_publisher: &Option<Arc<dyn OutputPublisher>>,
    agent_id: &str,
    event: AgentOutputEvent,
) {
    // 发送到 broadcast channel（用于 SSE 订阅者）
    let _ = output_tx.send(event.clone());

    // 发布到 output publisher（用于统一消息路由）
    if let Some(publisher) = output_publisher {
        if let Err(e) = publisher.publish(agent_id, event) {
            tracing::warn!(...);
        }
    }
}
```

### 3. 定义 AgentOutputPayload 类型（ergatai-nats）

**文件**: `crates/ergatai-nats/src/events.rs`

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum AgentOutputPayload {
    Text { delta: String },
    Thinking { delta: String },
    ToolCallStart { ... },
    ToolCallInput { ... },
    ToolCallComplete { ... },
    ToolCallError { ... },
    SessionTitleUpdate { title: String },
    Done { reason: String },
    Error { message: String },
}
```

**作用**: NATS 事件载荷，与 `AgentOutputEvent` 对应

### 4. 添加 publish_agent_output 方法（ergatai-nats）

**文件**: `crates/ergatai-nats/src/event_bus.rs`

```rust
pub async fn publish_agent_output(
    &self,
    agent_id: &str,
    payload: &AgentOutputPayload,
) -> ErgataiResult<()> {
    let subject = format!("ergatai.agent.output.{}", sanitize_agent_name(agent_id));
    self.publish(&subject, payload).await
}
```

**作用**: 发布到 `ergatai.agent.output.{agent_id}` subject

### 5. 实现 NatsOutputPublisher（ergatai-api）

**文件**: `crates/ergatai-api/src/services/nats_output_publisher.rs`

```rust
pub struct NatsOutputPublisher {
    nats_connection: ergatai_nats::NatsConnection,
}

impl OutputPublisher for NatsOutputPublisher {
    fn publish(&self, agent_id: &str, event: AgentOutputEvent) -> ErgataiResult<()> {
        let event_bus = ergatai_nats::EventBus::new(self.nats_connection.clone());
        let payload = convert_event_to_payload(event)?;
        
        // 异步发布到 NATS
        tokio::spawn(async move {
            event_bus.publish_agent_output(&agent_id, &payload).await
        });
        
        Ok(())
    }
}
```

**作用**: 
- 实现 `OutputPublisher` trait
- 将 `AgentOutputEvent` 转换为 `AgentOutputPayload`
- 异步发布到 NATS

## 当前状态

### ✅ 已完成
1. OutputPublisher trait 定义
2. AcpBackend 支持依赖注入
3. AgentOutputPayload 类型定义
4. NatsOutputPublisher 实现
5. 所有代码编译通过

### ⏳ 待完成
1. **在创建 AcpBackend 时注入 NatsOutputPublisher**
   - 找到创建 AcpBackend 的位置（通常在 `main.rs` 或初始化代码中）
   - 添加 `.with_output_publisher(Arc::new(NatsOutputPublisher::new(nats_connection)))`

2. **修改 SSE 流从 NATS 订阅**
   - 修改 `stream_agent_output` 函数
   - 从 NATS 订阅 `ergatai.agent.output.{agent_id}`
   - 移除直接从 broadcast channel 接收的逻辑

3. **移除 broadcast channel**（可选，完全重构）
   - 移除 `output_tx` 和 `output_rx`
   - 所有输出都通过 NATS 发布
   - SSE 从 NATS 订阅

## 架构优势

### 1. 解耦
- `ergatai-runtime` 不依赖具体的消息系统
- 可以切换不同的发布实现（NATS、Kafka、Redis 等）

### 2. 统一管理
- 所有消息都经过 NATS
- 可以使用 NATS 的监控能力
- 数据来源统一

### 3. 灵活性
- 可以同时发送到 broadcast channel 和 NATS（向后兼容）
- 可以逐步迁移，不需要一次性重构

### 4. 可测试
- 可以使用 mock 实现进行测试
- 可以隔离测试各个组件

## 下一步

1. 在 `main.rs` 或初始化代码中注入 `NatsOutputPublisher`
2. 测试 Agent 输出是否正确发布到 NATS
3. 修改 SSE 流从 NATS 订阅
4. 验证端到端流程
5. （可选）移除 broadcast channel，完全使用 NATS

## 编译状态

```bash
cargo check -p ergatai-runtime
# ✅ 编译通过

cargo check -p ergatai-api
# ✅ 编译通过（无警告）
```

所有代码已就绪，等待集成到初始化流程中。
