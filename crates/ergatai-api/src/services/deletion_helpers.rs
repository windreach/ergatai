//! Deletion cleanup helpers
//!
//! Shared logic for enqueueing async cleanup of conversation message tables.

use ergatai_error::ConversationId;

/// Enqueue async cleanup of conversation message tables.
///
/// Collects conversation IDs, serializes them to JSON, and enqueues a deletion job.
/// Errors during serialization are logged but do not fail the operation
/// (the caller should proceed with the main deletion).
///
/// # Arguments
/// * `entity_type` - Type of entity being deleted ("chat" or "workspace")
/// * `entity_id` - ID of the entity (as string)
/// * `action` - Action name for the deletion job (e.g., "cleanup_chat", "cleanup_workspace")
/// * `conversation_ids` - List of conversation IDs to clean up
pub fn enqueue_conversation_cleanup(
    entity_type: &str,
    entity_id: &str,
    action: &str,
    conversation_ids: Vec<ConversationId>,
) {
    // Serialize conversation IDs to JSON payload
    let payload = match serde_json::to_string(&conversation_ids) {
        Ok(p) => p,
        Err(e) => {
            tracing::warn!(
                error = %e,
                entity_type,
                entity_id,
                "Failed to serialize conversation IDs for cleanup; proceeding with empty payload"
            );
            "[]".to_string()
        }
    };

    // Enqueue deletion job
    if let Err(e) =
        crate::user_data_db::chats::enqueue_deletion(entity_type, entity_id, action, Some(&payload))
    {
        tracing::warn!(
            error = %e,
            entity_type,
            entity_id,
            conversation_count = conversation_ids.len(),
            "Failed to enqueue {} cleanup job",
            entity_type
        );
    }
}
