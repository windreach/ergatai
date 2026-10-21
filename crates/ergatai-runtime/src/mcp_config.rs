//! MCP configuration loader for agent startup.
//!
//! Loads user-configured MCP servers from the database when agents start.

use rusqlite::{params, Connection, Result};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use tracing::debug;

/// User-configured MCP server (loaded from database)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UserMcpServer {
    pub id: i64,
    pub profile_id: Option<String>,
    pub name: String,
    pub server_type: String, // "stdio", "http", "sse"
    pub command: Option<String>,
    pub args: Vec<String>,
    pub env: HashMap<String, String>,
    pub url: Option<String>,
    pub headers: HashMap<String, String>,
    pub enabled: bool,
}

/// Helper function to deserialize MCP server from database row
fn deserialize_server(row: &rusqlite::Row) -> rusqlite::Result<UserMcpServer> {
    let args_str: String = row.get(5)?;
    let env_str: String = row.get(6)?;
    let headers_str: String = row.get(8)?;

    let args = serde_json::from_str(&args_str).unwrap_or_else(|e| {
        tracing::warn!(
            server_id = row.get::<_, String>(0).unwrap_or_default(),
            error = %e,
            "Failed to parse args JSON from database, using empty array"
        );
        Vec::new()
    });

    let env = serde_json::from_str(&env_str).unwrap_or_else(|e| {
        tracing::warn!(
            server_id = row.get::<_, String>(0).unwrap_or_default(),
            error = %e,
            "Failed to parse env JSON from database, using empty map"
        );
        HashMap::new()
    });

    let headers = serde_json::from_str(&headers_str).unwrap_or_else(|e| {
        tracing::warn!(
            server_id = row.get::<_, String>(0).unwrap_or_default(),
            error = %e,
            "Failed to parse headers JSON from database, using empty map"
        );
        HashMap::new()
    });

    Ok(UserMcpServer {
        id: row.get(0)?,
        profile_id: row.get(1)?,
        name: row.get(2)?,
        server_type: row.get(3)?,
        command: row.get(4)?,
        args,
        env,
        url: row.get(7)?,
        headers,
        enabled: row.get::<_, i64>(9)? != 0,
    })
}

/// Load enabled MCP servers for a specific agent profile
///
/// Returns both profile-specific and global MCP servers (where profile_id IS NULL).
/// Profile-specific servers are listed first.
pub fn load_mcp_servers_for_profile(
    conn: &Connection,
    profile_id: Option<&str>,
) -> Result<Vec<UserMcpServer>> {
    let mut stmt = conn.prepare(
        "SELECT id, profile_id, name, server_type, command, args, env, url, headers, enabled
         FROM mcp_servers
         WHERE enabled = 1 AND (profile_id IS ?1 OR profile_id IS NULL)
         ORDER BY profile_id DESC, created_at DESC",
    )?;

    let servers = stmt.query_map(params![profile_id], deserialize_server)?;

    let result: Vec<UserMcpServer> = servers.collect::<Result<Vec<_>>>()?;
    debug!(
        profile_id = ?profile_id,
        count = result.len(),
        "Loaded MCP servers for profile"
    );
    Ok(result)
}

/// Load all enabled MCP servers (global only, for backward compatibility)
pub fn load_global_mcp_servers(conn: &Connection) -> Result<Vec<UserMcpServer>> {
    let mut stmt = conn.prepare(
        "SELECT id, profile_id, name, server_type, command, args, env, url, headers, enabled
         FROM mcp_servers
         WHERE enabled = 1 AND profile_id IS NULL
         ORDER BY created_at DESC",
    )?;

    let servers = stmt.query_map([], deserialize_server)?;

    let result: Vec<UserMcpServer> = servers.collect::<Result<Vec<_>>>()?;
    debug!(count = result.len(), "Loaded global MCP servers");
    Ok(result)
}
