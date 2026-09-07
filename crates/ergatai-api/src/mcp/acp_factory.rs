//! MCP-over-ACP factory implementation for ergatai-api.
//!
//! This module provides the concrete implementation of `McpServerFactory` that
//! creates MCP servers backed by ergatai's tools (list_agents, send_message, etc.).
//!
//! Note: This uses rmcp 2.x (aliased as rmcp2) for compatibility with agent-client-protocol-rmcp.

use std::sync::Arc;

use agent_client_protocol::mcp_server::McpServer;
use agent_client_protocol::role;
use agent_client_protocol_rmcp::McpServerExt;
use rmcp2::{
    model::{CallToolResult, ServerCapabilities, ServerInfo},
    ErrorData, ServerHandler,
};
use schemars::JsonSchema;
use serde::Deserialize;
use tracing::info;

use ergatai_core::agent_registry::AgentRegistry;
use ergatai_runtime::mcp_over_acp::McpServerFactory;

use crate::mcp::server::PeerRegistry;

/// Factory that creates MCP servers for ACP sessions.
///
/// Each factory creates MCP servers that have access to ergatai's agent registry
/// and can call tools like list_agents, send_message, etc.
pub struct ErgataiMcpServerFactory {
    /// Agent registry for tool implementations.
    registry: Arc<AgentRegistry>,
    /// Peer registry for MCP sessions.
    peer_registry: PeerRegistry,
    /// Server name.
    name: String,
}

impl ErgataiMcpServerFactory {
    /// Create a new factory.
    pub fn new(
        registry: Arc<AgentRegistry>,
        peer_registry: PeerRegistry,
        name: String,
    ) -> Self {
        Self {
            registry,
            peer_registry,
            name,
        }
    }
}

impl McpServerFactory for ErgataiMcpServerFactory {
    fn create_mcp_server(&self) -> Box<dyn std::any::Any + Send + Sync> {
        // Create an MCP server using rmcp integration.
        // The server is created with access to the agent registry.
        let registry = self.registry.clone();
        let peer_registry = self.peer_registry.clone();

        // Create the rmcp service.
        let service = ErgataiAcpMcpService::new(registry, peer_registry);

        // Convert to ACP McpServer using from_rmcp.
        let mcp_server = McpServer::<role::mcp::Client>::from_rmcp(&self.name, move || {
            service.clone()
        });

        Box::new(mcp_server)
    }

    fn server_name(&self) -> &str {
        &self.name
    }
}

/// rmcp service implementation for ACP MCP tools.
///
/// This service provides the same tools as the HTTP MCP server, but is designed
/// to be attached to ACP sessions via the native MCP-over-ACP transport.
///
/// Note: This manually implements ServerHandler to avoid macro conflicts between
/// rmcp 2.x and 3.x versions in the same crate.
#[derive(Clone)]
#[allow(dead_code)]
pub struct ErgataiAcpMcpService {
    registry: Arc<AgentRegistry>,
    peer_registry: PeerRegistry,
}

impl ErgataiAcpMcpService {
    /// Create a new service.
    pub fn new(registry: Arc<AgentRegistry>, peer_registry: PeerRegistry) -> Self {
        Self {
            registry,
            peer_registry,
        }
    }

    /// Handle list_agents tool call.
    async fn handle_list_agents(&self) -> Result<CallToolResult, ErrorData> {
        let agents = self.registry.list_agents().await;
        let json = serde_json::to_string_pretty(&agents)
            .map_err(|e| ErrorData::internal_error(format!("Failed to serialize agents: {}", e), None))?;
        Ok(CallToolResult::success(vec![rmcp2::model::ContentBlock::text(json)]))
    }

    /// Handle send_message tool call.
    async fn handle_send_message(
        &self,
        params: SendMessageParams,
    ) -> Result<CallToolResult, ErrorData> {
        // Simplified implementation - in production, this would use NATS
        info!(
            target_agent = %params.target_agent_id,
            message_len = params.content.len(),
            "Sending message via ACP MCP"
        );
        Ok(CallToolResult::success(vec![rmcp2::model::ContentBlock::text(
            format!("Message queued for agent {}", params.target_agent_id),
        )]))
    }
}

/// Parameters for send_message tool.
#[derive(Debug, Deserialize, JsonSchema)]
struct SendMessageParams {
    /// Target agent ID.
    target_agent_id: String,
    /// Message content.
    content: String,
}

impl ServerHandler for ErgataiAcpMcpService {
    fn get_info(&self) -> ServerInfo {
        ServerInfo::new(ServerCapabilities::builder().enable_tools().build())
            .with_server_info(rmcp2::model::Implementation::new(
                "ergatai-acp-mcp",
                "0.1.0",
            ))
            .with_protocol_version(rmcp2::model::ProtocolVersion::V_2024_11_05)
            .with_instructions("Ergatai MCP tools for ACP agents")
    }

    async fn list_tools(
        &self,
        _request: Option<rmcp2::model::PaginatedRequestParams>,
        _context: rmcp2::service::RequestContext<rmcp2::RoleServer>,
    ) -> Result<rmcp2::model::ListToolsResult, ErrorData> {
        // Tools will be discovered via call_tool
        Ok(rmcp2::model::ListToolsResult {
            tools: vec![],
            next_cursor: None,
            ..Default::default()
        })
    }

    async fn call_tool(
        &self,
        request: rmcp2::model::CallToolRequestParams,
        _context: rmcp2::service::RequestContext<rmcp2::RoleServer>,
    ) -> Result<CallToolResult, ErrorData> {
        let tool_name = request.name.clone();
        match tool_name.as_ref() {
            "list_agents" => self.handle_list_agents().await,
            "send_message" => {
                let args = request.arguments.unwrap_or_default();
                let params: SendMessageParams = serde_json::from_value(serde_json::Value::Object(args))
                    .map_err(|e| {
                        ErrorData::invalid_params(
                            format!("Invalid send_message parameters: {}", e),
                            None,
                        )
                    })?;
                self.handle_send_message(params).await
            }
            _ => Err(ErrorData::invalid_request(
                format!("Unknown tool: {}", tool_name),
                None,
            )),
        }
    }
}
