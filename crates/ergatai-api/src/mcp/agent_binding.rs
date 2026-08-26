//! Persistent agent binding storage for MCP reconnection support.
//!
//! This module stores MCP ↔ Runtime agent bindings in SQLite so they survive
//! server restarts and session reconnections.

use anyhow::Result;
use ergatai_error::ErgataiError;
use rusqlite::{params, Connection};
use std::sync::{Arc, Mutex};
use tracing::{debug, warn};

/// Parse RFC3339 timestamp, logging warning on failure and falling back to current time.
fn parse_timestamp(s: &str, field_name: &str) -> chrono::DateTime<chrono::Utc> {
    chrono::DateTime::parse_from_rfc3339(s)
        .map(|dt| dt.with_timezone(&chrono::Utc))
        .unwrap_or_else(|e| {
            warn!(
                error = %e,
                field = field_name,
                timestamp = s,
                "Failed to parse timestamp, using current time"
            );
            chrono::Utc::now()
        })
}

/// Represents a persistent binding between an MCP agent and a runtime agent.
#[derive(Debug, Clone)]
pub struct AgentBinding {
    /// MCP agent ID (e.g., "opencode@1a2b3c4d")
    pub mcp_agent_id: String,
    /// Runtime agent ID (e.g., "ws1-agent-1")
    pub runtime_agent_id: String,
    /// Agent identifier from URL path (e.g., "agent-1")
    pub agent_identifier: Option<String>,
    /// Timestamp when binding was created
    pub created_at: chrono::DateTime<chrono::Utc>,
    /// Timestamp of last activity (for cleanup)
    pub last_active: chrono::DateTime<chrono::Utc>,
}

/// Manages persistent agent bindings in SQLite.
pub struct AgentBindingStore {
    conn: Arc<Mutex<Connection>>,
}

impl AgentBindingStore {
    /// Create a new binding store.
    pub fn new(db_path: &str) -> Result<Self> {
        let conn = Connection::open(db_path).map_err(|e| {
            ErgataiError::DatabaseError(format!("Failed to open binding database: {}", e))
        })?;

        // Initialize schema
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS agent_bindings (
                mcp_agent_id TEXT PRIMARY KEY,
                runtime_agent_id TEXT NOT NULL,
                agent_identifier TEXT,
                created_at TEXT NOT NULL,
                last_active TEXT NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_bindings_runtime
                ON agent_bindings(runtime_agent_id);

            CREATE INDEX IF NOT EXISTS idx_bindings_identifier
                ON agent_bindings(agent_identifier);",
        )
        .map_err(|e| ErgataiError::DatabaseError(format!("Failed to create schema: {}", e)))?;

        Ok(Self {
            conn: Arc::new(Mutex::new(conn)),
        })
    }

    /// Store or update a binding.
    pub fn save_binding(&self, binding: &AgentBinding) -> Result<()> {
        let conn = self.conn.lock().map_err(|_| {
            ErgataiError::InternalError {
                message: "Binding store lock poisoned".to_string(),
                source: None,
            }
        })?;

        conn.execute(
            "INSERT OR REPLACE INTO agent_bindings
             (mcp_agent_id, runtime_agent_id, agent_identifier, created_at, last_active)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                binding.mcp_agent_id,
                binding.runtime_agent_id,
                binding.agent_identifier,
                binding.created_at.to_rfc3339(),
                binding.last_active.to_rfc3339(),
            ],
        )
        .map_err(|e| ErgataiError::DatabaseError(format!("Failed to save binding: {}", e)))?;

        debug!(
            mcp_agent_id = %binding.mcp_agent_id,
            runtime_agent_id = %binding.runtime_agent_id,
            "Saved agent binding"
        );

        Ok(())
    }

    /// Get a binding by MCP agent ID.
    pub fn get_binding(&self, mcp_agent_id: &str) -> Result<Option<AgentBinding>> {
        let conn = self.conn.lock().map_err(|_| {
            ErgataiError::InternalError {
                message: "Binding store lock poisoned".to_string(),
                source: None,
            }
        })?;

        let result = conn.query_row(
            "SELECT mcp_agent_id, runtime_agent_id, agent_identifier, created_at, last_active
             FROM agent_bindings
             WHERE mcp_agent_id = ?1",
            params![mcp_agent_id],
            |row| {
                let created_at: String = row.get(3)?;
                let last_active: String = row.get(4)?;
                Ok(AgentBinding {
                    mcp_agent_id: row.get(0)?,
                    runtime_agent_id: row.get(1)?,
                    agent_identifier: row.get(2)?,
                    created_at: parse_timestamp(&created_at, "created_at"),
                    last_active: parse_timestamp(&last_active, "last_active"),
                })
            },
        );

        match result {
            Ok(binding) => Ok(Some(binding)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => {
                warn!(error = %e, "Failed to query binding");
                Ok(None)
            }
        }
    }

    /// Get a binding by agent identifier.
    pub fn get_binding_by_identifier(
        &self,
        agent_identifier: &str,
    ) -> Result<Option<AgentBinding>> {
        let conn = self.conn.lock().map_err(|_| {
            ErgataiError::InternalError {
                message: "Binding store lock poisoned".to_string(),
                source: None,
            }
        })?;

        let result = conn.query_row(
            "SELECT mcp_agent_id, runtime_agent_id, agent_identifier, created_at, last_active
             FROM agent_bindings
             WHERE agent_identifier = ?1
             ORDER BY last_active DESC
             LIMIT 1",
            params![agent_identifier],
            |row| {
                let created_at: String = row.get(3)?;
                let last_active: String = row.get(4)?;
                Ok(AgentBinding {
                    mcp_agent_id: row.get(0)?,
                    runtime_agent_id: row.get(1)?,
                    agent_identifier: row.get(2)?,
                    created_at: parse_timestamp(&created_at, "created_at"),
                    last_active: parse_timestamp(&last_active, "last_active"),
                })
            },
        );

        match result {
            Ok(binding) => Ok(Some(binding)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => {
                warn!(error = %e, "Failed to query binding by identifier");
                Ok(None)
            }
        }
    }

    /// Update the last_active timestamp for a binding.
    pub fn touch_binding(&self, mcp_agent_id: &str) -> Result<()> {
        let conn = self.conn.lock().map_err(|_| {
            ErgataiError::InternalError {
                message: "Binding store lock poisoned".to_string(),
                source: None,
            }
        })?;

        let now = chrono::Utc::now().to_rfc3339();
        conn.execute(
            "UPDATE agent_bindings SET last_active = ?1 WHERE mcp_agent_id = ?2",
            params![now, mcp_agent_id],
        )
        .map_err(|e| ErgataiError::DatabaseError(format!("Failed to update binding: {}", e)))?;

        Ok(())
    }

    /// Remove a binding.
    pub fn remove_binding(&self, mcp_agent_id: &str) -> Result<()> {
        let conn = self.conn.lock().map_err(|_| {
            ErgataiError::InternalError {
                message: "Binding store lock poisoned".to_string(),
                source: None,
            }
        })?;

        conn.execute(
            "DELETE FROM agent_bindings WHERE mcp_agent_id = ?1",
            params![mcp_agent_id],
        )
        .map_err(|e| ErgataiError::DatabaseError(format!("Failed to remove binding: {}", e)))?;

        debug!(mcp_agent_id = %mcp_agent_id, "Removed agent binding");

        Ok(())
    }

    /// List all bindings.
    pub fn list_bindings(&self) -> Result<Vec<AgentBinding>> {
        let conn = self.conn.lock().map_err(|_| {
            ErgataiError::InternalError {
                message: "Binding store lock poisoned".to_string(),
                source: None,
            }
        })?;

        let mut stmt = conn
            .prepare(
                "SELECT mcp_agent_id, runtime_agent_id, agent_identifier, created_at, last_active
                 FROM agent_bindings
                 ORDER BY last_active DESC",
            )
            .map_err(|e| ErgataiError::DatabaseError(format!("Failed to prepare query: {}", e)))?;

        let bindings = stmt
            .query_map([], |row| {
                let created_at: String = row.get(3)?;
                let last_active: String = row.get(4)?;
                Ok(AgentBinding {
                    mcp_agent_id: row.get(0)?,
                    runtime_agent_id: row.get(1)?,
                    agent_identifier: row.get(2)?,
                    created_at: parse_timestamp(&created_at, "created_at"),
                    last_active: parse_timestamp(&last_active, "last_active"),
                })
            })
            .map_err(|e| ErgataiError::DatabaseError(format!("Failed to query bindings: {}", e)))?
            .collect::<std::result::Result<Vec<_>, _>>()
            .map_err(|e| {
                ErgataiError::DatabaseError(format!("Failed to collect bindings: {}", e))
            })?;

        Ok(bindings)
    }
}

// Global binding store instance
use std::sync::OnceLock;

static BINDING_STORE: OnceLock<Arc<AgentBindingStore>> = OnceLock::new();

/// Initialize the global binding store.
pub fn init_binding_store(db_path: &str) -> Result<Arc<AgentBindingStore>> {
    let store = AgentBindingStore::new(db_path)?;
    let arc = Arc::new(store);
    BINDING_STORE
        .set(arc.clone())
        .map_err(|_| ErgataiError::InternalError {
            message: "Binding store already initialized".to_string(),
            source: None,
        })?;
    Ok(arc)
}

/// Get the global binding store.
pub fn get_binding_store() -> Option<Arc<AgentBindingStore>> {
    BINDING_STORE.get().cloned()
}
