//! Interactive terminal sessions backed by a native PTY.

use std::{
    io::{Read, Write},
    sync::{Arc, Mutex},
};

use axum::{
    extract::{
        ws::{Message as WebSocketMessage, WebSocket, WebSocketUpgrade},
        Query, State,
    },
    response::{IntoResponse, Response},
};
use futures::{SinkExt, StreamExt};
use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use serde::{Deserialize, Serialize};
use tokio::sync::mpsc;

use crate::AppState;

#[derive(Debug, Deserialize)]
pub struct TerminalQuery {
    cwd: Option<String>,
    cols: Option<u16>,
    rows: Option<u16>,
}

#[derive(Debug, Serialize)]
pub struct TerminalCreated {
    pub cwd: String,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum TerminalClientMessage {
    Input { data: String },
    Resize { cols: u16, rows: u16 },
}

/// GET /api/v1/terminals/ws — create a PTY session and attach it to a WebSocket.
pub async fn create_terminal(
    State(state): State<AppState>,
    Query(query): Query<TerminalQuery>,
    websocket: WebSocketUpgrade,
) -> Response {
    let cwd = match query.cwd.as_deref() {
        Some(cwd) => match crate::validate_cwd_with_allowed_dirs(cwd, &state.allowed_dirs) {
            Ok(cwd) => cwd,
            Err(error) => {
                return crate::http_error::bad_request(error).into_response();
            }
        },
        None => {
            // Validate the current directory as a fallback
            let current = std::env::current_dir().unwrap_or_else(|_| std::path::PathBuf::from("."));
            match crate::validate_cwd_with_allowed_dirs(
                current.to_str().unwrap_or("."),
                &state.allowed_dirs,
            ) {
                Ok(validated) => validated,
                Err(error) => {
                    return crate::http_error::bad_request(error).into_response();
                }
            }
        }
    };
    let cols = query.cols.unwrap_or(80).clamp(1, 500);
    let rows = query.rows.unwrap_or(24).clamp(1, 200);
    let cwd = cwd.to_string_lossy().into_owned();

    websocket.on_upgrade(move |socket| run_terminal(socket, cwd, cols, rows))
}

async fn run_terminal(socket: WebSocket, cwd: String, cols: u16, rows: u16) {
    let pty_system = native_pty_system();
    let pair = match pty_system.openpty(PtySize {
        rows,
        cols,
        pixel_width: 0,
        pixel_height: 0,
    }) {
        Ok(pair) => pair,
        Err(error) => {
            tracing::error!(error = %error, "Failed to open PTY");
            return;
        }
    };

    let mut command = CommandBuilder::new(default_shell());
    command.cwd(&cwd);
    command.env("TERM", "xterm-256color");

    let mut child = match pair.slave.spawn_command(command) {
        Ok(child) => child,
        Err(error) => {
            tracing::error!(error = %error, cwd = %cwd, "Failed to spawn terminal shell");
            return;
        }
    };
    let mut killer = child.clone_killer();
    let reader = match pair.master.try_clone_reader() {
        Ok(reader) => reader,
        Err(error) => {
            tracing::error!(error = %error, "Failed to read from PTY");
            let _ = killer.kill();
            return;
        }
    };
    let writer = match pair.master.take_writer() {
        Ok(writer) => Arc::new(Mutex::new(writer)),
        Err(error) => {
            tracing::error!(error = %error, "Failed to write to PTY");
            let _ = killer.kill();
            return;
        }
    };
    let (resize_tx, resize_rx) = std::sync::mpsc::channel::<PtySize>();
    spawn_pty_resizer(pair.master, resize_rx);
    drop(pair.slave);

    let (output_tx, mut output_rx) = mpsc::channel::<String>(256);
    spawn_pty_reader(reader, output_tx);

    let (mut websocket_sender, mut websocket_receiver) = socket.split();
    let pty_to_client = async {
        while let Some(output) = output_rx.recv().await {
            if websocket_sender
                .send(WebSocketMessage::Text(output.into()))
                .await
                .is_err()
            {
                break;
            }
        }
    };

    let client_to_pty = async {
        while let Some(Ok(message)) = websocket_receiver.next().await {
            let WebSocketMessage::Text(text) = message else {
                continue;
            };

            let parsed: TerminalClientMessage = match serde_json::from_str(&text) {
                Ok(message) => message,
                Err(error) => {
                    tracing::debug!(error = %error, "Ignoring invalid terminal message");
                    continue;
                }
            };

            match parsed {
                TerminalClientMessage::Input { data } => {
                    let result = writer.lock().map(|mut writer| {
                        writer
                            .write_all(data.as_bytes())
                            .and_then(|()| writer.flush())
                    }).map_err(|e| {
                        tracing::warn!(error = %e, "Mutex poisoned, terminal writer unavailable");
                        e
                    });
                    if let Err(error) = result {
                        tracing::debug!(error = %error, "Failed to write terminal input");
                        break;
                    }
                }
                TerminalClientMessage::Resize { cols, rows } => {
                    if cols == 0 || rows == 0 || cols > 500 || rows > 200 {
                        continue;
                    }
                    if let Err(error) = resize_tx.send(PtySize {
                        rows,
                        cols,
                        pixel_width: 0,
                        pixel_height: 0,
                    }) {
                        tracing::debug!(error = %error, "Failed to resize PTY");
                    }
                }
            }
        }
    };

    tokio::select! {
        _ = pty_to_client => {
            tracing::debug!("PTY output stream ended");
        }
        _ = client_to_pty => {
            tracing::debug!("Client WebSocket closed");
        }
        // NOTE: No inactivity timeout — the WebSocket close or PTY exit handles cleanup.
        // A fixed timeout would kill sessions when users read output, type long commands,
        // or step away temporarily.
    }

    if let Err(e) = killer.kill() {
        tracing::debug!(error = %e, "Failed to kill terminal process");
    }
    drop(writer);

    // Wait for child process with timeout to prevent zombie processes
    tokio::task::spawn_blocking(move || {
        let wait_timeout = std::time::Duration::from_secs(5);
        let start = std::time::Instant::now();

        loop {
            match child.try_wait() {
                Ok(Some(status)) => {
                    tracing::debug!(?status, "Terminal child process exited");
                    return;
                }
                Ok(None) => {
                    // Process still running
                    if start.elapsed() > wait_timeout {
                        tracing::warn!("Terminal child process did not exit within 5s, force killing");
                        let _ = child.kill();
                        let _ = child.wait();
                        return;
                    }
                    std::thread::sleep(std::time::Duration::from_millis(100));
                }
                Err(e) => {
                    tracing::error!(error = %e, "Failed to wait for terminal child process");
                    return;
                }
            }
        }
    });
}

fn spawn_pty_reader(mut reader: Box<dyn Read + Send>, output_tx: mpsc::Sender<String>) {
    std::thread::spawn(move || {
        // Increased buffer size from 8KB to 32KB for better performance with large outputs
        let mut buffer = [0_u8; 32_768];
        loop {
            match reader.read(&mut buffer) {
                Ok(0) => break,
                Ok(length) => {
                    let output = String::from_utf8_lossy(&buffer[..length]).to_string();
                    if output_tx.blocking_send(output).is_err() {
                        break;
                    }
                }
                Err(error) => {
                    tracing::debug!(error = %error, "PTY reader stopped");
                    break;
                }
            }
        }
    });
}

fn spawn_pty_resizer(
    master: Box<dyn portable_pty::MasterPty + Send>,
    resize_rx: std::sync::mpsc::Receiver<PtySize>,
) {
    std::thread::spawn(move || {
        for size in resize_rx {
            if master.resize(size).is_err() {
                break;
            }
        }
    });
}

#[cfg(unix)]
fn default_shell() -> String {
    std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".to_string())
}

#[cfg(windows)]
fn default_shell() -> String {
    std::env::var("COMSPEC").unwrap_or_else(|_| "powershell.exe".to_string())
}

#[cfg(test)]
#[path = "terminal_test.rs"]
mod tests;
