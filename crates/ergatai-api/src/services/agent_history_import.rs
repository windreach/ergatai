//! Agent history import (ACP resume) implementation shared by job worker and sync API.

use anyhow::Context;
use ergatai_error::ConversationId;

#[derive(Debug, Clone, Default)]
pub struct ImportAgentSessionHistoryInput {
    pub chat_id: Option<i64>,
    pub acp_session_id: String,
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
    let persist_limit = input
        .persist_limit
        .or(input.limit)
        .unwrap_or(20)
        .min(20);
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
        && existing_state.as_ref().map(|s| s.imported_count).unwrap_or(0) == 0
        && existing_state
            .as_ref()
            .and_then(|s| s.import_cursor.clone())
            .is_none()
        && input.cursor.is_none();
    if legacy_skip {
        return Ok(());
    }

    // Capture history from agent.
    let captured = match crate::services::agent_service::resume_session_capture(
        agent_id,
        &acp_session_id,
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
        .or_else(|| existing_state.as_ref().and_then(|s| s.import_cursor.clone()))
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

    let new_imported_count = existing_state
        .as_ref()
        .map(|s| s.imported_count)
        .unwrap_or(0)
        + imported_this;
    let new_cursor = if start > 0 {
        Some(start.to_string())
    } else {
        None
    };
    let has_more = start > 0;
    let total_captured = captured_len as i64;

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