//! Session persistence for ACP agent sessions.
//!
//! Stores `session_id` for each agent so that on restart we can use
//! `session/load` (instead of `session/new`) to restore the agent's
//! conversation context, assuming the agent binary persists its own state.
//!
//! Database: `{project_root}/.ergatai/sessions.db` (SQLite).

use std::path::Path;

use rusqlite::{params, Connection};
use tracing::{debug, warn};

use ergatai_error::{ErgataiError, ErgataiResult};

/// A persisted ACP session record.
#[derive(Clone, Debug)]
pub struct SessionRecord {
    /// Stable agent identifier (typically the `agent_id` from the workspace).
    pub agent_uuid: String,
    /// ACP session ID returned by `session/new` or `session/load`.
    pub session_id: String,
    /// The command used to start the agent (for compatibility checks on load).
    pub command: String,
    /// The working directory the session was created in.
    pub cwd: String,
}

/// SQLite-backed session store.
///
/// One row per active agent session. Rows are inserted/updated when a session
/// is created or loaded, and removed when the agent is explicitly stopped.
pub struct SessionStore {
    db_path: String,
}

impl SessionStore {
    /// Open (or create) the session store at the given path.
    ///
    /// Parent directories are created if they don't exist.
    pub fn open<P: AsRef<Path>>(db_path: P) -> ErgataiResult<Self> {
        let db_path = db_path.as_ref().to_string_lossy().to_string();

        if let Some(parent) = Path::new(&db_path).parent() {
            if !parent.as_os_str().is_empty() {
                std::fs::create_dir_all(parent).map_err(|e| {
                    ErgataiError::internal(format!(
                        "Failed to create session store directory '{}': {}",
                        parent.display(),
                        e
                    ))
                })?;
            }
        }

        let store = Self { db_path };
        store.init_schema()?;
        Ok(store)
    }

    fn conn(&self) -> ErgataiResult<Connection> {
        Connection::open(&self.db_path).map_err(|e| {
            ErgataiError::internal(format!(
                "Failed to open session store '{}': {}",
                self.db_path, e
            ))
        })
    }

    fn init_schema(&self) -> ErgataiResult<()> {
        let conn = self.conn()?;
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS agent_sessions (
                agent_uuid  TEXT PRIMARY KEY NOT NULL,
                session_id  TEXT NOT NULL,
                command     TEXT NOT NULL,
                cwd         TEXT NOT NULL,
                created_at  INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
                updated_at  INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
            );",
        )
        .map_err(|e| ErgataiError::internal(format!("Failed to init session schema: {}", e)))?;
        Ok(())
    }

    /// Save or update a session record for the given agent.
    ///
    /// Uses `INSERT ... ON CONFLICT DO UPDATE` so repeated calls for the same
    /// `agent_uuid` update the existing row.
    pub fn save_session(
        &self,
        agent_uuid: &str,
        session_id: &str,
        command: &str,
        cwd: &str,
    ) -> ErgataiResult<()> {
        let conn = self.conn()?;
        conn.execute(
            "INSERT INTO agent_sessions (agent_uuid, session_id, command, cwd, updated_at)
             VALUES (?1, ?2, ?3, ?4, strftime('%s', 'now'))
             ON CONFLICT(agent_uuid) DO UPDATE SET
                session_id = excluded.session_id,
                command = excluded.command,
                cwd = excluded.cwd,
                updated_at = strftime('%s', 'now')",
            params![agent_uuid, session_id, command, cwd],
        )
        .map_err(|e| {
            ErgataiError::internal(format!(
                "Failed to save session for agent '{}' (session_id='{}', command='{}', cwd='{}'): {}",
                agent_uuid, session_id, command, cwd, e
            ))
        })?;
        debug!(
            agent_uuid = %agent_uuid,
            session_id = %session_id,
            "Saved ACP session"
        );
        Ok(())
    }

    /// Load a previously saved session for the given agent.
    ///
    /// Returns `None` if no session is stored for this agent.
    pub fn load_session(&self, agent_uuid: &str) -> ErgataiResult<Option<SessionRecord>> {
        let conn = self.conn()?;
        let mut stmt = conn
            .prepare(
                "SELECT agent_uuid, session_id, command, cwd FROM agent_sessions WHERE agent_uuid = ?1",
            )
            .map_err(|e| {
                ErgataiError::internal(format!(
                    "Failed to prepare session load query: {}",
                    e
                ))
            })?;

        let mut rows = stmt
            .query_map(params![agent_uuid], |row| {
                Ok(SessionRecord {
                    agent_uuid: row.get(0)?,
                    session_id: row.get(1)?,
                    command: row.get(2)?,
                    cwd: row.get(3)?,
                })
            })
            .map_err(|e| ErgataiError::internal(format!("Failed to query session: {}", e)))?;

        match rows.next() {
            Some(Ok(record)) => {
                debug!(
                    agent_uuid = %agent_uuid,
                    session_id = %record.session_id,
                    "Loaded ACP session record"
                );
                Ok(Some(record))
            }
            Some(Err(e)) => {
                warn!(error = %e, "Failed to read session row");
                Ok(None)
            }
            None => Ok(None),
        }
    }

    /// Remove the saved session for the given agent.
    ///
    /// Called when an agent is explicitly stopped (so we don't try to resume
    /// a deliberately terminated session on next start).
    pub fn remove_session(&self, agent_uuid: &str) -> ErgataiResult<()> {
        let conn = self.conn()?;
        conn.execute(
            "DELETE FROM agent_sessions WHERE agent_uuid = ?1",
            params![agent_uuid],
        )
        .map_err(|e| {
            ErgataiError::internal(format!(
                "Failed to remove session for agent '{}': {}",
                agent_uuid, e
            ))
        })?;
        debug!(agent_uuid = %agent_uuid, "Removed ACP session record");
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::NamedTempFile;

    fn temp_store() -> SessionStore {
        let tmp = NamedTempFile::new().unwrap();
        let path = tmp.path().to_path_buf();
        // Drop the tempfile so SessionStore can create a fresh one
        drop(tmp);
        SessionStore::open(&path).unwrap()
    }

    #[test]
    fn save_and_load_session() {
        let store = temp_store();
        store
            .save_session("agent-1", "sess-abc", "python agent.py", "/workspace")
            .unwrap();

        let record = store.load_session("agent-1").unwrap().unwrap();
        assert_eq!(record.agent_uuid, "agent-1");
        assert_eq!(record.session_id, "sess-abc");
        assert_eq!(record.command, "python agent.py");
        assert_eq!(record.cwd, "/workspace");
    }

    #[test]
    fn load_missing_returns_none() {
        let store = temp_store();
        assert!(store.load_session("nonexistent").unwrap().is_none());
    }

    #[test]
    fn save_overwrites_existing() {
        let store = temp_store();
        store
            .save_session("agent-1", "sess-1", "cmd", "/a")
            .unwrap();
        store
            .save_session("agent-1", "sess-2", "cmd", "/b")
            .unwrap();

        let record = store.load_session("agent-1").unwrap().unwrap();
        assert_eq!(record.session_id, "sess-2");
        assert_eq!(record.cwd, "/b");
    }

    #[test]
    fn remove_session() {
        let store = temp_store();
        store
            .save_session("agent-1", "sess-1", "cmd", "/a")
            .unwrap();
        store.remove_session("agent-1").unwrap();
        assert!(store.load_session("agent-1").unwrap().is_none());
    }
}
