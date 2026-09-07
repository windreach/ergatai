//! ACP HTTP Server — Expose ergatai as an ACP endpoint.
//!
//! Allows external ACP clients to connect to ergatai and interact with
//! the agent management system via the ACP protocol over HTTP/SSE.
//!
//! # Status
//!
//! This module is a work in progress. The ACP SDK's HTTP server API has evolved,
//! and this implementation needs to be updated to match the current API.
//!
//! # Use Cases
//!
//! - External tools can manage agents through ACP protocol
//! - Web UIs can connect directly via HTTP/SSE
//! - Integration with other ACP-compliant systems
//!
//! # Configuration
//!
//! Enable via environment variable:
//! ```bash
//! ERGATAI_ACP_SERVER_ENABLED=1
//! ERGATAI_ACP_SERVER_CORS_ORIGINS=http://localhost:3000,http://localhost:5173
//! ```

use std::sync::Arc;

use axum::Router;
use tracing::info;

use ergatai_runtime::AgentRuntime;

/// ACP server endpoint that exposes ergatai as an ACP agent.
///
/// This allows external ACP clients to interact with ergatai's
/// agent management capabilities through the standard ACP protocol.
///
/// # Status
///
/// This is a placeholder implementation. Full ACP server support
/// requires updating to match the current ACP SDK HTTP server API.
#[allow(dead_code)]
pub struct AcpServerEndpoint {
    runtime: Arc<AgentRuntime>,
    cors_origins: Vec<String>,
}

/// Configuration for the ACP server endpoint.
#[derive(Debug, Clone)]
pub struct AcpServerConfig {
    /// Whether the ACP server is enabled.
    pub enabled: bool,
    /// CORS allowed origins.
    pub cors_origins: Vec<String>,
}

impl AcpServerConfig {
    /// Load configuration from environment variables.
    pub fn from_env() -> Self {
        let enabled = std::env::var("ERGATAI_ACP_SERVER_ENABLED")
            .map(|v| v == "1" || v.to_lowercase() == "true")
            .unwrap_or(false);

        let cors_origins = std::env::var("ERGATAI_ACP_SERVER_CORS_ORIGINS")
            .map(|v| v.split(',').map(|s| s.trim().to_string()).collect())
            .unwrap_or_default();

        Self {
            enabled,
            cors_origins,
        }
    }
}

impl AcpServerEndpoint {
    /// Create a new ACP server endpoint.
    pub fn new(runtime: Arc<AgentRuntime>, cors_origins: Vec<String>) -> Self {
        Self {
            runtime,
            cors_origins,
        }
    }

    /// Check if the ACP server is enabled.
    pub fn is_enabled() -> bool {
        AcpServerConfig::from_env().enabled
    }
}

/// Mount the ACP server endpoints to the router.
///
/// This is a placeholder implementation. When enabled, it logs a message
/// but does not actually mount any ACP endpoints.
///
/// # Arguments
///
/// * `app` - The axum Router to mount endpoints to
/// * `runtime` - The AgentRuntime instance
///
/// # Returns
///
/// The router with ACP endpoints mounted (currently unchanged).
pub fn mount_acp_server(app: Router, _runtime: Arc<AgentRuntime>) -> Router {
    let config = AcpServerConfig::from_env();

    if config.enabled {
        info!(
            cors_origins = ?config.cors_origins,
            "ACP server endpoint requested (placeholder implementation)"
        );
        info!("Full ACP server support requires updating to match the current ACP SDK HTTP server API");
        // TODO: Implement full ACP server using agent_client_protocol_http::AcpHttpServer
        // The current ACP SDK HTTP server API requires:
        // 1. Creating AcpHttpServer with the runtime
        // 2. Implementing the ACP agent protocol handlers
        // 3. Mounting the server to the axum router
    } else {
        info!("ACP server endpoint disabled (set ERGATAI_ACP_SERVER_ENABLED=1 to enable)");
    }

    app
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_config_from_env() {
        std::env::remove_var("ERGATAI_ACP_SERVER_ENABLED");
        let config = AcpServerConfig::from_env();
        assert!(!config.enabled);

        std::env::set_var("ERGATAI_ACP_SERVER_ENABLED", "1");
        let config = AcpServerConfig::from_env();
        assert!(config.enabled);

        std::env::remove_var("ERGATAI_ACP_SERVER_ENABLED");
    }

    #[test]
    fn test_cors_origins_parsing() {
        std::env::set_var(
            "ERGATAI_ACP_SERVER_CORS_ORIGINS",
            "http://localhost:3000,http://localhost:5173",
        );
        let config = AcpServerConfig::from_env();
        assert_eq!(config.cors_origins.len(), 2);
        assert_eq!(config.cors_origins[0], "http://localhost:3000");
        assert_eq!(config.cors_origins[1], "http://localhost:5173");

        std::env::remove_var("ERGATAI_ACP_SERVER_CORS_ORIGINS");
    }
}
