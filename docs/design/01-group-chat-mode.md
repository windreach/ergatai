# 群聊模式设计

状态：Draft  
日期：2026-09-07  
范围：Ergatai 多 Agent 协作平台  
关联方向：IM 联系人模式、项目群、私聊 Agent、任务面板

## 1. 背景与目标

群聊模式是 Ergatai IM 化体验的第一层入口。用户不应该把 Agent 当成需要手动编排的调度器，而是像添加同事一样把 Agent 加入项目群：

- 用户可以和单个 Agent 私聊。
- 用户可以创建项目群，并邀请多个 Agent 加入。
- 群内通过 `@Agent`、任务卡、审批卡和结果卡完成协作。
- Agent 执行过程默认折叠，避免群聊被日志刷屏。
- 复杂过程由任务详情、Diff、终端输出和文件变更面板承接。

本设计的关键原则是：

1. **群聊负责触发、确认、审批和收结论**。
2. **任务负责承载执行状态、依赖、产出物和审计记录**。
3. **对话异步执行，消息发送不应该等待 Agent Run 完成**。
4. **思考只展示摘要，不把原始推理或完整工具输出塞进群聊**。

## 2. 非目标

第一版不做以下事情：

- 不做个人微信客户端自动化或逆向协议接入。
- 不要求所有群聊消息自动变成任务。
- 不在群聊里展示完整 raw chain-of-thought。
- 不让 Agent 绕过 Ergatai 现有的消息总线、权限模型和工作流调度器。
- 不在第一版支持无限量 Agent 并发写入同一个 workspace。

## 3. 核心对象

### 3.1 Conversation

`Conversation` 是消息容器，包含私聊和群聊。

```ts
type ConversationKind = "direct" | "project_group";

interface Conversation {
  id: string;
  workspaceId?: string;
  kind: ConversationKind;
  title: string;
  members: ConversationMember[];
  settings: ConversationSettings;
  createdAt: string;
  updatedAt: string;
}
```

`direct` 表示用户与单个 Agent 的私聊。  
`project_group` 表示项目群，可包含多个用户和多个 Agent。

### 3.2 ConversationMember

```ts
type MemberRole = "owner" | "admin" | "member" | "observer";
type MemberKind = "user" | "agent";

interface ConversationMember {
  id: string;
  kind: MemberKind;
  role: MemberRole;
  agentProfileId?: string;
  agentRecordId?: string;
  joinedAt: string;
}
```

Agent 成员需要区分两层身份：

- `agentProfileId`：Agent 模板或能力定义。
- `agentRecordId`：当前运行时 Agent 实例。

这样群聊可以保存“团队编制”，而实际执行时再绑定或启动具体 Agent 进程。

### 3.3 GroupMessage

群聊消息沿用前端已有的 message parts 思路，但增加任务和 Run 关联。

```ts
type GroupMessageSenderKind = "user" | "agent" | "system";

interface GroupMessage {
  id: string;
  conversationId: string;
  senderKind: GroupMessageSenderKind;
  senderId: string;
  parts: GroupMessagePart[];
  mentions?: string[];
  taskId?: string;
  runId?: string;
  replyToMessageId?: string;
  visibility: "member" | "panel" | "audit";
  createdAt: string;
}
```

### 3.4 GroupMessagePart

群聊消息不是单一字符串，而是结构化部件的组合。

```ts
type GroupMessagePart =
  | { type: "text"; content: string }
  | { type: "file"; fileId: string; summary?: string }
  | { type: "mention"; memberId: string; displayName: string }
  | { type: "task_ref"; taskId: string; title: string }
  | { type: "run_ref"; runId: string; agentId: string }
  | { type: "activity_card"; runId: string; state: ActivityCardState }
  | { type: "approval"; approvalId: string; state: ApprovalState }
  | { type: "artifact"; artifactId: string; kind: "diff" | "file" | "log" | "report" }
  | { type: "system_notice"; content: string };
```

`activity_card` 是群聊体验的核心。它看起来像普通消息，但内部绑定一个异步 Run，可以持续更新状态。

## 4. 群聊界面

推荐主界面为三栏，高级模式可扩展第四栏。

```text
┌────────────┬──────────────────────────────┬──────────────────────┐
│ 联系人/项目 │ 群聊                         │ 任务上下文 / 文件变更 │
├────────────┼──────────────────────────────┼──────────────────────┤
│ 项目群      │ 用户：@Codex 修复登录超时     │ Run Timeline         │
│ Agent 列表  │                              │ Tool Calls           │
│ 私聊        │ ┌ 活动卡 · Codex ───────────┐ │ Waiting Approvals    │
│ 任务        │ │ 状态：正在分析            │ │ Artifacts            │
│             │ │ 已读取 6 个文件           │ │ Diffs                │
│             │ │ [展开] [详情] [停止]      │ │ Logs                 │
│             │ └──────────────────────────┘ │                      │
└────────────┴──────────────────────────────┴──────────────────────┘
```

### 4.1 默认视图

中间聊天栏是唯一的主交互区域。

用户在群聊里能直接看到：

- 普通用户消息。
- Agent 最终回答。
- 系统通知。
- Agent 活动卡。
- 审批请求。
- 产出物入口。

### 4.2 活动卡

活动卡不是独立页面，而是插入在消息流里的可更新消息组件。

收起状态：

```text
┌ Codex ─────────────────────┐
│ 任务 #123 · running         │
│ 正在定位登录超时原因         │
│ 已读取 6 个文件              │
│ [展开] [详情] [停止]         │
└────────────────────────────┘
```

展开状态：

```text
┌ Codex ─────────────────────┐
│ ▾ 执行过程                   │
│ - 读取 auth/session.ts       │
│ - 定位 refresh token 竞态    │
│ - 准备修改 3 个文件           │
│                              │
│ 状态：等待批准写入文件        │
│ [批准] [拒绝] [详情]         │
└────────────────────────────┘
```

活动卡展示的内容来自 Run Events，而不是直接展示模型完整思考。默认只显示：

- 当前阶段。
- 最近一次关键判断。
- 工具活动摘要。
- 等待用户处理的事项。
- 最终结果摘要。

### 4.3 消息与任务详情的边界

| 信息 | 展示位置 |
| --- | --- |
| 用户请求 | 群聊 |
| Agent 结论 | 群聊 |
| 当前状态 | 活动卡 |
| 计划摘要 | 活动卡可展开区 |
| 工具调用摘要 | 活动卡可展开区 |
| 完整工具输入输出 | 任务详情 |
| 文件 Diff | 任务详情 / Diff 面板 |
| 终端日志 | 任务详情 / Terminal 面板 |
| Agent 内部协作消息 | 任务详情 |
| 审计记录 | 任务详情 / 审计视图 |

## 5. 群聊路由

### 5.1 明确提及

第一版以 `@Agent` 为主要路由方式。

```text
@Codex 修复登录超时
@Claude review Codex 的修改
@Gemini 查一下相关 issue
```

用户发送消息后，平台解析 mention，并为每个目标 Agent 创建或关联 Run。

### 5.2 无提及行为

第一版建议：

- 普通聊天不自动触发所有 Agent。
- 如果群里只有一个 Agent，可以配置为默认响应。
- 如果有多个 Agent，未指定目标时由群设置决定：
  - `manual`：不响应。
  - `suggest`：提示用户选择 Agent。
  - `router`：由轻量路由器选择 Agent。

推荐默认值是 `manual` 或 `suggest`，避免多 Agent 抢答。

### 5.3 多 Agent 协作

当用户说：

```text
@Codex 修复登录超时，@Claude review 修复方案
```

平台不应简单把同一句话同时发给两个 Agent 后放任其互聊，而应创建一个任务组：

```text
任务 #123：修复登录超时
├── t123-a · Codex · analyze_and_fix
└── t123-b · Claude · review_changes · depends_on: t123-a
```

群聊里显示一个聚合活动卡：

```text
┌ 修复登录超时 ───────────────┐
│ Codex  · running · 定位问题  │
│ Claude · queued · 等待变更   │
│                              │
│ [任务详情] [取消全部]        │
└─────────────────────────────┘
```

Agent 之间的消息仍然走 Ergatai 现有消息总线和通信策略，不直接绕过平台。

## 6. Run 与任务生命周期

### 6.1 Run 状态

```ts
type RunStatus =
  | "accepted"
  | "queued"
  | "starting"
  | "planning"
  | "running"
  | "waiting_input"
  | "waiting_approval"
  | "reviewing"
  | "completed"
  | "failed"
  | "cancelled"
  | "timeout";
```

群聊活动卡至少需要突出这些用户可感知状态：

```text
accepted        已接收
running         正在执行
waiting_input   需要补充信息
waiting_approval 等待审批
completed       已完成
failed          执行失败
cancelled       已取消
```

### 6.2 任务状态

```ts
type TaskStatus =
  | "draft"
  | "created"
  | "in_progress"
  | "blocked"
  | "in_review"
  | "done"
  | "failed"
  | "cancelled";
```

一个任务可以包含一个或多个 Run。简单请求可以只产生一个 Run；复杂协作可以生成子任务或 DAG。

### 6.3 生命周期示例

```text
用户发送 @Codex 修复登录超时
  ↓
创建 Task #123 和 Run r456
  ↓
群聊插入活动卡
  ↓
Codex 异步执行
  ↓
平台收到 reasoning.summary / tool.call.* 事件
  ↓
活动卡原地更新
  ↓
出现写文件审批
  ↓
用户批准
  ↓
Codex 继续执行并产出 diff
  ↓
Run completed
  ↓
活动卡显示最终摘要和 diff 入口
```

## 7. 事件模型

群聊和任务面板共享同一套 Run Event 流，只是消费粒度不同。

```ts
type RunEvent =
  | { type: "run.accepted"; runId: string }
  | { type: "run.started"; runId: string }
  | { type: "run.status_changed"; runId: string; status: RunStatus }
  | { type: "run.plan_summary"; runId: string; title: string; steps?: string[] }
  | { type: "run.reasoning_summary"; runId: string; title: string; detail?: string }
  | { type: "run.tool_call.started"; runId: string; toolCallId: string; toolName: string; summary: string }
  | { type: "run.tool_call.completed"; runId: string; toolCallId: string; summary: string; durationMs: number }
  | { type: "run.tool_call.failed"; runId: string; toolCallId: string; error: string }
  | { type: "run.approval.requested"; runId: string; approvalId: string; summary: string; risk: RiskLevel }
  | { type: "run.approval.resolved"; runId: string; approvalId: string; decision: "approved" | "rejected" }
  | { type: "run.output.delta"; runId: string; delta: string }
  | { type: "run.output.completed"; runId: string; summary: string }
  | { type: "run.artifact.created"; runId: string; artifactId: string; kind: "diff" | "file" | "log" | "report" }
  | { type: "run.needs_input"; runId: string; question: string }
  | { type: "run.completed"; runId: string; summary: string }
  | { type: "run.failed"; runId: string; error: string }
  | { type: "run.cancelled"; runId: string };
```

每个事件应包含通用 envelope：

```ts
interface EventEnvelope<T> {
  eventId: string;
  conversationId?: string;
  taskId?: string;
  runId?: string;
  agentId?: string;
  createdAt: string;
  visibility: "member" | "panel" | "audit";
  payload: T;
}
```

消费规则：

| 层级 | 消费内容 |
| --- | --- |
| 群聊 | 状态变化、关键摘要、审批、完成、失败 |
| 活动卡展开区 | 计划、思考摘要、工具调用摘要 |
| 任务详情 | 全部结构化事件 |
| 审计视图 | 不可变事件历史 |

## 8. API 草案

### 8.1 会话

```http
POST /api/v1/conversations
GET  /api/v1/conversations
GET  /api/v1/conversations/:conversationId
PATCH /api/v1/conversations/:conversationId
POST /api/v1/conversations/:conversationId/members
DELETE /api/v1/conversations/:conversationId/members/:memberId
```

创建项目群示例：

```json
{
  "kind": "project_group",
  "title": "Auth 修复群",
  "workspaceId": "ws_auth",
  "members": [
    { "kind": "user", "id": "u_alice", "role": "owner" },
    { "kind": "agent", "agentProfileId": "codex", "role": "member" },
    { "kind": "agent", "agentProfileId": "claude", "role": "member" }
  ],
  "settings": {
    "unmentionedPolicy": "manual",
    "autoCreateTask": true,
    "showAgentToAgentMessages": false
  }
}
```

### 8.2 发送消息

```http
POST /api/v1/conversations/:conversationId/messages
```

请求：

```json
{
  "parts": [
    { "type": "text", "content": "@Codex 修复登录超时" }
  ],
  "mentions": ["agent:codex"],
  "permissionMode": "manual"
}
```

响应必须立即返回，不能等待 Run 完成：

```json
{
  "messageId": "m_001",
  "taskId": "t_123",
  "runs": [
    {
      "runId": "r_456",
      "agentId": "codex",
      "status": "accepted"
    }
  ]
}
```

### 8.3 Run 操作

```http
GET   /api/v1/runs/:runId
GET   /api/v1/runs/:runId/events
POST  /api/v1/runs/:runId/approvals/:approvalId
POST  /api/v1/runs/:runId/input
POST  /api/v1/runs/:runId/cancel
POST  /api/v1/runs/:runId/retry
```

### 8.4 实时流

```http
GET /api/v1/conversations/:conversationId/events
GET /api/v1/runs/:runId/events
```

传输层可以使用 SSE 或 WebSocket。推荐事件主题：

```text
conversation.{conversation_id}.message
conversation.{conversation_id}.run
task.{task_id}.updated
run.{run_id}.event
run.{run_id}.approval
```

## 9. 并发与阻塞策略

群聊不能变成请求-响应式的阻塞模型。

### 9.1 Conversation 不阻塞

```text
用户可以继续发消息。
多个活动卡可以同时存在。
多个 Agent 可以并行执行。
Agent 完成时间不同，消息按事件到达顺序渲染。
```

### 9.2 Agent Session 级串行

同一个 Agent 实例的同一个交互 session 通常只能处理一个 prompt。平台应按 Agent Session 排队：

```text
Codex session r456: running
Codex same-session request: queued
```

如果用户希望并行，可以由 Agent Launcher 创建新的 Agent 实例或新的 session。

### 9.3 资源级串行

多个 Run 要修改同一个文件、目录或 workspace 时，必须使用现有锁机制：

```text
file lock
workspace lock
task dependency lock
```

只读操作可以并行；写操作默认需要锁或审批。

### 9.4 用户补充消息

当某个 Run 正在执行时，用户新输入可以有五种处理方式：

| 情况 | 行为 |
| --- | --- |
| 完全无关的新请求 | 创建新任务和新 Run |
| 对当前任务补充上下文 | 追加 `user_note` 到当前 Run |
| 纠正方向 | 提示中断、追加说明或排队 |
| 紧急停止 | 发送 cancel/interrupt |
| Agent 暂不接受输入 | 显示 queued，不锁聊天 |

## 10. 审批与安全

### 10.1 审批卡

高风险动作必须在群聊里产生审批卡：

```text
┌ 审批请求 · Codex ───────────┐
│ 准备写入 src/auth/session.ts │
│ 原因：修复 refresh token 竞态 │
│ 风险：workspace write        │
│                              │
│ [批准] [拒绝] [查看 diff]    │
└─────────────────────────────┘
```

审批结果需要记录：

- 审批人。
- 时间。
- 授权范围。
- 原始请求。
- 最终结果。

### 10.2 内容可见性

事件分为三层：

```ts
type EventVisibility = "member" | "panel" | "audit";
```

- `member`：群聊普通成员可见。
- `panel`：任务详情或上下文面板可见。
- `audit`：审计和调试可见。

### 10.3 敏感信息处理

群聊展示前应做：

- secret redaction。
- 命令输出截断。
- 文件内容摘要。
- 大日志外链化。
- prompt 注入标记。

来自网页、issue、外部文件的内容应标记为不可信上下文，不能自动获得更高权限。

## 11. 前端实现建议

现有 `ChatPanel` 已经基于 `UIMessage` parts 渲染。群聊模式可以扩展为：

```ts
type GroupChatUIPart =
  | { type: "text"; text: string }
  | { type: "reasoning-summary"; text: string; collapsed: boolean }
  | { type: "activity-card"; runId: string; status: RunStatus; summary: string }
  | { type: "tool-summary"; toolName: string; summary: string; runId?: string }
  | { type: "approval"; approvalId: string; risk: RiskLevel; summary: string }
  | { type: "artifact"; artifactId: string; kind: "diff" | "file" | "log" };
```

组件拆分：

```text
GroupChatPanel
├── GroupSidebar
├── ConversationHeader
├── MessageList
│   ├── UserMessage
│   ├── AgentMessage
│   ├── ActivityCard
│   ├── ApprovalCard
│   └── ArtifactCard
├── GroupComposer
│   ├── AgentMentionPicker
│   └── PermissionSelector
└── RunDetailDrawer / RunInspector
```

活动卡通过 `runId` 订阅事件，不直接轮询整段聊天记录。

## 12. 后端落地方式

推荐新增独立的群聊编排能力，而不是修改 Agent Adapter 的语义。

```text
ergatai-api
  ├── conversation HTTP API
  ├── group message router
  └── approval API

ergatai-collab
  ├── task/run orchestration
  ├── mention resolver
  └── multi-agent dependency handling

ergatai-runtime
  ├── agent session binding
  ├── run lifecycle
  └── cancel/interrupt

ergatai-nats
  ├── conversation events
  ├── run events
  └── approval events
```

存储建议：

```text
conversations
conversation_members
messages
message_parts
tasks
runs
run_events
approvals
artifacts
conversation_read_state
```

## 13. 外部 IM 适配

自建 Web/桌面端可以完整支持活动卡。外部 IM 需要降级：

| 能力 | 自建端 | 企业微信/飞书/Slack | 个人微信 |
| --- | --- | --- | --- |
| 富文本 | 支持 | 部分支持 | 受限 |
| 活动卡原地更新 | 支持 | 部分支持 | 基本不支持 |
| 审批按钮 | 支持 | 取决于平台 | 不建议 |
| Diff 查看跳转 | 支持 | 支持 | 支持 |
| 高频状态更新 | 支持 | 需节流 | 不建议 |

外部 IM 的推荐策略：

1. 收到任务后发送一条轻量确认。
2. 只在关键节点发送更新：开始、等待审批、阻塞、完成、失败。
3. 复杂操作返回 Ergatai 任务链接。
4. 个人微信仅做通知和简单确认，不做高危审批。

## 14. MVP 分期

### Phase 1：最小群聊

- 创建项目群。
- 添加多个 Agent 成员。
- `@Agent` 触发执行。
- 消息立即返回 accepted。
- 单个活动卡展示 running / waiting / completed / failed。
- Agent 最终回答写回群聊。

### Phase 2：过程可视化

- 活动卡支持展开思考摘要。
- 展示工具调用摘要。
- 接入审批卡。
- 支持取消、重试、补充输入。
- 任务详情页展示完整 Run Timeline。

### Phase 3：多 Agent 协作

- 支持 `@A ...，@B ...` 生成任务组。
- 支持依赖关系。
- 支持 Agent 间消息。
- 支持聚合活动卡。
- 支持 workspace/file 锁。

### Phase 4：外部 IM

- 企业微信、飞书、Slack 适配。
- 外部通知节流。
- 审批回跳。
- 群成员权限同步。

## 15. 成功指标

- 用户发出 `@Agent` 请求后 1 秒内看到 accepted 状态。
- 中长任务期间用户可以继续发送消息。
- 群聊中单个 Run 的默认消息数量不超过一张活动卡。
- 高风险写入操作 100% 有审批记录。
- 用户能从活动卡一步跳到 diff、日志或任务详情。
- 多 Agent 任务能明确看到谁在执行、谁在等待、谁被阻塞。

## 16. 开放问题

1. Agent Profile 加入群聊后，是预先启动实例，还是首次 mention 时懒启动？
2. 群聊历史默认给 Agent 提供多少上下文？只给被 @ 的片段，还是给最近 N 条消息？
3. 多个用户同时审批时采用单审批人、多数通过，还是按角色权限？
4. Agent 能否主动在群里发消息，还是只能回复 Run？
5. 未 mention 时是否引入轻量 router Agent，还是先完全手动选择？
6. 任务详情页使用右侧 Drawer、独立 Tab，还是独立路由？

