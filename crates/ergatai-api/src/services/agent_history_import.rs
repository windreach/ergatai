//! Agent history import (ACP resume) implementation shared by job worker and sync API.

use anyhow::Context;
use ergatai_error::ConversationId;

#[derive(Debug, Clone, Default)]
pub struct ImportAgentSessionHistoryInput {
    pub chat_id: Option<i64>,
    pub acp_session_id: String,
    pub cwd: Option<String>,
    pub title: Option<String>,
    pub conversation_id: Option<i64>,
    pub capture_limit: Option<usize>,
    pub persist_limit: Option<usize>,
    pub limit: Option<usize>,
    pub cursor: Option<String>,
}

use lru::LruCache;
use std::num::NonZeroUsize;
use std::sync::Mutex as StdMutex;

// LRU cache with bounded capacity to prevent unbounded memory growth.
// Capacity: 100 sessions (each with full message history).
// Eviction: Least Recently Used when capacity is reached.
#[allow(clippy::type_complexity)]
static NATIVE_CACHE: StdMutex<Option<LruCache<String, (u64, Vec<serde_json::Value>)>>> =
    StdMutex::new(None);
const NATIVE_CACHE_CAPACITY: usize = 100;

fn native_cache_key(session_id: &str, cwd: &str) -> String {
    format!("{}|{}", session_id, cwd)
}

/// Returns the modification time of the file, or None if it cannot be read.
/// Using Option<u64> instead of a sentinel value (like 0) allows distinguishing
/// between "file not found" and "error reading metadata", preventing false cache hits.
fn file_mtime(path: &std::path::Path) -> Option<u64> {
    std::fs::metadata(path)
        .ok()
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
}

/// Cached wrapper around try_native_capture. Reuses parsed result when the
/// underlying source file's mtime is unchanged.
/// Uses LRU cache with bounded capacity to prevent unbounded memory growth.
fn try_native_capture_cached(session_id: &str, cwd: &str) -> Option<Vec<serde_json::Value>> {
    // Determine source mtime for cache invalidation.
    // Check all possible source files (claude, opencode, codex) to ensure
    // cache is invalidated when any of them changes.
    let home = std::env::var("HOME").ok()?;
    let claude_path = std::path::PathBuf::from(&home)
        .join(".claude/projects")
        .join(format!(
            "-{}",
            cwd.trim_start_matches('/').replace('/', "-")
        ))
        .join(format!("{}.jsonl", session_id));
    let opencode_path = std::path::PathBuf::from(&home).join(".local/share/opencode/opencode.db");
    let codex_path = std::path::PathBuf::from(&home)
        .join(".codex/sessions")
        .join(format!("{}.jsonl", session_id));

    // Get mtime from whichever source file exists (if any).
    // Return None if mtime cannot be determined to avoid false cache hits.
    let mtime = if claude_path.exists() {
        file_mtime(&claude_path)?
    } else if opencode_path.exists() {
        file_mtime(&opencode_path)?
    } else if codex_path.exists() {
        file_mtime(&codex_path)?
    } else {
        return None; // No source file found
    };

    let key = native_cache_key(session_id, cwd);

    // Check cache (Mutex lock required since LRU get() updates access order)
    {
        let mut guard = NATIVE_CACHE.lock().unwrap();
        let cache = guard.get_or_insert_with(|| {
            LruCache::new(NonZeroUsize::new(NATIVE_CACHE_CAPACITY).unwrap())
        });
        if let Some((cached_mtime, msgs)) = cache.get(&key) {
            if *cached_mtime == mtime {
                return Some(msgs.clone());
            }
        }
    }

    // Compute
    let result = try_native_capture(session_id, cwd);

    // Store in LRU cache (will evict least recently used entry if at capacity)
    if let Some(msgs) = &result {
        let mut guard = NATIVE_CACHE.lock().unwrap();
        let cache = guard.get_or_insert_with(|| {
            LruCache::new(NonZeroUsize::new(NATIVE_CACHE_CAPACITY).unwrap())
        });
        cache.put(key, (mtime, msgs.clone()));
    }

    result
}

use tokio::sync::Mutex as TokioMutex;

// Sharded lock scheme to prevent unbounded memory growth.
// Fixed number of shards (64) bounds memory regardless of conversation count.
// Different conversations may share a shard lock, but contention is rare
// since import operations are infrequent and short-lived.
const IMPORT_LOCK_SHARDS: usize = 64;
static IMPORT_LOCKS: [StdMutex<Option<std::sync::Arc<TokioMutex<()>>>>; IMPORT_LOCK_SHARDS] = {
    // Initialize array of None values
    #[allow(clippy::declare_interior_mutable_const)]
    const INIT: StdMutex<Option<std::sync::Arc<TokioMutex<()>>>> = StdMutex::new(None);
    [INIT; IMPORT_LOCK_SHARDS]
};

async fn acquire_import_lock(conv_id: i64) -> std::sync::Arc<TokioMutex<()>> {
    let shard_idx = (conv_id as usize) % IMPORT_LOCK_SHARDS;
    let mut guard = IMPORT_LOCKS[shard_idx].lock().unwrap();
    guard
        .get_or_insert_with(|| std::sync::Arc::new(TokioMutex::new(())))
        .clone()
}

pub async fn import_agent_session_history(
    agent_id: &str,
    input: ImportAgentSessionHistoryInput,
) -> anyhow::Result<()> {
    tracing::info!(
        agent_id = agent_id,
        acp_session_id = %input.acp_session_id,
        "import_agent_session_history called"
    );

    let _persist_limit = input.persist_limit.or(input.limit).unwrap_or(100).min(500);
    let acp_session_id = input.acp_session_id.clone();
    let cwd_for_chat = input.cwd.clone().unwrap_or_else(|| "/".to_string());

    // Resolve a chat for this session. When importing migrated history we create
    // one chat per session (1:1 with conversation) instead of sharing a chat
    // across every session in the same cwd.
    let resolved_chat_id = if let Some(id) = input.chat_id {
        id
    } else if let Ok(Some(existing)) =
        crate::user_data_db::agent_sessions::get_by_acp_session_id(&acp_session_id)
    {
        let cid = existing.conversation_id;
        let chat = tokio::task::spawn_blocking(move || {
            crate::user_data_db::conversations::get(ergatai_error::ConversationId::new(cid))
                .ok()
                .flatten()
                .map(|c| c.chat_id.as_i64())
        })
        .await
        .unwrap_or(None);
        match chat {
            Some(id) => id,
            None => {
                crate::services::agent_history_import::ensure_chat_for_session(
                    &cwd_for_chat,
                    input.title.clone(),
                )
                .await?
            }
        }
    } else {
        crate::services::agent_history_import::ensure_chat_for_session(
            &cwd_for_chat,
            input.title.clone(),
        )
        .await?
    };

    // Ensure conversation exists.
    let conversation_id = if let Some(id) = input.conversation_id {
        ConversationId::new(id)
    } else {
        let chat_id = ergatai_error::ChatId::new(resolved_chat_id);
        let title = input.title.clone();
        let acp = acp_session_id.clone();
        let agent_id_owned = agent_id.to_string();
        tokio::task::spawn_blocking(move || {
            crate::user_data_db::conversations::create_for_agent_session(
                chat_id,
                &acp,
                title,
                Some(agent_id_owned.as_str()),
            )
        })
        .await
        .context("join error creating conversation")?
        .context("create_for_agent_session failed")?
    };

    // Ensure the imported session is attributed to the owning agent for progress tracking.
    let _ = tokio::task::spawn_blocking({
        let cid = conversation_id;
        let aid = agent_id.to_string();
        move || crate::user_data_db::agent_sessions::set_agent_id(cid.as_i64(), &aid)
    })
    .await;

    let _import_lock = acquire_import_lock(conversation_id.as_i64()).await;
    let _import_guard = _import_lock.lock().await;

    // Load existing import state.
    let existing_state = tokio::task::spawn_blocking({
        let cid = conversation_id;
        move || {
            crate::user_data_db::agent_sessions::get_by_conversation_id(cid.as_i64())
                .ok()
                .flatten()
        }
    })
    .await
    .unwrap_or(None);

    let conv_id_for_check = conversation_id;
    let has_messages = tokio::task::spawn_blocking(move || {
        crate::user_data_db::messages::list(conv_id_for_check)
            .map(|m| !m.is_empty())
            .unwrap_or(false)
    })
    .await
    .unwrap_or(false);

    let legacy_skip = has_messages
        && existing_state
            .as_ref()
            .map(|s| s.imported_count)
            .unwrap_or(0)
            == 0
        && existing_state
            .as_ref()
            .and_then(|s| s.import_cursor.clone())
            .is_none()
        && input.cursor.is_none();
    if legacy_skip {
        return Ok(());
    }

    // Already imported this session once: do not paginate further.
    if existing_state
        .as_ref()
        .map(|s| s.imported_count)
        .unwrap_or(0)
        > 0
    {
        return Ok(());
    }

    // Capture history. Prefer agent-native storage (Claude JSONL / opencode DB /
    // codex sessions) for full fidelity; fall back to ACP resume capture.
    let cwd = input.cwd.as_deref().unwrap_or("/").to_string();
    let native = tokio::task::spawn_blocking({
        let sid = acp_session_id.clone();
        let cwd = cwd.clone();
        move || try_native_capture_cached(&sid, &cwd)
    })
    .await
    .unwrap_or(None);

    let capture_limit = input.capture_limit.unwrap_or(50).min(50);
    let captured = if let Some(msgs) = native {
        let _ = crate::user_data_db::agent_sessions::update_resume_status(
            conversation_id.as_i64(),
            None,
            true,
        );
        msgs
    } else {
        // Fall back to ACP resume capture for agents without native storage.
        match crate::services::agent_service::resume_session_capture(
            agent_id,
            &acp_session_id,
            &cwd,
            capture_limit,
        )
        .await
        {
            Ok(captured) => {
                let _ = crate::user_data_db::agent_sessions::update_resume_status(
                    conversation_id.as_i64(),
                    None,
                    true,
                );
                captured
            }
            Err(error) => {
                let _ = crate::user_data_db::agent_sessions::update_resume_status(
                    conversation_id.as_i64(),
                    Some(error.to_string()),
                    false,
                );
                return Err(error).context("resume_session_capture failed");
            }
        }
    };

    tracing::info!(
        acp_session_id = %acp_session_id,
        captured_count = captured.len(),
        "Resume session capture completed"
    );

    if captured.is_empty() {
        tracing::warn!(acp_session_id = %acp_session_id, "No messages captured");
        return Ok(());
    }

    let captured_len = captured.len();

    // Full import: bring in every captured message for this session.
    let persist_limit = captured_len.max(1);

    // Simple online import: bring in only the most recent `persist_limit`
    // messages for this session in a single pass; no further pagination.
    let start = captured_len.saturating_sub(persist_limit);
    let actual_end = captured_len;

    if actual_end == 0 || start >= actual_end {
        return Ok(());
    }

    let mut messages = Vec::new();
    for update in captured
        .iter()
        .skip(start)
        .take(actual_end.saturating_sub(start))
    {
        let session_update = update
            .get("sessionUpdate")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        let role = match session_update {
            "user_message_chunk" | "user_message" => "user",
            _ => "assistant",
        };

        let text = update
            .get("content")
            .and_then(|c| c.get("text"))
            .and_then(|v| v.as_str())
            .or_else(|| update.get("text").and_then(|v| v.as_str()));

        // Skip environment/context injection messages that are not real user turns.
        if let Some(t) = text {
            if t.contains("<environment_context>") {
                continue;
            }
        }

        // Convert ACP updates into frontend-renderable parts so imported history
        // renders consistently with live streaming (text, reasoning, tool calls).
        let parts = match session_update {
            "agent_thought_chunk" => {
                if let Some(t) = text.filter(|t| !t.is_empty()) {
                    serde_json::json!([{"type": "reasoning", "text": t}])
                } else {
                    serde_json::json!([update.clone()])
                }
            }
            "tool_call" => {
                let title = update
                    .get("title")
                    .and_then(|v| v.as_str())
                    .unwrap_or("tool");
                let tool_call_id = update
                    .get("toolCallId")
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                let input = update
                    .get("rawInput")
                    .cloned()
                    .unwrap_or(serde_json::json!({}));
                serde_json::json!([{
                    "type": format!("tool-{}", title),
                    "toolCallId": tool_call_id,
                    "input": input,
                }])
            }
            _ => {
                if let Some(text) = text.filter(|t| !t.is_empty()) {
                    serde_json::json!([{"type": "text", "text": text}])
                } else {
                    serde_json::json!([update.clone()])
                }
            }
        };

        let metadata = serde_json::json!({ "acp_update": update });
        messages.push((role.to_string(), parts, metadata));
    }

    let imported_this = messages.len() as i64;
    if imported_this == 0 {
        return Ok(());
    }

    // Single-pass import: mark the session as fully imported (no more pages).
    let total_captured = captured_len as i64;
    let new_imported_count = imported_this;
    let has_more = false;
    let new_cursor = None;

    // Persist.
    // Ensure message table exists before appending (idempotent).
    tracing::info!(
        conversation_id = conversation_id.as_i64(),
        conversation_id_formatted = %conversation_id,
        "Creating message table for conversation"
    );
    let conv_id_for_table = conversation_id;
    let table_result = tokio::task::spawn_blocking(move || {
        crate::user_data_db::create_message_table(conv_id_for_table)
    })
    .await
    .context("join error creating message table")?;

    if let Err(ref e) = table_result {
        tracing::error!(
            error = ?e,
            conversation_id = conversation_id.as_i64(),
            "create_message_table failed with error"
        );
    }
    table_result.context("create_message_table failed")?;

    let conv_id = conversation_id;
    tokio::task::spawn_blocking({
        let msgs = messages;
        move || crate::user_data_db::messages::append_batch(conv_id, msgs)
    })
    .await
    .context("join error persisting messages")?
    .context("append_batch failed")?;

    // Update import state.
    let conv_id2 = conversation_id;
    tokio::task::spawn_blocking(move || {
        crate::user_data_db::agent_sessions::update_import_state(
            conv_id2.as_i64(),
            new_imported_count,
            new_cursor,
            has_more,
            total_captured,
        )
    })
    .await
    .context("join error updating import state")?
    .context("update_import_state failed")?;

    Ok(())
}

/// Session-scope batch import: paginate over an agent's ACP sessions and enqueue
/// per-session history import jobs. `cursor` is an opaque key of the form
/// `"<updated_at>|<session_id>"` pointing at the last processed session in the
/// descending sort order; `None` starts from the most recently updated session.
pub async fn ensure_workspace_chat_for_path(work_dir: &str) -> anyhow::Result<i64> {
    let managed = crate::services::workspace_manager::create(
        crate::services::workspace_manager::CreateManagedWorkspaceRequest {
            id: None,
            name: None,
            work_dir: work_dir.to_string(),
            env: None,
            resources: None,
            config: None,
            collaboration_mode: None,
            default_project_id: None,
        },
    )
    .await
    .map_err(|e| anyhow::anyhow!("ensure workspace failed: {:?}", e))?;

    let workspace_id = ergatai_error::WorkspaceId::decode(&managed.workspace_id)
        .map_err(|e| anyhow::anyhow!("invalid workspace id: {}", e))?;

    let work_dir_owned = work_dir.to_string();
    let chat_id = tokio::task::spawn_blocking(move || -> Result<i64, rusqlite::Error> {
        let chats = crate::user_data_db::chats::list(Some(workspace_id))?;
        if let Some(existing) = chats.into_iter().next() {
            // Ensure imported chats expose a working directory to the frontend.
            // Only update if worktree_path is not already set (avoid repeated writes).
            if existing.worktree_path.is_none() {
                let mut updated = existing.clone();
                updated.worktree_path = Some(work_dir_owned.clone());
                updated.updated_at = chrono::Utc::now().timestamp();
                match crate::user_data_db::chats::update(updated) {
                    Ok(_) => tracing::debug!(chat_id = %existing.chat_id.as_i64(), "Set worktree_path for imported chat"),
                    Err(e) => tracing::warn!(chat_id = %existing.chat_id.as_i64(), error = %e, "Failed to set worktree_path for imported chat"),
                }
            }
            return Ok(existing.chat_id.as_i64());
        }
        let now = chrono::Utc::now().timestamp();
        let chat = crate::user_data_db::Chat {
            chat_id: ergatai_error::ChatId::generate(),
            workspace_id,
            name: None,
            collaboration_mode: None,
            worktree_path: Some(work_dir_owned.clone()),
            branch: None,
            base_branch: None,
            pr_url: None,
            pr_number: None,
            created_at: now,
            updated_at: now,
            archived_at: None,
        };
        crate::user_data_db::chats::create(chat.clone())?;
        Ok(chat.chat_id.as_i64())
    })
    .await
    .map_err(|e| anyhow::anyhow!("join error ensuring chat: {}", e))?
    .map_err(|e| anyhow::anyhow!("ensure chat failed: {}", e))?;

    Ok(chat_id)
}

/// Create a dedicated chat for a single imported session under the workspace for `work_dir`.
pub async fn ensure_chat_for_session(work_dir: &str, name: Option<String>) -> anyhow::Result<i64> {
    let managed = crate::services::workspace_manager::create(
        crate::services::workspace_manager::CreateManagedWorkspaceRequest {
            id: None,
            name: None,
            work_dir: work_dir.to_string(),
            env: None,
            resources: None,
            config: None,
            collaboration_mode: None,
            default_project_id: None,
        },
    )
    .await
    .map_err(|e| anyhow::anyhow!("ensure workspace failed: {:?}", e))?;

    let workspace_id = ergatai_error::WorkspaceId::decode(&managed.workspace_id)
        .map_err(|e| anyhow::anyhow!("invalid workspace id: {}", e))?;

    let work_dir_owned = work_dir.to_string();
    let chat_name = name.clone().or_else(|| {
        std::path::Path::new(work_dir)
            .file_name()
            .and_then(|s| s.to_str())
            .map(|s| s.to_string())
    });
    let chat_id = tokio::task::spawn_blocking(move || -> Result<i64, rusqlite::Error> {
        let now = chrono::Utc::now().timestamp();
        let chat = crate::user_data_db::Chat {
            chat_id: ergatai_error::ChatId::generate(),
            workspace_id,
            name: chat_name,
            collaboration_mode: None,
            worktree_path: Some(work_dir_owned.clone()),
            branch: None,
            base_branch: None,
            pr_url: None,
            pr_number: None,
            created_at: now,
            updated_at: now,
            archived_at: None,
        };
        crate::user_data_db::chats::create(chat.clone())?;
        Ok(chat.chat_id.as_i64())
    })
    .await
    .map_err(|e| anyhow::anyhow!("join error ensuring chat: {}", e))?
    .map_err(|e| anyhow::anyhow!("ensure chat failed: {}", e))?;

    Ok(chat_id)
}

pub async fn import_agent_sessions_batch(
    agent_id: &str,
    chat_id: Option<i64>,
    cwd_filter: Option<String>,
    _cursor: Option<String>,
    limit: usize,
) -> anyhow::Result<()> {
    let limit = limit.clamp(1, 100);

    let sessions = crate::services::agent_service::list_agent_sessions(agent_id).await?;

    // Optionally restrict to sessions whose cwd matches the filter.
    let sessions: Vec<_> = if let Some(ref filter) = cwd_filter {
        sessions
            .into_iter()
            .filter(|s| s.cwd.as_deref() == Some(filter.as_str()))
            .collect()
    } else {
        sessions
    };

    // Build sort keys and sort descending (most recently updated first).
    let mut keyed: Vec<(String, ergatai_runtime::SessionInfo)> = sessions
        .into_iter()
        .map(|s| {
            let key = format!(
                "{}|{}",
                s.updated_at.as_deref().unwrap_or_default(),
                s.session_id
            );
            (key, s)
        })
        .collect();
    keyed.sort_by(|a, b| b.0.cmp(&a.0));

    // Only the first `limit` sessions per workspace are brought online; no
    // cursor-based pagination across the remaining sessions.
    let end = limit.min(keyed.len());
    let batch = &keyed[..end];

    for (_key, session) in batch {
        // Skip sessions already bound to a conversation.
        let already_bound = tokio::task::spawn_blocking({
            let sid = session.session_id.clone();
            move || {
                crate::user_data_db::agent_sessions::get_by_acp_session_id(&sid)
                    .ok()
                    .flatten()
                    .is_some()
            }
        })
        .await
        .unwrap_or(false);
        if already_bound {
            continue;
        }

        let payload = serde_json::json!({
            "chat_id": chat_id,
            "acp_session_id": session.session_id,
            "cwd": session.cwd,
            "title": session.title,
            "capture_limit": 50,
            "persist_limit": 20,
        });

        let _ = tokio::task::spawn_blocking({
            let agent_id = agent_id.to_string();
            let payload_str = payload.to_string();
            move || {
                crate::user_data_db::chats::enqueue_job(
                    "persistence",
                    "agent_session",
                    &agent_id,
                    "import_agent_session_history",
                    Some(&payload_str),
                )
            }
        })
        .await;
    }

    Ok(())
}

// ============================================================================
// Agent-native history capture (bypass ACP for full fidelity)
// ============================================================================

/// Try to capture history from agent-native storage. Returns `Some(messages)` if
/// a supported backend has the session; `None` to fall back to ACP capture.
pub fn has_native_capture(session_id: &str, cwd: &str) -> bool {
    try_native_capture(session_id, cwd)
        .map(|v| !v.is_empty())
        .unwrap_or(false)
}

fn try_native_capture(session_id: &str, cwd: &str) -> Option<Vec<serde_json::Value>> {
    if let Some(msgs) = try_claude_capture(session_id, cwd) {
        if !msgs.is_empty() {
            return Some(msgs);
        }
    }
    if let Some(msgs) = try_opencode_capture(session_id) {
        if !msgs.is_empty() {
            return Some(msgs);
        }
    }
    if let Some(msgs) = try_codex_capture(session_id) {
        if !msgs.is_empty() {
            return Some(msgs);
        }
    }
    None
}

/// Claude: read ~/.claude/projects/<encoded_cwd>/<session_id>.jsonl
fn try_claude_capture(session_id: &str, cwd: &str) -> Option<Vec<serde_json::Value>> {
    let home = std::env::var("HOME").ok()?;
    let encoded = format!("-{}", cwd.trim_start_matches('/').replace('/', "-"));
    let path = std::path::PathBuf::from(home)
        .join(".claude/projects")
        .join(&encoded)
        .join(format!("{}.jsonl", session_id));
    if !path.exists() {
        return None;
    }
    let content = std::fs::read_to_string(&path).ok()?;
    let mut out = Vec::new();
    for line in content.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let v: serde_json::Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(_) => continue,
        };
        let ty = v.get("type").and_then(|x| x.as_str()).unwrap_or("");
        let role = match ty {
            "user" => "user",
            "assistant" => "assistant",
            _ => continue,
        };
        let msg = v.get("message").unwrap_or(&v);
        let content = msg.get("content").unwrap_or(&serde_json::Value::Null);
        // content can be string or array
        if let Some(s) = content.as_str() {
            if !s.trim().is_empty() {
                let su = if role == "user" {
                    "user_message_chunk"
                } else {
                    "agent_message_chunk"
                };
                out.push(serde_json::json!({
                    "sessionUpdate": su,
                    "content": {"type": "text", "text": s}
                }));
            }
            continue;
        }
        if let Some(arr) = content.as_array() {
            for block in arr {
                let btype = block.get("type").and_then(|x| x.as_str()).unwrap_or("");
                match btype {
                    "text" => {
                        if let Some(text) = block.get("text").and_then(|x| x.as_str()) {
                            if !text.trim().is_empty() {
                                let su = if role == "user" {
                                    "user_message_chunk"
                                } else {
                                    "agent_message_chunk"
                                };
                                out.push(serde_json::json!({
                                    "sessionUpdate": su,
                                    "content": {"type": "text", "text": text}
                                }));
                            }
                        }
                    }
                    "thinking" => {
                        if let Some(text) = block.get("thinking").and_then(|x| x.as_str()) {
                            if !text.trim().is_empty() && role == "assistant" {
                                out.push(serde_json::json!({
                                    "sessionUpdate": "agent_thought_chunk",
                                    "content": {"type": "text", "text": text}
                                }));
                            }
                        }
                    }
                    "tool_use" => {
                        if role == "assistant" {
                            let id = block
                                .get("id")
                                .and_then(|x| x.as_str())
                                .unwrap_or("")
                                .to_string();
                            let name = block
                                .get("name")
                                .and_then(|x| x.as_str())
                                .unwrap_or("")
                                .to_string();
                            let input =
                                block.get("input").cloned().unwrap_or(serde_json::json!({}));
                            out.push(serde_json::json!({
                                "sessionUpdate": "tool_call",
                                "toolCallId": id,
                                "title": name,
                                "rawInput": input
                            }));
                        }
                    }
                    "tool_result" => {
                        let id = block
                            .get("tool_use_id")
                            .and_then(|x| x.as_str())
                            .unwrap_or("")
                            .to_string();
                        let raw = block
                            .get("content")
                            .cloned()
                            .unwrap_or(serde_json::json!(null));
                        out.push(serde_json::json!({
                            "sessionUpdate": "tool_call_update",
                            "toolCallId": id,
                            "status": "completed",
                            "rawOutput": raw
                        }));
                    }
                    _ => {}
                }
            }
        }
    }
    if out.is_empty() {
        None
    } else {
        Some(out)
    }
}

/// opencode: read ~/.local/share/opencode/opencode.db
fn try_opencode_capture(session_id: &str) -> Option<Vec<serde_json::Value>> {
    let home = std::env::var("HOME").ok()?;
    let db_path = std::path::PathBuf::from(home).join(".local/share/opencode/opencode.db");
    if !db_path.exists() {
        return None;
    }
    let conn = rusqlite::Connection::open_with_flags(
        &db_path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .ok()?;
    let _ = conn.busy_timeout(std::time::Duration::from_secs(5));
    // message role map
    let mut stmt = conn
        .prepare("SELECT id, data FROM message WHERE session_id = ?1")
        .ok()?;
    let mut role_map: std::collections::HashMap<String, String> = std::collections::HashMap::new();
    let rows = stmt
        .query_map(rusqlite::params![session_id], |row| {
            let id: String = row.get(0)?;
            let data: String = row.get(1)?;
            Ok((id, data))
        })
        .ok()?;
    for r in rows.flatten() {
        let (id, data) = r;
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&data) {
            let role = v
                .get("role")
                .and_then(|x| x.as_str())
                .unwrap_or("assistant")
                .to_string();
            role_map.insert(id, role);
        }
    }
    if role_map.is_empty() {
        return None;
    }
    // parts ordered by time_created
    let mut stmt = conn
        .prepare(
            "SELECT message_id, data FROM part WHERE session_id = ?1 ORDER BY time_created ASC",
        )
        .ok()?;
    let rows = stmt
        .query_map(rusqlite::params![session_id], |row| {
            let mid: String = row.get(0)?;
            let data: String = row.get(1)?;
            Ok((mid, data))
        })
        .ok()?;
    let mut out = Vec::new();
    for r in rows.flatten() {
        let (mid, data) = r;
        let role = role_map
            .get(&mid)
            .cloned()
            .unwrap_or_else(|| "assistant".to_string());
        let v: serde_json::Value = match serde_json::from_str(&data) {
            Ok(v) => v,
            Err(_) => continue,
        };
        let ptype = v.get("type").and_then(|x| x.as_str()).unwrap_or("");
        match ptype {
            "text" => {
                if let Some(text) = v.get("text").and_then(|x| x.as_str()) {
                    if !text.trim().is_empty() {
                        let su = if role == "user" {
                            "user_message_chunk"
                        } else {
                            "agent_message_chunk"
                        };
                        out.push(serde_json::json!({
                            "sessionUpdate": su,
                            "content": {"type": "text", "text": text}
                        }));
                    }
                }
            }
            "reasoning" => {
                if let Some(text) = v.get("text").and_then(|x| x.as_str()) {
                    if !text.trim().is_empty() && role == "assistant" {
                        out.push(serde_json::json!({
                            "sessionUpdate": "agent_thought_chunk",
                            "content": {"type": "text", "text": text}
                        }));
                    }
                }
            }
            _ => {}
        }
    }
    if out.is_empty() {
        None
    } else {
        Some(out)
    }
}

/// codex: search ~/.codex/sessions for a rollout file whose name contains session_id
fn try_codex_capture(session_id: &str) -> Option<Vec<serde_json::Value>> {
    let home = std::env::var("HOME").ok()?;
    let base = std::path::PathBuf::from(home).join(".codex/sessions");
    if !base.exists() {
        return None;
    }
    // find file - match exact filename stem to avoid substring false positives
    let mut found: Option<std::path::PathBuf> = None;
    for entry in walkdir(&base) {
        if entry.extension().map(|e| e == "jsonl").unwrap_or(false) {
            let stem_matches = entry
                .file_stem()
                .and_then(|s| s.to_str())
                .map(|stem| stem == session_id)
                .unwrap_or(false);
            if stem_matches {
                found = Some(entry);
                break;
            }
        }
    }
    let path = found?;
    let content = std::fs::read_to_string(&path).ok()?;
    let mut out = Vec::new();
    for line in content.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let v: serde_json::Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(_) => continue,
        };
        // codex rollout format: {"type":"response_item","payload":{"type":"message","role":"user/assistant","content":[...]}}
        let item_type = v.get("type").and_then(|x| x.as_str()).unwrap_or("");
        if item_type != "response_item" {
            continue;
        }
        let payload = match v.get("payload") {
            Some(p) => p,
            None => continue,
        };
        if payload.get("type").and_then(|x| x.as_str()) != Some("message") {
            continue;
        }
        let role = payload.get("role").and_then(|x| x.as_str()).unwrap_or("");
        let su = match role {
            "user" => "user_message_chunk",
            "assistant" => "agent_message_chunk",
            _ => continue,
        };
        if let Some(content) = payload.get("content").and_then(|x| x.as_array()) {
            for block in content {
                let btype = block.get("type").and_then(|x| x.as_str()).unwrap_or("");
                if btype == "input_text" || btype == "output_text" || btype == "text" {
                    if let Some(text) = block.get("text").and_then(|x| x.as_str()) {
                        if !text.trim().is_empty() {
                            out.push(serde_json::json!({
                                "sessionUpdate": su,
                                "content": {"type": "text", "text": text}
                            }));
                        }
                    }
                }
            }
        }
    }
    if out.is_empty() {
        None
    } else {
        Some(out)
    }
}

fn walkdir(base: &std::path::Path) -> Vec<std::path::PathBuf> {
    walkdir_with_depth(base, 0, 10)
}

fn walkdir_with_depth(
    base: &std::path::Path,
    current_depth: usize,
    max_depth: usize,
) -> Vec<std::path::PathBuf> {
    let mut result = Vec::new();
    if current_depth > max_depth {
        tracing::warn!(path = ?base, "Max directory depth exceeded, stopping recursion");
        return result;
    }
    if let Ok(entries) = std::fs::read_dir(base) {
        for entry in entries.flatten() {
            let path = entry.path();
            // Skip symlinks to prevent infinite loops
            if path.is_symlink() {
                tracing::debug!(path = ?path, "Skipping symlink");
                continue;
            }
            if path.is_dir() {
                result.extend(walkdir_with_depth(&path, current_depth + 1, max_depth));
            } else {
                result.push(path);
            }
        }
    }
    result
}
