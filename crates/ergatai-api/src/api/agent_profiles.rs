//! Agent Profile Registry API handlers
//!
//! 业务逻辑已迁移到 `crate::services::profile_service`，handler 只负责
//! HTTP 请求解析、响应格式化和错误状态码映射。

use axum::{extract::Path, http::StatusCode, response::IntoResponse, Json};
use serde::{Deserialize, Serialize};

use ergatai_runtime::profile_registry::AgentRegistration;

use crate::services::profile_service;

/// Request to register a new agent profile
#[derive(Debug, Deserialize)]
pub struct RegisterProfileRequest {
    pub name: String,
    pub command: String,
    pub agent_type: String,
    pub package_name: Option<String>,
}

/// Response for a single agent profile
#[derive(Debug, Serialize)]
pub struct ProfileResponse {
    pub name: String,
    pub command: String,
    pub agent_type: String,
    pub package_name: Option<String>,
    pub created_at: String,
}

impl From<AgentRegistration> for ProfileResponse {
    fn from(reg: AgentRegistration) -> Self {
        Self {
            name: reg.name,
            command: reg.command,
            agent_type: reg.agent_type,
            package_name: reg.package_name,
            created_at: reg.created_at.to_rfc3339(),
        }
    }
}

/// Response for listing agent profiles
#[derive(Debug, Serialize)]
pub struct ListProfilesResponse {
    pub profiles: Vec<ProfileResponse>,
}

/// Register a new agent profile
///
/// POST /api/v1/agent-profiles
pub async fn register_profile(Json(request): Json<RegisterProfileRequest>) -> impl IntoResponse {
    match profile_service::register_profile(
        request.name.clone(),
        request.command.clone(),
        request.agent_type.clone(),
        request.package_name.clone(),
    )
    .await
    {
        Ok(()) => (
            StatusCode::CREATED,
            Json(serde_json::json!({
                "status": "success",
                "message": format!("Agent profile '{}' registered successfully", request.name)
            })),
        ),
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
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    crate::sanitize_error(&e, "register_agent_profile"),
                )
            };
            (
                status,
                Json(serde_json::json!({
                    "error": message
                })),
            )
        }
    }
}

/// List all registered agent profiles
///
/// GET /api/v1/agent-profiles
pub async fn list_profiles() -> impl IntoResponse {
    match profile_service::list_profiles().await {
        Ok(profiles) => {
            let response = ListProfilesResponse {
                profiles: profiles.into_iter().map(ProfileResponse::from).collect(),
            };
            match serde_json::to_value(response) {
                Ok(value) => (StatusCode::OK, Json(value)),
                Err(e) => (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(serde_json::json!({
                        "error": format!("Failed to serialize profiles: {}", e)
                    })),
                ),
            }
        }
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({
                "error": format!("Failed to list profiles: {}", e)
            })),
        ),
    }
}

/// Get a specific agent profile
///
/// GET /api/v1/agent-profiles/:name
pub async fn get_profile(Path(name): Path<String>) -> impl IntoResponse {
    match profile_service::get_profile(&name).await {
        Ok(Some(registration)) => match serde_json::to_value(ProfileResponse::from(registration)) {
            Ok(value) => (StatusCode::OK, Json(value)),
            Err(e) => (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({
                    "error": format!("Failed to serialize profile: {}", e)
                })),
            ),
        },
        Ok(None) => (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({
                "error": format!("Agent profile '{}' not found", name)
            })),
        ),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({
                "error": format!("Failed to get profile: {}", e)
            })),
        ),
    }
}

/// Delete an agent profile
///
/// DELETE /api/v1/agent-profiles/:name
pub async fn delete_profile(Path(name): Path<String>) -> impl IntoResponse {
    match profile_service::delete_profile(&name).await {
        Ok(true) => (
            StatusCode::OK,
            Json(serde_json::json!({
                "status": "success",
                "message": format!("Agent profile '{}' deleted successfully", name)
            })),
        ),
        Ok(false) => (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({
                "error": format!("Agent profile '{}' not found", name)
            })),
        ),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({
                "error": format!("Failed to delete profile: {}", e)
            })),
        ),
    }
}

/// Response for a profile with installation status
#[derive(Debug, Serialize)]
pub struct ProfileWithStatusResponse {
    pub name: String,
    pub command: String,
    pub agent_type: String,
    pub package_name: Option<String>,
    pub installed: bool,
    pub created_at: String,
}

impl From<ergatai_runtime::profile_registry::ProfileWithStatus> for ProfileWithStatusResponse {
    fn from(p: ergatai_runtime::profile_registry::ProfileWithStatus) -> Self {
        Self {
            name: p.name,
            command: p.command,
            agent_type: p.agent_type,
            package_name: p.package_name,
            installed: p.installed,
            created_at: p.created_at,
        }
    }
}

/// Response for listing profiles with status
#[derive(Debug, Serialize)]
pub struct ListProfilesWithStatusResponse {
    pub profiles: Vec<ProfileWithStatusResponse>,
}

/// List all agent profiles with installation status
///
/// GET /api/v1/agent-profiles/with-status
pub async fn list_with_status() -> impl IntoResponse {
    match profile_service::list_profiles_with_status() {
        Ok(profiles) => {
            let response = ListProfilesWithStatusResponse {
                profiles: profiles
                    .into_iter()
                    .map(ProfileWithStatusResponse::from)
                    .collect(),
            };
            match serde_json::to_value(response) {
                Ok(value) => (StatusCode::OK, Json(value)),
                Err(e) => (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(serde_json::json!({
                        "error": format!("Failed to serialize profiles: {}", e)
                    })),
                ),
            }
        }
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({
                "error": format!("Failed to list profiles: {}", e)
            })),
        ),
    }
}

/// Install an agent by profile name (npm install -g)
///
/// POST /api/v1/agent-profiles/:name/install
pub async fn install_agent(Path(name): Path<String>) -> impl IntoResponse {
    match profile_service::install_agent(&name).await {
        Ok(output) => (
            StatusCode::OK,
            Json(serde_json::json!({
                "status": "success",
                "message": format!("Agent '{}' installed successfully", name),
                "output": output
            })),
        ),
        Err(e) => {
            let err_text = e.to_string();
            let is_user_error = err_text.contains("not found")
                || err_text.contains("no package_name")
                || err_text.contains("cannot be empty");

            let (status, message) = if is_user_error {
                (StatusCode::BAD_REQUEST, err_text)
            } else {
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    crate::sanitize_error(&e, "install_agent"),
                )
            };
            (
                status,
                Json(serde_json::json!({
                    "error": message
                })),
            )
        }
    }
}

/// Uninstall an agent by profile name (npm uninstall -g)
///
/// DELETE /api/v1/agent-profiles/:name/uninstall
pub async fn uninstall_agent(Path(name): Path<String>) -> impl IntoResponse {
    match profile_service::uninstall_agent(&name).await {
        Ok(output) => (
            StatusCode::OK,
            Json(serde_json::json!({
                "status": "success",
                "message": format!("Agent '{}' uninstalled successfully", name),
                "output": output
            })),
        ),
        Err(e) => {
            let err_text = e.to_string();
            let is_user_error = err_text.contains("not found")
                || err_text.contains("no package_name")
                || err_text.contains("cannot be empty");

            let (status, message) = if is_user_error {
                (StatusCode::BAD_REQUEST, err_text)
            } else {
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    crate::sanitize_error(&e, "uninstall_agent"),
                )
            };
            (
                status,
                Json(serde_json::json!({
                    "error": message
                })),
            )
        }
    }
}
