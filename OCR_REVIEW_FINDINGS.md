# OCR Code Review Findings - ID Migration Commit

**Commit**: `8cd0283` - [ID Migration] Fix compilation errors in ergatai-api and workspace  
**Review Date**: 2026-10-21  
**Reviewer**: Open Code Review (OCR)  
**Files Reviewed**: 59 Rust files + frontend TypeScript files

---

## Summary

Large-scale ID migration from string-based IDs to typed IDs (Snowflake IDs, `i64` newtype wrappers). The migration improves type safety but introduces several issues related to error handling, backward compatibility, and frontend integration.

**Total Issues Found**: 17
- 🔴 High: 4
- 🟡 Medium: 7
- 🟢 Low: 6

---

## 🔴 High Severity Issues (4)

### 1-2. Workspace Unregister Memory Leak

**File**: `crates/ergatai-api/src/services/workspace_manager.rs:614-616`

**Problem**: 
- `register_workspace` (called in `main.rs:650`) stores workspace ID as raw i64 decimal string (e.g., `"1234567890"`)
- `unregister_workspace` (in `archive_workspace` and `delete`) uses formatted typed ID (e.g., `"ws_123_001_0001"`)
- Format mismatch causes permission handler entry to never be cleaned up → memory leak

**Impact**: 
Every archived or deleted workspace leaves orphaned entries in the permission handler, causing memory growth over time.

**Fix**:
```rust
// Use raw i64 value to match the stored key format
permission_handler
    .unregister_workspace(&workspace_id.as_i64().to_string())
    .await;
```

**Locations**:
- Line 614-616: `archive_workspace` function
- Line 615-616: `delete` function

---

### 3. Async onSuccess Callback Without Error Handling

**File**: `frontend/src/renderer/features/agents/components/workspace-selector.tsx:121-129`

**Problem**:
- `onSuccess` callback is now `async` and performs awaited operations (`invalidate()`, `fetch()`)
- React Query calls `onSuccess` without awaiting its return value
- Any rejection produces unhandled promise rejection, leaving UI in inconsistent state

**Impact**:
Workspace created successfully but UI doesn't refresh properly, user gets no error feedback.

**Fix**:
```typescript
onSuccess: async (workspace) => {
  toast.success("Default workspace created")
  try {
    await utils.ergatai.listManagedWorkspaces.invalidate()
    await utils.projects.list.invalidate()
    const freshProjects = await utils.projects.list.fetch()
    // ... rest of logic
  } catch (err) {
    toast.error("Workspace created but failed to refresh data", {
      description: err instanceof Error ? err.message : "Please refresh and try again",
    })
    return
  }
}
```

---

### 4. Async handleWorkspaceSelected Without Error Handling

**File**: `frontend/src/renderer/features/agents/ui/agents-default-view.tsx:60-64`

**Problem**:
- `handleWorkspaceSelected` is `async` but prop type signature is `(workspace) => void` (synchronous)
- Caller in `workspace-selector.tsx` invokes it without awaiting
- Any rejection is completely unhandled

**Impact**:
Network failures during workspace fetch cause unhandled promise rejections, poor UX.

**Fix**:
```typescript
const handleWorkspaceSelected = useCallback(
  async (workspace: { id: string; name: string; path: string }) => {
    try {
      const freshWorkspaces = await utils.ergatai.listManagedWorkspaces.fetch({
        collaborationMode,
      })
      // ... rest of logic
    } catch (err) {
      toast.error("Failed to check existing workspaces", {
        description: err instanceof Error ? err.message : "Please try again",
      })
      return
    }
  },
  [collaborationMode]
)
```

Consider updating prop type to `(workspace) => void | Promise<void>` to signal async behavior.

---

## 🟡 Medium Severity Issues (7)

### 5. Silent Fallback to Invalid AgentId(0)

**File**: `crates/ergatai-api/src/api/agents.rs:3037-3037`

**Problem**:
- `parse_to_i64(&runtime_id)` failure silently constructs `AgentId::new(0)`
- Published `AgentInterrupted` event attributes interrupt to non-existent agent
- Same issue at line 3215 for `GroupAgentBinding.agent_id`

**Impact**:
Downstream consumers can't diagnose which agent actually caused the interrupt.

**Fix**:
```rust
let agent_id = match parse_to_i64(&runtime_id) {
    Some(id) => AgentId::new(id),
    None => {
        tracing::warn!(runtime_id = %runtime_id, "Failed to parse agent ID; using sentinel");
        AgentId::new(0)
    }
};
```

---

### 6. Incorrect Timestamp Semantics

**File**: `frontend/src/main/lib/trpc/routers/ergatai.ts:1762-1763`

**Problem**:
- `agent.last_heartbeat` used for both `createdAt` and `updatedAt`
- `last_heartbeat` is frequently-updated activity timestamp, not binding creation time
- Dedup logic in `use-agent-participants.ts:203` compares `binding.createdAt` to keep "newest" entry
- With heartbeat-based timestamps, dedup picks agent with most recent heartbeat, not most recent binding

**Impact**:
May evict wrong binding entry during deduplication.

**Fix**:
If backend doesn't provide `bound_at` or `created_at` field, consider adding one. Alternatively, document this as a known limitation.

---

### 7. Duplicated Workspace Re-fetch Logic

**File**: `frontend/src/main/lib/trpc/routers/ergatai.ts:1416-1420`

**Problem**:
- Workspace re-fetch block is duplicated verbatim in both `input.projectId` and `input.projectPath` branches
- Violates DRY principle

**Fix**:
```typescript
if (input.projectId) {
  await ergataiFetch(...)
} else if (input.projectPath) {
  const project = await ergataiFetch(...)
  await ergataiFetch(...)
}
// Re-fetch once after the if/else block
workspace = await ergataiFetch<BackendManagedWorkspace>(
  `/api/v1/workspaces/managed/${encodeURIComponent(workspace.workspace_id)}`,
  { method: "GET" },
)
```

---

### 8. Orphaned Conversation on Worktree Failure

**File**: `frontend/src/main/lib/trpc/routers/chats.ts:421-425`

**Problem**:
- Conversation created eagerly (line 421-428) before worktree setup (line 439-503)
- If `createWorktreeForChat` throws unhandled exception, conversation remains orphaned in backend

**Impact**:
Database accumulates orphaned conversations with no cleanup mechanism.

**Fix**:
```typescript
try {
  // Create conversation
  const conversation = await createConversation(...)
  
  // Worktree setup
  const worktreeResult = await createWorktreeForChat(...)
  if (!worktreeResult.success) {
    // Cleanup conversation
    await deleteConversation(conversation.id)
    throw new Error("Worktree setup failed")
  }
  
  return conversation
} catch (err) {
  // Ensure cleanup on any error
  if (conversation?.id) {
    await deleteConversation(conversation.id).catch(() => {})
  }
  throw err
}
```

---

### 9. HTTP 500 Never Retried

**File**: `crates/ergatai-api/src/mcp_stdio_adapter.rs:243-249`

**Problem**:
- `forward_to_http` converts ALL non-success HTTP responses into `anyhow::anyhow!()` (line 297)
- This is NOT a `reqwest::Error`, so `downcast_ref::<reqwest::Error>()` never matches
- String fallback only checks "502", "503", "504", missing "500" and other 5xx codes

**Impact**:
HTTP 500 errors are never retried, reducing reliability for transient server errors.

**Fix**:
```rust
let msg = e.to_string().to_lowercase();
msg.contains("connection")
    || msg.contains("timeout")
    || msg.contains("500")
    || msg.contains("502")
    || msg.contains("503")
    || msg.contains("504")
    || msg.contains("507")
```

Better: preserve HTTP status code in structured error type to avoid string matching.

---

### 10. Dead Code: replaceConversationMessages

**File**: `frontend/src/main/lib/ergatai/user-data.ts:260-263`

**Problem**:
- `replaceConversationMessages` no longer called by production code
- Previous call site replaced with inline `ergataiFetch` using `POST` instead of `PUT`
- Function still exists with old `PUT` method, doesn't match actual API contract

**Impact**:
Code confusion, potential for misuse if someone calls it expecting PUT behavior.

**Fix**: Remove function and corresponding test in `frontend/tests/user-data.test.ts`.

---

### 11. Dead Code: modeWorkspaces Query

**File**: `frontend/src/renderer/features/agents/ui/agents-default-view.tsx:34-40`

**Problem**:
- `modeWorkspaces` useMemo and `useQuery` call are unused
- `handleWorkspaceSelected` updated to fetch fresh data via `.fetch()`
- Variable declared but never read

**Impact**:
Unnecessary network request on every render, wasted resources.

**Fix**: Remove `modeWorkspaces`, `useMemo`, and `useQuery` call (and imports).

---

## 🟢 Low Severity Issues (6)

### 12. Misleading `_i64` Suffix on Typed ID Variables

**File**: `crates/ergatai-api/src/api/agents.rs:2871-2877`

**Problem**:
- Variables like `conversation_id_i64`, `workspace_id_i64`, `chat_id_i64` now hold typed values (`ConversationId`, `WorkspaceId`, `ChatId`)
- `_i64` suffix misleading, suggests raw integer

**Fix**: Rename to `conversation_id_typed`, `workspace_id`, `chat_id` (or similar).

---

### 13. Silent Error Discard in ConversationId::decode

**File**: `crates/ergatai-api/src/api/agents.rs:3044-3047`

**Problem**:
- `.ok()` discards decode error
- Future refactoring could silently produce `conversation_id: None`

**Fix**: Log warning on decode failure or reuse already-parsed value from earlier in function.

---

### 14. Wasteful JSON Round-trip

**File**: `frontend/src/main/lib/trpc/routers/chats.ts:427-427`

**Problem**:
- Caller passes `JSON.stringify(initialMessages)`
- `updateConversationMessages` immediately parses it back (`JSON.parse(messages)`)
- Then re-stringifies for API call

**Fix**: Change `updateConversationMessages` to accept `Array<Record<string, unknown>>` directly.

---

### 15. Inconsistent Type Cast

**File**: `frontend/src/renderer/features/agents/components/workspace-selector.tsx:157-157`

**Problem**:
- Uses `NonNullable<typeof selectedWorkspace>["gitProvider"]`
- Other locations use explicit `"github" | "gitlab" | "bitbucket" | null`

**Fix**: Use explicit union type for consistency.

---

### 16. Unnecessary drop()

**File**: `crates/ergatai-api/src/user_conversations.rs:745-745`

**Problem**:
- `Conversation` is plain data struct (no `Drop` impl)
- Will be dropped automatically at end of scope
- Explicit `drop()` adds no value

**Fix**: Remove `drop(conversation)` line.

---

### 17. Dead Code: listAllConversations

**File**: `frontend/src/main/lib/ergatai/user-data.ts:237-239`

**Problem**:
- `listAllConversations` no longer imported or called by production code
- Exported function with no consumers

**Fix**: Remove function and corresponding test.

---

## Recommendations

### Immediate Action (High Priority)
1. **Fix workspace unregister memory leak** - Causes resource exhaustion over time
2. **Add error handling to async callbacks** - Prevents unhandled promise rejections

### Short-term (Medium Priority)
3. **Fix HTTP 500 retry logic** - Improves reliability
4. **Add logging for ID decode failures** - Improves debuggability during migration
5. **Clean up dead code** - Reduces confusion and maintenance burden

### Long-term (Low Priority)
6. **Rename misleading variables** - Improves code clarity
7. **Optimize JSON serialization** - Minor performance improvement
8. **Consistent type annotations** - Improves code consistency

---

## Testing

All fixes should include:
- Unit tests for error paths (decode failures, parse failures)
- Integration tests for workspace lifecycle (create → archive → verify cleanup)
- Frontend E2E tests for workspace creation with network failures

---

## Notes

- Migration successfully improved type safety across the codebase
- Most issues are related to error handling and backward compatibility
- Frontend issues primarily involve async error handling patterns
- Dead code should be removed in a follow-up cleanup PR
