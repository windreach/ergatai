//! Persistence for suspended agent state.
//!
//! When an agent is suspended (manually, due to idle timeout, or on application
//! shutdown), its metadata is written to this store so it can be restored on
//! the next run. Each record captures everything needed to re-create the agent
//! in the same working environment: workspace, conversation, profile, working
//! directory, environment variables, and the reason it was suspended.
//!
//! Database: `{project_root}/.ergatai/suspended.db` (SQLite).

use std::path::Path;

use chrono::{DateTime, Utc};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use tracing::{debug, warn};

use ergatai_error::{ErgataiError, ErgataiResult};

/// Why an agent was suspended.
///
/// Stored as a snake_case string (`manual`, `idle`, `shutdown`) so it is easy
/// to inspect directly in the database.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum SuspendReason {
    /// User explicitly suspended the agent (default).
    #[default]
    Manual,
    /// Agent produced no output for the idle threshold (10 minutes).
    Idle,
    /// Application is shutting down; agent suspended for later resume.
    Shutdown,
}

impl SuspendReason {
    fn as_str(&self) -> &'static str {
        match self {
            Self::Manual => "manual",
            Self::Idle => "idle",
            Self::Shutdown => "shutdown",
        }
    }

    fn parse(s: &str) -> ErgataiResult<Self> {
        match s {
            "manual" => Ok(Self::Manual),
            "idle" => Ok(Self::Idle),
            "shutdown" => Ok(Self::Shutdown),
            other => Err(ErgataiError::internal(format!(
                "Unknown suspend reason: '{}'",
                other
            ))),
        }
    }
}

/// A persisted suspended-agent record.
///
/// Contains everything needed to re-create the agent in the same state: the
/// workspace it belonged to, the ACP conversation, the profile used to launch
/// it, the working directory, environment variables, and the reason it was
/// suspended.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SuspendedAgentRecord {
    /// Agent ID (the primary key — matches the runtime agent ID).
    pub id: String,
    /// Workspace the agent belonged to.
    pub workspace_id: String,
    /// ACP conversation ID, used to resume the same conversation.
    pub conversation_id: String,
    /// Agent profile name used to launch the agent.
    pub profile_name: String,
    /// Working directory.
    pub work_dir: String,
    /// Environment variables as JSON.
    pub environment: String,
    /// When the agent was suspended.
    pub suspended_at: DateTime<Utc>,
    /// Last known activity time (used for idle detection).
    pub last_activity: DateTime<Utc>,
    /// Why the agent was suspended.
    pub reason: SuspendReason,
    /// Optional metadata as JSON (free-form, for future extensions).
    pub metadata: Option<String>,
}

/// SQLite-backed store for suspended agents.
///
/// One row per suspended agent. Rows are inserted/updated when an agent is
/// suspended, and removed when the agent is resumed or permanently stopped.
///
/// The SQLite connection is cached and reused across operations to avoid the
/// overhead of opening/closing connections. Access is serialized via `Mutex`
/// since suspend/resume are low-frequency operations.
pub struct SuspendStore {
    conn: std::sync::Mutex<Connection>,
}

impl SuspendStore {
    /// Open (or create) the suspend store at the given path.
    ///
    /// Parent directories are created if they don't exist. The SQLite
    /// schema is initialized on open, and the connection is cached for reuse.
    pub fn open<P: AsRef<Path>>(db_path: P) -> ErgataiResult<Self> {
        let db_path_str = db_path.as_ref().to_string_lossy().to_string();

        if let Some(parent) = Path::new(&db_path_str).parent() {
            if !parent.as_os_str().is_empty() {
                std::fs::create_dir_all(parent).map_err(|e| {
                    ErgataiError::internal(format!(
                        "Failed to create suspend store directory '{}': {}",
                        parent.display(),
                        e
                    ))
                })?;
            }
        }

        let conn = Connection::open(&db_path_str).map_err(|e| {
            ErgataiError::internal(format!(
                "Failed to open suspend store '{}': {}",
                db_path_str, e
            ))
        })?;

        // Enable WAL mode for better concurrent read performance
        conn.execute_batch("PRAGMA journal_mode=WAL;")
            .map_err(|e| ErgataiError::internal(format!("Failed to set WAL mode: {}", e)))?;

        let store = Self {
            conn: std::sync::Mutex::new(conn),
        };
        store.init_schema()?;
        Ok(store)
    }

    /// Acquire the cached SQLite connection with error handling.
    ///
    /// This helper centralizes the lock acquisition pattern to avoid repeating
    /// the error mapping in every method.
    fn conn(&self) -> ErgataiResult<std::sync::MutexGuard<'_, Connection>> {
        self.conn.lock().map_err(|e| {
            ErgataiError::internal(format!("Failed to acquire connection lock: {}", e))
        })
    }

    fn init_schema(&self) -> ErgataiResult<()> {
        let conn = self.conn()?;
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS suspended_agents (
                id                TEXT PRIMARY KEY NOT NULL,
                workspace_id      TEXT NOT NULL,
                conversation_id   TEXT NOT NULL,
                profile_name      TEXT NOT NULL,
                work_dir          TEXT NOT NULL,
                environment       TEXT NOT NULL,
                suspended_at      INTEGER NOT NULL,
                last_activity     INTEGER NOT NULL,
                reason            TEXT NOT NULL,
                metadata          TEXT,
                created_at        INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
            );

            CREATE INDEX IF NOT EXISTS idx_suspended_conversation
                ON suspended_agents(conversation_id);

            CREATE INDEX IF NOT EXISTS idx_suspended_workspace
                ON suspended_agents(workspace_id);",
        )
        .map_err(|e| ErgataiError::internal(format!("Failed to init suspend schema: {}", e)))?;
        Ok(())
    }

    /// Save or update a suspended-agent record.
    ///
    /// Uses `INSERT ... ON CONFLICT DO UPDATE` so repeated calls for the same
    /// agent ID update the existing row (useful when an already-suspended agent
    /// needs its metadata refreshed).
    pub fn save_suspended(&self, record: &SuspendedAgentRecord) -> ErgataiResult<()> {
        let conn = self.conn()?;
        let suspended_at = record.suspended_at.timestamp();
        let last_activity = record.last_activity.timestamp();
        let reason = record.reason.as_str();

        conn.execute(
            "INSERT INTO suspended_agents
                (id, workspace_id, conversation_id, profile_name, work_dir,
                 environment, suspended_at, last_activity, reason, metadata)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
             ON CONFLICT(id) DO UPDATE SET
                workspace_id    = excluded.workspace_id,
                conversation_id = excluded.conversation_id,
                profile_name    = excluded.profile_name,
                work_dir        = excluded.work_dir,
                environment     = excluded.environment,
                suspended_at    = excluded.suspended_at,
                last_activity   = excluded.last_activity,
                reason          = excluded.reason,
                metadata        = excluded.metadata",
            params![
                record.id,
                record.workspace_id,
                record.conversation_id,
                record.profile_name,
                record.work_dir,
                record.environment,
                suspended_at,
                last_activity,
                reason,
                record.metadata,
            ],
        )
        .map_err(|e| {
            ErgataiError::internal(format!(
                "Failed to save suspended agent '{}' (workspace='{}', conversation='{}'): {}",
                record.id, record.workspace_id, record.conversation_id, e
            ))
        })?;

        debug!(
            agent_id = %record.id,
            workspace_id = %record.workspace_id,
            reason = %reason,
            "Saved suspended agent record"
        );
        Ok(())
    }

    /// Load a suspended-agent record by ID.
    ///
    /// Returns `None` if no record exists for this agent ID.
    pub fn load_suspended(&self, id: &str) -> ErgataiResult<Option<SuspendedAgentRecord>> {
        let conn = self.conn()?;
        let mut stmt = conn
            .prepare(
                "SELECT id, workspace_id, conversation_id, profile_name, work_dir,
                        environment, suspended_at, last_activity, reason, metadata
                 FROM suspended_agents
                 WHERE id = ?1",
            )
            .map_err(|e| {
                ErgataiError::internal(format!("Failed to prepare suspend load query: {}", e))
            })?;

        let mut rows = stmt
            .query_map(params![id], |row| {
                Ok(RowData {
                    id: row.get(0)?,
                    workspace_id: row.get(1)?,
                    conversation_id: row.get(2)?,
                    profile_name: row.get(3)?,
                    work_dir: row.get(4)?,
                    environment: row.get(5)?,
                    suspended_at: row.get(6)?,
                    last_activity: row.get(7)?,
                    reason: row.get(8)?,
                    metadata: row.get(9)?,
                })
            })
            .map_err(|e| {
                ErgataiError::internal(format!("Failed to query suspended agent: {}", e))
            })?;

        match rows.next() {
            Some(Ok(row)) => {
                let record = Self::row_to_record(row)?;
                debug!(agent_id = %record.id, "Loaded suspended agent record");
                Ok(Some(record))
            }
            Some(Err(e)) => {
                warn!(error = %e, "Failed to read suspended agent row");
                Ok(None)
            }
            None => Ok(None),
        }
    }

    /// Find a suspended-agent record by conversation ID.
    ///
    /// Returns `None` if no suspended agent belongs to this conversation.
    pub fn find_by_conversation(
        &self,
        conversation_id: &str,
    ) -> ErgataiResult<Option<SuspendedAgentRecord>> {
        let conn = self.conn()?;
        let mut stmt = conn
            .prepare(
                "SELECT id, workspace_id, conversation_id, profile_name, work_dir,
                        environment, suspended_at, last_activity, reason, metadata
                 FROM suspended_agents
                 WHERE conversation_id = ?1",
            )
            .map_err(|e| {
                ErgataiError::internal(format!(
                    "Failed to prepare suspend conversation query: {}",
                    e
                ))
            })?;

        let mut rows = stmt
            .query_map(params![conversation_id], |row| {
                Ok(RowData {
                    id: row.get(0)?,
                    workspace_id: row.get(1)?,
                    conversation_id: row.get(2)?,
                    profile_name: row.get(3)?,
                    work_dir: row.get(4)?,
                    environment: row.get(5)?,
                    suspended_at: row.get(6)?,
                    last_activity: row.get(7)?,
                    reason: row.get(8)?,
                    metadata: row.get(9)?,
                })
            })
            .map_err(|e| {
                ErgataiError::internal(format!(
                    "Failed to query suspended agent by conversation: {}",
                    e
                ))
            })?;

        match rows.next() {
            Some(Ok(row)) => {
                let record = Self::row_to_record(row)?;
                debug!(
                    agent_id = %record.id,
                    conversation_id = %conversation_id,
                    "Found suspended agent by conversation"
                );
                Ok(Some(record))
            }
            Some(Err(e)) => {
                warn!(error = %e, "Failed to read suspended agent row");
                Ok(None)
            }
            None => Ok(None),
        }
    }

    /// Remove a suspended-agent record.
    ///
    /// Called when the agent is resumed (re-launched) or permanently stopped.
    /// Removing a non-existent record is not an error.
    pub fn remove_suspended(&self, id: &str) -> ErgataiResult<()> {
        let conn = self.conn()?;
        conn.execute("DELETE FROM suspended_agents WHERE id = ?1", params![id])
            .map_err(|e| {
                ErgataiError::internal(format!("Failed to remove suspended agent '{}': {}", id, e))
            })?;
        debug!(agent_id = %id, "Removed suspended agent record");
        Ok(())
    }

    /// List all suspended-agent records.
    ///
    /// Used on startup to discover which agents need to be resumed.
    pub fn list_suspended(&self) -> ErgataiResult<Vec<SuspendedAgentRecord>> {
        let conn = self.conn()?;
        let mut stmt = conn
            .prepare(
                "SELECT id, workspace_id, conversation_id, profile_name, work_dir,
                        environment, suspended_at, last_activity, reason, metadata
                 FROM suspended_agents
                 ORDER BY suspended_at ASC",
            )
            .map_err(|e| {
                ErgataiError::internal(format!("Failed to prepare suspend list query: {}", e))
            })?;

        let rows = stmt
            .query_map([], |row| {
                Ok(RowData {
                    id: row.get(0)?,
                    workspace_id: row.get(1)?,
                    conversation_id: row.get(2)?,
                    profile_name: row.get(3)?,
                    work_dir: row.get(4)?,
                    environment: row.get(5)?,
                    suspended_at: row.get(6)?,
                    last_activity: row.get(7)?,
                    reason: row.get(8)?,
                    metadata: row.get(9)?,
                })
            })
            .map_err(|e| {
                ErgataiError::internal(format!("Failed to list suspended agents: {}", e))
            })?;

        let mut records = Vec::new();
        for row in rows {
            match row {
                Ok(row_data) => match Self::row_to_record(row_data) {
                    Ok(record) => records.push(record),
                    Err(e) => {
                        warn!(error = %e, "Skipping malformed suspended agent row");
                    }
                },
                Err(e) => {
                    warn!(error = %e, "Failed to read suspended agent row");
                }
            }
        }

        debug!(count = records.len(), "Listed suspended agent records");
        Ok(records)
    }

    /// Convert a raw SQLite row into a typed `SuspendedAgentRecord`.
    fn row_to_record(row: RowData) -> ErgataiResult<SuspendedAgentRecord> {
        let suspended_at =
            DateTime::<Utc>::from_timestamp(row.suspended_at, 0).ok_or_else(|| {
                ErgataiError::internal(format!(
                    "Invalid suspended_at timestamp {} for agent '{}'",
                    row.suspended_at, row.id
                ))
            })?;
        let last_activity =
            DateTime::<Utc>::from_timestamp(row.last_activity, 0).ok_or_else(|| {
                ErgataiError::internal(format!(
                    "Invalid last_activity timestamp {} for agent '{}'",
                    row.last_activity, row.id
                ))
            })?;
        let reason = SuspendReason::parse(&row.reason)?;

        Ok(SuspendedAgentRecord {
            id: row.id,
            workspace_id: row.workspace_id,
            conversation_id: row.conversation_id,
            profile_name: row.profile_name,
            work_dir: row.work_dir,
            environment: row.environment,
            suspended_at,
            last_activity,
            reason,
            metadata: row.metadata,
        })
    }
}

/// Raw row data as read from SQLite, before timestamp/enum conversion.
///
/// Separating the raw read from the typed conversion keeps the
/// `query_map` closure infallible for the database layer and funnels all
/// fallible parsing into one place.
struct RowData {
    id: String,
    workspace_id: String,
    conversation_id: String,
    profile_name: String,
    work_dir: String,
    environment: String,
    suspended_at: i64,
    last_activity: i64,
    reason: String,
    metadata: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::NamedTempFile;

    fn temp_store() -> SuspendStore {
        let tmp = NamedTempFile::new().unwrap();
        let path = tmp.path().to_path_buf();
        // Drop the tempfile so SuspendStore can create a fresh one
        drop(tmp);
        SuspendStore::open(&path).unwrap()
    }

    fn sample_record(id: &str, conversation_id: &str) -> SuspendedAgentRecord {
        SuspendedAgentRecord {
            id: id.to_string(),
            workspace_id: "ws-1".to_string(),
            conversation_id: conversation_id.to_string(),
            profile_name: "claude".to_string(),
            work_dir: "/workspace".to_string(),
            environment: "{}".to_string(),
            suspended_at: Utc::now(),
            last_activity: Utc::now(),
            reason: SuspendReason::Manual,
            metadata: None,
        }
    }

    #[test]
    fn save_and_load_suspended() {
        let store = temp_store();
        let record = sample_record("agent-1", "conv-1");
        store.save_suspended(&record).unwrap();

        let loaded = store.load_suspended("agent-1").unwrap().unwrap();
        assert_eq!(loaded.id, "agent-1");
        assert_eq!(loaded.workspace_id, "ws-1");
        assert_eq!(loaded.conversation_id, "conv-1");
        assert_eq!(loaded.profile_name, "claude");
        assert_eq!(loaded.work_dir, "/workspace");
        assert_eq!(loaded.environment, "{}");
        assert_eq!(loaded.reason, SuspendReason::Manual);
        assert!(loaded.metadata.is_none());
    }

    #[test]
    fn find_by_conversation() {
        let store = temp_store();
        let record = sample_record("agent-2", "conv-42");
        store.save_suspended(&record).unwrap();

        let found = store.find_by_conversation("conv-42").unwrap().unwrap();
        assert_eq!(found.id, "agent-2");
        assert_eq!(found.conversation_id, "conv-42");

        // Non-existent conversation returns None.
        assert!(store
            .find_by_conversation("no-such-conv")
            .unwrap()
            .is_none());
    }

    #[test]
    fn remove_suspended() {
        let store = temp_store();
        let record = sample_record("agent-3", "conv-3");
        store.save_suspended(&record).unwrap();

        store.remove_suspended("agent-3").unwrap();
        assert!(store.load_suspended("agent-3").unwrap().is_none());

        // Removing a non-existent record should not error.
        store.remove_suspended("does-not-exist").unwrap();
    }

    #[test]
    fn list_suspended() {
        let store = temp_store();
        assert!(store.list_suspended().unwrap().is_empty());

        let r1 = sample_record("agent-a", "conv-a");
        let r2 = sample_record("agent-b", "conv-b");
        store.save_suspended(&r1).unwrap();
        store.save_suspended(&r2).unwrap();

        let list = store.list_suspended().unwrap();
        assert_eq!(list.len(), 2);

        let mut ids: Vec<&str> = list.iter().map(|r| r.id.as_str()).collect();
        ids.sort();
        assert_eq!(ids, vec!["agent-a", "agent-b"]);
    }
}
