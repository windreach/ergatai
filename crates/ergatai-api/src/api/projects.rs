//! Projects API endpoints
//!
//! REST API for managing projects (code repositories/folders).

use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::IntoResponse,
    Json,
};
use serde::{Deserialize, Serialize};

use crate::user_data_db::{self, Project};
use crate::AppState;

// ── Request/Response Types ───────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
pub struct CreateProjectRequest {
    pub name: String,
    pub path: String,
    pub git_remote_url: Option<String>,
    pub git_provider: Option<String>,
    pub git_owner: Option<String>,
    pub git_repo: Option<String>,
    pub icon_path: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct UpdateProjectRequest {
    pub name: Option<String>,
    pub git_remote_url: Option<Option<String>>,
    pub git_provider: Option<Option<String>>,
    pub git_owner: Option<Option<String>>,
    pub git_repo: Option<Option<String>>,
    pub icon_path: Option<Option<String>>,
}

#[derive(Debug, Serialize)]
pub struct ProjectResponse {
    pub id: String,
    pub name: String,
    pub path: String,
    pub git_remote_url: Option<String>,
    pub git_provider: Option<String>,
    pub git_owner: Option<String>,
    pub git_repo: Option<String>,
    pub icon_path: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Serialize)]
pub struct ErrorResponse {
    pub error: String,
}

// ── Helper Functions ─────────────────────────────────────────────────────────

fn project_to_response(project: Project) -> ProjectResponse {
    ProjectResponse {
        id: project.id,
        name: project.name,
        path: project.path,
        git_remote_url: project.git_remote_url,
        git_provider: project.git_provider,
        git_owner: project.git_owner,
        git_repo: project.git_repo,
        icon_path: project.icon_path,
        created_at: project.created_at,
        updated_at: project.updated_at,
    }
}

fn generate_id() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    format!("proj_{}", timestamp)
}

// ── API Handlers ─────────────────────────────────────────────────────────────

/// GET /api/v1/projects
///
/// List all projects, ordered by creation date (newest first).
pub async fn list_projects(State(_state): State<AppState>) -> impl IntoResponse {
    match user_data_db::projects::list() {
        Ok(projects) => {
            let response: Vec<ProjectResponse> =
                projects.into_iter().map(project_to_response).collect();
            (StatusCode::OK, Json(response)).into_response()
        }
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse {
                error: format!("Failed to list projects: {}", e),
            }),
        )
            .into_response(),
    }
}

/// POST /api/v1/projects
///
/// Create a new project.
pub async fn create_project(
    State(_state): State<AppState>,
    Json(req): Json<CreateProjectRequest>,
) -> impl IntoResponse {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs() as i64;

    let project = Project {
        id: generate_id(),
        name: req.name,
        path: req.path,
        git_remote_url: req.git_remote_url,
        git_provider: req.git_provider,
        git_owner: req.git_owner,
        git_repo: req.git_repo,
        icon_path: req.icon_path,
        created_at: now,
        updated_at: now,
    };

    match user_data_db::projects::create(project) {
        Ok(created) => {
            let response = project_to_response(created);
            (StatusCode::CREATED, Json(response)).into_response()
        }
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse {
                error: format!("Failed to create project: {}", e),
            }),
        )
            .into_response(),
    }
}

/// GET /api/v1/projects/:id
///
/// Get a specific project by ID.
pub async fn get_project(
    State(_state): State<AppState>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    match user_data_db::projects::get(&id) {
        Ok(Some(project)) => {
            let response = project_to_response(project);
            (StatusCode::OK, Json(response)).into_response()
        }
        Ok(None) => (
            StatusCode::NOT_FOUND,
            Json(ErrorResponse {
                error: format!("Project not found: {}", id),
            }),
        )
            .into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse {
                error: format!("Failed to get project: {}", e),
            }),
        )
            .into_response(),
    }
}

/// PUT /api/v1/projects/:id
///
/// Update a project.
pub async fn update_project(
    State(_state): State<AppState>,
    Path(id): Path<String>,
    Json(req): Json<UpdateProjectRequest>,
) -> impl IntoResponse {
    // First check if project exists
    let existing = match user_data_db::projects::get(&id) {
        Ok(Some(project)) => project,
        Ok(None) => {
            return (
                StatusCode::NOT_FOUND,
                Json(ErrorResponse {
                    error: format!("Project not found: {}", id),
                }),
            )
                .into_response()
        }
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ErrorResponse {
                    error: format!("Failed to get project: {}", e),
                }),
            )
                .into_response()
        }
    };

    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs() as i64;

    let git_remote_url = req
        .git_remote_url
        .unwrap_or(existing.git_remote_url.clone());
    let git_provider = req.git_provider.unwrap_or(existing.git_provider.clone());
    let git_owner = req.git_owner.unwrap_or(existing.git_owner.clone());
    let git_repo = req.git_repo.unwrap_or(existing.git_repo.clone());
    let icon_path = req.icon_path.unwrap_or(existing.icon_path.clone());

    let updated_project = Project {
        id: existing.id.clone(),
        name: req.name.unwrap_or_else(|| existing.name.clone()),
        path: existing.path.clone(),
        git_remote_url,
        git_provider,
        git_owner,
        git_repo,
        icon_path,
        created_at: existing.created_at,
        updated_at: now,
    };

    match user_data_db::projects::update(updated_project) {
        Ok(_) => {
            // Fetch updated project
            match user_data_db::projects::get(&id) {
                Ok(Some(project)) => {
                    let response = project_to_response(project);
                    (StatusCode::OK, Json(response)).into_response()
                }
                Ok(None) => (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(ErrorResponse {
                        error: "Project disappeared after update".to_string(),
                    }),
                )
                    .into_response(),
                Err(e) => (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(ErrorResponse {
                        error: format!("Failed to fetch updated project: {}", e),
                    }),
                )
                    .into_response(),
            }
        }
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse {
                error: format!("Failed to update project: {}", e),
            }),
        )
            .into_response(),
    }
}

/// DELETE /api/v1/projects/:id
///
/// Delete a project. This will also delete all associated chats (cascade).
pub async fn delete_project(
    State(_state): State<AppState>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    match user_data_db::projects::delete(&id) {
        Ok(_) => StatusCode::NO_CONTENT.into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse {
                error: format!("Failed to delete project: {}", e),
            }),
        )
            .into_response(),
    }
}
