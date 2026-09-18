//! Lifecycle manager for the Bun collaboration runtime sidecar.

use std::{
    collections::{HashMap, VecDeque},
    path::PathBuf,
    process::Stdio,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    },
    time::Duration,
};

use anyhow::{anyhow, Result};
use serde_json::{json, Value};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStdin, Command},
    sync::{broadcast, oneshot, Mutex},
    task::JoinHandle,
    time::timeout,
};

const PROTOCOL_VERSION: u32 = 1;

#[derive(Debug, Clone)]
pub struct CollabRuntimeConfig {
    pub program: PathBuf,
    pub args: Vec<String>,
    pub data_dir: PathBuf,
    pub token: String,
    pub startup_timeout: Duration,
    pub request_timeout: Duration,
}

type PendingRequests = Arc<Mutex<HashMap<String, oneshot::Sender<Result<Value, String>>>>>;

struct CollabRuntimeInner {
    config: CollabRuntimeConfig,
    child: Mutex<Option<Child>>,
    stdin: Mutex<Option<ChildStdin>>,
    pending: PendingRequests,
    next_request_id: AtomicU64,
    event_tx: broadcast::Sender<Value>,
    event_history: Arc<Mutex<VecDeque<Value>>>,
}

#[derive(Clone)]
pub struct CollabRuntimeManager {
    inner: Arc<CollabRuntimeInner>,
}

impl CollabRuntimeManager {
    pub fn new(config: CollabRuntimeConfig) -> Self {
        let (event_tx, _) = broadcast::channel(1024);
        Self {
            inner: Arc::new(CollabRuntimeInner {
                config,
                child: Mutex::new(None),
                stdin: Mutex::new(None),
                pending: Arc::new(Mutex::new(HashMap::new())),
                next_request_id: AtomicU64::new(1),
                event_tx,
                event_history: Arc::new(Mutex::new(VecDeque::new())),
            }),
        }
    }

    pub fn subscribe(&self) -> broadcast::Receiver<Value> {
        self.inner.event_tx.subscribe()
    }

    pub async fn recent_events(&self, limit: usize) -> Vec<Value> {
        let history = self.inner.event_history.lock().await;
        let start = history.len().saturating_sub(limit);
        history.iter().skip(start).cloned().collect()
    }

    pub async fn start(&self) -> Result<()> {
        if self.has_live_child().await? {
            return Ok(());
        }

        tokio::fs::create_dir_all(&self.inner.config.data_dir).await?;
        let mut child = Command::new(&self.inner.config.program)
            .args(&self.inner.config.args)
            .env("ERGATAI_COLLAB_RUNTIME_TOKEN", &self.inner.config.token)
            .env(
                "ERGATAI_COLLAB_RUNTIME_DATA_DIR",
                &self.inner.config.data_dir,
            )
            .env(
                "ERGATAI_COLLAB_RUNTIME_PROTOCOL_VERSION",
                PROTOCOL_VERSION.to_string(),
            )
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .kill_on_drop(true)
            .spawn()?;

        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| anyhow!("collab runtime did not expose stdin"))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| anyhow!("collab runtime did not expose stdout"))?;

        {
            let mut state_child = self.inner.child.lock().await;
            let mut state_stdin = self.inner.stdin.lock().await;
            *state_stdin = Some(stdin);
            *state_child = Some(child);
        }

        spawn_stdout_reader(
            stdout,
            Arc::clone(&self.inner.pending),
            self.event_sink().await,
        );

        match self
            .request("hello", json!({}), self.inner.config.startup_timeout)
            .await
        {
            Ok(response) => {
                let version = response.get("protocolVersion").and_then(Value::as_u64);
                if version != Some(u64::from(PROTOCOL_VERSION)) {
                    self.force_kill().await;
                    return Err(anyhow!(
                        "collab runtime protocol mismatch: expected {}, got {:?}",
                        PROTOCOL_VERSION,
                        version
                    ));
                }
                tracing::info!("✅ Collaboration runtime started and authenticated");
                Ok(())
            }
            Err(error) => {
                self.force_kill().await;
                Err(anyhow!("failed to initialize collab runtime: {error}"))
            }
        }
    }

    pub async fn health(&self) -> Result<Value> {
        self.request("health", json!({}), self.inner.config.request_timeout)
            .await
    }

    pub async fn apply_interaction(
        &self,
        interaction: Value,
        collaboration_mode: Option<&str>,
    ) -> Result<Value> {
        let mut payload = json!({ "interaction": interaction });
        if let Some(mode) = collaboration_mode {
            payload["collaborationMode"] = Value::String(mode.to_string());
        }
        self.request(
            "apply_interaction",
            payload,
            self.inner.config.request_timeout,
        )
        .await
    }

    pub async fn restart(&self) -> Result<()> {
        self.shutdown().await?;
        self.start().await
    }

    pub async fn shutdown(&self) -> Result<()> {
        let had_child = self.inner.child.lock().await.is_some();
        let shutdown_request = self
            .request("shutdown", json!({}), Duration::from_secs(2))
            .await;

        let mut child_guard = self.inner.child.lock().await;
        if let Some(child) = child_guard.as_mut() {
            match timeout(Duration::from_secs(3), child.wait()).await {
                Ok(status) => {
                    tracing::info!(?status, "Collaboration runtime exited");
                }
                Err(_) => {
                    tracing::warn!("Collaboration runtime did not stop gracefully; killing");
                    child.kill().await?;
                    child.wait().await?;
                }
            }
        }

        *child_guard = None;
        *self.inner.stdin.lock().await = None;
        self.fail_pending("collaboration runtime stopped").await;

        match shutdown_request {
            Ok(_) => Ok(()),
            Err(_error) if !had_child => Ok(()),
            Err(error) => Err(error),
        }
    }

    async fn has_live_child(&self) -> Result<bool> {
        let mut child_guard = self.inner.child.lock().await;
        match child_guard.as_mut() {
            Some(child) => {
                if child.try_wait()?.is_some() {
                    *child_guard = None;
                    *self.inner.stdin.lock().await = None;
                    Ok(false)
                } else {
                    Ok(true)
                }
            }
            None => Ok(false),
        }
    }

    async fn request(
        &self,
        command_type: &str,
        payload: Value,
        request_timeout: Duration,
    ) -> Result<Value> {
        let command = if payload.as_object().is_some() {
            let mut command = json!({ "type": command_type });
            if let (Some(target), Some(source)) = (command.as_object_mut(), payload.as_object()) {
                for (key, value) in source {
                    target.insert(key.clone(), value.clone());
                }
            }
            command
        } else {
            json!({ "type": command_type })
        };

        let request_id = self.inner.next_request_id.fetch_add(1, Ordering::Relaxed);
        let request_id = format!("req_{request_id}");
        let (response_tx, response_rx) = oneshot::channel();
        self.inner
            .pending
            .lock()
            .await
            .insert(request_id.clone(), response_tx);

        let frame = json!({
            "id": request_id,
            "protocolVersion": PROTOCOL_VERSION,
            "token": self.inner.config.token,
            "command": command,
        });

        let write_result = {
            let mut stdin_guard = self.inner.stdin.lock().await;
            match stdin_guard.as_mut() {
                Some(stdin) => stdin.write_all(format!("{frame}\n").as_bytes()).await,
                None => Err(std::io::Error::new(
                    std::io::ErrorKind::NotConnected,
                    "collab runtime stdin is not available",
                )),
            }
        };

        if let Err(error) = write_result {
            self.inner.pending.lock().await.remove(&request_id);
            return Err(error.into());
        }

        match timeout(request_timeout, response_rx).await {
            Ok(Ok(Ok(value))) => Ok(value),
            Ok(Ok(Err(message))) => Err(anyhow!("collab runtime request failed: {message}")),
            Ok(Err(_)) => Err(anyhow!("collab runtime response channel closed")),
            Err(_) => {
                self.inner.pending.lock().await.remove(&request_id);
                Err(anyhow!("collab runtime request timed out"))
            }
        }
    }

    async fn fail_pending(&self, reason: &str) {
        let mut pending = self.inner.pending.lock().await;
        for (_, response_tx) in pending.drain() {
            let _ = response_tx.send(Err(reason.to_string()));
        }
    }

    async fn force_kill(&self) {
        let mut child_guard = self.inner.child.lock().await;
        if let Some(mut child) = child_guard.take() {
            let _ = child.kill().await;
        }
        *self.inner.stdin.lock().await = None;
        self.fail_pending("collaboration runtime was killed").await;
    }

    async fn event_sink(&self) -> Arc<RuntimeEventSink> {
        Arc::new(RuntimeEventSink {
            sender: self.inner.event_tx.clone(),
            history: Arc::clone(&self.inner.event_history),
        })
    }
}

struct RuntimeEventSink {
    sender: broadcast::Sender<Value>,
    history: Arc<Mutex<VecDeque<Value>>>,
}

impl RuntimeEventSink {
    async fn send(&self, event: Value) {
        {
            let mut history = self.history.lock().await;
            history.push_back(event.clone());
            while history.len() > 256 {
                history.pop_front();
            }
        }
        let _ = self.sender.send(event);
    }
}

fn spawn_stdout_reader(
    stdout: tokio::process::ChildStdout,
    pending: PendingRequests,
    event_sink: Arc<RuntimeEventSink>,
) -> JoinHandle<()> {
    tokio::spawn(async move {
        let mut lines = BufReader::new(stdout).lines();
        loop {
            match lines.next_line().await {
                Ok(Some(line)) => {
                    if line.len() > 1024 * 1024 {
                        tracing::warn!("Discarding oversized collab runtime frame");
                        continue;
                    }

                    let frame: Value = match serde_json::from_str(&line) {
                        Ok(frame) => frame,
                        Err(error) => {
                            tracing::warn!(error = %error, line, "Invalid collab runtime frame");
                            continue;
                        }
                    };

                    let request_id = frame.get("id").and_then(Value::as_str);
                    if let Some(request_id) = request_id {
                        let response = if frame.get("ok") == Some(&Value::Bool(true)) {
                            Ok(frame.get("result").cloned().unwrap_or(Value::Null))
                        } else {
                            Err(frame
                                .pointer("/error/message")
                                .and_then(Value::as_str)
                                .unwrap_or("unknown collab runtime error")
                                .to_string())
                        };

                        let responder = pending.lock().await.remove(request_id);
                        if let Some(response_tx) = responder {
                            let _ = response_tx.send(response);
                        } else {
                            tracing::warn!(
                                request_id,
                                "Received collab runtime response without pending request"
                            );
                        }
                    } else {
                        event_sink.send(frame).await;
                    }
                }
                Ok(None) => break,
                Err(error) => {
                    tracing::error!(error = %error, "Failed reading collab runtime stdout");
                    break;
                }
            }
        }

        let mut pending = pending.lock().await;
        for (_, response_tx) in pending.drain() {
            let _ = response_tx.send(Err("collab runtime stdout closed".to_string()));
        }
    })
}
