# Unified SSE Channel Implementation

**Date**: 2026-10-11  
**Status**: ✅ Completed (Deprecated endpoint removed)  
**Impact**: Frontend simplification, reduced architecture complexity

---

## Current Status (2026-10-11)

✅ **Deprecated endpoint fully removed**:
- `/api/v1/agents/{id}/stream` endpoint deleted
- `stream_agent_output` function removed (~485 lines)
- `AgentStreamQuery` struct removed
- Route registration and related imports cleaned up
- All tests passing, no compilation warnings

**Migration required**: Frontend must use `/api/v1/conversations/{id}/sse` unified SSE endpoint.

---

## Summary

Merged User→Agent and Agent→Agent SSE channels into a single unified channel at `/conversations/{id}/sse`. The frontend now only needs to subscribe to one endpoint to receive all conversation events.

## Changes Made

### 1. Modified `NatsOutputPublisher` (`crates/ergatai-api/src/services/nats_output_publisher.rs`)

**Before**: Published agent output to `ergatai.agent.output.{conversation_id}` only.

**After**: Publishes to **both** subjects:
- **Primary**: `ergatai.conversation.message.{conversation_id}` (unified SSE)
- **Deprecated**: `ergatai.agent.output.{conversation_id}` (backward compatibility)

This dual-publish approach ensures:
- ✅ Frontend can migrate to unified SSE gradually
- ✅ Existing `/agents/{id}/stream` endpoint continues to work
- ✅ No breaking changes during transition

### 2. Enhanced `conversation_sse.rs` (`crates/ergatai-api/src/api/conversation_sse.rs`)

**Before**: Only handled `ConversationMessagePayload` (persisted messages).

**After**: Handles both event types:
- `ConversationMessagePayload` — user messages, agent-to-agent messages (persisted)
- `AgentOutputEvent` — real-time agent output (Text, Thinking, ToolCall, etc.)

Agent output events are wrapped in a unified envelope:
```json
{
  "type": "agent_output",
  "event": { /* AgentOutputEvent */ }
}
```

### 3. Deprecated `/agents/{id}/stream` Endpoint (已移除 - 2026-10-11)

**历史**：
- 最初标记为 deprecated，添加运行时警告
- 2026-10-11: **完全移除** deprecated endpoint

**已删除内容**：
- `stream_agent_output` 函数 (约 485 行)
- `AgentStreamQuery` 结构体
- 路由注册和相关导入
- 辅助代码和变量

**迁移路径**：
前端必须使用 `/api/v1/conversations/{id}/sse` 统一 SSE 端点。

---

## Architecture

### Before: Dual SSE Channels

```
┌─────────────────────────────────────────────────────────────┐
│ Frontend                                                     │
├─────────────────────────────────────────────────────────────┤
│ Subscribe to:                                                │
│ 1. /agents/{id}/stream → ergatai.agent.output.{conv_id}     │
│    - Agent output (Text, Thinking, ToolCall, Done)           │
│    - Real-time, not persisted                                │
│                                                              │
│ 2. /conversations/{id}/sse → ergatai.conversation.message.* │
│    - User messages, agent-to-agent messages                  │
│    - Persisted to SQLite                                     │
└─────────────────────────────────────────────────────────────┘
```

**Problems**:
- ❌ Frontend needs two subscriptions
- ❌ Redundant architecture
- ❌ Complex state management

### After: Unified SSE Channel

```
┌─────────────────────────────────────────────────────────────┐
│ Frontend                                                     │
├─────────────────────────────────────────────────────────────┤
│ Subscribe to:                                                │
│ /conversations/{id}/sse → ergatai.conversation.message.*    │
│   - User messages (persisted)                                │
│   - Agent-to-agent messages (persisted)                      │
│   - Agent output events (real-time)                          │
│     - Text, Thinking, ToolCall, Done, etc.                   │
└─────────────────────────────────────────────────────────────┘

Backend:
  Agent Output → NatsOutputPublisher
    ├─→ ergatai.conversation.message.{conv_id} (primary, unified)
    └─→ ergatai.agent.output.{conv_id} (deprecated, backward compat)
```

**Benefits**:
- ✅ Single subscription for all events
- ✅ Simplified frontend code
- ✅ Unified event model
- ✅ Easier to maintain

---

## Migration Guide

### For Frontend Developers

**Step 1**: Update SSE subscription

```typescript
// ❌ Old: Two subscriptions
const agentStream = new EventSource(`/api/v1/agents/${agentId}/stream`);
const conversationStream = new EventSource(`/api/v1/conversations/${conversationId}/sse`);

agentStream.onmessage = (event) => {
  const output = JSON.parse(event.data); // AgentOutputEvent
  handleAgentOutput(output);
};

conversationStream.onmessage = (event) => {
  const message = JSON.parse(event.data); // ConversationMessagePayload
  handleMessage(message);
};

// ✅ New: Single subscription
const unifiedStream = new EventSource(`/api/v1/conversations/${conversationId}/sse`);

unifiedStream.onmessage = (event) => {
  const data = JSON.parse(event.data);
  
  if (data.type === 'agent_output') {
    // Agent real-time output (Text, Thinking, ToolCall, etc.)
    handleAgentOutput(data.event);
  } else {
    // Persisted message (user, agent-to-agent)
    handleMessage(data);
  }
};
```

**Step 2**: Handle unified event types

```typescript
type UnifiedEvent =
  | ConversationMessagePayload  // User/agent messages
  | { type: 'agent_output', event: AgentOutputEvent };  // Agent output

function handleEvent(event: UnifiedEvent) {
  if ('type' in event && event.type === 'agent_output') {
    // Real-time agent output
    switch (event.event.type) {
      case 'text':
        appendText(event.event.delta);
        break;
      case 'thinking':
        appendThinking(event.event.delta);
        break;
      case 'tool_call_start':
        showToolCall(event.event);
        break;
      case 'done':
        markComplete(event.event);
        break;
    }
  } else {
    // Persisted message
    const msg = event as ConversationMessagePayload;
    switch (msg.role) {
      case 'user':
        addUserMessage(msg);
        break;
      case 'agent':
        addAgentRequest(msg);
        break;
      case 'assistant':
        addAssistantResponse(msg);
        break;
    }
  }
}
```

**Step 3**: Remove deprecated endpoint usage

Search for `/agents/` and `/stream` in your codebase and replace with `/conversations/{id}/sse`.

---

## Event Types

### ConversationMessagePayload (Persisted Messages)

```typescript
interface ConversationMessagePayload {
  conversation_id: string;
  message_id: string;
  role: 'user' | 'agent' | 'assistant' | 'system';
  content: string;
  parts?: MessagePart[];
  metadata?: Record<string, any>;
  timestamp: number;
  sequence: number;
  sender_agent_id?: string;
  sender_agent_name?: string;
}
```

### AgentOutputEvent (Real-time Output)

```typescript
type AgentOutputEvent =
  | { type: 'text', delta: string }
  | { type: 'thinking', delta: string }
  | { type: 'tool_call_start', id: string, name: string, input?: any, locations: ToolCallLocation[] }
  | { type: 'tool_call_input', id: string, delta: string }
  | { type: 'tool_call_complete', id: string, name: string, input?: any, output?: any, locations: ToolCallLocation[] }
  | { type: 'tool_call_error', id: string, error: string }
  | { type: 'session_title_update', title: string }
  | { type: 'done', reason: string }
  | { type: 'error', message: string };
```

### Unified Envelope

```typescript
// Messages from /conversations/{id}/sse
type SSEEvent = ConversationMessagePayload | {
  type: 'agent_output',
  event: AgentOutputEvent
};
```

---

## Backward Compatibility

### Phase 1: Dual Publishing (Current)

- Agent output published to both subjects
- Both endpoints functional
- No breaking changes

### Phase 2: Frontend Migration

- Frontend migrates to `/conversations/{id}/sse`
- Monitor usage of `/agents/{id}/stream` via logs
- Deprecation warnings visible in logs

### Phase 3: Cleanup (Future)

- Remove `/agents/{id}/stream` endpoint
- Remove dual publishing from `NatsOutputPublisher`
- Remove `ergatai.agent.output.*` subject usage

---

## Testing

### Manual Testing

1. **Start API server**:
   ```bash
   cargo run -p ergatai-api -- --port 3000
   ```

2. **Subscribe to unified SSE**:
   ```bash
   curl -N http://localhost:3000/api/v1/conversations/{conv_id}/sse
   ```

3. **Send user message**:
   ```bash
   curl -X POST http://localhost:3000/api/v1/agents/{agent_id}/prompt \
     -H "Content-Type: application/json" \
     -d '{"message": "Hello"}'
   ```

4. **Verify events**:
   - ✅ User message appears (role: "user")
   - ✅ Agent output events appear (type: "agent_output")
   - ✅ Agent response appears (role: "assistant")

### Automated Testing

```bash
# Run all tests
cargo test --workspace

# Run specific test
cargo test -p ergatai-api conversation_sse
```

---

## Performance Considerations

### Load Impact

- **Before**: 2 SSE connections per active conversation
- **After**: 1 SSE connection per active conversation
- **Improvement**: 50% reduction in SSE connections

### Message Volume

- Agent output events now flow through conversation subject
- No additional persistence overhead (events already published to NATS)
- Slight increase in conversation subject traffic (acceptable)

### Latency

- No measurable latency increase
- Agent output still published via core NATS (non-JetStream)
- Same delivery path, just different subject

---

## Monitoring

### Deprecation Tracking

Monitor usage of deprecated endpoint via logs:

```bash
# Search for deprecation warnings
grep "Deprecated endpoint /api/v1/agents/:id/stream" logs/api.log
```

### Metrics

Add metrics to track:
- Number of SSE connections per endpoint
- Message throughput per subject
- Frontend migration progress

---

## Rollback Plan

If issues arise:

1. **Revert `NatsOutputPublisher`** to single-subject publishing
2. **Revert `conversation_sse.rs`** to message-only handling
3. **Remove deprecation notice** from `agents.rs`

All changes are additive, so rollback is straightforward.

---

## Future Enhancements

1. **Event Filtering**: Allow frontend to subscribe to specific event types
2. **Reconnection Logic**: Add `Last-Event-ID` support for resumption
3. **Compression**: Consider SSE event compression for large payloads
4. **Rate Limiting**: Add per-connection rate limits to prevent abuse

---

## References

- Original Issue: [Link to issue]
- Architecture Discussion: [Link to discussion]
- Frontend Migration Guide: [Link to frontend docs]
- API Documentation: `/docs/api/sse.md`

---

## Checklist

- [x] Modify `NatsOutputPublisher` for dual publishing
- [x] Enhance `conversation_sse.rs` to handle both event types
- [x] Add deprecation notice to `/agents/{id}/stream`
- [x] Add runtime warning log for deprecated endpoint
- [x] Update documentation
- [x] Test compilation (`cargo check`)
- [ ] Update frontend to use unified SSE
- [ ] Monitor deprecation warnings
- [ ] Remove deprecated endpoint (after migration complete)
- [ ] Update API documentation version
