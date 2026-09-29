// Error handling module for Ergatai
// Provides structured error types with fine-grained ConfigError variants

mod classify;
pub mod datetime;
pub mod id;
mod types;

// Re-export public API
pub use types::{ConfigError, ErgataiError, ErrorCode};

/// Result type alias using ErgataiError
pub type ErgataiResult<T> = Result<T, ErgataiError>;
