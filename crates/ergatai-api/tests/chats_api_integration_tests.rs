//! Integration tests for chats API handlers (smoke).

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

fn test_state_with_token(token: &str) -> AppState {
    ensure_app_context_initialized();
    AppState {
        default_cwd: std::env::temp_dir().to_string_lossy().to_string(),
        api_token: Some(token.to_string()),
        event_tx: std::sync::Arc::new(tokio::sync::broadcast::channel(16).0),
    }
}

async fn body_json(response: axum::response::Response) -> serde_json::Value {
    let body_bytes = axum::body::to_bytes(response.into_body(), 1024 * 1024)
        .await
        .expect("read body");
    serde_json::from_slice(&body_bytes).unwrap_or(serde_json::Value::Null)
}

#[tokio::test]
async fn list_chats_returns_empty_array() {
    let app = build_rest_app(test_state());
    let req = Request::builder()
        .method(Method::GET)
        .uri("/api/v1/chats")
        .body(Body::empty())
        .unwrap();
    let resp = app.oneshot(req).await.unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let json = body_json(resp).await;
    assert!(json.is_array(), "expected JSON array, got: {}", json);
    assert_eq!(json.as_array().unwrap().len(), 0);
}

#[tokio::test]
async fn list_chats_invalid_workspace_id_returns_bad_request() {
    let app = build_rest_app(test_state());
    let req = Request::builder()
        .method(Method::GET)
        .uri("/api/v1/chats?workspace_id=not-a-valid-id")
        .body(Body::empty())
        .unwrap();
    let resp = app.oneshot(req).await.unwrap();
    assert!(
        resp.status() == StatusCode::BAD_REQUEST || resp.status() == StatusCode::NOT_FOUND,
        "expected 400/404, got {}",
        resp.status()
    );
}

#[tokio::test]
async fn create_chat_missing_workspace_returns_error() {
    let app = build_rest_app(test_state());
    let req = Request::builder()
        .method(Method::POST)
        .uri("/api/v1/chats")
        .header("content-type", "application/json")
        .body(Body::from("{}"))
        .unwrap();
    let resp = app.oneshot(req).await.unwrap();
    assert!(
        resp.status() == StatusCode::BAD_REQUEST
            || resp.status() == StatusCode::UNPROCESSABLE_ENTITY
            || resp.status() == StatusCode::NOT_FOUND,
        "expected client error, got {}",
        resp.status()
    );
}

#[tokio::test]
async fn list_chats_requires_auth_when_token_set() {
    let state = test_state_with_token("secret-token");
    let app = build_rest_app(state);
    let req = Request::builder()
        .method(Method::GET)
        .uri("/api/v1/chats")
        .body(Body::empty())
        .unwrap();
    let resp = app.oneshot(req).await.unwrap();
    assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn get_nonexistent_chat_returns_not_found() {
    let app = build_rest_app(test_state());
    let req = Request::builder()
        .method(Method::GET)
        .uri("/api/v1/chats/999999")
        .body(Body::empty())
        .unwrap();
    let resp = app.oneshot(req).await.unwrap();
    assert!(resp.status() == StatusCode::NOT_FOUND || resp.status() == StatusCode::BAD_REQUEST);
}
