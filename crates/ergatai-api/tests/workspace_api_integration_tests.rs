//! Integration tests for create_workspace and workspace API handlers.
//!
//! Uses tower::ServiceExt::oneshot to send HTTP requests to the REST router
//! without starting a real server. Tests cover request validation, auth
//! middleware, list/create/delete workspace endpoints.

use axum::body::Body;
use axum::http::{Method, Request, StatusCode};
use ergatai_api::{build_rest_app, AppState};
use serde_json::json;
use tower::util::ServiceExt;

/// Build a test AppState (no auth token).
fn test_state() -> AppState {
    AppState {
        default_cwd: std::env::temp_dir().to_string_lossy().to_string(),
        api_token: None,
        event_tx: std::sync::Arc::new(tokio::sync::broadcast::channel(16).0),
    }
}

/// RAII guard that cleans up a workspace when dropped.
/// Calls DELETE /api/v1/workspaces/{id} on drop to ensure tmux session cleanup.
struct WorkspaceCleanupGuard {
    ws_id: String,
}

impl Drop for WorkspaceCleanupGuard {
    fn drop(&mut self) {
        // Cleanup must be synchronous — Drop runs after the tokio runtime may have
        // shut down, so tokio::spawn would be silently cancelled.
        // Use tmux directly to kill the session (best-effort).
        let session_name = format!("ergatai-{}", self.ws_id);
        let _ = std::process::Command::new("tmux")
            .args(["kill-session", "-t", &session_name])
            .output();
    }
}

/// Build a test AppState with an auth token.
fn test_state_with_token(token: &str) -> AppState {
    AppState {
        default_cwd: std::env::temp_dir().to_string_lossy().to_string(),
        api_token: Some(token.to_string()),
        event_tx: std::sync::Arc::new(tokio::sync::broadcast::channel(16).0),
    }
}

/// Read response body as serde_json::Value.
async fn body_json(response: axum::response::Response) -> serde_json::Value {
    let body_bytes = axum::body::to_bytes(response.into_body(), 1024 * 1024)
        .await
        .expect("read body");
    serde_json::from_slice(&body_bytes).expect("parse JSON body")
}

// ── create_workspace ─────────────────────────────────────────────────

#[tokio::test]
async fn create_workspace_missing_fields_returns_422() {
    let app = build_rest_app(test_state());

    let response = app
        .oneshot(
            Request::builder()
                .uri("/api/v1/workspaces")
                .method(Method::POST)
                .header("content-type", "application/json")
                .body(Body::from(json!({}).to_string()))
                .unwrap(),
        )
        .await
        .unwrap();

    // Missing required "id" field → 422 Unprocessable Entity (axum JSON extractor)
    assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY);
}

#[tokio::test]
async fn create_workspace_malformed_json_returns_4xx() {
    let app = build_rest_app(test_state());

    let response = app
        .oneshot(
            Request::builder()
                .uri("/api/v1/workspaces")
                .method(Method::POST)
                .header("content-type", "application/json")
                .body(Body::from("not json"))
                .unwrap(),
        )
        .await
        .unwrap();

    // Malformed JSON → 400 Bad Request or 422 Unprocessable Entity
    assert!(
        response.status() == StatusCode::BAD_REQUEST
            || response.status() == StatusCode::UNPROCESSABLE_ENTITY,
        "malformed JSON should be rejected, got: {}",
        response.status()
    );
}

#[tokio::test]
async fn create_workspace_with_valid_id_returns_created_or_bad_request() {
    let app = build_rest_app(test_state());
    let ws_id = format!("test-ws-{}", uuid::Uuid::new_v4());
    let guard = WorkspaceCleanupGuard {
        ws_id: ws_id.clone(),
    };

    let response = app
        .oneshot(
            Request::builder()
                .uri("/api/v1/workspaces")
                .method(Method::POST)
                .header("content-type", "application/json")
                .body(Body::from(
                    json!({
                        "id": ws_id,
                        "work_dir": std::env::temp_dir().to_string_lossy().to_string()
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    // Should be 201 (created) if tmux is available, or 400 if backend fails
    assert!(
        response.status() == StatusCode::CREATED || response.status() == StatusCode::BAD_REQUEST,
        "unexpected status: {}",
        response.status()
    );

    let body = body_json(response).await;
    if body.get("id").is_some() {
        assert_eq!(body["id"], ws_id);
    }
    if body.get("error").is_some() {
        assert!(!body["error"].as_str().unwrap().is_empty());
    }

    drop(guard); // ensure cleanup runs
}

#[tokio::test]
async fn create_workspace_with_env_and_persist() {
    let app = build_rest_app(test_state());
    let ws_id = format!("test-ws-env-{}", uuid::Uuid::new_v4());
    let guard = WorkspaceCleanupGuard {
        ws_id: ws_id.clone(),
    };

    let response = app
        .oneshot(
            Request::builder()
                .uri("/api/v1/workspaces")
                .method(Method::POST)
                .header("content-type", "application/json")
                .body(Body::from(
                    json!({
                        "id": ws_id,
                        "env": {"LANG": "en_US.UTF-8"},
                        "persist": true
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    assert!(
        response.status() == StatusCode::CREATED || response.status() == StatusCode::BAD_REQUEST,
        "unexpected status: {}",
        response.status()
    );

    drop(guard); // ensure cleanup runs
}

// ── list_workspaces ──────────────────────────────────────────────────

#[tokio::test]
async fn list_workspaces_returns_200_with_array() {
    let app = build_rest_app(test_state());

    let response = app
        .oneshot(
            Request::builder()
                .uri("/api/v1/workspaces")
                .method(Method::GET)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);

    let body = body_json(response).await;
    assert!(body.is_array(), "response should be a JSON array");
}

// ── delete_workspace ─────────────────────────────────────────────────

#[tokio::test]
async fn delete_workspace_nonexistent_returns_404_or_500() {
    let app = build_rest_app(test_state());

    let response = app
        .oneshot(
            Request::builder()
                .uri("/api/v1/workspaces/nonexistent-ws-id")
                .method(Method::DELETE)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert!(
        response.status() == StatusCode::NOT_FOUND
            || response.status() == StatusCode::INTERNAL_SERVER_ERROR,
        "unexpected status: {}",
        response.status()
    );

    let body = body_json(response).await;
    assert!(body.get("error").is_some(), "should have error field");
}

// ── Auth middleware ───────────────────────────────────────────────────

#[tokio::test]
async fn auth_middleware_rejects_without_token() {
    let app = build_rest_app(test_state_with_token("secret123"));

    let response = app
        .oneshot(
            Request::builder()
                .uri("/api/v1/workspaces")
                .method(Method::GET)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);

    let body = body_json(response).await;
    assert!(body["error"].as_str().unwrap().contains("API token"));
}

#[tokio::test]
async fn auth_middleware_rejects_wrong_token() {
    let app = build_rest_app(test_state_with_token("secret123"));

    let response = app
        .oneshot(
            Request::builder()
                .uri("/api/v1/workspaces")
                .method(Method::GET)
                .header("authorization", "Bearer wrong-token")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn auth_middleware_allows_correct_token() {
    let app = build_rest_app(test_state_with_token("secret123"));

    let response = app
        .oneshot(
            Request::builder()
                .uri("/api/v1/workspaces")
                .method(Method::GET)
                .header("authorization", "Bearer secret123")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
}

#[tokio::test]
async fn auth_middleware_exempts_health_endpoint() {
    let app = build_rest_app(test_state_with_token("secret123"));

    let response = app
        .oneshot(
            Request::builder()
                .uri("/health")
                .method(Method::GET)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert!(
        response.status() == StatusCode::OK || response.status() == StatusCode::SERVICE_UNAVAILABLE,
        "health should be exempt from auth, got: {}",
        response.status()
    );
}

#[tokio::test]
async fn auth_middleware_no_token_configured_allows_all() {
    let app = build_rest_app(test_state()); // no token

    let response = app
        .oneshot(
            Request::builder()
                .uri("/api/v1/workspaces")
                .method(Method::GET)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
}

// ── Health endpoint ──────────────────────────────────────────────────

#[tokio::test]
async fn health_endpoint_returns_json() {
    let app = build_rest_app(test_state());

    let response = app
        .oneshot(
            Request::builder()
                .uri("/health")
                .method(Method::GET)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert!(
        response.status() == StatusCode::OK || response.status() == StatusCode::SERVICE_UNAVAILABLE
    );

    let body = body_json(response).await;
    assert!(body.get("status").is_some(), "should have status field");
    assert!(body.get("checks").is_some(), "should have checks field");
    assert!(
        body.get("timestamp").is_some(),
        "should have timestamp field"
    );
}

// ── DAG status endpoint ──────────────────────────────────────────────

#[tokio::test]
async fn dag_status_no_dag_running() {
    let app = build_rest_app(test_state());

    let response = app
        .oneshot(
            Request::builder()
                .uri("/api/v1/dag/status")
                .method(Method::GET)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);

    let body = body_json(response).await;
    assert_eq!(body["running"], false);
}

#[tokio::test]
async fn list_dags_returns_array() {
    let app = build_rest_app(test_state());

    let response = app
        .oneshot(
            Request::builder()
                .uri("/api/v1/dags")
                .method(Method::GET)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);

    let body = body_json(response).await;
    assert!(body.is_array(), "dags should be an array");
}

// ── Agent list ───────────────────────────────────────────────────────

#[tokio::test]
async fn list_agents_returns_200() {
    let app = build_rest_app(test_state());

    let response = app
        .oneshot(
            Request::builder()
                .uri("/api/v1/agents")
                .method(Method::GET)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
}

// ── Submit DAG with invalid YAML ─────────────────────────────────────

#[tokio::test]
async fn submit_dag_invalid_yaml_returns_400() {
    let app = build_rest_app(test_state());

    let response = app
        .oneshot(
            Request::builder()
                .uri("/api/v1/dag")
                .method(Method::POST)
                .header("content-type", "application/json")
                .body(Body::from(
                    json!({"definition": "not: valid: dag: yaml: [[["}).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::BAD_REQUEST);

    let body = body_json(response).await;
    assert!(
        body["error"].as_str().unwrap().contains("parse")
            || body["error"].as_str().unwrap().contains("DAG"),
        "error should mention parsing"
    );
}
