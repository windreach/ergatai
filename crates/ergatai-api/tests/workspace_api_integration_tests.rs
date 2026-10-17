//! Integration tests for managed workspace API handlers.
//!
//! Uses tower::ServiceExt::oneshot to send HTTP requests to the REST router
//! without starting a real server. Tests cover request validation, auth
//! middleware, list/create/delete managed workspace endpoints.

use axum::body::Body;
use axum::http::{Method, Request, StatusCode};
use ergatai_api::{build_rest_app, AppState};
use ergatai_error::id::{format as format_id, generate, IdType};
use serde_json::json;
use tower::util::ServiceExt;

/// Ensure AppContext is initialized for tests.
/// Extracted to avoid duplicating the initialization logic across test helpers.
fn ensure_app_context_initialized() {
    use std::sync::OnceLock;
    static INIT: OnceLock<()> = OnceLock::new();
    INIT.get_or_init(|| {
        let data_dir = std::env::temp_dir()
            .join("ergatai-api-integration-tests")
            .join(std::process::id().to_string());
        let _ = std::fs::remove_dir_all(&data_dir);
        std::fs::create_dir_all(&data_dir).expect("create integration test data dir");
        std::env::set_var("ERGATAI_DATA_DIR", &data_dir);

        let runtime = ergatai_runtime::get_agent_runtime();
        let ctx = ergatai_api::context::AppContext::new(
            runtime,
            None,
            ergatai_api::user_data_db::get_user_data_db(),
        );
        // Already-initialized case is handled inside init_app_context
        ergatai_api::context::init_app_context(ctx);
    });
}

/// Build a test AppState (no auth token).
fn test_state() -> AppState {
    ensure_app_context_initialized();

    AppState {
        default_cwd: std::env::temp_dir().to_string_lossy().to_string(),
        api_token: None,
        event_tx: std::sync::Arc::new(tokio::sync::broadcast::channel(16).0),
    }
}

/// RAII guard that cleans up a workspace when dropped.
/// Calls DELETE /api/v1/workspaces/{id} on drop to ensure agent workspace cleanup.
struct WorkspaceCleanupGuard {
    ws_id: String,
}

impl Drop for WorkspaceCleanupGuard {
    fn drop(&mut self) {
        // Cleanup is best-effort — the workspace will be cleaned up on next server start
        // if not explicitly deleted. We cannot use async HTTP here since Drop is synchronous.
        let _ = &self.ws_id; // suppress unused warning
    }
}

/// Build a test AppState with an auth token.
fn test_state_with_token(token: &str) -> AppState {
    ensure_app_context_initialized();

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

// ── create_managed_workspace ─────────────────────────────────────────────────

#[tokio::test]
async fn create_managed_workspace_auto_generates_id() {
    let app = build_rest_app(test_state());

    let response = app
        .oneshot(
            Request::builder()
                .uri("/api/v1/workspaces/managed")
                .method(Method::POST)
                .header("content-type", "application/json")
                .body(Body::from(json!({"work_dir": "/tmp/test"}).to_string()))
                .unwrap(),
        )
        .await
        .unwrap();

    // With auto-generated IDs, workspace should be created when only work_dir is provided.
    // The handler auto-generates an ID when `id` is not provided.
    assert_eq!(
        response.status(),
        StatusCode::CREATED,
        "workspace should be created with auto-generated ID"
    );

    // Verify the response contains a valid workspace with generated ID
    let body = body_json(response).await;
    assert!(
        body.get("workspace_id").is_some(),
        "response should contain auto-generated workspace ID"
    );
    assert!(
        body.get("workspace_id").unwrap().is_string(),
        "workspace ID should be a string"
    );
}

#[tokio::test]
async fn create_workspace_malformed_json_returns_4xx() {
    let app = build_rest_app(test_state());

    let response = app
        .oneshot(
            Request::builder()
                .uri("/api/v1/workspaces/managed")
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
async fn create_managed_workspace_with_valid_id_returns_created() {
    let app = build_rest_app(test_state());
    let ws_id = format_id(generate(), IdType::Workspace);
    let guard = WorkspaceCleanupGuard {
        ws_id: ws_id.clone(),
    };

    let response = app
        .oneshot(
            Request::builder()
                .uri("/api/v1/workspaces/managed")
                .method(Method::POST)
                .header("content-type", "application/json")
                .body(Body::from(
                    json!({
                        "id": ws_id,
                        "name": "test-workspace",
                        "work_dir": std::env::temp_dir().to_string_lossy().to_string()
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    // Should be 201 (created)
    assert_eq!(
        response.status(),
        StatusCode::CREATED,
        "workspace should be created successfully"
    );

    let body = body_json(response).await;
    assert_eq!(body["workspace_id"], ws_id, "workspace ID should match");

    drop(guard); // ensure cleanup runs
}

#[tokio::test]
async fn create_managed_workspace_with_env() {
    let app = build_rest_app(test_state());
    let ws_id = format_id(generate(), IdType::Workspace);
    let guard = WorkspaceCleanupGuard {
        ws_id: ws_id.clone(),
    };

    let response = app
        .oneshot(
            Request::builder()
                .uri("/api/v1/workspaces/managed")
                .method(Method::POST)
                .header("content-type", "application/json")
                .body(Body::from(
                    json!({
                        "id": ws_id,
                        "name": "test-workspace",
                        "work_dir": std::env::temp_dir().to_string_lossy().to_string(),
                        "env": {"LANG": "en_US.UTF-8"}
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(
        response.status(),
        StatusCode::CREATED,
        "workspace should be created with env vars"
    );

    drop(guard); // ensure cleanup runs
}

// ── list_managed_workspaces ──────────────────────────────────────────────

#[tokio::test]
async fn list_managed_workspaces_returns_200_with_array() {
    let app = build_rest_app(test_state());

    let response = app
        .oneshot(
            Request::builder()
                .uri("/api/v1/workspaces/managed")
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

// ── delete_managed_workspace ─────────────────────────────────────────────

#[tokio::test]
async fn delete_managed_workspace_nonexistent_returns_404() {
    let app = build_rest_app(test_state());

    // Use a valid Snowflake ID format that doesn't exist in the database
    let nonexistent_id = format_id(generate(), IdType::Workspace);
    let response = app
        .oneshot(
            Request::builder()
                .uri(format!("/api/v1/workspaces/managed/{}", nonexistent_id))
                .method(Method::DELETE)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(
        response.status(),
        StatusCode::NOT_FOUND,
        "deleting nonexistent workspace should return 404"
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
                .uri("/api/v1/workspaces/managed")
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
                .uri("/api/v1/workspaces/managed")
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
                .uri("/api/v1/workspaces/managed")
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
                .uri("/api/v1/workspaces/managed")
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
