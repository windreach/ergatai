# ID 强类型迁移规范

## 概述

将核心表的 ID 字段从 `i64`/`String` 迁移到强类型（`ConversationId`, `MessageId` 等）。

## 强类型定义

已定义在 `crates/ergatai-error/src/typed_ids.rs`：

```rust
// 核心 ID 类型
ConversationId   // conv_xxx
MessageId        // msg_xxx
WorkspaceId      // ws_xxx
ChatId           // chat_xxx
AgentId          // agent_xxx
SessionId        // sess_xxx
LockId           // lock_xxx
SnapshotId       // snap_xxx
PermissionId     // perm_xxx
DagId            // dag_xxx
TaskId           // task_xxx
CheckpointId     // ckpt_xxx
ProjectId        // proj_xxx
```

### 特性

每个类型实现了：
- ✅ `Display` / `FromStr` - 格式化/解析（`conv_123_001_0001`）
- ✅ `ToSql` / `FromSql` - SQLite 读写（存储为 i64）
- ✅ `Serialize` / `Deserialize` - JSON 序列化（字符串格式）
- ✅ `Hash` / `Eq` / `Copy` - 可用于 HashMap 键
- ✅ `From<i64>` / `Into<i64>` - 与 i64 互转

### 使用示例

```rust
use ergatai_error::ConversationId;

// 生成新 ID
let id = ConversationId::generate();

// 从 i64 创建
let id = ConversationId::new(12345);

// 获取原始 i64
let raw: i64 = id.as_i64();

// 格式化为字符串
let s: String = id.to_string();  // "conv_12345_001_0001"
let s: String = id.encode();     // 同上

// 从字符串解析
let id: ConversationId = "conv_12345_001_0001".parse()?;
let id = ConversationId::decode("conv_12345_001_0001")?;

// SQLite 查询
conn.execute(
    "SELECT * FROM conversations WHERE conversation_id = ?1",
    params![id],  // 直接传 ConversationId
)?;

// HashMap 键
let mut map: HashMap<ConversationId, AgentId> = HashMap::new();
map.insert(id, agent_id);

// JSON 序列化
let json = serde_json::to_string(&id)?;  // "\"conv_12345_001_0001\""
```

---

## 任务分配

### 你负责：核心表的强类型迁移

**范围：** 用户数据相关的核心表（`user_data.db`）

#### 1. conversations 表 ✅ 已完成 schema 修改

**文件：** `crates/ergatai-api/src/user_data_db.rs`

**改动点：**
```rust
// 结构体定义
pub struct Conversation {
    pub conversation_id: i64,  // ❌ 改为 ConversationId
    pub collaboration_session_id: i64,  // ❌ 改为 SessionId
    pub chat_id: i64,  // ❌ 改为 ChatId
    // ...
}

// CRUD 函数
pub fn get(conversation_id: i64) -> Result<Option<Conversation>> {  // ❌ 改为 ConversationId
pub fn create(mut conversation: Conversation) -> Result<Conversation> {
pub fn update(conversation: Conversation) -> Result<()> {
pub fn delete(conversation_id: i64) -> Result<bool> {  // ❌ 改为 ConversationId
```

**影响文件：**
- `crates/ergatai-api/src/services/conversation_service.rs`
- `crates/ergatai-api/src/api/chats.rs` (使用 conversation 的部分)
- `crates/ergatai-api/src/api/agents.rs` (使用 conversation 的部分)

#### 2. messages 表

**文件：** `crates/ergatai-api/src/user_data_db.rs`

**改动点：**
```rust
pub struct Message {
    pub message_id: i64,  // ❌ 改为 MessageId
    pub conversation_id: i64,  // ❌ 改为 ConversationId
    // ...
}
```

**影响文件：**
- `crates/ergatai-api/src/services/message_service.rs`
- `crates/ergatai-api/src/api/chats.rs` (使用 message 的部分)

#### 3. workspaces 表

**文件：** `crates/ergatai-api/src/user_data_db.rs`

**改动点：**
```rust
pub struct Workspace {
    pub workspace_id: i64,  // ❌ 改为 WorkspaceId
    pub default_project_id: Option<i64>,  // ❌ 改为 Option<ProjectId>
    // ...
}
```

**影响文件：**
- `crates/ergatai-api/src/services/workspace_service.rs`
- `crates/ergatai-api/src/api/workspaces.rs`

#### 4. chats 表

**文件：** `crates/ergatai-api/src/user_data_db.rs`

**改动点：**
```rust
pub struct Chat {
    pub chat_id: i64,  // ❌ 改为 ChatId
    pub workspace_id: i64,  // ❌ 改为 WorkspaceId
    // ...
}
```

**影响文件：**
- `crates/ergatai-api/src/services/chat_service.rs`
- `crates/ergatai-api/src/api/chats.rs`

#### 5. collaboration_sessions 表

**文件：** `crates/ergatai-api/src/user_data_db.rs`

**改动点：**
```rust
pub struct CollaborationSession {
    pub collaboration_session_id: i64,  // ❌ 改为 SessionId
    pub chat_id: i64,  // ❌ 改为 ChatId
    pub workspace_id: i64,  // ❌ 改为 WorkspaceId
    // ...
}
```

**影响文件：**
- `crates/ergatai-api/src/services/collaboration_session.rs`
- `crates/ergatai-api/src/api/collaboration_sessions.rs`

### 我负责：剩余部分

#### 1. Agent 相关

**文件：**
- `crates/ergatai-runtime/src/agent_record.rs`
- `crates/ergatai-runtime/src/types.rs`
- `crates/ergatai-core/src/unified_registry.rs`

**改动点：**
```rust
pub struct AgentRecord {
    pub agent_id: String,  // ❌ 改为 AgentId
    pub conversation_id: Option<String>,  // ❌ 改为 Option<ConversationId>
    pub workspace_id: String,  // ❌ 改为 WorkspaceId
    // ...
}

// Registry
conversation_id_to_agent_id: HashMap<String, String>  // ❌ 改为 HashMap<ConversationId, AgentId>
```

#### 2. NATS 事件

**文件：** `crates/ergatai-nats/src/events.rs`

**改动点：**
```rust
pub struct AgentMessagePayload {
    pub message_id: String,  // ❌ 改为 MessageId
    pub target_conversation_id: Option<String>,  // ❌ 改为 Option<ConversationId>
    // ...
}
```

#### 3. Lock 系统

**文件：** `crates/ergatai-lock/src/token.rs`

**改动点：**
```rust
pub struct TokenId(i64);  // ❌ 改用 LockId

pub struct SystemToken {
    pub token_id: TokenId,  // ❌ 改为 LockId
    pub workspace_id: i64,  // ❌ 改为 WorkspaceId
    // ...
}
```

#### 4. DAG 系统

**文件：**
- `crates/ergatai-collab/src/dag_scheduler.rs`
- `crates/ergatai-dag/src/dag_topology.rs`

**改动点：**
```rust
pub struct TaskGraph {
    pub dag_id: String,  // ❌ 改为 DagId
    // ...
}

pub struct TaskNode {
    pub task_id: String,  // ❌ 改为 TaskId
    // ...
}
```

---

## 迁移步骤（每个表）

### Step 1: 修改结构体定义

```rust
// 修改前
pub struct Conversation {
    pub conversation_id: i64,
    pub chat_id: i64,
}

// 修改后
use ergatai_error::{ConversationId, ChatId};

pub struct Conversation {
    pub conversation_id: ConversationId,
    pub chat_id: ChatId,
}
```

### Step 2: 修改 CRUD 函数

```rust
// 修改前
pub fn get(conversation_id: i64) -> Result<Option<Conversation>> {
    let conn = get_connection()?;
    let mut stmt = conn.prepare("SELECT ... WHERE conversation_id = ?1")?;
    stmt.query_row(params![conversation_id], ...)?;
}

// 修改后
pub fn get(conversation_id: ConversationId) -> Result<Option<Conversation>> {
    let conn = get_connection()?;
    let mut stmt = conn.prepare("SELECT ... WHERE conversation_id = ?1")?;
    stmt.query_row(params![conversation_id], ...)?;  // 直接传 ConversationId
}
```

### Step 3: 修改 Service 层

```rust
// 修改前
pub fn get_conversation(id: i64) -> Result<Conversation> {
    conversations::get(id)?
}

// 修改后
pub fn get_conversation(id: ConversationId) -> Result<Conversation> {
    conversations::get(id)?
}
```

### Step 4: 修改 API 层

```rust
// 修改前
async fn get_conversation(Path(id): Path<String>) -> impl IntoResponse {
    let id_i64 = parse_id_or_not_found(&id, "Conversation")?;
    let conv = conversation_service::get(id_i64)?;
    Json(format_conversation(conv))
}

// 修改后
async fn get_conversation(Path(id): Path<String>) -> impl IntoResponse {
    let id: ConversationId = id.parse()
        .map_err(|_| bad_request("Invalid conversation ID"))?;
    let conv = conversation_service::get(id)?;
    Json(conv)  // Conversation 实现了 Serialize
}
```

### Step 5: 编译测试

```bash
cargo check -p ergatai-api
cargo test -p ergatai-api --lib
```

---

## 注意事项

### 1. 向后兼容

**API 响应格式不变：**
```json
{
  "conversation_id": "conv_12345_001_0001",  // 仍然是字符串
  "chat_id": "chat_67890_002_0001"
}
```

**JSON 序列化自动处理：**
```rust
// ConversationId 实现了 Serialize
// 自动序列化为字符串格式
```

### 2. 数据库存储不变

**SQLite 仍然存储 i64：**
```rust
// ConversationId 实现了 ToSql/FromSql
// 自动转换为 i64 存储
```

### 3. 错误处理

**解析失败返回 400：**
```rust
let id: ConversationId = id_str.parse()
    .map_err(|e| bad_request(format!("Invalid conversation ID: {}", e)))?;
```

### 4. 渐进式迁移

**可以混合使用：**
```rust
// 迁移过程中，允许同时存在
let old_id: i64 = 12345;
let new_id: ConversationId = old_id.into();  // 转换

// 某些函数可以稍后迁移
fn legacy_fn(id: i64) { ... }
fn new_fn(id: ConversationId) { ... }
```

---

## 检查清单

每个表迁移完成后，验证：

- [ ] 结构体字段改为强类型
- [ ] CRUD 函数参数/返回值改为强类型
- [ ] Service 层函数签名更新
- [ ] API 层解析逻辑更新（使用 `.parse()`）
- [ ] 编译通过（`cargo check`）
- [ ] 测试通过（`cargo test`）
- [ ] API 响应格式不变（JSON 字符串）
- [ ] 数据库存储不变（i64）

---

## 时间估算

### 你负责的部分（核心表）

| 表 | 工作量 | 优先级 |
|----|--------|--------|
| conversations | 2-3 小时 | P0 |
| messages | 1-2 小时 | P0 |
| workspaces | 1-2 小时 | P1 |
| chats | 1-2 小时 | P1 |
| collaboration_sessions | 2-3 小时 | P1 |
| **总计** | **7-12 小时** | - |

### 我负责的部分（剩余）

| 模块 | 工作量 | 优先级 |
|------|--------|--------|
| Agent 相关 | 2-3 小时 | P2 |
| NATS 事件 | 1-2 小时 | P2 |
| Lock 系统 | 1-2 小时 | P2 |
| DAG 系统 | 2-3 小时 | P2 |
| **总计** | **6-10 小时** | - |

**总工作量：** 13-22 小时（约 2-3 天）

---

## 开始顺序建议

### 你（核心表）

1. **conversations** - 最核心，其他表依赖它
2. **messages** - 与 conversations 紧密相关
3. **workspaces** - 独立性强
4. **chats** - 依赖 workspaces
5. **collaboration_sessions** - 依赖多个表

### 我（剩余部分）

1. **Agent 相关** - Registry 是核心
2. **NATS 事件** - 消息系统
3. **Lock 系统** - 相对独立
4. **DAG 系统** - 相对独立

---

## 沟通机制

- 每完成一个表，提交 PR 并标注 `[ID Migration]`
- 遇到阻塞问题，立即沟通
- 保持 API 兼容性，避免破坏前端
- 定期同步进度

---

## 成功标准

- ✅ 所有核心表使用强类型 ID
- ✅ 编译通过，测试通过
- ✅ API 响应格式不变
- ✅ 数据库存储不变
- ✅ 类型安全提升（编译期检查）
- ✅ 代码质量提升（减少字符串操作）
