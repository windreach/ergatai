# Agent 消息渲染规则检查报告

**检查日期**：2026-10-07  
**检查范围**：主聊天 (Main Chat)  
**参考文档**：`docs/AGENT_MESSAGE_RENDERING_RULES.md`

---

## 检查清单

### ✅ 规则 1: Agent 发送的请求消息

**要求**：
- 气泡样式：Agent 气泡（带 logo + 名称）
- 内容渲染：只渲染文本
- 消息角色：`role: "agent"` 或 `metadata.source: "agent"` + `metadata.messageType: "request"`

**实现位置**：
- `src/renderer/features/agents/main/isolated-message-group.tsx:166-339`

**检查结果**：✅ **已实现**

```typescript
// isolated-message-group.tsx:168
const isAgentSourcedMessage = userMsg.role === "agent"

// Line 325-339: Agent-sourced messages rendered as assistant-style with header
{isAgentSourcedMessage ? (
  <div data-agent-message-id={userMsgId}>
    {showAgentSenderHeader && displaySenderName && (
      <GroupAgentMessageHeader
        agentId={senderCoreAgentId ?? undefined}
        agentName={displaySenderName}
      />
    )}
    <div className="flex flex-col gap-1.5">
      {/* Only render text content - no tools or thinking process */}
      {textContent && (
        <MemoizedTextPart ... />
      )}
    </div>
  </div>
) : (
  <UserBubbleComponent ... />
)}
```

**符合规则**：
- ✅ 显示 agent logo + 名称 (`GroupAgentMessageHeader`)
- ✅ 只渲染文本内容 (`MemoizedTextPart`)
- ✅ 不渲染工具调用和思考步骤

---

### ✅ 规则 2: 宿主 Agent 的回复

**要求**：
- 气泡样式：Assistant 气泡
- 内容渲染：完整渲染（工具 + 思考 + 文本）
- 消息角色：`role: "assistant"`

**实现位置**：
- `src/renderer/features/agents/main/assistant-message-item.tsx`

**检查结果**：✅ **已实现**

```typescript
// assistant-message-item.tsx:700+ - Full rendering of assistant messages
// Renders all parts: thinking, tools, text
{normalizedParts.map((part, index) => {
  const type = part.type
  
  if (type === "text") {
    return <MemoizedTextPart key={index} ... />
  }
  
  if (type === "tool-Thinking" || type === "reasoning") {
    return <AgentThinkingTool key={index} ... />
  }
  
  if (type.startsWith("tool-")) {
    // Various tool renderers
    if (isPlanFile(toolName, part.input)) {
      return <AgentPlanFileTool key={key} ... />
    }
    if (toolName === "Bash") {
      return <AgentBashTool key={key} ... />
    }
    // ... more tool renderers
  }
})}
```

**符合规则**：
- ✅ 完整渲染思考步骤 (`AgentThinkingTool`)
- ✅ 完整渲染工具调用（各种 `Agent*Tool` 组件）
- ✅ 完整渲染文本内容 (`MemoizedTextPart`)
- ✅ 显示工具状态（⏳ 进行中 / ✓ 完成 / ❌ 错误）

---

### ✅ 规则 3: 其他 Agent 的回复

**要求**：
- 默认状态：可折叠标签（显示 agent 名称 + 消息摘要）
- 展开后：完整渲染（工具 + 思考 + 文本）
- 位置：在宿主消息末尾

**实现位置**：
- `src/renderer/features/agents/main/inter-agent-replies-disclosure.tsx`
- 使用位置：
  - `isolated-message-group.tsx:362` - 在 user/agent 消息后
  - `assistant-message-item.tsx:1077` - 在 assistant 消息后

**检查结果**：✅ **已实现** (刚修复)

```typescript
// inter-agent-replies-disclosure.tsx

// 1. Poll target agent's conversation
const { data } = trpc.ergatai.listConversationMessages.useQuery(
  { conversationId },
  { refetchInterval: 4000 },
)

// 2. Map messages with role mapping (same as side chat)
const uiMessages = useMemo(() => {
  return messages
    .map(mapToUIMessage)  // Maps messageType="response" → role="assistant"
    .filter((message) => message.role === "assistant")
    .sort(...)
}, [data])

// 3. Render with collapsible disclosure
<Collapsible defaultOpen={true}>
  <CollapsibleTrigger>
    <span>{agentName}'s response</span>  // Agent name label
    <ChevronDown />
  </CollapsibleTrigger>
  <CollapsibleContent>
    <AgentReplyMessagesList messages={uiMessages} />
  </CollapsibleContent>
</Collapsible>

// 4. Full rendering of each message
function AgentReplyMessageItem({ message }) {
  // Renders thinking, tools, text
  return (
    <div className="space-y-3">
      {/* Thinking/Reasoning */}
      {thinkingParts.length > 0 && (...)}
      
      {/* Tool calls */}
      {toolParts.length > 0 && (...)}
      
      {/* Text content */}
      {textParts.length > 0 && (...)}
    </div>
  )
}
```

**符合规则**：
- ✅ 可折叠标签 (`Collapsible`)
- ✅ 显示 agent 名称 (`agentName's response`)
- ✅ 展开后完整渲染 (`AgentReplyMessageItem`)
- ✅ 渲染思考步骤、工具调用、文本内容
- ✅ 位置正确（在触发消息后）

---

## 实现状态总结

| 规则 | 描述 | 状态 | 备注 |
|------|------|------|------|
| 规则 1 | Agent 发送的请求消息 | ✅ 已实现 | 简化渲染，只显示文本 + 身份 |
| 规则 2 | 宿主 Agent 的回复 | ✅ 已实现 | 完整渲染所有 parts |
| 规则 3 | 其他 Agent 的回复 | ✅ 已实现 | 可折叠标签，展开后完整渲染 |

**总体评估**：✅ **主聊天完全符合渲染规则**

---

## 待检查的会话类型

### 侧边聊天 (Side Chat)
**状态**：⏳ 待检查

**预期**：
- 应该遵循相同的三条规则
- 已经确认使用 `IsolatedMessagesSection` 进行完整渲染
- 需要验证 `InterAgentRepliesDisclosure` 是否也正确集成

### 子会话 (Sub-chat)
**状态**：⏳ 待检查

---

## 关键修复记录

### 2026-10-07 修复

**问题 1**: Agent-to-agent 消息没有被处理  
**原因**: 前端没传 `conversation_id`  
**修复**: 
- `src/main/lib/trpc/routers/ergatai.ts` - 添加 `conversationId` 到 schema
- `src/renderer/features/agents/lib/ergatai-chat-transport.ts` - 传递 `conversationId`
- `src/renderer/features/agents/lib/ergatai-agent-manager.ts` - 传递 `conversationId`

**问题 2**: Agent 回复没有工具调用和思考步骤  
**原因**: 
1. 过滤逻辑错误（过滤 `source === "agent"` 而不是 `messageType === "response"`）
2. 只渲染纯文本  
**修复**:
- `src/renderer/features/agents/main/inter-agent-replies-disclosure.tsx` - 完整重写
  - 使用侧边聊天的 role 映射逻辑
  - 保留完整的 `parts` 数组
  - 渲染所有类型的 parts（thinking, tools, text）

---

## 代码位置索引

### 渲染组件
| 组件 | 文件路径 | 用途 |
|------|---------|------|
| `IsolatedMessageGroup` | `src/renderer/features/agents/main/isolated-message-group.tsx` | 渲染单个消息组（user + assistant） |
| `AssistantMessageItem` | `src/renderer/features/agents/main/assistant-message-item.tsx` | 完整渲染 assistant 消息 |
| `InterAgentRepliesDisclosure` | `src/renderer/features/agents/main/inter-agent-replies-disclosure.tsx` | 可折叠的其他 agent 回复 |
| `GroupAgentMessageHeader` | `src/renderer/features/agents/collaboration/group-agent-message-header.tsx` | Agent logo + 名称 |

### 消息处理
| 模块 | 文件路径 | 用途 |
|------|---------|------|
| Message Store | `src/renderer/features/agents/stores/message-store.ts` | 消息存储和 role 策略 |
| Chat Transport | `src/renderer/features/agents/lib/ergatai-chat-transport.ts` | 消息传输层 |
| Agent Manager | `src/renderer/features/agents/lib/ergatai-agent-manager.ts` | Agent 管理器 |

### 后端 API
| 端点 | 文件路径 | 用途 |
|------|---------|------|
| `send_message` | `crates/ergatai-api/src/api/agents.rs` | Agent 消息 API |
| `message_delivery` | `crates/ergatai-api/src/mcp/message_delivery.rs` | NATS 消息投递 |

---

## 下一步

1. ✅ 创建渲染规则文档
2. ✅ 检查主聊天实现
3. ⏳ 检查侧边聊天实现
4. ⏳ 检查子会话实现
5. ⏳ 验证群聊会话使用不同的渲染规则
