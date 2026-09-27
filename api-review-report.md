# API Endpoint Code Review Report

**Review Period**: Latest 10 commits (HEAD~10..HEAD)  
**Reviewer**: Code Review Agent  
**Date**: 2026-09-27

---

## Summary

Reviewed 6 API endpoint files for correctness, error handling, security, and best practices.  
**Findings**: 2 HIGH severity, 4 MEDIUM severity issues

---

## HIGH Severity Issues

### 1. File: `crates/ergatai-api/src/api/agents.rs`

**Location**: Lines 1108-1126 (in `send_message` handler)

**Issue**: Misleading error type when root conversation not found

When creating an agent conversation, if the root conversation is not found, the code returns `rusqlite::Error::InvalidParameterName` which is semantically incorrect and confusing for debugging.

```rust
let Some(root_conversation) =
    crate::user_data_db::conversations::get(&chat_id_for_conversation)?
else {
    return Err(rusqlite::Error::InvalidParameterName(
        "chat conversation not found".to_string(),
    ));
};
```

**Impact**: 
- Misleading error type makes debugging difficult
- Callers cannot distinguish between "conversation not found" and actual parameter errors
- Violates Rust error handling best practices

**Suggested Fix**: 
Define a custom error type or use a more appropriate error variant. Consider returning a custom error enum that clearly indicates "NotFound" vs validation errors.

---

### 2. File: `crates/ergatai-api/src/api/collaboration_sessions.rs`

**Location**: Lines 287-358 (`stream_collaboration_session_events` endpoint)

**Issue**: SSE stream endpoint lacks session validation and has no timeout

The SSE streaming endpoint does not validate that the session exists before starting the stream, and the polling loop runs indefinitely without any timeout or maximum duration.

```rust
pub async fn stream_collaboration_session_events(
    Path(session_id): Path<String>,
    Query(query): Query<StreamEventQuery>,
) -> Response {
    // ... replay logic ...
    
    tokio::spawn(async move {
        // ... polling loop with no exit condition ...
        loop {
            interval.tick().await;
            // ... poll events ...
        }
    });
```

**Impact**:
- Resource exhaustion: Clients can start unlimited streams for non-existent sessions
- Memory leaks: Streams never terminate, accumulating over time
- DoS vector: Malicious clients can exhaust server resources

**Suggested Fix**:
1. Validate session existence before starting the stream
2. Add a maximum stream duration (e.g., 1 hour)
3. Add client disconnect detection to clean up orphaned streams
4. Consider implementing a stream registry with limits per session/client

---

## MEDIUM Severity Issues

### 3. File: `crates/ergatai-api/src/api/agents.rs`

**Location**: Lines 1195-1197 and 1206-1220

**Issue**: Critical errors silently logged as warnings

Agent session binding and collaboration participant registration failures are only logged as warnings, potentially leading to inconsistent state.

```rust
if let Err(error) = tokio::task::spawn_blocking(move || {
    crate::user_data_db::agent_sessions::upsert(...)
}).await {
    tracing::warn!(error = %error, "Failed to bind agent session to conversation");
}

// ...

if let Err(error) = tokio::task::spawn_blocking(move || {
    crate::services::collaboration_session::upsert_participant(...)
}).await {
    tracing::warn!(error = %error, "Failed to register collaboration participant");
}
```

**Impact**:
- Agents may be spawned without proper session tracking
- Collaboration sessions may have missing participants
- Inconsistent state is hard to detect and recover from

**Suggested Fix**:
Consider whether these operations should be atomic with agent spawning. If failures are acceptable, document why and add monitoring/alerting. If not, propagate errors and roll back agent creation.

---

### 4. File: `crates/ergatai-api/src/api/user_conversations.rs`

**Location**: Lines 847-850 (`line_count` function)

**Issue**: Incorrect line counting for content with trailing newlines

The `line_count` function uses `split('\n').count()` which incorrectly counts empty trailing lines.

```rust
fn line_count(content: Option<&str>) -> u64 {
    content
        .map(|content| {
            if content.is_empty() {
                0
            } else {
                content.split('\n').count() as u64
            }
        })
        .unwrap_or(0)
}
```

**Example**: `"line1\nline2\n"` returns 3 instead of 2.

**Impact**:
- File change statistics are inaccurate
- May affect downstream tools relying on line counts

**Suggested Fix**:
Use `lines().count()` instead of `split('\n').count()`:
```rust
content.lines().count() as u64
```

---

### 5. File: `crates/ergatai-api/src/api/user_conversations.rs`

**Location**: Lines 861-905 (`calculate_conversation_file_changes` function)

**Issue**: No path validation for file paths extracted from tool calls

The function extracts file paths from tool call inputs without validating they are absolute or within expected boundaries.

```rust
let Some(file_path) = resolve_tool_file_path(input) else {
    continue;
};
if is_session_file(&file_path) {
    continue;
}
```

**Impact**:
- Relative paths could cause incorrect file tracking
- Paths outside the workspace could be included in statistics
- Potential for misleading file change reports

**Suggested Fix**:
Add validation to ensure paths are absolute and optionally within the workspace/project boundaries:
```rust
if !file_path.starts_with('/') {
    continue; // Skip relative paths
}
```

---

### 6. File: `crates/ergatai-api/src/api/collaboration_sessions.rs`

**Location**: Lines 310-314 (poll interval configuration)

**Issue**: Aggressive minimum poll interval allows resource abuse

The poll interval is clamped to a minimum of 50ms, which is very aggressive and allows clients to create high-frequency polling loops.

```rust
let poll_interval_ms = query.poll_interval_ms.unwrap_or(250).clamp(50, 5_000);
```

**Impact**:
- High CPU usage from frequent polling
- Database load from repeated queries
- Potential for abuse with multiple concurrent streams

**Suggested Fix**:
Increase minimum poll interval to a more reasonable value (e.g., 500ms or 1000ms):
```rust
let poll_interval_ms = query.poll_interval_ms.unwrap_or(1000).clamp(500, 30_000);
```

---

## Positive Observations

1. **Good input validation**: Message length limits, work_dir validation
2. **Proper error propagation**: Most errors are correctly propagated with appropriate HTTP status codes
3. **Security**: Command validation, path sanitization in place
4. **Type safety**: Good use of Rust's type system for error handling
5. **Comprehensive tests**: Good test coverage for new functionality

---

## Recommendations

1. **Address HIGH severity issues immediately** - These can lead to resource exhaustion and debugging difficulties
2. **Add integration tests** for error scenarios (session not found, conversation not found)
3. **Consider adding metrics** for tracking warning-level errors to detect consistency issues
4. **Document error handling strategy** - When are warnings acceptable vs when should errors propagate?
5. **Add stream cleanup mechanism** - Implement periodic cleanup of orphaned SSE streams

---

## Files Reviewed

- `crates/ergatai-api/src/api/agents.rs` - Agent spawning and messaging
- `crates/ergatai-api/src/api/workspaces.rs` - Workspace management
- `crates/ergatai-api/src/api/collaboration_sessions.rs` - NEW: Collaboration session CRUD
- `crates/ergatai-api/src/api/conversations.rs` - Conversation management (tests only)
- `crates/ergatai-api/src/api/user_conversations.rs` - User conversation data API
- `crates/ergatai-api/src/api/agent_profiles.rs` - Agent profile registry (tests only)
