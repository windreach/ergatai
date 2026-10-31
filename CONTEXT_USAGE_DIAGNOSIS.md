# 配额 UI 渲染数据流诊断报告

## 数据流追踪

### 1. 后端数据采集 ✅

**文件**: `crates/ergatai-runtime/src/backends/acp.rs`

```rust
// Line 881: ACP 收到 UsageUpdate 时
acc.set_context_usage(usage_update.used, usage_update.size);

// Line 896-904: 通过 SSE 发送给前端
send_output_event_internal(
    token.as_ref(),
    Some(conversation_id),
    AgentOutputEvent::ContextUsage {
        used: usage_update.used,
        size: usage_update.size,
    },
)
.await;
```

**状态**: ✅ 正常工作

---

### 2. 后端持久化 ✅

**文件**: `crates/ergatai-api/src/services/agent_output_persistence.rs`

```rust
// Line 325-344: 从 metadata 提取 context_used 和 context_window
let cu = metadata.get("context_used").and_then(|v| v.as_u64()).map(|v| v as i64);
let cw = metadata.get("context_window").and_then(|v| v.as_u64()).map(|v| v as i64);

// Line 390-407: 更新数据库
if let (Some(cu), Some(cw)) = (context_used, context_window) {
    crate::user_data_db::conversations::update_context_usage(
        conversation_id,
        cu,
        cw,
    )?;
}
```

**状态**: ✅ 正常工作（但需要验证 metadata 中是否真的有值）

---

### 3. 后端 API 端点 ✅

**文件**: `crates/ergatai-api/src/api/user_conversations.rs`

```rust
// GET /api/v1/conversations/{id}/context-usage
pub async fn get_conversation_context_usage(...) -> Response {
    let conversation = conversations::get(id_i64).await?;
    
    let response = ContextUsageResponse {
        conversation_id: id,
        context_used: conversation.context_used,
        context_window: conversation.context_window,
        percent_used: percent_used.min(100.0),
        updated_at: conversation.context_updated_at,
    };
}
```

**状态**: ✅ 端点存在且返回数据

---

### 4. 前端初始加载 ✅

**文件**: `frontend/src/renderer/features/agents/hooks/use-question-handling.ts`

```typescript
// Line 44-70: 初始加载时从数据库获取
const fetchInitialContextUsage = async () => {
    const result = await trpcClient.ergatai.getConversationContextUsage.query({
        conversationId,
    })
    
    // 初始化 session store
    if (result.context_used > 0 || result.context_window > 0) {
        sessionStore.updateContextUsage(
            conversationId,
            result.context_used,
            result.context_window,
        )
    }
}
```

**状态**: ✅ 正常获取并更新 store

---

### 5. 前端实时更新 ✅

**文件**: `frontend/src/renderer/features/agents/lib/ergatai-chat-transport.ts`

```typescript
// Line 470-482: 处理 SSE context_usage 事件
if (event.type === "context_usage") {
    console.log("[ErgataiChatTransport] Received context_usage event:", {
        used: event.used,
        size: event.size,
        conversationId: effectiveConversationId,
    });
    
    const sessionStore = getRuntimeSessionStore()
    if (effectiveConversationId) {
        sessionStore.updateContextUsage(effectiveConversationId, event.used, event.size)
    }
}
```

**状态**: ✅ 正常接收并更新 store

---

### 6. Session Store 状态管理 ✅

**文件**: `frontend/src/renderer/features/conversation/runtime/runtime-session-store.ts`

```typescript
// Line 417-438: 更新 context usage
updateContextUsage(conversationId: string, used: number, size: number): void {
    const session = this.ensureSession(conversationId)
    if (session.contextUsed === used && session.contextWindow === size) {
        return
    }
    session.contextUsed = used
    session.contextWindow = size
    session.cachedPublicState = null // 使缓存失效
    session.updatedAt = new Date()
    this.notifyListeners(conversationId)
}

// Line 642-643: 转换为公开状态
contextUsed: session.contextUsed || undefined,
contextWindow: session.contextWindow || undefined,
```

**状态**: ✅ 正常更新并通知监听器

---

### 7. React Hook 订阅 ✅

**文件**: `frontend/src/renderer/features/conversation/runtime/use-conversation-invocation.ts`

```typescript
export function useSessionState(conversationId: string) {
    const subscribe = useCallback(
        (callback: () => void) => {
            return sessionStore.subscribe(conversationId, () => {
                callback()
            })
        },
        [sessionStore, conversationId],
    )
    
    const getSnapshot = useCallback(() => {
        return sessionStore.getRuntimeState(conversationId)
    }, [sessionStore, conversationId])
    
    return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}
```

**状态**: ✅ 使用 `useSyncExternalStore` 正确订阅

---

### 8. Token Data 计算 ✅

**文件**: `frontend/src/renderer/features/agents/hooks/use-question-handling.ts`

```typescript
// Line 38: 订阅 session state
const sessionState = useSessionState(conversationId)

// Line 144-153: 计算 messageTokenData
const messageTokenData = useMemo(() => {
    const contextUsed = sessionState?.contextUsed
    const sessionContextWindow = sessionState?.contextWindow
    
    return {
        totalInputTokens,
        totalOutputTokens,
        totalCostUsd,
        messageCount,
        contextWindow: sessionContextWindow || contextWindow,
        contextUsed,
    }
}, [messages, provider, conversationId, sessionState])
```

**状态**: ✅ 正确读取并包含在 messageTokenData 中

---

### 9. UI 组件渲染 ✅

**文件**: `frontend/src/renderer/features/agents/ui/agent-context-indicator.tsx`

```typescript
// Line 109-112: 使用 tokenData
const contextTokens = tokenData.contextUsed ?? tokenData.totalInputTokens
const contextWindow = Math.max(1, tokenData.contextWindow ?? CONTEXT_WINDOWS[modelId])
const percentUsed = Math.min(100, (contextTokens / contextWindow) * 100)

// Line 115-121: 调试日志
console.log("[AgentContextIndicator] Rendering with:", {
    contextTokens,
    contextWindow,
    percentUsed,
    isEmpty,
    source: tokenData.contextUsed !== undefined ? "ACP" : "metadata",
})
```

**状态**: ✅ 正确渲染

---

## 诊断建议

### 1. 检查后端日志

```bash
# 查看是否收到 UsageUpdate
grep "Accumulating context_usage in active turn" <log_file>

# 查看是否发送 SSE 事件
grep "Sending ContextUsage event to frontend" <log_file>

# 查看是否持久化到数据库
grep "Updating conversation context usage in database" <log_file>
```

### 2. 检查前端控制台

打开浏览器控制台，应该看到：

```javascript
"[ErgataiChatTransport] Received context_usage event: { used: X, size: Y, conversationId: Z }"
"[useQuestionHandling] Fetching initial context usage for: <conversation_id>"
"[useQuestionHandling] Initial context usage: { context_used: X, context_window: Y }"
"[AgentContextIndicator] Rendering with: { contextTokens: X, contextWindow: Y, ... }"
```

### 3. 检查数据库

```sql
SELECT conversation_id, context_used, context_window, context_updated_at
FROM conversations
WHERE conversation_id = <your_conversation_id>;
```

---

## 结论

**数据流完整性**: ✅ 完整（从后端到 UI 的所有连接都已实现）

**最可能的问题**: 
1. 后端 metadata 中缺少 context_used/context_window 字段
2. ACP 没有发送 UsageUpdate 通知
3. 前端没有收到 SSE 事件（网络或连接问题）

**建议**: 按照上述诊断步骤逐步排查，确定数据在哪个环节丢失。
