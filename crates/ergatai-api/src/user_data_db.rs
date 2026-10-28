//! User data database management for workspaces, chats, conversations, and messages.
//!
//! This module provides persistent storage for user-facing data with a clear hierarchy:
//! Workspace → Chat (1:N) → CollaborationSession (1:N) → Conversation (1:N) → Messages (1:N)
//!                                                                                   ↓
//!                                                                           AgentSession (1:1)

use ergatai_error::{
    ChatId, CollaborationSessionId, ConversationId, MessageId, ProjectId, WorkspaceId,
};
use once_cell::sync::Lazy;
use rusqlite::{params, Connection, OptionalExtension, Result};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use utoipa::ToSchema;

/// Default collaboration mode for chats
pub const DEFAULT_COLLABORATION_MODE: &str = "supervisor";

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

/// Get the database file path with symlink protection
fn get_db_path() -> PathBuf {
    // Use unified user data directory
    let data_dir = std::env::var("ERGATAI_DATA_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|_| ergatai_runtime::dirs::user_data_dir());

    std::fs::create_dir_all(&data_dir).ok();

    // SECURITY: Canonicalize data_dir to detect and prevent symlink attacks.
    let canonical_data_dir = match data_dir.canonicalize() {
        Ok(path) => path,
        Err(e) => {
            tracing::warn!(
                error = %e,
                data_dir = %data_dir.display(),
                "Failed to canonicalize data directory, using original path"
            );
            data_dir.clone()
        }
    };

    let db_path = canonical_data_dir.join("user_data.db");

    // SECURITY: If the db file already exists, verify it's not a symlink to a
    // sensitive location.
    if db_path.exists() {
        if let Ok(metadata) = std::fs::symlink_metadata(&db_path) {
            if metadata.file_type().is_symlink() {
                tracing::error!(
                    db_path = %db_path.display(),
                    "Database path is a symlink - refusing to open (security risk)"
                );
                let fallback = canonical_data_dir.join("user_data_safe.db");
                return fallback;
            }
        }
    }

    db_path
}

/// Initialize all required tables
///
/// This function drops and recreates all tables on startup ONLY in development mode.
/// Set ERGATAI_PRESERVE_DATA=1 or ERGATAI_PRODUCTION_MODE=1 to preserve existing data.
fn initialize_tables(conn: &Connection) -> Result<()> {
    // Helper to check if an environment variable is truthy (accepts "1" or "true", case-insensitive)
    let is_truthy_env = |var_name: &str| -> bool {
        std::env::var(var_name)
            .map(|v| v == "1" || v.to_lowercase() == "true")
            .unwrap_or(false)
    };

    // Check if we should preserve existing data (production mode)
    let preserve_data =
        is_truthy_env("ERGATAI_PRESERVE_DATA") || is_truthy_env("ERGATAI_PRODUCTION_MODE");

    if preserve_data {
        // Production mode: create tables if they don't exist, preserve existing data
        tracing::info!(
            "ERGATAI_PRESERVE_DATA or ERGATAI_PRODUCTION_MODE is set - preserving existing data"
        );
        conn.execute_batch("PRAGMA foreign_keys=ON;")?;
        return create_tables_if_not_exists(conn);
    }

    // Development mode: drop and recreate all tables
    tracing::warn!(
        "Development mode: dropping all user data tables. \
         Set ERGATAI_PRESERVE_DATA=1 to preserve data across restarts."
    );

    // Enable foreign key constraints
    conn.execute_batch("PRAGMA foreign_keys=OFF;")?;

    // Drop all tables in reverse dependency order (development mode - no data preservation)
    conn.execute_batch(
        r#"
        DROP TABLE IF EXISTS collaboration_approvals;
        DROP TABLE IF EXISTS collaboration_plan_revisions;
        DROP TABLE IF EXISTS collaboration_context_events;
        DROP TABLE IF EXISTS group_agent_bindings;
        DROP TABLE IF EXISTS conversation_execution_contexts;
        DROP TABLE IF EXISTS terminal_sessions;
        DROP TABLE IF EXISTS messages;
        DROP TABLE IF EXISTS agent_sessions;
        DROP TABLE IF EXISTS conversations;
        DROP TABLE IF EXISTS collaboration_session_participants;
        DROP TABLE IF EXISTS collaboration_sessions;
        DROP TABLE IF EXISTS projects;
        DROP TABLE IF EXISTS chats;
        DROP TABLE IF EXISTS workspaces;
        DROP TABLE IF EXISTS mcp_servers;
        "#,
    )?;

    conn.execute_batch("PRAGMA foreign_keys=ON;")?;

    create_tables_if_not_exists(conn)?;
    migrate_message_turn_columns(conn)
}

/// Create all tables if they don't already exist (safe for production)
fn create_tables_if_not_exists(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS workspaces (
            workspace_id INTEGER PRIMARY KEY,
            name TEXT NOT NULL,
            work_dir TEXT NOT NULL,
            env TEXT DEFAULT '{}',
            resources TEXT DEFAULT '{}',
            config TEXT DEFAULT '{}',
            collaboration_mode TEXT NOT NULL DEFAULT 'supervisor',
            status TEXT NOT NULL DEFAULT 'active',
            default_project_id INTEGER,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            FOREIGN KEY (default_project_id) REFERENCES projects(project_id) ON DELETE SET NULL
        );

        CREATE TABLE IF NOT EXISTS chats (
            chat_id INTEGER PRIMARY KEY,
            workspace_id INTEGER NOT NULL,
            name TEXT,
            collaboration_mode TEXT DEFAULT 'supervisor',
            worktree_path TEXT,
            branch TEXT,
            base_branch TEXT,
            pr_url TEXT,
            pr_number INTEGER,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            archived_at INTEGER,
            FOREIGN KEY (workspace_id) REFERENCES workspaces(workspace_id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_chats_workspace_id ON chats(workspace_id);
        CREATE INDEX IF NOT EXISTS idx_chats_worktree_path ON chats(worktree_path);

        CREATE TABLE IF NOT EXISTS projects (
            project_id INTEGER PRIMARY KEY,
            workspace_id INTEGER NOT NULL,
            name TEXT NOT NULL,
            path TEXT NOT NULL,
            description TEXT,
            git_remote_url TEXT,
            git_provider TEXT,
            git_owner TEXT,
            git_repo TEXT,
            icon_path TEXT,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            FOREIGN KEY (workspace_id) REFERENCES workspaces(workspace_id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_projects_workspace_id ON projects(workspace_id);
        CREATE INDEX IF NOT EXISTS idx_projects_path ON projects(path);

        CREATE TABLE IF NOT EXISTS collaboration_sessions (
            collaboration_session_id INTEGER PRIMARY KEY,
            chat_id INTEGER NOT NULL,
            workspace_id INTEGER NOT NULL,
            mode TEXT NOT NULL CHECK (mode IN ('supervisor', 'group')),
            state TEXT NOT NULL CHECK (state IN (
                'idle', 'planning', 'executing', 'waiting_input',
                'waiting_approval', 'synthesizing', 'completed',
                'failed', 'cancelled'
            )),
            goal TEXT,
            active_plan_revision TEXT,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            FOREIGN KEY (chat_id) REFERENCES chats(chat_id) ON DELETE CASCADE,
            FOREIGN KEY (workspace_id) REFERENCES workspaces(workspace_id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_collaboration_sessions_chat_id ON collaboration_sessions(chat_id);
        CREATE INDEX IF NOT EXISTS idx_collaboration_sessions_workspace_id ON collaboration_sessions(workspace_id);

        CREATE TABLE IF NOT EXISTS collaboration_session_participants (
            id TEXT PRIMARY KEY,
            session_id INTEGER NOT NULL,
            conversation_id INTEGER NOT NULL,
            agent_id INTEGER NOT NULL,
            role TEXT NOT NULL DEFAULT 'peer',
            status TEXT NOT NULL DEFAULT 'active',
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            FOREIGN KEY (session_id) REFERENCES collaboration_sessions(collaboration_session_id) ON DELETE CASCADE,
            FOREIGN KEY (conversation_id) REFERENCES conversations(conversation_id) ON DELETE CASCADE,
            UNIQUE (session_id, conversation_id)
        );
        CREATE INDEX IF NOT EXISTS idx_collaboration_session_participants_session_id ON collaboration_session_participants(session_id);
        CREATE INDEX IF NOT EXISTS idx_collaboration_session_participants_conversation_id ON collaboration_session_participants(conversation_id);
        CREATE INDEX IF NOT EXISTS idx_collaboration_session_participants_agent_id ON collaboration_session_participants(agent_id);

        CREATE TABLE IF NOT EXISTS conversations (
            conversation_id INTEGER PRIMARY KEY,
            collaboration_session_id INTEGER NOT NULL,
            chat_id INTEGER NOT NULL,
            parent_id INTEGER,
            name TEXT,
            mode TEXT NOT NULL DEFAULT 'agent',
            participant_role TEXT NOT NULL DEFAULT 'peer',
            status TEXT NOT NULL DEFAULT 'ready',
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            FOREIGN KEY (collaboration_session_id) REFERENCES collaboration_sessions(collaboration_session_id) ON DELETE CASCADE,
            FOREIGN KEY (chat_id) REFERENCES chats(chat_id) ON DELETE CASCADE,
            FOREIGN KEY (parent_id) REFERENCES conversations(conversation_id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_conversations_collaboration_session_id ON conversations(collaboration_session_id);
        CREATE INDEX IF NOT EXISTS idx_conversations_chat_id ON conversations(chat_id);
        CREATE INDEX IF NOT EXISTS idx_conversations_parent_id ON conversations(parent_id);

        CREATE TABLE IF NOT EXISTS agent_sessions (
            agent_session_id INTEGER PRIMARY KEY,
            conversation_id INTEGER NOT NULL UNIQUE,
            acp_session_id TEXT,
            mode TEXT NOT NULL DEFAULT 'agent',
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            FOREIGN KEY (conversation_id) REFERENCES conversations(conversation_id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS messages (
            message_id INTEGER PRIMARY KEY,
            conversation_id INTEGER NOT NULL,
            sequence INTEGER NOT NULL,
            role TEXT NOT NULL,
            parts TEXT,
            metadata TEXT,

            -- Agent 间消息字段（role="agent" 时使用）
            from_agent_id INTEGER,        -- 发送者 agent ID (雪花ID)
            from_agent_name TEXT,         -- 发送者显示名称
            message_type TEXT,            -- "request" | "response" | "broadcast"
            content TEXT,                 -- 实际消息内容（纯文本）

            -- Turn aggregate / projection metadata
            turn_id TEXT,                 -- Stable agent execution-turn identifier
            projection_kind TEXT,         -- canonical | side_copy
            origin_message_id TEXT,       -- Canonical message for a projection

            -- Agent 输出字段（role="assistant" 时使用，统一存储 agent 的详细输出）
            thinking TEXT,                -- JSON: [{text, duration_ms}]
            tool_calls TEXT,              -- JSON: [{id, name, input, output, status}]
            text_chunks TEXT,             -- JSON: [{text, timestamp}]
            stop_reason TEXT,             -- "end_turn" | "max_tokens" | "tool_use"
            duration_ms INTEGER,          -- 总耗时（毫秒）

            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            FOREIGN KEY (conversation_id) REFERENCES conversations(conversation_id) ON DELETE CASCADE
        );
        -- Core indexes for message queries
        CREATE INDEX IF NOT EXISTS idx_messages_conversation_id ON messages(conversation_id);
        CREATE INDEX IF NOT EXISTS idx_messages_sequence ON messages(conversation_id, sequence);
        CREATE INDEX IF NOT EXISTS idx_messages_role ON messages(role);
        CREATE INDEX IF NOT EXISTS idx_messages_from_agent_id ON messages(from_agent_id);
        CREATE INDEX IF NOT EXISTS idx_messages_message_type ON messages(message_type);
        CREATE INDEX IF NOT EXISTS idx_messages_turn_id ON messages(turn_id);
        CREATE INDEX IF NOT EXISTS idx_messages_origin_message_id ON messages(origin_message_id);

        CREATE TABLE IF NOT EXISTS terminal_sessions (
            session_id INTEGER PRIMARY KEY,
            workspace_id INTEGER NOT NULL,
            user_id TEXT NOT NULL,
            profile TEXT NOT NULL,
            transport TEXT NOT NULL,
            status TEXT NOT NULL,
            cwd TEXT NOT NULL,
            pid INTEGER,
            exit_code INTEGER,
            agent_session_id INTEGER,
            last_sequence INTEGER NOT NULL DEFAULT 0,
            recoverable INTEGER NOT NULL DEFAULT 0,
            created_at_ms INTEGER NOT NULL,
            updated_at_ms INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS conversation_execution_contexts (
            conversation_id INTEGER PRIMARY KEY,
            worktree_path TEXT,
            branch TEXT,
            base_branch TEXT,
            pr_url TEXT,
            pr_number INTEGER,
            FOREIGN KEY (conversation_id) REFERENCES conversations(conversation_id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS group_agent_bindings (
            workspace_id INTEGER NOT NULL,
            chat_id INTEGER NOT NULL,
            agent_id INTEGER NOT NULL,
            agent_name TEXT NOT NULL,
            agent_command TEXT,
            conversation_id INTEGER NOT NULL,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            PRIMARY KEY (chat_id, agent_id),
            FOREIGN KEY (chat_id) REFERENCES chats(chat_id) ON DELETE CASCADE,
            FOREIGN KEY (conversation_id) REFERENCES conversations(conversation_id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_group_agent_bindings_chat_id ON group_agent_bindings(chat_id);
        CREATE INDEX IF NOT EXISTS idx_group_agent_bindings_agent_id ON group_agent_bindings(agent_id);
        CREATE INDEX IF NOT EXISTS idx_group_agent_bindings_workspace_id ON group_agent_bindings(workspace_id);

        CREATE TABLE IF NOT EXISTS collaboration_context_events (
            id INTEGER PRIMARY KEY,
            session_id INTEGER NOT NULL,
            sequence INTEGER NOT NULL,
            type TEXT NOT NULL,
            actor_type TEXT NOT NULL,
            actor_id TEXT,
            payload TEXT NOT NULL DEFAULT '{}',
            visibility TEXT NOT NULL DEFAULT 'shared',
            artifact_refs TEXT NOT NULL DEFAULT '[]',
            created_at INTEGER NOT NULL,
            FOREIGN KEY (session_id) REFERENCES collaboration_sessions(collaboration_session_id) ON DELETE CASCADE,
            UNIQUE (session_id, sequence)
        );
        CREATE INDEX IF NOT EXISTS idx_collaboration_context_events_session ON collaboration_context_events(session_id, sequence);

        CREATE TABLE IF NOT EXISTS collaboration_plan_revisions (
            id INTEGER PRIMARY KEY,
            session_id INTEGER NOT NULL,
            revision INTEGER NOT NULL,
            status TEXT NOT NULL DEFAULT 'active',
            source_event_id TEXT,
            dag_snapshot TEXT NOT NULL DEFAULT '{}',
            summary TEXT,
            created_at INTEGER NOT NULL,
            FOREIGN KEY (session_id) REFERENCES collaboration_sessions(collaboration_session_id) ON DELETE CASCADE,
            UNIQUE (session_id, revision)
        );

        CREATE TABLE IF NOT EXISTS collaboration_approvals (
            id INTEGER PRIMARY KEY,
            session_id INTEGER NOT NULL,
            plan_revision_id TEXT,
            node_id TEXT,
            kind TEXT NOT NULL,
            request TEXT NOT NULL DEFAULT '{}',
            status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled')),
            decided_by TEXT,
            decision_payload TEXT NOT NULL DEFAULT '{}',
            created_at INTEGER NOT NULL,
            decided_at INTEGER,
            FOREIGN KEY (session_id) REFERENCES collaboration_sessions(collaboration_session_id) ON DELETE CASCADE
        );
    "#,
    )?;

    migrate_message_turn_columns(conn)?;

    // MCP Servers table
    //
    // NOTE: profile_id references agent_profiles(name) in profile_registry.db (a separate database).
    // SQLite foreign keys only work within the same database, so we cannot add a FK constraint here.
    // Instead, application-level cleanup in the agent profile deletion handler ensures orphaned
    // MCP servers are removed when their profile is deleted (see agent_profiles API handler).
    //
    // SECURITY: The `env` and `headers` fields store JSON that may contain sensitive data
    // (API keys, tokens). These are stored in plaintext in SQLite. Users should be warned
    // not to store secrets in MCP server configuration, or we should add encryption at rest.
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS mcp_servers (
            id INTEGER PRIMARY KEY,
            profile_id TEXT NOT NULL DEFAULT '',
            name TEXT NOT NULL,
            server_type TEXT NOT NULL CHECK (server_type IN ('stdio', 'http', 'sse')),
            command TEXT,
            args TEXT DEFAULT '[]',
            env TEXT DEFAULT '{}',
            url TEXT,
            headers TEXT DEFAULT '{}',
            enabled INTEGER NOT NULL DEFAULT 1,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            UNIQUE(profile_id, name)
        );
        CREATE INDEX IF NOT EXISTS idx_mcp_servers_profile_id ON mcp_servers(profile_id);
        CREATE INDEX IF NOT EXISTS idx_mcp_servers_name ON mcp_servers(name);
        CREATE INDEX IF NOT EXISTS idx_mcp_servers_enabled ON mcp_servers(enabled);
        CREATE INDEX IF NOT EXISTS idx_mcp_servers_server_type ON mcp_servers(server_type);
        "#,
    )?;

    Ok(())
}

/// Add the turn model columns to databases created before the strict turn
/// model was introduced. SQLite has no `ADD COLUMN IF NOT EXISTS`.
fn migrate_message_turn_columns(conn: &Connection) -> Result<()> {
    let existing_columns: std::collections::HashSet<String> = {
        let mut stmt = conn.prepare("PRAGMA table_info(messages)")?;
        let rows = stmt.query_map([], |row| row.get::<_, String>(1))?;
        let mut columns = std::collections::HashSet::new();
        for column in rows {
            let column = column?;
            columns.insert(column);
        }
        columns
    };

    for (column, definition) in [
        ("turn_id", "TEXT"),
        ("projection_kind", "TEXT"),
        ("origin_message_id", "TEXT"),
    ] {
        if !existing_columns.contains(column) {
            conn.execute(
                &format!("ALTER TABLE messages ADD COLUMN {column} {definition}"),
                [],
            )?;
        }
    }

    conn.execute_batch(
        r#"
        CREATE INDEX IF NOT EXISTS idx_messages_turn_id ON messages(turn_id);
        CREATE INDEX IF NOT EXISTS idx_messages_origin_message_id ON messages(origin_message_id);
        "#,
    )?;
    Ok(())
}

/// Get the global database connection
pub fn get_user_data_db() -> Arc<Mutex<Connection>> {
    Arc::clone(&USER_DATA_DB)
}

// ── Data Models ──────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct Workspace {
    pub workspace_id: WorkspaceId,
    pub name: String,
    pub work_dir: String,
    pub env: String,
    pub resources: String,
    pub config: String,
    pub collaboration_mode: String,
    pub status: String,
    pub default_project_id: Option<ProjectId>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct Chat {
    pub chat_id: ChatId,
    pub workspace_id: WorkspaceId,
    pub name: Option<String>,
    pub collaboration_mode: Option<String>,
    pub worktree_path: Option<String>,
    pub branch: Option<String>,
    pub base_branch: Option<String>,
    pub pr_url: Option<String>,
    pub pr_number: Option<i32>,
    pub created_at: i64,
    pub updated_at: i64,
    pub archived_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct Project {
    pub project_id: i64,
    pub workspace_id: i64,
    pub name: String,
    pub path: String,
    pub description: Option<String>,
    pub git_remote_url: Option<String>,
    pub git_provider: Option<String>,
    pub git_owner: Option<String>,
    pub git_repo: Option<String>,
    pub icon_path: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct CollaborationSession {
    pub collaboration_session_id: CollaborationSessionId,
    pub chat_id: ChatId,
    pub workspace_id: WorkspaceId,
    pub mode: String,
    pub state: String,
    pub goal: Option<String>,
    pub active_plan_revision: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct Conversation {
    pub conversation_id: ConversationId,
    pub collaboration_session_id: CollaborationSessionId,
    pub chat_id: ChatId,
    pub parent_id: Option<ConversationId>,
    pub name: Option<String>,
    pub mode: String,
    pub participant_role: String,
    pub status: String,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct AgentSession {
    pub agent_session_id: i64,
    pub conversation_id: i64,
    pub acp_session_id: Option<String>,
    pub mode: String,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct Message {
    pub message_id: MessageId,
    pub conversation_id: ConversationId,
    pub sequence: i64,
    pub role: String,
    pub parts: Option<String>,
    pub metadata: Option<String>,

    // Agent 间消息字段（role="agent" 时使用）
    pub from_agent_id: Option<i64>,      // 发送者 agent ID (雪花ID)
    pub from_agent_name: Option<String>, // 发送者显示名称
    pub message_type: Option<String>,    // "request" | "response" | "broadcast"
    pub content: Option<String>,         // 实际消息内容（纯文本）

    // Turn aggregate / projection metadata
    pub turn_id: Option<String>, // Stable agent execution-turn identifier
    pub projection_kind: Option<String>, // canonical | side_copy
    pub origin_message_id: Option<String>,

    // Agent 输出字段（role="assistant" 时使用）
    pub thinking: Option<String>,    // JSON: [{text, duration_ms}]
    pub tool_calls: Option<String>,  // JSON: [{id, name, input, output, status}]
    pub text_chunks: Option<String>, // JSON: [{text, timestamp}]
    pub stop_reason: Option<String>, // "end_turn" | "max_tokens" | "tool_use"
    pub duration_ms: Option<i64>,    // 总耗时（毫秒）

    pub created_at: i64,
    pub updated_at: i64,
}

/// Helper function to map a database row to a Message struct.
/// Used across multiple query functions to avoid code duplication.
pub fn map_row_to_message(row: &rusqlite::Row) -> rusqlite::Result<Message> {
    Ok(Message {
        message_id: row.get(0)?,
        conversation_id: row.get(1)?,
        sequence: row.get(2)?,
        role: row.get(3)?,
        parts: row.get(4)?,
        metadata: row.get(5)?,
        from_agent_id: row.get(6)?,
        from_agent_name: row.get(7)?,
        message_type: row.get(8)?,
        content: row.get(9)?,
        turn_id: row.get(10)?,
        projection_kind: row.get(11)?,
        origin_message_id: row.get(12)?,
        thinking: row.get(13)?,
        tool_calls: row.get(14)?,
        text_chunks: row.get(15)?,
        stop_reason: row.get(16)?,
        duration_ms: row.get(17)?,
        created_at: row.get(18)?,
        updated_at: row.get(19)?,
    })
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct ConversationExecutionContext {
    pub conversation_id: ConversationId,
    pub worktree_path: Option<String>,
    pub branch: Option<String>,
    pub base_branch: Option<String>,
    pub pr_url: Option<String>,
    pub pr_number: Option<i32>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct GroupAgentBinding {
    pub workspace_id: WorkspaceId,
    pub chat_id: ChatId,
    pub agent_id: i64,
    pub agent_name: String,
    pub agent_command: Option<String>,
    pub conversation_id: ConversationId,
    pub created_at: i64,
    pub updated_at: i64,
}

/// MCP Server configuration
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct McpServer {
    pub id: i64,
    /// Agent profile ID (from profile_registry.db). None = global MCP server.
    pub profile_id: Option<String>,
    pub name: String,
    pub server_type: String, // "stdio", "http", "sse"
    pub command: Option<String>,
    pub args: Vec<String>,
    pub env: HashMap<String, String>,
    pub url: Option<String>,
    pub headers: HashMap<String, String>,
    pub enabled: bool,
    pub created_at: i64,
    pub updated_at: i64,
}

// ── CRUD Operations ──────────────────────────────────────────────────────────

pub mod workspaces {
    use super::*;

    pub fn create(workspace: Workspace) -> Result<Workspace> {
        let db = get_user_data_db();
        let conn = db.lock().unwrap();

        conn.execute(
            "INSERT INTO workspaces (workspace_id, name, work_dir, env, resources, config, collaboration_mode, status, default_project_id, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
            params![
                workspace.workspace_id,
                workspace.name,
                workspace.work_dir,
                workspace.env,
                workspace.resources,
                workspace.config,
                workspace.collaboration_mode,
                workspace.status,
                workspace.default_project_id,
                workspace.created_at,
                workspace.updated_at,
            ],
        )?;

        Ok(workspace)
    }

    pub fn list(collaboration_mode: Option<&str>) -> Result<Vec<Workspace>> {
        let db = get_user_data_db();
        let conn = db.lock().unwrap();

        let mut stmt = conn.prepare(
            "SELECT workspace_id, name, work_dir, env, resources, config, collaboration_mode, status, default_project_id, created_at, updated_at
             FROM workspaces
             WHERE ?1 IS NULL OR collaboration_mode = ?1
             ORDER BY created_at DESC",
        )?;
        let workspaces = stmt.query_map(params![collaboration_mode], |row| {
            Ok(Workspace {
                workspace_id: row.get(0)?,
                name: row.get(1)?,
                work_dir: row.get(2)?,
                env: row.get(3)?,
                resources: row.get(4)?,
                config: row.get(5)?,
                collaboration_mode: row.get(6)?,
                status: row.get(7)?,
                default_project_id: row.get(8)?,
                created_at: row.get(9)?,
                updated_at: row.get(10)?,
            })
        })?;
        workspaces.collect()
    }

    pub fn get(workspace_id: WorkspaceId) -> Result<Option<Workspace>> {
        let db = get_user_data_db();
        let conn = db.lock().unwrap();

        let mut stmt = conn.prepare(
            "SELECT workspace_id, name, work_dir, env, resources, config, collaboration_mode, status, default_project_id, created_at, updated_at
             FROM workspaces WHERE workspace_id = ?1"
        )?;

        let mut rows = stmt.query_map(params![workspace_id], |row| {
            Ok(Workspace {
                workspace_id: row.get(0)?,
                name: row.get(1)?,
                work_dir: row.get(2)?,
                env: row.get(3)?,
                resources: row.get(4)?,
                config: row.get(5)?,
                collaboration_mode: row.get(6)?,
                status: row.get(7)?,
                default_project_id: row.get(8)?,
                created_at: row.get(9)?,
                updated_at: row.get(10)?,
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
             SET name = ?1, work_dir = ?2, env = ?3, resources = ?4, config = ?5,
                 collaboration_mode = ?6, status = ?7, default_project_id = ?8, updated_at = ?9
             WHERE workspace_id = ?10",
            params![
                workspace.name,
                workspace.work_dir,
                workspace.env,
                workspace.resources,
                workspace.config,
                workspace.collaboration_mode,
                workspace.status,
                workspace.default_project_id,
                workspace.updated_at,
                workspace.workspace_id,
            ],
        )?;

        Ok(())
    }

    pub fn delete(workspace_id: WorkspaceId) -> Result<bool> {
        let db = get_user_data_db();
        let conn = db.lock().unwrap();
        let count = conn.execute(
            "DELETE FROM workspaces WHERE workspace_id = ?1",
            params![workspace_id],
        )?;
        Ok(count > 0)
    }

    pub fn set_status(workspace_id: WorkspaceId, status: &str) -> Result<bool> {
        let db = get_user_data_db();
        let conn = db.lock().unwrap();
        let count = conn.execute(
            "UPDATE workspaces SET status = ?2, updated_at = strftime('%s', 'now') WHERE workspace_id = ?1",
            params![workspace_id, status],
        )?;
        Ok(count > 0)
    }
}

pub mod projects {
    use super::*;

    pub fn create(project: Project) -> Result<Project> {
        let db = get_user_data_db();
        let conn = db.lock().unwrap();

        conn.execute(
            "INSERT INTO projects (project_id, workspace_id, name, path, description, git_remote_url, git_provider, git_owner, git_repo, icon_path, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
            params![
                project.project_id,
                project.workspace_id,
                project.name,
                project.path,
                project.description,
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

    pub fn list(workspace_id: i64) -> Result<Vec<Project>> {
        let db = get_user_data_db();
        let conn = db.lock().unwrap();

        let mut stmt = conn.prepare(
            "SELECT project_id, workspace_id, name, path, description, git_remote_url, git_provider, git_owner, git_repo, icon_path, created_at, updated_at
             FROM projects
             WHERE workspace_id = ?1
             ORDER BY created_at DESC",
        )?;
        let projects = stmt.query_map(params![workspace_id], |row| {
            Ok(Project {
                project_id: row.get(0)?,
                workspace_id: row.get(1)?,
                name: row.get(2)?,
                path: row.get(3)?,
                description: row.get(4)?,
                git_remote_url: row.get(5)?,
                git_provider: row.get(6)?,
                git_owner: row.get(7)?,
                git_repo: row.get(8)?,
                icon_path: row.get(9)?,
                created_at: row.get(10)?,
                updated_at: row.get(11)?,
            })
        })?;
        projects.collect()
    }

    pub fn get(project_id: i64) -> Result<Option<Project>> {
        let db = get_user_data_db();
        let conn = db.lock().unwrap();

        let mut stmt = conn.prepare(
            "SELECT project_id, workspace_id, name, path, description, git_remote_url, git_provider, git_owner, git_repo, icon_path, created_at, updated_at
             FROM projects WHERE project_id = ?1"
        )?;

        let mut rows = stmt.query_map(params![project_id], |row| {
            Ok(Project {
                project_id: row.get(0)?,
                workspace_id: row.get(1)?,
                name: row.get(2)?,
                path: row.get(3)?,
                description: row.get(4)?,
                git_remote_url: row.get(5)?,
                git_provider: row.get(6)?,
                git_owner: row.get(7)?,
                git_repo: row.get(8)?,
                icon_path: row.get(9)?,
                created_at: row.get(10)?,
                updated_at: row.get(11)?,
            })
        })?;

        match rows.next() {
            Some(Ok(project)) => Ok(Some(project)),
            Some(Err(e)) => Err(e),
            None => Ok(None),
        }
    }

    pub fn exists_and_belongs_to(project_id: i64, workspace_id: i64) -> Result<bool> {
        let db = get_user_data_db();
        let conn = db.lock().unwrap();

        let count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM projects WHERE project_id = ?1 AND workspace_id = ?2",
            params![project_id, workspace_id],
            |row| row.get(0),
        )?;

        Ok(count > 0)
    }

    pub fn exists(project_id: i64) -> Result<bool> {
        let db = get_user_data_db();
        let conn = db.lock().unwrap();

        let count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM projects WHERE project_id = ?1",
            params![project_id],
            |row| row.get(0),
        )?;

        Ok(count > 0)
    }

    pub fn update(project: Project) -> Result<()> {
        let db = get_user_data_db();
        let conn = db.lock().unwrap();

        conn.execute(
            "UPDATE projects
             SET name = ?1, path = ?2, description = ?3, git_remote_url = ?4,
                 git_provider = ?5, git_owner = ?6, git_repo = ?7, icon_path = ?8,
                 updated_at = ?9
             WHERE project_id = ?10",
            params![
                project.name,
                project.path,
                project.description,
                project.git_remote_url,
                project.git_provider,
                project.git_owner,
                project.git_repo,
                project.icon_path,
                project.updated_at,
                project.project_id,
            ],
        )?;

        Ok(())
    }

    pub fn delete(project_id: i64) -> Result<bool> {
        let db = get_user_data_db();
        let conn = db.lock().unwrap();
        let count = conn.execute(
            "DELETE FROM projects WHERE project_id = ?1",
            params![project_id],
        )?;
        Ok(count > 0)
    }

    pub fn delete_by_workspace(workspace_id: i64) -> Result<u64> {
        let db = get_user_data_db();
        let conn = db.lock().unwrap();
        let count = conn.execute(
            "DELETE FROM projects WHERE workspace_id = ?1",
            params![workspace_id],
        )?;
        Ok(count as u64)
    }

    pub fn find_by_path(path: &str) -> Result<Option<Project>> {
        let db = get_user_data_db();
        let conn = db.lock().unwrap();

        let mut stmt = conn.prepare(
            "SELECT project_id, workspace_id, name, path, description, git_remote_url, git_provider, git_owner, git_repo, icon_path, created_at, updated_at
             FROM projects WHERE path = ?1 LIMIT 1",
        )?;

        let mut rows = stmt.query_map(params![path], |row| {
            Ok(Project {
                project_id: row.get(0)?,
                workspace_id: row.get(1)?,
                name: row.get(2)?,
                path: row.get(3)?,
                description: row.get(4)?,
                git_remote_url: row.get(5)?,
                git_provider: row.get(6)?,
                git_owner: row.get(7)?,
                git_repo: row.get(8)?,
                icon_path: row.get(9)?,
                created_at: row.get(10)?,
                updated_at: row.get(11)?,
            })
        })?;

        match rows.next() {
            Some(Ok(project)) => Ok(Some(project)),
            Some(Err(e)) => Err(e),
            None => Ok(None),
        }
    }

    /// Find a project by exact path match, or by prefix match (input path is a subdirectory of a project path).
    /// Returns the most specific (longest) matching project path.
    /// Example: input "/project/.ergatai/worktrees/ws/branch" matches project path "/project".
    ///
    /// Uses `substr` instead of `LIKE` to avoid SQL injection via LIKE wildcards (`%`, `_`)
    /// in stored path values, and to enable more efficient index usage.
    pub fn find_by_path_or_parent(path: &str) -> Result<Option<Project>> {
        let db = get_user_data_db();
        let conn = db.lock().unwrap();

        let mut stmt = conn.prepare(
            "SELECT project_id, workspace_id, name, path, description, git_remote_url, git_provider, git_owner, git_repo, icon_path, created_at, updated_at
             FROM projects
             WHERE path = ?1
                OR (length(?1) > length(path) AND substr(?1, 1, length(path) + 1) = path || '/')
             ORDER BY LENGTH(path) DESC
             LIMIT 1",
        )?;

        let mut rows = stmt.query_map(params![path], |row| {
            Ok(Project {
                project_id: row.get(0)?,
                workspace_id: row.get(1)?,
                name: row.get(2)?,
                path: row.get(3)?,
                description: row.get(4)?,
                git_remote_url: row.get(5)?,
                git_provider: row.get(6)?,
                git_owner: row.get(7)?,
                git_repo: row.get(8)?,
                icon_path: row.get(9)?,
                created_at: row.get(10)?,
                updated_at: row.get(11)?,
            })
        })?;

        match rows.next() {
            Some(Ok(project)) => Ok(Some(project)),
            Some(Err(e)) => Err(e),
            None => Ok(None),
        }
    }
}

pub mod chats {
    use super::*;

    pub fn create(chat: Chat) -> Result<Chat> {
        let db = get_user_data_db();
        let conn = db.lock().unwrap();

        conn.execute(
            "INSERT INTO chats (chat_id, workspace_id, name, collaboration_mode, worktree_path, branch, base_branch, pr_url, pr_number, created_at, updated_at, archived_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
            params![
                chat.chat_id,
                chat.workspace_id,
                chat.name,
                chat.collaboration_mode,
                chat.worktree_path,
                chat.branch,
                chat.base_branch,
                chat.pr_url,
                chat.pr_number,
                chat.created_at,
                chat.updated_at,
                chat.archived_at,
            ],
        )?;

        Ok(chat)
    }

    pub fn list(workspace_id: Option<WorkspaceId>) -> Result<Vec<Chat>> {
        let db = get_user_data_db();
        let conn = db.lock().unwrap();

        let mut stmt = conn.prepare(
            "SELECT chat_id, workspace_id, name, collaboration_mode, worktree_path, branch, base_branch, pr_url, pr_number, created_at, updated_at, archived_at
             FROM chats
             WHERE ?1 IS NULL OR workspace_id = ?1
             ORDER BY created_at DESC",
        )?;
        let chats = stmt.query_map(params![workspace_id], |row| {
            Ok(Chat {
                chat_id: row.get(0)?,
                workspace_id: row.get(1)?,
                name: row.get(2)?,
                collaboration_mode: row.get(3)?,
                worktree_path: row.get(4)?,
                branch: row.get(5)?,
                base_branch: row.get(6)?,
                pr_url: row.get(7)?,
                pr_number: row.get(8)?,
                created_at: row.get(9)?,
                updated_at: row.get(10)?,
                archived_at: row.get(11)?,
            })
        })?;
        chats.collect()
    }

    pub fn get(chat_id: ChatId) -> Result<Option<Chat>> {
        let db = get_user_data_db();
        let conn = db.lock().unwrap();

        let mut stmt = conn.prepare(
            "SELECT chat_id, workspace_id, name, collaboration_mode, worktree_path, branch, base_branch, pr_url, pr_number, created_at, updated_at, archived_at
             FROM chats WHERE chat_id = ?1",
        )?;

        let mut rows = stmt.query_map(params![chat_id], |row| {
            Ok(Chat {
                chat_id: row.get(0)?,
                workspace_id: row.get(1)?,
                name: row.get(2)?,
                collaboration_mode: row.get(3)?,
                worktree_path: row.get(4)?,
                branch: row.get(5)?,
                base_branch: row.get(6)?,
                pr_url: row.get(7)?,
                pr_number: row.get(8)?,
                created_at: row.get(9)?,
                updated_at: row.get(10)?,
                archived_at: row.get(11)?,
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
             SET workspace_id = ?1, name = ?2, collaboration_mode = ?3, worktree_path = ?4, branch = ?5, base_branch = ?6, pr_url = ?7, pr_number = ?8, updated_at = ?9, archived_at = ?10
             WHERE chat_id = ?11",
            params![
                chat.workspace_id,
                chat.name,
                chat.collaboration_mode,
                chat.worktree_path,
                chat.branch,
                chat.base_branch,
                chat.pr_url,
                chat.pr_number,
                chat.updated_at,
                chat.archived_at,
                chat.chat_id,
            ],
        )?;

        Ok(())
    }

    pub fn delete(chat_id: ChatId) -> Result<()> {
        let db = get_user_data_db();
        let conn = db.lock().unwrap();
        conn.execute("DELETE FROM chats WHERE chat_id = ?1", params![chat_id])?;
        Ok(())
    }

    pub fn archive(chat_id: ChatId) -> Result<()> {
        let db = get_user_data_db();
        let conn = db.lock().unwrap();
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs() as i64;
        conn.execute(
            "UPDATE chats SET archived_at = ?1, updated_at = ?1 WHERE chat_id = ?2",
            params![now, chat_id],
        )?;
        Ok(())
    }

    pub fn unarchive(chat_id: ChatId) -> Result<()> {
        let db = get_user_data_db();
        let conn = db.lock().unwrap();
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs() as i64;
        conn.execute(
            "UPDATE chats SET archived_at = NULL, updated_at = ?1 WHERE chat_id = ?2",
            params![now, chat_id],
        )?;
        Ok(())
    }

    pub fn find_by_worktree_path(path: &str) -> Result<Option<Chat>> {
        let db = get_user_data_db();
        let conn = db.lock().unwrap();

        let mut stmt = conn.prepare(
            "SELECT chat_id, workspace_id, name, collaboration_mode, worktree_path, branch, base_branch, pr_url, pr_number, created_at, updated_at, archived_at
             FROM chats WHERE worktree_path = ?1 LIMIT 1",
        )?;

        let mut rows = stmt.query_map(params![path], |row| {
            Ok(Chat {
                chat_id: row.get(0)?,
                workspace_id: row.get(1)?,
                name: row.get(2)?,
                collaboration_mode: row.get(3)?,
                worktree_path: row.get(4)?,
                branch: row.get(5)?,
                base_branch: row.get(6)?,
                pr_url: row.get(7)?,
                pr_number: row.get(8)?,
                created_at: row.get(9)?,
                updated_at: row.get(10)?,
                archived_at: row.get(11)?,
            })
        })?;

        match rows.next() {
            Some(Ok(chat)) => Ok(Some(chat)),
            Some(Err(e)) => Err(e),
            None => Ok(None),
        }
    }

    /// Find a chat by exact worktree_path match, or by prefix match (input path is a subdirectory of a chat's worktree_path).
    /// Returns the most specific (longest) matching worktree_path.
    ///
    /// Uses `substr` instead of `LIKE` to avoid SQL injection via LIKE wildcards (`%`, `_`)
    /// in stored worktree_path values, and to enable more efficient index usage.
    pub fn find_by_worktree_path_or_parent(path: &str) -> Result<Option<Chat>> {
        let db = get_user_data_db();
        let conn = db.lock().unwrap();

        let mut stmt = conn.prepare(
            "SELECT chat_id, workspace_id, name, collaboration_mode, worktree_path, branch, base_branch, pr_url, pr_number, created_at, updated_at, archived_at
             FROM chats
             WHERE worktree_path = ?1
                OR (length(?1) > length(worktree_path) AND substr(?1, 1, length(worktree_path) + 1) = worktree_path || '/')
             ORDER BY LENGTH(worktree_path) DESC
             LIMIT 1",
        )?;

        let mut rows = stmt.query_map(params![path], |row| {
            Ok(Chat {
                chat_id: row.get(0)?,
                workspace_id: row.get(1)?,
                name: row.get(2)?,
                collaboration_mode: row.get(3)?,
                worktree_path: row.get(4)?,
                branch: row.get(5)?,
                base_branch: row.get(6)?,
                pr_url: row.get(7)?,
                pr_number: row.get(8)?,
                created_at: row.get(9)?,
                updated_at: row.get(10)?,
                archived_at: row.get(11)?,
            })
        })?;

        match rows.next() {
            Some(Ok(chat)) => Ok(Some(chat)),
            Some(Err(e)) => Err(e),
            None => Ok(None),
        }
    }
}

pub mod collaboration_sessions {
    use super::*;

    pub fn create(session: CollaborationSession) -> Result<CollaborationSession> {
        let db = get_user_data_db();
        let conn = db.lock().unwrap();

        conn.execute(
            "INSERT INTO collaboration_sessions (collaboration_session_id, chat_id, workspace_id, mode, state, goal, active_plan_revision, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                session.collaboration_session_id,
                session.chat_id,
                session.workspace_id,
                session.mode,
                session.state,
                session.goal,
                session.active_plan_revision,
                session.created_at,
                session.updated_at,
            ],
        )?;

        Ok(session)
    }

    pub fn list(chat_id: Option<ChatId>) -> Result<Vec<CollaborationSession>> {
        let db = get_user_data_db();
        let conn = db.lock().unwrap();

        let mut stmt = conn.prepare(
            "SELECT collaboration_session_id, chat_id, workspace_id, mode, state, goal, active_plan_revision, created_at, updated_at
             FROM collaboration_sessions
             WHERE ?1 IS NULL OR chat_id = ?1
             ORDER BY created_at DESC",
        )?;
        let sessions = stmt.query_map(params![chat_id], |row| {
            Ok(CollaborationSession {
                collaboration_session_id: row.get(0)?,
                chat_id: row.get(1)?,
                workspace_id: row.get(2)?,
                mode: row.get(3)?,
                state: row.get(4)?,
                goal: row.get(5)?,
                active_plan_revision: row.get(6)?,
                created_at: row.get(7)?,
                updated_at: row.get(8)?,
            })
        })?;
        sessions.collect()
    }

    pub fn get(
        collaboration_session_id: CollaborationSessionId,
    ) -> Result<Option<CollaborationSession>> {
        let db = get_user_data_db();
        let conn = db.lock().unwrap();

        let mut stmt = conn.prepare(
            "SELECT collaboration_session_id, chat_id, workspace_id, mode, state, goal, active_plan_revision, created_at, updated_at
             FROM collaboration_sessions WHERE collaboration_session_id = ?1"
        )?;

        let mut rows = stmt.query_map(params![collaboration_session_id], |row| {
            Ok(CollaborationSession {
                collaboration_session_id: row.get(0)?,
                chat_id: row.get(1)?,
                workspace_id: row.get(2)?,
                mode: row.get(3)?,
                state: row.get(4)?,
                goal: row.get(5)?,
                active_plan_revision: row.get(6)?,
                created_at: row.get(7)?,
                updated_at: row.get(8)?,
            })
        })?;

        match rows.next() {
            Some(Ok(session)) => Ok(Some(session)),
            Some(Err(e)) => Err(e),
            None => Ok(None),
        }
    }

    pub fn update(session: CollaborationSession) -> Result<()> {
        let db = get_user_data_db();
        let conn = db.lock().unwrap();

        conn.execute(
            "UPDATE collaboration_sessions
             SET chat_id = ?1, workspace_id = ?2, mode = ?3, state = ?4, goal = ?5,
                 active_plan_revision = ?6, updated_at = ?7
             WHERE collaboration_session_id = ?8",
            params![
                session.chat_id,
                session.workspace_id,
                session.mode,
                session.state,
                session.goal,
                session.active_plan_revision,
                session.updated_at,
                session.collaboration_session_id,
            ],
        )?;

        Ok(())
    }

    pub fn delete(collaboration_session_id: CollaborationSessionId) -> Result<()> {
        let db = get_user_data_db();
        let conn = db.lock().unwrap();
        conn.execute(
            "DELETE FROM collaboration_sessions WHERE collaboration_session_id = ?1",
            params![collaboration_session_id],
        )?;
        Ok(())
    }

    pub fn update_state(
        collaboration_session_id: CollaborationSessionId,
        state: &str,
    ) -> Result<()> {
        let db = get_user_data_db();
        let conn = db.lock().unwrap();
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs() as i64;
        conn.execute(
            "UPDATE collaboration_sessions SET state = ?2, updated_at = ?3 WHERE collaboration_session_id = ?1",
            params![collaboration_session_id, state, now],
        )?;
        Ok(())
    }
}

pub mod conversations {
    use super::*;

    pub fn create(conversation: Conversation) -> Result<Conversation> {
        let db = get_user_data_db();
        let conn = db.lock().unwrap();

        conn.execute(
            "INSERT INTO conversations (conversation_id, collaboration_session_id, chat_id, parent_id, name, mode, participant_role, status, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            params![
                conversation.conversation_id,
                conversation.collaboration_session_id,
                conversation.chat_id,
                conversation.parent_id,
                conversation.name,
                conversation.mode,
                conversation.participant_role,
                conversation.status,
                conversation.created_at,
                conversation.updated_at,
            ],
        )?;

        Ok(conversation)
    }

    pub fn list_by_collaboration_session(
        collaboration_session_id: CollaborationSessionId,
    ) -> Result<Vec<Conversation>> {
        let db = get_user_data_db();
        let conn = db.lock().unwrap();

        let mut stmt = conn.prepare(
            "SELECT conversation_id, collaboration_session_id, chat_id, parent_id, name, mode, participant_role, status, created_at, updated_at
             FROM conversations WHERE collaboration_session_id = ?1 ORDER BY created_at ASC"
        )?;
        let conversations = stmt.query_map(params![collaboration_session_id], |row| {
            Ok(Conversation {
                conversation_id: row.get(0)?,
                collaboration_session_id: row.get(1)?,
                chat_id: row.get(2)?,
                parent_id: row.get(3)?,
                name: row.get(4)?,
                mode: row.get(5)?,
                participant_role: row.get(6)?,
                status: row.get(7)?,
                created_at: row.get(8)?,
                updated_at: row.get(9)?,
            })
        })?;
        conversations.collect()
    }

    pub fn list_by_chat(chat_id: ChatId) -> Result<Vec<Conversation>> {
        let db = get_user_data_db();
        let conn = db.lock().unwrap();

        let mut stmt = conn.prepare(
            "SELECT conversation_id, collaboration_session_id, chat_id, parent_id, name, mode, participant_role, status, created_at, updated_at
             FROM conversations WHERE chat_id = ?1 ORDER BY created_at ASC"
        )?;
        let conversations = stmt.query_map(params![chat_id], |row| {
            Ok(Conversation {
                conversation_id: row.get(0)?,
                collaboration_session_id: row.get(1)?,
                chat_id: row.get(2)?,
                parent_id: row.get(3)?,
                name: row.get(4)?,
                mode: row.get(5)?,
                participant_role: row.get(6)?,
                status: row.get(7)?,
                created_at: row.get(8)?,
                updated_at: row.get(9)?,
            })
        })?;
        conversations.collect()
    }

    pub fn list_children(parent_id: ConversationId) -> Result<Vec<Conversation>> {
        let db = get_user_data_db();
        let conn = db.lock().unwrap();

        let mut stmt = conn.prepare(
            "SELECT conversation_id, collaboration_session_id, chat_id, parent_id, name, mode, participant_role, status, created_at, updated_at
             FROM conversations WHERE parent_id = ?1 ORDER BY created_at ASC"
        )?;
        let conversations = stmt.query_map(params![parent_id], |row| {
            Ok(Conversation {
                conversation_id: row.get(0)?,
                collaboration_session_id: row.get(1)?,
                chat_id: row.get(2)?,
                parent_id: row.get(3)?,
                name: row.get(4)?,
                mode: row.get(5)?,
                participant_role: row.get(6)?,
                status: row.get(7)?,
                created_at: row.get(8)?,
                updated_at: row.get(9)?,
            })
        })?;
        conversations.collect()
    }

    pub fn list_roots(
        _agent_id: Option<&str>,
        workspace_id: Option<WorkspaceId>,
    ) -> Result<Vec<Conversation>> {
        let db = get_user_data_db();
        let conn = db.lock().unwrap();

        let conversations = if let Some(workspace_id) = workspace_id {
            // List root conversations for a workspace (through chat relationship)
            let mut stmt = conn.prepare(
                "SELECT c.conversation_id, c.collaboration_session_id, c.chat_id, c.parent_id, c.name, c.mode, c.participant_role, c.status, c.created_at, c.updated_at
                 FROM conversations c
                 JOIN chats ch ON c.chat_id = ch.chat_id
                 WHERE c.parent_id IS NULL AND ch.workspace_id = ?1
                 ORDER BY c.created_at ASC"
            )?;
            let mut result = Vec::new();
            let rows = stmt.query_map(params![workspace_id], |row| {
                Ok(Conversation {
                    conversation_id: row.get(0)?,
                    collaboration_session_id: row.get(1)?,
                    chat_id: row.get(2)?,
                    parent_id: row.get(3)?,
                    name: row.get(4)?,
                    mode: row.get(5)?,
                    participant_role: row.get(6)?,
                    status: row.get(7)?,
                    created_at: row.get(8)?,
                    updated_at: row.get(9)?,
                })
            })?;
            for row in rows {
                result.push(row?);
            }
            result
        } else {
            // List all root conversations
            let mut stmt = conn.prepare(
                "SELECT conversation_id, collaboration_session_id, chat_id, parent_id, name, mode, participant_role, status, created_at, updated_at
                 FROM conversations WHERE parent_id IS NULL ORDER BY created_at ASC"
            )?;
            let mut result = Vec::new();
            let rows = stmt.query_map([], |row| {
                Ok(Conversation {
                    conversation_id: row.get(0)?,
                    collaboration_session_id: row.get(1)?,
                    chat_id: row.get(2)?,
                    parent_id: row.get(3)?,
                    name: row.get(4)?,
                    mode: row.get(5)?,
                    participant_role: row.get(6)?,
                    status: row.get(7)?,
                    created_at: row.get(8)?,
                    updated_at: row.get(9)?,
                })
            })?;
            for row in rows {
                result.push(row?);
            }
            result
        };

        Ok(conversations)
    }

    pub fn get(conversation_id: ConversationId) -> Result<Option<Conversation>> {
        let db = get_user_data_db();
        let conn = db.lock().unwrap();

        let mut stmt = conn.prepare(
            "SELECT conversation_id, collaboration_session_id, chat_id, parent_id, name, mode, participant_role, status, created_at, updated_at
             FROM conversations WHERE conversation_id = ?1"
        )?;

        let mut rows = stmt.query_map(params![conversation_id], |row| {
            Ok(Conversation {
                conversation_id: row.get(0)?,
                collaboration_session_id: row.get(1)?,
                chat_id: row.get(2)?,
                parent_id: row.get(3)?,
                name: row.get(4)?,
                mode: row.get(5)?,
                participant_role: row.get(6)?,
                status: row.get(7)?,
                created_at: row.get(8)?,
                updated_at: row.get(9)?,
            })
        })?;

        match rows.next() {
            Some(Ok(conversation)) => Ok(Some(conversation)),
            Some(Err(e)) => Err(e),
            None => Ok(None),
        }
    }

    pub fn update(conversation: Conversation) -> Result<()> {
        let db = get_user_data_db();
        let conn = db.lock().unwrap();

        conn.execute(
            "UPDATE conversations
             SET collaboration_session_id = ?1, chat_id = ?2, parent_id = ?3, name = ?4,
                 mode = ?5, participant_role = ?6, status = ?7, updated_at = ?8
             WHERE conversation_id = ?9",
            params![
                conversation.collaboration_session_id,
                conversation.chat_id,
                conversation.parent_id,
                conversation.name,
                conversation.mode,
                conversation.participant_role,
                conversation.status,
                conversation.updated_at,
                conversation.conversation_id,
            ],
        )?;

        Ok(())
    }

    pub fn delete(conversation_id: ConversationId) -> Result<()> {
        let db = get_user_data_db();
        let conn = db.lock().unwrap();
        conn.execute(
            "DELETE FROM conversations WHERE conversation_id = ?1",
            params![conversation_id],
        )?;
        Ok(())
    }

    pub fn archive(conversation_id: ConversationId, updated_at: i64) -> Result<()> {
        let db = get_user_data_db();
        let conn = db.lock().unwrap();
        conn.execute(
            "UPDATE conversations SET status = 'archived', updated_at = ?1 WHERE conversation_id = ?2",
            params![updated_at, conversation_id],
        )?;
        Ok(())
    }

    pub fn unarchive(conversation_id: ConversationId, updated_at: i64) -> Result<()> {
        let db = get_user_data_db();
        let conn = db.lock().unwrap();
        conn.execute(
            "UPDATE conversations SET status = 'ready', updated_at = ?1 WHERE conversation_id = ?2",
            params![updated_at, conversation_id],
        )?;
        Ok(())
    }

    pub fn resolve_workspace_id(conversation_id: ConversationId) -> Result<Option<WorkspaceId>> {
        let db = get_user_data_db();
        let conn = db.lock().unwrap();

        conn.query_row(
            "SELECT workspace_id FROM chats WHERE chat_id = (
                SELECT chat_id FROM conversations WHERE conversation_id = ?1
            )",
            params![conversation_id],
            |row| row.get(0),
        )
        .optional()
    }
}

pub mod agent_sessions {
    use super::*;

    pub fn upsert(session: AgentSession) -> Result<AgentSession> {
        let db = get_user_data_db();
        let conn = db.lock().unwrap();

        conn.execute(
            "INSERT INTO agent_sessions (agent_session_id, conversation_id, acp_session_id, mode, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT(conversation_id) DO UPDATE SET
               acp_session_id = excluded.acp_session_id,
               mode = excluded.mode,
               updated_at = excluded.updated_at",
            params![
                session.agent_session_id,
                session.conversation_id,
                session.acp_session_id,
                session.mode,
                session.created_at,
                session.updated_at,
            ],
        )?;

        Ok(session)
    }

    pub fn get_by_conversation_id(conversation_id: i64) -> Result<Option<AgentSession>> {
        let db = get_user_data_db();
        let conn = db.lock().unwrap();

        let mut stmt = conn.prepare(
            "SELECT agent_session_id, conversation_id, acp_session_id, mode, created_at, updated_at
             FROM agent_sessions WHERE conversation_id = ?1",
        )?;

        let mut rows = stmt.query_map(params![conversation_id], |row| {
            Ok(AgentSession {
                agent_session_id: row.get(0)?,
                conversation_id: row.get(1)?,
                acp_session_id: row.get(2)?,
                mode: row.get(3)?,
                created_at: row.get(4)?,
                updated_at: row.get(5)?,
            })
        })?;

        match rows.next() {
            Some(Ok(session)) => Ok(Some(session)),
            Some(Err(e)) => Err(e),
            None => Ok(None),
        }
    }

    pub fn get_by_agent_session_id(agent_session_id: i64) -> Result<Option<AgentSession>> {
        let db = get_user_data_db();
        let conn = db.lock().unwrap();

        let mut stmt = conn.prepare(
            "SELECT agent_session_id, conversation_id, acp_session_id, mode, created_at, updated_at
             FROM agent_sessions WHERE agent_session_id = ?1",
        )?;

        let mut rows = stmt.query_map(params![agent_session_id], |row| {
            Ok(AgentSession {
                agent_session_id: row.get(0)?,
                conversation_id: row.get(1)?,
                acp_session_id: row.get(2)?,
                mode: row.get(3)?,
                created_at: row.get(4)?,
                updated_at: row.get(5)?,
            })
        })?;

        match rows.next() {
            Some(Ok(session)) => Ok(Some(session)),
            Some(Err(e)) => Err(e),
            None => Ok(None),
        }
    }

    pub fn get(conversation_id: i64) -> Result<Option<AgentSession>> {
        get_by_conversation_id(conversation_id)
    }

    pub fn delete(conversation_id: i64) -> Result<bool> {
        let db = get_user_data_db();
        let conn = db.lock().unwrap();
        let count = conn.execute(
            "DELETE FROM agent_sessions WHERE conversation_id = ?1",
            params![conversation_id],
        )?;
        Ok(count > 0)
    }
}

pub mod messages {
    use super::*;

    /// List messages by conversation_id (alias for `list` following naming convention)
    pub fn list_by_conversation(conversation_id: ConversationId) -> Result<Vec<Message>> {
        list(conversation_id)
    }

    /// Get the next sequence number for a conversation
    pub async fn get_next_sequence(conversation_id: ConversationId) -> Result<i64> {
        let db = get_user_data_db();
        let conn = db.lock().unwrap();
        let sequence: i64 = conn.query_row(
            "SELECT COALESCE(MAX(sequence), -1) + 1 FROM messages WHERE conversation_id = ?1",
            params![conversation_id],
            |row| row.get(0),
        )?;
        Ok(sequence)
    }

    /// Create a message directly (without auto-generating sequence)
    pub async fn create(message: Message) -> Result<Message> {
        let db = get_user_data_db();
        let conn = db.lock().unwrap();

        conn.execute(
            "INSERT INTO messages (message_id, conversation_id, sequence, role, parts, metadata, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                message.message_id,
                message.conversation_id,
                message.sequence,
                message.role,
                message.parts,
                message.metadata,
                message.created_at,
                message.updated_at,
            ],
        )?;

        Ok(message)
    }

    /// Get a single message by message_id
    pub fn get(message_id: MessageId) -> Result<Option<Message>> {
        let db = get_user_data_db();
        let conn = db.lock().unwrap();

        let mut stmt = conn.prepare(
            "SELECT message_id, conversation_id, sequence, role, parts, metadata,
                    from_agent_id, from_agent_name, message_type, content,
                    turn_id, projection_kind, origin_message_id,
                    thinking, tool_calls, text_chunks, stop_reason, duration_ms,
                    created_at, updated_at
             FROM messages WHERE message_id = ?1",
        )?;

        let mut rows = stmt.query_map(params![message_id], map_row_to_message)?;

        match rows.next() {
            Some(Ok(msg)) => Ok(Some(msg)),
            Some(Err(e)) => Err(e),
            None => Ok(None),
        }
    }

    /// Update a message's parts and metadata
    pub async fn update(
        message_id: MessageId,
        parts: Option<String>,
        metadata: Option<String>,
    ) -> Result<Option<Message>> {
        // Check if nothing to update
        if parts.is_none() && metadata.is_none() {
            // Nothing to update, just return current state
            return get(message_id);
        }

        // Execute the synchronous DB update first
        let update_result = {
            let db = get_user_data_db();
            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_secs() as i64;

            // Build dynamic update query based on what's provided
            let mut updates = Vec::new();
            let mut param_values: Vec<Box<dyn rusqlite::types::ToSql>> = Vec::new();

            if let Some(ref p) = parts {
                updates.push("parts = ?");
                param_values.push(Box::new(p.clone()));
            }
            if let Some(ref m) = metadata {
                updates.push("metadata = ?");
                param_values.push(Box::new(m.clone()));
            }

            updates.push("updated_at = ?");
            param_values.push(Box::new(now));

            param_values.push(Box::new(message_id));

            let query = format!(
                "UPDATE messages SET {} WHERE message_id = ?",
                updates.join(", ")
            );

            let conn = db.lock().unwrap();
            let params_ref: Vec<&dyn rusqlite::types::ToSql> =
                param_values.iter().map(|p| p.as_ref()).collect();
            conn.execute(&query, params_ref.as_slice())
        };
        // All non-Send values are dropped here

        update_result?;

        get(message_id)
    }

    /// Delete a message by message_id
    pub async fn delete(message_id: MessageId) -> Result<bool> {
        let db = get_user_data_db();
        let conn = db.lock().unwrap();
        let count = conn.execute(
            "DELETE FROM messages WHERE message_id = ?1",
            params![message_id],
        )?;
        Ok(count > 0)
    }

    pub fn list(conversation_id: ConversationId) -> Result<Vec<Message>> {
        let db = get_user_data_db();
        let conn = db.lock().unwrap();

        let mut stmt = conn.prepare(
            "SELECT message_id, conversation_id, sequence, role, parts, metadata,
                    from_agent_id, from_agent_name, message_type, content,
                    turn_id, projection_kind, origin_message_id,
                    thinking, tool_calls, text_chunks, stop_reason, duration_ms,
                    created_at, updated_at
             FROM messages WHERE conversation_id = ?1 ORDER BY sequence ASC",
        )?;
        let messages = stmt.query_map(params![conversation_id], map_row_to_message)?;
        messages.collect()
    }

    pub fn list_after_sequence(
        conversation_id: ConversationId,
        after_sequence: i64,
    ) -> Result<Vec<Message>> {
        let db = get_user_data_db();
        let conn = db.lock().unwrap();

        let mut stmt = conn.prepare(
            "SELECT message_id, conversation_id, sequence, role, parts, metadata,
                    from_agent_id, from_agent_name, message_type, content,
                    turn_id, projection_kind, origin_message_id,
                    thinking, tool_calls, text_chunks, stop_reason, duration_ms,
                    created_at, updated_at
             FROM messages
             WHERE conversation_id = ?1 AND sequence > ?2
             ORDER BY sequence ASC",
        )?;
        let messages =
            stmt.query_map(params![conversation_id, after_sequence], map_row_to_message)?;
        messages.collect()
    }

    pub fn get_last(conversation_id: ConversationId) -> Result<Option<Message>> {
        let db = get_user_data_db();
        let conn = db.lock().unwrap();

        let mut stmt = conn.prepare(
            "SELECT message_id, conversation_id, sequence, role, parts, metadata,
                    from_agent_id, from_agent_name, message_type, content,
                    turn_id, projection_kind, origin_message_id,
                    thinking, tool_calls, text_chunks, stop_reason, duration_ms,
                    created_at, updated_at
             FROM messages
             WHERE conversation_id = ?1
             ORDER BY sequence DESC
             LIMIT 1",
        )?;
        let mut rows = stmt.query_map(params![conversation_id], map_row_to_message)?;

        match rows.next() {
            Some(Ok(msg)) => Ok(Some(msg)),
            Some(Err(e)) => Err(e),
            None => Ok(None),
        }
    }

    /// Check if a message with the given external (NATS) message_id already exists
    /// in the specified conversation. Used for idempotent persistence when NATS
    /// redelivers after early persistence.
    ///
    /// The external message_id is stored in the metadata JSON field as `externalMessageId`.
    pub fn exists_by_external_message_id(
        conversation_id: ConversationId,
        external_message_id: &str,
    ) -> Result<bool> {
        let db = get_user_data_db();
        let conn = db.lock().unwrap();
        // Initial messages are persisted before the prompt is queued. Older
        // records did not yet carry externalMessageId in metadata, but the
        // frontend reuses their message_id as the prompt's clientRequestId.
        let legacy_message_id = MessageId::decode(external_message_id).ok();
        let legacy_message_id_i64 = legacy_message_id.map_or(-1, |id| id.as_i64());
        // Use JSON extraction to check metadata.externalMessageId
        let exists: bool = conn.query_row(
            "SELECT EXISTS(
                SELECT 1 FROM messages
                WHERE conversation_id = ?1
                  AND (json_extract(metadata, '$.externalMessageId') = ?2
                       OR message_id = ?3)
            )",
            params![conversation_id, external_message_id, legacy_message_id_i64],
            |row| row.get(0),
        )?;
        Ok(exists)
    }

    /// Update the delivery status of a message identified by external message ID.
    ///
    /// This updates the `deliveryStatus` field in the message's metadata JSON.
    /// Status values: "pending", "delivered", "failed"
    pub fn update_delivery_status(
        conversation_id: ConversationId,
        external_message_id: &str,
        status: &str,
    ) -> Result<()> {
        let db = get_user_data_db();
        let conn = db.lock().unwrap();

        // First check if the message exists
        let message_exists: bool = conn.query_row(
            "SELECT EXISTS(
                SELECT 1 FROM messages
                WHERE conversation_id = ?1
                  AND json_extract(metadata, '$.externalMessageId') = ?2
            )",
            params![conversation_id, external_message_id],
            |row| row.get(0),
        )?;

        if !message_exists {
            tracing::debug!(
                conversation_id = %conversation_id,
                external_message_id = %external_message_id,
                status = %status,
                "No message found to update delivery status (may have been deleted)"
            );
            return Ok(());
        }

        // Message exists, attempt to update delivery status
        // Use JSON patch to update the deliveryStatus field in metadata
        let rows_affected = conn.execute(
            "UPDATE messages
             SET metadata = json_set(
                 COALESCE(metadata, '{}'),
                 '$.deliveryStatus',
                 ?3
             ),
             updated_at = strftime('%s', 'now')
             WHERE conversation_id = ?1
               AND json_extract(metadata, '$.externalMessageId') = ?2",
            params![conversation_id, external_message_id, status],
        )?;

        if rows_affected == 0 {
            // Message exists but update failed - likely due to malformed metadata
            tracing::info!(
                conversation_id = %conversation_id,
                external_message_id = %external_message_id,
                status = %status,
                "Message exists but delivery status update failed (metadata may be malformed)"
            );
        } else {
            tracing::debug!(
                conversation_id = %conversation_id,
                external_message_id = %external_message_id,
                status = %status,
                "Updated message delivery status"
            );
        }

        Ok(())
    }

    /// Agent 消息专用字段（用于结构化存储 agent 间通信）
    #[derive(Debug, Clone, Default)]
    pub struct AgentMessageFields {
        pub from_agent_id: Option<i64>,
        pub from_agent_name: Option<String>,
        pub message_type: Option<String>,
        pub content: Option<String>,
        pub turn_id: Option<String>,
        pub projection_kind: Option<String>,
        pub origin_message_id: Option<String>,
    }

    /// Agent 输出字段（用于存储 agent 的详细输出）
    #[derive(Debug, Clone, Default)]
    pub struct AgentOutputFields {
        pub thinking: Option<String>,
        pub tool_calls: Option<String>,
        pub text_chunks: Option<String>,
        pub stop_reason: Option<String>,
        pub duration_ms: Option<i64>,
    }

    /// Reorder side-copy projections after their completed turn.
    ///
    /// A side copy is persisted as soon as `send_message` accepts the outbound
    /// message, while the producing turn is persisted after all events finish.
    /// Assigning sequence at insert time therefore puts the projection before
    /// reasoning/tool events even though causally it is an output of that turn.
    pub fn link_side_copies_to_turn(
        conversation_id: ConversationId,
        correlation_id: &str,
        turn_id: &str,
    ) -> Result<usize> {
        let db = get_user_data_db();
        let mut conn = db.lock().unwrap();
        let transaction = conn.transaction()?;
        let next_sequence: i64 = transaction.query_row(
            "SELECT COALESCE(MAX(sequence), -1) + 1 FROM messages WHERE conversation_id = ?1",
            params![conversation_id],
            |row| row.get(0),
        )?;

        let mut stmt = transaction.prepare(
            "SELECT message_id FROM messages
             WHERE conversation_id = ?1
               AND projection_kind = 'side_copy'
               AND json_extract(metadata, '$.correlationId') = ?2
             ORDER BY sequence ASC",
        )?;
        let message_ids = stmt
            .query_map(params![conversation_id, correlation_id], |row| {
                row.get::<_, i64>(0)
            })?
            .collect::<Result<Vec<_>>>()?;
        drop(stmt);

        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs() as i64;
        for (offset, message_id) in message_ids.iter().enumerate() {
            transaction.execute(
                "UPDATE messages
                 SET sequence = ?1, turn_id = ?2, updated_at = ?3
                 WHERE message_id = ?4",
                params![next_sequence + offset as i64, turn_id, now, message_id],
            )?;
        }

        transaction.commit()?;
        Ok(message_ids.len())
    }

    pub fn append(
        conversation_id: ConversationId,
        role: &str,
        parts: serde_json::Value,
        metadata: serde_json::Value,
        agent_fields: Option<AgentMessageFields>,
    ) -> Result<Message> {
        append_with_output(
            conversation_id,
            role,
            Some(parts),
            metadata,
            agent_fields,
            None,
        )
    }

    /// Append a message with optional agent output fields
    pub fn append_with_output(
        conversation_id: ConversationId,
        role: &str,
        parts: Option<serde_json::Value>,
        metadata: serde_json::Value,
        agent_fields: Option<AgentMessageFields>,
        output_fields: Option<AgentOutputFields>,
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

        let agent_fields = agent_fields.unwrap_or_default();
        let output_fields = output_fields.unwrap_or_default();

        // Use empty array instead of NULL for parts to simplify query logic
        let parts_str = parts
            .map(|p| p.to_string())
            .unwrap_or_else(|| "[]".to_string());

        let message = Message {
            message_id: MessageId::generate(),
            conversation_id,
            sequence,
            role: role.to_string(),
            parts: Some(parts_str),
            metadata: if metadata.is_null() {
                None
            } else {
                Some(metadata.to_string())
            },
            from_agent_id: agent_fields.from_agent_id,
            from_agent_name: agent_fields.from_agent_name,
            message_type: agent_fields.message_type,
            content: agent_fields.content,
            turn_id: agent_fields.turn_id,
            projection_kind: agent_fields.projection_kind,
            origin_message_id: agent_fields.origin_message_id,
            thinking: output_fields.thinking,
            tool_calls: output_fields.tool_calls,
            text_chunks: output_fields.text_chunks,
            stop_reason: output_fields.stop_reason,
            duration_ms: output_fields.duration_ms,
            created_at: now,
            updated_at: now,
        };

        transaction.execute(
            "INSERT INTO messages (message_id, conversation_id, sequence, role, parts, metadata,
             from_agent_id, from_agent_name, message_type, content,
             turn_id, projection_kind, origin_message_id,
             thinking, tool_calls, text_chunks, stop_reason, duration_ms,
             created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10,
                     ?11, ?12, ?13,
                     ?14, ?15, ?16, ?17, ?18, ?19, ?20)",
            params![
                message.message_id,
                message.conversation_id,
                message.sequence,
                message.role,
                message.parts,
                message.metadata,
                message.from_agent_id,
                message.from_agent_name,
                message.message_type,
                message.content,
                message.turn_id,
                message.projection_kind,
                message.origin_message_id,
                message.thinking,
                message.tool_calls,
                message.text_chunks,
                message.stop_reason,
                message.duration_ms,
                message.created_at,
                message.updated_at,
            ],
        )?;
        transaction.execute(
            "UPDATE conversations SET updated_at = ?1 WHERE conversation_id = ?2",
            params![now, conversation_id],
        )?;
        transaction.commit()?;
        Ok(message)
    }

    /// Append multiple messages in a single transaction.
    /// If any message fails to append, the entire batch is rolled back.
    pub fn append_batch(
        conversation_id: ConversationId,
        messages: Vec<(String, serde_json::Value, serde_json::Value)>, // (role, parts, metadata)
    ) -> Result<Vec<Message>> {
        let db = get_user_data_db();
        let mut conn = db.lock().unwrap();
        let transaction = conn.transaction()?;

        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs() as i64;

        let mut result = Vec::with_capacity(messages.len());

        for (role, parts, metadata) in messages {
            let sequence: i64 = transaction.query_row(
                "SELECT COALESCE(MAX(sequence), -1) + 1 FROM messages WHERE conversation_id = ?1",
                params![conversation_id],
                |row| row.get(0),
            )?;

            let agent_fields = AgentMessageFields::default();
            let output_fields = AgentOutputFields::default();

            // Use empty array instead of NULL for parts to simplify query logic
            let parts_str = parts.to_string();

            let message_id = MessageId::generate();
            let mut metadata = if metadata.is_null() {
                serde_json::json!({})
            } else {
                metadata
            };
            if let serde_json::Value::Object(metadata_map) = &mut metadata {
                metadata_map
                    .entry("externalMessageId")
                    .or_insert_with(|| serde_json::Value::String(message_id.encode()));
            }

            let message = Message {
                message_id,
                conversation_id,
                sequence,
                role, // role is already a String from the tuple, no need to clone
                parts: Some(parts_str),
                metadata: if metadata.is_null() {
                    None
                } else {
                    Some(metadata.to_string())
                },
                from_agent_id: agent_fields.from_agent_id,
                from_agent_name: agent_fields.from_agent_name,
                message_type: agent_fields.message_type,
                content: agent_fields.content,
                turn_id: agent_fields.turn_id,
                projection_kind: agent_fields.projection_kind,
                origin_message_id: agent_fields.origin_message_id,
                thinking: output_fields.thinking,
                tool_calls: output_fields.tool_calls,
                text_chunks: output_fields.text_chunks,
                stop_reason: output_fields.stop_reason,
                duration_ms: output_fields.duration_ms,
                created_at: now,
                updated_at: now,
            };

            transaction.execute(
                "INSERT INTO messages (message_id, conversation_id, sequence, role, parts, metadata,
                 from_agent_id, from_agent_name, message_type, content,
                 turn_id, projection_kind, origin_message_id,
                 thinking, tool_calls, text_chunks, stop_reason, duration_ms,
                 created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10,
                         ?11, ?12, ?13,
                         ?14, ?15, ?16, ?17, ?18, ?19, ?20)",
                params![
                    message.message_id,
                    message.conversation_id,
                    message.sequence,
                    message.role,
                    message.parts,
                    message.metadata,
                    message.from_agent_id,
                    message.from_agent_name,
                    message.message_type,
                    message.content,
                    message.turn_id,
                    message.projection_kind,
                    message.origin_message_id,
                    message.thinking,
                    message.tool_calls,
                    message.text_chunks,
                    message.stop_reason,
                    message.duration_ms,
                    message.created_at,
                    message.updated_at,
                ],
            )?;

            result.push(message);
        }

        // Update conversation's updated_at once for the entire batch
        transaction.execute(
            "UPDATE conversations SET updated_at = ?1 WHERE conversation_id = ?2",
            params![now, conversation_id],
        )?;

        transaction.commit()?;
        Ok(result)
    }

    pub fn list_by_collaboration_session(
        collaboration_session_id: CollaborationSessionId,
    ) -> Result<Vec<Message>> {
        let db = get_user_data_db();
        let conn = db.lock().unwrap();

        let mut stmt = conn.prepare(
            "SELECT m.message_id, m.conversation_id, m.sequence, m.role, m.parts, m.metadata,
                    m.from_agent_id, m.from_agent_name, m.message_type, m.content,
                    m.turn_id, m.projection_kind, m.origin_message_id,
                    m.thinking, m.tool_calls, m.text_chunks, m.stop_reason, m.duration_ms,
                    m.created_at, m.updated_at
             FROM messages m
             JOIN conversations c ON m.conversation_id = c.conversation_id
             WHERE c.collaboration_session_id = ?1
             ORDER BY m.created_at ASC",
        )?;
        let messages = stmt.query_map(params![collaboration_session_id], map_row_to_message)?;
        messages.collect()
    }

    pub fn list_by_chat(chat_id: ChatId) -> Result<Vec<Message>> {
        let db = get_user_data_db();
        let conn = db.lock().unwrap();

        let mut stmt = conn.prepare(
            "SELECT m.message_id, m.conversation_id, m.sequence, m.role, m.parts, m.metadata,
                    m.from_agent_id, m.from_agent_name, m.message_type, m.content,
                    m.turn_id, m.projection_kind, m.origin_message_id,
                    m.thinking, m.tool_calls, m.text_chunks, m.stop_reason, m.duration_ms,
                    m.created_at, m.updated_at
             FROM messages m
             JOIN conversations c ON m.conversation_id = c.conversation_id
             WHERE c.chat_id = ?1
             ORDER BY m.created_at ASC",
        )?;
        let messages = stmt.query_map(params![chat_id], map_row_to_message)?;
        messages.collect()
    }

    fn parts_text(parts: &Option<String>) -> String {
        let Some(parts_str) = parts else {
            return String::new();
        };
        let Ok(value) = serde_json::from_str::<serde_json::Value>(parts_str) else {
            return String::new();
        };
        let Some(items) = value.as_array() else {
            return String::new();
        };
        items
            .iter()
            .filter_map(|item| {
                let obj = item.as_object()?;
                if obj.get("type")?.as_str()? != "text" {
                    return None;
                }
                Some(obj.get("text")?.as_str()?.to_string())
            })
            .collect::<Vec<_>>()
            .join("\n")
    }

    fn message_metadata_source_is_agent(message: &Message) -> bool {
        message
            .metadata
            .as_deref()
            .and_then(|raw| serde_json::from_str::<serde_json::Value>(raw).ok())
            .and_then(|metadata| {
                metadata
                    .get("source")
                    .and_then(serde_json::Value::as_str)
                    .map(str::to_string)
            })
            .map(|source| source == "agent")
            .unwrap_or(false)
    }

    pub fn replace_legacy(
        conversation_id: ConversationId,
        messages_json: &str,
        updated_at: i64,
    ) -> Result<()> {
        let parsed: serde_json::Value = serde_json::from_str(messages_json).map_err(|_| {
            rusqlite::Error::InvalidParameterName("messages must be a JSON array".to_string())
        })?;
        let Some(items) = parsed.as_array() else {
            return Err(rusqlite::Error::InvalidParameterName(
                "messages must be a JSON array".to_string(),
            ));
        };

        let existing = list(conversation_id)?;

        let db = get_user_data_db();
        let mut conn = db.lock().unwrap();
        let transaction = conn.transaction()?;
        transaction.execute(
            "DELETE FROM messages WHERE conversation_id = ?1",
            params![conversation_id],
        )?;

        let mut merged: Vec<(MessageId, String, String, Option<String>, i64)> =
            Vec::with_capacity(items.len());
        let mut payload_ids = std::collections::HashSet::with_capacity(items.len());
        for value in items.iter() {
            // Try to parse ID as i64, or generate a new one
            let id = value
                .get("id")
                .and_then(|v| match v {
                    serde_json::Value::Number(number) => number.as_i64().map(MessageId::new),
                    serde_json::Value::String(raw) => MessageId::decode(raw).ok(),
                    _ => None,
                })
                .unwrap_or_else(MessageId::generate);
            payload_ids.insert(id);
            let role = value
                .get("role")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("user")
                .to_string();
            let parts = value.get("parts").cloned().unwrap_or_else(|| value.clone());
            let metadata = value
                .get("metadata")
                .cloned()
                .unwrap_or(serde_json::Value::Null);
            merged.push((
                id,
                role,
                parts.to_string(),
                if metadata.is_null() {
                    None
                } else {
                    Some(metadata.to_string())
                },
                updated_at,
            ));
        }

        let payload_text_index: std::collections::HashSet<(String, String)> = merged
            .iter()
            .filter_map(|(_, role, parts, ..)| {
                let text = parts_text(&Some(parts.clone()));
                if text.is_empty() {
                    None
                } else {
                    Some((role.clone(), text.trim().to_string()))
                }
            })
            .collect();
        let mut preserved: Vec<&Message> = existing
            .iter()
            .filter(|message| {
                if payload_ids.contains(&message.message_id)
                    || !message_metadata_source_is_agent(message)
                {
                    return false;
                }
                let text = parts_text(&message.parts);
                text.is_empty()
                    || !payload_text_index
                        .contains(&(message.role.clone(), text.trim().to_string()))
            })
            .collect();
        preserved.sort_by_key(|message| message.sequence);

        let preserved_at = match merged.last() {
            Some((_, role, ..)) if role == "assistant" => merged.len() - 1,
            _ => merged.len(),
        };

        let preserved_rows: Vec<(MessageId, String, String, Option<String>, i64)> = preserved
            .iter()
            .map(|message| {
                (
                    message.message_id,
                    message.role.clone(),
                    message.parts.clone().unwrap_or_default(),
                    message.metadata.clone(),
                    message.created_at,
                )
            })
            .collect();

        let mut final_merged = Vec::with_capacity(merged.len() + preserved_rows.len());
        final_merged.extend(merged.iter().take(preserved_at).cloned());
        final_merged.extend(preserved_rows);
        final_merged.extend(merged.iter().skip(preserved_at).cloned());
        merged = final_merged;

        for (index, (id, role, parts, metadata, created_at)) in merged.iter().enumerate() {
            transaction.execute(
                "INSERT INTO messages (message_id, conversation_id, sequence, role, parts, metadata, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)",
                params![
                    id,
                    conversation_id,
                    index as i64,
                    role,
                    parts,
                    metadata,
                    created_at,
                ],
            )?;
        }

        transaction.execute(
            "UPDATE conversations SET updated_at = ?1 WHERE conversation_id = ?2",
            params![updated_at, conversation_id],
        )?;
        transaction.commit()?;
        Ok(())
    }

    pub fn serialize_legacy(conversation_id: ConversationId) -> Result<String> {
        let messages = list(conversation_id)?;
        let values = messages
            .into_iter()
            .map(|message| {
                let parts: serde_json::Value = message
                    .parts
                    .as_ref()
                    .and_then(|p| serde_json::from_str(p).ok())
                    .unwrap_or_else(|| {
                        serde_json::Value::String(message.parts.clone().unwrap_or_default())
                    });
                let metadata: serde_json::Value = message
                    .metadata
                    .as_deref()
                    .and_then(|metadata| serde_json::from_str(metadata).ok())
                    .unwrap_or(serde_json::Value::Null);
                serde_json::json!({
                    "id": message.message_id,
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

    /// Delete messages older than the given timestamp (seconds since epoch).
    /// Returns the number of deleted messages.
    pub fn delete_older_than(cutoff_timestamp: i64) -> Result<usize> {
        let db = get_user_data_db();
        let conn = db.lock().unwrap();
        let count = conn.execute(
            "DELETE FROM messages WHERE created_at < ?1",
            params![cutoff_timestamp],
        )?;
        Ok(count)
    }

    /// List messages by conversation with pagination
    pub fn list_by_conversation_paginated(
        conversation_id: ConversationId,
        limit: Option<i64>,
        offset: Option<i64>,
    ) -> Result<Vec<Message>> {
        let db = get_user_data_db();
        let conn = db.lock().unwrap();

        // Build query with optional LIMIT and OFFSET
        let query = match (limit, offset) {
            (Some(_l), Some(_o)) => {
                "SELECT message_id, conversation_id, sequence, role, parts, metadata,
                        from_agent_id, from_agent_name, message_type, content,
                        turn_id, projection_kind, origin_message_id,
                        thinking, tool_calls, text_chunks, stop_reason, duration_ms,
                        created_at, updated_at
                 FROM messages WHERE conversation_id = ?1 ORDER BY sequence ASC LIMIT ?2 OFFSET ?3"
            }
            (Some(_l), None) => {
                "SELECT message_id, conversation_id, sequence, role, parts, metadata,
                        from_agent_id, from_agent_name, message_type, content,
                        turn_id, projection_kind, origin_message_id,
                        thinking, tool_calls, text_chunks, stop_reason, duration_ms,
                        created_at, updated_at
                 FROM messages WHERE conversation_id = ?1 ORDER BY sequence ASC LIMIT ?2"
            }
            _ => {
                "SELECT message_id, conversation_id, sequence, role, parts, metadata,
                        from_agent_id, from_agent_name, message_type, content,
                        turn_id, projection_kind, origin_message_id,
                        thinking, tool_calls, text_chunks, stop_reason, duration_ms,
                        created_at, updated_at
                 FROM messages WHERE conversation_id = ?1 ORDER BY sequence ASC"
            }
        };

        let mut stmt = conn.prepare(query)?;

        let messages = match (limit, offset) {
            (Some(l), Some(o)) => stmt
                .query_map(params![conversation_id, l, o], map_row_to_message)?
                .collect::<Result<Vec<_>>>()?,
            (Some(l), None) => stmt
                .query_map(params![conversation_id, l], map_row_to_message)?
                .collect::<Result<Vec<_>>>()?,
            _ => stmt
                .query_map(params![conversation_id], map_row_to_message)?
                .collect::<Result<Vec<_>>>()?,
        };

        Ok(messages)
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
            conversation_id: row.get(5)?,
            created_at: row.get(6)?,
            updated_at: row.get(7)?,
        })
    }

    pub fn upsert(binding: GroupAgentBinding) -> Result<GroupAgentBinding> {
        let db = get_user_data_db();
        let conn = db.lock().unwrap();

        conn.execute(
            "INSERT INTO group_agent_bindings (workspace_id, chat_id, agent_id, agent_name, agent_command, conversation_id, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
             ON CONFLICT(chat_id, agent_id) DO UPDATE SET
               workspace_id = excluded.workspace_id,
               agent_name = excluded.agent_name,
               agent_command = excluded.agent_command,
               conversation_id = excluded.conversation_id,
               updated_at = excluded.updated_at",
            params![
                binding.workspace_id,
                binding.chat_id,
                binding.agent_id,
                binding.agent_name,
                binding.agent_command,
                binding.conversation_id,
                binding.created_at,
                binding.updated_at,
            ],
        )?;

        let mut stmt = conn.prepare(
            "SELECT workspace_id, chat_id, agent_id, agent_name, agent_command, conversation_id, created_at, updated_at
             FROM group_agent_bindings WHERE chat_id = ?1 AND agent_id = ?2",
        )?;
        let mut rows =
            stmt.query_map(params![binding.chat_id, binding.agent_id], row_to_binding)?;
        rows.next()
            .unwrap_or_else(|| Err(rusqlite::Error::QueryReturnedNoRows))
    }

    pub fn list(chat_id: ChatId) -> Result<Vec<GroupAgentBinding>> {
        let db = get_user_data_db();
        let conn = db.lock().unwrap();

        let mut stmt = conn.prepare(
            "SELECT workspace_id, chat_id, agent_id, agent_name, agent_command, conversation_id, created_at, updated_at
             FROM group_agent_bindings WHERE chat_id = ?1 ORDER BY created_at ASC",
        )?;
        let bindings = stmt.query_map(params![chat_id], row_to_binding)?;
        bindings.collect()
    }

    pub fn find_conversation_id(agent_id: i64) -> Result<Option<ConversationId>> {
        let db = get_user_data_db();
        let conn = db.lock().unwrap();

        let mut stmt = conn
            .prepare("SELECT conversation_id FROM group_agent_bindings WHERE agent_id = ?1 ORDER BY updated_at DESC, created_at DESC LIMIT 1")?;
        let mut rows = stmt.query_map(params![agent_id], |row| row.get::<_, ConversationId>(0))?;
        rows.next().transpose()
    }

    /// Find the most recent agent binding that owns a conversation.
    ///
    /// This is the authoritative way to attribute normal assistant turns to an
    /// agent; no database migration is required because the binding table
    /// already owns the conversation → agent relationship.
    pub fn find_by_conversation_id(
        conversation_id: ConversationId,
    ) -> Result<Option<GroupAgentBinding>> {
        let db = get_user_data_db();
        let conn = db.lock().unwrap();

        let mut stmt = conn.prepare(
            "SELECT workspace_id, chat_id, agent_id, agent_name, agent_command, conversation_id, created_at, updated_at
             FROM group_agent_bindings
             WHERE conversation_id = ?1
             ORDER BY updated_at DESC, created_at DESC
             LIMIT 1",
        )?;
        let mut rows = stmt.query_map(params![conversation_id], row_to_binding)?;
        rows.next().transpose()
    }

    pub fn delete(chat_id: ChatId, agent_id: i64) -> Result<bool> {
        let db = get_user_data_db();
        let conn = db.lock().unwrap();
        let count = conn.execute(
            "DELETE FROM group_agent_bindings WHERE chat_id = ?1 AND agent_id = ?2",
            params![chat_id, agent_id],
        )?;
        Ok(count > 0)
    }

    pub fn delete_by_agent(agent_id: i64) -> Result<usize> {
        let db = get_user_data_db();
        let conn = db.lock().unwrap();
        let count = conn.execute(
            "DELETE FROM group_agent_bindings WHERE agent_id = ?1",
            params![agent_id],
        )?;
        Ok(count)
    }
}

pub mod terminal_sessions {
    use super::*;

    #[derive(Debug, Clone, Serialize, Deserialize)]
    pub struct TerminalSessionRecord {
        pub session_id: i64,
        pub workspace_id: i64,
        pub user_id: String,
        pub profile: String,
        pub transport: String,
        pub status: String,
        pub cwd: String,
        pub pid: Option<i64>,
        pub exit_code: Option<i32>,
        pub agent_session_id: Option<i64>,
        pub last_sequence: i64,
        pub recoverable: bool,
        pub created_at_ms: i64,
        pub updated_at_ms: i64,
    }

    pub fn upsert(record: &TerminalSessionRecord) -> Result<()> {
        let db = get_user_data_db();
        let conn = db.lock().unwrap();
        conn.execute(
            "INSERT INTO terminal_sessions (
                session_id, workspace_id, user_id, profile, transport, status,
                cwd, pid, exit_code, agent_session_id, last_sequence,
                recoverable, created_at_ms, updated_at_ms
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)
            ON CONFLICT(session_id) DO UPDATE SET
                workspace_id = excluded.workspace_id,
                user_id = excluded.user_id,
                profile = excluded.profile,
                transport = excluded.transport,
                status = excluded.status,
                cwd = excluded.cwd,
                pid = excluded.pid,
                exit_code = excluded.exit_code,
                agent_session_id = excluded.agent_session_id,
                last_sequence = excluded.last_sequence,
                recoverable = excluded.recoverable,
                updated_at_ms = excluded.updated_at_ms",
            params![
                record.session_id,
                record.workspace_id,
                record.user_id,
                record.profile,
                record.transport,
                record.status,
                record.cwd,
                record.pid,
                record.exit_code,
                record.agent_session_id,
                record.last_sequence,
                record.recoverable,
                record.created_at_ms,
                record.updated_at_ms,
            ],
        )?;
        Ok(())
    }

    pub fn list(workspace_id: i64, user_id: &str) -> Result<Vec<TerminalSessionRecord>> {
        let db = get_user_data_db();
        let conn = db.lock().unwrap();
        let mut statement = conn.prepare(
            "SELECT session_id, workspace_id, user_id, profile, transport, status,
                    cwd, pid, exit_code, agent_session_id, last_sequence,
                    recoverable, created_at_ms, updated_at_ms
             FROM terminal_sessions
             WHERE workspace_id = ?1 AND user_id = ?2
             ORDER BY created_at_ms DESC",
        )?;
        let records = statement
            .query_map(params![workspace_id, user_id], |row| {
                Ok(TerminalSessionRecord {
                    session_id: row.get(0)?,
                    workspace_id: row.get(1)?,
                    user_id: row.get(2)?,
                    profile: row.get(3)?,
                    transport: row.get(4)?,
                    status: row.get(5)?,
                    cwd: row.get(6)?,
                    pid: row.get(7)?,
                    exit_code: row.get(8)?,
                    agent_session_id: row.get(9)?,
                    last_sequence: row.get(10)?,
                    recoverable: row.get::<_, i64>(11)? != 0,
                    created_at_ms: row.get(12)?,
                    updated_at_ms: row.get(13)?,
                })
            })?
            .collect::<Result<Vec<_>>>()?;
        Ok(records)
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

    pub fn get(conversation_id: ConversationId) -> Result<Option<ConversationExecutionContext>> {
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
            "SELECT c.conversation_id, c.collaboration_session_id, c.chat_id, c.parent_id, c.name, c.mode, c.participant_role, c.status, c.created_at, c.updated_at
             FROM conversations AS c
             JOIN conversation_execution_contexts AS e ON e.conversation_id = c.conversation_id
             WHERE e.worktree_path = ?1 LIMIT 1",
            params![path],
            |row| {
                Ok(Conversation {
                    conversation_id: row.get(0)?,
                    collaboration_session_id: row.get(1)?,
                    chat_id: row.get(2)?,
                    parent_id: row.get(3)?,
                    name: row.get(4)?,
                    mode: row.get(5)?,
                    participant_role: row.get(6)?,
                    status: row.get(7)?,
                    created_at: row.get(8)?,
                    updated_at: row.get(9)?,
                })
            },
        )
        .optional()
    }
}

// ── MCP Servers CRUD ─────────────────────────────────────────────────────────

pub mod mcp_servers {
    use super::*;

    /// Helper function to deserialize MCP server from database row
    fn deserialize_server(row: &rusqlite::Row) -> rusqlite::Result<McpServer> {
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

        let profile_id_row: String = row.get(1)?;
        let profile_id = if profile_id_row.is_empty() {
            None
        } else {
            Some(profile_id_row)
        };

        Ok(McpServer {
            id: row.get(0)?,
            profile_id,
            name: row.get(2)?,
            server_type: row.get(3)?,
            command: row.get(4)?,
            args,
            env,
            url: row.get(7)?,
            headers,
            enabled: row.get::<_, i64>(9)? != 0,
            created_at: row.get(10)?,
            updated_at: row.get(11)?,
        })
    }

    /// Create a new MCP server configuration
    pub fn create(server: McpServer) -> Result<McpServer> {
        let db = get_user_data_db();
        let conn = db.lock().unwrap();

        let args_json = serde_json::to_string(&server.args)
            .map_err(|e| rusqlite::Error::ToSqlConversionFailure(Box::new(e)))?;
        let env_json = serde_json::to_string(&server.env)
            .map_err(|e| rusqlite::Error::ToSqlConversionFailure(Box::new(e)))?;
        let headers_json = serde_json::to_string(&server.headers)
            .map_err(|e| rusqlite::Error::ToSqlConversionFailure(Box::new(e)))?;
        // Convert None to empty string for UNIQUE constraint compatibility
        let profile_id_db = server.profile_id.as_deref().unwrap_or("");

        conn.execute(
            "INSERT INTO mcp_servers (id, profile_id, name, server_type, command, args, env, url, headers, enabled, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
            params![
                server.id,
                profile_id_db,
                server.name,
                server.server_type,
                server.command,
                args_json,
                env_json,
                server.url,
                headers_json,
                server.enabled as i64,
                server.created_at,
                server.updated_at,
            ],
        )?;

        Ok(server)
    }

    /// Get an MCP server by ID
    pub fn get(id: i64) -> Result<Option<McpServer>> {
        let db = get_user_data_db();
        let conn = db.lock().unwrap();

        conn.query_row(
            "SELECT id, profile_id, name, server_type, command, args, env, url, headers, enabled, created_at, updated_at
             FROM mcp_servers WHERE id = ?1",
            params![id],
            deserialize_server,
        )
        .optional()
    }

    /// Get an MCP server by profile_id and name
    pub fn get_by_profile_and_name(
        profile_id: Option<&str>,
        name: &str,
    ) -> Result<Option<McpServer>> {
        let db = get_user_data_db();
        let conn = db.lock().unwrap();

        // Convert None to empty string for database query
        let profile_id_db = profile_id.unwrap_or("");

        conn.query_row(
            "SELECT id, profile_id, name, server_type, command, args, env, url, headers, enabled, created_at, updated_at
             FROM mcp_servers WHERE profile_id = ?1 AND name = ?2",
            params![profile_id_db, name],
            deserialize_server,
        )
        .optional()
    }

    /// List all MCP servers
    pub fn list() -> Result<Vec<McpServer>> {
        let db = get_user_data_db();
        let conn = db.lock().unwrap();

        let mut stmt = conn.prepare(
            "SELECT id, profile_id, name, server_type, command, args, env, url, headers, enabled, created_at, updated_at
             FROM mcp_servers ORDER BY created_at DESC",
        )?;

        let servers = stmt.query_map([], deserialize_server)?;

        servers.collect()
    }

    /// List global MCP servers (profile_id is empty string)
    pub fn list_global() -> Result<Vec<McpServer>> {
        let db = get_user_data_db();
        let conn = db.lock().unwrap();

        let mut stmt = conn.prepare(
            "SELECT id, profile_id, name, server_type, command, args, env, url, headers, enabled, created_at, updated_at
             FROM mcp_servers WHERE profile_id = '' ORDER BY created_at DESC",
        )?;

        let servers = stmt.query_map([], deserialize_server)?;

        servers.collect()
    }

    /// List MCP servers by profile_id (including global servers where profile_id is empty string)
    pub fn list_by_profile(profile_id: Option<&str>) -> Result<Vec<McpServer>> {
        let db = get_user_data_db();
        let conn = db.lock().unwrap();

        // Convert None to empty string for database query
        let profile_id_db = profile_id.unwrap_or("");

        let mut stmt = conn.prepare(
            "SELECT id, profile_id, name, server_type, command, args, env, url, headers, enabled, created_at, updated_at
             FROM mcp_servers WHERE profile_id = ?1 ORDER BY created_at DESC",
        )?;

        let servers = stmt.query_map(params![profile_id_db], deserialize_server)?;

        servers.collect()
    }

    /// List enabled MCP servers for a specific profile (including global servers)
    pub fn list_enabled_for_profile(profile_id: Option<&str>) -> Result<Vec<McpServer>> {
        let db = get_user_data_db();
        let conn = db.lock().unwrap();

        // Convert None to empty string for database query
        let profile_id_db = profile_id.unwrap_or("");

        let mut stmt = conn.prepare(
            "SELECT id, profile_id, name, server_type, command, args, env, url, headers, enabled, created_at, updated_at
             FROM mcp_servers WHERE enabled = 1 AND (profile_id = ?1 OR profile_id = '')
             ORDER BY CASE WHEN profile_id = '' THEN 1 ELSE 0 END, created_at DESC",
        )?;

        let servers = stmt.query_map(params![profile_id_db], deserialize_server)?;

        servers.collect()
    }

    /// List all enabled MCP servers
    pub fn list_enabled() -> Result<Vec<McpServer>> {
        let db = get_user_data_db();
        let conn = db.lock().unwrap();

        let mut stmt = conn.prepare(
            "SELECT id, profile_id, name, server_type, command, args, env, url, headers, enabled, created_at, updated_at
             FROM mcp_servers WHERE enabled = 1 ORDER BY created_at DESC",
        )?;

        let servers = stmt.query_map([], deserialize_server)?;

        servers.collect()
    }

    /// Update an MCP server configuration
    pub fn update(server: McpServer) -> Result<()> {
        let db = get_user_data_db();
        let conn = db.lock().unwrap();

        let args_json = serde_json::to_string(&server.args)
            .map_err(|e| rusqlite::Error::ToSqlConversionFailure(Box::new(e)))?;
        let env_json = serde_json::to_string(&server.env)
            .map_err(|e| rusqlite::Error::ToSqlConversionFailure(Box::new(e)))?;
        let headers_json = serde_json::to_string(&server.headers)
            .map_err(|e| rusqlite::Error::ToSqlConversionFailure(Box::new(e)))?;
        // Convert None to empty string for UNIQUE constraint compatibility
        let profile_id_db = server.profile_id.as_deref().unwrap_or("");

        conn.execute(
            "UPDATE mcp_servers
             SET profile_id = ?1, name = ?2, server_type = ?3, command = ?4, args = ?5, env = ?6, url = ?7, headers = ?8, enabled = ?9, updated_at = ?10
             WHERE id = ?11",
            params![
                profile_id_db,
                server.name,
                server.server_type,
                server.command,
                args_json,
                env_json,
                server.url,
                headers_json,
                server.enabled as i64,
                server.updated_at,
                server.id,
            ],
        )?;

        Ok(())
    }

    /// Delete an MCP server by ID
    pub fn delete(id: i64) -> Result<bool> {
        let db = get_user_data_db();
        let conn = db.lock().unwrap();

        let count = conn.execute("DELETE FROM mcp_servers WHERE id = ?1", params![id])?;

        Ok(count > 0)
    }

    /// Delete all MCP servers for a specific profile
    pub fn delete_by_profile(profile_id: &str) -> Result<usize> {
        let db = get_user_data_db();
        let conn = db.lock().unwrap();

        let count = conn.execute(
            "DELETE FROM mcp_servers WHERE profile_id = ?1",
            params![profile_id],
        )?;

        Ok(count)
    }
}

// ── Batch Operations ─────────────────────────────────────────────────────────

/// Create a default chat with all associated records in a single transaction.
///
/// This ensures atomicity: either all 6 records are created, or none are.
/// Prevents orphaned records when creating the default chat/binding structure
/// for an agent that has no GroupAgentBinding yet.
///
/// Records created:
/// 1. Chat
/// 2. CollaborationSession
/// 3. Root Conversation (chat-level)
/// 4. Agent Conversation (child of root)
/// 5. GroupAgentBinding
/// 6. AgentSession
pub fn create_default_chat_with_binding(
    chat: Chat,
    collaboration_session: CollaborationSession,
    root_conversation: Conversation,
    agent_conversation: Conversation,
    binding: GroupAgentBinding,
    agent_session: AgentSession,
) -> Result<ConversationId> {
    let db = get_user_data_db();
    let mut conn = db.lock().unwrap();

    // Begin transaction
    let transaction = conn.transaction()?;

    // 1. Create chat
    transaction.execute(
        "INSERT INTO chats (chat_id, workspace_id, name, collaboration_mode, worktree_path, branch, base_branch, pr_url, pr_number, created_at, updated_at, archived_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
        params![
            chat.chat_id,
            chat.workspace_id,
            chat.name,
            chat.collaboration_mode,
            chat.worktree_path,
            chat.branch,
            chat.base_branch,
            chat.pr_url,
            chat.pr_number,
            chat.created_at,
            chat.updated_at,
            chat.archived_at,
        ],
    )?;

    // 2. Create collaboration session
    transaction.execute(
        "INSERT INTO collaboration_sessions (collaboration_session_id, chat_id, workspace_id, mode, state, goal, active_plan_revision, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        params![
            collaboration_session.collaboration_session_id,
            collaboration_session.chat_id,
            collaboration_session.workspace_id,
            collaboration_session.mode,
            collaboration_session.state,
            collaboration_session.goal,
            collaboration_session.active_plan_revision,
            collaboration_session.created_at,
            collaboration_session.updated_at,
        ],
    )?;

    // 3. Create root conversation
    transaction.execute(
        "INSERT INTO conversations (conversation_id, collaboration_session_id, chat_id, parent_id, name, mode, participant_role, status, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
        params![
            root_conversation.conversation_id,
            root_conversation.collaboration_session_id,
            root_conversation.chat_id,
            root_conversation.parent_id,
            root_conversation.name,
            root_conversation.mode,
            root_conversation.participant_role,
            root_conversation.status,
            root_conversation.created_at,
            root_conversation.updated_at,
        ],
    )?;

    // 4. Create agent conversation
    transaction.execute(
        "INSERT INTO conversations (conversation_id, collaboration_session_id, chat_id, parent_id, name, mode, participant_role, status, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
        params![
            agent_conversation.conversation_id,
            agent_conversation.collaboration_session_id,
            agent_conversation.chat_id,
            agent_conversation.parent_id,
            agent_conversation.name,
            agent_conversation.mode,
            agent_conversation.participant_role,
            agent_conversation.status,
            agent_conversation.created_at,
            agent_conversation.updated_at,
        ],
    )?;

    // 5. Create GroupAgentBinding
    transaction.execute(
        "INSERT INTO group_agent_bindings (workspace_id, chat_id, agent_id, agent_name, agent_command, conversation_id, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
         ON CONFLICT(workspace_id, agent_id) DO UPDATE SET
           chat_id = excluded.chat_id,
           agent_name = excluded.agent_name,
           agent_command = excluded.agent_command,
           conversation_id = excluded.conversation_id,
           updated_at = excluded.updated_at",
        params![
            binding.workspace_id,
            binding.chat_id,
            binding.agent_id,
            binding.agent_name,
            binding.agent_command,
            binding.conversation_id,
            binding.created_at,
            binding.updated_at,
        ],
    )?;

    // 6. Create AgentSession
    transaction.execute(
        "INSERT INTO agent_sessions (agent_session_id, conversation_id, acp_session_id, mode, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT(agent_session_id) DO UPDATE SET
           conversation_id = excluded.conversation_id,
           acp_session_id = excluded.acp_session_id,
           mode = excluded.mode,
           updated_at = excluded.updated_at",
        params![
            agent_session.agent_session_id,
            agent_session.conversation_id,
            agent_session.acp_session_id,
            agent_session.mode,
            agent_session.created_at,
            agent_session.updated_at,
        ],
    )?;

    // Commit transaction
    transaction.commit()?;

    Ok(agent_conversation.conversation_id)
}

// ── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    static TEST_DB_MUTEX: Mutex<()> = Mutex::new(());
    static TEST_DB_DATA_DIR: std::sync::OnceLock<PathBuf> = std::sync::OnceLock::new();

    fn lock_user_data_db_for_tests() -> std::sync::MutexGuard<'static, ()> {
        let guard = TEST_DB_MUTEX
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        TEST_DB_DATA_DIR.get_or_init(|| {
            let data_dir = std::env::temp_dir()
                .join("ergatai-user-data-tests")
                .join(std::process::id().to_string());
            let _ = std::fs::remove_dir_all(&data_dir);
            std::fs::create_dir_all(&data_dir).unwrap();
            std::env::set_var("ERGATAI_DATA_DIR", &data_dir);
            data_dir
        });
        Lazy::force(&USER_DATA_DB);
        guard
    }

    #[test]
    fn test_workspace_crud() {
        let _database_guard = lock_user_data_db_for_tests();

        let workspace = Workspace {
            workspace_id: WorkspaceId::new(12345),
            name: "Test Workspace".to_string(),
            work_dir: "/tmp/test".to_string(),
            env: "{}".to_string(),
            resources: "{}".to_string(),
            config: "{}".to_string(),
            collaboration_mode: "supervisor".to_string(),
            status: "active".to_string(),
            default_project_id: None,
            created_at: 1234567890,
            updated_at: 1234567890,
        };

        let created = workspaces::create(workspace.clone()).unwrap();
        assert_eq!(created.workspace_id, workspace.workspace_id);

        let retrieved = workspaces::get(workspace.workspace_id).unwrap().unwrap();
        assert_eq!(retrieved.name, workspace.name);

        let all = workspaces::list(None).unwrap();
        assert!(!all.is_empty());

        workspaces::delete(workspace.workspace_id).unwrap();
        let deleted = workspaces::get(workspace.workspace_id).unwrap();
        assert!(deleted.is_none());
    }

    #[test]
    fn test_full_hierarchy_crud() {
        let _database_guard = lock_user_data_db_for_tests();
        let prefix = std::process::id() as i64;
        let workspace_id = WorkspaceId::new(prefix * 10000 + 1);
        let chat_id = ChatId::new(prefix * 10000 + 2);
        let session_id = CollaborationSessionId::new(prefix * 10000 + 3);
        let conversation_id = ConversationId::new(prefix * 10000 + 4);

        workspaces::create(Workspace {
            workspace_id,
            name: "Test Workspace".to_string(),
            work_dir: "/tmp/test".to_string(),
            env: "{}".to_string(),
            resources: "{}".to_string(),
            config: "{}".to_string(),
            collaboration_mode: "supervisor".to_string(),
            status: "active".to_string(),
            default_project_id: None,
            created_at: 1000,
            updated_at: 1000,
        })
        .unwrap();

        chats::create(Chat {
            chat_id,
            workspace_id,
            name: Some("Test Chat".to_string()),
            collaboration_mode: Some("supervisor".to_string()),
            worktree_path: None,
            branch: None,
            base_branch: None,
            pr_url: None,
            pr_number: None,
            created_at: 1000,
            updated_at: 1000,
            archived_at: None,
        })
        .unwrap();

        collaboration_sessions::create(CollaborationSession {
            collaboration_session_id: session_id,
            chat_id,
            workspace_id,
            mode: "supervisor".to_string(),
            state: "idle".to_string(),
            goal: None,
            active_plan_revision: None,
            created_at: 1000,
            updated_at: 1000,
        })
        .unwrap();

        conversations::create(Conversation {
            conversation_id,
            collaboration_session_id: session_id,
            chat_id,
            parent_id: None,
            name: Some("Test Conversation".to_string()),
            mode: "agent".to_string(),
            participant_role: "peer".to_string(),
            status: "ready".to_string(),
            created_at: 1000,
            updated_at: 1000,
        })
        .unwrap();

        messages::append(
            conversation_id,
            "user",
            serde_json::json!([{ "type": "text", "text": "Hello" }]),
            serde_json::json!({}),
            None,
        )
        .unwrap();
        messages::append(
            conversation_id,
            "assistant",
            serde_json::json!([{ "type": "text", "text": "Hi there!" }]),
            serde_json::json!({}),
            None,
        )
        .unwrap();

        let chat = chats::get(chat_id).unwrap().unwrap();
        assert_eq!(chat.workspace_id, workspace_id);

        let session = collaboration_sessions::get(session_id).unwrap().unwrap();
        assert_eq!(session.chat_id, chat_id);

        let conversation = conversations::get(conversation_id).unwrap().unwrap();
        assert_eq!(conversation.collaboration_session_id, session_id);
        assert_eq!(conversation.chat_id, chat_id);

        let msgs = messages::list(conversation_id).unwrap();
        assert_eq!(msgs.len(), 2);

        let msgs_by_session = messages::list_by_collaboration_session(session_id).unwrap();
        assert_eq!(msgs_by_session.len(), 2);

        let msgs_by_chat = messages::list_by_chat(chat_id).unwrap();
        assert_eq!(msgs_by_chat.len(), 2);

        workspaces::delete(workspace_id).unwrap();
        assert!(chats::get(chat_id).unwrap().is_none());
        assert!(collaboration_sessions::get(session_id).unwrap().is_none());
        assert!(conversations::get(conversation_id).unwrap().is_none());
        assert!(messages::list(conversation_id).unwrap().is_empty());
    }

    #[test]
    fn test_messages_list_after_sequence() {
        let _database_guard = lock_user_data_db_for_tests();
        let prefix = std::process::id() as i64;
        let workspace_id = WorkspaceId::new(prefix * 10000 + 101);
        let chat_id = ChatId::new(prefix * 10000 + 102);
        let session_id = CollaborationSessionId::new(prefix * 10000 + 103);
        let conversation_id = ConversationId::new(prefix * 10000 + 104);

        workspaces::create(Workspace {
            workspace_id,
            name: "Test".to_string(),
            work_dir: "/tmp/test".to_string(),
            env: "{}".to_string(),
            resources: "{}".to_string(),
            config: "{}".to_string(),
            collaboration_mode: "supervisor".to_string(),
            status: "active".to_string(),
            default_project_id: None,
            created_at: 1000,
            updated_at: 1000,
        })
        .unwrap();

        chats::create(Chat {
            chat_id,
            workspace_id,
            name: None,
            collaboration_mode: Some("supervisor".to_string()),
            worktree_path: None,
            branch: None,
            base_branch: None,
            pr_url: None,
            pr_number: None,
            created_at: 1000,
            updated_at: 1000,
            archived_at: None,
        })
        .unwrap();

        collaboration_sessions::create(CollaborationSession {
            collaboration_session_id: session_id,
            chat_id,
            workspace_id,
            mode: "supervisor".to_string(),
            state: "idle".to_string(),
            goal: None,
            active_plan_revision: None,
            created_at: 1000,
            updated_at: 1000,
        })
        .unwrap();

        conversations::create(Conversation {
            conversation_id,
            collaboration_session_id: session_id,
            chat_id,
            parent_id: None,
            name: None,
            mode: "agent".to_string(),
            participant_role: "peer".to_string(),
            status: "ready".to_string(),
            created_at: 1000,
            updated_at: 1000,
        })
        .unwrap();

        let mut appended_messages = Vec::new();
        for i in 0..5 {
            let msg = messages::append(
                conversation_id,
                "user",
                serde_json::json!([{ "type": "text", "text": format!("Message {}", i) }]),
                serde_json::json!({ "index": i }),
                None,
            )
            .unwrap();
            appended_messages.push(msg);
        }

        let max_sequence = appended_messages
            .iter()
            .map(|m| m.sequence)
            .max()
            .unwrap_or(0);
        let min_sequence = appended_messages
            .iter()
            .map(|m| m.sequence)
            .min()
            .unwrap_or(0);

        let all = messages::list_after_sequence(conversation_id, min_sequence - 1).unwrap();
        assert_eq!(all.len(), 5);

        let mid_sequence = min_sequence + 1;
        let after_mid = messages::list_after_sequence(conversation_id, mid_sequence).unwrap();
        assert_eq!(after_mid.len(), (max_sequence - mid_sequence) as usize);

        let after_max = messages::list_after_sequence(conversation_id, max_sequence).unwrap();
        assert_eq!(after_max.len(), 0);

        workspaces::delete(workspace_id).unwrap();
    }

    #[test]
    fn test_messages_get_last() {
        let _database_guard = lock_user_data_db_for_tests();
        let prefix = std::process::id() as i64;
        let workspace_id = WorkspaceId::new(prefix * 10000 + 201);
        let chat_id = ChatId::new(prefix * 10000 + 202);
        let session_id = CollaborationSessionId::new(prefix * 10000 + 203);
        let conversation_id = ConversationId::new(prefix * 10000 + 204);

        workspaces::create(Workspace {
            workspace_id,
            name: "Test".to_string(),
            work_dir: "/tmp/test".to_string(),
            env: "{}".to_string(),
            resources: "{}".to_string(),
            config: "{}".to_string(),
            collaboration_mode: "supervisor".to_string(),
            status: "active".to_string(),
            default_project_id: None,
            created_at: 1000,
            updated_at: 1000,
        })
        .unwrap();

        chats::create(Chat {
            chat_id,
            workspace_id,
            name: None,
            collaboration_mode: Some("supervisor".to_string()),
            worktree_path: None,
            branch: None,
            base_branch: None,
            pr_url: None,
            pr_number: None,
            created_at: 1000,
            updated_at: 1000,
            archived_at: None,
        })
        .unwrap();

        collaboration_sessions::create(CollaborationSession {
            collaboration_session_id: session_id,
            chat_id,
            workspace_id,
            mode: "supervisor".to_string(),
            state: "idle".to_string(),
            goal: None,
            active_plan_revision: None,
            created_at: 1000,
            updated_at: 1000,
        })
        .unwrap();

        conversations::create(Conversation {
            conversation_id,
            collaboration_session_id: session_id,
            chat_id,
            parent_id: None,
            name: None,
            mode: "agent".to_string(),
            participant_role: "peer".to_string(),
            status: "ready".to_string(),
            created_at: 1000,
            updated_at: 1000,
        })
        .unwrap();

        let empty = messages::get_last(conversation_id).unwrap();
        assert!(empty.is_none());

        let mut last_msg = None;
        for i in 0..3 {
            let msg = messages::append(
                conversation_id,
                "user",
                serde_json::json!([{ "type": "text", "text": format!("Message {}", i) }]),
                serde_json::json!({ "index": i }),
                None,
            )
            .unwrap();
            last_msg = Some(msg);
        }

        let last = messages::get_last(conversation_id).unwrap();
        assert!(last.is_some());
        let last = last.unwrap();
        assert_eq!(last.message_id, last_msg.unwrap().message_id);

        workspaces::delete(workspace_id).unwrap();
    }

    #[test]
    fn test_mcp_servers_crud() {
        let _guard = lock_user_data_db_for_tests();

        // Create global MCP server (profile_id = None)
        let global_server = mcp_servers::create(McpServer {
            id: ergatai_core::id::generate(),
            profile_id: None,
            name: "global-mcp".to_string(),
            server_type: "stdio".to_string(),
            command: Some("npx".to_string()),
            args: Vec::new(),
            env: HashMap::new(),
            url: None,
            headers: HashMap::new(),
            enabled: true,
            created_at: 1000,
            updated_at: 1000,
        })
        .unwrap();

        // Create profile-specific MCP server
        let profile_server = mcp_servers::create(McpServer {
            id: ergatai_core::id::generate(),
            profile_id: Some("agent_123".to_string()),
            name: "profile-mcp".to_string(),
            server_type: "http".to_string(),
            command: None,
            args: Vec::new(),
            env: HashMap::new(),
            url: Some("http://localhost:3000".to_string()),
            headers: HashMap::new(),
            enabled: true,
            created_at: 1000,
            updated_at: 1000,
        })
        .unwrap();

        // Read by ID
        let fetched = mcp_servers::get(global_server.id).unwrap().unwrap();
        assert_eq!(fetched.name, "global-mcp");
        assert!(fetched.profile_id.is_none());

        // Read by profile and name
        let fetched_by_profile =
            mcp_servers::get_by_profile_and_name(Some("agent_123"), "profile-mcp")
                .unwrap()
                .unwrap();
        assert_eq!(fetched_by_profile.id, profile_server.id);

        // List all
        let all = mcp_servers::list().unwrap();
        assert!(all.len() >= 2);

        // List by profile
        let profile_servers = mcp_servers::list_by_profile(Some("agent_123")).unwrap();
        assert_eq!(profile_servers.len(), 1);
        assert_eq!(profile_servers[0].name, "profile-mcp");

        // List enabled for profile (should include both profile-specific and global)
        let enabled_for_profile = mcp_servers::list_enabled_for_profile(Some("agent_123")).unwrap();
        assert!(enabled_for_profile.len() >= 2);

        // Update
        let mut updated_server = fetched;
        updated_server.enabled = false;
        updated_server.updated_at = 2000;
        mcp_servers::update(updated_server.clone()).unwrap();

        let refetched = mcp_servers::get(global_server.id).unwrap().unwrap();
        assert!(!refetched.enabled);
        assert_eq!(refetched.updated_at, 2000);

        // Delete by profile
        let deleted_count = mcp_servers::delete_by_profile("agent_123").unwrap();
        assert_eq!(deleted_count, 1);

        // Verify profile server is deleted
        let not_found = mcp_servers::get(profile_server.id).unwrap();
        assert!(not_found.is_none());

        // Delete global server
        let deleted = mcp_servers::delete(global_server.id).unwrap();
        assert!(deleted);

        let not_found = mcp_servers::get(global_server.id).unwrap();
        assert!(not_found.is_none());
    }
}
