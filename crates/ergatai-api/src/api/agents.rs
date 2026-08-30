use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::IntoResponse,
    Json,
};
use ergatai_runtime::{get_agent_runtime, ResourceLimits, WorkspaceSpec};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

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
}

#[derive(Debug, Serialize)]
pub struct ErrorResponse {
    pub error: String,
}

pub async fn list_agents(State(_state): State<AppState>) -> impl IntoResponse {
    let runtime = get_agent_runtime();
    let agents = runtime.list_agents().await;

    let response: Vec<AgentInfoResponse> = agents
        .into_iter()
        .map(|a| {
            // Use lifecycle state_name() which returns lowercase (fixes the bug)
            let lifecycle_state = a.lifecycle.state_name().to_string();
            AgentInfoResponse {
                agent_id: a.agent_id,
                stable_id: a.stable_id,
                agent_uuid: a.agent_uuid,
                workspace_id: a.workspace_id,
                // Fix: use lowercase lifecycle state instead of Debug-formatted AgentState
                state: lifecycle_state.clone(),
                lifecycle_state,
                task_id: a.task_id,
                mcp_agent_id: a.mcp_agent_id,
                is_alive: a.lifecycle.is_alive(),
                is_idle: a.lifecycle.is_idle(),
                is_processing: a.lifecycle.is_processing(),
                created_at: a.created_at.to_rfc3339(),
                last_heartbeat: a.last_heartbeat.to_rfc3339(),
            }
        })
        .collect();

    Json(response)
}

/// Check if strict command validation is enabled.
///
/// When ERGATAI_STRICT_MODE=1, commands are validated against the whitelist.
/// Otherwise, all commands are allowed (for flexibility).
fn is_strict_mode() -> bool {
    std::env::var("ERGATAI_STRICT_MODE")
        .map(|v| v == "1" || v.to_lowercase() == "true")
        .unwrap_or(false)
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

/// Validate command (only in strict mode).
///
/// By default, all commands are allowed for maximum flexibility.
/// Set ERGATAI_STRICT_MODE=1 to enable whitelist validation.
fn validate_command(command: &str) -> Result<(), String> {
    // Skip validation unless strict mode is enabled
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
    // This avoids allocating a Vec<String> on every validation call.
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

    let runtime = get_agent_runtime();
    let env = req.env.unwrap_or_default();

    // Save work_dir before it's consumed by WorkspaceSpec
    let work_dir_str = req
        .work_dir
        .clone()
        .unwrap_or_else(|| state.default_cwd.clone());

    let spec = WorkspaceSpec {
        id: req.workspace_id,
        work_dir: work_dir_str.as_str().into(),
        env,
        resources: ResourceLimits::default(),
    };

    match runtime
        .launch_agent(spec, &req.command, req.instruction.as_deref())
        .await
    {
        Ok(agent_id) => {
            // Register workspace boundary with the file access enforcer
            // so the agent can only access files within its workspace.
            // Mandatory enforcement: if enforcer is active but registration
            // fails, kill the agent and return an error.
            match ergatai_lock::get_enforcer("default").await {
                Ok(Some(enforcer)) if enforcer.is_active() => {
                    // Convert absolute work_dir to relative path (relative to project root)
                    let workspace_dir = if let Ok(relative) =
                        std::path::Path::new(&work_dir_str).strip_prefix(&state.default_cwd)
                    {
                        relative.to_string_lossy().to_string()
                    } else {
                        work_dir_str.clone()
                    };

                    enforcer.register_workspace(&agent_id, &workspace_dir);
                    tracing::info!(
                        agent_id = %agent_id,
                        workspace = %workspace_dir,
                        "Registered workspace boundary for agent (enforced)"
                    );
                }
                Ok(Some(_enforcer)) => {
                    // Enforcer exists but not active (non-Linux or no fanotify perms).
                    // Workspace boundary enforcement is impossible — log warning
                    // but allow agent to start (progressive enhancement).
                    tracing::warn!(
                        agent_id = %agent_id,
                        "Enforcer not active — workspace boundary NOT enforced for this agent"
                    );
                }
                Ok(None) => {
                    // No enforcer instance at all — fanotify not initialized.
                    tracing::warn!(
                        agent_id = %agent_id,
                        "No enforcer available — workspace boundary NOT enforced for this agent"
                    );
                }
                Err(e) => {
                    // Failed to get enforcer — this is a real error.
                    // Kill the agent we just started and return error.
                    tracing::error!(
                        agent_id = %agent_id,
                        error = %e,
                        "Failed to get enforcer for workspace registration — killing agent"
                    );
                    if let Err(stop_err) = runtime.stop_agent(&agent_id).await {
                        tracing::error!(
                            agent_id = %agent_id,
                            stop_error = %stop_err,
                            "CRITICAL: failed to stop agent after enforcer registration failure — agent may be running without workspace isolation"
                        );
                    }
                    return (
                        StatusCode::INTERNAL_SERVER_ERROR,
                        Json(ErrorResponse {
                            error: format!(
                                "Agent started but workspace boundary enforcement failed: {}. Agent killed.",
                                e
                            ),
                        }),
                    )
                        .into_response();
                }
            }

            (StatusCode::CREATED, Json(SpawnAgentResponse { agent_id })).into_response()
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

pub async fn kill_agent(
    State(_state): State<AppState>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    let runtime = get_agent_runtime();

    // Unregister workspace boundary before stopping the agent
    if let Ok(Some(enforcer)) = ergatai_lock::get_enforcer("default").await {
        enforcer.unregister_workspace(&id);
        tracing::debug!(agent_id = %id, "Unregistered workspace boundary for agent");
    }

    match runtime.stop_agent(&id).await {
        Ok(_) => StatusCode::NO_CONTENT.into_response(),
        Err(e) => (
            StatusCode::NOT_FOUND,
            Json(ErrorResponse {
                error: e.to_string(),
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
            state: "running".to_string(),
            lifecycle_state: "running".to_string(),
            task_id: None,
            mcp_agent_id: None,
            is_alive: true,
            is_idle: false,
            is_processing: false,
            created_at: "2026-01-01T00:00:00Z".to_string(),
            last_heartbeat: "2026-01-01T00:00:00Z".to_string(),
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
