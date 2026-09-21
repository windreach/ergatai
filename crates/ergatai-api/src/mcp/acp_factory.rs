//! MCP-over-ACP factory implementation for ergatai-api.
//!
//! This module provides the concrete implementation of `McpServerFactory` that
//! creates MCP servers backed by ergatai's tools (list_agents, send_message, etc.).
//!
//! Both HTTP MCP and ACP MCP now use the same rmcp version (2.x), so we can
//! share parameter types from `params.rs` and reduce code duplication.

use std::sync::Arc;

use agent_client_protocol::mcp_server::McpServer;
use agent_client_protocol::{role, DynConnectTo};
use agent_client_protocol_rmcp::McpServerExt;
use rmcp::{
    model::{CallToolResult, ServerCapabilities, ServerInfo, Tool},
    ErrorData, ServerHandler,
};
use tracing::{info, warn};

use ergatai_core::agent_registry::AgentRegistry;
use ergatai_runtime::mcp_over_acp::McpServerFactory;

use super::params::{
    GetDagStatusParams, ListAgentsParams, SendMessageParams, SubmitOrchestrationParams,
    ValidateDagParams,
};
use crate::mcp::server::PeerRegistry;

// ── Factory ──

/// Factory that creates MCP servers for ACP sessions.
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
    pub fn new(registry: Arc<AgentRegistry>, peer_registry: PeerRegistry, name: String) -> Self {
        Self {
            registry,
            peer_registry,
            name,
        }
    }
}

impl McpServerFactory for ErgataiMcpServerFactory {
    fn create_mcp_server(&self) -> DynConnectTo<role::mcp::Client> {
        let registry = self.registry.clone();
        let peer_registry = self.peer_registry.clone();

        let service = ErgataiAcpMcpService::new(registry, peer_registry);

        let mcp_server =
            McpServer::<role::mcp::Client>::from_rmcp(&self.name, move || service.clone());

        DynConnectTo::new(mcp_server)
    }

    fn server_name(&self) -> &str {
        &self.name
    }
}

// ── Schema conversion helper ──

/// Convert a schemars JSON Schema to the Arc<JsonObject> format required by rmcp.
fn schema_to_arc_json_object(
    schema: schemars::Schema,
) -> Arc<serde_json::Map<String, serde_json::Value>> {
    let value = match serde_json::to_value(schema) {
        Ok(v) => v,
        Err(e) => {
            warn!(error = %e, "Failed to serialize JSON schema, using empty object");
            serde_json::Value::Object(Default::default())
        }
    };
    match value {
        serde_json::Value::Object(map) => Arc::new(map),
        _ => Arc::new(Default::default()),
    }
}

// ── Service ──

/// rmcp service implementation for ACP MCP tools.
///
/// This service provides the same tools as the HTTP MCP server, but is designed
/// to be attached to ACP sessions via the native MCP-over-ACP transport.
///
/// All tool implementations delegate to the shared service layer (agent_service,
/// messaging, dag_service), same as the HTTP MCP tools.
#[derive(Clone)]
pub struct ErgataiAcpMcpService {
    /// Agent registry — kept for potential future use (e.g., session binding).
    #[allow(dead_code)]
    registry: Arc<AgentRegistry>,
    /// Peer registry — kept for potential future use (e.g., notifications).
    #[allow(dead_code)]
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

    /// Build the tool definitions for list_tools response.
    fn build_tools() -> Vec<Tool> {
        vec![
            Tool::new(
                "list_agents",
                "List online agents in Ergatai. Use BEFORE `send_message` to discover valid target_agent_id values. RESPONSE: JSON with {agents: [{agent_id, state, workspace_id, is_alive, ...}], total, filter_applied}. FILTER: pass `filter` as a JSON OBJECT, e.g. {\"filter\": {\"status\": \"idle\"}}.",
                schema_to_arc_json_object(schemars::schema_for!(ListAgentsParams)),
            ),
            Tool::new(
                "send_message",
                r#"Send a message to another online agent. Persists via NATS JetStream.

PARAMETERS:
- target_agent_id (REQUIRED): recipient's ergatai_agent_id from list_agents
- message (REQUIRED): message content
- message_type (OPTIONAL, default "request"): "request" | "response" | "broadcast"
- correlation_id (OPTIONAL): system auto-tracks

RESPONSE: {status: "queued"|"direct_delivered", target_agent, delivery_method}

RATE LIMITS: 60 msg/min/agent, NATS backpressure >=1000 pending triggers rejection"#,
                schema_to_arc_json_object(schemars::schema_for!(SendMessageParams)),
            ),
            Tool::new(
                "submit_orchestration",
                r#"Submit a DAG workflow for multi-agent collaboration. BEFORE calling: (1) run `validate_dag_yaml`; (2) run `list_agents` to confirm agents are online. Only ONE DAG can run at a time.

YAML format: top-level `tasks:`, each with `name`, `agent`, `task`.
RESPONSE: {status: 'submitted', submitted_nodes, progress}"#,
                schema_to_arc_json_object(schemars::schema_for!(SubmitOrchestrationParams)),
            ),
            Tool::new(
                "validate_dag_yaml",
                r#"Dry-run validate a DAG YAML definition. ALWAYS call BEFORE `submit_orchestration`.
RESPONSE on success: {valid: true, task_count, agents: [...], tasks: [...]}.
RESPONSE on failure: MCP error with validation error."#,
                schema_to_arc_json_object(schemars::schema_for!(ValidateDagParams)),
            ),
            Tool::new(
                "get_dag_status",
                r#"Get DAG execution status. Poll every 10-30s during long runs.
RESPONSE: {status: 'no_dag'|'running'|'completed', progress, is_complete, graph_snapshot, collaboration}."#,
                schema_to_arc_json_object(schemars::schema_for!(GetDagStatusParams)),
            ),
        ]
    }

    /// Handle list_agents tool call.
    async fn handle_list_agents(
        &self,
        params: ListAgentsParams,
    ) -> Result<CallToolResult, ErrorData> {
        let filter = params.filter;

        let svc_filter = crate::services::agent_service::AgentListFilter {
            in_dag: filter.as_ref().and_then(|f| f.in_dag.clone()),
            status: filter.as_ref().and_then(|f| f.status.clone()),
            exclude_agent_ids: std::collections::HashSet::new(),
        };

        let items = crate::services::agent_service::list_agents_filtered(svc_filter).await;

        let agents_json: Vec<serde_json::Value> = items
            .into_iter()
            .map(|info| {
                serde_json::json!({
                    "agent_id": info.agent_id,
                    "agent_uuid": info.agent_uuid,
                    "mcp_agent_id": info.mcp_agent_id,
                    "workspace_id": info.workspace_id,
                    "state": info.state,
                    "lifecycle_state": info.state,
                    "task_id": info.task_id,
                    "is_alive": info.is_alive,
                    "is_idle": info.is_idle,
                    "is_processing": info.is_processing,
                    "status": if info.mcp_agent_id.is_some() { "active" } else { "discovered" },
                    "ergatai_agent_id": info.mcp_agent_id,
                    "last_heartbeat": info.last_heartbeat,
                })
            })
            .collect();

        let filter_applied = filter.as_ref().is_some_and(|f| {
            f.can_communicate_with.is_some() || f.in_dag.is_some() || f.status.is_some()
        });

        let result = serde_json::json!({
            "agents": agents_json,
            "total": agents_json.len(),
            "filter_applied": filter_applied,
        });

        Ok(CallToolResult::success(vec![
            rmcp::model::ContentBlock::text(
                serde_json::to_string_pretty(&result).unwrap_or_default(),
            ),
        ]))
    }

    /// Handle send_message tool call.
    async fn handle_send_message(
        &self,
        params: SendMessageParams,
    ) -> Result<CallToolResult, ErrorData> {
        let target_agent_id = &params.target_agent_id;
        let message = &params.message;
        let message_type = params.message_type.as_deref().unwrap_or("request");
        let correlation_id = params.correlation_id;

        info!(
            target_agent = %target_agent_id,
            message_len = message.len(),
            message_type = %message_type,
            "Sending message via ACP MCP"
        );

        let from_agent = "acp-mcp-client".to_string();

        let sender = match crate::messaging::get_message_sender() {
            Some(s) => s,
            None => {
                return Err(ErrorData::internal_error(
                    "MessageSender not initialized — server startup incomplete",
                    None,
                ));
            }
        };

        let send_req = crate::messaging::SendRequest {
            from: from_agent,
            to: target_agent_id.to_string(),
            message: message.to_string(),
            message_type: message_type.to_string(),
            correlation_id,
            sub_chat_id: None,
        };

        match sender.send(send_req).await {
            crate::messaging::SendMessageResult::Queued {
                target_agent,
                stream,
                sequence,
            } => {
                let response_json = serde_json::json!({
                    "status": "queued",
                    "target_agent": target_agent,
                    "delivery_method": "nats_jetstream",
                    "stream": stream,
                    "sequence": sequence,
                });
                Ok(CallToolResult::success(vec![
                    rmcp::model::ContentBlock::text(
                        serde_json::to_string_pretty(&response_json).unwrap_or_default(),
                    ),
                ]))
            }
            crate::messaging::SendMessageResult::DirectDelivered { target_agent } => {
                let response_json = serde_json::json!({
                    "status": "direct_delivered",
                    "target_agent": target_agent,
                    "delivery_method": "pty_injection",
                });
                Ok(CallToolResult::success(vec![
                    rmcp::model::ContentBlock::text(
                        serde_json::to_string_pretty(&response_json).unwrap_or_default(),
                    ),
                ]))
            }
            crate::messaging::SendMessageResult::Rejected { reason } => {
                Ok(CallToolResult::error(vec![
                    rmcp::model::ContentBlock::text(reason),
                ]))
            }
        }
    }

    /// Handle submit_orchestration tool call.
    async fn handle_submit_orchestration(
        &self,
        params: SubmitOrchestrationParams,
    ) -> Result<CallToolResult, ErrorData> {
        info!(
            "Submitting DAG orchestration via ACP MCP ({} bytes)",
            params.dag_definition.len()
        );

        let req = crate::services::dag_service::DagSubmitRequest {
            definition: params.dag_definition,
            parameters: params.parameters,
            context: params.context,
            submitter_agent_id: None,
        };

        match crate::services::dag_service::submit_dag(req).await {
            Ok(resp) => {
                let result = serde_json::json!({
                    "status": "submitted",
                    "submitted_nodes": resp.submitted_nodes,
                    "progress": resp.progress,
                    "graph_status": resp.graph_status,
                });
                Ok(CallToolResult::success(vec![
                    rmcp::model::ContentBlock::text(
                        serde_json::to_string_pretty(&result).unwrap_or_default(),
                    ),
                ]))
            }
            Err(e) => {
                let msg = e.to_string();
                if msg.contains("already running") {
                    Err(ErrorData::internal_error(msg, None))
                } else if msg.contains("Failed to parse")
                    || msg.contains("cannot also be a task worker")
                {
                    Err(ErrorData::invalid_params(msg, None))
                } else {
                    Err(ErrorData::internal_error(msg, None))
                }
            }
        }
    }

    /// Handle validate_dag_yaml tool call.
    async fn handle_validate_dag_yaml(
        &self,
        params: ValidateDagParams,
    ) -> Result<CallToolResult, ErrorData> {
        info!(
            "Validating DAG definition via ACP MCP ({} bytes)",
            params.dag_definition.len()
        );

        match crate::services::dag_service::validate_dag(&params.dag_definition, params.parameters)
        {
            Ok(result) => Ok(CallToolResult::success(vec![
                rmcp::model::ContentBlock::text(
                    serde_json::to_string_pretty(&serde_json::to_value(result).unwrap_or_default())
                        .unwrap_or_default(),
                ),
            ])),
            Err(e) => Err(ErrorData::invalid_params(
                format!("DAG validation failed: {}", e),
                None,
            )),
        }
    }

    /// Handle get_dag_status tool call.
    async fn handle_get_dag_status(
        &self,
        params: GetDagStatusParams,
    ) -> Result<CallToolResult, ErrorData> {
        info!("Getting DAG status via ACP MCP");

        let info = crate::services::dag_service::get_dag_status(Some(&params.dag_id)).await;

        let is_from_disk = info.progress_detail.is_some() && !info.running;

        if !info.running && info.is_complete != Some(true) {
            let result = serde_json::json!({
                "status": "no_dag",
                "message": "No DAG scheduler is active",
            });
            return Ok(CallToolResult::success(vec![
                rmcp::model::ContentBlock::text(
                    serde_json::to_string_pretty(&result).unwrap_or_default(),
                ),
            ]));
        }

        if is_from_disk {
            let nodes: Vec<serde_json::Value> = info
                .nodes
                .unwrap_or_default()
                .iter()
                .map(|n| {
                    serde_json::json!({
                        "id": n.id,
                        "task": n.task,
                        "agent": n.agent,
                        "status": n.status,
                    })
                })
                .collect();

            let collab =
                info.collaboration
                    .unwrap_or(crate::services::dag_service::DagCollaborationInfo {
                        dag_id: "unknown".to_string(),
                        policy: "N/A".to_string(),
                        participants: Vec::new(),
                        participant_count: 0,
                        created_at: "N/A".to_string(),
                    });

            let detail = info.progress_detail.unwrap();

            let result = serde_json::json!({
                "status": "completed",
                "progress": {
                    "completed": detail.completed,
                    "failed": detail.failed,
                    "total": detail.total,
                    "percent": detail.percent,
                },
                "is_complete": true,
                "graph_snapshot": nodes,
                "collaboration": {
                    "dag_id": collab.dag_id,
                    "policy": collab.policy,
                    "participants": collab.participants,
                    "participant_count": collab.participant_count,
                },
                "source": "disk",
            });
            return Ok(CallToolResult::success(vec![
                rmcp::model::ContentBlock::text(
                    serde_json::to_string_pretty(&result).unwrap_or_default(),
                ),
            ]));
        }

        let detail =
            info.progress_detail
                .unwrap_or(crate::services::dag_service::DagProgressDetail {
                    completed: 0,
                    running: 0,
                    failed: 0,
                    pending: 0,
                    total: 0,
                    percent: 0,
                });

        let collab =
            info.collaboration
                .unwrap_or(crate::services::dag_service::DagCollaborationInfo {
                    dag_id: String::new(),
                    policy: "N/A".to_string(),
                    participants: Vec::new(),
                    participant_count: 0,
                    created_at: String::new(),
                });

        let status = if info.is_complete == Some(true) {
            "completed"
        } else {
            "running"
        };

        let result = serde_json::json!({
            "status": status,
            "progress": {
                "completed": detail.completed,
                "running": detail.running,
                "failed": detail.failed,
                "pending": detail.pending,
                "total": detail.total,
                "percent": detail.percent,
            },
            "is_complete": info.is_complete.unwrap_or(false),
            "graph_snapshot": info.graph_snapshot,
            "collaboration": {
                "dag_id": collab.dag_id,
                "policy": collab.policy,
                "participants": collab.participants,
                "participant_count": collab.participant_count,
            }
        });
        Ok(CallToolResult::success(vec![
            rmcp::model::ContentBlock::text(
                serde_json::to_string_pretty(&result).unwrap_or_default(),
            ),
        ]))
    }
}

impl ServerHandler for ErgataiAcpMcpService {
    fn get_info(&self) -> ServerInfo {
        ServerInfo::new(ServerCapabilities::builder().enable_tools().build())
            .with_server_info(rmcp::model::Implementation::new("ergatai-acp-mcp", "0.1.0"))
            .with_protocol_version(rmcp::model::ProtocolVersion::V_2024_11_05)
            .with_instructions("Ergatai MCP tools for ACP agents")
    }

    async fn list_tools(
        &self,
        _request: Option<rmcp::model::PaginatedRequestParams>,
        _context: rmcp::service::RequestContext<rmcp::RoleServer>,
    ) -> Result<rmcp::model::ListToolsResult, ErrorData> {
        Ok(rmcp::model::ListToolsResult::with_all_items(
            Self::build_tools(),
        ))
    }

    async fn call_tool(
        &self,
        request: rmcp::model::CallToolRequestParams,
        _context: rmcp::service::RequestContext<rmcp::RoleServer>,
    ) -> Result<CallToolResult, ErrorData> {
        let tool_name = request.name.clone();
        let args = request.arguments.unwrap_or_default();
        let args_value = serde_json::Value::Object(args);

        match tool_name.as_ref() {
            "list_agents" => {
                let params: ListAgentsParams = serde_json::from_value(args_value).map_err(|e| {
                    ErrorData::invalid_params(
                        format!("Invalid list_agents parameters: {}", e),
                        None,
                    )
                })?;
                self.handle_list_agents(params).await
            }
            "send_message" => {
                let params: SendMessageParams =
                    serde_json::from_value(args_value).map_err(|e| {
                        ErrorData::invalid_params(
                            format!("Invalid send_message parameters: {}", e),
                            None,
                        )
                    })?;
                self.handle_send_message(params).await
            }
            "submit_orchestration" => {
                let params: SubmitOrchestrationParams = serde_json::from_value(args_value)
                    .map_err(|e| {
                        ErrorData::invalid_params(
                            format!("Invalid submit_orchestration parameters: {}", e),
                            None,
                        )
                    })?;
                self.handle_submit_orchestration(params).await
            }
            "validate_dag_yaml" => {
                let params: ValidateDagParams =
                    serde_json::from_value(args_value).map_err(|e| {
                        ErrorData::invalid_params(
                            format!("Invalid validate_dag_yaml parameters: {}", e),
                            None,
                        )
                    })?;
                self.handle_validate_dag_yaml(params).await
            }
            "get_dag_status" => {
                let params: GetDagStatusParams =
                    serde_json::from_value(args_value).map_err(|e| {
                        ErrorData::invalid_params(
                            format!("Invalid get_dag_status parameters: {}", e),
                            None,
                        )
                    })?;
                self.handle_get_dag_status(params).await
            }
            _ => Err(ErrorData::invalid_request(
                format!("Unknown tool: {}", tool_name),
                None,
            )),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_build_tools_returns_all_tools() {
        let tools = ErgataiAcpMcpService::build_tools();
        assert_eq!(tools.len(), 5, "Should have 5 tools");

        let tool_names: Vec<&str> = tools.iter().map(|t| t.name.as_ref()).collect();
        assert!(tool_names.contains(&"list_agents"));
        assert!(tool_names.contains(&"send_message"));
        assert!(tool_names.contains(&"submit_orchestration"));
        assert!(tool_names.contains(&"validate_dag_yaml"));
        assert!(tool_names.contains(&"get_dag_status"));
    }
}
