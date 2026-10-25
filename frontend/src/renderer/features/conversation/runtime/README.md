# Conversation Runtime

统一的对话调用抽象层，用于在不同对话上下文（主对话、侧边对话、分屏、群组对话）中发送消息。

## 概述

这个模块提供了统一的 API 来处理对话调用，消除了主对话、侧边对话、群组对话之间的重复逻辑。

### 核心组件

- **Contracts** (`contracts.ts`) - 类型定义
- **ConversationInvocationService** (`conversation-invocation-service.ts`) - 服务层门面
- **Resolvers** - 解析对话、agent runtime、transport
  - `conversation-resolver.ts` - 解析对话上下文
  - `agent-runtime-resolver.ts` - 解析 agent 状态
  - `transport-resolver.ts` - 解析 transport
- **RuntimeSessionStore** (`runtime-session-store.ts`) - 运行时状态管理
- **TurnOrchestrator** (`turn-orchestrator.ts`) - 协调完整的发送流程
- **React Hooks** (`use-conversation-invocation.ts`) - React 适配层

## 使用示例

### 基本用法

```typescript
import { useConversationInvocation } from "@/renderer/features/conversation/runtime"

function ChatInput({ conversationId, chatId }) {
  const invocation = useConversationInvocation()
  const sessionState = invocation.useSessionState(conversationId)
  
  const handleSend = async (message: string) => {
    await invocation.send({
      conversation: {
        chatId,
        conversationId,
        source: "main",
      },
      role: "user",
      parts: [{ type: "text", text: message }],
    })
  }
  
  const handleStop = async () => {
    await invocation.stop({ conversationId, chatId })
  }
  
  return (
    <div>
      <input 
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            handleSend(e.currentTarget.value)
          }
        }} 
      />
      {sessionState?.isStreaming && (
        <button onClick={handleStop}>
          Stop
        </button>
      )}
    </div>
  )
}
```

### 队列管理

```typescript
import { useConversationInvocation } from "@/renderer/features/conversation/runtime"

function QueueManager({ conversationId }) {
  const invocation = useConversationInvocation()
  const sessionState = invocation.useSessionState(conversationId)
  
  const handleSendQueued = async (itemId: string) => {
    await invocation.sendQueuedItem(conversationId, itemId)
  }
  
  const handleRemoveQueued = async (itemId: string) => {
    await invocation.removeQueuedItem(conversationId, itemId)
  }
  
  return (
    <div>
      {sessionState?.queue.map((item) => (
        <div key={item.id}>
          <span>{item.status}</span>
          <button onClick={() => handleSendQueued(item.id)}>Send</button>
          <button onClick={() => handleRemoveQueued(item.id)}>Remove</button>
        </div>
      ))}
    </div>
  )
}
```

### Agent 对话

```typescript
import { useConversationInvocation } from "@/renderer/features/conversation/runtime"

function AgentChat({ agentId, conversationId }) {
  const invocation = useConversationInvocation()
  
  const handleSendToAgent = async (message: string) => {
    await invocation.send({
      conversation: {
        chatId: "agent-chat",
        conversationId,
        agentId,
        source: "side",
      },
      role: "user",
      parts: [{ type: "text", text: message }],
    })
  }
  
  // ...
}
```

### Agent-to-Agent 消息

```typescript
import { useConversationInvocation } from "@/renderer/features/conversation/runtime"

function AgentToAgentChat({ fromAgentId, targetAgentId, conversationId }) {
  const invocation = useConversationInvocation()
  
  const handleAgentMessage = async (message: string) => {
    await invocation.send({
      conversation: {
        chatId: "agent-to-agent",
        conversationId,
        agentId: targetAgentId,
        source: "side",
      },
      role: "agent",
      parts: [{ type: "text", text: message }],
      fromAgentId,
      targetAgentId,
    })
  }
  
  // ...
}
```

## 架构

### 发送流程

```
UI Component
  ↓
useConversationInvocation()
  ↓
ConversationInvocationService.send()
  ↓
TurnOrchestrator.send()
  ├─ ConversationResolver.resolve() → ResolvedConversation
  ├─ AgentRuntimeResolver.resolve() → ResolvedAgentRuntime
  ├─ TransportResolver.resolve() → ChatTransport
  └─ RuntimeSessionStore.ensureSession()
  ↓
Transport.send()
  ↓
RuntimeSessionStore.updateState()
```

### 状态管理

```
RuntimeSessionStore
  ├─ persistedMessages (from backend)
  ├─ runtimeMessages (from streaming)
  ├─ visibleMessages (merged + deduplicated)
  ├─ queue (pending messages)
  ├─ streamingMessageId
  └─ status (idle/loading/ready/streaming/completed/error)
```

## 迁移指南

### 从 useChatInstance 迁移

**之前:**
```typescript
const { sendMessage, stopStreaming } = useChatInstance({
  chatId,
  conversationId,
  agentId,
})

await sendMessage(message)
```

**之后:**
```typescript
const invocation = useConversationInvocation()

await invocation.send({
  conversation: {
    chatId,
    conversationId,
    agentId,
    source: "main",
  },
  role: "user",
  parts: [{ type: "text", text: message }],
})
```

### 从 messageQueueStore 迁移

**之前:**
```typescript
const queue = useMessageQueueStore((s) => s.getQueue(conversationId))
const addToQueue = useMessageQueueStore((s) => s.addToQueue)

addToQueue(conversationId, queueItem)
```

**之后:**
```typescript
const invocation = useConversationInvocation()
const sessionState = invocation.useSessionState(conversationId)

// Queue is automatically managed
await invocation.enqueue({
  conversation: { chatId, conversationId, source: "main" },
  role: "user",
  parts: [{ type: "text", text: message }],
})

// Access queue
const queue = sessionState?.queue
```

### 从 streamingStatusStore 迁移

**之前:**
```typescript
const isStreaming = useStreamingStatusStore((s) => s.isStreaming(conversationId))
const setStatus = useStreamingStatusStore((s) => s.setStatus)

setStatus(conversationId, "streaming")
```

**之后:**
```typescript
const invocation = useConversationInvocation()
const sessionState = invocation.useSessionState(conversationId)

const isStreaming = sessionState?.isStreaming
// Status is automatically managed
```

## 实现阶段

- ✅ **Phase 1**: 类型定义 (`contracts.ts`)
- ✅ **Phase 2**: 服务骨架 (`conversation-invocation-service.ts`)
- ✅ **Phase 3**: Runtime Session Store (`runtime-session-store.ts`)
- ✅ **Phase 4**: Conversation Resolver (`conversation-resolver.ts`)
- ✅ **Phase 5**: Agent Runtime Resolver (`agent-runtime-resolver.ts`)
- ✅ **Phase 6**: Transport Resolver (`transport-resolver.ts`)
- ✅ **Phase 7**: Turn Orchestrator (`turn-orchestrator.ts`)
- ✅ **Phase 8**: React Hook (`use-conversation-invocation.ts`)

### 下一步

- **Phase 9**: 迁移侧边对话使用新 API
- **Phase 10**: 迁移主对话使用新 API
- **Phase 11**: 迁移群组对话使用新 API
- **Phase 12**: 清理重复逻辑

## 设计原则

1. **单一职责**: 每个组件只负责一个方面
2. **依赖注入**: 通过单例模式管理服务实例
3. **类型安全**: 完整的 TypeScript 类型定义
4. **可测试性**: 所有组件都可以独立测试
5. **向后兼容**: 与现有 store 和 hook 兼容

## 注意事项

- Transport Resolver 当前使用 mock 实现，需要与实际的 `ErgataiChatTransport`、`GroupChatTransport` 集成
- Agent Runtime Resolver 当前简化实现，需要查询实际的 agent runtime status store
- 队列管理已集成到 RuntimeSessionStore，但还需要与现有的 `messageQueueStore` 同步
