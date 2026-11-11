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

#[cfg(test)]
mod tests {
    use super::*;
    use ergatai_error::ConversationId;
    use std::sync::Mutex;

    static TEST_DB_MUTEX: Mutex<()> = Mutex::new(());
    static TEST_DB_DATA_DIR: std::sync::OnceLock<std::path::PathBuf> = std::sync::OnceLock::new();

    fn lock_db() -> std::sync::MutexGuard<'static, ()> {
        let guard = TEST_DB_MUTEX.lock().unwrap_or_else(|e| e.into_inner());
        TEST_DB_DATA_DIR.get_or_init(|| {
            let data_dir = std::env::temp_dir()
                .join("ergatai-deletion-tests")
                .join(std::process::id().to_string());
            let _ = std::fs::remove_dir_all(&data_dir);
            std::fs::create_dir_all(&data_dir).unwrap();
            std::env::set_var("ERGATAI_DATA_DIR", &data_dir);
            data_dir
        });
        let _ = crate::user_data_db::get_user_data_db();
        guard
    }

    #[test]
    fn test_enqueue_does_not_panic() {
        let _g = lock_db();
        let ids = vec![ConversationId::new(1), ConversationId::new(2)];
        // Should not panic even if enqueue_deletion fails (no parent rows)
        enqueue_conversation_cleanup("chat", "123", "cleanup_chat", ids);
    }
}
