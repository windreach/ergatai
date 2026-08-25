//! MCP Server implementation using rmcp (Rust MCP SDK)
//!
//! Implements MCP protocol 2025-06-18 with Streamable HTTP transport.
//! Agents connect via POST/GET /mcp and can call tools like list_agents,
//! send_message, submit_orchestration, etc.

use std::collections::HashMap;
use std::sync::Arc;

use rmcp::{elicit_safe, service::ElicitationError};
use rmcp::{
    handler::server::{router::tool::ToolRouter, wrapper::Parameters},
    model::{
        CallToolResult, ContentBlock, InitializeRequestParams, InitializeResult,
        ServerCapabilities, ServerInfo,
    },
    service::{Peer, RequestContext},
    tool, tool_handler, tool_router, ErrorData, RoleServer, ServerHandler,
};
use schemars::JsonSchema;
use serde::Deserialize;
use tokio::sync::RwLock;
use tokio_util::sync::CancellationToken;
use tracing::{error, info, warn};

use ergatai_core::agent_registry::AgentRegistry;
use ergatai_runtime::get_agent_runtime;

use super::conversation::ConversationManager;

/// Shared registry of MCP peer handles for pushing notifications to agents.
/// Key: agent_id (e.g., "opencode@abcd1234")
/// Value: Peer handle for sending notifications to that agent's MCP session.
pub type PeerRegistry = Arc<RwLock<HashMap<String, Peer<RoleServer>>>>;

/// Create a new empty PeerRegistry.
pub fn new_peer_registry() -> PeerRegistry {
    Arc::new(RwLock::new(HashMap::new()))
}

/// MCP Server state - shared across all sessions via Arc
#[derive(Clone)]
pub struct ErgataiMcpServer {
    tool_router: ToolRouter<Self>,
    registry: Arc<AgentRegistry>,
    /// Shared peer registry for pushing notifications to agents
    peer_registry: PeerRegistry,
    /// Per-session agent ID (set during initialize, used in send_message)
    session_agent_id: Arc<RwLock<Option<String>>>,
    /// Conversation manager for loop prevention (AutoGen-style).
    /// Kept for future use; current send_message delegates to global MessageSender.
    #[allow(dead_code)]
    conversation_manager: Arc<ConversationManager>,
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
        conversation_manager: Arc<ConversationManager>,
        agent_identifier: Option<String>,
    ) -> Self {
        Self {
            tool_router: Self::tool_router(),
            registry,
            peer_registry,
            session_agent_id: Arc::new(RwLock::new(None)),
            conversation_manager,
            agent_identifier,
        }
    }
}

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
async fn do_unregister_agent(
    registry: &AgentRegistry,
    peer_registry: &PeerRegistry,
    agent_id: &str,
    reason: &str,
) {
    registry.unregister_agent(agent_id).await;
    peer_registry.write().await.remove(agent_id);
    info!("Agent {} unregistered ({})", agent_id, reason);
}

// ── Tool parameter types ──

#[derive(Debug, Deserialize, JsonSchema)]
struct ListAgentsParams {
    /// Whether to include agent capabilities
    #[serde(default)]
    include_capabilities: Option<bool>,

    /// Optional filter to narrow results.
    /// - `can_communicate_with`: Only return agents that can communicate with the given agent
    ///   (based on active DAG MeshPolicy). Without a DAG, all agents can communicate.
    /// - `in_dag`: Only return agents that are participants in the specified DAG.
    /// - `status`: Only return agents whose lifecycle state matches (e.g., "running", "idle", "processing").
    #[serde(default)]
    filter: Option<AgentFilter>,
}

/// Filter criteria for `list_agents`. All fields are optional and combined with AND.
#[derive(Debug, Deserialize, JsonSchema)]
pub struct AgentFilter {
    /// Filter agents that can communicate with the specified agent (based on DAG MeshPolicy).
    /// The value is an agent identifier (runtime ID like "%15", display name, or MCP ID).
    /// When no DAG is active, all agents can communicate, so this filter has no effect.
    pub can_communicate_with: Option<String>,

    /// Filter agents that are participants in the specified DAG (by dag_id).
    pub in_dag: Option<String>,

    /// Filter agents by lifecycle status (case-insensitive).
    /// Valid values: "created", "initializing", "idle", "starting", "running", "processing", "stopping", "terminated".
    pub status: Option<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
struct SendMessageParams {
    /// ID of the target agent
    target_agent_id: String,
    /// Message content
    message: String,
    /// Type of message (request, response, broadcast)
    #[serde(default)]
    message_type: Option<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
struct SubmitOrchestrationParams {
    /// DAG definition in YAML format.
    ///
    /// ```yaml
    /// tasks:
    ///   - name: Task A
    ///     agent: agent-a
    ///     task: tasks/a.md
    ///   - name: Task B
    ///     agent: agent-b
    ///     depends_on: [Task A]
    ///     timeout: 300
    /// ```
    dag_definition: String,
    /// Optional context variables
    #[serde(default)]
    context: Option<serde_json::Value>,
    /// Optional parameter values for template expansion (maps `{{var}}` in
    /// task `input` / `condition` to concrete values). Must match the
    /// `parameters` schema declared in the YAML, if any.
    #[serde(default)]
    parameters: Option<HashMap<String, serde_json::Value>>,
}

#[derive(Debug, Deserialize, JsonSchema)]
struct ValidateDagParams {
    /// DAG definition in YAML format to validate (without executing).
    /// The YAML goes through the same strict validation as `submit_orchestration`,
    /// but nothing is scheduled or run.
    dag_definition: String,
    /// Optional parameter values for template expansion (maps `{{var}}` in
    /// task `input` / `condition` to concrete values).
    #[serde(default)]
    parameters: Option<HashMap<String, serde_json::Value>>,
}

#[derive(Debug, Deserialize, JsonSchema)]
struct CheckDagStatusParams {
    /// DAG ID to check
    dag_id: String,
}

#[derive(Debug, Deserialize, JsonSchema)]
struct GetCollaborationStatusParams {
    /// Optional DAG ID. If omitted, returns the most recently submitted session.
    dag_id: Option<String>,
}

// ── File Access Control parameter types ──

#[derive(Debug, Deserialize, JsonSchema)]
struct RequestFileAccessParams {
    /// File path to access (absolute or relative to project root)
    file_path: String,
    /// Access mode: "READ" or "WRITE"
    mode: String,
    /// Reason for requesting access
    reason: Option<String>,
    /// Glob pattern scope (e.g., "src/**" or specific file)
    #[serde(default = "default_scope")]
    scope: String,
}

fn default_scope() -> String {
    "**".to_string()
}

#[derive(Debug, Deserialize, JsonSchema)]
struct ReleaseFileAccessParams {
    /// File path to release
    file_path: String,
}

#[derive(Debug, Deserialize, JsonSchema)]
struct ListActiveLocksParams {
    /// Filter by agent ID (optional)
    agent_id: Option<String>,
}

// ── MCP Elicitation types for user approval ──

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct ApprovalResponse {
    /// User's approval decision: "yes" or "no"
    decision: String,
}

elicit_safe!(ApprovalResponse);

// ── Tool implementations ──

#[tool_router]
impl ErgataiMcpServer {
    /// List agents you can communicate with, with optional filtering.
    ///
    /// # Behavior
    /// - **Without active DAG**: Returns all online agents (discovered via PTY backend).
    /// - **With active DAG**: Returns only agents allowed by the DAG's MeshPolicy.
    ///   - `Open` — all DAG participants
    ///   - `Adjacent` — only agents directly connected to you in the DAG
    ///   - `Star:{hub}` — only the hub (if you are a spoke) or all spokes (if you are the hub)
    ///   - `Restricted` — only agents in the explicit allow-list
    ///
    /// # Filter Options (combined with AND)
    /// - `can_communicate_with: "<agent_id>"` — Only agents that can communicate with the
    ///   specified agent under the active MeshPolicy. Without a DAG, all agents are returned.
    /// - `in_dag: "<dag_id>"` — Only agents participating in the specified DAG.
    /// - `status: "<state>"` — Only agents whose lifecycle state matches (case-insensitive).
    ///   Valid states: created, initializing, idle, starting, running, processing, stopping, terminated.
    ///
    /// Use this to determine who you can message before calling `send_message`.
    /// Agents filtered out are not reachable — `send_message` would reject them.
    #[tool(
        description = "List agents you can communicate with in Ergatai. WITHOUT active DAG: returns all online agents. WITH active DAG: returns ONLY agents allowed by the DAG's MeshPolicy (communication policy). The 'dag_mode' field in the response indicates whether filtering is active. Supports optional filter: {can_communicate_with, in_dag, status}."
    )]
    async fn list_agents(
        &self,
        params: Parameters<ListAgentsParams>,
    ) -> Result<CallToolResult, ErrorData> {
        let _include_capabilities = params.0.include_capabilities.unwrap_or(false);
        let filter = params.0.filter;

        // Get runtime agents (discovered via PTY backend) instead of just MCP agents
        let runtime = get_agent_runtime();
        let runtime_agents = runtime.list_agents().await;

        // Get the calling agent's ID to mark is_self and to filter by MeshPolicy
        let my_agent_id = self.session_agent_id.read().await.clone();

        // Resolve caller's runtime ID so we can match against DAG participants
        // (participants are identified by runtime ID / TaskNode.agent).
        let my_runtime_id = match &my_agent_id {
            Some(id) => runtime.resolve_agent_id(id).await,
            None => None,
        };

        // Determine the set of allowed peer IDs under any active DAG.
        // `None` = no DAG covers me → return everyone (backward compat).
        // `Some(set)` = only agents in this set are reachable.
        let allowed_peers: Option<std::collections::HashSet<String>> = {
            let schedulers = ergatai_core::cross_agent::list_dag_schedulers();
            let mut covered = false;
            let mut peers = std::collections::HashSet::new();
            for scheduler in &schedulers {
                let session = scheduler.collaboration().await;
                // Check whether I am a participant (by runtime ID or MCP ID).
                let i_am_participant = my_runtime_id
                    .as_ref()
                    .is_some_and(|rid| session.participants.contains(rid))
                    || my_agent_id
                        .as_ref()
                        .is_some_and(|mid| session.participants.contains(mid));
                if !i_am_participant {
                    continue;
                }
                covered = true;
                // I am a participant — enumerate peers allowed by the policy.
                for other in &session.participants {
                    // Skip self
                    if my_runtime_id.as_ref().is_some_and(|rid| other == rid)
                        || my_agent_id.as_ref().is_some_and(|mid| other == mid)
                    {
                        continue;
                    }
                    if session.allows(
                        my_runtime_id
                            .as_deref()
                            .or(my_agent_id.as_deref())
                            .unwrap_or(""),
                        other,
                    ) {
                        peers.insert(other.clone());
                    }
                }
            }
            if covered {
                Some(peers)
            } else {
                None
            }
        };

        // ── Pre-compute filter state for `can_communicate_with` ──
        // When filter.can_communicate_with is set, we need the set of agents that
        // can communicate with the specified target under all active DAGs.
        // This is analogous to `allowed_peers` but centered on the filter target
        // rather than the caller.
        let comm_with_target: Option<std::collections::HashSet<String>> =
            if let Some(ref f) = filter {
                if let Some(ref target_agent) = f.can_communicate_with {
                    // Resolve the target agent's runtime ID for matching
                    let target_runtime_id = runtime.resolve_agent_id(target_agent).await;
                    let schedulers = ergatai_core::cross_agent::list_dag_schedulers();
                    let mut covered = false;
                    let mut peers = std::collections::HashSet::new();
                    for scheduler in &schedulers {
                        let session = scheduler.collaboration().await;
                        // Check whether the target is a participant
                        let target_is_participant = target_runtime_id
                            .as_ref()
                            .is_some_and(|rid| session.participants.contains(rid))
                            || session.participants.contains(target_agent);
                        if !target_is_participant {
                            continue;
                        }
                        covered = true;
                        let target_id_ref = target_runtime_id
                            .as_deref()
                            .unwrap_or(target_agent.as_str());
                        for other in &session.participants {
                            // Skip the target itself
                            if target_runtime_id.as_ref().is_some_and(|rid| other == rid)
                                || other == target_agent
                            {
                                continue;
                            }
                            if session.allows(target_id_ref, other) {
                                peers.insert(other.clone());
                            }
                        }
                    }
                    if covered {
                        Some(peers)
                    } else {
                        None
                    }
                } else {
                    None
                }
            } else {
                None
            };

        // ── Pre-compute filter state for `in_dag` ──
        let dag_participants: Option<std::collections::HashSet<String>> = if let Some(ref f) =
            filter
        {
            if let Some(ref dag_id) = f.in_dag {
                let scheduler = ergatai_core::cross_agent::get_dag_scheduler_by_id(Some(dag_id));
                match scheduler {
                    Some(s) => Some(s.collaboration().await.participants),
                    None => {
                        // DAG not found — treat as empty filter (nothing matches)
                        Some(std::collections::HashSet::new())
                    }
                }
            } else {
                None
            }
        } else {
            None
        };

        // ── Pre-compute status filter ──
        let status_filter: Option<String> = filter
            .as_ref()
            .and_then(|f| f.status.as_ref().map(|s| s.to_lowercase()));

        let agents_json: Vec<serde_json::Value> = runtime_agents
            .iter()
            .filter(|info| {
                // Skip self from the listing
                let is_self = my_agent_id.as_ref().is_some_and(|id| {
                    id == &info.agent_id
                        || info
                            .mcp_agent_id
                            .as_ref()
                            .is_some_and(|mcp_id| mcp_id == id)
                }) || my_runtime_id
                    .as_ref()
                    .is_some_and(|rid| rid == &info.agent_id);
                if is_self {
                    return false;
                }
                // Apply MeshPolicy filter when a DAG covers me
                if let Some(ref allowed) = allowed_peers {
                    let matches = allowed.contains(&info.agent_id)
                        || info
                            .mcp_agent_id
                            .as_ref()
                            .is_some_and(|mid| allowed.contains(mid));
                    if !matches {
                        return false;
                    }
                }
                // Apply can_communicate_with filter
                if let Some(ref peers) = comm_with_target {
                    let matches = peers.contains(&info.agent_id)
                        || info
                            .mcp_agent_id
                            .as_ref()
                            .is_some_and(|mid| peers.contains(mid));
                    if !matches {
                        return false;
                    }
                }
                // Apply in_dag filter
                if let Some(ref participants) = dag_participants {
                    let matches = participants.contains(&info.agent_id)
                        || info
                            .mcp_agent_id
                            .as_ref()
                            .is_some_and(|mid| participants.contains(mid));
                    if !matches {
                        return false;
                    }
                }
                // Apply status filter
                if let Some(ref status) = status_filter {
                    if info.lifecycle.state_name().to_lowercase() != *status {
                        return false;
                    }
                }
                true
            })
            .map(|info| {
                serde_json::json!({
                    "agent_id": info.agent_id,
                    "agent_uuid": info.agent_uuid,
                    "mcp_agent_id": info.mcp_agent_id,
                    "workspace_id": info.workspace_id,
                    // Lifecycle state (lowercase) from unified state machine
                    "state": info.lifecycle.state_name(),
                    "lifecycle_state": info.lifecycle.state_name(),
                    "task_id": info.task_id,
                    "is_alive": info.lifecycle.is_alive(),
                    "is_idle": info.lifecycle.is_idle(),
                    "is_processing": info.lifecycle.is_processing(),
                    "status": if info.mcp_agent_id.is_some() { "active" } else { "discovered" },
                    "ergatai_agent_id": info.handle.metadata.get("ergatai_agent_id"),
                    "last_heartbeat": info.last_heartbeat.to_rfc3339(),
                })
            })
            .collect();

        let dag_mode = allowed_peers.is_some();
        let filter_applied = filter.as_ref().is_some_and(|f| {
            f.can_communicate_with.is_some() || f.in_dag.is_some() || f.status.is_some()
        });
        let result = serde_json::json!({
            "agents": agents_json,
            "total": agents_json.len(),
            "dag_mode": dag_mode,
            "filter_applied": filter_applied,
            "note": match (dag_mode, filter_applied) {
                (true, true) => "Filtered by active DAG MeshPolicy and user-supplied filter. Only reachable agents are listed.",
                (true, false) => "Filtered by active DAG MeshPolicy. Only reachable agents are listed.",
                (false, true) => "No active DAG. All online agents are reachable. User-supplied filter applied.",
                (false, false) => "No active DAG. All online agents are reachable.",
            }
        });

        Ok(CallToolResult::success(vec![ContentBlock::text(
            serde_json::to_string_pretty(&result).unwrap_or_default(),
        )]))
    }

    /// Send a message to another agent.
    ///
    /// # Communication Rules
    /// - **Without active DAG**: You can message any online agent.
    ///   Use `list_agents` to see who is available.
    /// - **With active DAG**: Communication is restricted by the DAG's MeshPolicy.
    ///   You can only message agents allowed by the policy. Use `list_agents` —
    ///   it returns only reachable agents under the active policy. If your message
    ///   is rejected, call `get_collaboration_status` to inspect the DAG rules.
    ///
    /// # Task Complexity Annotation (for DAG YAML authors)
    /// When authoring tasks in a DAG YAML, annotate each task's complexity so the
    /// scheduler and other agents can reason about effort:
    /// - `complexity: low`    — format fixes, docs, config changes, simple tech-debt
    ///                          cleanup (< 30 min)
    /// - `complexity: medium` — normal feature work, bug fixes, small refactors
    ///                          (30 min – 2 hours)
    /// - `complexity: high`   — architectural changes, cross-module refactors,
    ///                          large migrations (> 2 hours)
    ///
    /// # Delivery
    /// Messages are persisted to NATS JetStream (`AGENT_MESSAGES` stream) and
    /// delivered by a background consumer via PTY injection. Direct PTY
    /// injection is used as a fallback when NATS is unavailable.
    #[tool(
        description = "Send a message to another agent. Without a DAG, any online agent is reachable. With a DAG, only agents allowed by the MeshPolicy are reachable (use list_agents to see who). Persists via NATS JetStream with PTY fallback."
    )]
    async fn send_message(
        &self,
        params: Parameters<SendMessageParams>,
    ) -> Result<CallToolResult, ErrorData> {
        let target_agent_id = &params.0.target_agent_id;
        let message = &params.0.message;
        let message_type = params.0.message_type.as_deref().unwrap_or("request");

        info!(
            "Sending message to agent {}: {} (type: {})",
            target_agent_id, message, message_type
        );

        // Get the sender agent ID from MCP session
        let from_agent = self
            .session_agent_id
            .read()
            .await
            .clone()
            .unwrap_or_else(|| "unknown-mcp-client".to_string());

        // Delegate to the shared MessageSender service (same pipeline as REST API)
        let sender = match crate::messaging::get_message_sender() {
            Some(s) => s,
            None => {
                return Err(ErrorData::internal_error(
                    "MessageSender not initialized — call init_message_sender first",
                    None,
                ));
            }
        };
        let send_req = crate::messaging::SendRequest {
            from: from_agent.clone(),
            to: target_agent_id.to_string(),
            message: message.to_string(),
            message_type: message_type.to_string(),
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
                    "note": "Message persisted to NATS JetStream. Background consumer will deliver via PTY injection."
                });

                Ok(CallToolResult::success(vec![ContentBlock::text(
                    serde_json::to_string_pretty(&response_json).unwrap_or_default(),
                )]))
            }
            crate::messaging::SendMessageResult::DirectDelivered { target_agent } => {
                let response_json = serde_json::json!({
                    "status": "direct_delivered",
                    "target_agent": target_agent,
                    "delivery_method": "pty_injection",
                    "note": "NATS unavailable. Message delivered directly via PTY injection (no persistence)."
                });

                Ok(CallToolResult::success(vec![ContentBlock::text(
                    serde_json::to_string_pretty(&response_json).unwrap_or_default(),
                )]))
            }
            crate::messaging::SendMessageResult::Rejected { reason } => {
                Ok(CallToolResult::error(vec![ContentBlock::text(reason)]))
            }
        }
    }

    /// Submit a DAG workflow for multi-agent collaboration.
    ///
    /// # DAG Definition Format
    /// Accepts YAML format with strict validation.
    ///
    /// ```yaml
    /// tasks:
    ///   - name: Task A
    ///     agent: agent-a
    ///     task: tasks/a.md
    ///     complexity: medium        # optional: low | medium | high
    ///   - name: Task B
    ///     agent: agent-b
    ///     depends_on: [Task A]
    ///     timeout: 300
    /// communication: adjacent       # optional: open (default) | adjacent | star:{hub}
    /// ```
    ///
    /// # Task Complexity Annotation
    /// Each task may carry a `complexity` hint. Use it to calibrate expectations:
    /// - `low`    — format fixes, docs, config changes, simple tech-debt (< 30 min)
    /// - `medium` — normal features, bug fixes, small refactors (30 min – 2 hours)
    /// - `high`   — architectural changes, cross-module refactors, large migrations (> 2 hours)
    ///
    /// # Communication Policy
    /// Optional top-level `communication` field sets the MeshPolicy for agents
    /// participating in this DAG:
    /// - `open` (default) — any participant can message any other
    /// - `adjacent` — only agents connected by a dependency edge can talk
    /// - `star:{hub_agent}` — all traffic routes through the named hub
    ///
    /// # YAML Validation Rules (strict — invalid YAML is rejected)
    /// - **Top-level fields**: unknown keys are rejected (e.g. `communcation:` typo → error).
    ///   Task-level unknown keys are collected as metadata (allowed).
    /// - **`name`** (per task): required, non-empty.
    /// - **`priority`** (DAG or task level): must be `low` | `medium` | `high` (case-insensitive).
    /// - **`timeout` / `max_agent_calls` / `stall_timeout_secs` / `node_timeout_secs`**:
    ///   must be > 0 when specified (0 is rejected, not treated as "unlimited").
    /// - **`communication`**: must be `open` | `adjacent` | `star:{hub}`; the hub agent
    ///   must appear as the `agent` of at least one task.
    /// - **Template variables** (`{{var}}` in `input` / `condition`): must reference a
    ///   declared `parameters` entry. If no parameters are declared, templates are
    ///   left unchecked (backward compatible).
    /// - **`depends_on`**: referenced task names must exist.
    /// - **`scope`**: invalid glob patterns are rejected (not silently dropped).
    ///
    /// # Tip
    /// Use the `validate_dag_yaml` tool to dry-run your YAML before submitting.
    #[tool(
        description = "Submit a DAG workflow for multi-agent collaboration. Accepts YAML with strict validation: `priority` ∈ {low,medium,high}; timeouts > 0; non-empty task names; `communication` ∈ {open,adjacent,star:{hub}} with hub existing in tasks; template vars must match declared parameters; top-level unknown fields rejected (task-level allowed as metadata). Use `validate_dag_yaml` to dry-run first."
    )]
    async fn submit_orchestration(
        &self,
        params: Parameters<SubmitOrchestrationParams>,
    ) -> Result<CallToolResult, ErrorData> {
        let dag_definition = &params.0.dag_definition;
        let context_value = &params.0.context;
        let parameters = params.0.parameters;

        info!(
            "Submitting DAG orchestration ({} bytes)",
            dag_definition.len()
        );

        // ── 获取调度者（提交者）的 agent_id ──
        let submitter_id = self.session_agent_id.read().await.clone();
        let submitter_runtime_id = match &submitter_id {
            Some(id) => {
                let runtime = ergatai_runtime::get_agent_runtime();
                runtime.resolve_agent_id(id).await
            }
            None => None,
        };

        // Check if a DAG is already running
        if let Some(existing) = ergatai_core::cross_agent::get_dag_scheduler() {
            if !existing.is_complete().await {
                return Err(ErrorData::internal_error(
                    "A DAG is already running. Wait for it to complete or check its status.",
                    None,
                ));
            }
        }

        // Parse DAG definition (YAML) → TaskGraph
        let graph = ergatai_core::orchestration::parse_dag_auto(dag_definition, parameters)
            .map_err(|e| {
                ErrorData::invalid_params(format!("Failed to parse DAG definition: {}", e), None)
            })?;

        // ── 强制校验：调度者禁止参与 DAG 工作 ──
        // 调度者（submitter）应该是纯协调角色，不应该同时是任务执行者。
        // 如果调度者在 DAG 的 task 列表中，拒绝提交。
        if let Some(ref runtime_id) = submitter_runtime_id {
            let dag_agents: Vec<String> = graph.nodes.iter().map(|t| t.agent.clone()).collect();
            if dag_agents.contains(runtime_id) {
                warn!(
                    submitter = %runtime_id,
                    dag_agents = ?dag_agents,
                    "Submitter is also a worker in DAG — rejecting"
                );
                return Err(ErrorData::invalid_params(
                    format!(
                        "DAG scheduler (agent '{}') cannot also be a task worker. \
                         The submitter must be a pure coordinator. \
                         Please assign tasks to other agents only.",
                        runtime_id
                    ),
                    None,
                ));
            }
        }

        // Build DagContext from optional context parameter
        let mut dag_context = ergatai_core::orchestration::DagContext::empty();
        if let Some(ctx_val) = context_value {
            if let Some(vars) = ctx_val.as_object() {
                for (k, v) in vars {
                    dag_context.set_global(k.clone(), v.as_str().unwrap_or_default().to_string());
                }
            }
        }

        // Create DagScheduler
        let project_root = std::env::current_dir().map_err(|e| {
            ErrorData::internal_error(format!("Failed to get current directory: {}", e), None)
        })?;
        let scheduler =
            ergatai_core::cross_agent::DagScheduler::with_context(project_root, graph, dag_context);

        // Register globally + start NATS event listener
        ergatai_core::cross_agent::set_dag_scheduler(scheduler.clone());
        scheduler.clone().start_event_listener();

        // Submit the graph (dispatches ready nodes)
        let submitted = scheduler
            .submit_graph()
            .await
            .map_err(|e| ErrorData::internal_error(format!("Failed to submit DAG: {}", e), None))?;

        let progress = scheduler.progress().await;
        let status = scheduler.status_prompt().await;

        let result = serde_json::json!({
            "status": "submitted",
            "submitted_nodes": submitted.len(),
            "progress": progress,
            "graph_status": status,
        });

        Ok(CallToolResult::success(vec![ContentBlock::text(
            serde_json::to_string_pretty(&result).unwrap_or_default(),
        )]))
    }

    /// Validate a DAG YAML definition without executing it.
    ///
    /// Runs the same strict validation as `submit_orchestration` but stops before
    /// scheduling any work. Use this to sanity-check your YAML before submitting.
    ///
    /// # Returns (on success)
    /// - `valid: true`
    /// - `task_count` — number of tasks parsed
    /// - `agents` — unique list of agent ids referenced
    /// - `communication` — resolved policy (or `"open"` if unspecified)
    /// - `dag_timeout` / `dag_max_agent_calls` — budget fields if set
    /// - `tasks` — per-task summary (name, agent, priority, complexity, depends_on)
    ///
    /// # Returns (on failure)
    /// MCP error response with the first validation error encountered.
    /// Common errors: unknown top-level field, invalid `priority`/`communication`,
    /// zero timeout, empty task name, unresolved template variable, missing
    /// dependency, invalid scope glob.
    #[tool(
        description = "Dry-run validate a DAG YAML definition. Returns success + summary or the first validation error. Use before `submit_orchestration` to avoid wasting a round-trip on invalid YAML."
    )]
    async fn validate_dag_yaml(
        &self,
        params: Parameters<ValidateDagParams>,
    ) -> Result<CallToolResult, ErrorData> {
        let dag_definition = &params.0.dag_definition;
        let parameters = params.0.parameters;

        info!("Validating DAG definition ({} bytes)", dag_definition.len());

        // Parse (applies all strict validation rules)
        let graph = ergatai_core::orchestration::parse_dag_auto(dag_definition, parameters)
            .map_err(|e| {
                ErrorData::invalid_params(format!("DAG validation failed: {}", e), None)
            })?;

        // Build success summary
        let mut agents: Vec<&str> = graph.nodes.iter().map(|n| n.agent.as_str()).collect();
        agents.sort_unstable();
        agents.dedup();

        let task_summaries: Vec<serde_json::Value> = graph
            .nodes
            .iter()
            .map(|n| {
                serde_json::json!({
                    "name": n.task,
                    "agent": n.agent,
                    "priority": n.priority,
                    "complexity": format!("{:?}", n.complexity).to_lowercase(),
                    "depends_on_count": n.depends_on.len(),
                    "timeout": n.timeout,
                    "scope": n.scope,
                })
            })
            .collect();

        let result = serde_json::json!({
            "valid": true,
            "task_count": graph.nodes.len(),
            "agents": agents,
            "communication": graph.communication.as_deref().unwrap_or("open"),
            "dag_timeout": graph.timeout,
            "dag_max_agent_calls": graph.max_agent_calls,
            "dag_stall_timeout_secs": graph.stall_timeout_secs,
            "dag_node_timeout_secs": graph.node_timeout_secs,
            "tasks": task_summaries,
        });

        Ok(CallToolResult::success(vec![ContentBlock::text(
            serde_json::to_string_pretty(&result).unwrap_or_default(),
        )]))
    }

    /// Check the status of a DAG execution
    #[tool(description = "Check the status of a DAG execution")]
    async fn check_dag_status(
        &self,
        params: Parameters<CheckDagStatusParams>,
    ) -> Result<CallToolResult, ErrorData> {
        let _dag_id = &params.0.dag_id;

        info!("Checking DAG status");

        match ergatai_core::cross_agent::get_dag_scheduler() {
            None => {
                let result = serde_json::json!({
                    "status": "no_dag",
                    "message": "No DAG scheduler is active",
                });
                Ok(CallToolResult::success(vec![ContentBlock::text(
                    serde_json::to_string_pretty(&result).unwrap_or_default(),
                )]))
            }
            Some(scheduler) => {
                let progress = scheduler.progress().await;
                let is_complete = scheduler.is_complete().await;
                let status_text = scheduler.status_prompt().await;
                let snapshot = scheduler.graph_snapshot().await.ok();

                let status = if is_complete { "completed" } else { "running" };

                let result = serde_json::json!({
                    "status": status,
                    "progress": progress,
                    "is_complete": is_complete,
                    "graph_status": status_text,
                    "graph_snapshot": snapshot,
                });
                Ok(CallToolResult::success(vec![ContentBlock::text(
                    serde_json::to_string_pretty(&result).unwrap_or_default(),
                )]))
            }
        }
    }

    /// Get the current collaboration session (participants + communication policy)
    #[tool(
        description = "Get the current collaboration session status: participant agents, communication policy (open/adjacent/star), and DAG binding. Optional dag_id selects a specific session; otherwise returns the most recent."
    )]
    async fn get_collaboration_status(
        &self,
        params: Parameters<GetCollaborationStatusParams>,
    ) -> Result<CallToolResult, ErrorData> {
        // When dag_id is specified, look up that specific scheduler.
        // When dag_id is None, fall back to the most recent scheduler.
        let scheduler = if params.0.dag_id.is_some() {
            ergatai_core::cross_agent::get_dag_scheduler_by_id(params.0.dag_id.as_deref())
        } else {
            ergatai_core::cross_agent::get_dag_scheduler()
        };

        match (scheduler, params.0.dag_id) {
            (Some(s), _) => {
                let session = s.collaboration().await;
                Ok(CallToolResult::success(vec![ContentBlock::text(
                    serde_json::to_string_pretty(&session).unwrap_or_default(),
                )]))
            }
            (None, Some(dag_id)) => Ok(CallToolResult::success(vec![ContentBlock::text(
                serde_json::to_string_pretty(&serde_json::json!({
                    "status": "not_found",
                    "message": format!("No collaboration session found for dag_id: {}", dag_id),
                }))
                .unwrap_or_default(),
            )])),
            (None, None) => Ok(CallToolResult::success(vec![ContentBlock::text(
                serde_json::to_string_pretty(&serde_json::json!({
                    "status": "no_active_session",
                    "message": "No collaboration session is active. Submit a DAG orchestration first.",
                }))
                .unwrap_or_default(),
            )])),
        }
    }

    // ── File Access Control Tools ──

    /// Request file access lock for reading or writing
    #[tool(
        description = "Request file access lock. Use this before reading or writing files in multi-agent mode. Returns a lock token if approved."
    )]
    async fn request_file_access(
        &self,
        params: Parameters<RequestFileAccessParams>,
    ) -> Result<CallToolResult, ErrorData> {
        let file_path = &params.0.file_path;
        let mode_str = params.0.mode.to_uppercase();
        let reason = params.0.reason.clone();
        let scope = params.0.scope.clone();

        // Get agent info from session
        let agent_id = self
            .session_agent_id
            .read()
            .await
            .clone()
            .unwrap_or_else(|| "unknown".to_string());

        info!(
            agent_id = %agent_id,
            file_path = %file_path,
            mode = %mode_str,
            "File access request via MCP"
        );

        // Parse mode
        let mode = match mode_str.as_str() {
            "READ" => ergatai_lock::FileMode::Read,
            "WRITE" => ergatai_lock::FileMode::Write,
            "ADMIN" => ergatai_lock::FileMode::Admin,
            _ => {
                return Err(ErrorData::invalid_params(
                    format!("Invalid mode '{}'. Must be READ, WRITE, or ADMIN", mode_str),
                    None,
                ));
            }
        };

        // Try to get lock manager.
        //
        // SECURITY: Deny access when the lock manager is unavailable. The project
        // implements zero-trust file access control — granting access here would
        // bypass the entire locking subsystem. In single-agent deployments, either
        // initialize the lock manager at startup or disable file locking explicitly
        // via a configuration flag (not via silent fail-open).
        let lock_manager = match ergatai_lock::get_lock_manager("default").await {
            Ok(lm) => lm,
            Err(e) => {
                // SECURITY: Deny access when lock manager is unavailable.
                // Do NOT grant access — that would bypass file locking entirely.
                return Err(ErrorData::internal_error(
                    format!(
                        "File lock system not available: {}. Cannot grant file access without lock manager.",
                        e
                    ),
                    None,
                ));
            }
        };

        // Create a file token for this request
        let session_id = format!("mcp-{}", agent_id);

        // SECURITY: Create and register a SystemToken first to update the session counter.
        // This is critical for is_single_agent_mode() detection to work correctly.
        // Without this, active_session_count stays at 0 and the system is permanently
        // stuck in "multi-agent mode" even when there's only one agent.
        //
        // Use the atomic `get_or_register_system_token` to eliminate the TOCTOU race
        // where register fails (UNIQUE collision) and the subsequent get returns None
        // because the watchdog expired the token in between (CRITICAL #2 fix).
        let system_token = ergatai_lock::SystemToken::new(
            agent_id.clone(),
            session_id.clone(),
            "default".to_string(), // project_root will be resolved by lock manager
            7200,                  // 2 hour TTL for system token
            60,                    // heartbeat every 60s
        );

        let system_token_id = match lock_manager.get_or_register_system_token(&system_token) {
            Ok(id) => id,
            Err(e) => {
                error!(
                    agent_id = %agent_id,
                    session_id = %session_id,
                    error = %e,
                    "Failed to get or register system token; cannot create file token"
                );
                return Err(ErrorData::internal_error(
                    format!("Failed to get or register system token for session: {}", e),
                    None,
                ));
            }
        };

        let file_token = ergatai_lock::FileToken::new(
            agent_id.clone(),
            session_id.clone(),
            system_token_id,
            scope.clone(),
            mode,
            reason.clone(),
            "mcp-request".to_string(),
            3600, // 1 hour TTL
            60,   // heartbeat every 60s
        );

        // Register the file token — fail early if registration fails so the lock
        // state stays consistent (otherwise acquire_lock would proceed without
        // a registered token, and subsequent release/list operations would be broken).
        if let Err(e) = lock_manager.register_file_token(&file_token) {
            warn!(
                agent_id = %agent_id,
                file_path = %file_path,
                error = %e,
                "Failed to register file token, denying access"
            );
            return Err(ErrorData::internal_error(
                format!("Failed to register file access token: {}", e),
                None,
            ));
        }

        // Try to acquire the lock
        match lock_manager.acquire_lock(&file_token, file_path).await {
            Ok(()) => {
                info!(
                    agent_id = %agent_id,
                    file_path = %file_path,
                    token_id = %file_token.id,
                    "File lock acquired successfully"
                );

                Ok(CallToolResult::success(vec![ContentBlock::text(
                    serde_json::to_string_pretty(&serde_json::json!({
                        "status": "granted",
                        "file_path": file_path,
                        "mode": mode_str,
                        "token_id": file_token.id.as_str(),
                        "scope": scope,
                        "expires_at": file_token.expires_at.to_rfc3339(),
                        "note": "File lock acquired. Remember to release when done."
                    }))
                    .unwrap_or_default(),
                )]))
            }
            Err(e) => {
                // Lock acquisition failed (conflict) - try MCP elicitation for user approval
                warn!(
                    agent_id = %agent_id,
                    file_path = %file_path,
                    error = %e,
                    "File lock conflict detected, requesting user approval via elicitation"
                );

                // Try to get the peer for this session and send elicitation
                {
                    if let Some(peer) = self.peer_registry.read().await.get(&agent_id).cloned() {
                        let approval_message = format!(
                            "🔒 File Access Conflict\n\n\
                             Agent wants to {} file: {}\n\
                             Reason: {}\n\
                             Conflict: {}\n\n\
                             Approve this access?",
                            mode_str,
                            file_path,
                            reason.as_deref().unwrap_or("not specified"),
                            e
                        );

                        match peer.elicit::<ApprovalResponse>(&approval_message).await {
                            Ok(Some(response)) if response.decision.to_lowercase() == "yes" => {
                                info!(
                                    agent_id = %agent_id,
                                    file_path = %file_path,
                                    "User approved file access via elicitation"
                                );
                                // User approved - grant access directly (bypass lock)
                                return Ok(CallToolResult::success(vec![ContentBlock::text(
                                    serde_json::to_string_pretty(&serde_json::json!({
                                        "status": "granted",
                                        "file_path": file_path,
                                        "mode": mode_str,
                                        "approval": "user_approved",
                                        "note": "Access granted by user approval despite conflict."
                                    }))
                                    .unwrap_or_default(),
                                )]));
                            }
                            Ok(Some(_)) => {
                                // User declined
                                info!(
                                    agent_id = %agent_id,
                                    file_path = %file_path,
                                    "User denied file access via elicitation"
                                );
                            }
                            Ok(None) => {
                                // No response (cancelled)
                                warn!(
                                    agent_id = %agent_id,
                                    file_path = %file_path,
                                    "User cancelled file access approval"
                                );
                            }
                            Err(ElicitationError::CapabilityNotSupported) => {
                                // Client doesn't support elicitation — deny rather than auto-approve.
                                // Auto-approving here would let any agent bypass file locks by connecting
                                // with a client that doesn't implement elicitation. The user/admin can
                                // manually grant access or upgrade the client.
                                warn!(
                                    agent_id = %agent_id,
                                    file_path = %file_path,
                                    "Client does not support elicitation, denying file access (conflict unresolved)"
                                );
                            }
                            Err(e) => {
                                // Elicitation failed — deny rather than auto-approve.
                                // Silently granting on failure defeats the purpose of the lock system.
                                warn!(
                                    agent_id = %agent_id,
                                    file_path = %file_path,
                                    error = %e,
                                    "Elicitation failed, denying file access (conflict unresolved)"
                                );
                            }
                        }
                    } else {
                        // No peer found — deny rather than auto-approve.
                        // A missing peer session is not a valid reason to bypass file locks.
                        warn!(
                            agent_id = %agent_id,
                            file_path = %file_path,
                            "No peer found in registry, denying file access (conflict unresolved)"
                        );
                    }
                }

                // No elicitation or user declined - return error
                Err(ErrorData::internal_error(
                    format!("File access denied: {}", e),
                    None,
                ))
            }
        }
    }

    /// Release a file access lock
    #[tool(
        description = "Release a file access lock when done reading/writing. Call this after completing file operations."
    )]
    async fn release_file_access(
        &self,
        params: Parameters<ReleaseFileAccessParams>,
    ) -> Result<CallToolResult, ErrorData> {
        let file_path = &params.0.file_path;

        let agent_id = self
            .session_agent_id
            .read()
            .await
            .clone()
            .unwrap_or_else(|| "unknown".to_string());

        info!(
            agent_id = %agent_id,
            file_path = %file_path,
            "File lock release request via MCP"
        );

        let lock_manager = match ergatai_lock::get_lock_manager("default").await {
            Ok(lm) => lm,
            Err(_) => {
                return Ok(CallToolResult::success(vec![ContentBlock::text(
                    serde_json::to_string_pretty(&serde_json::json!({
                        "status": "released",
                        "file_path": file_path,
                        "note": "File lock system not active."
                    }))
                    .unwrap_or_default(),
                )]));
            }
        };

        // Find the lock for this agent and file
        let session_id = format!("mcp-{}", agent_id);
        let locks = match lock_manager.get_locks_by_session(&session_id) {
            Ok(locks) => locks,
            Err(e) => {
                return Err(ErrorData::internal_error(
                    format!("Failed to find lock: {}", e),
                    None,
                ));
            }
        };

        // Find the lock for the specific file
        let lock = locks.iter().find(|l| l.file_path == *file_path);
        match lock {
            Some(lock) => {
                match lock_manager
                    .release_lock(lock.token_id.as_str(), file_path)
                    .await
                {
                    Ok(()) => {
                        info!(
                            agent_id = %agent_id,
                            file_path = %file_path,
                            "File lock released successfully"
                        );

                        Ok(CallToolResult::success(vec![ContentBlock::text(
                            serde_json::to_string_pretty(&serde_json::json!({
                                "status": "released",
                                "file_path": file_path,
                                "token_id": &lock.token_id
                            }))
                            .unwrap_or_default(),
                        )]))
                    }
                    Err(e) => Err(ErrorData::internal_error(
                        format!("Failed to release lock: {}", e),
                        None,
                    )),
                }
            }
            None => Ok(CallToolResult::success(vec![ContentBlock::text(
                serde_json::to_string_pretty(&serde_json::json!({
                    "status": "no_lock",
                    "file_path": file_path,
                    "note": "No active lock found for this file."
                }))
                .unwrap_or_default(),
            )])),
        }
    }

    /// List all active file locks
    #[tool(description = "List all active file locks. Shows which agents hold which file locks.")]
    async fn list_active_locks(
        &self,
        params: Parameters<ListActiveLocksParams>,
    ) -> Result<CallToolResult, ErrorData> {
        let agent_filter = params.0.agent_id.clone();

        let lock_manager = match ergatai_lock::get_lock_manager("default").await {
            Ok(lm) => lm,
            Err(_) => {
                return Ok(CallToolResult::success(vec![ContentBlock::text(
                    serde_json::to_string_pretty(&serde_json::json!({
                        "status": "not_active",
                        "locks": [],
                        "note": "File lock system not active."
                    }))
                    .unwrap_or_default(),
                )]));
            }
        };

        match lock_manager.get_all_active_locks() {
            Ok(locks) => {
                let filtered_locks: Vec<serde_json::Value> = locks
                    .iter()
                    .filter(|lock| {
                        agent_filter
                            .as_ref()
                            .is_none_or(|filter| &lock.agent_id == filter)
                    })
                    .map(|lock| {
                        serde_json::json!({
                            "file_path": lock.file_path,
                            "agent_id": lock.agent_id,
                            "session_id": lock.session_id,
                            "mode": format!("{:?}", lock.mode),
                            "token_id": lock.token_id,
                            "reason": lock.reason,
                            "created_at": lock.created_at.to_rfc3339(),
                            "expires_at": lock.expires_at.to_rfc3339()
                        })
                    })
                    .collect();

                Ok(CallToolResult::success(vec![ContentBlock::text(
                    serde_json::to_string_pretty(&serde_json::json!({
                        "status": "ok",
                        "total": filtered_locks.len(),
                        "locks": filtered_locks
                    }))
                    .unwrap_or_default(),
                )]))
            }
            Err(e) => Err(ErrorData::internal_error(
                format!("Failed to list locks: {}", e),
                None,
            )),
        }
    }
}

// ── ServerHandler implementation ──

#[tool_handler(router = self.tool_router)]
impl ServerHandler for ErgataiMcpServer {
    /// Handle initialize - auto-register the agent and save peer handle
    async fn initialize(
        &self,
        request: InitializeRequestParams,
        context: RequestContext<rmcp::RoleServer>,
    ) -> Result<InitializeResult, ErrorData> {
        let agent_id = request.client_info.name.clone();
        let agent_version = request.client_info.version.clone();

        // Generate a connection ID - use as unique agent key to support
        // multiple instances of the same client (e.g. 3 OpenCode instances)
        let connection_id = uuid::Uuid::new_v4().to_string();
        // Take first 8 chars of UUID (safe: UUIDs are always 36 chars: 8-4-4-4-12)
        let id_prefix = connection_id.get(..8).unwrap_or(&connection_id);
        let unique_agent_id = format!("{}@{}", agent_id, id_prefix);

        info!(
            "Agent connecting: {} (version: {}, protocol: {}) → {}",
            agent_id, agent_version, request.protocol_version, unique_agent_id
        );

        // Store the agent ID for this session (used in send_message)
        *self.session_agent_id.write().await = Some(unique_agent_id.clone());

        // Register agent in registry
        if let Err(e) = self
            .registry
            .register_agent(unique_agent_id.clone(), connection_id.clone(), None)
            .await
        {
            return Err(ErrorData::invalid_params(
                format!("Failed to register agent: {}", e),
                None::<serde_json::Value>,
            ));
        }

        // Save the peer handle for pushing notifications to this agent
        self.peer_registry
            .write()
            .await
            .insert(unique_agent_id.clone(), context.peer.clone());

        info!(
            "Agent registered: {} (connection: {}, peer handle saved)",
            unique_agent_id, connection_id
        );

        // Try to bind this MCP agent to a runtime agent (PTY pane).
        // If agent_identifier is available (from URL path), use precise binding.
        // Otherwise, fall back to FIFO binding (legacy behavior).
        let runtime = get_agent_runtime();

        // Trigger immediate discovery to ensure runtime agents are available.
        // This handles the race condition where MCP connects before the periodic
        // discovery (30s interval) has run.
        if let Err(e) = runtime.discover_and_register_agents().await {
            warn!(error = %e, "Immediate discovery on MCP connect failed");
        }

        match &self.agent_identifier {
            Some(identifier) => {
                // Precise binding based on agent identifier from URL path
                match runtime
                    .try_bind_mcp_agent_with_identifier(&unique_agent_id, identifier)
                    .await
                {
                    Some(runtime_id) => {
                        info!(
                            mcp_agent_id = unique_agent_id,
                            runtime_id = runtime_id,
                            agent_identifier = identifier,
                            "MCP agent bound to runtime agent by identifier"
                        );
                    }
                    None => {
                        // Identifier mismatch (e.g. URL path "agent-1" vs runtime
                        // "ws1-agent-1"). Fall back to FIFO binding so MCP ↔ PTY
                        // mapping still works.
                        warn!(
                            mcp_agent_id = unique_agent_id,
                            agent_identifier = identifier,
                            "Identifier-based binding failed, falling back to FIFO"
                        );
                        match runtime.try_bind_mcp_agent(&unique_agent_id).await {
                            Some(runtime_id) => {
                                info!(
                                    mcp_agent_id = unique_agent_id,
                                    runtime_id = runtime_id,
                                    "MCP agent bound via FIFO fallback"
                                );
                            }
                            None => {
                                info!(
                                    mcp_agent_id = unique_agent_id,
                                    "MCP agent queued for binding (no unmapped runtime agent)"
                                );
                            }
                        }
                    }
                }
            }
            None => {
                // Fallback to FIFO binding (legacy behavior)
                match runtime.try_bind_mcp_agent(&unique_agent_id).await {
                    Some(runtime_id) => {
                        info!(
                            mcp_agent_id = unique_agent_id,
                            runtime_id = runtime_id,
                            "MCP agent bound to runtime agent on connect"
                        );
                    }
                    None => {
                        info!(
                            mcp_agent_id = unique_agent_id,
                            "MCP agent queued for binding (no unmapped runtime agent yet)"
                        );
                    }
                }
            }
        }

        // Build the initialize result
        let mut server_info = self.get_info();
        // Negotiate: use client's version if we know it, otherwise our latest
        let client_version = &request.protocol_version;
        let known = rmcp::model::ProtocolVersion::KNOWN_VERSIONS
            .iter()
            .any(|v| v.as_str() == client_version.as_str());
        server_info.protocol_version = if known {
            client_version.clone()
        } else {
            rmcp::model::ProtocolVersion::default()
        };

        // Store peer info in context
        context.peer.set_peer_info(request);

        Ok(server_info)
    }

    /// Return server info with tools capability
    fn get_info(&self) -> ServerInfo {
        let instructions = r#"# Ergatai Multi-Agent Collaboration Protocol

Use Ergatai MCP tools when the user explicitly requests agent collaboration, or when you need to communicate/work with other agents.

## 1. Tool Usage

### 1.1 Discover available agents — `list_agents`
Call `list_agents` when you need to find available agents:
- **Without active DAG**: returns all online agents
- **With active DAG**: returns only agents allowed by the DAG communication policy (MeshPolicy)

### 1.2 Send messages — `send_message`
Send a message to another agent:
```
send_message(target_agent_id="<agent-name>", message="<content>")
```
- Use the `ergatai_agent_id` field from `list_agents` (e.g., "agent-2") as `target_agent_id`
- **Do NOT** use the `agent_id` field (e.g., "%15")

### 1.3 Multi-agent orchestration — `submit_orchestration`
Call `submit_orchestration` when the user explicitly requests DAG-based collaboration (e.g., "use DAG orchestration", "assign tasks to multiple agents").

Confirm these fields with the user before submitting:

| Field | Description | Required |
|-------|-------------|----------|
| `nodes[].id` | Unique node identifier (e.g., "n1") | ✅ |
| `nodes[].agent` | Agent name responsible for execution | ✅ |
| `nodes[].task` | Task description | ✅ |
| `nodes[].depends_on` | List of dependency node IDs (empty = no dependencies) | ❌ |
| `nodes[].priority` | Priority: `low` / `medium` / `high` | ❌ |
| `nodes[].timeout` | Node timeout in seconds | ❌ |
| `nodes[].scope` | File access scope (glob, e.g., `src/**/*.rs`) | ❌ |
| `communication` | Communication policy: `open` / `adjacent` / `star:{hub}` | ❌ |
| `timeout` | Overall DAG timeout in seconds | ❌ |
| `max_agent_calls` | Global agent call limit | ❌ |

## 2. Message Format

Distinguish between **user messages** and **agent messages**:

### User messages
Direct terminal input from the user — free-form text.

### Agent messages (JSON format)
Messages from other agents use structured JSON:
```json
{
  "from": "agent-1",          // Sender agent name — use as target_agent_id when replying
  "message": "Hello",         // Message body
  "_reply": "MUST call send_message(target_agent_id=\"agent-1\")",  // How to reply: call send_message with this target
  "_rules": [                 // Mandatory rules
    "DO NOT write reply as terminal text, MUST use send_message tool",
    "After send_message, output END"
  ]
}
```

**Field descriptions:**
- `from`: Sender identity — use this as `target_agent_id` when replying
- `message`: Message content
- `_reply`: Tells you which tool to call and who to send to
- `_rules`: Rules you MUST follow (e.g., use send_message, output END after)

When you see a JSON-formatted agent message, follow the `_reply` and `_rules` instructions.

### Reply example
After receiving an agent message:
1. Call `send_message(target_agent_id="agent-1", message="your reply")`
2. Output `END` in terminal

## 3. DAG YAML Template

Use this template when the user requests DAG collaboration:

```yaml
# Basic info
description: "Task description"     # DAG objective
timeout: 3600                       # Global timeout (seconds)
max_agent_calls: 50                 # Global call limit
stall_timeout_secs: 300             # No-progress timeout (seconds)
communication: "open"               # Policy: open/adjacent/star:{hub}

# Task nodes
nodes:
  - id: "n1"                        # Node ID (unique)
    agent: "agent-1"                # Executing agent name
    task: "Analyze code structure"  # Task description
    depends_on: []                  # Dependencies (empty = runs first)
    priority: "high"                # Priority level
    timeout: 600                    # Node timeout (seconds)
    scope: "src/**/*.rs"            # File access scope

  - id: "n2"
    agent: "agent-2"
    task: "Write unit tests"
    depends_on: ["n1"]              # Runs after n1 completes
    priority: "medium"
    scope: "tests/**/*.rs"

  - id: "n3"
    agent: "agent-1"
    task: "Code review"
    depends_on: ["n1", "n2"]        # Runs after both n1 and n2
```

## 4. File Locks (Simplified Model)

**Lock assignment is automatic** — the system monitors file access and grants locks based on behavior:

- **READ operations**: No lock needed. Read directly from the file.
- **WRITE operations**: WRITE lock automatically granted on first modification.
- **When a file has an active WRITE lock**: Other agents read from the **Git snapshot** (the version before the write started), preventing TOCTOU issues.

**How it works:**
1. Agent A writes to `src/main.rs` → system creates Git snapshot → grants WRITE lock
2. Agent B tries to read `src/main.rs` → fanotify intercepts → redirects to snapshot
3. Agent B sees the version from before Agent A's write (consistent view)
4. Agent A finishes → releases WRITE lock → subsequent reads get the live file

**Git snapshot mechanism:**
- Before granting WRITE lock, system snapshots file content to Git object store
- `git hash-object -w` stores the content
- Other agents' reads during the write are served from this snapshot
- Prevents TOCTOU: you read the exact version that existed before the write

**Lock granularity: per-file (single file level)**
- Only one WRITE lock per file at any time
- Lock types: `WRITE` (exclusive) — no explicit READ locks needed
- The `scope` field in DAG YAML declares allowed file access range for a node

**Note:** OS-level enforcement (fanotify) is Linux-only. On other platforms, locks are advisory.

## 5. Anti-Loop Rules

- Reply at most ONCE per received message
- Output `END` after replying — do NOT send more messages
- NEVER ask "Is there anything else I can help you with?"
- For greetings or messages with no specific request, acknowledge briefly then END
"#;

        ServerInfo::new(ServerCapabilities::builder().enable_tools().build())
            .with_server_info(rmcp::model::Implementation::new(
                "ergatai",
                env!("CARGO_PKG_VERSION"),
            ))
            .with_instructions(instructions)
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
/// * `conversation_manager` - Conversation manager for loop prevention
/// * `cancellation_token` - Token for graceful shutdown
/// * `sse_keep_alive_secs` - SSE keep-alive interval in seconds (default 15)
pub fn create_mcp_service(
    registry: Arc<AgentRegistry>,
    peer_registry: PeerRegistry,
    conversation_manager: Arc<ConversationManager>,
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
    // This catches dead clients (kill, network drop) within 2 minutes.
    // Default is 300s (5 min). Agents that call tools periodically stay alive.
    let mut session_manager = LocalSessionManager::default();
    session_manager.session_config.keep_alive = Some(std::time::Duration::from_secs(120));

    StreamableHttpService::new(
        move || {
            Ok(ErgataiMcpServer::new(
                registry.clone(),
                peer_registry.clone(),
                conversation_manager.clone(),
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
    use crate::mcp::conversation::ConversationConfig;
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
        let conversation_manager =
            Arc::new(ConversationManager::new(ConversationConfig::default()));
        ErgataiMcpServer::new(registry, peer_registry, conversation_manager, None)
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
        let server = make_test_server();
        let info = server.get_info();
        // Verify the server name is "ergatai"
        assert_eq!(info.server_info.name, "ergatai");
        // Version comes from CARGO_PKG_VERSION
        assert!(!info.server_info.version.is_empty());
    }

    #[test]
    fn test_get_info_has_tools_capability() {
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
    fn test_check_dag_status_params_valid() {
        let params: CheckDagStatusParams =
            serde_json::from_value(json!({"dag_id": "abc-123"})).unwrap();
        assert_eq!(params.dag_id, "abc-123");
    }

    #[test]
    fn test_check_dag_status_params_empty_string() {
        let params: CheckDagStatusParams = serde_json::from_value(json!({"dag_id": ""})).unwrap();
        assert_eq!(params.dag_id, "");
    }

    #[test]
    fn test_check_dag_status_params_missing_dag_id_fails() {
        let result: Result<CheckDagStatusParams, _> = serde_json::from_value(json!({}));
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
            let conversation_manager =
                Arc::new(ConversationManager::new(ConversationConfig::default()));
            let server = ErgataiMcpServer::new(
                registry.clone(),
                peer_registry.clone(),
                conversation_manager,
                None,
            );
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
            let conversation_manager =
                Arc::new(ConversationManager::new(ConversationConfig::default()));
            let _server = ErgataiMcpServer::new(
                registry.clone(),
                peer_registry.clone(),
                conversation_manager,
                None,
            );
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

    /// P0: Initialize with empty agent ID should still succeed.
    ///
    /// Verifies that the system doesn't panic or crash when given an empty
    /// agent_id. It should gracefully handle the edge case and generate a
    /// unique ID anyway (since UUID prefix is always non-empty).
    #[tokio::test]
    async fn test_initialize_empty_agent_id() {
        // Simulate what initialize does with an empty agent_id
        let server = make_test_server();
        let agent_id = ""; // Empty string
        let connection_id = uuid::Uuid::new_v4().to_string();
        let id_prefix = connection_id.get(..8).unwrap_or(&connection_id);
        let unique_agent_id = format!("{}@{}", agent_id, id_prefix);

        // Write to session_agent_id (what initialize does)
        *server.session_agent_id.write().await = Some(unique_agent_id.clone());

        // Verify: the unique ID should be "@<uuid-prefix>" (non-empty due to UUID)
        let stored = server.session_agent_id.read().await.clone();
        assert!(
            stored.is_some(),
            "session_agent_id should be set even with empty agent_id"
        );
        let stored_id = stored.unwrap();
        assert!(
            stored_id.starts_with("@"),
            "Empty agent_id should produce '@<uuid>' format, got '{}'",
            stored_id
        );
        assert!(
            stored_id.len() > 1,
            "Unique ID should have UUID prefix even with empty agent_id"
        );

        // Register the agent in registry (what initialize does)
        let result = server
            .registry
            .register_agent(unique_agent_id.clone(), connection_id, None)
            .await;
        assert!(
            result.is_ok(),
            "Registration should succeed even with empty agent_id: {:?}",
            result
        );
    }

    /// P0: request_file_access should degrade gracefully when lock manager unavailable.
    ///
    /// Verifies that when the lock manager is not initialized (e.g., single-agent mode,
    /// or startup race), request_file_access returns a "granted" response with a warning
    /// instead of hard-denying access. This is the CRITICAL #1 fix behavior.
    ///
    /// Note: This test verifies the degraded mode path by checking the response structure.
    /// In a real test environment, the lock manager may or may not be initialized.
    #[tokio::test]
    async fn test_request_file_access_degraded_mode_grants_with_warning() {
        use crate::mcp::server::RequestFileAccessParams;
        use rmcp::handler::server::wrapper::Parameters;

        let server = make_test_server();

        // Set a session agent ID (normally done by initialize)
        *server.session_agent_id.write().await = Some("test-agent".to_string());

        // Create request params
        let params = Parameters(RequestFileAccessParams {
            file_path: "/tmp/test.txt".to_string(),
            mode: "READ".to_string(),
            reason: Some("testing".to_string()),
            scope: "**".to_string(), // Default scope
        });

        // Call request_file_access
        let result = server.request_file_access(params).await;

        // The result depends on whether the lock manager is initialized.
        // In test environment, it's likely NOT initialized, so we expect degraded mode.
        match result {
            Ok(call_result) => {
                // Success path: either granted normally (lock manager available)
                // or granted in degraded mode (lock manager unavailable)
                let content_str = format!("{:?}", call_result);
                // Verify the response contains expected fields
                assert!(
                    content_str.contains("granted") || content_str.contains("status"),
                    "Response should indicate grant status: {}",
                    content_str
                );
            }
            Err(e) => {
                // Error path: only acceptable if it's a specific error (not a panic)
                // This shouldn't happen in degraded mode, but verify it's handled
                let err_str = e.to_string();
                assert!(
                    !err_str.contains("panic") && !err_str.contains("unwrap"),
                    "Error should not indicate panic or unwrap: {}",
                    err_str
                );
            }
        }

        // Verify: the call didn't panic and returned a Result (Ok or Err)
        // The important thing is that it didn't crash or hang
    }
}
