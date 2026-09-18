//! Projects API endpoints
//!
//! REST API for managing projects (code repositories/folders).

use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

use crate::user_data_db::{self, Project};
use crate::AppState;

// ── Request/Response Types ───────────────────────────────────────────────────

#[derive(Debug, Deserialize, ToSchema)]
pub struct CreateProjectRequest {
    pub name: String,
    pub path: String,
    pub git_remote_url: Option<String>,
    pub git_provider: Option<String>,
    pub git_owner: Option<String>,
    pub git_repo: Option<String>,
    pub icon_path: Option<String>,
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct UpdateProjectRequest {
    pub name: Option<String>,
    pub git_remote_url: Option<Option<String>>,
    pub git_provider: Option<Option<String>>,
    pub git_owner: Option<Option<String>>,
    pub git_repo: Option<Option<String>>,
    pub icon_path: Option<Option<String>>,
}

#[derive(Debug, Serialize, ToSchema)]
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

fn db_error(operation: &'static str, error: rusqlite::Error) -> Response {
    let response = (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(ErrorResponse {
            error: crate::sanitize_error(&error, operation),
        }),
    );
    response.into_response()
}

// ── API Handlers ─────────────────────────────────────────────────────────────

/// GET /api/v1/projects
///
/// List all projects, ordered by creation date (newest first).
#[utoipa::path(
    get,
    path = "/api/v1/projects",
    tag = "Projects",
    responses(
        (status = 200, description = "List projects", body = Vec<ProjectResponse>),
        (status = 500, description = "Internal server error", body = crate::api::ApiError),
    )
)]
pub async fn list_projects(State(_state): State<AppState>) -> impl IntoResponse {
    match tokio::task::spawn_blocking(move || user_data_db::projects::list()).await {
        Ok(Ok(projects)) => {
            let response: Vec<ProjectResponse> =
                projects.into_iter().map(project_to_response).collect();
            (StatusCode::OK, Json(response)).into_response()
        }
        Ok(Err(error)) => db_error("Failed to list projects", error),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse {
                error: format!("Task join error: {}", e),
            }),
        )
            .into_response(),
    }
}

/// Create a new project.
#[utoipa::path(
    post,
    path = "/api/v1/projects",
    tag = "Projects",
    request_body = CreateProjectRequest,
    responses(
        (status = 201, description = "Project created", body = ProjectResponse),
        (status = 500, description = "Internal server error", body = crate::api::ApiError),
    )
)]
pub async fn create_project(
    State(_state): State<AppState>,
    Json(req): Json<CreateProjectRequest>,
) -> impl IntoResponse {
    // Validate name is not empty/whitespace
    if req.name.trim().is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(ErrorResponse {
                error: "Project name cannot be empty".to_string(),
            }),
        )
            .into_response();
    }

    // Validate path is not empty/whitespace
    if req.path.trim().is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(ErrorResponse {
                error: "Project path cannot be empty".to_string(),
            }),
        )
            .into_response();
    }

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

    match tokio::task::spawn_blocking(move || user_data_db::projects::create(project)).await {
        Ok(Ok(created)) => {
            let response = project_to_response(created);
            (StatusCode::CREATED, Json(response)).into_response()
        }
        Ok(Err(error)) => db_error("Failed to create project", error),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse {
                error: format!("Task join error: {}", e),
            }),
        )
            .into_response(),
    }
}

/// Get a specific project by ID.
#[utoipa::path(
    get,
    path = "/api/v1/projects/{id}",
    tag = "Projects",
    params(("id" = String, Path, description = "Project ID")),
    responses(
        (status = 200, description = "Project detail", body = ProjectResponse),
        (status = 404, description = "Project not found", body = crate::api::ApiError),
        (status = 500, description = "Internal server error", body = crate::api::ApiError),
    )
)]
pub async fn get_project(
    State(_state): State<AppState>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    let id_for_get = id.clone();
    match tokio::task::spawn_blocking(move || user_data_db::projects::get(&id_for_get)).await {
        Ok(Ok(Some(project))) => {
            let response = project_to_response(project);
            (StatusCode::OK, Json(response)).into_response()
        }
        Ok(Ok(None)) => (
            StatusCode::NOT_FOUND,
            Json(ErrorResponse {
                error: format!("Project not found: {}", id),
            }),
        )
            .into_response(),
        Ok(Err(error)) => db_error("Failed to get project", error),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse {
                error: format!("Task join error: {}", e),
            }),
        )
            .into_response(),
    }
}

/// Update a project.
#[utoipa::path(
    put,
    path = "/api/v1/projects/{id}",
    tag = "Projects",
    params(("id" = String, Path, description = "Project ID")),
    request_body = UpdateProjectRequest,
    responses(
        (status = 200, description = "Project updated", body = ProjectResponse),
        (status = 404, description = "Project not found", body = crate::api::ApiError),
        (status = 500, description = "Internal server error", body = crate::api::ApiError),
    )
)]
pub async fn update_project(
    State(_state): State<AppState>,
    Path(id): Path<String>,
    Json(req): Json<UpdateProjectRequest>,
) -> impl IntoResponse {
    // First check if project exists
    let id_for_get = id.clone();
    let existing = match tokio::task::spawn_blocking(move || user_data_db::projects::get(&id_for_get)).await {
        Ok(Ok(Some(project))) => project,
        Ok(Ok(None)) => {
            return (
                StatusCode::NOT_FOUND,
                Json(ErrorResponse {
                    error: format!("Project not found: {}", id),
                }),
            )
                .into_response()
        }
        Ok(Err(error)) => return db_error("Failed to get project", error),
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ErrorResponse {
                    error: format!("Task join error: {}", e),
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

    match tokio::task::spawn_blocking(move || user_data_db::projects::update(updated_project)).await {
        Ok(Ok(_)) => {}
        Ok(Err(error)) => return db_error("Failed to update project", error),
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ErrorResponse {
                    error: format!("Task join error: {}", e),
                }),
            )
                .into_response()
        }
    }

    // Fetch updated project
    let id_for_reload = id.clone();
    match tokio::task::spawn_blocking(move || user_data_db::projects::get(&id_for_reload)).await {
        Ok(Ok(Some(project))) => {
            let response = project_to_response(project);
            (StatusCode::OK, Json(response)).into_response()
        }
        Ok(Ok(None)) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse {
                error: "Project disappeared after update".to_string(),
            }),
        )
            .into_response(),
        Ok(Err(error)) => db_error("Failed to fetch updated project", error),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse {
                error: format!("Task join error: {}", e),
            }),
        )
            .into_response(),
    }
}

/// Delete a project. This will also delete all associated chats (cascade).
#[utoipa::path(
    delete,
    path = "/api/v1/projects/{id}",
    tag = "Projects",
    params(("id" = String, Path, description = "Project ID")),
    responses(
        (status = 204, description = "Project deleted"),
        (status = 500, description = "Internal server error", body = crate::api::ApiError),
    )
)]
pub async fn delete_project(
    State(_state): State<AppState>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    let id_for_delete = id.clone();
    match tokio::task::spawn_blocking(move || user_data_db::projects::delete(&id_for_delete)).await {
        Ok(Ok(_)) => StatusCode::NO_CONTENT.into_response(),
        Ok(Err(error)) => db_error("Failed to delete project", error),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse {
                error: format!("Task join error: {}", e),
            }),
        )
            .into_response(),
    }
}
