use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::IntoResponse,
    response::Response,
    Json,
};
use ergatai_runtime::{ResourceLimits, WorkspaceSpec};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use utoipa::ToSchema;

use crate::{
    services::{agent_service, workspace_manager as manager},
    AppState,
};

#[derive(Debug, Deserialize, ToSchema)]
pub struct CreateWorkspaceRequest {
    pub id: String,
    pub work_dir: Option<String>,
    pub env: Option<HashMap<String, String>>,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct WorkspaceResponse {
    pub id: String,
    pub backend: String,
    pub metadata: HashMap<String, String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub capture_thoughts: Option<bool>,
}

#[derive(Debug, Serialize)]
pub struct ErrorResponse {
    pub error: String,
}

fn managed_error(error: manager::WorkspaceManagerError, context: &'static str) -> Response {
    let (status, message) = match error {
        manager::WorkspaceManagerError::Validation(message) => (StatusCode::BAD_REQUEST, message),
        manager::WorkspaceManagerError::NotFound(message) => (StatusCode::NOT_FOUND, message),
        manager::WorkspaceManagerError::Conflict(message) => (StatusCode::CONFLICT, message),
        manager::WorkspaceManagerError::Internal(error) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            crate::sanitize_error(&error, context),
        ),
    };
    (status, Json(ErrorResponse { error: message })).into_response()
}

#[utoipa::path(
        get,
        path = "/api/v1/workspaces",
        tag = "Workspaces",
        responses(
            (status = 200, description = "List workspaces", body = Vec<WorkspaceResponse>),
            (status = 500, description = "Internal server error", body = crate::api::ApiError),
        )
    )]
pub async fn list_workspaces(State(_state): State<AppState>) -> impl IntoResponse {
    let runtime = crate::context::get_app_context().agent_runtime.clone();
    match runtime.backend().list_workspaces().await {
        Ok(workspaces) => {
            let response: Vec<WorkspaceResponse> =
                futures::future::join_all(workspaces.into_iter().map(|w| async move {
                    let capture_thoughts = agent_service::get_workspace_capture_thoughts(&w.id)
                        .await
                        .ok()
                        .flatten();
                    WorkspaceResponse {
                        id: w.id,
                        backend: w.backend,
                        metadata: w.metadata,
                        capture_thoughts,
                    }
                }))
                .await;
            (StatusCode::OK, Json(response)).into_response()
        }
        // SECURITY (P1 #18): Redact internal error details (may contain
        // filesystem paths, DB connection info, backend names).
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse {
                error: crate::sanitize_error(&e, "list_workspaces"),
            }),
        )
            .into_response(),
    }
}

#[utoipa::path(
    post,
    path = "/api/v1/workspaces",
    tag = "Workspaces",
    request_body = CreateWorkspaceRequest,
    responses(
        (status = 201, description = "Workspace created", body = WorkspaceResponse),
        (status = 400, description = "Invalid workspace", body = crate::api::ApiError),
        (status = 503, description = "Workspace limit reached", body = crate::api::ApiError),
        (status = 500, description = "Internal server error", body = crate::api::ApiError),
    )
)]
pub async fn create_workspace(
    State(state): State<AppState>,
    Json(req): Json<CreateWorkspaceRequest>,
) -> impl IntoResponse {
    let runtime = crate::context::get_app_context().agent_runtime.clone();

    // Validate workspace ID is non-empty and contains only safe characters
    // (alphanumeric, `-`, `_`, `.`). Rejects path separators, `..`, and
    // control characters to prevent path-traversal / filesystem injection.
    if !crate::api::agents::is_valid_workspace_id(&req.id) {
        return (
            StatusCode::BAD_REQUEST,
            Json(ErrorResponse {
                error: "Workspace ID must contain only alphanumeric characters, hyphens, underscores, or dots".to_string(),
            }),
        )
            .into_response();
    }

    // SECURITY (P1 #15): Enforce a workspace cap to prevent a runaway client
    // from exhausting host resources (memory, file descriptors, NATS subjects).
    // Default: 100 workspaces. Override with ERGATAI_MAX_WORKSPACES.
    let max_workspaces: usize = std::env::var("ERGATAI_MAX_WORKSPACES")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(100);
    match runtime.backend().list_workspaces().await {
        Ok(list) if list.len() >= max_workspaces => {
            return (
                StatusCode::SERVICE_UNAVAILABLE,
                Json(ErrorResponse {
                    error: format!(
                        "Workspace limit reached ({}/{}). Delete a workspace or raise ERGATAI_MAX_WORKSPACES.",
                        list.len(),
                        max_workspaces
                    ),
                }),
            )
                .into_response();
        }
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ErrorResponse {
                    error: crate::sanitize_error(&e, "list_workspaces_for_cap_check"),
                }),
            )
                .into_response();
        }
        _ => {}
    }

    let env = req.env.unwrap_or_default();

    // SECURITY (P1 #13): validate and canonicalize the work_dir.
    // Falls back to the server's default_cwd (already validated at startup)
    // when the client omits it.
    let raw_work_dir = req.work_dir.unwrap_or_else(|| state.default_cwd.clone());

    // Validate work_dir is non-empty
    if raw_work_dir.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(ErrorResponse {
                error: "Work directory cannot be empty".to_string(),
            }),
        )
            .into_response();
    }

    let work_dir = match crate::validate_cwd(&raw_work_dir) {
        Ok(p) => p,
        Err(msg) => {
            return (StatusCode::BAD_REQUEST, Json(ErrorResponse { error: msg })).into_response();
        }
    };

    let spec = WorkspaceSpec {
        id: req.id,
        work_dir,
        env,
        resources: ResourceLimits::default(),
        capture_thoughts: false,
    };

    match runtime.backend().create_workspace(spec).await {
        Ok(handle) => {
            let capture_thoughts = agent_service::get_workspace_capture_thoughts(&handle.id)
                .await
                .ok()
                .flatten();
            let response = WorkspaceResponse {
                id: handle.id,
                backend: handle.backend,
                metadata: handle.metadata,
                capture_thoughts,
            };
            (StatusCode::CREATED, Json(response)).into_response()
        }
        // SECURITY (P1 #18): Redact internal error details (may contain
        // work_dir paths, backend state, OS error info).
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse {
                error: crate::sanitize_error(&e, "create_workspace"),
            }),
        )
            .into_response(),
    }
}

#[utoipa::path(
    delete,
    path = "/api/v1/workspaces/{id}",
    tag = "Workspaces",
    params(("id" = String, Path, description = "Workspace ID")),
    responses(
        (status = 204, description = "Workspace deleted"),
        (status = 404, description = "Workspace not found", body = crate::api::ApiError),
        (status = 500, description = "Internal server error", body = crate::api::ApiError),
    )
)]
pub async fn delete_workspace(
    State(_state): State<AppState>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    let runtime = crate::context::get_app_context().agent_runtime.clone();

    // Find workspace by ID
    let workspaces = match runtime.backend().list_workspaces().await {
        Ok(w) => w,
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ErrorResponse {
                    error: crate::sanitize_error(&e, "list_workspaces_for_delete"),
                }),
            )
                .into_response()
        }
    };

    let workspace = match workspaces.into_iter().find(|w| w.id == id) {
        Some(w) => w,
        None => {
            return (
                StatusCode::NOT_FOUND,
                Json(ErrorResponse {
                    error: format!("Workspace {} not found", id),
                }),
            )
                .into_response()
        }
    };

    match runtime.backend().cleanup_workspace(&workspace).await {
        Ok(_) => StatusCode::NO_CONTENT.into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse {
                error: crate::sanitize_error(&e, "cleanup_workspace"),
            }),
        )
            .into_response(),
    }
}

// ── Persistent Workspace APIs ──

#[derive(Debug, Deserialize, Serialize, ToSchema)]
pub struct PersistentWorkspaceRequest {
    pub id: String,
    pub project_id: String,
    pub name: Option<String>,
    pub work_dir: String,
    pub env: Option<String>,
    pub resources: Option<String>,
    pub capture_thoughts: Option<bool>,
    pub collaboration_mode: Option<String>,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct PersistentWorkspaceResponse {
    pub id: String,
    pub project_id: String,
    pub name: Option<String>,
    pub work_dir: String,
    pub env: String,
    pub resources: String,
    pub capture_thoughts: bool,
    pub collaboration_mode: String,
    pub status: String,
    pub created_at: i64,
    pub updated_at: i64,
}

pub fn persistent_response(workspace: manager::ManagedWorkspace) -> PersistentWorkspaceResponse {
    PersistentWorkspaceResponse {
        id: workspace.id,
        project_id: workspace.project_id,
        name: workspace.name,
        work_dir: workspace.work_dir,
        env: workspace.env,
        resources: workspace.resources,
        capture_thoughts: workspace.capture_thoughts,
        collaboration_mode: workspace.collaboration_mode,
        status: workspace.status,
        created_at: workspace.created_at,
        updated_at: workspace.updated_at,
    }
}

#[derive(Debug, Deserialize)]
pub struct ListPersistentWorkspacesQuery {
    pub project_id: Option<String>,
    pub collaboration_mode: Option<String>,
}

#[utoipa::path(
    get,
    path = "/api/v1/workspaces/persistent",
    tag = "PersistentWorkspaces",
    params(
        ("project_id" = Option<String>, Query, description = "Filter by project ID"),
        ("collaboration_mode" = Option<String>, Query, description = "Filter by collaboration mode")
    ),
    responses(
        (status = 200, description = "List persistent workspaces", body = Vec<PersistentWorkspaceResponse>),
        (status = 500, description = "Internal server error", body = crate::api::ApiError),
    )
)]
pub async fn list_persistent_workspaces(
    axum::extract::Query(query): axum::extract::Query<ListPersistentWorkspacesQuery>,
) -> impl IntoResponse {
    match manager::list(
        query.project_id.as_deref(),
        query.collaboration_mode.as_deref(),
    )
    .await
    {
        Ok(ws_list) => (
            StatusCode::OK,
            Json(
                ws_list
                    .into_iter()
                    .map(persistent_response)
                    .collect::<Vec<_>>(),
            ),
        )
            .into_response(),
        Err(error) => managed_error(error, "list_persistent_workspaces"),
    }
}

#[utoipa::path(
    post,
    path = "/api/v1/workspaces/persistent",
    tag = "PersistentWorkspaces",
    request_body = PersistentWorkspaceRequest,
    responses(
        (status = 201, description = "Persistent workspace created", body = PersistentWorkspaceResponse),
        (status = 400, description = "Invalid workspace", body = crate::api::ApiError),
        (status = 500, description = "Internal server error", body = crate::api::ApiError),
    )
)]
pub async fn create_persistent_workspace(
    Json(req): Json<PersistentWorkspaceRequest>,
) -> impl IntoResponse {
    // Validate workspace ID contains only safe characters
    if !crate::api::agents::is_valid_workspace_id(&req.id) {
        return managed_error(
            manager::WorkspaceManagerError::Validation(
                "Workspace ID contains invalid characters".to_string(),
            ),
            "create_persistent_workspace",
        );
    }

    // Validate project_id is not empty/whitespace
    if req.project_id.trim().is_empty() {
        return managed_error(
            manager::WorkspaceManagerError::Validation("Project ID cannot be empty".to_string()),
            "create_persistent_workspace",
        );
    }

    // Validate work_dir is not empty/whitespace
    if req.work_dir.trim().is_empty() {
        return managed_error(
            manager::WorkspaceManagerError::Validation("Work directory cannot be empty".to_string()),
            "create_persistent_workspace",
        );
    }

    let env = req
        .env
        .as_deref()
        .map(serde_json::from_str::<HashMap<String, String>>);
    let env = match env {
        Some(Ok(env)) => Some(env),
        Some(Err(e)) => {
            return managed_error(
                manager::WorkspaceManagerError::Validation(e.to_string()),
                "create_persistent_workspace",
            )
        }
        None => None,
    };
    let resources = req
        .resources
        .as_deref()
        .map(serde_json::from_str::<serde_json::Value>);
    let resources = match resources {
        Some(Ok(resources)) => Some(resources),
        Some(Err(e)) => {
            return managed_error(
                manager::WorkspaceManagerError::Validation(e.to_string()),
                "create_persistent_workspace",
            )
        }
        None => None,
    };

    let request = manager::CreateManagedWorkspaceRequest {
        id: Some(req.id),
        name: req.name,
        work_dir: req.work_dir,
        project_id: Some(req.project_id),
        project_path: None,
        project_name: None,
        env,
        resources,
        capture_thoughts: req.capture_thoughts.unwrap_or(false),
        collaboration_mode: req.collaboration_mode,
    };
    match manager::create(request).await {
        Ok(workspace) => {
            (StatusCode::CREATED, Json(persistent_response(workspace))).into_response()
        }
        Err(error) => managed_error(error, "create_persistent_workspace"),
    }
}

#[utoipa::path(
    get,
    path = "/api/v1/workspaces/persistent/{id}",
    tag = "PersistentWorkspaces",
    params(("id" = String, Path, description = "Workspace ID")),
    responses(
        (status = 200, description = "Persistent workspace found", body = PersistentWorkspaceResponse),
        (status = 404, description = "Workspace not found", body = crate::api::ApiError),
        (status = 500, description = "Internal server error", body = crate::api::ApiError),
    )
)]
pub async fn get_persistent_workspace(Path(id): Path<String>) -> impl IntoResponse {
    match manager::get(&id).await {
        Ok(workspace) => (StatusCode::OK, Json(persistent_response(workspace))).into_response(),
        Err(error) => managed_error(error, "get_persistent_workspace"),
    }
}

#[utoipa::path(
    put,
    path = "/api/v1/workspaces/persistent/{id}",
    tag = "PersistentWorkspaces",
    params(("id" = String, Path, description = "Workspace ID")),
    request_body = PersistentWorkspaceRequest,
    responses(
        (status = 200, description = "Workspace updated", body = PersistentWorkspaceResponse),
        (status = 404, description = "Workspace not found", body = crate::api::ApiError),
        (status = 500, description = "Internal server error", body = crate::api::ApiError),
    )
)]
pub async fn update_persistent_workspace(
    Path(id): Path<String>,
    Json(req): Json<PersistentWorkspaceRequest>,
) -> impl IntoResponse {
    // Validate workspace ID contains only safe characters
    if !crate::api::agents::is_valid_workspace_id(&req.id) {
        return managed_error(
            manager::WorkspaceManagerError::Validation(
                "Workspace ID contains invalid characters".to_string(),
            ),
            "update_persistent_workspace",
        );
    }

    // Validate project_id is not empty/whitespace
    if req.project_id.trim().is_empty() {
        return managed_error(
            manager::WorkspaceManagerError::Validation("Project ID cannot be empty".to_string()),
            "update_persistent_workspace",
        );
    }

    // Validate work_dir is not empty/whitespace
    if req.work_dir.trim().is_empty() {
        return managed_error(
            manager::WorkspaceManagerError::Validation("Work directory cannot be empty".to_string()),
            "update_persistent_workspace",
        );
    }

    let env = req
        .env
        .as_deref()
        .map(serde_json::from_str::<HashMap<String, String>>);
    let env = match env {
        Some(Ok(env)) => Some(env),
        Some(Err(error)) => {
            return managed_error(
                manager::WorkspaceManagerError::Validation(error.to_string()),
                "update_persistent_workspace",
            )
        }
        None => None,
    };
    let resources = req
        .resources
        .as_deref()
        .map(serde_json::from_str::<serde_json::Value>);
    let resources = match resources {
        Some(Ok(resources)) => Some(resources),
        Some(Err(error)) => {
            return managed_error(
                manager::WorkspaceManagerError::Validation(error.to_string()),
                "update_persistent_workspace",
            )
        }
        None => None,
    };

    let request = manager::UpdateManagedWorkspaceRequest {
        name: req.name,
        work_dir: Some(req.work_dir),
        env,
        resources,
        capture_thoughts: req.capture_thoughts,
        status: None,
        default_project_id: Some(req.project_id),
    };
    match manager::update(&id, request).await {
        Ok(workspace) => (StatusCode::OK, Json(persistent_response(workspace))).into_response(),
        Err(error) => managed_error(error, "update_persistent_workspace"),
    }
}

#[utoipa::path(
    delete,
    path = "/api/v1/workspaces/persistent/{id}",
    tag = "PersistentWorkspaces",
    params(("id" = String, Path, description = "Workspace ID")),
    responses(
        (status = 204, description = "Workspace deleted"),
        (status = 404, description = "Workspace not found", body = crate::api::ApiError),
        (status = 500, description = "Internal server error", body = crate::api::ApiError),
    )
)]
pub async fn delete_persistent_workspace(Path(id): Path<String>) -> impl IntoResponse {
    match manager::delete(&id, false).await {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(error) => managed_error(error, "delete_persistent_workspace"),
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
    pub collaboration_mode: Option<String>,
}

#[utoipa::path(
    get,
    path = "/api/v1/workspaces/managed",
    tag = "ManagedWorkspaces",
    params(
        ("collaboration_mode" = Option<String>, Query, description = "Filter by collaboration mode")
    ),
    responses(
        (status = 200, description = "List managed workspaces", body = Vec<manager::ManagedWorkspace>),
        (status = 500, description = "Internal server error", body = crate::api::ApiError),
    )
)]
pub async fn list_managed_workspaces(
    axum::extract::Query(query): axum::extract::Query<ListManagedWorkspacesQuery>,
) -> impl IntoResponse {
    match manager::list(None, query.collaboration_mode.as_deref()).await {
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
    )
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
    )
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
    )
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
    )
)]
pub async fn delete_managed_workspace(
    Path(id): Path<String>,
    axum::extract::Query(query): axum::extract::Query<DeleteManagedWorkspaceQuery>,
) -> impl IntoResponse {
    match manager::delete(&id, query.force).await {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(error) => managed_error(error, "delete_managed_workspace"),
    }
}

#[utoipa::path(
    get,
    path = "/api/v1/workspaces/managed/{id}/projects",
    tag = "ManagedWorkspaces",
    params(("id" = String, Path, description = "Workspace ID")),
    responses(
        (status = 200, description = "Workspace projects", body = Vec<manager::ManagedWorkspaceProject>),
        (status = 404, description = "Workspace not found", body = crate::api::ApiError),
        (status = 500, description = "Internal server error", body = crate::api::ApiError),
    )
)]
pub async fn list_managed_workspace_projects(Path(id): Path<String>) -> impl IntoResponse {
    match manager::list_projects(&id).await {
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
        (status = 200, description = "Project registered", body = manager::ManagedWorkspace),
        (status = 400, description = "Invalid project", body = crate::api::ApiError),
        (status = 404, description = "Workspace or project not found", body = crate::api::ApiError),
        (status = 409, description = "Project already registered", body = crate::api::ApiError),
        (status = 500, description = "Internal server error", body = crate::api::ApiError),
    )
)]
pub async fn register_managed_workspace_project(
    Path(id): Path<String>,
    Json(request): Json<manager::RegisterWorkspaceProjectRequest>,
) -> impl IntoResponse {
    match manager::register_project(&id, request).await {
        Ok(workspace) => (StatusCode::OK, Json(workspace)).into_response(),
        Err(error) => managed_error(error, "register_managed_workspace_project"),
    }
}

#[utoipa::path(
    delete,
    path = "/api/v1/workspaces/managed/{id}/projects/{project_id}",
    tag = "ManagedWorkspaces",
    params(
        ("id" = String, Path, description = "Workspace ID"),
        ("project_id" = String, Path, description = "Project ID")
    ),
    responses(
        (status = 200, description = "Project registration removed", body = manager::ManagedWorkspace),
        (status = 404, description = "Workspace or project link not found", body = crate::api::ApiError),
        (status = 409, description = "Workspace must retain one project", body = crate::api::ApiError),
        (status = 500, description = "Internal server error", body = crate::api::ApiError),
    )
)]
pub async fn remove_managed_workspace_project(
    Path((id, project_id)): Path<(String, String)>,
) -> impl IntoResponse {
    match manager::remove_project(&id, &project_id).await {
        Ok(workspace) => (StatusCode::OK, Json(workspace)).into_response(),
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

// ── Tests ──

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    // ── CreateWorkspaceRequest deserialization ──

    #[test]
    fn test_create_workspace_request_id_only() {
        let req: CreateWorkspaceRequest = serde_json::from_value(json!({"id": "ws-1"})).unwrap();
        assert_eq!(req.id, "ws-1");
        assert!(req.work_dir.is_none());
        assert!(req.env.is_none());
    }

    #[test]
    fn test_create_workspace_request_all_fields() {
        let req: CreateWorkspaceRequest = serde_json::from_value(json!({
            "id": "ws-2",
            "work_dir": "/home/user/project",
            "env": {"LANG": "en_US.UTF-8"}
        }))
        .unwrap();
        assert_eq!(req.id, "ws-2");
        assert_eq!(req.work_dir.as_deref(), Some("/home/user/project"));
        let env = req.env.unwrap();
        assert_eq!(env.get("LANG").unwrap(), "en_US.UTF-8");
    }

    #[test]
    fn test_create_workspace_request_missing_id_fails() {
        let result: Result<CreateWorkspaceRequest, _> =
            serde_json::from_value(json!({"work_dir": "/tmp"}));
        assert!(result.is_err());
    }

    #[test]
    fn test_create_workspace_request_empty_id() {
        let req: CreateWorkspaceRequest = serde_json::from_value(json!({"id": ""})).unwrap();
        assert_eq!(req.id, "");
    }

    #[test]
    fn test_create_workspace_request_empty_env() {
        let req: CreateWorkspaceRequest =
            serde_json::from_value(json!({"id": "ws", "env": {}})).unwrap();
        assert_eq!(req.env.unwrap().len(), 0);
    }

    // ── WorkspaceResponse serialization ──

    #[test]
    fn test_workspace_response_serialization() {
        let mut metadata = HashMap::new();
        metadata.insert("key".to_string(), "value".to_string());
        let resp = WorkspaceResponse {
            id: "ws-1".to_string(),
            backend: "pty".to_string(),
            metadata,
            capture_thoughts: Some(true),
        };
        let json = serde_json::to_value(&resp).unwrap();
        assert_eq!(json["id"], "ws-1");
        assert_eq!(json["backend"], "pty");
        assert_eq!(json["metadata"]["key"], "value");
        assert_eq!(json["capture_thoughts"], true);
    }

    #[test]
    fn test_workspace_response_empty_metadata() {
        let resp = WorkspaceResponse {
            id: "ws-1".to_string(),
            backend: "pty".to_string(),
            metadata: HashMap::new(),
            capture_thoughts: None,
        };
        let json = serde_json::to_value(&resp).unwrap();
        assert!(json["metadata"].as_object().unwrap().is_empty());
    }

    // ── ErrorResponse serialization ──

    #[test]
    fn test_error_response_contains_message() {
        let resp = ErrorResponse {
            error: "Workspace ws-1 not found".to_string(),
        };
        let json = serde_json::to_value(&resp).unwrap();
        assert_eq!(json["error"], "Workspace ws-1 not found");
    }

    #[test]
    fn test_error_response_only_has_error_field() {
        let resp = ErrorResponse {
            error: "some error".to_string(),
        };
        let json = serde_json::to_value(&resp).unwrap();
        // Verify the shape is exactly {"error": "some error"}
        let obj = json.as_object().unwrap();
        assert_eq!(obj.len(), 1);
        assert!(obj.contains_key("error"));
    }
}
