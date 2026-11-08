use serde_json::Value;
use std::path::PathBuf;
use tokio::process::Command;
use std::sync::{Arc, Mutex};
// atomic import removed
use std::time::{Duration, Instant};
use tokio::sync::Mutex as AsyncMutex;
use tokio::sync::Semaphore;

/// Timeout for Node SDK subprocess calls.
/// Prevents indefinite blocking if the SDK hangs (deadlock, network issue, etc).
const SDK_SUBPROCESS_TIMEOUT: Duration = Duration::from_secs(15);

/// Build NODE_PATH from dynamic user-home-based paths and environment overrides.
///
/// Path resolution order:
/// 1. `NODE_PATH` env var (if already set, preserved as-is)
/// 2. `ERGATAI_ADAPTERS_BASE` env var (custom adapter install location)
/// 3. `$HOME/.local/share/ergatai/adapters/...` (per-user managed adapters)
/// 4. `$HOME/.opencode/node_modules` and `$HOME/.config/opencode/node_modules`
/// 5. `/usr/lib/node_modules/...` (system-wide, only if it exists)
///
/// This avoids hardcoding `/root/` and works for any user.
fn build_node_path() -> String {
    let mut paths: Vec<PathBuf> = Vec::new();

    // 1. Respect existing NODE_PATH
    if let Ok(existing) = std::env::var("NODE_PATH") {
        if !existing.is_empty() {
            for p in existing.split(':') {
                if !p.is_empty() {
                    paths.push(PathBuf::from(p));
                }
            }
        }
    }

    let home = dirs::home_dir();

    // 2. ERGATAI_ADAPTERS_BASE env override (for custom deployments)
    if let Ok(base) = std::env::var("ERGATAI_ADAPTERS_BASE") {
        let base_path = PathBuf::from(&base);
        if base_path.exists() {
            // Scan for managed release node_modules
            if let Ok(entries) = std::fs::read_dir(base_path.join("managed").join("releases")) {
                for entry in entries.flatten() {
                    let nm = entry.path().join("node_modules");
                    if nm.exists() && !paths.contains(&nm) {
                        paths.push(nm);
                    }
                }
            }
        }
    } else if let Some(ref home_dir) = home {
        // 3. Default managed adapters location: $HOME/.local/share/ergatai/adapters
        let adapters_base = home_dir.join(".local").join("share").join("ergatai").join("adapters").join("managed").join("releases");
        if adapters_base.exists() {
            if let Ok(entries) = std::fs::read_dir(&adapters_base) {
                for entry in entries.flatten() {
                    let nm = entry.path().join("node_modules");
                    if nm.exists() && !paths.contains(&nm) {
                        paths.push(nm);
                    }
                }
            }
        }

        // 4. OpenCode SDK locations
        let opencode_paths = [
            home_dir.join(".opencode").join("node_modules"),
            home_dir.join(".config").join("opencode").join("node_modules"),
        ];
        for p in opencode_paths {
            if p.exists() && !paths.contains(&p) {
                paths.push(p);
            }
        }
    }

    // 5. System-wide Claude ACP adapter (only if it exists)
    let system_claude = PathBuf::from("/usr/lib/node_modules/@agentclientprotocol/claude-agent-acp/node_modules");
    if system_claude.exists() && !paths.contains(&system_claude) {
        paths.push(system_claude);
    }

    paths
        .iter()
        .map(|p| p.to_string_lossy().into_owned())
        .collect::<Vec<_>>()
        .join(":")
}

/// OpenCode server connection state
struct OpenCodeServerState {
    last_health_check: Instant,
    is_healthy: bool,
}

static OPENCODE_STATE: Mutex<Option<Arc<AsyncMutex<OpenCodeServerState>>>> = Mutex::new(None);

/// Optional runtime override for the OpenCode server URL (set by auto-start).
static OPENCODE_URL_OVERRIDE: Mutex<Option<String>> = Mutex::new(None);

/// Last time an auto-start attempt was made (for cooldown-based retry).
static OPENCODE_AUTOSTART_LAST_ATTEMPT: Mutex<Option<Instant>> = Mutex::new(None);

/// Global limit for concurrent Node SDK subprocesses.
static SDK_SEMAPHORE: Semaphore = Semaphore::const_new(4);

fn get_opencode_state() -> Arc<AsyncMutex<OpenCodeServerState>> {
    let mut guard = OPENCODE_STATE.lock().unwrap();
    guard.get_or_insert_with(|| {
        Arc::new(AsyncMutex::new(OpenCodeServerState {
            last_health_check: Instant::now() - Duration::from_secs(60), // Force initial check
            is_healthy: false,
        }))
    }).clone()
}

/// Check if OpenCode server is healthy via HTTP ping
fn opencode_base_url() -> String {
    if let Ok(url) = std::env::var("OPENCODE_URL") {
        if !url.trim().is_empty() {
            return url;
        }
    }
    if let Some(url) = OPENCODE_URL_OVERRIDE.lock().unwrap().clone() {
        return url;
    }
    "http://127.0.0.1:4096".to_string()
}

async fn check_opencode_health() -> bool {
    let url = opencode_base_url();
    let health_url = format!("{}/health", url.trim_end_matches('/'));

    // Simple HTTP GET with timeout
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(2))
        .build();

    match client {
        Ok(c) => {
            match c.get(&health_url).send().await {
                Ok(resp) => resp.status().is_success(),
                Err(_) => false,
            }
        }
        Err(_) => false,
    }
}

/// Ensure OpenCode server is healthy before calling SDK
async fn try_autostart_opencode() {
    if std::env::var("ERGATAI_OPENCODE_AUTOSTART").as_deref() != Ok("1") {
        return;
    }
    {
        let mut guard = OPENCODE_AUTOSTART_LAST_ATTEMPT.lock().unwrap();
        if let Some(last) = *guard {
            if last.elapsed() < Duration::from_secs(60) {
                return;
            }
        }
        *guard = Some(Instant::now());
    }

    tracing::info!("Attempting to auto-start OpenCode background service");
    let output = tokio::time::timeout(
        Duration::from_secs(15),
        Command::new("opencode")
            .args(["service", "start"])
            .output(),
    )
    .await;

    match output {
        Ok(Ok(out)) if out.status.success() => {
            let stdout = String::from_utf8_lossy(&out.stdout);
            // The command prints the server URL, e.g. http://127.0.0.1:49374
            // Parse the server URL defensively: strip trailing punctuation and
            // validate it looks like an HTTP(S) URL.
            let parsed_url = stdout.split_whitespace().find_map(|token| {
                let token = token.trim_end_matches(|c: char| {
                    matches!(c, ')' | ',' | ';' | '.' | ']' | '}')
                });
                if (token.starts_with("http://") || token.starts_with("https://"))
                    && token.len() > "http://".len()
                {
                    Some(token.to_string())
                } else {
                    None
                }
            });
            if let Some(url) = parsed_url {
                *OPENCODE_URL_OVERRIDE.lock().unwrap() = Some(url.clone());
                tracing::info!(url = %url, "OpenCode auto-start succeeded");
            } else {
                tracing::warn!(stdout = %stdout, "OpenCode auto-start succeeded but no URL was parsed");
            }
        }
        Ok(Ok(out)) => {
            let stderr = String::from_utf8_lossy(&out.stderr);
            tracing::warn!(status = %out.status, stderr = %stderr, "OpenCode auto-start failed");
        }
        Ok(Err(e)) => {
            tracing::warn!(error = %e, "Failed to spawn opencode service start");
        }
        Err(_) => {
            tracing::warn!("OpenCode auto-start timed out");
        }
    }
}

async fn ensure_opencode_ready() -> bool {
    let state = get_opencode_state();
    let mut guard = state.lock().await;

    // Check every 30 seconds
    if guard.last_health_check.elapsed() < Duration::from_secs(30) {
        return guard.is_healthy;
    }

    // Optional auto-start (opt-in via ERGATAI_OPENCODE_AUTOSTART=1).
    if !check_opencode_health().await {
        try_autostart_opencode().await;
    }

    let healthy = check_opencode_health().await;
    guard.last_health_check = Instant::now();
    guard.is_healthy = healthy;

    if !healthy {
        tracing::warn!(
            "OpenCode server not reachable. Set OPENCODE_URL, enable ERGATAI_OPENCODE_AUTOSTART=1, or start server manually."
        );
    }

    healthy
}

pub async fn switch_model(agent: &str, model: &str, cwd: Option<&str>, session_id: Option<&str>) -> Value {
    let script = crate::services::embedded_scripts::model_script_path();
    let mut cmd = Command::new("node");
    cmd.arg(script).arg(agent).arg(model);
    if let Some(c) = cwd {
        cmd.arg(c);
    }
    if let Some(s) = session_id {
        cmd.env("SESSION_ID", s);
    }
    if agent == "opencode" {
        cmd.env("OPENCODE_URL", opencode_base_url());
    }

    // Build NODE_PATH dynamically based on user home and env vars
    let node_path = build_node_path();
    if !node_path.is_empty() {
        cmd.env("NODE_PATH", &node_path);
    }

    cmd.kill_on_drop(true);

    // Acquire a global permit to limit concurrent Node SDK subprocesses.
    let _permit = SDK_SEMAPHORE.acquire().await.ok();

    // Run with timeout; kill_on_drop ensures the child is terminated on timeout.
    match tokio::time::timeout(SDK_SUBPROCESS_TIMEOUT, cmd.output()).await {
        Ok(Ok(output)) => {
            let stdout = String::from_utf8_lossy(&output.stdout);
            serde_json::from_str(&stdout).unwrap_or_else(|e| {
                let stderr = String::from_utf8_lossy(&output.stderr);
                tracing::warn!(error = %e, raw = %stdout, "Failed to parse agent-sdk-model output");
                serde_json::json!({"ok": false, "error": format!("JSON parse failed: {}", e), "stderr": stderr})
            })
        }
        Ok(Err(e)) => {
            tracing::warn!(error = %e, "Failed to execute agent-sdk-model script");
            serde_json::json!({"ok": false, "error": e.to_string()})
        }
        Err(_timeout) => {
            tracing::error!(
                agent = %agent,
                model = %model,
                timeout_secs = %SDK_SUBPROCESS_TIMEOUT.as_secs(),
                "agent-sdk-model subprocess timed out"
            );
            serde_json::json!({
                "ok": false,
                "error": format!("SDK subprocess timed out after {}s", SDK_SUBPROCESS_TIMEOUT.as_secs())
            })
        }
    }
}

pub async fn discover(agent: &str, cwd: Option<&str>) -> Value {
    // For OpenCode, check server health first to avoid hanging SDK calls
    if agent == "opencode" {
        if !ensure_opencode_ready().await {
            tracing::debug!("OpenCode server unavailable, returning empty discovery result");
            return serde_json::json!({
                "skills": [],
                "commands": [],
                "models": [],
                "mcp": [],
                "error": "OpenCode server not reachable"
            });
        }
    }

    let script = crate::services::embedded_scripts::discover_script_path();
    let mut cmd = Command::new("node");
    cmd.arg(script).arg(agent);
    if let Some(c) = cwd {
        cmd.arg(c);
    }
    if agent == "opencode" {
        cmd.env("OPENCODE_URL", opencode_base_url());
    }

    // Build NODE_PATH dynamically based on user home and env vars
    let node_path = build_node_path();
    if !node_path.is_empty() {
        cmd.env("NODE_PATH", &node_path);
    }

    cmd.kill_on_drop(true);

    // Acquire a global permit to limit concurrent Node SDK subprocesses.
    let _permit = SDK_SEMAPHORE.acquire().await.ok();

    // Run with timeout; kill_on_drop ensures the child is terminated on timeout.
    match tokio::time::timeout(SDK_SUBPROCESS_TIMEOUT, cmd.output()).await {
        Ok(Ok(output)) => {
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
        Ok(Err(e)) => {
            tracing::warn!(error = %e, "Failed to execute agent-sdk-discover script");
            serde_json::json!({"error": e.to_string()})
        }
        Err(_timeout) => {
            tracing::error!(
                agent = %agent,
                cwd = ?cwd,
                timeout_secs = %SDK_SUBPROCESS_TIMEOUT.as_secs(),
                "agent-sdk-discover subprocess timed out"
            );
            serde_json::json!({
                "skills": [],
                "commands": [],
                "models": [],
                "mcp": [],
                "error": format!("SDK subprocess timed out after {}s", SDK_SUBPROCESS_TIMEOUT.as_secs())
            })
        }
    }
}

/// Inject MCP servers into a running agent via SDK.
///
/// `servers_json` is a JSON object mapping server name -> SDK-shaped config.
pub async fn inject_mcp(agent: &str, cwd: Option<&str>, session_id: Option<&str>, servers_json: &str) -> Value {
    if agent == "opencode" {
        if !ensure_opencode_ready().await {
            return serde_json::json!({
                "ok": false,
                "error": "OpenCode server not reachable"
            });
        }
    }

    let script = crate::services::embedded_scripts::inject_mcp_script_path();
    let mut cmd = Command::new("node");
    cmd.arg(script).arg(agent);
    if let Some(c) = cwd {
        cmd.arg(c);
    }
    if let Some(s) = session_id {
        cmd.arg(s);
    }
    if agent == "opencode" {
        cmd.env("OPENCODE_URL", opencode_base_url());
    }

    let node_path = build_node_path();
    if !node_path.is_empty() {
        cmd.env("NODE_PATH", &node_path);
    }
    if !servers_json.is_empty() {
        cmd.env("MCP_SERVERS_JSON", servers_json);
    }

    cmd.kill_on_drop(true);

    let _permit = SDK_SEMAPHORE.acquire().await.ok();

    match tokio::time::timeout(SDK_SUBPROCESS_TIMEOUT, cmd.output()).await {
        Ok(Ok(output)) => {
            if output.status.success() {
                let stdout = String::from_utf8_lossy(&output.stdout);
                serde_json::from_str(&stdout).unwrap_or_else(|e| {
                    let stderr = String::from_utf8_lossy(&output.stderr);
                    serde_json::json!({"ok": false, "error": format!("JSON parse failed: {}", e), "stderr": stderr})
                })
            } else {
                let stderr = String::from_utf8_lossy(&output.stderr);
                serde_json::json!({"ok": false, "error": stderr.to_string()})
            }
        }
        Ok(Err(e)) => {
            serde_json::json!({"ok": false, "error": e.to_string()})
        }
        Err(_) => {
            serde_json::json!({"ok": false, "error": format!("SDK subprocess timed out after {}s", SDK_SUBPROCESS_TIMEOUT.as_secs())})
        }
    }
}
