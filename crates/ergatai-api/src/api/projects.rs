//! Projects API endpoints
//!
//! TODO: Projects have been removed from the database schema.
//! This file is temporarily stubbed out. The API endpoints will be
//! removed or migrated to work with the new schema in a future PR.

use axum::{
    extract::State,
    http::StatusCode,
    response::IntoResponse,
    Json,
};
use serde::Serialize;

use crate::AppState;

#[derive(Debug, Serialize)]
pub struct ErrorResponse {
    pub error: String,
}

/// GET /api/v1/projects
///
/// TODO: Projects API is temporarily unavailable.
#[utoipa::path(
    get,
    path = "/api/v1/projects",
    tag = "Projects",
    responses(
        (status = 501, description = "Projects API temporarily unavailable"),
    )
)]
pub async fn list_projects(State(_state): State<AppState>) -> impl IntoResponse {
    (
        StatusCode::NOT_IMPLEMENTED,
        Json(ErrorResponse {
            error: "Projects API is temporarily unavailable. The projects module has been removed from the database schema.".to_string(),
        }),
    )
        .into_response()
}

/// TODO: Projects API is temporarily unavailable.
#[utoipa::path(
    post,
    path = "/api/v1/projects",
    tag = "Projects",
    responses(
        (status = 501, description = "Projects API temporarily unavailable"),
    )
)]
pub async fn create_project(State(_state): State<AppState>) -> impl IntoResponse {
    (
        StatusCode::NOT_IMPLEMENTED,
        Json(ErrorResponse {
            error: "Projects API is temporarily unavailable.".to_string(),
        }),
    )
        .into_response()
}

/// TODO: Projects API is temporarily unavailable.
#[utoipa::path(
    get,
    path = "/api/v1/projects/{id}",
    tag = "Projects",
    responses(
        (status = 501, description = "Projects API temporarily unavailable"),
    )
)]
pub async fn get_project() -> impl IntoResponse {
    (
        StatusCode::NOT_IMPLEMENTED,
        Json(ErrorResponse {
            error: "Projects API is temporarily unavailable.".to_string(),
        }),
    )
        .into_response()
}

/// TODO: Projects API is temporarily unavailable.
#[utoipa::path(
    put,
    path = "/api/v1/projects/{id}",
    tag = "Projects",
    responses(
        (status = 501, description = "Projects API temporarily unavailable"),
    )
)]
pub async fn update_project() -> impl IntoResponse {
    (
        StatusCode::NOT_IMPLEMENTED,
        Json(ErrorResponse {
            error: "Projects API is temporarily unavailable.".to_string(),
        }),
    )
        .into_response()
}

/// TODO: Projects API is temporarily unavailable.
#[utoipa::path(
    delete,
    path = "/api/v1/projects/{id}",
    tag = "Projects",
    responses(
        (status = 501, description = "Projects API temporarily unavailable"),
    )
)]
pub async fn delete_project() -> impl IntoResponse {
    (
        StatusCode::NOT_IMPLEMENTED,
        Json(ErrorResponse {
            error: "Projects API is temporarily unavailable.".to_string(),
        }),
    )
        .into_response()
}
