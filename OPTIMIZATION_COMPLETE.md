# 统一消息投递优化完成总结

## 优化目标

将所有消息（用户消息和 Agent 消息）统一使用相同的投递路径：

```
用户/Agent → NATS JetStream → 消费者 → SQLite → ACP → Agent
```

## 完成的修改

### 1. 扩展 AgentMessagePayload 支持图片
- **文件**: `crates/ergatai-nats/src/events.rs`
- **改动**: 添加 `images: Vec<AgentImage>` 字段
- **状态**: ✅ 完成

### 2. 新增 Cov-centric 图片投递方法
- **文件**: `crates/ergatai-runtime/src/runtime.rs`
- **改动**: 添加 `inject_message_to_conversation_with_images()` 方法
- **状态**: ✅ 完成

### 3. 消费者支持用户消息持久化
- **文件**: `crates/ergatai-api/src/mcp/message_delivery.rs`
- **改动**: 在投递前检测用户消息（`from == "user"`），持久化到 SQLite 并发布 SSE
- **状态**: ✅ 完成

### 4. 消费者支持 Agent 消息持久化
- **文件**: `crates/ergatai-api/src/mcp/message_delivery.rs`
- **改动**: 在投递成功后检测 Agent 消息（`from != "user"`），持久化到 SQLite 并发布 SSE
- **状态**: ✅ 完成（刚刚添加）

### 5. prompt_agent 端点重构
- **文件**: `crates/ergatai-api/src/api/agents.rs`
- **改动**: 从直接写入 SQLite + ACP 调用改为发布到 NATS JetStream
- **状态**: ✅ 完成

### 6. MessageSender 重构
- **文件**: `crates/ergatai-api/src/messaging/mod.rs`
- **改动**: 
  - 成功 NATS 路径：移除持久化和 SSE 逻辑（由消费者处理）
  - 回退路径：保留完整逻辑（NATS 失败时的降级方案）
- **状态**: ✅ 完成

### 7. 测试修复
- **文件**: `crates/ergatai-nats/src/event_bus.rs`, `crates/ergatai-nats/src/events.rs`
- **改动**: 为所有测试添加 `images: vec![]` 字段
- **状态**: ✅ 完成

## 验证结果

### 编译检查
```bash
cargo check --workspace
# 结果: ✅ 通过
```

### 测试
```bash
cargo test --workspace --lib
# 结果: ✅ 1384 passed (11 suites, 44.95s)
```

## 统一投递路径

### 用户消息流程
```
1. 用户 → REST API (prompt_agent)
2. REST API → 构建 AgentMessagePayload（from="user"）
3. REST API → 发布到 NATS JetStream
4. NATS JetStream → 消费者接收
5. 消费者 → 检测 from == "user"
6. 消费者 → 持久化到 SQLite（role="user"）+ 发布 SSE
7. 消费者 → 投递给 Agent（通过 ACP）
8. Agent 接收消息
```

### Agent 消息流程
```
1. Agent → MCP (send_message)
2. MessageSender → 构建 AgentMessagePayload（from="agent"）
3. MessageSender → 发布到 NATS JetStream
4. NATS JetStream → 消费者接收
5. 消费者 → 检测 from != "user"（跳过用户消息逻辑）
6. 消费者 → 投递给 Agent（通过 ACP）
7. 消费者 → ack 消息
8. 消费者 → 持久化到 SQLite（role="agent" 或 "assistant"）+ 发布 SSE
9. Agent 接收消息
```

## 关键设计决策

### 1. 消费者统一处理持久化
- **原因**: 避免重复代码，确保所有消息都经过相同的处理流程
- **实现**: 消费者在投递成功后根据 `from` 字段区分用户/Agent 消息

### 2. 持久化在 ack 之后
- **原因**: 确保消息已成功投递，避免 ack 失败导致重复投递
- **实现**: Agent 消息的持久化逻辑在 `msg.ack()` 之后执行

### 3. 持久化失败不影响投递
- **原因**: 持久化是辅助功能，不应影响核心投递流程
- **实现**: 持久化失败只记录警告日志，不返回错误

### 4. Role 动态决定
- **原因**: 符合前端对话分组逻辑
- **实现**: 
  - 用户消息: `role = "user"`
  - Agent request 消息: `role = "agent"`（开启新对话组）
  - Agent response/broadcast 消息: `role = "assistant"`（追加到当前组）

### 5. 回退路径保留完整逻辑
- **原因**: 当 NATS 不可用时，仍能提供基本功能
- **实现**: 直接投递 + 持久化 + SSE 发布

## 优势

### 1. 统一投递路径
- 所有消息都经过相同的 NATS → 消费者 → SQLite → ACP 路径
- 代码更简洁，逻辑更一致

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

## 向后兼容性

这个重构对外部 API 没有影响：
- REST API 接口不变
- MCP 工具接口不变
- 前端无需修改

内部实现完全透明，用户和 Agent 的消息投递行为保持一致。

## 待提交文件

以下文件已修改但未提交（按用户要求，验证完成后再提交）：

1. `crates/ergatai-runtime/src/runtime.rs` - 新增 inject_message_to_conversation_with_images 方法
2. `crates/ergatai-nats/src/events.rs` - 添加 images 字段 + 修复测试
3. `crates/ergatai-nats/src/event_bus.rs` - 修复测试
4. `crates/ergatai-api/src/api/agents.rs` - prompt_agent 重构为发布到 NATS
5. `crates/ergatai-api/src/mcp/message_delivery.rs` - 消费者支持用户/Agent 消息持久化
6. `crates/ergatai-api/src/messaging/mod.rs` - 移除成功路径的持久化逻辑
7. `UNIFIED_MESSAGE_DELIVERY_REFACTOR.md` - 重构文档

## 总结

✅ **优化已完成**

所有修改已验证：
- 编译通过
- 所有测试通过（1384 passed）
- 统一投递路径实现
- 用户和 Agent 消息都经过 NATS → 消费者 → SQLite → ACP
- 消费者统一处理持久化和 SSE 发布
- 回退路径保留完整逻辑

等待用户确认后提交。
