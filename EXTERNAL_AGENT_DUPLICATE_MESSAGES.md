# 外部 Agent 消息重复存储问题

**日期**: 2026-01-xx  
**状态**: 待修复  
**优先级**: 高

---

## 问题现象

外部 agent（如 opencode/Agnes）发送的消息在数据库中被存储了两次，导致 UI 重复渲染。

### 数据库证据

在 `messages_conv_504699902832_000_0000` 表中，同一条消息出现两次：

```
sequence 4: message_id=2116865073518477313, created_at=1793534937
sequence 5: message_id=2116865079122067456, created_at=1793534938
content: "你好 Claude Code！很高兴认识你。我是 Agnes，由 Sapiens AI 开发的语言模型..."
```

两条消息间隔仅 1 秒，内容完全相同，`externalMessageId` 也相同（`msg_504699962977_000_0000`）。

### UI 表现

- 主聊天区域显示一次消息
- `InterAgentRepliesDisclosure` 组件中又显示一次相同消息
- 用户看到重复的消息内容

---

## 根本原因

代码中存在**两个消息存储点**，都在存储同一条消息：

### 存储点 1：早期存储（Early Append）

**位置**: `crates/ergatai-api/src/messaging/mod.rs:626`

```rust
// NATS JetStream 发布成功后立即存储
let append_result = tokio::task::spawn_blocking(move || {
    user_data_db::messages::append(
        queued_conversation_id,  // 目标对话
        role,
        early_parts,
        early_metadata,
        Some(agent_fields),
    )
})
.await;
```

**触发条件**: 消息通过 NATS JetStream 成功发布后

**注释说明**:
```rust
// Persist the queued inter-agent message immediately. The
// delivery consumer checks the same external ID and skips
// its later persistence pass, so this only moves the UI
// visibility point from injection time to acceptance time.
```

**预期行为**: 注释说 "delivery consumer checks the same external ID and skips its later persistence pass"，但实际上并没有跳过。

---

### 存储点 2：投递后存储（Delivery Persistence）

**位置**: `crates/ergatai-api/src/messaging/mod.rs:779`

```rust
// 消息投递到 agent 后存储
let append_result = tokio::task::spawn_blocking(move || {
    user_data_db::messages::append(
        conversation_id_for_persist,  // 目标对话
        role,
        serde_json::json!([{ "type": "text", "text": message }]),
        metadata,
        Some(agent_fields),
    )
})
.await;
```

**触发条件**: 消息通过 ACP 协议成功投递到目标 agent 后

**代码路径**: 这是 fallback 路径（当 NATS JetStream 发布失败时），但实际上似乎也在执行。

---

## 问题分析

### 为什么会有两个存储点？

1. **早期存储**：为了让消息在 NATS 接受后立即在 UI 可见（而不是等待投递完成）
2. **投递后存储**：作为 fallback，确保消息在投递成功后被持久化

### 为什么会导致重复？

代码注释说 "delivery consumer checks the same external ID and skips its later persistence pass"，但实际检查逻辑可能没有生效：

1. 早期存储使用了 `externalMessageId`
2. 投递后存储也使用了相同的 `externalMessageId`
3. 但投递后存储没有检查是否已经存在相同 `externalMessageId` 的消息

### 为什么只影响外部 agent 消息？

- **用户消息**：只经过一个存储路径（通过 `initial_prompt_turns`）
- **内部 agent 消息**：可能只经过一个存储路径
- **外部 agent 消息**：经过 NATS JetStream + ACP 投递两个路径，触发两个存储点

---

## 代码位置

### 关键文件

- `crates/ergatai-api/src/messaging/mod.rs` - 消息发送逻辑
- `crates/ergatai-api/src/messaging/message_delivery.rs` - NATS consumer 投递逻辑

### 关键函数

1. `MessageSender::send_message()` - 消息发送入口
   - 第 626 行：早期存储
   - 第 779 行：投递后存储

2. `message_delivery.rs` - NATS consumer
   - 应该在投递时检查 `externalMessageId` 是否已存在
   - 但检查逻辑可能没有生效

---

## 建议的解决方案

### 方案 1：在投递后存储前检查是否已存在（推荐）

在 `mod.rs:779` 的存储逻辑前，检查是否已经存在相同 `externalMessageId` 的消息：

```rust
// 检查是否已存在
let existing = user_data_db::messages::get_by_external_id(
    conversation_id_for_persist,
    &direct_external_message_id_for_meta,
)?;

if existing.is_some() {
    // 已存在，跳过存储
    return Ok(());
}

// 不存在，执行存储
user_data_db::messages::append(...)
```

**优点**：
- 保持早期存储的优势（立即可见）
- 防止重复存储
- 改动小，风险低

**缺点**：
- 需要添加 `get_by_external_id()` 函数
- 需要查询 metadata JSON 字段（性能可能较慢）

---

### 方案 2：移除投递后存储

如果早期存储已经足够可靠，可以移除投递后存储逻辑。

**优点**：
- 代码更简单
- 无重复风险

**缺点**：
- 如果早期存储失败，消息不会被持久化
- 需要确保早期存储的可靠性

---

### 方案 3：统一存储点

重新设计消息存储流程，只保留一个存储点。

**优点**：
- 架构更清晰
- 无重复风险

**缺点**：
- 改动大
- 需要重新设计消息可见性时机

---

## 测试建议

修复后需要测试：

1. **外部 agent 消息**：
   - 发送消息到外部 agent
   - 检查数据库中是否只有一条记录
   - 检查 UI 中是否只渲染一次

2. **用户消息**：
   - 用户发送消息
   - 检查数据库中是否只有一条记录

3. **内部 agent 消息**：
   - agent 之间发送消息
   - 检查数据库中是否只有一条记录

4. **消息丢失场景**：
   - 模拟早期存储失败
   - 检查消息是否仍能持久化

---

## 相关文件

- `PER_CONVERSATION_TABLES.md` - 按对话独立消息表架构
- `crates/ergatai-api/src/messaging/mod.rs` - 消息发送逻辑
- `crates/ergatai-api/src/user_data_db.rs` - 数据库操作

---

## 备注

这个问题在实施按对话独立消息表架构后仍然存在，说明问题不在表结构，而在消息存储逻辑。

需要优先修复，因为重复渲染会严重影响用户体验。
