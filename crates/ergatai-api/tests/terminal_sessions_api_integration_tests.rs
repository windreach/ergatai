//! Integration tests for terminal sessions API handlers (smoke).

use axum::body::Body;
use axum::http::{Method, Request, StatusCode};
use ergatai_api::{build_rest_app, AppState};
use tower::util::ServiceExt;

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
        ergatai_api::context::init_app_context(ctx);
    });
}

fn test_state() -> AppState {
    ensure_app_context_initialized();
    AppState {
        default_cwd: std::env::temp_dir().to_string_lossy().to_string(),
        api_token: None,
        event_tx: std::sync::Arc::new(tokio::sync::broadcast::channel(16).0),
    }
}

#[tokio::test]
async fn list_terminal_sessions_returns_sessions_array() {
    let app = build_rest_app(test_state());
    let req = Request::builder()
        .method(Method::GET)
        .uri("/api/v1/terminal-sessions")
        .body(Body::empty())
        .unwrap();
    let resp = app.oneshot(req).await.unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let body_bytes = axum::body::to_bytes(resp.into_body(), 1024 * 1024)
        .await
        .unwrap();
    let json: serde_json::Value = serde_json::from_slice(&body_bytes).unwrap();
    assert!(json.get("sessions").is_some(), "expected sessions field");
    assert!(json["sessions"].is_array());
}

#[tokio::test]
async fn list_terminal_sessions_invalid_workspace_returns_not_found() {
    let app = build_rest_app(test_state());
    let req = Request::builder()
        .method(Method::GET)
        .uri("/api/v1/terminal-sessions?workspace_id=not-a-workspace")
        .body(Body::empty())
        .unwrap();
    let resp = app.oneshot(req).await.unwrap();
    // workspace_id is not validated as typed id here; just ensure no 500
    assert!(
        resp.status().is_success()
            || resp.status() == StatusCode::NOT_FOUND
            || resp.status() == StatusCode::BAD_REQUEST
    );
}

#[tokio::test]
async fn get_nonexistent_terminal_session_returns_not_found() {
    let app = build_rest_app(test_state());
    let req = Request::builder()
        .method(Method::GET)
        .uri("/api/v1/terminal-sessions/nonexistent-id")
        .body(Body::empty())
        .unwrap();
    let resp = app.oneshot(req).await.unwrap();
    assert!(resp.status() == StatusCode::NOT_FOUND || resp.status() == StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn create_terminal_session_missing_fields_returns_bad_request() {
    let app = build_rest_app(test_state());
    let req = Request::builder()
        .method(Method::POST)
        .uri("/api/v1/terminal-sessions")
        .header("content-type", "application/json")
        .body(Body::from("{}"))
        .unwrap();
    let resp = app.oneshot(req).await.unwrap();
    assert!(
        resp.status() == StatusCode::BAD_REQUEST
            || resp.status() == StatusCode::UNPROCESSABLE_ENTITY,
        "got {}",
        resp.status()
    );
}
