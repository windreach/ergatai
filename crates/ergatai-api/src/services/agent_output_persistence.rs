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
pub async fn persist_agent_output(
    conversation_id: i64,
    output_data: AgentOutputData,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    use crate::user_data_db::agent_outputs;
    use crate::user_data_db::AgentOutput;

    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
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
