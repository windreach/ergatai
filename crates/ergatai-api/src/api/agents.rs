use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::{
        sse::{Event, Sse},
        IntoResponse,
    },
    Json,
};
use ergatai_runtime::{get_agent_runtime, ResourceLimits, WorkspaceSpec};
use futures::stream::{self, Stream};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::convert::Infallible;

use crate::messaging::{get_message_sender, SendMessageResult, SendRequest};
use crate::AppState;

#[derive(Debug, Deserialize)]
pub struct SpawnAgentRequest {
    pub workspace_id: String,
    pub command: String,
    pub instruction: Option<String>,
    pub work_dir: Option<String>,
    pub env: Option<HashMap<String, String>>,
}

#[derive(Debug, Deserialize)]
pub struct SendMessageRequest {
    pub message: String,
    /// Optional sender identifier. Defaults to "api" if not provided.
    /// Workflows can set this to identify themselves in message history.
    #[serde(default)]
    pub from: Option<String>,
    /// Optional message type: "request", "response", or "broadcast".
    /// Defaults to "request" if not provided.
    #[serde(default)]
    pub message_type: Option<String>,
    /// Correlation ID for linking a response back to its original request.
    /// Required when `message_type = "response"`. Take from the received
    /// request's `_meta.correlation_id`. Ignored for request/broadcast.
    #[serde(default)]
    pub correlation_id: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct SpawnAgentResponse {
    pub agent_id: String,
}

#[derive(Debug, Serialize)]
pub struct AgentInfoResponse {
    pub agent_id: String,
    /// Human-readable stable identifier (e.g., "agent-1"). User-facing display name.
    pub stable_id: Option<String>,
    pub agent_uuid: String,
    pub workspace_id: String,
    /// Working directory of the agent
    pub work_dir: String,
    /// Lifecycle state name (lowercase, e.g., "running", "idle", "processing")
    pub state: String,
    /// Detailed lifecycle state from the unified state machine
    pub lifecycle_state: String,
    pub task_id: Option<String>,
    pub mcp_agent_id: Option<String>,
    pub is_alive: bool,
    pub is_idle: bool,
    pub is_processing: bool,
    pub created_at: String,
    pub last_heartbeat: String,
    /// Session title reported by the agent via `SessionUpdate::SessionInfoUpdate`.
    pub session_title: Option<String>,
    /// ACP session ID for session persistence and recovery.
    pub session_id: Option<String>,
    /// Stop reason from the most recent prompt response (e.g., EndTurn, MaxTokens,
    /// Refusal, Cancelled). `None` if no prompt has completed yet.
    pub stop_reason: Option<String>,
    /// Number of automatic prompt continuations performed (when auto-continue is enabled).
    pub continuation_count: usize,
    /// Configuration options reported by the agent (includes modes like auto-approval, plan mode).
    /// `None` if agent hasn't reported any config options yet.
    pub config_options: Option<Vec<ConfigOptionInfo>>,
    /// Agent profile name (e.g., "general-purpose", "explore", "plan").
    pub profile: Option<String>,
    /// Agent capabilities (tools this agent provides).
    pub capabilities: Vec<String>,
    /// When the lifecycle state last changed.
    pub state_changed_at: String,
    /// State transition history (audit trail).
    pub state_history: Vec<ergatai_runtime::agent_record::StateTransition>,
}

#[derive(Debug, Serialize)]
pub struct ErrorResponse {
    pub error: String,
}

pub async fn list_agents(State(_state): State<AppState>) -> impl IntoResponse {
    let items = crate::services::agent_service::list_agents_filtered(
        crate::services::agent_service::AgentListFilter::default(),
    )
    .await;

    let response: Vec<AgentInfoResponse> = items
        .into_iter()
        .map(|a| {
            let session_title =
                crate::services::agent_service::get_agent_session_title(&a.agent_id);
            let session_id = crate::services::agent_service::get_agent_session_id(&a.agent_id);
            let stop_reason = crate::services::agent_service::get_agent_stop_reason(&a.agent_id);
            let continuation_count =
                crate::services::agent_service::get_agent_continuation_count(&a.agent_id);

            // Get config options (includes modes like auto-approval, plan mode)
            let config_options =
                crate::services::agent_service::get_agent_config_options(&a.agent_id)
                    .ok()
                    .flatten()
                    .map(|opts| {
                        opts.into_iter()
                            .map(|o| {
                                let category = o.category.map(|c| format!("{:?}", c));
                                let description = o.description.clone();
                                let kind_json = serde_json::to_value(&o.kind).ok();
                                ConfigOptionInfo {
                                    id: o.id.to_string(),
                                    name: o.name,
                                    description,
                                    category,
                                    kind: kind_json,
                                }
                            })
                            .collect()
                    });

            AgentInfoResponse {
                agent_id: a.agent_id,
                stable_id: a.stable_id,
                agent_uuid: a.agent_uuid,
                workspace_id: a.workspace_id,
                work_dir: a.work_dir,
                state: a.state.clone(),
                lifecycle_state: a.state,
                task_id: a.task_id,
                mcp_agent_id: a.mcp_agent_id,
                is_alive: a.is_alive,
                is_idle: a.is_idle,
                is_processing: a.is_processing,
                created_at: a.created_at,
                last_heartbeat: a.last_heartbeat,
                session_title,
                session_id,
                stop_reason,
                continuation_count,
                config_options,
                profile: a.profile,
                capabilities: a.capabilities,
                state_changed_at: a.state_changed_at,
                state_history: a.state_history,
            }
        })
        .collect();

    Json(response)
}

/// Check if strict command validation is enabled.
///
/// When ERGATAI_STRICT_MODE=0, command whitelist validation is disabled.
/// By default, strict mode is ON — commands must match the whitelist.
/// This prevents arbitrary binary execution via the agent spawn API.
fn is_strict_mode() -> bool {
    std::env::var("ERGATAI_STRICT_MODE")
        .map(|v| v != "0" && v.to_lowercase() != "false")
        .unwrap_or(true) // SECURITY: default ON — opt-out via ERGATAI_STRICT_MODE=0
}

/// Whitelist for strict mode (only used when ERGATAI_STRICT_MODE=1).
const STRICT_MODE_ALLOWED_COMMANDS: &[&str] = &[
    "claude",
    "cursor",
    "codex",
    "opencode",
    "ergatai-agent",
    "simple-agent",
];

/// Check if a command matches a pattern (supports * wildcard).
fn matches_pattern(command: &str, pattern: &str) -> bool {
    if pattern.contains('*') {
        let parts: Vec<&str> = pattern.split('*').collect();
        if parts.len() == 2 {
            let (prefix, suffix) = (parts[0], parts[1]);
            return command.starts_with(prefix) && command.ends_with(suffix);
        }
        command == pattern
    } else {
        command == pattern
    }
}

/// Validate that a workspace_id contains only safe characters.
fn is_valid_workspace_id(id: &str) -> bool {
    !id.is_empty()
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.')
}

/// Validate command against whitelist.
///
/// Strict mode is enabled by default. Commands must match `STRICT_MODE_ALLOWED_COMMANDS`,
/// the `ERGATAI_ALLOWED_COMMANDS` env var, OR any binary registered in the ProfileRegistry.
/// Set `ERGATAI_STRICT_MODE=0` to disable validation (not recommended).
fn validate_command(command: &str) -> Result<(), String> {
    // Skip validation only when strict mode is explicitly disabled
    if !is_strict_mode() {
        return Ok(());
    }

    let program = command
        .split_whitespace()
        .next()
        .ok_or_else(|| "Empty command".to_string())?;

    let binary_name = std::path::Path::new(program)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or(program);

    // Check against env var if set, otherwise use static whitelist.
    if let Ok(commands) = std::env::var("ERGATAI_ALLOWED_COMMANDS") {
        for pattern in commands
            .split(',')
            .map(|s| s.trim())
            .filter(|s| !s.is_empty())
        {
            if matches_pattern(binary_name, pattern) || matches_pattern(program, pattern) {
                return Ok(());
            }
        }
    } else {
        for pattern in STRICT_MODE_ALLOWED_COMMANDS {
            if matches_pattern(binary_name, pattern) || matches_pattern(program, pattern) {
                return Ok(());
            }
        }
    }

    // Dynamic whitelist: accept any binary registered in the ProfileRegistry.
    // Uses list_with_status() (sync) to avoid async context issues.
    if let Ok(registry) = crate::services::profile_service::get_profile_registry() {
        if let Ok(profiles) = registry.list_with_status() {
            for profile in profiles {
                if let Some(cmd_binary) = profile.command.split_whitespace().next() {
                    let cmd_basename = std::path::Path::new(cmd_binary)
                        .file_name()
                        .and_then(|n| n.to_str())
                        .unwrap_or(cmd_binary);
                    if cmd_basename == binary_name || cmd_binary == program {
                        return Ok(());
                    }
                }
            }
        }
    }

    Err(format!(
        "Command '{}' is not allowed (strict mode)",
        binary_name
    ))
}

pub async fn spawn_agent(
    State(state): State<AppState>,
    Json(req): Json<SpawnAgentRequest>,
) -> impl IntoResponse {
    // Security: validate command against whitelist before execution
    if let Err(e) = validate_command(&req.command) {
        return (StatusCode::FORBIDDEN, Json(ErrorResponse { error: e })).into_response();
    }

    // Security: validate workspace_id contains only safe characters
    if !is_valid_workspace_id(&req.workspace_id) {
        return (
            StatusCode::BAD_REQUEST,
            Json(ErrorResponse {
                error: "workspace_id must contain only alphanumeric characters, hyphens, or underscores".to_string(),
            }),
        )
            .into_response();
    }

    // SECURITY (P1 #15): Enforce an agent cap to prevent runaway spawning from
    // exhausting host resources (processes, memory, NATS subjects, ACP sessions).
    // Default: 50 agents. Override with ERGATAI_MAX_AGENTS.
    let max_agents: usize = std::env::var("ERGATAI_MAX_AGENTS")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(50);
    {
        let runtime = get_agent_runtime();
        let list = runtime.list_agents().await;
        if list.len() >= max_agents {
            return (
                StatusCode::SERVICE_UNAVAILABLE,
                Json(ErrorResponse {
                    error: format!(
                        "Agent limit reached ({}/{}). Stop an agent or raise ERGATAI_MAX_AGENTS.",
                        list.len(),
                        max_agents
                    ),
                }),
            )
                .into_response();
        }
    }

    let runtime = get_agent_runtime();
    let env = req.env.unwrap_or_default();

    // SECURITY (P1 #13): validate and canonicalize the work_dir.
    // Rejects path traversal, non-existent dirs, and (optionally) paths outside
    // ERGATAI_WORKSPACE_ROOT. The canonical path is what the agent process will
    // actually use as its cwd.
    let raw_work_dir = req
        .work_dir
        .clone()
        .unwrap_or_else(|| state.default_cwd.clone());
    let work_dir = match crate::validate_cwd(&raw_work_dir) {
        Ok(p) => p,
        Err(msg) => {
            return (StatusCode::BAD_REQUEST, Json(ErrorResponse { error: msg })).into_response();
        }
    };
    let work_dir_str = work_dir.to_string_lossy().into_owned();

    let spec = WorkspaceSpec {
        id: req.workspace_id,
        work_dir: work_dir_str.as_str().into(),
        env,
        resources: ResourceLimits::default(),
        capture_thoughts: false,
    };

    match runtime
        .launch_agent(spec, &req.command, req.instruction.as_deref())
        .await
    {
        Ok(agent_id) => {
            // Workspace boundary was already registered in launch_agent() before agent start.
            // This eliminates the race condition where agent could modify files before registration.
            tracing::info!(
                agent_id = %agent_id,
                workspace = %work_dir_str,
                "Agent launched successfully (workspace pre-registered)"
            );

            (StatusCode::CREATED, Json(SpawnAgentResponse { agent_id })).into_response()
        }
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse {
                // SECURITY (P1 #18): Redact internal error details (may contain
                // command lines, argv, binary paths, work_dir).
                error: crate::sanitize_error(&e, "spawn_agent"),
            }),
        )
            .into_response(),
    }
}

pub async fn kill_agent(
    State(_state): State<AppState>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    let runtime = get_agent_runtime();

    // Unregister workspace boundary before stopping the agent.
    // Best-effort: log but don't fail if registration removal errors.
    if let Err(e) = ergatai_lock::unregister_workspace_for_project("default", &id).await {
        tracing::debug!(
            agent_id = %id,
            error = %e,
            "Failed to unregister workspace boundary (non-fatal)"
        );
    } else {
        tracing::debug!(agent_id = %id, "Unregistered workspace boundary for agent");
    }

    match runtime.stop_agent(&id).await {
        Ok(_) => StatusCode::NO_CONTENT.into_response(),
        Err(e) => (
            StatusCode::NOT_FOUND,
            Json(ErrorResponse {
                // SECURITY (P1 #18): Redact runtime internals.
                error: crate::sanitize_error(&e, "kill_agent"),
            }),
        )
            .into_response(),
    }
}

/// Cancel the current prompt turn for an agent (sends ACP `session/cancel`).
///
/// Does NOT stop the agent — only cancels the in-flight prompt. The agent
/// will return a response with `stop_reason = "cancelled"`.
pub async fn cancel_prompt(
    State(_state): State<AppState>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    match crate::services::agent_service::cancel_agent_prompt(&id).await {
        Ok(()) => (
            StatusCode::OK,
            Json(serde_json::json!({ "status": "cancelled" })),
        )
            .into_response(),
        Err(e) => (
            StatusCode::NOT_FOUND,
            Json(ErrorResponse {
                // SECURITY (P1 #18): Redact ACP internals.
                error: crate::sanitize_error(&e, "cancel_prompt"),
            }),
        )
            .into_response(),
    }
}

pub async fn send_message(
    State(_state): State<AppState>,
    Path(id): Path<String>,
    Json(req): Json<SendMessageRequest>,
) -> impl IntoResponse {
    let sender = match get_message_sender() {
        Some(s) => s,
        None => {
            return (
                axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                "MessageSender not initialized",
            )
                .into_response();
        }
    };
    let send_req = SendRequest {
        from: req.from.unwrap_or_else(|| "api".to_string()),
        to: id.clone(),
        message: req.message,
        message_type: req.message_type.unwrap_or_else(|| "request".to_string()),
        correlation_id: req.correlation_id,
    };

    match sender.send(send_req).await {
        SendMessageResult::Queued {
            target_agent,
            stream,
            sequence,
        } => (
            StatusCode::OK,
            Json(serde_json::json!({
                "status": "queued",
                "target_agent": target_agent,
                "stream": stream,
                "sequence": sequence,
            })),
        )
            .into_response(),
        SendMessageResult::DirectDelivered { target_agent } => (
            StatusCode::OK,
            Json(serde_json::json!({
                "status": "direct_delivered",
                "target_agent": target_agent,
            })),
        )
            .into_response(),
        SendMessageResult::Rejected { reason } => (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({
                "status": "rejected",
                "reason": reason,
            })),
        )
            .into_response(),
    }
}

// ── ACP Monitoring Endpoints ──

#[derive(Debug, Serialize)]
pub struct AgentThoughtsResponse {
    pub agent_id: String,
    pub thoughts: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct AgentToolCallsResponse {
    pub agent_id: String,
    pub tool_calls: Vec<ToolCallInfo>,
}

#[derive(Debug, Serialize)]
pub struct ToolCallInfo {
    /// ACP tool call ID.
    pub id: String,
    /// Human-readable description (e.g. "Edit src/main.rs").
    pub title: Option<String>,
    /// Tool category (read, edit, delete, execute, search, think, fetch, etc.).
    pub kind: Option<String>,
    /// Current status (pending, in_progress, completed, failed).
    pub status: String,
    /// When the tool call was first seen (relative, e.g. "5s ago").
    pub started_at: String,
    /// Duration in milliseconds (from first_seen to last_updated).
    pub duration_ms: u64,
    /// File paths affected (each as "path:line" or just "path").
    pub locations: Vec<String>,
    /// Preview of tool arguments (JSON, truncated to 200 chars).
    pub input_preview: Option<String>,
    /// Preview of tool results (JSON, truncated to 200 chars).
    pub output_preview: Option<String>,
}

/// Serialize a JSON value to string, truncating to `max_chars`.
/// Appends "…" if truncated.
fn truncate_json(value: &serde_json::Value, max_chars: usize) -> String {
    let s = value.to_string();
    if s.len() <= max_chars {
        s
    } else {
        let mut truncated: String = s.chars().take(max_chars).collect();
        truncated.push('…');
        truncated
    }
}

#[derive(Debug, Serialize)]
pub struct AgentUsageResponse {
    pub agent_id: String,
    pub input_tokens: usize,
    pub output_tokens: usize,
    pub total_tokens: usize,
}

/// Get captured thoughts for an agent (if capture_thoughts was enabled).
pub async fn get_agent_thoughts(
    State(_state): State<AppState>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    match crate::services::agent_service::get_agent_thoughts(&id) {
        Ok(thoughts) => (
            StatusCode::OK,
            Json(AgentThoughtsResponse {
                agent_id: id,
                thoughts,
            }),
        )
            .into_response(),
        Err(e) => (
            StatusCode::BAD_REQUEST,
            Json(ErrorResponse {
                error: e.to_string(),
            }),
        )
            .into_response(),
    }
}

/// Get recent tool calls for an agent (last 100).
pub async fn get_agent_tool_calls(
    State(_state): State<AppState>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    let result = crate::services::agent_service::get_agent_tool_calls(&id);
    match result {
        Ok(Some(calls)) => {
            let tool_calls = calls
                .into_iter()
                .map(|tc| {
                    let started_at = tc.first_seen.elapsed();
                    let duration = tc.last_updated.saturating_duration_since(tc.first_seen);
                    ToolCallInfo {
                        id: tc.tool_call_id,
                        title: tc.title,
                        kind: tc.kind.map(|k| format!("{k:?}").to_lowercase()),
                        status: format!("{:?}", tc.status).to_lowercase(),
                        started_at: format!("{}s ago", started_at.as_secs()),
                        duration_ms: duration.as_millis() as u64,
                        locations: tc
                            .locations
                            .iter()
                            .map(|loc| {
                                let p = loc.path.to_string_lossy();
                                match loc.line {
                                    Some(line) => format!("{p}:{line}"),
                                    None => p.to_string(),
                                }
                            })
                            .collect(),
                        input_preview: tc.raw_input.as_ref().map(|v| truncate_json(v, 200)),
                        output_preview: tc.raw_output.as_ref().map(|v| truncate_json(v, 200)),
                    }
                })
                .collect();
            (
                StatusCode::OK,
                Json(AgentToolCallsResponse {
                    agent_id: id,
                    tool_calls,
                }),
            )
                .into_response()
        }
        Ok(None) => (
            StatusCode::NOT_FOUND,
            Json(ErrorResponse {
                error: format!("Agent {} not found", id),
            }),
        )
            .into_response(),
        Err(e) => (
            StatusCode::BAD_REQUEST,
            Json(ErrorResponse {
                error: e.to_string(),
            }),
        )
            .into_response(),
    }
}

/// Response for `GET /api/v1/agents/:id/plan`.
#[derive(Serialize)]
struct AgentPlanResponse {
    agent_id: String,
    plan: Option<PlanInfo>,
}

/// Execution plan info for an agent.
#[derive(Serialize)]
struct PlanInfo {
    entries: Vec<PlanEntryInfo>,
    last_updated: String,
}

/// A single plan entry.
#[derive(Serialize)]
struct PlanEntryInfo {
    content: String,
    priority: String,
    status: String,
}

/// Get the current execution plan for an agent.
pub async fn get_agent_plan(
    State(_state): State<AppState>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    match crate::services::agent_service::get_agent_plan(&id) {
        Ok(Some(tracked)) => {
            let elapsed = tracked.last_updated.elapsed();
            let plan = PlanInfo {
                entries: tracked
                    .entries
                    .into_iter()
                    .map(|e| PlanEntryInfo {
                        content: e.content,
                        priority: e.priority,
                        status: e.status,
                    })
                    .collect(),
                last_updated: format!("{}s ago", elapsed.as_secs()),
            };
            (
                StatusCode::OK,
                Json(AgentPlanResponse {
                    agent_id: id,
                    plan: Some(plan),
                }),
            )
                .into_response()
        }
        Ok(None) => (
            StatusCode::OK,
            Json(AgentPlanResponse {
                agent_id: id,
                plan: None,
            }),
        )
            .into_response(),
        Err(e) => (
            StatusCode::BAD_REQUEST,
            Json(ErrorResponse {
                error: e.to_string(),
            }),
        )
            .into_response(),
    }
}

/// Response for `GET /api/v1/agents/:id/elicitations`.
#[derive(Serialize)]
struct AgentElicitationsResponse {
    agent_id: String,
    elicitations: Vec<ElicitationInfo>,
}

/// Elicitation info (agent request for user input).
#[derive(Serialize)]
struct ElicitationInfo {
    elicitation_id: String,
    message: String,
    mode: String,
    received_at: String,
    responded: bool,
    action: Option<String>,
}

/// Agent available commands response.
#[derive(Serialize)]
struct AgentAvailableCommandsResponse {
    agent_id: String,
    commands: Vec<AvailableCommandInfo>,
}

/// Available command info.
#[derive(Serialize)]
struct AvailableCommandInfo {
    name: String,
    description: String,
    has_input: bool,
}

/// Request to execute a slash command on an agent.
#[derive(Debug, Deserialize)]
pub struct ExecuteCommandRequest {
    /// The slash command to execute (e.g. "/model").
    pub command: String,
    /// Timeout in seconds (default: 10).
    #[serde(default = "default_command_timeout")]
    pub timeout_secs: u64,
}

fn default_command_timeout() -> u64 {
    10
}

/// Response from executing a slash command.
#[derive(Debug, Serialize)]
pub struct ExecuteCommandResponse {
    /// Raw output text from the agent.
    pub output: String,
    /// Parsed data (command-specific). For `/model`: `{ "models": [...], "current": "..." }`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parsed: Option<serde_json::Value>,
}

/// Response from listing sessions.
#[derive(Debug, Serialize)]
pub struct ListSessionsResponse {
    /// List of sessions.
    pub sessions: Vec<SessionInfoResponse>,
}

/// Session information.
#[derive(Debug, Serialize)]
pub struct SessionInfoResponse {
    /// Unique session identifier.
    pub session_id: String,
    /// Human-readable title.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    /// Creation timestamp (ISO 8601).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub created_at: Option<String>,
    /// Last update timestamp (ISO 8601).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<String>,
}

/// Agent config options response.
#[derive(Serialize)]
struct AgentConfigOptionsResponse {
    agent_id: String,
    config_options: Vec<ConfigOptionInfo>,
}

/// Config option info.
#[derive(Debug, Serialize)]
pub struct ConfigOptionInfo {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    pub category: Option<String>,
    pub kind: Option<serde_json::Value>,
}

/// Get recent elicitation requests for an agent.
pub async fn get_agent_elicitations(
    State(_state): State<AppState>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    let result = crate::services::agent_service::get_agent_elicitations(&id);
    match result {
        Ok(Some(elics)) => {
            let elicitation_infos = elics
                .into_iter()
                .map(|e| {
                    let elapsed = e.received_at.elapsed();
                    ElicitationInfo {
                        elicitation_id: e.elicitation_id,
                        message: e.message,
                        mode: e.mode,
                        received_at: format!("{}s ago", elapsed.as_secs()),
                        responded: e.responded,
                        action: e.action,
                    }
                })
                .collect();
            (
                StatusCode::OK,
                Json(AgentElicitationsResponse {
                    agent_id: id,
                    elicitations: elicitation_infos,
                }),
            )
                .into_response()
        }
        Ok(None) => (
            StatusCode::NOT_FOUND,
            Json(ErrorResponse {
                error: format!("Agent {} not found", id),
            }),
        )
            .into_response(),
        Err(e) => (
            StatusCode::BAD_REQUEST,
            Json(ErrorResponse {
                error: e.to_string(),
            }),
        )
            .into_response(),
    }
}

/// Get available slash commands reported by the agent.
pub async fn get_agent_available_commands(
    State(_state): State<AppState>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    let result = crate::services::agent_service::get_agent_available_commands(&id);
    match result {
        Ok(Some(cmds)) => {
            let cmd_infos: Vec<AvailableCommandInfo> = cmds
                .into_iter()
                .map(|c| AvailableCommandInfo {
                    name: c.name,
                    description: c.description,
                    has_input: c.input.is_some(),
                })
                .collect();
            (
                StatusCode::OK,
                Json(AgentAvailableCommandsResponse {
                    agent_id: id,
                    commands: cmd_infos,
                }),
            )
                .into_response()
        }
        Ok(None) => (
            StatusCode::NOT_FOUND,
            Json(ErrorResponse {
                error: format!("Agent {} not found", id),
            }),
        )
            .into_response(),
        Err(e) => (
            StatusCode::BAD_REQUEST,
            Json(ErrorResponse {
                error: e.to_string(),
            }),
        )
            .into_response(),
    }
}

/// Execute a slash command on an agent (e.g. `/model`).
///
/// Sends the command as a prompt via ACP, waits for the agent to finish,
/// and returns the captured output with optional parsed data.
pub async fn execute_agent_command(
    State(_state): State<AppState>,
    Path(id): Path<String>,
    Json(req): Json<ExecuteCommandRequest>,
) -> impl IntoResponse {
    match crate::services::agent_service::execute_agent_command(&id, &req.command, req.timeout_secs)
        .await
    {
        Ok(output) => {
            let parsed = parse_command_output(&req.command, &output);
            (
                StatusCode::OK,
                Json(ExecuteCommandResponse { output, parsed }),
            )
                .into_response()
        }
        Err(e) => (
            StatusCode::BAD_REQUEST,
            Json(ErrorResponse {
                error: e.to_string(),
            }),
        )
            .into_response(),
    }
}

/// List available ACP sessions for an agent.
pub async fn list_agent_sessions(
    State(_state): State<AppState>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    match crate::services::agent_service::list_agent_sessions(&id).await {
        Ok(sessions) => {
            let response = ListSessionsResponse {
                sessions: sessions
                    .into_iter()
                    .map(|s| SessionInfoResponse {
                        session_id: s.session_id,
                        title: s.title,
                        created_at: s.created_at,
                        updated_at: s.updated_at,
                    })
                    .collect(),
            };
            (StatusCode::OK, Json(response)).into_response()
        }
        Err(e) => (
            StatusCode::BAD_REQUEST,
            Json(ErrorResponse {
                error: e.to_string(),
            }),
        )
            .into_response(),
    }
}

/// Create a new ACP session for an agent.
pub async fn create_agent_session(
    State(_state): State<AppState>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    match crate::services::agent_service::create_agent_session(&id).await {
        Ok(session) => {
            let response = SessionInfoResponse {
                session_id: session.session_id,
                title: session.title,
                created_at: session.created_at,
                updated_at: session.updated_at,
            };
            (StatusCode::CREATED, Json(response)).into_response()
        }
        Err(e) => (
            StatusCode::BAD_REQUEST,
            Json(ErrorResponse {
                error: e.to_string(),
            }),
        )
            .into_response(),
    }
}

/// Load an existing ACP session for an agent.
pub async fn load_agent_session(
    State(_state): State<AppState>,
    Path((id, session_id)): Path<(String, String)>,
) -> impl IntoResponse {
    match crate::services::agent_service::load_agent_session(&id, &session_id).await {
        Ok(()) => StatusCode::OK.into_response(),
        Err(e) => (
            StatusCode::BAD_REQUEST,
            Json(ErrorResponse {
                error: e.to_string(),
            }),
        )
            .into_response(),
    }
}

/// Delete an ACP session for an agent.
pub async fn delete_agent_session(
    State(_state): State<AppState>,
    Path((id, session_id)): Path<(String, String)>,
) -> impl IntoResponse {
    match crate::services::agent_service::delete_agent_session(&id, &session_id).await {
        Ok(()) => StatusCode::OK.into_response(),
        Err(e) => (
            StatusCode::BAD_REQUEST,
            Json(ErrorResponse {
                error: e.to_string(),
            }),
        )
            .into_response(),
    }
}

/// Parse command output based on command type.
///
/// Currently supports `/model` — extracts model names and current model from
/// the agent's text response.
fn parse_command_output(command: &str, output: &str) -> Option<serde_json::Value> {
    if command == "/model" {
        parse_model_output(output)
    } else {
        None
    }
}

/// Parse `/model` output to extract model list and current model.
///
/// Looks for lines containing model identifiers (e.g. `claude-sonnet-4-20250514`)
/// and detects which model is marked as current via `(current)` or similar markers.
fn parse_model_output(output: &str) -> Option<serde_json::Value> {
    let mut models = Vec::new();
    let mut current_model = None;

    for line in output.lines() {
        let trimmed = line.trim();

        // Extract model identifiers from the line.
        if let Some(model_name) = extract_model_name(trimmed) {
            if !models.contains(&model_name) {
                models.push(model_name.clone());
            }

            // Detect current model marker.
            if trimmed.contains("(current)")
                || trimmed.contains("(selected)")
                || trimmed.contains("✓")
                || trimmed.contains("✔")
            {
                current_model = Some(model_name);
            }
        }
    }

    if models.is_empty() {
        return None;
    }

    Some(serde_json::json!({
        "models": models,
        "current": current_model,
    }))
}

/// Extract a model name from a line of text.
///
/// Matches common model name patterns: `claude-*`, `gpt-*`, `o1-*`, `o3-*`, `o4-*`.
fn extract_model_name(line: &str) -> Option<String> {
    // Simple pattern matching without regex dependency.
    let prefixes = ["claude-", "gpt-", "o1-", "o3-", "o4-"];
    for prefix in &prefixes {
        if let Some(start) = line.find(prefix) {
            let rest = &line[start..];
            // Extract the model name: alphanumeric, hyphens, dots.
            let end = rest
                .find(|c: char| !c.is_alphanumeric() && c != '-' && c != '.')
                .unwrap_or(rest.len());
            let name = &rest[..end];
            if name.len() > prefix.len() {
                return Some(name.to_string());
            }
        }
    }
    None
}

/// Get configuration options reported by the agent.
pub async fn get_agent_config_options(
    State(_state): State<AppState>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    let result = crate::services::agent_service::get_agent_config_options(&id);
    match result {
        Ok(Some(opts)) => {
            let opt_infos: Vec<ConfigOptionInfo> = opts
                .into_iter()
                .map(|o| {
                    let category = o.category.map(|c| format!("{:?}", c));
                    let description = o.description.clone();
                    // Serialize the kind as JSON for now (complex type).
                    let kind_json = serde_json::to_value(&o.kind).ok();
                    ConfigOptionInfo {
                        id: o.id.to_string(),
                        name: o.name,
                        description,
                        category,
                        kind: kind_json,
                    }
                })
                .collect();
            (
                StatusCode::OK,
                Json(AgentConfigOptionsResponse {
                    agent_id: id,
                    config_options: opt_infos,
                }),
            )
                .into_response()
        }
        Ok(None) => (
            StatusCode::NOT_FOUND,
            Json(ErrorResponse {
                error: format!("Agent {} not found", id),
            }),
        )
            .into_response(),
        Err(e) => (
            StatusCode::BAD_REQUEST,
            Json(ErrorResponse {
                error: e.to_string(),
            }),
        )
            .into_response(),
    }
}

/// Request body for responding to an elicitation.
#[derive(Deserialize)]
pub struct RespondToElicitationRequest {
    /// The action: "accept", "decline", or "cancel".
    pub action: String,
    /// Optional form data (for form-mode elicitations).
    pub form_data: Option<serde_json::Value>,
}

/// Respond to a pending elicitation request from an agent.
pub async fn respond_to_elicitation(
    State(_state): State<AppState>,
    Path((_agent_id, elicitation_id)): Path<(String, String)>,
    Json(req): Json<RespondToElicitationRequest>,
) -> impl IntoResponse {
    let response = ergatai_runtime::ElicitationResponse {
        action: req.action,
        form_data: req.form_data,
    };

    match crate::services::agent_service::respond_to_elicitation(&elicitation_id, response).await {
        Ok(true) => (
            StatusCode::OK,
            Json(serde_json::json!({ "status": "responded" })),
        )
            .into_response(),
        Ok(false) => (
            StatusCode::NOT_FOUND,
            Json(ErrorResponse {
                error: format!(
                    "Elicitation {} not found or already responded",
                    elicitation_id
                ),
            }),
        )
            .into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse {
                // SECURITY (P1 #18): Redact internal error details.
                error: crate::sanitize_error(&e, "respond_elicitation"),
            }),
        )
            .into_response(),
    }
}

/// Get token usage statistics for an agent.
pub async fn get_agent_usage(
    State(_state): State<AppState>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    let result = crate::services::agent_service::get_agent_usage(&id);
    match result {
        Ok(Some((input_tokens, output_tokens))) => (
            StatusCode::OK,
            Json(AgentUsageResponse {
                agent_id: id,
                input_tokens,
                output_tokens,
                total_tokens: input_tokens + output_tokens,
            }),
        )
            .into_response(),
        Ok(None) => (
            StatusCode::NOT_FOUND,
            Json(ErrorResponse {
                error: format!("Agent {} not found", id),
            }),
        )
            .into_response(),
        Err(e) => (
            StatusCode::BAD_REQUEST,
            Json(ErrorResponse {
                error: e.to_string(),
            }),
        )
            .into_response(),
    }
}

/// Response for agent output endpoint.
#[derive(Serialize)]
pub struct AgentOutputResponse {
    pub agent_id: String,
    pub output: String,
}

/// Get captured output for an agent (non-destructive read).
pub async fn get_agent_output(
    State(_state): State<AppState>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    let result = crate::services::agent_service::get_agent_output(&id);
    match result {
        Ok(Some(output)) => (
            StatusCode::OK,
            Json(AgentOutputResponse {
                agent_id: id,
                output,
            }),
        )
            .into_response(),
        Ok(None) => (
            StatusCode::NOT_FOUND,
            Json(ErrorResponse {
                error: format!("Agent {} not found or has no output", id),
            }),
        )
            .into_response(),
        Err(e) => (
            StatusCode::BAD_REQUEST,
            Json(ErrorResponse {
                error: e.to_string(),
            }),
        )
            .into_response(),
    }
}

/// Response for agent last output age endpoint.
#[derive(Serialize)]
pub struct AgentLastOutputResponse {
    pub agent_id: String,
    /// Seconds since the agent's last output.
    pub last_output_age_secs: f64,
}

/// Get the time elapsed since the agent's last output.
pub async fn get_agent_last_output(
    State(_state): State<AppState>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    let result = crate::services::agent_service::get_agent_last_output_age(&id);
    match result {
        Ok(Some(duration)) => (
            StatusCode::OK,
            Json(AgentLastOutputResponse {
                agent_id: id,
                last_output_age_secs: duration.as_secs_f64(),
            }),
        )
            .into_response(),
        Ok(None) => (
            StatusCode::NOT_FOUND,
            Json(ErrorResponse {
                error: format!("Agent {} not found", id),
            }),
        )
            .into_response(),
        Err(e) => (
            StatusCode::BAD_REQUEST,
            Json(ErrorResponse {
                error: e.to_string(),
            }),
        )
            .into_response(),
    }
}

/// Response for agent exit code endpoint.
#[derive(Serialize)]
pub struct AgentExitCodeResponse {
    pub agent_id: String,
    /// `null` if still running, `0` for normal exit, non-zero for error.
    pub exit_code: Option<i32>,
    pub running: bool,
}

/// Get the exit code from the agent's connection task.
pub async fn get_agent_exit_code(
    State(_state): State<AppState>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    let result = crate::services::agent_service::get_agent_exit_code(&id);
    match result {
        Ok(Some(exit_code)) => (
            StatusCode::OK,
            Json(AgentExitCodeResponse {
                agent_id: id,
                exit_code,
                running: exit_code.is_none(),
            }),
        )
            .into_response(),
        Ok(None) => (
            StatusCode::NOT_FOUND,
            Json(ErrorResponse {
                error: format!("Agent {} not found", id),
            }),
        )
            .into_response(),
        Err(e) => (
            StatusCode::BAD_REQUEST,
            Json(ErrorResponse {
                error: e.to_string(),
            }),
        )
            .into_response(),
    }
}

/// Response for agent PID endpoint.
#[derive(Serialize)]
pub struct AgentPidResponse {
    pub agent_id: String,
    pub pid: u32,
}

/// Get the PID of an agent's process.
pub async fn get_agent_pid(
    State(_state): State<AppState>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    let result = crate::services::agent_service::get_agent_pid(&id);
    match result {
        Ok(Some(pid)) => {
            (StatusCode::OK, Json(AgentPidResponse { agent_id: id, pid })).into_response()
        }
        Ok(None) => (
            StatusCode::NOT_FOUND,
            Json(ErrorResponse {
                error: format!("Agent {} not found or PID not available", id),
            }),
        )
            .into_response(),
        Err(e) => (
            StatusCode::BAD_REQUEST,
            Json(ErrorResponse {
                error: e.to_string(),
            }),
        )
            .into_response(),
    }
}

// ── Prompt & SSE streaming ──

#[derive(Debug, Deserialize)]
pub struct PromptAgentRequest {
    pub message: String,
}

/// POST /api/v1/agents/:id/prompt — send a prompt to an agent (non-blocking).
///
/// Returns 202 Accepted immediately. The agent processes the prompt in the
/// background; output events are available via `GET /api/v1/agents/:id/stream`.
pub async fn prompt_agent(
    State(_state): State<AppState>,
    Path(id): Path<String>,
    Json(body): Json<PromptAgentRequest>,
) -> impl IntoResponse {
    match crate::services::agent_service::prompt_agent(&id, &body.message).await {
        Ok(()) => (
            StatusCode::ACCEPTED,
            Json(serde_json::json!({ "status": "queued" })),
        )
            .into_response(),
        Err(e) => (
            StatusCode::BAD_REQUEST,
            Json(ErrorResponse {
                error: e.to_string(),
            }),
        )
            .into_response(),
    }
}

/// GET /api/v1/agents/:id/stream — SSE stream of real-time agent output events.
///
/// Subscribes to the agent's broadcast channel and yields `AgentOutputEvent`
/// values as SSE data frames. The stream stays open until the agent finishes
/// (emits a `Done` event) or the client disconnects.
pub async fn stream_agent_output(
    State(_state): State<AppState>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    let receiver = match crate::services::agent_service::subscribe_agent_output(&id) {
        Ok(rx) => rx,
        Err(e) => {
            return (
                StatusCode::NOT_FOUND,
                Json(ErrorResponse {
                    error: e.to_string(),
                }),
            )
                .into_response();
        }
    };

    let agent_id_for_stream = id.clone();
    let event_stream = stream::unfold(receiver, move |mut rx| {
        let aid = agent_id_for_stream.clone();
        async move {
            loop {
                match rx.recv().await {
                    Ok(event) => {
                        if let Ok(json) = serde_json::to_string(&event) {
                            let event_type = match &event {
                                ergatai_runtime::AgentOutputEvent::Text { .. } => "text",
                                ergatai_runtime::AgentOutputEvent::Thinking { .. } => "thinking",
                                ergatai_runtime::AgentOutputEvent::ToolCallStart { .. } => {
                                    "tool_call_start"
                                }
                                ergatai_runtime::AgentOutputEvent::ToolCallInput { .. } => {
                                    "tool_call_input"
                                }
                                ergatai_runtime::AgentOutputEvent::ToolCallComplete { .. } => {
                                    "tool_call_complete"
                                }
                                ergatai_runtime::AgentOutputEvent::ToolCallError { .. } => {
                                    "tool_call_error"
                                }
                                ergatai_runtime::AgentOutputEvent::Done { .. } => "done",
                                ergatai_runtime::AgentOutputEvent::Error { .. } => "error",
                            };
                            let sse_event = Event::default().event(event_type).data(json);
                            let is_done =
                                matches!(event, ergatai_runtime::AgentOutputEvent::Done { .. });
                            let result = Some((Ok(sse_event), rx));
                            if is_done {
                                // After yielding Done, end the stream on next iteration
                                return result;
                            }
                            return result;
                        }
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(n)) => {
                        tracing::warn!(agent_id = %aid, lagged = n, "SSE subscriber lagged, skipping events");
                        continue;
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => {
                        return None;
                    }
                }
            }
        }
    });

    let pinned: std::pin::Pin<Box<dyn Stream<Item = Result<Event, Infallible>> + Send>> =
        Box::pin(event_stream);

    Sse::new(pinned)
        .keep_alive(
            axum::response::sse::KeepAlive::new().interval(std::time::Duration::from_secs(15)),
        )
        .into_response()
}

// ── Tests ──

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    // ── SpawnAgentRequest deserialization ──

    #[test]
    fn test_spawn_agent_request_required_fields() {
        let req: SpawnAgentRequest = serde_json::from_value(json!({
            "workspace_id": "ws-1",
            "command": "claude"
        }))
        .unwrap();
        assert_eq!(req.workspace_id, "ws-1");
        assert_eq!(req.command, "claude");
        assert!(req.instruction.is_none());
        assert!(req.work_dir.is_none());
        assert!(req.env.is_none());
    }

    #[test]
    fn test_spawn_agent_request_all_fields() {
        let req: SpawnAgentRequest = serde_json::from_value(json!({
            "workspace_id": "ws-1",
            "command": "claude",
            "instruction": "do a task",
            "work_dir": "/tmp/work",
            "env": {"FOO": "bar", "BAZ": "qux"}
        }))
        .unwrap();
        assert_eq!(req.instruction.as_deref(), Some("do a task"));
        assert_eq!(req.work_dir.as_deref(), Some("/tmp/work"));
        let env = req.env.unwrap();
        assert_eq!(env.get("FOO").unwrap(), "bar");
        assert_eq!(env.get("BAZ").unwrap(), "qux");
    }

    #[test]
    fn test_spawn_agent_request_missing_workspace_id_fails() {
        let result: Result<SpawnAgentRequest, _> =
            serde_json::from_value(json!({"command": "claude"}));
        assert!(result.is_err());
    }

    #[test]
    fn test_spawn_agent_request_missing_command_fails() {
        let result: Result<SpawnAgentRequest, _> =
            serde_json::from_value(json!({"workspace_id": "ws-1"}));
        assert!(result.is_err());
    }

    #[test]
    fn test_spawn_agent_request_null_optional_fields() {
        let req: SpawnAgentRequest = serde_json::from_value(json!({
            "workspace_id": "ws-1",
            "command": "claude",
            "instruction": null,
            "work_dir": null,
            "env": null
        }))
        .unwrap();
        assert!(req.instruction.is_none());
        assert!(req.work_dir.is_none());
        assert!(req.env.is_none());
    }

    // ── SendMessageRequest deserialization ──

    #[test]
    fn test_send_message_request_valid() {
        let req: SendMessageRequest =
            serde_json::from_value(json!({"message": "hello world"})).unwrap();
        assert_eq!(req.message, "hello world");
    }

    #[test]
    fn test_send_message_request_empty_string() {
        let req: SendMessageRequest = serde_json::from_value(json!({"message": ""})).unwrap();
        assert_eq!(req.message, "");
    }

    #[test]
    fn test_send_message_request_missing_message_fails() {
        let result: Result<SendMessageRequest, _> = serde_json::from_value(json!({}));
        assert!(result.is_err());
    }

    // ── Response struct serialization ──

    #[test]
    fn test_spawn_agent_response_serialization() {
        let resp = SpawnAgentResponse {
            agent_id: "agent-42".to_string(),
        };
        let json = serde_json::to_value(&resp).unwrap();
        assert_eq!(json["agent_id"], "agent-42");
    }

    #[test]
    fn test_agent_info_response_serialization() {
        let resp = AgentInfoResponse {
            agent_id: "a-1".to_string(),
            stable_id: Some("agent-1".to_string()),
            agent_uuid: "uuid-1".to_string(),
            workspace_id: "ws-1".to_string(),
            work_dir: "/workspace/ws-1".to_string(),
            state: "running".to_string(),
            lifecycle_state: "running".to_string(),
            task_id: None,
            mcp_agent_id: None,
            is_alive: true,
            is_idle: false,
            is_processing: false,
            created_at: "2026-01-01T00:00:00Z".to_string(),
            last_heartbeat: "2026-01-01T00:00:00Z".to_string(),
            session_title: Some("Refactoring auth module".to_string()),
            session_id: Some("session-123".to_string()),
            stop_reason: Some("end_turn".to_string()),
            continuation_count: 2,
            config_options: None,
            profile: Some("general-purpose".to_string()),
            capabilities: vec!["code_edit".to_string(), "search".to_string()],
            state_changed_at: "2026-01-01T00:00:00Z".to_string(),
            state_history: vec![],
        };
        let json = serde_json::to_value(&resp).unwrap();
        assert_eq!(json["agent_id"], "a-1");
        assert_eq!(json["agent_uuid"], "uuid-1");
        assert_eq!(json["workspace_id"], "ws-1");
        // Fixed: state is now lowercase
        assert_eq!(json["state"], "running");
        assert_eq!(json["lifecycle_state"], "running");
        assert_eq!(json["is_alive"], true);
        assert_eq!(json["created_at"], "2026-01-01T00:00:00Z");
        assert_eq!(json["session_title"], "Refactoring auth module");
        assert_eq!(json["stop_reason"], "end_turn");
        assert_eq!(json["continuation_count"], 2);
    }

    #[test]
    fn test_error_response_serialization() {
        let resp = ErrorResponse {
            error: "something went wrong".to_string(),
        };
        let json = serde_json::to_value(&resp).unwrap();
        assert_eq!(json["error"], "something went wrong");
        // Only one field
        assert_eq!(json.as_object().unwrap().len(), 1);
    }
}
