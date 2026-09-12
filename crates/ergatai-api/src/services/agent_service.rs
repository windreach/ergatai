//! Agent service — 统一 agent 查询和 ACP backend 访问。
//!
//! 将 handler 中重复的 backend trait 方法调用封装到 service 层，
//! handler 只负责 HTTP 协议细节（响应格式化、状态码映射）。

use std::collections::HashSet;

use ergatai_runtime::{ElicitationResponse, TrackedElicitation, TrackedPlan, TrackedToolCall};

// ── Backend access helper ──

/// Get the current backend instance via the trait interface.
fn backend() -> std::sync::Arc<dyn ergatai_runtime::backend::AcpBackendInterface> {
    crate::context::get_app_context()
        .agent_runtime
        .backend()
        .clone()
}

// ── Per-agent queries ──

/// Get captured thoughts for an agent (if `capture_thoughts` was enabled).
pub async fn get_agent_thoughts(agent_id: &str) -> anyhow::Result<Option<String>> {
    Ok(backend().thoughts(agent_id).await?)
}

/// Get recent tool calls for an agent (last 100, newest first).
pub async fn get_agent_tool_calls(agent_id: &str) -> anyhow::Result<Option<Vec<TrackedToolCall>>> {
    Ok(backend().tool_calls(agent_id).await?)
}

/// Get the current execution plan reported by an agent.
pub async fn get_agent_plan(agent_id: &str) -> anyhow::Result<Option<TrackedPlan>> {
    Ok(backend().plan(agent_id).await?)
}

/// Get recent elicitation requests for an agent (both pending and responded).
pub async fn get_agent_elicitations(
    agent_id: &str,
) -> anyhow::Result<Option<Vec<TrackedElicitation>>> {
    Ok(backend().elicitations(agent_id).await?)
}

/// Get available slash commands reported by the agent.
pub async fn get_agent_available_commands(
    agent_id: &str,
) -> anyhow::Result<Option<Vec<agent_client_protocol::schema::v1::AvailableCommand>>> {
    Ok(backend().available_commands(agent_id).await?)
}

/// Get configuration options reported by the agent.
pub async fn get_agent_config_options(
    agent_id: &str,
) -> anyhow::Result<Option<Vec<agent_client_protocol::schema::v1::SessionConfigOption>>> {
    Ok(backend().config_options(agent_id).await?)
}

/// Get token usage statistics for an agent as `(input_tokens, output_tokens)`.
pub async fn get_agent_usage(agent_id: &str) -> anyhow::Result<Option<(usize, usize)>> {
    Ok(backend().usage(agent_id).await?)
}

/// Get captured output for an agent (non-destructive read).
pub async fn get_agent_output(agent_id: &str) -> anyhow::Result<Option<String>> {
    Ok(backend().output(agent_id).await?)
}

/// Get the time elapsed since the agent's last output.
pub async fn get_agent_last_output_age(
    agent_id: &str,
) -> anyhow::Result<Option<std::time::Duration>> {
    Ok(backend().agent_last_output_age(agent_id).await?)
}

/// Get the exit code from the agent's connection task.
/// `Some(None)` = exists but still running, `Some(Some(code))` = exited, `None` = not found.
pub async fn get_agent_exit_code(agent_id: &str) -> anyhow::Result<Option<Option<i32>>> {
    Ok(backend().exit_code(agent_id).await?)
}

/// Get the PID of an agent's process.
pub async fn get_agent_pid(agent_id: &str) -> anyhow::Result<Option<u32>> {
    Ok(backend().pid(agent_id).await?)
}

/// Get the session title reported by an agent (if any).
pub async fn get_agent_session_title(agent_id: &str) -> Option<String> {
    backend().session_title(agent_id).await.ok().flatten()
}

/// Get the ACP session ID for an agent (if available).
pub async fn get_agent_session_id(agent_id: &str) -> Option<String> {
    backend().session_id(agent_id).await.ok().flatten()
}

/// Get the stop reason from the most recent prompt response.
pub async fn get_agent_stop_reason(agent_id: &str) -> Option<String> {
    backend().stop_reason(agent_id).await.ok().flatten()
}

/// Get the number of automatic continuations performed for an agent.
pub async fn get_agent_continuation_count(agent_id: &str) -> usize {
    backend()
        .continuation_count(agent_id)
        .await
        .ok()
        .flatten()
        .unwrap_or(0)
}

/// Resolve an agent ID (profile name, stable ID, or runtime ID) to a runtime ID.
/// Returns `None` if the agent is not found or not running.
pub async fn resolve_to_runtime_id(agent_id: &str) -> Option<String> {
    // Delegate to the more complete resolve_agent_id which handles:
    // 1. Direct lookup by runtime ID
    // 2. MCP agent ID lookup via bindings
    // 3. Profile name resolution (TODO)
    resolve_agent_id(agent_id).await
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
    anyhow::bail!("Prompt queue not yet implemented")
}

/// Wait for a pending prompt turn to complete.
/// Returns `true` if the turn was found, `false` if not.
pub async fn wait_pending_prompt_turn(_agent_id: &str, _prompt_id: &str) -> bool {
    // TODO: Implement wait logic — for now, always return false to indicate not found
    false
}

/// Run a pending prompt by agent ID and optional prompt ID.
pub async fn run_pending_prompt(_agent_id: &str, _prompt_id: Option<&str>) -> anyhow::Result<()> {
    anyhow::bail!("Prompt execution not yet implemented")
}

/// Flush pending prompts for an agent.
pub async fn flush_pending_prompt(_agent_id: &str) {
    // TODO: Implement flush logic — no-op until queue is implemented
}

/// Prompt an agent with images.
pub async fn prompt_agent_with_images(
    _agent_id: &str,
    _message: &str,
    _images: Vec<ergatai_runtime::AgentImage>,
) -> anyhow::Result<()> {
    anyhow::bail!("Image prompt not yet implemented")
}

/// Prompt an agent with persistence.
pub async fn prompt_agent_with_persistence(
    _agent_id: &str,
    _prompt: PendingPrompt,
    _session_id: Option<&str>,
) -> anyhow::Result<()> {
    anyhow::bail!("Persistent prompt not yet implemented")
}

/// Cancel the current prompt turn for an agent (sends ACP `session/cancel`).
///
/// Does NOT stop the agent — only cancels the in-flight prompt.
pub async fn cancel_agent_prompt(agent_id: &str) -> anyhow::Result<()> {
    Ok(backend().cancel_prompt(agent_id).await?)
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
    Ok(backend()
        .execute_command(agent_id, command, timeout_secs)
        .await?)
}

/// List available ACP sessions for an agent.
pub async fn list_agent_sessions(
    agent_id: &str,
) -> anyhow::Result<Vec<ergatai_runtime::SessionInfo>> {
    Ok(backend().list_sessions(agent_id).await?)
}

/// Create a new ACP session for an agent.
pub async fn create_agent_session(agent_id: &str) -> anyhow::Result<ergatai_runtime::SessionInfo> {
    Ok(backend().create_session(agent_id).await?)
}

/// Load an existing ACP session for an agent.
pub async fn load_agent_session(agent_id: &str, session_id: &str) -> anyhow::Result<()> {
    Ok(backend().load_session(agent_id, session_id).await?)
}

/// Delete an ACP session for an agent.
pub async fn delete_agent_session(agent_id: &str, session_id: &str) -> anyhow::Result<()> {
    Ok(backend().delete_session(agent_id, session_id).await?)
}

/// Respond to a pending elicitation request from an agent.
///
/// Returns `Ok(true)` if the elicitation was found and the response was sent,
/// `Ok(false)` if the elicitation ID was not found (already responded or invalid).
pub async fn respond_to_elicitation(
    elicitation_id: &str,
    response: ElicitationResponse,
) -> anyhow::Result<bool> {
    Ok(backend()
        .respond_to_elicitation(elicitation_id, response)
        .await?)
}

// ── Backend configuration queries ──

/// Check if auto-continue is enabled.
pub async fn get_backend_auto_continue() -> anyhow::Result<bool> {
    Ok(backend().auto_continue().await?)
}

/// Get max auto-continues setting.
pub async fn get_backend_max_auto_continues() -> anyhow::Result<usize> {
    Ok(backend().max_auto_continues().await?)
}

/// Check if MCP-over-ACP is enabled.
pub async fn is_backend_mcp_over_acp_enabled() -> anyhow::Result<bool> {
    Ok(backend().mcp_over_acp_enabled().await?)
}

/// Check if session persistence is enabled.
pub async fn is_backend_session_persistence_enabled() -> anyhow::Result<bool> {
    Ok(backend().session_persistence_enabled().await?)
}

/// Get workspace configuration (capture_thoughts flag).
pub async fn get_workspace_capture_thoughts(workspace_id: &str) -> anyhow::Result<Option<bool>> {
    Ok(backend().workspace_capture_thoughts(workspace_id).await?)
}

/// Subscribe to real-time output events from an agent.
pub async fn subscribe_agent_output(
    agent_id: &str,
) -> anyhow::Result<Option<tokio::sync::broadcast::Receiver<ergatai_runtime::AgentOutputEvent>>> {
    Ok(backend().subscribe_output(agent_id).await?)
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

// ── Agent ID resolution (used by MCP server.rs) ──

/// Resolve an agent ID to a runtime agent ID.
///
/// Tries:
/// 1. Direct lookup by runtime ID (e.g., "ws1-agent-1")
/// 2. Lookup by MCP agent ID (e.g., "agent-1")
/// 3. Profile name resolution (TODO)
///
/// Returns `None` if the agent is not found or not running.
pub async fn resolve_agent_id(agent_id: &str) -> Option<String> {
    let runtime = crate::context::get_app_context().agent_runtime.clone();
    // Try direct lookup first
    if runtime.get_agent(agent_id).await.is_some() {
        return Some(agent_id.to_string());
    }
    // Try MCP agent ID lookup via bindings
    if let Some(binding_store) = crate::mcp::get_binding_store() {
        if let Ok(Some(binding)) = binding_store.get_binding_by_identifier(agent_id) {
            let runtime_id = binding.runtime_agent_id;
            // Verify the runtime agent still exists
            if runtime.get_agent(&runtime_id).await.is_some() {
                return Some(runtime_id);
            }
        }
    }
    // TODO: Add profile name resolution
    None
}

/// Prompt an agent with a message.
///
/// This is the main entry point for sending prompts to agents.
/// It resolves the agent ID and delegates to the backend's message injection.
pub async fn prompt_agent(
    agent_id: &str,
    message: &str,
    images: Vec<ergatai_runtime::AgentImage>,
) -> anyhow::Result<()> {
    let runtime_id = resolve_agent_id(agent_id)
        .await
        .ok_or_else(|| anyhow::anyhow!("Agent not found or not running: {}", agent_id))?;

    let runtime = crate::context::get_app_context().agent_runtime.clone();
    runtime
        .inject_message_with_images(&runtime_id, message, images)
        .await?;
    Ok(())
}
