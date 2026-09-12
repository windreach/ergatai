//! Agent service — 统一 agent 查询和 ACP backend 访问。
//!
//! 将 handler 中重复的 ACP backend downcast 逻辑和 agent 列表查询封装到
//! service 层，handler 只负责 HTTP 协议细节（响应格式化、状态码映射）。

use std::collections::HashSet;

use ergatai_runtime::{
    AcpBackend, ElicitationResponse, TrackedElicitation, TrackedPlan, TrackedToolCall,
};

// ── ACP backend access helpers ──

/// Apply `f` to the live `AcpBackend`, or return an error if the runtime is
/// using a different backend.
///
/// The closure receives a `&AcpBackend` whose lifetime is tied to the
/// `Arc<AgentRuntime>` held for the duration of the call, so it can only
/// return owned data (which is exactly what all ACP query methods produce).
fn with_acp_backend<T>(f: impl FnOnce(&AcpBackend) -> T) -> anyhow::Result<T> {
    let runtime = crate::context::get_app_context().agent_runtime.clone();
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

/// Get captured output for an agent (non-destructive read).
pub fn get_agent_output(agent_id: &str) -> anyhow::Result<Option<String>> {
    with_acp_backend(|acp| acp.get_agent_output(agent_id))
}

/// Get the time elapsed since the agent's last output.
pub fn get_agent_last_output_age(agent_id: &str) -> anyhow::Result<Option<std::time::Duration>> {
    with_acp_backend(|acp| acp.get_agent_last_output_age(agent_id))
}

/// Get the exit code from the agent's connection task.
/// `Some(None)` = exists but still running, `Some(Some(code))` = exited, `None` = not found.
pub fn get_agent_exit_code(agent_id: &str) -> anyhow::Result<Option<Option<i32>>> {
    with_acp_backend(|acp| acp.get_agent_exit_code(agent_id))
}

/// Get the PID of an agent's process.
pub fn get_agent_pid(agent_id: &str) -> anyhow::Result<Option<u32>> {
    with_acp_backend(|acp| acp.get_pid_by_agent(agent_id))
}

/// Resolve an agent ID (profile name, stable ID, or runtime ID) to a runtime ID.
/// Returns `None` if the agent is not found or not running.
pub async fn resolve_to_runtime_id(agent_id: &str) -> Option<String> {
    let runtime = crate::context::get_app_context().agent_runtime.clone();
    // Try direct lookup first
    if runtime.get_agent(agent_id).await.is_some() {
        return Some(agent_id.to_string());
    }
    // TODO: Add resolution logic for profile names and stable IDs
    None
}

/// Get agent information by runtime ID.
pub async fn get_agent_info(runtime_id: &str) -> Option<ergatai_runtime::AgentInfo> {
    let runtime = crate::context::get_app_context().agent_runtime.clone();
    runtime.get_agent(runtime_id).await
}

/// Pending prompt state for an agent.
#[derive(Clone, Debug)]
pub struct PendingPrompt {
    pub id: String,
    pub agent_id: String,
    pub message: String,
    pub images: Vec<ergatai_runtime::AgentImage>,
    pub sub_chat_id: Option<String>,
    pub agent_name: String,
    pub created_at: std::time::Instant,
}

/// Enqueue a prompt for an agent.
pub fn enqueue_prompt(_agent_id: &str, _prompt: PendingPrompt) -> anyhow::Result<()> {
    // TODO: Implement prompt queue
    Ok(())
}

/// Wait for a pending prompt turn to complete.
/// Returns `true` if the turn was found, `false` if not.
pub async fn wait_pending_prompt_turn(_agent_id: &str, _prompt_id: &str) -> bool {
    // TODO: Implement wait logic
    true
}

/// Run a pending prompt by agent ID and optional prompt ID.
pub async fn run_pending_prompt(_agent_id: &str, _prompt_id: Option<&str>) -> anyhow::Result<()> {
    // TODO: Implement prompt execution
    Ok(())
}

/// Flush pending prompts for an agent.
pub async fn flush_pending_prompt(_agent_id: &str) {
    // TODO: Implement flush logic
}

/// Prompt an agent with images.
pub async fn prompt_agent_with_images(
    _agent_id: &str,
    _message: &str,
    _images: Vec<ergatai_runtime::AgentImage>,
) -> anyhow::Result<()> {
    // TODO: Implement image prompt
    Ok(())
}

/// Prompt an agent with persistence.
pub async fn prompt_agent_with_persistence(
    _agent_id: &str,
    _prompt: PendingPrompt,
    _session_id: Option<&str>,
) -> anyhow::Result<()> {
    // TODO: Implement persistent prompt
    Ok(())
}

/// Cancel the current prompt turn for an agent (sends ACP `session/cancel`).
///
/// Does NOT stop the agent — only cancels the in-flight prompt.
pub async fn cancel_agent_prompt(agent_id: &str) -> anyhow::Result<()> {
    let runtime = crate::context::get_app_context().agent_runtime.clone();
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
    let runtime = crate::context::get_app_context().agent_runtime.clone();
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
    let runtime = crate::context::get_app_context().agent_runtime.clone();
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
pub async fn create_agent_session(agent_id: &str) -> anyhow::Result<ergatai_runtime::SessionInfo> {
    let runtime = crate::context::get_app_context().agent_runtime.clone();
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
    let runtime = crate::context::get_app_context().agent_runtime.clone();
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
    let runtime = crate::context::get_app_context().agent_runtime.clone();
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
    let runtime = crate::context::get_app_context().agent_runtime.clone();
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

/// Get the ACP session ID for an agent (if available).
pub fn get_agent_session_id(agent_id: &str) -> Option<String> {
    with_acp_backend(|acp| acp.get_agent_session_id(agent_id))
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
    /// Agent profile name (e.g., "general-purpose", "explore", "plan").
    pub profile: Option<String>,
    /// Agent capabilities (tools this agent provides).
    pub capabilities: Vec<String>,
    /// When the lifecycle state last changed.
    pub state_changed_at: String,
    /// State transition history (audit trail).
    pub state_history: Vec<ergatai_runtime::agent_record::StateTransition>,
}

/// List agents matching the given filter.
///
/// This is the shared query used by both the REST `GET /api/v1/agents` handler
/// and the MCP `list_agents` tool. Each caller maps the returned
/// `AgentListItem`s into its own response format.
pub async fn list_agents_filtered(filter: AgentListFilter) -> Vec<AgentListItem> {
    let runtime = crate::context::get_app_context().agent_runtime.clone();
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
                profile: a.profile,
                capabilities: a.capabilities,
                state_changed_at: a.state_changed_at.to_rfc3339(),
                state_history: a.state_history,
            }
        })
        .collect()
}

/// Resolve the runtime agent ID for a given MCP peer ID.
///
/// Convenience wrapper used by the MCP `list_agents` tool to exclude the caller.
pub async fn resolve_agent_id(mcp_agent_id: &str) -> Option<String> {
    let runtime = crate::context::get_app_context().agent_runtime.clone();
    runtime.resolve_agent_id(mcp_agent_id).await
}

// ── Backend global configuration ──────────────────────────────────────────────

///
/// Get the backend auto-continue setting.
pub fn get_backend_auto_continue() -> anyhow::Result<bool> {
    with_acp_backend(|b| b.get_auto_continue())
}

///
/// Get the backend max auto-continues limit.
pub fn get_backend_max_auto_continues() -> anyhow::Result<usize> {
    with_acp_backend(|b| b.get_max_auto_continues())
}

///
/// Check if MCP-over-ACP is enabled in the backend.
pub fn is_backend_mcp_over_acp_enabled() -> anyhow::Result<bool> {
    with_acp_backend(|b| b.is_mcp_over_acp_enabled())
}

///
/// Check if session persistence is enabled in the backend.
pub fn is_backend_session_persistence_enabled() -> anyhow::Result<bool> {
    with_acp_backend(|b| b.is_session_persistence_enabled())
}

///
/// Get the capture_thoughts setting for a workspace.
pub fn get_workspace_capture_thoughts(workspace_id: &str) -> anyhow::Result<Option<bool>> {
    with_acp_backend(|b| b.get_workspace_capture_thoughts(workspace_id))
}

// ── Streaming & Prompt ──

/// Subscribe to real-time output events from an agent.
///
/// Returns a broadcast receiver that yields `AgentOutputEvent` values as
/// the agent produces output during prompt execution.
pub fn subscribe_agent_output(
    agent_id: &str,
) -> anyhow::Result<tokio::sync::broadcast::Receiver<ergatai_runtime::AgentOutputEvent>> {
    with_acp_backend(|acp| acp.subscribe_output(agent_id))?
        .ok_or_else(|| anyhow::anyhow!("Agent '{}' not found", agent_id))
}

/// Send a prompt to an agent (non-blocking).
///
/// Spawns a background task that calls `inject_message()` and returns
/// immediately. Output events are broadcast via `subscribe_agent_output()`.
pub async fn prompt_agent(agent_id: &str, message: &str) -> anyhow::Result<()> {
    let runtime = crate::context::get_app_context().agent_runtime.clone();
    let agent_id = agent_id.to_string();
    let message = message.to_string();
    tokio::spawn(async move {
        if let Err(e) = runtime.inject_message(&agent_id, &message).await {
            tracing::warn!(agent_id = %agent_id, error = %e, "Background prompt failed");
        }
    });
    Ok(())
}
