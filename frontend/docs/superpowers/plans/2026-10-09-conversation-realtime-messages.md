# Conversation 实时消息订阅实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将前端消息接收从轮询 REST API 改为订阅 Conversation 级别的 SSE 流，实现实时消息推送

**Architecture:** 前端通过 tRPC subscription 桥接后端 SSE 端点，使用 `useConversationMessages` Hook 统一管理历史加载和实时订阅。首次加载使用 REST API，后续增量使用 SSE。

**Tech Stack:** React 19, tRPC, Server-Sent Events (SSE), NATS JetStream

**Spec:** `docs/superpowers/specs/2026-10-09-conversation-realtime-messages-design.md`

## Global Constraints

- 消息延迟 < 100ms
- 移除所有轮询代码
- 消息不丢失，不重复
- 支持自动重连
- 向后兼容（后端未就绪前可降级）

## Review Focus

1. **消息去重**：同一消息不重复显示，即使 SSE 重连后重新推送
   - 测试：Task 4 Step 2

2. **消息排序**：消息按 sequence 顺序显示，即使乱序到达
   - 测试：Task 4 Step 2

3. **增量订阅**：SSE 重连后只接收新消息，不重复接收历史
   - 测试：Task 3 Step 3 (afterSequence 参数)

4. **错误处理**：SSE 连接失败时自动重连，不影响 UI
   - 测试：Task 5 Step 1

5. **内存泄漏**：组件卸载时正确清理 SSE 连接
   - 测试：Task 6 Step 1 (return cleanup function)

---

### Task 1: 创建 useConversationMessages Hook 骨架

**Files:**
- Create: `src/renderer/features/agents/hooks/use-conversation-messages.ts`
- Test: `tests/renderer/features/agents/hooks/use-conversation-messages.test.ts`

**Interfaces:**
- Consumes: `trpc.ergatai.listConversationMessages` (existing)
- Produces: `useConversationMessages(conversationId: string) => { messages, isLoading, error }`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/renderer/features/agents/hooks/use-conversation-messages.test.ts
import { renderHook, waitFor } from "@testing-library/react"
import { useConversationMessages } from "@/renderer/features/agents/hooks/use-conversation-messages"
import { trpc } from "@/renderer/lib/trpc"

// Mock tRPC
vi.mock("../../../lib/trpc", () => ({
  trpc: {
    ergatai: {
      listConversationMessages: {
        useQuery: vi.fn(),
      },
      subscribeConversationMessages: {
        useSubscription: vi.fn(),
      },
    },
  },
}))

describe("useConversationMessages", () => {
  it("should load historical messages on mount", async () => {
    const mockMessages = [
      { id: "1", sequence: 1, role: "user", content: "Hello" },
      { id: "2", sequence: 2, role: "assistant", content: "Hi" },
    ]
    
    vi.mocked(trpc.ergatai.listConversationMessages.useQuery).mockReturnValue({
      data: mockMessages,
      isLoading: false,
      error: null,
    } as any)
    
    vi.mocked(trpc.ergatai.subscribeConversationMessages.useSubscription).mockReturnValue({
      error: null,
    } as any)
    
    const { result } = renderHook(() => useConversationMessages("conv-123"))
    
    await waitFor(() => {
      expect(result.current.isLoading).toBe(false)
    })
    
    expect(result.current.messages).toEqual(mockMessages)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/renderer/features/agents/hooks/use-conversation-messages.test.ts`
Expected: FAIL with "useConversationMessages is not defined"

- [ ] **Step 3: Create hook skeleton**

```typescript
// src/renderer/features/agents/hooks/use-conversation-messages.ts
import { useState } from "react"
import { trpc } from "../../../lib/trpc"

type Message = {
  id: string
  conversationId: string
  sequence: number
  role: string
  parts: unknown[]
  metadata: Record<string, unknown> | null
  createdAt: Date
}

export function useConversationMessages(conversationId: string) {
  const [messages, setMessages] = useState<Message[]>([])
  const [isLoading, setIsLoading] = useState(true)
  
  // TODO: Implement in next steps
  
  return {
    messages,
    isLoading,
    error: null,
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/renderer/features/agents/hooks/use-conversation-messages.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/renderer/features/agents/hooks/use-conversation-messages.ts
git add tests/renderer/features/agents/hooks/use-conversation-messages.test.ts
git commit -m "feat: add useConversationMessages hook skeleton"
```

---

### Task 2: 实现历史消息加载

**Files:**
- Modify: `src/renderer/features/agents/hooks/use-conversation-messages.ts`
- Test: `tests/renderer/features/agents/hooks/use-conversation-messages.test.ts`

**Interfaces:**
- Consumes: `trpc.ergatai.listConversationMessages`
- Produces: 历史消息加载逻辑

- [ ] **Step 1: Write test for historical loading**

```typescript
// tests/renderer/features/agents/hooks/use-conversation-messages.test.ts
it("should set messages from historical query", async () => {
  const mockMessages = [
    { id: "1", sequence: 1, role: "user", content: "Hello" },
    { id: "2", sequence: 2, role: "assistant", content: "Hi" },
  ]
  
  vi.mocked(trpc.ergatai.listConversationMessages.useQuery).mockImplementation((input, options) => {
    // Simulate onSuccess callback
    setTimeout(() => options.onSuccess?.(mockMessages), 0)
    return {
      data: mockMessages,
      isLoading: false,
      error: null,
    } as any
  })
  
  const { result } = renderHook(() => useConversationMessages("conv-123"))
  
  await waitFor(() => {
    expect(result.current.isLoading).toBe(false)
    expect(result.current.messages).toHaveLength(2)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/renderer/features/agents/hooks/use-conversation-messages.test.ts -t "should set messages"`
Expected: FAIL

- [ ] **Step 3: Implement historical loading**

```typescript
// src/renderer/features/agents/hooks/use-conversation-messages.ts
export function useConversationMessages(conversationId: string) {
  const [messages, setMessages] = useState<Message[]>([])
  const [isLoading, setIsLoading] = useState(true)
  
  // 1. 首次加载：REST API 获取历史消息
  const { data: history, isLoading: isHistoryLoading } = 
    trpc.ergatai.listConversationMessages.useQuery(
      { conversationId },
      {
        enabled: !!conversationId,
        onSuccess: (data) => {
          setMessages(data)
          setIsLoading(false)
        },
      }
    )
  
  return {
    messages,
    isLoading: isLoading || isHistoryLoading,
    error: null,
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/renderer/features/agents/hooks/use-conversation-messages.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/renderer/features/agents/hooks/use-conversation-messages.ts
git commit -m "feat: implement historical message loading"
```

---

### Task 3: 实现实时订阅

**Files:**
- Modify: `src/renderer/features/agents/hooks/use-conversation-messages.ts`
- Test: `tests/renderer/features/agents/hooks/use-conversation-messages.test.ts`

**Interfaces:**
- Consumes: `trpc.ergatai.subscribeConversationMessages`
- Produces: 实时消息订阅逻辑

- [ ] **Step 1: Write test for real-time subscription**

```typescript
// tests/renderer/features/agents/hooks/use-conversation-messages.test.ts
it("should receive new messages via subscription", async () => {
  const historicalMessages = [
    { id: "1", sequence: 1, role: "user", content: "Hello" },
  ]
  const newMessage = { id: "2", sequence: 2, role: "assistant", content: "Hi" }
  
  let subscriptionCallback: ((msg: Message) => void) | null = null
  
  vi.mocked(trpc.ergatai.listConversationMessages.useQuery).mockImplementation((input, options) => {
    setTimeout(() => options.onSuccess?.(historicalMessages), 0)
    return { data: historicalMessages, isLoading: false, error: null } as any
  })
  
  vi.mocked(trpc.ergatai.subscribeConversationMessages.useSubscription).mockImplementation((input, options) => {
    subscriptionCallback = options.onData
    return { error: null } as any
  })
  
  const { result } = renderHook(() => useConversationMessages("conv-123"))
  
  await waitFor(() => {
    expect(result.current.isLoading).toBe(false)
  })
  
  // Simulate new message
  subscriptionCallback?.(newMessage)
  
  await waitFor(() => {
    expect(result.current.messages).toHaveLength(2)
    expect(result.current.messages[1]).toEqual(newMessage)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/renderer/features/agents/hooks/use-conversation-messages.test.ts -t "should receive new messages"`
Expected: FAIL

- [ ] **Step 3: Implement real-time subscription**

```typescript
// src/renderer/features/agents/hooks/use-conversation-messages.ts
import { useState, useRef } from "react"

export function useConversationMessages(conversationId: string) {
  const [messages, setMessages] = useState<Message[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const lastSequenceRef = useRef(0)
  
  // 1. 首次加载：REST API 获取历史消息
  const { data: history, isLoading: isHistoryLoading } = 
    trpc.ergatai.listConversationMessages.useQuery(
      { conversationId },
      {
        enabled: !!conversationId,
        onSuccess: (data) => {
          setMessages(data)
          lastSequenceRef.current = Math.max(
            ...data.map(m => m.sequence),
            0
          )
          setIsLoading(false)
        },
      }
    )
  
  // 2. 实时订阅：SSE 接收新消息
  trpc.ergatai.subscribeConversationMessages.useSubscription(
    { 
      conversationId,
      afterSequence: lastSequenceRef.current
    },
    {
      enabled: !!conversationId && !isLoading,
      onData: (message) => {
        setMessages((prev) => {
          // 去重
          if (prev.some(m => m.id === message.id)) {
            return prev
          }
          // 追加并排序
          return [...prev, message].sort((a, b) => a.sequence - b.sequence)
        })
        lastSequenceRef.current = Math.max(lastSequenceRef.current, message.sequence)
      },
    }
  )
  
  return {
    messages,
    isLoading: isLoading || isHistoryLoading,
    error: null,
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/renderer/features/agents/hooks/use-conversation-messages.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/renderer/features/agents/hooks/use-conversation-messages.ts
git commit -m "feat: implement real-time message subscription"
```

---

### Task 4: 实现去重和排序逻辑

**Files:**
- Modify: `src/renderer/features/agents/hooks/use-conversation-messages.ts`
- Test: `tests/renderer/features/agents/hooks/use-conversation-messages.test.ts`

**Interfaces:**
- Consumes: 现有逻辑
- Produces: 健壮的去重和排序

- [ ] **Step 1: Write tests for deduplication and sorting**

```typescript
// tests/renderer/features/agents/hooks/use-conversation-messages.test.ts
it("should deduplicate messages", async () => {
  const message = { id: "1", sequence: 1, role: "user", content: "Hello" }
  
  let subscriptionCallback: ((msg: Message) => void) | null = null
  
  vi.mocked(trpc.ergatai.listConversationMessages.useQuery).mockImplementation((input, options) => {
    setTimeout(() => options.onSuccess?.([message]), 0)
    return { data: [message], isLoading: false, error: null } as any
  })
  
  vi.mocked(trpc.ergatai.subscribeConversationMessages.useSubscription).mockImplementation((input, options) => {
    subscriptionCallback = options.onData
    return { error: null } as any
  })
  
  const { result } = renderHook(() => useConversationMessages("conv-123"))
  
  await waitFor(() => expect(result.current.isLoading).toBe(false))
  
  // Try to add duplicate
  subscriptionCallback?.(message)
  
  await waitFor(() => {
    expect(result.current.messages).toHaveLength(1)
  })
})

it("should sort messages by sequence", async () => {
  const messages = [
    { id: "1", sequence: 1, role: "user", content: "First" },
    { id: "3", sequence: 3, role: "assistant", content: "Third" },
  ]
  
  let subscriptionCallback: ((msg: Message) => void) | null = null
  
  vi.mocked(trpc.ergatai.listConversationMessages.useQuery).mockImplementation((input, options) => {
    setTimeout(() => options.onSuccess?.(messages), 0)
    return { data: messages, isLoading: false, error: null } as any
  })
  
  vi.mocked(trpc.ergatai.subscribeConversationMessages.useSubscription).mockImplementation((input, options) => {
    subscriptionCallback = options.onData
    return { error: null } as any
  })
  
  const { result } = renderHook(() => useConversationMessages("conv-123"))
  
  await waitFor(() => expect(result.current.isLoading).toBe(false))
  
  // Add message with sequence 2 (out of order)
  subscriptionCallback?.({ id: "2", sequence: 2, role: "user", content: "Second" })
  
  await waitFor(() => {
    expect(result.current.messages).toHaveLength(3)
    expect(result.current.messages.map(m => m.sequence)).toEqual([1, 2, 3])
  })
})
```

- [ ] **Step 2: Run tests to verify they pass**

Run: `bun test tests/renderer/features/agents/hooks/use-conversation-messages.test.ts`
Expected: PASS (already implemented in Task 3)

- [ ] **Step 3: Commit**

```bash
git add tests/renderer/features/agents/hooks/use-conversation-messages.test.ts
git commit -m "test: add deduplication and sorting tests"
```

---

### Task 5: 实现错误处理

**Files:**
- Modify: `src/renderer/features/agents/hooks/use-conversation-messages.ts`
- Test: `tests/renderer/features/agents/hooks/use-conversation-messages.test.ts`

**Interfaces:**
- Consumes: 现有逻辑
- Produces: 错误状态暴露

- [ ] **Step 1: Write test for error handling**

```typescript
// tests/renderer/features/agents/hooks/use-conversation-messages.test.ts
it("should expose subscription errors", async () => {
  const error = new Error("SSE connection failed")
  
  vi.mocked(trpc.ergatai.listConversationMessages.useQuery).mockReturnValue({
    data: [],
    isLoading: false,
    error: null,
  } as any)
  
  vi.mocked(trpc.ergatai.subscribeConversationMessages.useSubscription).mockReturnValue({
    error,
  } as any)
  
  const { result } = renderHook(() => useConversationMessages("conv-123"))
  
  await waitFor(() => {
    expect(result.current.error).toBe(error)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/renderer/features/agents/hooks/use-conversation-messages.test.ts -t "should expose subscription errors"`
Expected: FAIL

- [ ] **Step 3: Implement error handling**

```typescript
// src/renderer/features/agents/hooks/use-conversation-messages.ts
export function useConversationMessages(conversationId: string) {
  const [messages, setMessages] = useState<Message[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const lastSequenceRef = useRef(0)
  
  const { data: history, isLoading: isHistoryLoading, error: historyError } = 
    trpc.ergatai.listConversationMessages.useQuery(
      { conversationId },
      {
        enabled: !!conversationId,
        onSuccess: (data) => {
          setMessages(data)
          lastSequenceRef.current = Math.max(...data.map(m => m.sequence), 0)
          setIsLoading(false)
        },
      }
    )
  
  const { error: subscriptionError } = 
    trpc.ergatai.subscribeConversationMessages.useSubscription(
      { conversationId, afterSequence: lastSequenceRef.current },
      {
        enabled: !!conversationId && !isLoading,
        onData: (message) => {
          if (messages.some(m => m.id === message.id)) return
          setMessages(prev => [...prev, message].sort((a, b) => a.sequence - b.sequence))
          lastSequenceRef.current = Math.max(lastSequenceRef.current, message.sequence)
        },
      }
    )
  
  return {
    messages,
    isLoading: isLoading || isHistoryLoading,
    error: historyError || subscriptionError,
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/renderer/features/agents/hooks/use-conversation-messages.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/renderer/features/agents/hooks/use-conversation-messages.ts
git commit -m "feat: implement error handling"
```

---

### Task 6: 添加 tRPC Subscription 端点

**Files:**
- Modify: `src/main/lib/trpc/routers/ergatai.ts:825-875` (在 listConversationMessages 后添加)

**Interfaces:**
- Consumes: 后端 SSE 端点（待后端实现）
- Produces: `trpc.ergatai.subscribeConversationMessages`

- [ ] **Step 1: Add subscription to tRPC router**

```typescript
// src/main/lib/trpc/routers/ergatai.ts (在 listConversationMessages 后添加)
/**
 * 订阅 conversation 的实时消息（SSE）
 * 注意：需要后端实现 GET /api/v1/conversations/{id}/sse
 */
subscribeConversationMessages: publicProcedure
  .input(z.object({ 
    conversationId: z.string(),
    afterSequence: z.number().optional()
  }))
  .subscription(({ input }) => {
    return observable((emit) => {
      const backendUrl = process.env.ERGATAI_BACKEND_URL || "http://localhost:8080"
      const eventSource = new EventSource(
        `${backendUrl}/api/v1/conversations/${input.conversationId}/sse?after_sequence=${input.afterSequence ?? 0}`
      )
      
      eventSource.onmessage = (event) => {
        try {
          const message = JSON.parse(event.data) as BackendMessage
          emit.next(mapMessage(message))
        } catch (error) {
          console.error("[SSE] Parse error:", error)
        }
      }
      
      eventSource.onerror = (error) => {
        console.error("[SSE] Connection error:", error)
        emit.error(new Error("SSE connection failed"))
        eventSource.close()
      }
      
      return () => {
        eventSource.close()
      }
    })
  })
```

- [ ] **Step 2: Commit**

```bash
git add src/main/lib/trpc/routers/ergatai.ts
git commit -m "feat: add tRPC subscription for conversation messages"
```

---

### Task 7: 修改 inter-agent-replies-disclosure.tsx

**Files:**
- Modify: `src/renderer/features/agents/main/inter-agent-replies-disclosure.tsx:99-120`

**Interfaces:**
- Consumes: `useConversationMessages`
- Produces: 移除轮询，使用 Hook

- [ ] **Step 1: Remove polling and use new hook**

```typescript
// src/renderer/features/agents/main/inter-agent-replies-disclosure.tsx
import { useConversationMessages } from "../hooks/use-conversation-messages"

function AgentReplyDisclosure({
  conversationId,
  agentId,
  agentName,
}: {
  conversationId: string
  agentId: string
  agentName: string
}) {
  // ❌ 移除轮询
  // const { data } = trpc.ergatai.listConversationMessages.useQuery(
  //   { conversationId },
  //   { refetchInterval: 4000 }
  // )
  
  // ✅ 使用新 Hook
  const { messages, isLoading } = useConversationMessages(conversationId)
  
  const replies = useMemo(() => {
    if (isLoading) return []
    
    return messages
      .filter((message) => {
        const metadata = message.metadata
        return message.role !== "system" &&
          metadata?.source === "agent" &&
          metadata.senderAgentId === agentId
      })
      .sort((left, right) => left.sequence - right.sequence)
      .map((message) => ({
        ...message,
        text: getMessageText(message),
      }))
      .filter((message) => message.text.length > 0)
  }, [messages, agentId, isLoading])
  
  if (replies.length === 0) return null
  
  // ... rest of component
}
```

- [ ] **Step 2: Commit**

```bash
git add src/renderer/features/agents/main/inter-agent-replies-disclosure.tsx
git commit -m "refactor: replace polling with useConversationMessages hook"
```

---

### Task 8: 修改 collaboration-session-runtime.ts

**Files:**
- Modify: `src/renderer/features/agents/collaboration/collaboration-session-runtime.ts:367-379`

**Interfaces:**
- Consumes: tRPC subscription
- Produces: 移除轮询

- [ ] **Step 1: Remove polling and use subscription**

```typescript
// src/renderer/features/agents/collaboration/collaboration-session-runtime.ts
export function useCollaborationSession({ ... }: UseCollaborationSessionInput) {
  // ... existing code ...
  
  // ❌ 移除轮询
  // useEffect(() => {
  //   if (!pollingEnabled || !enabled || !session) return
  //   const interval = window.setInterval(() => {
  //     void (async () => {
  //       await refreshSession()
  //       await loadEvents(session.id)
  //     })()
  //   }, 1000)
  //   return () => window.clearInterval(interval)
  // }, [enabled, loadEvents, pollingEnabled, refreshSession, session])
  
  // ✅ 使用 subscription（需要后端实现）
  trpcClient.ergatai.subscribeCollaborationSessionEvents.useSubscription(
    { sessionId: session?.id },
    {
      enabled: !!session?.id && pollingEnabled,
      onData: (event) => {
        setEvents((prev) => {
          if (prev.some(e => e.id === event.id)) return prev
          return [...prev, event].sort((a, b) => a.sequence - b.sequence)
        })
      }
    }
  )
  
  // ... rest of hook
}
```

- [ ] **Step 2: Commit**

```bash
git add src/renderer/features/agents/collaboration/collaboration-session-runtime.ts
git commit -m "refactor: replace polling with subscription for collaboration events"
```

---

### Task 9: 运行完整测试套件

**Files:**
- Test: 所有修改的文件

- [ ] **Step 1: Run all tests**

Run: `bun test`
Expected: All tests pass

- [ ] **Step 2: Run type check**

Run: `bun type-check`
Expected: No type errors

- [ ] **Step 3: Run lint**

Run: `bun lint`
Expected: No lint errors

- [ ] **Step 4: Manual testing**

1. Start the app: `bun run dev`
2. Open a conversation with agent messages
3. Verify messages load immediately
4. Send a new message and verify it appears in real-time (< 100ms)
5. Close and reopen the conversation to verify historical loading
6. Check browser console for no errors

- [ ] **Step 5: Commit final changes**

```bash
git add .
git commit -m "feat: complete conversation real-time message subscription

- Implement useConversationMessages hook
- Replace polling with SSE subscription
- Add deduplication and sorting
- Add error handling
- Update documentation"
```

---

## 完成标准

- [ ] 所有单元测试通过
- [ ] 消息延迟 < 100ms
- [ ] 移除所有轮询代码
- [ ] 消息不丢失，不重复
- [ ] 自动重连正常工作
- [ ] 无 TypeScript 错误
- [ ] 无 lint 错误
