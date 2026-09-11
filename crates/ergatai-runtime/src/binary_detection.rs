//! Binary detection — check whether an agent command's binary is installed.
//!
//! Uses the `which` crate to locate executables on `PATH`.
//! The detection extracts the first whitespace-delimited token of a command
//! string (the binary name) and checks whether it resolves on the system PATH.

use std::path::PathBuf;

use tracing::debug;

/// Detect whether an agent command's binary is installed on the system.
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
pub fn detect_binary(command: &str) -> Option<PathBuf> {
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
}
