//! User data database management for projects, chats, and sub-chats.
//!
//! This module provides persistent storage for user-facing data that was
//! previously stored in the frontend's local SQLite database. By centralizing
//! this data in the backend, we enable:
//! - Single source of truth
//! - Multi-device sync (future)
//! - Better data consistency
//! - Centralized backup

use once_cell::sync::Lazy;
use rusqlite::{params, Connection, Result};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

/// Global database instance
static USER_DATA_DB: Lazy<Arc<Mutex<Connection>>> = Lazy::new(|| {
    let db_path = get_db_path();
    let conn = Connection::open(&db_path).expect("Failed to open user data database");

    // Enable WAL mode and enforce declared foreign-key cascades.
    conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;")
        .ok();

    // Initialize tables
    initialize_tables(&conn).expect("Failed to initialize user data tables");

    Arc::new(Mutex::new(conn))
});

/// Get the database file path
fn get_db_path() -> PathBuf {
    let data_dir = std::env::var("ERGATAI_DATA_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|_| {
            let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".to_string());
            PathBuf::from(home).join(".ergatai")
        });

    std::fs::create_dir_all(&data_dir).ok();
    data_dir.join("user_data.db")
}

/// Initialize all required tables
fn initialize_tables(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        r#"
        -- Projects table
        CREATE TABLE IF NOT EXISTS projects (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            path TEXT NOT NULL UNIQUE,
            git_remote_url TEXT,
            git_provider TEXT,
            git_owner TEXT,
            git_repo TEXT,
            icon_path TEXT,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        );

        -- Chats table (workspaces)
        CREATE TABLE IF NOT EXISTS chats (
            id TEXT PRIMARY KEY,
            name TEXT,
            project_id TEXT NOT NULL,
            collaboration_mode TEXT NOT NULL DEFAULT 'supervisor',
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            archived_at INTEGER,
            worktree_path TEXT,
            branch TEXT,
            base_branch TEXT,
            pr_url TEXT,
            pr_number INTEGER,
            FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
        );

        -- Sub-chats table (conversation threads)
        CREATE TABLE IF NOT EXISTS sub_chats (
            id TEXT PRIMARY KEY,
            name TEXT,
            chat_id TEXT NOT NULL,
            session_id TEXT,
            stream_id TEXT,
            mode TEXT NOT NULL DEFAULT 'agent',
            messages TEXT NOT NULL DEFAULT '[]',
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            FOREIGN KEY (chat_id) REFERENCES chats(id) ON DELETE CASCADE
        );

        -- Stable binding between a group chat, a backend agent, and its own thread
        CREATE TABLE IF NOT EXISTS group_agent_bindings (
            id TEXT PRIMARY KEY,
            chat_id TEXT NOT NULL,
            agent_id TEXT NOT NULL,
            agent_name TEXT NOT NULL,
            agent_command TEXT,
            sub_chat_id TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            UNIQUE(chat_id, agent_id),
            FOREIGN KEY (chat_id) REFERENCES chats(id) ON DELETE CASCADE,
            FOREIGN KEY (sub_chat_id) REFERENCES sub_chats(id) ON DELETE CASCADE
        );

        -- Anthropic accounts for OAuth
        CREATE TABLE IF NOT EXISTS anthropic_accounts (
            id TEXT PRIMARY KEY,
            user_id TEXT NOT NULL,
            email TEXT,
            display_name TEXT,
            encrypted_access_token TEXT NOT NULL,
            encrypted_refresh_token TEXT,
            token_expires_at INTEGER,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        );

        -- Anthropic settings (singleton)
        CREATE TABLE IF NOT EXISTS anthropic_settings (
            id TEXT PRIMARY KEY DEFAULT 'active',
            active_account_id TEXT,
            FOREIGN KEY (active_account_id) REFERENCES anthropic_accounts(id)
        );

        -- Create indexes for performance
        CREATE INDEX IF NOT EXISTS idx_chats_project_id ON chats(project_id);
        CREATE INDEX IF NOT EXISTS idx_sub_chats_chat_id ON sub_chats(chat_id);
        CREATE INDEX IF NOT EXISTS idx_group_agent_bindings_chat_id ON group_agent_bindings(chat_id);
        CREATE INDEX IF NOT EXISTS idx_group_agent_bindings_agent_id ON group_agent_bindings(agent_id);
        CREATE INDEX IF NOT EXISTS idx_chats_archived_at ON chats(archived_at);
        "#,
    )?;

    Ok(())
}

/// Get the global database connection
pub fn get_user_data_db() -> Arc<Mutex<Connection>> {
    Arc::clone(&USER_DATA_DB)
}

// ── Data Models ──────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Project {
    pub id: String,
    pub name: String,
    pub path: String,
    pub git_remote_url: Option<String>,
    pub git_provider: Option<String>,
    pub git_owner: Option<String>,
    pub git_repo: Option<String>,
    pub icon_path: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Chat {
    pub id: String,
    pub name: Option<String>,
    pub project_id: String,
    pub collaboration_mode: String,
    pub created_at: i64,
    pub updated_at: i64,
    pub archived_at: Option<i64>,
    pub worktree_path: Option<String>,
    pub branch: Option<String>,
    pub base_branch: Option<String>,
    pub pr_url: Option<String>,
    pub pr_number: Option<i32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SubChat {
    pub id: String,
    pub name: Option<String>,
    pub chat_id: String,
    pub session_id: Option<String>,
    pub stream_id: Option<String>,
    pub mode: String,
    pub messages: String, // JSON array
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GroupAgentBinding {
    pub id: String,
    pub chat_id: String,
    pub agent_id: String,
    pub agent_name: String,
    pub agent_command: Option<String>,
    pub sub_chat_id: String,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AnthropicAccount {
    pub id: String,
    pub user_id: String,
    pub email: Option<String>,
    pub display_name: Option<String>,
    pub encrypted_access_token: String,
    pub encrypted_refresh_token: Option<String>,
    pub token_expires_at: Option<i64>,
    pub created_at: i64,
    pub updated_at: i64,
}

// ── CRUD Operations ──────────────────────────────────────────────────────────

pub mod projects {
    use super::*;

    pub fn create(project: Project) -> Result<Project> {
        let db = get_user_data_db();
        let conn = db.lock().unwrap();

        conn.execute(
            "INSERT INTO projects (id, name, path, git_remote_url, git_provider, git_owner, git_repo, icon_path, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            params![
                project.id,
                project.name,
                project.path,
                project.git_remote_url,
                project.git_provider,
                project.git_owner,
                project.git_repo,
                project.icon_path,
                project.created_at,
                project.updated_at,
            ],
        )?;

        Ok(project)
    }

    pub fn list() -> Result<Vec<Project>> {
        let db = get_user_data_db();
        let conn = db.lock().unwrap();

        let mut stmt = conn.prepare(
            "SELECT id, name, path, git_remote_url, git_provider, git_owner, git_repo, icon_path, created_at, updated_at
             FROM projects ORDER BY created_at DESC"
        )?;

        let projects = stmt.query_map([], |row| {
            Ok(Project {
                id: row.get(0)?,
                name: row.get(1)?,
                path: row.get(2)?,
                git_remote_url: row.get(3)?,
                git_provider: row.get(4)?,
                git_owner: row.get(5)?,
                git_repo: row.get(6)?,
                icon_path: row.get(7)?,
                created_at: row.get(8)?,
                updated_at: row.get(9)?,
            })
        })?;

        projects.collect()
    }

    pub fn get(id: &str) -> Result<Option<Project>> {
        let db = get_user_data_db();
        let conn = db.lock().unwrap();

        let mut stmt = conn.prepare(
            "SELECT id, name, path, git_remote_url, git_provider, git_owner, git_repo, icon_path, created_at, updated_at
             FROM projects WHERE id = ?1"
        )?;

        let mut rows = stmt.query_map(params![id], |row| {
            Ok(Project {
                id: row.get(0)?,
                name: row.get(1)?,
                path: row.get(2)?,
                git_remote_url: row.get(3)?,
                git_provider: row.get(4)?,
                git_owner: row.get(5)?,
                git_repo: row.get(6)?,
                icon_path: row.get(7)?,
                created_at: row.get(8)?,
                updated_at: row.get(9)?,
            })
        })?;

        match rows.next() {
            Some(Ok(project)) => Ok(Some(project)),
            Some(Err(e)) => Err(e),
            None => Ok(None),
        }
    }

    pub fn update(project: Project) -> Result<()> {
        let db = get_user_data_db();
        let conn = db.lock().unwrap();

        conn.execute(
            "UPDATE projects
             SET name = ?1, git_remote_url = ?2, git_provider = ?3, git_owner = ?4,
                 git_repo = ?5, icon_path = ?6, updated_at = ?7
             WHERE id = ?8",
            params![
                project.name,
                project.git_remote_url,
                project.git_provider,
                project.git_owner,
                project.git_repo,
                project.icon_path,
                project.updated_at,
                project.id,
            ],
        )?;

        Ok(())
    }

    pub fn delete(id: &str) -> Result<()> {
        let db = get_user_data_db();
        let conn = db.lock().unwrap();

        conn.execute("DELETE FROM projects WHERE id = ?1", params![id])?;

        Ok(())
    }
}

pub mod chats {
    use super::*;

    pub fn create(chat: Chat) -> Result<Chat> {
        let db = get_user_data_db();
        let conn = db.lock().unwrap();

        conn.execute(
            "INSERT INTO chats (id, name, project_id, collaboration_mode, created_at, updated_at, archived_at, worktree_path, branch, base_branch, pr_url, pr_number)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
            params![
                chat.id,
                chat.name,
                chat.project_id,
                chat.collaboration_mode,
                chat.created_at,
                chat.updated_at,
                chat.archived_at,
                chat.worktree_path,
                chat.branch,
                chat.base_branch,
                chat.pr_url,
                chat.pr_number,
            ],
        )?;

        Ok(chat)
    }

    pub fn list(project_id: Option<&str>) -> Result<Vec<Chat>> {
        let db = get_user_data_db();
        let conn = db.lock().unwrap();

        if let Some(pid) = project_id {
            let mut stmt = conn.prepare(
                "SELECT id, name, project_id, collaboration_mode, created_at, updated_at, archived_at, worktree_path, branch, base_branch, pr_url, pr_number
                 FROM chats WHERE project_id = ?1 ORDER BY created_at DESC"
            )?;
            let chats = stmt.query_map(params![pid], |row| {
                Ok(Chat {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    project_id: row.get(2)?,
                    collaboration_mode: row.get(3)?,
                    created_at: row.get(4)?,
                    updated_at: row.get(5)?,
                    archived_at: row.get(6)?,
                    worktree_path: row.get(7)?,
                    branch: row.get(8)?,
                    base_branch: row.get(9)?,
                    pr_url: row.get(10)?,
                    pr_number: row.get(11)?,
                })
            })?;
            chats.collect()
        } else {
            let mut stmt = conn.prepare(
                "SELECT id, name, project_id, collaboration_mode, created_at, updated_at, archived_at, worktree_path, branch, base_branch, pr_url, pr_number
                 FROM chats ORDER BY created_at DESC"
            )?;
            let chats = stmt.query_map([], |row| {
                Ok(Chat {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    project_id: row.get(2)?,
                    collaboration_mode: row.get(3)?,
                    created_at: row.get(4)?,
                    updated_at: row.get(5)?,
                    archived_at: row.get(6)?,
                    worktree_path: row.get(7)?,
                    branch: row.get(8)?,
                    base_branch: row.get(9)?,
                    pr_url: row.get(10)?,
                    pr_number: row.get(11)?,
                })
            })?;
            chats.collect()
        }
    }

    pub fn get(id: &str) -> Result<Option<Chat>> {
        let db = get_user_data_db();
        let conn = db.lock().unwrap();

        let mut stmt = conn.prepare(
            "SELECT id, name, project_id, collaboration_mode, created_at, updated_at, archived_at, worktree_path, branch, base_branch, pr_url, pr_number
             FROM chats WHERE id = ?1"
        )?;

        let mut rows = stmt.query_map(params![id], |row| {
            Ok(Chat {
                id: row.get(0)?,
                name: row.get(1)?,
                project_id: row.get(2)?,
                collaboration_mode: row.get(3)?,
                created_at: row.get(4)?,
                updated_at: row.get(5)?,
                archived_at: row.get(6)?,
                worktree_path: row.get(7)?,
                branch: row.get(8)?,
                base_branch: row.get(9)?,
                pr_url: row.get(10)?,
                pr_number: row.get(11)?,
            })
        })?;

        match rows.next() {
            Some(Ok(chat)) => Ok(Some(chat)),
            Some(Err(e)) => Err(e),
            None => Ok(None),
        }
    }

    pub fn update(chat: Chat) -> Result<()> {
        let db = get_user_data_db();
        let conn = db.lock().unwrap();

        conn.execute(
            "UPDATE chats
             SET name = ?1, collaboration_mode = ?2, updated_at = ?3, worktree_path = ?4,
                 branch = ?5, base_branch = ?6, pr_url = ?7, pr_number = ?8
             WHERE id = ?9",
            params![
                chat.name,
                chat.collaboration_mode,
                chat.updated_at,
                chat.worktree_path,
                chat.branch,
                chat.base_branch,
                chat.pr_url,
                chat.pr_number,
                chat.id,
            ],
        )?;

        Ok(())
    }

    pub fn archive(id: &str) -> Result<()> {
        let db = get_user_data_db();
        let conn = db.lock().unwrap();
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs() as i64;

        conn.execute(
            "UPDATE chats SET archived_at = ?1, updated_at = ?1 WHERE id = ?2",
            params![now, id],
        )?;

        Ok(())
    }

    pub fn unarchive(id: &str) -> Result<()> {
        let db = get_user_data_db();
        let conn = db.lock().unwrap();
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs() as i64;

        conn.execute(
            "UPDATE chats SET archived_at = NULL, updated_at = ?1 WHERE id = ?2",
            params![now, id],
        )?;

        Ok(())
    }

    pub fn delete(id: &str) -> Result<()> {
        let db = get_user_data_db();
        let conn = db.lock().unwrap();

        conn.execute("DELETE FROM chats WHERE id = ?1", params![id])?;

        Ok(())
    }
}

pub mod sub_chats {
    use super::*;

    pub fn create(sub_chat: SubChat) -> Result<SubChat> {
        let db = get_user_data_db();
        let conn = db.lock().unwrap();

        conn.execute(
            "INSERT INTO sub_chats (id, name, chat_id, session_id, stream_id, mode, messages, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                sub_chat.id,
                sub_chat.name,
                sub_chat.chat_id,
                sub_chat.session_id,
                sub_chat.stream_id,
                sub_chat.mode,
                sub_chat.messages,
                sub_chat.created_at,
                sub_chat.updated_at,
            ],
        )?;

        Ok(sub_chat)
    }

    pub fn list(chat_id: &str) -> Result<Vec<SubChat>> {
        let db = get_user_data_db();
        let conn = db.lock().unwrap();

        let mut stmt = conn.prepare(
            "SELECT id, name, chat_id, session_id, stream_id, mode, messages, created_at, updated_at
             FROM sub_chats WHERE chat_id = ?1 ORDER BY created_at ASC"
        )?;

        let sub_chats = stmt.query_map(params![chat_id], |row| {
            Ok(SubChat {
                id: row.get(0)?,
                name: row.get(1)?,
                chat_id: row.get(2)?,
                session_id: row.get(3)?,
                stream_id: row.get(4)?,
                mode: row.get(5)?,
                messages: row.get(6)?,
                created_at: row.get(7)?,
                updated_at: row.get(8)?,
            })
        })?;

        sub_chats.collect()
    }

    pub fn get(id: &str) -> Result<Option<SubChat>> {
        let db = get_user_data_db();
        let conn = db.lock().unwrap();

        let mut stmt = conn.prepare(
            "SELECT id, name, chat_id, session_id, stream_id, mode, messages, created_at, updated_at
             FROM sub_chats WHERE id = ?1"
        )?;

        let mut rows = stmt.query_map(params![id], |row| {
            Ok(SubChat {
                id: row.get(0)?,
                name: row.get(1)?,
                chat_id: row.get(2)?,
                session_id: row.get(3)?,
                stream_id: row.get(4)?,
                mode: row.get(5)?,
                messages: row.get(6)?,
                created_at: row.get(7)?,
                updated_at: row.get(8)?,
            })
        })?;

        match rows.next() {
            Some(Ok(sub_chat)) => Ok(Some(sub_chat)),
            Some(Err(e)) => Err(e),
            None => Ok(None),
        }
    }

    pub fn update_messages(id: &str, messages: &str, updated_at: i64) -> Result<()> {
        let db = get_user_data_db();
        let conn = db.lock().unwrap();

        conn.execute(
            "UPDATE sub_chats SET messages = ?1, updated_at = ?2 WHERE id = ?3",
            params![messages, updated_at, id],
        )?;

        Ok(())
    }

    pub fn append_message(
        id: &str,
        role: &str,
        text: &str,
        metadata: serde_json::Value,
    ) -> Result<()> {
        let parts = serde_json::json!([{ "type": "text", "text": text }]);
        sub_chats::append_message_parts(id, role, parts, metadata)
    }

    pub fn append_message_parts(
        id: &str,
        role: &str,
        parts: serde_json::Value,
        metadata: serde_json::Value,
    ) -> Result<()> {
        let Some(sub_chat) = sub_chats::get(id)? else {
            return Err(rusqlite::Error::QueryReturnedNoRows);
        };

        let mut messages: serde_json::Value =
            serde_json::from_str(&sub_chat.messages).unwrap_or_else(|_| serde_json::json!([]));
        if !messages.is_array() {
            messages = serde_json::json!([]);
        }

        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs() as i64;
        let message_id = format!("msg_{}", uuid::Uuid::new_v4());

        messages
            .as_array_mut()
            .expect("messages must be an array")
            .push(serde_json::json!({
                "id": message_id,
                "role": role,
                "parts": parts,
                "metadata": metadata,
            }));

        sub_chats::update_messages(id, &messages.to_string(), now)
    }

    pub fn update_name(id: &str, name: &str, updated_at: i64) -> Result<()> {
        let db = get_user_data_db();
        let conn = db.lock().unwrap();

        conn.execute(
            "UPDATE sub_chats SET name = ?1, updated_at = ?2 WHERE id = ?3",
            params![name, updated_at, id],
        )?;

        Ok(())
    }

    pub fn update_session(id: &str, session_id: &str, updated_at: i64) -> Result<()> {
        let db = get_user_data_db();
        let conn = db.lock().unwrap();

        conn.execute(
            "UPDATE sub_chats SET session_id = ?1, updated_at = ?2 WHERE id = ?3",
            params![session_id, updated_at, id],
        )?;

        Ok(())
    }

    pub fn update_mode(id: &str, mode: &str, updated_at: i64) -> Result<()> {
        let db = get_user_data_db();
        let conn = db.lock().unwrap();

        conn.execute(
            "UPDATE sub_chats SET mode = ?1, updated_at = ?2 WHERE id = ?3",
            params![mode, updated_at, id],
        )?;

        Ok(())
    }

    #[allow(unused_assignments)]
    pub fn update_full(
        id: &str,
        name: Option<&str>,
        session_id: Option<&str>,
        stream_id: Option<&str>,
        mode: Option<&str>,
        messages: Option<&str>,
        updated_at: i64,
    ) -> Result<()> {
        let db = get_user_data_db();
        let conn = db.lock().unwrap();

        // Build dynamic update query
        let mut updates = vec!["updated_at = ?1".to_string()];
        let mut param_idx = 2;

        if name.is_some() {
            updates.push(format!("name = ?{}", param_idx));
            param_idx += 1;
        }
        if session_id.is_some() {
            updates.push(format!("session_id = ?{}", param_idx));
            param_idx += 1;
        }
        if stream_id.is_some() {
            updates.push(format!("stream_id = ?{}", param_idx));
            param_idx += 1;
        }
        if mode.is_some() {
            updates.push(format!("mode = ?{}", param_idx));
            param_idx += 1;
        }
        if messages.is_some() {
            updates.push(format!("messages = ?{}", param_idx));
            param_idx += 1;
        }

        let query = format!("UPDATE sub_chats SET {} WHERE id = ?", updates.join(", "));

        // Build params
        let mut params_vec: Vec<Box<dyn rusqlite::types::ToSql>> = vec![Box::new(updated_at)];
        if let Some(n) = name {
            params_vec.push(Box::new(n.to_string()));
        }
        if let Some(s) = session_id {
            params_vec.push(Box::new(s.to_string()));
        }
        if let Some(st) = stream_id {
            params_vec.push(Box::new(st.to_string()));
        }
        if let Some(m) = mode {
            params_vec.push(Box::new(m.to_string()));
        }
        if let Some(msg) = messages {
            params_vec.push(Box::new(msg.to_string()));
        }
        params_vec.push(Box::new(id.to_string()));

        let params_ref: Vec<&dyn rusqlite::types::ToSql> =
            params_vec.iter().map(|p| p.as_ref()).collect();
        conn.execute(&query, params_ref.as_slice())?;

        Ok(())
    }

    pub fn delete(id: &str) -> Result<()> {
        let db = get_user_data_db();
        let conn = db.lock().unwrap();

        conn.execute("DELETE FROM sub_chats WHERE id = ?1", params![id])?;

        Ok(())
    }
}

pub mod group_agent_bindings {
    use super::*;

    fn row_to_binding(row: &rusqlite::Row<'_>) -> Result<GroupAgentBinding> {
        Ok(GroupAgentBinding {
            id: row.get(0)?,
            chat_id: row.get(1)?,
            agent_id: row.get(2)?,
            agent_name: row.get(3)?,
            agent_command: row.get(4)?,
            sub_chat_id: row.get(5)?,
            created_at: row.get(6)?,
            updated_at: row.get(7)?,
        })
    }

    pub fn upsert(binding: GroupAgentBinding) -> Result<GroupAgentBinding> {
        let db = get_user_data_db();
        let conn = db.lock().unwrap();

        conn.execute(
            "INSERT INTO group_agent_bindings (id, chat_id, agent_id, agent_name, agent_command, sub_chat_id, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
             ON CONFLICT(chat_id, agent_id) DO UPDATE SET
               agent_name = excluded.agent_name,
               agent_command = excluded.agent_command,
               sub_chat_id = excluded.sub_chat_id,
               updated_at = excluded.updated_at",
            params![
                binding.id,
                binding.chat_id,
                binding.agent_id,
                binding.agent_name,
                binding.agent_command,
                binding.sub_chat_id,
                binding.created_at,
                binding.updated_at,
            ],
        )?;

        let mut stmt = conn.prepare(
            "SELECT id, chat_id, agent_id, agent_name, agent_command, sub_chat_id, created_at, updated_at
             FROM group_agent_bindings WHERE chat_id = ?1 AND agent_id = ?2",
        )?;
        let mut rows =
            stmt.query_map(params![binding.chat_id, binding.agent_id], row_to_binding)?;
        rows.next()
            .unwrap_or_else(|| Err(rusqlite::Error::QueryReturnedNoRows))
    }

    pub fn list(chat_id: &str) -> Result<Vec<GroupAgentBinding>> {
        let db = get_user_data_db();
        let conn = db.lock().unwrap();

        let mut stmt = conn.prepare(
            "SELECT id, chat_id, agent_id, agent_name, agent_command, sub_chat_id, created_at, updated_at
             FROM group_agent_bindings WHERE chat_id = ?1 ORDER BY created_at ASC",
        )?;
        let bindings = stmt.query_map(params![chat_id], row_to_binding)?;
        bindings.collect()
    }

    pub fn find_sub_chat_id(agent_id: &str) -> Result<Option<String>> {
        let db = get_user_data_db();
        let conn = db.lock().unwrap();

        let mut stmt = conn
            .prepare("SELECT sub_chat_id FROM group_agent_bindings WHERE agent_id = ?1 LIMIT 1")?;
        let mut rows = stmt.query_map(params![agent_id], |row| row.get::<_, String>(0))?;
        rows.next().transpose()
    }

    pub fn delete(chat_id: &str, agent_id: &str) -> Result<bool> {
        let db = get_user_data_db();
        let conn = db.lock().unwrap();
        let count = conn.execute(
            "DELETE FROM group_agent_bindings WHERE chat_id = ?1 AND agent_id = ?2",
            params![chat_id, agent_id],
        )?;
        Ok(count > 0)
    }
}

pub mod anthropic_accounts {
    use super::*;

    fn row_to_account(row: &rusqlite::Row<'_>) -> Result<AnthropicAccount> {
        Ok(AnthropicAccount {
            id: row.get(0)?,
            user_id: row.get(1)?,
            email: row.get(2)?,
            display_name: row.get(3)?,
            encrypted_access_token: row.get(4)?,
            encrypted_refresh_token: row.get(5)?,
            token_expires_at: row.get(6)?,
            created_at: row.get(7)?,
            updated_at: row.get(8)?,
        })
    }

    pub fn create(account: AnthropicAccount) -> Result<AnthropicAccount> {
        let db = get_user_data_db();
        let conn = db.lock().unwrap();

        conn.execute(
            "INSERT INTO anthropic_accounts (id, user_id, email, display_name, encrypted_access_token, encrypted_refresh_token, token_expires_at, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                account.id,
                account.user_id,
                account.email,
                account.display_name,
                account.encrypted_access_token,
                account.encrypted_refresh_token,
                account.token_expires_at,
                account.created_at,
                account.updated_at,
            ],
        )?;

        Ok(account)
    }

    pub fn list() -> Result<Vec<AnthropicAccount>> {
        let db = get_user_data_db();
        let conn = db.lock().unwrap();

        let mut stmt = conn.prepare(
            "SELECT id, user_id, email, display_name, encrypted_access_token, encrypted_refresh_token, token_expires_at, created_at, updated_at
             FROM anthropic_accounts ORDER BY created_at ASC",
        )?;
        let accounts = stmt.query_map([], row_to_account)?;
        accounts.collect()
    }

    pub fn get(id: &str) -> Result<Option<AnthropicAccount>> {
        let db = get_user_data_db();
        let conn = db.lock().unwrap();

        let mut stmt = conn.prepare(
            "SELECT id, user_id, email, display_name, encrypted_access_token, encrypted_refresh_token, token_expires_at, created_at, updated_at
             FROM anthropic_accounts WHERE id = ?1",
        )?;
        let mut rows = stmt.query_map(params![id], row_to_account)?;
        match rows.next() {
            Some(Ok(account)) => Ok(Some(account)),
            Some(Err(e)) => Err(e),
            None => Ok(None),
        }
    }

    pub fn delete(id: &str) -> Result<bool> {
        let db = get_user_data_db();
        let conn = db.lock().unwrap();
        let count = conn.execute("DELETE FROM anthropic_accounts WHERE id = ?1", params![id])?;
        Ok(count > 0)
    }

    pub fn get_active() -> Result<Option<AnthropicAccount>> {
        let db = get_user_data_db();
        let conn = db.lock().unwrap();

        let mut stmt = conn.prepare(
            "SELECT a.id, a.user_id, a.email, a.display_name, a.encrypted_access_token, a.encrypted_refresh_token, a.token_expires_at, a.created_at, a.updated_at
             FROM anthropic_accounts a
             JOIN anthropic_settings s ON s.active_account_id = a.id
             WHERE s.id = 'active'",
        )?;
        let mut rows = stmt.query_map([], row_to_account)?;
        match rows.next() {
            Some(Ok(account)) => Ok(Some(account)),
            Some(Err(e)) => Err(e),
            None => Ok(None),
        }
    }

    pub fn set_active(id: &str) -> Result<bool> {
        let db = get_user_data_db();
        let conn = db.lock().unwrap();

        // Verify account exists
        let exists: bool = conn
            .query_row(
                "SELECT COUNT(*) > 0 FROM anthropic_accounts WHERE id = ?1",
                params![id],
                |row| row.get(0),
            )
            .unwrap_or(false);

        if !exists {
            return Ok(false);
        }

        conn.execute(
            "INSERT INTO anthropic_settings (id, active_account_id) VALUES ('active', ?1)
             ON CONFLICT(id) DO UPDATE SET active_account_id = excluded.active_account_id",
            params![id],
        )?;

        Ok(true)
    }

    pub fn update_display_name(id: &str, display_name: &str) -> Result<bool> {
        let db = get_user_data_db();
        let conn = db.lock().unwrap();

        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs() as i64;

        let count = conn.execute(
            "UPDATE anthropic_accounts SET display_name = ?2, updated_at = ?3 WHERE id = ?1",
            params![id, display_name, now],
        )?;
        Ok(count > 0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_project_crud() {
        let data_dir = std::env::temp_dir()
            .join("ergatai-user-data-tests")
            .join(std::process::id().to_string());
        let _ = std::fs::remove_dir_all(&data_dir);
        std::fs::create_dir_all(&data_dir).unwrap();
        std::env::set_var("ERGATAI_DATA_DIR", &data_dir);

        let project = Project {
            id: "test-1".to_string(),
            name: "Test Project".to_string(),
            path: "/tmp/test".to_string(),
            git_remote_url: None,
            git_provider: None,
            git_owner: None,
            git_repo: None,
            icon_path: None,
            created_at: 1234567890,
            updated_at: 1234567890,
        };

        // Create
        let created = projects::create(project.clone()).unwrap();
        assert_eq!(created.id, project.id);

        // Read
        let retrieved = projects::get(&project.id).unwrap().unwrap();
        assert_eq!(retrieved.name, project.name);

        // List
        let all = projects::list().unwrap();
        assert!(!all.is_empty());

        // Delete
        projects::delete(&project.id).unwrap();
        let deleted = projects::get(&project.id).unwrap();
        assert!(deleted.is_none());

        let _ = std::fs::remove_dir_all(&data_dir);
    }
}
