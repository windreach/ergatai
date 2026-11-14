//! Hooks for keeping agent and MCP session lifecycles aligned.
//!
//! The runtime crate owns agent stop/suspend decisions, but only the API crate
//! owns the Streamable HTTP MCP session manager.  The API layer installs a
//! callback here so stopping or suspending an agent can deterministically close
//! that agent's MCP sessions before the agent process is killed.

use std::{
    future::Future,
    pin::Pin,
    sync::{Arc, OnceLock},
};

pub type McpSessionCloseFuture = Pin<Box<dyn Future<Output = ()> + Send>>;
pub type McpSessionCloser = Arc<dyn Fn(&str) -> McpSessionCloseFuture + Send + Sync + 'static>;

static MCP_SESSION_CLOSER: OnceLock<McpSessionCloser> = OnceLock::new();

/// Install the API-layer callback used to close an agent's MCP sessions.
pub fn set_global_mcp_session_closer(closer: McpSessionCloser) -> Result<(), McpSessionCloser> {
    MCP_SESSION_CLOSER.set(closer)
}

/// Best-effort close all MCP sessions associated with a runtime agent.
pub async fn close_agent_mcp_sessions(agent_id: &str) {
    let Some(closer) = MCP_SESSION_CLOSER.get() else {
        tracing::debug!(
            agent_id = %agent_id,
            "No MCP session closer installed; skipping MCP lifecycle cleanup"
        );
        return;
    };

    closer(agent_id).await;
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    #[tokio::test]
    async fn invokes_installed_closer() {
        static CLOSER: std::sync::OnceLock<AtomicUsize> = std::sync::OnceLock::new();
        let counter = CLOSER.get_or_init(|| AtomicUsize::new(0));

        let result = set_global_mcp_session_closer(Arc::new(|agent_id| {
            let counter = CLOSER.get().expect("closer installed");
            let agent_id = agent_id.to_owned();
            Box::pin(async move {
                if agent_id == "agent-test" {
                    counter.fetch_add(1, Ordering::SeqCst);
                }
            })
        }));
        assert!(result.is_ok(), "test global hook should only be set once");

        let before = counter.load(Ordering::SeqCst);
        close_agent_mcp_sessions("agent-test").await;
        assert_eq!(counter.load(Ordering::SeqCst), before + 1);
    }

    #[tokio::test]
    async fn close_does_not_panic() {
        // Should not panic whether or not a closer is installed.
        close_agent_mcp_sessions("agent-noop").await;
    }
}
