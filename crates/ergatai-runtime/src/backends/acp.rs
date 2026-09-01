//! AcpBackend — ACP (Agent Client Protocol) based agent execution environment.
//!
//! Agents run as child processes communicating via ACP protocol over stdio (JSON-RPC).
//! Messages are sent via ACP `session/prompt` requests, and output is captured from
//! ACP session notifications and responses.
//!
//! # Advantages
//!
//! - Structured communication (JSON-RPC, not raw terminal bytes)
//! - No ANSI escape code parsing needed
//! - Standard protocol (compatible with ACP-compliant agents)
//! - Simpler message injection (no PTY fd manipulation)
//!
//! # Limitations
//!
//! - Requires agents to support ACP protocol
//! - No direct terminal I/O (not suitable for interactive CLI agents)

use std::collections::HashMap;
use std::path::PathBuf;
use std::str::FromStr;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{Duration, Instant};

use async_trait::async_trait;
use parking_lot::RwLock;
use tokio::sync::{mpsc, oneshot};
use tracing::{debug, error, info, warn};

use agent_client_protocol::{AcpAgent, Agent, Client, ConnectionTo};
use agent_client_protocol::schema::ProtocolVersion;
use agent_client_protocol::schema::v1::{
    ContentBlock, InitializeRequest, NewSessionRequest, PromptRequest,
    RequestPermissionOutcome, RequestPermissionRequest, RequestPermissionResponse,
    SelectedPermissionOutcome, SessionNotification, SessionUpdate, TextContent,
};

use ergatai_error::{ErgataiError, ErgataiResult};

/// Extract text content from a ContentChunk (AgentMessageChunk or AgentThoughtChunk).
fn extract_text_from_chunk(chunk: &agent_client_protocol::schema::v1::ContentChunk) -> Option<String> {
    match &chunk.content {
        ContentBlock::Text(text_content) => Some(text_content.text.clone()),
        _ => None,
    }
}

use crate::backend::AgentRuntimeBackend;
use crate::types::{AgentHandle, BackendCapabilities, WaitResult, WorkspaceHandle, WorkspaceSpec};

// ── Configuration constants ──

/// Poll interval for wait_for_exit.
const EXIT_POLL_INTERVAL: Duration = Duration::from_millis(200);

/// Output buffer max size (256 KiB).
const OUTPUT_BUFFER_MAX_SIZE: usize = 256 * 1024;

// ── Internal types ──

/// Per-agent output buffer: bounded rolling buffer of captured ACP output.
struct OutputBuffer {
    /// Captured output text.
    data: RwLock<Vec<u8>>,
    /// Maximum buffer size in bytes.
    max_size: usize,
}

impl OutputBuffer {
    fn new(max_size: usize) -> Self {
        Self {
            data: RwLock::new(Vec::new()),
            max_size,
        }
    }

    /// Append data, evicting oldest bytes if over capacity.
    fn append(&self, chunk: &[u8]) {
        let mut data = self.data.write();
        data.extend_from_slice(chunk);
        // Evict oldest bytes if over capacity
        if data.len() > self.max_size {
            let excess = data.len() - self.max_size;
            data.drain(..excess);
        }
    }

    /// Capture and drain current buffer contents as text (incremental semantics).
    ///
    /// Each call returns only the data appended since the last `capture()` call.
    /// The buffer is cleared after reading so callers receive deltas, not cumulative data.
    fn capture(&self) -> String {
        let mut data = self.data.write();
        let result = String::from_utf8_lossy(&data).to_string();
        data.clear();
        result
    }
}

/// Command sent to the ACP connection task via channel.
enum AcpCommand {
    /// Send a prompt message to the agent.
    Prompt {
        message: String,
        response_tx: oneshot::Sender<ErgataiResult<()>>,
    },
    /// Graceful stop (connection task will exit, closing the ACP connection).
    Stop,
}

/// Tracks a running ACP agent's state.
struct AcpAgentEntry {
    /// Channel to send commands to the connection task.
    command_tx: mpsc::Sender<AcpCommand>,
    /// Output buffer for captured agent responses.
    output: Arc<OutputBuffer>,
    /// Last time output was received (for watchdog).
    last_output_at: Arc<RwLock<Instant>>,
    /// Whether the agent process is still alive.
    alive: Arc<std::sync::atomic::AtomicBool>,
    /// The AgentHandle for this agent.
    handle: AgentHandle,
    /// Abort handle for the connection task (can be cloned and used to abort the task).
    abort_handle: tokio::task::AbortHandle,
}

/// Logical workspace (no physical resources, just metadata).
struct WorkspaceEntry {
    id: String,
    /// Per-workspace counter for deterministic agent IDs.
    agent_counter: AtomicUsize,
    agent_ids: Vec<String>,
}

// ── AcpBackend ──

/// Helper to set alive flag (avoids importing Ordering in multiple places).
fn task_alive_store(alive: &std::sync::atomic::AtomicBool, value: bool) {
    alive.store(value, std::sync::atomic::Ordering::SeqCst);
}

/// ACP-based agent execution backend.
///
/// Each workspace is a logical container (directory + env). Each agent is a
/// child process communicating via ACP protocol. Messages are injected via
/// ACP `session/prompt` requests, and output is captured from session notifications.
pub struct AcpBackend {
    /// Agent entries keyed by agent ID.
    agents: RwLock<HashMap<String, AcpAgentEntry>>,
    /// Workspace entries keyed by workspace ID.
    workspaces: RwLock<HashMap<String, WorkspaceEntry>>,
    /// Agent IDs whose connection tasks have exited (crashed or stopped).
    /// Drained lazily by `reap_dead()` on the next backend operation.
    dead_agents: Arc<parking_lot::Mutex<Vec<String>>>,
}

impl AcpBackend {
    /// Create a new AcpBackend.
    pub fn new() -> Self {
        Self {
            agents: RwLock::new(HashMap::new()),
            workspaces: RwLock::new(HashMap::new()),
            dead_agents: Arc::new(parking_lot::Mutex::new(Vec::new())),
        }
    }

    /// Generate a workspace-scoped agent ID: `{workspace_id}-agent-{counter}`.
    fn next_agent_id(&self, workspace_id: &str) -> String {
        let workspaces = self.workspaces.read();
        let count = workspaces
            .get(workspace_id)
            .map(|ws| ws.agent_counter.fetch_add(1, Ordering::SeqCst))
            .unwrap_or(0);
        format!("{}-agent-{}", workspace_id, count)
    }

    /// Remove agent entry.
    fn remove_agent(&self, agent_id: &str) {
        let mut agents = self.agents.write();
        agents.remove(agent_id);
    }

    /// Reap dead agents whose connection tasks have exited.
    ///
    /// Called lazily before public operations. The connection task pushes its
    /// agent_id to `dead_agents` on exit (crash or normal). This method drains
    /// the list and removes those entries from the agents map and workspace lists.
    fn reap_dead(&self) {
        let dead: Vec<String> = {
            let mut dead_agents = self.dead_agents.lock();
            std::mem::take(&mut *dead_agents)
        };
        if dead.is_empty() {
            return;
        }
        let mut agents = self.agents.write();
        for id in &dead {
            agents.remove(id);
        }
        // Also clean from workspace entries.
        let mut workspaces = self.workspaces.write();
        for ws in workspaces.values_mut() {
            ws.agent_ids.retain(|id| !dead.contains(id));
        }
        debug!(count = dead.len(), "Reaped dead ACP agents");
    }
}

impl Default for AcpBackend {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl AgentRuntimeBackend for AcpBackend {
    fn name(&self) -> &'static str {
        "acp"
    }

    fn as_any(&self) -> &dyn std::any::Any {
        self
    }

    fn capabilities(&self) -> BackendCapabilities {
        BackendCapabilities {
            supports_message_injection: true,     // ACP session/prompt
            supports_output_capture: true,         // ACP session notifications
            supports_resource_limits: false,       // TODO: future enhancement
            supports_workspace_reuse: true,        // logical workspaces
            supports_network_isolation: false,
            max_concurrent_agents: None,
        }
    }

    async fn initialize(&self) -> ErgataiResult<()> {
        // No external dependencies to check — ACP uses stdio.
        info!("AcpBackend initialized (no external dependencies)");
        Ok(())
    }

    async fn create_workspace(&self, spec: WorkspaceSpec) -> ErgataiResult<WorkspaceHandle> {
        let workspace_id = spec.id.clone();

        // Create workspace entry with per-workspace agent counter.
        let entry = WorkspaceEntry {
            id: spec.id.clone(),
            agent_counter: AtomicUsize::new(0),
            agent_ids: Vec::new(),
        };

        self.workspaces.write().insert(workspace_id.clone(), entry);

        info!(workspace_id = %workspace_id, work_dir = %spec.work_dir.display(), "Created workspace");

        // Include work_dir in metadata so start_agent() can locate the working directory.
        let mut metadata = HashMap::new();
        metadata.insert(
            "work_dir".to_string(),
            spec.work_dir.to_string_lossy().to_string(),
        );

        Ok(WorkspaceHandle {
            id: workspace_id,
            backend: self.name().to_string(),
            metadata,
        })
    }

    async fn start_agent(
        &self,
        handle: &WorkspaceHandle,
        command: &str,
        instruction: Option<&str>,
    ) -> ErgataiResult<AgentHandle> {
        // Reap any dead agents before starting a new one.
        self.reap_dead();

        let agent_id = self.next_agent_id(&handle.id);

        // Parse the command string into an AcpAgent.
        // Supports: "python agent.py", "npx -y @agentclientprotocol/claude-agent-acp@latest",
        // or JSON: {"command":"python","args":["agent.py"]}
        let acp_agent = AcpAgent::from_str(command).map_err(|e| {
            ErgataiError::internal(format!("Failed to parse ACP agent command '{}': {}", command, e))
        })?
        .with_debug(|line, direction| {
            debug!(?direction, line = %line, "ACP wire debug");
        });

        // Shared state between this backend and the connection task.
        let output = Arc::new(OutputBuffer::new(OUTPUT_BUFFER_MAX_SIZE));
        let last_output_at = Arc::new(RwLock::new(Instant::now()));
        let alive = Arc::new(std::sync::atomic::AtomicBool::new(true));

        // Channel for sending commands (prompts, stop) to the connection task.
        let (command_tx, mut command_rx) = mpsc::channel::<AcpCommand>(32);

        // Oneshot for the connection task to report the session_id back.
        let (session_tx, session_rx) = oneshot::channel::<agent_client_protocol::schema::v1::SessionId>();

        // Clone shared state for the connection task.
        let task_output = output.clone();
        let task_last_output_at = last_output_at.clone();
        let task_alive = alive.clone();
        let task_agent_id = agent_id.clone();
        let task_dead_agents = self.dead_agents.clone();
        let cwd = handle
            .metadata
            .get("work_dir")
            .map(PathBuf::from)
            .unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| PathBuf::from("/")));

        // Spawn the ACP connection task.
        let join_handle = tokio::spawn(async move {
            // Build the ACP client with notification and permission handlers.
            let result = Client
                .builder()
                .name(format!("ergatai-acp-{}", &task_agent_id))
                .on_receive_notification(
                    {
                        let out = task_output.clone();
                        let last_out = task_last_output_at.clone();
                        async move |notification: SessionNotification, _cx| {
                            // Extract text from session notifications and write to output buffer.
                            match &notification.update {
                                SessionUpdate::AgentMessageChunk(chunk) => {
                                    if let Some(text) = extract_text_from_chunk(chunk) {
                                        debug!(text_len = text.len(), "ACP agent message chunk");
                                        out.append(text.as_bytes());
                                    }
                                }
                                SessionUpdate::AgentThoughtChunk(chunk) => {
                                    if let Some(text) = extract_text_from_chunk(chunk) {
                                        debug!(text_len = text.len(), "ACP agent thought chunk");
                                        // Optionally capture thoughts (prefix to distinguish)
                                        // out.append(format!("[thinking: {}]", text).as_bytes());
                                    }
                                }
                                SessionUpdate::UsageUpdate(usage) => {
                                    debug!(used = usage.used, size = usage.size, "ACP usage update");
                                }
                                SessionUpdate::ToolCallUpdate(tool_call) => {
                                    debug!(tool_call = ?tool_call, "ACP tool call");
                                }
                                _ => {
                                    debug!(update = ?notification.update, "ACP session notification");
                                }
                            }
                            *last_out.write() = Instant::now();
                            Ok(())
                        }
                    },
                    agent_client_protocol::on_receive_notification!(),
                )
                .on_receive_request(
                    async move |request: RequestPermissionRequest, responder, _connection| {
                        // YOLO mode: auto-approve all permission requests.
                        debug!("Auto-approving ACP permission request: {:?}", request);
                        let option_id = request.options.first().map(|opt| opt.option_id.clone());
                        if let Some(id) = option_id {
                            responder.respond(RequestPermissionResponse::new(
                                RequestPermissionOutcome::Selected(
                                    SelectedPermissionOutcome::new(id),
                                ),
                            ))
                        } else {
                            responder.respond(RequestPermissionResponse::new(
                                RequestPermissionOutcome::Cancelled,
                            ))
                        }
                    },
                    agent_client_protocol::on_receive_request!(),
                )
                .connect_with(acp_agent, |connection: ConnectionTo<Agent>| async move {
                    // Step 1: Initialize the ACP connection.
                    let init_response = connection
                        .send_request(InitializeRequest::new(ProtocolVersion::V1))
                        .block_task()
                        .await?;

                    info!(
                        agent_info = ?init_response.agent_info,
                        "ACP agent initialized"
                    );

                    // Step 2: Create a new ACP session.
                    let new_session_response = connection
                        .send_request(NewSessionRequest::new(&cwd))
                        .block_task()
                        .await?;

                    let session_id = new_session_response.session_id;
                    info!(session_id = %session_id, "ACP session created");

                    // Report session_id back to start_agent.
                    let _ = session_tx.send(session_id.clone());

                    // Step 3: Command loop — receive prompts from the channel and send to agent.
                    loop {
                        match command_rx.recv().await {
                            Some(AcpCommand::Prompt {
                                message,
                                response_tx,
                            }) => {
                                let content = vec![ContentBlock::Text(TextContent::new(
                                    message.clone(),
                                ))];
                                let result = connection
                                    .send_request(PromptRequest::new(
                                        session_id.clone(),
                                        content,
                                    ))
                                    .block_task()
                                    .await;

                                match result {
                                    Ok(response) => {
                                        debug!(
                                            stop_reason = ?response.stop_reason,
                                            "ACP prompt completed"
                                        );
                                        let _ = response_tx.send(Ok(()));
                                    }
                                    Err(e) => {
                                        warn!(error = %e, "ACP prompt failed");
                                        let _ = response_tx.send(Err(ErgataiError::internal(
                                            format!("ACP prompt failed: {e}"),
                                        )));
                                    }
                                }
                            }
                            Some(AcpCommand::Stop) => {
                                info!("ACP connection task received stop command");
                                break;
                            }
                            None => {
                                // Channel closed — backend dropped or agent removed.
                                info!("ACP command channel closed, connection task exiting");
                                break;
                            }
                        }
                    }

                    Ok(())
                })
                .await;

            // Mark agent as not alive and report death for lazy reaping.
            task_alive.store(false, std::sync::atomic::Ordering::SeqCst);
            task_dead_agents.lock().push(task_agent_id.clone());

            if let Err(e) = result {
                error!(error = %e, "ACP connection task failed");
            }
        });

        // Wait for session_id from the connection task (with timeout).
        let session_id = match tokio::time::timeout(Duration::from_secs(30), session_rx).await {
            Ok(Ok(id)) => {
                info!(session_id = %id, "ACP agent session ready");
                Some(id)
            }
            Ok(Err(_)) => {
                warn!("ACP connection task exited before sending session_id");
                None
            }
            Err(_) => {
                warn!("Timeout waiting for ACP session_id");
                None
            }
        };

        // If session creation failed, the agent is not usable.
        if session_id.is_none() {
            task_alive_store(&alive, false);
            join_handle.abort();
            return Err(ErgataiError::internal(
                "Failed to initialize ACP agent session",
            ));
        }

        // Build the agent entry.
        let entry = AcpAgentEntry {
            command_tx,
            output,
            last_output_at,
            alive: alive.clone(),
            handle: AgentHandle {
                workspace: handle.clone(),
                agent_id: agent_id.clone(),
                process_id: None,
                metadata: {
                    let mut m = HashMap::new();
                    if let Some(sid) = &session_id {
                        m.insert("session_id".to_string(), sid.to_string());
                    }
                    m.insert("command".to_string(), command.to_string());
                    m
                },
            },
            abort_handle: join_handle.abort_handle(),
        };

        self.agents.write().insert(agent_id.clone(), entry);

        // Track agent in workspace.
        if let Some(ws) = self.workspaces.write().get_mut(&handle.id) {
            ws.agent_ids.push(agent_id.clone());
        }

        info!(
            agent_id = %agent_id,
            workspace_id = %handle.id,
            command = %command,
            "Started ACP agent"
        );

        // If an initial instruction was provided, send it as the first prompt.
        if let Some(instr) = instruction {
            debug!(
                agent_id = %agent_id,
                instruction_len = instr.len(),
                "Sending initial instruction"
            );
            let agent_handle = {
                let agents = self.agents.read();
                agents.get(&agent_id).map(|e| e.handle.clone())
            };
            if let Some(h) = agent_handle {
                if let Err(e) = self.inject_message(&h, instr).await {
                    warn!(
                        agent_id = %agent_id,
                        error = %e,
                        "Failed to send initial instruction"
                    );
                }
            }
        }

        // Return the agent handle.
        let agents = self.agents.read();
        if let Some(entry) = agents.get(&agent_id) {
            Ok(entry.handle.clone())
        } else {
            Err(ErgataiError::internal("Failed to create agent handle"))
        }
    }

    async fn inject_message(&self, handle: &AgentHandle, message: &str) -> ErgataiResult<()> {
        self.reap_dead();
        let command_tx = {
            let agents = self.agents.read();
            match agents.get(&handle.agent_id) {
                Some(entry) => entry.command_tx.clone(),
                None => {
                    return Err(ErgataiError::NotFound(format!(
                        "Agent not found: {}",
                        handle.agent_id
                    )));
                }
            }
        };

        let (response_tx, response_rx) = oneshot::channel();
        command_tx
            .send(AcpCommand::Prompt {
                message: message.to_string(),
                response_tx,
            })
            .await
            .map_err(|_| ErgataiError::internal("ACP command channel closed"))?;

        // Wait for the connection task to finish sending the prompt.
        match response_rx.await {
            Ok(result) => result,
            Err(_) => Err(ErgataiError::internal("ACP response channel closed")),
        }
    }

    async fn capture_output(&self, handle: &AgentHandle) -> ErgataiResult<Option<String>> {
        self.reap_dead();
        let agents = self.agents.read();
        if let Some(entry) = agents.get(&handle.agent_id) {
            let output = entry.output.capture();
            if output.is_empty() {
                Ok(None)
            } else {
                Ok(Some(output))
            }
        } else {
            Err(ErgataiError::NotFound(format!("Agent not found: {}", handle.agent_id)))
        }
    }

    async fn is_alive(&self, handle: &AgentHandle) -> ErgataiResult<bool> {
        self.reap_dead();
        let agents = self.agents.read();
        if let Some(entry) = agents.get(&handle.agent_id) {
            Ok(entry.alive.load(std::sync::atomic::Ordering::Relaxed))
        } else {
            Ok(false)
        }
    }

    async fn stop_agent(&self, handle: &AgentHandle) -> ErgataiResult<()> {
        self.reap_dead();
        let (command_tx, abort_handle) = {
            let agents = self.agents.read();
            match agents.get(&handle.agent_id) {
                Some(entry) => (entry.command_tx.clone(), entry.abort_handle.clone()),
                None => {
                    return Err(ErgataiError::NotFound(format!(
                        "Agent not found: {}",
                        handle.agent_id
                    )));
                }
            }
        };

        // Send stop command to the connection task.
        let _ = command_tx.send(AcpCommand::Stop).await;

        // Give the task a brief moment to shut down gracefully, then abort if needed.
        tokio::time::sleep(Duration::from_millis(500)).await;
        if !abort_handle.is_finished() {
            warn!(
                agent_id = %handle.agent_id,
                "ACP agent did not stop within grace period, aborting"
            );
            abort_handle.abort();
        }

        // Mark as not alive and remove entry.
        {
            let agents = self.agents.read();
            if let Some(entry) = agents.get(&handle.agent_id) {
                entry.alive.store(false, std::sync::atomic::Ordering::SeqCst);
            }
        }
        self.remove_agent(&handle.agent_id);

        info!(agent_id = %handle.agent_id, "ACP agent stopped");
        Ok(())
    }

    async fn kill_agent(&self, handle: &AgentHandle) -> ErgataiResult<()> {
        self.reap_dead();
        let abort_handle = {
            let agents = self.agents.read();
            match agents.get(&handle.agent_id) {
                Some(entry) => entry.abort_handle.clone(),
                None => {
                    return Err(ErgataiError::NotFound(format!(
                        "Agent not found: {}",
                        handle.agent_id
                    )));
                }
            }
        };

        // Force abort the connection task (which drops the ACP connection, killing the child).
        abort_handle.abort();

        // Mark as not alive and remove entry.
        {
            let agents = self.agents.read();
            if let Some(entry) = agents.get(&handle.agent_id) {
                entry.alive.store(false, std::sync::atomic::Ordering::SeqCst);
            }
        }
        self.remove_agent(&handle.agent_id);

        info!(agent_id = %handle.agent_id, "ACP agent killed");
        Ok(())
    }

    async fn wait_for_exit(
        &self,
        handle: &AgentHandle,
        timeout: Option<Duration>,
    ) -> ErgataiResult<WaitResult> {
        // Poll until agent exits. When timeout is None, wait indefinitely
        // (the runtime monitor calls this to track agent lifecycle).
        let start = Instant::now();
        let timeout_duration = timeout.unwrap_or(Duration::from_secs(u64::MAX));

        loop {
            if !self.is_alive(handle).await? {
                return Ok(WaitResult::Exited { code: 0 });
            }

            if start.elapsed() > timeout_duration {
                return Ok(WaitResult::Timeout);
            }

            tokio::time::sleep(EXIT_POLL_INTERVAL).await;
        }
    }

    async fn list_workspaces(&self) -> ErgataiResult<Vec<WorkspaceHandle>> {
        self.reap_dead();
        let workspaces = self.workspaces.read();
        Ok(workspaces
            .values()
            .map(|ws| {
                let metadata = HashMap::new();
                // Note: work_dir is not stored in WorkspaceEntry anymore;
                // it's carried in the WorkspaceHandle returned by create_workspace().
                WorkspaceHandle {
                    id: ws.id.clone(),
                    backend: self.name().to_string(),
                    metadata,
                }
            })
            .collect())
    }

    async fn cleanup_workspace(&self, handle: &WorkspaceHandle) -> ErgataiResult<()> {
        let mut workspaces = self.workspaces.write();
        workspaces.remove(&handle.id);
        info!(workspace_id = %handle.id, "Cleaned up workspace");
        Ok(())
    }

    async fn shutdown(&self) -> ErgataiResult<()> {
        // Stop all agents.
        let agent_ids: Vec<String> = {
            let agents = self.agents.read();
            agents.keys().cloned().collect()
        };

        for agent_id in agent_ids {
            let handle = {
                let agents = self.agents.read();
                if let Some(entry) = agents.get(&agent_id) {
                    entry.handle.clone()
                } else {
                    continue;
                }
            };
            let _ = self.stop_agent(&handle).await;
        }

        info!("AcpBackend shutdown complete");
        Ok(())
    }

    async fn discover_agents(&self) -> ErgataiResult<Vec<(String, AgentHandle)>> {
        self.reap_dead();
        let agents = self.agents.read();
        Ok(agents
            .values()
            .filter(|entry| entry.alive.load(std::sync::atomic::Ordering::Relaxed))
            .map(|entry| (entry.handle.agent_id.clone(), entry.handle.clone()))
            .collect())
    }

    fn last_output_age(&self, handle: &AgentHandle) -> Option<Duration> {
        let agents = self.agents.read();
        agents.get(&handle.agent_id).map(|entry| {
            let last_output = entry.last_output_at.read();
            last_output.elapsed()
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_acp_backend_name() {
        let backend = AcpBackend::new();
        assert_eq!(backend.name(), "acp");
    }

    #[test]
    fn test_acp_backend_capabilities() {
        let backend = AcpBackend::new();
        let caps = backend.capabilities();
        assert!(caps.supports_message_injection);
        assert!(caps.supports_output_capture);
        assert!(caps.supports_workspace_reuse);
    }

    #[tokio::test]
    async fn test_acp_backend_initialize() {
        let backend = AcpBackend::new();
        assert!(backend.initialize().await.is_ok());
    }

    #[tokio::test]
    async fn test_acp_backend_create_workspace() {
        let backend = AcpBackend::new();
        let spec = WorkspaceSpec {
            id: "ws-test-1".to_string(),
            work_dir: PathBuf::from("/tmp"),
            env: HashMap::new(),
            resources: crate::types::ResourceLimits::default(),
        };
        let handle = backend.create_workspace(spec).await.unwrap();
        assert_eq!(handle.id, "ws-test-1");
        assert_eq!(handle.backend, "acp");
    }
}
