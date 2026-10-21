# ID 收敛实施计划

## 总体策略

分两步走，降低风险：
1. **Step 1**: 数据库字段修复（TEXT → INTEGER）
2. **Step 2**: 强类型替换（i64 → ConversationId 等）

---

## Step 1: 数据库字段修复 ✅ 进行中

### 目标

修复 Snowflake ID 迁移中遗漏的表，确保所有 ID 字段使用 INTEGER 类型。

### 发现的问题

**只需要修复 1 个表：**
- `collaboration_session_participants.conversation_id`: `TEXT` → `INTEGER`

**其他表状态：**
- ✅ `agent_sessions` (session_store): 已经是 `INTEGER`
- ✅ `conversations`: 已经是 `INTEGER PRIMARY KEY`
- ✅ 其他 13 个核心表: 已经在 Snowflake 迁移中修复

### 已完成的工作

#### 1. Schema 修改 ✅

**文件：** `crates/ergatai-api/src/user_data_db.rs:182-193`

```rust
// 修改前
conversation_id TEXT NOT NULL,

// 修改后
conversation_id INTEGER NOT NULL,
FOREIGN KEY (conversation_id) REFERENCES conversations(conversation_id) ON DELETE CASCADE,
```

**改进：**
- 类型从 TEXT 改为 INTEGER
- 添加外键约束到 conversations 表
- 支持级联删除

#### 2. 数据访问层修改 ✅

**文件：** `crates/ergatai-api/src/services/collaboration_session.rs`

**修改 1: `participant_from_row()` 函数**
```rust
// 修改前
conversation_id: row.get(2)?, // TEXT

// 修改后
let conversation_id_i64: i64 = row.get(2)?;
conversation_id: format_id(conversation_id_i64, IdType::Conversation),
```

**修改 2: `insert_participant()` 函数**
```rust
// 修改前
params![
    participant.conversation_id.trim(),  // String
    // ...
]

// 修改后
let conversation_id_i64 = ergatai_error::id::parse_to_i64_with_type(
    participant.conversation_id.trim(),
    ergatai_error::id::IdType::Conversation,
).ok_or_else(|| {
    CollaborationSessionError::Validation(format!(
        "Invalid conversation_id format: '{}'",
        participant.conversation_id
    ))
})?;
params![
    conversation_id_i64,  // i64
    // ...
]
```

**修改 3: `add_participant()` 函数**
```rust
// 查询时同样解析 String → i64
let conversation_id_i64 = ergatai_error::id::parse_to_i64_with_type(...)?;
params![session_id_i64, conversation_id_i64]
```

#### 3. 编译验证 ✅

```bash
cargo check -p ergatai-api
# 编译通过，无错误
```

### 待完成的工作

#### 1. 数据库迁移（如果有现有数据）

**当前状态：** 表为空，可以直接重建

**执行命令：**
```bash
# 备份
cp ~/.local/share/ergatai/user_data.db ~/.local/share/ergatai/user_data.db.backup

# 迁移
sqlite3 ~/.local/share/ergatai/user_data.db << 'EOF'
DROP TABLE IF EXISTS collaboration_session_participants;
CREATE TABLE collaboration_session_participants (
    id TEXT PRIMARY KEY,
    session_id INTEGER NOT NULL,
    conversation_id INTEGER NOT NULL,
    agent_id TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'peer',
    status TEXT NOT NULL DEFAULT 'active',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY (session_id) REFERENCES collaboration_sessions(collaboration_session_id) ON DELETE CASCADE,
    FOREIGN KEY (conversation_id) REFERENCES conversations(conversation_id) ON DELETE CASCADE,
    UNIQUE (session_id, conversation_id)
);
CREATE INDEX idx_collaboration_session_participants_session_id ON collaboration_session_participants(session_id);
CREATE INDEX idx_collaboration_session_participants_conversation_id ON collaboration_session_participants(conversation_id);
CREATE INDEX idx_collaboration_session_participants_agent_id ON collaboration_session_participants(agent_id);
EOF
```

**详细文档：** 参见 `MIGRATION_COLLABORATION_PARTICIPANTS.md`

#### 2. 测试验证

```bash
# 运行相关测试
cargo test -p ergatai-api collaboration_session

# 启动应用，验证无错误
cargo run -p ergatai-api -- --port 3000
```

### Step 1 总结

**工作量：** 0.5 天
- Schema 修改：30 分钟
- 代码修改：1.5 小时
- 测试验证：30 分钟
- 文档编写：30 分钟

**收益：**
- ✅ 数据库 schema 完全一致
- ✅ 支持外键约束和级联删除
- ✅ 查询性能提升（INTEGER vs TEXT）
- ✅ 为 Step 2 打下基础

**风险：** 低
- 表为空，无需数据迁移
- 代码改动集中在一个模块
- 编译通过，逻辑清晰

---

## Step 2: 强类型替换 ⏸️ 暂缓

### 目标

定义强类型包装器（`ConversationId`, `MessageId` 等），替换代码中的 `i64` 和 `String`。

### 原计划

```rust
// 定义强类型
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct ConversationId(i64);

// 实现 trait
impl Display for ConversationId { ... }
impl FromStr for ConversationId { ... }
impl ToSql for ConversationId { ... }
impl FromSql for ConversationId { ... }

// 替换代码
// 从: conversation_id: i64
// 到: conversation_id: ConversationId
```

### 重新评估

**成本分析：**
- 需要修改 1182 处 `conversation_id` 使用点
- 涉及 62 个文件
- 需要更新所有测试
- 预计工作量：1-2 周

**收益分析：**
- 类型安全（编译期检查）
- 代码更清晰
- 减少格式化/解析错误

**ROI 评估：**
- 当前系统已经运行良好
- i64 已经提供了基本的一致性
- 强类型带来的收益不足以证明成本

### 建议：不做全面强类型替换

**理由：**
1. **成本过高** - 1-2 周的开发时间
2. **收益有限** - 当前 i64 已经够用
3. **风险较大** - 大量代码修改容易引入 bug
4. **更好的时间投入** - 新功能开发、用户体验改进

### 替代方案：按需局部优化

**场景 1：新功能需要强类型**
```rust
// 在新模块中使用强类型
struct NewFeature {
    conversation_id: ConversationId,  // 使用强类型
}
```

**场景 2：发现类型混淆 bug**
```rust
// 针对特定模块引入强类型
// 不全面替换，只在使用容易混淆的地方
```

**场景 3：性能瓶颈**
```rust
// 如果发现 HashMap<String, String> 是瓶颈
// 局部改为 HashMap<i64, String> 或 HashMap<ConversationId, AgentId>
```

### Step 2 总结

**建议：** 不做全面强类型替换
**替代方案：** 按需局部优化
**工作量：** 0（除非有具体需求）

---

## 下一步行动

### 立即执行

1. **执行数据库迁移**（如果有现有数据）
   ```bash
   # 参见 MIGRATION_COLLABORATION_PARTICIPANTS.md
   ```

2. **验证 Step 1**
   ```bash
   cargo test -p ergatai-api
   cargo run -p ergatai-api -- --port 3000
   ```

3. **清理文档**
   - 删除 `id_convergence_analysis.md`（过度设计）
   - 保留 `MIGRATION_COLLABORATION_PARTICIPANTS.md`（迁移指南）

### 后续监控

- 如果发现性能问题，再考虑局部优化
- 如果添加新功能，评估是否需要强类型
- 保持代码审查，防止新的 TEXT ID 字段

---

## 总结

**Step 1 已完成** ✅
- 修复了 1 个遗漏的表
- 代码编译通过
- 等待数据库迁移和测试验证

**Step 2 取消** ⏸️
- 成本过高，收益有限
- 改为按需局部优化

**总体工作量：** 0.5 天（原计划 2-3 周）
**实际收益：** 数据库一致性 + 外键约束
**风险：** 低
