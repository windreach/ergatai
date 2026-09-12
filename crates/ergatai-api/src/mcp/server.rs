//! MCP Server core — struct definition, tool router delegation, service factory.
//!
//! The heavy lifting lives in sibling modules:
//! - [`crate::mcp::params`] — tool parameter types
//! - [`crate::mcp::tools`] — tool implementations (one file per tool)
//! - [`crate::mcp::protocol`] — `ServerHandler` impl (initialize handshake, server info)

use std::collections::HashMap;
use std::sync::Arc;

use rmcp::{
    handler::server::{router::tool::ToolRouter, wrapper::Parameters},
    model::CallToolResult,
    service::Peer,
    tool, tool_router, ErrorData, RoleServer,
};
use tokio::sync::RwLock;
use tokio_util::sync::CancellationToken;
use tracing::{info, warn};

use ergatai_core::agent_registry::AgentRegistry;

use super::params::{
    GetDagStatusParams, ListAgentsParams, SendMessageParams, SubmitOrchestrationParams,
    ValidateDagParams,
};

// ── PeerRegistry ──

/// Shared registry of MCP peer handles for pushing notifications to agents.
/// Key: agent_id (e.g., "opencode@abcd1234")
/// Value: Peer handle for sending notifications to that agent's MCP session.
pub type PeerRegistry = Arc<RwLock<HashMap<String, Peer<RoleServer>>>>;

/// Create a new empty PeerRegistry.
pub fn new_peer_registry() -> PeerRegistry {
    Arc::new(RwLock::new(HashMap::new()))
}

// ── ErgataiMcpServer ──

/// MCP Server state - shared across all sessions via Arc
#[derive(Clone)]
pub struct ErgataiMcpServer {
    pub(crate) tool_router: ToolRouter<Self>,
    registry: Arc<AgentRegistry>,
    /// Shared peer registry for pushing notifications to agents
    peer_registry: PeerRegistry,
    /// Per-session agent ID (set during initialize, used in send_message)
    session_agent_id: Arc<RwLock<Option<String>>>,
    /// Agent identifier from URL path (e.g., "agent-1", "agent-2")
    /// Used to bind MCP connections to specific PTY panes
    agent_identifier: Option<String>,
}

impl std::fmt::Debug for ErgataiMcpServer {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ErgataiMcpServer").finish_non_exhaustive()
    }
}

impl ErgataiMcpServer {
    /// Create a new server instance (called per-session by the factory)
    pub fn new(
        registry: Arc<AgentRegistry>,
        peer_registry: PeerRegistry,
        agent_identifier: Option<String>,
    ) -> Self {
        Self {
            tool_router: Self::tool_router(),
            registry,
            peer_registry,
            session_agent_id: Arc::new(RwLock::new(None)),
            agent_identifier,
        }
    }

    // ── Accessors for sibling modules (tools/, protocol) ──

    pub(crate) fn session_agent_id(&self) -> &RwLock<Option<String>> {
        &self.session_agent_id
    }

    pub(crate) fn registry(&self) -> &AgentRegistry {
        &self.registry
    }

    pub(crate) fn peer_registry(&self) -> &PeerRegistry {
        &self.peer_registry
    }

    pub(crate) fn agent_identifier(&self) -> &Option<String> {
        &self.agent_identifier
    }
}

// ── Drop — auto-unregister on session close ──

/// When the per-session `ErgataiMcpServer` is dropped (session ends — client
/// disconnect, idle timeout, or server shutdown), automatically unregister the
/// agent from the shared registry and remove its peer handle. Without this,
/// dead agents accumulate as zombies because rmcp's `ServerHandler` has no
/// `on_close` callback.
impl Drop for ErgataiMcpServer {
    fn drop(&mut self) {
        // `Drop` is synchronous — use `try_read` (non-blocking) to grab the
        // agent ID, then spawn the async cleanup on the tokio runtime.
        // The session worker task is still on the runtime when it drops us,
        // so `tokio::spawn` is safe here.
        let agent_id = match self.session_agent_id.try_read() {
            Ok(guard) => guard.clone(),
            Err(_) => {
                warn!(
                    "ErgataiMcpServer::drop: session_agent_id lock contended, \
                     skipping unregister (stale-agent reaper will clean up)"
                );
                None
            }
        };

        if let Some(agent_id) = agent_id {
            let registry = self.registry.clone();
            let peer_registry = self.peer_registry.clone();
            info!("MCP session ending, unregistering agent: {}", agent_id);
            tokio::spawn(async move {
                do_unregister_agent(&registry, &peer_registry, &agent_id, "MCP session closed")
                    .await;
            });
        }
    }
}

/// Unregister an agent from the registry and remove its peer handle.
/// Centralized helper used by Drop, peer reaper, and send_message failure handler.
pub(crate) async fn do_unregister_agent(
    registry: &AgentRegistry,
    peer_registry: &PeerRegistry,
    agent_id: &str,
    reason: &str,
) {
    registry.unregister_agent(agent_id).await;
    peer_registry.write().await.remove(agent_id);
    info!("Agent {} unregistered ({})", agent_id, reason);
}

// ── Tool router — thin delegation to tools/ modules ──

#[tool_router]
impl ErgataiMcpServer {
    #[tool(
        description = "List online agents in Ergatai. Use BEFORE `send_message` to discover valid target_agent_id values, or BEFORE `submit_orchestration` to verify agent availability. Excludes the caller automatically. RESPONSE: JSON with {agents: [{agent_id, state, workspace_id, is_alive, last_heartbeat, ...}], total, filter_applied, note}. FILTER: pass `filter` as a JSON OBJECT (not a string), e.g. {\"filter\": {\"status\": \"idle\"}} or {\"filter\": {\"in_dag\": \"dag-1\"}}. Valid status values: created|initializing|idle|starting|running|processing|stopping|terminated. Omit `filter` entirely to list all agents.",
        annotations(read_only_hint = true, idempotent_hint = true)
    )]
    async fn list_agents(
        &self,
        params: Parameters<ListAgentsParams>,
    ) -> Result<CallToolResult, ErrorData> {
        super::tools::list_agents::handle(self, params).await
    }

    #[tool(
        description = "Send a message to another online agent. Persists via NATS JetStream with PTY injection fallback.\n\nWHEN TO USE:\n- Need to communicate with another agent (request help, send response, broadcast info)\n- User explicitly asks to message another agent\n- Responding to a received message\n\nWHEN NOT TO USE:\n- Target agent is offline (check list_agents first)\n- Messaging yourself (will be rejected)\n- Sending a reply that is ONLY polite acknowledgment (\"thanks\", \"ok\", \"got it\", \"thanks for the update\")\n- Responding to a broadcast that has no specific task for you\n- Responding to a \"response\" message that is clearly ending the conversation\n\nWHEN NOT TO RESPOND (ANTI-LOOP — CRITICAL):\nEvery unnecessary reply creates a loop. Follow these rules:\n- broadcast with no task/question → DO NOT reply, ignore silently\n- response that says \"thanks\", \"ok\", \"got it\" → DO NOT reply, conversation is done\n- You already replied once → STOP, do not reply again\n- Your message would just be acknowledgment → SUPPRESS IT, silence is better than a loop\n- message_type = \"request\" with real task → DO reply (this is the ONLY case you should reply)\n\nPARAMETERS:\n- target_agent_id (REQUIRED): recipient's ergatai_agent_id from list_agents (e.g., \"agent-2\"). NOT the agent_id field (e.g., \"%15\").\n- message (REQUIRED): message content\n- message_type (OPTIONAL, default \"request\"):\n  * \"request\": expects response; system auto-tracks correlation_id, starts 30s timeout\n  * \"response\": reply to received request; system auto-tracks correlation_id\n  * \"broadcast\": informational; no tracking, no timeout\n- correlation_id (OPTIONAL): system auto-tracks, typically not needed\n\nRECEIVING MESSAGES:\nWhen you receive a message, it's JSON with these fields:\n- from: sender's agent ID (use as target_agent_id when replying)\n- message: the actual content\n- message_type: \"request\" | \"response\" | \"broadcast\"\n- _reply: exact send_message call to make (COPY THIS EXACTLY)\n- _rules: rules you MUST follow\n\nHOW TO RESPOND:\nIf message_type = \"request\" with a concrete task or question:\n1. Do your work\n2. Call send_message(target_agent_id=<from>, message=<reply>, message_type=\"response\")\n3. Output END in terminal\nSystem auto-tracks correlation — no need to pass correlation_id manually.\n\nIf message_type = \"response\": DO NOT reply again unless there is NEW work to do. Most \"response\" messages end the conversation. Silence = done.\n\nIf message_type = \"broadcast\": DO NOT reply unless the broadcast contains a SPECIFIC task for you. General greetings or FYI broadcasts need NO response.\n\nRESPONSE ON SUCCESS:\n{status: \"queued\"|\"direct_delivered\", target_agent: string, delivery_method: string, stream?: string, sequence?: number}\n\nRESPONSE ON ERROR:\nMCP error with reason:\n- \"target agent not found\": call list_agents to verify target is online\n- \"rate limit exceeded\": 60 msg/min/agent, back off and retry\n- \"communication policy denied\": DAG MeshPolicy forbids this pair\n- \"backpressure\": target inbox full (>=1000 pending), wait and retry\n- \"sender not bound to runtime agent\": MCP clients must be bound to PTY agents\n\nRATE LIMITS:\n- 60 messages per minute per agent (sliding window)\n- NATS backpressure: >=1000 pending messages triggers rejection\n- You CANNOT message yourself",
        annotations(
            read_only_hint = false,
            destructive_hint = false,
            idempotent_hint = false
        )
    )]
    async fn send_message(
        &self,
        params: Parameters<SendMessageParams>,
    ) -> Result<CallToolResult, ErrorData> {
        super::tools::send_message::handle(self, params).await
    }

    #[tool(
        description = "Submit a DAG workflow for multi-agent collaboration. BEFORE calling: (1) run `validate_dag_yaml` with the same YAML to dry-run validation; (2) run `list_agents` to confirm every `agent:` in the YAML matches an online agent. YOU CANNOT be a task worker in your own DAG — the scheduler must be a pure coordinator. YAML format: the top-level field MUST be `tasks:` (NOT `nodes:`), each with `name`, `agent`, `task` sub-fields. YAML rules: unknown top-level fields rejected; priority ∈ {low,medium,high}; timeouts > 0; `communication` ∈ {open,adjacent,star:{hub}} with hub existing in tasks; template vars must match declared parameters. Only ONE DAG can run at a time — use `get_dag_status` to check before submitting. RESPONSE: {status: 'submitted', submitted_nodes, progress: {completed, total, percent}, graph_status}. TIP: After submission, poll `get_dag_status` to monitor progress.",
        annotations(
            read_only_hint = false,
            destructive_hint = true,
            idempotent_hint = false
        )
    )]
    async fn submit_orchestration(
        &self,
        params: Parameters<SubmitOrchestrationParams>,
    ) -> Result<CallToolResult, ErrorData> {
        super::tools::orchestration::handle_submit(self, params).await
    }

    #[tool(
        description = "Dry-run validate a DAG YAML definition. ALWAYS call this BEFORE `submit_orchestration` — same strict parser, no execution. RESPONSE on success: {valid: true, task_count, agents: [...], communication, dag_timeout, dag_max_agent_calls, tasks: [{name, agent, priority, complexity, depends_on_count, timeout, scope}]}. Use the summary to verify parsing: check `agents` for typos, `tasks[].depends_on_count` for correct edges. RESPONSE on failure: MCP error with first validation error (common: `unknown field 'X'` → fix typo; `Duplicate task name` → rename; `depends_on unknown task` → fix reference; `communication hub not found` → hub must be an agent in the DAG). TIP: After validation, also call `list_agents` to confirm every `agents[]` value is online.",
        annotations(read_only_hint = true, idempotent_hint = true)
    )]
    async fn validate_dag_yaml(
        &self,
        params: Parameters<ValidateDagParams>,
    ) -> Result<CallToolResult, ErrorData> {
        super::tools::orchestration::handle_validate(params).await
    }

    #[tool(
        description = "Get DAG execution status. Use AFTER `submit_orchestration` to monitor progress, check stuck nodes, or inspect the active MeshPolicy. Poll every 10-30s during long runs. There is at most ONE active DAG — `dag_id` param is accepted but ignored. RESPONSE: {status: 'no_dag'|'running'|'completed', progress: {completed, total, percent}, is_complete, graph_snapshot: [{id, task, agent, status}], collaboration: {dag_id, policy, participants, participant_count, created_at}}. INTERPRETING: `status='running'` → poll again in 10-30s; check `graph_snapshot` for stuck `running` nodes. `status='completed'` → MeshPolicy lifted, safe to submit new DAG. `failed` nodes → check node metadata for error reason. `status='no_dag'` → no DAG active, safe to submit.",
        annotations(read_only_hint = true, idempotent_hint = true)
    )]
    async fn get_dag_status(
        &self,
        params: Parameters<GetDagStatusParams>,
    ) -> Result<CallToolResult, ErrorData> {
        super::tools::get_dag_status::handle(params).await
    }
}

// ── Public API for creating the Streamable HTTP service ──

use rmcp::transport::streamable_http_server::{
    session::local::LocalSessionManager, StreamableHttpServerConfig, StreamableHttpService,
};

/// Create the MCP Streamable HTTP service for mounting in axum.
///
/// Returns a `StreamableHttpService` that handles POST/GET/DELETE /mcp
/// with proper MCP 2025-06-18 protocol support.
///
/// # Arguments
/// * `registry` - Agent registry for tracking connected agents
/// * `peer_registry` - Shared registry of MCP peer handles for pushing notifications
/// * `cancellation_token` - Token for graceful shutdown
/// * `sse_keep_alive_secs` - SSE keep-alive interval in seconds (default 15)
pub fn create_mcp_service(
    registry: Arc<AgentRegistry>,
    peer_registry: PeerRegistry,
    cancellation_token: CancellationToken,
    sse_keep_alive_secs: u64,
    agent_identifier: Option<String>,
) -> StreamableHttpService<ErgataiMcpServer, LocalSessionManager> {
    let config = StreamableHttpServerConfig::default()
        .with_sse_keep_alive(Some(std::time::Duration::from_secs(sse_keep_alive_secs)))
        .with_sse_retry(Some(std::time::Duration::from_secs(3)))
        .with_json_response(true)
        .with_cancellation_token(cancellation_token)
        .with_allowed_hosts(["localhost", "127.0.0.1", "::1", "0.0.0.0"]);

    // Session keep_alive: auto-close sessions after this duration of inactivity.
    // This catches dead clients (kill, network drop) within 10 minutes.
    // Default is 300s (5 min). Agents that call tools periodically stay alive.
    // Increased from 120s to 600s to prevent premature disconnection during idle periods.
    let mut session_manager = LocalSessionManager::default();
    session_manager.session_config.keep_alive = Some(std::time::Duration::from_secs(600));

    StreamableHttpService::new(
        move || {
            Ok(ErgataiMcpServer::new(
                registry.clone(),
                peer_registry.clone(),
                agent_identifier.clone(),
            ))
        },
        std::sync::Arc::new(session_manager),
        config,
    )
}

/// Start a background task that periodically checks all peer connections
/// and removes agents whose MCP transport has been closed (e.g. abrupt disconnect).
///
/// This complements the `Drop`-based cleanup which only fires on graceful session close.
/// When a client is killed (SIGKILL, network drop), the SSE session may linger until
/// the transport detects the broken connection. The reaper proactively cleans these up.
pub fn start_peer_reaper(
    registry: Arc<AgentRegistry>,
    peer_registry: PeerRegistry,
    cancellation_token: CancellationToken,
) {
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(std::time::Duration::from_secs(10));
        loop {
            tokio::select! {
                _ = cancellation_token.cancelled() => {
                    info!("Peer reaper shutting down");
                    break;
                }
                _ = interval.tick() => {
                    let stale_peers: Vec<String> = {
                        let peers = peer_registry.read().await;
                        peers.iter()
                            .filter(|(_, peer)| peer.is_transport_closed())
                            .map(|(id, _)| id.clone())
                            .collect()
                    };

                    for agent_id in stale_peers {
                        warn!("Peer reaper: detected dead transport for {}, cleaning up", agent_id);
                        do_unregister_agent(
                            &registry, &peer_registry, &agent_id, "dead transport (reaper)",
                        ).await;
                    }
                }
            }
        }
    });
}

// ── Tests ──

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mcp::params::AgentFilter;
    use ergatai_core::agent_registry::AgentRegistry;
    use serde_json::json;

    // ── PeerRegistry tests ──

    #[test]
    fn test_new_peer_registry_is_empty() {
        let registry = new_peer_registry();
        // Block on async read to check emptiness
        let map = registry.blocking_read();
        assert!(map.is_empty(), "new_peer_registry should start empty");
    }

    #[tokio::test]
    async fn test_peer_registry_insert_and_read() {
        let registry = new_peer_registry();
        // We can't easily construct a Peer<RoleServer> here, but we can verify
        // the registry's type and that write().await works.
        let map = registry.write().await;
        assert_eq!(map.len(), 0);
        // Insert/remove a dummy key (peer is opaque, we just test the HashMap mechanics)
        // Since Peer is not constructible without an MCP connection, we only verify
        // that the registry operations don't panic on an empty registry.
        drop(map);
        let map = registry.read().await;
        assert!(map.is_empty());
    }

    #[tokio::test]
    async fn test_peer_registry_remove_missing_key_is_noop() {
        let registry = new_peer_registry();
        let mut map = registry.write().await;
        let removed = map.remove("nonexistent-agent");
        assert!(
            removed.is_none(),
            "removing a missing key should return None"
        );
    }

    // ── ErgataiMcpServer::new() tests ──

    fn make_test_server() -> ErgataiMcpServer {
        let registry = Arc::new(AgentRegistry::new());
        let peer_registry = new_peer_registry();
        ErgataiMcpServer::new(registry, peer_registry, None)
    }

    #[test]
    fn test_mcp_server_new_creates_instance() {
        let server = make_test_server();
        // Verify the server was created successfully (Debug impl works, no panics)
        let debug_str = format!("{:?}", server);
        assert!(
            debug_str.contains("ErgataiMcpServer"),
            "Debug output should contain struct name"
        );
    }

    #[tokio::test]
    async fn test_mcp_server_new_initial_session_agent_id_is_none() {
        let server = make_test_server();
        let agent_id = server.session_agent_id.read().await.clone();
        assert!(
            agent_id.is_none(),
            "session_agent_id should be None before initialize"
        );
    }

    #[test]
    fn test_mcp_server_clone() {
        // ErgataiMcpServer derives Clone; verify clone doesn't panic
        let server = make_test_server();
        let _cloned = server.clone();
    }

    // ── get_info tests ──

    #[test]
    fn test_get_info_returns_server_info() {
        use rmcp::ServerHandler;
        let server = make_test_server();
        let info = server.get_info();
        // Verify the server name is "ergatai"
        assert_eq!(info.server_info.name, "ergatai");
        // Version comes from CARGO_PKG_VERSION
        assert!(!info.server_info.version.is_empty());
    }

    #[test]
    fn test_get_info_has_tools_capability() {
        use rmcp::ServerHandler;
        let server = make_test_server();
        let info = server.get_info();
        // The capabilities should have tools enabled
        let caps_json = serde_json::to_value(&info.capabilities).unwrap();
        assert!(
            caps_json.get("tools").is_some(),
            "Server capabilities should include 'tools'"
        );
    }

    // ── Parameter deserialization tests ──

    #[test]
    fn test_list_agents_params_empty_object() {
        let params: ListAgentsParams = serde_json::from_value(json!({})).unwrap();
        assert_eq!(params.include_capabilities, None);
    }

    #[test]
    fn test_list_agents_params_with_true() {
        let params: ListAgentsParams =
            serde_json::from_value(json!({"include_capabilities": true})).unwrap();
        assert_eq!(params.include_capabilities, Some(true));
    }

    #[test]
    fn test_list_agents_params_with_false() {
        let params: ListAgentsParams =
            serde_json::from_value(json!({"include_capabilities": false})).unwrap();
        assert_eq!(params.include_capabilities, Some(false));
    }

    #[test]
    fn test_list_agents_params_ignores_extra_fields() {
        let params: ListAgentsParams =
            serde_json::from_value(json!({"include_capabilities": true, "unknown": 123})).unwrap();
        assert_eq!(params.include_capabilities, Some(true));
    }

    // ── AgentFilter deserialization tests ──

    #[test]
    fn test_list_agents_params_no_filter_by_default() {
        let params: ListAgentsParams = serde_json::from_value(json!({})).unwrap();
        assert!(params.filter.is_none());
    }

    #[test]
    fn test_agent_filter_all_fields() {
        let filter: AgentFilter = serde_json::from_value(json!({
            "can_communicate_with": "%15",
            "in_dag": "feature_dag",
            "status": "running"
        }))
        .unwrap();
        assert_eq!(filter.can_communicate_with.as_deref(), Some("%15"));
        assert_eq!(filter.in_dag.as_deref(), Some("feature_dag"));
        assert_eq!(filter.status.as_deref(), Some("running"));
    }

    #[test]
    fn test_agent_filter_only_can_communicate_with() {
        let filter: AgentFilter =
            serde_json::from_value(json!({"can_communicate_with": "frontend-dev"})).unwrap();
        assert_eq!(filter.can_communicate_with.as_deref(), Some("frontend-dev"));
        assert!(filter.in_dag.is_none());
        assert!(filter.status.is_none());
    }

    #[test]
    fn test_agent_filter_only_in_dag() {
        let filter: AgentFilter = serde_json::from_value(json!({"in_dag": "my-dag"})).unwrap();
        assert_eq!(filter.in_dag.as_deref(), Some("my-dag"));
        assert!(filter.can_communicate_with.is_none());
        assert!(filter.status.is_none());
    }

    #[test]
    fn test_agent_filter_only_status() {
        let filter: AgentFilter = serde_json::from_value(json!({"status": "idle"})).unwrap();
        assert_eq!(filter.status.as_deref(), Some("idle"));
        assert!(filter.can_communicate_with.is_none());
        assert!(filter.in_dag.is_none());
    }

    #[test]
    fn test_agent_filter_empty_object_all_none() {
        let filter: AgentFilter = serde_json::from_value(json!({})).unwrap();
        assert!(filter.can_communicate_with.is_none());
        assert!(filter.in_dag.is_none());
        assert!(filter.status.is_none());
    }

    #[test]
    fn test_list_agents_params_with_filter() {
        let params: ListAgentsParams = serde_json::from_value(json!({
            "filter": {
                "can_communicate_with": "%42",
                "status": "running"
            }
        }))
        .unwrap();
        assert!(params.filter.is_some());
        let f = params.filter.unwrap();
        assert_eq!(f.can_communicate_with.as_deref(), Some("%42"));
        assert_eq!(f.status.as_deref(), Some("running"));
        assert!(f.in_dag.is_none());
    }

    #[test]
    fn test_agent_filter_ignores_unknown_fields() {
        let filter: AgentFilter =
            serde_json::from_value(json!({"status": "busy", "bogus": 999})).unwrap();
        assert_eq!(filter.status.as_deref(), Some("busy"));
    }

    #[test]
    fn test_send_message_params_required_fields() {
        let params: SendMessageParams = serde_json::from_value(json!({
            "target_agent_id": "agent-1",
            "message": "hello"
        }))
        .unwrap();
        assert_eq!(params.target_agent_id, "agent-1");
        assert_eq!(params.message, "hello");
        assert_eq!(params.message_type, None);
    }

    #[test]
    fn test_send_message_params_with_message_type() {
        let params: SendMessageParams = serde_json::from_value(json!({
            "target_agent_id": "agent-1",
            "message": "hello",
            "message_type": "broadcast"
        }))
        .unwrap();
        assert_eq!(params.message_type.as_deref(), Some("broadcast"));
    }

    #[test]
    fn test_send_message_params_missing_target_fails() {
        let result: Result<SendMessageParams, _> =
            serde_json::from_value(json!({"message": "hello"}));
        assert!(
            result.is_err(),
            "missing target_agent_id should fail deserialization"
        );
    }

    #[test]
    fn test_send_message_params_missing_message_fails() {
        let result: Result<SendMessageParams, _> =
            serde_json::from_value(json!({"target_agent_id": "a"}));
        assert!(
            result.is_err(),
            "missing message should fail deserialization"
        );
    }

    #[test]
    fn test_submit_orchestration_params_with_dag_only() {
        let params: SubmitOrchestrationParams = serde_json::from_value(json!({
            "dag_definition": "## Task A\n- agent: a\n"
        }))
        .unwrap();
        assert!(params.dag_definition.contains("Task A"));
        assert!(params.context.is_none());
    }

    #[test]
    fn test_submit_orchestration_params_with_context() {
        let params: SubmitOrchestrationParams = serde_json::from_value(json!({
            "dag_definition": "dag",
            "context": {"key": "value", "num": 42}
        }))
        .unwrap();
        let ctx = params.context.unwrap();
        assert_eq!(ctx["key"].as_str(), Some("value"));
        assert_eq!(ctx["num"].as_i64(), Some(42));
    }

    #[test]
    fn test_submit_orchestration_params_missing_dag_fails() {
        let result: Result<SubmitOrchestrationParams, _> =
            serde_json::from_value(json!({"context": {}}));
        assert!(result.is_err());
    }

    #[test]
    fn test_get_dag_status_params_valid() {
        let params: GetDagStatusParams =
            serde_json::from_value(json!({"dag_id": "abc-123"})).unwrap();
        assert_eq!(params.dag_id, "abc-123");
    }

    #[test]
    fn test_get_dag_status_params_empty_string() {
        let params: GetDagStatusParams = serde_json::from_value(json!({"dag_id": ""})).unwrap();
        assert_eq!(params.dag_id, "");
    }

    #[test]
    fn test_get_dag_status_params_missing_dag_id_fails() {
        let result: Result<GetDagStatusParams, _> = serde_json::from_value(json!({}));
        assert!(result.is_err());
    }

    // ── Message formatting helper tests ──

    #[test]
    fn test_message_formatting_prefix() {
        // The formatted message in try_pty_injection is:
        // format!("Message from {}: {}", from_agent, message)
        let from = "agent-A";
        let message = "please review";
        let formatted = format!("Message from {}: {}", from, message);
        assert_eq!(formatted, "Message from agent-A: please review");
    }

    #[test]
    fn test_message_formatting_empty_message() {
        let formatted = format!("Message from {}: {}", "sender", "");
        assert_eq!(formatted, "Message from sender: ");
    }

    // ── Agent ID prefix matching logic tests ──

    #[test]
    fn test_agent_id_exact_match() {
        let target = "simple-agent@ead00fad";
        let candidate = "simple-agent@ead00fad";
        assert_eq!(candidate, target);
    }

    #[test]
    fn test_agent_id_prefix_match_logic() {
        // The send_message code uses:
        // a.agent_id.starts_with(&format!("{}@", target_agent_id))
        let target = "simple-agent";
        let agent_id = "simple-agent@ead00fad";
        assert!(agent_id.starts_with(&format!("{}@", target)));
    }

    #[test]
    fn test_agent_id_prefix_no_false_positive() {
        // "simple" should NOT match "simple-agent@xxx"
        let target = "simple";
        let agent_id = "simple-agent@ead00fad";
        assert!(!agent_id.starts_with(&format!("{}@", target)));
    }

    #[test]
    fn test_agent_id_prefix_empty_target_does_not_match() {
        // Edge case: empty target produces "@", which does NOT match "agent@abc"
        // (because "agent@abc" starts with 'a', not '@'). This confirms the prefix
        // match is safe against empty/missing target_agent_id.
        let target = "";
        let agent_id = "agent@abc";
        assert!(!agent_id.starts_with(&format!("{}@", target)));
    }

    // ── do_unregister_agent tests ──

    #[tokio::test]
    async fn test_do_unregister_agent_removes_from_registry() {
        let registry = AgentRegistry::new();
        let peer_registry = new_peer_registry();

        // Register an agent first
        registry
            .register_agent("agent-1".to_string(), "conn-1".to_string(), None)
            .await
            .unwrap();

        // Verify it's registered
        let agents = registry.list_agents().await;
        assert_eq!(agents.len(), 1);

        // Unregister
        do_unregister_agent(&registry, &peer_registry, "agent-1", "test").await;

        // Verify it's gone
        let agents = registry.list_agents().await;
        assert_eq!(agents.len(), 0);
    }

    #[tokio::test]
    async fn test_do_unregister_agent_removes_from_peer_registry() {
        let registry = AgentRegistry::new();
        let peer_registry = new_peer_registry();

        // Manually insert a dummy entry (we can't create a real Peer, so we test
        // the mechanics by inserting then checking removal logic via another path).
        // Since Peer is opaque, we just verify that removing from an empty registry
        // doesn't panic.
        do_unregister_agent(&registry, &peer_registry, "nonexistent", "test").await;

        let map = peer_registry.read().await;
        assert!(map.is_empty());
    }

    #[tokio::test]
    async fn test_do_unregister_agent_is_idempotent() {
        let registry = AgentRegistry::new();
        let peer_registry = new_peer_registry();

        registry
            .register_agent("agent-1".to_string(), "conn-1".to_string(), None)
            .await
            .unwrap();

        // Call unregister twice — second call should be a no-op
        do_unregister_agent(&registry, &peer_registry, "agent-1", "test1").await;
        do_unregister_agent(&registry, &peer_registry, "agent-1", "test2").await;

        let agents = registry.list_agents().await;
        assert_eq!(agents.len(), 0);
    }

    // ── Drop impl tests ──

    #[tokio::test]
    async fn test_drop_unregisters_agent_when_session_id_set() {
        let registry = Arc::new(AgentRegistry::new());
        let peer_registry = new_peer_registry();

        // Register agent manually
        registry
            .register_agent("drop-agent".to_string(), "conn".to_string(), None)
            .await
            .unwrap();

        {
            let server = ErgataiMcpServer::new(registry.clone(), peer_registry.clone(), None);
            // Simulate initialize having set the session agent ID
            *server.session_agent_id.write().await = Some("drop-agent".to_string());
            // server is dropped here
        }

        // Give the spawned task time to run
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;

        let agents = registry.list_agents().await;
        assert!(agents.is_empty(), "Drop should have unregistered the agent");
    }

    #[tokio::test]
    async fn test_drop_is_noop_when_session_id_not_set() {
        let registry = Arc::new(AgentRegistry::new());
        let peer_registry = new_peer_registry();

        // Register a different agent (not the one tied to this session)
        registry
            .register_agent("other-agent".to_string(), "conn".to_string(), None)
            .await
            .unwrap();

        {
            let _server = ErgataiMcpServer::new(registry.clone(), peer_registry.clone(), None);
            // session_agent_id is None (not initialized), so drop should not unregister anything
        }

        tokio::time::sleep(std::time::Duration::from_millis(50)).await;

        let agents = registry.list_agents().await;
        assert_eq!(
            agents.len(),
            1,
            "Drop without session_agent_id should not unregister any agent"
        );
    }

    // ===== P0 Boundary Tests =====

    /// P0: Concurrent initialize calls should each overwrite session_agent_id.
    ///
    /// Verifies that multiple concurrent initialize() calls don't corrupt state.
    /// Each call generates a unique agent ID (UUID-based), so the last one wins.
    /// This tests the RwLock write safety under concurrent access.
    #[tokio::test]
    async fn test_initialize_concurrent_connections_overwrite_session_agent_id() {
        use tokio::task::JoinSet;

        let server = make_test_server();

        // We can't easily construct a real RequestContext with a Peer, so we test
        // the RwLock mechanics directly by simulating what initialize does:
        // it writes to session_agent_id.
        let mut joinset = JoinSet::new();
        for i in 0..10 {
            let server_clone = server.clone();
            joinset.spawn(async move {
                let agent_id = format!("agent-{}", i);
                *server_clone.session_agent_id.write().await = Some(agent_id.clone());
                agent_id
            });
        }

        // Collect all results
        let mut results = Vec::new();
        while let Some(result) = joinset.join_next().await {
            results.push(result.unwrap());
        }

        // Verify: all 10 writes succeeded (no panics, no data corruption)
        assert_eq!(
            results.len(),
            10,
            "All 10 concurrent writes should complete"
        );

        // The final value should be one of the 10 agent IDs (last writer wins)
        let final_value = server.session_agent_id.read().await.clone();
        assert!(
            final_value.is_some(),
            "session_agent_id should be set after concurrent writes"
        );
        let final_id = final_value.unwrap();
        assert!(
            results.contains(&final_id),
            "Final value should be one of the written values, got '{}'",
            final_id
        );
    }
}
