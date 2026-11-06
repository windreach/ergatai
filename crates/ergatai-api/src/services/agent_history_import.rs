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

pub async fn import_agent_session_history(
    agent_id: &str,
    input: ImportAgentSessionHistoryInput,
) -> anyhow::Result<()> {
    let capture_limit = input.capture_limit.unwrap_or(50).min(50);
    let persist_limit = input.persist_limit.or(input.limit).unwrap_or(20).min(20);
    let acp_session_id = input.acp_session_id.clone();

    // Ensure conversation exists.
    let conversation_id = if let Some(id) = input.conversation_id {
        ConversationId::new(id)
    } else if let Some(chat_id) = input.chat_id {
        let chat_id = ergatai_error::ChatId::new(chat_id);
        let title = input.title.clone();
        let acp = acp_session_id.clone();
        tokio::task::spawn_blocking(move || {
            crate::user_data_db::conversations::create_for_agent_session(chat_id, &acp, title)
        })
        .await
        .context("join error creating conversation")?
        .context("create_for_agent_session failed")?
    } else {
        return Err(anyhow::anyhow!("missing conversation_id or chat_id"));
    };

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

    // Capture history from agent.
    let cwd = input.cwd.as_deref().unwrap_or("/");
    let captured = match crate::services::agent_service::resume_session_capture(
        agent_id,
        &acp_session_id,
        cwd,
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
    };

    if captured.is_empty() {
        return Ok(());
    }

    let captured_len = captured.len();

    let cursor_from_payload = input.cursor.clone();
    let end = cursor_from_payload
        .or_else(|| {
            existing_state
                .as_ref()
                .and_then(|s| s.import_cursor.clone())
        })
        .and_then(|c| c.parse::<usize>().ok())
        .unwrap_or_else(|| {
            let imported = existing_state
                .as_ref()
                .map(|s| s.imported_count as usize)
                .unwrap_or(0);
            if imported > 0 {
                captured_len.saturating_sub(imported)
            } else {
                captured_len
            }
        });

    if end == 0 {
        return Ok(());
    }

    let start = end.saturating_sub(persist_limit);
    if start >= captured_len && end > captured_len {
        return Ok(());
    }

    let mut messages = Vec::new();
    for update in captured.iter().skip(start).take(end.saturating_sub(start)) {
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

        let parts = if let Some(text) = text.filter(|t| !t.is_empty()) {
            serde_json::json!([{"type": "text", "text": text}])
        } else {
            serde_json::json!([update.clone()])
        };

        let metadata = serde_json::json!({ "acp_update": update });
        messages.push((role.to_string(), parts, metadata));
    }

    let imported_this = messages.len() as i64;
    if imported_this == 0 {
        return Ok(());
    }

    let prior_imported = existing_state
        .as_ref()
        .map(|s| s.imported_count)
        .unwrap_or(0);
    let prior_total = existing_state
        .as_ref()
        .map(|s| s.total_captured)
        .unwrap_or(0);

    // Clamp the end index to the captured range and accumulate progress across
    // multiple batches instead of overwriting it on every run.
    let total_captured = prior_total.max(captured_len as i64);
    let new_imported_count = (prior_imported + imported_this).min(total_captured);
    let has_more = new_imported_count < total_captured;
    let new_cursor = if start > 0 && has_more {
        Some(start.to_string())
    } else {
        None
    };

    // Persist.
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

    let chat_id = tokio::task::spawn_blocking(move || -> Result<i64, rusqlite::Error> {
        let chats = crate::user_data_db::chats::list(Some(workspace_id))?;
        if let Some(existing) = chats.into_iter().next() {
            return Ok(existing.chat_id.as_i64());
        }
        let now = chrono::Utc::now().timestamp();
        let chat = crate::user_data_db::Chat {
            chat_id: ergatai_error::ChatId::generate(),
            workspace_id,
            name: None,
            collaboration_mode: None,
            worktree_path: None,
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
    chat_id: i64,
    cwd_filter: Option<String>,
    cursor: Option<String>,
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

    // Resolve cursor position: process sessions whose key is strictly less than
    // the cursor key (i.e. come after it in descending order).
    let start = if let Some(ref c) = cursor {
        keyed.iter().position(|(k, _)| k < c).unwrap_or(keyed.len())
    } else {
        0
    };

    let end = (start + limit).min(keyed.len());
    let batch = &keyed[start..end];

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

    // Enqueue next batch if there are more sessions.
    if end < keyed.len() {
        if let Some((last_key, _)) = batch.last() {
            let next_cursor = last_key.clone();
            let payload = serde_json::json!({
                "chat_id": chat_id,
                "cursor": next_cursor,
                "limit": limit,
            });
            let _ = tokio::task::spawn_blocking({
                let agent_id = agent_id.to_string();
                let payload_str = payload.to_string();
                move || {
                    crate::user_data_db::chats::enqueue_job(
                        "persistence",
                        "agent_session",
                        &agent_id,
                        "import_agent_sessions_batch",
                        Some(&payload_str),
                    )
                }
            })
            .await;
        }
    }

    Ok(())
}
