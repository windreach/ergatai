//! Agent Profile Registry — user-registered agent templates for quick spawning.
//!
//! Users register agent profiles with a command and type, then spawn agents
//! from profiles without re-typing the full command each time.
//!
//! # Example
//!
//! ```rust,no_run
//! use ergatai_runtime::profile_registry::{AgentRegistration, ProfileRegistry};
//!
//! # async fn example() -> ergatai_error::ErgataiResult<()> {
//! let registry = ProfileRegistry::new(".ergatai/profile_registry.db")?;
//!
//! // Register a profile
//! let registration = AgentRegistration {
//!     name: "my-claude".to_string(),
//!     command: "npx @anthropic/claude-acp".to_string(),
//!     agent_type: "acp".to_string(),
//!     created_at: chrono::Utc::now(),
//! };
//! registry.register(registration).await?;
//!
//! // Spawn from profile
//! let loaded = registry.get("my-claude").await?;
//! # Ok(())
//! # }
//! ```

use std::path::Path;

use chrono::{DateTime, Utc};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use tracing::{debug, info, warn};

use ergatai_error::{ErgataiError, ErgataiResult};

/// User-registered agent template.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentRegistration {
    /// Profile name (user-friendly identifier, unique).
    pub name: String,
    /// Command to start the agent (e.g., "python3 agent.py" or "npx @anthropic/claude-acp").
    pub command: String,
    /// Agent type: "acp" or "mcp" (future).
    pub agent_type: String,
    /// When the profile was registered.
    pub created_at: DateTime<Utc>,
}

impl AgentRegistration {
    /// Create a new agent registration with the current timestamp.
    pub fn new(name: String, command: String, agent_type: String) -> Self {
        Self {
            name,
            command,
            agent_type,
            created_at: Utc::now(),
        }
    }

    /// Validate the registration before storing.
    pub fn validate(&self) -> ErgataiResult<()> {
        if self.name.trim().is_empty() {
            return Err(ErgataiError::InvalidArgument(
                "Profile name cannot be empty".to_string(),
            ));
        }
        if self.command.trim().is_empty() {
            return Err(ErgataiError::InvalidArgument(
                "Profile command cannot be empty".to_string(),
            ));
        }
        if self.agent_type.trim().is_empty() {
            return Err(ErgataiError::InvalidArgument(
                "Agent type cannot be empty".to_string(),
            ));
        }
        // Validate agent type
        match self.agent_type.to_lowercase().as_str() {
            "acp" | "mcp" => Ok(()),
            other => Err(ErgataiError::InvalidArgument(format!(
                "Invalid agent type '{}': must be 'acp' or 'mcp'",
                other
            ))),
        }
    }
}

/// SQLite-backed registry for agent profiles.
pub struct ProfileRegistry {
    db_path: String,
}

impl ProfileRegistry {
    /// Create a new profile registry at the given path.
    pub fn new<P: AsRef<Path>>(db_path: P) -> ErgataiResult<Self> {
        let db_path = db_path.as_ref().to_string_lossy().to_string();

        // Ensure parent directory exists
        if let Some(parent) = Path::new(&db_path).parent() {
            std::fs::create_dir_all(parent).map_err(|e| {
                ErgataiError::internal(format!(
                    "Failed to create directory for profile registry: {}",
                    e
                ))
            })?;
        }

        let registry = Self { db_path };
        registry.init_db()?;
        Ok(registry)
    }

    /// Initialize the database schema.
    fn init_db(&self) -> ErgataiResult<()> {
        let conn = Connection::open(&self.db_path).map_err(|e| {
            ErgataiError::internal(format!("Failed to open profile registry database: {}", e))
        })?;

        // Enable WAL mode for better concurrent read/write performance
        conn.execute_batch(
            "
            PRAGMA journal_mode=WAL;
            PRAGMA synchronous=NORMAL;
            PRAGMA cache_size=-64000;
            PRAGMA foreign_keys=ON;
            PRAGMA wal_autocheckpoint=100;
            ",
        )
        .map_err(|e| ErgataiError::internal(format!("Failed to set pragmas: {}", e)))?;

        // Verify WAL mode was actually enabled
        let journal_mode: String = conn
            .query_row("PRAGMA journal_mode", [], |row| row.get(0))
            .map_err(|e| ErgataiError::internal(format!("Failed to query journal mode: {}", e)))?;
        if journal_mode.to_lowercase() != "wal" {
            warn!(
                "Failed to enable WAL journal mode for profile registry (current: {}). \
                 Concurrent read/write performance may be degraded.",
                journal_mode
            );
        }

        conn.execute(
            "CREATE TABLE IF NOT EXISTS agent_registrations (
                name TEXT PRIMARY KEY,
                command TEXT NOT NULL,
                agent_type TEXT NOT NULL,
                created_at TEXT NOT NULL
            )",
            [],
        )
        .map_err(|e| {
            ErgataiError::internal(format!("Failed to create agent_registrations table: {}", e))
        })?;

        debug!(
            "Profile registry initialized at {} (WAL mode)",
            self.db_path
        );
        Ok(())
    }

    /// Register a new agent profile.
    pub async fn register(&self, registration: AgentRegistration) -> ErgataiResult<()> {
        registration.validate()?;

        let conn = Connection::open(&self.db_path).map_err(|e| {
            ErgataiError::internal(format!("Failed to open profile registry database: {}", e))
        })?;

        conn.execute(
            "INSERT INTO agent_registrations (name, command, agent_type, created_at)
             VALUES (?1, ?2, ?3, ?4)",
            params![
                registration.name,
                registration.command,
                registration.agent_type,
                registration.created_at.to_rfc3339()
            ],
        )
        .map_err(|e| {
            if e.to_string().contains("UNIQUE constraint failed") {
                ErgataiError::InvalidArgument(format!(
                    "Agent profile '{}' already exists",
                    registration.name
                ))
            } else {
                ErgataiError::internal(format!("Failed to register agent profile: {}", e))
            }
        })?;

        info!(name = %registration.name, agent_type = %registration.agent_type, "Registered agent profile");
        Ok(())
    }

    /// Get a profile by name.
    pub async fn get(&self, name: &str) -> ErgataiResult<Option<AgentRegistration>> {
        let conn = Connection::open(&self.db_path).map_err(|e| {
            ErgataiError::internal(format!("Failed to open profile registry database: {}", e))
        })?;

        let mut stmt = conn
            .prepare(
                "SELECT name, command, agent_type, created_at
                 FROM agent_registrations WHERE name = ?1",
            )
            .map_err(|e| ErgataiError::internal(format!("Failed to prepare query: {}", e)))?;

        let result = stmt
            .query_row(params![name], |row| {
                let created_at_str: String = row.get(3)?;
                let created_at = DateTime::parse_from_rfc3339(&created_at_str)
                    .map(|dt| dt.with_timezone(&Utc))
                    .unwrap_or_else(|_| Utc::now());

                Ok(AgentRegistration {
                    name: row.get(0)?,
                    command: row.get(1)?,
                    agent_type: row.get(2)?,
                    created_at,
                })
            })
            .optional()
            .map_err(|e| ErgataiError::internal(format!("Failed to get agent profile: {}", e)))?;

        Ok(result)
    }

    /// List all registered profiles.
    pub async fn list(&self) -> ErgataiResult<Vec<AgentRegistration>> {
        let conn = Connection::open(&self.db_path).map_err(|e| {
            ErgataiError::internal(format!("Failed to open profile registry database: {}", e))
        })?;

        let mut stmt = conn
            .prepare(
                "SELECT name, command, agent_type, created_at
                 FROM agent_registrations ORDER BY created_at DESC",
            )
            .map_err(|e| ErgataiError::internal(format!("Failed to prepare query: {}", e)))?;

        let profiles = stmt
            .query_map([], |row| {
                let created_at_str: String = row.get(3)?;
                let created_at = DateTime::parse_from_rfc3339(&created_at_str)
                    .map(|dt| dt.with_timezone(&Utc))
                    .unwrap_or_else(|_| Utc::now());

                Ok(AgentRegistration {
                    name: row.get(0)?,
                    command: row.get(1)?,
                    agent_type: row.get(2)?,
                    created_at,
                })
            })
            .map_err(|e| ErgataiError::internal(format!("Failed to list agent profiles: {}", e)))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| {
                ErgataiError::internal(format!("Failed to collect agent profiles: {}", e))
            })?;

        Ok(profiles)
    }

    /// Delete a profile by name.
    pub async fn delete(&self, name: &str) -> ErgataiResult<bool> {
        let conn = Connection::open(&self.db_path).map_err(|e| {
            ErgataiError::internal(format!("Failed to open profile registry database: {}", e))
        })?;

        let rows_affected = conn
            .execute(
                "DELETE FROM agent_registrations WHERE name = ?1",
                params![name],
            )
            .map_err(|e| {
                ErgataiError::internal(format!("Failed to delete agent profile: {}", e))
            })?;

        if rows_affected > 0 {
            info!(name = %name, "Deleted agent profile");
        }

        Ok(rows_affected > 0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::NamedTempFile;

    #[tokio::test]
    async fn test_register_and_get() {
        let temp_file = NamedTempFile::new().unwrap();
        let registry = ProfileRegistry::new(temp_file.path()).unwrap();

        let registration = AgentRegistration::new(
            "test-agent".to_string(),
            "python3 test.py".to_string(),
            "acp".to_string(),
        );

        registry.register(registration.clone()).await.unwrap();

        let loaded = registry.get("test-agent").await.unwrap().unwrap();
        assert_eq!(loaded.name, "test-agent");
        assert_eq!(loaded.command, "python3 test.py");
        assert_eq!(loaded.agent_type, "acp");
    }

    #[tokio::test]
    async fn test_list_registrations() {
        let temp_file = NamedTempFile::new().unwrap();
        let registry = ProfileRegistry::new(temp_file.path()).unwrap();

        registry
            .register(AgentRegistration::new(
                "agent-1".to_string(),
                "cmd1".to_string(),
                "acp".to_string(),
            ))
            .await
            .unwrap();

        registry
            .register(AgentRegistration::new(
                "agent-2".to_string(),
                "cmd2".to_string(),
                "mcp".to_string(),
            ))
            .await
            .unwrap();

        let profiles = registry.list().await.unwrap();
        assert_eq!(profiles.len(), 2);
    }

    #[tokio::test]
    async fn test_delete_registration() {
        let temp_file = NamedTempFile::new().unwrap();
        let registry = ProfileRegistry::new(temp_file.path()).unwrap();

        registry
            .register(AgentRegistration::new(
                "to-delete".to_string(),
                "cmd".to_string(),
                "acp".to_string(),
            ))
            .await
            .unwrap();

        assert!(registry.delete("to-delete").await.unwrap());
        assert!(registry.get("to-delete").await.unwrap().is_none());
    }

    #[tokio::test]
    async fn test_duplicate_name_error() {
        let temp_file = NamedTempFile::new().unwrap();
        let registry = ProfileRegistry::new(temp_file.path()).unwrap();

        let registration = AgentRegistration::new(
            "duplicate".to_string(),
            "cmd1".to_string(),
            "acp".to_string(),
        );

        registry.register(registration.clone()).await.unwrap();
        let result = registry.register(registration).await;
        assert!(result.is_err());
        assert!(result.unwrap_err().to_string().contains("already exists"));
    }

    #[test]
    fn test_validate_registration() {
        let valid =
            AgentRegistration::new("test".to_string(), "cmd".to_string(), "acp".to_string());
        assert!(valid.validate().is_ok());

        let empty_name =
            AgentRegistration::new("".to_string(), "cmd".to_string(), "acp".to_string());
        assert!(empty_name.validate().is_err());

        let invalid_type =
            AgentRegistration::new("test".to_string(), "cmd".to_string(), "invalid".to_string());
        assert!(invalid_type.validate().is_err());
    }
}
