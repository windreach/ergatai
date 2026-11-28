//! Agent service — 统一 agent 查询和 ACP backend 访问。
//!
//! 将 handler 中重复的 backend trait 方法调用封装到 service 层，
//! handler 只负责 HTTP 协议细节（响应格式化、状态码映射）。

use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::{Mutex, OnceLock};

use ergatai_error::{id::parse_to_i64, ChatId, ConversationId, ErgataiError};
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

/// Conversation currently being prompted, per runtime agent. Set at every
/// prompt dispatch point so SSE stream consumers can attribute output events
/// to the conversation that produced them — an agent is just a launch
/// configuration; the conversation is the unit of execution.
pub fn set_current_prompt_conversation(agent_id: &str, conversation_id: Option<String>) {
    ergatai_runtime::set_current_prompt_conversation(agent_id, conversation_id);
}

pub fn get_current_prompt_conversation(agent_id: &str) -> Option<String> {
    ergatai_runtime::get_current_prompt_conversation(agent_id)
}

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

/// Read the live model selected in the agent's ACP config options, if any.
pub async fn get_agent_current_model(agent_id: &str) -> Option<String> {
    get_agent_config_options(agent_id)
        .await
        .ok()
        .flatten()
        .and_then(|options| {
            crate::services::agent::acp::extract_models_from_config_options(&options)
        })
        .and_then(|detected| detected.current)
}

/// Get token usage statistics for an agent as `(input_tokens, output_tokens)`.
pub async fn get_agent_usage(agent_id: &str) -> anyhow::Result<Option<(usize, usize)>> {
    Ok(backend().usage(agent_id).await?)
}

/// Get the latest parsed ACP extension metadata for an agent, if any.
pub async fn get_agent_extension_meta(
    agent_id: &str,
) -> anyhow::Result<Option<ergatai_runtime::acp_extension::ExtensionMeta>> {
    Ok(backend().extension_meta(agent_id).await?)
}

/// Get ephemeral in-memory subagent runs for an agent.
pub async fn get_agent_subagent_runs(
    agent_id: &str,
) -> anyhow::Result<Vec<ergatai_runtime::SubagentRun>> {
    Ok(backend().subagent_runs(agent_id).await?)
}

/// Get the composed ephemeral subagent runtime for an agent.
pub async fn get_agent_subagent_runtime(
    agent_id: &str,
) -> anyhow::Result<ergatai_runtime::SubagentRuntime> {
    Ok(backend().subagent_runtime(agent_id).await?)
}

/// Get captured output for an agent (non-destructive read).
pub async fn get_agent_output(agent_id: &str) -> anyhow::Result<Option<String>> {
    Ok(backend().output(agent_id).await?)
}

/// Get the time elapsed since the agent's last structured activity.
pub async fn get_agent_last_activity_age(
    agent_id: &str,
) -> anyhow::Result<Option<std::time::Duration>> {
    Ok(backend().agent_last_activity_age(agent_id).await?)
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

/// Resolve an agent ID (runtime ID or MCP agent ID) to a runtime ID.
/// Returns `None` if the agent is not found or not running.
pub async fn resolve_to_runtime_id(agent_id: &str) -> Option<String> {
    // Delegate to resolve_agent_id which handles:
    // 1. Direct lookup by runtime ID
    // 2. MCP agent ID lookup via bindings
    resolve_agent_id(agent_id).await
}

/// Try to auto-resume a suspended agent.
///
/// This is the shared auto-resume logic used by both the HTTP prompt path
/// (`prompt_agent` handler) and the MCP messaging path (`send_message`).
/// It tries three strategies in order:
/// 1. Look up suspended agent by agent ID
/// 2. Look up suspended agent by conversation_id
/// 3. Look up running agent by conversation_id (handles race conditions)
///
/// Returns the new agent ID if resume succeeded, or the existing agent ID
/// if a running agent with matching conversation_id is found.
///
/// # Concurrency
///
/// Step 3 performs a check-then-act over the running agent list. Callers in
/// `MessageSender::send` serialize target resolution with a per-target lock
/// (`spawn_lock`) so concurrent sends cannot both observe "no agent" and
/// create duplicates. Direct callers should hold an equivalent lock when
/// invoking this in a concurrent context.
/// Resume through the unified launch service so the provider environment and
/// durable conversation model are restored consistently with explicit resume.
async fn resume_via_launch_service(
    _runtime: &ergatai_runtime::AgentRuntime,
    suspended_id: &str,
    conversation_id: &str,
) -> Option<String> {
    let Ok(conversation_id) = ConversationId::decode(conversation_id) else {
        tracing::warn!(
            suspended_id = %suspended_id,
            conversation_id = %conversation_id,
            "Cannot resume through launch service: invalid conversation ID"
        );
        return None;
    };
    let request = crate::services::agent_launch::EnsureAgentRequest {
        conversation_id: Some(conversation_id),
        profile: None,
        workspace_id: None,
        work_dir: None,
        provider_connection_id: None,
        model: crate::services::agent_launch::ModelInput::None,
        mode: crate::services::agent_launch::LaunchMode::ResumeOnly,
        env: Default::default(),
        allow_native_default: false,
    };
    let service = crate::context::get_app_context().agent_launch.clone();
    match service.ensure(request).await {
        Ok(result) => Some(result.agent_id),
        Err(error) => {
            tracing::warn!(
                suspended_id = %suspended_id,
                conversation_id = %conversation_id,
                error = %error,
                "Unified launch service failed to resume suspended agent"
            );
            None
        }
    }
}

pub async fn try_auto_resume_suspended_agent(
    runtime: &ergatai_runtime::AgentRuntime,
    target: &str,
    conversation_id: Option<&str>,
) -> Option<String> {
    // Step 1: Check if target matches a suspended agent ID
    if let Ok(Some(suspended)) = runtime.suspend_store().load_suspended(target) {
        tracing::info!(
            target = target,
            suspended_id = %suspended.id,
            conversation_id = %suspended.conversation_id,
            "Found suspended agent by ID, attempting resume"
        );

        match resume_via_launch_service(runtime, &suspended.id, &suspended.conversation_id).await {
            Some(new_agent_id) => {
                tracing::info!(
                    suspended_id = %suspended.id,
                    new_agent_id = %new_agent_id,
                    "Successfully resumed suspended agent by ID"
                );
                return Some(new_agent_id);
            }
            None => {
                tracing::warn!(
                    suspended_id = %suspended.id,
                    "Failed to resume suspended agent by ID"
                );
                return None;
            }
        }
    }

    // Step 2: Check if conversation_id matches a suspended agent
    if let Some(conversation_id) = conversation_id {
        if let Ok(Some(suspended)) = runtime
            .suspend_store()
            .find_by_conversation(conversation_id)
        {
            tracing::info!(
                conversation_id = %conversation_id,
                suspended_id = %suspended.id,
                "Found suspended agent by conversation_id, attempting resume"
            );

            match resume_via_launch_service(runtime, &suspended.id, conversation_id).await {
                Some(new_agent_id) => {
                    tracing::info!(
                        suspended_id = %suspended.id,
                        new_agent_id = %new_agent_id,
                        conversation_id = %conversation_id,
                        "Successfully resumed suspended agent by conversation_id"
                    );
                    return Some(new_agent_id);
                }
                None => {
                    tracing::warn!(
                        suspended_id = %suspended.id,
                        conversation_id = %conversation_id,
                        "Failed to resume suspended agent by conversation_id"
                    );
                    return None;
                }
            }
        }
    }

    // NOTE: Do not fall back to "any suspended agent whose profile matches the
    // target string". Suspended records are historical; picking one by
    // `max(suspended_at)` silently resumes an unrelated conversation and starts
    // a duplicate process. Name-style targets must be scoped by the caller's
    // chat (see `MessageSender::resolve_target_in_sender_chat`), which maps the
    // name to the chat's conversation and then resumes by `conversation_id`
    // above.

    // Step 3: Locate a running agent bound to this conversation.
    //
    // Prefer the runtime registry's conversation index (O(1), authoritative)
    // over scanning agent metadata. Fall back to a metadata scan only for
    // legacy agents that predate the conversation_index binding, so older
    // in-flight processes are still recoverable.
    if let Some(conversation_id) = conversation_id {
        if let Some(info) = runtime
            .registry()
            .resolve_conversation_id(conversation_id)
            .await
        {
            if info.lifecycle.is_alive() {
                tracing::debug!(
                    conversation_id = %conversation_id,
                    agent_id = %info.agent_id,
                    "Found running agent via conversation index"
                );
                return Some(info.agent_id);
            }
        }

        let agents = runtime.list_agents().await;
        for agent in agents {
            let matches = agent.conversation_id.as_deref() == Some(conversation_id)
                || agent.handle.workspace.metadata.get("conversation_id")
                    == Some(&conversation_id.to_string())
                || agent
                    .handle
                    .workspace
                    .metadata
                    .get("ergatai_conversation_id")
                    == Some(&conversation_id.to_string())
                || agent.handle.metadata.get("conversation_id")
                    == Some(&conversation_id.to_string())
                || agent.handle.metadata.get("ergatai_conversation_id")
                    == Some(&conversation_id.to_string());

            if matches && agent.lifecycle.is_alive() {
                tracing::debug!(
                    conversation_id = %conversation_id,
                    agent_id = %agent.agent_id,
                    "Found running agent via metadata fallback"
                );
                return Some(agent.agent_id);
            }
        }
    }

    None
}

/// Resolve a running runtime agent ID for a conversation, auto-resuming a
/// suspended one when necessary.
///
/// Conversation is the single anchor here: a running agent bound to the
/// conversation is preferred over any stale agent ID the caller may still
/// hold. This is the shared entry point that prompt/stream/messaging paths
/// should use instead of re-implementing the suspended-agent lookup.
static CONVERSATION_RESOLVE_LOCKS: OnceLock<
    Mutex<HashMap<String, std::sync::Arc<tokio::sync::Mutex<()>>>>,
> = OnceLock::new();

fn conversation_resolve_lock(conv: &str) -> std::sync::Arc<tokio::sync::Mutex<()>> {
    CONVERSATION_RESOLVE_LOCKS
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .entry(conv.to_string())
        .or_default()
        .clone()
}

pub async fn resolve_agent_for_conversation(conversation_id: &str) -> Option<String> {
    let lock = conversation_resolve_lock(conversation_id);
    let _guard = lock.lock().await;

    let runtime = crate::context::get_app_context().agent_runtime.clone();

    // 1. Already running and bound to this conversation.
    if let Some(info) = runtime
        .registry()
        .resolve_conversation_id(conversation_id)
        .await
    {
        if info.lifecycle.is_alive() {
            return Some(info.agent_id);
        }
    }

    // 2. Durable binding from a previous run (survives backend restart).
    if let Ok(conv_id) = ConversationId::decode(conversation_id) {
        if let Ok(Some(agent_id)) =
            crate::user_data_db::conversations::get_current_agent_id(conv_id)
        {
            if let Some(info) = runtime.get_agent(&agent_id).await {
                if info.lifecycle.is_alive() {
                    // Re-register in-memory binding for O(1) lookups.
                    let _ = runtime
                        .registry()
                        .update(&agent_id, |i| {
                            i.conversation_id = Some(conversation_id.to_string());
                        })
                        .await;
                    return Some(agent_id);
                }
            }
        }
    }

    // 3. Resume a suspended agent for this conversation.
    let resumed =
        try_auto_resume_suspended_agent(&runtime, conversation_id, Some(conversation_id)).await;

    // Persist the new binding so future restarts can recover without resume.
    if let Some(resumed_id) = resumed.as_ref() {
        if let Ok(conv_id) = ConversationId::decode(conversation_id) {
            let _ =
                crate::user_data_db::conversations::set_current_agent_id(conv_id, Some(resumed_id));
        }
    }

    resumed
}

/// Resolve a runtime agent ID for an incoming request.
///
/// Conversation takes precedence over any (possibly stale) agent ID, so a
/// resumed agent with a new runtime ID is transparently reused. Falls back
/// to direct agent-ID resolution and suspended-agent lookup by ID when no
/// conversation binding is available.
pub async fn resolve_agent_for_request(
    target_agent_id: &str,
    conversation_id: Option<&str>,
) -> Option<String> {
    if let Some(conv) = conversation_id {
        if let Some(rid) = resolve_agent_for_conversation(conv).await {
            return Some(rid);
        }
    }

    if let Some(rid) = resolve_to_runtime_id(target_agent_id).await {
        return Some(rid);
    }

    let runtime = crate::context::get_app_context().agent_runtime.clone();
    try_auto_resume_suspended_agent(&runtime, target_agent_id, conversation_id).await
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
    pub files: Vec<ergatai_runtime::AgentFile>,
    pub conversation_id: Option<String>,
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

    prompt_agent_with_images(
        &prompt.agent_id,
        &prompt.message,
        prompt.images,
        prompt.files,
        prompt.conversation_id,
    )
    .await
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

/// Save file attachments and prepare the prompt/resources used for delivery.
///
/// OpenCode receives ACP resource links for saved files. Other agent kinds
/// receive absolute paths appended to the prompt so their file tools can read
/// the attachments. Keeping this in one place makes direct prompts, NATS
/// delivery, and durable initial prompts behave consistently.
pub fn prepare_file_attachments(
    message: &str,
    files: &[ergatai_runtime::AgentFile],
    agent_kind: Option<&str>,
    conversation_id: Option<&str>,
) -> anyhow::Result<(String, Vec<ergatai_runtime::AgentResource>)> {
    if files.is_empty() {
        return Ok((message.to_string(), Vec::new()));
    }

    let saved_paths = save_file_attachments(files, conversation_id)?;
    if agent_kind == Some("opencode") {
        let resources = files
            .iter()
            .zip(saved_paths)
            .map(|(file, (_filename, path))| ergatai_runtime::AgentResource {
                uri: format!("file://{}", path),
                name: Some(file.filename.clone()),
                mime_type: file.media_type.clone(),
                text: None,
                blob: None,
            })
            .collect();
        Ok((message.to_string(), resources))
    } else {
        let mut prepared_message = message.to_string();
        for (_filename, path) in &saved_paths {
            prepared_message.push_str(&format!("\n{}", path));
        }
        Ok((prepared_message, Vec::new()))
    }
}

/// Prompt an agent with images and file attachments.
///
/// Files are decoded from base64, saved to the attachments directory, and
/// the resulting file paths are appended to the message so the agent can
/// read them with its own file tools.
pub async fn prompt_agent_with_images(
    agent_id: &str,
    message: &str,
    images: Vec<ergatai_runtime::AgentImage>,
    files: Vec<ergatai_runtime::AgentFile>,
    conversation_id: Option<String>,
) -> anyhow::Result<()> {
    // Resolve agent kind for agent-specific skill conversion rules.
    let runtime = crate::context::get_app_context().agent_runtime.clone();
    let agent_kind = if let Some(info) = runtime.get_agent(agent_id).await {
        if let Some(profile_name) = info.profile.as_deref() {
            crate::services::agent::resolve_kind_by_name(profile_name).await
        } else {
            crate::services::agent::AgentKind::Unknown
        }
    } else {
        crate::services::agent::AgentKind::Unknown
    };
    let agent_kind_str = agent_kind.as_str();

    // Backend prompt-processing hook: convert Ergatai discovery/mention tokens
    // (e.g. @[file:...], @[skill:...]) into agent-native prompt text before
    // delivery. Raw tokens are kept in storage; transformation happens here.
    let message =
        crate::services::initial_prompt_turns::convert_prompt_tokens(message, agent_kind_str);
    let (message, resources) =
        prepare_file_attachments(&message, &files, agent_kind_str, conversation_id.as_deref())?;

    set_current_prompt_conversation(agent_id, conversation_id.clone());
    if resources.is_empty() {
        crate::context::get_app_context()
            .agent_runtime
            .inject_message_with_images(agent_id, &message, images)
            .await?;
    } else {
        crate::context::get_app_context()
            .agent_runtime
            .inject_message_with_resources(agent_id, &message, images, resources)
            .await?;
    }
    Ok(())
}

/// Prompt an agent with persistence.
pub async fn prompt_agent_with_persistence(
    agent_id: &str,
    prompt: PendingPrompt,
    _session_id: Option<&str>,
) -> anyhow::Result<()> {
    prompt_agent_with_images(
        agent_id,
        &prompt.message,
        prompt.images,
        prompt.files,
        prompt.conversation_id,
    )
    .await
}

/// Save base64 file attachments to the local attachments directory.
///
/// Files are written to `~/.local/share/ergatai/attachments/{conversation_id or "default"}/`
/// and the (filename, absolute_path) pairs are returned.
pub fn save_file_attachments(
    files: &[ergatai_runtime::AgentFile],
    conversation_id: Option<&str>,
) -> anyhow::Result<Vec<(String, String)>> {
    use base64::Engine;

    let dir = dirs::data_dir()
        .unwrap_or_else(|| std::path::PathBuf::from("/tmp"))
        .join("ergatai")
        .join("attachments")
        .join(conversation_id.unwrap_or("default"));
    std::fs::create_dir_all(&dir)?;

    let mut results = Vec::new();
    let mut used_names = std::collections::HashSet::new();
    for file in files {
        file.validate()?;
        let data = base64::engine::general_purpose::STANDARD
            .decode(&file.base64_data)
            .map_err(|e| anyhow::anyhow!("Failed to decode file '{}': {}", file.filename, e))?;

        // Sanitize filename to prevent path traversal and other attacks
        let base_safe_name = sanitize_filename(&file.filename);

        // Deduplicate: if the same sanitized name is used by multiple files
        // (e.g. "a/report.csv" and "b/report.csv" both sanitize to "report.csv"),
        // append a counter to avoid silent overwrites.
        let safe_name = deduplicate_filename(&base_safe_name, &used_names);
        used_names.insert(safe_name.clone());

        let path = dir.join(&safe_name);
        std::fs::write(&path, &data)?;
        results.push((file.filename.clone(), path.to_string_lossy().to_string()));
        tracing::info!(
            filename = %file.filename,
            path = %path.display(),
            size_bytes = data.len(),
            "Saved file attachment for agent prompt"
        );
    }
    Ok(results)
}

/// Deduplicate a filename by appending a counter if the name is already in use.
///
/// E.g., "report.csv" → "report (1).csv" → "report (2).csv"
///
/// When many files collide (counter > 10,000), falls back to a millisecond-timestamp
/// suffix to avoid an unbounded loop.
fn deduplicate_filename(base_name: &str, used_names: &std::collections::HashSet<String>) -> String {
    if !used_names.contains(base_name) {
        return base_name.to_string();
    }

    // Split into stem and extension at the LAST dot (preserve compound extensions like .tar.gz)
    let (stem, ext) = match base_name.rfind('.') {
        Some(0) | None => (base_name.as_bytes(), b"".as_slice()),
        Some(dot_pos) => (
            &base_name.as_bytes()[..dot_pos],
            &base_name.as_bytes()[dot_pos..],
        ),
    };

    // Try counter suffixes until we find an unused name
    let mut counter = 1u64;
    loop {
        let candidate = format!(
            "{} ({}){}",
            String::from_utf8_lossy(stem),
            counter,
            String::from_utf8_lossy(ext)
        );
        if !used_names.contains(&candidate) {
            tracing::warn!(
                original = %base_name,
                deduplicated = %candidate,
                "File name collision detected; deduplicated with counter suffix"
            );
            return candidate;
        }
        counter += 1;
        // Safety bound: avoid unbounded loop in pathological cases
        if counter > 10_000 {
            let ts = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis())
                .unwrap_or(0);
            let fallback = format!(
                "{}_{}{}",
                String::from_utf8_lossy(stem),
                ts,
                String::from_utf8_lossy(ext)
            );
            tracing::warn!(
                original = %base_name,
                deduplicated = %fallback,
                "File name collision detected (>10k collisions); deduplicated with timestamp suffix"
            );
            return fallback;
        }
    }
}

/// Sanitize a filename to prevent path traversal and other attacks.
/// Removes or replaces dangerous characters and limits length.
fn sanitize_filename(filename: &str) -> String {
    // Replace path separators and dangerous characters
    let sanitized: String = filename
        .chars()
        .map(|c| match c {
            '/' | '\\' | '\0' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
            _ => c,
        })
        .collect();

    // Remove leading dots and spaces (prevent hidden files and trailing spaces on Windows)
    let sanitized = sanitized.trim_start_matches(['.', ' ']);

    // Remove all path traversal sequences (.., ..., etc.)
    // Use a loop to handle cases like "...//..." which become "////" after first pass
    let mut prev = String::new();
    let mut current = sanitized.to_string();
    while prev != current {
        prev = current.clone();
        current = current.replace("..", "");
    }
    let sanitized = current;

    // Remove any remaining path separators that might have been created
    let sanitized = sanitized.replace(['/', '\\'], "");

    // Check for reserved Windows filenames (case-insensitive)
    let reserved_names = [
        "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
        "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
    ];
    let sanitized_upper = sanitized.to_uppercase();
    let base_name = sanitized_upper.split('.').next().unwrap_or("");
    let sanitized = if reserved_names.contains(&base_name) {
        // Prefix with underscore to make it safe
        format!("_{}", sanitized)
    } else {
        sanitized
    };

    // Limit length to 255 characters (common filesystem limit)
    // Use chars().take() instead of byte slicing to avoid splitting multi-byte UTF-8 characters
    let sanitized: String = if sanitized.chars().count() > 255 {
        sanitized.chars().take(255).collect()
    } else {
        sanitized
    };

    // If filename is empty after sanitization, use a default name
    if sanitized.is_empty() {
        "unnamed_file".to_string()
    } else {
        sanitized
    }
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

/// Switch the model of a running agent.
///
/// Prefers agent SDK switching when available (e.g. OpenCode HTTP session model API),
/// then ACP `session/set_model`, then falls back to the `/model` slash command.
pub async fn set_agent(agent_id: &str, model: &str) -> anyhow::Result<String> {
    set_agent_with_context(agent_id, model, None, "user_selected").await
}

/// Split a Codex model reference into its base model and optional effort.
///
/// The UI stores `model/effort` (for example `gpt-5.3-codex/high`), while
/// codex-acp's `session/set_model` requires `model[effort]`. Accept both
/// spellings and leave the effort unset for a bare model.
fn split_codex_model(model: &str) -> (String, Option<String>) {
    let trimmed = model.trim();

    if let Some(open) = trimmed.rfind('[') {
        if trimmed.ends_with(']') && open > 0 {
            let effort = &trimmed[open + 1..trimmed.len() - 1];
            if !effort.is_empty() {
                return (trimmed[..open].to_string(), Some(effort.to_string()));
            }
        }
    }

    if let Some((base, effort)) = trimmed.rsplit_once('/') {
        if !base.is_empty() && !effort.is_empty() {
            return (base.to_string(), Some(effort.to_string()));
        }
    }

    (trimmed.to_string(), None)
}

/// Resolve a requested Codex model against the live `model` config option.
///
/// Exact matches win so provider-qualified model IDs that contain `/` are not
/// mistaken for a model/effort pair. `None` means the requested base model is
/// not offered by the running agent.
fn resolve_codex_model(
    requested: &str,
    candidates: &[&agent_client_protocol::schema::v1::SessionConfigSelectOption],
) -> Option<(String, Option<String>)> {
    if candidates
        .iter()
        .any(|option| *option.value.0 == *requested)
    {
        return Some((requested.to_string(), None));
    }

    let (base, effort) = split_codex_model(requested);
    if candidates.iter().any(|option| *option.value.0 == base) {
        Some((base, effort))
    } else {
        None
    }
}

/// Apply a model through ACP, preserving the legacy fallback order.
async fn apply_acp_model(
    backend: &dyn ergatai_runtime::AcpBackendInterface,
    agent_id: &str,
    model: &str,
) -> anyhow::Result<()> {
    match backend.set_session_model(agent_id, model).await {
        Ok(()) => Ok(()),
        Err(e1) => {
            tracing::debug!(
                agent_id = %agent_id,
                error = %e1,
                "ACP set_session_model unavailable, trying session config option"
            );
            backend
                .set_session_config_option(agent_id, "model", model)
                .await
                .map_err(|e2| anyhow::anyhow!("ACP model switching unavailable: {}", e2))
        }
    }
}

/// Apply a Codex model using the adapter's required `model[effort]` spelling.
///
/// `session/set_model` is authoritative when an effort is present. Older
/// adapters only expose the `model` config option, so a failure there falls
/// back to setting the base model (and `reasoning_effort` when available).
async fn apply_codex_model(
    backend: &dyn ergatai_runtime::AcpBackendInterface,
    agent_id: &str,
    base: &str,
    effort: Option<&str>,
) -> anyhow::Result<()> {
    let primary = match effort {
        Some(effort) => {
            backend
                .set_session_model(agent_id, &format!("{base}[{effort}]"))
                .await
        }
        None => {
            backend
                .set_session_config_option(agent_id, "model", base)
                .await
        }
    };

    match primary {
        Ok(()) => Ok(()),
        Err(primary_error) => {
            if effort.is_none() {
                tracing::warn!(
                    agent_id = %agent_id,
                    error = %primary_error,
                    "ACP model switching unavailable"
                );
                return Err(anyhow::anyhow!(
                    "ACP model switching unavailable: {}",
                    primary_error
                ));
            }

            tracing::debug!(
                agent_id = %agent_id,
                error = %primary_error,
                "Codex set_session_model unavailable, trying session config option"
            );
            backend
                .set_session_config_option(agent_id, "model", base)
                .await
                .map_err(|error| {
                    tracing::warn!(
                        agent_id = %agent_id,
                        error = %error,
                        "ACP model switching unavailable"
                    );
                    anyhow::anyhow!("ACP model switching unavailable: {}", error)
                })?;

            if let Some(effort) = effort {
                if let Err(error) = backend
                    .set_session_config_option(agent_id, "reasoning_effort", effort)
                    .await
                {
                    tracing::debug!(
                        agent_id = %agent_id,
                        effort = %effort,
                        error = %error,
                        "Codex reasoning_effort option unavailable"
                    );
                }
            }

            Ok(())
        }
    }
}

/// Apply a model and persist both the runtime row and (when known) the
/// conversation key. Persistence is awaited so callers cannot observe a
/// successful switch before the durable row exists.
pub async fn set_agent_with_context(
    agent_id: &str,
    model: &str,
    conversation_id: Option<ConversationId>,
    source: &str,
) -> anyhow::Result<String> {
    let model_trimmed = model.trim();
    if model_trimmed.is_empty() {
        return Err(anyhow::anyhow!("model must not be empty"));
    }

    // Runtime model switching must happen inside the running ACP process.
    // SDK-based switching runs in a separate process and cannot reliably mutate
    // the active ACP session, so it is intentionally not used here.

    let backend = backend();

    // Resolve the agent kind so OpenCode can skip the unsupported
    // `session/set_model` request and avoid noisy method-not-found logs.
    let runtime = crate::context::get_app_context().agent_runtime.clone();
    let agent_kind = if let Some(info) = runtime.get_agent(agent_id).await {
        if let Some(profile_name) = info.profile.as_deref() {
            crate::services::agent::resolve_kind_by_name(profile_name).await
        } else {
            crate::services::agent::AgentKind::Unknown
        }
    } else {
        crate::services::agent::AgentKind::Unknown
    };

    // Normalize the requested model to an ID actually supported by the running
    // ACP agent. Agents such as OpenCode expose provider-qualified IDs (e.g.
    // `opencode-go/iceman-contributor-free`) in their `model` config option,
    // while callers may pass the bare model name.
    //
    // Codex needs one extra step: the UI stores `model/effort` but codex-acp's
    // `session/set_model` only accepts `model[effort]`. Resolve the base model
    // against the live options and keep the effort for the apply step.
    let requested_model = model_trimmed.to_string();
    let mut model_to_apply = requested_model.clone();
    let mut codex_target: Option<(String, Option<String>)> = None;

    if let Ok(Some(options)) = backend.config_options(agent_id).await {
        if let Some(model_option) = options.iter().find(|o| &*o.id.0 == "model") {
            let mut candidates: Vec<&agent_client_protocol::schema::v1::SessionConfigSelectOption> =
                Vec::new();
            if let agent_client_protocol::schema::v1::SessionConfigKind::Select(select) =
                &model_option.kind
            {
                match &select.options {
                    agent_client_protocol::schema::v1::SessionConfigSelectOptions::Ungrouped(
                        opts,
                    ) => {
                        candidates.extend(opts.iter());
                    }
                    agent_client_protocol::schema::v1::SessionConfigSelectOptions::Grouped(
                        groups,
                    ) => {
                        for group in groups {
                            candidates.extend(group.options.iter());
                        }
                    }
                    _ => {}
                }
            }

            if agent_kind == crate::services::agent::AgentKind::Codex {
                match resolve_codex_model(&requested_model, &candidates) {
                    Some((base, effort)) => {
                        model_to_apply = match effort.as_deref() {
                            Some(effort) => format!("{}/{}", base, effort),
                            None => base.clone(),
                        };
                        codex_target = Some((base, effort));
                    }
                    None => {
                        let available = candidates
                            .iter()
                            .map(|option| option.value.0.to_string())
                            .collect::<Vec<_>>()
                            .join(", ");
                        let available = if available.is_empty() {
                            "the agent did not report any models".to_string()
                        } else {
                            available
                        };
                        return Err(anyhow::anyhow!(
                            "Model '{}' is not available for Codex. Available models: {}",
                            requested_model,
                            available
                        ));
                    }
                }
            } else if candidates
                .iter()
                .any(|v| &*v.value.0 == requested_model.as_str())
            {
                // Exact match first.
                model_to_apply = requested_model.clone();
            } else {
                // Suffix / name match for bare IDs.
                model_to_apply = candidates
                    .iter()
                    .find_map(|v| {
                        let value = v.value.0.clone();
                        if &*value == requested_model.as_str()
                            || value.ends_with(&format!("/{}", requested_model))
                            || v.name == requested_model
                        {
                            Some(value.to_string())
                        } else {
                            None
                        }
                    })
                    .unwrap_or_else(|| requested_model.clone());
            }
        }
    }

    let result = if agent_kind == crate::services::agent::AgentKind::OpenCode {
        // OpenCode ACP does not support `session/set_model`; use config option directly.
        match backend
            .set_session_config_option(agent_id, "model", &model_to_apply)
            .await
        {
            Ok(()) => Ok(String::new()),
            Err(e2) => {
                tracing::warn!(
                    agent_id = %agent_id,
                    error = %e2,
                    "ACP model switching unavailable"
                );
                Err(anyhow::anyhow!("ACP model switching unavailable: {}", e2))
            }
        }
    } else if let Some((base, effort)) = codex_target.as_ref() {
        apply_codex_model(backend.as_ref(), agent_id, base, effort.as_deref())
            .await
            .map(|_| String::new())
    } else {
        apply_acp_model(backend.as_ref(), agent_id, &model_to_apply)
            .await
            .map(|_| String::new())
    };

    // Persist runtime selected model synchronously. Callers must not observe a
    // successful switch before the durable row (including its conversation
    // key) exists.
    if result.is_ok() {
        let agent_id_owned = agent_id.to_string();
        let model_owned = model_to_apply.clone();
        let source_owned = source.to_string();
        let profile_name = crate::context::get_app_context()
            .agent_runtime
            .get_agent(agent_id)
            .await
            .and_then(|info| info.profile.clone());
        let _ = tokio::task::spawn_blocking(move || {
            if let Err(error) = crate::user_data_db::set_agent_runtime_model_full(
                &agent_id_owned,
                profile_name.as_deref(),
                conversation_id,
                Some(&model_owned),
                None,
                &source_owned,
            ) {
                tracing::warn!(
                    agent_id = %agent_id_owned,
                    error = %error,
                    "Failed to persist runtime model selection"
                );
            }

            if let Some(conversation_id) = conversation_id {
                // Preserve the provider binding: switching a model must not
                // silently drop the credentials the conversation launched with.
                let existing =
                    crate::user_data_db::conversation_launch_settings::get(conversation_id)
                        .ok()
                        .flatten();
                let provider_connection_id = existing
                    .as_ref()
                    .and_then(|row| row.provider_connection_id.as_deref());
                let source = crate::services::agent_launch::ModelSource::parse(&source_owned)
                    .unwrap_or(crate::services::agent_launch::ModelSource::ConversationUser);
                let selection = crate::services::agent_launch::ModelSelection::new(model_owned);
                if let Err(error) = crate::services::agent_launch::settings::save(
                    conversation_id,
                    profile_name.as_deref(),
                    &selection,
                    source,
                    provider_connection_id,
                ) {
                    tracing::warn!(
                        conversation_id = %conversation_id,
                        error = %error,
                        "Failed to persist conversation model selection"
                    );
                }
            }
        })
        .await;
    }

    result
}

/// List available ACP sessions for an agent.
pub async fn list_agent_sessions(
    agent_id: &str,
) -> anyhow::Result<Vec<ergatai_runtime::SessionInfo>> {
    Ok(backend().list_sessions(agent_id).await?)
}

pub async fn resume_session_capture(
    agent_id: &str,
    session_id: &str,
    cwd: &str,
    max_messages: usize,
) -> anyhow::Result<Vec<serde_json::Value>> {
    Ok(backend()
        .resume_session_capture(agent_id, session_id, cwd, max_messages)
        .await?)
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
    /// Calling agent ID, used to derive its runtime registry scope.
    pub caller_agent_id: Option<String>,
    /// Calling agent workspace, used when the caller is unavailable.
    pub caller_workspace_id: Option<String>,
}

/// A single agent entry returned by [`list_agents_filtered`].
///
/// Contains the common fields needed by both REST and MCP consumers. Each
/// caller may enrich the response with additional fields (e.g., MCP adds
/// `ergatai_agent_id` and `status`, REST adds `session_title`).
pub struct AgentListItem {
    pub agent_id: String,
    pub workspace_id: String,
    /// Stable conversation routing identity bound to this runtime agent.
    pub conversation_id: Option<String>,
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
    /// Where this entry came from: the live runtime registry.
    pub source: String,
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

    let caller_info = if let Some(ref caller_agent_id) = filter.caller_agent_id {
        match resolve_to_runtime_id(caller_agent_id).await {
            Some(runtime_id) => get_agent_info(&runtime_id).await,
            None => None,
        }
    } else {
        None
    };
    let dag_query = filter.in_dag.is_some();
    let workspace_id = if dag_query {
        None
    } else {
        filter
            .caller_workspace_id
            .clone()
            .or_else(|| caller_info.as_ref().map(|info| info.workspace_id.clone()))
    };
    let chat_id = if dag_query {
        None
    } else {
        caller_info.as_ref().and_then(|info| {
            info.handle
                .workspace
                .metadata
                .get("ergatai_chat_id")
                .cloned()
        })
    };

    let mut items = runtime_agents
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
            if let Some(ref expected_workspace_id) = workspace_id {
                if &info.workspace_id != expected_workspace_id {
                    return false;
                }
            }
            if let Some(expected_chat_id) = &chat_id {
                if info.handle.workspace.metadata.get("ergatai_chat_id") != Some(expected_chat_id) {
                    return false;
                }
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
                workspace_id: a.workspace_id,
                conversation_id: a.conversation_id,
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
                source: "runtime".to_string(),
            }
        })
        .collect::<Vec<_>>();

    // Suspended agents are not in the live runtime registry because their
    // process has stopped. They are still persistent agent identities, so the
    // API returns them as non-alive `suspended` entries (with the profile and
    // conversation needed by callers to resume/route them).
    let live_agent_ids: HashSet<String> = items.iter().map(|item| item.agent_id.clone()).collect();
    let suspended_agents = match runtime.suspend_store().list_suspended() {
        Ok(agents) => agents,
        Err(e) => {
            tracing::warn!("Failed to list suspended agents: {}", e);
            Vec::new()
        }
    };
    for record in suspended_agents {
        if live_agent_ids.contains(&record.id) {
            continue;
        }
        if let Some(ref expected_workspace_id) = workspace_id {
            if &record.workspace_id != expected_workspace_id {
                continue;
            }
        }
        if let Some(expected_chat_id) = &chat_id {
            let environment: serde_json::Value =
                serde_json::from_str(&record.environment).unwrap_or(serde_json::Value::Null);
            if environment
                .get("ergatai_chat_id")
                .and_then(|value| value.as_str())
                != Some(expected_chat_id.as_str())
            {
                continue;
            }
        }
        if let Some(ref participants) = dag_participants {
            if !participants.contains(&record.id) {
                continue;
            }
        }
        if let Some(ref status) = status_filter {
            if status != "suspended" {
                continue;
            }
        }

        items.push(AgentListItem {
            agent_id: record.id,
            workspace_id: record.workspace_id,
            conversation_id: record
                .conversation_id
                .starts_with("conv_")
                .then(|| record.conversation_id.clone()),
            state: "suspended".to_string(),
            task_id: None,
            mcp_agent_id: None,
            is_alive: false,
            is_idle: false,
            is_processing: false,
            created_at: record.suspended_at.to_rfc3339(),
            last_heartbeat: record.last_activity.to_rfc3339(),
            work_dir: record.work_dir,
            profile: Some(record.profile_name),
            capabilities: Vec::new(),
            state_changed_at: record.suspended_at.to_rfc3339(),
            state_history: Vec::new(),
            source: "suspend-store".to_string(),
        });
    }

    items
}

// ── Agent ID resolution (used by MCP server.rs) ──

/// Resolve an agent ID to a runtime agent ID.
///
/// Tries:
/// 1. Direct lookup by runtime ID (e.g., "agent_502816809136_000_0001")
/// 2. Lookup by MCP agent ID (e.g., "agent-1")
///
/// Note: Profile names are NOT resolved here because profiles are templates,
/// not running agent instances. Multiple agents can be created from the same profile.
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

    // Resolve agent kind for agent-specific skill conversion rules.
    let runtime_for_kind = crate::context::get_app_context().agent_runtime.clone();
    let agent_kind = if let Some(info) = runtime_for_kind.get_agent(agent_id).await {
        if let Some(profile_name) = info.profile.as_deref() {
            crate::services::agent::resolve_kind_by_name(profile_name).await
        } else {
            crate::services::agent::AgentKind::Unknown
        }
    } else {
        crate::services::agent::AgentKind::Unknown
    };
    let agent_kind_str = agent_kind.as_str();

    // Backend prompt-processing hook (see prompt_agent_with_images).
    let message =
        crate::services::initial_prompt_turns::convert_prompt_tokens(message, agent_kind_str);

    let runtime = crate::context::get_app_context().agent_runtime.clone();
    runtime
        .inject_message_with_images(&runtime_id, &message, images)
        .await?;
    Ok(())
}

#[derive(Debug)]
pub enum ChatAgentDeletionError {
    InvalidAgentId(String),
    AgentNotBound { chat_id: ChatId, agent_id: String },
    Runtime(ErgataiError),
    Join(anyhow::Error),
    Database(rusqlite::Error),
}

#[derive(Debug)]
pub struct DeletedChatAgent {
    pub binding_deleted: bool,
    pub conversation_ids: Vec<String>,
    pub message_cleanup_queued: bool,
    pub mcp_bindings_removed: usize,
}

/// Permanently delete one chat-bound runtime agent.
///
/// A closed runtime agent is removed from the agent registry and its durable
/// chat binding/conversation are removed from the project database. Physical
/// message tables are intentionally heavy, so their IDs are placed in the
/// existing deletion queue for asynchronous cleanup.
pub async fn delete_chat_agent(
    chat_id: ChatId,
    agent_id: &str,
) -> Result<DeletedChatAgent, ChatAgentDeletionError> {
    let agent_id_i64 = parse_to_i64(agent_id)
        .ok_or_else(|| ChatAgentDeletionError::InvalidAgentId(agent_id.to_string()))?;

    // Stopped bindings will not be in the runtime registry; only stop an agent
    // that is still alive. A failed stop must abort deletion so the process
    // cannot continue writing messages for a conversation we are about to delete.
    let runtime = crate::context::get_app_context().agent_runtime.clone();
    if runtime.get_agent(agent_id).await.is_some() {
        runtime
            .stop_agent(agent_id)
            .await
            .map_err(ChatAgentDeletionError::Runtime)?;
    }

    let agent_id_for_binding = agent_id.to_string();
    let agent_id_for_mcp = agent_id.to_string();
    let result = tokio::task::spawn_blocking(move || {
        let deleted = crate::user_data_db::group_agent_bindings::delete_agent_and_conversation(
            chat_id,
            agent_id_i64,
        )
        .map_err(ChatAgentDeletionError::Database)?
        .ok_or_else(|| ChatAgentDeletionError::AgentNotBound {
            chat_id,
            agent_id: agent_id_for_binding,
        })?;

        let conversation_id_strings = deleted
            .conversation_ids
            .iter()
            .map(|conversation_id| conversation_id.to_string())
            .collect::<Vec<_>>();

        // MCP reconnect bindings are in a separate database and have no FK to
        // the conversation. Cleanup is best-effort so the main deletion still
        // succeeds if this secondary store fails.
        let mcp_bindings_removed = match crate::mcp::get_binding_store() {
            Some(store) => store
                .remove_bindings_by_runtime_agent_id(&agent_id_for_mcp)
                .unwrap_or_else(|error| {
                    tracing::warn!(
                        agent_id = %agent_id_for_mcp,
                        error = %error,
                        "Failed to remove MCP bindings for deleted agent"
                    );
                    0
                }),
            None => 0,
        };

        Ok(DeletedChatAgent {
            binding_deleted: true,
            conversation_ids: conversation_id_strings,
            message_cleanup_queued: true,
            mcp_bindings_removed,
        })
    })
    .await
    .map_err(|error| {
        ChatAgentDeletionError::Join(anyhow::anyhow!("Agent deletion task failed: {}", error))
    })??;

    Ok(result)
}

// ── Runtime selected model persistence (Phase 3) ──

pub async fn get_agent_runtime_selected_model(agent_id: &str) -> Option<String> {
    let agent_id = agent_id.to_string();
    tokio::task::spawn_blocking(move || {
        crate::user_data_db::get_agent_runtime_model(&agent_id)
            .ok()
            .flatten()
            .and_then(|(_, model, _, _)| model)
    })
    .await
    .ok()
    .flatten()
}

pub async fn set_agent_runtime_selected_model(
    agent_id: &str,
    profile_name: Option<&str>,
    selected_model: &str,
    source: &str,
) {
    let agent_id = agent_id.to_string();
    let profile_name = profile_name.map(str::to_string);
    let selected_model = selected_model.to_string();
    let source = source.to_string();
    let _ = tokio::task::spawn_blocking(move || {
        let _ = crate::user_data_db::set_agent_runtime_model(
            &agent_id,
            profile_name.as_deref(),
            Some(&selected_model),
            &source,
        );
    })
    .await;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn split_codex_model_accepts_both_ui_spellings() {
        assert_eq!(
            split_codex_model("gpt-5.3-codex/high"),
            ("gpt-5.3-codex".to_string(), Some("high".to_string()))
        );
        assert_eq!(
            split_codex_model("gpt-5.3-codex[xhigh]"),
            ("gpt-5.3-codex".to_string(), Some("xhigh".to_string()))
        );
        assert_eq!(
            split_codex_model("gpt-5.3-codex"),
            ("gpt-5.3-codex".to_string(), None)
        );
    }

    #[test]
    fn resolve_codex_model_prefers_an_exact_provider_id() {
        use agent_client_protocol::schema::v1::SessionConfigSelectOption;

        let provider_model = SessionConfigSelectOption::new("openai/gpt-5", "openai/gpt-5");
        let plain_model = SessionConfigSelectOption::new("gpt-5.3-codex", "gpt-5.3-codex");
        let candidates = vec![&provider_model, &plain_model];

        // A model ID containing `/` must not be split when it is an exact option.
        assert_eq!(
            resolve_codex_model("openai/gpt-5", &candidates),
            Some(("openai/gpt-5".to_string(), None))
        );
        assert_eq!(
            resolve_codex_model("gpt-5.3-codex/high", &candidates),
            Some(("gpt-5.3-codex".to_string(), Some("high".to_string())))
        );
        assert_eq!(resolve_codex_model("missing/high", &candidates), None);
    }

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
