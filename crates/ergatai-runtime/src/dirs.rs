//! Unified directory management for Ergatai data storage.
//!
//! Ergatai separates data into two categories:
//!
//! 1. **Project-level data** (`.ergatai/` in current directory)
//!    - `locks.db` — File access control locks (per-project file protection)
//!    - `sessions.db` — ACP session state (per-project, bound to cwd)
//!    - `agent_bindings.db` — MCP ↔ runtime agent bindings (per-project, for reconnection)
//!    - `collab-runtime/` — DAG collaboration runtime data (per-project)
//!    - `worktrees/` — Git worktrees (per-project)
//!
//! 2. **User-level data** (`~/.local/share/ergatai/` on Linux)
//!    - `user_data.db` — Projects, workspaces, conversations, messages (shared across projects)
//!    - `profile_registry.db` — Agent profile registry (global templates)
//!    - `adapters/` — Managed adapter installations (shared across projects)
//!    - `.api-token` — API authentication token (global)
//!
//! This separation ensures:
//! - Project-specific data stays with the project (can be deleted/cleaned per-project)
//! - User-level data is shared across all projects (one agent profile works everywhere)
//! - Multiple ergatai instances can share adapters and profiles
//! - Easy to clean up user data (single directory)

use std::path::PathBuf;

/// Returns the project-level data directory (`.ergatai/` in current directory).
///
/// This directory contains project-specific data:
/// - `locks.db` - File access control locks
/// - `sessions.db` - Agent session state
/// - `agent_bindings.db` - MCP connection bindings
/// - `collab-runtime/` - DAG collaboration state
/// - `worktrees/` - Git worktrees
///
/// # Important
/// Returns a **relative path** (`.ergatai`), which is resolved against the process's
/// current working directory. If the process changes directories (via `std::env::set_current_dir`),
/// subsequent calls will return a different absolute path. This is intentional — project data
/// should stay with the project directory.
///
/// # Example
/// ```rust
/// use ergatai_runtime::dirs::project_data_dir;
/// let project_dir = project_data_dir();
/// // => .ergatai/
/// ```
pub fn project_data_dir() -> PathBuf {
    PathBuf::from(".ergatai")
}

/// Returns the user-level data directory.
///
/// Priority:
/// 1. `ERGATAI_USER_DATA_DIR` environment variable (if set)
/// 2. Platform-specific user data directory:
///    - Linux: `~/.local/share/ergatai/`
///    - macOS: `~/Library/Application Support/ergatai/`
///    - Windows: `%LOCALAPPDATA%/ergatai/`
/// 3. Fallback: `~/.ergatai/` (legacy location)
///
/// This directory contains user-level data shared across all projects:
/// - `adapters/` - Managed adapter installations
/// - `profile_registry.db` - Global agent profile registry
/// - `config.json` - User configuration
/// - `.api-token` - API authentication token
///
/// # Example
/// ```rust
/// use ergatai_runtime::dirs::user_data_dir;
/// let user_dir = user_data_dir();
/// // => ~/.local/share/ergatai/
/// ```
pub fn user_data_dir() -> PathBuf {
    // Check environment variable first
    if let Ok(dir) = std::env::var("ERGATAI_USER_DATA_DIR") {
        return PathBuf::from(dir);
    }

    // Use platform-specific user data directory
    dirs::data_dir()
        .map(|dir| dir.join("ergatai"))
        .unwrap_or_else(|| {
            // Fallback to legacy location
            std::env::var("HOME")
                .map(PathBuf::from)
                .unwrap_or_else(|_| PathBuf::from("/tmp"))
                .join(".ergatai")
        })
}

/// Returns the path to the user-level profile registry database.
///
/// # Example
/// ```rust
/// use ergatai_runtime::dirs::profile_registry_db_path;
/// let db_path = profile_registry_db_path();
/// // => ~/.local/share/ergatai/profile_registry.db
/// ```
pub fn profile_registry_db_path() -> PathBuf {
    user_data_dir().join("profile_registry.db")
}

/// Returns the path to the user data database (projects, workspaces, conversations, messages).
///
/// This database contains user-facing data shared across all projects:
/// - Projects and workspaces
/// - Conversations and messages
/// - Agent sessions and terminal sessions
/// - Chat history
/// - Group-agent bindings
///
/// # Example
/// ```rust
/// use ergatai_runtime::dirs::user_data_db_path;
/// let db_path = user_data_db_path();
/// // => ~/.local/share/ergatai/user_data.db
/// ```
pub fn user_data_db_path() -> PathBuf {
    user_data_dir().join("user_data.db")
}

/// Returns the base directory for managed adapter installations.
///
/// # Example
/// ```rust
/// use ergatai_runtime::dirs::adapters_base_dir;
/// let adapters_dir = adapters_base_dir();
/// // => ~/.local/share/ergatai/adapters/
/// ```
pub fn adapters_base_dir() -> PathBuf {
    user_data_dir().join("adapters")
}

/// Returns the path to the API token file.
///
/// # Example
/// ```rust
/// use ergatai_runtime::dirs::api_token_path;
/// let token_path = api_token_path();
/// // => ~/.local/share/ergatai/.api-token
/// ```
pub fn api_token_path() -> PathBuf {
    user_data_dir().join(".api-token")
}

/// Ensure the user data directory exists.
///
/// # Returns
/// `Ok(())` if the directory exists or was successfully created.
pub fn ensure_user_data_dir() -> std::io::Result<()> {
    let dir = user_data_dir();
    if !dir.exists() {
        std::fs::create_dir_all(&dir)?;
    }
    Ok(())
}

/// Ensure the project data directory exists.
///
/// # Returns
/// `Ok(())` if the directory exists or was successfully created.
pub fn ensure_project_data_dir() -> std::io::Result<()> {
    let dir = project_data_dir();
    if !dir.exists() {
        std::fs::create_dir_all(&dir)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_project_data_dir() {
        let dir = project_data_dir();
        assert_eq!(dir, PathBuf::from(".ergatai"));
    }

    #[test]
    fn test_user_data_dir_with_env() {
        // WARNING: std::env::set_var/remove_var are not thread-safe.
        // These tests should be run with `cargo test -- --test-threads=1` to avoid
        // race conditions when multiple tests modify environment variables concurrently.
        // Alternatively, use a process-level lock or refactor to avoid env var manipulation.
        std::env::set_var("ERGATAI_USER_DATA_DIR", "/tmp/test-ergatai");
        let dir = user_data_dir();
        assert_eq!(dir, PathBuf::from("/tmp/test-ergatai"));
        std::env::remove_var("ERGATAI_USER_DATA_DIR");
    }

    #[test]
    fn test_user_data_dir_without_env() {
        std::env::remove_var("ERGATAI_USER_DATA_DIR");
        let dir = user_data_dir();
        // Should be platform-specific or fallback to ~/.ergatai
        assert!(dir.to_string_lossy().contains("ergatai"));
    }

    #[test]
    fn test_profile_registry_db_path() {
        let path = profile_registry_db_path();
        assert!(path.to_string_lossy().ends_with("profile_registry.db"));
    }

    #[test]
    fn test_user_data_db_path() {
        let path = user_data_db_path();
        assert!(path.to_string_lossy().ends_with("user_data.db"));
    }

    #[test]
    fn test_adapters_base_dir() {
        let path = adapters_base_dir();
        assert!(path.to_string_lossy().ends_with("adapters"));
    }

    #[test]
    fn test_api_token_path() {
        let path = api_token_path();
        assert!(path.to_string_lossy().ends_with(".api-token"));
    }
}
