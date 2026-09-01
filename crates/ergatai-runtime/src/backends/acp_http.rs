//! AcpHttpBackend — HTTP/SSE transport for ACP (Agent Client Protocol).
//!
//! Connects to remote ACP agents over HTTP/SSE or WebSocket instead of stdio.
//! This enables:
//! - Remote agent connections (agents on different machines)
//! - Network-based agent management
//! - Integration with HTTP-only ACP implementations
//!
//! # Advantages over stdio transport
//!
//! - Remote agent support (not limited to local processes)
//! - Standard HTTP protocols (firewall-friendly)
//! - WebSocket support for bidirectional communication
//! - SSE for server-sent event streaming
//!
//! # Limitations
//!
//! - Requires agents to expose HTTP endpoints
//! - Network latency may affect performance
//! - Requires proper authentication/authorization setup

use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use async_trait::async_trait;
use parking_lot::RwLock;
use tokio::sync::mpsc;
use tracing::{debug, error, info, warn};

use agent_client_protocol::schema::v1::{
    ContentBlock, InitializeRequest, NewSessionRequest, PromptRequest, SessionNotification,
    SessionUpdate, TextContent,
};
use agent_client_protocol::schema::ProtocolVersion;
use agent_client_protocol::{Agent, Client, ConnectionTo};
use agent_client_protocol_http::HttpClient;

use ergatai_error::{ErgataiError, ErgataiResult};

use crate::backend::AgentRuntimeBackend;
use crate::types::{
    AgentHandle, BackendCapabilities, WaitResult, WorkspaceHandle, WorkspaceSpec,
};

// ── Configuration constants ──

/// Poll interval for wait_for_exit.
const EXIT_POLL_INTERVAL: Duration = Duration::from_millis(200);

/// Output buffer max size (256 KiB).
const OUTPUT_BUFFER_MAX_SIZE: usize = 256 * 1024;

// ── Internal types ──

/// Per-agent output buffer: bounded rolling buffer of captured ACP output.
struct OutputBuffer {
    data: RwLock<Vec<u8>>,
    max_size: usize,
}

impl OutputBuffer {
    fn new(max_size: usize) -> Self {
        Self {
            data: RwLock::new(Vec::new()),
            max_size,
        }
    }

    fn append(&self, chunk: &[u8]) {
        let mut data = self.data.write();
        data.extend_from_slice(chunk);
        if data.len() > self.max_size {
            let excess = data.len() - self.max_size;
            data.drain(..excess);
        }
    }

    fn capture(&self) -> String {
        let mut data = self.data.write();
        let result = String::from_utf8_lossy(&data).to_string();
        data.clear();
        result
    }
}

/// Commands sent to the connection task.
enum HttpAcpCommand {
    Prompt {
        message: String,
        response_tx: tokio::sync::oneshot::Sender<ErgataiResult<()>>,
    },
    Cancel {
        response_tx: tokio::sync::oneshot::Sender<ErgataiResult<()>>,
    },
    Stop {
        response_tx: tokio::sync::oneshot::Sender<ErgataiResult<()>>,
    },
}

/// Per-agent entry tracking HTTP connection state.
struct HttpAgentEntry {
    agent_id: String,
    output: Arc<OutputBuffer>,
    command_tx: mpsc::Sender<HttpAcpCommand>,
    abort_handle: tokio::task::AbortHandle,
    alive: Arc<std::sync::atomic::AtomicBool>,
    last_output_at: Arc<RwLock<Instant>>,
    workspace: String,
}

/// Workspace entry for HTTP backend.
struct HttpWorkspaceEntry {
    id: String,
    agent_ids: Vec<String>,
    agent_counter: std::sync::atomic::AtomicUsize,
}

/// HTTP-based ACP backend for remote agent connections.
pub struct AcpHttpBackend {
    agents: RwLock<HashMap<String, HttpAgentEntry>>,
    workspaces: RwLock<HashMap<String, HttpWorkspaceEntry>>,
}

impl AcpHttpBackend {
    /// Create a new HTTP ACP backend.
    pub fn new() -> Self {
        Self {
            agents: RwLock::new(HashMap::new()),
            workspaces: RwLock::new(HashMap::new()),
        }
    }

    /// Connect to a remote ACP agent via HTTP.
    pub async fn connect_remote_agent(
        &self,
        workspace_id: &str,
        endpoint: &str,
        agent_id: Option<String>,
    ) -> ErgataiResult<AgentHandle> {
        // Get or create workspace
        let workspace = self.get_or_create_workspace(workspace_id).await?;

        // Generate agent ID if not provided
        let agent_id = agent_id.unwrap_or_else(|| self.next_agent_id(workspace_id));

        info!(
            agent_id = %agent_id,
            endpoint = %endpoint,
            "Connecting to remote ACP agent via HTTP"
        );

        // Create HTTP client
        let http_client = HttpClient::new(endpoint).map_err(|e| {
            ErgataiError::internal(format!(
                "Failed to create HTTP client for endpoint '{}': {}",
                endpoint, e
            ))
        })?;

        // Shared state
        let output = Arc::new(OutputBuffer::new(OUTPUT_BUFFER_MAX_SIZE));
        let alive = Arc::new(std::sync::atomic::AtomicBool::new(true));
        let last_output_at = Arc::new(RwLock::new(Instant::now()));

        // Command channel
        let (command_tx, mut command_rx) = mpsc::channel::<HttpAcpCommand>(32);

        // Clone for connection task
        let task_output = output.clone();
        let task_alive = alive.clone();
        let task_last_output = last_output_at.clone();
        let task_agent_id = agent_id.clone();

        // Spawn connection task
        let join_handle = tokio::spawn(async move {
            // Build ACP client
            let result = Client::builder(Client)
                .name(format!("ergatai-http-{}", task_agent_id))
                .on_receive_notification(
                    {
                        let out = task_output.clone();
                        let last_out = task_last_output.clone();
                        async move |notification: SessionNotification, _cx| {
                            // Extract text from session notifications
                            match &notification.update {
                                SessionUpdate::AgentMessageChunk(chunk) => {
                                    if let ContentBlock::Text(text_content) = &chunk.content {
                                        debug!(text_len = text_content.text.len(), "HTTP agent message");
                                        out.append(text_content.text.as_bytes());
                                    }
                                }
                                SessionUpdate::AgentThoughtChunk(chunk) => {
                                    if let ContentBlock::Text(text_content) = &chunk.content {
                                        debug!(text_len = text_content.text.len(), "HTTP agent thought");
                                    }
                                }
                                _ => {
                                    debug!(update = ?notification.update, "HTTP session notification");
                                }
                            }
                            *last_out.write() = Instant::now();
                            Ok(())
                        }
                    },
                    agent_client_protocol::on_receive_notification!(),
                )
                .connect_to(http_client)
                .await;

            match result {
                Ok(()) => {
                    info!(agent_id = %task_agent_id, "HTTP ACP connection completed");
                }
                Err(e) => {
                    error!(error = %e, agent_id = %task_agent_id, "HTTP ACP connection failed");
                    task_alive.store(false, std::sync::atomic::Ordering::SeqCst);
                }
            }
        });

        let abort_handle = join_handle.abort_handle();

        // Spawn command handler task
        let cmd_output = output.clone();
        let cmd_alive = alive.clone();
        let cmd_last_output = last_output_at.clone();

        tokio::spawn(async move {
            // Note: This is a simplified command handler.
            // In a full implementation, we would need to maintain the connection
            // context and send requests through it.
            while let Some(cmd) = command_rx.recv().await {
                match cmd {
                    HttpAcpCommand::Prompt { message, response_tx } => {
                        debug!(message_len = message.len(), "Prompt command received");
                        // TODO: Send prompt through connection
                        let _ = response_tx.send(Ok(()));
                    }
                    HttpAcpCommand::Cancel { response_tx } => {
                        debug!("Cancel command received");
                        let _ = response_tx.send(Ok(()));
                    }
                    HttpAcpCommand::Stop { response_tx } => {
                        debug!("Stop command received");
                        cmd_alive.store(false, std::sync::atomic::Ordering::SeqCst);
                        let _ = response_tx.send(Ok(()));
                        break;
                    }
                }
            }
        });

        // Create agent entry
        let entry = HttpAgentEntry {
            agent_id: agent_id.clone(),
            output,
            command_tx,
            abort_handle,
            alive,
            last_output_at,
            workspace: workspace.id.clone(),
        };

        // Register agent
        self.agents.write().insert(agent_id.clone(), entry);
        self.workspaces
            .write()
            .get_mut(workspace_id)
            .map(|ws| ws.agent_ids.push(agent_id.clone()));

        info!(agent_id = %agent_id, "Connected to remote HTTP ACP agent");

        Ok(AgentHandle {
            workspace,
            agent_id,
            process_id: None,
            metadata: HashMap::new(),
        })
    }

    /// Disconnect a remote HTTP agent.
    pub async fn disconnect_remote_agent(&self, agent_id: &str) -> ErgataiResult<()> {
        let entry = self.agents.write().remove(agent_id);
        if let Some(entry) = entry {
            entry.abort_handle.abort();
            entry
                .alive
                .store(false, std::sync::atomic::Ordering::SeqCst);
            info!(agent_id = %agent_id, "Disconnected remote HTTP ACP agent");
            Ok(())
        } else {
            Err(ErgataiError::AgentNotFound(agent_id.to_string()))
        }
    }

    /// List all HTTP-connected agents.
    pub async fn list_http_agents(&self) -> Vec<String> {
        self.agents.read().keys().cloned().collect()
    }

    async fn get_or_create_workspace(&self, workspace_id: &str) -> ErgataiResult<WorkspaceHandle> {
        let mut workspaces = self.workspaces.write();
        if !workspaces.contains_key(workspace_id) {
            workspaces.insert(
                workspace_id.to_string(),
                HttpWorkspaceEntry {
                    id: workspace_id.to_string(),
                    agent_ids: Vec::new(),
                    agent_counter: std::sync::atomic::AtomicUsize::new(0),
                },
            );
        }
        Ok(WorkspaceHandle {
            id: workspace_id.to_string(),
            backend: self.name().to_string(),
            metadata: HashMap::new(),
        })
    }

    fn next_agent_id(&self, workspace_id: &str) -> String {
        let workspaces = self.workspaces.read();
        let count = workspaces
            .get(workspace_id)
            .map(|ws| ws.agent_counter.fetch_add(1, std::sync::atomic::Ordering::SeqCst))
            .unwrap_or(0);
        format!("{}-agent-{}", workspace_id, count)
    }
}

impl Default for AcpHttpBackend {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl AgentRuntimeBackend for AcpHttpBackend {
    fn name(&self) -> &'static str {
        "acp-http"
    }

    fn capabilities(&self) -> BackendCapabilities {
        BackendCapabilities {
            supports_message_injection: true,
            supports_output_capture: true,
            supports_resource_limits: false,
            supports_workspace_reuse: true,
            supports_network_isolation: false,
            max_concurrent_agents: None,
        }
    }

    async fn initialize(&self) -> ErgataiResult<()> {
        info!("AcpHttpBackend initialized");
        Ok(())
    }

    async fn create_workspace(&self, spec: WorkspaceSpec) -> ErgataiResult<WorkspaceHandle> {
        self.get_or_create_workspace(&spec.id).await
    }

    fn next_agent_id(&self, workspace_id: &str) -> String {
        // HTTP backend uses a simple counter-based approach
        // Note: This is called before start_agent for workspace pre-registration
        let agents = self.agents.read();
        let count = agents.values().filter(|a| a.workspace == workspace_id).count();
        format!("{}-agent-{}", workspace_id, count)
    }

    async fn start_agent(
        &self,
        handle: &WorkspaceHandle,
        command: &str,
        _instruction: Option<&str>,
    ) -> ErgataiResult<AgentHandle> {
        // For HTTP backend, command should be the endpoint URL
        self.connect_remote_agent(&handle.id, command, None).await
    }

    async fn inject_message(&self, handle: &AgentHandle, message: &str) -> ErgataiResult<()> {
        let command_tx = {
            let agents = self.agents.read();
            if let Some(entry) = agents.get(&handle.agent_id) {
                entry.command_tx.clone()
            } else {
                return Err(ErgataiError::AgentNotFound(handle.agent_id.clone()));
            }
        };

        let (response_tx, response_rx) = tokio::sync::oneshot::channel();
        command_tx
            .send(HttpAcpCommand::Prompt {
                message: message.to_string(),
                response_tx,
            })
            .await
            .map_err(|e| ErgataiError::internal(format!("Failed to send command: {}", e)))?;
        response_rx
            .await
            .map_err(|e| ErgataiError::internal(format!("Command failed: {}", e)))?
    }

    async fn capture_output(&self, handle: &AgentHandle) -> ErgataiResult<Option<String>> {
        let agents = self.agents.read();
        if let Some(entry) = agents.get(&handle.agent_id) {
            let output = entry.output.capture();
            Ok(if output.is_empty() { None } else { Some(output) })
        } else {
            Err(ErgataiError::AgentNotFound(handle.agent_id.clone()))
        }
    }

    async fn is_alive(&self, handle: &AgentHandle) -> ErgataiResult<bool> {
        let agents = self.agents.read();
        if let Some(entry) = agents.get(&handle.agent_id) {
            Ok(entry.alive.load(std::sync::atomic::Ordering::SeqCst))
        } else {
            Ok(false)
        }
    }

    async fn stop_agent(&self, handle: &AgentHandle) -> ErgataiResult<()> {
        let command_tx = {
            let agents = self.agents.read();
            if let Some(entry) = agents.get(&handle.agent_id) {
                entry.command_tx.clone()
            } else {
                return Err(ErgataiError::AgentNotFound(handle.agent_id.clone()));
            }
        };

        let (response_tx, response_rx) = tokio::sync::oneshot::channel();
        command_tx
            .send(HttpAcpCommand::Stop { response_tx })
            .await
            .map_err(|e| ErgataiError::internal(format!("Failed to send stop: {}", e)))?;
        response_rx
            .await
            .map_err(|e| ErgataiError::internal(format!("Stop failed: {}", e)))?
    }

    async fn kill_agent(&self, handle: &AgentHandle) -> ErgataiResult<()> {
        self.disconnect_remote_agent(&handle.agent_id).await
    }

    async fn wait_for_exit(
        &self,
        handle: &AgentHandle,
        timeout: Option<Duration>,
    ) -> ErgataiResult<WaitResult> {
        let start = Instant::now();
        loop {
            if !self.is_alive(handle).await? {
                return Ok(WaitResult::Exited { code: 0 });
            }
            if let Some(timeout) = timeout {
                if start.elapsed() > timeout {
                    return Ok(WaitResult::Timeout);
                }
            }
            tokio::time::sleep(EXIT_POLL_INTERVAL).await;
        }
    }

    async fn list_workspaces(&self) -> ErgataiResult<Vec<WorkspaceHandle>> {
        let workspaces = self.workspaces.read();
        let handles = workspaces
            .values()
            .map(|entry| WorkspaceHandle {
                id: entry.id.clone(),
                backend: self.name().to_string(),
                metadata: HashMap::new(),
            })
            .collect();
        Ok(handles)
    }

    async fn cleanup_workspace(&self, handle: &WorkspaceHandle) -> ErgataiResult<()> {
        self.workspaces.write().remove(&handle.id);
        Ok(())
    }

    async fn shutdown(&self) -> ErgataiResult<()> {
        info!("AcpHttpBackend shutdown — draining HTTP agents");
        // Drain all agents, abort their connection/command tasks, and mark them
        // dead so observers don't see stale entries.
        let entries: Vec<(String, HttpAgentEntry)> =
            self.agents.write().drain().collect();
        for (agent_id, entry) in entries {
            entry
                .alive
                .store(false, std::sync::atomic::Ordering::SeqCst);
            entry.abort_handle.abort();
            debug!(agent_id = %agent_id, "Aborted HTTP agent connection task");
        }
        Ok(())
    }

    fn as_any(&self) -> &dyn std::any::Any {
        self
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_http_backend_creation() {
        let backend = AcpHttpBackend::new();
        assert!(backend.agents.read().is_empty());
        assert!(backend.workspaces.read().is_empty());
    }

    #[tokio::test]
    async fn test_workspace_creation() {
        let backend = AcpHttpBackend::new();
        let spec = WorkspaceSpec {
            id: "test-workspace".to_string(),
            work_dir: std::path::PathBuf::from("/tmp"),
            env: HashMap::new(),
            resources: Default::default(),
            capture_thoughts: false,
        };
        let result = backend.create_workspace(spec).await;
        assert!(result.is_ok());
        assert!(backend.workspaces.read().contains_key("test-workspace"));
    }
}
