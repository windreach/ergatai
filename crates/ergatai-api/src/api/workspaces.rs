use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::IntoResponse,
    Json,
};
use ergatai_runtime::{get_agent_runtime, ResourceLimits, WorkspaceSpec};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

use crate::AppState;

#[derive(Debug, Deserialize)]
pub struct CreateWorkspaceRequest {
    pub id: String,
    pub work_dir: Option<String>,
    pub env: Option<HashMap<String, String>>,
}

#[derive(Debug, Serialize)]
pub struct WorkspaceResponse {
    pub id: String,
    pub backend: String,
    pub metadata: HashMap<String, String>,
}

#[derive(Debug, Serialize)]
pub struct ErrorResponse {
    pub error: String,
}

pub async fn list_workspaces(State(_state): State<AppState>) -> impl IntoResponse {
    let runtime = get_agent_runtime();
    match runtime.backend().list_workspaces().await {
        Ok(workspaces) => {
            let response: Vec<WorkspaceResponse> = workspaces
                .into_iter()
                .map(|w| WorkspaceResponse {
                    id: w.id,
                    backend: w.backend,
                    metadata: w.metadata,
                })
                .collect();
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

pub async fn create_workspace(
    State(state): State<AppState>,
    Json(req): Json<CreateWorkspaceRequest>,
) -> impl IntoResponse {
    let runtime = get_agent_runtime();

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
    let work_dir = match crate::validate_cwd(&raw_work_dir) {
        Ok(p) => p,
        Err(msg) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(ErrorResponse { error: msg }),
            )
                .into_response();
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
            let response = WorkspaceResponse {
                id: handle.id,
                backend: handle.backend,
                metadata: handle.metadata,
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

pub async fn delete_workspace(
    State(_state): State<AppState>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    let runtime = get_agent_runtime();

    // Find workspace by ID
    let workspaces = match runtime.backend().list_workspaces().await {
        Ok(w) => w,
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ErrorResponse {
                    error: e.to_string(),
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
                error: e.to_string(),
            }),
        )
            .into_response(),
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
        };
        let json = serde_json::to_value(&resp).unwrap();
        assert_eq!(json["id"], "ws-1");
        assert_eq!(json["backend"], "pty");
        assert_eq!(json["metadata"]["key"], "value");
    }

    #[test]
    fn test_workspace_response_empty_metadata() {
        let resp = WorkspaceResponse {
            id: "ws-1".to_string(),
            backend: "pty".to_string(),
            metadata: HashMap::new(),
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
