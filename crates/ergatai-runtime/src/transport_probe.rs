//! Transport probe — detect whether an ACP agent uses stdio or HTTP transport
//! by sending a real ACP `initialize` handshake and checking for a response.
//!
//! # Strategy
//!
//! 1. Try stdio: spawn the agent, write a JSON-RPC `initialize` line to stdin,
//!    and wait for a JSON-RPC response on stdout.
//! 2. If stdio fails, try HTTP: spawn with `--port`, wait for TCP readiness,
//!    and POST the `initialize` to `http://127.0.0.1:{port}/acp`.
//! 3. If both fail, return `None` (caller falls back to stdio default).
//!
//! Results are cached by the caller (profile registry) so the probe only runs
//! on first launch or when the agent binary changes (fingerprint mismatch).

use std::time::Duration;

use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};
use tokio::time::timeout;
use tracing::{debug, info, warn};

const PROBE_TIMEOUT: Duration = Duration::from_secs(3);
const HTTP_TCP_POLL_INTERVAL: Duration = Duration::from_millis(100);

/// Build the ACP `initialize` JSON-RPC request body.
fn initialize_request_json() -> String {
    serde_json::json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "initialize",
        "params": {
            "protocolVersion": "2025-11-25",
            "capabilities": {},
            "clientInfo": {
                "name": "ergatai-transport-probe",
                "version": "0.1.0"
            }
        }
    })
    .to_string()
}

/// Check whether a stdout line looks like a JSON-RPC response (has "result" or "error").
fn is_jsonrpc_response(line: &str) -> bool {
    // A valid JSON-RPC response must contain either "result" or "error".
    // We don't fully parse — just enough to confirm the process speaks JSON-RPC.
    line.contains("\"result\"") || line.contains("\"error\"")
}

/// Spawn the agent command, returning the child process with piped stdio.
fn spawn_stdio(command: &str) -> std::io::Result<Child> {
    let mut parts = command.split_whitespace();
    let binary = parts.next().unwrap_or_default();
    if binary.is_empty() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "empty command",
        ));
    }
    let args: Vec<&str> = parts.collect();

    Command::new(binary)
        .args(&args)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
}

/// Kill a child process and wait for it to exit (best-effort cleanup).
async fn kill_child(mut child: Child) {
    let _ = child.start_kill();
    let _ = child.wait().await;
}

/// Probe stdio transport: spawn agent, write ACP initialize, wait for JSON-RPC response.
///
/// Returns `true` if the agent responded to the initialize request on stdout.
async fn probe_stdio(command: &str) -> bool {
    let mut child = match spawn_stdio(command) {
        Ok(c) => c,
        Err(e) => {
            debug!(command = %command, error = %e, "Transport probe: failed to spawn stdio process");
            return false;
        }
    };

    // Write the initialize request to stdin.
    let init_body = initialize_request_json();
    if let Some(mut stdin) = child.stdin.take() {
        let write_result = async {
            stdin
                .write_all(format!("{init_body}\n").as_bytes())
                .await?;
            stdin.flush().await
        }
        .await;
        if let Err(e) = write_result {
            debug!(command = %command, error = %e, "Transport probe: failed to write initialize to stdin");
            kill_child(child).await;
            return false;
        }
    }

    // Read stdout lines, looking for a JSON-RPC response.
    let found_response = if let Some(stdout) = child.stdout.take() {
        timeout(PROBE_TIMEOUT, async move {
            let mut lines = BufReader::new(stdout).lines();
            loop {
                match lines.next_line().await {
                    Ok(Some(line)) => {
                        if is_jsonrpc_response(&line) {
                            return true;
                        }
                        // Continue reading — some agents print startup logs first.
                    }
                    _ => return false,
                }
            }
        })
        .await
        .unwrap_or(false)
    } else {
        false
    };

    kill_child(child).await;

    if found_response {
        debug!(command = %command, "Transport probe: stdio responded to ACP initialize");
    }
    found_response
}

/// Probe HTTP transport: spawn agent with --port, wait for TCP, POST ACP initialize.
///
/// Returns `true` if the HTTP endpoint responded to the initialize request.
async fn probe_http(command: &str) -> bool {
    // Reserve an ephemeral port.
    let listener = match tokio::net::TcpListener::bind("127.0.0.1:0").await {
        Ok(l) => l,
        Err(e) => {
            debug!(error = %e, "Transport probe: failed to bind ephemeral port");
            return false;
        }
    };
    let port = match listener.local_addr() {
        Ok(addr) => addr.port(),
        Err(_) => return false,
    };
    drop(listener);

    let mut parts = command.split_whitespace();
    let binary = parts.next().unwrap_or_default();
    if binary.is_empty() {
        return false;
    }
    let args: Vec<&str> = parts.collect();

    let child = match Command::new(binary)
        .args(&args)
        .arg("--port")
        .arg(port.to_string())
        .arg("--hostname")
        .arg("127.0.0.1")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
    {
        Ok(c) => c,
        Err(e) => {
            debug!(command = %command, error = %e, "Transport probe: failed to spawn HTTP process");
            return false;
        }
    };

    let init_body = initialize_request_json();
    let found_response = timeout(PROBE_TIMEOUT, async {
        // Wait for TCP port to become reachable.
        loop {
            if tokio::net::TcpStream::connect(("127.0.0.1", port))
                .await
                .is_ok()
            {
                break;
            }
            tokio::time::sleep(HTTP_TCP_POLL_INTERVAL).await;
        }

        // Send a raw HTTP POST with the ACP initialize body.
        let request = format!(
            "POST /acp HTTP/1.1\r\n\
             Host: 127.0.0.1:{port}\r\n\
             Content-Type: application/json\r\n\
             Content-Length: {}\r\n\
             Connection: close\r\n\
             \r\n\
             {init_body}",
            init_body.len()
        );

        let mut stream = tokio::net::TcpStream::connect(("127.0.0.1", port)).await.ok()?;
        stream.write_all(request.as_bytes()).await.ok()?;

        // Read the response (headers + body).
        let mut buf = vec![0u8; 8192];
        let n = stream.read(&mut buf).await.ok()?;
        let response = String::from_utf8_lossy(&buf[..n]);

        // Accept HTTP 200 or a JSON-RPC response in the body.
        Some(response.contains("200") || response.contains("\"result\""))
    })
    .await
    .unwrap_or(None)
    .unwrap_or(false);

    kill_child(child).await;

    if found_response {
        debug!(command = %command, port = port, "Transport probe: HTTP responded to ACP initialize");
    }
    found_response
}

/// Probe the transport for an agent command.
///
/// Tries stdio first (most ACP agents), then HTTP as a fallback.
/// Returns `"stdio"`, `"http"`, or `None` if both probes fail.
pub async fn probe_transport(command: &str) -> Option<&'static str> {
    if probe_stdio(command).await {
        info!(command = %command, "Transport probe result: stdio");
        return Some("stdio");
    }

    warn!(command = %command, "Transport probe: stdio failed, trying HTTP");
    if probe_http(command).await {
        info!(command = %command, "Transport probe result: http");
        return Some("http");
    }

    warn!(command = %command, "Transport probe: both stdio and HTTP failed");
    None
}

/// Compute a lightweight binary fingerprint (mtime + size) for change detection.
///
/// Uses `stat()` only — no file content hashing. Sufficient to detect binary
/// replacement (upgrade/reinstall) without reading large executables.
pub fn binary_fingerprint(command: &str) -> Option<String> {
    let binary = command.split_whitespace().next()?;
    let path = if std::path::Path::new(binary).is_absolute() {
        std::path::PathBuf::from(binary)
    } else {
        which::which(binary).ok()?
    };

    let metadata = std::fs::metadata(&path).ok()?;
    let mtime = metadata
        .modified()
        .ok()?
        .duration_since(std::time::UNIX_EPOCH)
        .ok()?
        .as_secs();
    Some(format!("{}:{}", mtime, metadata.len()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_initialize_request_json() {
        let body = initialize_request_json();
        assert!(body.contains("\"jsonrpc\""));
        assert!(body.contains("\"method\":\"initialize\""));
    }

    #[test]
    fn test_is_jsonrpc_response() {
        assert!(is_jsonrpc_response(r#"{"jsonrpc":"2.0","id":1,"result":{}}"#));
        assert!(is_jsonrpc_response(r#"{"jsonrpc":"2.0","id":1,"error":{"code":-1}}"#));
        assert!(!is_jsonrpc_response("some random log line"));
        assert!(!is_jsonrpc_response(""));
    }

    #[test]
    fn test_binary_fingerprint_system_binary() {
        // `sh` should exist on Unix systems
        let fp = binary_fingerprint("sh");
        assert!(fp.is_some());
        let fp = fp.unwrap();
        assert!(fp.contains(':')); // format: "mtime:size"
    }

    #[test]
    fn test_binary_fingerprint_missing_binary() {
        assert!(binary_fingerprint("definitely-not-a-real-binary-xyz-123").is_none());
        assert!(binary_fingerprint("").is_none());
    }

    #[tokio::test]
    async fn test_probe_stdio_nonexistent_binary() {
        assert!(!probe_stdio("definitely-not-a-real-binary-xyz-123 acp").await);
    }

    #[tokio::test]
    async fn test_probe_stdio_non_acp_process() {
        // `echo` exits immediately without responding to JSON-RPC
        assert!(!probe_stdio("echo hello").await);
    }
}
