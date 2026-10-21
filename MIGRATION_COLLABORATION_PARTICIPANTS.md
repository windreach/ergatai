# 数据库迁移：collaboration_session_participants.conversation_id TEXT → INTEGER

## 迁移概述

**目标表：** `collaboration_session_participants`
**字段：** `conversation_id`
**变更：** `TEXT NOT NULL` → `INTEGER NOT NULL`
**原因：** 与 Snowflake ID 迁移保持一致，提升查询性能，支持外键约束

## 当前状态

检查数据库：
```bash
sqlite3 ~/.local/share/ergatai/user_data.db ".schema collaboration_session_participants"
```

如果看到 `conversation_id TEXT NOT NULL`，需要执行迁移。

## 迁移步骤

### 方案 A：直接重建表（推荐，表为空时）

如果表为空或可以接受数据丢失：

```sql
-- 1. 备份数据库（重要！）
cp ~/.local/share/ergatai/user_data.db ~/.local/share/ergatai/user_data.db.backup

-- 2. 执行迁移
sqlite3 ~/.local/share/ergatai/user_data.db << 'EOF'
BEGIN TRANSACTION;

-- 删除旧表
DROP TABLE IF EXISTS collaboration_session_participants;

-- 创建新表（conversation_id 改为 INTEGER，添加外键约束）
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

-- 重建索引
CREATE INDEX idx_collaboration_session_participants_session_id ON collaboration_session_participants(session_id);
CREATE INDEX idx_collaboration_session_participants_conversation_id ON collaboration_session_participants(conversation_id);
CREATE INDEX idx_collaboration_session_participants_agent_id ON collaboration_session_participants(agent_id);

COMMIT;
EOF

-- 3. 验证
sqlite3 ~/.local/share/ergatai/user_data.db ".schema collaboration_session_participants"
```

### 方案 B：保留数据的迁移（表有数据时）

如果表中有数据，需要转换 conversation_id：

```sql
-- 1. 备份数据库
cp ~/.local/share/ergatai/user_data.db ~/.local/share/ergatai/user_data.db.backup

-- 2. 检查数据格式
sqlite3 ~/.local/share/ergatai/user_data.db "SELECT conversation_id FROM collaboration_session_participants LIMIT 5;"

-- 预期输出：conv_1727568000001_001_0002 格式
-- 如果已经是数字格式，直接跳到方案 A

-- 3. 执行迁移（带数据转换）
sqlite3 ~/.local/share/ergatai/user_data.db << 'EOF'
BEGIN TRANSACTION;

-- 重命名旧表
ALTER TABLE collaboration_session_participants RENAME TO collaboration_session_participants_old;

-- 创建新表
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

-- 迁移数据（需要解析 conversation_id）
-- 注意：这里假设 conversation_id 是 conv_{timestamp}_{instance}_{sequence} 格式
-- 实际转换逻辑需要在应用层实现，或使用下面的简化版本
INSERT INTO collaboration_session_participants (
    id, session_id, conversation_id, agent_id, role, status, created_at, updated_at
)
SELECT 
    id,
    session_id,
    CAST(SUBSTR(conversation_id, 6) AS INTEGER), -- 简化：去掉 "conv_" 前缀，实际应该解析完整格式
    agent_id,
    role,
    status,
    created_at,
    updated_at
FROM collaboration_session_participants_old;

-- 重建索引
CREATE INDEX idx_collaboration_session_participants_session_id ON collaboration_session_participants(session_id);
CREATE INDEX idx_collaboration_session_participants_conversation_id ON collaboration_session_participants(conversation_id);
CREATE INDEX idx_collaboration_session_participants_agent_id ON collaboration_session_participants(agent_id);

-- 删除旧表
DROP TABLE collaboration_session_participants_old;

COMMIT;
EOF
```

**注意：** 上面的 SQL 中的 `SUBSTR` 只是简化示例，实际的 Snowflake ID 解析需要使用 `ergatai_error::id::parse_to_i64()` 函数。

**推荐做法：** 如果表中有重要数据，建议：
1. 导出数据到 JSON/CSV
2. 使用应用层代码转换 conversation_id
3. 重新导入

## 验证迁移

```bash
# 检查 schema
sqlite3 ~/.local/share/ergatai/user_data.db ".schema collaboration_session_participants"

# 应该看到：conversation_id INTEGER NOT NULL

# 检查外键约束
sqlite3 ~/.local/share/ergatai/user_data.db "PRAGMA foreign_key_list(collaboration_session_participants);"

# 应该看到两个外键：session_id 和 conversation_id

# 检查数据完整性
sqlite3 ~/.local/share/ergatai/user_data.db "SELECT COUNT(*) FROM collaboration_session_participants;"
```

## 回滚方案

如果迁移失败，从备份恢复：

```bash
cp ~/.local/share/ergatai/user_data.db.backup ~/.local/share/ergatai/user_data.db
```

## 相关代码变更

迁移后，以下代码已更新：
1. `crates/ergatai-api/src/user_data_db.rs` - Schema 定义
2. `crates/ergatai-api/src/services/collaboration_session.rs` - 数据访问层
   - `participant_from_row()` - 读取 i64 后 format_id
   - `insert_participant()` - 解析 String 到 i64
   - `add_participant()` - 查询时解析 String 到 i64

## 完成标准

- [x] Schema 改为 INTEGER
- [x] 添加外键约束到 conversations 表
- [x] 代码编译通过
- [ ] 迁移脚本已执行（如果有现有数据库）
- [ ] 验证通过

## 后续步骤

1. 运行迁移脚本（如果有现有数据库）
2. 重启应用，确保使用新 schema
3. 监控日志，确认无错误
4. 进行 Step 2：强类型替换（可选）
