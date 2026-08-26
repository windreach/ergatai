//! WebSocket terminal endpoint for PTY-based agent I/O.
//!
//! Provides bidirectional terminal streaming between the CLI client and
//! the agent's PTY. Uses a binary protocol with type prefix:
//!
//! - `0x01` (Data): Raw terminal bytes (stdin/stdout)
//! - `0x02` (Resize): JSON `{"rows": u16, "cols": u16}` (client → server)
//! - `0x10` (Error): UTF-8 error message (server → client)
//! - `0x11` (Exit): JSON `{"code": i32}` (server → client)

use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        Path, State,
    },
    response::IntoResponse,
};
use futures::{SinkExt, StreamExt};
use std::sync::Arc;
use tokio::sync::Mutex;
use tracing::{debug, error, info, warn};

use ergatai_runtime::get_agent_runtime;

use crate::AppState;

/// WebSocket upgrade handler for terminal I/O.
pub async fn terminal_ws(
    Path(agent_id): Path<String>,
    ws: WebSocketUpgrade,
    State(state): State<AppState>,
) -> impl IntoResponse {
    ws.on_upgrade(move |socket| handle_terminal_ws(socket, agent_id, state))
}

/// Handle WebSocket connection for terminal I/O.
async fn handle_terminal_ws(socket: WebSocket, agent_id: String, _state: AppState) {
    info!(agent_id = %agent_id, "WebSocket terminal connection opened");

    // 1. Look up agent in runtime registry
    let runtime = get_agent_runtime();
    let agent = match runtime.get_agent(&agent_id).await {
        Some(agent) => agent,
        None => {
            warn!(agent_id = %agent_id, "Agent not found for WebSocket terminal");
            // Send error message and close
            let mut socket = socket;
            let error_msg = format!("Agent {} not found", agent_id);
            let mut msg = vec![0x10u8]; // Type=Error
            msg.extend_from_slice(error_msg.as_bytes());
            let _ = socket.send(Message::Binary(msg)).await;
            let _ = socket.send(Message::Close(None)).await;
            return;
        }
    };

    // 2. Get PTY process handle from backend
    let backend = runtime.backend();
    let pty_process = match backend.get_pty_process(&agent.handle).await {
        Ok(Some(process)) => process,
        Ok(None) => {
            warn!(agent_id = %agent_id, "Backend does not support PTY terminal");
            let mut socket = socket;
            let error_msg = "Backend does not support WebSocket terminal (PTY required)";
            let mut msg = vec![0x10u8];
            msg.extend_from_slice(error_msg.as_bytes());
            let _ = socket.send(Message::Binary(msg)).await;
            let _ = socket.send(Message::Close(None)).await;
            return;
        }
        Err(e) => {
            error!(agent_id = %agent_id, error = %e, "Failed to get PTY process");
            let mut socket = socket;
            let error_msg = format!("Failed to get PTY process: {}", e);
            let mut msg = vec![0x10u8];
            msg.extend_from_slice(error_msg.as_bytes());
            let _ = socket.send(Message::Binary(msg)).await;
            let _ = socket.send(Message::Close(None)).await;
            return;
        }
    };

    // 3. Split WebSocket into reader/writer
    let (ws_tx, mut ws_rx) = socket.split();
    let ws_tx = Arc::new(Mutex::new(ws_tx));

    // 4. Spawn writer task: WebSocket → PTY
    let writer_pty = pty_process.clone();
    let writer_backend = backend.clone();
    let writer_handle = agent.handle.clone();
    let writer_task = tokio::spawn(async move {
        info!("Writer task started");
        let mut msg_count = 0u64;
        while let Some(msg) = ws_rx.next().await {
            msg_count += 1;
            match msg {
                Ok(Message::Binary(data)) => {
                    if data.is_empty() {
                        continue;
                    }
                    let msg_type = data[0];
                    match msg_type {
                        0x01 => {
                            let payload = &data[1..];
                            debug!(bytes = payload.len(), "WebSocket → PTY");
                            if let Err(e) = writer_pty.write(payload).await {
                                warn!("PTY write failed: {}", e);
                                break;
                            }
                        }
                        0x02 => {
                            let payload = &data[1..];
                            if let Ok(resize) = serde_json::from_slice::<ResizeMessage>(payload) {
                                debug!(rows = resize.rows, cols = resize.cols, "PTY resize");
                                if let Err(e) = writer_backend
                                    .resize_pty(&writer_handle, resize.rows, resize.cols)
                                    .await
                                {
                                    warn!("PTY resize failed: {}", e);
                                }
                            }
                        }
                        _ => {
                            debug!("Unknown WebSocket message type: 0x{:02x}", msg_type);
                        }
                    }
                }
                Ok(Message::Close(_)) => {
                    debug!("WebSocket closed by client");
                    break;
                }
                Err(e) => {
                    warn!("WebSocket receive error: {}", e);
                    break;
                }
                _ => {}
            }
        }
        info!(total_messages = msg_count, "Writer task exited");
    });

    // 5. Spawn reader task: PTY → WebSocket
    let reader_pty = pty_process.clone();
    let reader_ws_tx = ws_tx.clone();
    let reader_task = tokio::spawn(async move {
        let mut buf = [0u8; 4096];
        info!("Reader task started");
        loop {
            // Check if process has exited
            if reader_pty.has_exited().await {
                let exit_code = reader_pty.wait().await.unwrap_or(-1);
                info!(exit_code, "Process exited");
                let exit_msg = serde_json::json!({"code": exit_code});
                let mut msg = vec![0x11u8]; // Type=Exit
                msg.extend_from_slice(exit_msg.to_string().as_bytes());

                let mut tx = reader_ws_tx.lock().await;
                let _ = tx.send(Message::Binary(msg)).await;
                let _ = tx.send(Message::Close(None)).await;
                break;
            }

            // Non-blocking read with short timeout
            match tokio::time::timeout(
                std::time::Duration::from_millis(100),
                reader_pty.read(&mut buf),
            )
            .await
            {
                Ok(Ok(n)) if n > 0 => {
                    debug!(bytes = n, "PTY → WebSocket");
                    let mut msg = Vec::with_capacity(1 + n);
                    msg.push(0x01); // Type=Data
                    msg.extend_from_slice(&buf[..n]);

                    let mut tx = reader_ws_tx.lock().await;
                    if tx.send(Message::Binary(msg)).await.is_err() {
                        debug!("WebSocket send failed, reader exiting");
                        break;
                    }
                }
                Ok(Ok(_)) => {
                    // 0 bytes — EOF, process likely exited
                    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                }
                Ok(Err(e)) => {
                    debug!("PTY read error: {}", e);
                    break;
                }
                Err(_) => {
                    // Timeout — no data available, loop and check exit
                }
            }
        }
    });

    // Get abort handles before moving into select!
    let writer_abort = writer_task.abort_handle();
    let reader_abort = reader_task.abort_handle();

    // 6. Wait for either task to exit
    tokio::select! {
        _ = writer_task => {
            debug!("Writer task exited");
            reader_abort.abort();
        }
        _ = reader_task => {
            debug!("Reader task exited");
            writer_abort.abort();
        }
    }

    // 7. Resume background PTY reader (paused when WebSocket connected)
    if let Err(e) = backend.resume_pty_reader(&agent.handle).await {
        warn!(agent_id = %agent_id, error = %e, "Failed to resume background PTY reader");
    }

    info!(agent_id = %agent_id, "WebSocket terminal connection closed");
}

/// Resize message payload (JSON).
#[derive(serde::Deserialize)]
struct ResizeMessage {
    rows: u16,
    cols: u16,
}
