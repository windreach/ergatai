//! Agent output persistence service.
//!
//! This module provides the persistence callback that saves accumulated agent
//! outputs to the messages table when a turn completes.

use ergatai_error::{ChatId, CollaborationSessionId, ConversationId, WorkspaceId};
use ergatai_runtime::output_accumulator::OutputTimelineItem;
use ergatai_runtime::AgentOutputData;

/// Build complete parts array from agent output data.
///
/// Converts thinking, tool_calls, and final_text into a structured parts array
/// that matches the format expected by the frontend (same as streaming output).
///
/// Format:
/// - Thinking: { "type": "tool-Thinking", "input": { "text": "..." }, "state": "result" }
/// - Tool calls: { "type": "tool-{name}", "input": {...}, "state": "result", "output": "..." }
/// - Final text: { "type": "text", "text": "..." }
fn build_complete_parts_array(output_data: &AgentOutputData) -> Option<serde_json::Value> {
    let mut parts_array = Vec::new();

    // New turns persist a typed chronological timeline. This is the strict
    // turn projection: reasoning/tool/text remain ordered, contiguous text
    // deltas are coalesced, and protocol-only markers are not user text.
    if let Some(timeline_json) = &output_data.timeline {
        if let Ok(timeline) = serde_json::from_str::<Vec<OutputTimelineItem>>(timeline_json) {
            let mut pending_text = String::new();
            let flush_text = |parts: &mut Vec<serde_json::Value>, text: &mut String| {
                if !text.trim().is_empty() {
                    parts.push(serde_json::json!({
                        "type": "text",
                        "text": std::mem::take(text),
                    }));
                } else {
                    text.clear();
                }
            };

            for item in timeline {
                match item {
                    OutputTimelineItem::Text { text, .. } => {
                        // Treat all text as regular content - no special filtering for "END"
                        pending_text.push_str(&text);
                    }
                    OutputTimelineItem::Thinking { text, .. } => {
                        flush_text(&mut parts_array, &mut pending_text);
                        parts_array.push(serde_json::json!({
                            "type": "tool-Thinking",
                            "state": "result",
                            "input": { "text": text },
                            "output": { "completed": true },
                        }));
                    }
                    OutputTimelineItem::ToolCall {
                        id,
                        name,
                        kind,
                        input,
                        output,
                        status,
                        locations,
                        started_at,
                        completed_at,
                        error,
                    } => {
                        flush_text(&mut parts_array, &mut pending_text);
                        parts_array.push(serde_json::json!({
                            "type": format!("tool-{}", name),
                            "toolCallId": id,
                            "toolKind": kind,
                            "state": if status == "completed" { "result" } else { "error" },
                            "input": *input,
                            "output": *output,
                            "locations": locations,
                            "startedAt": started_at,
                            "completedAt": completed_at,
                            "error": error,
                        }));
                    }
                }
            }
            flush_text(&mut parts_array, &mut pending_text);
            return if parts_array.is_empty() {
                None
            } else {
                Some(serde_json::Value::Array(parts_array))
            };
        }
    }

    // 1. Add thinking blocks as tool-Thinking parts
    if let Some(thinking_json) = &output_data.thinking {
        match serde_json::from_str::<Vec<serde_json::Value>>(thinking_json) {
            Ok(thinking_blocks) => {
                for block in thinking_blocks {
                    let thinking_text = block.get("text").and_then(|t| t.as_str()).unwrap_or("");

                    parts_array.push(serde_json::json!({
                        "type": "tool-Thinking",
                        "state": "result",
                        "input": { "text": thinking_text },
                        "output": { "completed": true }
                    }));
                }
            }
            Err(e) => {
                tracing::warn!(
                    error = %e,
                    "Failed to parse thinking JSON, skipping thinking parts"
                );
            }
        }
    }

    // 2. Add tool calls as tool-{name} parts
    if let Some(tool_calls_json) = &output_data.tool_calls {
        match serde_json::from_str::<Vec<serde_json::Value>>(tool_calls_json) {
            Ok(tool_calls) => {
                for tool_call in tool_calls {
                    let name = tool_call
                        .get("name")
                        .and_then(|n| n.as_str())
                        .unwrap_or("Unknown");
                    let input = tool_call
                        .get("input")
                        .cloned()
                        .unwrap_or(serde_json::json!({}));
                    let output = tool_call
                        .get("output")
                        .and_then(|o| o.as_str())
                        .unwrap_or("");
                    let status = tool_call
                        .get("status")
                        .and_then(|s| s.as_str())
                        .unwrap_or("completed");

                    let state = if status == "completed" {
                        "result"
                    } else {
                        "error"
                    };

                    parts_array.push(serde_json::json!({
                        "type": format!("tool-{}", name),
                        "state": state,
                        "input": input,
                        "output": output
                    }));
                }
            }
            Err(e) => {
                tracing::warn!(
                    error = %e,
                    "Failed to parse tool_calls JSON, skipping tool call parts"
                );
            }
        }
    }

    // 3. Add final text as text part
    if let Some(final_text) = &output_data.final_text {
        if !final_text.is_empty() {
            parts_array.push(serde_json::json!({
                "type": "text",
                "text": final_text
            }));
        }
    }

    if parts_array.is_empty() {
        None
    } else {
        Some(serde_json::Value::Array(parts_array))
    }
}

/// Persist agent output to messages table.
///
/// This function is called by the runtime when a prompt completes and the
/// accumulated output needs to be saved. It converts the AgentOutputData
/// to a Message record and inserts it into the messages table.
///
/// If the conversation record doesn't exist, it will be created automatically
/// to satisfy the FOREIGN KEY constraint.
pub async fn persist_agent_output(
    conversation_id: i64,
    mut output_data: AgentOutputData,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    use crate::user_data_db::conversations;
    use crate::user_data_db::messages::{self, AgentOutputFields};
    use crate::user_data_db::{Conversation, DEFAULT_COLLABORATION_MODE};

    // The callback resolves the formatted conversation ID; accumulator data may
    // still be from an older snapshot. Treat the callback ID as authoritative.
    output_data.conversation_id = conversation_id;

    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64;

    // Write to database in a blocking task
    tokio::task::spawn_blocking(
        move || -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
            // Ensure conversation record exists (FOREIGN KEY constraint)
            // Try to get the conversation; if it doesn't exist, create a minimal record
            let conversation_id = ConversationId::new(output_data.conversation_id);
            let conv_exists = match conversations::get(conversation_id) {
                Ok(Some(_)) => true,
                Ok(None) => false,
                Err(e) => {
                    tracing::warn!(
                        conversation_id = %output_data.conversation_id,
                        error = %e,
                        "Failed to query conversation record"
                    );
                    false
                }
            };

            if !conv_exists {
                // Generate unique IDs for each entity to avoid ID collisions
                let workspace_id = WorkspaceId::generate();
                let chat_id = ChatId::generate();
                let collab_session_id = CollaborationSessionId::generate();

                // Create a default workspace record (required by FOREIGN KEY)
                let workspace = crate::user_data_db::Workspace {
                    workspace_id,
                    name: format!("Auto-generated workspace for {}", conversation_id),
                    work_dir: std::env::temp_dir().to_string_lossy().into_owned(),
                    env: "{}".to_string(),
                    resources: "{}".to_string(),
                    config: "{}".to_string(),
                    collaboration_mode: "mesh".to_string(),
                    status: "active".to_string(),
                    default_project_id: None,
                    created_at: now,
                    updated_at: now,
                };
                if let Err(e) = crate::user_data_db::workspaces::create(workspace) {
                    tracing::warn!(
                        workspace_id = %workspace_id,
                        error = %e,
                        "Failed to create auto-generated workspace (may already exist)"
                    );
                }

                // Create a default chat record (required by FOREIGN KEY)
                let chat = crate::user_data_db::Chat {
                    chat_id,
                    workspace_id,
                    name: Some(format!("Auto-generated chat for {}", conversation_id)),
                    collaboration_mode: Some(DEFAULT_COLLABORATION_MODE.to_string()),
                    worktree_path: None,
                    branch: None,
                    base_branch: None,
                    pr_url: None,
                    pr_number: None,
                    created_at: now,
                    updated_at: now,
                    archived_at: None,
                };
                if let Err(e) = crate::user_data_db::chats::create(chat) {
                    tracing::warn!(
                        chat_id = %chat_id,
                        error = %e,
                        "Failed to create auto-generated chat (may already exist)"
                    );
                }

                // Create a default collaboration_session record (required by FOREIGN KEY)
                let collab_session = crate::user_data_db::CollaborationSession {
                    collaboration_session_id: collab_session_id,
                    chat_id,
                    workspace_id,
                    mode: "group".to_string(),
                    state: "completed".to_string(),
                    goal: None,
                    active_plan_revision: None,
                    created_at: now,
                    updated_at: now,
                };
                if let Err(e) = crate::user_data_db::collaboration_sessions::create(collab_session)
                {
                    tracing::warn!(
                        collaboration_session_id = %collab_session_id,
                        error = %e,
                        "Failed to create auto-generated collaboration session (may already exist)"
                    );
                }

                // Finally create the conversation record
                let conv = Conversation {
                    conversation_id,
                    collaboration_session_id: collab_session_id,
                    chat_id,
                    parent_id: None,
                    name: Some(format!(
                        "Auto-generated for agent output {}",
                        conversation_id
                    )),
                    mode: "agent".to_string(),
                    participant_role: "assistant".to_string(),
                    status: "completed".to_string(),
                    created_at: now,
                    updated_at: now,
                    context_used: 0,
                    context_window: 0,
                    context_updated_at: 0,
                };
                if let Err(e) = conversations::create(conv) {
                    tracing::warn!(
                        conversation_id = %output_data.conversation_id,
                        error = %e,
                        "Failed to create conversation record (may already exist)"
                    );
                }
            }

            // Build agent output fields
            // Note: thinking/tool_calls/text_chunks are already JSON strings in AgentOutputData,
            // so we pass them through directly without re-encoding
            // Parse metadata to extract stop_reason, duration_ms, and context usage
            let (stop_reason, duration_ms, context_used, context_window) =
                if let Some(ref metadata_json) = output_data.metadata {
                    if let Ok(metadata) = serde_json::from_str::<serde_json::Value>(metadata_json) {
                        let sr = metadata
                            .get("stop_reason")
                            .and_then(|v| v.as_str())
                            .map(|s| s.to_string());
                        let dm = metadata
                            .get("duration_ms")
                            .and_then(|v| v.as_u64())
                            .map(|d| d as i64);
                        let cu = metadata
                            .get("context_used")
                            .and_then(|v| v.as_u64())
                            .map(|v| v as i64);
                        let cw = metadata
                            .get("context_window")
                            .and_then(|v| v.as_u64())
                            .map(|v| v as i64);
                        (sr, dm, cu, cw)
                    } else {
                        tracing::warn!(
                            conversation_id = %output_data.conversation_id,
                            "Failed to parse metadata JSON"
                        );
                        (None, None, None, None)
                    }
                } else {
                    (None, None, None, None)
                };

            let output_fields = AgentOutputFields {
                thinking: output_data.thinking.clone(),
                tool_calls: output_data.tool_calls.clone(),
                text_chunks: output_data.text_chunks.clone(),
                stop_reason,
                duration_ms,
            };

            // Build complete parts JSON array including thinking, tool_calls, and final_text
            // This ensures the frontend can render all content from the parts array
            let parts = build_complete_parts_array(&output_data);

            let metadata = serde_json::json!({
                "turnId": output_data.turn_id,
                "replyToMessageId": output_data.reply_to_message_id,
                "correlationId": output_data.correlation_id,
                "sourceConversationId": output_data.source_conversation_id,
            });

            // Insert into messages table with agent output fields
            messages::append_with_output(
                conversation_id,
                &output_data.role,
                parts,
                metadata,
                Some(crate::user_data_db::messages::AgentMessageFields {
                    turn_id: Some(output_data.turn_id.clone()),
                    projection_kind: Some("canonical".to_string()),
                    ..Default::default()
                }),
                Some(output_fields),
            )?;

            // Update conversation context usage (final snapshot from this turn)
            if let (Some(cu), Some(cw)) = (context_used, context_window) {
                tracing::info!(
                    conversation_id = %conversation_id,
                    context_used = cu,
                    context_window = cw,
                    "Updating conversation context usage in database"
                );
                if let Err(e) = crate::user_data_db::conversations::update_context_usage(
                    conversation_id,
                    cu,
                    cw,
                ) {
                    tracing::warn!(
                        conversation_id = %conversation_id,
                        error = %e,
                        "Failed to update conversation context usage after turn"
                    );
                }
            } else {
                tracing::debug!(
                    conversation_id = %conversation_id,
                    context_used = ?context_used,
                    context_window = ?context_window,
                    "No context usage to update (one or both values are None)"
                );
            }

            // The side copy was written before this turn completed, so its
            // insert-time sequence is not causal. Re-link it under the same
            // turn after the trace is durable.
            if let Some(correlation_id) = output_data.correlation_id.as_deref() {
                match messages::link_side_copies_to_turn(
                    conversation_id,
                    correlation_id,
                    &output_data.turn_id,
                ) {
                    Ok(0) => {}
                    Ok(count) => {
                        tracing::debug!(
                            conversation_id = %conversation_id,
                            correlation_id = %correlation_id,
                            turn_id = %output_data.turn_id,
                            count,
                            "Linked side-copy projections to completed turn"
                        );
                    }
                    Err(error) => {
                        tracing::warn!(
                            conversation_id = %conversation_id,
                            correlation_id = %correlation_id,
                            turn_id = %output_data.turn_id,
                            error = %error,
                            "Failed to link side-copy projections to completed turn"
                        );
                    }
                }
            }

            Ok(())
        },
    )
    .await??;

    tracing::debug!(
        conversation_id = %conversation_id,
        "Persisted agent output to messages table"
    );

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn output_with_timeline(timeline: &str) -> AgentOutputData {
        serde_json::from_str::<serde_json::Value>(
            r#"{
                "conversation_id": 1,
                "role": "assistant",
                "created_at": 1,
                "updated_at": 1
            }"#,
        )
        .map(|mut value| {
            value["turn_id"] = serde_json::json!("turn_test");
            value["timeline"] = serde_json::json!(timeline);
            serde_json::from_value(value).unwrap()
        })
        .unwrap()
    }

    #[test]
    fn timeline_projection_coalesces_text_including_end_marker() {
        let timeline = serde_json::to_string(&vec![
            OutputTimelineItem::Text {
                text: "你好".to_string(),
                timestamp: 1,
            },
            OutputTimelineItem::Text {
                text: "！".to_string(),
                timestamp: 1,
            },
            OutputTimelineItem::Text {
                text: "END".to_string(),
                timestamp: 2,
            },
        ])
        .unwrap();
        let parts = build_complete_parts_array(&output_with_timeline(&timeline))
            .and_then(|value| value.as_array().cloned())
            .unwrap();

        // "END" is now treated as regular text content, not filtered out
        assert_eq!(parts.len(), 1);
        assert_eq!(parts[0]["type"], "text");
        assert_eq!(parts[0]["text"], "你好！END");
    }

    #[test]
    fn timeline_projection_preserves_interleaving() {
        let timeline = serde_json::to_string(&vec![
            OutputTimelineItem::Thinking {
                text: "why".to_string(),
                timestamp: 1,
            },
            OutputTimelineItem::Text {
                text: "hello ".to_string(),
                timestamp: 2,
            },
            OutputTimelineItem::ToolCall {
                id: "call_1".to_string(),
                name: "send_message".to_string(),
                kind: None,
                input: Box::new(serde_json::json!({"message": "hello"})),
                output: Box::new(Some(serde_json::json!({"status": "queued"}))),
                status: "completed".to_string(),
                locations: Vec::new(),
                started_at: 3,
                completed_at: Some(4),
                error: None,
            },
        ])
        .unwrap();
        let parts = build_complete_parts_array(&output_with_timeline(&timeline))
            .and_then(|value| value.as_array().cloned())
            .unwrap();

        let types: Vec<&str> = parts
            .iter()
            .map(|part| part["type"].as_str().unwrap())
            .collect();
        assert_eq!(types, ["tool-Thinking", "text", "tool-send_message"]);
    }
}
