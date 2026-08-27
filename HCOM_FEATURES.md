# hcom 启发功能实现总结

## 概述

借鉴 hcom 项目的设计，在 ergatai 中实现了三个消息可观察性增强功能：

1. **Read Receipts（已读回执）** - 追踪消息是否被 agent 成功接收
2. **Auto-subscription Presets（自动订阅预设）** - agent 启动时自动订阅关键事件
3. **reqwatch Auto-monitoring（请求自动监控）** - 自动监控 request 消息是否被响应

## 实现详情

### Phase 1: Read Receipts（已读回执）

**目标**: 让发送方知道消息是否被目标 agent 成功接收。

**改动文件**:
- `crates/ergatai-nats/src/events.rs`
  - 扩展 `AgentMessagePayload` 添加 `message_id` 和 `requires_receipt` 字段
  - 新增 `ReadReceiptPayload` 结构体
- `crates/ergatai-nats/src/event_bus.rs`
  - 添加 `publish_read_receipt()` 方法
  - 路由: `ergatai.agent.receipt.{to_agent}`
- `crates/ergatai-nats/src/lib.rs`
  - 导出 `ReadReceiptPayload`
- `crates/ergatai-api/src/messaging/mod.rs`
  - 生成 `message_id` (UUID)
  - 根据 `message_type` 设置 `requires_receipt`
- `crates/ergatai-api/src/mcp/message_delivery.rs`
  - 成功投递后发布 `ReadReceiptPayload`

**工作原理**:
1. Agent A 发送 request 消息给 Agent B
2. `MessageSender::send()` 生成 `message_id` 和设置 `requires_receipt: true`
3. 消息通过 NATS 投递到 Agent B
4. `message_delivery.rs` 成功投递后发布 `ReadReceiptPayload` 到 `ergatai.agent.receipt.{Agent A}`
5. Agent A 收到回执，确认消息已被接收

---

### Phase 2: Auto-subscription Presets（自动订阅预设）

**目标**: agent 启动时自动订阅关键事件类型。

**改动文件**:
- `crates/ergatai-core/src/agent_registry.rs`
  - 添加 `subscription_presets` 字段到 `AgentInfo`
  - 定义 `SUBSCRIPTION_PRESETS` 常量
  - 默认值: `["lifecycle", "receipts"]`

**预设定义**:
```rust
pub const SUBSCRIPTION_PRESETS: &[(&str, &[&str])] = &[
    ("lifecycle", &["ergatai.agent.lifecycle"]),
    ("receipts", &["ergatai.agent.receipt.*"]),
    ("file_events", &["ergatai.file.ready", "ergatai.file.error"]),
];
```

**工作原理**:
1. Agent 注册时，`register_agent()` 自动设置 `subscription_presets`
2. 预设定义了 agent 应该订阅的 NATS subject 模式
3. 后续可以扩展为自动创建 NATS subscriptions

---

### Phase 3: reqwatch Auto-monitoring（请求自动监控）

**目标**: 自动监控 request 消息是否被响应，超时则通知发送方。

**改动文件**:
- `crates/ergatai-nats/src/events.rs`
  - 扩展 `AgentMessagePayload` 添加 `correlation_id` 和 `timeout_ms` 字段
  - 新增 `RequestTimeoutPayload` 结构体
- `crates/ergatai-nats/src/event_bus.rs`
  - 添加 `publish_request_timeout()` 方法
  - 路由: `ergatai.agent.request_timeout.{from_agent}`
- `crates/ergatai-nats/src/lib.rs`
  - 导出 `RequestTimeoutPayload`
- `crates/ergatai-api/src/mcp/request_monitor.rs` (新文件)
  - 实现 `RequestMonitor` 服务
  - 追踪 pending requests
  - 检测超时
  - 后台任务每 5 秒检查超时
- `crates/ergatai-api/src/mcp/mod.rs`
  - 导出 `RequestMonitor` 和 `spawn_request_monitor`
- `crates/ergatai-api/src/messaging/mod.rs`
  - 添加 `request_monitor` 字段到 `MessageSender`
  - request 消息发送后调用 `track_request()`
- `crates/ergatai-api/src/main.rs`
  - 启动 reqwatch 后台任务

**工作原理**:
1. Agent A 发送 request 消息给 Agent B
2. `MessageSender::send()` 生成 `correlation_id` 和设置 `timeout_ms: 30000`
3. `RequestMonitor::track_request()` 记录 pending request
4. 后台任务每 5 秒检查超时
5. 如果 30 秒内未收到 response，发布 `RequestTimeoutPayload` 到 `ergatai.agent.request_timeout.{Agent A}`
6. Agent A 收到超时通知，知道请求未被响应

**关键实现**:
```rust
pub struct RequestMonitor {
    pending: Arc<RwLock<HashMap<String, PendingRequest>>>,
}

struct PendingRequest {
    message_id: String,
    from_agent: String,
    to_agent: String,
    correlation_id: String,
    sent_at: u64,
    timeout_ms: u64,
}
```

---

## 消息类型与监控行为

| message_type | requires_receipt | correlation_id | timeout_ms | 监控行为 |
|--------------|------------------|----------------|------------|----------|
| `request` | true | 自动生成 | 30000 | 追踪 + 超时检测 |
| `response` | false | None | None | 无特殊监控 |
| `broadcast` | false | None | None | 无特殊监控 |

---

## 新增 NATS Subjects

```
ergatai.agent.receipt.{agent_id}           已读回执
ergatai.agent.request_timeout.{agent_id}   请求超时通知
```

---

## 新增类型

| 类型 | 文件 | 用途 |
|------|------|------|
| `ReadReceiptPayload` | `nats/events.rs` | 已读回执 |
| `RequestTimeoutPayload` | `nats/events.rs` | 请求超时通知 |
| `RequestMonitor` | `api/mcp/request_monitor.rs` | reqwatch 监控服务 |

---

## 测试验证

### Read Receipts 验证
```bash
# 启动两个 agent
ergatai agent spawn --name agent-1
ergatai agent spawn --name agent-2

# 发送 request 消息
ergatai agent message agent-1 --to agent-2 --type request --message "Hello"

# 检查日志，应该看到:
# 1. 消息投递成功
# 2. ReadReceipt 发布到 ergatai.agent.receipt.agent-1
```

### Auto-subscription 验证
```bash
# 启动 agent
ergatai agent spawn --name agent-1

# 检查 agent 配置，应该看到:
# subscription_presets: ["lifecycle", "receipts"]
```

### reqwatch 验证
```bash
# 启动两个 agent
ergatai agent spawn --name agent-1
ergatai agent spawn --name agent-2

# agent-1 发送 request 给 agent-2
ergatai agent message agent-1 --to agent-2 --type request --message "Task"

# 等待超时时间（默认 30 秒）
# 检查日志，应该看到:
# RequestTimeout 发布到 ergatai.agent.request_timeout.agent-1
```

---

## 编译状态

✅ 所有代码编译成功，无错误和警告

```bash
cargo check --workspace
# Finished `dev` profile [unoptimized + debuginfo] target(s)
```

---

## 文档更新

已更新 `CLAUDE.md`:
- 添加"消息可观察性（hcom 启发）"章节
- 更新"关键类型"表格，添加新类型
- 更新"NATS Subject 命名"章节，添加新 subjects

---

## 实现日期

2026-08-27

## 灵感来源

hcom 项目 (位于 `/home/yubing/code/hcom`)
