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
                        record_mcp_approvals(&resolved.locations).await;
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
async fn record_mcp_approvals(identifiers: &[String]) {
    if identifiers.is_empty() {
        return;
    }
    let Ok(home) = std::env::var("HOME") else {
        tracing::warn!("HOME environment variable not set, cannot persist MCP approvals");
        return;
    };
    let settings_path = std::path::Path::new(&home)
        .join(".claude")
        .join("settings.json");

    // Ensure parent directory exists before validation to prevent path traversal
    let Some(parent) = settings_path.parent() else {
        tracing::warn!(path = %settings_path.display(), "Settings path has no parent directory");
        return;
    };
    if let Err(e) = tokio::fs::create_dir_all(parent).await {
        tracing::warn!(error = %e, path = %parent.display(), "Failed to create parent directory");
        return;
    }

    // Validate path to prevent path traversal attacks - now parent exists so canonicalize should work
    let canonical_path = match tokio::fs::canonicalize(parent).await {
        Ok(path) => path,
        Err(e) => {
            tracing::warn!(error = %e, path = %settings_path.display(), "Failed to canonicalize settings path (security check failed)");
            return;
        }
    };

    // Ensure the canonical path is under HOME to prevent path traversal
    let canonical_home = match tokio::fs::canonicalize(&home).await {
        Ok(path) => path,
        Err(e) => {
            tracing::warn!(error = %e, home = %home, "Failed to canonicalize HOME directory");
            return;
        }
    };
    if !canonical_path.starts_with(&canonical_home) {
        tracing::warn!(
            path = %canonical_path.display(),
            home = %canonical_home.display(),
            "Settings file path is outside HOME directory, refusing to write (security check)"
        );
        return;
    }

    let mut settings: serde_json::Value = match tokio::fs::read_to_string(&settings_path).await {
        Ok(content) => serde_json::from_str(&content).unwrap_or_else(|e| {
            tracing::warn!(error = %e, path = %settings_path.display(), "Failed to parse settings file, using empty object");
            serde_json::json!({})
        }),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            tracing::debug!("Settings file does not exist yet, creating new");
            serde_json::json!({})
        }
        Err(e) => {
            tracing::warn!(error = %e, path = %settings_path.display(), "Failed to read settings file");
            return;
        }
    };

    let Some(approved) = settings
        .as_object_mut()
        .map(|object| {
            object
                .entry("approvedPluginMcpServers")
                .or_insert_with(|| serde_json::Value::Array(vec![]))
        })
        .and_then(|value| value.as_array_mut())
    else {
        tracing::warn!("Settings file is not a JSON object, cannot persist MCP approvals");
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

    match serde_json::to_string_pretty(&settings) {
        Ok(content) => {
            if let Err(e) = tokio::fs::write(&settings_path, content).await {
                tracing::warn!(error = %e, path = %settings_path.display(), "Failed to write settings file");
            }
        }
        Err(e) => {
            tracing::warn!(error = %e, "Failed to serialize settings to JSON");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_respond_permission_body_deserialize() {
        // 测试基本的 decision 字段
        let json = r#"{"decision": "allow_once"}"#;
        let body: RespondPermissionBody = serde_json::from_str(json).unwrap();
        assert_eq!(body.decision, "allow_once");
        assert!(body.form_data.is_none());

        // 测试带 form_data 的 decision
        let json = r#"{"decision": "reject_always", "form_data": {"key": "value"}}"#;
        let body: RespondPermissionBody = serde_json::from_str(json).unwrap();
        assert_eq!(body.decision, "reject_always");
        assert!(body.form_data.is_some());
    }

    #[test]
    fn test_set_mode_body_deserialize() {
        let json = r#"{"mode": "ask"}"#;
        let body: SetModeBody = serde_json::from_str(json).unwrap();
        assert_eq!(body.mode, "ask");
    }

    #[test]
    fn test_permission_decision_kind_parse() {
        // 测试有效的 decision 值
        assert!(PermissionDecisionKind::parse("allow_once").is_some());
        assert!(PermissionDecisionKind::parse("allow_always").is_some());
        assert!(PermissionDecisionKind::parse("reject_once").is_some());
        assert!(PermissionDecisionKind::parse("reject_always").is_some());

        // 测试无效的 decision 值
        assert!(PermissionDecisionKind::parse("invalid").is_none());
        assert!(PermissionDecisionKind::parse("").is_none());
    }
}
