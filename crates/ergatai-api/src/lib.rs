//! Ergatai API Library — shared types, handlers, and router construction.
//!
//! This library is used by the `ergatai-server` binary and by integration tests.
//! It contains all HTTP/MCP handler logic, AppState, and middleware.

use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};

use axum::{
    body::Body,
    extract::State,
    http::{header, Request, StatusCode},
    middleware::{self, Next},
    response::IntoResponse,
    routing::{delete, get, patch, post, put},
    Router,
};
use serde::{Deserialize, Serialize};
use std::time::Duration;
use tokio::sync::broadcast;
use tower_http::cors::{Any, CorsLayer};
use utoipa::OpenApi;

use ergatai_core::nats;

pub mod api;
pub mod context;
pub mod lock_permission;
pub mod mcp;

pub mod messaging;

pub mod services;

pub mod user_data_db;

// ── Custom JSON extractor ────────────────────────────────────────────

/// Custom JSON extractor that returns JSON error responses instead of plain text.
///
/// Wraps `axum::Json` and implements `From<JsonRejection>` to ensure all JSON
/// parsing errors return `application/json` Content-Type with a structured error
/// response, matching the API's error response format.
///
/// Usage: Replace `Json<T>` with `crate::Json<T>` in handler signatures.
pub struct Json<T>(pub T);

impl<T, S> axum::extract::FromRequest<S> for Json<T>
where
    T: serde::de::DeserializeOwned + Send + Sync,
    S: Send + Sync,
{
    type Rejection = (StatusCode, axum::Json<serde_json::Value>);

    async fn from_request(req: axum::extract::Request, state: &S) -> Result<Self, Self::Rejection> {
        <axum::Json<T> as axum::extract::FromRequest<S>>::from_request(req, state)
            .await
            .map(|axum::Json(value)| Json(value))
            .map_err(|rejection| {
                let message = match rejection {
                    axum::extract::rejection::JsonRejection::JsonDataError(e) => {
                        format!("Invalid JSON data: {}", e.body_text())
                    }
                    axum::extract::rejection::JsonRejection::JsonSyntaxError(e) => {
                        format!(
                            "Failed to parse the request body as JSON: {}",
                            e.body_text()
                        )
                    }
                    axum::extract::rejection::JsonRejection::MissingJsonContentType(e) => {
                        e.body_text()
                    }
                    _ => "Unknown JSON extraction error".to_string(),
                };
                crate::http_error::bad_request(message)
            })
    }
}

impl<T> std::ops::Deref for Json<T> {
    type Target = T;

    fn deref(&self) -> &Self::Target {
        &self.0
    }
}

impl<T> serde::Serialize for Json<T>
where
    T: serde::Serialize,
{
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        self.0.serialize(serializer)
    }
}

// ── Custom JSON Query Extractor ──────────────────────────────────────

/// Custom Query extractor that returns JSON error responses instead of plain text.
///
/// Wraps `axum::extract::Query` and ensures all query parameter parsing errors
/// return `application/json` Content-Type with a structured error response.
///
/// Usage: Replace `Query<T>` with `crate::JsonQuery<T>` in handler signatures.
pub struct JsonQuery<T>(pub T);

impl<T, S> axum::extract::FromRequestParts<S> for JsonQuery<T>
where
    T: serde::de::DeserializeOwned + Send + Sync,
    S: Send + Sync,
{
    type Rejection = (StatusCode, axum::Json<serde_json::Value>);

    async fn from_request_parts(
        parts: &mut axum::http::request::Parts,
        state: &S,
    ) -> Result<Self, Self::Rejection> {
        // Reject requests with empty query parameter names (e.g., `?=value`)
        if let Some(query_str) = parts.uri.query() {
            if query_str.split('&').any(|pair| pair.starts_with('=')) {
                return Err(crate::http_error::bad_request(
                    "Invalid query parameter: empty parameter name",
                ));
            }
        }
        <axum::extract::Query<T> as axum::extract::FromRequestParts<S>>::from_request_parts(
            parts, state,
        )
        .await
        .map(|axum::extract::Query(value)| JsonQuery(value))
        .map_err(|rejection| {
            let message = format!("Invalid query parameters: {}", rejection.body_text());
            crate::http_error::bad_request(message)
        })
    }
}

impl<T> std::ops::Deref for JsonQuery<T> {
    type Target = T;

    fn deref(&self) -> &Self::Target {
        &self.0
    }
}

impl<T> IntoResponse for Json<T>
where
    T: serde::Serialize,
{
    fn into_response(self) -> axum::response::Response {
        axum::Json(self.0).into_response()
    }
}

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

/// Global permission handler for ACP tool execution (manages per-workspace lock managers)
static PERMISSION_HANDLER: OnceLock<Arc<crate::lock_permission::LockPermissionHandler>> =
    OnceLock::new();

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

/// Set the global permission handler (called once at startup).
pub fn set_permission_handler(handler: Arc<crate::lock_permission::LockPermissionHandler>) {
    let _ = PERMISSION_HANDLER.set(handler);
}

/// Get the global permission handler reference.
pub fn get_permission_handler(
) -> Option<&'static Arc<crate::lock_permission::LockPermissionHandler>> {
    PERMISSION_HANDLER.get()
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
        .route("/api/v1/openapi.json", get(openapi_json))
        .route("/health", get(health_check))
        .route("/ready", get(readiness_check))
        .route("/metrics", get(metrics_endpoint))
        // ════════════════════════════════════════════════════════════════
        // Workspace API（最顶层容器）
        // ════════════════════════════════════════════════════════════════
        .route("/api/v1/workspaces", get(api::workspaces::list_workspaces))
        .route(
            "/api/v1/workspaces",
            post(api::workspaces::create_workspace),
        )
        .route(
            "/api/v1/workspaces/{workspace_id}",
            get(api::workspaces::get_workspace),
        )
        .route(
            "/api/v1/workspaces/{workspace_id}",
            patch(api::workspaces::update_workspace),
        )
        .route(
            "/api/v1/workspaces/{workspace_id}",
            delete(api::workspaces::delete_workspace),
        )
        // Workspace lifecycle management
        .route(
            "/api/v1/workspaces/{workspace_id}/stop",
            post(api::workspaces::stop_workspace),
        )
        .route(
            "/api/v1/workspaces/{workspace_id}/start",
            post(api::workspaces::start_workspace),
        )
        .route(
            "/api/v1/workspaces/{workspace_id}/archive",
            post(api::workspaces::archive_workspace),
        )
        .route(
            "/api/v1/workspaces/{workspace_id}/restore",
            post(api::workspaces::restore_workspace),
        )
        .route(
            "/api/v1/terminal-sessions",
            get(api::terminal_sessions::list_sessions)
                .post(api::terminal_sessions::create_session),
        )
        .route(
            "/api/v1/terminal-sessions/{id}",
            get(api::terminal_sessions::get_session),
        )
        .route(
            "/api/v1/terminal-sessions/{id}/input",
            post(api::terminal_sessions::write_input),
        )
        .route(
            "/api/v1/terminal-sessions/{id}/resize",
            post(api::terminal_sessions::resize_session),
        )
        .route(
            "/api/v1/terminal-sessions/{id}/signal",
            post(api::terminal_sessions::signal_session),
        )
        .route(
            "/api/v1/terminal-sessions/{id}/terminate",
            post(api::terminal_sessions::terminate_session),
        )
        .route(
            "/api/v1/terminal-sessions/{id}/stream",
            get(api::terminal_sessions::stream_session),
        )
        .route(
            "/api/v1/terminal-sessions/{id}/audit",
            get(api::terminal_sessions::list_audit),
        )
        // Persistent workspace routes
        .route(
            "/api/v1/workspaces/persistent",
            get(api::workspaces::list_persistent_workspaces),
        )
        .route(
            "/api/v1/workspaces/persistent",
            post(api::workspaces::create_persistent_workspace),
        )
        .route(
            "/api/v1/workspaces/persistent/{id}",
            get(api::workspaces::get_persistent_workspace),
        )
        .route(
            "/api/v1/workspaces/persistent/{id}",
            put(api::workspaces::update_persistent_workspace),
        )
        .route(
            "/api/v1/workspaces/persistent/{id}",
            delete(api::workspaces::delete_persistent_workspace),
        )
        // Managed workspace routes
        .route(
            "/api/v1/workspaces/managed",
            get(api::workspaces::list_managed_workspaces),
        )
        .route(
            "/api/v1/workspaces/managed",
            post(api::workspaces::create_managed_workspace),
        )
        .route(
            "/api/v1/workspaces/managed/{id}",
            get(api::workspaces::get_managed_workspace),
        )
        .route(
            "/api/v1/workspaces/managed/{id}",
            patch(api::workspaces::update_managed_workspace),
        )
        .route(
            "/api/v1/workspaces/managed/{id}",
            delete(api::workspaces::delete_managed_workspace),
        )
        .route(
            "/api/v1/workspaces/managed/{id}/archive",
            post(api::workspaces::archive_managed_workspace),
        )
        .route(
            "/api/v1/workspaces/managed/{id}/restore",
            post(api::workspaces::restore_managed_workspace),
        )
        // TODO: Project management endpoints temporarily disabled
        // .route(
        //     "/api/v1/workspaces/managed/{id}/projects",
        //     get(api::workspaces::list_managed_workspace_projects),
        // )
        // .route(
        //     "/api/v1/workspaces/managed/{id}/projects",
        //     post(api::workspaces::register_managed_workspace_project),
        // )
        // .route(
        //     "/api/v1/workspaces/managed/{id}/projects/{project_id}",
        //     delete(api::workspaces::remove_managed_workspace_project),
        // )
        // .route(
        //     "/api/v1/workspaces/managed/{id}/status",
        //     get(api::workspaces::managed_workspace_status),
        // )
        // ════════════════════════════════════════════════════════════════
        // Agent API（批量查询 / 管理端点）
        // ════════════════════════════════════════════════════════════════
        .route("/api/v1/agents", get(api::agents::list_agents))
        .route("/api/v1/agents", post(api::agents::spawn_agent))
        .route(
            "/api/v1/agents/{id}",
            get(api::agents::get_agent),
        )
        .route(
            "/api/v1/agents/suspended",
            get(api::agents::list_suspended_agents),
        )
        .route("/api/v1/agents/{id}", delete(api::agents::kill_agent))
        .route(
            "/api/v1/agents/{id}/send",
            post(api::agents::send_message),
        )
        .route(
            "/api/v1/agents/{id}/spawn-session",
            post(api::agents::spawn_session),
        )
        .route(
            "/api/v1/agents/{id}/cancel",
            post(api::agents::cancel_prompt),
        )
        .route(
            "/api/v1/agents/{id}/suspend",
            post(api::agents::suspend_agent),
        )
        .route(
            "/api/v1/agents/{id}/resume",
            post(api::agents::resume_agent),
        )
        .route("/api/v1/agents/{id}/prompt", post(api::agents::prompt_agent))
        // ACP monitoring endpoints
        .route(
            "/api/v1/agents/{id}/thoughts",
            get(api::agents::get_agent_thoughts),
        )
        .route(
            "/api/v1/agents/{id}/tool-calls",
            get(api::agents::get_agent_tool_calls),
        )
        .route("/api/v1/agents/{id}/plan", get(api::agents::get_agent_plan))
        .route(
            "/api/v1/agents/{id}/elicitations",
            get(api::agents::get_agent_elicitations),
        )
        .route(
            "/api/v1/agents/{id}/elicitations/{elicitation_id}/respond",
            post(api::agents::respond_to_elicitation),
        )
        .route(
            "/api/v1/agents/{id}/config-options",
            get(api::agents::get_agent_config_options),
        )
        .route(
            "/api/v1/agents/{id}/commands",
            get(api::agents::get_agent_available_commands),
        )
        .route(
            "/api/v1/agents/{id}/execute-command",
            post(api::agents::execute_agent_command),
        )
        .route(
            "/api/v1/agents/{id}/sessions",
            get(api::agents::list_agent_sessions),
        )
        .route(
            "/api/v1/agents/{id}/sessions",
            post(api::agents::create_agent_session),
        )
        .route(
            "/api/v1/agents/{id}/sessions/{session_id}",
            post(api::agents::load_agent_session),
        )
        .route(
            "/api/v1/agents/{id}/sessions/{session_id}",
            delete(api::agents::delete_agent_session),
        )
        .route(
            "/api/v1/agents/{id}/usage",
            get(api::agents::get_agent_usage),
        )
        .route(
            "/api/v1/agents/{id}/output",
            get(api::agents::get_agent_output),
        )
        .route(
            "/api/v1/agents/{id}/last-activity",
            get(api::agents::get_agent_last_activity),
        )
        .route(
            "/api/v1/agents/{id}/exit-code",
            get(api::agents::get_agent_exit_code),
        )
        .route("/api/v1/agents/{id}/pid", get(api::agents::get_agent_pid))
        .route(
            "/api/v1/agents/{id}/current-output",
            get(api::agents::get_agent_current_output),
        )
        // Agent event stream (SSE)
        .route(
            "/api/v1/agents/{id}/events",
            get(api::agents::stream_agent_events),
        )
        // Permission requests (unified approval feed)
        .route(
            "/api/v1/permissions/pending",
            get(api::permissions::list_pending),
        )
        .route(
            "/api/v1/permissions/stream",
            get(api::permissions::stream_permissions),
        )
        .route(
            "/api/v1/permissions/mode",
            get(api::permissions::get_mode),
        )
        .route(
            "/api/v1/permissions/mode",
            post(api::permissions::set_mode),
        )
        .route(
            "/api/v1/permissions/{id}/respond",
            post(api::permissions::respond_permission),
        )
        // ════════════════════════════════════════════════════════════════
        // Chat API（属于 Workspace，1:N）
        // ════════════════════════════════════════════════════════════════
        .route(
            "/api/v1/chats",
            get(api::chats::list_chats).post(api::chats::create_chat),
        )
        .route(
            "/api/v1/chats/{chat_id}",
            get(api::chats::get_chat)
                .patch(api::chats::patch_chat)
                .delete(api::chats::delete_chat),
        )
        .route(
            "/api/v1/chats/{chat_id}/archive",
            post(api::chats::archive_chat),
        )
        .route(
            "/api/v1/chats/{chat_id}/unarchive",
            post(api::chats::unarchive_chat),
        )
        .route(
            "/api/v1/worktrees/registered",
            get(api::chats::lookup_registered_worktree),
        )
        .route(
            "/api/v1/chats/lookup-worktree",
            get(api::chats::lookup_registered_worktree),
        )
        .route(
            "/api/v1/chats/lookup-worktree",
            axum::routing::options(|| async {
                axum::response::Response::builder()
                    .status(StatusCode::OK)
                    .header("Allow", "GET,HEAD")
                    .body(axum::body::Body::empty())
                    .unwrap()
            }),
        )
        .route(
            "/api/v1/chats/{chat_id}/agents",
            get(api::chats::list_chat_agents),
        )
        .route(
            "/api/v1/chats/{chat_id}/agent-graph",
            get(api::chats::get_agent_graph),
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
            "/api/v1/agent-profiles/{name}/install",
            post(api::agent_profiles::install_agent),
        )
        .route(
            "/api/v1/agent-profiles/{name}/uninstall",
            delete(api::agent_profiles::uninstall_agent),
        )
        .route(
            "/api/v1/agent-profiles/{name}",
            get(api::agent_profiles::get_profile),
        )
        .route(
            "/api/v1/agent-profiles/{name}",
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
        // ════════════════════════════════════════════════════════════════
        // Conversation API (full CRUD + archive operations)
        // ════════════════════════════════════════════════════════════════
        .route(
            "/api/v1/conversations",
            get(api::user_conversations::list_conversations).post(api::user_conversations::create_conversation),
        )
        .route(
            "/api/v1/conversations/{conversation_id}",
            get(api::user_conversations::get_conversation)
                .patch(api::user_conversations::update_conversation)
                .delete(api::user_conversations::delete_conversation),
        )
        .route(
            "/api/v1/conversations/{conversation_id}/archive",
            post(api::user_conversations::archive_conversation),
        )
        .route(
            "/api/v1/conversations/{conversation_id}/unarchive",
            post(api::user_conversations::unarchive_conversation),
        )
        // Conversation Messages (read-only)
        .route(
            "/api/v1/conversations/{conversation_id}/messages",
            get(api::user_conversations::list_conversation_messages),
        )
        .route(
            "/api/v1/conversations/{conversation_id}/file-changes",
            get(api::user_conversations::list_conversation_file_changes),
        )
        // Conversation Agent Outputs
        .route(
            "/api/v1/conversations/{conversation_id}/outputs",
            get(api::user_conversations::list_conversation_outputs),
        )
        .route(
            "/api/v1/conversations/{conversation_id}/outputs/{output_id}",
            get(api::user_conversations::get_conversation_output),
        )
        .route(
            "/api/v1/activity/recent",
            get(api::activity_routes::get_recent_events),
        )
        .route(
            "/api/v1/activity/stream",
            get(api::activity_routes::stream_events),
        )
        // ════════════════════════════════════════════════════════════════
        // Collaboration Session API（属于 Chat，1:N）
        // ════════════════════════════════════════════════════════════════
        .route(
            "/api/v1/collaboration-sessions",
            get(api::collaboration_sessions::list_collaboration_sessions)
                .post(api::collaboration_sessions::create_collaboration_session),
        )
        .route(
            "/api/v1/collaboration-sessions/by-chat/{chat_id}",
            get(api::collaboration_sessions::get_collaboration_session_by_chat),
        )
        .route(
            "/api/v1/collaboration-sessions/{collaboration_session_id}",
            get(api::collaboration_sessions::get_collaboration_session)
                .patch(api::collaboration_sessions::patch_collaboration_session)
                .delete(api::collaboration_sessions::delete_collaboration_session),
        )
        .route(
            "/api/v1/collaboration-sessions/{collaboration_session_id}/status",
            get(api::collaboration_sessions::get_collaboration_session_status),
        )
        .route(
            "/api/v1/collaboration-sessions/{collaboration_session_id}/progress",
            get(api::collaboration_sessions::get_collaboration_session_progress),
        )
        .route(
            "/api/v1/collaboration-sessions/{collaboration_session_id}/state",
            post(api::collaboration_sessions::transition_collaboration_session_state),
        )
        .route(
            "/api/v1/collaboration-sessions/{collaboration_session_id}/events",
            get(api::collaboration_sessions::list_collaboration_session_events),
        )
        .route(
            "/api/v1/collaboration-sessions/{collaboration_session_id}/stream",
            get(api::collaboration_sessions::stream_collaboration_session_events),
        )
        .route(
            "/api/v1/collaboration-sessions/{collaboration_session_id}/plans",
            post(api::collaboration_sessions::create_collaboration_session_plan),
        )
        .route(
            "/api/v1/collaboration-sessions/{collaboration_session_id}/plans",
            get(api::collaboration_sessions::list_collaboration_session_plans),
        )
        .route(
            "/api/v1/collaboration-sessions/{collaboration_session_id}/plans/{plan_revision_id}",
            get(api::collaboration_sessions::get_collaboration_session_plan),
        )
        .route(
            "/api/v1/collaboration-sessions/{collaboration_session_id}/plans/{plan_revision_id}/execute",
            post(api::collaboration_sessions::execute_collaboration_session_plan),
        )
        .route(
            "/api/v1/collaboration-sessions/{collaboration_session_id}/approvals",
            post(api::collaboration_sessions::create_collaboration_session_approval),
        )
        .route(
            "/api/v1/collaboration-sessions/{collaboration_session_id}/approvals/{approval_id}/decision",
            post(api::collaboration_sessions::decide_collaboration_session_approval),
        )
        .route(
            "/api/v1/collaboration-sessions/{collaboration_session_id}/cancel",
            post(api::collaboration_sessions::cancel_collaboration_session),
        )
        .route(
            "/api/v1/collaboration-sessions/{collaboration_session_id}/conversations",
            get(api::collaboration_sessions::list_session_conversations),
        )
        .route(
            "/api/v1/collaboration-sessions/{collaboration_session_id}/conversations/{conversation_id}",
            get(api::collaboration_sessions::get_session_conversation),
        )
        .with_state(state.clone())
        // Auth middleware (exempts /health, /ready, /metrics)
        // Added FIRST (innermost) so it executes AFTER method_validation but BEFORE router.
        .layer(middleware::from_fn_with_state(
            state.clone(),
            auth_middleware,
        ))
        // CORS layer — outermost so preflight `OPTIONS` requests bypass auth.
        // Configure allowed origins via ERGATAI_CORS_ALLOWED_ORIGINS (comma-separated).
        // When unset, falls back to permissive development config (any origin).
        .layer({
            match std::env::var("ERGATAI_CORS_ALLOWED_ORIGINS") {
                Ok(origins) => {
                    let mut allowed = Vec::new();
                    for part in origins.split(',') {
                        let trimmed = part.trim();
                        if trimmed.is_empty() {
                            continue;
                        }
                        match trimmed.parse() {
                            Ok(origin) => allowed.push(origin),
                            Err(_) => {
                                tracing::warn!(
                                    "CORS: ignoring invalid origin {:?} from ERGATAI_CORS_ALLOWED_ORIGINS",
                                    trimmed
                                );
                            }
                        }
                    }

                    if allowed.is_empty() {
                        tracing::error!(
                            "CORS: ERGATAI_CORS_ALLOWED_ORIGINS set but no valid origins parsed; \
                             denying all cross-origin requests (fail-safe). \
                             Check your configuration for typos or invalid origins."
                        );
                        // Fail-safe: when env var is explicitly set but yields no valid origins,
                        // deny all cross-origin requests rather than opening to all origins.
                        // Don't set allow_origin - default behavior is to deny all.
                        CorsLayer::new()
                            .allow_methods(Any)
                            .allow_headers(Any)
                            .max_age(Duration::from_secs(3600))
                    } else {
                        tracing::info!(
                            "CORS configured with {} allowed origin(s)",
                            allowed.len()
                        );
                        CorsLayer::new()
                            .allow_origin(allowed)
                            .allow_methods(Any)
                            .allow_headers(Any)
                            .max_age(Duration::from_secs(3600))
                    }
                }
                Err(_) => {
                    tracing::warn!(
                        "CORS: no ERGATAI_CORS_ALLOWED_ORIGINS set, using permissive config"
                    );
                    CorsLayer::new()
                        .allow_origin(Any)
                        .allow_methods(Any)
                        .allow_headers(Any)
                        .max_age(Duration::from_secs(3600))
                }
            }
        })
        // Method validation must be the outermost layer so that unsupported methods
        // (including OPTIONS preflight) are handled before CORS/auth and return a
        // consistent 405 with an Allow header matching the documented methods.
        .layer(middleware::from_fn(method_validation_middleware))
}

async fn openapi_json() -> Json<utoipa::openapi::OpenApi> {
    let mut openapi = api::openapi::ApiDoc::openapi();

    // Broaden the documented response statuses/content types so the served OpenAPI
    // contract matches the behaviour of the auth, routing, validation and error
    // middleware. Without this, Schemathesis reports a large number of
    // "undocumented status code" and "undocumented content-type" failures for
    // perfectly normal error responses (400/401/404/405/415/422/...).
    let common_statuses = [
        "400", "401", "403", "404", "405", "409", "415", "422", "429", "500",
    ];
    for item in openapi.paths.paths.values_mut() {
        for op in [
            item.get.as_mut(),
            item.put.as_mut(),
            item.post.as_mut(),
            item.delete.as_mut(),
            item.options.as_mut(),
            item.head.as_mut(),
            item.patch.as_mut(),
        ]
        .into_iter()
        .flatten()
        {
            for code in common_statuses {
                use utoipa::openapi::{Content, RefOr, Response};
                if !op.responses.responses.contains_key(code) {
                    let mut response = Response::new(code);
                    response
                        .content
                        .insert("application/json".to_string(), Content::default());
                    response
                        .content
                        .insert("text/plain".to_string(), Content::default());
                    op.responses
                        .responses
                        .insert(code.to_string(), RefOr::T(response));
                } else if let Some(RefOr::T(response)) = op.responses.responses.get_mut(code) {
                    response
                        .content
                        .entry("application/json".to_string())
                        .or_default();
                    response
                        .content
                        .entry("text/plain".to_string())
                        .or_default();
                }
            }
        }
    }

    Json(openapi)
}

// ── Health / readiness / metrics handlers ────────────────────────────

async fn health_check() -> impl IntoResponse {
    metrics::counter!("api_requests_total", "endpoint" => "health").increment(1);

    let mut checks = serde_json::Map::new();
    let mut all_healthy = true;

    // Use AppContext as single source of truth for NATS health
    let nats_ok = crate::context::try_get_app_context()
        .and_then(|ctx| ctx.nats_connection.clone())
        .map(|conn| conn.is_connected())
        .unwrap_or(false);
    checks.insert("nats".to_string(), serde_json::Value::Bool(nats_ok));
    if !nats_ok {
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
    // Use AppContext as single source of truth for NATS readiness
    let nats_ready = crate::context::try_get_app_context()
        .and_then(|ctx| ctx.nats_connection.clone())
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

// ── Method validation middleware ──────────────────────────────────────

/// Method validation middleware — ensures unsupported HTTP methods return 405 Method Not Allowed
/// instead of 401 Unauthorized.
///
/// This middleware runs BEFORE authentication to provide proper REST API semantics:
/// when a client uses an unsupported method (e.g., TRACE, DELETE) on a valid endpoint,
/// they should receive 405 with an Allow header listing the supported methods, not 401.
///
/// The middleware maintains a mapping of path patterns to allowed methods, extracted from
/// the route definitions. When a request arrives:
/// 1. Check if the path matches any registered pattern
/// 2. If yes, check if the HTTP method is in the allowed list
/// 3. If not allowed, return 405 with Allow header
/// 4. Otherwise, pass through to the next middleware (auth)
pub async fn method_validation_middleware(request: Request<Body>, next: Next) -> impl IntoResponse {
    let method = request.method().clone();
    let path = request.uri().path().to_string();

    // Check if the path matches any API route and validate the method
    if let Some(allowed_methods) = get_allowed_methods_for_path(&path) {
        if !allowed_methods.contains(&method) {
            // Method not allowed for this path
            // Filter out HEAD and OPTIONS unless explicitly defined in routes
            // (HEAD is auto-added by axum for GET routes, but shouldn't be advertised in Allow header for OpenAPI compliance)
            let allow_header = allowed_methods
                .iter()
                .filter(|m| **m != axum::http::Method::HEAD && **m != axum::http::Method::OPTIONS)
                .map(|m| m.as_str())
                .collect::<Vec<_>>()
                .join(",");

            let error_message = format!(
                "Method {} not allowed. Allowed methods: {}",
                method, allow_header
            );

            tracing::debug!(
                method = %method,
                path = %path,
                allowed = %allow_header,
                "Request rejected (405): method not allowed"
            );

            return (
                StatusCode::METHOD_NOT_ALLOWED,
                [(header::ALLOW, allow_header)],
                Json(ErrorResponse {
                    error: error_message,
                }),
            )
                .into_response();
        }
    }

    // Method is allowed or path doesn't match any route (will be handled by axum's 404)
    next.run(request).await.into_response()
}

/// Returns the allowed HTTP methods for a given path pattern.
///
/// This function maps request paths to their allowed methods based on the route definitions.
/// It handles both exact matches and path parameters (e.g., `/api/v1/agents/{id}`).
///
/// Returns `None` if the path doesn't match any registered route (will result in 404).
fn get_allowed_methods_for_path(path: &str) -> Option<Vec<axum::http::Method>> {
    use axum::http::Method;

    let matches_pattern = |path: &str, pattern: &str| -> bool {
        let path_parts: Vec<&str> = path.trim_matches('/').split('/').collect();
        let pattern_parts: Vec<&str> = pattern.trim_matches('/').split('/').collect();

        if path_parts.len() != pattern_parts.len() {
            return false;
        }

        path_parts
            .iter()
            .zip(pattern_parts.iter())
            .all(|(p, pat)| pat.starts_with('{') && pat.ends_with('}') || p == pat)
    };

    // Cache the OpenAPI spec to avoid regenerating it on every request
    use std::sync::OnceLock;
    static OPENAPI_CACHE: OnceLock<utoipa::openapi::OpenApi> = OnceLock::new();
    let openapi = OPENAPI_CACHE.get_or_init(crate::api::openapi::ApiDoc::openapi);

    for (pattern, item) in openapi.paths.paths.iter() {
        if matches_pattern(path, pattern) {
            let mut methods = Vec::new();
            if item.get.is_some() {
                methods.push(Method::GET);
            }
            if item.put.is_some() {
                methods.push(Method::PUT);
            }
            if item.post.is_some() {
                methods.push(Method::POST);
            }
            if item.delete.is_some() {
                methods.push(Method::DELETE);
            }
            if item.options.is_some() {
                methods.push(Method::OPTIONS);
            }
            if item.head.is_some() {
                methods.push(Method::HEAD);
            }
            if item.patch.is_some() {
                methods.push(Method::PATCH);
            }
            if item.trace.is_some() {
                methods.push(Method::TRACE);
            }
            if !methods.is_empty() {
                return Some(methods);
            }
        }
    }
    None
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
        tracing::warn!(
            path = %path,
            has_auth_header = auth_header.is_some(),
            "Request rejected (401): invalid or missing API token"
        );
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

/// HTTP error response helpers — reduce boilerplate in API handlers.
///
/// These helpers combine status code selection, error sanitization, and
/// server-side logging into single calls, eliminating hundreds of lines of
/// repeated `(StatusCode, String)` construction across API handlers.
pub mod http_error {
    use axum::http::StatusCode;
    use axum::Json;
    use serde_json::json;

    /// 500 Internal Server Error with sanitized message.
    /// Logs the full error at ERROR level, returns generic message to client.
    pub fn internal<E: std::fmt::Display>(
        err: E,
        context: &str,
    ) -> (StatusCode, Json<serde_json::Value>) {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": crate::sanitize_error(&err, context) })),
        )
    }

    /// 400 Bad Request with a client-facing message.
    pub fn bad_request(message: impl Into<String>) -> (StatusCode, Json<serde_json::Value>) {
        (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": message.into() })),
        )
    }

    /// 404 Not Found with a client-facing message.
    pub fn not_found(resource: &str, id: &str) -> (StatusCode, Json<serde_json::Value>) {
        (
            StatusCode::NOT_FOUND,
            Json(json!({ "error": format!("{} {} not found", resource, id) })),
        )
    }

    /// 503 Service Unavailable (e.g., during initialization or overload).
    pub fn unavailable(message: impl Into<String>) -> (StatusCode, Json<serde_json::Value>) {
        (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({ "error": message.into() })),
        )
    }

    /// Parse a Snowflake ID string, returning 400 if invalid.
    ///
    /// Invalid ID format is a client parameter error (bad request), not a resource not found error.
    /// Resource not found (404) should be returned when the ID is valid but the resource doesn't exist in the database.
    pub fn parse_id_or_not_found(
        id_str: &str,
        resource: &str,
    ) -> Result<i64, (StatusCode, Json<serde_json::Value>)> {
        ergatai_error::id::parse_to_i64(id_str)
            .ok_or_else(|| bad_request(format!("Invalid {} ID format: '{}'", resource, id_str)))
    }
}

/// Run a blocking operation on the thread pool with unified error handling.
///
/// Eliminates the repeated pattern of:
/// ```ignore
/// match tokio::task::spawn_blocking(move || blocking_fn(args)).await {
///     Ok(Ok(result)) => { /* use result */ }
///     Ok(Err(e)) => { /* handle blocking error */ }
///     Err(e) => { /* handle JoinError */ }
/// }
/// ```
///
/// Converts both the blocking error and JoinError into a single `Result<T, (StatusCode, Json<serde_json::Value>)>`
/// suitable for direct use in API handlers.
pub async fn run_blocking<F, T, E>(f: F) -> Result<T, (StatusCode, axum::Json<serde_json::Value>)>
where
    F: FnOnce() -> std::result::Result<T, E> + Send + 'static,
    T: Send + 'static,
    E: std::fmt::Display + Send + 'static,
{
    match tokio::task::spawn_blocking(f).await {
        Ok(Ok(result)) => Ok(result),
        Ok(Err(e)) => Err(crate::http_error::internal(e, "blocking operation")),
        Err(e) => Err(crate::http_error::internal(
            format!("Task join error: {}", e),
            "spawn_blocking",
        )),
    }
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
