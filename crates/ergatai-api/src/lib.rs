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
pub mod lock_permission;
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
    APP_STATE
        .get()
        .expect("AppState not initialized — call app_state_with_token first")
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

/// Build the REST API router (without MCP services and static files).
/// MCP services are nested separately in main.rs.
/// Static files are served separately in main.rs to avoid rate limiting.
pub fn build_rest_app(state: AppState) -> Router {
    // API routes
    Router::new()
        .route("/health", get(health_check))
        .route("/ready", get(readiness_check))
        .route("/metrics", get(metrics_endpoint))
        .route("/api/v1/workspaces", get(api::workspaces::list_workspaces))
        .route(
            "/api/v1/workspaces",
            post(api::workspaces::create_workspace),
        )
        .route(
            "/api/v1/workspaces/:id",
            delete(api::workspaces::delete_workspace),
        )
        .route("/api/v1/agents", get(api::agents::list_agents))
        .route("/api/v1/agents", post(api::agents::spawn_agent))
        .route("/api/v1/agents/:id", delete(api::agents::kill_agent))
        .route(
            "/api/v1/agents/:id/message",
            post(api::agents::send_message),
        )
        .route(
            "/api/v1/agents/:id/cancel",
            post(api::agents::cancel_prompt),
        )
        // ACP monitoring endpoints
        .route(
            "/api/v1/agents/:id/thoughts",
            get(api::agents::get_agent_thoughts),
        )
        .route(
            "/api/v1/agents/:id/tool-calls",
            get(api::agents::get_agent_tool_calls),
        )
        .route(
            "/api/v1/agents/:id/plan",
            get(api::agents::get_agent_plan),
        )
        .route(
            "/api/v1/agents/:id/elicitations",
            get(api::agents::get_agent_elicitations),
        )
        .route(
            "/api/v1/agents/:id/elicitations/:elicitation_id/respond",
            post(api::agents::respond_to_elicitation),
        )
        .route(
            "/api/v1/agents/:id/config-options",
            get(api::agents::get_agent_config_options),
        )
        .route(
            "/api/v1/agents/:id/commands",
            get(api::agents::get_agent_available_commands),
        )
        .route(
            "/api/v1/agents/:id/usage",
            get(api::agents::get_agent_usage),
        )
        .route(
            "/api/v1/agent-profiles",
            get(api::agent_profiles::list_profiles),
        )
        .route(
            "/api/v1/agent-profiles",
            post(api::agent_profiles::register_profile),
        )
        .route(
            "/api/v1/agent-profiles/:name",
            get(api::agent_profiles::get_profile),
        )
        .route(
            "/api/v1/agent-profiles/:name",
            delete(api::agent_profiles::delete_profile),
        )
        .route("/api/v1/status", get(api::status::get_status))
        .route("/api/v1/locks", get(api::locks::list_locks))
        .route("/api/v1/locks/audit", get(api::locks::list_audit))
        .route(
            "/api/v1/locks/contention",
            get(api::locks::get_lock_contention),
        )
        .route(
            "/api/v1/conversations",
            get(api::conversations::list_conversations),
        )
        .route(
            "/api/v1/conversations/:id",
            get(api::conversations::get_conversation_detail),
        )
        .route(
            "/api/v1/stats/message-types",
            get(api::conversations::get_message_type_stats),
        )
        .route(
            "/api/v1/activity/recent",
            get(api::activity_routes::get_recent_events),
        )
        .route(
            "/api/v1/activity/stream",
            get(api::activity_routes::stream_events),
        )
        .route("/api/v1/dag", post(submit_dag))
        .route("/api/v1/dag/status", get(dag_status))
        .route("/api/v1/dag/visualization", get(dag_visualization))
        .route("/api/v1/dag/metrics", get(dag_metrics))
        .route("/api/v1/dags", get(list_dags))
        .with_state(state.clone())
        // Auth middleware (exempts /health, /ready, /metrics)
        .layer(middleware::from_fn_with_state(
            state.clone(),
            auth_middleware,
        ))
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
    // Exempt: health probes, metrics, and dashboard static assets
    if path == "/health"
        || path == "/ready"
        || path == "/metrics"
        || path == "/"
        || path == "/logo.png"
        || path.starts_with("/css/")
        || path.starts_with("/js/")
        || path.starts_with("/favicon")
    {
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

#[derive(Serialize)]
struct DagVisualizationNode {
    id: String,
    agent: String,
    task: String,
    status: String,
    depends_on: Vec<String>,
    x: f32,
    y: f32,
    layer: u32,
}

#[derive(Serialize)]
struct DagVisualizationResponse {
    dag_id: String,
    nodes: Vec<DagVisualizationNode>,
    edges: Vec<DagEdge>,
}

#[derive(Serialize)]
struct DagEdge {
    from: String,
    to: String,
}

async fn dag_visualization(Query(query): Query<DagStatusQuery>) -> impl IntoResponse {
    let scheduler: Option<DagScheduler> = if let Some(dag_id) = &query.dag_id {
        get_dag_scheduler_by_id(Some(dag_id))
    } else {
        get_dag_scheduler()
    };

    let Some(scheduler) = scheduler else {
        return Json(DagVisualizationResponse {
            dag_id: String::new(),
            nodes: Vec::new(),
            edges: Vec::new(),
        });
    };

    let dag_id = scheduler.dag_id().to_string();

    // Parse graph snapshot
    let nodes = match scheduler.graph_snapshot().await {
        Ok(snapshot_json) => {
            if let Ok(snapshot) = serde_json::from_str::<serde_json::Value>(&snapshot_json) {
                if let Some(nodes_array) = snapshot.get("nodes").and_then(|n| n.as_array()) {
                    nodes_array
                        .iter()
                        .filter_map(|node| {
                            Some((
                                node.get("id")?.as_str()?.to_string(),
                                node.get("agent")?.as_str()?.to_string(),
                                node.get("task")?.as_str()?.to_string(),
                                node.get("status")?.as_str()?.to_string(),
                                node.get("depends_on")
                                    .and_then(|d| d.as_array())
                                    .map(|arr| {
                                        arr.iter()
                                            .filter_map(|v| v.as_str().map(String::from))
                                            .collect::<Vec<String>>()
                                    })
                                    .unwrap_or_default(),
                            ))
                        })
                        .collect::<Vec<_>>()
                } else {
                    Vec::new()
                }
            } else {
                Vec::new()
            }
        }
        Err(_) => Vec::new(),
    };

    // Calculate layers using topological sort (BFS from root nodes)
    let mut node_layers: std::collections::HashMap<String, u32> = std::collections::HashMap::new();
    let mut queue: std::collections::VecDeque<(String, u32)> = std::collections::VecDeque::new();

    // Find root nodes (no dependencies)
    for (id, _, _, _, deps) in &nodes {
        if deps.is_empty() {
            queue.push_back((id.clone(), 0));
        }
    }

    // BFS to assign layers — FIFO ensures shortest path (minimum layer) is found first
    while let Some((id, layer)) = queue.pop_front() {
        if let Some(&existing_layer) = node_layers.get(&id) {
            // Skip if we already found a shorter or equal path
            if existing_layer <= layer {
                continue;
            }
        }
        node_layers.insert(id.clone(), layer);

        // Find nodes that depend on this one
        for (other_id, _, _, _, deps) in &nodes {
            if deps.contains(&id) {
                queue.push_back((other_id.clone(), layer + 1));
            }
        }
    }

    // Group nodes by layer
    let mut layer_groups: std::collections::HashMap<u32, Vec<usize>> =
        std::collections::HashMap::new();
    for (idx, (id, _, _, _, _)) in nodes.iter().enumerate() {
        let layer = node_layers.get(id).copied().unwrap_or(0);
        layer_groups.entry(layer).or_default().push(idx);
    }

    // Calculate positions
    let layer_spacing = 150.0;
    let node_spacing = 100.0;
    let mut visualization_nodes = Vec::new();

    for (layer, indices) in &layer_groups {
        let layer_width = indices.len() as f32 * node_spacing;
        let start_x = -layer_width / 2.0 + node_spacing / 2.0;

        for (pos, idx) in indices.iter().enumerate() {
            let (id, agent, task, status, deps) = &nodes[*idx];
            visualization_nodes.push(DagVisualizationNode {
                id: id.clone(),
                agent: agent.clone(),
                task: task.clone(),
                status: status.clone(),
                depends_on: deps.clone(),
                x: start_x + pos as f32 * node_spacing,
                y: *layer as f32 * layer_spacing,
                layer: *layer,
            });
        }
    }

    // Build edges
    let mut edges = Vec::new();
    for (id, _, _, _, deps) in &nodes {
        for dep in deps {
            edges.push(DagEdge {
                from: dep.clone(),
                to: id.clone(),
            });
        }
    }

    Json(DagVisualizationResponse {
        dag_id,
        nodes: visualization_nodes,
        edges,
    })
}

#[derive(Serialize)]
struct DagMetrics {
    total_nodes: u32,
    completed_nodes: u32,
    failed_nodes: u32,
    running_nodes: u32,
    pending_nodes: u32,
    avg_completion_time_secs: Option<f32>,
}

async fn dag_metrics(Query(query): Query<DagStatusQuery>) -> impl IntoResponse {
    let scheduler: Option<DagScheduler> = if let Some(dag_id) = &query.dag_id {
        get_dag_scheduler_by_id(Some(dag_id))
    } else {
        get_dag_scheduler()
    };

    let Some(scheduler) = scheduler else {
        return Json(DagMetrics {
            total_nodes: 0,
            completed_nodes: 0,
            failed_nodes: 0,
            running_nodes: 0,
            pending_nodes: 0,
            avg_completion_time_secs: None,
        });
    };

    let nodes = match scheduler.graph_snapshot().await {
        Ok(snapshot_json) => {
            if let Ok(snapshot) = serde_json::from_str::<serde_json::Value>(&snapshot_json) {
                if let Some(nodes_array) = snapshot.get("nodes").and_then(|n| n.as_array()) {
                    nodes_array
                        .iter()
                        .filter_map(|node| node.get("status")?.as_str().map(|s| s.to_string()))
                        .collect::<Vec<String>>()
                } else {
                    Vec::new()
                }
            } else {
                Vec::new()
            }
        }
        Err(_) => Vec::new(),
    };

    let total_nodes = nodes.len() as u32;
    let completed_nodes = nodes.iter().filter(|s| s.as_str() == "completed").count() as u32;
    let failed_nodes = nodes.iter().filter(|s| s.as_str() == "failed").count() as u32;
    let running_nodes = nodes.iter().filter(|s| s.as_str() == "running").count() as u32;
    let pending_nodes = nodes.iter().filter(|s| s.as_str() == "pending").count() as u32;

    Json(DagMetrics {
        total_nodes,
        completed_nodes,
        failed_nodes,
        running_nodes,
        pending_nodes,
        avg_completion_time_secs: None, // TODO: Calculate from timestamps
    })
}
