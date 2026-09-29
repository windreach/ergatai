use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    response::{
        sse::{Event, KeepAlive, Sse},
        IntoResponse, Response,
    },
    Json,
};
use futures::{stream, StreamExt};
use serde::{Deserialize, Serialize};
use std::convert::Infallible;
use utoipa::ToSchema;

use crate::{
    services::terminal_sessions::{self, TerminalSessionError},
    AppState,
};

pub use crate::services::terminal_sessions::{
    CreateTerminalSessionRequest, TerminalAuditAction, TerminalAuditEvent, TerminalAuditOutcome,
    TerminalInputRequest, TerminalProfile, TerminalResizeRequest, TerminalSession,
    TerminalSessionStatus, TerminalSignalRequest, TerminalTransport,
};

#[derive(Debug, Serialize, ToSchema)]
pub struct TerminalSessionResponse {
    pub session: TerminalSession,
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct TerminalSessionListQuery {
    pub workspace_id: String,
    #[serde(default = "default_list_user_id")]
    pub user_id: String,
}

fn default_list_user_id() -> String {
    "local".to_string()
}

#[derive(Debug, Serialize, ToSchema)]
pub struct TerminalSessionListResponse {
    pub sessions: Vec<TerminalSession>,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct TerminalAuditResponse {
    pub events: Vec<TerminalAuditEvent>,
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct TerminalStreamQuery {
    after: Option<u64>,
}

fn sse_event<T: Serialize>(value: &T) -> Event {
    Event::default().data(serde_json::to_string(value).unwrap_or_default())
}

fn response(error: TerminalSessionError, operation: &'static str) -> Response {
    let status = match error {
        TerminalSessionError::WorkspaceNotFound => StatusCode::NOT_FOUND,
        TerminalSessionError::Validation(_) => StatusCode::BAD_REQUEST,
        TerminalSessionError::Forbidden(_) => StatusCode::FORBIDDEN,
        TerminalSessionError::NotFound => StatusCode::NOT_FOUND,
        TerminalSessionError::ProcessFailed(_) => StatusCode::BAD_GATEWAY,
    };
    let process_failed = matches!(error, TerminalSessionError::ProcessFailed(_));
    let message = match error {
        TerminalSessionError::Validation(message)
        | TerminalSessionError::Forbidden(message)
        | TerminalSessionError::ProcessFailed(message) => message,
        TerminalSessionError::WorkspaceNotFound => "Workspace not found".to_string(),
        TerminalSessionError::NotFound => "Terminal session not found".to_string(),
    };
    if process_failed {
        tracing::error!(operation = %operation, error = %message, "Terminal session failed");
    }
    (status, Json(serde_json::json!({ "error": message }))).into_response()
}

#[utoipa::path(
    post,
    path = "/api/v1/terminal-sessions",
    tag = "Terminal Sessions",
    request_body = CreateTerminalSessionRequest,
    responses(
        (status = 201, description = "Terminal session created", body = TerminalSessionResponse),
        (status = 400, description = "Invalid request", body = crate::api::ApiError),
        (status = 403, description = "Workspace access denied", body = crate::api::ApiError),
        (status = 404, description = "Workspace not found", body = crate::api::ApiError),
    )
)]
pub async fn create_session(
    State(_state): State<AppState>,
    Json(request): Json<CreateTerminalSessionRequest>,
) -> Response {
    match terminal_sessions::create_session(request).await {
        Ok(session) => (
            StatusCode::CREATED,
            Json(TerminalSessionResponse { session }),
        )
            .into_response(),
        Err(error) => response(error, "create_terminal_session"),
    }
}

#[utoipa::path(
    get,
    path = "/api/v1/terminal-sessions",
    tag = "Terminal Sessions",
    params(("workspace_id" = String, Query, description = "Workspace identifier")),
    params(("user_id" = Option<String>, Query, description = "Requesting user identifier")),
    responses(
        (status = 200, description = "Terminal sessions and recovery metadata", body = TerminalSessionListResponse),
        (status = 400, description = "Invalid request", body = crate::api::ApiError),
        (status = 403, description = "Workspace access denied", body = crate::api::ApiError),
        (status = 404, description = "Workspace not found", body = crate::api::ApiError),
    )
)]
pub async fn list_sessions(Query(query): Query<TerminalSessionListQuery>) -> Response {
    match terminal_sessions::list_sessions(&query.workspace_id, &query.user_id).await {
        Ok(sessions) => (
            StatusCode::OK,
            Json(TerminalSessionListResponse { sessions }),
        )
            .into_response(),
        Err(error) => response(error, "list_terminal_sessions"),
    }
}

#[utoipa::path(
    get,
    path = "/api/v1/terminal-sessions/{id}",
    tag = "Terminal Sessions",
    params(("id" = String, Path, description = "Terminal session identifier")),
    responses(
        (status = 200, description = "Terminal session", body = TerminalSessionResponse),
        (status = 404, description = "Not found", body = crate::api::ApiError),
    )
)]
pub async fn get_session(Path(session_id): Path<String>) -> Response {
    match terminal_sessions::get_session(&session_id).await {
        Ok(session) => (StatusCode::OK, Json(TerminalSessionResponse { session })).into_response(),
        Err(error) => response(error, "get_terminal_session"),
    }
}

#[utoipa::path(
    post,
    path = "/api/v1/terminal-sessions/{id}/input",
    tag = "Terminal Sessions",
    request_body = TerminalInputRequest,
    params(("id" = String, Path, description = "Terminal session identifier")),
    responses(
        (status = 204, description = "Input accepted"),
        (status = 400, description = "Invalid request", body = crate::api::ApiError),
        (status = 404, description = "Not found", body = crate::api::ApiError),
    )
)]
pub async fn write_input(
    Path(session_id): Path<String>,
    Json(request): Json<TerminalInputRequest>,
) -> Response {
    match terminal_sessions::write_input(&session_id, request).await {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(error) => response(error, "write_terminal_input"),
    }
}

#[utoipa::path(
    post,
    path = "/api/v1/terminal-sessions/{id}/resize",
    tag = "Terminal Sessions",
    request_body = TerminalResizeRequest,
    params(("id" = String, Path, description = "Terminal session identifier")),
    responses(
        (status = 204, description = "Terminal resized"),
        (status = 400, description = "Invalid size or transport", body = crate::api::ApiError),
        (status = 404, description = "Terminal session not found", body = crate::api::ApiError),
    )
)]
pub async fn resize_session(
    Path(session_id): Path<String>,
    Json(request): Json<TerminalResizeRequest>,
) -> Response {
    match terminal_sessions::resize_session(&session_id, request).await {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(error) => response(error, "resize_terminal_session"),
    }
}

#[utoipa::path(
    post,
    path = "/api/v1/terminal-sessions/{id}/signal",
    tag = "Terminal Sessions",
    request_body = TerminalSignalRequest,
    params(("id" = String, Path, description = "Terminal session identifier")),
    responses(
        (status = 204, description = "Signal accepted"),
        (status = 400, description = "Invalid signal", body = crate::api::ApiError),
        (status = 404, description = "Not found", body = crate::api::ApiError),
    )
)]
pub async fn signal_session(
    Path(session_id): Path<String>,
    Json(request): Json<TerminalSignalRequest>,
) -> Response {
    match terminal_sessions::send_signal(&session_id, request).await {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(error) => response(error, "signal_terminal_session"),
    }
}

#[utoipa::path(
    post,
    path = "/api/v1/terminal-sessions/{id}/terminate",
    tag = "Terminal Sessions",
    params(("id" = String, Path, description = "Terminal session identifier")),
    responses(
        (status = 200, description = "Terminate requested", body = TerminalSessionResponse),
        (status = 404, description = "Not found", body = crate::api::ApiError),
    )
)]
pub async fn terminate_session(Path(session_id): Path<String>) -> Response {
    match terminal_sessions::terminate_session(&session_id).await {
        Ok(session) => (StatusCode::OK, Json(TerminalSessionResponse { session })).into_response(),
        Err(error) => response(error, "terminate_terminal_session"),
    }
}

#[utoipa::path(
    get,
    path = "/api/v1/terminal-sessions/{id}/stream",
    tag = "Terminal Sessions",
    params(
        ("id" = String, Path, description = "Terminal session identifier"),
        ("after" = Option<u64>, Query, description = "Last successfully received sequence"),
    ),
    responses((status = 200, description = "Terminal output stream"))
)]
pub async fn stream_session(
    Path(session_id): Path<String>,
    Query(query): Query<TerminalStreamQuery>,
) -> Response {
    let subscription = match terminal_sessions::subscribe(&session_id, query.after).await {
        Ok(result) => result,
        Err(error) => return response(error, "stream_terminal_session"),
    };

    let mut replay_events: Vec<serde_json::Value> = subscription
        .events
        .into_iter()
        .map(|event| serde_json::to_value(event).unwrap_or_default())
        .collect();
    if subscription.reset {
        replay_events.insert(0, serde_json::json!({ "type": "resync" }));
    };
    let replay = stream::iter(replay_events).map(|event| Ok::<_, Infallible>(sse_event(&event)));
    let live = stream::unfold(subscription.receiver, |mut receiver| async move {
        match receiver.recv().await {
            Ok(event) => Some((Ok::<_, Infallible>(sse_event(&event)), receiver)),
            Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => None,
            Err(tokio::sync::broadcast::error::RecvError::Closed) => None,
        }
    });

    Sse::new(Box::pin(replay.chain(live)))
        .keep_alive(KeepAlive::default())
        .into_response()
}

#[utoipa::path(
    get,
    path = "/api/v1/terminal-sessions/{id}/audit",
    tag = "Terminal Sessions",
    params(("id" = String, Path, description = "Terminal session identifier")),
    responses(
        (status = 200, description = "Terminal audit events", body = TerminalAuditResponse),
        (status = 404, description = "Terminal session not found", body = crate::api::ApiError),
    )
)]
pub async fn list_audit(Path(session_id): Path<String>) -> Response {
    match terminal_sessions::list_audit(&session_id).await {
        Ok(events) => (StatusCode::OK, Json(TerminalAuditResponse { events })).into_response(),
        Err(error) => response(error, "list_terminal_audit"),
    }
}
