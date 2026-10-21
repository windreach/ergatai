//! Integration tests for MCP Server Configuration API
//!
//! Tests cover CRUD operations, validation, filtering, and error handling
//! for the `/api/v1/mcp-servers` endpoints.

use axum::body::Body;
use axum::http::{Method, Request, StatusCode};
use ergatai_api::{build_rest_app, AppState};
use serde_json::json;
use tower::util::ServiceExt;

// ════════════════════════════════════════════════════════════════════════════
// Test Setup
// ════════════════════════════════════════════════════════════════════════════

fn test_state() -> AppState {
    ensure_app_context_initialized();

    AppState {
        default_cwd: std::env::temp_dir().to_string_lossy().to_string(),
        api_token: None,
        event_tx: std::sync::Arc::new(tokio::sync::broadcast::channel(16).0),
    }
}

fn ensure_app_context_initialized() {
    use std::sync::OnceLock;
    static INIT: OnceLock<()> = OnceLock::new();
    INIT.get_or_init(|| {
        let data_dir = std::env::temp_dir()
            .join("ergatai-mcp-api-integration-tests")
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

/// Read response body as serde_json::Value.
async fn body_json(response: axum::response::Response) -> serde_json::Value {
    let body_bytes = axum::body::to_bytes(response.into_body(), 1024 * 1024)
        .await
        .expect("read body");
    serde_json::from_slice(&body_bytes).expect("parse JSON body")
}

// ════════════════════════════════════════════════════════════════════════════
// CREATE tests
// ════════════════════════════════════════════════════════════════════════════

#[tokio::test]
async fn create_stdio_mcp_server_returns_201() {
    let app = build_rest_app(test_state());

    let response = app
        .oneshot(
            Request::builder()
                .uri("/api/v1/mcp-servers")
                .method(Method::POST)
                .header("content-type", "application/json")
                .body(Body::from(
                    json!({
                        "name": "test-github",
                        "server_type": "stdio",
                        "command": "npx",
                        "args": "[\"@modelcontextprotocol/server-github\"]",
                        "env": "{\"GITHUB_TOKEN\":\"test-token\"}",
                        "enabled": true
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
        "stdio MCP server should be created successfully"
    );

    let body = body_json(response).await;
    assert_eq!(body["name"], "test-github");
    assert_eq!(body["server_type"], "stdio");
    assert_eq!(body["command"], "npx");
    assert!(body["enabled"].as_bool().unwrap());
    assert!(body["id"].as_i64().is_some());
    assert!(body["created_at"].as_i64().is_some());
}

#[tokio::test]
async fn create_http_mcp_server_returns_201() {
    let app = build_rest_app(test_state());

    let response = app
        .oneshot(
            Request::builder()
                .uri("/api/v1/mcp-servers")
                .method(Method::POST)
                .header("content-type", "application/json")
                .body(Body::from(
                    json!({
                        "name": "test-http-mcp",
                        "server_type": "http",
                        "url": "http://localhost:8080/mcp",
                        "headers": "{\"Authorization\":\"Bearer test-token\"}",
                        "enabled": true
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::CREATED);

    let body = body_json(response).await;
    assert_eq!(body["name"], "test-http-mcp");
    assert_eq!(body["server_type"], "http");
    assert_eq!(body["url"], "http://localhost:8080/mcp");
}

#[tokio::test]
async fn create_global_mcp_server_with_null_profile_id() {
    let app = build_rest_app(test_state());

    let response = app
        .oneshot(
            Request::builder()
                .uri("/api/v1/mcp-servers")
                .method(Method::POST)
                .header("content-type", "application/json")
                .body(Body::from(
                    json!({
                        "profile_id": null,
                        "name": "global-mcp",
                        "server_type": "stdio",
                        "command": "npx",
                        "args": "[]",
                        "enabled": true
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::CREATED);

    let body = body_json(response).await;
    assert!(
        body["profile_id"].is_null(),
        "profile_id should be null for global MCP"
    );
}

#[tokio::test]
async fn create_profile_specific_mcp_server() {
    let app = build_rest_app(test_state());

    let response = app
        .oneshot(
            Request::builder()
                .uri("/api/v1/mcp-servers")
                .method(Method::POST)
                .header("content-type", "application/json")
                .body(Body::from(
                    json!({
                        "profile_id": "agent_profile_123",
                        "name": "profile-mcp",
                        "server_type": "stdio",
                        "command": "npx",
                        "args": "[]",
                        "enabled": true
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::CREATED);

    let body = body_json(response).await;
    assert_eq!(body["profile_id"], "agent_profile_123");
}

// ════════════════════════════════════════════════════════════════════════════
// Validation tests
// ════════════════════════════════════════════════════════════════════════════

#[tokio::test]
async fn create_mcp_server_invalid_server_type_returns_400() {
    let app = build_rest_app(test_state());

    let response = app
        .oneshot(
            Request::builder()
                .uri("/api/v1/mcp-servers")
                .method(Method::POST)
                .header("content-type", "application/json")
                .body(Body::from(
                    json!({
                        "name": "bad-mcp",
                        "server_type": "invalid_type",
                        "command": "npx"
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::BAD_REQUEST);

    let body = body_json(response).await;
    assert!(body["error"]
        .as_str()
        .unwrap()
        .contains("Invalid server_type"));
}

#[tokio::test]
async fn create_stdio_mcp_server_without_command_returns_400() {
    let app = build_rest_app(test_state());

    let response = app
        .oneshot(
            Request::builder()
                .uri("/api/v1/mcp-servers")
                .method(Method::POST)
                .header("content-type", "application/json")
                .body(Body::from(
                    json!({
                        "name": "bad-stdio",
                        "server_type": "stdio"
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::BAD_REQUEST);

    let body = body_json(response).await;
    assert!(body["error"]
        .as_str()
        .unwrap()
        .contains("require a 'command'"));
}

#[tokio::test]
async fn create_http_mcp_server_without_url_returns_400() {
    let app = build_rest_app(test_state());

    let response = app
        .oneshot(
            Request::builder()
                .uri("/api/v1/mcp-servers")
                .method(Method::POST)
                .header("content-type", "application/json")
                .body(Body::from(
                    json!({
                        "name": "bad-http",
                        "server_type": "http"
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::BAD_REQUEST);

    let body = body_json(response).await;
    assert!(body["error"].as_str().unwrap().contains("require a 'url'"));
}

#[tokio::test]
async fn create_mcp_server_invalid_args_json_returns_400() {
    let app = build_rest_app(test_state());

    let response = app
        .oneshot(
            Request::builder()
                .uri("/api/v1/mcp-servers")
                .method(Method::POST)
                .header("content-type", "application/json")
                .body(Body::from(
                    json!({
                        "name": "bad-json",
                        "server_type": "stdio",
                        "command": "npx",
                        "args": "not-valid-json"
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::BAD_REQUEST);

    let body = body_json(response).await;
    assert!(body["error"]
        .as_str()
        .unwrap()
        .contains("Invalid 'args' JSON"));
}

#[tokio::test]
async fn create_mcp_server_duplicate_name_returns_409() {
    // Create first server with a specific profile_id (NULL profile_id doesn't trigger UNIQUE in SQLite)
    let app = build_rest_app(test_state());
    let response = app
        .oneshot(
            Request::builder()
                .uri("/api/v1/mcp-servers")
                .method(Method::POST)
                .header("content-type", "application/json")
                .body(Body::from(
                    json!({
                        "profile_id": "duplicate-test-profile",
                        "name": "duplicate-test",
                        "server_type": "stdio",
                        "command": "npx",
                        "args": "[]"
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::CREATED);

    // Try to create duplicate with same profile_id and name
    let app = build_rest_app(test_state());
    let response = app
        .oneshot(
            Request::builder()
                .uri("/api/v1/mcp-servers")
                .method(Method::POST)
                .header("content-type", "application/json")
                .body(Body::from(
                    json!({
                        "profile_id": "duplicate-test-profile",
                        "name": "duplicate-test",
                        "server_type": "stdio",
                        "command": "npx",
                        "args": "[]"
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(
        response.status(),
        StatusCode::CONFLICT,
        "duplicate name within same profile should return 409"
    );
}

// ════════════════════════════════════════════════════════════════════════════
// LIST tests
// ════════════════════════════════════════════════════════════════════════════

#[tokio::test]
async fn list_mcp_servers_returns_all() {
    // Create two servers first
    let app = build_rest_app(test_state());
    let response = app
        .oneshot(
            Request::builder()
                .uri("/api/v1/mcp-servers")
                .method(Method::POST)
                .header("content-type", "application/json")
                .body(Body::from(
                    json!({
                        "name": "list-test-1",
                        "server_type": "stdio",
                        "command": "npx",
                        "args": "[]"
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::CREATED);

    let app = build_rest_app(test_state());
    let response = app
        .oneshot(
            Request::builder()
                .uri("/api/v1/mcp-servers")
                .method(Method::POST)
                .header("content-type", "application/json")
                .body(Body::from(
                    json!({
                        "name": "list-test-2",
                        "server_type": "http",
                        "url": "http://localhost:9999"
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::CREATED);

    // List all
    let app = build_rest_app(test_state());
    let response = app
        .oneshot(
            Request::builder()
                .uri("/api/v1/mcp-servers")
                .method(Method::GET)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);

    let body = body_json(response).await;
    let servers = body["servers"]
        .as_array()
        .expect("servers should be an array");
    assert!(
        servers.len() >= 2,
        "should have at least 2 servers, got {}",
        servers.len()
    );
}

#[tokio::test]
async fn list_mcp_servers_filter_by_enabled() {
    // Create an enabled server
    let app = build_rest_app(test_state());
    let response = app
        .oneshot(
            Request::builder()
                .uri("/api/v1/mcp-servers")
                .method(Method::POST)
                .header("content-type", "application/json")
                .body(Body::from(
                    json!({
                        "name": "enabled-filter-test",
                        "server_type": "stdio",
                        "command": "npx",
                        "args": "[]",
                        "enabled": true
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::CREATED);
    let server_id = body_json(response).await["id"].as_i64().unwrap();

    // List with enabled=true filter
    let app = build_rest_app(test_state());
    let response = app
        .oneshot(
            Request::builder()
                .uri("/api/v1/mcp-servers?enabled=true")
                .method(Method::GET)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);

    let body = body_json(response).await;
    let servers = body["servers"]
        .as_array()
        .expect("servers should be an array");
    let found = servers.iter().any(|s| s["id"].as_i64() == Some(server_id));
    assert!(found, "enabled server should be in filtered results");
}

// ════════════════════════════════════════════════════════════════════════════
// GET by ID tests
// ════════════════════════════════════════════════════════════════════════════

#[tokio::test]
async fn get_mcp_server_by_id_returns_200() {
    // Create a server first
    let app = build_rest_app(test_state());
    let response = app
        .oneshot(
            Request::builder()
                .uri("/api/v1/mcp-servers")
                .method(Method::POST)
                .header("content-type", "application/json")
                .body(Body::from(
                    json!({
                        "name": "get-by-id-test",
                        "server_type": "stdio",
                        "command": "npx",
                        "args": "[]"
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::CREATED);
    let created = body_json(response).await;
    let server_id = created["id"].as_i64().unwrap();

    // Get by ID
    let app = build_rest_app(test_state());
    let response = app
        .oneshot(
            Request::builder()
                .uri(format!("/api/v1/mcp-servers/{}", server_id))
                .method(Method::GET)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);

    let body = body_json(response).await;
    assert_eq!(body["id"], server_id);
    assert_eq!(body["name"], "get-by-id-test");
}

#[tokio::test]
async fn get_mcp_server_nonexistent_id_returns_404() {
    let app = build_rest_app(test_state());
    let response = app
        .oneshot(
            Request::builder()
                .uri("/api/v1/mcp-servers/999999999999")
                .method(Method::GET)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::NOT_FOUND);

    let body = body_json(response).await;
    assert!(body["error"].as_str().unwrap().contains("not found"));
}

// ════════════════════════════════════════════════════════════════════════════
// UPDATE tests
// ════════════════════════════════════════════════════════════════════════════

#[tokio::test]
async fn update_mcp_server_returns_200() {
    // Create a server first
    let app = build_rest_app(test_state());
    let response = app
        .oneshot(
            Request::builder()
                .uri("/api/v1/mcp-servers")
                .method(Method::POST)
                .header("content-type", "application/json")
                .body(Body::from(
                    json!({
                        "name": "update-test",
                        "server_type": "stdio",
                        "command": "npx",
                        "args": "[]",
                        "enabled": true
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::CREATED);
    let server_id = body_json(response).await["id"].as_i64().unwrap();

    // Update the server
    let app = build_rest_app(test_state());
    let response = app
        .oneshot(
            Request::builder()
                .uri(format!("/api/v1/mcp-servers/{}", server_id))
                .method(Method::PUT)
                .header("content-type", "application/json")
                .body(Body::from(
                    json!({
                        "name": "updated-name",
                        "enabled": false
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);

    let body = body_json(response).await;
    assert_eq!(body["name"], "updated-name");
    assert!(
        !body["enabled"].as_bool().unwrap(),
        "enabled should be false after update"
    );
    assert_eq!(
        body["server_type"], "stdio",
        "unchanged fields should remain"
    );
}

#[tokio::test]
async fn update_mcp_server_nonexistent_returns_404() {
    let app = build_rest_app(test_state());
    let response = app
        .oneshot(
            Request::builder()
                .uri("/api/v1/mcp-servers/999999999999")
                .method(Method::PUT)
                .header("content-type", "application/json")
                .body(Body::from(json!({"name": "nope"}).to_string()))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::NOT_FOUND);
}

// ════════════════════════════════════════════════════════════════════════════
// DELETE tests
// ════════════════════════════════════════════════════════════════════════════

#[tokio::test]
async fn delete_mcp_server_returns_204() {
    // Create a server first
    let app = build_rest_app(test_state());
    let response = app
        .oneshot(
            Request::builder()
                .uri("/api/v1/mcp-servers")
                .method(Method::POST)
                .header("content-type", "application/json")
                .body(Body::from(
                    json!({
                        "name": "delete-test",
                        "server_type": "stdio",
                        "command": "npx",
                        "args": "[]"
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::CREATED);
    let server_id = body_json(response).await["id"].as_i64().unwrap();

    // Delete the server
    let app = build_rest_app(test_state());
    let response = app
        .oneshot(
            Request::builder()
                .uri(format!("/api/v1/mcp-servers/{}", server_id))
                .method(Method::DELETE)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(
        response.status(),
        StatusCode::NO_CONTENT,
        "delete should return 204"
    );

    // Verify it's gone
    let app = build_rest_app(test_state());
    let response = app
        .oneshot(
            Request::builder()
                .uri(format!("/api/v1/mcp-servers/{}", server_id))
                .method(Method::GET)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn delete_mcp_server_nonexistent_returns_404() {
    let app = build_rest_app(test_state());
    let response = app
        .oneshot(
            Request::builder()
                .uri("/api/v1/mcp-servers/999999999999")
                .method(Method::DELETE)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::NOT_FOUND);
}

// ════════════════════════════════════════════════════════════════════════════
// FOR-PROFILE tests
// ════════════════════════════════════════════════════════════════════════════

#[tokio::test]
async fn list_mcp_servers_for_profile_includes_global() {
    // Create a global server
    let app = build_rest_app(test_state());
    let response = app
        .oneshot(
            Request::builder()
                .uri("/api/v1/mcp-servers")
                .method(Method::POST)
                .header("content-type", "application/json")
                .body(Body::from(
                    json!({
                        "profile_id": null,
                        "name": "global-for-profile-test",
                        "server_type": "stdio",
                        "command": "npx",
                        "args": "[]",
                        "enabled": true
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::CREATED);

    // Create a profile-specific server
    let app = build_rest_app(test_state());
    let response = app
        .oneshot(
            Request::builder()
                .uri("/api/v1/mcp-servers")
                .method(Method::POST)
                .header("content-type", "application/json")
                .body(Body::from(
                    json!({
                        "profile_id": "test-profile-abc",
                        "name": "profile-for-profile-test",
                        "server_type": "stdio",
                        "command": "npx",
                        "args": "[]",
                        "enabled": true
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::CREATED);

    // Query for-profile endpoint
    let app = build_rest_app(test_state());
    let response = app
        .oneshot(
            Request::builder()
                .uri("/api/v1/mcp-servers/for-profile/test-profile-abc")
                .method(Method::GET)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);

    let body = body_json(response).await;
    let servers = body["servers"]
        .as_array()
        .expect("servers should be an array");

    // Should include both global and profile-specific
    let names: Vec<&str> = servers.iter().filter_map(|s| s["name"].as_str()).collect();

    assert!(
        names.contains(&"global-for-profile-test"),
        "for-profile should include global servers, got: {:?}",
        names
    );
    assert!(
        names.contains(&"profile-for-profile-test"),
        "for-profile should include profile-specific servers, got: {:?}",
        names
    );
}

#[tokio::test]
async fn list_mcp_servers_for_global_profile_id() {
    // Create a global server
    let app = build_rest_app(test_state());
    let response = app
        .oneshot(
            Request::builder()
                .uri("/api/v1/mcp-servers")
                .method(Method::POST)
                .header("content-type", "application/json")
                .body(Body::from(
                    json!({
                        "profile_id": null,
                        "name": "global-only-test",
                        "server_type": "stdio",
                        "command": "npx",
                        "args": "[]",
                        "enabled": true
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::CREATED);

    // Query with "global" profile_id
    let app = build_rest_app(test_state());
    let response = app
        .oneshot(
            Request::builder()
                .uri("/api/v1/mcp-servers/for-profile/global")
                .method(Method::GET)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);

    let body = body_json(response).await;
    let servers = body["servers"]
        .as_array()
        .expect("servers should be an array");

    // All servers should have profile_id = null (global)
    for server in servers {
        assert!(
            server["profile_id"].is_null(),
            "for-profile/global should only return global servers, but found: {:?}",
            server["profile_id"]
        );
    }
}

#[tokio::test]
async fn list_mcp_servers_for_profile_excludes_disabled() {
    // Create a disabled server
    let app = build_rest_app(test_state());
    let response = app
        .oneshot(
            Request::builder()
                .uri("/api/v1/mcp-servers")
                .method(Method::POST)
                .header("content-type", "application/json")
                .body(Body::from(
                    json!({
                        "profile_id": "disabled-test-profile",
                        "name": "disabled-server-test",
                        "server_type": "stdio",
                        "command": "npx",
                        "args": "[]",
                        "enabled": false
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::CREATED);

    // Query for-profile endpoint
    let app = build_rest_app(test_state());
    let response = app
        .oneshot(
            Request::builder()
                .uri("/api/v1/mcp-servers/for-profile/disabled-test-profile")
                .method(Method::GET)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);

    let body = body_json(response).await;
    let servers = body["servers"]
        .as_array()
        .expect("servers should be an array");

    // Should not include the disabled server
    let names: Vec<&str> = servers.iter().filter_map(|s| s["name"].as_str()).collect();

    assert!(
        !names.contains(&"disabled-server-test"),
        "for-profile should exclude disabled servers, got: {:?}",
        names
    );
}
