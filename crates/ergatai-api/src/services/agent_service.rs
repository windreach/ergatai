//! Agent service — 统一 agent 查询和 ACP backend 访问。
//!
//! 将 handler 中重复的 ACP backend downcast 逻辑和 agent 列表查询封装到
//! service 层，handler 只负责 HTTP 协议细节（响应格式化、状态码映射）。

use std::collections::HashSet;

use ergatai_runtime::{
    get_agent_runtime, AcpBackend, ElicitationResponse, TrackedElicitation, TrackedPlan,
    TrackedToolCall,
};

// ── ACP backend access helpers ──

/// Apply `f` to the live `AcpBackend`, or return an error if the runtime is
/// using a different backend.
///
/// The closure receives a `&AcpBackend` whose lifetime is tied to the
/// `Arc<AgentRuntime>` held for the duration of the call, so it can only
/// return owned data (which is exactly what all ACP query methods produce).
fn with_acp_backend<T>(f: impl FnOnce(&AcpBackend) -> T) -> anyhow::Result<T> {
    let runtime = get_agent_runtime();
    let backend = runtime.backend();
    match backend.as_any().downcast_ref::<AcpBackend>() {
        Some(acp) => Ok(f(acp)),
        None => anyhow::bail!("Agent is not using ACP backend"),
    }
}

// ── Per-agent queries ──

/// Get captured thoughts for an agent (if `capture_thoughts` was enabled).
pub fn get_agent_thoughts(agent_id: &str) -> anyhow::Result<Option<String>> {
    with_acp_backend(|acp| acp.get_agent_thoughts(agent_id))
}

/// Get recent tool calls for an agent (last 100, newest first).
pub fn get_agent_tool_calls(agent_id: &str) -> anyhow::Result<Option<Vec<TrackedToolCall>>> {
    with_acp_backend(|acp| acp.get_agent_tool_calls(agent_id))
}

/// Get the current execution plan reported by an agent.
pub fn get_agent_plan(agent_id: &str) -> anyhow::Result<Option<TrackedPlan>> {
    with_acp_backend(|acp| acp.get_agent_plan(agent_id))
}

/// Get recent elicitation requests for an agent (both pending and responded).
pub fn get_agent_elicitations(agent_id: &str) -> anyhow::Result<Option<Vec<TrackedElicitation>>> {
    with_acp_backend(|acp| acp.get_agent_elicitations(agent_id))
}

/// Get available slash commands reported by the agent.
pub fn get_agent_available_commands(
    agent_id: &str,
) -> anyhow::Result<Option<Vec<agent_client_protocol::schema::v1::AvailableCommand>>> {
    with_acp_backend(|acp| acp.get_agent_available_commands(agent_id))
}

/// Get configuration options reported by the agent.
pub fn get_agent_config_options(
    agent_id: &str,
) -> anyhow::Result<Option<Vec<agent_client_protocol::schema::v1::SessionConfigOption>>> {
    with_acp_backend(|acp| acp.get_agent_config_options(agent_id))
}

/// Get token usage statistics for an agent as `(input_tokens, output_tokens)`.
pub fn get_agent_usage(agent_id: &str) -> anyhow::Result<Option<(usize, usize)>> {
    with_acp_backend(|acp| acp.get_agent_usage(agent_id))
}

/// Cancel the current prompt turn for an agent (sends ACP `session/cancel`).
///
/// Does NOT stop the agent — only cancels the in-flight prompt.
pub async fn cancel_agent_prompt(agent_id: &str) -> anyhow::Result<()> {
    let runtime = get_agent_runtime();
    let backend = runtime.backend();
    let acp = backend
        .as_any()
        .downcast_ref::<AcpBackend>()
        .ok_or_else(|| anyhow::anyhow!("Agent is not using ACP backend"))?;
    acp.cancel_prompt(agent_id)
        .await
        .map_err(|e| anyhow::anyhow!("{e}"))
}

/// Execute a slash command on an agent and return the captured output.
///
/// Sends the command (e.g. `/model`) as a prompt via ACP, waits for the agent
/// to finish responding, and returns the output text. The output buffer is
/// drained so only the command's response is returned.
pub async fn execute_agent_command(
    agent_id: &str,
    command: &str,
    timeout_secs: u64,
) -> anyhow::Result<String> {
    let runtime = get_agent_runtime();
    let backend = runtime.backend();
    let acp = backend
        .as_any()
        .downcast_ref::<AcpBackend>()
        .ok_or_else(|| anyhow::anyhow!("Agent is not using ACP backend"))?;
    acp.execute_command(agent_id, command, timeout_secs)
        .await
        .map_err(|e| anyhow::anyhow!("{e}"))
}

/// List available ACP sessions for an agent.
pub async fn list_agent_sessions(
    agent_id: &str,
) -> anyhow::Result<Vec<ergatai_runtime::SessionInfo>> {
    let runtime = get_agent_runtime();
    let backend = runtime.backend();
    let acp = backend
        .as_any()
        .downcast_ref::<AcpBackend>()
        .ok_or_else(|| anyhow::anyhow!("Agent is not using ACP backend"))?;
    acp.list_sessions(agent_id)
        .await
        .map_err(|e| anyhow::anyhow!("{e}"))
}

/// Create a new ACP session for an agent.
pub async fn create_agent_session(
    agent_id: &str,
) -> anyhow::Result<ergatai_runtime::SessionInfo> {
    let runtime = get_agent_runtime();
    let backend = runtime.backend();
    let acp = backend
        .as_any()
        .downcast_ref::<AcpBackend>()
        .ok_or_else(|| anyhow::anyhow!("Agent is not using ACP backend"))?;
    acp.create_session(agent_id)
        .await
        .map_err(|e| anyhow::anyhow!("{e}"))
}

/// Load an existing ACP session for an agent.
pub async fn load_agent_session(agent_id: &str, session_id: &str) -> anyhow::Result<()> {
    let runtime = get_agent_runtime();
    let backend = runtime.backend();
    let acp = backend
        .as_any()
        .downcast_ref::<AcpBackend>()
        .ok_or_else(|| anyhow::anyhow!("Agent is not using ACP backend"))?;
    acp.load_session(agent_id, session_id)
        .await
        .map_err(|e| anyhow::anyhow!("{e}"))
}

/// Delete an ACP session for an agent.
pub async fn delete_agent_session(agent_id: &str, session_id: &str) -> anyhow::Result<()> {
    let runtime = get_agent_runtime();
    let backend = runtime.backend();
    let acp = backend
        .as_any()
        .downcast_ref::<AcpBackend>()
        .ok_or_else(|| anyhow::anyhow!("Agent is not using ACP backend"))?;
    acp.delete_session(agent_id, session_id)
        .await
        .map_err(|e| anyhow::anyhow!("{e}"))
}

/// Respond to a pending elicitation request from an agent.
///
/// Returns `Ok(true)` if the elicitation was found and the response was sent,
/// `Ok(false)` if the elicitation ID was not found (already responded or invalid).
pub async fn respond_to_elicitation(
    elicitation_id: &str,
    response: ElicitationResponse,
) -> anyhow::Result<bool> {
    let runtime = get_agent_runtime();
    let backend = runtime.backend();
    let acp = backend
        .as_any()
        .downcast_ref::<AcpBackend>()
        .ok_or_else(|| anyhow::anyhow!("Agent is not using ACP backend"))?;
    acp.respond_to_elicitation(elicitation_id, response)
        .await
        .map_err(|e| anyhow::anyhow!("{e}"))
}

/// Get the session title reported by an agent (if any).
pub fn get_agent_session_title(agent_id: &str) -> Option<String> {
    with_acp_backend(|acp| acp.get_agent_session_title(agent_id))
        .ok()
        .flatten()
}

/// Get the stop reason from the most recent prompt response.
pub fn get_agent_stop_reason(agent_id: &str) -> Option<String> {
    with_acp_backend(|acp| acp.get_agent_stop_reason(agent_id))
        .ok()
        .flatten()
}

/// Get the number of automatic continuations performed for an agent.
pub fn get_agent_continuation_count(agent_id: &str) -> usize {
    with_acp_backend(|acp| acp.get_agent_continuation_count(agent_id))
        .ok()
        .flatten()
        .unwrap_or(0)
}

// ── Agent list query (Phase 4) ──

/// Filter criteria for listing agents. All fields are optional; `None` means
/// "no constraint on this axis".
#[derive(Default)]
pub struct AgentListFilter {
    /// Only include agents that participate in this DAG (by `agent_id` match
    /// against the graph nodes, including `mcp_agent_id` aliases).
    pub in_dag: Option<String>,
    /// Only include agents whose lifecycle state equals this value (case-insensitive).
    pub status: Option<String>,
    /// Skip these agent IDs from the result. Used by MCP to exclude the caller.
    pub exclude_agent_ids: HashSet<String>,
}

/// A single agent entry returned by [`list_agents_filtered`].
///
/// Contains the common fields needed by both REST and MCP consumers. Each
/// caller may enrich the response with additional fields (e.g., MCP adds
/// `ergatai_agent_id` and `status`, REST adds `session_title`).
pub struct AgentListItem {
    pub agent_id: String,
    pub stable_id: Option<String>,
    pub agent_uuid: String,
    pub workspace_id: String,
    /// Lowercase lifecycle state name (e.g., "running", "idle").
    pub state: String,
    pub task_id: Option<String>,
    pub mcp_agent_id: Option<String>,
    pub is_alive: bool,
    pub is_idle: bool,
    pub is_processing: bool,
    pub created_at: String,
    pub last_heartbeat: String,
    /// Working directory from workspace metadata.
    pub work_dir: String,
}

/// List agents matching the given filter.
///
/// This is the shared query used by both the REST `GET /api/v1/agents` handler
/// and the MCP `list_agents` tool. Each caller maps the returned
/// `AgentListItem`s into its own response format.
pub async fn list_agents_filtered(filter: AgentListFilter) -> Vec<AgentListItem> {
    let runtime = get_agent_runtime();
    let runtime_agents = runtime.list_agents().await;

    // Pre-compute DAG participant set if requested.
    let dag_participants: Option<HashSet<String>> = if let Some(ref dag_id) = filter.in_dag {
        let scheduler = ergatai_core::cross_agent::get_dag_scheduler_by_id(Some(dag_id));
        match scheduler {
            Some(s) => {
                // Build the set synchronously via try_lock first; fall back to
                // the cached snapshot of node agent names if the lock is busy.
                // (The scheduler's graph is a tokio::Mutex, but we already hold
                // no other lock here, so blocking on it briefly is acceptable.)
                let graph = s.graph().lock_owned().await;
                let participants: HashSet<String> =
                    graph.nodes.iter().map(|n| n.agent.clone()).collect();
                Some(participants)
            }
            None => Some(HashSet::new()),
        }
    } else {
        None
    };

    let status_filter: Option<String> = filter.status.map(|s| s.to_lowercase());

    runtime_agents
        .into_iter()
        .filter(|info| {
            // Skip excluded IDs (e.g., the calling MCP agent).
            if filter.exclude_agent_ids.contains(&info.agent_id) {
                return false;
            }
            if info
                .mcp_agent_id
                .as_ref()
                .is_some_and(|mcp_id| filter.exclude_agent_ids.contains(mcp_id))
            {
                return false;
            }
            // Apply in_dag filter.
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
            // Apply status filter (case-insensitive).
            if let Some(ref status) = status_filter {
                if info.lifecycle.state_name().to_lowercase() != *status {
                    return false;
                }
            }
            true
        })
        .map(|a| {
            let state = a.lifecycle.state_name().to_string();
            let work_dir = a
                .handle
                .workspace
                .metadata
                .get("work_dir")
                .cloned()
                .unwrap_or_default();
            AgentListItem {
                agent_id: a.agent_id,
                stable_id: a.stable_id,
                agent_uuid: a.agent_uuid,
                workspace_id: a.workspace_id,
                state,
                task_id: a.task_id,
                mcp_agent_id: a.mcp_agent_id,
                is_alive: a.lifecycle.is_alive(),
                is_idle: a.lifecycle.is_idle(),
                is_processing: a.lifecycle.is_processing(),
                created_at: a.created_at.to_rfc3339(),
                last_heartbeat: a.last_heartbeat.to_rfc3339(),
                work_dir,
            }
        })
        .collect()
}

/// Resolve the runtime agent ID for a given MCP peer ID.
///
/// Convenience wrapper used by the MCP `list_agents` tool to exclude the caller.
pub async fn resolve_agent_id(mcp_agent_id: &str) -> Option<String> {
    let runtime = get_agent_runtime();
    runtime.resolve_agent_id(mcp_agent_id).await
}
