//! Ergatai API Library — shared types, handlers, and router construction.
//!
//! This library is used by the `ergatai-server` binary and by integration tests.
//! It contains all HTTP/MCP handler logic, AppState, and middleware.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};

use axum::{
    body::Body,
    extract::{Query, State},
    http::{header, Request, StatusCode},
    middleware::{self, Next},
    response::IntoResponse,
    routing::{delete, get, post},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use tokio::sync::broadcast;

use ergatai_core::cross_agent::{
    get_dag_scheduler, get_dag_scheduler_by_id, list_dag_schedulers, set_dag_scheduler,
    DagScheduler,
};
use ergatai_core::nats;

pub mod api;
pub mod mcp;
pub mod messaging;

// ── AppState ─────────────────────────────────────────────────────────

/// Shared application state available to all handlers.
#[derive(Clone)]
pub struct AppState {
    /// Default working directory for new workspaces when the request does not
    /// provide one. Falls back to the process cwd.
    pub default_cwd: String,
    /// Optional API token for authentication. If set, all requests must include
    /// an `Authorization: Bearer <token>` header.
    pub api_token: Option<String>,
    /// Broadcast channel for WebSocket event broadcasting (CLI status monitoring).
    pub event_tx: Arc<broadcast::Sender<serde_json::Value>>,
}

static APP_STATE: OnceLock<AppState> = OnceLock::new();

/// Initialize the global AppState (called once at startup or in tests).
pub fn app_state_with_token(token: Option<String>) -> &'static AppState {
    APP_STATE.get_or_init(|| {
        let (event_tx, _) = broadcast::channel(1024);
        AppState {
            default_cwd: std::env::current_dir()
                .map(|p| p.to_string_lossy().to_string())
                .unwrap_or_else(|_| ".".to_string()),
            api_token: token,
            event_tx: Arc::new(event_tx),
        }
    })
}

/// Get the global AppState reference.
pub fn get_app_state() -> &'static AppState {
    APP_STATE.get().expect("AppState not initialized — call app_state_with_token first")
}

// ── Prometheus metrics ───────────────────────────────────────────────

/// Prometheus metrics handle, stored globally for /metrics endpoint access.
static PROMETHEUS_HANDLE: OnceLock<metrics_exporter_prometheus::PrometheusHandle> = OnceLock::new();

/// Initialize Prometheus metrics (called once at startup).
pub fn init_prometheus() -> Option<metrics_exporter_prometheus::PrometheusHandle> {
    let handle = metrics_exporter_prometheus::PrometheusBuilder::new()
        .install_recorder()
        .ok()?;
    let _ = PROMETHEUS_HANDLE.set(handle);
    PROMETHEUS_HANDLE.get().cloned()
}

// ── Error response ───────────────────────────────────────────────────

#[derive(Debug, Serialize)]
pub struct ErrorResponse {
    pub error: String,
}

// ── Router construction ──────────────────────────────────────────────

/// Build the REST API router (without MCP services).
/// MCP services are nested separately in main.rs.
pub fn build_rest_app(state: AppState) -> Router {
    Router::new()
        // Health / readiness / metrics
        .route("/health", get(health_check))
        .route("/ready", get(readiness_check))
        .route("/metrics", get(metrics_endpoint))
        // Workspace management
        .route("/api/v1/workspaces", get(api::workspaces::list_workspaces))
        .route("/api/v1/workspaces", post(api::workspaces::create_workspace))
        .route(
            "/api/v1/workspaces/:id",
            delete(api::workspaces::delete_workspace),
        )
        // Agent management
        .route("/api/v1/agents", get(api::agents::list_agents))
        .route("/api/v1/agents", post(api::agents::spawn_agent))
        .route("/api/v1/agents/:id", delete(api::agents::kill_agent))
        .route(
            "/api/v1/agents/:id/message",
            post(api::agents::send_message),
        )
        // Status
        .route("/api/v1/status", get(api::status::get_status))
        // DAG
        .route("/api/v1/dag", post(submit_dag))
        .route("/api/v1/dag/status", get(dag_status))
        .route("/api/v1/dags", get(list_dags))
        // Auth middleware (exempts /health, /ready, /metrics)
        .layer(middleware::from_fn_with_state(
            state.clone(),
            auth_middleware,
        ))
        .with_state(state)
}

// ── Health / readiness / metrics handlers ────────────────────────────

async fn health_check() -> impl IntoResponse {
    metrics::counter!("api_requests_total", "endpoint" => "health").increment(1);

    let mut checks = serde_json::Map::new();
    let mut all_healthy = true;

    let nats_ok = nats::is_nats_initialized().await;
    checks.insert("nats".to_string(), serde_json::Value::Bool(nats_ok));
    if !nats_ok {
        all_healthy = false;
    }

    let nats_connected = if let Some(conn) = nats::get_nats_connection().await {
        conn.is_connected()
    } else {
        false
    };
    checks.insert(
        "nats_connected".to_string(),
        serde_json::Value::Bool(nats_connected),
    );
    if !nats_connected {
        all_healthy = false;
    }

    let nats_port = nats::get_nats_server_port().await;
    checks.insert(
        "nats_port".to_string(),
        serde_json::Value::Number(nats_port.map(|p| p as u64).unwrap_or(0).into()),
    );

    let status = if all_healthy { "healthy" } else { "unhealthy" };
    let status_code = if all_healthy {
        StatusCode::OK
    } else {
        StatusCode::SERVICE_UNAVAILABLE
    };

    (
        status_code,
        Json(serde_json::json!({
            "status": status,
            "checks": checks,
            "timestamp": chrono::Utc::now().to_rfc3339(),
        })),
    )
}

async fn readiness_check() -> impl IntoResponse {
    let nats_ready = nats::is_nats_initialized().await
        && nats::get_nats_connection()
            .await
            .map(|c| c.is_ready())
            .unwrap_or(false);

    if nats_ready {
        (StatusCode::OK, Json(serde_json::json!({"ready": true})))
    } else {
        (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(serde_json::json!({"ready": false})),
        )
    }
}

async fn metrics_endpoint() -> impl IntoResponse {
    match PROMETHEUS_HANDLE.get() {
        Some(handle) => {
            let output = handle.render();
            (
                StatusCode::OK,
                [(
                    header::CONTENT_TYPE,
                    "text/plain; version=0.0.4; charset=utf-8",
                )],
                output,
            )
                .into_response()
        }
        None => (StatusCode::INTERNAL_SERVER_ERROR, "Metrics not initialized").into_response(),
    }
}

// ── Auth middleware ───────────────────────────────────────────────────

/// Authentication middleware. If an API token is configured, requires all
/// requests to include a valid `Authorization: Bearer <token>` header.
/// Health check, readiness, and metrics endpoints are exempt.
pub async fn auth_middleware(
    State(state): State<AppState>,
    request: Request<Body>,
    next: Next,
) -> impl IntoResponse {
    let path = request.uri().path();
    if path == "/health" || path == "/ready" || path == "/metrics" {
        return next.run(request).await.into_response();
    }

    let Some(expected_token) = &state.api_token else {
        return next.run(request).await.into_response();
    };

    let auth_header = request
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok());

    let is_valid = auth_header
        .and_then(|h| h.strip_prefix("Bearer "))
        .map(|token| token == expected_token.as_str())
        .unwrap_or(false);

    if !is_valid {
        return (
            StatusCode::UNAUTHORIZED,
            Json(ErrorResponse {
                error: "Invalid or missing API token. Provide via Authorization: Bearer <token>"
                    .to_string(),
            }),
        )
            .into_response();
    }

    next.run(request).await.into_response()
}

// ── CWD validation ───────────────────────────────────────────────────

/// Validate and canonicalize a working directory path.
#[allow(dead_code)]
pub fn validate_cwd(cwd: &str) -> anyhow::Result<PathBuf, String> {
    let path = Path::new(cwd);

    for component in path.components() {
        if matches!(component, std::path::Component::ParentDir) {
            return Err("Path traversal (..) not allowed in cwd".to_string());
        }
    }

    let canonical =
        std::fs::canonicalize(path).map_err(|e| format!("Invalid cwd '{}': {}", cwd, e))?;

    if !canonical.is_dir() {
        return Err(format!("cwd '{}' is not a directory", cwd));
    }

    Ok(canonical)
}

// ── Request / response types ─────────────────────────────────────────

#[derive(Debug, Deserialize)]
#[allow(dead_code)]
struct CreateChatRequest {
    agent: String,
    #[serde(default)]
    cwd: Option<String>,
}

#[derive(Debug, Serialize)]
#[allow(dead_code)]
struct CreateChatResponse {
    session_id: String,
    agent: String,
    cwd: String,
}

#[derive(Debug, Serialize)]
#[allow(dead_code)]
struct AgentSummary {
    name: String,
    source: String,
    available: bool,
}

#[derive(Debug, Serialize)]
struct NodeStatusInfo {
    id: String,
    agent: String,
    task: String,
    status: String,
    depends_on: Vec<String>,
    output: Option<serde_json::Value>,
}

#[derive(Debug, Serialize)]
struct DagStatusResponse {
    running: bool,
    progress: Option<f32>,
    status_prompt: Option<String>,
    is_complete: Option<bool>,
    nodes: Option<Vec<NodeStatusInfo>>,
}

// ── DAG handlers ─────────────────────────────────────────────────────

#[derive(Deserialize)]
struct SubmitDagRequest {
    definition: String,
    #[serde(default)]
    parameters: Option<HashMap<String, serde_json::Value>>,
}

async fn submit_dag(body: String) -> impl IntoResponse {
    if let Some(existing) = get_dag_scheduler() {
        if !existing.is_complete().await {
            return (
                StatusCode::CONFLICT,
                Json(serde_json::json!({
                    "error": "A DAG is already running. Wait for completion or check status.",
                })),
            );
        }
    }

    let (definition, parameters) = if let Ok(req) = serde_json::from_str::<SubmitDagRequest>(&body)
    {
        (req.definition, req.parameters)
    } else {
        (body, None)
    };

    let graph = match ergatai_core::orchestration::parse_dag_auto(&definition, parameters) {
        Ok(g) => g,
        Err(e) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({
                    "error": format!("Failed to parse DAG definition: {}", e),
                })),
            );
        }
    };

    let state = get_app_state();
    let project_root = PathBuf::from(&state.default_cwd);
    let scheduler = DagScheduler::new(project_root, graph);

    set_dag_scheduler(scheduler.clone());
    scheduler.clone().start_event_listener();

    match scheduler.submit_graph().await {
        Ok(submitted) => (
            StatusCode::OK,
            Json(serde_json::json!({
                "status": "submitted",
                "submitted_nodes": submitted.len(),
            })),
        ),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({
                "error": format!("Failed to submit DAG: {}", e),
            })),
        ),
    }
}

#[derive(Deserialize)]
struct DagStatusQuery {
    dag_id: Option<String>,
}

async fn dag_status(Query(query): Query<DagStatusQuery>) -> impl IntoResponse {
    let scheduler: Option<DagScheduler> = if let Some(dag_id) = &query.dag_id {
        get_dag_scheduler_by_id(Some(dag_id))
    } else {
        get_dag_scheduler()
    };

    let Some(scheduler) = scheduler else {
        return Json(DagStatusResponse {
            running: false,
            progress: None,
            status_prompt: None,
            is_complete: None,
            nodes: None,
        });
    };

    let progress = scheduler.progress().await;
    let status_prompt = scheduler.status_prompt().await;
    let is_complete = scheduler.is_complete().await;

    let nodes = match scheduler.graph_snapshot().await {
        Ok(snapshot_json) => {
            if let Ok(snapshot) = serde_json::from_str::<serde_json::Value>(&snapshot_json) {
                if let Some(nodes_array) = snapshot.get("nodes").and_then(|n| n.as_array()) {
                    let nodes_info: Vec<NodeStatusInfo> = nodes_array
                        .iter()
                        .filter_map(|node| {
                            Some(NodeStatusInfo {
                                id: node.get("id")?.as_str()?.to_string(),
                                agent: node.get("agent")?.as_str()?.to_string(),
                                task: node.get("task")?.as_str()?.to_string(),
                                status: node.get("status")?.as_str()?.to_string(),
                                depends_on: node
                                    .get("depends_on")
                                    .and_then(|d| d.as_array())
                                    .map(|arr| {
                                        arr.iter()
                                            .filter_map(|v| v.as_str().map(String::from))
                                            .collect()
                                    })
                                    .unwrap_or_default(),
                                output: None,
                            })
                        })
                        .collect();
                    Some(nodes_info)
                } else {
                    None
                }
            } else {
                None
            }
        }
        Err(_) => None,
    };

    Json(DagStatusResponse {
        running: true,
        progress: Some(progress),
        status_prompt: Some(status_prompt),
        is_complete: Some(is_complete),
        nodes,
    })
}

#[derive(Serialize)]
struct DagInfo {
    dag_id: String,
    progress: f32,
    is_complete: bool,
    status_prompt: String,
}

async fn list_dags() -> impl IntoResponse {
    let schedulers = list_dag_schedulers();

    let mut dags = Vec::new();
    for scheduler in schedulers {
        let progress = scheduler.progress().await;
        let is_complete = scheduler.is_complete().await;
        let status_prompt = scheduler.status_prompt().await;

        dags.push(DagInfo {
            dag_id: scheduler.dag_id().to_string(),
            progress,
            is_complete,
            status_prompt,
        });
    }

    Json(dags)
}
