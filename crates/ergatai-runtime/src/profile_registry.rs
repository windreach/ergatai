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
//! let registration = AgentRegistration::new(
//!     "my-claude".to_string(),
//!     "npx @anthropic/claude-acp".to_string(),
//!     "acp".to_string(),
//! );
//! registry.register(registration).await?;
//!
//! // Spawn from profile
//! let loaded = registry.get("my-claude").await?;
//! # Ok(())
//! # }
//! ```

use std::path::Path;
use std::sync::Arc;
use tokio::process::Command;
use tokio::sync::Mutex;

use chrono::{DateTime, Utc};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use tracing::{debug, info, warn};

use ergatai_error::id::{format as format_id, generate, IdType};
use ergatai_error::{ErgataiError, ErgataiResult};

use crate::{agent_installer, binary_detection};

/// Global lock to prevent concurrent adapter downloads.
/// Multiple concurrent downloads cause TOCTOU races on the staging directory.
static ADAPTER_DOWNLOAD_LOCK: std::sync::LazyLock<Arc<Mutex<()>>> =
    std::sync::LazyLock::new(|| Arc::new(Mutex::new(())));

/// User-registered agent template.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentRegistration {
    /// Profile ID (stable identifier, primary key).
    pub id: String,
    /// Profile name (user-friendly display name, can be changed).
    pub name: String,
    /// Command to start the agent (e.g., "python3 agent.py" or "npx @anthropic/claude-acp").
    pub command: String,
    /// Agent type: "acp" or "mcp" (future).
    pub agent_type: String,
    /// Transport type: "stdio" (default), "http" (for agents like opencode), or "adapter".
    pub transport: Option<String>,
    /// Whether this is a managed adapter (version-checked and auto-updated).
    pub is_managed: bool,
    /// NPM package name for install/uninstall (e.g., "@anthropic-ai/claude-code").
    /// None for agents that are not installed via npm.
    pub package_name: Option<String>,
    /// Avatar URL (data URL or HTTP URL) for UI display.
    pub avatar_url: Option<String>,
    /// When the profile was registered.
    pub created_at: DateTime<Utc>,
}

impl AgentRegistration {
    /// Create a new agent registration with the current timestamp.
    /// Generates a unique ID for the id field.
    pub fn new(name: String, command: String, agent_type: String) -> Self {
        Self {
            id: format_id(generate(), IdType::Agent),
            name,
            command,
            agent_type,
            package_name: None,
            transport: None,
            is_managed: false,
            avatar_url: None,
            created_at: Utc::now(),
        }
    }

    /// Create a new agent registration with an npm package name.
    pub fn with_package_name(
        name: String,
        command: String,
        agent_type: String,
        package_name: Option<String>,
    ) -> Self {
        Self {
            id: format_id(generate(), IdType::Agent),
            name,
            command,
            agent_type,
            package_name,
            transport: None,
            is_managed: false,
            avatar_url: None,
            created_at: Utc::now(),
        }
    }

    /// Create a new agent registration with an avatar URL.
    pub fn with_avatar_url(
        name: String,
        command: String,
        agent_type: String,
        package_name: Option<String>,
        avatar_url: Option<String>,
    ) -> Self {
        Self {
            id: format_id(generate(), IdType::Agent),
            name,
            command,
            agent_type,
            package_name,
            transport: None,
            is_managed: false,
            avatar_url,
            created_at: Utc::now(),
        }
    }

    /// Create a new agent registration with a specific ID (for migrations/defaults).
    pub fn with_id(
        id: String,
        name: String,
        command: String,
        agent_type: String,
        package_name: Option<String>,
    ) -> Self {
        Self {
            id,
            name,
            command,
            agent_type,
            package_name,
            transport: None,
            is_managed: false,
            avatar_url: None,
            created_at: Utc::now(),
        }
    }

    /// Create a new agent registration with a specific ID and transport type.
    pub fn with_id_and_transport(
        id: String,
        name: String,
        command: String,
        agent_type: String,
        package_name: Option<String>,
        transport: Option<String>,
    ) -> Self {
        Self {
            id,
            name,
            command,
            agent_type,
            package_name,
            transport,
            is_managed: false,
            avatar_url: None,
            created_at: Utc::now(),
        }
    }

    /// Create a new managed adapter registration.
    pub fn with_managed(
        id: String,
        name: String,
        command: String,
        agent_type: String,
        package_name: Option<String>,
    ) -> Self {
        Self {
            id,
            name,
            command,
            agent_type,
            package_name,
            transport: None,
            is_managed: true,
            avatar_url: None,
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

/// Agent profile with installation status — used by the API to report
/// whether each registered agent's binary is currently available on the system.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProfileWithStatus {
    /// Profile ID (stable identifier).
    pub id: String,
    /// Profile name (user-friendly display name).
    pub name: String,
    /// Command to start the agent.
    pub command: String,
    /// Agent type: "acp" or "mcp".
    pub agent_type: String,
    /// Transport type: "stdio", "http", or "adapter".
    pub transport: Option<String>,
    /// Whether this adapter is managed by the adapter manager.
    pub is_managed: bool,
    /// NPM package name (if installable via npm).
    pub package_name: Option<String>,
    /// Avatar URL for UI display.
    pub avatar_url: Option<String>,
    /// Whether the agent's binary is currently detected on the system.
    pub installed: bool,
    /// When the profile was registered (RFC3339 string).
    pub created_at: String,
}

/// SQLite-backed registry for agent profiles.
pub struct ProfileRegistry {
    db_path: String,
}

impl ProfileRegistry {
    /// Create a new profile registry at the given path.
    /// Registers default built-in profiles on first call.
    pub fn new<P: AsRef<Path>>(db_path: P) -> ErgataiResult<Self> {
        let db_path = db_path.as_ref().to_string_lossy().to_string();
        Self::new_inner(db_path, true)
    }

    /// Internal constructor.
    /// `register_defaults`: whether to register default profiles (false for background tasks).
    fn new_inner(db_path: String, register_defaults: bool) -> ErgataiResult<Self> {
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
        registry.init_db(register_defaults)?;
        Ok(registry)
    }

    /// Initialize the database schema.
    /// `register_defaults`: whether to register default profiles (false for background tasks).
    fn init_db(&self, register_defaults: bool) -> ErgataiResult<()> {
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
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                command TEXT NOT NULL,
                agent_type TEXT NOT NULL,
                transport TEXT,
                is_managed INTEGER NOT NULL DEFAULT 0,
                package_name TEXT,
                avatar_url TEXT,
                created_at TEXT NOT NULL
            )",
            [],
        )
        .map_err(|e| {
            ErgataiError::internal(format!("Failed to create agent_registrations table: {}", e))
        })?;

        // Incremental migrations for existing databases.
        // Old schema used `name` as PRIMARY KEY without `id`, `package_name`, or `avatar_url` columns.
        // Check if migration is needed by looking for the `id` column.
        let has_id_column = conn
            .prepare("PRAGMA table_info(agent_registrations)")
            .and_then(|mut stmt| {
                let rows = stmt.query_map([], |row| row.get::<_, String>(1))?;
                let columns: Vec<String> = rows.collect::<Result<Vec<_>, _>>()?;
                Ok(columns.contains(&"id".to_string()))
            })
            .unwrap_or(false);

        if !has_id_column {
            // Migrate old schema: recreate table with new schema and migrate data.
            // Old schema: PRIMARY KEY was `name`, no `id`, `package_name`, or `avatar_url` columns.
            conn.execute_batch(
                "
                -- Create temporary table with old data
                CREATE TEMPORARY TABLE IF NOT EXISTS agent_registrations_backup AS
                SELECT name, command, agent_type, created_at FROM agent_registrations;

                -- Drop old table
                DROP TABLE agent_registrations;

                -- Recreate with new schema
                CREATE TABLE agent_registrations (
                    id TEXT PRIMARY KEY,
                    name TEXT NOT NULL,
                    command TEXT NOT NULL,
                    agent_type TEXT NOT NULL,
                    transport TEXT,
                    is_managed INTEGER NOT NULL DEFAULT 0,
                    package_name TEXT,
                    avatar_url TEXT,
                    created_at TEXT NOT NULL
                );

                -- Migrate data: use name as id for backward compatibility
                INSERT INTO agent_registrations (id, name, command, agent_type, transport, is_managed, package_name, avatar_url, created_at)
                SELECT name, name, command, agent_type, NULL, NULL, NULL, created_at
                FROM agent_registrations_backup;

                -- Clean up temporary table
                DROP TABLE agent_registrations_backup;
                ",
            )
            .map_err(|e| {
                ErgataiError::internal(format!("Failed to migrate agent_registrations schema: {}", e))
            })?;
            info!("Migrated agent_registrations table to new schema with id, package_name, avatar_url columns");
        } else {
            // Table has id column, but may be missing package_name or avatar_url (intermediate versions).
            // Add them if missing (idempotent - SQLite ignores errors if column already exists).
            if let Err(e) =
                conn.execute_batch("ALTER TABLE agent_registrations ADD COLUMN package_name TEXT")
            {
                if !e.to_string().contains("duplicate column name") {
                    warn!(error = %e, "Failed to add package_name column");
                }
            }
            if let Err(e) =
                conn.execute_batch("ALTER TABLE agent_registrations ADD COLUMN avatar_url TEXT")
            {
                if !e.to_string().contains("duplicate column name") {
                    warn!(error = %e, "Failed to add avatar_url column");
                }
            }
        }

        debug!(
            "Profile registry initialized at {} (WAL mode)",
            self.db_path
        );

        // Register default built-in profiles FIRST (use current version)
        // Only on initial construction, not for background tasks (to avoid recursive spawn).
        if register_defaults {
            self.register_default_profiles()?;
        }

        // SECURITY: Background adapter auto-update is OPT-IN.
        //
        // When enabled, every startup runs `git fetch` + `git pull` in each
        // adapter directory. This is a supply-chain risk: if an upstream adapter
        // repo is compromised, ergatai pulls malicious code automatically. It
        // also adds latency on air-gapped or slow networks (git fetch timeout).
        //
        // Opt in explicitly with ERGATAI_ADAPTERS_AUTO_UPDATE=1 when you accept
        // these trade-offs (e.g., dev environments with trusted upstreams).
        let auto_update = std::env::var("ERGATAI_ADAPTERS_AUTO_UPDATE")
            .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
            .unwrap_or(false);

        if auto_update {
            // Check for updates in BACKGROUND (non-blocking).
            // Updates will be ready for NEXT startup.
            let adapters_base = Self::resolve_adapters_base();
            let db_path = self.db_path.clone();
            tokio::spawn(async move {
                // Create a temporary registry instance for background update.
                // Use new_inner(..., false) to skip default registration (avoid recursive spawn).
                if let Ok(registry) = Self::new_inner(db_path, false) {
                    if let Err(e) = registry
                        .check_and_update_adapters_background(&adapters_base)
                        .await
                    {
                        warn!(error = %e, "Background adapter update failed");
                    }
                }
            });
        } else {
            debug!("Adapter auto-update disabled (set ERGATAI_ADAPTERS_AUTO_UPDATE=1 to enable)");
        }

        Ok(())
    }

    /// Register built-in default agent profiles.
    ///
    /// Commands verified from official documentation:
    /// - OpenCode: https://opencode.ai/docs/acp/
    /// - Gemini CLI: https://geminicli.com/docs/cli/acp-mode/
    /// - Goose: https://goose-docs.ai/docs/guides/acp-clients/
    /// - ACP Registry: https://agentclientprotocol.com/get-started/agents
    fn register_default_profiles(&self) -> ErgataiResult<()> {
        // Check if managed adapter releases exist. If so, point profiles at the
        // current managed release. Otherwise, skip managed adapters (they will be
        // registered by adapter_manager after first install completes).
        let adapters_base = Self::resolve_adapters_base();
        let managed_base = adapters_base.join("managed");
        let current_release_dir = Self::find_current_managed_release(&managed_base);

        if let Some(release_dir) = &current_release_dir {
            // Point to managed release
            let claude_cmd = format!(
                "node {}",
                release_dir
                    .join("node_modules/@zed-industries/claude-code-acp/dist/index.js")
                    .display()
            );
            let codex_cmd = format!(
                "node {}",
                release_dir
                    .join("node_modules/@agentclientprotocol/codex-acp/dist/index.js")
                    .display()
            );
            info!(
                release = %release_dir.display(),
                "Registering managed adapter profiles"
            );

            self.register_all_default_profiles(&claude_cmd, &codex_cmd)
        } else {
            // No managed release yet - spawn async download task
            info!("No managed adapter release found; spawning async download task...");
            let db_path = self.db_path.clone();
            tokio::spawn(async move {
                // Use new_inner(..., false) to skip default registration (avoid recursive spawn).
                let registry = Self::new_inner(db_path, false).expect("Failed to open registry");
                match registry
                    .download_and_install_adapters_async(managed_base)
                    .await
                {
                    Ok(release_dir) => {
                        let claude_cmd = format!(
                            "node {}",
                            release_dir
                                .join("node_modules/@zed-industries/claude-code-acp/dist/index.js")
                                .display()
                        );
                        let codex_cmd = format!(
                            "node {}",
                            release_dir
                                .join("node_modules/@agentclientprotocol/codex-acp/dist/index.js")
                                .display()
                        );
                        if let Err(e) =
                            registry.register_all_default_profiles(&claude_cmd, &codex_cmd)
                        {
                            warn!(error = %e, "Failed to register managed adapter profiles");
                        } else {
                            info!("Managed adapter profiles registered after download");
                        }
                    }
                    Err(e) => {
                        warn!(error = %e, "Failed to download adapters asynchronously");
                    }
                }
            });
            // Register non-managed profiles immediately
            self.register_non_managed_default_profiles()
        }
    }

    /// Synchronous version of register for use during initialization.
    fn register_sync(&self, registration: AgentRegistration) -> ErgataiResult<()> {
        registration.validate()?;

        let conn = Connection::open(&self.db_path).map_err(|e| {
            ErgataiError::internal(format!("Failed to open profile registry database: {}", e))
        })?;

        conn.execute(
            "INSERT OR IGNORE INTO agent_registrations (id, name, command, agent_type, transport, is_managed, package_name, avatar_url, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                registration.id,
                registration.name,
                registration.command,
                registration.agent_type,
                registration.transport,
                registration.is_managed as i32,
                registration.package_name,
                registration.avatar_url,
                registration.created_at.to_rfc3339()
            ],
        )
        .map_err(|e| {
            ErgataiError::internal(format!("Failed to register agent profile: {}", e))
        })?;

        Ok(())
    }

    /// Register a new agent profile.
    pub async fn register(&self, registration: AgentRegistration) -> ErgataiResult<()> {
        registration.validate()?;

        let conn = Connection::open(&self.db_path).map_err(|e| {
            ErgataiError::internal(format!("Failed to open profile registry database: {}", e))
        })?;

        conn.execute(
            "INSERT INTO agent_registrations (id, name, command, agent_type, transport, is_managed, package_name, avatar_url, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                registration.id,
                registration.name,
                registration.command,
                registration.agent_type,
                registration.transport,
                registration.is_managed as i32,
                registration.package_name,
                registration.avatar_url,
                registration.created_at.to_rfc3339()
            ],
        )
        .map_err(|e| {
            if e.to_string().contains("UNIQUE constraint failed") {
                ErgataiError::InvalidArgument(format!(
                    "Agent profile with id '{}' already exists",
                    registration.id
                ))
            } else {
                ErgataiError::internal(format!("Failed to register agent profile: {}", e))
            }
        })?;

        info!(id = %registration.id, name = %registration.name, agent_type = %registration.agent_type, "Registered agent profile");
        Ok(())
    }

    /// Get a profile by ID.
    pub async fn get(&self, id: &str) -> ErgataiResult<Option<AgentRegistration>> {
        let conn = Connection::open(&self.db_path).map_err(|e| {
            ErgataiError::internal(format!("Failed to open profile registry database: {}", e))
        })?;

        let mut stmt = conn
            .prepare(
                "SELECT id, name, command, agent_type, transport, is_managed, package_name, avatar_url, created_at
                 FROM agent_registrations WHERE id = ?1",
            )
            .map_err(|e| ErgataiError::internal(format!("Failed to prepare query: {}", e)))?;

        let result = stmt
            .query_row(params![id], parse_agent_registration_row)
            .optional()
            .map_err(|e| ErgataiError::internal(format!("Failed to get agent profile: {}", e)))?;

        Ok(result)
    }

    /// Get a profile by name (convenience method for backward compatibility).
    pub async fn get_by_name(&self, name: &str) -> ErgataiResult<Option<AgentRegistration>> {
        let conn = Connection::open(&self.db_path).map_err(|e| {
            ErgataiError::internal(format!("Failed to open profile registry database: {}", e))
        })?;

        let mut stmt = conn
            .prepare(
                "SELECT id, name, command, agent_type, transport, is_managed, package_name, avatar_url, created_at
                 FROM agent_registrations WHERE name = ?1",
            )
            .map_err(|e| ErgataiError::internal(format!("Failed to prepare query: {}", e)))?;

        let result = stmt
            .query_row(params![name], parse_agent_registration_row)
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
                "SELECT id, name, command, agent_type, transport, is_managed, package_name, avatar_url, created_at
                 FROM agent_registrations ORDER BY created_at DESC",
            )
            .map_err(|e| ErgataiError::internal(format!("Failed to prepare query: {}", e)))?;

        let profiles = stmt
            .query_map([], parse_agent_registration_row)
            .map_err(|e| ErgataiError::internal(format!("Failed to list agent profiles: {}", e)))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| {
                ErgataiError::internal(format!("Failed to collect agent profiles: {}", e))
            })?;

        Ok(profiles)
    }

    /// Delete a profile by ID.
    pub async fn delete(&self, id: &str) -> ErgataiResult<bool> {
        let conn = Connection::open(&self.db_path).map_err(|e| {
            ErgataiError::internal(format!("Failed to open profile registry database: {}", e))
        })?;

        let rows_affected = conn
            .execute("DELETE FROM agent_registrations WHERE id = ?1", params![id])
            .map_err(|e| {
                ErgataiError::internal(format!("Failed to delete agent profile: {}", e))
            })?;

        if rows_affected > 0 {
            info!(id = %id, "Deleted agent profile");
        }

        Ok(rows_affected > 0)
    }

    /// Check and update adapters in background (non-blocking).
    ///
    /// This method is called after system startup to check for updates.
    /// Updates happen asynchronously so they don't delay system startup.
    /// Updated adapters will be used on NEXT system startup.
    ///
    /// `adapters_base` must be the same directory that `register_default_profiles`
    /// resolved, so this function inspects the adapters that were actually registered.
    pub async fn check_and_update_adapters_background(
        &self,
        adapters_base: &std::path::Path,
    ) -> ErgataiResult<()> {
        let adapters_dir = adapters_base;

        if !adapters_dir.exists() {
            debug!(
                path = %adapters_dir.display(),
                "Adapters directory not found, skipping background update"
            );
            return Ok(());
        }

        info!("Starting background adapter update check...");

        let mut updated_count = 0;
        let mut checked_count = 0;

        // Check each adapter directory
        if let Ok(entries) = std::fs::read_dir(adapters_dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_dir() && path.join("package.json").exists() {
                    if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
                        checked_count += 1;
                        match self.update_adapter_if_needed(&path, name).await {
                            Ok(true) => {
                                updated_count += 1;
                                info!(adapter = %name, "Adapter updated in background");
                            }
                            Ok(false) => {
                                debug!(adapter = %name, "Adapter is up-to-date");
                            }
                            Err(e) => {
                                warn!(adapter = %name, error = %e, "Failed to update adapter");
                            }
                        }
                    }
                }
            }
        }

        if updated_count > 0 {
            info!(
                updated = updated_count,
                total = checked_count,
                "Background adapter updates complete (will use on next startup)"
            );
        } else {
            info!(total = checked_count, "All adapters are up-to-date");
        }

        Ok(())
    }

    /// Resolve the base directory for adapters.
    ///
    /// Priority:
    ///   1. `ERGATAI_ADAPTERS_DIR` env var (explicit override)
    ///   2. `<current_exe>/../adapters` (production layout: target/<profile>/ergatai-api → adapters/)
    ///   3. `./adapters` (fallback for source/dev)
    ///
    /// This helper is shared by `register_default_profiles` and
    /// `check_and_update_adapters_background` so they always point at the same
    /// adapters directory — fixing a prior inconsistency where one used
    /// `current_exe` and the other used `current_dir`.
    fn resolve_adapters_base() -> std::path::PathBuf {
        Self::resolve_adapters_base_public()
    }

    /// Public wrapper for `resolve_adapters_base` so other modules can access it.
    pub fn resolve_adapters_base_public() -> std::path::PathBuf {
        crate::dirs::adapters_base_dir()
    }

    /// Register default profiles that are NOT managed adapters.
    /// Called when no managed release exists yet (first startup).
    fn register_non_managed_default_profiles(&self) -> ErgataiResult<()> {
        let defaults = vec![
            // OpenCode (已验证 - https://opencode.ai/docs/acp/)
            AgentRegistration::with_id_and_transport(
                "opencode".to_string(),
                "opencode".to_string(),
                "opencode acp".to_string(),
                "acp".to_string(),
                Some("opencode-ai".to_string()),
                Some("http".to_string()), // OpenCode uses HTTP server mode
            ),
            // Gemini CLI (已验证 - https://geminicli.com/docs/cli/acp-mode/)
            AgentRegistration::with_id(
                "gemini".to_string(),
                "gemini".to_string(),
                "gemini --acp".to_string(),
                "acp".to_string(),
                Some("@anthropic-ai/claude-code".to_string()),
            ),
            // Goose (已验证 - https://goose-docs.ai/docs/guides/acp-clients/)
            AgentRegistration::with_id(
                "goose".to_string(),
                "goose".to_string(),
                "goose run --acp".to_string(),
                "acp".to_string(),
                None,
            ),
            // Cline (已验证 - ACP registry)
            AgentRegistration::with_id(
                "cline".to_string(),
                "cline".to_string(),
                "cline --acp".to_string(),
                "acp".to_string(),
                None,
            ),
            // Kiro CLI (已验证 - ACP registry)
            AgentRegistration::with_id(
                "kiro".to_string(),
                "kiro".to_string(),
                "kiro-cli acp".to_string(),
                "acp".to_string(),
                None,
            ),
            // Auggie CLI (已验证 - ACP registry)
            AgentRegistration::with_id(
                "auggie".to_string(),
                "auggie".to_string(),
                "auggie --acp".to_string(),
                "acp".to_string(),
                None,
            ),
            // OpenClaw (已验证 - ACP registry)
            AgentRegistration::with_id(
                "openclaw".to_string(),
                "openclaw".to_string(),
                "openclaw acp".to_string(),
                "acp".to_string(),
                None,
            ),
            // Hermes Agent (已验证 - ACP registry)
            AgentRegistration::with_id(
                "hermes".to_string(),
                "hermes".to_string(),
                "hermes acp".to_string(),
                "acp".to_string(),
                None,
            ),
        ];

        info!(
            count = defaults.len(),
            "Registering non-managed default agent profiles"
        );
        for profile in defaults {
            self.register_sync(profile)?;
        }
        Ok(())
    }

    /// Register all default profiles including managed adapters.
    fn register_all_default_profiles(
        &self,
        claude_cmd: &str,
        codex_cmd: &str,
    ) -> ErgataiResult<()> {
        let defaults = vec![
            // OpenAI Codex CLI adapter (managed)
            AgentRegistration::with_managed(
                "codex".to_string(),
                "codex".to_string(),
                codex_cmd.to_string(),
                "acp".to_string(),
                Some("@agentclientprotocol/codex-acp".to_string()),
            ),
            // Anthropic Claude Agent adapter (managed)
            AgentRegistration::with_managed(
                "claude-code".to_string(),
                "claude-code".to_string(),
                claude_cmd.to_string(),
                "acp".to_string(),
                Some("@zed-industries/claude-code-acp".to_string()),
            ),
            // OpenCode (已验证 - https://opencode.ai/docs/acp/)
            AgentRegistration::with_id_and_transport(
                "opencode".to_string(),
                "opencode".to_string(),
                "opencode acp".to_string(),
                "acp".to_string(),
                Some("opencode-ai".to_string()),
                Some("http".to_string()),
            ),
            // Gemini CLI (已验证 - https://geminicli.com/docs/cli/acp-mode/)
            AgentRegistration::with_id(
                "gemini".to_string(),
                "gemini".to_string(),
                "gemini --acp".to_string(),
                "acp".to_string(),
                Some("@anthropic-ai/claude-code".to_string()),
            ),
            // Goose (已验证 - https://goose-docs.ai/docs/guides/acp-clients/)
            AgentRegistration::with_id(
                "goose".to_string(),
                "goose".to_string(),
                "goose run --acp".to_string(),
                "acp".to_string(),
                None,
            ),
            // Cline (已验证 - ACP registry)
            AgentRegistration::with_id(
                "cline".to_string(),
                "cline".to_string(),
                "cline --acp".to_string(),
                "acp".to_string(),
                None,
            ),
            // Kiro CLI (已验证 - ACP registry)
            AgentRegistration::with_id(
                "kiro".to_string(),
                "kiro".to_string(),
                "kiro-cli acp".to_string(),
                "acp".to_string(),
                None,
            ),
            // Auggie CLI (已验证 - ACP registry)
            AgentRegistration::with_id(
                "auggie".to_string(),
                "auggie".to_string(),
                "auggie --acp".to_string(),
                "acp".to_string(),
                None,
            ),
            // OpenClaw (已验证 - ACP registry)
            AgentRegistration::with_id(
                "openclaw".to_string(),
                "openclaw".to_string(),
                "openclaw acp".to_string(),
                "acp".to_string(),
                None,
            ),
            // Hermes Agent (已验证 - ACP registry)
            AgentRegistration::with_id(
                "hermes".to_string(),
                "hermes".to_string(),
                "hermes acp".to_string(),
                "acp".to_string(),
                None,
            ),
        ];

        info!(count = defaults.len(), "Registering default agent profiles");
        for profile in defaults {
            if let Err(e) = self.register_sync(profile.clone()) {
                if !e.to_string().contains("already exists") {
                    debug!(id = %profile.id, name = %profile.name, error = %e, "Failed to register default profile");
                }
            } else {
                info!(id = %profile.id, name = %profile.name, command = %profile.command, "Registered default agent profile");
            }
        }
        Ok(())
    }

    /// Asynchronously download and install adapters.
    /// Returns the release directory on success.
    async fn download_and_install_adapters_async(
        &self,
        managed_base: std::path::PathBuf,
    ) -> ErgataiResult<std::path::PathBuf> {
        use tokio::process::Command;

        // Acquire global lock to prevent concurrent downloads.
        // Multiple concurrent downloads cause TOCTOU races on the staging directory.
        let _guard = ADAPTER_DOWNLOAD_LOCK.lock().await;

        info!("Starting async adapter download...");

        // Create staging directory
        let staging = managed_base.join("staging");
        // Ignore "not found" error - staging may not exist.
        let _ = tokio::fs::remove_dir_all(&staging).await;
        tokio::fs::create_dir_all(&staging)
            .await
            .map_err(|e| ErgataiError::internal(format!("Failed to create staging dir: {}", e)))?;

        // Initialize package.json so npm install works correctly.
        // Without this, npm may report "up to date" without actually installing.
        let init_output = Command::new("npm")
            .args(["init", "-y"])
            .current_dir(&staging)
            .output()
            .await
            .map_err(|e| ErgataiError::internal(format!("Failed to run npm init: {}", e)))?;
        if !init_output.status.success() {
            let stderr = String::from_utf8_lossy(&init_output.stderr);
            return Err(ErgataiError::internal(format!(
                "npm init failed: {}",
                stderr
            )));
        }

        // Install adapters
        let adapters = vec![
            "@zed-industries/claude-code-acp",
            "@agentclientprotocol/codex-acp",
        ];

        for package in &adapters {
            info!(package = %package, "Installing adapter package...");
            let output = Command::new("npm")
                .args([
                    "install",
                    "--no-audit",
                    "--no-fund",
                    "--loglevel=error",
                    package,
                ])
                .current_dir(&staging)
                .output()
                .await
                .map_err(|e| ErgataiError::internal(format!("Failed to run npm install: {}", e)))?;

            if !output.status.success() {
                let stderr = String::from_utf8_lossy(&output.stderr);
                let stdout = String::from_utf8_lossy(&output.stdout);
                return Err(ErgataiError::internal(format!(
                    "npm install {} failed (exit {:?}): stderr={}, stdout={}",
                    package,
                    output.status.code(),
                    stderr.trim(),
                    stdout.trim()
                )));
            }
            debug!(
                package = %package,
                stdout = %String::from_utf8_lossy(&output.stdout).trim(),
                "npm install succeeded"
            );
        }

        // Verify installation
        let claude_dist =
            staging.join("node_modules/@zed-industries/claude-code-acp/dist/index.js");
        let codex_dist = staging.join("node_modules/@agentclientprotocol/codex-acp/dist/index.js");

        if !claude_dist.exists() {
            return Err(ErgataiError::internal(format!(
                "Claude adapter dist not found: {}",
                claude_dist.display()
            )));
        }
        if !codex_dist.exists() {
            return Err(ErgataiError::internal(format!(
                "Codex adapter dist not found: {}",
                codex_dist.display()
            )));
        }

        // Create release directory
        let release_id = chrono::Utc::now().format("%Y%m%d-%H%M%S").to_string();
        let releases_dir = managed_base.join("releases");
        tokio::fs::create_dir_all(&releases_dir)
            .await
            .map_err(|e| ErgataiError::internal(format!("Failed to create releases dir: {}", e)))?;
        let release_dir = releases_dir.join(&release_id);
        tokio::fs::rename(&staging, &release_dir)
            .await
            .map_err(|e| {
                ErgataiError::internal(format!("Failed to promote staging to release: {}", e))
            })?;

        // Update current pointer
        let current_pointer = managed_base.join("current");
        tokio::fs::write(&current_pointer, &release_id)
            .await
            .map_err(|e| {
                ErgataiError::internal(format!("Failed to write current pointer: {}", e))
            })?;

        info!(
            release = %release_id,
            "Adapters downloaded and installed successfully"
        );

        Ok(release_dir)
    }

    /// Find the current managed adapter release directory.
    fn find_current_managed_release(managed_base: &std::path::Path) -> Option<std::path::PathBuf> {
        let current_pointer = managed_base.join("current");
        let release_id = std::fs::read_to_string(&current_pointer)
            .ok()?
            .trim()
            .to_string();
        if release_id.is_empty() {
            return None;
        }
        let release_dir = managed_base.join("releases").join(&release_id);
        release_dir.is_dir().then_some(release_dir)
    }

    /// Check if an adapter needs updating and perform the update.
    /// Returns Ok(true) if updated, Ok(false) if no update needed.
    async fn update_adapter_if_needed(
        &self,
        adapter_path: &std::path::Path,
        adapter_name: &str,
    ) -> ErgataiResult<bool> {
        // Check if git is available and this is a git repo
        let git_check = Command::new("git")
            .arg("rev-parse")
            .arg("--git-dir")
            .current_dir(adapter_path)
            .output()
            .await;

        if git_check.is_err() || !git_check.unwrap().status.success() {
            debug!(adapter = %adapter_name, "Not a git repository, skipping update check");
            return Ok(false);
        }

        // Fetch latest changes
        let fetch_result = Command::new("git")
            .args(["fetch", "--tags", "--quiet"])
            .current_dir(adapter_path)
            .output()
            .await;

        if fetch_result.is_err() || !fetch_result.unwrap().status.success() {
            warn!(adapter = %adapter_name, "Failed to fetch updates");
            return Ok(false);
        }

        // Get current version
        let current = Command::new("git")
            .args(["describe", "--tags", "--abbrev=0"])
            .current_dir(adapter_path)
            .output()
            .await
            .ok()
            .and_then(|o| String::from_utf8(o.stdout).ok())
            .unwrap_or_default()
            .trim()
            .to_string();

        // Get latest version
        let latest = Command::new("git")
            .args(["describe", "--tags", "--abbrev=0", "origin/HEAD"])
            .current_dir(adapter_path)
            .output()
            .await
            .ok()
            .and_then(|o| String::from_utf8(o.stdout).ok())
            .unwrap_or_default()
            .trim()
            .to_string();

        if current != latest && !latest.is_empty() && latest != "unknown" {
            info!(
                adapter = %adapter_name,
                current = %current,
                latest = %latest,
                "Updating adapter"
            );

            // Pull latest changes
            let pull_result = Command::new("git")
                .args(["pull", "--quiet"])
                .current_dir(adapter_path)
                .output()
                .await;

            if pull_result.is_err() || !pull_result.unwrap().status.success() {
                warn!(adapter = %adapter_name, "Failed to pull updates");
                return Ok(false);
            }

            // Reinstall dependencies
            info!(adapter = %adapter_name, "Installing dependencies...");
            let npm_install = Command::new("npm")
                .args(["install"])
                .current_dir(adapter_path)
                .output()
                .await;

            if npm_install.is_err() || !npm_install.unwrap().status.success() {
                warn!(adapter = %adapter_name, "Failed to install dependencies");
                return Ok(false);
            }

            // Rebuild
            info!(adapter = %adapter_name, "Building...");
            let npm_build = Command::new("npm")
                .args(["run", "build"])
                .current_dir(adapter_path)
                .output()
                .await;

            if npm_build.is_err() || !npm_build.unwrap().status.success() {
                warn!(adapter = %adapter_name, "Failed to build");
                return Ok(false);
            }

            info!(adapter = %adapter_name, "Update complete");
            Ok(true)
        } else {
            debug!(adapter = %adapter_name, version = %current, "Adapter is up-to-date");
            Ok(false)
        }
    }

    /// List all registered profiles with their current installation status.
    ///
    /// For each profile, checks whether the agent's binary is detectable on
    /// the system PATH (or at the explicit path in the command).
    pub fn list_with_status(&self) -> ErgataiResult<Vec<ProfileWithStatus>> {
        let conn = Connection::open(&self.db_path).map_err(|e| {
            ErgataiError::internal(format!("Failed to open profile registry database: {}", e))
        })?;

        let mut stmt = conn
            .prepare(
                "SELECT id, name, command, agent_type, transport, is_managed, package_name, avatar_url, created_at
                 FROM agent_registrations ORDER BY created_at DESC",
            )
            .map_err(|e| ErgataiError::internal(format!("Failed to prepare query: {}", e)))?;

        let profiles = stmt
            .query_map([], |row| {
                let created_at_str: String = row.get(8)?;
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, Option<String>>(4)?,
                    row.get::<_, i32>(5)? != 0,
                    row.get::<_, Option<String>>(6)?,
                    row.get::<_, Option<String>>(7)?,
                    created_at_str,
                ))
            })
            .map_err(|e| ErgataiError::internal(format!("Failed to list agent profiles: {}", e)))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| {
                ErgataiError::internal(format!("Failed to collect agent profiles: {}", e))
            })?;

        let result = profiles
            .into_iter()
            .map(
                |(
                    id,
                    name,
                    command,
                    agent_type,
                    transport,
                    is_managed,
                    package_name,
                    avatar_url,
                    created_at,
                )| {
                    let installed = binary_detection::is_installed(&command);
                    ProfileWithStatus {
                        id,
                        name,
                        command,
                        agent_type,
                        transport,
                        is_managed,
                        package_name,
                        avatar_url,
                        installed,
                        created_at,
                    }
                },
            )
            .collect();

        Ok(result)
    }

    /// Install an agent by its profile ID.
    ///
    /// Looks up the profile, extracts the `package_name`, and runs
    /// `npm install -g`. Returns the npm stdout on success.
    ///
    /// # Errors
    /// - Profile not found
    /// - Profile has no `package_name` (not npm-installable)
    /// - npm install fails
    pub async fn install(&self, id: &str) -> ErgataiResult<String> {
        let profile = self
            .get(id)
            .await?
            .ok_or_else(|| ErgataiError::InvalidArgument(format!("Profile '{}' not found", id)))?;

        let package_name = profile.package_name.ok_or_else(|| {
            ErgataiError::InvalidArgument(format!(
                "Profile '{}' has no package_name — cannot be installed via npm",
                id
            ))
        })?;

        agent_installer::install_and_verify(&profile.command, &package_name).await
    }

    /// Uninstall an agent by its profile ID.
    ///
    /// Looks up the profile, extracts the `package_name`, and runs
    /// `npm uninstall -g`. Returns the npm stdout on success.
    pub async fn uninstall(&self, id: &str) -> ErgataiResult<String> {
        let profile = self
            .get(id)
            .await?
            .ok_or_else(|| ErgataiError::InvalidArgument(format!("Profile '{}' not found", id)))?;

        let package_name = profile.package_name.ok_or_else(|| {
            ErgataiError::InvalidArgument(format!(
                "Profile '{}' has no package_name — cannot be uninstalled via npm",
                id
            ))
        })?;

        agent_installer::uninstall_npm(&package_name).await
    }
}

/// Parse a database row into an AgentRegistration struct.
/// Used by both `get` and `list` methods.
fn parse_agent_registration_row(row: &rusqlite::Row) -> rusqlite::Result<AgentRegistration> {
    let created_at_str: String = row.get(8)?;
    let created_at = DateTime::parse_from_rfc3339(&created_at_str)
        .map(|dt| dt.with_timezone(&Utc))
        .unwrap_or_else(|_| Utc::now());

    Ok(AgentRegistration {
        id: row.get(0)?,
        name: row.get(1)?,
        command: row.get(2)?,
        agent_type: row.get(3)?,
        transport: row.get(4)?,
        is_managed: row.get::<_, i32>(5)? != 0,
        package_name: row.get(6)?,
        avatar_url: row.get(7)?,
        created_at,
    })
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

        let id = registration.id.clone();
        registry.register(registration.clone()).await.unwrap();

        let loaded = registry.get(&id).await.unwrap().unwrap();
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
        // ProfileRegistry::new() registers default built-in profiles, so the
        // total count is 10 defaults + 2 we just registered. Assert the two
        // expected profiles are present rather than checking an exact count.
        let names: Vec<&str> = profiles.iter().map(|p| p.name.as_str()).collect();
        assert!(names.contains(&"agent-1"), "agent-1 not found in {names:?}");
        assert!(names.contains(&"agent-2"), "agent-2 not found in {names:?}");
        assert!(profiles.len() >= 2);
    }

    #[tokio::test]
    async fn test_delete_registration() {
        let temp_file = NamedTempFile::new().unwrap();
        let registry = ProfileRegistry::new(temp_file.path()).unwrap();

        let registration = AgentRegistration::new(
            "to-delete".to_string(),
            "cmd".to_string(),
            "acp".to_string(),
        );
        let id = registration.id.clone();

        registry.register(registration).await.unwrap();

        assert!(registry.delete(&id).await.unwrap());
        assert!(registry.get(&id).await.unwrap().is_none());
    }

    #[tokio::test]
    async fn test_duplicate_id_error() {
        let temp_file = NamedTempFile::new().unwrap();
        let registry = ProfileRegistry::new(temp_file.path()).unwrap();

        let mut registration = AgentRegistration::new(
            "duplicate".to_string(),
            "cmd1".to_string(),
            "acp".to_string(),
        );

        registry.register(registration.clone()).await.unwrap();

        // Try to register another profile with the same ID
        registration.name = "different-name".to_string();
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

    #[test]
    fn test_validate_empty_command() {
        let reg = AgentRegistration::new("test".to_string(), "".to_string(), "acp".to_string());
        assert!(reg.validate().is_err());
        assert!(reg.validate().unwrap_err().to_string().contains("command"));
    }

    #[test]
    fn test_validate_empty_agent_type() {
        let reg = AgentRegistration::new("test".to_string(), "cmd".to_string(), "".to_string());
        assert!(reg.validate().is_err());
        assert!(reg
            .validate()
            .unwrap_err()
            .to_string()
            .contains("Agent type"));
    }

    #[test]
    fn test_validate_whitespace_only_name() {
        let reg = AgentRegistration::new("   ".to_string(), "cmd".to_string(), "acp".to_string());
        assert!(reg.validate().is_err());
    }

    #[test]
    fn test_validate_whitespace_only_command() {
        let reg = AgentRegistration::new("test".to_string(), "   ".to_string(), "acp".to_string());
        assert!(reg.validate().is_err());
    }

    #[test]
    fn test_validate_mcp_type() {
        let reg = AgentRegistration::new("test".to_string(), "cmd".to_string(), "mcp".to_string());
        assert!(reg.validate().is_ok());
    }

    #[test]
    fn test_validate_case_insensitive_type() {
        let reg = AgentRegistration::new("test".to_string(), "cmd".to_string(), "ACP".to_string());
        assert!(reg.validate().is_ok());

        let reg2 = AgentRegistration::new("test".to_string(), "cmd".to_string(), "Mcp".to_string());
        assert!(reg2.validate().is_ok());
    }

    #[test]
    fn test_builder_methods() {
        let reg = AgentRegistration::with_package_name(
            "test".to_string(),
            "cmd".to_string(),
            "acp".to_string(),
            Some("my-package".to_string()),
        );
        assert_eq!(reg.package_name, Some("my-package".to_string()));
        assert_eq!(reg.name, "test");
        assert_eq!(reg.command, "cmd");
    }

    #[test]
    fn test_builder_with_avatar() {
        let reg = AgentRegistration::with_avatar_url(
            "test".to_string(),
            "cmd".to_string(),
            "acp".to_string(),
            Some("pkg".to_string()),
            Some("https://example.com/avatar.png".to_string()),
        );
        assert_eq!(
            reg.avatar_url,
            Some("https://example.com/avatar.png".to_string())
        );
        assert_eq!(reg.package_name, Some("pkg".to_string()));
    }

    #[test]
    fn test_builder_with_id() {
        let reg = AgentRegistration::with_id(
            "custom-id".to_string(),
            "test".to_string(),
            "cmd".to_string(),
            "acp".to_string(),
            None,
        );
        assert_eq!(reg.id, "custom-id");
        assert!(reg.package_name.is_none());
    }

    #[tokio::test]
    async fn test_get_by_name() {
        let temp_file = NamedTempFile::new().unwrap();
        let registry = ProfileRegistry::new(temp_file.path()).unwrap();

        let registration = AgentRegistration::new(
            "test-agent".to_string(),
            "python3 test.py".to_string(),
            "acp".to_string(),
        );

        registry.register(registration.clone()).await.unwrap();

        // Test get_by_name with existing name
        let loaded = registry.get_by_name("test-agent").await.unwrap().unwrap();
        assert_eq!(loaded.id, registration.id);
        assert_eq!(loaded.name, "test-agent");
        assert_eq!(loaded.command, "python3 test.py");

        // Test get_by_name with non-existent name
        let not_found = registry.get_by_name("non-existent").await.unwrap();
        assert!(not_found.is_none());
    }

    #[tokio::test]
    async fn test_get_by_name_empty_string() {
        let temp_file = NamedTempFile::new().unwrap();
        let registry = ProfileRegistry::new(temp_file.path()).unwrap();

        let not_found = registry.get_by_name("").await.unwrap();
        assert!(not_found.is_none());
    }

    #[tokio::test]
    async fn test_register_with_package_name() {
        let temp_file = NamedTempFile::new().unwrap();
        let registry = ProfileRegistry::new(temp_file.path()).unwrap();

        let registration = AgentRegistration::with_package_name(
            "test-agent".to_string(),
            "python3 test.py".to_string(),
            "acp".to_string(),
            Some("my-package".to_string()),
        );

        registry.register(registration.clone()).await.unwrap();

        let loaded = registry.get(&registration.id).await.unwrap().unwrap();
        assert_eq!(loaded.package_name, Some("my-package".to_string()));
    }

    #[tokio::test]
    async fn test_register_with_avatar_url() {
        let temp_file = NamedTempFile::new().unwrap();
        let registry = ProfileRegistry::new(temp_file.path()).unwrap();

        let registration = AgentRegistration::with_avatar_url(
            "test-agent".to_string(),
            "python3 test.py".to_string(),
            "acp".to_string(),
            Some("my-package".to_string()),
            Some("https://example.com/avatar.png".to_string()),
        );

        registry.register(registration.clone()).await.unwrap();

        let loaded = registry.get(&registration.id).await.unwrap().unwrap();
        assert_eq!(
            loaded.avatar_url,
            Some("https://example.com/avatar.png".to_string())
        );
    }

    #[tokio::test]
    async fn test_delete_non_existent() {
        let temp_file = NamedTempFile::new().unwrap();
        let registry = ProfileRegistry::new(temp_file.path()).unwrap();

        let result = registry.delete("non-existent-id").await.unwrap();
        assert!(!result);
    }

    #[tokio::test]
    async fn test_list_empty_registry() {
        let temp_file = NamedTempFile::new().unwrap();
        let registry = ProfileRegistry::new(temp_file.path()).unwrap();

        let profiles = registry.list().await.unwrap();
        // ProfileRegistry::new() registers default built-in profiles
        assert!(!profiles.is_empty());
    }

    #[tokio::test]
    async fn test_update_existing_registration() {
        let temp_file = NamedTempFile::new().unwrap();
        let registry = ProfileRegistry::new(temp_file.path()).unwrap();

        let registration = AgentRegistration::new(
            "test-agent".to_string(),
            "python3 test.py".to_string(),
            "acp".to_string(),
        );

        registry.register(registration.clone()).await.unwrap();

        // Try to register with same ID but different name
        let mut updated = registration.clone();
        updated.name = "updated-name".to_string();
        updated.command = "python3 updated.py".to_string();

        let result = registry.register(updated).await;
        assert!(result.is_err());
        assert!(result.unwrap_err().to_string().contains("already exists"));
    }

    #[test]
    fn test_validate_special_characters_in_name() {
        let reg = AgentRegistration::new(
            "test-agent_123".to_string(),
            "cmd".to_string(),
            "acp".to_string(),
        );
        assert!(reg.validate().is_ok());
    }

    #[test]
    fn test_validate_unicode_in_name() {
        let reg = AgentRegistration::new(
            "测试agent".to_string(),
            "cmd".to_string(),
            "acp".to_string(),
        );
        assert!(reg.validate().is_ok());
    }

    #[test]
    fn test_validate_long_command() {
        let long_cmd = "python3 ".to_string() + &"a".repeat(1000);
        let reg = AgentRegistration::new("test".to_string(), long_cmd, "acp".to_string());
        assert!(reg.validate().is_ok());
    }
}
