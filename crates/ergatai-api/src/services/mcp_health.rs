//! MCP server health probing and tool/prompt invocation.
//!
//! Implemented with the official `rmcp` client SDK instead of hand-rolled
//! JSON-RPC, so transport, protocol version negotiation, and message framing
//! are handled by the SDK.

use crate::user_data_db::McpServer;
use axum::http::{HeaderName, HeaderValue};
use rmcp::{
    transport::{
        streamable_http_client::{
            StreamableHttpClientTransport, StreamableHttpClientTransportConfig,
        },
        TokioChildProcess,
    },
    ServiceExt,
};
use std::collections::HashMap;
use std::str::FromStr;
use std::sync::Mutex;
use std::time::{Duration, Instant};

#[derive(Debug, Clone)]
pub struct McpHealth {
    pub status: String, // "connected" | "failed"
    pub tools: Vec<String>,
    pub error: Option<String>,
}

impl McpHealth {
    fn connected(tools: Vec<String>) -> Self {
        Self {
            status: "connected".to_string(),
            tools,
            error: None,
        }
    }
    fn failed(error: impl Into<String>) -> Self {
        Self {
            status: "failed".to_string(),
            tools: Vec::new(),
            error: Some(error.into()),
        }
    }
}

struct CacheEntry {
    health: McpHealth,
    created_at: Instant,
}

static CACHE: Mutex<Option<HashMap<i64, CacheEntry>>> = Mutex::new(None);
const CACHE_TTL: Duration = Duration::from_secs(30);

fn cache_get(id: i64) -> Option<McpHealth> {
    let guard = CACHE.lock().unwrap();
    if let Some(map) = guard.as_ref() {
        if let Some(entry) = map.get(&id) {
            if entry.created_at.elapsed() < CACHE_TTL {
                return Some(entry.health.clone());
            }
        }
    }
    None
}

fn cache_set(id: i64, health: McpHealth) {
    let mut guard = CACHE.lock().unwrap();
    let map = guard.get_or_insert_with(HashMap::new);
    map.insert(
        id,
        CacheEntry {
            health,
            created_at: Instant::now(),
        },
    );
}

// ── Connection helpers ──────────────────────────────────────────────────────

async fn connect_stdio(
    server: &McpServer,
) -> Result<rmcp::service::RunningService<rmcp::service::RoleClient, ()>, String> {
    let command = server
        .command
        .clone()
        .filter(|c| !c.trim().is_empty())
        .ok_or_else(|| "missing command".to_string())?;
    let mut cmd = tokio::process::Command::new(&command);
    cmd.args(&server.args);
    for (k, v) in &server.env {
        cmd.env(k, v);
    }
    let transport = TokioChildProcess::new(cmd).map_err(|e| format!("spawn failed: {}", e))?;
    tokio::time::timeout(Duration::from_secs(10), ().serve(transport))
        .await
        .map_err(|_| "initialize timeout".to_string())?
        .map_err(|e| format!("initialize failed: {}", e))
}

async fn connect_http(
    server: &McpServer,
) -> Result<rmcp::service::RunningService<rmcp::service::RoleClient, ()>, String> {
    let url = server
        .url
        .clone()
        .filter(|u| !u.trim().is_empty())
        .ok_or_else(|| "missing url".to_string())?;
    let mut headers = HashMap::new();
    for (k, v) in &server.headers {
        if let (Ok(name), Ok(val)) = (HeaderName::from_str(k), HeaderValue::from_str(v)) {
            headers.insert(name, val);
        }
    }
    let config = StreamableHttpClientTransportConfig::with_uri(url).custom_headers(headers);
    let transport = StreamableHttpClientTransport::from_config(config);
    tokio::time::timeout(Duration::from_secs(10), ().serve(transport))
        .await
        .map_err(|_| "initialize timeout".to_string())?
        .map_err(|e| format!("initialize failed: {}", e))
}

async fn connect(
    server: &McpServer,
) -> Result<rmcp::service::RunningService<rmcp::service::RoleClient, ()>, String> {
    match server.server_type.as_str() {
        "stdio" => connect_stdio(server).await,
        "http" | "sse" => connect_http(server).await,
        other => Err(format!("unsupported type: {}", other)),
    }
}

// ── Health check ────────────────────────────────────────────────────────────

pub async fn check(server: &McpServer) -> McpHealth {
    if !server.enabled {
        return McpHealth::failed("disabled");
    }
    if let Some(cached) = cache_get(server.id) {
        return cached;
    }
    let client = match connect(server).await {
        Ok(c) => c,
        Err(e) => {
            let health = McpHealth::failed(e);
            cache_set(server.id, health.clone());
            return health;
        }
    };
    let tools = match tokio::time::timeout(Duration::from_secs(5), client.list_all_tools()).await {
        Ok(Ok(t)) => t.into_iter().map(|t| t.name.to_string()).collect(),
        Ok(Err(e)) => {
            let _ = client.cancel().await;
            let health = McpHealth::failed(format!("list tools failed: {}", e));
            cache_set(server.id, health.clone());
            return health;
        }
        Err(_) => {
            let _ = client.cancel().await;
            let health = McpHealth::failed("list tools timeout");
            cache_set(server.id, health.clone());
            return health;
        }
    };
    let _ = client.cancel().await;
    let health = McpHealth::connected(tools);
    cache_set(server.id, health.clone());
    health
}
