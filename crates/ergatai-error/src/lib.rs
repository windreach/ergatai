// Error handling module for Ergatai
// Provides structured error types with fine-grained ConfigError variants

mod classify;
pub mod datetime;
pub mod id;
pub mod typed_ids;
mod types;

// Re-export public API
pub use types::{ConfigError, ErgataiError, ErrorCode};

// Re-export typed IDs for convenience
pub use typed_ids::{
    AgentId, ChatId, CheckpointId, CollaborationSessionId, ConversationId, DagId, IdParseError,
    LockId, MessageId, PermissionId, ProjectId, SnapshotId, TaskId, WorkspaceId,
};

/// Result type alias using ErgataiError
pub type ErgataiResult<T> = Result<T, ErgataiError>;
