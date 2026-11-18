# Subagent 对话渲染计划（前端，不持久化）

## 目标

把 subagent 对话渲染成“正常 agent 对话”的视觉形态，但 **不新建 conversation / ChatTransport / 持久化链路**，而是作为 parent conversation 的过滤视图。

## 核心原则

- subagent 不是独立 ergatai agent
- 不走完整前端对话通道
- 只做内存态缓冲 + 选中视图 + 复用现有消息渲染
- 流式更新，不轮询
- 前端以 SSE 事件中的 `subagent_session_id` 作为消息归属的唯一权威来源
- 刷新后 subagent 对话与 run 列表清空，这是设计选择，不视为 bug
- 不读取 backend `/subagent-runs` 作为渲染数据源，避免刷新后出现“有 run 但无消息”的半残状态；backend API 仅保留为后端调试/未来 hydration 能力

---

## Phase 0：数据权威源与 UI 宿主（新增）

### 0.1 数据权威源

- 消息归属：只使用 SSE 事件上的 `subagent_session_id`，不依赖 backend 的 `active_subagent_session_id`
- run 元数据：由 `subagent_spawned` / `subagent_state_update` 事件在前端内存中维护
- backend `SubagentRun.messages` 不作为前端渲染来源

### 0.2 UI 宿主

- subagent rail 不能依赖 `ConversationStatusCard` 的 busy 状态才能展开
- `ConversationStatusCard` 仅在以下条件全部满足时才 `return null`：
  - `!isBusy`
  - `uncommittedFiles.length === 0`
  - 当前 agent 没有任何 subagent run
- rail 展开状态与 busy 状态解耦：只要有 subagent run，就可以展开/折叠 rail

### 验收

- 生成结束后仍可展开并查看已完成 subagent
- 多个 subagent 并发时，消息不会因 active pointer 误归属

---

## Phase 1：数据模型与缓冲层

### 1.1 定义可渲染的 subagent 消息结构

文件：
- `frontend/src/renderer/features/agents/lib/subagent-message-store.ts`
- `frontend/src/renderer/features/agents/lib/subagent-run-store.ts`（新增，或合并到 message store）

结构：

```ts
type SubagentToolCall = {
  toolCallId: string
  toolName: string
  input: unknown
  state?: "pending" | "completed" | "failed"
  output?: unknown
}

type SubagentRenderPart =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "tool-call"; toolCall: SubagentToolCall }

type SubagentRenderMessage = {
  id: string // 通常为 subagentSessionId
  role: "assistant"
  parts: SubagentRenderPart[]
}

type SubagentRunMeta = {
  subagentSessionId: string
  name: string
  task: string
  state: "running" | "completed" | "failed" | "cancelled" | "disconnected" | string
  startedAt: number
  updatedAt: number
  parentToolUseId?: string | null
}
```

底层 chunk 结构：

```ts
type SubagentMessage = {
  kind: "text" | "thinking" | "tool_call" | "tool_result"
  content: string
  createdAt: number
  // tool_call
  toolCallId?: string
  toolName?: string
  input?: unknown
  // tool_result / tool_call_update
  state?: "pending" | "completed" | "failed"
  output?: unknown
}
```

### 1.2 将 chunk 流合并为 parts

修改 `appendSubagentMessage`：
- 连续 `text` 追加到当前 text part
- 连续 `thinking` 追加到当前 reasoning part
- `tool_call` 新增 tool-call part，并携带 `toolCallId/toolName/input`
- `tool_result` 更新最近一个匹配的 tool-call part 的 `state/output`
- 如果同类内容被 tool call 打断，后续同类内容新建 part

### 1.3 提供转换函数

```ts
function toSubagentRenderMessages(messages: SubagentMessage[]): SubagentRenderMessage[]
```

### 1.4 有界缓冲

- 每个 subagent 最多保留 500 条 chunk
- 同时限制总字符数，例如 200,000 chars，超出时丢弃最旧 chunk
- 超过上限时保留最新内容，并记录被截断标记（可选）

### 1.5 清理函数

新增：

```ts
clearSubagentMessages(agentId, subagentSessionId?)
clearSubagentRuns(agentId)
```

### 1.6 订阅粒度

- 不使用全局单一 listener set
- 按 `agentId::subagentSessionId` 维护 listener
- `useSubagentMessages` 只订阅当前 key
- run 列表使用单独的 per-agent 订阅

### 验收

- 同一 subagent 的流式 text 不会被拆成大量独立消息
- tool call 能正确插入 parts 序列
- tool result 能更新对应 tool card 状态
- 内存缓冲有上限（消息数 + 字符数）
- 多 subagent 并发时，订阅更新不会导致无关视图重渲染

---

## Phase 2：视图状态与选择

### 2.1 增加 selected subagent 状态

位置：
- `conversation-status-card.tsx` 内部 state，或 agents atoms（若需要跨组件共享）

状态：

```ts
selectedSubagentSessionId: string | null
isSubagentRailExpanded: boolean
```

### 2.2 rail 切换

展开面板右侧：
- `Subagents`：显示 subagent 列表
- 点击某项 -> 设置 `selectedSubagentSessionId`
- `Terminal`：保持现有终端视图

run 列表数据：
- 来自前端内存中的 `SubagentRunMeta`
- 由 `subagent_spawned` / `subagent_state_update` 事件更新

### 2.3 空状态

- 无 subagent：显示 No subagents
- 有 subagent 但未选中：显示 Select a subagent

### 验收

- 点击 subagent 后，右侧内容切换为该 subagent 的对话视图
- 不影响主对话流
- 生成结束后 rail 仍可展开

---

## Phase 3：渲染层复用

### 3.1 新增 SubagentConversationView

文件建议：
- `frontend/src/renderer/features/agents/ui/subagent-conversation-view.tsx`

职责：
- 读取 `useSubagentMessages(agentId, selectedSubagentId)`
- 读取 `useSubagentRunMeta(agentId, selectedSubagentId)`
- 转换为 render messages
- 渲染 text / reasoning / tool-call parts
- 显示 subagent name / task / state

### 3.2 复用策略

优先复用展示层，而不是整条消息 runtime：
- text block / Markdown renderer
- reasoning block
- tool call card shell
- loading / empty state

避免直接复用：
- `AssistantMessageItem` 的整条消息 grouping 逻辑
- conversation context 强相关的 atom 体系

如现有 tool 组件强依赖 `MessagePart`，新增轻量 adapter，把 `SubagentRenderPart` 映射为组件 props。

### 3.3 流式更新

- store 更新时自动 re-render
- 自动滚动到底部
- 可选：高亮当前 active subagent

### 验收

- subagent 对话能实时流式增长
- tool call 能 inline 显示，并反映 pending/completed/failed
- UI 与主对话视觉一致
- 不引入 conversation runtime 的复杂度

---

## Phase 4：状态与元数据展示

### 4.1 维护 subagent 元数据

从 SSE 事件维护：
- `subagent_spawned`: `subagentSessionId`, `name`, `task`
- `subagent_state_update`: `subagentSessionId`, `state`

可选展示字段：
- `started_at`
- `updated_at`
- `parent_tool_use_id`
- `file_change_report`
- `worktree`
- `async_tasks`

如果未来需要 hydration，再评估 backend `/subagent-runs` / `/subagent-runtime`，但默认不作为渲染数据源。

### 4.2 状态徽标

- running
- completed
- failed
- cancelled
- disconnected

### 4.3 rail 列表

- 显示 name / task 摘要 / state 徽标
- 选中视图头部显示 name/task/state/time

### 验收

- rail 列表显示状态
- 选中视图头部显示 name/task/state
- 刷新后列表与消息一致清空

---

## Phase 5：边界与清理

### 5.1 不持久化

- 不写 DB
- 不创建 conversation
- 不创建 ChatTransport
- 不读取 backend subagent-runs 作为渲染来源

### 5.2 内存清理

- conversation 结束时清空 subagent buffers 与 run meta
- agent 退出/kill 时清空
- chat archive/delete 时清空
- 设置最大消息数 / 最大字符数

调用点：
- transport `finish` / abort
- agent kill mutation success
- chat archive/delete mutation success

### 5.3 刷新行为

- 页面刷新后 subagent 对话与 run 列表清空
- 这是预期行为，不视为 bug
- UI 中应明确提示“刷新后 subagent 对话不会保留”

### 验收

- 无持久化副作用
- 无内存无限增长
- 清理路径可追踪

---

## 文件改动清单

### 新增

- `frontend/src/renderer/features/agents/lib/subagent-message-store.ts`（已创建，需重构）
- `frontend/src/renderer/features/agents/lib/subagent-run-store.ts`（新增，或合并到 message store）
- `frontend/src/renderer/features/agents/ui/subagent-conversation-view.tsx`

### 修改

- `frontend/src/renderer/features/agents/lib/ergatai-chat-transport.ts`
  - 保持 capture 逻辑
  - `tool_call_start` 时保存结构化 `toolCallId/name/input`
  - `tool_call` update/result 时更新 tool card 状态（若支持）
  - 流结束/abort 时触发清理
- `frontend/src/renderer/features/agents/ui/conversation-status-card.tsx`
  - rail 列表接入 subagent 选择
  - 右侧渲染 `SubagentConversationView`
  - 解耦 rail 展开与 busy 状态
  - 仅在无 busy、无文件、无 subagent run 时隐藏
- `frontend/src/main/lib/ergatai/sse-client.ts`
  - 已支持 `subagent_session_id`
- `frontend/src/renderer/features/agents/main/active-chat-dock.tsx`（如需要）
  - 确保 status card 在 subagent 存在时保持挂载

### 后端（已完成基础，前端默认不作为渲染数据源）

- `SubagentRun`
- `SubagentRuntime`
- `/subagent-runs`
- `/subagent-runtime`
- SSE `subagent_session_id`

如未来需要 hydration，再增加 tRPC procedure：
- `getAgentSubagentRuns`
- `getAgentSubagentRuntime`

---

## 里程碑

### M1：数据缓冲可用

- subagent text/thinking/tool_call 能合并成 parts
- tool call 保留结构化信息
- store 有界
- clear 函数可用

### M2：选择与空状态可用

- rail 列表可点击
- selected state 正常切换
- 生成结束后仍可展开 rail

### M3：渲染可用

- selected subagent 对话可流式渲染
- 复用展示层组件
- tool call inline 显示

### M4：元数据与清理完成

- 状态徽标、task、时间显示
- 无持久化、内存清理正常
- 刷新语义明确

---

## 风险

1. 多 subagent 并发
   - backend active pointer 可能误归属
   - 前端必须以 SSE `subagent_session_id` 为准
   - 需要 per-key 订阅避免不必要重渲染

2. 消息缓冲过大
   - 需要 bounded store（消息数 + 字符数）

3. 刷新丢失
   - 这是设计选择，需在 UI 中明确
   - 不读取 backend runs，避免半残状态

4. 组件复用复杂度
   - 现有 message 组件可能强依赖 conversation context
   - 优先抽离纯 presentational 组件或 adapter

5. tool result 支持范围
   - 当前只捕获 tool_call_start
   - 若需要完整 tool card 状态，必须扩展 transport 与 store

---

## 一句话

先建立以 SSE `subagent_session_id` 为权威的内存态 parts 缓冲与 run 元数据，再做 rail 选择与视图切换，最后复用展示层组件；subagent 只是 parent conversation 的过滤视图，不走完整对话通道，也不读取 backend runs 作为渲染来源。