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

use ergatai_core::nats;

pub mod api;
pub mod lock_permission;
pub mod mcp;

pub mod messaging;

pub mod services;

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
        .route(
            "/api/v1/agents/:id/prompt",
            post(api::agents::prompt_agent),
        )
        .route(
            "/api/v1/agents/:id/stream",
            get(api::agents::stream_agent_output),
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
        .route("/api/v1/agents/:id/plan", get(api::agents::get_agent_plan))
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
            "/api/v1/agents/:id/execute-command",
            post(api::agents::execute_agent_command),
        )
        .route(
            "/api/v1/agents/:id/sessions",
            get(api::agents::list_agent_sessions),
        )
        .route(
            "/api/v1/agents/:id/sessions",
            post(api::agents::create_agent_session),
        )
        .route(
            "/api/v1/agents/:id/sessions/:session_id",
            post(api::agents::load_agent_session),
        )
        .route(
            "/api/v1/agents/:id/sessions/:session_id",
            delete(api::agents::delete_agent_session),
        )
        .route(
            "/api/v1/agents/:id/usage",
            get(api::agents::get_agent_usage),
        )
        .route(
            "/api/v1/agents/:id/output",
            get(api::agents::get_agent_output),
        )
        .route(
            "/api/v1/agents/:id/last-output",
            get(api::agents::get_agent_last_output),
        )
        .route(
            "/api/v1/agents/:id/exit-code",
            get(api::agents::get_agent_exit_code),
        )
        .route(
            "/api/v1/agents/:id/pid",
            get(api::agents::get_agent_pid),
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
            "/api/v1/agent-profiles/with-status",
            get(api::agent_profiles::list_with_status),
        )
        .route(
            "/api/v1/agent-profiles/:name/install",
            post(api::agent_profiles::install_agent),
        )
        .route(
            "/api/v1/agent-profiles/:name/uninstall",
            delete(api::agent_profiles::uninstall_agent),
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
        .route(
            "/api/v1/system/config",
            get(api::status::get_backend_config),
        )
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
        .route("/api/v1/dag/validate", post(validate_dag))
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

    // SECURITY: Constant-time comparison to prevent timing attacks.
    // The `==` operator on strings short-circuits on first differing byte,
    // allowing an attacker to recover the token byte-by-byte via RTT measurement.
    let is_valid = auth_header
        .and_then(|h| h.strip_prefix("Bearer "))
        .map(|token| constant_time_eq(token, expected_token.as_str()))
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

/// Constant-time string comparison to prevent timing side-channel attacks.
///
/// Compares all bytes regardless of where they differ (including length), so an
/// attacker cannot recover the expected value byte-by-byte — nor its length —
/// via round-trip time measurement. Uses a `u8` accumulator OR'd with each
/// XOR'd byte pair so every byte is touched in the same number of cycles.
fn constant_time_eq(a: &str, b: &str) -> bool {
    let a_bytes = a.as_bytes();
    let b_bytes = b.as_bytes();

    // Include length difference in the accumulator so early-exit on mismatched
    // length is not observable — we still walk max(len_a, len_b) bytes.
    let mut diff = (a_bytes.len() ^ b_bytes.len()) as u8;
    let max_len = a_bytes.len().max(b_bytes.len());
    for i in 0..max_len {
        let x = *a_bytes.get(i).unwrap_or(&0);
        let y = *b_bytes.get(i).unwrap_or(&0);
        diff |= x ^ y;
    }
    diff == 0
}

// ── Error sanitization ────────────────────────────────────────────────

/// Sanitize an error and return the client-safe message string.
///
/// Logs the full error server-side (with its `{:?}` representation) and
/// returns a generic message suitable for inclusion in an HTTP response.
/// The caller wraps the returned string in its own `ErrorResponse` type.
///
/// # Arguments
///
/// * `err` - The internal error. Will be logged at ERROR level.
/// * `context` - Short description of what was happening when the error
///   occurred (e.g. `"create_workspace"`, `"spawn_agent"`). Used in the
///   server-side log and in the generic client message.
pub fn sanitize_error(err: &dyn std::fmt::Display, context: &str) -> String {
    // Log the full error server-side for debugging.
    tracing::error!(
        error = %err,
        error_context = context,
        "Internal error (details redacted from client response)"
    );
    format!("Internal error ({})", context)
}

/// Validate and canonicalize a working directory path.
///
/// SECURITY (P1 #13):
///   - Rejects `..` components (path-traversal guard)
///   - Requires the path to exist and be a directory (no mkdir from user input)
///   - Returns the canonical absolute path (symlinks resolved)
///   - When `ERGATAI_WORKSPACE_ROOT` is set, additionally requires the resolved
///     path to be a descendant of that root (workspace whitelist). This prevents
///     a client with API access from spawning agents in arbitrary host
///     directories such as `/etc`, `/root`, or another user's project.
pub fn validate_cwd(cwd: &str) -> anyhow::Result<PathBuf, String> {
    let path = Path::new(cwd);

    for component in path.components() {
        if matches!(component, std::path::Component::ParentDir) {
            return Err("Path traversal (..) not allowed in work_dir".to_string());
        }
    }

    let canonical = std::fs::canonicalize(path).map_err(|_| {
        format!(
            "Invalid work_dir '{}': does not exist or is not accessible",
            cwd
        )
    })?;

    if !canonical.is_dir() {
        return Err(format!("work_dir '{}' is not a directory", cwd));
    }

    // Optional whitelist: ERGATAI_WORKSPACE_ROOT restricts where agents may run.
    if let Ok(root) = std::env::var("ERGATAI_WORKSPACE_ROOT") {
        let root_path = Path::new(&root);
        let canonical_root = std::fs::canonicalize(root_path).map_err(|_| {
            // SECURITY: Do not echo ERGATAI_WORKSPACE_ROOT's value to the client —
            // it's a server-side configuration secret (reveals host directory layout).
            tracing::error!(
                root = %root,
                "ERGATAI_WORKSPACE_ROOT is not a valid directory"
            );
            "Server workspace root is misconfigured (contact administrator)".to_string()
        })?;
        if !canonical.starts_with(&canonical_root) {
            // SECURITY: Do not leak the canonical_root path to the client.
            // Log the details server-side for debugging.
            tracing::info!(
                requested = %canonical.display(),
                root = %canonical_root.display(),
                "work_dir rejected: outside ERGATAI_WORKSPACE_ROOT"
            );
            return Err(
                "work_dir is outside the allowed workspace root (see server logs)".to_string(),
            );
        }
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

// ── DAG handlers ─────────────────────────────────────────────────────

#[derive(Deserialize)]
struct SubmitDagRequest {
    definition: String,
    #[serde(default)]
    parameters: Option<HashMap<String, serde_json::Value>>,
}

async fn submit_dag(body: String) -> impl IntoResponse {
    let (definition, parameters) = if let Ok(req) = serde_json::from_str::<SubmitDagRequest>(&body)
    {
        (req.definition, req.parameters)
    } else {
        (body, None)
    };

    let req = services::dag_service::DagSubmitRequest {
        definition,
        parameters,
        context: None,
        submitter_agent_id: None,
    };

    match services::dag_service::submit_dag(req).await {
        Ok(resp) => (
            StatusCode::OK,
            Json(serde_json::json!({
                "status": "submitted",
                "submitted_nodes": resp.submitted_nodes,
            })),
        ),
        Err(e) => {
            let msg = e.to_string();
            let status = if msg.contains("already running") {
                StatusCode::CONFLICT
            } else if msg.contains("Failed to parse")
                || msg.contains("cannot also be a task worker")
            {
                StatusCode::BAD_REQUEST
            } else {
                StatusCode::INTERNAL_SERVER_ERROR
            };
            (status, Json(serde_json::json!({ "error": msg })))
        }
    }
}

#[derive(Deserialize)]
struct DagStatusQuery {
    dag_id: Option<String>,
}

async fn dag_status(Query(query): Query<DagStatusQuery>) -> impl IntoResponse {
    let info = services::dag_service::get_dag_status(query.dag_id.as_deref()).await;

    // REST response 兼容旧格式
    #[derive(Serialize)]
    struct DagStatusRest {
        running: bool,
        progress: Option<f64>,
        status_prompt: Option<String>,
        is_complete: Option<bool>,
        nodes: Option<Vec<services::dag_service::NodeStatusInfo>>,
    }

    Json(DagStatusRest {
        running: info.running,
        progress: info.progress,
        status_prompt: info.status_prompt,
        is_complete: info.is_complete,
        nodes: info.nodes,
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
    let entries = services::dag_service::list_dags().await;
    let dags: Vec<DagInfo> = entries
        .into_iter()
        .map(|e| DagInfo {
            dag_id: e.dag_id,
            progress: e.progress,
            is_complete: e.is_complete,
            status_prompt: e.status_prompt,
        })
        .collect();
    Json(dags)
}

#[derive(Serialize)]
struct DagVisualizationResponse {
    dag_id: String,
    nodes: Vec<services::dag_service::DagVisualizationNode>,
    edges: Vec<services::dag_service::DagEdge>,
}

async fn dag_visualization(Query(query): Query<DagStatusQuery>) -> impl IntoResponse {
    let result = services::dag_service::get_dag_visualization(query.dag_id.as_deref()).await;
    Json(DagVisualizationResponse {
        dag_id: result.dag_id,
        nodes: result.nodes,
        edges: result.edges,
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
    let result = services::dag_service::get_dag_metrics(query.dag_id.as_deref()).await;
    Json(DagMetrics {
        total_nodes: result.total_nodes,
        completed_nodes: result.completed_nodes,
        failed_nodes: result.failed_nodes,
        running_nodes: result.running_nodes,
        pending_nodes: result.pending_nodes,
        avg_completion_time_secs: result.avg_completion_time_secs,
    })
}

/// REST 端点：dry-run 验证 DAG YAML。
#[derive(Deserialize)]
struct ValidateDagRestRequest {
    definition: String,
    #[serde(default)]
    parameters: Option<HashMap<String, serde_json::Value>>,
}

async fn validate_dag(body: String) -> impl IntoResponse {
    let (definition, parameters) =
        if let Ok(req) = serde_json::from_str::<ValidateDagRestRequest>(&body) {
            (req.definition, req.parameters)
        } else {
            (body, None)
        };

    match services::dag_service::validate_dag(&definition, parameters) {
        Ok(result) => (
            StatusCode::OK,
            Json(serde_json::to_value(result).unwrap_or_default()),
        ),
        Err(e) => (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": e.to_string() })),
        ),
    }
}
