//! Agent output persistence service.
//!
//! This module provides the persistence callback that saves accumulated agent
//! outputs to the messages table when a turn completes.

use ergatai_error::id::generate;
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
    output_data: AgentOutputData,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    use crate::user_data_db::conversations;
    use crate::user_data_db::messages::{self, AgentOutputFields};
    use crate::user_data_db::{Conversation, DEFAULT_COLLABORATION_MODE};

    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64;

    // Write to database in a blocking task
    tokio::task::spawn_blocking(
        move || -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
            // Ensure conversation record exists (FOREIGN KEY constraint)
            // Try to get the conversation; if it doesn't exist, create a minimal record
            let conv_exists = match conversations::get(output_data.conversation_id) {
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
                let workspace_id = generate();
                let chat_id = generate();
                let collab_session_id = generate();

                // Create a default workspace record (required by FOREIGN KEY)
                let workspace = crate::user_data_db::Workspace {
                    workspace_id,
                    name: format!(
                        "Auto-generated workspace for {}",
                        output_data.conversation_id
                    ),
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
                        workspace_id = workspace_id,
                        error = %e,
                        "Failed to create auto-generated workspace (may already exist)"
                    );
                }

                // Create a default chat record (required by FOREIGN KEY)
                let chat = crate::user_data_db::Chat {
                    chat_id,
                    workspace_id,
                    name: Some(format!(
                        "Auto-generated chat for {}",
                        output_data.conversation_id
                    )),
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
                        chat_id = chat_id,
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
                        collaboration_session_id = collab_session_id,
                        error = %e,
                        "Failed to create auto-generated collaboration session (may already exist)"
                    );
                }

                // Finally create the conversation record
                let conv = Conversation {
                    conversation_id: output_data.conversation_id,
                    collaboration_session_id: collab_session_id,
                    chat_id,
                    parent_id: None,
                    name: Some(format!(
                        "Auto-generated for agent output {}",
                        output_data.conversation_id
                    )),
                    mode: "agent".to_string(),
                    participant_role: "assistant".to_string(),
                    status: "completed".to_string(),
                    created_at: now,
                    updated_at: now,
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
            let output_fields = AgentOutputFields {
                thinking: output_data.thinking.clone(),
                tool_calls: output_data.tool_calls.clone(),
                text_chunks: output_data.text_chunks.clone(),
                stop_reason: None, // metadata is now just a JSON string, not a structured field
                duration_ms: None, // metadata is now just a JSON string, not a structured field
            };

            // Build complete parts JSON array including thinking, tool_calls, and final_text
            // This ensures the frontend can render all content from the parts array
            let parts = build_complete_parts_array(&output_data);

            // Insert into messages table with agent output fields
            messages::append_with_output(
                output_data.conversation_id,
                &output_data.role,
                parts,
                serde_json::json!({}),
                None,
                Some(output_fields),
            )?;

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
