//! Application context — centralized dependency injection container.
//!
//! This module provides `AppContext`, which encapsulates all global state that
//! was previously accessed via `OnceLock` singletons. This improves:
//! - **Testability**: Tests can create mock contexts without global state
//! - **Explicit dependencies**: Dependencies are passed explicitly, not hidden
//! - **Initialization order**: Constructor enforces correct initialization sequence
//!
//! # Migration Strategy
//!
//! This is a gradual migration. Currently, both `AppContext` and the old
//! `get_*()` singleton accessors coexist. New code should prefer `AppContext`.
//! Over time, we'll migrate all callers to use `AppContext` and remove the
//! singletons.

use std::sync::Arc;
use std::sync::Mutex;

use ergatai_nats::NatsConnection;
use ergatai_runtime::AgentRuntime;
use rusqlite::Connection;

/// Centralized application context holding all shared state.
///
/// This replaces the previous pattern of accessing global singletons via
/// `get_agent_runtime()`, `get_nats_connection()`, etc. Instead, components
/// receive `&AppContext` as a parameter, making dependencies explicit.
///
/// # Thread Safety
///
/// All fields are `Arc` or otherwise `Send + Sync`, so `AppContext` can be
/// shared across threads. Typically, you create one `AppContext` at startup
/// and clone the `Arc<AppContext>` to pass to different components.
pub struct AppContext {
    /// Agent runtime — manages agent lifecycle, workspaces, and backend.
    /// Previously accessed via `get_agent_runtime()`.
    pub agent_runtime: Arc<AgentRuntime>,

    /// NATS connection for messaging and event bus.
    /// Previously accessed via `get_nats_connection()`.
    /// Note: NATS connection is cloneable, so we store an Option.
    pub nats_connection: Option<NatsConnection>,

    /// User data database connection (SQLite).
    /// Previously accessed via `get_user_data_db()`.
    pub user_data_db: Arc<Mutex<Connection>>,
}

impl AppContext {
    /// Create a new `AppContext` with all required dependencies.
    ///
    /// This is the full constructor. All dependencies must be provided.
    pub fn new(
        agent_runtime: Arc<AgentRuntime>,
        nats_connection: Option<NatsConnection>,
        user_data_db: Arc<Mutex<Connection>>,
    ) -> Self {
        Self {
            agent_runtime,
            nats_connection,
            user_data_db,
        }
    }

    /// Create an `AppContext` for testing.
    ///
    /// This creates a context with minimal initialization, suitable for
    /// unit tests that don't need the full production setup.
    #[cfg(test)]
    pub fn test_context() -> Self {
        // For tests, create an in-memory SQLite database
        let db = Arc::new(Mutex::new(
            Connection::open_in_memory().expect("Failed to create test database"),
        ));
        Self {
            agent_runtime: Arc::new(AgentRuntime::new(std::sync::Arc::new(
                ergatai_runtime::backends::acp::AcpBackend::new(),
            ))),
            nats_connection: None,
            user_data_db: db,
        }
    }
}

/// Global `AppContext` instance (transitional).
///
/// During the migration period, we still need a global accessor for code
/// that hasn't been migrated yet. This will be removed once all callers
/// receive `AppContext` via dependency injection.
static APP_CONTEXT: std::sync::OnceLock<Arc<AppContext>> = std::sync::OnceLock::new();

/// Initialize the global `AppContext`.
///
/// This should be called once at application startup. Subsequent calls
/// are ignored (the first initialization wins).
pub fn init_app_context(ctx: AppContext) {
    let _ = APP_CONTEXT.set(Arc::new(ctx));
}

/// Get the global `AppContext`.
///
/// # Panics
///
/// Panics if `init_app_context()` has not been called yet.
pub fn get_app_context() -> Arc<AppContext> {
    APP_CONTEXT
        .get()
        .cloned()
        .expect("AppContext not initialized. Call init_app_context() first.")
}

/// Get the global `AppContext`, or `None` if not initialized.
///
/// This is a non-panicking version of `get_app_context()`, useful for
/// code that might run before initialization (e.g., early startup).
pub fn try_get_app_context() -> Option<Arc<AppContext>> {
    APP_CONTEXT.get().cloned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_app_context_creation() {
        let runtime = Arc::new(AgentRuntime::new(std::sync::Arc::new(
            ergatai_runtime::backends::acp::AcpBackend::new(),
        )));
        let db = Arc::new(Mutex::new(
            Connection::open_in_memory().expect("Failed to create test database"),
        ));
        let ctx = AppContext::new(runtime.clone(), None, db.clone());
        assert!(Arc::ptr_eq(&ctx.agent_runtime, &runtime));
        assert!(ctx.nats_connection.is_none());
    }

    #[test]
    fn test_app_context_test_context() {
        let ctx = AppContext::test_context();
        // Just verify it doesn't panic
        let _ = &ctx.agent_runtime;
        let _ = &ctx.user_data_db;
    }
}
