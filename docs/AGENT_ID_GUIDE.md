# Agent ID 使用指南

> **TL;DR**: 项目有两套 Agent ID 系统。**对外通信使用 `ergatai_agent_id`，内部存储使用 Snowflake `agent_id`**。

---

## 📚 概述

Ergatai 使用两套 Agent ID 系统，分别服务于不同的场景：

| ID 类型 | 格式示例 | 存储位置 | 生命周期 | 主要用途 |
|---------|---------|---------|---------|---------|
| **Runtime Agent ID** | `agent_502816809136_000_0000` | `AgentHandle.agent_id` | 进程级（重启后变化） | 内部追踪、数据库存储 |
| **Cross-restart Agent ID** | `agent-1`, `ws1-agent-1` | `AgentHandle.metadata["ergatai_agent_id"]` | 跨重启稳定 | 消息路由、API 调用、用户界面 |

---

## 🎯 快速决策指南

### 何时使用 `ergatai_agent_id`

✅ **使用场景**：
- `send_message` 的 `target_agent_id` 参数
- MCP 工具调用（`list_agents`, `send_message` 等）
- REST API 的 agent 标识符
- 用户界面显示 agent 名称
- Agent 间通信的发送者/接收者标识
- 日志中的人类可读 agent 标识

❌ **不要使用**：
- 数据库主键或外键
- 需要唯一性保证的内部追踪

### 何时使用 `agent_id` (Snowflake)

✅ **使用场景**：
- 数据库存储（`messages.from_agent_id` 等）
- 内部运行时追踪（性能监控、调试）
- 需要时间排序的场景
- 进程级别的技术追踪

❌ **不要使用**：
- 对外 API 的参数
- 用户可见的标识符
- Agent 间消息路由

---

## 📖 详细示例

### 示例 1: 发送消息

```rust
// ✅ 正确：使用 ergatai_agent_id
let target = "agent-2";  // 从 list_agents 获取的 ergatai_agent_id
send_message(
    target_agent_id: target,
    message: "Hello",
    message_type: "request"
)?;

// ❌ 错误：使用 Snowflake agent_id
let target = "agent_502816809136_000_0000";  // 这是内部 ID，不要用于消息路由
send_message(target_agent_id: target, ...)?;  // 可能失败或行为不一致
```

### 示例 2: 数据库存储

```rust
// ✅ 正确：存储 Snowflake ID (i64)
let snowflake_id: i64 = parse_agent_id_to_i64(&agent_handle.agent_id)?;
db.insert_message(
    from_agent_id: Some(snowflake_id),  // 数据库字段是 INTEGER
    ...
)?;

// ❌ 错误：存储字符串 ID
db.insert_message(
    from_agent_id: Some("agent-1".parse::<i64>()),  // 格式错误，会失败
    ...
)?;
```

### 示例 3: API 响应

```rust
// ✅ 正确：返回两个 ID，明确用途
json!({
    "agent_id": handle.agent_id,              // Snowflake ID（内部使用）
    "ergatai_agent_id": handle.metadata
        .get("ergatai_agent_id")
        .unwrap_or(&handle.agent_id),         // Cross-restart ID（外部使用）
    "status": "running",
    ...
})

// 在 API 文档中说明：
/// - `agent_id`: 内部 Snowflake ID，用于数据库查询和日志追踪
/// - `ergatai_agent_id`: 稳定的 agent 标识，用于 send_message 和 MCP 调用
```

---

## 🔧 代码位置参考

### ID 定义

| 文件 | 行号 | 说明 |
|------|------|------|
| `crates/ergatai-runtime/src/types.rs` | 177-198 | `AgentHandle` 定义，包含两种 ID |
| `crates/ergatai-error/src/typed_ids.rs` | 193 | `AgentId` 类型定义（Snowflake） |
| `crates/ergatai-error/src/id.rs` | 104 | `IdType::Agent` 枚举 |

### ID 生成

| 文件 | 行号 | 说明 |
|------|------|------|
| `crates/ergatai-runtime/src/backend.rs` | 316 | 生成 Snowflake agent_id |
| `crates/ergatai-runtime/src/runtime.rs` | 1512 | 设置 `ergatai_agent_id` 到 metadata |
| `crates/ergatai-collab/src/agent_launcher.rs` | - | 通过 `ERGATAI_AGENT_ID` 环境变量设置 |

### ID 使用

| 文件 | 行号 | 场景 |
|------|------|------|
| `crates/ergatai-api/src/mcp/acp_factory.rs` | 141 | `send_message` 使用 `ergatai_agent_id` |
| `crates/ergatai-api/src/messaging/mod.rs` | 75-104 | ID 转换逻辑（Snowflake ↔ Legacy） |
| `crates/ergatai-api/src/user_data_db.rs` | 269 | 数据库存储 Snowflake ID (i64) |
| `crates/ergatai-api/src/mcp/tools/list_agents.rs` | 106 | API 返回两种 ID |

---

## 🔄 ID 转换逻辑

### 字符串 → i64 (数据库存储)

```rust
// crates/ergatai-api/src/messaging/mod.rs:75
fn parse_agent_id_to_i64(id_str: &str) -> Option<i64> {
    // 1. 优先尝试 Snowflake 格式: "agent_123_001_0001"
    if let Some(id) = ergatai_error::id::parse_to_i64(id_str) {
        return Some(id);
    }
    
    // 2. 降级到 Legacy 格式: "ws1-agent-1" → 提取末尾数字 1
    // ⚠️ 注意：Legacy 格式可能冲突（多个 workspace 的 agent-1）
    if id_str.contains("-agent-") {
        // 提取计数器
    }
    
    None
}
```

### i64 → 字符串 (API 响应)

```rust
// 使用 ergatai_error::id::format
let formatted = ergatai_error::id::format(snowflake_id, IdType::Agent);
// 输出: "agent_502816809136_000_0000"
```

---

## ⚠️ 常见陷阱

### 陷阱 1: 混淆两种 ID

```rust
// ❌ 错误：用 Snowflake ID 发送消息
let agent_id = "agent_502816809136_000_0000";
send_message(target_agent_id: agent_id, ...)?;  // 可能失败

// ✅ 正确：用 ergatai_agent_id
let ergatai_id = agent_handle.metadata
    .get("ergatai_agent_id")
    .unwrap_or(&agent_handle.agent_id);
send_message(target_agent_id: ergatai_id, ...)?;
```

### 陷阱 2: Legacy ID 冲突

```rust
// ⚠️ 风险：多个 workspace 的 agent-1 都会解析为 i64(1)
let id1 = "ws1-agent-1";  // → 1
let id2 = "ws2-agent-1";  // → 1 (冲突!)

// ✅ 解决：使用 Snowflake ID 或全局唯一的 ergatai_agent_id
```

### 陷阱 3: 进程重启后 ID 变化

```rust
// ❌ 错误：缓存 Snowflake agent_id
let cached_id = agent_handle.agent_id.clone();
// ... agent 重启 ...
// cached_id 现在指向新进程，旧 ID 失效

// ✅ 正确：使用 ergatai_agent_id（跨重启稳定）
let stable_id = agent_handle.metadata
    .get("ergatai_agent_id")
    .cloned()
    .unwrap_or_else(|| agent_handle.agent_id.clone());
```

---

## 📝 最佳实践

### 1. API 设计

```rust
#[derive(Debug, Serialize)]
pub struct AgentInfo {
    /// 内部 Snowflake ID（用于数据库查询、日志追踪）
    /// 格式: "agent_{timestamp}_{instance}_{sequence}"
    pub agent_id: String,
    
    /// 稳定的 agent 标识（用于 send_message、MCP 调用）
    /// 格式: "agent-1", "ws1-agent-1", 或 MCP URL path
    #[serde(rename = "ergatai_agent_id")]
    pub stable_id: String,
    
    // ... 其他字段
}
```

### 2. 消息路由

```rust
pub fn route_message(
    from: &str,           // ergatai_agent_id
    to: &str,             // ergatai_agent_id
    message: &str,
) -> Result<()> {
    // 1. 解析 ergatai_agent_id 到 runtime agent
    let target_agent = resolve_agent_by_ergatai_id(to)?;
    
    // 2. 发送到 runtime
    target_agent.send(message)?;
    
    // 3. 存储到数据库（转换为 Snowflake ID）
    let from_snowflake = parse_agent_id_to_i64(from);
    db.insert_message(from_snowflake, to_snowflake, message)?;
    
    Ok(())
}
```

### 3. 日志记录

```rust
// ✅ 同时记录两种 ID，便于追踪
tracing::info!(
    agent_id = %handle.agent_id,              // Snowflake ID（技术追踪）
    ergatai_agent_id = %ergatai_id,           // Stable ID（业务追踪）
    "Agent started"
);
```

---

## 🔍 调试技巧

### 查找 agent 的所有 ID

```bash
# 通过 ergatai_agent_id 查找
curl http://localhost:3000/api/v1/agents | jq '.[] | select(.ergatai_agent_id == "agent-1")'

# 输出示例:
{
  "agent_id": "agent_502816809136_000_0000",      # Snowflake ID
  "ergatai_agent_id": "agent-1",                   # Stable ID
  "status": "running",
  ...
}
```

### 追踪消息路由

```rust
// 在 send_message 中添加日志
tracing::debug!(
    from_ergatai_id = %send_request.from,
    to_ergatai_id = %send_request.to,
    from_snowflake = ?parse_agent_id_to_i64(&send_request.from),
    to_snowflake = ?parse_agent_id_to_i64(&send_request.to),
    "Routing message"
);
```

---

## 📚 相关文档

- [CLAUDE.md](../CLAUDE.md) - 项目总体文档
- [INTERRUPT_MECHANISM.md](./INTERRUPT_MECHANISM.md) - Agent 中断机制
- [ID Generation](../crates/ergatai-error/src/id.rs) - ID 生成模块源码

---

**最后更新**: 2026-10-25  
**维护者**: Ergatai Core Team
