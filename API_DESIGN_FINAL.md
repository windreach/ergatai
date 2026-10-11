# API 设计规范（最终版）

> 最后更新：2026-10-11

## 📋 设计原则

### 1. **扁平化**
- 每个资源独立，路径简洁
- 避免深层嵌套（最多 2 层）
- 通过查询参数过滤

### 2. **父级 ID 在 body**
- POST 创建时，父级 ID 放在请求体
- 统一风格，易于理解

### 3. **1:1 用单数，1:N 用复数**
- Agent 1:1 绑定 Conversation → `/agent` 单数
- Conversation 1:N 属于 Collaboration Session → `/conversations` 复数

### 4. **SSE 用 `/events`**
- 不叫 `/messages/sse`
- 更通用，包含状态、进度、错误等

### 5. **命名规范**
- 使用全称：`workspace_id`、`chat_id`、`conversation_id`
- 禁止简称：`id`、`ws_id`、`cov_id`
- 禁止独立使用 `session_id`，使用 `collaboration_session_id`

---

## 🎯 层次关系

```
Workspace（工作空间）← 最顶层容器
  ├─ Config（项目配置）← 属性，不是独立资源
  │
  └─ Chat（聊天）← 1:N
      └─ Collaboration Session（协作会话）← 1:N
          └─ Conversation（对话上下文）← 1:N
              ├─ Agent（1:1 绑定）
              └─ Messages（1:N）
```

**关系定义**：
- ✅ Workspace : Chat = 1:N
- ✅ Chat : Collaboration Session = 1:N
- ✅ Collaboration Session : Conversation = 1:N
- ✅ Conversation : Agent = 1:1
- ✅ Conversation : Messages = 1:N

---

## 🌐 完整 API 路由

### **Workspace（最顶层容器）**

```http
GET    /api/v1/workspaces
POST   /api/v1/workspaces
       Body: { "name": "...", "work_dir": "...", "env": {} }
GET    /api/v1/workspaces/{workspace_id}
PATCH  /api/v1/workspaces/{workspace_id}
DELETE /api/v1/workspaces/{workspace_id}

# Workspace 配置（项目配置）
GET    /api/v1/workspaces/{workspace_id}/config
PATCH  /api/v1/workspaces/{workspace_id}/config
       Body: { "projects": [{ "name": "...", "path": "...", "permissions": {...} }] }
DELETE /api/v1/workspaces/{workspace_id}/config
```

### **Chat（属于 Workspace，1:N）**

```http
# 列表（通过查询参数过滤）
GET    /api/v1/chats?workspace_id={workspace_id}

# 创建（扁平，父级 ID 在 body）
POST   /api/v1/chats
       Body: { "workspace_id": "...", "name": "..." }

# 单项操作
GET    /api/v1/chats/{chat_id}
PATCH  /api/v1/chats/{chat_id}
DELETE /api/v1/chats/{chat_id}
```

### **Collaboration Session（属于 Chat，1:N）**

```http
# 列表（通过查询参数过滤）
GET    /api/v1/collaboration-sessions?chat_id={chat_id}

# 创建（扁平，父级 ID 在 body）
POST   /api/v1/collaboration-sessions
       Body: { "chat_id": "...", "mode": "supervisor", "goal": "..." }

# 单项操作
GET    /api/v1/collaboration-sessions/{collaboration_session_id}
PATCH  /api/v1/collaboration-sessions/{collaboration_session_id}
DELETE /api/v1/collaboration-sessions/{collaboration_session_id}

# Session 状态
GET    /api/v1/collaboration-sessions/{collaboration_session_id}/status
GET    /api/v1/collaboration-sessions/{collaboration_session_id}/progress
```

### **Conversation（属于 Collaboration Session，1:N）**

```http
# 列表（通过查询参数过滤，支持多维度）
GET    /api/v1/conversations?collaboration_session_id={collaboration_session_id}
GET    /api/v1/conversations?chat_id={chat_id}

# 创建（扁平，父级 ID 在 body）
POST   /api/v1/conversations
       Body: { "collaboration_session_id": "...", "name": "...", "mode": "agent" }

# 单项操作
GET    /api/v1/conversations/{conversation_id}
PATCH  /api/v1/conversations/{conversation_id}
DELETE /api/v1/conversations/{conversation_id}

# 子对话（树形结构）
GET    /api/v1/conversations/{conversation_id}/children
POST   /api/v1/conversations/{conversation_id}/children
       Body: { "name": "...", "mode": "..." }
```

### **Conversation 的 Agent（1:1，单数路径）**

```http
# 获取/创建/删除绑定的 Agent
GET    /api/v1/conversations/{conversation_id}/agent
POST   /api/v1/conversations/{conversation_id}/agent
       Body: { "profile_name": "claude-code", ... }
DELETE /api/v1/conversations/{conversation_id}/agent

# Agent 操作（通过 Conversation 路径）
POST   /api/v1/conversations/{conversation_id}/agent/prompt
       Body: { "content": "...", "interrupt": false, "images": [] }

POST   /api/v1/conversations/{conversation_id}/agent/cancel

POST   /api/v1/conversations/{conversation_id}/agent/interrupt
       Body: { "content": "..." }
```

### **Message（属于 Conversation）**

```http
# 列表（通过查询参数过滤，支持多维度）
GET    /api/v1/messages?conversation_id={conversation_id}
GET    /api/v1/messages?collaboration_session_id={collaboration_session_id}
GET    /api/v1/messages?chat_id={chat_id}

# 创建（扁平，父级 ID 在 body）
POST   /api/v1/messages
       Body: { "conversation_id": "...", "role": "user", "content": "..." }

# 单项操作
GET    /api/v1/messages/{message_id}
PATCH  /api/v1/messages/{message_id}
DELETE /api/v1/messages/{message_id}
```

### **SSE / Events（实时事件流）**

```http
# Conversation 级别的事件流
GET    /api/v1/conversations/{conversation_id}/events

# Chat 级别的事件流（聚合所有 Conversation 的事件）
GET    /api/v1/chats/{chat_id}/events
```

### **Agent（批量查询 / 管理端点）**

```http
# 列表（通过查询参数过滤，支持多维度）
GET    /api/v1/agents?collaboration_session_id={collaboration_session_id}
GET    /api/v1/agents?chat_id={chat_id}

# 单项查询（调试/管理用）
GET    /api/v1/agents/{agent_id}
```

---

## 📊 数据模型

### **Workspace**

```sql
CREATE TABLE workspaces (
    workspace_id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    work_dir TEXT NOT NULL,
    env TEXT DEFAULT '{}',
    resources TEXT DEFAULT '{}',
    config TEXT DEFAULT '{}',  -- JSON：项目配置
    collaboration_mode TEXT NOT NULL DEFAULT 'supervisor',
    status TEXT NOT NULL DEFAULT 'active',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);
```

### **Chat**

```sql
CREATE TABLE chats (
    chat_id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    name TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    archived_at INTEGER,
    FOREIGN KEY (workspace_id) REFERENCES workspaces(workspace_id) ON DELETE CASCADE
);

CREATE INDEX idx_chats_workspace_id ON chats(workspace_id);
```

### **Collaboration Session**

```sql
CREATE TABLE collaboration_sessions (
    collaboration_session_id TEXT PRIMARY KEY,
    chat_id TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    mode TEXT NOT NULL CHECK (mode IN ('supervisor', 'group')),
    state TEXT NOT NULL CHECK (state IN (
        'idle', 'planning', 'executing', 'waiting_input',
        'waiting_approval', 'synthesizing', 'completed',
        'failed', 'cancelled'
    )),
    goal TEXT,
    active_plan_revision TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY (chat_id) REFERENCES chats(chat_id) ON DELETE CASCADE,
    FOREIGN KEY (workspace_id) REFERENCES workspaces(workspace_id) ON DELETE CASCADE
);

CREATE INDEX idx_collaboration_sessions_chat_id ON collaboration_sessions(chat_id);
CREATE INDEX idx_collaboration_sessions_workspace_id ON collaboration_sessions(workspace_id);
```

### **Conversation**

```sql
CREATE TABLE conversations (
    conversation_id TEXT PRIMARY KEY,
    collaboration_session_id TEXT NOT NULL,
    chat_id TEXT NOT NULL,
    parent_id TEXT,  -- 支持树形结构
    name TEXT,
    mode TEXT NOT NULL DEFAULT 'agent',
    participant_role TEXT NOT NULL DEFAULT 'peer',  -- 参与者角色：peer/supervisor/hub
    status TEXT NOT NULL DEFAULT 'ready',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY (collaboration_session_id) REFERENCES collaboration_sessions(collaboration_session_id) ON DELETE CASCADE,
    FOREIGN KEY (chat_id) REFERENCES chats(chat_id) ON DELETE CASCADE,
    FOREIGN KEY (parent_id) REFERENCES conversations(conversation_id) ON DELETE CASCADE
);

CREATE INDEX idx_conversations_collaboration_session_id ON conversations(collaboration_session_id);
CREATE INDEX idx_conversations_chat_id ON conversations(chat_id);
CREATE INDEX idx_conversations_parent_id ON conversations(parent_id);
```

### **Agent Session**

```sql
CREATE TABLE agent_sessions (
    agent_session_id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL UNIQUE,  -- 1:1 绑定
    acp_session_id TEXT,
    mode TEXT NOT NULL DEFAULT 'agent',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY (conversation_id) REFERENCES conversations(conversation_id) ON DELETE CASCADE
);
```

### **Message**

```sql
CREATE TABLE messages (
    message_id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    sequence INTEGER NOT NULL,
    role TEXT NOT NULL,
    parts TEXT NOT NULL,
    metadata TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY (conversation_id) REFERENCES conversations(conversation_id) ON DELETE CASCADE
);

CREATE INDEX idx_messages_conversation_id ON messages(conversation_id);
```

---

## 💡 前端调用示例

### **完整流程**

```typescript
// 1. 创建 Workspace
const workspace = await fetch('/api/v1/workspaces', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    name: 'My Workspace',
    work_dir: '/path/to/workspace'
  })
}).then(r => r.json());

// 2. 创建 Chat
const chat = await fetch('/api/v1/chats', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    workspace_id: workspace.workspace_id,
    name: 'Refactor Auth Module'
  })
}).then(r => r.json());

// 3. 创建 Collaboration Session
const collab = await fetch('/api/v1/collaboration-sessions', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    chat_id: chat.chat_id,
    mode: 'supervisor',
    goal: 'Refactor authentication module'
  })
}).then(r => r.json());

// 4. 创建 Conversation（参与者）
const conv = await fetch('/api/v1/conversations', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    collaboration_session_id: collab.collaboration_session_id,
    name: 'Agent A - Auth Service',
    mode: 'agent',
    participant_role: 'peer'
  })
}).then(r => r.json());

// 5. 启动 Agent（1:1 绑定）
const agent = await fetch(
  `/api/v1/conversations/${conv.conversation_id}/agent`,
  {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      profile_name: 'claude-code'
    })
  }
).then(r => r.json());

// 6. 发送消息
await fetch('/api/v1/messages', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    conversation_id: conv.conversation_id,
    role: 'user',
    content: 'Please refactor the auth service'
  })
});

// 7. 订阅事件流
const eventSource = new EventSource(
  `/api/v1/conversations/${conv.conversation_id}/events`
);

eventSource.onmessage = (event) => {
  const data = JSON.parse(event.data);
  console.log('Event:', data);
};

// 8. Agent 操作（发送 prompt）
await fetch(
  `/api/v1/conversations/${conv.conversation_id}/agent/prompt`,
  {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      content: 'Emergency: stop and review',
      interrupt: true
    })
  }
);

// 9. 查询 Chat 的所有消息
const messages = await fetch(
  `/api/v1/messages?chat_id=${chat.chat_id}`
).then(r => r.json());

// 10. 查询 Collaboration Session 的所有 Conversation
const conversations = await fetch(
  `/api/v1/conversations?collaboration_session_id=${collab.collaboration_session_id}`
).then(r => r.json());

// 11. 查询 Conversation 的 Agent（1:1，返回单个）
const agentInfo = await fetch(
  `/api/v1/conversations/${conv.conversation_id}/agent`
).then(r => r.json());

// 12. 取消 Agent 任务
await fetch(
  `/api/v1/conversations/${conv.conversation_id}/agent/cancel`,
  { method: 'POST' }
);

// 13. 在安全点插入消息
await fetch(
  `/api/v1/conversations/${conv.conversation_id}/agent/interrupt`,
  {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      content: 'Please prioritize this task'
    })
  }
);
```

---

## 🔑 关键设计决策

### **1. 扁平化 vs 嵌套**

**选择：扁平化**
- 列表：`/conversations?collaboration_session_id=xxx`
- 创建：`/conversations` + body 带父级 ID
- 单项：`/conversations/{conversation_id}`

**理由**：
- 路径简洁
- 易于维护
- 查询灵活

### **2. 1:1 关系用单数路径**

```http
# ✅ 正确
GET    /api/v1/conversations/{conversation_id}/agent
POST   /api/v1/conversations/{conversation_id}/agent
DELETE /api/v1/conversations/{conversation_id}/agent

# ❌ 错误
GET /api/v1/agents?conversation_id={conversation_id}
# 返回集合，不合理
```

### **3. SSE 用 `/events`**

```http
# ✅ 正确
GET /api/v1/conversations/{conversation_id}/events
GET /api/v1/chats/{chat_id}/events

# ❌ 错误
GET /api/v1/conversations/{conversation_id}/messages/sse
```

**理由**：
- 事件流不只有 message
- 包含状态、进度、错误等
- `/events` 更通用

### **4. 多维度查询**

```http
# Message 支持三种查询方式
GET /api/v1/messages?conversation_id={conversation_id}
GET /api/v1/messages?collaboration_session_id={collaboration_session_id}
GET /api/v1/messages?chat_id={chat_id}

# Agent 支持两种查询方式
GET /api/v1/agents?collaboration_session_id={collaboration_session_id}
GET /api/v1/agents?chat_id={chat_id}
```

**后端实现**：
```rust
async fn list_messages(
    Query(query): Query<MessageQuery>,
) -> impl IntoResponse {
    let messages = if let Some(conversation_id) = query.conversation_id {
        db.get_messages_by_conversation(&conversation_id).await?
    } else if let Some(collaboration_session_id) = query.collaboration_session_id {
        db.get_messages_by_collaboration_session(&collaboration_session_id).await?
    } else if let Some(chat_id) = query.chat_id {
        db.get_messages_by_chat(&chat_id).await?
    } else {
        return Err("至少需要一个查询参数".into());
    };
    
    Ok(Json(messages))
}
```

---

## ✅ 总结

**最终设计特点**：
- ✅ **扁平化**：每个资源独立，路径简洁
- ✅ **父级 ID 在 body**：POST 创建时统一风格
- ✅ **1:1 用单数**：Agent 1:1 绑定，语义清晰
- ✅ **1:N 用复数**：Conversation 1:N，支持批量
- ✅ **SSE 用 `/events`**：通用名称，不局限于 message
- ✅ **多维度查询**：支持多种过滤方式
- ✅ **命名规范**：使用全称，避免歧义

这套 API 设计已经定稿，可以用于实现。
