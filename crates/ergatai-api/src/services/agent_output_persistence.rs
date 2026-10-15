//! Agent output persistence service.
//!
//! This module provides the persistence callback that saves accumulated agent
//! outputs to the database when a turn completes.

use ergatai_error::id::generate;
use ergatai_runtime::AgentOutputData;

/// Persist agent output to database.
///
/// This function is called by the runtime when a prompt completes and the
/// accumulated output needs to be saved. It converts the AgentOutputData
/// to the database model and inserts it.
///
/// If the conversation record doesn't exist, it will be created automatically
/// to satisfy the FOREIGN KEY constraint.
pub async fn persist_agent_output(
    conversation_id: i64,
    output_data: AgentOutputData,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    use crate::user_data_db::agent_outputs;
    use crate::user_data_db::conversations;
    use crate::user_data_db::AgentOutput;
    use crate::user_data_db::Conversation;

    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64;

    // Generate a unique ID for the agent output
    let output_id = generate();

    let agent_output = AgentOutput {
        id: output_id,
        conversation_id: output_data.conversation_id,
        message_id: output_data.message_id,
        sequence: output_data.sequence,
        role: output_data.role,
        thinking: output_data.thinking,
        tool_calls: output_data.tool_calls,
        text_chunks: output_data.text_chunks,
        final_text: output_data.final_text,
        metadata: output_data.metadata,
        created_at: now,
        updated_at: now,
    };

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
                    collaboration_session_id: collab_session_id, // Link to the session we just created
                    chat_id,                                     // Link to the chat we just created
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

            agent_outputs::create(agent_output)?;
            Ok(())
        },
    )
    .await??;

    tracing::debug!(
        conversation_id = %conversation_id,
        "Persisted agent output to database"
    );

    Ok(())
}
