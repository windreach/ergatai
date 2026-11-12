//! Agent Profile Registry API handlers
//!
//! 业务逻辑已迁移到 `crate::services::profile_service`，handler 只负责
//! HTTP 请求解析、响应格式化和错误状态码映射。

use crate::Json;
use axum::{extract::Path, http::StatusCode, response::IntoResponse};
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

use ergatai_runtime::profile_registry::AgentRegistration;

use super::agents::{extract_models_from_config_options, parse_model_output, DetectedModels};
use crate::services::profile_service;

/// Request to register a new agent profile
#[derive(Debug, Clone, Copy, Deserialize, ToSchema, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ApiAgentType {
    Acp,
    Mcp,
}

impl ApiAgentType {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Acp => "acp",
            Self::Mcp => "mcp",
        }
    }
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct RegisterProfileRequest {
    #[schema(min_length = 1)]
    pub name: String,
    #[schema(min_length = 1)]
    pub command: String,
    #[schema(min_length = 1)]
    pub agent_type: ApiAgentType,
    pub package_name: Option<String>,
    pub avatar_url: Option<String>,
    /// Optional native trigger allowlist. Unknown syntax remains raw text.
    pub native_triggers: Option<Vec<serde_json::Value>>,
    /// Optional discovery trigger declarations for this agent.
    pub discovery_triggers: Option<Vec<serde_json::Value>>,
}

/// Response for a single agent profile
#[derive(Debug, Serialize, ToSchema)]
pub struct ProfileResponse {
    pub id: String,
    pub name: String,
    pub command: String,
    pub agent_type: String,
    pub package_name: Option<String>,
    pub avatar_url: Option<String>,
    pub native_triggers: Option<serde_json::Value>,
    pub discovery_triggers: Option<serde_json::Value>,
    pub created_at: String,
}

impl From<AgentRegistration> for ProfileResponse {
    fn from(reg: AgentRegistration) -> Self {
        let native_triggers = reg.native_triggers_json.and_then(|json| {
            serde_json::from_str::<Vec<serde_json::Value>>(&json)
                .inspect_err(|e| {
                    tracing::warn!(
                        "Failed to parse native_triggers_json for profile {}: {}",
                        reg.name,
                        e
                    )
                })
                .ok()
                .map(serde_json::Value::Array)
        });
        let discovery_triggers = reg.discovery_triggers_json.and_then(|json| {
            serde_json::from_str::<Vec<serde_json::Value>>(&json)
                .inspect_err(|e| {
                    tracing::warn!(
                        "Failed to parse discovery_triggers_json for profile {}: {}",
                        reg.name,
                        e
                    )
                })
                .ok()
                .map(serde_json::Value::Array)
        });
        Self {
            id: reg.id,
            name: reg.name,
            command: reg.command,
            agent_type: reg.agent_type,
            package_name: reg.package_name,
            avatar_url: reg.avatar_url,
            native_triggers,
            discovery_triggers,
            created_at: reg.created_at.to_rfc3339(),
        }
    }
}

/// Response for listing agent profiles
#[derive(Debug, Serialize, ToSchema)]
pub struct ListProfilesResponse {
    pub profiles: Vec<ProfileResponse>,
}

/// Register a new agent profile
///
/// POST /api/v1/agent-profiles
#[utoipa::path(
    post,
    path = "/api/v1/agent-profiles",
    tag = "Agent Profiles",
    request_body = RegisterProfileRequest,
    responses(
        (status = 201, description = "Agent profile registered successfully"),
        (status = 400, description = "Invalid request", body = crate::api::ApiError),
        (status = 401, description = "Unauthorized", body = crate::api::ApiError),
        (status = 409, description = "Profile already exists", body = crate::api::ApiError),
        (status = 500, description = "Internal server error", body = crate::api::ApiError),
    )
)]
pub async fn register_profile(
    Json(request): Json<RegisterProfileRequest>,
) -> axum::response::Response {
    // Bind name once to avoid redundant clones in success path
    let profile_name = request.name.clone();

    match profile_service::register_profile(
        request.name,
        request.command,
        request.agent_type.as_str().to_string(),
        request.package_name,
        request.avatar_url,
        request.native_triggers,
        request.discovery_triggers,
    )
    .await
    {
        Ok(()) => {
            // Fetch the newly registered profile to return its complete info (including auto-generated id)
            match profile_service::get_profile_by_name(&profile_name).await {
                Ok(Some(registration)) => {
                    let profile_response = ProfileResponse::from(registration);
                    match serde_json::to_value(profile_response) {
                        Ok(value) => (StatusCode::CREATED, Json(value)).into_response(),
                        Err(_) => {
                            // Serialization failed - return minimal success response
                            (
                                StatusCode::CREATED,
                                Json(serde_json::json!({
                                    "status": "success",
                                    "message": format!("Agent profile '{}' registered successfully", profile_name),
                                    "name": profile_name
                                })),
                            )
                                .into_response()
                        }
                    }
                }
                Ok(None) => {
                    // Profile was registered but can't be fetched - return minimal success response
                    (
                        StatusCode::CREATED,
                        Json(serde_json::json!({
                            "status": "success",
                            "message": format!("Agent profile '{}' registered successfully", profile_name),
                            "name": profile_name
                        })),
                    )
                        .into_response()
                }
                Err(_) => {
                    // Fetch failed but registration succeeded - return minimal success response
                    (
                        StatusCode::CREATED,
                        Json(serde_json::json!({
                            "status": "success",
                            "message": format!("Agent profile '{}' registered successfully", profile_name),
                            "name": profile_name
                        })),
                    )
                        .into_response()
                }
            }
        }
        Err(e) => {
            let err_text = e.to_string();
            // Classification based on error content — used to pick an HTTP
            // status code. These strings are the contract between the profile
            // registry and the HTTP layer; keep them stable.
            let is_user_error = err_text.contains("already exists")
                || err_text.contains("cannot be empty")
                || err_text.contains("Invalid agent type");

            let (status, message) = if is_user_error {
                // Validation / conflict errors are safe to forward verbatim.
                let status = if err_text.contains("already exists") {
                    StatusCode::CONFLICT
                } else {
                    StatusCode::BAD_REQUEST
                };
                (status, err_text)
            } else {
                // SECURITY (P1 #18): Redact internal DB/storage errors that
                // may reveal SQLite file paths or constraint messages.
                return crate::http_error::internal(e, "register_agent_profile").into_response();
            };
            (
                status,
                Json(serde_json::json!({
                    "error": message
                })),
            )
                .into_response()
        }
    }
}

/// List all registered agent profiles
///
/// GET /api/v1/agent-profiles
#[utoipa::path(
    get,
    path = "/api/v1/agent-profiles",
    tag = "Agent Profiles",
    responses(
        (status = 200, description = "List of agent profiles", body = ListProfilesResponse),
        (status = 500, description = "Internal server error", body = crate::api::ApiError),
    )
)]
pub async fn list_profiles() -> axum::response::Response {
    match profile_service::list_profiles().await {
        Ok(profiles) => {
            let response = ListProfilesResponse {
                profiles: profiles.into_iter().map(ProfileResponse::from).collect(),
            };
            match serde_json::to_value(response) {
                Ok(value) => (StatusCode::OK, Json(value)).into_response(),
                Err(e) => crate::http_error::internal(
                    format!("Failed to serialize profiles: {}", e),
                    "list_profiles_serialize",
                )
                .into_response(),
            }
        }
        Err(e) => crate::http_error::internal(e, "list_profiles").into_response(),
    }
}

/// Get a specific agent profile
///
/// GET /api/v1/agent-profiles/:id
#[utoipa::path(
    get,
    path = "/api/v1/agent-profiles/{id}",
    tag = "Agent Profiles",
    params(
        ("id" = String, Path, description = "Agent profile ID"),
    ),
    responses(
        (status = 200, description = "Agent profile details", body = ProfileResponse),
        (status = 404, description = "Profile not found", body = crate::api::ApiError),
        (status = 500, description = "Internal server error", body = crate::api::ApiError),
    )
)]
pub async fn get_profile(Path(id): Path<String>) -> axum::response::Response {
    match profile_service::get_profile(&id).await {
        Ok(Some(registration)) => match serde_json::to_value(ProfileResponse::from(registration)) {
            Ok(value) => (StatusCode::OK, Json(value)).into_response(),
            Err(e) => crate::http_error::internal(
                format!("Failed to serialize profile: {}", e),
                "get_profile_serialize",
            )
            .into_response(),
        },
        Ok(None) => crate::http_error::not_found("Agent profile", &id).into_response(),
        Err(e) => crate::http_error::internal(e, "get_profile").into_response(),
    }
}

/// Delete an agent profile
///
/// DELETE /api/v1/agent-profiles/:id
#[utoipa::path(
    delete,
    path = "/api/v1/agent-profiles/{id}",
    tag = "Agent Profiles",
    params(
        ("id" = String, Path, description = "Agent profile ID"),
    ),
    responses(
        (status = 200, description = "Agent profile deleted successfully"),
        (status = 404, description = "Profile not found", body = crate::api::ApiError),
        (status = 500, description = "Internal server error", body = crate::api::ApiError),
    )
)]
pub async fn delete_profile(Path(id): Path<String>) -> axum::response::Response {
    match profile_service::delete_profile(&id).await {
        Ok(true) => (
            StatusCode::OK,
            Json(serde_json::json!({
                "status": "success",
                "message": format!("Agent profile '{}' deleted successfully", id)
            })),
        )
            .into_response(),
        Ok(false) => crate::http_error::not_found("Agent profile", &id).into_response(),
        Err(e) => crate::http_error::internal(e, "delete_profile").into_response(),
    }
}

/// Response for a profile with installation status
#[derive(Debug, Serialize, ToSchema)]
pub struct ProfileWithStatusResponse {
    pub id: String,
    pub name: String,
    pub command: String,
    pub agent_type: String,
    pub package_name: Option<String>,
    pub avatar_url: Option<String>,
    pub native_triggers: Option<serde_json::Value>,
    pub discovery_triggers: Option<serde_json::Value>,
    pub installed: bool,
    pub created_at: String,
}

impl From<ergatai_runtime::profile_registry::ProfileWithStatus> for ProfileWithStatusResponse {
    fn from(p: ergatai_runtime::profile_registry::ProfileWithStatus) -> Self {
        let native_triggers = p.native_triggers_json.and_then(|json| {
            serde_json::from_str::<Vec<serde_json::Value>>(&json)
                .inspect_err(|e| {
                    tracing::warn!(
                        "Failed to parse native_triggers_json for profile {}: {}",
                        p.name,
                        e
                    )
                })
                .ok()
                .map(serde_json::Value::Array)
        });
        let discovery_triggers = p.discovery_triggers_json.and_then(|json| {
            serde_json::from_str::<Vec<serde_json::Value>>(&json)
                .inspect_err(|e| {
                    tracing::warn!(
                        "Failed to parse discovery_triggers_json for profile {}: {}",
                        p.name,
                        e
                    )
                })
                .ok()
                .map(serde_json::Value::Array)
        });
        Self {
            id: p.id,
            name: p.name,
            command: p.command,
            agent_type: p.agent_type,
            package_name: p.package_name,
            avatar_url: p.avatar_url,
            native_triggers,
            discovery_triggers,
            installed: p.installed,
            created_at: p.created_at,
        }
    }
}

/// Response for listing profiles with status
#[derive(Debug, Serialize, ToSchema)]
pub struct ListProfilesWithStatusResponse {
    pub profiles: Vec<ProfileWithStatusResponse>,
}

/// List all agent profiles with installation status
///
/// GET /api/v1/agent-profiles/with-status
#[utoipa::path(
    get,
    path = "/api/v1/agent-profiles/with-status",
    tag = "Agent Profiles",
    responses(
        (status = 200, description = "List of agent profiles with installation status", body = ListProfilesWithStatusResponse),
        (status = 500, description = "Internal server error", body = crate::api::ApiError),
    )
)]
pub async fn list_with_status() -> axum::response::Response {
    match profile_service::list_profiles_with_status() {
        Ok(profiles) => {
            let response = ListProfilesWithStatusResponse {
                profiles: profiles
                    .into_iter()
                    .map(ProfileWithStatusResponse::from)
                    .collect(),
            };
            match serde_json::to_value(response) {
                Ok(value) => (StatusCode::OK, Json(value)).into_response(),
                Err(e) => crate::http_error::internal(
                    format!("Failed to serialize profiles: {}", e),
                    "list_with_status_serialize",
                )
                .into_response(),
            }
        }
        Err(e) => crate::http_error::internal(e, "list_with_status").into_response(),
    }
}

/// Install an agent by profile ID (npm install -g)
///
/// POST /api/v1/agent-profiles/:id/install
#[utoipa::path(
    post,
    path = "/api/v1/agent-profiles/{id}/install",
    tag = "Agent Profiles",
    params(
        ("id" = String, Path, description = "Agent profile ID"),
    ),
    responses(
        (status = 200, description = "Agent installed successfully"),
        (status = 400, description = "Invalid request", body = crate::api::ApiError),
        (status = 404, description = "Profile not found", body = crate::api::ApiError),
        (status = 500, description = "Internal server error", body = crate::api::ApiError),
    )
)]
pub async fn install_agent(Path(id): Path<String>) -> axum::response::Response {
    // Fast path: avoid a potentially long npm install when the agent is
    // already installed.
    if let Ok(profiles) = profile_service::list_profiles_with_status() {
        if let Some(profile) = profiles
            .iter()
            .find(|profile| profile.id == id || profile.name == id)
        {
            if profile.installed {
                return (
                    StatusCode::OK,
                    Json(serde_json::json!({
                        "status": "success",
                        "message": format!("Agent '{}' is already installed", id),
                        "output": ""
                    })),
                )
                    .into_response();
            }
        }
    }

    match profile_service::install_agent(&id).await {
        Ok(output) => (
            StatusCode::OK,
            Json(serde_json::json!({
                "status": "success",
                "message": format!("Agent '{}' installed successfully", id),
                "output": output
            })),
        )
            .into_response(),
        Err(e) => {
            let err_text = e.to_string();

            // 区分"资源不存在"（404）和"请求无效"（400）
            let (status, message) = if err_text.contains("not found")
                || err_text.contains("no package_name")
                || err_text.contains("cannot be empty")
            {
                (StatusCode::NOT_FOUND, err_text)
            } else {
                return crate::http_error::internal(e, "install_agent").into_response();
            };

            (
                status,
                Json(serde_json::json!({
                    "error": message
                })),
            )
                .into_response()
        }
    }
}

/// Uninstall an agent by profile ID (npm uninstall -g)
///
/// DELETE /api/v1/agent-profiles/:id/uninstall
#[utoipa::path(
    delete,
    path = "/api/v1/agent-profiles/{id}/uninstall",
    tag = "Agent Profiles",
    params(
        ("id" = String, Path, description = "Agent profile ID"),
    ),
    responses(
        (status = 200, description = "Agent uninstalled successfully"),
        (status = 400, description = "Invalid request", body = crate::api::ApiError),
        (status = 404, description = "Profile not found", body = crate::api::ApiError),
        (status = 500, description = "Internal server error", body = crate::api::ApiError),
    )
)]
pub async fn uninstall_agent(Path(id): Path<String>) -> axum::response::Response {
    match profile_service::uninstall_agent(&id).await {
        Ok(output) => (
            StatusCode::OK,
            Json(serde_json::json!({
                "status": "success",
                "message": format!("Agent '{}' uninstalled successfully", id),
                "output": output
            })),
        )
            .into_response(),
        Err(e) => {
            let err_text = e.to_string();

            // 区分"资源不存在"（404）和"请求无效"（400）
            let (status, message) = if err_text.contains("not found")
                || err_text.contains("no package_name")
                || err_text.contains("cannot be empty")
            {
                (StatusCode::NOT_FOUND, err_text)
            } else {
                return crate::http_error::internal(e, "uninstall_agent").into_response();
            };

            (
                status,
                Json(serde_json::json!({
                    "error": message
                })),
            )
                .into_response()
        }
    }
}

/// Get the model catalog for an agent profile
///
/// GET /api/v1/agent-profiles/:name/models
#[utoipa::path(
    get,
    path = "/api/v1/agent-profiles/{name}/models",
    tag = "Agent Profiles",
    params(("name" = String, Path, description = "Agent profile name")),
    responses(
        (status = 200, description = "Cached models"),
        (status = 404, description = "Profile not found", body = crate::api::ApiError),
        (status = 500, description = "Internal server error", body = crate::api::ApiError),
    )
)]
pub async fn get_profile_models(Path(name): Path<String>) -> axum::response::Response {
    match profile_service::get_profile_models_by_name(&name).await {
        Ok(models) => (StatusCode::OK, Json(models)).into_response(),
        Err(e) => crate::http_error::internal(e, "get_profile_models").into_response(),
    }
}

/// Trigger model detection for an agent profile via ACP config_options.
///
/// A `/model` command is used only when the agent explicitly declared it.
///
/// POST /api/v1/agent-profiles/:name/models/refresh
///
/// Rate limited: 1 refresh per 30 seconds per profile to prevent abuse.
#[utoipa::path(
    post,
    path = "/api/v1/agent-profiles/{name}/models/refresh",
    tag = "Agent Profiles",
    params(("name" = String, Path, description = "Agent profile name")),
    responses(
        (status = 200, description = "Models refreshed"),
        (status = 404, description = "Profile not found", body = crate::api::ApiError),
        (status = 429, description = "Rate limit exceeded", body = crate::api::ApiError),
        (status = 500, description = "Internal server error", body = crate::api::ApiError),
    )
)]
/// Resolve the Claude CLI binary, preferring absolute paths so the subprocess
/// works even when the server's PATH does not include ~/.local/bin.
fn claude_cli_path() -> String {
    for candidate in [
        "/root/.local/bin/claude",
        "/usr/local/bin/claude",
        "/usr/bin/claude",
    ] {
        if std::path::Path::new(candidate).exists() {
            return candidate.to_string();
        }
    }
    "claude".to_string()
}

pub async fn refresh_profile_models(Path(name): Path<String>) -> axum::response::Response {
    // Rate limit check: prevent frequent refreshes (30s cooldown per profile)
    use std::collections::HashMap;
    use std::sync::Mutex;
    use std::time::Instant;

    static REFRESH_COOLDOWN: std::sync::LazyLock<Mutex<HashMap<String, Instant>>> =
        std::sync::LazyLock::new(|| Mutex::new(HashMap::new()));

    {
        let mut cooldowns = REFRESH_COOLDOWN.lock().unwrap();
        if let Some(last_refresh) = cooldowns.get(&name) {
            if last_refresh.elapsed().as_secs() < 30 {
                return (
                    StatusCode::TOO_MANY_REQUESTS,
                    Json(serde_json::json!({
                        "error": "Rate limit exceeded",
                        "message": format!("Please wait {} seconds before refreshing again",
                            30 - last_refresh.elapsed().as_secs())
                    })),
                )
                    .into_response();
            }
        }
        cooldowns.insert(name.clone(), Instant::now());
    }

    // 1. Look up the profile by name
    let profile = match profile_service::get_profile_by_name(&name).await {
        Ok(Some(p)) => p,
        Ok(None) => return crate::http_error::not_found("Agent profile", &name).into_response(),
        Err(e) => {
            return crate::http_error::internal(e, "refresh_profile_models_lookup").into_response()
        }
    };

    // 0. SDK-first detection (preferred over ACP/CLI).
    {
        let kind = {
            let hay = profile.name.to_lowercase();
            if hay.contains("opencode") {
                "opencode"
            } else if hay.contains("codex") {
                "codex"
            } else if hay.contains("claude") {
                "claude"
            } else {
                ""
            }
        };
        if !kind.is_empty() {
            if let Ok(details) = profile_service::refresh_profile_models(kind, &name, None).await {
                if !details.is_empty() {
                    let models: Vec<String> = details.iter().map(|d| d.id.clone()).collect();
                    return (
                        StatusCode::OK,
                        Json(serde_json::json!({
                            "status": "available",
                            "source": "agent_sdk",
                            "models": models,
                            "model_details": details,
                            "current": null,
                        })),
                    )
                        .into_response();
                }
            }
        }
    }

    // 2. Claude Code has no ACP model selector; detect via CLI subprocess.
    if profile.name.to_lowercase().contains("claude") {
        if let Ok(output) = tokio::process::Command::new(claude_cli_path())
            .arg("/model")
            .output()
            .await
        {
            let text = String::from_utf8_lossy(&output.stdout);
            if let Some(parsed) = parse_model_output(&text) {
                let current = parsed
                    .get("current")
                    .and_then(serde_json::Value::as_str)
                    .map(ToString::to_string);
                // Only collapse alias/variant tokens when running through a
                // non-Claude (gateway) backend; native Claude exposes them all.
                let is_gateway = current
                    .as_ref()
                    .map(|c| {
                        let l = c.to_lowercase();
                        !(l.contains("sonnet")
                            || l.contains("opus")
                            || l.contains("haiku")
                            || l.contains("fable")
                            || l.contains("claude"))
                    })
                    .unwrap_or(false);
                let models = parsed
                    .get("models")
                    .and_then(serde_json::Value::as_array)
                    .map(|values| {
                        values
                            .iter()
                            .filter_map(serde_json::Value::as_str)
                            .filter(|m| {
                                if !is_gateway {
                                    return true;
                                }
                                let lower = m.to_lowercase();
                                !lower.contains('[')
                                    && lower != "best"
                                    && lower != "opusplan"
                                    && lower != "default"
                            })
                            .map(ToString::to_string)
                            .collect::<Vec<_>>()
                    })
                    .unwrap_or_default();
                if !models.is_empty() {
                    if let Err(e) =
                        profile_service::save_profile_models_by_name(&name, &models, None).await
                    {
                        return crate::http_error::internal(e, "refresh_profile_models_save")
                            .into_response();
                    }
                    return (
                        StatusCode::OK,
                        Json(serde_json::json!({
                            "status": "available",
                            "source": "cli_subprocess",
                            "models": models,
                            "current": current,
                        })),
                    )
                        .into_response();
                }
            }
        }
    }

    // 2. Find a running agent for this profile
    let running_agent_id =
        match find_running_agent_for_profile(&profile.name).await {
            Ok(agent_id) => agent_id,
            Err(_e) => return (
                StatusCode::OK,
                Json(serde_json::json!({
                    "status": "no_agent",
                    "source": "none",
                    "models": [],
                    "last_known_models": [],
                    "current": null,
                    "message": format!("No running agent found for profile '{}'.", profile.name),
                })),
            )
                .into_response(),
        };

    // 3. Prefer the structured ACP model selector.
    let mut models_result = None;
    let mut acp_read_succeeded = false;
    match crate::services::agent_service::get_agent_config_options(&running_agent_id).await {
        Ok(Some(opts)) => {
            acp_read_succeeded = true;
            models_result = extract_models_from_config_options(&opts);
        }
        Ok(None) => {
            tracing::warn!(agent_id = %running_agent_id, "Agent disappeared during model refresh");
        }
        Err(e) => {
            tracing::warn!(
                error = %e,
                agent_id = %running_agent_id,
                "get_agent_config_options failed during model refresh"
            );
        }
    }

    // 4. Only fall back to text if the agent advertised the command. `/model`
    // is a private command, not an ACP contract, so never send it blindly.
    if models_result.is_none() && acp_read_succeeded {
        let supports_model_command =
            match crate::services::agent_service::get_agent_available_commands(&running_agent_id)
                .await
            {
                Ok(Some(commands)) => commands.iter().any(|command| {
                    let command_name = command.name.trim();
                    command_name == "/model" || command_name.eq_ignore_ascii_case("model")
                }),
                Ok(None) => false,
                Err(e) => {
                    tracing::warn!(
                        error = %e,
                        agent_id = %running_agent_id,
                        "Failed to read available commands during model refresh"
                    );
                    false
                }
            };

        if supports_model_command {
            match crate::services::agent_service::execute_agent_command(
                &running_agent_id,
                "/model",
                3,
            )
            .await
            {
                Ok(output) => {
                    models_result = parse_model_output(&output).map(|parsed| {
                        let models = parsed
                            .get("models")
                            .and_then(serde_json::Value::as_array)
                            .map(|values| {
                                values
                                    .iter()
                                    .filter_map(serde_json::Value::as_str)
                                    .map(ToString::to_string)
                                    .collect::<Vec<_>>()
                            })
                            .unwrap_or_default();
                        DetectedModels {
                            models,
                            current: parsed
                                .get("current")
                                .and_then(serde_json::Value::as_str)
                                .map(ToString::to_string),
                            option_id: None,
                        }
                    });
                }
                Err(e) => {
                    tracing::warn!(
                        error = %e,
                        agent_id = %running_agent_id,
                        "Declared /model command failed during model refresh"
                    );
                }
            }
        }
    }

    // 4b. Claude Code does not expose a model selector over ACP, but its CLI
    // prints the available models to stdout. Fall back to a short subprocess
    // so the catalog can still be populated.
    if models_result.is_none() && profile.name.to_lowercase().contains("claude") {
        match tokio::process::Command::new(claude_cli_path())
            .arg("/model")
            .output()
            .await
        {
            Ok(output) => {
                let text = String::from_utf8_lossy(&output.stdout);
                if let Some(parsed) = parse_model_output(&text) {
                    let models = parsed
                        .get("models")
                        .and_then(serde_json::Value::as_array)
                        .map(|values| {
                            values
                                .iter()
                                .filter_map(serde_json::Value::as_str)
                                // Claude prints alias/variant tokens (best, *plan, * [1m])
                                // that are not individually selectable in most setups.
                                .filter(|m| {
                                    let lower = m.to_lowercase();
                                    !lower.contains('[')
                                        && lower != "best"
                                        && lower != "opusplan"
                                        && lower != "default"
                                })
                                .map(ToString::to_string)
                                .collect::<Vec<_>>()
                        })
                        .unwrap_or_default();
                    if !models.is_empty() {
                        models_result = Some(DetectedModels {
                            models,
                            current: parsed
                                .get("current")
                                .and_then(serde_json::Value::as_str)
                                .map(ToString::to_string),
                            option_id: None,
                        });
                    }
                }
            }
            Err(e) => {
                tracing::warn!(error = %e, "Claude /model subprocess failed");
            }
        }
    }

    // 5. Persist only definitive results. A missing backend/read error leaves
    // the previous cache untouched, but the response still explains why.
    if let Some(detection) = models_result {
        if detection.models.is_empty() {
            return (
                StatusCode::OK,
                Json(serde_json::json!({
                    "status": "unsupported",
                    "source": "slash_command",
                    "models": [],
                    "last_known_models": [],
                    "current": detection.current,
                    "message": "Declared /model command returned no parseable model list",
                })),
            )
                .into_response();
        }

        if let Err(e) = profile_service::save_profile_models_by_name(
            &name,
            &detection.models,
            detection.option_id.as_deref(),
        )
        .await
        {
            return crate::http_error::internal(e, "refresh_profile_models_save").into_response();
        }
        let source =
            if profile.name.to_lowercase().contains("claude") && detection.option_id.is_none() {
                "cli_subprocess"
            } else {
                detection
                    .option_id
                    .as_deref()
                    .map(|_| "acp_config_options")
                    .unwrap_or("slash_command")
            };
        (
            StatusCode::OK,
            Json(serde_json::json!({
                "status": "available",
                "source": source,
                "models": detection.models,
                "current": detection.current,
            })),
        )
            .into_response()
    } else if acp_read_succeeded {
        if let Err(e) = profile_service::mark_profile_models_unavailable_by_name(&name).await {
            return crate::http_error::internal(e, "refresh_profile_models_unsupported")
                .into_response();
        }
        let catalog = match profile_service::get_profile_models_by_name(&name).await {
            Ok(catalog) => catalog,
            Err(e) => {
                return crate::http_error::internal(e, "refresh_profile_models_read")
                    .into_response()
            }
        };
        (
            StatusCode::OK,
            Json(serde_json::json!({
                "status": catalog.status,
                "source": catalog.source,
                "models": catalog.models,
                "last_known_models": catalog.last_known_models,
                "current": catalog.current,
                "verified_at": catalog.verified_at,
                "message": "Agent did not expose a model selector",
            })),
        )
            .into_response()
    } else {
        let previous = match profile_service::get_profile_models_by_name(&name).await {
            Ok(catalog) => catalog,
            Err(e) => {
                return crate::http_error::internal(e, "refresh_profile_models_read")
                    .into_response()
            }
        };
        (
            StatusCode::OK,
            Json(serde_json::json!({
                "status": "detection_failed",
                "source": "none",
                "models": previous.models,
                "last_known_models": previous.last_known_models,
                "current": null,
                "verified_at": previous.verified_at,
                "message": "Could not read agent config options; previous cache was not changed",
            })),
        )
            .into_response()
    }
}

/// Find a running agent matching the profile name.
async fn find_running_agent_for_profile(profile_name: &str) -> Result<String, String> {
    // List running agents and find one matching this profile
    let agents = crate::services::agent_service::list_agents_filtered(
        crate::services::agent_service::AgentListFilter::default(),
    )
    .await;

    // Look for an alive agent with matching profile name
    for agent in &agents {
        if agent.profile.as_deref() == Some(profile_name) && agent.is_alive {
            return Ok(agent.agent_id.clone());
        }
    }

    Err(format!(
        "No running agent found for profile '{}'",
        profile_name
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn test_register_profile_request_deserialization() {
        let json = json!({
            "name": "test-agent",
            "command": "python3 agent.py",
            "agent_type": "acp"
        });
        let req: RegisterProfileRequest = serde_json::from_value(json).unwrap();
        assert_eq!(req.name, "test-agent");
        assert_eq!(req.command, "python3 agent.py");
        assert_eq!(req.agent_type, ApiAgentType::Acp);
        assert!(req.package_name.is_none());
        assert!(req.avatar_url.is_none());
    }

    #[test]
    fn test_register_profile_request_all_fields() {
        let json = json!({
            "name": "test-agent",
            "command": "python3 agent.py",
            "agent_type": "acp",
            "package_name": "@anthropic/claude",
            "avatar_url": "https://example.com/avatar.png"
        });
        let req: RegisterProfileRequest = serde_json::from_value(json).unwrap();
        assert_eq!(req.name, "test-agent");
        assert_eq!(req.package_name, Some("@anthropic/claude".to_string()));
        assert_eq!(
            req.avatar_url,
            Some("https://example.com/avatar.png".to_string())
        );
    }

    #[test]
    fn test_profile_response_serialization() {
        let resp = ProfileResponse {
            id: "profile-1".to_string(),
            name: "test-agent".to_string(),
            command: "python3 agent.py".to_string(),
            agent_type: "acp".to_string(),
            package_name: Some("@anthropic/claude".to_string()),
            avatar_url: None,
            native_triggers: None,
            discovery_triggers: None,
            created_at: "2026-01-01T00:00:00Z".to_string(),
        };
        let json = serde_json::to_value(&resp).unwrap();
        assert_eq!(json["id"], "profile-1");
        assert_eq!(json["name"], "test-agent");
        assert_eq!(json["agent_type"], "acp");
        assert_eq!(json["package_name"], "@anthropic/claude");
    }

    #[test]
    fn test_list_profiles_response_serialization() {
        let resp = ListProfilesResponse {
            profiles: vec![
                ProfileResponse {
                    id: "p1".to_string(),
                    name: "agent-1".to_string(),
                    command: "cmd1".to_string(),
                    agent_type: "acp".to_string(),
                    package_name: None,
                    avatar_url: None,
                    native_triggers: None,
                    discovery_triggers: None,
                    created_at: "2026-01-01T00:00:00Z".to_string(),
                },
                ProfileResponse {
                    id: "p2".to_string(),
                    name: "agent-2".to_string(),
                    command: "cmd2".to_string(),
                    agent_type: "mcp".to_string(),
                    package_name: None,
                    avatar_url: None,
                    native_triggers: None,
                    discovery_triggers: None,
                    created_at: "2026-01-01T00:00:00Z".to_string(),
                },
            ],
        };
        let json = serde_json::to_value(&resp).unwrap();
        assert_eq!(json["profiles"].as_array().unwrap().len(), 2);
    }

    #[test]
    fn test_profile_response_from_agent_registration() {
        let reg = AgentRegistration::new(
            "test-agent".to_string(),
            "python3 agent.py".to_string(),
            "acp".to_string(),
        );
        let resp = ProfileResponse::from(reg.clone());
        assert_eq!(resp.name, reg.name);
        assert_eq!(resp.command, reg.command);
        assert_eq!(resp.agent_type, reg.agent_type);
    }

    #[test]
    fn test_profile_response_discovery_triggers_roundtrip() {
        let triggers = serde_json::json!([
            {"char": "/", "kind": "slash"},
            {"char": "@", "kind": "mention"}
        ]);
        let resp = ProfileResponse {
            id: "p1".to_string(),
            name: "a".to_string(),
            command: "cmd".to_string(),
            agent_type: "acp".to_string(),
            package_name: None,
            avatar_url: None,
            native_triggers: None,
            discovery_triggers: Some(triggers.clone()),
            created_at: "2026-01-01T00:00:00Z".to_string(),
        };
        let v = serde_json::to_value(&resp).unwrap();
        assert_eq!(v["discovery_triggers"], triggers);
    }

    #[test]
    fn test_profile_response_from_registration_with_discovery_triggers() {
        let mut reg =
            AgentRegistration::new("disc".to_string(), "cmd".to_string(), "acp".to_string());
        reg.discovery_triggers_json = Some(
            serde_json::to_string(&serde_json::json!([{"char": "/", "kind": "slash"}])).unwrap(),
        );
        let resp = ProfileResponse::from(reg);
        assert!(resp.discovery_triggers.is_some());
        let arr = resp.discovery_triggers.unwrap();
        assert_eq!(arr.as_array().unwrap().len(), 1);
        assert_eq!(arr[0]["char"], "/");
    }
}
