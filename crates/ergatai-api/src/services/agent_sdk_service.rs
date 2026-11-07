use serde_json::Value;
use std::process::Command;

/// Get the project root directory (where Cargo.toml lives).
fn project_root() -> std::path::PathBuf {
    // Try to find the project root by looking for Cargo.toml in parent directories
    let mut current = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|p| p.to_path_buf()))
        .unwrap_or_else(|| std::env::current_dir().unwrap_or_default());

    loop {
        if current.join("Cargo.toml").exists() && current.join("scripts").exists() {
            return current;
        }
        if !current.pop() {
            break;
        }
    }

    // Fallback to current directory
    std::env::current_dir().unwrap_or_default()
}

pub async fn switch_model(agent: &str, model: &str, cwd: Option<&str>, session_id: Option<&str>) -> Value {
    let script = project_root().join("scripts/agent-sdk-model.mjs");
    let mut cmd = Command::new("node");
    cmd.arg(script).arg(agent).arg(model);
    if let Some(c) = cwd {
        cmd.arg(c);
    }
    if let Some(s) = session_id {
        cmd.env("SESSION_ID", s);
    }

    // Run blocking command in spawn_blocking to avoid blocking the async executor
    tokio::task::spawn_blocking(move || match cmd.output() {
        Ok(output) => {
            let stdout = String::from_utf8_lossy(&output.stdout);
            serde_json::from_str(&stdout).unwrap_or_else(|e| {
                let stderr = String::from_utf8_lossy(&output.stderr);
                tracing::warn!(error = %e, raw = %stdout, "Failed to parse agent-sdk-model output");
                serde_json::json!({"ok": false, "error": format!("JSON parse failed: {}", e), "stderr": stderr})
            })
        }
        Err(e) => {
            tracing::warn!(error = %e, "Failed to execute agent-sdk-model script");
            serde_json::json!({"ok": false, "error": e.to_string()})
        }
    })
    .await
    .unwrap_or_else(|e| serde_json::json!({"ok": false, "error": format!("spawn_blocking failed: {}", e)}))
}

pub async fn discover(agent: &str, cwd: Option<&str>) -> Value {
    let script = project_root().join("scripts/agent-sdk-discover.mjs");
    let mut cmd = Command::new("node");
    cmd.arg(script).arg(agent);
    if let Some(c) = cwd {
        cmd.arg(c);
    }

    // Run blocking command in spawn_blocking to avoid blocking the async executor
    tokio::task::spawn_blocking(move || match cmd.output() {
        Ok(output) => {
            if output.status.success() {
                let stdout = String::from_utf8_lossy(&output.stdout);
                serde_json::from_str(&stdout).unwrap_or_else(|e| {
                    tracing::warn!(error = %e, raw = %stdout, "Failed to parse agent-sdk-discover output");
                    serde_json::json!({"error": format!("JSON parse failed: {}", e), "raw": stdout})
                })
            } else {
                let stderr = String::from_utf8_lossy(&output.stderr);
                tracing::debug!(status = %output.status, stderr = %stderr, "agent-sdk-discover script failed");
                serde_json::json!({"error": stderr})
            }
        }
        Err(e) => {
            tracing::warn!(error = %e, "Failed to execute agent-sdk-discover script");
            serde_json::json!({"error": e.to_string()})
        }
    })
    .await
    .unwrap_or_else(|e| serde_json::json!({"error": format!("spawn_blocking failed: {}", e)}))
}
