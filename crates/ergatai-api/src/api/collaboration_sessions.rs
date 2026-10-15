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

use crate::services::collaboration_session::{
    create_approval, create_plan_revision, create_session, decide_approval, find_session_by_chat,
    get_plan_revision, get_session, list_events, list_plan_revisions, transition_state,
    ApprovalDecisionRequest, CollaborationSessionError, CreateApprovalRequest,
    CreateCollaborationSessionRequest, CreatePlanRevisionRequest, SessionStateTransitionRequest,
};
use crate::services::collaboration_session_dag::{
    activate_plan_revision, cancel_session_execution, CollaborationSessionDagError,
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
        CollaborationSessionDagError::Conflict(message) => (
            StatusCode::CONFLICT,
            Json(serde_json::json!({"error": message})),
        )
            .into_response(),
        CollaborationSessionDagError::Validation(message) => {
            crate::http_error::bad_request(message).into_response()
        }
        CollaborationSessionDagError::Execution(message) => {
            crate::http_error::internal(message, operation).into_response()
        }
    }
}

fn response_from_error(error: CollaborationSessionError, operation: &'static str) -> Response {
    match error {
        CollaborationSessionError::NotFound(ref id) => {
            crate::http_error::not_found("Collaboration session", id).into_response()
        }
        CollaborationSessionError::Validation(message) => {
            crate::http_error::bad_request(message).into_response()
        }
        CollaborationSessionError::Serialization(err) => {
            crate::http_error::bad_request(err.to_string()).into_response()
        }
        CollaborationSessionError::InvalidTransition { .. } => {
            crate::http_error::bad_request(error.to_string()).into_response()
        }
        CollaborationSessionError::Database(err) => {
            crate::http_error::internal(err, operation).into_response()
        }
    }
}

/// POST /api/v1/collaboration-sessions
#[utoipa::path(
    post,
    path = "/api/v1/collaboration-sessions",
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
        Err(error) => {
            crate::http_error::internal(format!("Task join error: {}", error), "spawn_blocking")
                .into_response()
        }
    }
}

/// GET /api/v1/collaboration-sessions/by-chat/:chat_id
#[utoipa::path(
    get,
    path = "/api/v1/collaboration-sessions/by-chat/{chat_id}",
    tag = "Collaboration Sessions",
    params(("chat_id" = String, Path, description = "Chat identifier")),
    responses(
        (status = 200, description = "Collaboration session", body = crate::services::collaboration_session::CollaborationSession),
        (status = 404, description = "Session not found", body = crate::api::ApiError),
    )
)]
pub async fn get_collaboration_session_by_chat(Path(chat_id): Path<String>) -> Response {
    let chat_id_for_closure = chat_id.clone();
    match tokio::task::spawn_blocking(move || find_session_by_chat(&chat_id_for_closure)).await {
        Ok(Ok(Some(session))) => (StatusCode::OK, Json(session)).into_response(),
        Ok(Ok(None)) => {
            crate::http_error::not_found("Collaboration session for chat", &chat_id).into_response()
        }
        Ok(Err(error)) => response_from_error(error, "find collaboration session by chat"),
        Err(error) => {
            crate::http_error::internal(format!("Task join error: {}", error), "spawn_blocking")
                .into_response()
        }
    }
}

/// GET /api/v1/collaboration-sessions/:id
#[utoipa::path(
    get,
    path = "/api/v1/collaboration-sessions/{id}",
    tag = "Collaboration Sessions",
    params(("id" = String, Path, description = "Collaboration session identifier")),
    responses(
        (status = 200, description = "Collaboration session detail", body = crate::services::collaboration_session::CollaborationSessionDetail),
        (status = 404, description = "Session not found", body = crate::api::ApiError),
    )
)]
pub async fn get_collaboration_session(Path(collaboration_session_id): Path<String>) -> Response {
    match tokio::task::spawn_blocking(move || get_session(&collaboration_session_id)).await {
        Ok(Ok(detail)) => (StatusCode::OK, Json(detail)).into_response(),
        Ok(Err(error)) => response_from_error(error, "get collaboration session"),
        Err(error) => {
            crate::http_error::internal(format!("Task join error: {}", error), "spawn_blocking")
                .into_response()
        }
    }
}

/// POST /api/v1/collaboration-sessions/:id/state
#[utoipa::path(
    post,
    path = "/api/v1/collaboration-sessions/{id}/state",
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
    Path(collaboration_session_id): Path<String>,
    Json(request): Json<SessionStateTransitionRequest>,
) -> Response {
    match tokio::task::spawn_blocking(move || transition_state(&collaboration_session_id, request))
        .await
    {
        Ok(Ok(detail)) => (StatusCode::OK, Json(detail)).into_response(),
        Ok(Err(error)) => response_from_error(error, "transition collaboration session state"),
        Err(error) => {
            crate::http_error::internal(format!("Task join error: {}", error), "spawn_blocking")
                .into_response()
        }
    }
}

/// GET /api/v1/collaboration-sessions/:id/events
#[utoipa::path(
    get,
    path = "/api/v1/collaboration-sessions/{id}/events",
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
    Path(collaboration_session_id): Path<String>,
    Query(query): Query<EventQuery>,
) -> Response {
    match tokio::task::spawn_blocking(move || {
        // Clamp limit to reasonable maximum to prevent memory exhaustion from malicious clients
        let limit = query.limit.unwrap_or(100).min(1000);
        list_events(&collaboration_session_id, query.after, limit)
    })
    .await
    {
        Ok(Ok(events)) => (StatusCode::OK, Json(events)).into_response(),
        Ok(Err(error)) => response_from_error(error, "list collaboration session events"),
        Err(error) => {
            crate::http_error::internal(format!("Task join error: {}", error), "spawn_blocking")
                .into_response()
        }
    }
}

/// GET /api/v1/collaboration-sessions/:session_id/stream
#[utoipa::path(
    get,
    path = "/api/v1/collaboration-sessions/{session_id}/stream",
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
    Path(collaboration_session_id): Path<String>,
    Query(query): Query<StreamEventQuery>,
) -> Response {
    // Validate session exists before starting the stream to prevent DoS via
    // unbounded polling on non-existent sessions.
    let validate_session_id = collaboration_session_id.clone();
    match tokio::task::spawn_blocking(move || get_session(&validate_session_id)).await {
        Ok(Ok(_)) => { /* session exists, proceed */ }
        Ok(Err(error)) => {
            return response_from_error(error, "validate collaboration session for stream")
        }
        Err(error) => {
            return crate::http_error::internal(
                format!("Task join error: {}", error),
                "spawn_blocking",
            )
            .into_response()
        }
    }

    let after_sequence = query.after_sequence.unwrap_or(0).max(0);
    let replay_session_id = collaboration_session_id.clone();
    let replay = match tokio::task::spawn_blocking(move || {
        list_events(&replay_session_id, Some(after_sequence), 500)
    })
    .await
    {
        Ok(Ok(events)) => events,
        Ok(Err(error)) => return response_from_error(error, "replay collaboration session events"),
        Err(error) => {
            return crate::http_error::internal(
                format!("Task join error: {}", error),
                "spawn_blocking",
            )
            .into_response()
        }
    };

    // Minimum 500ms poll interval to prevent excessive database load.
    // Lower values (e.g., 50ms) cause high CPU usage and DB contention under load.
    let poll_interval_ms = query.poll_interval_ms.unwrap_or(250).clamp(500, 5_000);
    let (sender, receiver) = tokio::sync::mpsc::channel::<Result<Event, Infallible>>(256);
    let stream_session_id = collaboration_session_id.clone();
    tokio::spawn(async move {
        // 30-minute maximum stream lifetime to prevent unbounded resource consumption.
        // Clients should reconnect to continue receiving events.
        let stream_deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(1800);

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
            // Check stream deadline before each poll
            if tokio::time::Instant::now() >= stream_deadline {
                tracing::debug!(
                    session_id = %stream_session_id,
                    "Collaboration SSE stream reached 30-minute timeout, closing"
                );
                return;
            }

            interval.tick().await;
            let session_id = stream_session_id.clone();
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

/// POST /api/v1/collaboration-sessions/:id/plans
#[utoipa::path(
    post,
    path = "/api/v1/collaboration-sessions/{id}/plans",
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
    Path(collaboration_session_id): Path<String>,
    Json(request): Json<CreatePlanRevisionRequest>,
) -> Response {
    match tokio::task::spawn_blocking(move || {
        create_plan_revision(&collaboration_session_id, request)
    })
    .await
    {
        Ok(Ok(result)) => (StatusCode::CREATED, Json(result)).into_response(),
        Ok(Err(error)) => response_from_error(error, "create collaboration plan revision"),
        Err(error) => {
            crate::http_error::internal(format!("Task join error: {}", error), "spawn_blocking")
                .into_response()
        }
    }
}

/// GET /api/v1/collaboration-sessions/:id/plans
#[utoipa::path(
    get,
    path = "/api/v1/collaboration-sessions/{id}/plans",
    tag = "Collaboration Sessions",
    params(("id" = String, Path, description = "Collaboration session identifier")),
    responses(
        (status = 200, description = "Plan revisions", body = Vec<crate::services::collaboration_session::CollaborationPlanRevision>),
        (status = 404, description = "Session not found", body = crate::api::ApiError),
    )
)]
pub async fn list_collaboration_session_plans(
    Path(collaboration_session_id): Path<String>,
) -> Response {
    match tokio::task::spawn_blocking(move || list_plan_revisions(&collaboration_session_id)).await
    {
        Ok(Ok(revisions)) => (StatusCode::OK, Json(revisions)).into_response(),
        Ok(Err(error)) => response_from_error(error, "list collaboration plan revisions"),
        Err(error) => {
            crate::http_error::internal(format!("Task join error: {}", error), "spawn_blocking")
                .into_response()
        }
    }
}

/// GET /api/v1/collaboration-sessions/:session_id/plans/:plan_revision_id
#[utoipa::path(
    get,
    path = "/api/v1/collaboration-sessions/{session_id}/plans/{plan_revision_id}",
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
    Path((collaboration_session_id, plan_revision_id)): Path<(String, String)>,
) -> Response {
    match tokio::task::spawn_blocking(move || {
        get_plan_revision(&collaboration_session_id, &plan_revision_id)
    })
    .await
    {
        Ok(Ok(revision)) => (StatusCode::OK, Json(revision)).into_response(),
        Ok(Err(error)) => response_from_error(error, "get collaboration plan revision"),
        Err(error) => {
            crate::http_error::internal(format!("Task join error: {}", error), "spawn_blocking")
                .into_response()
        }
    }
}

/// POST /api/v1/collaboration-sessions/:session_id/plans/:plan_revision_id/execute
#[utoipa::path(
    post,
    path = "/api/v1/collaboration-sessions/{session_id}/plans/{plan_revision_id}/execute",
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
    Path((collaboration_session_id, plan_revision_id)): Path<(String, String)>,
) -> Response {
    match activate_plan_revision(&collaboration_session_id, &plan_revision_id).await {
        Ok(activation) => (StatusCode::ACCEPTED, Json(activation)).into_response(),
        Err(error) => response_from_dag_error(error, "execute collaboration plan revision"),
    }
}

/// POST /api/v1/collaboration-sessions/:id/approvals
#[utoipa::path(
    post,
    path = "/api/v1/collaboration-sessions/{id}/approvals",
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
    Path(collaboration_session_id): Path<String>,
    Json(request): Json<CreateApprovalRequest>,
) -> Response {
    match tokio::task::spawn_blocking(move || create_approval(&collaboration_session_id, request))
        .await
    {
        Ok(Ok(result)) => (StatusCode::CREATED, Json(result)).into_response(),
        Ok(Err(error)) => response_from_error(error, "create collaboration approval"),
        Err(error) => {
            crate::http_error::internal(format!("Task join error: {}", error), "spawn_blocking")
                .into_response()
        }
    }
}

/// POST /api/v1/collaboration-sessions/:session_id/approvals/:approval_id/decision
#[utoipa::path(
    post,
    path = "/api/v1/collaboration-sessions/{session_id}/approvals/{approval_id}/decision",
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
    Path((collaboration_session_id, approval_id)): Path<(String, String)>,
    Json(request): Json<ApprovalDecisionRequest>,
) -> Response {
    match tokio::task::spawn_blocking(move || {
        decide_approval(&collaboration_session_id, &approval_id, request)
    })
    .await
    {
        Ok(Ok(result)) => (StatusCode::OK, Json(result)).into_response(),
        Ok(Err(error)) => response_from_error(error, "decide collaboration approval"),
        Err(error) => {
            crate::http_error::internal(format!("Task join error: {}", error), "spawn_blocking")
                .into_response()
        }
    }
}

/// POST /api/v1/collaboration-sessions/:id/cancel
#[utoipa::path(
    post,
    path = "/api/v1/collaboration-sessions/{id}/cancel",
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
    Path(collaboration_session_id): Path<String>,
    reason: Option<Json<String>>,
) -> Response {
    let reason = reason.map(|Json(reason)| reason);
    match cancel_session_execution(&collaboration_session_id, reason).await {
        Ok(detail) => (StatusCode::OK, Json(detail)).into_response(),
        Err(error) => response_from_dag_error(error, "cancel collaboration session"),
    }
}

// ════════════════════════════════════════════════════════════════════════
// Collaboration Session API（新版扁平化路由）
// ════════════════════════════════════════════════════════════════════════

#[derive(Debug, Deserialize, utoipa::IntoParams)]
pub struct ListCollaborationSessionsQuery {
    pub chat_id: Option<String>,
}

/// GET /api/v1/collaboration-sessions
#[utoipa::path(
    get,
    path = "/api/v1/collaboration-sessions",
    tag = "Collaboration Sessions",
    params(ListCollaborationSessionsQuery),
    responses(
        (status = 200, description = "List collaboration sessions", body = Vec<crate::services::collaboration_session::CollaborationSessionDetail>),
        (status = 500, description = "Internal server error", body = crate::api::ApiError),
    )
)]
pub async fn list_collaboration_sessions(
    Query(query): Query<ListCollaborationSessionsQuery>,
) -> Response {
    use crate::services::collaboration_session::list_sessions;

    let result = if let Some(chat_id) = query.chat_id {
        list_sessions(Some(&chat_id), None).await
    } else {
        list_sessions(None, None).await
    };

    match result {
        Ok(sessions) => (StatusCode::OK, Json(sessions)).into_response(),
        Err(e) => crate::http_error::internal(e, "list collaboration sessions").into_response(),
    }
}

#[derive(Debug, Deserialize, utoipa::ToSchema)]
pub struct PatchCollaborationSessionRequest {
    pub mode: Option<String>,
    pub goal: Option<String>,
    pub state: Option<String>,
}

/// PATCH /api/v1/collaboration-sessions/{collaboration_session_id}
#[utoipa::path(
    patch,
    path = "/api/v1/collaboration-sessions/{collaboration_session_id}",
    tag = "Collaboration Sessions",
    params(("collaboration_session_id" = String, Path, description = "Collaboration session ID")),
    request_body = PatchCollaborationSessionRequest,
    responses(
        (status = 200, description = "Session updated", body = crate::services::collaboration_session::CollaborationSessionDetail),
        (status = 404, description = "Session not found", body = crate::api::ApiError),
        (status = 400, description = "Invalid request", body = crate::api::ApiError),
        (status = 500, description = "Internal server error", body = crate::api::ApiError),
    )
)]
pub async fn patch_collaboration_session(
    Path(collaboration_session_id): Path<String>,
    Json(req): Json<PatchCollaborationSessionRequest>,
) -> Response {
    use crate::services::collaboration_session::{get_session, update_session};

    // Get existing session
    let _session = match get_session(&collaboration_session_id) {
        Ok(s) => s,
        Err(e) => return response_from_error(e, "get collaboration session for update"),
    };

    // Update fields
    let update_req = crate::services::collaboration_session::UpdateCollaborationSessionRequest {
        mode: req.mode,
        goal: req.goal,
        state: req.state,
    };

    match update_session(&collaboration_session_id, update_req).await {
        Ok(Some(detail)) => (StatusCode::OK, Json(detail)).into_response(),
        Ok(None) => {
            crate::http_error::not_found("Collaboration session", &collaboration_session_id)
                .into_response()
        }
        Err(e) => response_from_error(e, "update collaboration session"),
    }
}

/// DELETE /api/v1/collaboration-sessions/{collaboration_session_id}
#[utoipa::path(
    delete,
    path = "/api/v1/collaboration-sessions/{collaboration_session_id}",
    tag = "Collaboration Sessions",
    params(("collaboration_session_id" = String, Path, description = "Collaboration session ID")),
    responses(
        (status = 204, description = "Session deleted"),
        (status = 404, description = "Session not found", body = crate::api::ApiError),
        (status = 500, description = "Internal server error", body = crate::api::ApiError),
    )
)]
pub async fn delete_collaboration_session(
    Path(collaboration_session_id): Path<String>,
) -> Response {
    use crate::services::collaboration_session::delete_session;

    match delete_session(&collaboration_session_id).await {
        Ok(true) => StatusCode::NO_CONTENT.into_response(),
        Ok(false) => {
            crate::http_error::not_found("Collaboration session", &collaboration_session_id)
                .into_response()
        }
        Err(e) => response_from_error(e, "delete collaboration session"),
    }
}

/// GET /api/v1/collaboration-sessions/{collaboration_session_id}/status
#[utoipa::path(
    get,
    path = "/api/v1/collaboration-sessions/{collaboration_session_id}/status",
    tag = "Collaboration Sessions",
    params(("collaboration_session_id" = String, Path, description = "Collaboration session ID")),
    responses(
        (status = 200, description = "Session status", body = serde_json::Value),
        (status = 404, description = "Session not found", body = crate::api::ApiError),
    )
)]
pub async fn get_collaboration_session_status(
    Path(collaboration_session_id): Path<String>,
) -> Response {
    use crate::services::collaboration_session::get_session;

    match get_session(&collaboration_session_id) {
        Ok(session) => {
            let status = serde_json::json!({
                "collaboration_session_id": session.session.collaboration_session_id,
                "state": session.session.state,
                "mode": session.session.mode,
                "goal": session.session.goal,
                "created_at": session.session.created_at,
                "updated_at": session.session.updated_at,
            });
            (StatusCode::OK, Json(status)).into_response()
        }
        Err(e) => response_from_error(e, "get collaboration session status"),
    }
}

/// GET /api/v1/collaboration-sessions/{collaboration_session_id}/progress
#[utoipa::path(
    get,
    path = "/api/v1/collaboration-sessions/{collaboration_session_id}/progress",
    tag = "Collaboration Sessions",
    params(("collaboration_session_id" = String, Path, description = "Collaboration session ID")),
    responses(
        (status = 200, description = "Session progress", body = serde_json::Value),
        (status = 404, description = "Session not found", body = crate::api::ApiError),
    )
)]
pub async fn get_collaboration_session_progress(
    Path(collaboration_session_id): Path<String>,
) -> Response {
    use crate::services::collaboration_session::{get_session, list_events};

    // Get session
    let session = match get_session(&collaboration_session_id) {
        Ok(s) => s,
        Err(e) => return response_from_error(e, "get collaboration session for progress"),
    };

    // Get events for progress calculation
    let events = match list_events(&collaboration_session_id, None, 1000) {
        Ok(evts) => evts,
        Err(e) => return response_from_error(e, "list events for progress"),
    };

    let total_events = events.len();
    let completed_events = events
        .iter()
        .filter(|e| e.event_type == "completed")
        .count();

    let progress = serde_json::json!({
        "collaboration_session_id": session.session.collaboration_session_id,
        "state": session.session.state,
        "total_events": total_events,
        "completed_events": completed_events,
        "progress_percentage": if total_events > 0 {
            (completed_events as f64 / total_events as f64) * 100.0
        } else {
            0.0
        },
    });

    (StatusCode::OK, Json(progress)).into_response()
}

/// GET /api/v1/collaboration-sessions/{session_id}/conversations
/// 列出该 session 下的所有节点（Conversations）
#[utoipa::path(
    get,
    path = "/api/v1/collaboration-sessions/{session_id}/conversations",
    tag = "Collaboration Sessions",
    params(("session_id" = String, Path, description = "Collaboration session ID")),
    responses(
        (status = 200, description = "List of conversations in the session", body = serde_json::Value),
        (status = 404, description = "Session not found", body = crate::api::ApiError),
        (status = 500, description = "Internal server error", body = crate::api::ApiError),
    )
)]
pub async fn list_session_conversations(Path(collaboration_session_id): Path<String>) -> Response {
    // Parse session ID to i64 using parse_to_i64 for formatted IDs
    let session_id_i64 = match ergatai_error::id::parse_to_i64(&collaboration_session_id) {
        Some(id) => id,
        None => {
            return crate::http_error::bad_request(format!(
                "Invalid collaboration session ID format: {}",
                collaboration_session_id
            ))
            .into_response()
        }
    };

    // 1. 验证 session 存在
    let _session = match tokio::task::spawn_blocking({
        let session_id = session_id_i64;
        move || crate::user_data_db::collaboration_sessions::get(session_id)
    })
    .await
    {
        Ok(Ok(Some(s))) => s,
        Ok(Ok(None)) => {
            return crate::http_error::not_found("Collaboration session", &collaboration_session_id)
                .into_response()
        }
        Ok(Err(e)) => return crate::http_error::internal(e, "query session").into_response(),
        Err(e) => return crate::http_error::internal(e, "task join error").into_response(),
    };

    // 2. 查询该 session 下的所有 conversations
    let conversations = match tokio::task::spawn_blocking({
        let session_id = session_id_i64;
        move || crate::user_data_db::conversations::list_by_collaboration_session(session_id)
    })
    .await
    {
        Ok(Ok(convs)) => convs,
        Ok(Err(e)) => return crate::http_error::internal(e, "list conversations").into_response(),
        Err(e) => return crate::http_error::internal(e, "task join error").into_response(),
    };

    // 3. 查询每个 conversation 的 agent 信息
    let registry = ergatai_core::unified_registry::unified_registry();
    let mut nodes = Vec::new();

    for conv in conversations {
        let agent_info = registry
            .get_by_conversation_id(&conv.conversation_id.to_string())
            .await
            .map(|a| {
                serde_json::json!({
                    "agent_id": a.agent_id,
                    "state": format!("{:?}", a.state),
                    "profile": a.profile,
                })
            });

        nodes.push(serde_json::json!({
            "conversation_id": conv.conversation_id,
            "title": conv.name,
            "status": conv.status,
            "agent": agent_info,
            "created_at": conv.created_at,
            "updated_at": conv.updated_at,
        }));
    }

    Json(serde_json::json!({
        "session_id": collaboration_session_id,
        "conversations": nodes,
        "total": nodes.len()
    }))
    .into_response()
}

/// GET /api/v1/collaboration-sessions/{session_id}/conversations/{conversation_id}
/// 查询单个节点
#[utoipa::path(
    get,
    path = "/api/v1/collaboration-sessions/{session_id}/conversations/{conversation_id}",
    tag = "Collaboration Sessions",
    params(
        ("session_id" = String, Path, description = "Collaboration session ID"),
        ("conversation_id" = String, Path, description = "Conversation ID"),
    ),
    responses(
        (status = 200, description = "Conversation details", body = serde_json::Value),
        (status = 404, description = "Session or conversation not found", body = crate::api::ApiError),
        (status = 500, description = "Internal server error", body = crate::api::ApiError),
    )
)]
pub async fn get_session_conversation(
    Path((collaboration_session_id, conversation_id)): Path<(String, String)>,
) -> Response {
    // Parse IDs to i64 using parse_to_i64 for formatted IDs
    let session_id_i64 = match ergatai_error::id::parse_to_i64(&collaboration_session_id) {
        Some(id) => id,
        None => {
            return crate::http_error::bad_request(format!(
                "Invalid collaboration session ID format: {}",
                collaboration_session_id
            ))
            .into_response()
        }
    };
    let conversation_id_i64 = match ergatai_error::id::parse_to_i64(&conversation_id) {
        Some(id) => id,
        None => {
            return crate::http_error::bad_request(format!(
                "Invalid conversation ID format: {}",
                conversation_id
            ))
            .into_response()
        }
    };

    // 1. 验证 session 存在
    let session_exists = match tokio::task::spawn_blocking({
        let session_id = session_id_i64;
        move || crate::user_data_db::collaboration_sessions::get(session_id)
    })
    .await
    {
        Ok(Ok(Some(_))) => true,
        Ok(Ok(None)) => false,
        Ok(Err(e)) => return crate::http_error::internal(e, "query session").into_response(),
        Err(e) => return crate::http_error::internal(e, "task join error").into_response(),
    };

    if !session_exists {
        return crate::http_error::not_found("Collaboration session", &collaboration_session_id)
            .into_response();
    }

    // 2. 查询 conversation
    let conversation = match tokio::task::spawn_blocking({
        let conversation_id = conversation_id_i64;
        move || crate::user_data_db::conversations::get(conversation_id)
    })
    .await
    {
        Ok(Ok(Some(conv))) => conv,
        Ok(Ok(None)) => {
            return crate::http_error::not_found("Conversation", &conversation_id).into_response()
        }
        Ok(Err(e)) => return crate::http_error::internal(e, "query conversation").into_response(),
        Err(e) => return crate::http_error::internal(e, "task join error").into_response(),
    };

    // 3. 验证 conversation 属于该 session
    if conversation.collaboration_session_id != session_id_i64 {
        return crate::http_error::not_found("Conversation", &conversation_id).into_response();
    }

    // 4. 查询 agent 信息
    let registry = ergatai_core::unified_registry::unified_registry();
    let agent_info = registry
        .get_by_conversation_id(&conversation_id)
        .await
        .map(|a| {
            serde_json::json!({
                "agent_id": a.agent_id,
                "state": format!("{:?}", a.state),
                "profile": a.profile,
                "capabilities": a.capabilities,
                "last_heartbeat": a.last_heartbeat,
            })
        });

    Json(serde_json::json!({
        "conversation_id": conversation.conversation_id,
        "session_id": collaboration_session_id,
        "title": conversation.name,
        "status": conversation.status,
        "agent": agent_info,
        "created_at": conversation.created_at,
        "updated_at": conversation.updated_at,
    }))
    .into_response()
}
