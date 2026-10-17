# Agent 间会话管理实现计划

## 目标
实现 agent-to-agent 通信时的会话复用逻辑：
- 同一 chat 内，agent 呼唤另一个 agent 时复用已存在的 agent 实例
- 只有当 agent 明确要求新会话时，才 spawn 新的 agent
- 提供清晰的 backend API 和 frontend 集成点

## 当前状态
- ✅ User → Agent 通信已通过 binding 机制实现复用
- ❌ Agent → Agent 通信完全由后端处理，前端无法控制
- ❌ 缺少显式创建新 session 的接口

## 实现计划

### Phase 1: Backend API 设计

#### 1.1 查询 chat 绑定的 agents
**接口**：`GET /api/v1/chats/:chatId/agents`

**Response**：
```json
{
  "agents": [
    {
      "agent_id": "abc123",
      "command": "claude",
      "status": "alive",
      "bound_at": "2024-01-01T00:00:00Z"
    }
  ]
}
```

**用途**：Agent A 调用 Agent B 时，后端先查询此接口确定 B 是否已存在

#### 1.2 Agent 间消息路由增强
**现有接口**：`POST /api/v1/agents/:agentId/message`

**增强逻辑**：
当收到 agent-to-agent 消息时（通过 `from` 字段识别）：
```
1. 解析 target_agent_id（从消息内容或专门的字段）
2. 查询 chat 绑定的 agents
3. 如果 target_agent 已绑定且存活 → 直接路由
4. 如果 target_agent 未绑定或已死亡 → spawn 新 agent 并绑定
5. 如果消息包含 `force_new_session: true` → 强制 spawn 新 agent（不绑定到当前 chat）
```

**新增字段**（在 message body 中）：
```json
{
  "message": "...",
  "from": "agent_a_id",
  "target_agent_command": "claude",  // 指定要调用的 agent 类型
  "force_new_session": false,         // 是否强制新会话
  "correlation_id": "conv_123"        // 对话关联 ID
}
```

#### 1.3 显式创建新 session
**接口**：`POST /api/v1/agents/:agentId/spawn-session`

**Request**：
```json
{
  "target_command": "claude",
  "reason": "explicit_request" | "context_overflow" | "task_separation",
  "inherit_context": false,
  "workspace_id": "chat_xyz"
}
```

**Response**：
```json
{
  "new_session_id": "session_456",
  "new_agent_id": "def789",
  "message": "New session created for task separation"
}
```

**用途**：当 agent 明确要求新会话时调用（如上下文溢出、任务分离）

### Phase 2: Frontend 集成

#### 2.1 扩展 binding 查询接口
**tRPC Router**：`src/main/lib/trpc/routers/ergatai.ts`

```typescript
// 新增：查询 chat 的所有绑定 agents
getChatAgents: publicProcedure
  .input(z.object({ chatId: z.string() }))
  .query(async ({ input }) => {
    return ergataiFetch(`/api/v1/chats/${input.chatId}/agents`)
  })
```

#### 2.2 增强 sendMessage 接口
**现有接口**：`ergatai.ts` 第 346 行

**新增可选参数**：
```typescript
sendMessage: publicProcedure
  .input(z.object({
    agentId: z.string(),
    message: z.string(),
    from: z.string().optional(),
    messageType: z.enum(["request", "response", "broadcast"]).optional(),
    correlationId: z.string().optional(),
    // 新增
    targetAgentCommand: z.string().optional(),  // agent-to-agent 调用
    forceNewSession: z.boolean().optional(),    // 强制新会话
  }))
```

#### 2.3 Agent Manager 增加辅助方法
**文件**：`src/renderer/features/agents/lib/ergatai-agent-manager.ts`

```typescript
/**
 * 获取 chat 绑定的所有 agents
 */
export async function getChatAgents(chatId: string): Promise<ChatAgent[]> {
  return trpcClient.ergatai.getChatAgents.query({ chatId })
}

/**
 * Agent 间通信：智能路由
 * 由后端决定复用还是新建
 */
export async function sendAgentToAgentMessage(
  fromAgentId: string,
  targetAgentCommand: string,
  message: string,
  options: {
    forceNewSession?: boolean
    correlationId?: string
  } = {}
): Promise<{ targetAgentId: string; sessionId: string }> {
  const result = await trpcClient.ergatai.sendMessage.mutate({
    agentId: fromAgentId,
    message,
    from: fromAgentId,
    messageType: "request",
    targetAgentCommand,
    forceNewSession: options.forceNewSession,
    correlationId: options.correlationId,
  })
  
  return {
    targetAgentId: result.target_agent_id,
    sessionId: result.session_id,
  }
}
```

### Phase 3: 工具集成

#### 3.1 修改 GroupAgentMentionTool 的执行逻辑
**当前状态**：Tool 只是 UI 展示，实际执行在后端

**需要确认**：当 agent 使用 `send_message` tool 时，backend 如何处理？

**预期流程**：
1. Agent A 调用 `send_message(target_agent_id="claude", message="...")`
2. Backend 拦截这个 tool call
3. Backend 查询 chat 绑定的 agents
4. 如果 claude agent 已存在 → 路由到现有实例
5. 如果不存在 → spawn 新 claude agent 并绑定
6. 如果 tool input 包含 `force_new_session: true` → 强制新建

#### 3.2 添加新 session 请求的 tool（可选）
如果 agent 需要显式请求新会话，可以提供一个专门的 tool：

```typescript
// 这个 tool 由 agent 调用
{
  name: "request_new_session",
  description: "Request a new session for task separation or context overflow",
  input: {
    target_command: "claude",
    reason: "context_overflow" | "task_separation" | "explicit_request"
  }
}
```

### Phase 4: 测试场景

#### 场景 1：同一 chat 内 agent 复用
```
1. User 在 chat X 中与 Agent A (claude) 对话
2. Agent A 调用 Agent B (codex) 处理某个任务
3. 验证：Agent B 被 spawn 并绑定到 chat X
4. Agent A 再次调用 Agent B
5. 验证：复用同一个 Agent B 实例（通过 agent_id 确认）
```

#### 场景 2：显式新会话
```
1. Agent A 上下文即将溢出
2. Agent A 调用 request_new_session(target_command="claude", reason="context_overflow")
3. 验证：新的 Agent B 被 spawn，但不绑定到 chat X（或在新的 sub-chat 中）
4. 验证：Agent A 和 Agent B 可以通过 correlation_id 继续对话
```

#### 场景 3：Agent 死亡后重建
```
1. Agent B 在 chat X 中被绑定
2. Agent B 进程崩溃（is_alive = false）
3. Agent A 调用 Agent B
4. 验证：检测到 Agent B 已死亡，spawn 新的 Agent B 并更新绑定
```

## 实现优先级

### P0（必须）
1. Backend 实现 agent-to-agent 消息路由逻辑
2. Backend 实现 chat agents 查询接口
3. Frontend 添加 `getChatAgents` 和增强的 `sendMessage`

### P1（重要）
4. Backend 实现 `spawn-session` 接口
5. Agent Manager 添加 `sendAgentToAgentMessage` 辅助方法
6. 测试场景 1 和 3

### P2（可选）
7. 添加 `request_new_session` tool
8. 测试场景 2
9. UI 展示新 session 创建的状态

## 关键设计决策

### 决策 1：Binding 的粒度
**选项 A**：每个 chat 绑定一个 agent 实例（当前实现）
**选项 B**：每个 chat 可以绑定多个不同类型的 agent

**选择 B**：一个 chat 可以有 claude agent、codex agent 等多个实例，通过 command 区分

### 决策 2：新 session 的归属
**选项 A**：新 session 绑定到同一个 chat（共享上下文）
**选项 B**：新 session 创建新的 sub-chat（独立上下文）

**选择 B**：显式请求的新 session 应该在新的 sub-chat 中，避免上下文污染

### 决策 3：Agent 间通信的追踪
**方案**：使用 `correlation_id` 追踪跨 agent 的对话
- 每次 agent-to-agent 调用生成新的 correlation_id
- 所有相关的消息都带上这个 ID
- 可用于 UI 展示对话线程

## 实现状态

### ✅ 已完成（Frontend）

#### 1. tRPC Router 扩展
**文件**：`src/main/lib/trpc/routers/ergatai.ts`

- ✅ `getChatAgents` - 查询 chat 绑定的所有 agents
- ✅ `spawnAgentSession` - 显式创建新 session
- ✅ `sendMessage` 扩展 - 新增 `targetAgentCommand` 和 `forceNewSession` 字段

#### 2. Agent Manager 辅助方法
**文件**：`src/renderer/features/agents/lib/ergatai-agent-manager.ts`

- ✅ `getChatAgents(chatId)` - 获取 chat 绑定的 agents
- ✅ `sendAgentToAgentMessage(fromAgentId, targetAgentCommand, message, options)` - Agent 间消息发送
- ✅ `spawnNewAgentSession(agentId, targetCommand, reason, options)` - 显式创建新 session
- ✅ 新增类型：`ChatAgent`, `SpawnSessionResult`

### ❌ 待实现（Backend - Rust ergatai-api）

#### 1. 查询 chat 绑定的 agents
**接口**：`GET /api/v1/chats/:chatId/agents`

**Response**：
```json
{
  "agents": [
    {
      "agent_id": "abc123",
      "command": "claude",
      "status": "alive",
      "bound_at": "2024-01-01T00:00:00Z"
    }
  ]
}
```

**实现要点**：
- 查询 `agent_bindings` 表，关联 `agents` 状态
- 返回每个 binding 的 agent_id、command、status、bound_at

#### 2. Agent 间消息路由增强
**接口**：`POST /api/v1/agents/:agentId/message`

**新增字段**：
```json
{
  "message": "...",
  "from": "agent_a_id",
  "target_agent_command": "claude",  // 新增
  "force_new_session": false,         // 新增
  "correlation_id": "conv_123"
}
```

**路由逻辑**：
```
收到消息时：
1. 检查是否有 target_agent_command 字段
2. 如果没有 → 正常处理（发给当前 agent）
3. 如果有 → 进入 agent-to-agent 路由：
   a. 查询 chat 绑定的 agents（通过 from agent 的 workspace_id/chat_id）
   b. 查找 command == target_agent_command 的 binding
   c. 如果找到且 agent 存活 → 路由到该 agent
   d. 如果未找到或 agent 已死 → spawn 新 agent 并绑定
   e. 如果 force_new_session == true → 跳过复用，直接 spawn 新 agent
4. 返回 { target_agent_id, session_id }
```

#### 3. 显式创建新 session
**接口**：`POST /api/v1/agents/:agentId/spawn-session`

**Request**：
```json
{
  "target_command": "claude",
  "reason": "explicit_request" | "context_overflow" | "task_separation",
  "inherit_context": false,
  "workspace_id": "chat_xyz"
}
```

**Response**：
```json
{
  "new_session_id": "session_456",
  "new_agent_id": "def789",
  "message": "New session created for task separation"
}
```

**实现要点**：
- 不绑定到当前 chat（或创建新的 sub-chat）
- 返回新 agent 的 ID 和 session ID
- 可用于跨 agent 的对话追踪（通过 correlation_id）

## Backend 实现检查清单

- [ ] 实现 `GET /api/v1/chats/:chatId/agents`
  - [ ] 查询 agent_bindings 表
  - [ ] 关联 agents 状态（is_alive）
  - [ ] 返回 agents 数组

- [ ] 增强 `POST /api/v1/agents/:agentId/message`
  - [ ] 解析 target_agent_command 字段
  - [ ] 实现 agent-to-agent 路由逻辑
  - [ ] 支持 force_new_session 标志
  - [ ] 返回 target_agent_id 和 session_id

- [ ] 实现 `POST /api/v1/agents/:agentId/spawn-session`
  - [ ] Spawn 新 agent（不绑定到当前 chat）
  - [ ] 返回 new_session_id 和 new_agent_id

- [ ] 修改 tool 处理逻辑
  - [ ] 拦截 send_message tool call
  - [ ] 提取 target_agent_id 参数
  - [ ] 调用 agent-to-agent 路由

- [ ] 添加数据库索引
  - [ ] agent_bindings.chat_id + agent_command 联合索引

- [ ] 实现 agent 死亡检测
  - [ ] 在路由前检查 is_alive
  - [ ] 自动重建死亡 agent 的 binding

## Frontend 实现检查清单

- [x] 添加 `getChatAgents` tRPC 接口
- [x] 添加 `spawnAgentSession` tRPC 接口
- [x] 扩展 `sendMessage` 输入参数
- [x] Agent Manager 添加 `getChatAgents` 方法
- [x] Agent Manager 添加 `sendAgentToAgentMessage` 方法
- [x] Agent Manager 添加 `spawnNewAgentSession` 方法
- [ ] 更新 `ErgataiChatTransport` 支持 agent-to-agent 消息（P1）
- [ ] 添加新 session 创建的 UI 反馈（P2）

## P0 完成标准

当 Backend 实现以下接口后，P0 即完成：
1. `GET /api/v1/chats/:chatId/agents` - 前端已调用，等待后端实现
2. `POST /api/v1/agents/:agentId/message` 增强 - 前端已发送新字段，等待后端处理
3. `POST /api/v1/agents/:agentId/spawn-session` - 前端已调用，等待后端实现

**验证方式**：
```bash
# 测试 1：查询 chat agents
curl http://localhost:3000/api/v1/chats/:chatId/agents

# 测试 2：Agent 间消息（带 target_agent_command）
curl -X POST http://localhost:3000/api/v1/agents/:agentId/message \
  -H "Content-Type: application/json" \
  -d '{"message": "test", "target_agent_command": "codex"}'

# 测试 3：显式创建新 session
curl -X POST http://localhost:3000/api/v1/agents/:agentId/spawn-session \
  -H "Content-Type: application/json" \
  -d '{"target_command": "claude", "reason": "task_separation"}'
```

## 时间估算

- Phase 1（Backend）：2-3 天
- Phase 2（Frontend 集成）：1 天
- Phase 3（工具集成）：1 天
- Phase 4（测试）：1 天

**总计**：5-6 天
