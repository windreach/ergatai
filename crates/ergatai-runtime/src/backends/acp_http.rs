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
use ergatai_error::id::{format as format_id, generate, IdType};
use parking_lot::RwLock;
use tokio::sync::mpsc;
use tracing::{debug, error, info, warn};

use agent_client_protocol::schema::v1::{
    ContentBlock, CreateElicitationRequest, CreateElicitationResponse, ElicitationAction,
    InitializeRequest, McpServer, McpServerHttp, NewSessionRequest, PromptRequest,
    RequestPermissionRequest, RequestPermissionResponse, SessionNotification, SessionUpdate,
    TextContent,
};
use agent_client_protocol::schema::ProtocolVersion;
use agent_client_protocol::{Client, ConnectionTo};
use agent_client_protocol_http::HttpClient;

use ergatai_error::{ErgataiError, ErgataiResult};

use crate::backend::AcpBackendInterface;
use crate::permission::PermissionHandler;
use crate::types::{AgentHandle, BackendCapabilities, WaitResult, WorkspaceHandle, WorkspaceSpec};

// ── Configuration constants ──

/// Poll interval for wait_for_exit.
const EXIT_POLL_INTERVAL: Duration = Duration::from_millis(200);

/// Output buffer max size (256 KiB).
const OUTPUT_BUFFER_MAX_SIZE: usize = 256 * 1024;

/// Maximum process-output tail retained for HTTP spawn diagnostics.
const HTTP_SPAWN_OUTPUT_TAIL_MAX: usize = 8 * 1024;

/// Type alias for boxed prompt future to avoid complex type warnings.
type BoxedPromptFuture = std::pin::Pin<
    Box<
        dyn std::future::Future<
                Output = Result<
                    agent_client_protocol::schema::v1::PromptResponse,
                    agent_client_protocol::Error,
                >,
            > + Send,
    >,
>;

/// Consume child output and retain a bounded tail for error reporting.
async fn capture_output_tail<R>(output: R, tail: Arc<std::sync::Mutex<String>>)
where
    R: tokio::io::AsyncRead + Unpin,
{
    use tokio::io::{AsyncBufReadExt, BufReader};

    let mut lines = BufReader::new(output).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        let mut tail = tail.lock().unwrap();
        tail.push_str(line.trim_end());
        tail.push('\n');
        if tail.len() > HTTP_SPAWN_OUTPUT_TAIL_MAX {
            let cut = tail.len() - HTTP_SPAWN_OUTPUT_TAIL_MAX;
            let cut = (0..=cut)
                .rev()
                .find(|&index| tail.is_char_boundary(index))
                .unwrap_or(0);
            tail.drain(..cut);
        }
    }
}

// ── Internal types ──

/// Per-agent output buffer: bounded rolling buffer of captured ACP output.
#[allow(dead_code)]
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

    #[allow(dead_code)]
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
#[allow(dead_code)]
enum HttpAcpCommand {
    Prompt {
        message: String,
        response_tx: tokio::sync::oneshot::Sender<ErgataiResult<()>>,
    },
    InterruptPrompt {
        message: String,
        message_id: String,
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
#[allow(dead_code)]
struct HttpAgentEntry {
    agent_id: String,
    endpoint: String, // HTTP endpoint (e.g., "http://127.0.0.1:12345")
    output: Arc<OutputBuffer>,
    command_tx: mpsc::Sender<HttpAcpCommand>,
    abort_handle: tokio::task::AbortHandle,
    alive: Arc<std::sync::atomic::AtomicBool>,
    last_activity_at: Arc<RwLock<Instant>>,
    workspace: String,
    /// Child process handle for cleanup (HTTP agents spawned locally)
    child_process: Option<tokio::process::Child>,
}

/// Workspace entry for HTTP backend.
struct HttpWorkspaceEntry {
    id: String,
    agent_ids: Vec<String>,
}

/// HTTP-based ACP backend for remote agent connections.
pub struct AcpHttpBackend {
    agents: RwLock<HashMap<String, HttpAgentEntry>>,
    workspaces: RwLock<HashMap<String, HttpWorkspaceEntry>>,
    permission_handler: Option<Arc<dyn PermissionHandler>>,
    mcp_server_factory: Option<Arc<dyn crate::mcp_over_acp::McpServerFactory>>,
    /// Optional: URL for HTTP MCP fallback (when agent doesn't support MCP-over-ACP).
    /// This is typically the ergatai API server's MCP endpoint, not the agent's endpoint.
    http_mcp_url: Option<String>,
}

impl AcpHttpBackend {
    /// Create a new HTTP ACP backend.
    pub fn new() -> Self {
        Self {
            agents: RwLock::new(HashMap::new()),
            workspaces: RwLock::new(HashMap::new()),
            permission_handler: None,
            mcp_server_factory: None,
            http_mcp_url: None,
        }
    }

    /// Set the permission handler for this backend.
    pub fn with_permission_handler(mut self, handler: Arc<dyn PermissionHandler>) -> Self {
        self.permission_handler = Some(handler);
        self
    }

    /// Set the MCP server factory for this backend.
    pub fn with_mcp_server_factory(
        mut self,
        factory: impl crate::mcp_over_acp::McpServerFactory,
    ) -> Self {
        self.mcp_server_factory = Some(Arc::new(factory));
        self
    }

    /// Set the HTTP MCP URL for fallback (when agent doesn't support MCP-over-ACP).
    ///
    /// This should be the ergatai API server's MCP endpoint (e.g., `http://host:port/mcp`),
    /// NOT the agent's endpoint. The agent's endpoint is for ACP, not MCP.
    pub fn with_http_mcp_url(mut self, url: impl Into<String>) -> Self {
        self.http_mcp_url = Some(url.into());
        self
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

        // Shared state
        let output = Arc::new(OutputBuffer::new(OUTPUT_BUFFER_MAX_SIZE));
        let alive = Arc::new(std::sync::atomic::AtomicBool::new(true));
        let last_activity_at = Arc::new(RwLock::new(Instant::now()));

        // Interrupt/cancel support (mirrors stdio backend)
        let shared_session_id: Arc<RwLock<Option<String>>> = Arc::new(RwLock::new(None));
        let in_thinking: Arc<std::sync::atomic::AtomicBool> =
            Arc::new(std::sync::atomic::AtomicBool::new(false));
        let in_tool_call: Arc<std::sync::atomic::AtomicBool> =
            Arc::new(std::sync::atomic::AtomicBool::new(false));
        let text_output_seen: Arc<std::sync::atomic::AtomicBool> =
            Arc::new(std::sync::atomic::AtomicBool::new(false));

        // Command channel
        let (command_tx, mut command_rx) = mpsc::channel::<HttpAcpCommand>(32);

        // Clone for connection task
        let task_output = output.clone();
        let task_alive = alive.clone();
        let task_last_activity = last_activity_at.clone();
        let task_agent_id = agent_id.clone();
        let task_workspace_id = workspace_id.to_string();
        let task_endpoint = endpoint.to_string();
        let task_permission_handler = self.permission_handler.clone();
        let task_mcp_server_factory = self.mcp_server_factory.clone();
        let task_http_mcp_url = self.http_mcp_url.clone();
        let task_shared_session_id = shared_session_id.clone();
        let task_in_thinking = in_thinking.clone();
        let task_in_tool_call = in_tool_call.clone();
        let task_text_output_seen = text_output_seen.clone();
        let cwd = std::env::current_dir().unwrap_or_else(|_| std::path::PathBuf::from("."));

        // Spawn connection task - holds the connection for the lifetime of the agent
        let join_handle = tokio::spawn(async move {
            // Create HTTP client
            let http_client = match HttpClient::new(&task_endpoint) {
                Ok(client) => client,
                Err(e) => {
                    error!(
                        error = %e,
                        agent_id = %task_agent_id,
                        endpoint = %task_endpoint,
                        "Failed to create HTTP client"
                    );
                    task_alive.store(false, std::sync::atomic::Ordering::SeqCst);
                    return;
                }
            };

            // Build ACP client with all handlers (notification, permission, elicitation)
            let connect_result = Client::builder(Client)
                .name(format!("ergatai-http-{}", task_agent_id))
                // --- Notification handler ---
                .on_receive_notification(
                    {
                        let out = task_output.clone();
                        let last_activity = task_last_activity.clone();
                        let in_thinking = task_in_thinking.clone();
                        let in_tool_call = task_in_tool_call.clone();
                        let text_output_seen = task_text_output_seen.clone();
                        async move |notification: SessionNotification, _cx| {
                            match &notification.update {
                                SessionUpdate::AgentMessageChunk(chunk) => {
                                    if let ContentBlock::Text(text_content) = &chunk.content {
                                        debug!(text_len = text_content.text.len(), "HTTP agent message");
                                        out.append(text_content.text.as_bytes());
                                        text_output_seen.store(true, std::sync::atomic::Ordering::Relaxed);
                                    }
                                    in_tool_call.store(false, std::sync::atomic::Ordering::Relaxed);
                                }
                                SessionUpdate::AgentThoughtChunk(chunk) => {
                                    if let ContentBlock::Text(text_content) = &chunk.content {
                                        debug!(text_len = text_content.text.len(), "HTTP agent thought");
                                    }
                                    in_thinking.store(true, std::sync::atomic::Ordering::Relaxed);
                                    in_tool_call.store(false, std::sync::atomic::Ordering::Relaxed);
                                }
                                SessionUpdate::ToolCall(_) => {
                                    in_thinking.store(false, std::sync::atomic::Ordering::Relaxed);
                                    in_tool_call.store(true, std::sync::atomic::Ordering::Relaxed);
                                }
                                SessionUpdate::ToolCallUpdate(_) => {
                                    // Tool call update - tool is still running
                                }
                                SessionUpdate::SessionInfoUpdate(_info) => {
                                    // Session info update - no state change needed
                                }
                                _ => {
                                    debug!(update = ?notification.update, "HTTP session notification");
                                }
                            }
                            *last_activity.write() = Instant::now();
                            Ok(())
                        }
                    },
                    agent_client_protocol::on_receive_notification!(),
                )
                // --- Permission handler (mirrors stdio backend) ---
                .on_receive_request(
                    {
                        let handler = task_permission_handler.clone();
                        let sid = task_shared_session_id.clone();
                        let aid = task_agent_id.clone();
                        async move |request: RequestPermissionRequest, responder, _connection| {
                            let session_id_str = {
                                let guard = sid.read();
                                guard.clone().unwrap_or_default()
                            };
                            if let Some(handler) = &handler {
                                let decision = handler.evaluate(&aid, &session_id_str, &request).await;
                                debug!(
                                    agent_id = %aid,
                                    decision = ?decision,
                                    "HTTP ACP permission decision"
                                );
                                let _ = responder.respond(RequestPermissionResponse::new(
                                    decision.into_outcome(),
                                ));
                            } else {
                                // No handler configured → auto-approve using YoloPermissionHandler
                                let yolo = crate::permission::YoloPermissionHandler;
                                let decision = yolo.evaluate(&aid, &session_id_str, &request).await;
                                debug!(
                                    agent_id = %aid,
                                    decision = ?decision,
                                    "HTTP ACP permission decision (YoloPermissionHandler)"
                                );
                                let _ = responder.respond(RequestPermissionResponse::new(
                                    decision.into_outcome(),
                                ));
                            }
                            Ok(())
                        }
                    },
                    agent_client_protocol::on_receive_request!(),
                )
                // --- Elicitation handler (mirrors stdio backend) ---
                .on_receive_request(
                    {
                        let aid = task_agent_id.clone();
                        async move |request: CreateElicitationRequest, responder, _connection| {
                            info!(
                                agent_id = %aid,
                                message_bytes = request.message.len(),
                                "HTTP ACP elicitation request received (auto-declining)"
                            );
                            // Auto-decline to avoid blocking the agent
                            let _ = responder.respond(CreateElicitationResponse::new(
                                ElicitationAction::Decline,
                            ));
                            Ok(())
                        }
                    },
                    agent_client_protocol::on_receive_request!(),
                )
                // --- Connect and run the session ---
                .connect_with(http_client, |connection: ConnectionTo<agent_client_protocol::Agent>| async move {
                    info!(agent_id = %task_agent_id, "HTTP ACP connection established");

                    // Step 1: Initialize the ACP connection with retry.
                    // The TCP port may be up before the HTTP handler is fully
                    // ready, so we retry a few times with backoff before
                    // giving up.
                    const INIT_MAX_RETRIES: u32 = 10;
                    const INIT_RETRY_DELAY_MS: u64 = 500;
                    let mut init_response = None;
                    for attempt in 1..=INIT_MAX_RETRIES {
                        match connection
                            .send_request(InitializeRequest::new(ProtocolVersion::V1))
                            .block_task()
                            .await
                        {
                            Ok(response) => {
                                init_response = Some(response);
                                break;
                            }
                            Err(e) if attempt < INIT_MAX_RETRIES => {
                                warn!(
                                    error = %e,
                                    agent_id = %task_agent_id,
                                    attempt = attempt,
                                    max_retries = INIT_MAX_RETRIES,
                                    "ACP initialize failed, retrying"
                                );
                                tokio::time::sleep(Duration::from_millis(
                                    INIT_RETRY_DELAY_MS,
                                ))
                                .await;
                            }
                            Err(e) => {
                                error!(error = %e, agent_id = %task_agent_id, "ACP initialize failed after {} attempts", INIT_MAX_RETRIES);
                                return Err(e);
                            }
                        }
                    }
                    let init_response =
                        init_response.expect("init_response must be set after retry loop");

                    info!(
                        agent_id = %task_agent_id,
                        agent_info = ?init_response.agent_info,
                        capabilities = ?init_response.agent_capabilities,
                        "ACP agent initialized"
                    );

                    // Step 1.5: Set up MCP bridge if supported
                    let mcp_acp_supported = init_response
                        .agent_capabilities
                        .mcp_capabilities
                        .acp;
                    let mcp_http_supported = init_response
                        .agent_capabilities
                        .mcp_capabilities
                        .http;

                    let (_mcp_guard, mcp_declaration) = match &task_mcp_server_factory {
                        Some(factory) if mcp_acp_supported => {
                            let context = crate::mcp_over_acp::McpServerContext {
                                agent_id: Some(task_agent_id.clone()),
                                workspace_id: Some(task_workspace_id.clone()),
                            };
                            let bridge = crate::mcp_over_acp::AcpMcpBridge::new(
                                factory.clone(),
                                context,
                            );
                            let declaration = bridge.declaration();
                            let guard = connection.add_dynamic_handler(bridge)?;
                            info!(
                                agent_id = %task_agent_id,
                                mcp_server_name = %factory.server_name(),
                                "MCP-over-ACP attached to HTTP ACP connection"
                            );
                            (Some(guard), Some(declaration))
                        }
                        Some(factory) => {
                            // Fallback: HTTP MCP (use configured http_mcp_url, not the ACP endpoint)
                            if mcp_http_supported {
                                // Use the configured HTTP MCP URL (ergatai API server's MCP endpoint)
                                // instead of the agent's ACP endpoint
                                let mcp_url = task_http_mcp_url.as_ref().unwrap_or(&task_endpoint);
                                let http_server = McpServerHttp::new(
                                    factory.server_name(),
                                    mcp_url,
                                );
                                let declaration = McpServer::Http(http_server);
                                info!(
                                    agent_id = %task_agent_id,
                                    mcp_server_name = %factory.server_name(),
                                    mcp_url = %mcp_url,
                                    "Agent does not support MCP-over-ACP; using HTTP MCP fallback"
                                );
                                (None, Some(declaration))
                            } else {
                                debug!(
                                    agent_id = %task_agent_id,
                                    mcp_server_name = %factory.server_name(),
                                    "Agent does not support MCP-over-ACP or HTTP MCP"
                                );
                                (None, None)
                            }
                        }
                        None => (None, None),
                    };

                    // Step 2: Create a new session
                    let mut session_request = NewSessionRequest::new(&cwd);
                    if let Some(declaration) = &mcp_declaration {
                        session_request.mcp_servers.push(declaration.clone());
                    }
                    let session_response = connection
                        .send_request(session_request)
                        .block_task()
                        .await
                        .map_err(|e| {
                            error!(error = %e, agent_id = %task_agent_id, "Session creation failed");
                            e
                        })?;

                    let session_id = session_response.session_id;
                    info!(
                        agent_id = %task_agent_id,
                        session_id = %session_id,
                        "ACP session created"
                    );

                    // Share session_id with on_receive_request handlers
                    *task_shared_session_id.write() = Some(session_id.to_string());

                    // Step 3: Command loop - receive prompts and send to agent
                    // Use tokio::select! to handle commands concurrently, allowing
                    // Cancel/Stop to interrupt in-flight prompts.
                    let mut current_prompt: Option<BoxedPromptFuture> = None;
                    let mut current_response_tx: Option<tokio::sync::oneshot::Sender<ErgataiResult<()>>> = None;

                    loop {
                        // If there's a prompt in-flight, wait for it OR new commands
                        // If no prompt is in-flight, just wait for commands
                        if current_prompt.is_some() && current_response_tx.is_some() {
                            // Take ownership of response_tx for sending the result
                            let response_tx = current_response_tx.take().unwrap();
                            tokio::select! {
                                // Prompt completed
                                result = current_prompt.as_mut().unwrap() => {
                                    match result {
                                        Ok(response) => {
                                            info!(
                                                agent_id = %task_agent_id,
                                                stop_reason = ?response.stop_reason,
                                                "Prompt completed"
                                            );
                                            let _ = response_tx.send(Ok(()));
                                        }
                                        Err(e) => {
                                            error!(error = %e, agent_id = %task_agent_id, "Prompt failed");
                                            let _ = response_tx.send(Err(ErgataiError::internal(
                                                format!("Prompt failed: {}", e),
                                            )));
                                        }
                                    }
                                    current_prompt = None;
                                }
                                // New command arrived while prompt is in-flight
                                cmd = command_rx.recv() => {
                                    // Put response_tx back if we're not done
                                    current_response_tx = Some(response_tx);
                                    match cmd {
                                        Some(HttpAcpCommand::Cancel { response_tx: cancel_tx }) => {
                                            debug!("Cancel command received during prompt, sending session/cancel");
                                            let cancel_result = connection
                                                .send_notification(agent_client_protocol::schema::v1::CancelNotification::new(
                                                    session_id.clone(),
                                                ));
                                            match cancel_result {
                                                Ok(()) => {
                                                    info!(agent_id = %task_agent_id, "Sent session/cancel notification");
                                                    let _ = cancel_tx.send(Ok(()));
                                                }
                                                Err(e) => {
                                                    warn!(error = %e, agent_id = %task_agent_id, "Failed to send session/cancel");
                                                    let _ = cancel_tx.send(Err(ErgataiError::internal(
                                                        format!("Failed to cancel: {e}"),
                                                    )));
                                                }
                                            }
                                        }
                                        Some(HttpAcpCommand::Stop { response_tx: stop_tx }) => {
                                            debug!("Stop command received during prompt");
                                            task_alive.store(false, std::sync::atomic::Ordering::SeqCst);
                                            let _ = stop_tx.send(Ok(()));
                                            break;
                                        }
                                        Some(HttpAcpCommand::InterruptPrompt { message_id, response_tx: interrupt_tx, .. }) => {
                                            info!(
                                                agent_id = %task_agent_id,
                                                message_id = %message_id,
                                                "Interrupt received during prompt, queuing until prompt completes"
                                            );
                                            let _ = interrupt_tx.send(Ok(()));
                                        }
                                        Some(HttpAcpCommand::Prompt { response_tx: new_prompt_tx, .. }) => {
                                            warn!("New prompt received while prompt is in-flight, rejecting");
                                            let _ = new_prompt_tx.send(Err(ErgataiError::internal(
                                                "Another prompt is already in-flight".to_string(),
                                            )));
                                        }
                                        None => {
                                            info!(agent_id = %task_agent_id, "Command channel closed, shutting down");
                                            break;
                                        }
                                    }
                                }
                            }
                        } else {
                                // No prompt in-flight, just wait for commands
                                match command_rx.recv().await {
                                    Some(HttpAcpCommand::Prompt { message, response_tx }) => {
                                        debug!(message_len = message.len(), "Prompt command received");

                                        let content = if message.is_empty() {
                                            vec![ContentBlock::Text(TextContent::new(String::new()))]
                                        } else {
                                            vec![ContentBlock::Text(TextContent::new(message))]
                                        };

                                        task_text_output_seen.store(false, std::sync::atomic::Ordering::Relaxed);
                                        let prompt_request = PromptRequest::new(session_id.clone(), content);
                                        let sent_request = connection.send_request(prompt_request);

                                        current_prompt = Some(Box::pin(sent_request.block_task()));
                                        current_response_tx = Some(response_tx);
                                    }
                                    Some(HttpAcpCommand::InterruptPrompt { message, message_id, response_tx }) => {
                                        info!(
                                            agent_id = %task_agent_id,
                                            message_id = %message_id,
                                            "Interrupt message received, waiting for safe point"
                                        );

                                        // Wait for safe point (not in thinking or tool call)
                                        let timeout = std::time::Duration::from_secs(30);
                                        let start = std::time::Instant::now();
                                        loop {
                                            let thinking = task_in_thinking.load(std::sync::atomic::Ordering::SeqCst);
                                            let tool = task_in_tool_call.load(std::sync::atomic::Ordering::SeqCst);
                                            if !thinking && !tool {
                                                info!(agent_id = %task_agent_id, "Safe point reached, sending interrupt prompt");
                                                break;
                                            }
                                            if start.elapsed() > timeout {
                                                warn!(agent_id = %task_agent_id, "Interrupt timeout after 30s - forcing prompt");
                                                break;
                                            }
                                            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                                        }

                                        // Send the interrupt prompt
                                        task_text_output_seen.store(false, std::sync::atomic::Ordering::Relaxed);
                                        let content = if message.is_empty() {
                                            vec![ContentBlock::Text(TextContent::new(String::new()))]
                                        } else {
                                            vec![ContentBlock::Text(TextContent::new(message))]
                                        };

                                        let request = PromptRequest::new(session_id.clone(), content);
                                        let sent_request = connection.send_request(request);

                                        current_prompt = Some(Box::pin(sent_request.block_task()));
                                        current_response_tx = Some(response_tx);
                                    }
                                    Some(HttpAcpCommand::Cancel { response_tx }) => {
                                        debug!("Cancel command received, sending session/cancel notification");
                                        let cancel_result = connection
                                            .send_notification(agent_client_protocol::schema::v1::CancelNotification::new(
                                                session_id.clone(),
                                            ));
                                        match cancel_result {
                                            Ok(()) => {
                                                info!(agent_id = %task_agent_id, "Sent session/cancel notification");
                                                let _ = response_tx.send(Ok(()));
                                            }
                                            Err(e) => {
                                                warn!(error = %e, agent_id = %task_agent_id, "Failed to send session/cancel");
                                                let _ = response_tx.send(Err(ErgataiError::internal(
                                                    format!("Failed to cancel: {e}"),
                                                )));
                                            }
                                        }
                                    }
                                    Some(HttpAcpCommand::Stop { response_tx }) => {
                                        debug!("Stop command received");
                                        task_alive.store(false, std::sync::atomic::Ordering::SeqCst);
                                        let _ = response_tx.send(Ok(()));
                                        break;
                                    }
                                    None => {
                                        info!(agent_id = %task_agent_id, "Command channel closed, shutting down");
                                        break;
                                    }
                                }
                        }
                    }

                    Ok(())
                })
                .await;

            match connect_result {
                Ok(()) => info!("HTTP ACP connection task completed successfully"),
                Err(e) => error!(error = %e, "HTTP ACP connection task failed"),
            }
        });

        let abort_handle = join_handle.abort_handle();

        // Create agent entry
        let entry = HttpAgentEntry {
            agent_id: agent_id.clone(),
            endpoint: endpoint.to_string(),
            output,
            command_tx,
            abort_handle,
            alive,
            last_activity_at,
            workspace: workspace.id.clone(),
            child_process: None, // Remote agents don't have a local child process
        };

        // Register agent
        self.agents.write().insert(agent_id.clone(), entry);
        if let Some(ws) = self.workspaces.write().get_mut(workspace_id) {
            ws.agent_ids.push(agent_id.clone());
        }

        info!(agent_id = %agent_id, endpoint = %endpoint, "Connected to remote HTTP ACP agent");

        Ok(AgentHandle {
            workspace,
            agent_id,
            process_id: None,
            metadata: HashMap::new(),
        })
    }

    /// Spawn a local HTTP-based ACP agent (e.g., opencode acp).
    ///
    /// This starts the agent process, waits for it to be ready, then connects via HTTP.
    pub async fn spawn_http_agent(
        &self,
        workspace: &WorkspaceHandle,
        command: &str,
        _instruction: Option<&str>,
    ) -> ErgataiResult<AgentHandle> {
        // Parse command to extract binary and args
        let parts: Vec<&str> = command.split_whitespace().collect();
        if parts.is_empty() {
            return Err(ErgataiError::internal("Empty command".to_string()));
        }

        let binary = parts[0];
        let args = &parts[1..];

        // Allocate a concrete port before spawn.  Some ACP servers do not
        // print their ephemeral port on stdout, and an HTTP endpoint can be
        // readiness-probed without depending on implementation-specific logs.
        let port_listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .map_err(|e| {
                ErgataiError::internal(format!("Failed to reserve HTTP agent port: {}", e))
            })?;
        let port = port_listener
            .local_addr()
            .map_err(|e| {
                ErgataiError::internal(format!("Failed to read reserved HTTP agent port: {}", e))
            })?
            .port();
        drop(port_listener);
        let hostname = "127.0.0.1";

        info!(
            command = %command,
            hostname = %hostname,
            "Spawning HTTP ACP agent (OS will assign port)"
        );

        // Spawn the agent process with HTTP server mode
        let mut cmd = tokio::process::Command::new(binary);
        cmd.args(args)
            .arg("--port")
            .arg(port.to_string())
            .arg("--hostname")
            .arg(hostname)
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());

        // Set working directory from workspace metadata
        if let Some(work_dir) = workspace.metadata.get("work_dir") {
            cmd.current_dir(work_dir);
        }

        let mut child = cmd.spawn().map_err(|e| {
            ErgataiError::internal(format!("Failed to spawn HTTP agent process: {}", e))
        })?;

        let pid = child.id();
        info!(pid = ?pid, "HTTP agent process spawned, waiting for port assignment");

        // Drain stdout/stderr to prevent pipe-buffer deadlock and retain a
        // bounded tail for actionable spawn failures.
        let stderr = child.stderr.take();
        let stderr_tail = Arc::new(std::sync::Mutex::new(String::new()));
        let stderr_drain = stderr.map(|stderr| {
            let tail = stderr_tail.clone();
            tokio::spawn(capture_output_tail(stderr, tail))
        });
        let stdout = child.stdout.take();
        let stdout_tail = Arc::new(std::sync::Mutex::new(String::new()));
        let stdout_drain = stdout.map(|stdout| {
            let tail = stdout_tail.clone();
            tokio::spawn(capture_output_tail(stdout, tail))
        });

        // Wait for the HTTP listener to accept connections.
        let max_wait = std::time::Duration::from_secs(30);
        let start = std::time::Instant::now();
        let mut exit_status = None;

        while start.elapsed() < max_wait {
            if let Ok(Some(status)) = child.try_wait() {
                exit_status = Some(status);
                break;
            }

            if tokio::net::TcpStream::connect((hostname, port))
                .await
                .is_ok()
            {
                break;
            }

            tokio::time::sleep(Duration::from_millis(100)).await;
        }

        let endpoint = if exit_status.is_none()
            && tokio::net::TcpStream::connect((hostname, port))
                .await
                .is_ok()
        {
            // The TCP port may be briefly reachable from a dying process (kernel
            // completes the handshake even after the peer closes). Verify the
            // process is still alive before declaring it ready.
            if let Ok(Some(late_exit)) = child.try_wait() {
                let stderr_tail = stderr_tail.lock().unwrap().trim().to_string();
                let stdout_tail = stdout_tail.lock().unwrap().trim().to_string();
                error!(
                    pid = ?pid,
                    exit_status = ?late_exit,
                    stderr = %stderr_tail,
                    stdout = %stdout_tail,
                    "HTTP agent process exited immediately after port became reachable"
                );
                return Err(ErgataiError::internal(format!(
                    "HTTP agent process exited immediately after port {} became reachable (exit_status={:?}); stderr={}",
                    port, late_exit, stderr_tail
                )));
            }
            format!("{}:{}", hostname, port)
        } else {
            // Clean up the child process on failure to prevent orphan processes
            let stderr_tail = stderr_tail.lock().unwrap().trim().to_string();
            let stdout_tail = stdout_tail.lock().unwrap().trim().to_string();
            warn!(
                pid = ?pid,
                exit_status = ?exit_status,
                stderr = %stderr_tail,
                stdout = %stdout_tail,
                "Failed to determine HTTP agent endpoint, killing process"
            );
            let _ = child.start_kill();
            return Err(ErgataiError::internal(format!(
                "Failed to determine HTTP agent endpoint within {:?}; exit_status={:?}; stderr={}",
                max_wait, exit_status, stderr_tail
            )));
        };

        // Keep both drain tasks running so a chatty server cannot fill its
        // pipe buffers after readiness.
        debug!(stderr_drain = ?stderr_drain.is_some(), stdout_drain = ?stdout_drain.is_some(), "HTTP agent output drains active");

        info!(endpoint = %endpoint, "HTTP agent is ready");

        // Now connect to the agent via HTTP ACP
        let full_endpoint = if endpoint.starts_with("http://") {
            endpoint
        } else {
            format!("http://{}", endpoint)
        };

        let mut handle = match self
            .connect_remote_agent(&workspace.id, &full_endpoint, None)
            .await
        {
            Ok(h) => h,
            Err(e) => {
                warn!(
                    endpoint = %full_endpoint,
                    "Failed to connect to HTTP agent after successful spawn, killing process"
                );
                let _ = child.start_kill();
                return Err(e);
            }
        };

        // Store the child process in the agent entry for cleanup
        handle.process_id = pid.map(|p| p.to_string());
        if let Some(entry) = self.agents.write().get_mut(&handle.agent_id) {
            entry.child_process = Some(child);
        }

        Ok(handle)
    }

    /// Disconnect a remote HTTP agent.
    pub async fn disconnect_remote_agent(&self, agent_id: &str) -> ErgataiResult<()> {
        let entry = self.agents.write().remove(agent_id);
        if let Some(entry) = entry {
            entry.abort_handle.abort();
            entry
                .alive
                .store(false, std::sync::atomic::Ordering::SeqCst);
            // Kill child process if this was a locally spawned agent
            if let Some(mut child) = entry.child_process {
                let _ = child.start_kill();
            }
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

    /// Get the HTTP endpoint for a specific agent.
    ///
    /// Returns the endpoint URL (e.g., "http://127.0.0.1:12345") if the agent
    /// is connected, or None if the agent is not found.
    pub fn get_agent_endpoint(&self, agent_id: &str) -> Option<String> {
        self.agents
            .read()
            .get(agent_id)
            .map(|entry| entry.endpoint.clone())
    }

    /// List all agents with their endpoints.
    ///
    /// Returns a vector of (agent_id, endpoint) tuples for all connected agents.
    pub fn list_agents_with_endpoints(&self) -> Vec<(String, String)> {
        self.agents
            .read()
            .iter()
            .map(|(id, entry)| (id.clone(), entry.endpoint.clone()))
            .collect()
    }

    async fn get_or_create_workspace(&self, workspace_id: &str) -> ErgataiResult<WorkspaceHandle> {
        let mut workspaces = self.workspaces.write();
        if !workspaces.contains_key(workspace_id) {
            workspaces.insert(
                workspace_id.to_string(),
                HttpWorkspaceEntry {
                    id: workspace_id.to_string(),
                    agent_ids: Vec::new(),
                },
            );
        }
        Ok(WorkspaceHandle {
            id: workspace_id.to_string(),
            backend: self.name().to_string(),
            metadata: HashMap::new(),
        })
    }

    fn next_agent_id(&self, _workspace_id: &str) -> String {
        let id = generate();
        format_id(id, IdType::Agent)
    }
}

impl Default for AcpHttpBackend {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl AcpBackendInterface for AcpHttpBackend {
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

    fn next_agent_id(&self, _workspace_id: &str) -> String {
        // Use snowflake ID for deterministic, globally unique agent IDs
        let id = generate();
        format_id(id, IdType::Agent)
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
            Ok(if output.is_empty() {
                None
            } else {
                Some(output)
            })
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
        let entries: Vec<(String, HttpAgentEntry)> = self.agents.write().drain().collect();
        for (agent_id, entry) in entries {
            entry
                .alive
                .store(false, std::sync::atomic::Ordering::SeqCst);
            entry.abort_handle.abort();
            debug!(agent_id = %agent_id, "Aborted HTTP agent connection task");
        }
        Ok(())
    }

    fn last_activity_age(&self, _handle: &AgentHandle) -> Option<Duration> {
        None // AcpHttpBackend does not track structured activity age
    }

    // Observation operations - not supported by AcpHttpBackend
    async fn thoughts(&self, _agent_id: &str) -> ErgataiResult<Option<String>> {
        Err(ErgataiError::BackendUnsupported("thoughts".into()))
    }

    async fn take_recent_thinking(&self, _agent_id: &str) -> ErgataiResult<Option<String>> {
        Err(ErgataiError::BackendUnsupported(
            "take_recent_thinking".into(),
        ))
    }

    async fn output(&self, _agent_id: &str) -> ErgataiResult<Option<String>> {
        Err(ErgataiError::BackendUnsupported("output".into()))
    }

    async fn tool_calls(
        &self,
        _agent_id: &str,
    ) -> ErgataiResult<Option<Vec<crate::backends::acp::TrackedToolCall>>> {
        Err(ErgataiError::BackendUnsupported("tool_calls".into()))
    }

    async fn plan(
        &self,
        _agent_id: &str,
    ) -> ErgataiResult<Option<crate::backends::acp::TrackedPlan>> {
        Err(ErgataiError::BackendUnsupported("plan".into()))
    }

    async fn elicitations(
        &self,
        _agent_id: &str,
    ) -> ErgataiResult<Option<Vec<crate::backends::acp::TrackedElicitation>>> {
        Err(ErgataiError::BackendUnsupported("elicitations".into()))
    }

    async fn session_title(&self, _agent_id: &str) -> ErgataiResult<Option<String>> {
        Err(ErgataiError::BackendUnsupported("session_title".into()))
    }

    async fn session_id(&self, _agent_id: &str) -> ErgataiResult<Option<String>> {
        Err(ErgataiError::BackendUnsupported("session_id".into()))
    }

    async fn stop_reason(&self, _agent_id: &str) -> ErgataiResult<Option<String>> {
        Err(ErgataiError::BackendUnsupported("stop_reason".into()))
    }

    async fn workspace_capture_thoughts(&self, _workspace_id: &str) -> ErgataiResult<Option<bool>> {
        Err(ErgataiError::BackendUnsupported(
            "workspace_capture_thoughts".into(),
        ))
    }

    async fn continuation_count(&self, _agent_id: &str) -> ErgataiResult<Option<usize>> {
        Err(ErgataiError::BackendUnsupported(
            "continuation_count".into(),
        ))
    }

    async fn agent_last_activity_age(&self, _agent_id: &str) -> ErgataiResult<Option<Duration>> {
        Err(ErgataiError::BackendUnsupported(
            "agent_last_activity_age".into(),
        ))
    }

    async fn exit_code(&self, _agent_id: &str) -> ErgataiResult<Option<Option<i32>>> {
        Err(ErgataiError::BackendUnsupported("exit_code".into()))
    }

    async fn available_commands(
        &self,
        _agent_id: &str,
    ) -> ErgataiResult<Option<Vec<agent_client_protocol::schema::v1::AvailableCommand>>> {
        Err(ErgataiError::BackendUnsupported(
            "available_commands".into(),
        ))
    }

    async fn auto_continue(&self) -> ErgataiResult<bool> {
        Ok(false)
    }

    async fn max_auto_continues(&self) -> ErgataiResult<usize> {
        Ok(0)
    }

    async fn mcp_over_acp_enabled(&self) -> ErgataiResult<bool> {
        Ok(false)
    }

    async fn session_persistence_enabled(&self) -> ErgataiResult<bool> {
        Ok(false)
    }

    async fn config_options(
        &self,
        _agent_id: &str,
    ) -> ErgataiResult<Option<Vec<agent_client_protocol::schema::v1::SessionConfigOption>>> {
        Err(ErgataiError::BackendUnsupported("config_options".into()))
    }

    async fn usage(&self, _agent_id: &str) -> ErgataiResult<Option<(usize, usize)>> {
        Err(ErgataiError::BackendUnsupported("usage".into()))
    }

    async fn pid(&self, _agent_id: &str) -> ErgataiResult<Option<u32>> {
        Err(ErgataiError::BackendUnsupported("pid".into()))
    }

    async fn list_sessions(
        &self,
        _agent_id: &str,
    ) -> ErgataiResult<Vec<crate::types::SessionInfo>> {
        Err(ErgataiError::BackendUnsupported("list_sessions".into()))
    }

    async fn create_session(&self, _agent_id: &str) -> ErgataiResult<crate::types::SessionInfo> {
        Err(ErgataiError::BackendUnsupported("create_session".into()))
    }

    async fn load_session(&self, _agent_id: &str, _session_id: &str) -> ErgataiResult<()> {
        Err(ErgataiError::BackendUnsupported("load_session".into()))
    }

    async fn delete_session(&self, _agent_id: &str, _session_id: &str) -> ErgataiResult<()> {
        Err(ErgataiError::BackendUnsupported("delete_session".into()))
    }

    // Control operations
    async fn cancel_prompt(&self, agent_id: &str) -> ErgataiResult<()> {
        let command_tx = {
            let agents = self.agents.read();
            match agents.get(agent_id) {
                Some(entry) => entry.command_tx.clone(),
                None => {
                    return Err(ErgataiError::NotFound(format!(
                        "Agent not found: {agent_id}"
                    )));
                }
            }
        };

        let (response_tx, response_rx) = tokio::sync::oneshot::channel();
        command_tx
            .send(HttpAcpCommand::Cancel { response_tx })
            .await
            .map_err(|_| ErgataiError::internal("HTTP ACP command channel closed"))?;

        match response_rx.await {
            Ok(result) => result,
            Err(_) => Err(ErgataiError::internal("HTTP ACP response channel closed")),
        }
    }

    async fn execute_command(
        &self,
        _agent_id: &str,
        _command: &str,
        _timeout_secs: u64,
    ) -> ErgataiResult<String> {
        Err(ErgataiError::BackendUnsupported("execute_command".into()))
    }

    async fn respond_to_elicitation(
        &self,
        _elicitation_id: &str,
        _response: crate::ElicitationResponse,
    ) -> ErgataiResult<bool> {
        Err(ErgataiError::BackendUnsupported(
            "respond_to_elicitation".into(),
        ))
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
