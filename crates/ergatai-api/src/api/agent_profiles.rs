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
    pub avatar_url: Option<String>,
}

/// Response for a single agent profile
#[derive(Debug, Serialize)]
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
#[derive(Debug, Serialize)]
pub struct ListProfilesResponse {
    pub profiles: Vec<ProfileResponse>,
}

/// Register a new agent profile
///
/// POST /api/v1/agent-profiles
pub async fn register_profile(Json(request): Json<RegisterProfileRequest>) -> impl IntoResponse {
    // Capture the name before moving fields into the service call, so we can
    // reuse it in the success response without an extra clone.
    let profile_name = request.name.clone();
    match profile_service::register_profile(
        request.name,
        request.command,
        request.agent_type,
        request.package_name,
        request.avatar_url,
    )
    .await
    {
        Ok(()) => (
            StatusCode::CREATED,
            Json(serde_json::json!({
                "status": "success",
                "message": format!("Agent profile '{}' registered successfully", profile_name)
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
                "error": crate::sanitize_error(&e, "list_profiles")
            })),
        ),
    }
}

/// Get a specific agent profile
///
/// GET /api/v1/agent-profiles/:id
pub async fn get_profile(Path(id): Path<String>) -> impl IntoResponse {
    match profile_service::get_profile(&id).await {
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
                "error": format!("Agent profile '{}' not found", id)
            })),
        ),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({
                "error": crate::sanitize_error(&e, "get_profile")
            })),
        ),
    }
}

/// Delete an agent profile
///
/// DELETE /api/v1/agent-profiles/:id
pub async fn delete_profile(Path(id): Path<String>) -> impl IntoResponse {
    match profile_service::delete_profile(&id).await {
        Ok(true) => (
            StatusCode::OK,
            Json(serde_json::json!({
                "status": "success",
                "message": format!("Agent profile '{}' deleted successfully", id)
            })),
        ),
        Ok(false) => (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({
                "error": format!("Agent profile '{}' not found", id)
            })),
        ),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({
                "error": crate::sanitize_error(&e, "delete_profile")
            })),
        ),
    }
}

/// Response for a profile with installation status
#[derive(Debug, Serialize)]
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
                "error": crate::sanitize_error(&e, "list_with_status")
            })),
        ),
    }
}

/// Install an agent by profile ID (npm install -g)
///
/// POST /api/v1/agent-profiles/:id/install
pub async fn install_agent(Path(id): Path<String>) -> impl IntoResponse {
    match profile_service::install_agent(&id).await {
        Ok(output) => (
            StatusCode::OK,
            Json(serde_json::json!({
                "status": "success",
                "message": format!("Agent '{}' installed successfully", id),
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

/// Uninstall an agent by profile ID (npm uninstall -g)
///
/// DELETE /api/v1/agent-profiles/:id/uninstall
pub async fn uninstall_agent(Path(id): Path<String>) -> impl IntoResponse {
    match profile_service::uninstall_agent(&id).await {
        Ok(output) => (
            StatusCode::OK,
            Json(serde_json::json!({
                "status": "success",
                "message": format!("Agent '{}' uninstalled successfully", id),
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
        assert_eq!(req.agent_type, "acp");
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
        assert_eq!(req.avatar_url, Some("https://example.com/avatar.png".to_string()));
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
