//! Agent installer — npm-based install/uninstall for agent packages.
//!
//! Provides asynchronous install and uninstall operations for globally
//! installing npm packages that provide agent binaries. After install,
//! the binary can be verified via `binary_detection`.

use std::process::Output;

use ergatai_error::{ErgataiError, ErgataiResult};
use tracing::{info, warn};

use crate::binary_detection;

/// Install an npm package globally.
///
/// Runs `npm install -g <package_name>` and returns the combined stdout.
///
/// # Errors
/// Returns an error if npm is not installed, the command fails, or the
/// package name is empty.
pub async fn install_npm(package_name: &str) -> ErgataiResult<String> {
    if package_name.trim().is_empty() {
        return Err(ErgataiError::InvalidArgument(
            "Package name cannot be empty".to_string(),
        ));
    }

    info!(package = %package_name, "Installing npm package globally");

    let output = tokio::process::Command::new("npm")
        .args(["install", "-g", package_name])
        .output()
        .await
        .map_err(|e| {
            ErgataiError::internal(format!("Failed to spawn npm (is it installed?): {}", e))
        })?;

    handle_npm_output(output, "install", package_name)
}

/// Uninstall an npm package globally.
///
/// Runs `npm uninstall -g <package_name>` and returns the combined stdout.
pub async fn uninstall_npm(package_name: &str) -> ErgataiResult<String> {
    if package_name.trim().is_empty() {
        return Err(ErgataiError::InvalidArgument(
            "Package name cannot be empty".to_string(),
        ));
    }

    info!(package = %package_name, "Uninstalling npm package globally");

    let output = tokio::process::Command::new("npm")
        .args(["uninstall", "-g", package_name])
        .output()
        .await
        .map_err(|e| {
            ErgataiError::internal(format!("Failed to spawn npm (is it installed?): {}", e))
        })?;

    handle_npm_output(output, "uninstall", package_name)
}

/// Install an npm package and verify the expected binary is now available.
///
/// After `npm install -g`, checks that the binary extracted from `command`
/// is resolvable on PATH. If not, logs a warning (may need shell restart)
/// but still returns success since npm itself succeeded.
pub async fn install_and_verify(command: &str, package_name: &str) -> ErgataiResult<String> {
    let stdout = install_npm(package_name).await?;

    // Verify the binary is now available (non-fatal if not found)
    if let Some(binary) = binary_detection::binary_name(command) {
        if !binary_detection::is_installed(binary) {
            warn!(
                package = %package_name,
                binary = %binary,
                "npm install succeeded but binary not found on PATH (may need shell restart)"
            );
        }
    }

    Ok(stdout)
}

/// Process npm command output, returning stdout on success or a descriptive error.
fn handle_npm_output(output: Output, operation: &str, package_name: &str) -> ErgataiResult<String> {
    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();

    if output.status.success() {
        info!(
            package = %package_name,
            operation = %operation,
            "npm {} completed successfully",
            operation
        );
        Ok(stdout)
    } else {
        let error_detail = if stderr.is_empty() { &stdout } else { &stderr };
        warn!(
            package = %package_name,
            operation = %operation,
            exit_code = ?output.status.code(),
            "npm {} failed",
            operation
        );
        Err(ErgataiError::internal(format!(
            "npm {} {} failed (exit {:?}): {}",
            operation,
            package_name,
            output.status.code(),
            error_detail.trim()
        )))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn rejects_empty_package_name() {
        assert!(install_npm("").await.is_err());
        assert!(uninstall_npm("  ").await.is_err());
    }

    #[test]
    fn handle_npm_output_success_with_stdout() {
        use std::os::unix::process::ExitStatusExt;
        let status = std::process::ExitStatus::from_raw(0);
        let output = Output {
            status,
            stdout: b"installed successfully\n".to_vec(),
            stderr: b"".to_vec(),
        };
        let result = handle_npm_output(output, "install", "test-package");
        assert!(result.is_ok());
        assert_eq!(result.unwrap(), "installed successfully\n");
    }

    #[test]
    fn handle_npm_output_failure_with_stderr() {
        use std::os::unix::process::ExitStatusExt;
        let status = std::process::ExitStatus::from_raw(256);
        let output = Output {
            status,
            stdout: b"".to_vec(),
            stderr: b"npm ERR! something went wrong\n".to_vec(),
        };
        let result = handle_npm_output(output, "install", "test-package");
        assert!(result.is_err());
        let err = result.unwrap_err();
        assert!(err.to_string().contains("npm install test-package failed"));
        assert!(err.to_string().contains("npm ERR!"));
    }

    #[test]
    fn handle_npm_output_failure_with_stdout_fallback() {
        use std::os::unix::process::ExitStatusExt;
        let status = std::process::ExitStatus::from_raw(256);
        let output = Output {
            status,
            stdout: b"some error output\n".to_vec(),
            stderr: b"".to_vec(),
        };
        let result = handle_npm_output(output, "uninstall", "test-package");
        assert!(result.is_err());
        let err = result.unwrap_err();
        assert!(err.to_string().contains("some error output"));
    }

    #[test]
    fn handle_npm_output_with_both_stdout_and_stderr() {
        use std::os::unix::process::ExitStatusExt;
        let status = std::process::ExitStatus::from_raw(256);
        let output = Output {
            status,
            stdout: b"stdout output\n".to_vec(),
            stderr: b"stderr error\n".to_vec(),
        };
        let result = handle_npm_output(output, "install", "test-package");
        assert!(result.is_err());
        let err = result.unwrap_err();
        // Should prefer stderr over stdout
        assert!(err.to_string().contains("stderr error"));
    }

    #[test]
    fn handle_npm_output_success_prefers_stdout() {
        use std::os::unix::process::ExitStatusExt;
        let status = std::process::ExitStatus::from_raw(0);
        let output = Output {
            status,
            stdout: b"success output\n".to_vec(),
            stderr: b"warning message\n".to_vec(),
        };
        let result = handle_npm_output(output, "install", "test-package");
        assert!(result.is_ok());
        // Should return stdout on success
        assert_eq!(result.unwrap(), "success output\n");
    }

    #[tokio::test]
    async fn install_and_verify_with_empty_package() {
        let result = install_and_verify("some-command", "").await;
        assert!(result.is_err());
        assert!(result.unwrap_err().to_string().contains("empty"));
    }

    #[test]
    fn handle_npm_output_with_empty_strings() {
        use std::os::unix::process::ExitStatusExt;
        let status = std::process::ExitStatus::from_raw(0);
        let output = Output {
            status,
            stdout: b"".to_vec(),
            stderr: b"".to_vec(),
        };
        let result = handle_npm_output(output, "install", "test-package");
        assert!(result.is_ok());
        assert_eq!(result.unwrap(), "");
    }

    #[test]
    fn handle_npm_output_with_whitespace_only() {
        use std::os::unix::process::ExitStatusExt;
        let status = std::process::ExitStatus::from_raw(0);
        let output = Output {
            status,
            stdout: b"   \n".to_vec(),
            stderr: b"".to_vec(),
        };
        let result = handle_npm_output(output, "install", "test-package");
        assert!(result.is_ok());
    }

    #[test]
    fn handle_npm_output_preserves_newlines() {
        use std::os::unix::process::ExitStatusExt;
        let status = std::process::ExitStatus::from_raw(0);
        let output = Output {
            status,
            stdout: b"line1\nline2\nline3\n".to_vec(),
            stderr: b"".to_vec(),
        };
        let result = handle_npm_output(output, "install", "test-package");
        assert!(result.is_ok());
        assert_eq!(result.unwrap(), "line1\nline2\nline3\n");
    }

    #[tokio::test]
    async fn install_and_verify_with_whitespace_only_package() {
        let result = install_and_verify("some-command", "   ").await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn uninstall_with_empty_package() {
        let result = uninstall_npm("").await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn uninstall_with_whitespace_only_package() {
        let result = uninstall_npm("   ").await;
        assert!(result.is_err());
    }
}
