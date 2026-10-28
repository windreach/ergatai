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

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;

    fn setup_test_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute(
            "CREATE TABLE mcp_servers (
                id INTEGER PRIMARY KEY,
                profile_id TEXT,
                name TEXT NOT NULL,
                server_type TEXT NOT NULL,
                command TEXT,
                args TEXT NOT NULL DEFAULT '[]',
                env TEXT NOT NULL DEFAULT '{}',
                url TEXT,
                headers TEXT NOT NULL DEFAULT '{}',
                enabled INTEGER NOT NULL DEFAULT 1,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            )",
            [],
        )
        .unwrap();
        conn
    }

    #[test]
    fn test_deserialize_server_with_valid_json() {
        let conn = setup_test_db();
        conn.execute(
            "INSERT INTO mcp_servers (id, profile_id, name, server_type, command, args, env, url, headers, enabled)
             VALUES (1, 'profile1', 'test-server', 'stdio', '/usr/bin/test', '[\"--arg1\", \"--arg2\"]', '{\"KEY\": \"value\"}', NULL, '{\"X-Custom\": \"header\"}', 1)",
            [],
        ).unwrap();

        let servers = load_mcp_servers_for_profile(&conn, Some("profile1")).unwrap();
        assert_eq!(servers.len(), 1);

        let server = &servers[0];
        assert_eq!(server.id, 1);
        assert_eq!(server.profile_id, Some("profile1".to_string()));
        assert_eq!(server.name, "test-server");
        assert_eq!(server.server_type, "stdio");
        assert_eq!(server.command, Some("/usr/bin/test".to_string()));
        assert_eq!(server.args, vec!["--arg1", "--arg2"]);
        assert_eq!(server.env.get("KEY"), Some(&"value".to_string()));
        assert_eq!(server.url, None);
        assert_eq!(server.headers.get("X-Custom"), Some(&"header".to_string()));
        assert!(server.enabled);
    }

    #[test]
    fn test_deserialize_server_with_invalid_json_falls_back_to_empty() {
        let conn = setup_test_db();
        conn.execute(
            "INSERT INTO mcp_servers (id, profile_id, name, server_type, command, args, env, url, headers, enabled)
             VALUES (1, NULL, 'test-server', 'http', NULL, 'invalid-json', 'also-invalid', 'http://localhost:3000', 'bad-json', 1)",
            [],
        ).unwrap();

        let servers = load_global_mcp_servers(&conn).unwrap();
        assert_eq!(servers.len(), 1);

        let server = &servers[0];
        // Invalid JSON should fall back to empty collections
        assert!(server.args.is_empty());
        assert!(server.env.is_empty());
        assert!(server.headers.is_empty());
        assert_eq!(server.url, Some("http://localhost:3000".to_string()));
    }

    #[test]
    fn test_load_mcp_servers_for_profile_includes_global() {
        let conn = setup_test_db();

        // Insert global server (profile_id IS NULL)
        conn.execute(
            "INSERT INTO mcp_servers (id, profile_id, name, server_type, command, args, env, url, headers, enabled)
             VALUES (1, NULL, 'global-server', 'stdio', '/usr/bin/global', '[]', '{}', NULL, '{}', 1)",
            [],
        ).unwrap();

        // Insert profile-specific server
        conn.execute(
            "INSERT INTO mcp_servers (id, profile_id, name, server_type, command, args, env, url, headers, enabled)
             VALUES (2, 'profile1', 'profile-server', 'http', NULL, '[]', '{}', 'http://localhost', '{}', 1)",
            [],
        ).unwrap();

        // Load for profile1 - should include both global and profile-specific
        let servers = load_mcp_servers_for_profile(&conn, Some("profile1")).unwrap();
        assert_eq!(servers.len(), 2);

        // Profile-specific servers should be listed first (ORDER BY profile_id DESC)
        assert_eq!(servers[0].name, "profile-server");
        assert_eq!(servers[1].name, "global-server");
    }

    #[test]
    fn test_load_mcp_servers_for_profile_excludes_other_profiles() {
        let conn = setup_test_db();

        conn.execute(
            "INSERT INTO mcp_servers (id, profile_id, name, server_type, command, args, env, url, headers, enabled)
             VALUES (1, 'profile1', 'server1', 'stdio', '/bin/s1', '[]', '{}', NULL, '{}', 1)",
            [],
        ).unwrap();

        conn.execute(
            "INSERT INTO mcp_servers (id, profile_id, name, server_type, command, args, env, url, headers, enabled)
             VALUES (2, 'profile2', 'server2', 'stdio', '/bin/s2', '[]', '{}', NULL, '{}', 1)",
            [],
        ).unwrap();

        // Load for profile1 - should NOT include profile2's server
        let servers = load_mcp_servers_for_profile(&conn, Some("profile1")).unwrap();
        assert_eq!(servers.len(), 1);
        assert_eq!(servers[0].name, "server1");
    }

    #[test]
    fn test_load_global_mcp_servers_only() {
        let conn = setup_test_db();

        conn.execute(
            "INSERT INTO mcp_servers (id, profile_id, name, server_type, command, args, env, url, headers, enabled)
             VALUES (1, NULL, 'global1', 'stdio', '/bin/g1', '[]', '{}', NULL, '{}', 1)",
            [],
        ).unwrap();

        conn.execute(
            "INSERT INTO mcp_servers (id, profile_id, name, server_type, command, args, env, url, headers, enabled)
             VALUES (2, 'profile1', 'profile1', 'stdio', '/bin/p1', '[]', '{}', NULL, '{}', 1)",
            [],
        ).unwrap();

        // Load global only
        let servers = load_global_mcp_servers(&conn).unwrap();
        assert_eq!(servers.len(), 1);
        assert_eq!(servers[0].name, "global1");
    }

    #[test]
    fn test_disabled_servers_not_loaded() {
        let conn = setup_test_db();

        conn.execute(
            "INSERT INTO mcp_servers (id, profile_id, name, server_type, command, args, env, url, headers, enabled)
             VALUES (1, NULL, 'enabled-server', 'stdio', '/bin/e', '[]', '{}', NULL, '{}', 1)",
            [],
        ).unwrap();

        conn.execute(
            "INSERT INTO mcp_servers (id, profile_id, name, server_type, command, args, env, url, headers, enabled)
             VALUES (2, NULL, 'disabled-server', 'stdio', '/bin/d', '[]', '{}', NULL, '{}', 0)",
            [],
        ).unwrap();

        let servers = load_global_mcp_servers(&conn).unwrap();
        assert_eq!(servers.len(), 1);
        assert_eq!(servers[0].name, "enabled-server");
    }

    #[test]
    fn test_http_server_with_url_and_headers() {
        let conn = setup_test_db();
        conn.execute(
            "INSERT INTO mcp_servers (id, profile_id, name, server_type, command, args, env, url, headers, enabled)
             VALUES (1, NULL, 'http-server', 'http', NULL, '[]', '{}', 'http://api.example.com', '{\"Authorization\": \"Bearer token123\"}', 1)",
            [],
        ).unwrap();

        let servers = load_global_mcp_servers(&conn).unwrap();
        assert_eq!(servers.len(), 1);

        let server = &servers[0];
        assert_eq!(server.server_type, "http");
        assert_eq!(server.command, None);
        assert_eq!(server.url, Some("http://api.example.com".to_string()));
        assert_eq!(
            server.headers.get("Authorization"),
            Some(&"Bearer token123".to_string())
        );
    }

    #[test]
    fn test_sse_server_type() {
        let conn = setup_test_db();
        conn.execute(
            "INSERT INTO mcp_servers (id, profile_id, name, server_type, command, args, env, url, headers, enabled)
             VALUES (1, NULL, 'sse-server', 'sse', NULL, '[]', '{}', 'http://sse.example.com', '{}', 1)",
            [],
        ).unwrap();

        let servers = load_global_mcp_servers(&conn).unwrap();
        assert_eq!(servers.len(), 1);
        assert_eq!(servers[0].server_type, "sse");
    }

    #[test]
    fn test_empty_database_returns_empty_vec() {
        let conn = setup_test_db();
        let servers = load_global_mcp_servers(&conn).unwrap();
        assert!(servers.is_empty());
    }

    #[test]
    fn test_multiple_args_and_env_vars() {
        let conn = setup_test_db();
        conn.execute(
            "INSERT INTO mcp_servers (id, profile_id, name, server_type, command, args, env, url, headers, enabled)
             VALUES (1, NULL, 'complex-server', 'stdio', '/usr/bin/server', '[\"--verbose\", \"--config\", \"/etc/config.json\"]', '{\"DB_HOST\": \"localhost\", \"DB_PORT\": \"5432\", \"LOG_LEVEL\": \"debug\"}', NULL, '{}', 1)",
            [],
        ).unwrap();

        let servers = load_global_mcp_servers(&conn).unwrap();
        assert_eq!(servers.len(), 1);

        let server = &servers[0];
        assert_eq!(server.args.len(), 3);
        assert_eq!(server.args[0], "--verbose");
        assert_eq!(server.args[1], "--config");
        assert_eq!(server.args[2], "/etc/config.json");

        assert_eq!(server.env.len(), 3);
        assert_eq!(server.env.get("DB_HOST"), Some(&"localhost".to_string()));
        assert_eq!(server.env.get("DB_PORT"), Some(&"5432".to_string()));
        assert_eq!(server.env.get("LOG_LEVEL"), Some(&"debug".to_string()));
    }
}
