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
use rusqlite::{params, Connection, OptionalExtension, Result};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use utoipa::ToSchema;

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

        -- Workspaces table (persistent execution scope: working directory, environment, and resources)
        CREATE TABLE IF NOT EXISTS workspaces (
            id TEXT PRIMARY KEY,
            project_id TEXT NOT NULL,
            name TEXT,
            work_dir TEXT NOT NULL,
            env TEXT DEFAULT '{}',
            resources TEXT DEFAULT '{}',
            capture_thoughts INTEGER DEFAULT 0,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
        );

        -- Chats table (conversation containers; workspace_id references a related workspace,
        -- but a chat and a workspace remain distinct entities)
        CREATE TABLE IF NOT EXISTS chats (
            id TEXT PRIMARY KEY,
            name TEXT,
            project_id TEXT NOT NULL,
            workspace_id TEXT,
            collaboration_mode TEXT NOT NULL DEFAULT 'supervisor',
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            archived_at INTEGER,
            worktree_path TEXT,
            branch TEXT,
            base_branch TEXT,
            pr_url TEXT,
            pr_number INTEGER,
            FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
            FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE SET NULL
        );

        -- Sub-chats table (individual conversation threads within a chat)
        CREATE TABLE IF NOT EXISTS sub_chats (
            id TEXT PRIMARY KEY,
            name TEXT,
            chat_id TEXT NOT NULL,
            session_id TEXT,
            mode TEXT NOT NULL DEFAULT 'agent',
            messages TEXT NOT NULL DEFAULT '[]',
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            FOREIGN KEY (chat_id) REFERENCES chats(id) ON DELETE CASCADE
        );

        -- Unified conversation tree. A conversation is either a root scoped to a
        -- workspace or a child scoped to its parent. Both roots and children are
        -- the same entity; parent_id is the only hierarchy boundary.
        CREATE TABLE IF NOT EXISTS conversations (
            id TEXT PRIMARY KEY,
            parent_id TEXT,
            project_id TEXT NOT NULL,
            workspace_id TEXT,
            name TEXT,
            mode TEXT NOT NULL DEFAULT 'agent',
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            archived_at INTEGER,
            FOREIGN KEY (parent_id) REFERENCES conversations(id) ON DELETE CASCADE,
            FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
            FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE SET NULL
        );

        -- Durable messages belong to exactly one conversation.
        CREATE TABLE IF NOT EXISTS messages (
            id TEXT PRIMARY KEY,
            conversation_id TEXT NOT NULL,
            sequence INTEGER NOT NULL,
            role TEXT NOT NULL,
            parts TEXT NOT NULL,
            metadata TEXT,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
            UNIQUE (conversation_id, sequence)
        );

        -- Runtime identity is separate from conversation identity.
        CREATE TABLE IF NOT EXISTS agent_sessions (
            conversation_id TEXT PRIMARY KEY,
            session_id TEXT,
            mode TEXT NOT NULL DEFAULT 'agent',
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
        );

        -- Git/PR execution context is separate from conversation identity.
        CREATE TABLE IF NOT EXISTS conversation_execution_contexts (
            conversation_id TEXT PRIMARY KEY,
            worktree_path TEXT,
            branch TEXT,
            base_branch TEXT,
            pr_url TEXT,
            pr_number INTEGER,
            FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
        );

        -- Stable binding between a root conversation, a backend agent, and its thread.
        CREATE TABLE IF NOT EXISTS conversation_agent_bindings (
            workspace_id TEXT NOT NULL,
            chat_id TEXT NOT NULL,
            agent_id TEXT NOT NULL,
            agent_name TEXT NOT NULL,
            agent_command TEXT,
            sub_chat_id TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            PRIMARY KEY (chat_id, agent_id),
            FOREIGN KEY (chat_id) REFERENCES conversations(id) ON DELETE CASCADE,
            FOREIGN KEY (sub_chat_id) REFERENCES conversations(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS group_agent_bindings (
            workspace_id TEXT NOT NULL,
            chat_id TEXT NOT NULL,
            agent_id TEXT NOT NULL,
            agent_name TEXT NOT NULL,
            agent_command TEXT,
            sub_chat_id TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            PRIMARY KEY (chat_id, agent_id),
            FOREIGN KEY (chat_id) REFERENCES chats(id) ON DELETE CASCADE,
            FOREIGN KEY (sub_chat_id) REFERENCES sub_chats(id) ON DELETE CASCADE
        );

        -- Create indexes for performance
        CREATE INDEX IF NOT EXISTS idx_workspaces_project_id ON workspaces(project_id);
        CREATE INDEX IF NOT EXISTS idx_chats_project_id ON chats(project_id);
        CREATE INDEX IF NOT EXISTS idx_sub_chats_chat_id ON sub_chats(chat_id);
        CREATE INDEX IF NOT EXISTS idx_group_agent_bindings_chat_id ON group_agent_bindings(chat_id);
        CREATE INDEX IF NOT EXISTS idx_group_agent_bindings_agent_id ON group_agent_bindings(agent_id);
        CREATE INDEX IF NOT EXISTS idx_chats_archived_at ON chats(archived_at);
        CREATE INDEX IF NOT EXISTS idx_conversations_parent_id ON conversations(parent_id);
        CREATE INDEX IF NOT EXISTS idx_conversations_project_id ON conversations(project_id);
        CREATE INDEX IF NOT EXISTS idx_conversations_workspace_id ON conversations(workspace_id);
        CREATE INDEX IF NOT EXISTS idx_messages_conversation_id ON messages(conversation_id);
        CREATE INDEX IF NOT EXISTS idx_conversation_agent_bindings_agent_id
            ON conversation_agent_bindings(agent_id);
        "#,
    )?;

    // Migration: Remove `id` column from group_agent_bindings if it exists
    // (SQLite 3.35.0+ supports DROP COLUMN)
    let _ = conn.execute_batch("ALTER TABLE group_agent_bindings DROP COLUMN id;");

    // Migration: Remove `stream_id` column from sub_chats if it exists
    let _ = conn.execute_batch("ALTER TABLE sub_chats DROP COLUMN stream_id;");

    // Migration: Add `workspace_id` column to group_agent_bindings if it doesn't exist.
    // Legacy rows predate a separate workspace ID and used the chat ID as the workspace identifier.
    // Backfill it only so old rows keep resolving; the current model keeps workspace and chat IDs distinct.
    let _ = conn.execute_batch(
        "ALTER TABLE group_agent_bindings ADD COLUMN workspace_id TEXT NOT NULL DEFAULT '';",
    );
    let _ = conn.execute_batch(
        "UPDATE group_agent_bindings SET workspace_id = chat_id WHERE workspace_id = '';",
    );

    // Migration: Add `workspace_id` column to chats if it doesn't exist.
    // Existing rows are left unlinked rather than assuming that a chat is itself a workspace.
    let _ = conn.execute_batch(
        "ALTER TABLE chats ADD COLUMN workspace_id TEXT REFERENCES workspaces(id) ON DELETE SET NULL;",
    );
    let _ = conn
        .execute_batch("CREATE INDEX IF NOT EXISTS idx_chats_workspace_id ON chats(workspace_id);");

    // Create index on workspace_id after migration (column may not exist in older databases)
    let _ = conn.execute_batch(
        "CREATE INDEX IF NOT EXISTS idx_group_agent_bindings_workspace_id ON group_agent_bindings(workspace_id);",
    );

    migrate_legacy_conversations(conn)?;

    Ok(())
}

/// Copy legacy chat/sub-chat rows into the unified conversation model.
///
/// The legacy tables remain only as migration sources; all runtime reads and
/// writes use the unified tables after startup.
fn migrate_legacy_conversations(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        r#"
        INSERT OR IGNORE INTO conversations
            (id, parent_id, project_id, workspace_id, name, mode, created_at, updated_at, archived_at)
        SELECT id, NULL, project_id, workspace_id, name, collaboration_mode,
               created_at, updated_at, archived_at
        FROM chats;

        INSERT OR IGNORE INTO conversation_execution_contexts
            (conversation_id, worktree_path, branch, base_branch, pr_url, pr_number)
        SELECT id, worktree_path, branch, base_branch, pr_url, pr_number
        FROM chats
        WHERE id IN (SELECT id FROM conversations);

        INSERT OR IGNORE INTO conversations
            (id, parent_id, project_id, workspace_id, name, mode, created_at, updated_at, archived_at)
        SELECT s.id, c.id, c.project_id, c.workspace_id, s.name, s.mode,
               s.created_at, s.updated_at, NULL
        FROM sub_chats AS s
        JOIN chats AS c ON c.id = s.chat_id;

        INSERT OR IGNORE INTO agent_sessions
            (conversation_id, session_id, mode, created_at, updated_at)
        SELECT s.id, s.session_id, s.mode, s.created_at, s.updated_at
        FROM sub_chats AS s
        WHERE s.id IN (SELECT id FROM conversations);

        INSERT OR IGNORE INTO conversation_agent_bindings
            (workspace_id, chat_id, agent_id, agent_name, agent_command, sub_chat_id, created_at, updated_at)
        SELECT workspace_id, chat_id, agent_id, agent_name, agent_command, sub_chat_id, created_at, updated_at
        FROM group_agent_bindings
        WHERE chat_id IN (SELECT id FROM conversations)
          AND sub_chat_id IN (SELECT id FROM conversations);
        "#,
    )?;

    // Legacy messages are stored as a JSON array inside each sub-chat row.
    // Expand them once; stable synthetic IDs make this migration idempotent.
    let mut stmt = conn.prepare(
        "SELECT id, messages, created_at FROM sub_chats WHERE id IN (SELECT id FROM conversations)",
    )?;
    let legacy_sub_chats = stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2)?,
            ))
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    drop(stmt);

    for (conversation_id, legacy_messages, fallback_created_at) in legacy_sub_chats {
        let parsed: serde_json::Value =
            serde_json::from_str(&legacy_messages).unwrap_or_else(|_| serde_json::json!([]));
        let Some(items) = parsed.as_array() else {
            continue;
        };

        for (index, value) in items.iter().enumerate() {
            let message_id = value
                .get("id")
                .and_then(serde_json::Value::as_str)
                .map(str::to_string)
                .unwrap_or_else(|| format!("legacy_{}_{}", conversation_id, index));
            let role = value
                .get("role")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("user")
                .to_string();
            let parts = match value.get("parts") {
                Some(parts) => parts.to_string(),
                None => value.to_string(),
            };
            let metadata = value
                .get("metadata")
                .filter(|value| !value.is_null())
                .map(serde_json::Value::to_string);
            let timestamp = value
                .get("createdAt")
                .and_then(serde_json::Value::as_i64)
                .unwrap_or(fallback_created_at);

            conn.execute(
                "INSERT OR IGNORE INTO messages
                    (id, conversation_id, sequence, role, parts, metadata, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)",
                params![
                    message_id,
                    conversation_id,
                    index as i64,
                    role,
                    parts,
                    metadata,
                    timestamp,
                ],
            )?;
        }
    }

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
pub struct Workspace {
    pub id: String,
    pub project_id: String,
    pub name: Option<String>,
    pub work_dir: String,
    pub env: String,       // JSON string
    pub resources: String, // JSON string
    pub capture_thoughts: bool,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Chat {
    pub id: String,
    pub name: Option<String>,
    pub project_id: String,
    pub workspace_id: Option<String>,
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
    pub mode: String,
    pub messages: String, // JSON array
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct Conversation {
    pub id: String,
    pub parent_id: Option<String>,
    pub project_id: String,
    pub workspace_id: Option<String>,
    pub name: Option<String>,
    pub mode: String,
    pub created_at: i64,
    pub updated_at: i64,
    pub archived_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct Message {
    pub id: String,
    pub conversation_id: String,
    pub sequence: i64,
    pub role: String,
    pub parts: String,
    pub metadata: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct AgentSession {
    pub conversation_id: String,
    pub session_id: Option<String>,
    pub mode: String,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct ConversationExecutionContext {
    pub conversation_id: String,
    pub worktree_path: Option<String>,
    pub branch: Option<String>,
    pub base_branch: Option<String>,
    pub pr_url: Option<String>,
    pub pr_number: Option<i32>,
}

/// Binding between a group chat and a runtime agent.
///
/// ## Matching Logic
/// - `agent_command` stores the profile name (e.g., "coder", "reviewer"), NOT the full command path
/// - Frontend passes `agentCommand` which is also the profile name
/// - Agent-to-agent routing matches by `agent_command == target_command` (both are profile names)
/// - This ensures consistent matching across frontend and backend
///
/// ## Workspace vs Chat
/// - `workspace_id` - Resource isolation (working directory, environment)
/// - `chat_id` - UI conversation session
/// - 1 workspace can have N chats (multiple conversations sharing same workspace)
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct GroupAgentBinding {
    /// Workspace ID (resource isolation)
    pub workspace_id: String,
    /// Chat ID (UI conversation session)
    pub chat_id: String,
    /// Runtime agent ID (e.g., "ws1-agent-1")
    pub agent_id: String,
    /// Display name for the agent
    pub agent_name: String,
    /// Profile name for matching (e.g., "coder") - NOT full command path
    pub agent_command: Option<String>,
    /// Sub-chat ID for this agent's conversation thread
    pub sub_chat_id: String,
    pub created_at: i64,
    pub updated_at: i64,
}

// ── CRUD Operations ──────────────────────────────────────────────────────────

pub mod conversations {
    use super::*;

    pub fn row_to_conversation(row: &rusqlite::Row<'_>) -> Result<Conversation> {
        Ok(Conversation {
            id: row.get(0)?,
            parent_id: row.get(1)?,
            project_id: row.get(2)?,
            workspace_id: row.get(3)?,
            name: row.get(4)?,
            mode: row.get(5)?,
            created_at: row.get(6)?,
            updated_at: row.get(7)?,
            archived_at: row.get(8)?,
        })
    }

    pub const CONVERSATION_COLUMNS: &str =
        "id, parent_id, project_id, workspace_id, name, mode, created_at, updated_at, archived_at";

    pub fn create(conversation: Conversation) -> Result<Conversation> {
        let db = get_user_data_db();
        let conn = db.lock().unwrap();

        if let Some(parent_id) = &conversation.parent_id {
            let (project_id, workspace_id): (String, Option<String>) = conn.query_row(
                "SELECT project_id, workspace_id FROM conversations WHERE id = ?1",
                params![parent_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )?;

            if conversation.project_id != project_id {
                return Err(rusqlite::Error::InvalidParameterName(
                    "conversation parent and child must belong to the same project".to_string(),
                ));
            }
            if conversation.workspace_id.is_some() && conversation.workspace_id != workspace_id {
                return Err(rusqlite::Error::InvalidParameterName(
                    "conversation parent and child must belong to the same workspace".to_string(),
                ));
            }
        }

        conn.execute(
            "INSERT INTO conversations (id, parent_id, project_id, workspace_id, name, mode, created_at, updated_at, archived_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                conversation.id,
                conversation.parent_id,
                conversation.project_id,
                conversation.workspace_id,
                conversation.name,
                conversation.mode,
                conversation.created_at,
                conversation.updated_at,
                conversation.archived_at,
            ],
        )?;

        Ok(conversation)
    }

    pub fn list_roots(
        project_id: Option<&str>,
        workspace_id: Option<&str>,
    ) -> Result<Vec<Conversation>> {
        let db = get_user_data_db();
        let conn = db.lock().unwrap();

        let (where_clause, params_vec): (String, Vec<Box<dyn rusqlite::types::ToSql>>) =
            match (project_id, workspace_id) {
                (Some(project_id), Some(workspace_id)) => (
                    "WHERE parent_id IS NULL AND project_id = ?1 AND workspace_id = ?2".to_string(),
                    vec![
                        Box::new(project_id.to_string()),
                        Box::new(workspace_id.to_string()),
                    ],
                ),
                (Some(project_id), None) => (
                    "WHERE parent_id IS NULL AND project_id = ?1".to_string(),
                    vec![Box::new(project_id.to_string())],
                ),
                (None, Some(workspace_id)) => (
                    "WHERE parent_id IS NULL AND workspace_id = ?1".to_string(),
                    vec![Box::new(workspace_id.to_string())],
                ),
                (None, None) => ("WHERE parent_id IS NULL".to_string(), vec![]),
            };

        let query = format!(
            "SELECT {CONVERSATION_COLUMNS} FROM conversations {where_clause} ORDER BY created_at DESC"
        );
        let mut stmt = conn.prepare(&query)?;
        let params_refs: Vec<&dyn rusqlite::types::ToSql> =
            params_vec.iter().map(|param| param.as_ref()).collect();
        let conversations = stmt.query_map(params_refs.as_slice(), row_to_conversation)?;
        conversations.collect()
    }

    pub fn list_children(parent_id: &str) -> Result<Vec<Conversation>> {
        let db = get_user_data_db();
        let conn = db.lock().unwrap();

        let mut stmt = conn.prepare(&format!(
            "SELECT {CONVERSATION_COLUMNS} FROM conversations WHERE parent_id = ?1 ORDER BY created_at ASC"
        ))?;
        let conversations = stmt.query_map(params![parent_id], row_to_conversation)?;
        conversations.collect()
    }

    pub fn get(id: &str) -> Result<Option<Conversation>> {
        let db = get_user_data_db();
        let conn = db.lock().unwrap();

        let mut stmt = conn.prepare(&format!(
            "SELECT {CONVERSATION_COLUMNS} FROM conversations WHERE id = ?1"
        ))?;
        let mut rows = stmt.query_map(params![id], row_to_conversation)?;
        rows.next().transpose()
    }

    pub fn update(conversation: Conversation) -> Result<()> {
        let db = get_user_data_db();
        let conn = db.lock().unwrap();

        conn.execute(
            "UPDATE conversations
             SET parent_id = ?1, project_id = ?2, workspace_id = ?3, name = ?4, mode = ?5,
                 archived_at = ?6, updated_at = ?7
             WHERE id = ?8",
            params![
                conversation.parent_id,
                conversation.project_id,
                conversation.workspace_id,
                conversation.name,
                conversation.mode,
                conversation.archived_at,
                conversation.updated_at,
                conversation.id,
            ],
        )?;

        Ok(())
    }

    pub fn archive(id: &str, archived_at: i64) -> Result<()> {
        let db = get_user_data_db();
        let conn = db.lock().unwrap();
        conn.execute(
            "UPDATE conversations SET archived_at = ?1, updated_at = ?1 WHERE id = ?2",
            params![archived_at, id],
        )?;
        Ok(())
    }

    pub fn unarchive(id: &str, updated_at: i64) -> Result<()> {
        let db = get_user_data_db();
        let conn = db.lock().unwrap();
        conn.execute(
            "UPDATE conversations SET archived_at = NULL, updated_at = ?1 WHERE id = ?2",
            params![updated_at, id],
        )?;
        Ok(())
    }

    pub fn delete(id: &str) -> Result<()> {
        let db = get_user_data_db();
        let conn = db.lock().unwrap();
        conn.execute("DELETE FROM conversations WHERE id = ?1", params![id])?;
        Ok(())
    }

    pub fn resolve_workspace_id(id: &str) -> Result<Option<String>> {
        let db = get_user_data_db();
        let conn = db.lock().unwrap();

        conn.query_row(
            "WITH RECURSIVE lineage AS (
                SELECT id, parent_id, workspace_id FROM conversations WHERE id = ?1
                UNION ALL
                SELECT conversations.id, conversations.parent_id, conversations.workspace_id
                FROM conversations JOIN lineage ON conversations.id = lineage.parent_id
             )
             SELECT workspace_id FROM lineage WHERE workspace_id IS NOT NULL LIMIT 1",
            params![id],
            |row| row.get(0),
        )
        .optional()
    }
}

pub mod messages {
    use super::*;

    pub fn list(conversation_id: &str) -> Result<Vec<Message>> {
        let db = get_user_data_db();
        let conn = db.lock().unwrap();

        let mut stmt = conn.prepare(
            "SELECT id, conversation_id, sequence, role, parts, metadata, created_at, updated_at
             FROM messages WHERE conversation_id = ?1 ORDER BY sequence ASC",
        )?;
        let messages = stmt.query_map(params![conversation_id], |row| {
            Ok(Message {
                id: row.get(0)?,
                conversation_id: row.get(1)?,
                sequence: row.get(2)?,
                role: row.get(3)?,
                parts: row.get(4)?,
                metadata: row.get(5)?,
                created_at: row.get(6)?,
                updated_at: row.get(7)?,
            })
        })?;
        messages.collect()
    }

    pub fn append(
        conversation_id: &str,
        role: &str,
        parts: serde_json::Value,
        metadata: serde_json::Value,
    ) -> Result<Message> {
        let db = get_user_data_db();
        let mut conn = db.lock().unwrap();
        let transaction = conn.transaction()?;
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs() as i64;
        let sequence: i64 = transaction.query_row(
            "SELECT COALESCE(MAX(sequence), -1) + 1 FROM messages WHERE conversation_id = ?1",
            params![conversation_id],
            |row| row.get(0),
        )?;
        let message = Message {
            id: format!("msg_{}", uuid::Uuid::new_v4()),
            conversation_id: conversation_id.to_string(),
            sequence,
            role: role.to_string(),
            parts: parts.to_string(),
            metadata: if metadata.is_null() {
                None
            } else {
                Some(metadata.to_string())
            },
            created_at: now,
            updated_at: now,
        };

        transaction.execute(
            "INSERT INTO messages (id, conversation_id, sequence, role, parts, metadata, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                message.id,
                message.conversation_id,
                message.sequence,
                message.role,
                message.parts,
                message.metadata,
                message.created_at,
                message.updated_at,
            ],
        )?;
        transaction.execute(
            "UPDATE conversations SET updated_at = ?1 WHERE id = ?2",
            params![now, conversation_id],
        )?;
        transaction.commit()?;
        Ok(message)
    }

    pub fn replace_legacy(conversation_id: &str, messages: &str, updated_at: i64) -> Result<()> {
        let parsed: serde_json::Value = serde_json::from_str(messages).map_err(|_| {
            rusqlite::Error::InvalidParameterName("messages must be a JSON array".to_string())
        })?;
        let Some(items) = parsed.as_array() else {
            return Err(rusqlite::Error::InvalidParameterName(
                "messages must be a JSON array".to_string(),
            ));
        };

        let db = get_user_data_db();
        let mut conn = db.lock().unwrap();
        let transaction = conn.transaction()?;
        transaction.execute(
            "DELETE FROM messages WHERE conversation_id = ?1",
            params![conversation_id],
        )?;

        for (index, value) in items.iter().enumerate() {
            let role = value
                .get("role")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("user");
            let parts = value.get("parts").cloned().unwrap_or_else(|| value.clone());
            let metadata = value
                .get("metadata")
                .cloned()
                .unwrap_or(serde_json::Value::Null);
            transaction.execute(
                "INSERT INTO messages (id, conversation_id, sequence, role, parts, metadata, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)",
                params![
                    value.get("id").and_then(serde_json::Value::as_str).unwrap_or(&format!("msg_{}", uuid::Uuid::new_v4())),
                    conversation_id,
                    index as i64,
                    role,
                    parts.to_string(),
                    if metadata.is_null() { None } else { Some(metadata.to_string()) },
                    updated_at,
                ],
            )?;
        }

        transaction.execute(
            "UPDATE conversations SET updated_at = ?1 WHERE id = ?2",
            params![updated_at, conversation_id],
        )?;
        transaction.commit()?;
        Ok(())
    }

    pub fn serialize_legacy(conversation_id: &str) -> Result<String> {
        let messages = list(conversation_id)?;
        let values = messages
            .into_iter()
            .map(|message| {
                let parts: serde_json::Value = serde_json::from_str(&message.parts)
                    .unwrap_or(serde_json::Value::String(message.parts.clone()));
                let metadata: serde_json::Value = message
                    .metadata
                    .as_deref()
                    .and_then(|metadata| serde_json::from_str(metadata).ok())
                    .unwrap_or(serde_json::Value::Null);
                serde_json::json!({
                    "id": message.id,
                    "role": message.role,
                    "parts": parts,
                    "metadata": metadata,
                    "createdAt": message.created_at,
                })
            })
            .collect::<Vec<_>>();
        serde_json::to_string(&values)
            .map_err(|error| rusqlite::Error::ToSqlConversionFailure(Box::new(error)))
    }
}

pub mod agent_sessions {
    use super::*;

    pub fn upsert(
        conversation_id: &str,
        session_id: Option<&str>,
        mode: &str,
        timestamp: i64,
    ) -> Result<()> {
        let db = get_user_data_db();
        let conn = db.lock().unwrap();
        conn.execute(
            "INSERT INTO agent_sessions (conversation_id, session_id, mode, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?4)
             ON CONFLICT(conversation_id) DO UPDATE SET
               session_id = excluded.session_id,
               mode = excluded.mode,
               updated_at = excluded.updated_at",
            params![conversation_id, session_id, mode, timestamp],
        )?;
        Ok(())
    }

    pub fn get(conversation_id: &str) -> Result<Option<String>> {
        let db = get_user_data_db();
        let conn = db.lock().unwrap();
        conn.query_row(
            "SELECT session_id FROM agent_sessions WHERE conversation_id = ?1",
            params![conversation_id],
            |row| row.get(0),
        )
        .optional()
    }
}

pub mod conversation_execution_contexts {
    use super::*;

    pub fn upsert(context: ConversationExecutionContext, timestamp: i64) -> Result<()> {
        let db = get_user_data_db();
        let conn = db.lock().unwrap();
        conn.execute(
            "INSERT INTO conversation_execution_contexts
                (conversation_id, worktree_path, branch, base_branch, pr_url, pr_number)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT(conversation_id) DO UPDATE SET
               worktree_path = excluded.worktree_path,
               branch = excluded.branch,
               base_branch = excluded.base_branch,
               pr_url = excluded.pr_url,
               pr_number = excluded.pr_number",
            params![
                context.conversation_id,
                context.worktree_path,
                context.branch,
                context.base_branch,
                context.pr_url,
                context.pr_number,
            ],
        )?;
        let _ = timestamp;
        Ok(())
    }

    pub fn get(conversation_id: &str) -> Result<Option<ConversationExecutionContext>> {
        let db = get_user_data_db();
        let conn = db.lock().unwrap();
        conn.query_row(
            "SELECT conversation_id, worktree_path, branch, base_branch, pr_url, pr_number
             FROM conversation_execution_contexts WHERE conversation_id = ?1",
            params![conversation_id],
            |row| {
                Ok(ConversationExecutionContext {
                    conversation_id: row.get(0)?,
                    worktree_path: row.get(1)?,
                    branch: row.get(2)?,
                    base_branch: row.get(3)?,
                    pr_url: row.get(4)?,
                    pr_number: row.get(5)?,
                })
            },
        )
        .optional()
    }

    pub fn find_by_worktree_path(path: &str) -> Result<Option<Conversation>> {
        let db = get_user_data_db();
        let conn = db.lock().unwrap();
        conn.query_row(
            &format!(
                "SELECT {} FROM conversations AS c
                 JOIN conversation_execution_contexts AS e ON e.conversation_id = c.id
                 WHERE c.parent_id IS NULL AND e.worktree_path = ?1 LIMIT 1",
                super::conversations::CONVERSATION_COLUMNS
                    .split(", ")
                    .map(|column| format!("c.{column}"))
                    .collect::<Vec<_>>()
                    .join(", ")
            ),
            params![path],
            super::conversations::row_to_conversation,
        )
        .optional()
    }
}

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

    /// Find a project by its path (indexed lookup, O(1) instead of O(n) full table scan)
    pub fn find_by_path(path: &str) -> Result<Option<Project>> {
        let db = get_user_data_db();
        let conn = db.lock().unwrap();

        let mut stmt = conn.prepare(
            "SELECT id, name, path, git_remote_url, git_provider, git_owner, git_repo, icon_path, created_at, updated_at
             FROM projects WHERE path = ?1 LIMIT 1"
        )?;

        let mut rows = stmt.query_map(params![path], |row| {
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

pub mod workspaces {
    use super::*;

    pub fn create(workspace: Workspace) -> Result<Workspace> {
        let db = get_user_data_db();
        let conn = db.lock().unwrap();

        conn.execute(
            "INSERT INTO workspaces (id, project_id, name, work_dir, env, resources, capture_thoughts, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                workspace.id,
                workspace.project_id,
                workspace.name,
                workspace.work_dir,
                workspace.env,
                workspace.resources,
                workspace.capture_thoughts,
                workspace.created_at,
                workspace.updated_at,
            ],
        )?;

        Ok(workspace)
    }

    pub fn list(project_id: Option<&str>) -> Result<Vec<Workspace>> {
        let db = get_user_data_db();
        let conn = db.lock().unwrap();

        if let Some(pid) = project_id {
            let mut stmt = conn.prepare(
                "SELECT id, project_id, name, work_dir, env, resources, capture_thoughts, created_at, updated_at
                 FROM workspaces WHERE project_id = ?1 ORDER BY created_at DESC"
            )?;
            let workspaces = stmt.query_map(params![pid], |row| {
                Ok(Workspace {
                    id: row.get(0)?,
                    project_id: row.get(1)?,
                    name: row.get(2)?,
                    work_dir: row.get(3)?,
                    env: row.get(4)?,
                    resources: row.get(5)?,
                    capture_thoughts: row.get(6)?,
                    created_at: row.get(7)?,
                    updated_at: row.get(8)?,
                })
            })?;
            workspaces.collect()
        } else {
            let mut stmt = conn.prepare(
                "SELECT id, project_id, name, work_dir, env, resources, capture_thoughts, created_at, updated_at
                 FROM workspaces ORDER BY created_at DESC"
            )?;
            let workspaces = stmt.query_map([], |row| {
                Ok(Workspace {
                    id: row.get(0)?,
                    project_id: row.get(1)?,
                    name: row.get(2)?,
                    work_dir: row.get(3)?,
                    env: row.get(4)?,
                    resources: row.get(5)?,
                    capture_thoughts: row.get(6)?,
                    created_at: row.get(7)?,
                    updated_at: row.get(8)?,
                })
            })?;
            workspaces.collect()
        }
    }

    pub fn get(id: &str) -> Result<Option<Workspace>> {
        let db = get_user_data_db();
        let conn = db.lock().unwrap();

        let mut stmt = conn.prepare(
            "SELECT id, project_id, name, work_dir, env, resources, capture_thoughts, created_at, updated_at
             FROM workspaces WHERE id = ?1"
        )?;

        let mut rows = stmt.query_map(params![id], |row| {
            Ok(Workspace {
                id: row.get(0)?,
                project_id: row.get(1)?,
                name: row.get(2)?,
                work_dir: row.get(3)?,
                env: row.get(4)?,
                resources: row.get(5)?,
                capture_thoughts: row.get(6)?,
                created_at: row.get(7)?,
                updated_at: row.get(8)?,
            })
        })?;

        match rows.next() {
            Some(Ok(workspace)) => Ok(Some(workspace)),
            Some(Err(e)) => Err(e),
            None => Ok(None),
        }
    }

    pub fn update(workspace: Workspace) -> Result<()> {
        let db = get_user_data_db();
        let conn = db.lock().unwrap();

        conn.execute(
            "UPDATE workspaces
             SET name = ?1, work_dir = ?2, env = ?3, resources = ?4,
                 capture_thoughts = ?5, updated_at = ?6
             WHERE id = ?7",
            params![
                workspace.name,
                workspace.work_dir,
                workspace.env,
                workspace.resources,
                workspace.capture_thoughts,
                workspace.updated_at,
                workspace.id,
            ],
        )?;

        Ok(())
    }

    pub fn delete(id: &str) -> Result<bool> {
        let db = get_user_data_db();
        let conn = db.lock().unwrap();
        let count = conn.execute("DELETE FROM workspaces WHERE id = ?1", params![id])?;
        Ok(count > 0)
    }
}

pub mod chats {
    use super::*;

    fn now_unix_seconds() -> i64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs() as i64
    }

    fn conversation_to_chat(
        conversation: Conversation,
        context: Option<ConversationExecutionContext>,
    ) -> Chat {
        Chat {
            id: conversation.id,
            name: conversation.name,
            project_id: conversation.project_id,
            workspace_id: conversation.workspace_id,
            collaboration_mode: conversation.mode,
            created_at: conversation.created_at,
            updated_at: conversation.updated_at,
            archived_at: conversation.archived_at,
            worktree_path: context
                .as_ref()
                .and_then(|context| context.worktree_path.clone()),
            branch: context.as_ref().and_then(|context| context.branch.clone()),
            base_branch: context
                .as_ref()
                .and_then(|context| context.base_branch.clone()),
            pr_url: context.as_ref().and_then(|context| context.pr_url.clone()),
            pr_number: context.as_ref().and_then(|context| context.pr_number),
        }
    }

    fn context_for(id: &str) -> Result<Option<ConversationExecutionContext>> {
        conversation_execution_contexts::get(id)
    }

    pub fn create(chat: Chat) -> Result<Chat> {
        let conversation = Conversation {
            id: chat.id.clone(),
            parent_id: None,
            project_id: chat.project_id.clone(),
            workspace_id: chat.workspace_id,
            name: chat.name.clone(),
            mode: chat.collaboration_mode.clone(),
            created_at: chat.created_at,
            updated_at: chat.updated_at,
            archived_at: chat.archived_at,
        };
        let conversation = conversations::create(conversation)?;
        conversation_execution_contexts::upsert(
            ConversationExecutionContext {
                conversation_id: chat.id.clone(),
                worktree_path: chat.worktree_path.clone(),
                branch: chat.branch.clone(),
                base_branch: chat.base_branch.clone(),
                pr_url: chat.pr_url.clone(),
                pr_number: chat.pr_number,
            },
            chat.updated_at,
        )?;
        Ok(conversation_to_chat(conversation, context_for(&chat.id)?))
    }

    pub fn list(project_id: Option<&str>, workspace_id: Option<&str>) -> Result<Vec<Chat>> {
        conversations::list_roots(project_id, workspace_id)?
            .into_iter()
            .map(|conversation| {
                let context = context_for(&conversation.id)?;
                Ok(conversation_to_chat(conversation, context))
            })
            .collect()
    }

    pub fn get(id: &str) -> Result<Option<Chat>> {
        let Some(conversation) = conversations::get(id)? else {
            return Ok(None);
        };
        if conversation.parent_id.is_some() {
            return Ok(None);
        }
        let context = context_for(id)?;
        Ok(Some(conversation_to_chat(conversation, context)))
    }

    pub fn find_by_worktree_path(path: &str) -> Result<Option<Chat>> {
        let Some(conversation) = conversation_execution_contexts::find_by_worktree_path(path)?
        else {
            return Ok(None);
        };
        let context = context_for(&conversation.id)?;
        Ok(Some(conversation_to_chat(conversation, context)))
    }

    pub fn update(chat: Chat) -> Result<()> {
        let Some(existing) = conversations::get(&chat.id)? else {
            return Err(rusqlite::Error::QueryReturnedNoRows);
        };
        conversations::update(Conversation {
            id: existing.id,
            parent_id: existing.parent_id,
            project_id: existing.project_id,
            workspace_id: chat.workspace_id,
            name: chat.name,
            mode: chat.collaboration_mode,
            created_at: existing.created_at,
            updated_at: chat.updated_at,
            archived_at: existing.archived_at,
        })?;
        conversation_execution_contexts::upsert(
            ConversationExecutionContext {
                conversation_id: chat.id.clone(),
                worktree_path: chat.worktree_path,
                branch: chat.branch,
                base_branch: chat.base_branch,
                pr_url: chat.pr_url,
                pr_number: chat.pr_number,
            },
            chat.updated_at,
        )?;
        Ok(())
    }

    pub fn archive(id: &str) -> Result<()> {
        conversations::archive(id, now_unix_seconds())
    }

    pub fn unarchive(id: &str) -> Result<()> {
        conversations::unarchive(id, now_unix_seconds())
    }

    pub fn delete(id: &str) -> Result<()> {
        conversations::delete(id)
    }
}

pub mod legacy_chats {
    use super::*;

    pub fn create(chat: Chat) -> Result<Chat> {
        let db = get_user_data_db();
        let conn = db.lock().unwrap();

        conn.execute(
            "INSERT INTO chats (id, name, project_id, workspace_id, collaboration_mode, created_at, updated_at, archived_at, worktree_path, branch, base_branch, pr_url, pr_number)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
            params![
                chat.id,
                chat.name,
                chat.project_id,
                chat.workspace_id,
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

    pub fn list(project_id: Option<&str>, workspace_id: Option<&str>) -> Result<Vec<Chat>> {
        let db = get_user_data_db();
        let conn = db.lock().unwrap();

        let select = "SELECT id, name, project_id, workspace_id, collaboration_mode, created_at, updated_at, archived_at, worktree_path, branch, base_branch, pr_url, pr_number";
        let (query, params_vec): (String, Vec<Box<dyn rusqlite::types::ToSql>>) =
            match (project_id, workspace_id) {
                (Some(pid), Some(wid)) => (
                    format!("{select} FROM chats WHERE project_id = ?1 AND workspace_id = ?2 ORDER BY created_at DESC"),
                    vec![Box::new(pid.to_string()), Box::new(wid.to_string())],
                ),
                (Some(pid), None) => (
                    format!("{select} FROM chats WHERE project_id = ?1 ORDER BY created_at DESC"),
                    vec![Box::new(pid.to_string())],
                ),
                (None, Some(wid)) => (
                    format!("{select} FROM chats WHERE workspace_id = ?1 ORDER BY created_at DESC"),
                    vec![Box::new(wid.to_string())],
                ),
                (None, None) => (
                    format!("{select} FROM chats ORDER BY created_at DESC"),
                    vec![],
                ),
            };

        let mut stmt = conn.prepare(&query)?;
        let params_refs: Vec<&dyn rusqlite::types::ToSql> =
            params_vec.iter().map(|p| p.as_ref()).collect();
        let chats = stmt.query_map(params_refs.as_slice(), |row| {
            Ok(Chat {
                id: row.get(0)?,
                name: row.get(1)?,
                project_id: row.get(2)?,
                workspace_id: row.get(3)?,
                collaboration_mode: row.get(4)?,
                created_at: row.get(5)?,
                updated_at: row.get(6)?,
                archived_at: row.get(7)?,
                worktree_path: row.get(8)?,
                branch: row.get(9)?,
                base_branch: row.get(10)?,
                pr_url: row.get(11)?,
                pr_number: row.get(12)?,
            })
        })?;
        chats.collect()
    }

    pub fn get(id: &str) -> Result<Option<Chat>> {
        let db = get_user_data_db();
        let conn = db.lock().unwrap();

        let mut stmt = conn.prepare(
            "SELECT id, name, project_id, workspace_id, collaboration_mode, created_at, updated_at, archived_at, worktree_path, branch, base_branch, pr_url, pr_number
             FROM chats WHERE id = ?1"
        )?;

        let mut rows = stmt.query_map(params![id], |row| {
            Ok(Chat {
                id: row.get(0)?,
                name: row.get(1)?,
                project_id: row.get(2)?,
                workspace_id: row.get(3)?,
                collaboration_mode: row.get(4)?,
                created_at: row.get(5)?,
                updated_at: row.get(6)?,
                archived_at: row.get(7)?,
                worktree_path: row.get(8)?,
                branch: row.get(9)?,
                base_branch: row.get(10)?,
                pr_url: row.get(11)?,
                pr_number: row.get(12)?,
            })
        })?;

        match rows.next() {
            Some(Ok(chat)) => Ok(Some(chat)),
            Some(Err(e)) => Err(e),
            None => Ok(None),
        }
    }

    /// Find a chat by its worktree path (indexed lookup, O(1) instead of O(n) full table scan)
    pub fn find_by_worktree_path(path: &str) -> Result<Option<Chat>> {
        let db = get_user_data_db();
        let conn = db.lock().unwrap();

        let mut stmt = conn.prepare(
            "SELECT id, name, project_id, workspace_id, collaboration_mode, created_at, updated_at, archived_at, worktree_path, branch, base_branch, pr_url, pr_number
             FROM chats WHERE worktree_path = ?1 LIMIT 1"
        )?;

        let mut rows = stmt.query_map(params![path], |row| {
            Ok(Chat {
                id: row.get(0)?,
                name: row.get(1)?,
                project_id: row.get(2)?,
                workspace_id: row.get(3)?,
                collaboration_mode: row.get(4)?,
                created_at: row.get(5)?,
                updated_at: row.get(6)?,
                archived_at: row.get(7)?,
                worktree_path: row.get(8)?,
                branch: row.get(9)?,
                base_branch: row.get(10)?,
                pr_url: row.get(11)?,
                pr_number: row.get(12)?,
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
             SET name = ?1, workspace_id = ?2, collaboration_mode = ?3, updated_at = ?4, worktree_path = ?5,
                 branch = ?6, base_branch = ?7, pr_url = ?8, pr_number = ?9
             WHERE id = ?10",
            params![
                chat.name,
                chat.workspace_id,
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

    fn conversation_to_sub_chat(
        conversation: Conversation,
        session_id: Option<String>,
        messages: String,
    ) -> SubChat {
        SubChat {
            id: conversation.id,
            name: conversation.name,
            chat_id: conversation
                .parent_id
                .expect("child conversation must have a parent"),
            session_id,
            mode: conversation.mode,
            messages,
            created_at: conversation.created_at,
            updated_at: conversation.updated_at,
        }
    }

    pub fn create(sub_chat: SubChat) -> Result<SubChat> {
        let parent = conversations::get(&sub_chat.chat_id)?
            .filter(|conversation| conversation.parent_id.is_none())
            .ok_or(rusqlite::Error::QueryReturnedNoRows)?;
        let conversation = conversations::create(Conversation {
            id: sub_chat.id.clone(),
            parent_id: Some(parent.id.clone()),
            project_id: parent.project_id.clone(),
            workspace_id: parent.workspace_id.clone(),
            name: sub_chat.name.clone(),
            mode: sub_chat.mode.clone(),
            created_at: sub_chat.created_at,
            updated_at: sub_chat.updated_at,
            archived_at: None,
        })?;
        agent_sessions::upsert(
            &sub_chat.id,
            sub_chat.session_id.as_deref(),
            &sub_chat.mode,
            sub_chat.created_at,
        )?;
        messages::replace_legacy(&sub_chat.id, &sub_chat.messages, sub_chat.updated_at)?;
        Ok(conversation_to_sub_chat(
            conversation,
            sub_chat.session_id,
            sub_chat.messages,
        ))
    }

    pub fn list(chat_id: &str) -> Result<Vec<SubChat>> {
        conversations::list_children(chat_id)?
            .into_iter()
            .map(|conversation| {
                let session_id = agent_sessions::get(&conversation.id)?;
                let messages = messages::serialize_legacy(&conversation.id)?;
                Ok(conversation_to_sub_chat(conversation, session_id, messages))
            })
            .collect()
    }

    pub fn get(id: &str) -> Result<Option<SubChat>> {
        let Some(conversation) =
            conversations::get(id)?.filter(|conversation| conversation.parent_id.is_some())
        else {
            return Ok(None);
        };
        let session_id = agent_sessions::get(id)?;
        let messages = messages::serialize_legacy(id)?;
        Ok(Some(conversation_to_sub_chat(
            conversation,
            session_id,
            messages,
        )))
    }

    pub fn update_messages(id: &str, messages: &str, updated_at: i64) -> Result<()> {
        if conversations::get(id)?.is_none() {
            return Err(rusqlite::Error::QueryReturnedNoRows);
        }
        messages::replace_legacy(id, messages, updated_at)
    }

    pub fn append_message(
        id: &str,
        role: &str,
        text: &str,
        metadata: serde_json::Value,
    ) -> Result<()> {
        let parts = serde_json::json!([{ "type": "text", "text": text }]);
        append_message_parts(id, role, parts, metadata)
    }

    pub fn append_message_parts(
        id: &str,
        role: &str,
        parts: serde_json::Value,
        metadata: serde_json::Value,
    ) -> Result<()> {
        messages::append(id, role, parts, metadata)?;
        Ok(())
    }

    fn update_conversation_fields(
        id: &str,
        name: Option<&str>,
        mode: Option<&str>,
        updated_at: i64,
    ) -> Result<()> {
        let Some(existing) = conversations::get(id)? else {
            return Err(rusqlite::Error::QueryReturnedNoRows);
        };
        conversations::update(Conversation {
            id: existing.id,
            parent_id: existing.parent_id,
            project_id: existing.project_id,
            workspace_id: existing.workspace_id,
            name: name.map(str::to_string).or(existing.name),
            mode: mode
                .map(str::to_string)
                .unwrap_or_else(|| existing.mode.clone()),
            created_at: existing.created_at,
            updated_at,
            archived_at: existing.archived_at,
        })
    }

    pub fn update_name(id: &str, name: &str, updated_at: i64) -> Result<()> {
        update_conversation_fields(id, Some(name), None, updated_at)
    }

    pub fn update_session(id: &str, session_id: &str, updated_at: i64) -> Result<()> {
        let mode = conversations::get(id)?
            .ok_or(rusqlite::Error::QueryReturnedNoRows)?
            .mode;
        agent_sessions::upsert(id, Some(session_id), &mode, updated_at)
    }

    pub fn update_mode(id: &str, mode: &str, updated_at: i64) -> Result<()> {
        update_conversation_fields(id, None, Some(mode), updated_at)?;
        agent_sessions::upsert(id, None, mode, updated_at)
    }

    pub fn update_full(
        id: &str,
        name: Option<&str>,
        session_id: Option<&str>,
        mode: Option<&str>,
        messages: Option<&str>,
        updated_at: i64,
    ) -> Result<()> {
        update_conversation_fields(id, name, mode, updated_at)?;
        if let Some(session_id) = session_id {
            update_session(id, session_id, updated_at)?;
        }
        if let Some(messages) = messages {
            update_messages(id, messages, updated_at)?;
        }
        Ok(())
    }

    pub fn delete(id: &str) -> Result<()> {
        conversations::delete(id)
    }
}

pub mod legacy_sub_chats {
    use super::*;

    pub fn create(sub_chat: SubChat) -> Result<SubChat> {
        let db = get_user_data_db();
        let conn = db.lock().unwrap();

        conn.execute(
            "INSERT INTO sub_chats (id, name, chat_id, session_id, mode, messages, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                sub_chat.id,
                sub_chat.name,
                sub_chat.chat_id,
                sub_chat.session_id,
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
            "SELECT id, name, chat_id, session_id, mode, messages, created_at, updated_at
             FROM sub_chats WHERE chat_id = ?1 ORDER BY created_at ASC",
        )?;

        let sub_chats = stmt.query_map(params![chat_id], |row| {
            Ok(SubChat {
                id: row.get(0)?,
                name: row.get(1)?,
                chat_id: row.get(2)?,
                session_id: row.get(3)?,
                mode: row.get(4)?,
                messages: row.get(5)?,
                created_at: row.get(6)?,
                updated_at: row.get(7)?,
            })
        })?;

        sub_chats.collect()
    }

    pub fn get(id: &str) -> Result<Option<SubChat>> {
        let db = get_user_data_db();
        let conn = db.lock().unwrap();

        let mut stmt = conn.prepare(
            "SELECT id, name, chat_id, session_id, mode, messages, created_at, updated_at
             FROM sub_chats WHERE id = ?1",
        )?;

        let mut rows = stmt.query_map(params![id], |row| {
            Ok(SubChat {
                id: row.get(0)?,
                name: row.get(1)?,
                chat_id: row.get(2)?,
                session_id: row.get(3)?,
                mode: row.get(4)?,
                messages: row.get(5)?,
                created_at: row.get(6)?,
                updated_at: row.get(7)?,
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
        // Hold the mutex across the entire read-modify-write sequence to prevent race conditions
        let db = get_user_data_db();
        let conn = db.lock().unwrap();

        // Read current messages
        let mut stmt = conn.prepare("SELECT messages FROM sub_chats WHERE id = ?1")?;
        let messages_str: String = match stmt.query_row(params![id], |row| row.get(0)) {
            Ok(s) => s,
            Err(rusqlite::Error::QueryReturnedNoRows) => {
                return Err(rusqlite::Error::QueryReturnedNoRows)
            }
            Err(e) => return Err(e),
        };

        let mut messages: serde_json::Value =
            serde_json::from_str(&messages_str).unwrap_or_else(|_| serde_json::json!([]));
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

        // Write updated messages while still holding the mutex
        conn.execute(
            "UPDATE sub_chats SET messages = ?1, updated_at = ?2 WHERE id = ?3",
            params![messages.to_string(), now, id],
        )?;

        Ok(())
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

    pub fn update_full(
        id: &str,
        name: Option<&str>,
        session_id: Option<&str>,
        mode: Option<&str>,
        messages: Option<&str>,
        updated_at: i64,
    ) -> Result<()> {
        let db = get_user_data_db();
        let conn = db.lock().unwrap();

        // Build dynamic update query
        let mut updates = vec!["updated_at = ?1".to_string()];
        // Count Some fields to determine param_idx (starts at 2 since updated_at is ?1)
        let some_count = [
            name.is_some(),
            session_id.is_some(),
            mode.is_some(),
            messages.is_some(),
        ]
        .iter()
        .filter(|&&b| b)
        .count();

        let mut param_idx = 2;
        if name.is_some() {
            updates.push(format!("name = ?{}", param_idx));
            param_idx += 1;
        }
        if session_id.is_some() {
            updates.push(format!("session_id = ?{}", param_idx));
            param_idx += 1;
        }
        if mode.is_some() {
            updates.push(format!("mode = ?{}", param_idx));
            param_idx += 1;
        }
        if messages.is_some() {
            updates.push(format!("messages = ?{}", param_idx));
            // No need to increment param_idx after the last field
        }

        // Suppress unused variable warning for param_idx when all fields are None
        let _ = param_idx;
        let _ = some_count;

        let query = format!("UPDATE sub_chats SET {} WHERE id = ?", updates.join(", "));

        // Build params
        let mut params_vec: Vec<Box<dyn rusqlite::types::ToSql>> = vec![Box::new(updated_at)];
        if let Some(n) = name {
            params_vec.push(Box::new(n.to_string()));
        }
        if let Some(s) = session_id {
            params_vec.push(Box::new(s.to_string()));
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
            workspace_id: row.get(0)?,
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
            "INSERT INTO conversation_agent_bindings (workspace_id, chat_id, agent_id, agent_name, agent_command, sub_chat_id, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
             ON CONFLICT(chat_id, agent_id) DO UPDATE SET
               workspace_id = excluded.workspace_id,
               agent_name = excluded.agent_name,
               agent_command = excluded.agent_command,
               sub_chat_id = excluded.sub_chat_id,
               updated_at = excluded.updated_at",
            params![
                binding.workspace_id,
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
            "SELECT workspace_id, chat_id, agent_id, agent_name, agent_command, sub_chat_id, created_at, updated_at
             FROM conversation_agent_bindings WHERE chat_id = ?1 AND agent_id = ?2",
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
            "SELECT workspace_id, chat_id, agent_id, agent_name, agent_command, sub_chat_id, created_at, updated_at
             FROM conversation_agent_bindings WHERE chat_id = ?1 ORDER BY created_at ASC",
        )?;
        let bindings = stmt.query_map(params![chat_id], row_to_binding)?;
        bindings.collect()
    }

    pub fn find_sub_chat_id(agent_id: &str) -> Result<Option<String>> {
        let db = get_user_data_db();
        let conn = db.lock().unwrap();

        let mut stmt = conn
            .prepare("SELECT sub_chat_id FROM conversation_agent_bindings WHERE agent_id = ?1 ORDER BY created_at ASC LIMIT 1")?;
        let mut rows = stmt.query_map(params![agent_id], |row| row.get::<_, String>(0))?;
        rows.next().transpose()
    }

    pub fn delete(chat_id: &str, agent_id: &str) -> Result<bool> {
        let db = get_user_data_db();
        let conn = db.lock().unwrap();
        let count = conn.execute(
            "DELETE FROM conversation_agent_bindings WHERE chat_id = ?1 AND agent_id = ?2",
            params![chat_id, agent_id],
        )?;
        Ok(count > 0)
    }

    /// Remove all bindings for a specific agent (cleanup when agent dies)
    pub fn delete_by_agent(agent_id: &str) -> Result<usize> {
        let db = get_user_data_db();
        let conn = db.lock().unwrap();
        let count = conn.execute(
            "DELETE FROM conversation_agent_bindings WHERE agent_id = ?1",
            params![agent_id],
        )?;
        Ok(count)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_project_crud() {
        // NOTE: This test uses set_var which is not thread-safe in parallel test contexts.
        // We use process ID to create a unique directory per test process, reducing race risk.
        // For full safety, this test should be run with `cargo test -- --test-threads=1` or
        // refactored to not rely on env vars (requires get_db_path() to accept a parameter).
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

    fn make_chat(id: &str, project_id: &str, workspace_id: Option<&str>) -> Chat {
        Chat {
            id: id.to_string(),
            name: Some(format!("Chat {id}")),
            project_id: project_id.to_string(),
            workspace_id: workspace_id.map(|s| s.to_string()),
            collaboration_mode: "none".to_string(),
            created_at: 1000,
            updated_at: 1000,
            archived_at: None,
            worktree_path: None,
            branch: None,
            base_branch: None,
            pr_url: None,
            pr_number: None,
        }
    }

    // NOTE: This test shares the process-global USER_DATA_DB (Lazy<...>).
    // Use unique IDs to avoid collisions with other tests, and clean up afterward.
    // For full isolation, run with `cargo test -- --test-threads=1`.

    #[test]
    fn test_chat_list_all_filter_combinations() {
        let prefix = format!("cl-{}", std::process::id());
        let pid1 = format!("{prefix}-p1");
        let pid2 = format!("{prefix}-p2");
        let wid1 = format!("{prefix}-w1");
        let wid2 = format!("{prefix}-w2");
        let wid3 = format!("{prefix}-w3");
        let cid1 = format!("{prefix}-c1");
        let cid2 = format!("{prefix}-c2");
        let cid3 = format!("{prefix}-c3");

        // Create parent records (FK constraints)
        let p1 = Project {
            id: pid1.clone(),
            name: "P1".into(),
            path: format!("/tmp/{pid1}"),
            git_remote_url: None,
            git_provider: None,
            git_owner: None,
            git_repo: None,
            icon_path: None,
            created_at: 1000,
            updated_at: 1000,
        };
        let p2 = Project {
            id: pid2.clone(),
            name: "P2".into(),
            path: format!("/tmp/{pid2}"),
            git_remote_url: None,
            git_provider: None,
            git_owner: None,
            git_repo: None,
            icon_path: None,
            created_at: 1000,
            updated_at: 1000,
        };
        projects::create(p1).unwrap();
        projects::create(p2).unwrap();

        let w1 = Workspace {
            id: wid1.clone(),
            project_id: pid1.clone(),
            name: Some("W1".into()),
            work_dir: format!("/tmp/{wid1}"),
            env: "{}".into(),
            resources: "{}".into(),
            capture_thoughts: false,
            created_at: 1000,
            updated_at: 1000,
        };
        let w2 = Workspace {
            id: wid2.clone(),
            project_id: pid1.clone(),
            name: Some("W2".into()),
            work_dir: format!("/tmp/{wid2}"),
            env: "{}".into(),
            resources: "{}".into(),
            capture_thoughts: false,
            created_at: 1000,
            updated_at: 1000,
        };
        let w3 = Workspace {
            id: wid3.clone(),
            project_id: pid2.clone(),
            name: Some("W3".into()),
            work_dir: format!("/tmp/{wid3}"),
            env: "{}".into(),
            resources: "{}".into(),
            capture_thoughts: false,
            created_at: 1000,
            updated_at: 1000,
        };
        workspaces::create(w1).unwrap();
        workspaces::create(w2).unwrap();
        workspaces::create(w3).unwrap();

        // Insert test chats
        chats::create(make_chat(&cid1, &pid1, Some(&wid1))).unwrap();
        chats::create(make_chat(&cid2, &pid1, Some(&wid2))).unwrap();
        chats::create(make_chat(&cid3, &pid2, Some(&wid3))).unwrap();

        // Branch 1: no filters → at least 3 (may include data from other tests)
        let all = chats::list(None, None).unwrap();
        assert!(all.len() >= 3);

        // Branch 2: project_id only → 2 (pid1)
        let by_project = chats::list(Some(&pid1), None).unwrap();
        assert_eq!(by_project.len(), 2);
        assert!(by_project.iter().all(|c| c.project_id == pid1));

        // Branch 3: workspace_id only → 1 (wid1)
        let by_workspace = chats::list(None, Some(&wid1)).unwrap();
        assert_eq!(by_workspace.len(), 1);
        assert_eq!(by_workspace[0].id, cid1);

        // Branch 4: both filters → 1 (pid1 + wid1)
        let by_both = chats::list(Some(&pid1), Some(&wid1)).unwrap();
        assert_eq!(by_both.len(), 1);
        assert_eq!(by_both[0].id, cid1);

        // Cleanup
        let _ = chats::get(&cid1);
        let _ = chats::get(&cid2);
        let _ = chats::get(&cid3);
        let _ = workspaces::delete(&wid1);
        let _ = workspaces::delete(&wid2);
        let _ = workspaces::delete(&wid3);
        let _ = projects::delete(&pid1);
        let _ = projects::delete(&pid2);
    }

    #[test]
    fn test_conversation_tree_messages_and_workspace_resolution() {
        let prefix = format!("conversation-tree-{}", std::process::id());
        let project_id = format!("{prefix}-project");
        let workspace_id = format!("{prefix}-workspace");
        let root_id = format!("{prefix}-root");
        let child_id = format!("{prefix}-child");

        projects::create(Project {
            id: project_id.clone(),
            name: "Conversation test".to_string(),
            path: format!("/tmp/{project_id}"),
            git_remote_url: None,
            git_provider: None,
            git_owner: None,
            git_repo: None,
            icon_path: None,
            created_at: 1000,
            updated_at: 1000,
        })
        .unwrap();
        workspaces::create(Workspace {
            id: workspace_id.clone(),
            project_id: project_id.clone(),
            name: None,
            work_dir: format!("/tmp/{workspace_id}"),
            env: "{}".to_string(),
            resources: "{}".to_string(),
            capture_thoughts: false,
            created_at: 1000,
            updated_at: 1000,
        })
        .unwrap();

        conversations::create(Conversation {
            id: root_id.clone(),
            parent_id: None,
            project_id: project_id.clone(),
            workspace_id: Some(workspace_id.clone()),
            name: Some("Root".to_string()),
            mode: "agent".to_string(),
            created_at: 1000,
            updated_at: 1000,
            archived_at: None,
        })
        .unwrap();
        conversations::create(Conversation {
            id: child_id.clone(),
            parent_id: Some(root_id.clone()),
            project_id: project_id.clone(),
            workspace_id: None,
            name: Some("Child".to_string()),
            mode: "agent".to_string(),
            created_at: 1001,
            updated_at: 1001,
            archived_at: None,
        })
        .unwrap();

        messages::append(
            &root_id,
            "user",
            serde_json::json!([{ "type": "text", "text": "root prompt" }]),
            serde_json::json!({}),
        )
        .unwrap();
        messages::append(
            &child_id,
            "assistant",
            serde_json::json!([{ "type": "text", "text": "child reply" }]),
            serde_json::json!({}),
        )
        .unwrap();

        assert_eq!(
            conversations::resolve_workspace_id(&root_id).unwrap(),
            Some(workspace_id.clone())
        );
        assert_eq!(
            conversations::resolve_workspace_id(&child_id).unwrap(),
            Some(workspace_id.clone())
        );
        assert_eq!(messages::list(&root_id).unwrap().len(), 1);
        assert_eq!(messages::list(&child_id).unwrap().len(), 1);
        assert_eq!(conversations::list_children(&root_id).unwrap().len(), 1);

        let legacy_chat = chats::get(&root_id).unwrap().unwrap();
        assert_eq!(
            legacy_chat.workspace_id.as_deref(),
            Some(workspace_id.as_str())
        );
        let legacy_sub_chat = sub_chats::get(&child_id).unwrap().unwrap();
        assert_eq!(legacy_sub_chat.chat_id, root_id);
        let legacy_messages: serde_json::Value =
            serde_json::from_str(&legacy_sub_chat.messages).unwrap();
        assert_eq!(legacy_messages[0]["role"], "assistant");
        assert_eq!(legacy_messages[0]["parts"][0]["text"], "child reply");

        conversations::archive(&root_id, 2000).unwrap();
        assert!(conversations::get(&root_id)
            .unwrap()
            .unwrap()
            .archived_at
            .is_some());

        conversations::delete(&root_id).unwrap();
        assert!(conversations::get(&child_id).unwrap().is_none());
        assert!(messages::list(&child_id).unwrap().is_empty());
        workspaces::delete(&workspace_id).unwrap();
        projects::delete(&project_id).unwrap();
    }
}
