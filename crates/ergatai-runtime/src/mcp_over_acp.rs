//! MCP-over-ACP — Provide MCP tools to ACP agents via native ACP transport.
//!
//! This module allows ergatai to expose its MCP tools (list_agents, send_message,
//! submit_orchestration, etc.) to ACP agents using the native ACP MCP transport.
//!
//! # How it works
//!
//! When an ACP agent is started, ergatai can attach an MCP server to the session.
//! The agent can then call MCP tools through the ACP protocol using:
//! - `mcp/connect` - Establish MCP connection
//! - `mcp/message` - Send MCP requests/responses
//! - `mcp/disconnect` - Close MCP connection
//!
//! # Architecture
//!
//! The MCP server implementation lives in `ergatai-api` (using rmcp). This module
//! provides a trait-based abstraction so `ergatai-runtime` can attach MCP servers
//! to ACP sessions without directly depending on the implementation.
//!
//! # Configuration
//!
//! Enable via environment variable:
//! ```bash
//! ERGATAI_MCP_OVER_ACP_ENABLED=1
//! ERGATAI_MCP_SERVER_NAME="Ergatai MCP Tools"
//! ```

use tracing::{debug, info};

/// Trait for creating MCP servers that can be attached to ACP sessions.
///
/// This trait abstracts the MCP server creation so that `ergatai-runtime` doesn't
/// need to know about the concrete implementation (which lives in `ergatai-api`).
///
/// The factory returns a type-erased MCP server that will be downcast when attaching
/// to ACP sessions.
pub trait McpServerFactory: Send + Sync + 'static {
    /// Create an MCP server instance.
    ///
    /// Returns a boxed MCP server that can be attached to ACP sessions.
    /// The concrete type should be `McpServer<role::mcp::Client, impl RunWithConnectionTo<role::mcp::Client>>`.
    fn create_mcp_server(&self) -> Box<dyn std::any::Any + Send + Sync>;

    /// Get the server name (for logging/display).
    fn server_name(&self) -> &str;
}

/// Wrapper that holds a concrete MCP server for ACP integration.
///
/// This is created by the factory and passed to `AcpBackend`.
pub struct AcpMcpServer {
    /// The underlying MCP server (type-erased for cross-crate compatibility).
    inner: Box<dyn std::any::Any + Send + Sync>,
    /// Server name for logging.
    name: String,
}

impl AcpMcpServer {
    /// Create a new wrapper.
    pub fn new(inner: Box<dyn std::any::Any + Send + Sync>, name: String) -> Self {
        Self { inner, name }
    }

    /// Get the server name.
    pub fn name(&self) -> &str {
        &self.name
    }

    /// Try to downcast to the concrete MCP server type.
    ///
    /// Returns `None` if the inner type doesn't match.
    pub fn downcast<T: 'static>(&self) -> Option<&T> {
        self.inner.downcast_ref::<T>()
    }

    /// Consume the wrapper and return the inner value.
    pub fn into_inner(self) -> Box<dyn std::any::Any + Send + Sync> {
        self.inner
    }
}

/// Configuration for MCP-over-ACP.
#[derive(Debug, Clone)]
pub struct McpOverAcpConfig {
    /// Whether MCP-over-ACP is enabled.
    pub enabled: bool,
    /// Server name.
    pub server_name: String,
}

impl McpOverAcpConfig {
    /// Load configuration from environment variables.
    pub fn from_env() -> Self {
        Self {
            enabled: std::env::var("ERGATAI_MCP_OVER_ACP_ENABLED")
                .map(|v| v == "1" || v.to_lowercase() == "true")
                .unwrap_or(false),
            server_name: std::env::var("ERGATAI_MCP_SERVER_NAME")
                .unwrap_or_else(|_| "Ergatai MCP Tools".to_string()),
        }
    }
}

/// Check if MCP-over-ACP is enabled via environment variable.
pub fn is_enabled() -> bool {
    McpOverAcpConfig::from_env().enabled
}

/// Helper function to check if MCP-over-ACP is enabled.
pub fn create_config_if_enabled() -> Option<McpOverAcpConfig> {
    let config = McpOverAcpConfig::from_env();
    if config.enabled {
        info!("MCP-over-ACP enabled");
        Some(config)
    } else {
        debug!("MCP-over-ACP disabled");
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_config_from_env() {
        std::env::remove_var("ERGATAI_MCP_OVER_ACP_ENABLED");
        let config = McpOverAcpConfig::from_env();
        assert!(!config.enabled);

        std::env::set_var("ERGATAI_MCP_OVER_ACP_ENABLED", "1");
        let config = McpOverAcpConfig::from_env();
        assert!(config.enabled);

        std::env::remove_var("ERGATAI_MCP_OVER_ACP_ENABLED");
    }

    #[test]
    fn test_acp_mcp_server_wrapper() {
        let inner = Box::new(42i32);
        let server = AcpMcpServer::new(inner, "test-server".to_string());
        assert_eq!(server.name(), "test-server");
        assert_eq!(server.downcast::<i32>(), Some(&42));
    }
}
