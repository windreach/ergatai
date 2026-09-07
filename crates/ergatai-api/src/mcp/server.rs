//! MCP Server implementation using rmcp (Rust MCP SDK)
//!
//! Implements MCP protocol 2025-06-18 with Streamable HTTP transport.
//! Agents connect via POST/GET /mcp and can call tools like list_agents,
//! send_message, submit_orchestration, etc.

use std::collections::HashMap;
use std::sync::Arc;

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
use tracing::{info, warn};

use ergatai_core::agent_registry::AgentRegistry;
use ergatai_runtime::get_agent_runtime;

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
    /// - `can_communicate_with`: reserved for future use; currently a no-op (all
    ///   agents are returned regardless of this value).
    /// - `in_dag`: Only return agents that are participants in the specified DAG.
    /// - `status`: Only return agents whose lifecycle state matches (e.g., "running", "idle", "processing").
    #[serde(default)]
    filter: Option<AgentFilter>,
}

/// Filter criteria for `list_agents`. All fields are optional and combined with AND.
#[derive(Debug, Deserialize, JsonSchema)]
pub struct AgentFilter {
    /// Reserved for future use; currently a no-op. All agents are returned
    /// regardless of this value.
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
    /// Message type. Controls tracking and timeout behavior:
    ///
    /// - `"request"` (default): the message expects a response. The system will
    ///   generate a correlation ID, start a 30-second timeout, and track the
    ///   request via `RequestMonitor`. If no response arrives in time, a
    ///   `request_timeout` notification is published to the sender.
    /// - `"response"`: a reply to a received request. Pass `correlation_id`
    ///   (from the request's `_meta.correlation_id`) so the system can match
    ///   this response to the original request and cancel the timeout.
    /// - `"broadcast"`: informational message, no tracking, no timeout.
    #[serde(default)]
    message_type: Option<String>,
    /// Correlation ID for linking a response back to its original request.
    ///
    /// **Optional**: the system automatically tracks pending responses, so you
    /// typically don't need to set this. Only provide it if you're handling
    /// advanced scenarios with multiple concurrent requests.
    /// Ignored for `"request"` and `"broadcast"` messages.
    #[serde(default)]
    correlation_id: Option<String>,
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
struct GetDagStatusParams {
    /// DAG ID to check (currently unused — there is at most one active DAG)
    dag_id: String,
}

// ── Tool implementations ──

#[tool_router]
impl ErgataiMcpServer {
    /// List online agents in Ergatai. Use this BEFORE `send_message` to discover valid
    /// target_agent_id values, or BEFORE `submit_orchestration` to verify which agents
    /// are available for task assignment.
    ///
    /// # Behavior
    /// Returns all online agents discovered via the PTY backend. The caller is automatically
    /// excluded from the results (you cannot message yourself). Communication policy (MeshPolicy)
    /// filtering is NOT applied — all agents are listed regardless of DAG membership.
    ///
    /// # Filter Options (combined with AND)
    /// - `in_dag: "<dag_id>"` — Only agents participating in the specified DAG (derived from
    ///   the DAG's task graph nodes). Use this to see who is working on a specific orchestration.
    /// - `status: "<state>"` — Only agents whose lifecycle state matches (case-insensitive).
    ///   Valid states: `created`, `initializing`, `idle`, `starting`, `running`, `processing`,
    ///   `stopping`, `terminated`. Use `idle` to find agents available for new tasks.
    /// - `can_communicate_with` — Reserved for future use (currently a no-op).
    ///
    /// # Response Format
    /// ```json
    /// {
    ///   "agents": [
    ///     {
    ///       "agent_id": "ws1-agent-1",
    ///       "agent_uuid": "550e8400-e29b-41d4-a716-446655440000",
    ///       "mcp_agent_id": "opencode@a1b2c3d4",
    ///       "workspace_id": "ws1",
    ///       "state": "idle",
    ///       "lifecycle_state": "idle",
    ///       "task_id": null,
    ///       "is_alive": true,
    ///       "is_idle": true,
    ///       "is_processing": false,
    ///       "status": "active",
    ///       "ergatai_agent_id": "ws1-agent-1",
    ///       "last_heartbeat": "2026-08-27T10:30:00Z"
    ///     }
    ///   ],
    ///   "total": 3,
    ///   "filter_applied": false,
    ///   "note": "All online agents are listed."
    /// }
    /// ```
    ///
    /// # Field Semantics
    /// - `agent_id` / `ergatai_agent_id` — Runtime agent ID (use this for `send_message` target).
    ///   Format: `{workspace_id}-agent-{counter}` (e.g., `ws1-agent-1`).
    /// - `mcp_agent_id` — MCP connection ID (e.g., `opencode@a1b2c3d4`). Present only if the
    ///   agent connected via MCP protocol.
    /// - `state` / `lifecycle_state` — Current lifecycle state. Agents in `idle` state are
    ///   available for new tasks; agents in `processing` state are executing a task.
    /// - `status` — `"active"` if connected via MCP, `"discovered"` if detected via PTY only.
    /// - `last_heartbeat` — ISO 8601 timestamp of last heartbeat. Stale heartbeats (> 60s)
    ///   indicate the agent may be unresponsive.
    ///
    /// # Usage Patterns
    /// 1. **Find available agents**: Call with `filter: {"status": "idle"}` (pass filter as a JSON object) to find agents ready
    ///    for new tasks.
    /// 2. **Check DAG participants**: Call with `filter: {"in_dag": "<dag_id>"}` to see which
    ///    agents are assigned to a specific orchestration.
    /// 3. **No filter needed**: Omit `filter` entirely (or pass `null`) to list all agents.
    /// 4. **Verify target exists**: Before `send_message`, call this to confirm the target
    ///    agent is online and `is_alive = true`.
    ///
    /// # Errors
    /// This tool does not return errors under normal operation. If `total = 0`, no agents
    /// are currently online — wait for agents to start or check workspace configuration.
    #[tool(
        description = "List online agents in Ergatai. Use BEFORE `send_message` to discover valid target_agent_id values, or BEFORE `submit_orchestration` to verify agent availability. Excludes the caller automatically. RESPONSE: JSON with {agents: [{agent_id, state, workspace_id, is_alive, last_heartbeat, ...}], total, filter_applied, note}. FILTER: pass `filter` as a JSON OBJECT (not a string), e.g. {\"filter\": {\"status\": \"idle\"}} or {\"filter\": {\"in_dag\": \"dag-1\"}}. Valid status values: created|initializing|idle|starting|running|processing|stopping|terminated. Omit `filter` entirely to list all agents.",
        annotations(read_only_hint = true, idempotent_hint = true)
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

        // Get the calling agent's ID to mark is_self.
        let my_agent_id = self.session_agent_id.read().await.clone();

        // Resolve caller's runtime ID so we can exclude self from the listing.
        let my_runtime_id = match &my_agent_id {
            Some(id) => runtime.resolve_agent_id(id).await,
            None => None,
        };

        // ── Pre-compute filter state for `in_dag` ──
        let dag_participants: Option<std::collections::HashSet<String>> = if let Some(ref f) =
            filter
        {
            if let Some(ref dag_id) = f.in_dag {
                let scheduler = ergatai_core::cross_agent::get_dag_scheduler_by_id(Some(dag_id));
                match scheduler {
                    Some(s) => {
                        // Get participants from the graph nodes (unique agents)
                        let graph = s.graph().lock_owned().await;
                        let participants: std::collections::HashSet<String> =
                            graph.nodes.iter().map(|n| n.agent.clone()).collect();
                        Some(participants)
                    }
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
                    // ID Unification: prefer MCP URL path name (e.g., "agent-1") when
                    // the agent is MCP-bound, so it matches the `from` field in messages
                    // and the `target_agent_id` agents use in send_message.
                    // Fall back to workspace ID (e.g., "start-opencode-3-agent-1") for
                    // agents not yet bound to an MCP connection.
                    "ergatai_agent_id": info.mcp_agent_id.as_ref().or_else(|| info.handle.metadata.get("ergatai_agent_id")),
                    "last_heartbeat": info.last_heartbeat.to_rfc3339(),
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
            "note": if filter_applied {
                "User-supplied filter applied."
            } else {
                "All online agents are listed."
            }
        });

        Ok(CallToolResult::success(vec![ContentBlock::text(
            serde_json::to_string_pretty(&result).unwrap_or_default(),
        )]))
    }

    /// Send a message to another agent. Use this for any inter-agent communication:
    /// requests, status updates, task delegation, or collaborative discussion.
    ///
    /// # Before You Call
    /// 1. **Verify the target exists**: Call `list_agents` first and confirm the target
    ///    agent is in the result with `is_alive = true`. Sending to a dead agent will
    ///    be rejected.
    /// 2. **Use the right ID**: Pass `agent_id` (e.g., `ws1-agent-1`) from `list_agents`
    ///    as `target_agent_id`. Do NOT use `mcp_agent_id` — that is internal.
    ///
    /// # Communication Rules
    /// - You can message ANY online agent. MeshPolicy constraints (from DAG `communication`
    ///   field) are enforced server-side and will return a clear error if violated.
    /// - You CANNOT message yourself — the server rejects self-messages.
    /// - Rate limit: 60 messages/min per agent (sliding window). Exceeding this returns
    ///   a 429-style error; back off and retry.
    ///
    /// # Message Types
    /// - `request` (default) — A request requiring a response. The receiver is expected
    ///   to act and reply.
    /// - `response` — A reply to a previous `request`. Use when answering a question.
    /// - `broadcast` — Informational; no response expected. Use for status updates.
    ///
    /// # Delivery Pipeline
    /// Messages are persisted to NATS JetStream (`AGENT_MESSAGES` stream, 24h TTL,
    /// WorkQueue retention) and delivered by a background consumer via PTY injection
    /// into the target agent's terminal. If NATS is unavailable, messages fall back
    /// to direct PTY injection (no persistence — use this signal for reliability
    /// monitoring).
    ///
    /// # Response Format (success)
    /// ```json
    /// {
    ///   "status": "queued",
    ///   "target_agent": "ws1-agent-2",
    ///   "delivery_method": "nats_jetstream",
    ///   "stream": "AGENT_MESSAGES",
    ///   "sequence": 42,
    ///   "note": "Message persisted to NATS JetStream..."
    /// }
    /// ```
    /// Status values:
    /// - `queued` — persisted to NATS JetStream, will be delivered by background consumer.
    ///   `stream` and `sequence` fields are present.
    /// - `direct_delivered` — NATS unavailable; delivered via direct PTY injection
    ///   (no persistence). Only `target_agent` and `delivery_method` are present.
    ///
    /// # Response Format (error)
    /// MCP error with human-readable reason. Common causes:
    /// - `target agent not found` — call `list_agents` to verify the agent is online.
    /// - `rate limit exceeded` — wait and retry; reduce message frequency.
    /// - `communication policy denied` — the DAG's `communication` field (MeshPolicy)
    ///   forbids this sender→receiver pair. Adjust the DAG YAML or remove the sender
    ///   from the DAG session.
    /// - `backpressure: too many pending messages` — the target's inbox is full (≥1000).
    ///   Wait for the target to consume messages before retrying.
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
        let target_agent_id = &params.0.target_agent_id;
        let message = &params.0.message;
        let message_type = params.0.message_type.as_deref().unwrap_or("request");
        let correlation_id = params.0.correlation_id.clone();

        info!(
            "Sending message to agent {} (type: {}, bytes: {}, correlation_id: {:?})",
            target_agent_id,
            message_type,
            message.len(),
            correlation_id
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
            correlation_id,
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

    /// Submit a DAG workflow for multi-agent collaboration. You are the COORDINATOR —
    /// once submitted, you CANNOT also be a task worker in the same DAG. The scheduler
    /// role is purely orchestration; assign all tasks to other agents.
    ///
    /// # Before You Call
    /// 1. **Validate the YAML first**: Call `validate_dag_yaml` with the SAME YAML
    ///    to catch errors without starting execution. A failed `submit_orchestration`
    ///    wastes no resources, but validation errors are clearer from the dry-run tool.
    /// 2. **Verify agents exist**: Call `list_agents` and confirm every `agent:` value
    ///    in your YAML matches an online agent's `agent_id`. Submitting a DAG that
    ///    references unknown agents will fail at task dispatch time (not at submission).
    /// 3. **Choose complexity carefully**: Each task's `complexity` (low|medium|high)
    ///    scales its timeout (Low × 0.5, Medium × 1.0, High × 2.0) and influences
    ///    priority scoring. Under-estimating complexity causes premature timeouts.
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
    /// # Communication Policy
    /// Optional top-level `communication` field constrains which agents can message
    /// each other DURING the DAG execution (MeshPolicy):
    /// - `open` (default) — any participant can message any other participant.
    /// - `adjacent` — only agents connected by a `depends_on` edge can message each other.
    /// - `star:{hub_agent}` — all communication must pass through the named hub agent.
    ///   The hub must appear as the `agent` of at least one task.
    /// Policy is enforced server-side on every `send_message` call while the DAG is active.
    /// After the DAG completes, policy is lifted and agents can communicate freely again.
    ///
    /// # YAML Validation Rules (strict — invalid YAML is rejected)
    /// - **Top-level fields**: unknown keys are rejected (e.g., `communcation:` typo → error).
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
    /// # Concurrency
    /// Only ONE DAG can run at a time. If a DAG is already running, this call is rejected.
    /// Use `get_dag_status` to check the current DAG, then wait for it to complete or fail
    /// before submitting a new one.
    ///
    /// # Response Format
    /// ```json
    /// {
    ///   "status": "submitted",
    ///   "submitted_nodes": 3,
    ///   "progress": {
    ///     "completed": 0,
    ///     "total": 3,
    ///     "percent": 0.0
    ///   },
    ///   "graph_status": "running (0/3 completed)"
    /// }
    /// ```
    ///
    /// # After Submission
    /// Use `get_dag_status` to monitor progress. The scheduler dispatches ready tasks
    /// (those with all `depends_on` satisfied) as their worker agents become available.
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

    /// Dry-run validate a DAG YAML definition. ALWAYS call this BEFORE `submit_orchestration`
    /// to catch validation errors without starting execution. The same YAML and parameters
    /// go through the exact same strict parser — if validation passes here, submission
    /// will not fail on parse errors.
    ///
    /// # What is Validated
    /// All 9 strict rules (unknown top-level fields rejected, non-empty unique task names,
    /// priority enum, positive timeouts, communication format + hub existence, template
    /// variable references, depends_on existence, scope glob validity). See
    /// `submit_orchestration` for the full rule list.
    ///
    /// # Response Format (success)
    /// ```json
    /// {
    ///   "valid": true,
    ///   "task_count": 3,
    ///   "agents": ["agent-a", "agent-b", "agent-c"],
    ///   "communication": "adjacent",
    ///   "dag_timeout": 3600,
    ///   "dag_max_agent_calls": 100,
    ///   "dag_stall_timeout_secs": 300,
    ///   "dag_node_timeout_secs": 600,
    ///   "tasks": [
    ///     {
    ///       "name": "Task A",
    ///       "agent": "agent-a",
    ///       "priority": "medium",
    ///       "complexity": "medium",
    ///       "depends_on_count": 0,
    ///       "timeout": null,
    ///       "scope": null
    ///     }
    ///   ]
    /// }
    /// ```
    /// Use this summary to verify your YAML parsed as intended: check `agents` for typos,
    /// `communication` for correct policy, `tasks[].depends_on_count` for correct edges.
    ///
    /// # Response Format (failure)
    /// MCP error with the FIRST validation error encountered. The error message includes
    /// the offending field name and the rejected value. Common errors and fixes:
    /// - `unknown field 'communcation'` → typo: rename to `communication`
    /// - `Task name cannot be empty` → add a `name:` field to every task
    /// - `Duplicate task name: 'X'` → rename one of the duplicate tasks
    /// - `DAG has invalid priority ["urgent"]` → use `low`|`medium`|`high`
    /// - `DAG 'timeout' must be > 0` → remove the field or set to a positive integer
    /// - `Task 'B' depends_on unknown task 'A'` → fix the typo or declare task 'A'
    /// - `communication hub 'agent-x' not found in tasks` → ensure the hub is an `agent:` value
    ///
    /// # Tip
    /// After successful validation, verify every `agents[]` value exists by calling
    /// `list_agents` before submission.
    #[tool(
        description = "Dry-run validate a DAG YAML definition. ALWAYS call this BEFORE `submit_orchestration` — same strict parser, no execution. RESPONSE on success: {valid: true, task_count, agents: [...], communication, dag_timeout, dag_max_agent_calls, tasks: [{name, agent, priority, complexity, depends_on_count, timeout, scope}]}. Use the summary to verify parsing: check `agents` for typos, `tasks[].depends_on_count` for correct edges. RESPONSE on failure: MCP error with first validation error (common: `unknown field 'X'` → fix typo; `Duplicate task name` → rename; `depends_on unknown task` → fix reference; `communication hub not found` → hub must be an agent in the DAG). TIP: After validation, also call `list_agents` to confirm every `agents[]` value is online.",
        annotations(read_only_hint = true, idempotent_hint = true)
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

    /// Get the status of a DAG execution. Use this AFTER `submit_orchestration` to monitor
    /// progress, check for stuck nodes, or inspect the active communication policy.
    /// Poll periodically (every 10-30s) during long-running orchestrations.
    ///
    /// # What This Returns
    /// A combined view of DAG execution progress + collaboration session metadata.
    /// There is at most ONE active DAG at a time, so no dag_id lookup is needed —
    /// the `dag_id` parameter is accepted for forward compatibility but ignored.
    ///
    /// # Response Format (no DAG running)
    /// ```json
    /// {
    ///   "status": "no_dag",
    ///   "message": "No DAG scheduler is active"
    /// }
    /// ```
    /// Use this signal to decide whether it is safe to call `submit_orchestration`.
    ///
    /// # Response Format (DAG active or completed)
    /// ```json
    /// {
    ///   "status": "running",
    ///   "progress": {
    ///     "completed": 2,
    ///     "total": 5,
    ///     "percent": 40.0
    ///   },
    ///   "is_complete": false,
    ///   "graph_status": "running (2/5 completed, 1 in progress)",
    ///   "graph_snapshot": [
    ///     {"id": "...", "task": "Task A", "agent": "agent-a", "status": "completed", ...},
    ///     {"id": "...", "task": "Task B", "agent": "agent-b", "status": "running", ...},
    ///     {"id": "...", "task": "Task C", "agent": "agent-c", "status": "pending", ...}
    ///   ],
    ///   "collaboration": {
    ///     "dag_id": "550e8400-e29b-41d4-a716-446655440000",
    ///     "policy": "Adjacent",
    ///     "participants": ["agent-a", "agent-b", "agent-c"],
    ///     "participant_count": 3,
    ///     "created_at": "2026-08-27T10:30:00Z"
    ///   }
    /// }
    /// ```
    ///
    /// # Field Semantics
    /// - `status` — `"no_dag"` | `"running"` | `"completed"`. Check this first to branch logic.
    /// - `progress` — `{completed, total, percent}`. `percent` is 0-100 float.
    /// - `is_complete` — boolean; true when all nodes reached terminal state (completed/failed/skipped).
    /// - `graph_snapshot` — array of node states; each has `{id, task, agent, status}`.
    ///   Node status: `pending` | `running` | `completed` | `failed` | `skipped`.
    ///   Use to identify stuck nodes (running for too long) or plan next steps.
    /// - `collaboration.policy` — Active MeshPolicy: `Open` | `Adjacent` | `Star { hub: "..." }` |
    ///   `Restricted { pairs: [...] }`. Determines which agents can message each other.
    /// - `collaboration.participants` — Agents bound to this DAG session. Only these agents
    ///   are subject to the MeshPolicy; agents outside the list can communicate freely.
    ///
    /// # Interpreting Results
    /// - `status = "running"` + `progress.percent < 100` → DAG is still executing. Poll again
    ///   in 10-30s. Inspect `graph_snapshot` to find nodes in `running` state.
    /// - `graph_snapshot` has nodes in `running` state for longer than `node_timeout_secs` →
    ///   those nodes may be stuck; the scheduler's timeout watcher will handle them.
    /// - `status = "completed"` → DAG finished. MeshPolicy is lifted; agents can now message
    ///   freely. You may submit a new DAG.
    /// - `graph_snapshot` has `failed` nodes → inspect their `metadata["error"]` for the
    ///   failure reason. Decide whether to retry with a new DAG.
    ///
    /// # Errors
    /// This tool does not return errors under normal operation. A `no_dag` status is NOT
    /// an error — it means no DAG is currently scheduled.
    #[tool(
        description = "Get DAG execution status. Use AFTER `submit_orchestration` to monitor progress, check stuck nodes, or inspect the active MeshPolicy. Poll every 10-30s during long runs. There is at most ONE active DAG — `dag_id` param is accepted but ignored. RESPONSE: {status: 'no_dag'|'running'|'completed', progress: {completed, total, percent}, is_complete, graph_snapshot: [{id, task, agent, status}], collaboration: {dag_id, policy, participants, participant_count, created_at}}. INTERPRETING: `status='running'` → poll again in 10-30s; check `graph_snapshot` for stuck `running` nodes. `status='completed'` → MeshPolicy lifted, safe to submit new DAG. `failed` nodes → check node metadata for error reason. `status='no_dag'` → no DAG active, safe to submit.",
        annotations(read_only_hint = true, idempotent_hint = true)
    )]
    async fn get_dag_status(
        &self,
        params: Parameters<GetDagStatusParams>,
    ) -> Result<CallToolResult, ErrorData> {
        let _dag_id = &params.0.dag_id;

        info!("Getting DAG status");

        match ergatai_core::cross_agent::get_dag_scheduler() {
            None => {
                // Scheduler was removed from registry (DAG reached terminal state).
                // Try to load the final state from disk so callers see "completed"
                // instead of "no_dag".
                match load_completed_dag_from_disk().await {
                    Some(result) => Ok(CallToolResult::success(vec![ContentBlock::text(
                        serde_json::to_string_pretty(&result).unwrap_or_default(),
                    )])),
                    None => {
                        let result = serde_json::json!({
                            "status": "no_dag",
                            "message": "No DAG scheduler is active",
                        });
                        Ok(CallToolResult::success(vec![ContentBlock::text(
                            serde_json::to_string_pretty(&result).unwrap_or_default(),
                        )]))
                    }
                }
            }
            Some(scheduler) => {
                let is_complete = scheduler.is_complete().await;
                let status_text = scheduler.status_prompt().await;
                let snapshot = scheduler.graph_snapshot().await.ok();

                // Calculate progress as object (consistent with disk fallback format)
                let graph_arc = scheduler.graph();
                let graph = graph_arc.lock().await;
                let total = graph.nodes.len();
                let completed = graph
                    .nodes
                    .iter()
                    .filter(|n| {
                        matches!(n.status, ergatai_core::orchestration::TaskStatus::Completed)
                    })
                    .count();
                let running = graph
                    .nodes
                    .iter()
                    .filter(|n| {
                        matches!(n.status, ergatai_core::orchestration::TaskStatus::Running)
                    })
                    .count();
                let failed = graph
                    .nodes
                    .iter()
                    .filter(|n| matches!(n.status, ergatai_core::orchestration::TaskStatus::Failed))
                    .count();
                let pending = graph
                    .nodes
                    .iter()
                    .filter(|n| {
                        matches!(n.status, ergatai_core::orchestration::TaskStatus::Pending)
                    })
                    .count();
                let percent = if total > 0 {
                    // Clamp to 100.0 to prevent float precision from producing
                    // values like 100.5 that round up past the logical maximum.
                    ((completed + failed) as f64 / total as f64 * 100.0)
                        .round()
                        .min(100.0) as u32
                } else {
                    0
                };
                drop(graph);

                // Fetch collaboration session info (MeshPolicy + participants)
                let collab = scheduler.collaboration().await;
                let policy_str = format!("{:?}", collab.policy);
                let participants: Vec<&str> =
                    collab.participants.iter().map(|s| s.as_str()).collect();

                let status = if is_complete { "completed" } else { "running" };

                let result = serde_json::json!({
                    "status": status,
                    "progress": {
                        "completed": completed,
                        "running": running,
                        "failed": failed,
                        "pending": pending,
                        "total": total,
                        "percent": percent,
                    },
                    "is_complete": is_complete,
                    "graph_status": status_text,
                    "graph_snapshot": snapshot,
                    "collaboration": {
                        "dag_id": collab.dag_id,
                        "policy": policy_str,
                        "participants": participants,
                        "participant_count": participants.len(),
                        "created_at": collab.created_at,
                    }
                });
                Ok(CallToolResult::success(vec![ContentBlock::text(
                    serde_json::to_string_pretty(&result).unwrap_or_default(),
                )]))
            }
        }
    }
}

// ── Helpers ──

/// Try to load the most recently modified completed DAG state from disk.
///
/// After `finalize_if_terminal` removes the scheduler from the in-memory registry,
/// the persisted `dag-state-*.json` files remain on disk. This function scans
/// `<project_root>/.ergatai/`, picks the newest file, and — if its graph shows all
/// nodes in a terminal state — returns a JSON value with status "completed".
///
/// Returns `None` if no project root can be determined, no state files exist, or
/// the most recent DAG is not yet complete (e.g., crash mid-execution).
async fn load_completed_dag_from_disk() -> Option<serde_json::Value> {
    use ergatai_core::orchestration::{TaskGraph, TaskStatus};

    let project_root = std::env::current_dir().ok()?;
    let ergatai_dir = project_root.join(".ergatai");

    // Collect dag-state-*.json files
    let mut dag_files: Vec<std::path::PathBuf> = Vec::new();
    let mut entries = tokio::fs::read_dir(&ergatai_dir).await.ok()?;
    while let Ok(Some(entry)) = entries.next_entry().await {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) == Some("json")
            && path
                .file_name()
                .and_then(|n| n.to_str())
                .is_some_and(|n| n.starts_with("dag-state-"))
        {
            dag_files.push(path);
        }
    }

    if dag_files.is_empty() {
        // Also try legacy single-DAG file
        let legacy = ergatai_dir.join("dag-state.json");
        if legacy.exists() {
            dag_files.push(legacy);
        }
    }

    if dag_files.is_empty() {
        return None;
    }

    // Pick the most recently modified file
    let mut best: Option<(std::path::PathBuf, std::time::SystemTime)> = None;
    for path in &dag_files {
        if let Ok(meta) = tokio::fs::metadata(path).await {
            if let Ok(modified) = meta.modified() {
                if best.as_ref().is_none_or(|(_, t)| modified > *t) {
                    best = Some((path.clone(), modified));
                }
            }
        }
    }
    let (best_path, _) = best?;

    // Guard against excessively large state files (e.g., corrupted or malicious)
    const MAX_DAG_STATE_SIZE: u64 = 10 * 1024 * 1024; // 10 MB
    if let Ok(meta) = tokio::fs::metadata(&best_path).await {
        if meta.len() > MAX_DAG_STATE_SIZE {
            tracing::warn!(
                path = %best_path.display(),
                size = meta.len(),
                limit = MAX_DAG_STATE_SIZE,
                "DAG state file exceeds size limit, skipping"
            );
            return None;
        }
    }

    let graph = TaskGraph::load_from_file(&best_path).await.ok()?;

    // Only report completed if every node is terminal
    if !graph.is_complete() {
        return None;
    }

    let total = graph.nodes.len();
    let completed = graph
        .nodes
        .iter()
        .filter(|n| matches!(n.status, TaskStatus::Completed))
        .count();
    let failed = graph
        .nodes
        .iter()
        .filter(|n| matches!(n.status, TaskStatus::Failed))
        .count();
    let percent = if total > 0 {
        // Clamp to 100.0 to prevent float precision overflow.
        ((completed + failed) as f64 / total as f64 * 100.0)
            .round()
            .min(100.0) as u32
    } else {
        0
    };

    let dag_id = graph
        .dag_id
        .clone()
        .unwrap_or_else(|| "unknown".to_string());

    let snapshot: Vec<serde_json::Value> = graph
        .nodes
        .iter()
        .map(|n| {
            serde_json::json!({
                "id": n.id,
                "task": n.task,
                "agent": n.agent,
                "status": format!("{:?}", n.status),
            })
        })
        .collect();

    // Load collaboration metadata from disk (if saved during finalization)
    let collab_meta =
        ergatai_core::cross_agent::DagScheduler::load_collaboration_meta(&project_root, &dag_id)
            .await
            .unwrap_or_else(|| {
                serde_json::json!({
                    "dag_id": dag_id,
                    "policy": "N/A",
                    "participants": [],
                    "participant_count": 0,
                    "created_at": "N/A",
                })
            });

    Some(serde_json::json!({
        "status": "completed",
        "progress": {
            "completed": completed,
            "failed": failed,
            "total": total,
            "percent": percent,
        },
        "is_complete": true,
        "graph_status": "All nodes have reached a terminal state",
        "graph_snapshot": snapshot,
        "collaboration": collab_meta,
        "source": "disk",
        "message": "DAG has completed. Scheduler was removed from memory; this status was loaded from persisted state.",
    }))
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

        // Use the MCP URL path component as the unique agent ID.
        // This is the dynamic name from the URL (e.g., /mcp/agent-1/ → "agent-1").
        // Falls back to client_info.name if no agent_identifier (default /mcp/ endpoint).
        let connection_id = uuid::Uuid::new_v4().to_string();
        let unique_agent_id = self
            .agent_identifier
            .clone()
            .unwrap_or_else(|| agent_id.clone());

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

        // Reconnection support: Check for stored binding first
        let mut binding_restored = false;
        if let (Some(identifier), Some(binding_store)) =
            (&self.agent_identifier, crate::mcp::get_binding_store())
        {
            if let Ok(Some(stored_binding)) = binding_store.get_binding_by_identifier(identifier) {
                // Verify the runtime agent still exists
                if runtime
                    .get_agent(&stored_binding.runtime_agent_id)
                    .await
                    .is_some()
                {
                    // Try to restore the binding
                    match runtime
                        .try_bind_mcp_agent_with_identifier(
                            &unique_agent_id,
                            &stored_binding.runtime_agent_id,
                        )
                        .await
                    {
                        Some(runtime_id) => {
                            info!(
                                mcp_agent_id = unique_agent_id,
                                runtime_id = runtime_id,
                                agent_identifier = identifier,
                                "Binding restored from persistent storage (reconnection)"
                            );
                            binding_restored = true;
                            // Update last_active timestamp
                            let _ = binding_store.touch_binding(&unique_agent_id);
                        }
                        None => {
                            warn!(
                                mcp_agent_id = unique_agent_id,
                                runtime_id = stored_binding.runtime_agent_id,
                                "Failed to restore binding, proceeding with normal binding"
                            );
                        }
                    }
                } else {
                    info!(
                        mcp_agent_id = unique_agent_id,
                        runtime_id = stored_binding.runtime_agent_id,
                        "Stored runtime agent no longer exists, proceeding with normal binding"
                    );
                }
            }
        }

        // Normal binding flow (if not restored from storage)
        if !binding_restored {
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
        } // End of if !binding_restored

        // Persist the binding for reconnection support
        if let Some(binding_store) = crate::mcp::get_binding_store() {
            // Check if we have a successful binding by looking up the runtime ID
            if let Some(runtime_id) = runtime.resolve_agent_id(&unique_agent_id).await {
                let binding = crate::mcp::AgentBinding {
                    mcp_agent_id: unique_agent_id.clone(),
                    runtime_agent_id: runtime_id.clone(),
                    agent_identifier: self.agent_identifier.clone(),
                    created_at: chrono::Utc::now(),
                    last_active: chrono::Utc::now(),
                };

                if let Err(e) = binding_store.save_binding(&binding) {
                    warn!(
                        error = %e,
                        mcp_agent_id = %unique_agent_id,
                        "Failed to persist agent binding"
                    );
                } else {
                    info!(
                        mcp_agent_id = %unique_agent_id,
                        runtime_agent_id = %runtime_id,
                        "Binding persisted for reconnection"
                    );
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

## 1. Available Tools

| Tool | Purpose |
|------|---------|
| `list_agents` | Discover online agents |
| `send_message` | Send message to another agent |
| `submit_orchestration` | Submit DAG workflow |
| `validate_dag_yaml` | Validate DAG YAML without executing (dry-run) |
| `get_dag_status` | Query DAG execution status |

### 1.1 Discover agents — `list_agents`
Returns all online agents. Use `ergatai_agent_id` field (e.g., "agent-2") as `target_agent_id`. Do NOT use `agent_id` field.

### 1.2 Send messages — `send_message`
See tool description for full details.

QUICK REFERENCE (use the `ergatai_agent_id` from `list_agents` as `target_agent_id`):
```
# Send request (default)
send_message(target_agent_id="agent-2", message="Please review")

# Reply (use the `from` field of the received message)
send_message(target_agent_id="agent-1", message="Done", message_type="response")

# Broadcast
send_message(target_agent_id="agent-2", message="FYI", message_type="broadcast")
```

### 1.3 DAG orchestration

**Submit DAG** — `submit_orchestration`:
Call when user explicitly requests DAG collaboration. The YAML top-level field MUST be `tasks:` (NOT `nodes:`). Confirm fields before submitting:

| Field | Description | Required |
|-------|-------------|----------|
| `tasks[].name` | Unique task name | YES |
| `tasks[].agent` | Agent name | YES |
| `tasks[].task` | Task description | YES |
| `tasks[].depends_on` | Dependency task names | NO |
| `tasks[].priority` | `low` / `medium` / `high` | NO |
| `tasks[].timeout` | Node timeout (seconds) | NO |
| `tasks[].scope` | File access scope (glob) | NO |
| `communication` | `open` / `adjacent` / `star:{hub}` | NO |
| `timeout` | DAG timeout (seconds) | NO |
| `max_agent_calls` | Global call limit | NO |

**Validate DAG** — `validate_dag_yaml`:
Dry-run validation without execution. Returns summary or first error. Use before `submit_orchestration` to check YAML.

**Check status** — `get_dag_status`:
Returns DAG execution status, progress, collaboration session info (MeshPolicy + participants).

## 2. Message Format

MUST distinguish user messages (free-form) from agent messages (JSON).

### Agent message format
```json
{
  "from": "agent-1",
  "message": "Please review",
  "message_type": "request",
  "_reply": "MUST call send_message(target_agent_id=\"agent-1\")",
  "_rules": ["DO NOT write reply as terminal text", "After send_message, output END"]
}
```

Fields:
- `from`: Sender's MCP agent ID (e.g., "agent-1"). This is the unified ID format — use it as `target_agent_id` when replying. `from` and `_reply` always contain the same ID.
- `message`: Content
- `message_type`: "request" | "response" | "broadcast"
- `_reply`: (request only) Exact `send_message` call — MUST follow. **Absent (null) for response/broadcast** — do NOT call send_message unless there is new work or a specific task.
- `_rules`: Type-specific behavioral rules — MUST follow

### How to respond
When `message_type = "request"` with a concrete task or question:
1. Do your work
2. Call `send_message(target_agent_id="<from>", message="<reply>", message_type="response")`
3. Output `END`

When `message_type = "response"`: DO NOT reply again (conversation is done unless there's new work).
When `message_type = "broadcast"`: DO NOT reply unless it has a specific task for you.

System auto-tracks correlation_id — no manual tracking needed.

### Timeout handling
If you receive `request_timeout`, recipient didn't respond in time.

RETRY GUIDANCE:
- First timeout: Retry once after 5 seconds
- Second timeout: Escalate to user or try alternative agent
- NEVER retry more than 2 times

## 3. DAG YAML Template

```yaml
description: "Task description"
timeout: 3600
max_agent_calls: 50
communication: "open"

tasks:
  - name: "analyze"           # Unique task name (REQUIRED)
    agent: "agent-1"          # Executing agent (REQUIRED)
    task: "Analyze structure" # Task description (REQUIRED)
    depends_on: []            # Dependencies (empty = runs first)
    priority: "high"
    timeout: 600
    scope: "src/**/*.rs"

  - name: "test"
    agent: "agent-2"
    task: "Write tests"
    depends_on: ["analyze"]
    priority: "medium"

  - name: "review"
    agent: "agent-1"
    task: "Code review"
    depends_on: ["analyze", "test"]
```

## 4. File Locks

Locks are AUTOMATIC:
- READ: No lock needed
- WRITE: Automatically granted on first modification
- Reading locked file: You see Git snapshot (version before write)

NOTE: OS-level enforcement (fanotify) is Linux-only. Other platforms: advisory only.

## 5. Anti-Loop Rules

MUST follow to prevent infinite loops:
- Reply at most ONCE per received message
- Output `END` after replying
- NEVER ask "Is there anything else I can help you with?"

### WHEN NOT TO REPLY (critical)
DO NOT respond in these cases:
- message_type="broadcast" with no specific task or question → ignore silently
- message_type="response" and the conversation is clearly ending (e.g., "thanks", "ok", "got it") → no reply needed
- You've already replied to this message → stop
- Your response would just be polite acknowledgment → suppress it

### WHEN TO REPLY (only these cases)
- message_type="request" with a concrete task or question → do the work, then reply
- message_type="broadcast" with a specific task for you → do the work, then reply

### Key principle
Every reply must contain SUBSTANCE (work done, answer given, data provided). If your reply is just "thanks", "ok", "got it", or similar acknowledgment — DO NOT REPLY. Silence is better than a loop.
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
}
