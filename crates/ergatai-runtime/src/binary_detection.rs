//! Binary detection — check whether an agent command's binary is installed.
//!
//! Uses the `which` crate to locate executables on `PATH`.
//! The detection extracts the first whitespace-delimited token of a command
//! string (the binary name) and checks whether it resolves on the system PATH.
//!
//! # Caching
//!
//! Detection results are cached on first scan to avoid repeated filesystem lookups.
//! The cache persists for the lifetime of the process and is automatically cleared
//! when the process exits. On next startup, a fresh scan is performed.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::OnceLock;

use tracing::debug;

/// Global cache for binary detection results.
/// Key: command string, Value: detected path (None if not found)
///
/// # Lifecycle
/// - Initialized on first call to `detect_binary`
/// - Persists for the lifetime of the process
/// - Automatically cleared when process exits (memory reclaimed by OS)
/// - Next startup triggers a fresh scan
static BINARY_CACHE: OnceLock<std::sync::Mutex<HashMap<String, Option<PathBuf>>>> = OnceLock::new();

fn get_cache() -> &'static std::sync::Mutex<HashMap<String, Option<PathBuf>>> {
    BINARY_CACHE.get_or_init(|| std::sync::Mutex::new(HashMap::new()))
}

/// Clear the binary detection cache.
/// Typically not needed (cache auto-clears on process exit), but provided for:
/// - Manual refresh after installing new agents
/// - Testing
/// - Explicit cache invalidation
pub fn clear_cache() {
    if let Some(cache) = BINARY_CACHE.get() {
        if let Ok(mut guard) = cache.lock() {
            let count = guard.len();
            guard.clear();
            debug!(cleared_entries = count, "Binary detection cache cleared");
        }
    }
}

/// Detect whether an agent command's binary is installed on the system.
///
/// Results are cached on first scan to avoid repeated filesystem lookups.
/// The cache persists for the process lifetime and auto-clears on exit.
///
/// # Arguments
/// * `command` - Full agent command string (e.g. `"opencode acp"`, `"goose run --acp"`).
///
/// # Returns
/// `Some(path)` if the binary is found on PATH, `None` otherwise.
///
/// # Notes
/// - Only the first whitespace-delimited token is treated as the binary name.
/// - Absolute paths are checked directly via `Path::exists`.
/// - This does NOT validate arguments — only that the binary is resolvable.
/// - Results are cached for the process lifetime; restart to re-scan.
pub fn detect_binary(command: &str) -> Option<PathBuf> {
    // Check cache first
    let cache = get_cache();
    if let Ok(guard) = cache.lock() {
        if let Some(cached) = guard.get(command) {
            return cached.clone();
        }
    }

    // Cache miss - perform detection
    let result = detect_binary_uncached(command);

    // Store in cache
    if let Ok(mut guard) = cache.lock() {
        guard.insert(command.to_string(), result.clone());
    }

    result
}

/// Internal detection without caching.
fn detect_binary_uncached(command: &str) -> Option<PathBuf> {
    let binary = command.split_whitespace().next()?.trim();
    if binary.is_empty() {
        return None;
    }

    // If it's an absolute or relative path, check directly
    let binary_path = PathBuf::from(binary);
    if binary_path.is_absolute() || binary.starts_with("./") || binary.starts_with("../") {
        if binary_path.exists() {
            let resolved = binary_path.display().to_string();
            debug!(binary = %binary, resolved_path = %resolved, "Binary found at explicit path");
            return Some(binary_path);
        }
        debug!(binary = %binary, "Binary path does not exist");
        return None;
    }

    // Use `which` to resolve on PATH
    match which::which(binary) {
        Ok(resolved) => {
            let resolved_str = resolved.display().to_string();
            debug!(binary = %binary, resolved_path = %resolved_str, "Binary found on PATH");
            Some(resolved)
        }
        Err(_) => {
            debug!(binary = %binary, "Binary not found on PATH");
            None
        }
    }
}

/// Check whether an agent command's binary is installed.
///
/// Convenience wrapper around `detect_binary` returning a boolean.
pub fn is_installed(command: &str) -> bool {
    detect_binary(command).is_some()
}

/// Extract the binary name from a command string (first whitespace-delimited token).
pub fn binary_name(command: &str) -> Option<&str> {
    command
        .split_whitespace()
        .next()
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_binary_name() {
        assert_eq!(binary_name("opencode acp"), Some("opencode"));
        assert_eq!(binary_name("goose run --acp"), Some("goose"));
        assert_eq!(binary_name("  claude  "), Some("claude"));
        assert_eq!(binary_name(""), None);
        assert_eq!(binary_name("   "), None);
    }

    #[test]
    fn detects_system_binary() {
        // `sh` is available on every Unix system
        assert!(is_installed("sh"));
        assert!(is_installed("sh -c 'echo hello'"));
    }

    #[test]
    fn returns_none_for_missing_binary() {
        assert!(!is_installed("definitely-not-a-real-binary-xyz-123"));
    }

    #[test]
    fn detects_absolute_path() {
        // /bin/sh exists on Unix
        if std::path::Path::new("/bin/sh").exists() {
            assert!(is_installed("/bin/sh"));
        }
    }

    #[test]
    fn detect_binary_returns_pathbuf_for_system_binary() {
        let result = detect_binary("sh");
        assert!(result.is_some());
        assert!(result.unwrap().to_string_lossy().contains("sh"));
    }

    #[test]
    fn detect_binary_returns_none_for_empty_command() {
        assert!(detect_binary("").is_none());
        assert!(detect_binary("   ").is_none());
    }

    #[test]
    fn detect_binary_handles_relative_path() {
        // Non-existent relative path should return None
        assert!(detect_binary("./nonexistent-binary-xyz").is_none());
        assert!(detect_binary("../nonexistent-binary-xyz").is_none());
    }

    #[test]
    fn binary_name_trims_whitespace() {
        assert_eq!(binary_name("  opencode  "), Some("opencode"));
        assert_eq!(binary_name("\topencode\n"), Some("opencode"));
    }

    #[test]
    fn binary_name_with_arguments() {
        assert_eq!(binary_name("python3 script.py"), Some("python3"));
        assert_eq!(binary_name("node --version"), Some("node"));
        assert_eq!(binary_name("go run main.go"), Some("go"));
    }

    #[test]
    fn binary_name_with_flags() {
        assert_eq!(binary_name("cargo build --release"), Some("cargo"));
        assert_eq!(binary_name("npm install -g package"), Some("npm"));
    }

    #[test]
    fn is_installed_with_version_flag() {
        // Test with version flags
        assert!(is_installed("sh --version") || is_installed("sh -V"));
    }

    #[test]
    fn detect_binary_with_complex_command() {
        // Complex command should still extract binary name
        let result = detect_binary("sh -c 'echo hello world'");
        assert!(result.is_some());
    }

    #[test]
    fn binary_name_preserves_case() {
        assert_eq!(binary_name("MyBinary arg1"), Some("MyBinary"));
        assert_eq!(binary_name("CamelCaseBinary"), Some("CamelCaseBinary"));
    }

    #[test]
    fn is_installed_returns_false_for_empty_string() {
        assert!(!is_installed(""));
        assert!(!is_installed("   "));
    }
}
