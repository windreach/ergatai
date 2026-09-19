//! Unified permission request endpoints.
//!
//! Backs the frontend permission approval dialog: pending list, real-time
//! SSE feed, and decision handling.

use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::{
        sse::{Event, KeepAlive, Sse},
        IntoResponse, Response,
    },
    Json,
};
use futures::stream::Stream;
use serde::Deserialize;
use std::convert::Infallible;

use ergatai_runtime::permission_service::{
    get_permission_mode, global_permission_service, set_permission_mode, PermissionDecisionKind,
    PermissionEvent, PermissionMode, PermissionRequestKind, PermissionSource,
};
use ergatai_runtime::ElicitationResponse;

use crate::{services::agent_service, AppState};

/// GET /api/v1/permissions/pending — snapshot of all pending requests.
pub async fn list_pending() -> impl IntoResponse {
    let requests = global_permission_service().pending().await;
    Json(serde_json::json!({ "requests": requests }))
}

/// GET /api/v1/permissions/stream — SSE feed of permission lifecycle events.
pub async fn stream_permissions() -> Sse<impl Stream<Item = Result<Event, Infallible>>> {
    let receiver = global_permission_service().subscribe();
    let stream = futures::stream::unfold(receiver, |mut receiver| async move {
        loop {
            match receiver.recv().await {
                Ok(event) => {
                    let (event_name, data) = match &event {
                        PermissionEvent::Request(request) => (
                            "permission_request",
                            serde_json::to_string(request).unwrap_or_default(),
                        ),
                        PermissionEvent::Resolved {
                            request_id,
                            decision,
                        } => (
                            "permission_resolved",
                            serde_json::json!({
                                "requestId": request_id,
                                "decision": decision,
                            })
                            .to_string(),
                        ),
                    };
                    return Some((
                        Ok::<_, Infallible>(Event::default().event(event_name).data(data)),
                        receiver,
                    ));
                }
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                Err(tokio::sync::broadcast::error::RecvError::Closed) => return None,
            }
        }
    });
    Sse::new(stream).keep_alive(KeepAlive::default())
}

/// Body for POST /api/v1/permissions/:id/respond.
#[derive(Debug, Deserialize)]
pub struct RespondPermissionBody {
    /// One of: allow_once, allow_always, reject_once, reject_always.
    pub decision: String,
    /// Optional form data for elicitation requests.
    #[serde(default)]
    pub form_data: Option<serde_json::Value>,
}

/// GET /api/v1/permissions/mode — current frontend permission mode.
pub async fn get_mode() -> impl IntoResponse {
    Json(serde_json::json!({ "mode": get_permission_mode() }))
}

/// Body for POST /api/v1/permissions/mode.
#[derive(Debug, Deserialize)]
pub struct SetModeBody {
    /// One of: ask, auto, full_access.
    pub mode: String,
}

/// POST /api/v1/permissions/mode — switch the frontend permission mode.
pub async fn set_mode(Json(body): Json<SetModeBody>) -> Response {
    let mode = match body.mode.as_str() {
        "ask" => PermissionMode::Ask,
        "auto" => PermissionMode::Auto,
        "full_access" => PermissionMode::FullAccess,
        _ => return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({
                "error": format!("Invalid mode '{}'. Expected ask, auto, or full_access", body.mode)
            })),
        )
            .into_response(),
    };
    set_permission_mode(mode);
    Json(serde_json::json!({ "success": true, "mode": mode })).into_response()
}

/// POST /api/v1/permissions/:id/respond — apply a user decision.
pub async fn respond_permission(
    State(_state): State<AppState>,
    Path(request_id): Path<String>,
    Json(body): Json<RespondPermissionBody>,
) -> Response {
    let Some(decision) = PermissionDecisionKind::parse(&body.decision) else {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({
                "error": format!(
                    "Invalid decision '{}'. Expected allow_once, allow_always, reject_once, or reject_always",
                    body.decision
                )
            })),
        )
            .into_response();
    };

    let service = global_permission_service();
    let Some(request) = service.get(&request_id).await else {
        return (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({
                "error": format!("Permission request {} not found", request_id)
            })),
        )
            .into_response();
    };

    match request.source {
        PermissionSource::Elicitation => {
            let action = if decision.is_allow() {
                "accept"
            } else {
                "decline"
            };
            match agent_service::respond_to_elicitation(
                &request_id,
                ElicitationResponse {
                    action: action.to_string(),
                    form_data: body.form_data,
                },
            )
            .await
            {
                Ok(true) => Json(serde_json::json!({
                    "success": true,
                    "requestId": request_id,
                    "decision": decision,
                }))
                .into_response(),
                Ok(false) => (
                    StatusCode::CONFLICT,
                    Json(serde_json::json!({
                        "error": format!("Permission request {} was already resolved", request_id)
                    })),
                )
                    .into_response(),
                Err(error) => (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(serde_json::json!({
                        "error": crate::sanitize_error(&error, "respond_to_elicitation")
                    })),
                )
                    .into_response(),
            }
        }
        PermissionSource::Acp | PermissionSource::LaunchGate => {
            match service.respond(&request_id, decision).await {
                Ok(resolved) => {
                    if resolved.kind == PermissionRequestKind::McpServer
                        && decision == PermissionDecisionKind::AllowAlways
                    {
                        record_mcp_approvals(&resolved.locations);
                    }
                    Json(serde_json::json!({
                        "success": true,
                        "requestId": request_id,
                        "decision": decision,
                        "request": resolved,
                    }))
                    .into_response()
                }
                Err(error) => (
                    StatusCode::NOT_FOUND,
                    Json(serde_json::json!({ "error": error })),
                )
                    .into_response(),
            }
        }
    }
}

/// Persist `allow_always` decisions for plugin MCP servers to
/// `~/.claude/settings.json` so future agent launches skip the gate.
/// Identifiers use the "{pluginSource}:{serverName}" format.
fn record_mcp_approvals(identifiers: &[String]) {
    if identifiers.is_empty() {
        return;
    }
    let Ok(home) = std::env::var("HOME") else {
        return;
    };
    let settings_path = std::path::Path::new(&home)
        .join(".claude")
        .join("settings.json");
    let mut settings: serde_json::Value = std::fs::read_to_string(&settings_path)
        .ok()
        .and_then(|content| serde_json::from_str(&content).ok())
        .unwrap_or_else(|| serde_json::json!({}));

    let Some(approved) = settings
        .as_object_mut()
        .map(|object| {
            object
                .entry("approvedPluginMcpServers")
                .or_insert_with(|| serde_json::Value::Array(vec![]))
        })
        .and_then(|value| value.as_array_mut())
    else {
        return;
    };

    for identifier in identifiers {
        if !approved
            .iter()
            .any(|value| value.as_str() == Some(identifier.as_str()))
        {
            approved.push(serde_json::Value::String(identifier.clone()));
        }
    }

    if let Some(parent) = settings_path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Ok(content) = serde_json::to_string_pretty(&settings) {
        let _ = std::fs::write(&settings_path, content);
    }
}
