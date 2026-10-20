use crate::Json;
use crate::JsonQuery;
use axum::{extract::Path, http::StatusCode, response::IntoResponse, response::Response};
use serde::{Deserialize, Serialize};

use crate::services::workspace_manager as manager;

#[derive(Debug, Serialize)]
pub struct ErrorResponse {
    pub error: String,
}

fn managed_error(error: manager::WorkspaceManagerError, context: &'static str) -> Response {
    match error {
        manager::WorkspaceManagerError::Validation(message) => {
            crate::http_error::bad_request(message).into_response()
        }
        manager::WorkspaceManagerError::NotFound(message) => {
            crate::http_error::not_found("Resource", &message).into_response()
        }
        manager::WorkspaceManagerError::Conflict(message) => {
            (StatusCode::CONFLICT, Json(ErrorResponse { error: message })).into_response()
        }
        manager::WorkspaceManagerError::Internal(error) => {
            crate::http_error::internal(error, context).into_response()
        }
    }
}

// ── Managed Workspace APIs ──

#[derive(Debug, Deserialize)]
pub struct DeleteManagedWorkspaceQuery {
    #[serde(default)]
    pub force: bool,
}

#[derive(Debug, Deserialize)]
pub struct ListManagedWorkspacesQuery {
    pub collaboration_mode: Option<crate::services::collaboration_session::CollaborationMode>,
}

#[derive(Debug, Deserialize)]
pub struct RegisteredPathQuery {
    pub path: String,
}

#[utoipa::path(
    get,
    path = "/api/v1/registered-path",
    tag = "ManagedWorkspaces",
    params(
        ("path" = String, Query, description = "Filesystem path to resolve against registered projects and chats")
    ),
    responses(
        (status = 200, description = "Resolved project and/or chat for the path", body = manager::RegisteredPathResponse),
        (status = 400, description = "Missing path parameter", body = crate::api::ApiError),
        (status = 500, description = "Internal server error", body = crate::api::ApiError),
    )
)]
pub async fn get_registered_path(
    JsonQuery(query): JsonQuery<RegisteredPathQuery>,
) -> impl IntoResponse {
    if query.path.is_empty() {
        return crate::http_error::bad_request("path query parameter is required").into_response();
    }
    match manager::find_registered_path(&query.path) {
        Ok(result) => (StatusCode::OK, Json(result)).into_response(),
        Err(error) => managed_error(error, "get_registered_path"),
    }
}

#[utoipa::path(
    get,
    path = "/api/v1/workspaces/managed",
    tag = "ManagedWorkspaces",
    params(
        ("collaboration_mode" = Option<crate::services::collaboration_session::CollaborationMode>, Query, description = "Filter by collaboration mode")
    ),
    responses(
        (status = 200, description = "List managed workspaces", body = Vec<manager::ManagedWorkspace>),
        (status = 500, description = "Internal server error", body = crate::api::ApiError),
        (status = 404, description = "Resource not found", body = crate::api::ApiError),)
)]
pub async fn list_managed_workspaces(
    JsonQuery(query): JsonQuery<ListManagedWorkspacesQuery>,
) -> impl IntoResponse {
    match manager::list(query.collaboration_mode.map(|m| m.as_str())).await {
        Ok(workspaces) => (StatusCode::OK, Json(workspaces)).into_response(),
        Err(error) => managed_error(error, "list_managed_workspaces"),
    }
}

#[utoipa::path(
    post,
    path = "/api/v1/workspaces/managed",
    tag = "ManagedWorkspaces",
    request_body = manager::CreateManagedWorkspaceRequest,
    responses(
        (status = 201, description = "Managed workspace created", body = manager::ManagedWorkspace),
        (status = 400, description = "Invalid workspace", body = crate::api::ApiError),
        (status = 401, description = "Unauthorized", body = crate::api::ApiError),
        (status = 404, description = "Resource not found", body = crate::api::ApiError),
        (status = 409, description = "Workspace already exists", body = crate::api::ApiError),
        (status = 500, description = "Internal server error", body = crate::api::ApiError),
    )
)]
pub async fn create_managed_workspace(
    Json(request): Json<manager::CreateManagedWorkspaceRequest>,
) -> impl IntoResponse {
    match manager::create(request).await {
        Ok(workspace) => (StatusCode::CREATED, Json(workspace)).into_response(),
        Err(error) => managed_error(error, "create_managed_workspace"),
    }
}

#[utoipa::path(
    get,
    path = "/api/v1/workspaces/managed/{id}",
    tag = "ManagedWorkspaces",
    params(("id" = String, Path, description = "Workspace ID")),
    responses(
        (status = 200, description = "Managed workspace found", body = manager::ManagedWorkspace),
        (status = 404, description = "Workspace not found", body = crate::api::ApiError),
        (status = 500, description = "Internal server error", body = crate::api::ApiError),
        (status = 400, description = "Invalid request parameters", body = crate::api::ApiError),)
)]
pub async fn get_managed_workspace(Path(id): Path<String>) -> impl IntoResponse {
    match manager::get(&id).await {
        Ok(workspace) => (StatusCode::OK, Json(workspace)).into_response(),
        Err(error) => managed_error(error, "get_managed_workspace"),
    }
}

#[utoipa::path(
    patch,
    path = "/api/v1/workspaces/managed/{id}",
    tag = "ManagedWorkspaces",
    params(("id" = String, Path, description = "Workspace ID")),
    request_body = manager::UpdateManagedWorkspaceRequest,
    responses(
        (status = 200, description = "Managed workspace updated", body = manager::ManagedWorkspace),
        (status = 400, description = "Invalid workspace", body = crate::api::ApiError),
        (status = 404, description = "Workspace not found", body = crate::api::ApiError),
        (status = 500, description = "Internal server error", body = crate::api::ApiError),
    )
)]
pub async fn update_managed_workspace(
    Path(id): Path<String>,
    Json(request): Json<manager::UpdateManagedWorkspaceRequest>,
) -> impl IntoResponse {
    match manager::update(&id, request).await {
        Ok(workspace) => (StatusCode::OK, Json(workspace)).into_response(),
        Err(error) => managed_error(error, "update_managed_workspace"),
    }
}

#[utoipa::path(
    post,
    path = "/api/v1/workspaces/managed/{id}/archive",
    tag = "ManagedWorkspaces",
    params(("id" = String, Path, description = "Workspace ID")),
    responses(
        (status = 200, description = "Managed workspace archived", body = manager::ManagedWorkspace),
        (status = 404, description = "Workspace not found", body = crate::api::ApiError),
        (status = 500, description = "Internal server error", body = crate::api::ApiError),
        (status = 400, description = "Invalid request parameters", body = crate::api::ApiError),)
)]
pub async fn archive_managed_workspace(Path(id): Path<String>) -> impl IntoResponse {
    match manager::set_status(&id, "archived").await {
        Ok(workspace) => (StatusCode::OK, Json(workspace)).into_response(),
        Err(error) => managed_error(error, "archive_managed_workspace"),
    }
}

#[utoipa::path(
    post,
    path = "/api/v1/workspaces/managed/{id}/restore",
    tag = "ManagedWorkspaces",
    params(("id" = String, Path, description = "Workspace ID")),
    responses(
        (status = 200, description = "Managed workspace restored", body = manager::ManagedWorkspace),
        (status = 404, description = "Workspace not found", body = crate::api::ApiError),
        (status = 500, description = "Internal server error", body = crate::api::ApiError),
        (status = 400, description = "Invalid request parameters", body = crate::api::ApiError),)
)]
pub async fn restore_managed_workspace(Path(id): Path<String>) -> impl IntoResponse {
    match manager::set_status(&id, "active").await {
        Ok(workspace) => (StatusCode::OK, Json(workspace)).into_response(),
        Err(error) => managed_error(error, "restore_managed_workspace"),
    }
}

#[utoipa::path(
    delete,
    path = "/api/v1/workspaces/managed/{id}",
    tag = "ManagedWorkspaces",
    params(
        ("id" = String, Path, description = "Workspace ID"),
        ("force" = Option<bool>, Query, description = "Stop active agents before deletion")
    ),
    responses(
        (status = 204, description = "Managed workspace deleted"),
        (status = 404, description = "Workspace not found", body = crate::api::ApiError),
        (status = 409, description = "Workspace has active runtime resources", body = crate::api::ApiError),
        (status = 500, description = "Internal server error", body = crate::api::ApiError),
        (status = 400, description = "Invalid request parameters", body = crate::api::ApiError),)
)]
pub async fn delete_managed_workspace(
    Path(id): Path<String>,
    JsonQuery(query): JsonQuery<DeleteManagedWorkspaceQuery>,
) -> impl IntoResponse {
    match manager::delete(&id, query.force).await {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(error) => managed_error(error, "delete_managed_workspace"),
    }
}

// ── Project Management APIs ──

#[utoipa::path(
    get,
    path = "/api/v1/workspaces/managed/{id}/projects",
    tag = "ManagedWorkspaces",
    params(("id" = String, Path, description = "Workspace ID")),
    responses(
        (status = 200, description = "List workspace projects", body = Vec<manager::Project>),
        (status = 404, description = "Workspace not found", body = crate::api::ApiError),
        (status = 500, description = "Internal server error", body = crate::api::ApiError),
    )
)]
pub async fn list_managed_workspace_projects(Path(id): Path<String>) -> impl IntoResponse {
    match manager::list_projects(&id) {
        Ok(projects) => (StatusCode::OK, Json(projects)).into_response(),
        Err(error) => managed_error(error, "list_managed_workspace_projects"),
    }
}

#[utoipa::path(
    post,
    path = "/api/v1/workspaces/managed/{id}/projects",
    tag = "ManagedWorkspaces",
    params(("id" = String, Path, description = "Workspace ID")),
    request_body = manager::RegisterWorkspaceProjectRequest,
    responses(
        (status = 201, description = "Project registered", body = manager::Project),
        (status = 400, description = "Invalid request", body = crate::api::ApiError),
        (status = 404, description = "Workspace not found", body = crate::api::ApiError),
        (status = 500, description = "Internal server error", body = crate::api::ApiError),
    )
)]
pub async fn register_managed_workspace_project(
    Path(id): Path<String>,
    Json(request): Json<manager::RegisterWorkspaceProjectRequest>,
) -> impl IntoResponse {
    match manager::register_project(&id, request) {
        Ok(project) => (StatusCode::CREATED, Json(project)).into_response(),
        Err(error) => managed_error(error, "register_managed_workspace_project"),
    }
}

#[utoipa::path(
    patch,
    path = "/api/v1/workspaces/managed/{id}/projects/{project_id}",
    tag = "ManagedWorkspaces",
    params(
        ("id" = String, Path, description = "Workspace ID"),
        ("project_id" = String, Path, description = "Project ID"),
    ),
    request_body = manager::UpdateWorkspaceProjectRequest,
    responses(
        (status = 200, description = "Project updated", body = manager::Project),
        (status = 400, description = "Invalid request", body = crate::api::ApiError),
        (status = 404, description = "Workspace or project not found", body = crate::api::ApiError),
        (status = 500, description = "Internal server error", body = crate::api::ApiError),
    )
)]
pub async fn update_managed_workspace_project(
    Path((id, project_id)): Path<(String, String)>,
    Json(request): Json<manager::UpdateWorkspaceProjectRequest>,
) -> impl IntoResponse {
    match manager::update_project(&id, &project_id, request) {
        Ok(project) => (StatusCode::OK, Json(project)).into_response(),
        Err(error) => managed_error(error, "update_managed_workspace_project"),
    }
}

#[utoipa::path(
    delete,
    path = "/api/v1/workspaces/managed/{id}/projects/{project_id}",
    tag = "ManagedWorkspaces",
    params(
        ("id" = String, Path, description = "Workspace ID"),
        ("project_id" = String, Path, description = "Project ID"),
    ),
    responses(
        (status = 204, description = "Project removed"),
        (status = 404, description = "Workspace or project not found", body = crate::api::ApiError),
        (status = 500, description = "Internal server error", body = crate::api::ApiError),
    )
)]
pub async fn remove_managed_workspace_project(
    Path((id, project_id)): Path<(String, String)>,
) -> impl IntoResponse {
    match manager::remove_project(&id, &project_id) {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(error) => managed_error(error, "remove_managed_workspace_project"),
    }
}

#[utoipa::path(
    get,
    path = "/api/v1/workspaces/managed/{id}/status",
    tag = "ManagedWorkspaces",
    params(("id" = String, Path, description = "Workspace ID")),
    responses(
        (status = 200, description = "Workspace status", body = manager::WorkspaceStatus),
        (status = 404, description = "Workspace not found", body = crate::api::ApiError),
        (status = 500, description = "Internal server error", body = crate::api::ApiError),
    )
)]
pub async fn managed_workspace_status(Path(id): Path<String>) -> impl IntoResponse {
    match manager::status(&id).await {
        Ok(status) => (StatusCode::OK, Json(status)).into_response(),
        Err(error) => managed_error(error, "managed_workspace_status"),
    }
}
