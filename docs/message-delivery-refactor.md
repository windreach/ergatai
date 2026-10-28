# 消息投递管线重构：命令与视图分离

## 概述

本次重构实现了多 agent 协作消息系统的核心改进，将"命令"（发送消息）和"视图"（消息可见性）彻底分离。核心原则：

> **Agent API 负责发送，conversation runtime 只读投影，SQLite 负责历史，frontend session 只做合并渲染。**

---

## 改动内容

### 批1：消息立即可见（Early Persistence）

**问题**：消息在进入 delivery pipeline 后，需要等待 agent 处理完成才持久化到 SQLite，导致前端在 agent 处理期间查询 conversation API 看不到消息。

**解决方案**：将消息持久化从 `inject_message_to_conversation()` 之后移到之前。

**改动文件**：
- `crates/ergatai-api/src/mcp/message_delivery.rs` — 将持久化逻辑从 `Ok(())` 分支移到 inject 调用之前；新增 `deliveryStatus` 字段追踪投递状态
- `crates/ergatai-api/src/user_data_db.rs` — 新增 `exists_by_external_message_id()` 用于 SQLite 级去重；新增 `update_delivery_status()` 更新投递状态

**时序对比**：

```
旧流程：
  NATS publish → consumer 拉取 → inject_message (阻塞) → ack → 持久化 → SSE 推送
  
新流程：
  NATS publish → consumer 拉取 → 持久化 (deliveryStatus="pending") → SSE 推送 → inject_message (阻塞) → ack → 更新 deliveryStatus
```

**投递状态追踪**：

由于消息在投递前就持久化，通过 metadata 中的 `deliveryStatus` 字段追踪投递状态：

```json
{
  "externalMessageId": "uuid-from-frontend",
  "deliveryStatus": "pending" | "delivered" | "failed"
}
```

- `pending`：消息已持久化，等待投递（初始状态）
- `delivered`：消息成功投递到 agent（inject 成功后更新）
- `failed`：消息投递失败（inject 失败后更新）

**去重机制**（防止 NATS redelivery 重复写入）：
1. 内存级去重：`is_duplicate_message()` + `mark_message_processed()`（已有）
2. SQLite 级去重：`exists_by_external_message_id()` 检查 metadata 中的 `externalMessageId`（新增）

### 批2：统一事件契约（Explicit Turn Boundaries）

**问题**：Turn 开始是隐式的（从第一个 delta 事件推断），前端需要猜测 turn 边界。

**解决方案**：新增 `TurnStarted` 事件变体，在 `begin_turn()` 后立即发射，使 turn 边界显式化。

**改动文件**：
- `crates/ergatai-runtime/src/backends/acp.rs` — 新增 `AgentOutputEvent::TurnStarted` 变体，三个 `begin_turn()` 调用点都发射该事件
- `frontend/src/main/lib/ergatai/sse-client.ts` — Zod schema 新增 `turn_started` 事件类型

**事件类型**：
```rust
AgentOutputEvent::TurnStarted {
    role: String,  // "assistant" for local agent, "agent" for inter-agent
}
```

### 批5：消息 ID 对齐（Client Request ID）

**问题**：前端发送消息后无法将 optimistic 消息与后端持久化的 durable 消息匹配，导致"重复消息"、"完成后闪一下"、"历史覆盖实时流"等问题。

**解决方案**：前端复用已持久化的 `message_id` 作为 `clientRequestId`，全链路传递到 SQLite metadata 的
`externalMessageId` 字段。新的 optimistic 消息可以省略该 ID，由后端在持久化时分配 Snowflake `message_id`。

**改动文件**：
- `frontend/src/main/lib/trpc/routers/ergatai.ts` — `sendMessage` 和 `promptAgent` 新增 `clientRequestId` 参数
- `frontend/src/renderer/features/agents/lib/ergatai-chat-transport.ts` — 优先复用已持久化的消息 ID 作为 `clientRequestId`
- `crates/ergatai-api/src/api/agents.rs` — `SendMessageRequest` 和 `PromptAgentRequest` 新增 `client_request_id` 字段
- `crates/ergatai-api/src/messaging/mod.rs` — `SendRequest` 新增 `client_request_id` 字段，存入 NATS payload metadata
- `crates/ergatai-api/src/mcp/message_delivery.rs` — 优先使用 metadata 中的 `clientRequestId` 作为 `externalMessageId`
- `crates/ergatai-api/src/mcp/acp_factory.rs` — MCP 工具构造 `SendRequest` 时设置 `client_request_id: None`
- `crates/ergatai-api/src/mcp/tools/send_message.rs` — 同上
- `crates/ergatai-api/tests/admission_gate_integration_tests.rs` — 测试适配新字段

**数据流**：
```
前端复用 persisted message_id；新消息省略 clientRequestId
  → tRPC clientRequestId
  → REST API client_request_id
  → SendRequest.client_request_id
  → NATS payload.metadata["clientRequestId"]
  → SQLite metadata.externalMessageId
  → 前端通过 externalMessageId 匹配 optimistic → durable
```

---

## ID 体系

| ID | 来源 | 用途 |
|----|------|------|
| `clientRequestId` | 前端复用 persisted `message_id`；新消息可省略 | 去重 / optimistic 消息匹配标识 |
| `message_id` | 后端生成（snowflake） | SQLite 主键，全局唯一 |
| `externalMessageId` | SQLite metadata 字段 | 存储 `clientRequestId`，用于前端去重匹配 |
| `turnId` | runtime 生成 | Agent 回合标识，格式 `turn-{epoch}-{sequence}` |
| `sequence` | runtime 单调递增 | Conversation 内事件顺序，用于断点续传 |

---

## 前端合并规则

1. 发送消息时生成 `clientRequestId`，创建 optimistic 消息
2. 后端持久化后返回 durable 消息（通过 SSE 或 API）
3. 前端通过 `metadata.externalMessageId === clientRequestId` 匹配
4. 匹配成功后用 durable 消息替换 optimistic 消息
5. Runtime streaming turn 用 `turnId` 标识
6. Durable assistant message 完成后替换对应 runtime turn

---

## 测试

- 所有 267 个现有测试通过
- 9 个 `collaboration_session_integration_tests` 失败为预先存在的问题（agent_id 格式校验），与本次改动无关
- 14 个 `message_delivery` 测试全部通过

---

## 后续工作

- **批3**：前端统一 `useConversationSession` hook（读层统一）
- **批4**：主对话去掉混合状态（`ErgataiChatTransport` 只做命令提交）
- **批6**：清理重复 API（`chats.get` 全量加载、side chat 独立初始化等）
- **批7**：补充端到端测试（NATS redelivery 去重、cancel 后状态、reconnect 无重复等）
