//! Agent Profile Registry API handlers

use axum::{extract::Path, http::StatusCode, response::IntoResponse, Json};
use serde::{Deserialize, Serialize};

use ergatai_runtime::profile_registry::{AgentRegistration, ProfileRegistry};

/// Default path for the profile registry database
fn profile_registry_db_path() -> String {
    ".ergatai/profile_registry.db".to_string()
}

/// Request to register a new agent profile
#[derive(Debug, Deserialize)]
pub struct RegisterProfileRequest {
    pub name: String,
    pub command: String,
    pub agent_type: String,
}

/// Response for a single agent profile
#[derive(Debug, Serialize)]
pub struct ProfileResponse {
    pub name: String,
    pub command: String,
    pub agent_type: String,
    pub created_at: String,
}

impl From<AgentRegistration> for ProfileResponse {
    fn from(reg: AgentRegistration) -> Self {
        Self {
            name: reg.name,
            command: reg.command,
            agent_type: reg.agent_type,
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
    let registry = match ProfileRegistry::new(profile_registry_db_path()) {
        Ok(r) => r,
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({
                    "error": format!("Failed to open profile registry: {}", e)
                })),
            );
        }
    };

    let registration = AgentRegistration::new(
        request.name.clone(),
        request.command.clone(),
        request.agent_type.clone(),
    );

    match registry.register(registration).await {
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
    let registry = match ProfileRegistry::new(profile_registry_db_path()) {
        Ok(r) => r,
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({
                    "error": format!("Failed to open profile registry: {}", e)
                })),
            );
        }
    };

    match registry.list().await {
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
    let registry = match ProfileRegistry::new(profile_registry_db_path()) {
        Ok(r) => r,
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({
                    "error": format!("Failed to open profile registry: {}", e)
                })),
            );
        }
    };

    match registry.get(&name).await {
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
    let registry = match ProfileRegistry::new(profile_registry_db_path()) {
        Ok(r) => r,
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({
                    "error": format!("Failed to open profile registry: {}", e)
                })),
            );
        }
    };

    match registry.delete(&name).await {
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
