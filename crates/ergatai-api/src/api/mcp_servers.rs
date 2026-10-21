//! MCP Server Configuration API handlers
//!
//! CRUD endpoints for user-configured MCP servers.
//! Supports global MCP servers (available to all agents) and
//! profile-specific MCP servers (bound to an agent profile).

use axum::{
    extract::{Path, Query},
    http::StatusCode,
    response::IntoResponse,
    Json,
};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use utoipa::{IntoParams, ToSchema};

use crate::user_data_db::{mcp_servers, McpServer};
use ergatai_core::id::generate;

// ════════════════════════════════════════════════════════════════════════════
// Request/Response Types
// ════════════════════════════════════════════════════════════════════════════

#[derive(Debug, Deserialize, ToSchema)]
pub struct CreateMcpServerRequest {
    /// Agent profile ID to bind to. Null/omitted = global MCP server.
    pub profile_id: Option<String>,
    /// Display name (unique within the same profile_id scope)
    pub name: String,
    /// Server type: "stdio", "http", or "sse"
    pub server_type: String,
    /// Command to run (for stdio type)
    pub command: Option<String>,
    /// Command arguments (for stdio type)
    #[serde(default)]
    pub args: Vec<String>,
    /// Environment variables
    #[serde(default)]
    pub env: HashMap<String, String>,
    /// Server URL (for http/sse type)
    pub url: Option<String>,
    /// HTTP headers
    #[serde(default)]
    pub headers: HashMap<String, String>,
    /// Whether this MCP server is enabled
    #[serde(default = "default_true")]
    pub enabled: bool,
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct UpdateMcpServerRequest {
    pub profile_id: Option<String>,
    pub name: Option<String>,
    pub server_type: Option<String>,
    pub command: Option<String>,
    pub args: Option<Vec<String>>,
    pub env: Option<HashMap<String, String>>,
    pub url: Option<String>,
    pub headers: Option<HashMap<String, String>>,
    pub enabled: Option<bool>,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct McpServerResponse {
    pub id: String, // Changed from i64 to String to avoid JavaScript precision issues
    pub profile_id: Option<String>,
    pub name: String,
    pub server_type: String,
    pub command: Option<String>,
    pub args: Vec<String>,
    pub env: HashMap<String, String>,
    pub url: Option<String>,
    pub headers: HashMap<String, String>,
    pub enabled: bool,
    pub created_at: i64,
    pub updated_at: i64,
}

impl From<McpServer> for McpServerResponse {
    fn from(s: McpServer) -> Self {
        Self {
            id: s.id.to_string(), // Convert i64 to String
            profile_id: s.profile_id,
            name: s.name,
            server_type: s.server_type,
            command: s.command,
            args: s.args,
            env: s.env,
            url: s.url,
            headers: s.headers,
            enabled: s.enabled,
            created_at: s.created_at,
            updated_at: s.updated_at,
        }
    }
}

#[derive(Debug, Serialize, ToSchema)]
pub struct ListMcpServersResponse {
    pub servers: Vec<McpServerResponse>,
}

#[derive(Debug, Deserialize, IntoParams)]
pub struct ListMcpServersQuery {
    /// Filter by profile_id. Use "global" for global servers (profile_id IS NULL).
    pub profile_id: Option<String>,
    /// Filter by enabled status
    pub enabled: Option<bool>,
}

// ════════════════════════════════════════════════════════════════════════════
// Handlers
// ════════════════════════════════════════════════════════════════════════════

/// Create a new MCP server configuration
///
/// POST /api/v1/mcp-servers
#[utoipa::path(
    post,
    path = "/api/v1/mcp-servers",
    tag = "MCP Servers",
    request_body = CreateMcpServerRequest,
    responses(
        (status = 201, description = "MCP server created", body = McpServerResponse),
        (status = 400, description = "Invalid request"),
        (status = 409, description = "Name conflict"),
        (status = 500, description = "Internal error"),
    )
)]
pub async fn create_mcp_server(Json(req): Json<CreateMcpServerRequest>) -> impl IntoResponse {
    // Validate server_type
    if !["stdio", "http", "sse"].contains(&req.server_type.as_str()) {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({
                "error": format!("Invalid server_type '{}'. Must be one of: stdio, http, sse", req.server_type)
            })),
        )
            .into_response();
    }

    // Validate type-specific requirements
    match req.server_type.as_str() {
        "stdio" if req.command.is_none() => {
            return (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({
                    "error": "Stdio MCP servers require a 'command' field"
                })),
            )
                .into_response();
        }
        "http" | "sse" if req.url.is_none() => {
            return (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({
                    "error": "HTTP/SSE MCP servers require a 'url' field"
                })),
            )
                .into_response();
        }
        _ => {}
    }

    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or(std::time::Duration::ZERO)
        .as_secs() as i64;

    let server = McpServer {
        id: generate(),
        profile_id: req.profile_id,
        name: req.name,
        server_type: req.server_type,
        command: req.command,
        args: req.args,
        env: req.env,
        url: req.url,
        headers: req.headers,
        enabled: req.enabled,
        created_at: now,
        updated_at: now,
    };

    match mcp_servers::create(server) {
        Ok(created) => {
            let response = McpServerResponse::from(created);
            (
                StatusCode::CREATED,
                Json(serde_json::to_value(response).unwrap()),
            )
                .into_response()
        }
        Err(rusqlite::Error::SqliteFailure(err, _))
            if err.code == rusqlite::ErrorCode::ConstraintViolation =>
        {
            (
                StatusCode::CONFLICT,
                Json(serde_json::json!({
                    "error": "An MCP server with this name already exists for the given profile"
                })),
            )
                .into_response()
        }
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({
                "error": format!("Failed to create MCP server: {}", e)
            })),
        )
            .into_response(),
    }
}

/// List MCP servers
///
/// GET /api/v1/mcp-servers
#[utoipa::path(
    get,
    path = "/api/v1/mcp-servers",
    tag = "MCP Servers",
    params(
        ("profile_id" = Option<String>, Query, description = "Filter by profile_id. Use 'global' for global servers."),
        ("enabled" = Option<bool>, Query, description = "Filter by enabled status"),
    ),
    responses(
        (status = 200, description = "List of MCP servers", body = ListMcpServersResponse),
        (status = 500, description = "Internal error"),
    )
)]
pub async fn list_mcp_servers(Query(query): Query<ListMcpServersQuery>) -> impl IntoResponse {
    let result = if query.profile_id.is_some() || query.enabled.is_some() {
        // Get all, then filter in Rust (simpler than building dynamic SQL)
        match mcp_servers::list() {
            Ok(servers) => {
                let filtered: Vec<_> = servers
                    .into_iter()
                    .filter(|s| {
                        let matches_profile = match &query.profile_id {
                            Some(pid) if pid == "global" => s.profile_id.is_none(),
                            Some(pid) => s.profile_id.as_deref() == Some(pid.as_str()),
                            None => true,
                        };
                        let matches_enabled = match query.enabled {
                            Some(e) => s.enabled == e,
                            None => true,
                        };
                        matches_profile && matches_enabled
                    })
                    .collect();
                Ok(filtered)
            }
            Err(e) => Err(e),
        }
    } else {
        mcp_servers::list()
    };

    match result {
        Ok(servers) => {
            let response = ListMcpServersResponse {
                servers: servers.into_iter().map(McpServerResponse::from).collect(),
            };
            (
                StatusCode::OK,
                Json(serde_json::to_value(response).unwrap()),
            )
                .into_response()
        }
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({
                "error": format!("Failed to list MCP servers: {}", e)
            })),
        )
            .into_response(),
    }
}

/// Get a single MCP server by ID
///
/// GET /api/v1/mcp-servers/{id}
#[utoipa::path(
    get,
    path = "/api/v1/mcp-servers/{id}",
    tag = "MCP Servers",
    params(
        ("id" = i64, Path, description = "MCP server ID"),
    ),
    responses(
        (status = 200, description = "MCP server found", body = McpServerResponse),
        (status = 404, description = "Not found"),
        (status = 500, description = "Internal error"),
    )
)]
pub async fn get_mcp_server(Path(id): Path<i64>) -> impl IntoResponse {
    match mcp_servers::get(id) {
        Ok(Some(server)) => {
            let response = McpServerResponse::from(server);
            (
                StatusCode::OK,
                Json(serde_json::to_value(response).unwrap()),
            )
                .into_response()
        }
        Ok(None) => (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({
                "error": format!("MCP server with id {} not found", id)
            })),
        )
            .into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({
                "error": format!("Failed to get MCP server: {}", e)
            })),
        )
            .into_response(),
    }
}

/// Update an MCP server configuration
///
/// PUT /api/v1/mcp-servers/{id}
#[utoipa::path(
    put,
    path = "/api/v1/mcp-servers/{id}",
    tag = "MCP Servers",
    params(
        ("id" = i64, Path, description = "MCP server ID"),
    ),
    request_body = UpdateMcpServerRequest,
    responses(
        (status = 200, description = "MCP server updated", body = McpServerResponse),
        (status = 400, description = "Invalid request"),
        (status = 404, description = "Not found"),
        (status = 409, description = "Name conflict"),
        (status = 500, description = "Internal error"),
    )
)]
pub async fn update_mcp_server(
    Path(id): Path<i64>,
    Json(req): Json<UpdateMcpServerRequest>,
) -> impl IntoResponse {
    // Fetch existing server
    let existing = match mcp_servers::get(id) {
        Ok(Some(s)) => s,
        Ok(None) => {
            return (
                StatusCode::NOT_FOUND,
                Json(serde_json::json!({
                    "error": format!("MCP server with id {} not found", id)
                })),
            )
                .into_response()
        }
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({
                    "error": format!("Failed to get MCP server: {}", e)
                })),
            )
                .into_response()
        }
    };

    // Build updated server
    let mut updated = existing;
    if let Some(v) = req.profile_id {
        updated.profile_id = Some(v);
    }
    if let Some(v) = req.name {
        updated.name = v;
    }
    if let Some(ref v) = req.server_type {
        if !["stdio", "http", "sse"].contains(&v.as_str()) {
            return (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({
                    "error": format!("Invalid server_type '{}'. Must be one of: stdio, http, sse", v)
                })),
            )
                .into_response();
        }
        updated.server_type = v.clone();
    }
    if let Some(v) = req.command {
        updated.command = Some(v);
    }
    if let Some(v) = req.args {
        updated.args = v;
    }
    if let Some(v) = req.env {
        updated.env = v;
    }
    if let Some(v) = req.url {
        updated.url = Some(v);
    }
    if let Some(v) = req.headers {
        updated.headers = v;
    }
    if let Some(v) = req.enabled {
        updated.enabled = v;
    }

    // Validate type-specific requirements after applying updates
    match updated.server_type.as_str() {
        "stdio" if updated.command.is_none() => {
            return (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({
                    "error": "Stdio MCP servers require a 'command' field"
                })),
            )
                .into_response();
        }
        "http" | "sse" if updated.url.is_none() => {
            return (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({
                    "error": "HTTP/SSE MCP servers require a 'url' field"
                })),
            )
                .into_response();
        }
        _ => {}
    }

    updated.updated_at = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or(std::time::Duration::ZERO)
        .as_secs() as i64;

    match mcp_servers::update(updated.clone()) {
        Ok(()) => {
            let response = McpServerResponse::from(updated);
            (
                StatusCode::OK,
                Json(serde_json::to_value(response).unwrap()),
            )
                .into_response()
        }
        Err(rusqlite::Error::SqliteFailure(err, _))
            if err.code == rusqlite::ErrorCode::ConstraintViolation =>
        {
            (
                StatusCode::CONFLICT,
                Json(serde_json::json!({
                    "error": "An MCP server with this name already exists for the given profile"
                })),
            )
                .into_response()
        }
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({
                "error": format!("Failed to update MCP server: {}", e)
            })),
        )
            .into_response(),
    }
}

/// Delete an MCP server
///
/// DELETE /api/v1/mcp-servers/{id}
#[utoipa::path(
    delete,
    path = "/api/v1/mcp-servers/{id}",
    tag = "MCP Servers",
    params(
        ("id" = i64, Path, description = "MCP server ID"),
    ),
    responses(
        (status = 204, description = "MCP server deleted"),
        (status = 404, description = "Not found"),
        (status = 500, description = "Internal error"),
    )
)]
pub async fn delete_mcp_server(Path(id): Path<i64>) -> impl IntoResponse {
    match mcp_servers::delete(id) {
        Ok(true) => StatusCode::NO_CONTENT.into_response(),
        Ok(false) => (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({
                "error": format!("MCP server with id {} not found", id)
            })),
        )
            .into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({
                "error": format!("Failed to delete MCP server: {}", e)
            })),
        )
            .into_response(),
    }
}

/// List MCP servers enabled for a specific profile (including global servers)
///
/// GET /api/v1/mcp-servers/for-profile/{profile_id}
///
/// Use "global" as profile_id to list only global servers.
/// This is what gets injected when an agent starts.
#[utoipa::path(
    get,
    path = "/api/v1/mcp-servers/for-profile/{profile_id}",
    tag = "MCP Servers",
    params(
        ("profile_id" = String, Path, description = "Agent profile ID. Use 'global' for global servers only."),
    ),
    responses(
        (status = 200, description = "List of enabled MCP servers for the profile", body = ListMcpServersResponse),
        (status = 500, description = "Internal error"),
    )
)]
pub async fn list_mcp_servers_for_profile(Path(profile_id): Path<String>) -> impl IntoResponse {
    let profile_opt = if profile_id == "global" {
        None
    } else {
        Some(profile_id.as_str())
    };

    match mcp_servers::list_enabled_for_profile(profile_opt) {
        Ok(servers) => {
            let response = ListMcpServersResponse {
                servers: servers.into_iter().map(McpServerResponse::from).collect(),
            };
            (
                StatusCode::OK,
                Json(serde_json::to_value(response).unwrap()),
            )
                .into_response()
        }
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({
                "error": format!("Failed to list MCP servers: {}", e)
            })),
        )
            .into_response(),
    }
}
