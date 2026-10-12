use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::IntoResponse,
    Json,
};
use ergatai_runtime::suspend_store::SuspendReason;
use ergatai_runtime::{ResourceLimits, WorkspaceSpec};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::sync::OnceLock;
use tokio::sync::Mutex;
use utoipa::ToSchema;

use ergatai_core::id::{format as format_id, generate, IdType};

use crate::messaging::{get_message_sender, SendMessageResult, SendRequest};
use crate::AppState;

/// Cache for adapter version checks (per-process, one-time check per adapter).
/// Each adapter is checked only once per process lifetime.
static ADAPTER_CHECK_CACHE: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();

/// Check if an adapter needs version update (cached per-process).
/// Returns immediately, spawns background task if update needed.
async fn check_and_update_adapter_if_needed(
    profile_name: &str,
    package_name: Option<&str>,
    is_managed: bool,
) {
    // Only check managed adapters with a package name
    if !is_managed {
        return;
    }

    let npm_package = match package_name {
        Some(pkg) => pkg,
        None => {
            tracing::debug!(profile = %profile_name, "Managed adapter has no package_name, skipping version check");
            return;
        }
    };

    let cache = ADAPTER_CHECK_CACHE.get_or_init(|| Mutex::new(HashSet::new()));

    // Check if already checked (lock released before spawning)
    {
        let checked = cache.lock().await;
        if checked.contains(profile_name) {
            tracing::debug!(profile = %profile_name, "Adapter already checked in this process, skipping");
            return;
        }
    } // Lock released here

    // Check version in background (don't block spawn)
    // Mark as checked only after background task completes
    let profile_name_owned = profile_name.to_string();
    let npm_package_owned = npm_package.to_string();
    tokio::spawn(async move {
        match check_adapter_version_async(&profile_name_owned, &npm_package_owned).await {
            Ok(_) => {
                // Mark as checked only on success
                let mut checked = cache.lock().await;
                checked.insert(profile_name_owned.clone());
                tracing::debug!(profile = %profile_name_owned, "Adapter version check completed");
            }
            Err(e) => {
                // Don't mark as checked on failure, so it can be retried
                tracing::warn!(
                    profile = %profile_name_owned,
                    error = %e,
                    "Adapter version check failed (will retry on next spawn)"
                );
            }
        }
    });
}

/// Check adapter version against npm registry and update if needed.
async fn check_adapter_version_async(profile_name: &str, npm_package: &str) -> Result<(), String> {
    use tokio::process::Command;

    // Get local version (from package.json in node_modules)
    let local_version = get_local_adapter_version(npm_package).await?;

    // Get latest version from npm registry
    let output = Command::new("npm")
        .args(["view", npm_package, "version"])
        .output()
        .await
        .map_err(|e| format!("Failed to run npm view: {}", e))?;

    if !output.status.success() {
        return Err("npm view failed".to_string());
    }

    let latest_version = String::from_utf8_lossy(&output.stdout).trim().to_string();

    tracing::info!(
        profile = %profile_name,
        package = %npm_package,
        local = %local_version,
        latest = %latest_version,
        "Checking adapter version"
    );

    // Compare versions
    if local_version == latest_version {
        tracing::debug!(
            profile = %profile_name,
            "Adapter is up-to-date"
        );
        return Ok(());
    }

    // Version mismatch - trigger background update
    tracing::info!(
        profile = %profile_name,
        local_version = %local_version,
        latest_version = %latest_version,
        "Adapter update available, triggering background update"
    );

    // Spawn adapter manager to download and activate new version
    spawn_adapter_update_async(npm_package).await;

    Ok(())
}

/// Spawn background task to download and activate adapter update.
async fn spawn_adapter_update_async(npm_package: &str) {
    let npm_package_owned = npm_package.to_string();
    tokio::spawn(async move {
        if let Err(e) = download_and_activate_adapter_async(&npm_package_owned).await {
            tracing::warn!(
                package = %npm_package_owned,
                error = %e,
                "Failed to download and activate adapter update"
            );
        }
    });
}

/// Download and activate adapter update (async).
async fn download_and_activate_adapter_async(npm_package: &str) -> Result<(), String> {
    use tokio::fs;
    use tokio::process::Command;

    let adapters_base =
        ergatai_runtime::profile_registry::ProfileRegistry::resolve_adapters_base_public();
    let managed_base = adapters_base.join("managed");

    // Create staging directory
    let staging = managed_base.join("staging");
    if staging.exists() {
        fs::remove_dir_all(&staging)
            .await
            .map_err(|e| format!("Failed to remove stale staging: {}", e))?;
    }
    fs::create_dir_all(&staging)
        .await
        .map_err(|e| format!("Failed to create staging dir: {}", e))?;

    // Install adapter package
    tracing::info!(package = %npm_package, "Downloading adapter update...");
    let output = Command::new("npm")
        .args([
            "install",
            "--no-audit",
            "--no-fund",
            "--loglevel=error",
            npm_package,
        ])
        .current_dir(&staging)
        .output()
        .await
        .map_err(|e| format!("Failed to run npm install: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("npm install failed: {}", stderr));
    }

    // Create release directory
    let release_id = chrono::Utc::now().format("%Y%m%d-%H%M%S").to_string();
    let releases_dir = managed_base.join("releases");
    fs::create_dir_all(&releases_dir)
        .await
        .map_err(|e| format!("Failed to create releases dir: {}", e))?;
    let release_dir = releases_dir.join(&release_id);
    fs::rename(&staging, &release_dir)
        .await
        .map_err(|e| format!("Failed to promote staging to release: {}", e))?;

    // Update current pointer
    let current_pointer = managed_base.join("current");
    fs::write(&current_pointer, &release_id)
        .await
        .map_err(|e| format!("Failed to write current pointer: {}", e))?;

    // Update profile database
    let db_path = crate::services::profile_service::profile_registry_db_path();
    if let Err(e) = ergatai_runtime::adapter_manager::refresh_profile_rows(
        &std::path::PathBuf::from(&db_path),
        &release_dir,
    ) {
        tracing::warn!(error = %e, "Failed to update profile rows");
    }

    tracing::info!(
        package = %npm_package,
        release = %release_id,
        "Adapter update downloaded and activated"
    );

    Ok(())
}

/// Get local adapter version from package.json.
async fn get_local_adapter_version(npm_package: &str) -> Result<String, String> {
    use tokio::fs;

    let adapters_base =
        ergatai_runtime::profile_registry::ProfileRegistry::resolve_adapters_base_public();
    let managed_base = adapters_base.join("managed");

    // Read current pointer
    let current_pointer = managed_base.join("current");
    let release_id = fs::read_to_string(&current_pointer)
        .await
        .map_err(|e| format!("Failed to read current pointer: {}", e))?
        .trim()
        .to_string();

    let release_dir = managed_base.join("releases").join(&release_id);
    let package_json = release_dir
        .join("node_modules")
        .join(npm_package)
        .join("package.json");

    let content = fs::read_to_string(&package_json)
        .await
        .map_err(|e| format!("Failed to read package.json: {}", e))?;

    let json: serde_json::Value = serde_json::from_str(&content)
        .map_err(|e| format!("Failed to parse package.json: {}", e))?;

    json.get("version")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| "Version not found in package.json".to_string())
}

/// Request body for spawning a new agent.
#[derive(Debug, Deserialize, ToSchema)]
pub struct SpawnAgentRequest {
    #[serde(default)]
    pub workspace_id: Option<String>,
    #[serde(default)]
    pub conversation_id: Option<String>,
    /// Agent profile name from the profile registry (e.g., "claude-code", "general-purpose").
    /// The backend will look up the profile and use its configured command to start the agent.
    /// For backward compatibility, if the profile is not found, this is treated as a raw command.
    pub command: String,
    /// Optional instruction/prompt to send to the agent after startup.
    pub instruction: Option<String>,
    /// Working directory for the agent.
    pub work_dir: Option<String>,
    /// Environment variables to set for the agent process.
    pub env: Option<HashMap<String, String>>,
}

#[derive(Debug, Deserialize, ToSchema)]
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
    /// Optional conversation to append the external message to before delivery.
    #[serde(default)]
    pub conversation_id: Option<String>,
    /// Optional display name for UI rendering.
    #[serde(default)]
    pub sender_agent_name: Option<String>,
    /// Target agent command for agent-to-agent routing (e.g., "claude", "codex").
    /// When present, the backend will route to an agent with this command bound to the same chat.
    #[serde(default)]
    pub target_agent_command: Option<String>,
    /// Force spawn a new agent session instead of reusing an existing one.
    #[serde(default)]
    pub force_new_session: Option<bool>,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct SpawnAgentResponse {
    pub agent_id: String,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct AgentInfoResponse {
    pub agent_id: String,
    /// Human-readable identifier (e.g., "agent-1"). User-facing display name.
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
    #[schema(value_type = Vec<Object>)]
    pub state_history: Vec<ergatai_runtime::agent_record::StateTransition>,
}

#[derive(Debug, Serialize)]
pub struct ErrorResponse {
    pub error: String,
}

#[utoipa::path(
    get,
    path = "/api/v1/agents",
    tag = "Agents",
    responses(
        (status = 200, description = "List agents", body = Vec<AgentInfoResponse>),
        (status = 500, description = "Internal server error", body = crate::api::ApiError),
    )
)]
pub async fn list_agents(State(_state): State<AppState>) -> impl IntoResponse {
    let items = crate::services::agent_service::list_agents_filtered(
        crate::services::agent_service::AgentListFilter::default(),
    )
    .await;

    // Collect all agent IDs and fetch session metadata in one batch.
    // Each agent's 5 backend queries run in parallel via tokio::join!,
    // and all agents are processed concurrently via join_all — replacing
    // the previous N+1 sequential pattern.
    let agent_ids: Vec<&str> = items.iter().map(|a| a.agent_id.as_str()).collect();
    let snapshots = crate::services::agent_service::agent_snapshot_batch(&agent_ids).await;

    let response: Vec<AgentInfoResponse> = items
        .into_iter()
        .map(|a| {
            let snapshot = snapshots.get(&a.agent_id);

            let config_options = snapshot
                .and_then(|s| s.config_options.as_ref())
                .map(|opts| {
                    opts.iter()
                        .map(|o| {
                            let category = o.category.clone().map(|c| format!("{:?}", c));
                            let description = o.description.clone();
                            let kind_json = serde_json::to_value(&o.kind).ok();
                            ConfigOptionInfo {
                                id: o.id.to_string(),
                                name: o.name.clone(),
                                description,
                                category,
                                kind: kind_json,
                            }
                        })
                        .collect()
                });

            AgentInfoResponse {
                agent_id: a.agent_id,
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
                session_title: snapshot.and_then(|s| s.session_title.clone()),
                session_id: snapshot.and_then(|s| s.session_id.clone()),
                stop_reason: snapshot.and_then(|s| s.stop_reason.clone()),
                continuation_count: snapshot.map_or(0, |s| s.continuation_count),
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
    "claude-code", // 添加 claude-code
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
///
/// SECURITY: rejects empty IDs, path separators, `..` components, control
/// characters, and any non-ASCII symbol. Prevents path-traversal and
/// filesystem-namespace injection via the workspace creation API.
pub(crate) fn is_valid_workspace_id(id: &str) -> bool {
    if id.is_empty() || id.contains("..") || id == "." {
        return false;
    }
    id.chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.')
}

async fn workspace_resource_limits(
    workspace_id: &str,
) -> Result<ResourceLimits, (StatusCode, String)> {
    let workspace_id_for_get = workspace_id.to_string();
    let workspace = match tokio::task::spawn_blocking(move || {
        crate::user_data_db::workspaces::get(&workspace_id_for_get)
    })
    .await
    {
        Ok(Ok(workspace)) => workspace,
        Ok(Err(error)) => {
            return Err((
                StatusCode::INTERNAL_SERVER_ERROR,
                crate::sanitize_error(&error, "workspace_load"),
            ))
        }
        Err(e) => {
            return Err((
                StatusCode::INTERNAL_SERVER_ERROR,
                crate::sanitize_error(&e, "workspace_load_join"),
            ))
        }
    };

    let workspace = workspace.ok_or_else(|| {
        (
            StatusCode::BAD_REQUEST,
            format!("Workspace {} not found", workspace_id),
        )
    })?;

    serde_json::from_str::<ResourceLimits>(&workspace.resources).map_err(|error| {
        (
            StatusCode::BAD_REQUEST,
            crate::sanitize_error(&error, "workspace_resources_parse"),
        )
    })
}

/// Validate command against whitelist.
///
/// Strict mode is enabled by default. Commands must match `STRICT_MODE_ALLOWED_COMMANDS`,
/// the `ERGATAI_ALLOWED_COMMANDS` env var, OR any binary registered in the ProfileRegistry.
/// Set `ERGATAI_STRICT_MODE=0` to disable validation (not recommended).
async fn validate_command(command: &str) -> Result<(), String> {
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
    match tokio::task::spawn_blocking(move || {
        crate::services::profile_service::get_profile_registry()
    })
    .await
    {
        Ok(Ok(registry)) => {
            if let Ok(profiles) = registry.list_with_status() {
                for profile in profiles {
                    // Match against profile name (e.g. "claude-code" matches profile "claude-code")
                    if profile.name == binary_name || profile.name == program {
                        return Ok(());
                    }
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
        Ok(Err(_)) => {} // Registry not available, continue with static whitelist
        Err(_) => {}     // Task join error, continue with static whitelist
    }

    Err(format!(
        "Command '{}' is not allowed (strict mode)",
        binary_name
    ))
}

#[utoipa::path(
    post,
    path = "/api/v1/agents",
    tag = "Agents",
    request_body = SpawnAgentRequest,
    responses(
        (status = 201, description = "Agent launched", body = SpawnAgentResponse),
        (status = 400, description = "Invalid agent request", body = crate::api::ApiError),
        (status = 403, description = "Command not allowed", body = crate::api::ApiError),
        (status = 503, description = "Agent limit reached", body = crate::api::ApiError),
        (status = 500, description = "Internal server error", body = crate::api::ApiError),
    )
)]
pub async fn spawn_agent(
    State(state): State<AppState>,
    Json(req): Json<SpawnAgentRequest>,
) -> impl IntoResponse {
    // Security: validate command against whitelist before execution
    if let Err(e) = validate_command(&req.command).await {
        return (StatusCode::FORBIDDEN, Json(ErrorResponse { error: e })).into_response();
    }

    // Resolve profile name to its actual launch command.
    // Frontend sends the profile name (e.g. "claude-code") from list_profiles();
    // the backend looks up the profile and uses its configured command.
    // Keep the original profile name for AgentInfo.profile field.
    //
    // Backward compatibility: If no matching profile is found, treat req.command
    // as a raw command (legacy behavior for direct command specification).
    let (resolved_command, profile_name, transport_type) =
        match tokio::task::spawn_blocking(move || {
            crate::services::profile_service::get_profile_registry()
        })
        .await
        {
            Ok(Ok(registry)) => {
                if let Ok(profiles) = registry.list_with_status() {
                    // Debug: log all available profiles
                    tracing::debug!(
                        request_command = %req.command,
                        available_profiles = ?profiles.iter().map(|p| &p.name).collect::<Vec<_>>(),
                        "Looking up profile for command"
                    );

                    match profiles.into_iter().find(|p| p.name == req.command) {
                        Some(profile) => {
                            tracing::info!(
                                profile_name = %profile.name,
                                profile_command = %profile.command,
                                transport = ?profile.transport,
                                "Found matching profile"
                            );

                            // Check adapter version (cached per-process, one-time check)
                            check_and_update_adapter_if_needed(
                                &profile.name,
                                profile.package_name.as_deref(),
                                profile.is_managed,
                            )
                            .await;

                            (
                                profile.command,
                                Some(profile.name),
                                profile.transport.clone(),
                            )
                        }
                        None => {
                            tracing::warn!(
                                request_command = %req.command,
                                "No matching profile found, using command as-is"
                            );
                            (req.command.clone(), None, None)
                        }
                    }
                } else {
                    (req.command.clone(), None, None)
                }
            }
            _ => (req.command.clone(), None, None),
        };

    if req.workspace_id.is_none() && req.conversation_id.is_none() {
        return (
            StatusCode::BAD_REQUEST,
            Json(ErrorResponse {
                error: "Either workspace_id or conversation_id is required".to_string(),
            }),
        )
            .into_response();
    }

    let mut workspace_id = req.workspace_id.clone();
    let mut raw_work_dir = req.work_dir.clone();
    let mut env = req.env.clone();
    let capture_thoughts = false;

    let mut spawn_chat_id: Option<String> = None;

    if let Some(conversation_id) = req.conversation_id.as_deref() {
        let conversation_id_for_get = conversation_id.to_string();
        match tokio::task::spawn_blocking(move || {
            crate::user_data_db::conversations::get(&conversation_id_for_get)
        })
        .await
        {
            Ok(Ok(Some(conversation))) => {
                spawn_chat_id = Some(
                    conversation
                        .parent_id
                        .clone()
                        .unwrap_or_else(|| conversation.conversation_id.clone()),
                );
            }
            Ok(Ok(None)) => {
                return (
                    StatusCode::NOT_FOUND,
                    Json(ErrorResponse {
                        error: "Conversation not found".to_string(),
                    }),
                )
                    .into_response();
            }
            Ok(Err(e)) => {
                return (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(ErrorResponse {
                        error: crate::sanitize_error(&e, "conversation_load"),
                    }),
                )
                    .into_response();
            }
            Err(e) => {
                return (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(ErrorResponse {
                        error: crate::sanitize_error(&e, "conversation_load_join"),
                    }),
                )
                    .into_response();
            }
        }

        let conversation_id_for_resolve = conversation_id.to_string();
        let resolved_workspace_id = match tokio::task::spawn_blocking(move || {
            crate::user_data_db::conversations::resolve_workspace_id(&conversation_id_for_resolve)
        })
        .await
        {
            Ok(Ok(Some(workspace_id))) => workspace_id,
            Ok(Ok(None)) => {
                return (
                    StatusCode::BAD_REQUEST,
                    Json(ErrorResponse {
                        error: "Conversation has no workspace".to_string(),
                    }),
                )
                    .into_response();
            }
            Ok(Err(e)) => {
                return (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(ErrorResponse {
                        error: crate::sanitize_error(&e, "conversation_resolve_workspace"),
                    }),
                )
                    .into_response();
            }
            Err(e) => {
                return (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(ErrorResponse {
                        error: crate::sanitize_error(&e, "conversation_resolve_workspace_join"),
                    }),
                )
                    .into_response();
            }
        };

        if let Some(requested_workspace_id) = &workspace_id {
            if requested_workspace_id != &resolved_workspace_id {
                return (
                    StatusCode::CONFLICT,
                    Json(ErrorResponse {
                        error: "workspace_id does not match the conversation workspace".to_string(),
                    }),
                )
                    .into_response();
            }
        }

        let resolved_workspace_id_for_get = resolved_workspace_id.clone();
        let workspace = match tokio::task::spawn_blocking(move || {
            crate::user_data_db::workspaces::get(&resolved_workspace_id_for_get)
        })
        .await
        {
            Ok(Ok(Some(workspace))) => workspace,
            Ok(Ok(None)) => {
                return (
                    StatusCode::BAD_REQUEST,
                    Json(ErrorResponse {
                        error: "Conversation workspace not found".to_string(),
                    }),
                )
                    .into_response();
            }
            Ok(Err(e)) => {
                return (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(ErrorResponse {
                        error: crate::sanitize_error(&e, "conversation_workspace_load"),
                    }),
                )
                    .into_response();
            }
            Err(e) => {
                return (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(ErrorResponse {
                        error: crate::sanitize_error(&e, "conversation_workspace_load_join"),
                    }),
                )
                    .into_response();
            }
        };

        let conversation_id_for_context = conversation_id.to_string();
        let execution_context = match tokio::task::spawn_blocking(move || {
            crate::user_data_db::conversation_execution_contexts::get(&conversation_id_for_context)
        })
        .await
        {
            Ok(Ok(context)) => context,
            Ok(Err(e)) => {
                return (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(ErrorResponse {
                        error: crate::sanitize_error(&e, "execution_context_load"),
                    }),
                )
                    .into_response();
            }
            Err(e) => {
                return (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(ErrorResponse {
                        error: crate::sanitize_error(&e, "execution_context_load_join"),
                    }),
                )
                    .into_response();
            }
        };

        raw_work_dir = Some(
            execution_context
                .and_then(|context| context.worktree_path)
                .unwrap_or(workspace.work_dir),
        );
        env = serde_json::from_str::<HashMap<String, String>>(&workspace.env)
            .map(Some)
            .unwrap_or(None);
        workspace_id = Some(resolved_workspace_id);
    }

    let workspace_id = workspace_id.expect("workspace_id is checked above");

    if !is_valid_workspace_id(&workspace_id) {
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
        let runtime = crate::context::get_app_context().agent_runtime.clone();
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

    let runtime = crate::context::get_app_context().agent_runtime.clone();
    let env = env.unwrap_or_default();

    // SECURITY (P1 #13): validate and canonicalize the work_dir.
    // Rejects path traversal, non-existent dirs, and (optionally) paths outside
    // ERGATAI_WORKSPACE_ROOT. The canonical path is what the agent process will
    // actually use as its cwd.
    let raw_work_dir = raw_work_dir.unwrap_or_else(|| state.default_cwd.clone());
    let work_dir = match crate::validate_cwd(&raw_work_dir) {
        Ok(p) => p,
        Err(msg) => {
            return (StatusCode::BAD_REQUEST, Json(ErrorResponse { error: msg })).into_response();
        }
    };
    let work_dir_str = work_dir.to_string_lossy().into_owned();
    let resources = match workspace_resource_limits(&workspace_id).await {
        Ok(resources) => resources,
        Err((status, error)) => {
            return (status, Json(ErrorResponse { error })).into_response();
        }
    };

    let spec = WorkspaceSpec {
        id: workspace_id,
        work_dir: work_dir_str.as_str().into(),
        env,
        resources,
        capture_thoughts,
    };

    // Use provided transport type from profile (already set during registration)
    let effective_transport = transport_type.as_deref();

    match runtime
        .launch_agent_scoped(
            spec,
            &resolved_command,
            req.instruction.as_deref(),
            spawn_chat_id.as_deref(),
            None, // conversation_id - will be generated by runtime
            profile_name.as_deref(),
            effective_transport,
        )
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

#[utoipa::path(
    delete,
    path = "/api/v1/agents/{id}",
    tag = "Agents",
    params(("id" = String, Path, description = "Agent ID")),
    responses(
        (status = 204, description = "Agent stopped"),
        (status = 404, description = "Agent not found", body = crate::api::ApiError),
        (status = 500, description = "Internal server error", body = crate::api::ApiError),
    )
)]
pub async fn kill_agent(
    State(_state): State<AppState>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    let runtime = crate::context::get_app_context().agent_runtime.clone();

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
        Ok(_) => {
            // Clean up current prompt conversation tracking
            crate::services::agent_service::set_current_prompt_conversation(&id, None);
            StatusCode::NO_CONTENT.into_response()
        }
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

#[utoipa::path(
    post,
    path = "/api/v1/agents/{id}/message",
    tag = "Agents",
    params(("id" = String, Path, description = "Agent ID")),
    request_body = SendMessageRequest,
    responses(
        (status = 200, description = "Message queued or delivered"),
        (status = 404, description = "Agent not found", body = crate::api::ApiError),
        (status = 500, description = "Internal server error", body = crate::api::ApiError),
    )
)]
pub async fn send_message(
    State(_state): State<AppState>,
    Path(id): Path<String>,
    Json(req): Json<SendMessageRequest>,
) -> impl IntoResponse {
    // Validate message is not empty/whitespace
    if req.message.trim().is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(ErrorResponse {
                error: "Message cannot be empty".to_string(),
            }),
        )
            .into_response();
    }

    // Validate message length to prevent resource exhaustion
    const MAX_MESSAGE_LENGTH: usize = 1_000_000; // 1MB limit
    if req.message.len() > MAX_MESSAGE_LENGTH {
        return (
            StatusCode::BAD_REQUEST,
            Json(ErrorResponse {
                error: format!(
                    "Message too large: {} bytes (max: {} bytes)",
                    req.message.len(),
                    MAX_MESSAGE_LENGTH
                ),
            }),
        )
            .into_response();
    }

    // Validate message_type if provided
    if let Some(ref msg_type) = req.message_type {
        if !matches!(msg_type.as_str(), "request" | "response" | "broadcast") {
            return (
                StatusCode::BAD_REQUEST,
                Json(ErrorResponse {
                    error: "message_type must be one of: request, response, broadcast".to_string(),
                }),
            )
                .into_response();
        }
    }

    // Validate from if provided (non-empty)
    if let Some(ref from) = req.from {
        if from.trim().is_empty() {
            return (
                StatusCode::BAD_REQUEST,
                Json(ErrorResponse {
                    error: "from cannot be empty".to_string(),
                }),
            )
                .into_response();
        }
    }

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

    // Check if this is an agent-to-agent routing request
    if let Some(target_command) = &req.target_agent_command {
        // Get the sender agent's info to find its workspace/chat
        let sender_info = match crate::services::agent_service::get_agent_info(&id).await {
            Some(info) => info,
            None => {
                return (
                    StatusCode::NOT_FOUND,
                    Json(serde_json::json!({
                        "status": "error",
                        "message": format!("Sender agent {} not found", id),
                    })),
                )
                    .into_response();
            }
        };

        // Resolve the owning chat from the collaboration conversation.
        let Some(requested_conversation_id) = req.conversation_id.clone() else {
            return (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({
                    "status": "error",
                    "message": "conversation_id is required for agent-to-agent routing",
                })),
            )
                .into_response();
        };

        let chat_id = {
            let requested_conversation_id = requested_conversation_id.clone();
            match tokio::task::spawn_blocking(move || -> Result<String, String> {
                if let Ok(Some(conversation)) =
                    crate::user_data_db::conversations::get(&requested_conversation_id)
                {
                    return Ok(conversation
                        .parent_id
                        .unwrap_or(conversation.conversation_id));
                }
                Err("Conversation not found for agent-to-agent routing".to_string())
            })
            .await
            {
                Ok(Ok(chat_id)) => chat_id,
                Ok(Err(message)) => {
                    return (
                        StatusCode::BAD_REQUEST,
                        Json(serde_json::json!({
                            "status": "error",
                            "message": message,
                        })),
                    )
                        .into_response();
                }
                Err(error) => {
                    return (
                        StatusCode::INTERNAL_SERVER_ERROR,
                        Json(serde_json::json!({
                            "status": "error",
                            "message": format!("Failed to resolve chat: {error}"),
                        })),
                    )
                        .into_response();
                }
            }
        };

        // Check if we should force a new session
        let force_new = req.force_new_session.unwrap_or(false);

        if !force_new {
            // Try to find an existing agent with the target command bound to this chat
            let chat_id_for_list = chat_id.clone();
            let bindings_result = match tokio::task::spawn_blocking(move || {
                crate::user_data_db::group_agent_bindings::list(&chat_id_for_list)
            })
            .await
            {
                Ok(Ok(bindings)) => Some(bindings),
                _ => None,
            };

            if let Some(bindings) = bindings_result {
                for binding in bindings {
                    if binding.agent_command.as_deref() == Some(target_command) {
                        // Check if this agent is alive
                        if let Some(target_info) =
                            crate::services::agent_service::get_agent_info(&binding.agent_id).await
                        {
                            if target_info.lifecycle.is_alive() {
                                // Route to this existing agent's own conversation.
                                let target_conversation_id = binding.conversation_id.clone();
                                let send_req = SendRequest {
                                    from: req.from.unwrap_or_else(|| id.clone()),
                                    to: binding.agent_id.clone(),
                                    target_conversation_id: None, // REST API uses agent-centric routing
                                    message: req.message,
                                    message_type: req
                                        .message_type
                                        .unwrap_or_else(|| "request".to_string()),
                                    correlation_id: req.correlation_id,
                                    conversation_id: Some(target_conversation_id),
                                };

                                match sender.send(send_req).await {
                                    SendMessageResult::Queued {
                                        target_agent,
                                        stream,
                                        sequence,
                                    } => {
                                        return (
                                            StatusCode::OK,
                                            Json(serde_json::json!({
                                                "status": "queued",
                                                "target_agent_id": target_agent,
                                                "session_id": stream,
                                                "sequence": sequence,
                                                "reused": true,
                                            })),
                                        )
                                            .into_response();
                                    }
                                    SendMessageResult::DirectDelivered { target_agent } => {
                                        return (
                                            StatusCode::OK,
                                            Json(serde_json::json!({
                                                "status": "direct_delivered",
                                                "target_agent_id": target_agent,
                                                "reused": true,
                                            })),
                                        )
                                            .into_response();
                                    }
                                    SendMessageResult::Rejected { reason } => {
                                        return (
                                            StatusCode::BAD_REQUEST,
                                            Json(serde_json::json!({
                                                "status": "rejected",
                                                "reason": reason,
                                            })),
                                        )
                                            .into_response();
                                    }
                                }
                            } else {
                                // Agent is dead - clean up stale binding
                                let chat_id_for_delete = chat_id.clone();
                                let agent_id_for_delete = binding.agent_id.clone();
                                if let Err(e) = tokio::task::spawn_blocking(move || {
                                    crate::user_data_db::group_agent_bindings::delete(
                                        &chat_id_for_delete,
                                        &agent_id_for_delete,
                                    )
                                })
                                .await
                                {
                                    tracing::warn!(
                                        agent_id = %binding.agent_id,
                                        error = %e,
                                        "Failed to clean up stale binding for dead agent"
                                    );
                                }
                            }
                        } else {
                            // Agent not found - clean up stale binding
                            let chat_id_for_delete = chat_id.clone();
                            let agent_id_for_delete = binding.agent_id.clone();
                            if let Err(e) = tokio::task::spawn_blocking(move || {
                                crate::user_data_db::group_agent_bindings::delete(
                                    &chat_id_for_delete,
                                    &agent_id_for_delete,
                                )
                            })
                            .await
                            {
                                tracing::warn!(
                                    agent_id = %binding.agent_id,
                                    error = %e,
                                    "Failed to clean up stale binding for missing agent"
                                );
                            }
                        }
                    }
                }
            }
        }

        // No existing agent found or force_new_session is true - spawn a new one
        // Resolve profile name to actual command. Keep the original profile name for AgentInfo.profile.
        let (resolved_command, profile_name, transport_type) =
            match tokio::task::spawn_blocking(move || {
                crate::services::profile_service::get_profile_registry()
            })
            .await
            {
                Ok(Ok(registry)) => {
                    if let Ok(profiles) = registry.list_with_status() {
                        match profiles.into_iter().find(|p| p.name == *target_command) {
                            Some(profile) => (
                                profile.command,
                                Some(profile.name),
                                profile.transport.clone(),
                            ),
                            None => (target_command.clone(), None, None),
                        }
                    } else {
                        (target_command.clone(), None, None)
                    }
                }
                _ => (target_command.clone(), None, None),
            };

        // Security: validate command
        if let Err(e) = validate_command(&resolved_command).await {
            return (StatusCode::FORBIDDEN, Json(ErrorResponse { error: e })).into_response();
        }

        // Check agent cap
        let max_agents: usize = std::env::var("ERGATAI_MAX_AGENTS")
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(50);
        {
            let runtime = crate::context::get_app_context().agent_runtime.clone();
            let list = runtime.list_agents().await;
            if list.len() >= max_agents {
                return (
                    StatusCode::SERVICE_UNAVAILABLE,
                    Json(serde_json::json!({
                        "status": "error",
                        "message": format!("Agent limit reached ({}/{}).", list.len(), max_agents),
                    })),
                )
                    .into_response();
            }
        }

        let runtime = crate::context::get_app_context().agent_runtime.clone();

        // Get work_dir from workspace metadata or use a default
        let work_dir = sender_info
            .handle
            .workspace
            .metadata
            .get("work_dir")
            .cloned()
            .unwrap_or_else(|| "/tmp".to_string());
        let resources = match workspace_resource_limits(&sender_info.workspace_id).await {
            Ok(resources) => resources,
            Err((status, error)) => {
                return (status, Json(ErrorResponse { error })).into_response();
            }
        };

        let spec = WorkspaceSpec {
            id: sender_info.workspace_id.clone(),
            work_dir: work_dir.as_str().into(),
            env: std::collections::HashMap::new(),
            resources,
            capture_thoughts: false,
        };

        let instruction = Some(format!(
            "Agent-to-agent message from {}. Target command: {}.",
            id, target_command
        ));

        match runtime
            .launch_agent_scoped(
                spec,
                &resolved_command,
                instruction.as_deref(),
                Some(&chat_id),
                None, // conversation_id - will be generated by runtime
                profile_name.as_deref(),
                transport_type.as_deref(),
            )
            .await
        {
            Ok(new_agent_id) => {
                tracing::info!(
                    from_agent = %id,
                    new_agent = %new_agent_id,
                    target_command = %target_command,
                    chat_id = %chat_id,
                    "Spawned new agent for agent-to-agent routing"
                );

                // Get the conversation_id from the new agent's metadata
                // This ensures the database conversation ID matches the NATS routing ID
                let agent_conversation_id = match runtime.get_agent(&new_agent_id).await {
                    Some(agent_info) => agent_info
                        .handle
                        .metadata
                        .get("conversation_id")
                        .cloned()
                        .unwrap_or_else(|| format_id(generate(), IdType::Conversation)),
                    None => {
                        tracing::warn!(
                            new_agent = %new_agent_id,
                            "Failed to get agent info, generating new conversation_id"
                        );
                        format_id(generate(), IdType::Conversation)
                    }
                };

                // Bind the new agent to its own conversation below the chat.
                let now = chrono::Utc::now().timestamp();
                let chat_id_for_conversation = chat_id.clone();
                let agent_command_for_name = target_command.clone();
                let conversation_id_for_create = agent_conversation_id.clone();
                let create_conversation =
                    tokio::task::spawn_blocking(move || -> Result<String, rusqlite::Error> {
                        let Some(root_conversation) =
                            crate::user_data_db::conversations::get(&chat_id_for_conversation)?
                        else {
                            return Err(rusqlite::Error::QueryReturnedNoRows);
                        };

                        crate::user_data_db::conversations::create(
                            crate::user_data_db::Conversation {
                                conversation_id: conversation_id_for_create.clone(),
                                collaboration_session_id: root_conversation
                                    .collaboration_session_id
                                    .clone(),
                                chat_id: root_conversation.chat_id.clone(),
                                parent_id: Some(chat_id_for_conversation),
                                name: Some(agent_command_for_name),
                                mode: "agent".to_string(),
                                participant_role: "peer".to_string(),
                                status: "ready".to_string(),
                                created_at: now,
                                updated_at: now,
                            },
                        )?;
                        Ok(conversation_id_for_create)
                    })
                    .await;

                let agent_conversation_id = match create_conversation {
                    Ok(Ok(conversation_id)) => conversation_id,
                    Ok(Err(error)) => {
                        return (
                            StatusCode::INTERNAL_SERVER_ERROR,
                            Json(serde_json::json!({
                                "status": "error",
                                "message": format!("Failed to create agent conversation: {error}"),
                            })),
                        )
                            .into_response();
                    }
                    Err(error) => {
                        return (
                            StatusCode::INTERNAL_SERVER_ERROR,
                            Json(serde_json::json!({
                                "status": "error",
                                "message": format!("Failed to create agent conversation: {error}"),
                            })),
                        )
                            .into_response();
                    }
                };

                let binding = crate::user_data_db::GroupAgentBinding {
                    workspace_id: sender_info.workspace_id.clone(),
                    chat_id: chat_id.clone(),
                    agent_id: new_agent_id.clone(),
                    agent_name: target_command.clone(),
                    agent_command: Some(target_command.clone()),
                    conversation_id: agent_conversation_id.clone(),
                    created_at: now,
                    updated_at: now,
                };

                if let Err(e) = tokio::task::spawn_blocking(move || {
                    crate::user_data_db::group_agent_bindings::upsert(binding)
                })
                .await
                {
                    tracing::warn!(
                        error = %e,
                        "Failed to bind new agent to chat (non-fatal)"
                    );
                }

                // Bind the runtime agent session to the new conversation.
                let session_id =
                    crate::services::agent_service::get_agent_session_id(&new_agent_id)
                        .await
                        .unwrap_or_default();
                let conversation_id_for_agent_session = agent_conversation_id.clone();
                let agent_session_id = format_id(generate(), IdType::Session);
                if let Err(error) = tokio::task::spawn_blocking(move || {
                    crate::user_data_db::agent_sessions::upsert(crate::user_data_db::AgentSession {
                        agent_session_id,
                        conversation_id: conversation_id_for_agent_session,
                        acp_session_id: Some(session_id),
                        mode: "agent".to_string(),
                        created_at: now,
                        updated_at: now,
                    })
                })
                .await
                {
                    tracing::warn!(error = %error, "Failed to bind agent session to conversation");
                }

                // Register the conversation in the collaboration session.
                let chat_id_for_participant = chat_id.clone();
                let session_for_participant = tokio::task::spawn_blocking(move || {
                    crate::services::collaboration_session::find_session_by_chat(
                        &chat_id_for_participant,
                    )
                })
                .await;
                let new_agent_id_for_participant = new_agent_id.clone();
                match session_for_participant {
                    Ok(Ok(Some(session))) => {
                        let participant_conversation_id = agent_conversation_id.clone();
                        if let Err(error) = tokio::task::spawn_blocking(move || {
                            crate::services::collaboration_session::upsert_participant(
                                &session.collaboration_session_id,
                                crate::services::collaboration_session::ParticipantInput {
                                    conversation_id: participant_conversation_id,
                                    agent_id: new_agent_id_for_participant,
                                    role: "peer".to_string(),
                                    status: "ready".to_string(),
                                },
                            )
                        })
                        .await
                        {
                            tracing::warn!(error = %error, "Failed to register collaboration participant");
                        }
                    }
                    Ok(Ok(None)) => {
                        tracing::warn!(chat_id = %chat_id, "Collaboration session not found for spawned agent");
                    }
                    Ok(Err(error)) => {
                        tracing::warn!(error = %error, "Failed to resolve collaboration session");
                    }
                    Err(error) => {
                        tracing::warn!(error = %error, "Failed to resolve collaboration session");
                    }
                }

                // Now send the message to the new agent
                let send_req = SendRequest {
                    from: req.from.unwrap_or_else(|| id.clone()),
                    to: new_agent_id.clone(),
                    target_conversation_id: None, // REST API uses agent-centric routing
                    message: req.message,
                    message_type: req.message_type.unwrap_or_else(|| "request".to_string()),
                    correlation_id: req.correlation_id,
                    conversation_id: Some(agent_conversation_id),
                };

                return match sender.send(send_req).await {
                    SendMessageResult::Queued {
                        target_agent,
                        stream,
                        sequence,
                    } => (
                        StatusCode::OK,
                        Json(serde_json::json!({
                            "status": "queued",
                            "target_agent_id": target_agent,
                            "session_id": stream,
                            "sequence": sequence,
                            "spawned": true,
                        })),
                    )
                        .into_response(),
                    SendMessageResult::DirectDelivered { target_agent } => (
                        StatusCode::OK,
                        Json(serde_json::json!({
                            "status": "direct_delivered",
                            "target_agent_id": target_agent,
                            "spawned": true,
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
                };
            }
            Err(e) => {
                return (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(serde_json::json!({
                        "status": "error",
                        "message": crate::sanitize_error(&e, "send_message_spawn_agent"),
                    })),
                )
                    .into_response();
            }
        }
    }

    // Normal message sending (no agent-to-agent routing)
    let send_req = SendRequest {
        from: req.from.unwrap_or_else(|| "api".to_string()),
        to: id.clone(),
        target_conversation_id: None, // REST API uses agent-centric routing
        message: req.message,
        message_type: req.message_type.unwrap_or_else(|| "request".to_string()),
        correlation_id: req.correlation_id,
        conversation_id: req.conversation_id,
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

/// Request type for POST /api/v1/agents/:agent_id/spawn-session
#[derive(Debug, Deserialize)]
pub struct SpawnSessionRequest {
    /// Target agent command to spawn (e.g., "claude", "codex")
    pub target_command: String,
    /// Reason for spawning a new session
    #[serde(default)]
    pub reason: Option<String>,
    /// Whether to inherit context from the parent agent
    #[serde(default)]
    pub inherit_context: Option<bool>,
    /// Workspace ID for the new agent (defaults to parent's workspace)
    #[serde(default)]
    pub workspace_id: Option<String>,
}

/// Response type for POST /api/v1/agents/:agent_id/spawn-session
#[derive(Debug, Serialize)]
pub struct SpawnSessionResponse {
    pub new_session_id: String,
    pub new_agent_id: String,
    pub message: String,
}

/// POST /api/v1/agents/:agent_id/spawn-session
/// Explicitly spawn a new agent session from an existing agent.
/// Used for context overflow, task separation, or explicit user requests.
pub async fn spawn_session(
    State(state): State<AppState>,
    Path(parent_agent_id): Path<String>,
    Json(req): Json<SpawnSessionRequest>,
) -> impl IntoResponse {
    // Get parent agent info to determine workspace
    let parent_info = match crate::services::agent_service::get_agent_info(&parent_agent_id).await {
        Some(info) => info,
        None => {
            return (
                StatusCode::NOT_FOUND,
                Json(ErrorResponse {
                    error: format!("Parent agent {} not found", parent_agent_id),
                }),
            )
                .into_response();
        }
    };

    // Resolve profile name to actual command. Keep the original profile name for AgentInfo.profile.
    let (resolved_command, profile_name, transport_type) =
        match tokio::task::spawn_blocking(move || {
            crate::services::profile_service::get_profile_registry()
        })
        .await
        {
            Ok(Ok(registry)) => {
                if let Ok(profiles) = registry.list_with_status() {
                    match profiles.into_iter().find(|p| p.name == req.target_command) {
                        Some(profile) => (
                            profile.command,
                            Some(profile.name),
                            profile.transport.clone(),
                        ),
                        None => (req.target_command.clone(), None, None),
                    }
                } else {
                    (req.target_command.clone(), None, None)
                }
            }
            _ => (req.target_command.clone(), None, None),
        };

    // Security: validate command
    if let Err(e) = validate_command(&resolved_command).await {
        return (StatusCode::FORBIDDEN, Json(ErrorResponse { error: e })).into_response();
    }

    // Use parent's workspace or the provided one
    let workspace_id = req
        .workspace_id
        .unwrap_or_else(|| parent_info.workspace_id.clone());

    // Security: validate workspace_id
    if !is_valid_workspace_id(&workspace_id) {
        return (
            StatusCode::BAD_REQUEST,
            Json(ErrorResponse {
                error: "workspace_id must contain only alphanumeric characters, hyphens, or underscores".to_string(),
            }),
        )
            .into_response();
    }

    // Check agent cap
    let max_agents: usize = std::env::var("ERGATAI_MAX_AGENTS")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(50);
    {
        let runtime = crate::context::get_app_context().agent_runtime.clone();
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

    let runtime = crate::context::get_app_context().agent_runtime.clone();

    // Get work_dir from workspace metadata
    let work_dir = parent_info
        .handle
        .workspace
        .metadata
        .get("work_dir")
        .cloned()
        .unwrap_or_else(|| state.default_cwd.clone());
    let resources = match workspace_resource_limits(&workspace_id).await {
        Ok(resources) => resources,
        Err((status, error)) => {
            return (status, Json(ErrorResponse { error })).into_response();
        }
    };

    let spec = WorkspaceSpec {
        id: workspace_id.clone(),
        work_dir: work_dir.as_str().into(),
        env: std::collections::HashMap::new(),
        resources,
        capture_thoughts: false,
    };

    // Build instruction based on reason and context inheritance
    let instruction = if req.inherit_context.unwrap_or(false) {
        Some(format!(
            "New session spawned from agent {}. Reason: {}. Please continue the work from the parent agent's context.",
            parent_agent_id,
            req.reason.as_deref().unwrap_or("explicit_request")
        ))
    } else {
        Some(format!(
            "New session spawned from agent {}. Reason: {}.",
            parent_agent_id,
            req.reason.as_deref().unwrap_or("explicit_request")
        ))
    };

    let spawn_chat_id = parent_info
        .handle
        .workspace
        .metadata
        .get("ergatai_chat_id")
        .cloned();

    match runtime
        .launch_agent_scoped(
            spec,
            &resolved_command,
            instruction.as_deref(),
            spawn_chat_id.as_deref(),
            None, // conversation_id - will be generated by runtime
            profile_name.as_deref(),
            transport_type.as_deref(),
        )
        .await
    {
        Ok(new_agent_id) => {
            tracing::info!(
                parent_agent_id = %parent_agent_id,
                new_agent_id = %new_agent_id,
                workspace = %workspace_id,
                reason = ?req.reason,
                "New session spawned successfully"
            );

            // Get the session ID for the new agent
            let session_id = crate::services::agent_service::get_agent_session_id(&new_agent_id)
                .await
                .unwrap_or_default();

            let reason_text = req.reason.as_deref().unwrap_or("explicit_request");

            (
                StatusCode::CREATED,
                Json(SpawnSessionResponse {
                    new_session_id: session_id,
                    new_agent_id,
                    message: format!("New session created for {}", reason_text),
                }),
            )
                .into_response()
        }
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse {
                error: crate::sanitize_error(&e, "spawn_session"),
            }),
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
    match crate::services::agent_service::get_agent_thoughts(&id).await {
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
                error: crate::sanitize_error(&e, "get_agent_thoughts"),
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
    let result = crate::services::agent_service::get_agent_tool_calls(&id).await;
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
                error: crate::sanitize_error(&e, "monitoring_handler"),
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
    match crate::services::agent_service::get_agent_plan(&id).await {
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
                error: crate::sanitize_error(&e, "monitoring_handler"),
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
#[derive(Debug, Serialize, ToSchema)]
pub struct ConfigOptionInfo {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    pub category: Option<String>,
    #[schema(value_type = Object, nullable = true)]
    pub kind: Option<serde_json::Value>,
}

/// Get recent elicitation requests for an agent.
pub async fn get_agent_elicitations(
    State(_state): State<AppState>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    let result = crate::services::agent_service::get_agent_elicitations(&id).await;
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
                error: crate::sanitize_error(&e, "monitoring_handler"),
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
    let result = crate::services::agent_service::get_agent_available_commands(&id).await;
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
                error: crate::sanitize_error(&e, "monitoring_handler"),
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
                error: crate::sanitize_error(&e, "monitoring_handler"),
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
                error: crate::sanitize_error(&e, "monitoring_handler"),
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
                error: crate::sanitize_error(&e, "monitoring_handler"),
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
                error: crate::sanitize_error(&e, "monitoring_handler"),
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
                error: crate::sanitize_error(&e, "monitoring_handler"),
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
/// Parses "Current model: XXX" for the current model.
/// Also parses "Available: A, B, C, ..." for the full list of available models.
fn parse_model_output(output: &str) -> Option<serde_json::Value> {
    let mut models = Vec::new();
    let mut current_model = None;

    for line in output.lines() {
        let trimmed = line.trim();

        // Parse "Current model: XXX" or "Current model: `XXX`"
        if trimmed.starts_with("Current model:") {
            if let Some(model) = trimmed.strip_prefix("Current model:").map(|s| s.trim()) {
                let clean_model = model.trim_matches('`');
                if !clean_model.is_empty() {
                    current_model = Some(clean_model.to_string());
                    if !models.contains(&clean_model.to_string()) {
                        models.push(clean_model.to_string());
                    }
                }
            }
        }

        // Parse "Available: A, B, C, ..."
        if trimmed.starts_with("Available:") {
            if let Some(available) = trimmed.strip_prefix("Available:").map(|s| s.trim()) {
                // Remove trailing period if present
                let available = available.strip_suffix('.').unwrap_or(available);
                for part in available.split(',') {
                    let name = part.trim();
                    if !name.is_empty()
                        && !name.starts_with("or ")
                        && name != "default"
                        && !models.contains(&name.to_string())
                    {
                        models.push(name.to_string());
                    }
                }
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

/// Get configuration options reported by the agent.
pub async fn get_agent_config_options(
    State(_state): State<AppState>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    let result = crate::services::agent_service::get_agent_config_options(&id).await;
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
                error: crate::sanitize_error(&e, "monitoring_handler"),
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
    let result = crate::services::agent_service::get_agent_usage(&id).await;
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
                error: crate::sanitize_error(&e, "monitoring_handler"),
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
    let result = crate::services::agent_service::get_agent_output(&id).await;
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
                error: crate::sanitize_error(&e, "monitoring_handler"),
            }),
        )
            .into_response(),
    }
}

/// Response for agent last structured activity age endpoint.
#[derive(Serialize)]
pub struct AgentLastActivityResponse {
    pub agent_id: String,
    /// Seconds since the agent's last structured activity event.
    pub last_activity_age_secs: f64,
}

/// Get the time elapsed since the agent's last structured activity.
pub async fn get_agent_last_activity(
    State(_state): State<AppState>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    let result = crate::services::agent_service::get_agent_last_activity_age(&id).await;
    match result {
        Ok(Some(duration)) => (
            StatusCode::OK,
            Json(AgentLastActivityResponse {
                agent_id: id,
                last_activity_age_secs: duration.as_secs_f64(),
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
                error: crate::sanitize_error(&e, "monitoring_handler"),
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
    let result = crate::services::agent_service::get_agent_exit_code(&id).await;
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
                error: crate::sanitize_error(&e, "monitoring_handler"),
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
    let result = crate::services::agent_service::get_agent_pid(&id).await;
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
                error: crate::sanitize_error(&e, "monitoring_handler"),
            }),
        )
            .into_response(),
    }
}

// ── Prompt & SSE streaming ──

#[derive(Debug, Deserialize, ToSchema)]
pub struct PromptAgentRequest {
    pub message: String,
    /// Conversation associated with this prompt.
    #[serde(default)]
    pub conversation_id: Option<String>,
    /// Optional sender identity for agent-to-agent UI rendering.
    #[serde(default)]
    pub sender_agent_id: Option<String>,
    #[serde(default)]
    pub sender_agent_name: Option<String>,
    /// Optional image attachments sent as base64 ACP content blocks.
    #[serde(default)]
    #[schema(value_type = Vec<Object>)]
    pub images: Vec<ergatai_runtime::AgentImage>,
    /// Server-side dispatchers can execute immediately; chat transports wait
    /// for their paired SSE stream to subscribe first.
    #[serde(default = "default_true")]
    pub wait_for_stream: bool,
    /// Whether to insert this message at the next safe point (after thinking/tool completion)
    /// rather than waiting in FIFO queue. Default: false.
    #[serde(default)]
    pub interrupt: bool,
}

fn default_true() -> bool {
    true
}

/// POST /api/v1/agents/:id/prompt — send a prompt to an agent (non-blocking).
///
/// Returns 202 Accepted immediately. The agent processes the prompt in the
/// background; output events are available via `GET /api/v1/conversations/{id}/sse`.
#[utoipa::path(
    post,
    path = "/api/v1/agents/{id}/prompt",
    tag = "Agents",
    params(("id" = String, Path, description = "Agent ID")),
    request_body = PromptAgentRequest,
    responses(
        (status = 202, description = "Prompt accepted"),
        (status = 400, description = "Prompt rejected", body = crate::api::ApiError),
        (status = 404, description = "Agent or sub-chat not found", body = crate::api::ApiError),
        (status = 500, description = "Internal server error", body = crate::api::ApiError),
    )
)]
pub async fn prompt_agent(
    State(_state): State<AppState>,
    Path(id): Path<String>,
    Json(body): Json<PromptAgentRequest>,
) -> impl IntoResponse {
    // Validate image attachments before any processing to prevent
    // memory-exhaustion from oversized or unsupported payloads.
    for (i, image) in body.images.iter().enumerate() {
        if let Err(reason) = image.validate() {
            return (
                StatusCode::BAD_REQUEST,
                Json(ErrorResponse {
                    error: format!("Invalid image attachment at index {}: {}", i, reason),
                }),
            )
                .into_response();
        }
    }

    // Resolve the agent ID to a runtime ID (handles profile names, ergatai_agent_id, etc.)
    let runtime_id = match crate::services::agent_service::resolve_to_runtime_id(&id).await {
        Some(rid) => rid,
        None => {
            return (
                StatusCode::NOT_FOUND,
                Json(ErrorResponse {
                    error: format!("Agent {} not found or not running", id),
                }),
            )
                .into_response();
        }
    };

    let prompt_id = format_id(generate(), IdType::Session);

    if let Some(conversation_id) = body.conversation_id.as_deref() {
        let conversation_id_for_get = conversation_id.to_string();
        let conversation = match tokio::task::spawn_blocking(move || {
            crate::user_data_db::conversations::get(&conversation_id_for_get)
        })
        .await
        {
            Ok(Ok(Some(conversation))) => conversation,
            Ok(Ok(None)) => {
                return (
                    StatusCode::NOT_FOUND,
                    Json(ErrorResponse {
                        error: "Conversation not found".to_string(),
                    }),
                )
                    .into_response();
            }
            Ok(Err(e)) => {
                return (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(ErrorResponse {
                        error: crate::sanitize_error(&e, "prompt_conversation_load"),
                    }),
                )
                    .into_response();
            }
            Err(e) => {
                return (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(ErrorResponse {
                        error: crate::sanitize_error(&e, "prompt_conversation_load_join"),
                    }),
                )
                    .into_response();
            }
        };

        let conversation_id_for_resolve = conversation_id.to_string();
        let workspace_id = match tokio::task::spawn_blocking(move || {
            crate::user_data_db::conversations::resolve_workspace_id(&conversation_id_for_resolve)
        })
        .await
        {
            Ok(Ok(Some(workspace_id))) => workspace_id,
            Ok(Ok(None)) => {
                return (
                    StatusCode::BAD_REQUEST,
                    Json(ErrorResponse {
                        error: "Conversation has no workspace".to_string(),
                    }),
                )
                    .into_response();
            }
            Ok(Err(e)) => {
                return (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(ErrorResponse {
                        error: crate::sanitize_error(&e, "prompt_conversation_resolve_workspace"),
                    }),
                )
                    .into_response();
            }
            Err(e) => {
                return (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(ErrorResponse {
                        error: crate::sanitize_error(
                            &e,
                            "prompt_conversation_resolve_workspace_join",
                        ),
                    }),
                )
                    .into_response();
            }
        };

        let agent_info = crate::services::agent_service::get_agent_info(&runtime_id).await;
        let agent_profile = agent_info.as_ref().and_then(|info| info.profile.clone());
        if let Some(info) = &agent_info {
            if info.workspace_id != workspace_id {
                return (
                    StatusCode::CONFLICT,
                    Json(ErrorResponse {
                        error: "Agent workspace does not match the conversation workspace"
                            .to_string(),
                    }),
                )
                    .into_response();
            }
        }

        let agent_name = agent_info
            .as_ref()
            .map(|info| info.agent_id.clone())
            .or_else(|| conversation.name.clone())
            .unwrap_or_else(|| runtime_id.clone());

        // Handle interrupt messages differently: directly inject into the agent
        if body.interrupt {
            tracing::info!(
                agent_id = %runtime_id,
                message_id = %prompt_id,
                "Processing interrupt message"
            );

            // Directly call the AcpBackend inject_interrupt method
            if let Some(ctx) = crate::context::try_get_app_context() {
                let runtime = ctx.agent_runtime.clone();
                let backend = runtime.backend();

                // Try to downcast to AcpBackend
                if let Some(acp_backend) = backend
                    .as_any()
                    .downcast_ref::<ergatai_runtime::backends::acp::AcpBackend>(
                ) {
                    match acp_backend
                        .inject_interrupt(
                            &runtime_id,
                            &body.message,
                            &body
                                .images
                                .into_iter()
                                .map(|img| ergatai_runtime::AgentImage {
                                    base64_data: img.base64_data,
                                    media_type: img.media_type,
                                    filename: img.filename,
                                })
                                .collect::<Vec<_>>(),
                            &prompt_id,
                        )
                        .await
                    {
                        Ok(()) => {
                            tracing::info!(
                                message_id = %prompt_id,
                                "Interrupt message injected successfully"
                            );

                            // Publish interrupt event to NATS for SSE streaming
                            if let Some(nats_conn) = ctx.nats_connection.clone() {
                                let bus = ergatai_nats::EventBus::new(nats_conn);
                                let interrupt_event = ergatai_nats::AgentInterrupted {
                                    agent_id: runtime_id.clone(),
                                    paused_message_id: None,
                                    new_message_id: prompt_id.clone(),
                                    interrupted_at: std::time::SystemTime::now()
                                        .duration_since(std::time::UNIX_EPOCH)
                                        .map(|d| d.as_secs())
                                        .unwrap_or(0),
                                    conversation_id: body.conversation_id.clone(),
                                };
                                if let Err(e) = bus.publish_interrupt_event(&interrupt_event).await
                                {
                                    tracing::warn!(error = %e, "Failed to publish interrupt event");
                                }
                            }

                            return (
                                StatusCode::ACCEPTED,
                                Json(serde_json::json!({
                                    "status": "interrupt_queued",
                                    "prompt_id": prompt_id,
                                    "message": "Interrupt message queued for processing at next safe point"
                                })),
                            )
                                .into_response();
                        }
                        Err(e) => {
                            tracing::error!(
                                error = %e,
                                message_id = %prompt_id,
                                "Failed to inject interrupt message"
                            );
                            return (
                                StatusCode::INTERNAL_SERVER_ERROR,
                                Json(ErrorResponse {
                                    error: crate::sanitize_error(&e, "inject_interrupt"),
                                }),
                            )
                                .into_response();
                        }
                    }
                } else {
                    return (
                        StatusCode::BAD_REQUEST,
                        Json(ErrorResponse {
                            error: "Agent backend does not support interrupts".to_string(),
                        }),
                    )
                        .into_response();
                }
            } else {
                return (
                    StatusCode::SERVICE_UNAVAILABLE,
                    Json(ErrorResponse {
                        error: "Application not initialized".to_string(),
                    }),
                )
                    .into_response();
            }
        }

        // Refactored: Publish user message to NATS JetStream for unified delivery
        // Consumer will handle: SQLite persistence, SSE streaming, and ACP delivery
        if let Some(ctx) = crate::context::try_get_app_context() {
            if let Some(nats_conn) = ctx.nats_connection.clone() {
                let bus = ergatai_nats::EventBus::new(nats_conn);

                // Build AgentMessagePayload for user message
                let payload = ergatai_nats::AgentMessagePayload {
                    from_agent: "user".to_string(),
                    to_agent: runtime_id.clone(),
                    content: body.message.clone(),
                    timestamp: std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .map(|d| d.as_secs())
                        .unwrap_or(0),
                    metadata: std::collections::HashMap::new(),
                    message_id: prompt_id.clone(),
                    requires_receipt: false,
                    correlation_id: None,
                    timeout_ms: None,
                    message_type: "request".to_string(),
                    target_conversation_id: Some(conversation_id.to_string()),
                    images: body
                        .images
                        .iter()
                        .map(|img| ergatai_nats::events::AgentImage {
                            base64_data: img.base64_data.clone(),
                            media_type: img.media_type.clone(),
                            filename: img.filename.clone(),
                        })
                        .collect(),
                };

                // Publish to NATS JetStream
                match bus.publish_agent_message_reliable(&payload).await {
                    Ok(ack) => {
                        tracing::info!(
                            message_id = %payload.message_id,
                            stream = %ack.stream,
                            sequence = %ack.sequence,
                            "User message published to NATS for unified delivery"
                        );
                    }
                    Err(e) => {
                        tracing::error!(
                            error = %e,
                            "Failed to publish user message to NATS"
                        );
                        return (
                            StatusCode::INTERNAL_SERVER_ERROR,
                            Json(ErrorResponse {
                                error: crate::sanitize_error(&e, "publish_user_message_to_nats"),
                            }),
                        )
                            .into_response();
                    }
                }
            } else {
                tracing::error!("NATS connection not available");
                return (
                    StatusCode::SERVICE_UNAVAILABLE,
                    Json(ErrorResponse {
                        error: "Message system unavailable".to_string(),
                    }),
                )
                    .into_response();
            }
        } else {
            tracing::error!("App context not available");
            return (
                StatusCode::SERVICE_UNAVAILABLE,
                Json(ErrorResponse {
                    error: "Application not initialized".to_string(),
                }),
            )
                .into_response();
        }

        if let Some(session_id) =
            crate::services::agent_service::get_agent_session_id(&runtime_id).await
        {
            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs() as i64;
            let conversation_id_for_upsert = conversation_id.to_string();
            let conversation_mode = conversation.mode.clone();
            let agent_session_id = format_id(generate(), IdType::Session);
            if let Err(e) = tokio::task::spawn_blocking(move || {
                crate::user_data_db::agent_sessions::upsert(crate::user_data_db::AgentSession {
                    agent_session_id,
                    conversation_id: conversation_id_for_upsert,
                    acp_session_id: Some(session_id),
                    mode: conversation_mode,
                    created_at: now,
                    updated_at: now,
                })
            })
            .await
            {
                tracing::warn!(
                    error = %e,
                    conversation_id = %conversation_id,
                    "Prompt dispatched but failed to persist agent session"
                );
            }
        }

        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs() as i64;
        let root_conversation_id = conversation
            .parent_id
            .clone()
            .unwrap_or_else(|| conversation.conversation_id.clone());
        let binding = crate::user_data_db::GroupAgentBinding {
            workspace_id,
            chat_id: root_conversation_id,
            agent_id: runtime_id.clone(),
            agent_name: agent_name.clone(),
            agent_command: agent_profile,
            conversation_id: conversation.conversation_id,
            created_at: now,
            updated_at: now,
        };
        if let Err(e) = tokio::task::spawn_blocking(move || {
            crate::user_data_db::group_agent_bindings::upsert(binding)
        })
        .await
        {
            tracing::warn!(
                error = %e,
                conversation_id = %conversation_id,
                runtime_id = %runtime_id,
                "Prompt dispatched but failed to bind agent"
            );
        }

        (
            StatusCode::ACCEPTED,
            Json(serde_json::json!({ "status": "queued", "prompt_id": prompt_id })),
        )
            .into_response()
    } else {
        // No conversation_id — use direct inject (legacy path, no persistence).
        match crate::services::agent_service::prompt_agent_with_images(
            &runtime_id,
            &body.message,
            body.images,
            None,
        )
        .await
        {
            Ok(()) => (
                StatusCode::ACCEPTED,
                Json(serde_json::json!({ "status": "queued", "prompt_id": prompt_id })),
            )
                .into_response(),
            Err(e) => (
                StatusCode::BAD_REQUEST,
                Json(ErrorResponse {
                    error: crate::sanitize_error(&e, "prompt_agent_direct"),
                }),
            )
                .into_response(),
        }
    }
}

// ── Suspend/Resume API ──

#[derive(Debug, Default, Deserialize)]
pub struct SuspendRequest {
    #[serde(default)]
    pub reason: SuspendReason,
}

/// POST /api/v1/agents/{id}/suspend
///
/// Suspend an agent, saving its state and stopping the process.
pub async fn suspend_agent(
    State(_state): State<AppState>,
    Path(agent_id): Path<String>,
    Json(req): Json<SuspendRequest>,
) -> impl IntoResponse {
    let ctx = match crate::context::try_get_app_context() {
        Some(ctx) => ctx,
        None => {
            return (
                StatusCode::SERVICE_UNAVAILABLE,
                Json(ErrorResponse {
                    error: "Application not initialized".to_string(),
                }),
            )
                .into_response();
        }
    };
    let runtime = ctx.agent_runtime.clone();
    let reason = req.reason;

    match runtime.suspend_agent(&agent_id, reason).await {
        Ok(()) => (
            StatusCode::OK,
            Json(serde_json::json!({
                "status": "suspended",
                "agent_id": agent_id,
                "reason": reason,
            })),
        )
            .into_response(),
        Err(e) => (
            StatusCode::BAD_REQUEST,
            Json(crate::api::ApiError {
                error: crate::sanitize_error(&e, "suspend_agent"),
            }),
        )
            .into_response(),
    }
}

/// POST /api/v1/agents/{id}/resume
///
/// Resume a suspended agent, restoring it with a new agent ID.
pub async fn resume_agent(
    State(_state): State<AppState>,
    Path(suspended_id): Path<String>,
) -> impl IntoResponse {
    let ctx = match crate::context::try_get_app_context() {
        Some(ctx) => ctx,
        None => {
            return (
                StatusCode::SERVICE_UNAVAILABLE,
                Json(ErrorResponse {
                    error: "Application not initialized".to_string(),
                }),
            )
                .into_response();
        }
    };
    let runtime = ctx.agent_runtime.clone();

    match runtime.resume_agent(&suspended_id).await {
        Ok(new_agent_id) => (
            StatusCode::OK,
            Json(serde_json::json!({
                "status": "resumed",
                "old_id": suspended_id,
                "new_agent_id": new_agent_id,
            })),
        )
            .into_response(),
        Err(e) => (
            StatusCode::NOT_FOUND,
            Json(crate::api::ApiError {
                error: crate::sanitize_error(&e, "resume_agent"),
            }),
        )
            .into_response(),
    }
}

/// GET /api/v1/agents/suspended
///
/// List all suspended agents.
pub async fn list_suspended_agents(State(_state): State<AppState>) -> impl IntoResponse {
    let ctx = match crate::context::try_get_app_context() {
        Some(ctx) => ctx,
        None => {
            return (
                StatusCode::SERVICE_UNAVAILABLE,
                Json(ErrorResponse {
                    error: "Application not initialized".to_string(),
                }),
            )
                .into_response();
        }
    };
    let runtime = ctx.agent_runtime.clone();

    match runtime.suspend_store().list_suspended() {
        Ok(suspended) => (
            StatusCode::OK,
            Json(serde_json::json!({
                "agents": suspended,
                "count": suspended.len(),
            })),
        )
            .into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(crate::api::ApiError {
                error: crate::sanitize_error(&e, "list_suspended_agents"),
            }),
        )
            .into_response(),
    }
}

// ════════════════════════════════════════════════════════════════════════
// Conversation Agent API（1:1 绑定）
// ════════════════════════════════════════════════════════════════════════

#[derive(Debug, Deserialize, ToSchema)]
pub struct CreateConversationAgentRequest {
    pub profile_name: String,
    #[serde(default)]
    pub cwd: Option<String>,
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct PromptConversationAgentRequest {
    pub content: String,
    #[serde(default)]
    pub interrupt: bool,
    #[serde(default)]
    pub images: Vec<String>,
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct InterruptConversationAgentRequest {
    pub content: String,
}

/// GET /api/v1/conversations/{conversation_id}/agent
pub async fn get_conversation_agent(Path(conversation_id): Path<String>) -> impl IntoResponse {
    // Get agent session for this conversation
    let conv_id_for_closure = conversation_id.clone();
    let conv_id_for_error = conversation_id.clone();
    match tokio::task::spawn_blocking(move || {
        crate::user_data_db::agent_sessions::get(&conv_id_for_closure)
    })
    .await
    {
        Ok(Ok(Some(session))) => (StatusCode::OK, Json(session)).into_response(),
        Ok(Ok(None)) => (
            StatusCode::NOT_FOUND,
            Json(crate::api::ApiError {
                error: format!("No agent bound to conversation {}", conv_id_for_error),
            }),
        )
            .into_response(),
        Ok(Err(e)) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(crate::api::ApiError {
                error: crate::sanitize_error(&e, "get_conversation_agent"),
            }),
        )
            .into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(crate::api::ApiError {
                error: format!("Task join error: {}", e),
            }),
        )
            .into_response(),
    }
}

/// POST /api/v1/conversations/{conversation_id}/agent
pub async fn create_conversation_agent(
    Path(_conversation_id): Path<String>,
    Json(_req): Json<CreateConversationAgentRequest>,
) -> impl IntoResponse {
    // TODO: Implement agent creation and binding
    // This requires integration with the agent runtime
    (
        StatusCode::NOT_IMPLEMENTED,
        Json(crate::api::ApiError {
            error: "Agent creation not yet implemented".to_string(),
        }),
    )
        .into_response()
}

/// DELETE /api/v1/conversations/{conversation_id}/agent
pub async fn delete_conversation_agent(Path(conversation_id): Path<String>) -> impl IntoResponse {
    // Remove agent binding
    let conv_id_for_closure = conversation_id.clone();
    match tokio::task::spawn_blocking(move || {
        crate::user_data_db::agent_sessions::delete(&conv_id_for_closure)
    })
    .await
    {
        Ok(Ok(true)) => StatusCode::NO_CONTENT.into_response(),
        Ok(Ok(false)) => (
            StatusCode::NOT_FOUND,
            Json(crate::api::ApiError {
                error: format!("No agent bound to conversation {}", conversation_id),
            }),
        )
            .into_response(),
        Ok(Err(e)) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(crate::api::ApiError {
                error: crate::sanitize_error(&e, "delete_conversation_agent"),
            }),
        )
            .into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(crate::api::ApiError {
                error: format!("Task join error: {}", e),
            }),
        )
            .into_response(),
    }
}

/// POST /api/v1/conversations/{conversation_id}/agent/prompt
pub async fn prompt_conversation_agent(
    Path(_conversation_id): Path<String>,
    Json(_req): Json<PromptConversationAgentRequest>,
) -> impl IntoResponse {
    // TODO: Implement prompt sending
    (
        StatusCode::NOT_IMPLEMENTED,
        Json(crate::api::ApiError {
            error: "Agent prompt not yet implemented".to_string(),
        }),
    )
        .into_response()
}

/// POST /api/v1/conversations/{conversation_id}/agent/cancel
pub async fn cancel_conversation_agent(Path(_conversation_id): Path<String>) -> impl IntoResponse {
    // TODO: Implement agent cancellation
    (
        StatusCode::NOT_IMPLEMENTED,
        Json(crate::api::ApiError {
            error: "Agent cancel not yet implemented".to_string(),
        }),
    )
        .into_response()
}

/// POST /api/v1/conversations/{conversation_id}/agent/interrupt
pub async fn interrupt_conversation_agent(
    Path(_conversation_id): Path<String>,
    Json(_req): Json<InterruptConversationAgentRequest>,
) -> impl IntoResponse {
    // TODO: Implement agent interrupt
    (
        StatusCode::NOT_IMPLEMENTED,
        Json(crate::api::ApiError {
            error: "Agent interrupt not yet implemented".to_string(),
        }),
    )
        .into_response()
}

/// GET /api/v1/agents/{agent_id}
pub async fn get_agent(
    Path(agent_id): Path<String>,
    State(_state): State<AppState>,
) -> impl IntoResponse {
    let runtime = crate::context::get_app_context().agent_runtime.clone();
    match runtime.get_agent(&agent_id).await {
        Some(info) => (StatusCode::OK, Json(info)).into_response(),
        None => (
            StatusCode::NOT_FOUND,
            Json(crate::api::ApiError {
                error: format!("Agent {} not found", agent_id),
            }),
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
        assert_eq!(req.workspace_id.as_deref(), Some("ws-1"));
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
    fn test_spawn_agent_request_without_target_ids_fails() {
        let result: Result<SpawnAgentRequest, _> =
            serde_json::from_value(json!({"command": "claude"}));
        assert!(result.is_ok());
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

    #[test]
    fn test_spawn_agent_request_with_empty_workspace_id() {
        let req: SpawnAgentRequest = serde_json::from_value(json!({
            "workspace_id": "",
            "command": "claude"
        }))
        .unwrap();
        assert_eq!(req.workspace_id.as_deref(), Some(""));
    }

    #[test]
    fn test_spawn_agent_request_with_complex_env() {
        let req: SpawnAgentRequest = serde_json::from_value(json!({
            "workspace_id": "ws-1",
            "command": "claude",
            "env": {
                "PATH": "/usr/bin",
                "HOME": "/home/user",
                "CUSTOM_VAR": "value with spaces"
            }
        }))
        .unwrap();
        let env = req.env.unwrap();
        assert_eq!(env.len(), 3);
        assert_eq!(env.get("CUSTOM_VAR").unwrap(), "value with spaces");
    }

    #[test]
    fn test_agent_info_response_with_all_optional_fields() {
        let resp = AgentInfoResponse {
            agent_id: "a-1".to_string(),
            workspace_id: "ws-1".to_string(),
            work_dir: "/workspace".to_string(),
            state: "running".to_string(),
            lifecycle_state: "running".to_string(),
            task_id: Some("task-123".to_string()),
            mcp_agent_id: Some("mcp-1".to_string()),
            is_alive: true,
            is_idle: true,
            is_processing: true,
            created_at: "2026-01-01T00:00:00Z".to_string(),
            last_heartbeat: "2026-01-01T00:00:00Z".to_string(),
            session_title: Some("title".to_string()),
            session_id: Some("session-1".to_string()),
            stop_reason: Some("end_turn".to_string()),
            continuation_count: 5,
            config_options: Some(vec![]),
            profile: Some("profile-1".to_string()),
            capabilities: vec!["cap1".to_string(), "cap2".to_string()],
            state_changed_at: "2026-01-01T00:00:00Z".to_string(),
            state_history: vec![],
        };
        let json = serde_json::to_value(&resp).unwrap();
        assert_eq!(json["task_id"], "task-123");
        assert_eq!(json["mcp_agent_id"], "mcp-1");
        assert_eq!(json["is_idle"], true);
        assert_eq!(json["is_processing"], true);
        assert_eq!(json["continuation_count"], 5);
    }

    #[test]
    fn test_agent_info_response_with_null_optional_fields() {
        let resp = AgentInfoResponse {
            agent_id: "a-1".to_string(),
            workspace_id: "ws-1".to_string(),
            work_dir: "/workspace".to_string(),
            state: "terminated".to_string(),
            lifecycle_state: "terminated".to_string(),
            task_id: None,
            mcp_agent_id: None,
            is_alive: false,
            is_idle: false,
            is_processing: false,
            created_at: "2026-01-01T00:00:00Z".to_string(),
            last_heartbeat: "2026-01-01T00:00:00Z".to_string(),
            session_title: None,
            session_id: None,
            stop_reason: None,
            continuation_count: 0,
            config_options: None,
            profile: None,
            capabilities: vec![],
            state_changed_at: "2026-01-01T00:00:00Z".to_string(),
            state_history: vec![],
        };
        let json = serde_json::to_value(&resp).unwrap();
        assert!(json["task_id"].is_null());
        assert!(json["session_title"].is_null());
        assert_eq!(json["is_alive"], false);
    }

    #[test]
    fn test_send_message_request_with_unicode() {
        let req: SendMessageRequest =
            serde_json::from_value(json!({"message": "Hello 世界 🌍"})).unwrap();
        assert_eq!(req.message, "Hello 世界 🌍");
    }

    #[test]
    fn test_send_message_request_with_multiline() {
        let req: SendMessageRequest =
            serde_json::from_value(json!({"message": "line1\nline2\nline3"})).unwrap();
        assert_eq!(req.message, "line1\nline2\nline3");
    }
}
