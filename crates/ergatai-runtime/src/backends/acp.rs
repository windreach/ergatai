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

use std::collections::{HashMap, VecDeque};
use std::path::PathBuf;
use std::str::FromStr;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use async_trait::async_trait;
use parking_lot::RwLock;
use tokio::sync::{mpsc, oneshot};
use tracing::{debug, error, info, warn};

use agent_client_protocol::schema::v1::{
    ContentBlock, CreateElicitationRequest, CreateElicitationResponse, ElicitationAction,
    InitializeRequest, LoadSessionRequest, NewSessionRequest, Plan, PromptRequest,
    RequestPermissionRequest, RequestPermissionResponse, SessionNotification, SessionUpdate,
    TextContent, ToolCall as AcpToolCall, ToolCallLocation, ToolCallStatus, ToolCallUpdate,
    ToolKind,
};
use agent_client_protocol::schema::ProtocolVersion;
use agent_client_protocol::{AcpAgent, Agent, Client, ConnectionTo};

use ergatai_error::{ErgataiError, ErgataiResult};

/// Register a SystemToken for an ACP session to enable watchdog monitoring.
///
/// This allows the watchdog to detect agent crashes and reclaim locks automatically.
/// The token is registered with:
/// - TTL: 1 hour (will be renewed by heartbeat)
/// - Heartbeat interval: 30 seconds
/// - Project root: the agent's working directory
async fn register_system_token_for_acp_session(
    agent_id: &str,
    session_id: &str,
    project_root: &str,
) -> ErgataiResult<()> {
    use ergatai_lock::token::SystemToken;

    // Get the lock manager for the default project
    let lock_manager = ergatai_lock::get_lock_manager("default").await?;

    // Create a SystemToken with reasonable defaults
    // TTL: 1 hour, heartbeat interval: 30 seconds
    let token = SystemToken::new(
        agent_id.to_string(),
        session_id.to_string(),
        project_root.to_string(),
        3600, // TTL: 1 hour
        30,   // heartbeat interval: 30 seconds
    );

    // Register the token
    lock_manager
        .register_system_token(&token)
        .map_err(|e| ErgataiError::internal(format!("Failed to register SystemToken: {}", e)))?;

    Ok(())
}

/// Find the ergatai-preload library (libergatai_preload.so or .dylib).
///
/// Searches in common locations:
/// 1. Same directory as the current executable
/// 2. ../lib relative to the executable
/// 3. Standard library paths (/usr/lib, /usr/local/lib)
/// 4. Target directory relative to the executable (for development)
fn find_preload_library() -> Option<String> {
    let lib_name = if cfg!(target_os = "linux") {
        "libergatai_preload.so"
    } else if cfg!(target_os = "macos") {
        "libergatai_preload.dylib"
    } else {
        return None;
    };

    // Try to find the library in various locations
    let exe_path = std::env::current_exe().ok();
    let exe_dir = exe_path.as_ref().and_then(|p| p.parent());

    let search_paths = vec![
        // Same directory as executable
        exe_dir.map(|d| d.join(lib_name)),
        // ../lib relative to executable
        exe_dir
            .and_then(|d| d.parent())
            .map(|d| d.join("lib").join(lib_name)),
        // Standard library paths
        Some(PathBuf::from(format!("/usr/lib/{}", lib_name))),
        Some(PathBuf::from(format!("/usr/local/lib/{}", lib_name))),
        // Target directory relative to executable (development)
        exe_dir.map(|d| d.join("target").join("release").join(lib_name)),
        exe_dir.map(|d| d.join("target").join("debug").join(lib_name)),
    ];

    for path_opt in search_paths {
        if let Some(path) = path_opt {
            if path.exists() {
                return path.to_str().map(|s| s.to_string());
            }
        }
    }

    None
}

/// Get the IPC socket path for ergatai-lock.
///
/// Returns the default path: /tmp/ergatai-lock-{uid}.sock on Unix.
/// On non-Unix platforms, falls back to a per-process path using PID
/// to preserve per-user isolation (non-Unix is unreachable today since
/// `find_preload_library` returns `None` for non-Unix targets, but we
/// keep a safe fallback in case that changes).
fn get_ipc_socket_path() -> String {
    #[cfg(unix)]
    {
        // SAFETY: getuid() always succeeds, no safety invariants.
        let uid = unsafe { libc::getuid() };
        format!("/tmp/ergatai-lock-{uid}.sock")
    }
    #[cfg(not(unix))]
    {
        let pid = std::process::id();
        format!("/tmp/ergatai-lock-{pid}.sock")
    }
}

/// Extract text content from a ContentChunk (AgentMessageChunk or AgentThoughtChunk).
fn extract_text_from_chunk(
    chunk: &agent_client_protocol::schema::v1::ContentChunk,
) -> Option<String> {
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

/// Maximum number of tool calls to track per agent.
const MAX_TRACKED_TOOL_CALLS: usize = 200;

/// Maximum number of elicitations to track per agent.
const MAX_TRACKED_ELICITATIONS: usize = 50;

/// Default timeout for elicitation responses (60 seconds).
const DEFAULT_ELICITATION_TIMEOUT_SECS: u64 = 60;

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

/// Helper function to evict oldest entries when a tracker reaches capacity.
///
/// Removes entries from the front of `order` and corresponding entries from `calls`
/// until `order.len() < max_entries`.
fn evict_oldest_entries<V>(
    order: &mut VecDeque<String>,
    calls: &mut std::collections::HashMap<String, V>,
    max_entries: usize,
) {
    while order.len() >= max_entries {
        if let Some(oldest) = order.pop_front() {
            calls.remove(&oldest);
        } else {
            break;
        }
    }
}

/// A tracked ACP tool call with full structured fields.
///
/// Captures the complete lifecycle of a tool call: initial creation via
/// `SessionUpdate::ToolCall` and subsequent patches via `SessionUpdate::ToolCallUpdate`.
/// Updates are merged into the same record by `tool_call_id`.
#[derive(Clone, Debug, serde::Serialize)]
pub struct TrackedToolCall {
    /// ACP-assigned unique identifier for this tool call.
    pub tool_call_id: String,
    /// Human-readable description (e.g. "Edit src/main.rs").
    pub title: Option<String>,
    /// Tool category (Read, Edit, Delete, Execute, etc.).
    pub kind: Option<ToolKind>,
    /// Current execution status.
    pub status: ToolCallStatus,
    /// When the initial ToolCall notification was received.
    #[serde(skip)]
    pub first_seen: Instant,
    /// When the most recent update was applied.
    #[serde(skip)]
    pub last_updated: Instant,
    /// File paths affected by this tool call (path + optional line).
    pub locations: Vec<ToolCallLocation>,
    /// Tool arguments (JSON). May be large; HTTP API truncates to preview.
    pub raw_input: Option<serde_json::Value>,
    /// Tool results (JSON). May be large; HTTP API truncates to preview.
    pub raw_output: Option<serde_json::Value>,
}

/// Per-agent tool call tracker.
///
/// Stores tool calls in insertion order, merging updates by `tool_call_id`.
/// Evicts oldest entries when capacity is reached.
struct ToolCallTracker {
    /// tool_call_id -> tracked state
    calls: RwLock<HashMap<String, TrackedToolCall>>,
    /// Insertion order (oldest first) for eviction and "recent N" queries.
    order: RwLock<VecDeque<String>>,
    /// Maximum number of tool calls to retain.
    max_entries: usize,
}

impl ToolCallTracker {
    fn new(max_entries: usize) -> Self {
        Self {
            calls: RwLock::new(HashMap::new()),
            order: RwLock::new(VecDeque::new()),
            max_entries,
        }
    }

    /// Record the initial creation of a tool call (from `SessionUpdate::ToolCall`).
    fn record_initial(&self, tc: &AcpToolCall) {
        let id = tc.tool_call_id.to_string();
        let now = Instant::now();
        let tracked = TrackedToolCall {
            tool_call_id: id.clone(),
            title: Some(tc.title.clone()),
            kind: Some(tc.kind),
            status: tc.status,
            first_seen: now,
            last_updated: now,
            locations: tc.locations.clone(),
            raw_input: tc.raw_input.clone(),
            raw_output: tc.raw_output.clone(),
        };
        let mut calls = self.calls.write();
        let mut order = self.order.write();
        // If we've seen this id before (unexpected but handle gracefully), replace.
        if calls.contains_key(&id) {
            calls.insert(id.clone(), tracked);
            return;
        }
        // Evict oldest if at capacity.
        evict_oldest_entries(&mut order, &mut calls, self.max_entries);
        calls.insert(id.clone(), tracked);
        order.push_back(id);
    }

    /// Apply a patch update (from `SessionUpdate::ToolCallUpdate`).
    ///
    /// Merges optional fields into the existing record. Collections (locations)
    /// overwrite; scalars (title, status, kind) replace if present.
    /// If the tool_call_id is unknown, creates a new record with only the
    /// provided fields (status defaults to Pending).
    fn apply_update(&self, update: &ToolCallUpdate) {
        let id = update.tool_call_id.to_string();
        let mut calls = self.calls.write();
        let mut order = self.order.write();
        let now = Instant::now();

        if let Some(existing) = calls.get_mut(&id) {
            // Merge fields.
            if let Some(ref kind) = update.fields.kind {
                existing.kind = Some(*kind);
            }
            if let Some(ref status) = update.fields.status {
                existing.status = *status;
            }
            if let Some(ref title) = update.fields.title {
                existing.title = Some(title.clone());
            }
            if let Some(ref locations) = update.fields.locations {
                existing.locations = locations.clone();
            }
            if update.fields.raw_input.is_some() {
                existing.raw_input = update.fields.raw_input.clone();
            }
            if update.fields.raw_output.is_some() {
                existing.raw_output = update.fields.raw_output.clone();
            }
            existing.last_updated = now;
        } else {
            // Unknown id — create a minimal record from the update.
            let tracked = TrackedToolCall {
                tool_call_id: id.clone(),
                title: update.fields.title.clone(),
                kind: update.fields.kind,
                status: update.fields.status.unwrap_or(ToolCallStatus::Pending),
                first_seen: now,
                last_updated: now,
                locations: update.fields.locations.clone().unwrap_or_default(),
                raw_input: update.fields.raw_input.clone(),
                raw_output: update.fields.raw_output.clone(),
            };
            // Evict oldest if at capacity.
            evict_oldest_entries(&mut order, &mut calls, self.max_entries);
            calls.insert(id.clone(), tracked);
            order.push_back(id);
        }
    }

    /// Return the most recent `limit` tool calls, newest first.
    fn get_recent(&self, limit: usize) -> Vec<TrackedToolCall> {
        let calls = self.calls.read();
        let order = self.order.read();
        order
            .iter()
            .rev()
            .take(limit)
            .filter_map(|id| calls.get(id).cloned())
            .collect()
    }
}

/// Tracks token usage for an agent
struct UsageTracker {
    input_tokens: AtomicUsize,
    output_tokens: AtomicUsize,
}

impl UsageTracker {
    fn new() -> Self {
        Self {
            input_tokens: AtomicUsize::new(0),
            output_tokens: AtomicUsize::new(0),
        }
    }

    fn record(&self, input: usize, output: usize) {
        self.input_tokens.fetch_add(input, Ordering::Relaxed);
        self.output_tokens.fetch_add(output, Ordering::Relaxed);
    }

    fn get_usage(&self) -> (usize, usize) {
        (
            self.input_tokens.load(Ordering::Relaxed),
            self.output_tokens.load(Ordering::Relaxed),
        )
    }
}

/// Command sent to the ACP connection task via channel.
enum AcpCommand {
    /// Send a prompt message to the agent.
    Prompt {
        message: String,
        response_tx: oneshot::Sender<ErgataiResult<()>>,
    },
    /// Cancel the current prompt turn (sends `session/cancel` notification).
    Cancel {
        response_tx: oneshot::Sender<ErgataiResult<()>>,
    },
    /// Graceful stop (connection task will exit, closing the ACP connection).
    Stop,
}

/// Tracked agent execution plan (from `SessionUpdate::Plan`).
///
/// ACP plan semantics: each update is a complete replacement of the entire plan.
/// We store the latest plan plus a timestamp for freshness tracking.
#[derive(Clone, Debug, serde::Serialize)]
pub struct TrackedPlan {
    /// The plan entries (full snapshot — ACP replaces the whole plan on each update).
    pub entries: Vec<TrackedPlanEntry>,
    /// When this plan was last updated.
    #[serde(skip)]
    pub last_updated: Instant,
}

/// A single entry in an agent's execution plan.
#[derive(Clone, Debug, serde::Serialize)]
pub struct TrackedPlanEntry {
    /// Human-readable task description.
    pub content: String,
    /// Priority: "high", "medium", "low".
    pub priority: String,
    /// Status: "pending", "in_progress", "completed".
    pub status: String,
}

impl TrackedPlan {
    /// Convert an ACP `Plan` into a `TrackedPlan`.
    fn from_acp(plan: &Plan) -> Self {
        let entries = plan
            .entries
            .iter()
            .map(|e| TrackedPlanEntry {
                content: e.content.clone(),
                priority: format!("{:?}", e.priority).to_lowercase(),
                status: format!("{:?}", e.status).to_lowercase(),
            })
            .collect();
        Self {
            entries,
            last_updated: Instant::now(),
        }
    }
}

/// Response to an elicitation request (from frontend or auto-decline).
#[derive(Clone, Debug)]
pub struct ElicitationResponse {
    /// The action to take: "accept", "decline", or "cancel".
    pub action: String,
    /// Optional form data (for form-mode elicitations).
    pub form_data: Option<serde_json::Value>,
}

/// Tracked ACP elicitation request (agent asking user for input).
#[derive(Clone, Debug, serde::Serialize)]
pub struct TrackedElicitation {
    /// Unique elicitation ID (generated by us for tracking).
    pub elicitation_id: String,
    /// The agent's message describing what input is needed.
    pub message: String,
    /// Mode discriminator: "form", "url", or custom.
    pub mode: String,
    /// When the elicitation was received.
    #[serde(skip)]
    pub received_at: Instant,
    /// Whether this elicitation has been responded to.
    pub responded: bool,
    /// The action taken (e.g., "decline", "accept", "cancel").
    pub action: Option<String>,
}

/// Per-agent elicitation tracker.
///
/// Stores recent elicitation requests (pending + responded). Auto-declines
/// after a timeout if no response is provided via REST API.
struct ElicitationTracker {
    /// elicitation_id -> tracked state
    elicitations: RwLock<HashMap<String, TrackedElicitation>>,
    /// Insertion order (oldest first) for eviction.
    order: RwLock<VecDeque<String>>,
    /// Maximum number of elicitations to retain.
    max_entries: usize,
}

impl ElicitationTracker {
    fn new(max_entries: usize) -> Self {
        Self {
            elicitations: RwLock::new(HashMap::new()),
            order: RwLock::new(VecDeque::new()),
            max_entries,
        }
    }

    /// Record a new elicitation request.
    fn record(&self, elicitation_id: String, message: String, mode: String) {
        let tracked = TrackedElicitation {
            elicitation_id: elicitation_id.clone(),
            message,
            mode,
            received_at: Instant::now(),
            responded: false,
            action: None,
        };
        let mut elicitations = self.elicitations.write();
        let mut order = self.order.write();
        // Evict oldest if at capacity.
        evict_oldest_entries(&mut order, &mut elicitations, self.max_entries);
        elicitations.insert(elicitation_id.clone(), tracked);
        order.push_back(elicitation_id);
    }

    /// Mark an elicitation as responded.
    fn mark_responded(&self, elicitation_id: &str, action: String) {
        let mut elicitations = self.elicitations.write();
        if let Some(e) = elicitations.get_mut(elicitation_id) {
            e.responded = true;
            e.action = Some(action);
        }
    }

    /// Get all elicitations (pending + responded).
    fn get_all(&self) -> Vec<TrackedElicitation> {
        let elicitations = self.elicitations.read();
        let order = self.order.read();
        order
            .iter()
            .filter_map(|id| elicitations.get(id).cloned())
            .collect()
    }
}

/// Tracks a running ACP agent's state.
struct AcpAgentEntry {
    /// Channel to send commands to the connection task.
    command_tx: mpsc::Sender<AcpCommand>,
    /// Output buffer for captured agent responses.
    output: Arc<OutputBuffer>,
    /// Thought buffer for captured agent thoughts (if capture_thoughts enabled).
    thoughts: Arc<OutputBuffer>,
    /// Tool call tracker for monitoring agent tool usage.
    tool_calls: Arc<ToolCallTracker>,
    /// Usage tracker for monitoring token consumption.
    usage: Arc<UsageTracker>,
    /// Current execution plan reported by the agent (latest snapshot).
    plan: Arc<RwLock<Option<TrackedPlan>>>,
    /// Elicitation tracker for agent-initiated user input requests.
    elicitations: Arc<ElicitationTracker>,
    /// Session title/metadata from `SessionUpdate::SessionInfoUpdate`.
    session_title: Arc<RwLock<Option<String>>>,
    /// Last prompt response stop_reason (EndTurn, MaxTokens, Refusal, etc.).
    stop_reason: Arc<RwLock<Option<String>>>,
    /// Number of automatic continuations performed for this agent.
    continuation_count: Arc<std::sync::atomic::AtomicUsize>,
    /// Configuration options reported by the agent (from `SessionUpdate::ConfigOptionUpdate`).
    config_options: Arc<RwLock<Vec<agent_client_protocol::schema::v1::SessionConfigOption>>>,
    /// Available slash commands reported by the agent (from `SessionUpdate::AvailableCommandsUpdate`).
    available_commands: Arc<RwLock<Vec<agent_client_protocol::schema::v1::AvailableCommand>>>,
    /// Last time output was received (for watchdog).
    last_output_at: Arc<RwLock<Instant>>,
    /// Whether the agent process is still alive.
    alive: Arc<std::sync::atomic::AtomicBool>,
    /// The AgentHandle for this agent.
    handle: AgentHandle,
    /// Abort handle for the connection task (can be cloned and used to abort the task).
    abort_handle: tokio::task::AbortHandle,
    /// Exit code from the connection task (None while running, Some after exit).
    /// 0 = normal exit, non-zero = error/crash.
    exit_code: Arc<RwLock<Option<i32>>>,
}

/// Logical workspace (no physical resources, just metadata).
struct WorkspaceEntry {
    id: String,
    /// Per-workspace counter for deterministic agent IDs.
    agent_counter: AtomicUsize,
    agent_ids: Vec<String>,
    /// Environment variables to pass to agents in this workspace.
    env: HashMap<String, String>,
    /// Whether to capture agent thoughts.
    capture_thoughts: bool,
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
    /// Optional session persistence. When set, agent `session_id`s are saved
    /// on creation and looked up on start to enable `session/load` recovery.
    session_store: Option<Arc<crate::session_store::SessionStore>>,
    /// Policy for evaluating ACP permission requests. Defaults to YOLO
    /// (auto-approve everything). Plug in `ergatai-lock` or custom policy via
    /// `with_permission_handler()`.
    permission_handler: Arc<dyn crate::permission::PermissionHandler>,
    /// Whether to automatically continue prompts when `stop_reason` is
    /// `max_tokens` or `max_turn_requests`. Disabled by default.
    auto_continue: bool,
    /// Maximum number of automatic continuations per agent (default 3).
    max_auto_continues: usize,
    /// Pending elicitation responders (elicitation_id -> oneshot sender).
    /// When an elicitation arrives, we store the sender here and await the
    /// receiver in the handler. The HTTP API sends responses through the sender.
    pending_elicitations: Arc<RwLock<HashMap<String, tokio::sync::oneshot::Sender<ElicitationResponse>>>>,
    /// Optional MCP server factory for MCP-over-ACP. When enabled, agents can call
    /// ergatai's MCP tools through the native ACP transport.
    mcp_server_factory: Option<Arc<dyn crate::mcp_over_acp::McpServerFactory>>,
}

impl AcpBackend {
    /// Create a new AcpBackend without session persistence and YOLO permissions.
    pub fn new() -> Self {
        Self {
            agents: RwLock::new(HashMap::new()),
            workspaces: RwLock::new(HashMap::new()),
            dead_agents: Arc::new(parking_lot::Mutex::new(Vec::new())),
            session_store: None,
            permission_handler: Arc::new(crate::permission::YoloPermissionHandler),
            auto_continue: false,
            max_auto_continues: 3,
            pending_elicitations: Arc::new(RwLock::new(HashMap::new())),
            mcp_server_factory: None,
        }
    }

    /// Enable automatic prompt continuation when `stop_reason` is `max_tokens`
    /// or `max_turn_requests`.
    ///
    /// When enabled, the backend will automatically send a follow-up prompt
    /// ("Please continue your unfinished work") up to `max_continues` times.
    /// This is opt-in to prevent unintended infinite loops.
    pub fn with_auto_continue(mut self, max_continues: usize) -> Self {
        self.auto_continue = true;
        self.max_auto_continues = max_continues;
        self
    }

    /// Attach a session store so agent sessions survive process restarts.
    ///
    /// When set, `start_agent` will look up the agent's previous `session_id`
    /// and attempt `session/load` before falling back to `session/new`.
    pub fn with_session_store(mut self, store: crate::session_store::SessionStore) -> Self {
        self.session_store = Some(Arc::new(store));
        self
    }

    /// Attach a custom permission handler for ACP permission requests.
    ///
    /// The default is [`YoloPermissionHandler`] (auto-approve all requests).
    /// Pass an `ergatai_lock`-backed handler to enforce file access control
    /// on ACP tool calls.
    pub fn with_permission_handler(
        mut self,
        handler: Arc<dyn crate::permission::PermissionHandler>,
    ) -> Self {
        self.permission_handler = handler;
        self
    }

    /// Attach an MCP server factory for MCP-over-ACP.
    ///
    /// When set, agents started by this backend can call ergatai's MCP tools
    /// through the native ACP transport using `mcp/connect`, `mcp/message`,
    /// and `mcp/disconnect` protocol messages.
    ///
    /// The factory is called for each new agent session to create an MCP server
    /// instance that will be attached to the ACP session.
    pub fn with_mcp_server_factory(
        mut self,
        factory: impl crate::mcp_over_acp::McpServerFactory,
    ) -> Self {
        self.mcp_server_factory = Some(Arc::new(factory));
        self
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

    /// Get captured thoughts for an agent (if capture_thoughts is enabled).
    pub fn get_agent_thoughts(&self, agent_id: &str) -> Option<String> {
        self.reap_dead();
        let agents = self.agents.read();
        agents.get(agent_id).and_then(|entry| {
            let thoughts_data = entry.thoughts.data.read();
            if thoughts_data.is_empty() {
                None
            } else {
                String::from_utf8(thoughts_data.clone()).ok()
            }
        })
    }

    /// Get recent tool calls for an agent (last 100, newest first).
    ///
    /// Returns the full structured `TrackedToolCall` records with all ACP fields
    /// (tool_call_id, title, kind, status, locations, raw_input, raw_output).
    pub fn get_agent_tool_calls(&self, agent_id: &str) -> Option<Vec<TrackedToolCall>> {
        self.reap_dead();
        let agents = self.agents.read();
        agents
            .get(agent_id)
            .map(|entry| entry.tool_calls.get_recent(100))
    }

    /// Get the current execution plan reported by an agent (if any).
    ///
    /// Returns the latest `SessionUpdate::Plan` snapshot. ACP replaces the
    /// entire plan on each update, so this is always the most recent version.
    pub fn get_agent_plan(&self, agent_id: &str) -> Option<TrackedPlan> {
        self.reap_dead();
        let agents = self.agents.read();
        agents
            .get(agent_id)
            .and_then(|entry| entry.plan.read().clone())
    }

    /// Get recent elicitation requests for an agent.
    ///
    /// Returns both pending and responded elicitations.
    pub fn get_agent_elicitations(&self, agent_id: &str) -> Option<Vec<TrackedElicitation>> {
        self.reap_dead();
        let agents = self.agents.read();
        agents
            .get(agent_id)
            .map(|entry| entry.elicitations.get_all())
    }

    /// Get the session title reported by an agent (if any).
    ///
    /// Extracted from `SessionUpdate::SessionInfoUpdate`. Returns `None` if
    /// the agent hasn't reported a title yet.
    pub fn get_agent_session_title(&self, agent_id: &str) -> Option<String> {
        self.reap_dead();
        let agents = self.agents.read();
        agents
            .get(agent_id)
            .and_then(|entry| entry.session_title.read().clone())
    }

    /// Get the stop reason from the most recent prompt response.
    ///
    /// Returns `None` if no prompt has completed yet. Possible values include
    /// `EndTurn`, `MaxTokens`, `MaxTurnRequests`, `Refusal`, `Cancelled`.
    pub fn get_agent_stop_reason(&self, agent_id: &str) -> Option<String> {
        self.reap_dead();
        let agents = self.agents.read();
        agents
            .get(agent_id)
            .and_then(|entry| entry.stop_reason.read().clone())
    }

    /// Get the number of automatic continuations performed for an agent.
    pub fn get_agent_continuation_count(&self, agent_id: &str) -> Option<usize> {
        self.reap_dead();
        let agents = self.agents.read();
        agents.get(agent_id).map(|entry| {
            entry
                .continuation_count
                .load(std::sync::atomic::Ordering::SeqCst)
        })
    }

    /// Get configuration options reported by the agent.
    ///
    /// Returns the latest snapshot from `SessionUpdate::ConfigOptionUpdate`.
    pub fn get_agent_config_options(
        &self,
        agent_id: &str,
    ) -> Option<Vec<agent_client_protocol::schema::v1::SessionConfigOption>> {
        self.reap_dead();
        let agents = self.agents.read();
        agents
            .get(agent_id)
            .map(|entry| entry.config_options.read().clone())
    }

    /// Get available slash commands reported by the agent.
    ///
    /// Returns the latest snapshot from `SessionUpdate::AvailableCommandsUpdate`.
    pub fn get_agent_available_commands(
        &self,
        agent_id: &str,
    ) -> Option<Vec<agent_client_protocol::schema::v1::AvailableCommand>> {
        self.reap_dead();
        let agents = self.agents.read();
        agents
            .get(agent_id)
            .map(|entry| entry.available_commands.read().clone())
    }

    /// Respond to a pending elicitation request.
    ///
    /// Returns `Ok(true)` if the elicitation was found and the response was sent.
    /// Returns `Ok(false)` if the elicitation ID was not found (already responded or invalid).
    /// Returns `Err` if the channel is closed.
    pub async fn respond_to_elicitation(
        &self,
        elicitation_id: &str,
        response: ElicitationResponse,
    ) -> ErgataiResult<bool> {
        let sender = self.pending_elicitations.write().remove(elicitation_id);
        match sender {
            Some(tx) => {
                tx.send(response).map_err(|_| {
                    ErgataiError::internal("Elicitation response channel closed")
                })?;
                Ok(true)
            }
            None => Ok(false),
        }
    }

    /// Get token usage statistics for an agent.
    pub fn get_agent_usage(&self, agent_id: &str) -> Option<(usize, usize)> {
        self.reap_dead();
        let agents = self.agents.read();
        agents.get(agent_id).map(|entry| entry.usage.get_usage())
    }

    /// Cancel the current prompt turn for an agent (sends `session/cancel`).
    ///
    /// This does NOT stop the agent — it only cancels the in-flight prompt.
    /// The agent will return a response with `stop_reason = "cancelled"`.
    pub async fn cancel_prompt(&self, agent_id: &str) -> ErgataiResult<()> {
        self.reap_dead();
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

        let (response_tx, response_rx) = oneshot::channel();
        command_tx
            .send(AcpCommand::Cancel { response_tx })
            .await
            .map_err(|_| ErgataiError::internal("ACP command channel closed"))?;

        match response_rx.await {
            Ok(result) => result,
            Err(_) => Err(ErgataiError::internal("ACP response channel closed")),
        }
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
            supports_message_injection: true, // ACP session/prompt
            supports_output_capture: true,    // ACP session notifications
            supports_resource_limits: false,  // TODO: future enhancement
            supports_workspace_reuse: true,   // logical workspaces
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

        // Create workspace entry with per-workspace agent counter, env vars, and thought capture config.
        let entry = WorkspaceEntry {
            id: spec.id.clone(),
            agent_counter: AtomicUsize::new(0),
            agent_ids: Vec::new(),
            env: spec.env.clone(),
            capture_thoughts: spec.capture_thoughts,
        };

        self.workspaces.write().insert(workspace_id.clone(), entry);

        info!(workspace_id = %workspace_id, work_dir = %spec.work_dir.display(), env_count = spec.env.len(), "Created workspace");

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

    fn next_agent_id(&self, workspace_id: &str) -> String {
        // Delegate to the inherent `next_agent_id` method above.
        // Inherent methods take priority over trait methods on `self.method()`
        // resolution, so this call dispatches to the inherent impl.
        self.next_agent_id(workspace_id)
    }

    async fn start_agent(
        &self,
        handle: &WorkspaceHandle,
        command: &str,
        instruction: Option<&str>,
    ) -> ErgataiResult<AgentHandle> {
        // Reap any dead agents before starting a new one.
        self.reap_dead();

        // Use pre-computed agent_id from metadata if available (set by launch_agent for pre-registration).
        // Otherwise generate a new one.
        let agent_id = handle
            .metadata
            .get("precomputed_agent_id")
            .cloned()
            .unwrap_or_else(|| self.next_agent_id(&handle.id));

        // Get workspace env vars and capture_thoughts config to pass to the agent process.
        // Clone directly into the mutable env map we'll inject LD_PRELOAD into
        // (avoids a redundant intermediate clone).
        let (mut env_with_preload, capture_thoughts) = {
            let workspaces = self.workspaces.read();
            workspaces
                .get(&handle.id)
                .map(|entry| (entry.env.clone(), entry.capture_thoughts))
                .unwrap_or_default()
        };

        // Inject LD_PRELOAD for file lock snapshot reads (if available).
        if let Some(preload_path) = find_preload_library() {
            // Set LD_PRELOAD (or DYLD_INSERT_LIBRARIES on macOS)
            #[cfg(target_os = "linux")]
            {
                env_with_preload.insert("LD_PRELOAD".into(), preload_path.clone());
            }
            #[cfg(target_os = "macos")]
            {
                env_with_preload.insert("DYLD_INSERT_LIBRARIES".into(), preload_path.clone());
            }

            // Set IPC socket path for snapshot queries
            let socket_path = get_ipc_socket_path();
            env_with_preload.insert("ERGATAI_IPC_SOCKET".into(), socket_path);

            info!(
                preload_path = %preload_path,
                agent_id = %agent_id,
                "LD_PRELOAD injected for file lock snapshot reads"
            );
        } else {
            debug!(
                agent_id = %agent_id,
                "LD_PRELOAD library not found; file lock snapshot reads disabled"
            );
        }

        // Parse the command string into an AcpAgent.
        // Supports: "python agent.py", "npx -y @agentclientprotocol/claude-agent-acp@latest",
        // or JSON: {"command":"python","args":["agent.py"]}
        // Then inject workspace env vars into the agent config.
        let config = AcpAgent::from_str(command)
            .map_err(|e| {
                ErgataiError::internal(format!(
                    "Failed to parse ACP agent command '{}': {}",
                    command, e
                ))
            })?
            .into_config()
            .envs(env_with_preload.iter());
        let acp_agent = AcpAgent::new(config).with_debug(|line, direction| {
            debug!(?direction, line = %line, "ACP wire debug");
        });

        // Shared state between this backend and the connection task.
        let output = Arc::new(OutputBuffer::new(OUTPUT_BUFFER_MAX_SIZE));
        let thoughts = Arc::new(OutputBuffer::new(OUTPUT_BUFFER_MAX_SIZE));
        let tool_calls = Arc::new(ToolCallTracker::new(MAX_TRACKED_TOOL_CALLS));
        let plan: Arc<RwLock<Option<TrackedPlan>>> = Arc::new(RwLock::new(None));
        let elicitations = Arc::new(ElicitationTracker::new(MAX_TRACKED_ELICITATIONS));
        let session_title: Arc<RwLock<Option<String>>> = Arc::new(RwLock::new(None));
        let stop_reason: Arc<RwLock<Option<String>>> = Arc::new(RwLock::new(None));
        let continuation_count = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let config_options: Arc<RwLock<Vec<agent_client_protocol::schema::v1::SessionConfigOption>>> = Arc::new(RwLock::new(Vec::new()));
        let available_commands: Arc<RwLock<Vec<agent_client_protocol::schema::v1::AvailableCommand>>> = Arc::new(RwLock::new(Vec::new()));
        let usage = Arc::new(UsageTracker::new());
        let last_output_at = Arc::new(RwLock::new(Instant::now()));
        let alive = Arc::new(std::sync::atomic::AtomicBool::new(true));
        let exit_code = Arc::new(RwLock::new(None));

        // Channel for sending commands (prompts, stop) to the connection task.
        let (command_tx, mut command_rx) = mpsc::channel::<AcpCommand>(32);

        // Oneshot for the connection task to report the session_id back.
        let (session_tx, session_rx) =
            oneshot::channel::<agent_client_protocol::schema::v1::SessionId>();

        // Shared session_id between connect_with (writes) and on_receive_request (reads).
        // Set after session/new or session/load completes.
        let shared_session_id: Arc<RwLock<Option<String>>> = Arc::new(RwLock::new(None));

        // Clone shared state for the connection task.
        let task_command_tx = command_tx.clone();
        let task_output = output.clone();
        let task_thoughts = thoughts.clone();
        let task_tool_calls = tool_calls.clone();
        let task_plan = plan.clone();
        let task_elicitations = elicitations.clone();
        let task_session_title = session_title.clone();
        let task_stop_reason = stop_reason.clone();
        let task_continuation_count = continuation_count.clone();
        let task_config_options = config_options.clone();
        let task_available_commands = available_commands.clone();
        let task_usage = usage.clone();
        let task_capture_thoughts = capture_thoughts;
        let task_last_output_at = last_output_at.clone();
        let task_alive = alive.clone();
        let task_exit_code = exit_code.clone();
        let task_agent_id = agent_id.clone();
        let task_dead_agents = self.dead_agents.clone();
        let task_permission_handler = self.permission_handler.clone();
        let task_shared_session_id = shared_session_id.clone();
        let task_auto_continue = self.auto_continue;
        let task_max_auto_continues = self.max_auto_continues;
        let task_pending_elicitations = self.pending_elicitations.clone();
        let cwd = handle
            .metadata
            .get("work_dir")
            .map(PathBuf::from)
            .unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| PathBuf::from("/")));

        // Look up a previously saved session for this agent (for session/load recovery).
        let saved_session_id: Option<String> = self
            .session_store
            .as_ref()
            .and_then(|store| match store.load_session(&agent_id) {
                Ok(Some(record)) if record.command == command => {
                    info!(
                        agent_id = %agent_id,
                        session_id = %record.session_id,
                        "Found saved ACP session, will attempt session/load"
                    );
                    Some(record.session_id)
                }
                Ok(Some(record)) => {
                    info!(
                        agent_id = %agent_id,
                        old_command = %record.command,
                        new_command = %command,
                        "Saved session command mismatch, creating new session"
                    );
                    None
                }
                Ok(None) => None,
                Err(e) => {
                    warn!(error = %e, "Failed to load saved session, creating new");
                    None
                }
            });

        // Clone for the connection task — session_store is shared via Arc.
        let task_session_store = self.session_store.clone();
        let task_mcp_server_factory = self.mcp_server_factory.clone();
        let task_command_for_save = command.to_string();
        let task_cwd_for_save = cwd.clone();
        // Separate clone for session save inside the connect_with closure.
        // We can't capture `task_agent_id` itself because it's needed after the closure exits.
        let task_agent_id_for_save = task_agent_id.clone();

        // Note: ACP SDK's connect_with() doesn't expose the child process PID.
        // This limits file lock attribution via fanotify.
        // TODO: Consider using spawn_process() directly or requesting ACP SDK to expose PID.
        // For now, file lock enforcement relies on LD_PRELOAD (injected above) rather than PID-based fanotify.

        // Spawn the ACP connection task.
        let join_handle = tokio::spawn(async move {
            // Build the ACP client with notification and permission handlers.
            let result = Client
                .builder()
                .name(format!("ergatai-acp-{}", task_agent_id))
                .on_receive_notification(
                    {
                        let out = task_output.clone();
                        let thoughts = task_thoughts.clone();
                        let tool_calls = task_tool_calls.clone();
                        let usage = task_usage.clone();
                        let capture_thoughts = task_capture_thoughts;
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
                                        if capture_thoughts {
                                            thoughts.append(format!("[thinking] {}\n", text).as_bytes());
                                        }
                                    }
                                }
                                SessionUpdate::UsageUpdate(usage_update) => {
                                    debug!(used = usage_update.used, size = usage_update.size, "ACP usage update");
                                    usage.record(usage_update.used as usize, usage_update.size as usize);
                                }
                                SessionUpdate::ToolCall(tc) => {
                                    debug!(
                                        id = %tc.tool_call_id,
                                        title = %tc.title,
                                        kind = ?tc.kind,
                                        "ACP tool call started"
                                    );
                                    tool_calls.record_initial(tc);
                                }
                                SessionUpdate::ToolCallUpdate(update) => {
                                    debug!(
                                        id = %update.tool_call_id,
                                        status = ?update.fields.status,
                                        title = ?update.fields.title,
                                        "ACP tool call update"
                                    );
                                    tool_calls.apply_update(update);
                                }
                                SessionUpdate::Plan(acp_plan) => {
                                    let entry_count = acp_plan.entries.len();
                                    let completed = acp_plan
                                        .entries
                                        .iter()
                                        .filter(|e| {
                                            e.status
                                                == agent_client_protocol::schema::v1::PlanEntryStatus::Completed
                                        })
                                        .count();
                                    debug!(
                                        entries = entry_count,
                                        completed = completed,
                                        "ACP plan update"
                                    );
                                    *task_plan.write() = Some(TrackedPlan::from_acp(acp_plan));
                                }
                                SessionUpdate::SessionInfoUpdate(info) => {
                                    // Extract title if present (Value variant).
                                    if let Some(title) = info.title.value() {
                                        debug!(title = %title, "ACP session title updated");
                                        *task_session_title.write() = Some(title.clone());
                                    }
                                }
                                SessionUpdate::ConfigOptionUpdate(config_update) => {
                                    debug!(
                                        count = config_update.config_options.len(),
                                        "ACP config options updated"
                                    );
                                    *task_config_options.write() = config_update.config_options.clone();
                                }
                                SessionUpdate::AvailableCommandsUpdate(cmds_update) => {
                                    debug!(
                                        count = cmds_update.available_commands.len(),
                                        "ACP available commands updated"
                                    );
                                    *task_available_commands.write() = cmds_update.available_commands.clone();
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
                    {
                        let handler = task_permission_handler.clone();
                        let sid = task_shared_session_id.clone();
                        let aid = task_agent_id.clone();
                        async move |request: RequestPermissionRequest, responder, _connection| {
                            // Clone session_id and release lock before calling async evaluate
                            let session_id_str = {
                                let guard = sid.read();
                                guard.clone().unwrap_or_default()
                            };
                            let decision = handler.evaluate(&aid, &session_id_str, &request).await;
                            debug!(
                                agent_id = %aid,
                                decision = ?decision,
                                "ACP permission decision"
                            );
                            responder.respond(RequestPermissionResponse::new(
                                decision.into_outcome(),
                            ))
                        }
                    },
                    agent_client_protocol::on_receive_request!(),
                )
                .on_receive_request(
                    {
                        let elics = task_elicitations.clone();
                        let aid = task_agent_id.clone();
                        let pending = task_pending_elicitations.clone();
                        async move |request: CreateElicitationRequest, responder, _connection| {
                            // Generate a tracking ID for this elicitation.
                            let elicitation_id = format!(
                                "elic-{}-{}",
                                aid,
                                uuid::Uuid::new_v4().to_string().split('-').next().unwrap_or("0000")
                            );
                            let mode_str = match &request.mode {
                                agent_client_protocol::schema::v1::ElicitationMode::Form(_) => {
                                    "form".to_string()
                                }
                                agent_client_protocol::schema::v1::ElicitationMode::Url(_) => {
                                    "url".to_string()
                                }
                                agent_client_protocol::schema::v1::ElicitationMode::Other(o) => {
                                    format!("other:{}", o.mode)
                                }
                                _ => "unknown".to_string(),
                            };
                            info!(
                                agent_id = %aid,
                                elicitation_id = %elicitation_id,
                                mode = %mode_str,
                                message = %request.message,
                                "ACP elicitation request received (awaiting frontend response)"
                            );
                            elics.record(elicitation_id.clone(), request.message.clone(), mode_str);

                            // Create a oneshot channel for the response.
                            let (response_tx, response_rx) = tokio::sync::oneshot::channel::<ElicitationResponse>();
                            pending.write().insert(elicitation_id.clone(), response_tx);

                            // Wait for response with timeout.
                            let response = tokio::time::timeout(
                                std::time::Duration::from_secs(DEFAULT_ELICITATION_TIMEOUT_SECS),
                                response_rx,
                            )
                            .await;

                            // Remove from pending map.
                            pending.write().remove(&elicitation_id);

                            let action = match response {
                                Ok(Ok(resp)) => {
                                    info!(elicitation_id = %elicitation_id, action = %resp.action, "Elicitation responded");
                                    elics.mark_responded(&elicitation_id, resp.action.clone());
                                    match resp.action.as_str() {
                                        "accept" => {
                                            // TODO: parse form_data into ElicitationContentValue map
                                            ElicitationAction::Accept(agent_client_protocol::schema::v1::ElicitationAcceptAction::new())
                                        },
                                        "cancel" => ElicitationAction::Cancel,
                                        _ => ElicitationAction::Decline,
                                    }
                                }
                                _ => {
                                    warn!(elicitation_id = %elicitation_id, "Elicitation timeout or cancelled, auto-declining");
                                    elics.mark_responded(&elicitation_id, "decline".to_string());
                                    ElicitationAction::Decline
                                }
                            };

                            responder.respond(CreateElicitationResponse::new(action))
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

                    // Step 2: Create or load an ACP session.
                    let session_id = if let Some(saved_sid) = saved_session_id {
                        info!(session_id = %saved_sid, "Attempting session/load");
                        match connection
                            .send_request(LoadSessionRequest::new(saved_sid.clone(), &cwd))
                            .block_task()
                            .await
                        {
                            Ok(_load_resp) => {
                                info!(session_id = %saved_sid, "Loaded existing ACP session");
                                // LoadSessionResponse carries modes/config_options but no session_id;
                                // the session_id we passed in is the authoritative one.
                                agent_client_protocol::schema::v1::SessionId::from(saved_sid)
                            }
                            Err(e) => {
                                warn!(
                                    error = %e,
                                    saved_session_id = %saved_sid,
                                    "session/load failed, falling back to session/new"
                                );
                                let new_resp = connection
                                    .send_request(NewSessionRequest::new(&cwd))
                                    .block_task()
                                    .await?;
                                new_resp.session_id
                            }
                        }
                    } else {
                        let new_resp = connection
                            .send_request(NewSessionRequest::new(&cwd))
                            .block_task()
                            .await?;
                        new_resp.session_id
                    };
                    info!(session_id = %session_id, "ACP session ready");

                    // Log MCP server configuration if enabled.
                    if let Some(mcp_factory) = &task_mcp_server_factory {
                        info!(
                            mcp_server_name = %mcp_factory.server_name(),
                            "MCP-over-ACP factory configured for agent session"
                        );
                        // TODO: Create and attach MCP server to session.
                        // This requires using the factory to create an McpServer instance
                        // and attaching it using the ACP SDK's session builder API.
                        // The factory returns a Box<dyn Any> that needs to be downcast
                        // to the concrete McpServer type.
                    }

                    // Publish session_id for the permission handler closure.
                    *task_shared_session_id.write() = Some(session_id.to_string());

                    // Persist the session_id so we can attempt session/load on next start.
                    if let Some(store) = &task_session_store {
                        if let Err(e) = store.save_session(
                            &task_agent_id_for_save,
                            &session_id.to_string(),
                            &task_command_for_save,
                            &task_cwd_for_save.to_string_lossy(),
                        ) {
                            warn!(error = %e, "Failed to save ACP session");
                        }
                    }

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
                                        // Serialize as snake_case matching ACP wire format
                                        // (e.g. "end_turn", "max_tokens", "refusal").
                                        let sr = serde_json::to_string(&response.stop_reason)
                                            .unwrap_or_else(|_| format!("{:?}", response.stop_reason))
                                            .trim_matches('"')
                                            .to_string();
                                        debug!(
                                            stop_reason = %sr,
                                            "ACP prompt completed"
                                        );
                                        *task_stop_reason.write() = Some(sr.clone());
                                        let _ = response_tx.send(Ok(()));

                                        // Auto-continue on max_tokens / max_turn_requests
                                        if task_auto_continue
                                            && (sr == "max_tokens" || sr == "max_turn_requests")
                                        {
                                            // Atomically increment only while under the limit
                                            // (compare_exchange_weak loop avoids the transient
                                            // inflated count of fetch_add + fetch_sub rollback).
                                            let mut permitted_count: Option<usize> = None;
                                            loop {
                                                let cur = task_continuation_count
                                                    .load(std::sync::atomic::Ordering::SeqCst);
                                                if cur >= task_max_auto_continues {
                                                    break;
                                                }
                                                if task_continuation_count
                                                    .compare_exchange_weak(
                                                        cur,
                                                        cur + 1,
                                                        std::sync::atomic::Ordering::SeqCst,
                                                        std::sync::atomic::Ordering::SeqCst,
                                                    )
                                                    .is_ok()
                                                {
                                                    permitted_count = Some(cur);
                                                    break;
                                                }
                                            }
                                            if let Some(count) = permitted_count {
                                                info!(
                                                    continuation = count + 1,
                                                    max = task_max_auto_continues,
                                                    stop_reason = %sr,
                                                    "Auto-continuing prompt"
                                                );
                                                let (cont_tx, cont_rx) = oneshot::channel();
                                                let _ = task_command_tx
                                                    .send(AcpCommand::Prompt {
                                                        message: "Please continue your unfinished work.".to_string(),
                                                        response_tx: cont_tx,
                                                    })
                                                    .await;
                                                // Fire-and-forget: the continuation response
                                                // is consumed by the command loop.
                                                tokio::spawn(async move {
                                                    let _ = cont_rx.await;
                                                });
                                            } else {
                                                warn!(
                                                    count = task_continuation_count
                                                        .load(std::sync::atomic::Ordering::SeqCst),
                                                    max = task_max_auto_continues,
                                                    "Auto-continue limit reached"
                                                );
                                            }
                                        }
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
                            Some(AcpCommand::Cancel { response_tx }) => {
                                debug!("ACP connection task received cancel command");
                                let result = connection
                                    .send_notification(agent_client_protocol::schema::v1::CancelNotification::new(
                                        session_id.clone(),
                                    ));
                                match result {
                                    Ok(()) => {
                                        info!("Sent session/cancel notification");
                                        let _ = response_tx.send(Ok(()));
                                    }
                                    Err(e) => {
                                        warn!(error = %e, "Failed to send session/cancel");
                                        let _ = response_tx.send(Err(ErgataiError::internal(
                                            format!("Failed to cancel: {e}"),
                                        )));
                                    }
                                }
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

            // Set exit code based on connection task result.
            let code = if result.is_ok() { 0 } else { 1 };
            *task_exit_code.write() = Some(code);

            if let Err(e) = result {
                error!(error = %e, exit_code = code, "ACP connection task failed");
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

        // Register SystemToken for watchdog heartbeat monitoring.
        // This enables automatic lock reclamation if the agent crashes.
        if let Some(ref sid) = session_id {
            // Clone cwd for SystemToken registration (cwd was moved into the async block)
            let cwd_for_token = handle
                .metadata
                .get("work_dir")
                .map(PathBuf::from)
                .unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| PathBuf::from("/")));

            if let Err(e) = register_system_token_for_acp_session(
                &agent_id,
                &sid.to_string(),
                &cwd_for_token.to_string_lossy(),
            ).await {
                warn!(
                    agent_id = %agent_id,
                    session_id = %sid,
                    error = %e,
                    "Failed to register SystemToken for ACP session (non-fatal)"
                );
            } else {
                info!(
                    agent_id = %agent_id,
                    session_id = %sid,
                    "Registered SystemToken for ACP session watchdog monitoring"
                );
            }
        }

        // Build the agent entry.
        let entry = AcpAgentEntry {
            command_tx,
            output,
            thoughts,
            tool_calls,
            usage,
            plan,
            elicitations,
            session_title,
            stop_reason,
            continuation_count,
            config_options,
            available_commands,
            last_output_at,
            alive: alive.clone(),
            handle: AgentHandle {
                workspace: handle.clone(),
                agent_id: agent_id.clone(),
                // Note: process_id is None because ACP SDK's connect_with() doesn't expose
                // the child process PID. This limits file lock attribution via fanotify.
                // File lock enforcement relies on LD_PRELOAD injection instead.
                // TODO: Request ACP SDK to expose PID, or use spawn_process() directly.
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
            exit_code,
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
            Err(ErgataiError::NotFound(format!(
                "Agent not found: {}",
                handle.agent_id
            )))
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
                    debug!(
                        agent_id = %handle.agent_id,
                        "Agent already removed (idempotent stop)"
                    );
                    return Ok(());
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
                entry
                    .alive
                    .store(false, std::sync::atomic::Ordering::SeqCst);
            }
        }
        self.remove_agent(&handle.agent_id);

        // Remove the saved session — explicit stop means the user doesn't want to resume.
        if let Some(store) = &self.session_store {
            if let Err(e) = store.remove_session(&handle.agent_id) {
                warn!(error = %e, agent_id = %handle.agent_id, "Failed to remove saved session");
            }
        }

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
                    debug!(
                        agent_id = %handle.agent_id,
                        "Agent already removed (idempotent kill)"
                    );
                    return Ok(());
                }
            }
        };

        // Force abort the connection task (which drops the ACP connection, killing the child).
        abort_handle.abort();

        // Mark as not alive and remove entry.
        {
            let agents = self.agents.read();
            if let Some(entry) = agents.get(&handle.agent_id) {
                entry
                    .alive
                    .store(false, std::sync::atomic::Ordering::SeqCst);
            }
        }
        self.remove_agent(&handle.agent_id);

        // Remove the saved session — explicit kill means the user doesn't want to resume.
        if let Some(store) = &self.session_store {
            if let Err(e) = store.remove_session(&handle.agent_id) {
                warn!(error = %e, agent_id = %handle.agent_id, "Failed to remove saved session");
            }
        }

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
                // Read the exit code from the agent entry.
                let code = {
                    let agents = self.agents.read();
                    agents
                        .get(&handle.agent_id)
                        .and_then(|entry| *entry.exit_code.read())
                        .unwrap_or(0) // Default to 0 if entry is gone (already reaped)
                };
                return Ok(WaitResult::Exited { code });
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
            capture_thoughts: false,
        };
        let handle = backend.create_workspace(spec).await.unwrap();
        assert_eq!(handle.id, "ws-test-1");
        assert_eq!(handle.backend, "acp");
    }
}
