//! Agent service — 统一 agent 查询和 ACP backend 访问。
//!
//! 将 handler 中重复的 backend trait 方法调用封装到 service 层，
//! handler 只负责 HTTP 协议细节（响应格式化、状态码映射）。

use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::{Mutex, OnceLock};

use ergatai_runtime::{ElicitationResponse, TrackedElicitation, TrackedPlan, TrackedToolCall};
use tokio::sync::Notify;

// ── Backend access helper ──

/// Get the current backend instance via the trait interface.
fn backend() -> std::sync::Arc<dyn ergatai_runtime::backend::AcpBackendInterface> {
    crate::context::get_app_context()
        .agent_runtime
        .backend()
        .clone()
}

#[derive(Default)]
struct PromptQueueState {
    queues: Mutex<HashMap<String, VecDeque<PendingPrompt>>>,
    dispatch_locks: Mutex<HashMap<String, std::sync::Arc<tokio::sync::Mutex<()>>>>,
    notify: Notify,
}

static PROMPT_QUEUE_STATE: OnceLock<PromptQueueState> = OnceLock::new();

fn prompt_queue_state() -> &'static PromptQueueState {
    PROMPT_QUEUE_STATE.get_or_init(PromptQueueState::default)
}

fn dispatch_lock(agent_id: &str) -> anyhow::Result<std::sync::Arc<tokio::sync::Mutex<()>>> {
    let state = prompt_queue_state();
    Ok(state
        .dispatch_locks
        .lock()
        .map_err(|error| anyhow::anyhow!("Prompt dispatch lock registry poisoned: {}", error))?
        .entry(agent_id.to_string())
        .or_default()
        .clone())
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

/// Agent snapshot with session metadata, fetched in batch.
///
/// Contains the per-agent metadata that `list_agents` needs beyond the basic
/// `AgentListItem` fields. Fetching these in batch (all agents in parallel,
/// all fields per agent in parallel) avoids the N+1 pattern where each agent
/// incurred 5 sequential backend roundtrips.
pub struct AgentSnapshot {
    pub session_title: Option<String>,
    pub session_id: Option<String>,
    pub stop_reason: Option<String>,
    pub continuation_count: usize,
    pub config_options: Option<Vec<agent_client_protocol::schema::v1::SessionConfigOption>>,
}

/// Fetch session metadata for multiple agents in one batch.
///
/// All agents are processed concurrently; within each agent, all 5 backend
/// queries run in parallel via `tokio::join!`. This turns O(N * 5) sequential
/// roundtrips into O(N) concurrent work — for 50 agents, from ~250 serial
/// calls down to ~50 parallel batches of 5 concurrent calls each.
pub async fn agent_snapshot_batch(agent_ids: &[&str]) -> HashMap<String, AgentSnapshot> {
    let futures: Vec<_> =
        agent_ids
            .iter()
            .map(|id| {
                let id_owned = id.to_string();
                async move {
                    let (
                        session_title,
                        session_id,
                        stop_reason,
                        continuation_count,
                        config_options,
                    ) = tokio::join!(
                        get_agent_session_title(&id_owned),
                        get_agent_session_id(&id_owned),
                        get_agent_stop_reason(&id_owned),
                        async { get_agent_continuation_count(&id_owned).await },
                        async { get_agent_config_options(&id_owned).await.ok().flatten() },
                    );
                    (
                        id_owned,
                        AgentSnapshot {
                            session_title,
                            session_id,
                            stop_reason,
                            continuation_count,
                            config_options,
                        },
                    )
                }
            })
            .collect();

    futures::future::join_all(futures)
        .await
        .into_iter()
        .collect()
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
pub fn enqueue_prompt(agent_id: &str, prompt: PendingPrompt) -> anyhow::Result<()> {
    let state = prompt_queue_state();
    state
        .queues
        .lock()
        .map_err(|error| anyhow::anyhow!("Prompt queue lock poisoned: {}", error))?
        .entry(agent_id.to_string())
        .or_default()
        .push_back(prompt);
    state.notify.notify_one();
    Ok(())
}

/// Wait for a pending prompt turn to complete.
/// Returns `true` if the turn was found, `false` if not.
pub async fn wait_pending_prompt_turn(agent_id: &str, prompt_id: &str) -> bool {
    let state = prompt_queue_state();
    let Ok(queues) = state.queues.lock() else {
        return false;
    };

    queues
        .get(agent_id)
        .is_some_and(|queue| queue.iter().any(|prompt| prompt.id == prompt_id))
}

/// Claim the next queued prompt for an SSE subscriber.
///
/// The returned guard is held while the prompt executes, so a later prompt's
/// stream cannot subscribe while the previous turn is still producing events.
pub async fn claim_pending_prompt(
    agent_id: &str,
    prompt_id: &str,
) -> anyhow::Result<(PendingPrompt, tokio::sync::OwnedMutexGuard<()>)> {
    let state = prompt_queue_state();
    loop {
        let head_id = {
            let queues = state
                .queues
                .lock()
                .map_err(|error| anyhow::anyhow!("Prompt queue lock poisoned: {}", error))?;
            queues
                .get(agent_id)
                .and_then(VecDeque::front)
                .map(|prompt| prompt.id.clone())
        };

        match head_id {
            Some(head_id) if head_id == prompt_id => {}
            Some(_) => {
                state.notify.notified().await;
                continue;
            }
            None => anyhow::bail!("Prompt {} not found", prompt_id),
        }

        let dispatch_lock = dispatch_lock(agent_id)?;
        let dispatch_guard = dispatch_lock.clone().lock_owned().await;
        let mut queues = state
            .queues
            .lock()
            .map_err(|error| anyhow::anyhow!("Prompt queue lock poisoned: {}", error))?;
        let is_head = queues
            .get(agent_id)
            .and_then(VecDeque::front)
            .is_some_and(|head| head.id == prompt_id);
        if !is_head {
            state.notify.notify_one();
            continue;
        }

        let prompt = queues
            .get_mut(agent_id)
            .expect("prompt queue exists")
            .pop_front()
            .expect("checked prompt queue head");
        state.notify.notify_one();
        return Ok((prompt, dispatch_guard));
    }
}

/// Run a pending prompt by agent ID and optional prompt ID.
pub async fn run_pending_prompt(agent_id: &str, prompt_id: Option<&str>) -> anyhow::Result<()> {
    let state = prompt_queue_state();
    let dispatch_lock = dispatch_lock(agent_id)?;
    let _dispatch_guard = dispatch_lock.lock().await;

    let prompt = loop {
        let next_prompt = {
            let queues = state
                .queues
                .lock()
                .map_err(|error| anyhow::anyhow!("Prompt queue lock poisoned: {}", error))?;
            queues.get(agent_id).and_then(VecDeque::front).cloned()
        };

        match next_prompt {
            Some(prompt) if prompt_id.is_none_or(|id| prompt.id == id) => break prompt,
            Some(_) => state.notify.notified().await,
            None => anyhow::bail!("Prompt not found"),
        }
    };

    {
        let mut queues = state
            .queues
            .lock()
            .map_err(|error| anyhow::anyhow!("Prompt queue lock poisoned: {}", error))?;
        let is_head = queues
            .get(agent_id)
            .and_then(VecDeque::front)
            .is_some_and(|head| head.id == prompt.id);
        if !is_head {
            anyhow::bail!("Prompt queue changed before prompt {} could run", prompt.id);
        }
        queues
            .get_mut(agent_id)
            .expect("prompt queue exists")
            .pop_front();
    }
    state.notify.notify_one();

    prompt_agent_with_images(&prompt.agent_id, &prompt.message, prompt.images).await
}

/// Flush pending prompts for an agent.
pub async fn flush_pending_prompt(agent_id: &str) {
    loop {
        let next_prompt = {
            let Ok(queues) = prompt_queue_state().queues.lock() else {
                return;
            };
            queues.get(agent_id).and_then(VecDeque::front).cloned()
        };

        let Some(prompt) = next_prompt else {
            break;
        };
        if run_pending_prompt(agent_id, Some(&prompt.id))
            .await
            .is_err()
        {
            break;
        }
    }
}

/// Prompt an agent with images.
pub async fn prompt_agent_with_images(
    agent_id: &str,
    message: &str,
    images: Vec<ergatai_runtime::AgentImage>,
) -> anyhow::Result<()> {
    crate::context::get_app_context()
        .agent_runtime
        .inject_message_with_images(agent_id, message, images)
        .await?;
    Ok(())
}

/// Prompt an agent with persistence.
pub async fn prompt_agent_with_persistence(
    agent_id: &str,
    prompt: PendingPrompt,
    _session_id: Option<&str>,
) -> anyhow::Result<()> {
    prompt_agent_with_images(agent_id, &prompt.message, prompt.images).await
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
            let runtime_id = binding.agent_id;
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_dispatch_lock_creation() {
        let lock1 = dispatch_lock("agent-1").unwrap();
        let lock2 = dispatch_lock("agent-1").unwrap();

        // Same agent should get the same lock
        assert!(std::sync::Arc::ptr_eq(&lock1, &lock2));
    }

    #[test]
    fn test_dispatch_lock_different_agents() {
        let lock1 = dispatch_lock("agent-1").unwrap();
        let lock2 = dispatch_lock("agent-2").unwrap();

        // Different agents should get different locks
        assert!(!std::sync::Arc::ptr_eq(&lock1, &lock2));
    }

    #[test]
    fn test_prompt_queue_state_initialization() {
        let state = prompt_queue_state();
        // Should not panic and should be accessible
        assert!(state.queues.lock().is_ok());
        assert!(state.dispatch_locks.lock().is_ok());
    }
}
