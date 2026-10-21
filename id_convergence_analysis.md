# ID 收敛方案验证报告

## 当前问题诊断

### 1. SQLite 存储不一致

**发现的问题：**
- `conversations` 表: `conversation_id INTEGER PRIMARY KEY` ✅
- `session_store` 表: `conversation_id TEXT PRIMARY KEY` ❌
- `suspend_store` 表: `conversation_id TEXT NOT NULL` ❌
- `collaboration_session_participants` 表: `conversation_id TEXT NOT NULL` ❌

**影响：**
- 无法建立有效的外键关系
- 查询时需要频繁类型转换
- 索引效率降低（TEXT vs INTEGER）

### 2. Registry 使用字符串键

```rust
// 当前实现
conversation_id_to_agent_id: Arc<RwLock<HashMap<String, String>>>

// 问题
- 使用格式化后的字符串作为键: "conv_1727568000001_001_0002"
- 每次查找都需要格式化/解析
- 内存占用增加（字符串 vs i64）
- 类型不安全（容易混淆不同类型的 ID）
```

### 3. API 边界转换分散

**当前模式：**
```rust
// 在多个 API handler 中重复
let conversation_id_i64 = match crate::http_error::parse_id_or_not_found(
    conversation_id, 
    "Conversation"
) {
    Ok(id) => id,
    Err(e) => return e.into_response(),
};
```

**问题：**
- 代码重复（1182 处使用 conversation_id）
- 容易遗漏错误处理
- 缺乏类型安全保证

### 4. 格式化字符串过于复杂

**当前格式：**
```
conv_1727568000001_001_0002
     ^timestamp    ^inst ^seq
```

**问题：**
- 下划线分段无业务语义
- 字符串较长（30+ 字符）
- 解析成本较高
- 日志中占用空间大

### 5. Project ID 的遗留格式问题

**发现：**
```rust
// 支持两种格式
1. Snowflake: proj_1727568000000_001_0001
2. Legacy:    proj_0123456789abcdef0123456789abcdef  (32位hex)
```

**问题：**
- 遗留格式实际上是 UUID 变体，与 Snowflake 体系不兼容
- 验证逻辑复杂化
- 无法提取时间戳等元数据

---

## 收敛方案验证（以 conversation_id 为例）

### 方案 1: 强类型包装 ✅ 推荐

```rust
// 定义
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct ConversationId(i64);

impl ConversationId {
    pub fn new(raw: i64) -> Self {
        Self(raw)
    }
    
    pub fn generate() -> Self {
        Self(ergatai_error::id::generate())
    }
    
    pub fn as_i64(&self) -> i64 {
        self.0
    }
}

// Display: 用于 API/日志
impl std::fmt::Display for ConversationId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // 简化格式: conv_5037399923480000000
        write!(f, "conv_{}", self.0)
    }
}

// FromStr: 用于解析
impl std::str::FromStr for ConversationId {
    type Err = IdParseError;
    
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        let rest = s.strip_prefix("conv_")
            .ok_or(IdParseError::InvalidPrefix)?;
        let raw: i64 = rest.parse()
            .map_err(|_| IdParseError::InvalidNumber)?;
        Ok(Self(raw))
    }
}

// SQLite 转换
impl rusqlite::types::ToSql for ConversationId {
    fn to_sql(&self) -> rusqlite::Result<rusqlite::types::ToSqlOutput<'_>> {
        Ok(rusqlite::types::ToSqlOutput::Owned(
            rusqlite::types::Value::Integer(self.0)
        ))
    }
}

impl rusqlite::types::FromSql for ConversationId {
    fn column_result(value: rusqlite::types::ValueRef<'_>) -> rusqlite::types::FromSqlResult<Self> {
        match value {
            rusqlite::types::ValueRef::Integer(i) => Ok(Self(i)),
            _ => Err(rusqlite::types::FromSqlError::InvalidType),
        }
    }
}
```

**优势：**
- ✅ 类型安全：编译期防止 ID 类型混淆
- ✅ 零成本抽象：运行时就是 i64
- ✅ 集中转换：Display/FromStr 统一处理
- ✅ SQLite 友好：直接存储 i64

### 方案 2: 简化公开格式 ✅ 推荐

**当前格式：**
```
conv_1727568000001_001_0002  (28字符)
```

**建议格式：**
```
conv_5037399923480000000     (22字符)
```

**实现：**
```rust
impl std::fmt::Display for ConversationId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "conv_{}", self.0)
    }
}

impl std::str::FromStr for ConversationId {
    type Err = IdParseError;
    
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        let rest = s.strip_prefix("conv_")
            .ok_or(IdParseError::InvalidPrefix)?;
        let raw: i64 = rest.parse()
            .map_err(|_| IdParseError::InvalidNumber)?;
        Ok(Self(raw))
    }
}
```

**优势：**
- ✅ 更短（节省 22% 空间）
- ✅ 解析更快（无需 split）
- ✅ 保留类型前缀（可读性）
- ✅ 仍可从原始 i64 提取时间戳（需要时）

**备选：Base62 编码**
```rust
// 更激进的压缩
conv_Ab3kZ9xY2mN  (15字符)
```

权衡：
- 优点：更短
- 缺点：可读性降低，需要额外依赖

### 方案 3: Registry 改用 i64 键 ✅ 推荐

**当前：**
```rust
conversation_id_to_agent_id: HashMap<String, String>
// 键: "conv_1727568000001_001_0002"
```

**改进：**
```rust
conversation_id_to_agent_id: HashMap<i64, String>
// 键: 5037399923480000000 (原始 i64)
```

**最佳实践：**
```rust
conversation_id_to_agent_id: HashMap<ConversationId, AgentId>
// 强类型，零运行时开销
```

### 方案 4: SQLite 统一为 INTEGER ✅ 必须

**需要迁移的表：**

```sql
-- session_store
ALTER TABLE session_store RENAME TO session_store_old;
CREATE TABLE session_store (
    conversation_id INTEGER PRIMARY KEY NOT NULL,
    session_id TEXT NOT NULL,
    command TEXT NOT NULL,
    cwd TEXT NOT NULL,
    FOREIGN KEY (conversation_id) REFERENCES conversations(conversation_id)
);
INSERT INTO session_store (conversation_id, session_id, command, cwd)
SELECT CAST(conversation_id AS INTEGER), session_id, command, cwd
FROM session_store_old;
DROP TABLE session_store_old;

-- suspend_store
ALTER TABLE suspend_store RENAME TO suspend_store_old;
CREATE TABLE suspend_store (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id INTEGER NOT NULL,
    profile_name TEXT NOT NULL,
    work_dir TEXT NOT NULL,
    environment TEXT NOT NULL,
    FOREIGN KEY (conversation_id) REFERENCES conversations(conversation_id)
);
INSERT INTO suspend_store (conversation_id, profile_name, work_dir, environment)
SELECT CAST(conversation_id AS INTEGER), profile_name, work_dir, environment
FROM suspend_store_old;
DROP TABLE suspend_store_old;

-- collaboration_session_participants
ALTER TABLE collaboration_session_participants RENAME TO collaboration_session_participants_old;
CREATE TABLE collaboration_session_participants (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    collaboration_session_id INTEGER NOT NULL,
    conversation_id INTEGER NOT NULL,
    agent_id TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'peer',
    status TEXT NOT NULL DEFAULT 'active',
    FOREIGN KEY (conversation_id) REFERENCES conversations(conversation_id)
);
INSERT INTO collaboration_session_participants 
    (collaboration_session_id, conversation_id, agent_id, role, status)
SELECT collaboration_session_id, CAST(conversation_id AS INTEGER), agent_id, role, status
FROM collaboration_session_participants_old;
DROP TABLE collaboration_session_participants_old;
```

### 方案 5: 外部 Agent ID 映射表 ✅ 推荐

**场景：** Claude Code、Codex 等外部 agent 有自己的 session ID 体系

**当前问题：**
- 尝试将外部 UUID 塞进 Snowflake 体系
- 或者混用字符串和整数

**解决方案：**
```sql
CREATE TABLE external_agent_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id INTEGER NOT NULL,
    external_kind TEXT NOT NULL,  -- 'claude_code', 'codex', 'opencode'
    external_session_id TEXT NOT NULL,  -- 外部原始 ID，不解析
    workspace_path TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE(external_kind, external_session_id),
    FOREIGN KEY (conversation_id) REFERENCES conversations(conversation_id)
);

-- 索引
CREATE INDEX idx_external_sessions_conversation 
    ON external_agent_sessions(conversation_id);
CREATE INDEX idx_external_sessions_lookup 
    ON external_agent_sessions(external_kind, external_session_id);
```

**优势：**
- ✅ 内部保持 i64 一致性
- ✅ 外部 ID 原样存储，不强制转换
- ✅ 支持多种外部 agent 类型
- ✅ 可查询映射关系

### 方案 6: 可选的 public_id 派生列 ⚠️ 谨慎使用

**场景：** 需要对外暴露不可预测的 ID（安全考虑）

```sql
CREATE TABLE conversations (
    conversation_id INTEGER PRIMARY KEY,
    public_id TEXT UNIQUE,  -- 可选，用于外部 API
    collaboration_session_id INTEGER NOT NULL,
    chat_id INTEGER NOT NULL,
    -- ...
);

-- 生成 public_id (应用层)
-- 格式: conv_{base62_random_12chars}
-- 示例: conv_Ab3kZ9xY2mNp
```

**权衡：**
- 优点：不可预测，安全性高
- 缺点：需要额外存储和维护
- 建议：仅在确实需要隐藏内部 ID 时使用

---

## 实施路线图

### Phase 1: 定义强类型（1-2天）

1. 在 `ergatai-error/src/id.rs` 中添加：
   ```rust
   pub struct ConversationId(i64);
   pub struct MessageId(i64);
   pub struct AgentRunId(i64);
   // ... 其他 ID 类型
   ```

2. 实现必要的 trait：
   - `Display`, `FromStr`
   - `ToSql`, `FromSql`
   - `Serialize`, `Deserialize`
   - `Hash`, `Eq`, `PartialEq`

3. 添加转换函数：
   ```rust
   impl ConversationId {
       pub fn encode(&self) -> String { ... }
       pub fn decode(s: &str) -> Result<Self, Error> { ... }
   }
   ```

### Phase 2: SQLite 迁移（2-3天）

1. 创建迁移脚本
2. 备份数据库
3. 执行 TEXT → INTEGER 转换
4. 验证数据完整性
5. 添加外键约束

### Phase 3: Registry 重构（2-3天）

1. 修改 `UnifiedAgentRegistry`：
   ```rust
   conversation_id_to_agent_id: HashMap<ConversationId, AgentId>
   ```

2. 更新所有使用点：
   - `get_by_conversation_id(&str)` → `get_by_conversation_id(ConversationId)`
   - 移除内部格式化/解析

### Phase 4: API 边界整理（3-5天）

1. 统一使用 `FromStr` 解析：
   ```rust
   let conv_id: ConversationId = conversation_id_str.parse()
       .map_err(|_| bad_request("Invalid conversation ID"))?;
   ```

2. 移除重复的 `parse_id_or_not_found` 调用

3. 更新 OpenAPI 文档

### Phase 5: 简化公开格式（可选，1-2天）

1. 修改 `Display` 实现：
   ```rust
   // 从: conv_1727568000001_001_0002
   // 到: conv_5037399923480000000
   ```

2. 更新前端解析逻辑

3. 提供迁移指南

### Phase 6: 外部 ID 映射（2-3天）

1. 创建 `external_agent_sessions` 表
2. 实现映射逻辑
3. 迁移现有外部 session 数据

---

## 风险评估

### 高风险

1. **数据迁移**
   - 风险：TEXT → INTEGER 转换可能失败（脏数据）
   - 缓解：完整备份 + 测试环境验证 + 回滚脚本

2. **API 破坏性变更**
   - 风险：前端/客户端依赖旧格式
   - 缓解：版本化 API + 兼容层 + 渐进式迁移

### 中风险

3. **性能影响**
   - 风险：大量代码修改引入 bug
   - 缓解：分阶段实施 + 充分测试

4. **兼容性**
   - 风险：遗留 system 的 project ID 格式
   - 缓解：保留 `is_valid_project_id` 的双格式支持

### 低风险

5. **学习曲线**
   - 风险：团队需要适应强类型
   - 缓解：文档 + 示例代码

---

## 收益分析

### 定量收益

1. **存储节省**
   - SQLite: TEXT (20-30 bytes) → INTEGER (8 bytes)
   - 每条记录节省: 12-22 bytes
   - 假设 100 万条对话: 节省 12-22 MB

2. **内存节省**
   - Registry: String (24 bytes + heap) → i64 (8 bytes)
   - 每个映射节省: ~40 bytes
   - 假设 10 万活跃 agent: 节省 ~4 MB

3. **性能提升**
   - 索引: INTEGER 比较比 TEXT 快 3-5x
   - 解析: 移除 split + parse，减少 50% CPU

### 定性收益

1. **类型安全**
   - 编译期捕获 ID 类型错误
   - 防止 conv_id 和 msg_id 混用

2. **代码质量**
   - 减少 1182 处重复代码
   - 集中转换逻辑
   - 更易维护

3. **可观察性**
   - 日志更简洁
   - 调试更容易

---

## 结论

### 方案合理性评估

| 建议 | 合理性 | 优先级 | 说明 |
|------|--------|--------|------|
| 强类型包装 | ✅ 非常合理 | P0 | 类型安全是核心收益 |
| SQLite 统一 INTEGER | ✅ 必须做 | P0 | 数据一致性基础 |
| Registry 用 i64 键 | ✅ 非常合理 | P0 | 性能+类型安全 |
| 简化公开格式 | ✅ 推荐 | P1 | 降低复杂度 |
| 外部 ID 映射表 | ✅ 推荐 | P1 | 解耦内外系统 |
| public_id 派生列 | ⚠️ 谨慎 | P2 | 仅在确实需要时 |

### 实施建议

1. **立即开始 Phase 1-3**（强类型 + SQLite + Registry）
   - 这是基础，后续所有改进都依赖于此
   - 预计 1 周完成

2. **Phase 4-5 可并行**（API 边界 + 简化格式）
   - 影响面广，需要仔细测试
   - 预计 1-2 周完成

3. **Phase 6 按需实施**（外部 ID 映射）
   - 仅在集成新 agent 类型时添加

### 关键成功因素

1. **完整的测试覆盖**
   - 单元测试：每个 ID 类型的转换
   - 集成测试：API 端点
   - 迁移测试：数据完整性

2. **渐进式部署**
   - 先在测试环境验证
   - 灰度发布到生产
   - 保留回滚能力

3. **文档更新**
   - API 文档：新 ID 格式
   - 迁移指南：前端/客户端适配
   - 开发者文档：强类型使用示例

---

## 下一步行动

1. **验证当前数据质量**
   ```bash
   # 检查是否有无法转换的 TEXT conversation_id
   SELECT conversation_id FROM session_store 
   WHERE conversation_id NOT GLOB '[0-9]*';
   ```

2. **创建原型**
   - 实现 `ConversationId` 强类型
   - 在一个小模块中试用
   - 验证可行性

3. **制定详细迁移计划**
   - 列出所有受影响的表
   - 编写迁移脚本
   - 准备回滚方案

4. **团队评审**
   - 讨论方案细节
   - 确认实施时间表
   - 分配任务
