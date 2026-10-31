//! Agent Profile Registry API handlers
//!
//! 业务逻辑已迁移到 `crate::services::profile_service`，handler 只负责
//! HTTP 请求解析、响应格式化和错误状态码映射。

use crate::Json;
use axum::{extract::Path, http::StatusCode, response::IntoResponse};
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

use ergatai_runtime::profile_registry::AgentRegistration;

use super::agents::extract_models_from_config_options;
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
    pub created_at: String,
}

impl From<AgentRegistration> for ProfileResponse {
    fn from(reg: AgentRegistration) -> Self {
        Self {
            id: reg.id,
            name: reg.name,
            command: reg.command,
            agent_type: reg.agent_type,
            package_name: reg.package_name,
            avatar_url: reg.avatar_url,
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
    pub installed: bool,
    pub created_at: String,
}

impl From<ergatai_runtime::profile_registry::ProfileWithStatus> for ProfileWithStatusResponse {
    fn from(p: ergatai_runtime::profile_registry::ProfileWithStatus) -> Self {
        Self {
            id: p.id,
            name: p.name,
            command: p.command,
            agent_type: p.agent_type,
            package_name: p.package_name,
            avatar_url: p.avatar_url,
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

/// Get cached models for an agent profile
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
        Ok(Some(models)) => (StatusCode::OK, Json(models)).into_response(),
        Ok(None) => (
            StatusCode::OK,
            Json(serde_json::json!({ "models": [], "current": null, "updated_at": null })),
        )
            .into_response(),
        Err(e) => crate::http_error::internal(e, "get_profile_models").into_response(),
    }
}

/// Trigger model detection for an agent profile via ACP config_options
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

    // 2. Find a running agent for this profile
    let running_agent_id = match find_running_agent_for_profile(&profile.name).await {
        Ok(agent_id) => agent_id,
        Err(_e) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({
                    "error": "No running agent",
                    "message": format!("No running agent found for profile '{}'. Please start an agent first before refreshing models.", profile.name),
                    "hint": "Use the spawn agent API or UI to start an agent with this profile."
                })),
            ).into_response()
        }
    };

    // 3. Call get_agent_config_options on the running agent
    let models_result =
        match crate::services::agent_service::get_agent_config_options(&running_agent_id).await {
            Ok(Some(opts)) => extract_models_from_config_options(&opts),
            Ok(None) => None,
            Err(e) => {
                tracing::warn!(
                    error = %e,
                    "get_agent_config_options failed during model refresh"
                );
                None
            }
        };

    // 4. Extract models and save to DB (using profile name)
    if let Some((models, current)) = models_result {
        if let Err(e) =
            profile_service::save_profile_models_by_name(&name, &models, current.as_deref()).await
        {
            return crate::http_error::internal(e, "refresh_profile_models_save").into_response();
        }
        (
            StatusCode::OK,
            Json(serde_json::json!({
                "status": "success",
                "models": models,
                "current": current,
            })),
        )
            .into_response()
    } else {
        (
            StatusCode::OK,
            Json(serde_json::json!({
                "status": "success",
                "models": [],
                "current": null,
                "message": "No models detected from agent",
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
                    created_at: "2026-01-01T00:00:00Z".to_string(),
                },
                ProfileResponse {
                    id: "p2".to_string(),
                    name: "agent-2".to_string(),
                    command: "cmd2".to_string(),
                    agent_type: "mcp".to_string(),
                    package_name: None,
                    avatar_url: None,
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
}
