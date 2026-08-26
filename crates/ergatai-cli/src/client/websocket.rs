//! WebSocket terminal client for connecting to PTY-based agents.
//!
//! WebSocket-based terminal streaming that provides direct PTY access
//! streams PTY I/O bidirectionally. Uses crossterm for raw terminal mode.

use anyhow::{Context, Result};
use crossterm::terminal::{disable_raw_mode, enable_raw_mode};
use futures_util::{SinkExt, StreamExt};
use std::io::stdout;
use tokio_tungstenite::{connect_async, tungstenite::Message};

/// WebSocket message type prefixes (must match server protocol).
const MSG_TYPE_DATA: u8 = 0x01;
const MSG_TYPE_RESIZE: u8 = 0x02;
const MSG_TYPE_EXIT: u8 = 0x11;

/// Connect to agent terminal via WebSocket and enter interactive mode.
///
/// This function:
/// 1. Builds WebSocket URL from API URL
/// 2. Connects to WebSocket endpoint
/// 3. Enters raw terminal mode
/// 4. Spawns bidirectional I/O tasks (stdin → WebSocket, WebSocket → stdout)
/// 5. Handles terminal resize events
/// 6. Exits when agent terminates or user disconnects
pub async fn attach_terminal(agent_id: &str, api_url: &str, token: Option<&str>) -> Result<()> {
    // 1. Build WebSocket URL
    let ws_url = build_ws_url(api_url, agent_id)?;

    // 2. Build WebSocket request with optional auth header
    let mut request =
        tokio_tungstenite::tungstenite::client::IntoClientRequest::into_client_request(&ws_url)?;
    if let Some(token) = token {
        request
            .headers_mut()
            .insert("Authorization", format!("Bearer {}", token).parse()?);
    }

    // 3. Connect to WebSocket
    let (ws_stream, _) = connect_async(request)
        .await
        .context("Failed to connect to WebSocket terminal")?;

    let (mut ws_tx, mut ws_rx) = ws_stream.split();

    // 4. Enter raw mode
    enable_raw_mode().context("Failed to enable raw terminal mode")?;

    // Send initial terminal size
    let (cols, rows) = crossterm::terminal::size()?;
    let resize_msg = build_resize_message(rows, cols);
    ws_tx.send(Message::Binary(resize_msg)).await.ok();

    // 5. Spawn writer task: stdin → WebSocket
    // Read raw bytes from stdin directly (bypasses crossterm event parser which
    // gets confused by terminal escape sequences in the output).
    let (stdin_tx, mut stdin_rx) = tokio::sync::mpsc::unbounded_channel::<Vec<u8>>();

    // Blocking thread: reads raw bytes from stdin and sends them to the async writer.
    std::thread::spawn(move || {
        use std::io::Read;
        let mut buf = [0u8; 256];
        loop {
            match std::io::stdin().read(&mut buf) {
                Ok(0) => break, // EOF
                Ok(n) => {
                    let data = buf[..n].to_vec();
                    if stdin_tx.send(data).is_err() {
                        break;
                    }
                }
                Err(e) => {
                    if e.kind() == std::io::ErrorKind::WouldBlock {
                        std::thread::sleep(std::time::Duration::from_millis(10));
                        continue;
                    }
                    break;
                }
            }
        }
    });

    let writer_handle = tokio::spawn(async move {
        while let Some(data) = stdin_rx.recv().await {
            // Check for exit keys (Ctrl+C = 0x03, Ctrl+D = 0x04)
            // Only trigger on exact single-byte matches to avoid false positives from pasted content
            let should_exit = data.len() == 1 && (data[0] == 0x03 || data[0] == 0x04);

            // Forward raw bytes to WebSocket
            let mut msg = vec![MSG_TYPE_DATA];
            msg.extend(&data);
            if ws_tx.send(Message::Binary(msg)).await.is_err() {
                break;
            }

            if should_exit {
                break;
            }
        }
    });

    // 6. Spawn reader task: WebSocket → stdout
    let reader_handle = tokio::spawn(async move {
        while let Some(msg) = ws_rx.next().await {
            match msg {
                Ok(Message::Binary(data)) => {
                    if data.is_empty() {
                        continue;
                    }
                    let msg_type = data[0];
                    match msg_type {
                        MSG_TYPE_DATA => {
                            // Terminal output: write to stdout
                            let payload = &data[1..];
                            use std::io::Write;
                            let mut out = stdout();
                            if out.write_all(payload).is_err() {
                                break;
                            }
                            if out.flush().is_err() {
                                break;
                            }
                        }
                        MSG_TYPE_EXIT => {
                            // Agent exited — parse exit code and break
                            let payload = &data[1..];
                            if let Ok(exit_json) =
                                serde_json::from_slice::<serde_json::Value>(payload)
                            {
                                if let Some(code) = exit_json.get("code").and_then(|c| c.as_i64()) {
                                    // Exit code received
                                    let _ = code;
                                }
                            }
                            break;
                        }
                        _ => {} // Ignore unknown message types
                    }
                }
                Ok(Message::Close(_)) => break,
                Err(_) => break,
                _ => {} // Ignore text/ping/pong
            }
        }
    });

    // 7. Wait for either task to exit
    tokio::select! {
        _ = writer_handle => {}
        _ = reader_handle => {}
    }

    // 8. Restore terminal
    disable_raw_mode().context("Failed to disable raw terminal mode")?;

    Ok(())
}

/// Build WebSocket URL from HTTP API URL.
fn build_ws_url(api_url: &str, agent_id: &str) -> Result<String> {
    let ws_url = api_url
        .replace("http://", "ws://")
        .replace("https://", "wss://");

    Ok(format!("{}/api/v1/agents/{}/terminal", ws_url, agent_id))
}

/// Build resize message (type prefix + JSON payload).
fn build_resize_message(rows: u16, cols: u16) -> Vec<u8> {
    let resize_json = serde_json::json!({"rows": rows, "cols": cols});
    let mut msg = vec![MSG_TYPE_RESIZE];
    msg.extend_from_slice(resize_json.to_string().as_bytes());
    msg
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_build_ws_url_http() {
        let url = build_ws_url("http://localhost:3000", "agent-123").unwrap();
        assert_eq!(url, "ws://localhost:3000/api/v1/agents/agent-123/terminal");
    }

    #[test]
    fn test_build_ws_url_https() {
        let url = build_ws_url("https://api.example.com", "agent-456").unwrap();
        assert_eq!(
            url,
            "wss://api.example.com/api/v1/agents/agent-456/terminal"
        );
    }

    #[test]
    fn test_build_resize_message() {
        let msg = build_resize_message(50, 200);
        assert_eq!(msg[0], MSG_TYPE_RESIZE);
        let payload = &msg[1..];
        let json: serde_json::Value = serde_json::from_slice(payload).unwrap();
        assert_eq!(json["rows"], 50);
        assert_eq!(json["cols"], 200);
    }
}
