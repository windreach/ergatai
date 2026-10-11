# 服务层和模型层重构计划

## 目标

根据 API_DESIGN_FINAL.md 重构数据模型和服务层，实现：
1. 统一的数据模型（使用全称 ID）
2. 清晰的服务层封装
3. 正确的关联关系
4. 级联操作支持

## 数据模型重构

### 1. Workspace（添加 config 字段）
```rust
pub struct Workspace {
    pub workspace_id: String,  // ✅ 改名为 workspace_id
    pub name: String,
    pub work_dir: String,
    pub env: String,
    pub resources: String,
    pub config: String,  // ✅ 新增：项目配置 JSON
    pub collaboration_mode: String,
    pub status: String,
    pub created_at: i64,
    pub updated_at: i64,
}
```

### 2. Chat（简化）
```rust
pub struct Chat {
    pub chat_id: String,  // ✅ 改名为 chat_id
    pub workspace_id: String,  // ✅ 必填
    pub name: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
    pub archived_at: Option<i64>,
}
```

### 3. CollaborationSession（已有，需要调整）
```rust
pub struct CollaborationSession {
    pub collaboration_session_id: String,  // ✅ 全称
    pub chat_id: String,
    pub workspace_id: String,
    pub mode: String,
    pub state: String,
    pub goal: Option<String>,
    pub active_plan_revision: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}
```

### 4. Conversation（添加 participant_role, status）
```rust
pub struct Conversation {
    pub conversation_id: String,  // ✅ 全称
    pub collaboration_session_id: String,  // ✅ 必填
    pub chat_id: String,  // ✅ 必填（冗余但便于查询）
    pub parent_id: Option<String>,
    pub name: Option<String>,
    pub mode: String,
    pub participant_role: String,  // ✅ 新增：peer/supervisor/hub
    pub status: String,  // ✅ 新增：ready/busy/idle
    pub created_at: i64,
    pub updated_at: i64,
}
```

### 5. AgentSession（1:1 绑定）
```rust
pub struct AgentSession {
    pub agent_session_id: String,  // ✅ 独立 ID
    pub conversation_id: String,  // ✅ 1:1 绑定
    pub acp_session_id: Option<String>,
    pub mode: String,
    pub created_at: i64,
    pub updated_at: i64,
}
```

### 6. Message（保持不变）
```rust
pub struct Message {
    pub message_id: String,  // ✅ 改名为 message_id
    pub conversation_id: String,
    pub sequence: i64,
    pub role: String,
    pub parts: String,
    pub metadata: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}
```

## 服务层重构

### WorkspaceService
- create_workspace()
- get_workspace()
- list_workspaces()
- update_workspace()
- delete_workspace() - 级联删除 Chat
- update_config()

### ChatService
- create_chat()
- get_chat()
- list_chats(workspace_id)
- update_chat()
- delete_chat() - 级联删除 CollaborationSession, Conversation
- archive_chat()
- unarchive_chat()

### CollaborationSessionService
- create_session()
- get_session()
- list_sessions(chat_id)
- update_session()
- delete_session() - 级联删除 Conversation
- update_state()

### ConversationService
- create_conversation()
- get_conversation()
- list_conversations(collaboration_session_id)
- list_conversations_by_chat(chat_id)
- update_conversation()
- delete_conversation() - 级联删除 Agent, Message
- list_children(conversation_id)
- create_child()

### AgentService（增强）
- get_agent_by_conversation(conversation_id)
- create_agent(conversation_id, profile)
- delete_agent(conversation_id)
- list_agents(collaboration_session_id)
- list_agents_by_chat(chat_id)

### MessageService
- create_message()
- get_message()
- list_messages_by_conversation(conversation_id)
- list_messages_by_collaboration_session(collaboration_session_id)
- list_messages_by_chat(chat_id)
- update_message()
- delete_message()

## 实施步骤

### Phase 1: 数据模型重构
1. 修改 user_data_db.rs 中的结构体定义
2. 添加数据库迁移脚本
3. 更新所有 CRUD 操作
4. 运行测试确保兼容

### Phase 2: 服务层实现
1. 创建新的服务模块
2. 实现业务逻辑
3. 实现多维度查询
4. 实现级联操作

### Phase 3: Handler 层适配
1. 更新 API handler 使用新的服务层
2. 更新路由定义
3. 测试 API 接口

### Phase 4: 测试和验证
1. 单元测试
2. 集成测试
3. API 测试

## 关键设计决策

1. **使用全称 ID**：workspace_id, chat_id, conversation_id
2. **冗余字段**：Conversation 同时保存 collaboration_session_id 和 chat_id（便于查询）
3. **级联删除**：通过服务层实现，不在数据库层使用 CASCADE
4. **多维度查询**：Message 支持按 conversation_id, collaboration_session_id, chat_id 查询

## 风险和缓解

1. **数据迁移**：需要迁移脚本将旧的 id 字段改为全称
2. **向后兼容**：保留旧的访问方法，添加新的全称方法
3. **测试覆盖**：确保所有测试通过
