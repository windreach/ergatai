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
use tokio::process::Command;

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

        // Register default built-in profiles FIRST (use current version)
        self.register_default_profiles()?;

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
                // Create a temporary registry instance for background update
                if let Ok(registry) = ProfileRegistry::new(&db_path) {
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
        // Resolve adapter paths via the shared helper (same path used by
        // check_and_update_adapters_background so auto-update inspects the
        // same adapters we registered here).
        let adapters_base = Self::resolve_adapters_base();

        let codex_cmd = format!(
            "node {}",
            adapters_base.join("codex-acp/dist/index.js").display()
        );
        let claude_cmd = format!(
            "node {}",
            adapters_base
                .join("claude-agent-acp/dist/acp-agent.js")
                .display()
        );

        let defaults = vec![
            // OpenAI Codex CLI adapter (已验证 - adapters/codex-acp)
            AgentRegistration {
                name: "codex".to_string(),
                command: codex_cmd,
                agent_type: "acp".to_string(),
                created_at: Utc::now(),
            },
            // Anthropic Claude Agent adapter (已验证 - adapters/claude-agent-acp)
            AgentRegistration {
                name: "claude".to_string(),
                command: claude_cmd,
                agent_type: "acp".to_string(),
                created_at: Utc::now(),
            },
            // OpenCode (已验证 - https://opencode.ai/docs/acp/)
            AgentRegistration {
                name: "opencode".to_string(),
                command: "opencode acp".to_string(),
                agent_type: "acp".to_string(),
                created_at: Utc::now(),
            },
            // Gemini CLI (已验证 - https://geminicli.com/docs/cli/acp-mode/)
            AgentRegistration {
                name: "gemini".to_string(),
                command: "gemini --acp".to_string(),
                agent_type: "acp".to_string(),
                created_at: Utc::now(),
            },
            // Goose (已验证 - https://goose-docs.ai/docs/guides/acp-clients/)
            AgentRegistration {
                name: "goose".to_string(),
                command: "goose run --acp".to_string(),
                agent_type: "acp".to_string(),
                created_at: Utc::now(),
            },
            // Cline (已验证 - ACP registry)
            AgentRegistration {
                name: "cline".to_string(),
                command: "cline --acp".to_string(),
                agent_type: "acp".to_string(),
                created_at: Utc::now(),
            },
            // Kiro CLI (已验证 - ACP registry)
            AgentRegistration {
                name: "kiro".to_string(),
                command: "kiro-cli acp".to_string(),
                agent_type: "acp".to_string(),
                created_at: Utc::now(),
            },
            // Auggie CLI (已验证 - ACP registry)
            AgentRegistration {
                name: "auggie".to_string(),
                command: "auggie --acp".to_string(),
                agent_type: "acp".to_string(),
                created_at: Utc::now(),
            },
            // OpenClaw (已验证 - ACP registry)
            AgentRegistration {
                name: "openclaw".to_string(),
                command: "openclaw acp".to_string(),
                agent_type: "acp".to_string(),
                created_at: Utc::now(),
            },
            // Hermes Agent (已验证 - ACP registry)
            AgentRegistration {
                name: "hermes".to_string(),
                command: "hermes acp".to_string(),
                agent_type: "acp".to_string(),
                created_at: Utc::now(),
            },
        ];

        for profile in defaults {
            // Try to register, ignore if already exists
            if let Err(e) = self.register_sync(profile.clone()) {
                if !e.to_string().contains("already exists") {
                    debug!(name = %profile.name, error = %e, "Failed to register default profile");
                }
            } else {
                info!(name = %profile.name, "Registered default agent profile");
            }
        }

        Ok(())
    }

    /// Synchronous version of register for use during initialization.
    fn register_sync(&self, registration: AgentRegistration) -> ErgataiResult<()> {
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
                "SELECT name, command, agent_type, created_at
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
        std::env::var("ERGATAI_ADAPTERS_DIR")
            .ok()
            .map(std::path::PathBuf::from)
            .or_else(|| {
                std::env::current_exe()
                    .ok()
                    .and_then(|p| p.parent().map(|d| d.to_path_buf()))
                    .map(|d| d.join("../adapters"))
            })
            .unwrap_or_else(|| std::path::PathBuf::from("adapters"))
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
}

/// Parse a database row into an AgentRegistration struct.
/// Used by both `get` and `list` methods.
fn parse_agent_registration_row(row: &rusqlite::Row) -> rusqlite::Result<AgentRegistration> {
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
