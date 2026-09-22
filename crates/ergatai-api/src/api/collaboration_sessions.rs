//! HTTP handlers for authoritative collaboration sessions.

use axum::{
    extract::{Path, Query},
    http::StatusCode,
    response::{
        sse::{Event, KeepAlive, Sse},
        IntoResponse, Response,
    },
    Json,
};
use serde::Deserialize;
use std::convert::Infallible;

use crate::api::ApiError;
use crate::services::collaboration_session::{
    append_message, create_approval, create_plan_revision, create_session, decide_approval,
    find_session_by_chat, get_plan_revision, get_session, list_events, list_plan_revisions,
    transition_state, AppendSessionMessageRequest, ApprovalDecisionRequest,
    CollaborationSessionError, CreateApprovalRequest, CreateCollaborationSessionRequest,
    CreatePlanRevisionRequest, SessionStateTransitionRequest,
};
use crate::services::collaboration_session_dag::{
    activate_plan_revision, cancel_session_execution, submit_session_interaction,
    CollaborationSessionDagError,
};

#[derive(Debug, Deserialize)]
pub struct EventQuery {
    #[serde(default)]
    pub after: Option<i64>,
    #[serde(default)]
    pub limit: Option<usize>,
}

#[derive(Debug, Deserialize)]
pub struct StreamEventQuery {
    #[serde(default)]
    pub after_sequence: Option<i64>,
    #[serde(default)]
    pub poll_interval_ms: Option<u64>,
}

fn response_from_dag_error(
    error: CollaborationSessionDagError,
    operation: &'static str,
) -> Response {
    match error {
        CollaborationSessionDagError::Session(session_error) => {
            response_from_error(session_error, operation)
        }
        CollaborationSessionDagError::Conflict(message) => {
            (StatusCode::CONFLICT, Json(ApiError { error: message })).into_response()
        }
        CollaborationSessionDagError::Validation(message) => {
            (StatusCode::BAD_REQUEST, Json(ApiError { error: message })).into_response()
        }
        CollaborationSessionDagError::Execution(message) => {
            tracing::error!(operation, error = %message, "Collaboration DAG execution failed");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ApiError { error: message }),
            )
                .into_response()
        }
    }
}

fn response_from_error(error: CollaborationSessionError, operation: &'static str) -> Response {
    let status = match &error {
        CollaborationSessionError::NotFound(_) => StatusCode::NOT_FOUND,
        CollaborationSessionError::Validation(_)
        | CollaborationSessionError::Serialization(_)
        | CollaborationSessionError::InvalidTransition { .. } => StatusCode::BAD_REQUEST,
        CollaborationSessionError::Database(_) => StatusCode::INTERNAL_SERVER_ERROR,
    };
    if matches!(error, CollaborationSessionError::Database(_)) {
        tracing::error!(operation, error = %error, "Collaboration session operation failed");
    }
    (
        status,
        Json(ApiError {
            error: error.to_string(),
        }),
    )
        .into_response()
}

/// POST /api/v1/collaboration/sessions
#[utoipa::path(
    post,
    path = "/api/v1/collaboration/sessions",
    tag = "Collaboration Sessions",
    request_body = CreateCollaborationSessionRequest,
    responses(
        (status = 201, description = "Collaboration session created or returned", body = crate::services::collaboration_session::CollaborationSessionDetail),
        (status = 400, description = "Invalid request", body = crate::api::ApiError),
        (status = 500, description = "Internal server error", body = crate::api::ApiError),
    )
)]
pub async fn create_collaboration_session(
    Json(request): Json<CreateCollaborationSessionRequest>,
) -> Response {
    match tokio::task::spawn_blocking(move || create_session(request)).await {
        Ok(Ok(detail)) => (StatusCode::CREATED, Json(detail)).into_response(),
        Ok(Err(error)) => response_from_error(error, "create collaboration session"),
        Err(error) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ApiError {
                error: format!("Task join error: {error}"),
            }),
        )
            .into_response(),
    }
}

/// GET /api/v1/collaboration/sessions/by-chat/:chat_id
#[utoipa::path(
    get,
    path = "/api/v1/collaboration/sessions/by-chat/{chat_id}",
    tag = "Collaboration Sessions",
    params(("chat_id" = String, Path, description = "Chat identifier")),
    responses(
        (status = 200, description = "Collaboration session", body = crate::services::collaboration_session::CollaborationSession),
        (status = 404, description = "Session not found", body = crate::api::ApiError),
    )
)]
pub async fn get_collaboration_session_by_chat(Path(chat_id): Path<String>) -> Response {
    match tokio::task::spawn_blocking(move || find_session_by_chat(&chat_id)).await {
        Ok(Ok(Some(session))) => (StatusCode::OK, Json(session)).into_response(),
        Ok(Ok(None)) => (
            StatusCode::NOT_FOUND,
            Json(ApiError {
                error: "Collaboration session not found".to_string(),
            }),
        )
            .into_response(),
        Ok(Err(error)) => response_from_error(error, "find collaboration session by chat"),
        Err(error) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ApiError {
                error: format!("Task join error: {error}"),
            }),
        )
            .into_response(),
    }
}

/// GET /api/v1/collaboration/sessions/:id
#[utoipa::path(
    get,
    path = "/api/v1/collaboration/sessions/{id}",
    tag = "Collaboration Sessions",
    params(("id" = String, Path, description = "Collaboration session identifier")),
    responses(
        (status = 200, description = "Collaboration session detail", body = crate::services::collaboration_session::CollaborationSessionDetail),
        (status = 404, description = "Session not found", body = crate::api::ApiError),
    )
)]
pub async fn get_collaboration_session(Path(session_id): Path<String>) -> Response {
    match tokio::task::spawn_blocking(move || get_session(&session_id)).await {
        Ok(Ok(detail)) => (StatusCode::OK, Json(detail)).into_response(),
        Ok(Err(error)) => response_from_error(error, "get collaboration session"),
        Err(error) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ApiError {
                error: format!("Task join error: {error}"),
            }),
        )
            .into_response(),
    }
}

/// POST /api/v1/collaboration/sessions/:id/messages
#[utoipa::path(
    post,
    path = "/api/v1/collaboration/sessions/{id}/messages",
    tag = "Collaboration Sessions",
    request_body = AppendSessionMessageRequest,
    params(("id" = String, Path, description = "Collaboration session identifier")),
    responses(
        (status = 201, description = "Session message appended", body = crate::services::collaboration_session::CollaborationSessionDetail),
        (status = 400, description = "Invalid request", body = crate::api::ApiError),
        (status = 404, description = "Session not found", body = crate::api::ApiError),
    )
)]
pub async fn append_collaboration_session_message(
    Path(session_id): Path<String>,
    Json(request): Json<AppendSessionMessageRequest>,
) -> Response {
    match tokio::task::spawn_blocking(move || append_message(&session_id, request)).await {
        Ok(Ok(detail)) => (StatusCode::CREATED, Json(detail)).into_response(),
        Ok(Err(error)) => response_from_error(error, "append collaboration session message"),
        Err(error) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ApiError {
                error: format!("Task join error: {error}"),
            }),
        )
            .into_response(),
    }
}

/// POST /api/v1/collaboration/sessions/:id/interactions
#[utoipa::path(
    post,
    path = "/api/v1/collaboration/sessions/{id}/interactions",
    tag = "Collaboration Sessions",
    request_body = crate::services::collaboration_planner::SubmitSessionInteractionRequest,
    params(("id" = String, Path, description = "Collaboration session identifier")),
    responses(
        (status = 201, description = "Interaction routed; a collaboration plan may also be activated", body = crate::services::collaboration_session_dag::SessionInteractionSubmitted),
        (status = 400, description = "Invalid interaction or plan", body = crate::api::ApiError),
        (status = 404, description = "Session not found", body = crate::api::ApiError),
        (status = 409, description = "A session DAG is already running", body = crate::api::ApiError),
    )
)]
pub async fn submit_collaboration_session_interaction(
    Path(session_id): Path<String>,
    Json(request): Json<crate::services::collaboration_planner::SubmitSessionInteractionRequest>,
) -> Response {
    match submit_session_interaction(&session_id, request).await {
        Ok(result) => (StatusCode::CREATED, Json(result)).into_response(),
        Err(error) => response_from_dag_error(error, "submit collaboration session interaction"),
    }
}

/// POST /api/v1/collaboration/sessions/:id/state
#[utoipa::path(
    post,
    path = "/api/v1/collaboration/sessions/{id}/state",
    tag = "Collaboration Sessions",
    request_body = SessionStateTransitionRequest,
    params(("id" = String, Path, description = "Collaboration session identifier")),
    responses(
        (status = 200, description = "Session state changed", body = crate::services::collaboration_session::CollaborationSessionDetail),
        (status = 400, description = "Invalid transition", body = crate::api::ApiError),
        (status = 404, description = "Session not found", body = crate::api::ApiError),
    )
)]
pub async fn transition_collaboration_session_state(
    Path(session_id): Path<String>,
    Json(request): Json<SessionStateTransitionRequest>,
) -> Response {
    match tokio::task::spawn_blocking(move || transition_state(&session_id, request)).await {
        Ok(Ok(detail)) => (StatusCode::OK, Json(detail)).into_response(),
        Ok(Err(error)) => response_from_error(error, "transition collaboration session state"),
        Err(error) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ApiError {
                error: format!("Task join error: {error}"),
            }),
        )
            .into_response(),
    }
}

/// GET /api/v1/collaboration/sessions/:id/events
#[utoipa::path(
    get,
    path = "/api/v1/collaboration/sessions/{id}/events",
    tag = "Collaboration Sessions",
    params(
        ("id" = String, Path, description = "Collaboration session identifier"),
        ("after" = Option<i64>, Query, description = "Return events after this sequence"),
        ("limit" = Option<usize>, Query, description = "Maximum events to return"),
    ),
    responses(
        (status = 200, description = "Shared context events", body = Vec<crate::services::collaboration_session::CollaborationContextEvent>),
        (status = 404, description = "Session not found", body = crate::api::ApiError),
    )
)]
pub async fn list_collaboration_session_events(
    Path(session_id): Path<String>,
    Query(query): Query<EventQuery>,
) -> Response {
    match tokio::task::spawn_blocking(move || {
        // Clamp limit to reasonable maximum to prevent memory exhaustion from malicious clients
        let limit = query.limit.unwrap_or(100).min(1000);
        list_events(&session_id, query.after, limit)
    })
    .await
    {
        Ok(Ok(events)) => (StatusCode::OK, Json(events)).into_response(),
        Ok(Err(error)) => response_from_error(error, "list collaboration session events"),
        Err(error) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ApiError {
                error: format!("Task join error: {error}"),
            }),
        )
            .into_response(),
    }
}

/// GET /api/v1/collaboration/sessions/:session_id/stream
#[utoipa::path(
    get,
    path = "/api/v1/collaboration/sessions/{session_id}/stream",
    tag = "Collaboration Sessions",
    params(
        ("session_id" = String, Path, description = "Collaboration session identifier"),
        ("after_sequence" = Option<i64>, Query, description = "Replay events after this sequence"),
        ("poll_interval_ms" = Option<u64>, Query, description = "Live poll interval in milliseconds"),
    ),
    responses(
        (status = 200, description = "Server-sent shared context event stream"),
        (status = 404, description = "Session not found", body = crate::api::ApiError),
    )
)]
pub async fn stream_collaboration_session_events(
    Path(session_id): Path<String>,
    Query(query): Query<StreamEventQuery>,
) -> Response {
    let after_sequence = query.after_sequence.unwrap_or(0).max(0);
    let replay_session_id = session_id.clone();
    let replay = match tokio::task::spawn_blocking(move || {
        list_events(&replay_session_id, Some(after_sequence), 500)
    })
    .await
    {
        Ok(Ok(events)) => events,
        Ok(Err(error)) => return response_from_error(error, "replay collaboration session events"),
        Err(error) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ApiError {
                    error: format!("Task join error: {error}"),
                }),
            )
                .into_response()
        }
    };

    let poll_interval_ms = query.poll_interval_ms.unwrap_or(250).clamp(50, 5_000);
    let (sender, receiver) = tokio::sync::mpsc::channel::<Result<Event, Infallible>>(256);
    tokio::spawn(async move {
        let mut last_sequence = after_sequence;
        for event in replay {
            last_sequence = last_sequence.max(event.sequence);
            let json = match serde_json::to_string(&event) {
                Ok(json) => json,
                Err(error) => {
                    tracing::error!(error = %error, "Failed to serialize collaboration event");
                    continue;
                }
            };
            let sse_event = Event::default()
                .event(event.event_type.clone())
                .id(event.sequence.to_string())
                .data(json);
            if sender.send(Ok(sse_event)).await.is_err() {
                return;
            }
        }

        let mut interval =
            tokio::time::interval(std::time::Duration::from_millis(poll_interval_ms));
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            interval.tick().await;
            let session_id = session_id.clone();
            let events = match tokio::task::spawn_blocking(move || {
                list_events(&session_id, Some(last_sequence), 500)
            })
            .await
            {
                Ok(Ok(events)) => events,
                Ok(Err(error)) => {
                    tracing::warn!(
                        error = %error,
                        "Failed to poll collaboration session events"
                    );
                    continue;
                }
                Err(error) => {
                    tracing::warn!(error = %error, "Collaboration event poll task failed");
                    return;
                }
            };

            for event in events {
                last_sequence = last_sequence.max(event.sequence);
                let json = match serde_json::to_string(&event) {
                    Ok(json) => json,
                    Err(error) => {
                        tracing::error!(error = %error, "Failed to serialize collaboration event");
                        continue;
                    }
                };
                let sse_event = Event::default()
                    .event(event.event_type.clone())
                    .id(event.sequence.to_string())
                    .data(json);
                if sender.send(Ok(sse_event)).await.is_err() {
                    return;
                }
            }
        }
    });

    let live = futures::stream::unfold(receiver, |mut receiver| async move {
        receiver.recv().await.map(|event| (event, receiver))
    });
    Sse::new(live)
        .keep_alive(KeepAlive::default())
        .into_response()
}

/// POST /api/v1/collaboration/sessions/:id/plans
#[utoipa::path(
    post,
    path = "/api/v1/collaboration/sessions/{id}/plans",
    tag = "Collaboration Sessions",
    request_body = CreatePlanRevisionRequest,
    params(("id" = String, Path, description = "Collaboration session identifier")),
    responses(
        (status = 201, description = "Plan revision created", body = crate::services::collaboration_session::PlanRevisionCreated),
        (status = 400, description = "Invalid request", body = crate::api::ApiError),
        (status = 404, description = "Session not found", body = crate::api::ApiError),
    )
)]
pub async fn create_collaboration_session_plan(
    Path(session_id): Path<String>,
    Json(request): Json<CreatePlanRevisionRequest>,
) -> Response {
    match tokio::task::spawn_blocking(move || create_plan_revision(&session_id, request)).await {
        Ok(Ok(result)) => (StatusCode::CREATED, Json(result)).into_response(),
        Ok(Err(error)) => response_from_error(error, "create collaboration plan revision"),
        Err(error) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ApiError {
                error: format!("Task join error: {error}"),
            }),
        )
            .into_response(),
    }
}

/// GET /api/v1/collaboration/sessions/:id/plans
#[utoipa::path(
    get,
    path = "/api/v1/collaboration/sessions/{id}/plans",
    tag = "Collaboration Sessions",
    params(("id" = String, Path, description = "Collaboration session identifier")),
    responses(
        (status = 200, description = "Plan revisions", body = Vec<crate::services::collaboration_session::CollaborationPlanRevision>),
        (status = 404, description = "Session not found", body = crate::api::ApiError),
    )
)]
pub async fn list_collaboration_session_plans(Path(session_id): Path<String>) -> Response {
    match tokio::task::spawn_blocking(move || list_plan_revisions(&session_id)).await {
        Ok(Ok(revisions)) => (StatusCode::OK, Json(revisions)).into_response(),
        Ok(Err(error)) => response_from_error(error, "list collaboration plan revisions"),
        Err(error) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ApiError {
                error: format!("Task join error: {error}"),
            }),
        )
            .into_response(),
    }
}

/// GET /api/v1/collaboration/sessions/:session_id/plans/:plan_revision_id
#[utoipa::path(
    get,
    path = "/api/v1/collaboration/sessions/{session_id}/plans/{plan_revision_id}",
    tag = "Collaboration Sessions",
    params(
        ("session_id" = String, Path, description = "Collaboration session identifier"),
        ("plan_revision_id" = String, Path, description = "Plan revision identifier"),
    ),
    responses(
        (status = 200, description = "Plan revision", body = crate::services::collaboration_session::CollaborationPlanRevision),
        (status = 404, description = "Plan revision not found", body = crate::api::ApiError),
    )
)]
pub async fn get_collaboration_session_plan(
    Path((session_id, plan_revision_id)): Path<(String, String)>,
) -> Response {
    match tokio::task::spawn_blocking(move || get_plan_revision(&session_id, &plan_revision_id))
        .await
    {
        Ok(Ok(revision)) => (StatusCode::OK, Json(revision)).into_response(),
        Ok(Err(error)) => response_from_error(error, "get collaboration plan revision"),
        Err(error) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ApiError {
                error: format!("Task join error: {error}"),
            }),
        )
            .into_response(),
    }
}

/// POST /api/v1/collaboration/sessions/:session_id/plans/:plan_revision_id/execute
#[utoipa::path(
    post,
    path = "/api/v1/collaboration/sessions/{session_id}/plans/{plan_revision_id}/execute",
    tag = "Collaboration Sessions",
    params(
        ("session_id" = String, Path, description = "Collaboration session identifier"),
        ("plan_revision_id" = String, Path, description = "Active plan revision identifier"),
    ),
    responses(
        (status = 202, description = "Plan revision activated", body = crate::services::collaboration_session_dag::SessionPlanActivation),
        (status = 400, description = "Invalid plan or session state", body = crate::api::ApiError),
        (status = 404, description = "Session or plan revision not found", body = crate::api::ApiError),
        (status = 409, description = "A session DAG is already running", body = crate::api::ApiError),
    )
)]
pub async fn execute_collaboration_session_plan(
    Path((session_id, plan_revision_id)): Path<(String, String)>,
) -> Response {
    match activate_plan_revision(&session_id, &plan_revision_id).await {
        Ok(activation) => (StatusCode::ACCEPTED, Json(activation)).into_response(),
        Err(error) => response_from_dag_error(error, "execute collaboration plan revision"),
    }
}

/// POST /api/v1/collaboration/sessions/:id/approvals
#[utoipa::path(
    post,
    path = "/api/v1/collaboration/sessions/{id}/approvals",
    tag = "Collaboration Sessions",
    request_body = CreateApprovalRequest,
    params(("id" = String, Path, description = "Collaboration session identifier")),
    responses(
        (status = 201, description = "Approval requested", body = crate::services::collaboration_session::ApprovalDecisionResult),
        (status = 400, description = "Invalid request", body = crate::api::ApiError),
        (status = 404, description = "Session not found", body = crate::api::ApiError),
    )
)]
pub async fn create_collaboration_session_approval(
    Path(session_id): Path<String>,
    Json(request): Json<CreateApprovalRequest>,
) -> Response {
    match tokio::task::spawn_blocking(move || create_approval(&session_id, request)).await {
        Ok(Ok(result)) => (StatusCode::CREATED, Json(result)).into_response(),
        Ok(Err(error)) => response_from_error(error, "create collaboration approval"),
        Err(error) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ApiError {
                error: format!("Task join error: {error}"),
            }),
        )
            .into_response(),
    }
}

/// POST /api/v1/collaboration/sessions/:session_id/approvals/:approval_id/decision
#[utoipa::path(
    post,
    path = "/api/v1/collaboration/sessions/{session_id}/approvals/{approval_id}/decision",
    tag = "Collaboration Sessions",
    request_body = ApprovalDecisionRequest,
    params(
        ("session_id" = String, Path, description = "Collaboration session identifier"),
        ("approval_id" = String, Path, description = "Approval identifier"),
    ),
    responses(
        (status = 200, description = "Approval decided", body = crate::services::collaboration_session::ApprovalDecisionResult),
        (status = 400, description = "Invalid decision", body = crate::api::ApiError),
        (status = 404, description = "Approval not found", body = crate::api::ApiError),
    )
)]
pub async fn decide_collaboration_session_approval(
    Path((session_id, approval_id)): Path<(String, String)>,
    Json(request): Json<ApprovalDecisionRequest>,
) -> Response {
    match tokio::task::spawn_blocking(move || decide_approval(&session_id, &approval_id, request))
        .await
    {
        Ok(Ok(result)) => (StatusCode::OK, Json(result)).into_response(),
        Ok(Err(error)) => response_from_error(error, "decide collaboration approval"),
        Err(error) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ApiError {
                error: format!("Task join error: {error}"),
            }),
        )
            .into_response(),
    }
}

/// POST /api/v1/collaboration/sessions/:id/cancel
#[utoipa::path(
    post,
    path = "/api/v1/collaboration/sessions/{id}/cancel",
    tag = "Collaboration Sessions",
    params(("id" = String, Path, description = "Collaboration session identifier")),
    request_body = Option<String>,
    responses(
        (status = 200, description = "Session cancelled", body = crate::services::collaboration_session::CollaborationSessionDetail),
        (status = 400, description = "Invalid cancellation", body = crate::api::ApiError),
        (status = 404, description = "Session not found", body = crate::api::ApiError),
    )
)]
pub async fn cancel_collaboration_session(
    Path(session_id): Path<String>,
    reason: Option<Json<String>>,
) -> Response {
    let reason = reason.map(|Json(reason)| reason);
    match cancel_session_execution(&session_id, reason).await {
        Ok(detail) => (StatusCode::OK, Json(detail)).into_response(),
        Err(error) => response_from_dag_error(error, "cancel collaboration session"),
    }
}
