/// Embedded Node.js helper scripts for production deployment.
///
/// In development, scripts are loaded from `scripts/` directory via `project_root()`.
/// In production, they are embedded into the binary using `include_str!`.
///
/// At runtime, embedded scripts are written to a temporary directory and executed from there.
/// This avoids the fragile `project_root()` lookup in production environments.

use std::path::PathBuf;
use std::sync::Mutex;

static EMBEDDED_SCRIPTS_DIR: Mutex<Option<PathBuf>> = Mutex::new(None);

/// The discover script source (embedded in production).
const DISCOVER_SCRIPT: &str = include_str!("../../../../scripts/agent-sdk-discover.mjs");

/// The model switch script source (embedded in production).
const MODEL_SCRIPT: &str = include_str!("../../../../scripts/agent-sdk-model.mjs");

/// The MCP injection script source (embedded in production).
const INJECT_MCP_SCRIPT: &str = include_str!("../../../../scripts/agent-sdk-inject-mcp.mjs");

/// Get the path to the discover script.
///
/// In production, this extracts the embedded script to a temp directory.
/// In development, falls back to the source `scripts/` directory.
pub fn discover_script_path() -> PathBuf {
    get_or_extract_script("agent-sdk-discover.mjs", DISCOVER_SCRIPT)
}

/// Get the path to the model switch script.
///
/// In production, this extracts the embedded script to a temp directory.
/// In development, falls back to the source `scripts/` directory.
pub fn model_script_path() -> PathBuf {
    get_or_extract_script("agent-sdk-model.mjs", MODEL_SCRIPT)
}

/// Get the path to the MCP injection script.
pub fn inject_mcp_script_path() -> PathBuf {
    get_or_extract_script("agent-sdk-inject-mcp.mjs", INJECT_MCP_SCRIPT)
}

/// Extract embedded script to temp directory if needed, returning the path.
fn get_or_extract_script(name: &str, content: &str) -> PathBuf {
    // Check if we already extracted scripts
    {
        let guard = EMBEDDED_SCRIPTS_DIR.lock().unwrap();
        if let Some(dir) = guard.as_ref() {
            let path = dir.join(name);
            if path.exists() {
                return path;
            }
        }
    }

    // In debug builds (or when explicitly opted in), prefer the source tree scripts
    // so developers can iterate without recompiling. In release builds, always use
    // the embedded copy to avoid stale scripts next to the binary.
    let allow_dev_scripts = cfg!(debug_assertions)
        || std::env::var("ERGATAI_DEV_SCRIPTS").as_deref() == Ok("1");
    if allow_dev_scripts {
        if let Ok(root) = std::env::current_exe() {
            let mut dir = root.parent().map(|p| p.to_path_buf());
            while let Some(d) = dir {
                let dev_path = d.join("scripts").join(name);
                if dev_path.exists() {
                    return dev_path;
                }
                dir = d.parent().map(|p| p.to_path_buf());
            }
        }
    }

    // Fall back to extracting embedded script
    let temp_dir = std::env::temp_dir().join("ergatai-embedded-scripts");

    // Create directory if it doesn't exist
    if !temp_dir.exists() {
        let _ = std::fs::create_dir_all(&temp_dir);
    }

    let script_path = temp_dir.join(name);

    // Write the embedded script
    if let Err(e) = std::fs::write(&script_path, content) {
        tracing::error!(error = %e, "Failed to write embedded script");
        // Fall back to current directory as last resort
        return PathBuf::from(name);
    }

    // Store the temp directory for future lookups
    {
        let mut guard = EMBEDDED_SCRIPTS_DIR.lock().unwrap();
        *guard = Some(temp_dir.clone());
    }

    script_path
}

/// Clean up extracted scripts (optional, called on shutdown).
pub fn cleanup_embedded_scripts() {
    let guard = EMBEDDED_SCRIPTS_DIR.lock().unwrap();
    if let Some(dir) = guard.as_ref() {
        if let Err(e) = std::fs::remove_dir_all(dir) {
            tracing::debug!(error = %e, "Failed to cleanup embedded scripts directory");
        }
    }
}
