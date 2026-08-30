//! PtyBackend — direct PTY-based agent execution environment.
//!
//! Agents run as child processes with dedicated PTYs, messages are injected
//! via direct `write()` to the PTY master fd, and output is captured via
//! background reader tasks that maintain a rolling buffer.
//!
//! # Advantages
//!
//! - No external binary dependencies
//! - Direct fd-level control (lower latency)
//! - Precise output capture (raw bytes before terminal rendering)
//! - Simpler process lifecycle (waitpid)
//!
//! # Limitations
//!
//! - No cross-process agent discovery (PTY agents are internal child processes
//!   of this backend instance; `discover_agents()` returns only agents started
//!   by this instance, filtered to those still alive)
//! - No terminal multiplexing (each agent is a separate process)

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use parking_lot::RwLock;
use tokio::sync::Mutex as TokioMutex;
use tokio::task::JoinHandle;
use tracing::{debug, info, warn};
use uuid::Uuid;

use ergatai_error::{ErgataiError, ErgataiResult};
use ergatai_pty::{PtyConfig, PtyProcess};

use crate::backend::AgentRuntimeBackend;
use crate::cgroups::CgroupController;
use crate::types::{AgentHandle, BackendCapabilities, WaitResult, WorkspaceHandle, WorkspaceSpec};

// ── Configuration constants ──

/// Default terminal rows.
const DEFAULT_ROWS: u16 = 50;

/// Default terminal columns.
const DEFAULT_COLS: u16 = 200;

/// Delay before injecting instructions after agent start.
const INSTRUCTION_DELAY: Duration = Duration::from_secs(2);

/// Output buffer max size (256 KiB).
const OUTPUT_BUFFER_MAX_SIZE: usize = 256 * 1024;

/// Grace period for graceful stop (SIGTERM → wait → SIGKILL).
const STOP_GRACE_PERIOD: Duration = Duration::from_secs(5);

/// Poll interval for wait_for_exit.
const EXIT_POLL_INTERVAL: Duration = Duration::from_millis(200);

// ── Internal types ──

/// Per-agent output buffer: bounded rolling buffer of captured PTY output.
struct OutputBuffer {
    /// Raw bytes captured from PTY stdout.
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

    /// Snapshot current buffer contents as cleaned text (ANSI stripped).
    fn capture_clean(&self) -> String {
        let data = self.data.read();
        ergatai_pty::ansi::strip_ansi(&data)
    }
}

/// Tracks a running agent's PTY process and associated resources.
struct AgentEntry {
    process: Arc<PtyProcess>,
    output: Arc<OutputBuffer>,
    #[allow(dead_code)]
    workspace_id: String,
    reader_handle: JoinHandle<()>,
    /// Flag to pause the background reader when WebSocket terminal is connected.
    /// When true, the background reader skips reading (leaves data for WebSocket reader).
    reader_paused: Arc<std::sync::atomic::AtomicBool>,
    exit_code: Arc<TokioMutex<Option<i32>>>,
    /// Path to the instruction temp file, if one was written for this agent.
    /// Cleaned up on drop to avoid leaking files in /tmp.
    instr_path: Option<String>,
    /// The AgentHandle returned from start_agent. Stored so that
    /// discover_agents() can return it for registry integration.
    handle: AgentHandle,
}

impl Drop for AgentEntry {
    fn drop(&mut self) {
        self.reader_handle.abort();
        if let Some(path) = &self.instr_path {
            let _ = std::fs::remove_file(path);
        }
    }
}

/// Logical workspace (no physical resources, just metadata).
struct WorkspaceEntry {
    id: String,
    work_dir: PathBuf,
    env: HashMap<String, String>,
    agent_pids: Vec<String>,
    /// Cgroup controller for resource limits (CPU/memory).
    /// None if cgroups v2 is unavailable or no limits were specified.
    cgroup_controller: Option<CgroupController>,
    /// Counter for generating stable agent IDs within this workspace.
    /// Each agent gets stable_id: agent-{counter}
    agent_counter: u32,
}

// ── PtyBackend ──

/// Direct PTY-based agent execution backend.
///
/// Each workspace is a logical container (directory + env). Each agent is a
/// child process with its own PTY. Messages are injected via `write()` to the
/// PTY master fd, and output is captured via background reader tasks.
pub struct PtyBackend {
    /// Agent entries keyed by PID string.
    agents: RwLock<HashMap<String, AgentEntry>>,
    /// Workspace entries keyed by workspace ID.
    workspaces: RwLock<HashMap<String, WorkspaceEntry>>,
    /// Default terminal rows.
    rows: u16,
    /// Default terminal columns.
    cols: u16,
}

impl PtyBackend {
    /// Create a new PtyBackend with default terminal dimensions.
    pub fn new() -> Self {
        Self {
            agents: RwLock::new(HashMap::new()),
            workspaces: RwLock::new(HashMap::new()),
            rows: DEFAULT_ROWS,
            cols: DEFAULT_COLS,
        }
    }

    /// Create with custom terminal dimensions.
    pub fn with_dimensions(mut self, rows: u16, cols: u16) -> Self {
        self.rows = rows;
        self.cols = cols;
        self
    }

    /// Check health of all tracked agent processes.
    ///
    /// Called by `AgentRuntime::prune_unhealthy_agents()` via downcast.
    #[cfg(target_os = "linux")]
    pub async fn health_check_agents(
        &self,
    ) -> Vec<(String, crate::backends::proc_linux::ProcessState)> {
        use crate::backends::proc_linux::read_proc_state;

        let agents = self.agents.read();
        let mut results = Vec::new();

        for pid_str in agents.keys() {
            let pid: u32 = match pid_str.parse() {
                Ok(p) => p,
                Err(_) => continue,
            };

            let state =
                read_proc_state(pid).unwrap_or(crate::backends::proc_linux::ProcessState::Unknown);
            results.push((pid_str.clone(), state));
        }

        results
    }

    /// Health check is Linux-specific (uses /proc/{pid}/stat).
    /// On non-Linux platforms, return empty — no agents to prune.
    #[cfg(not(target_os = "linux"))]
    pub async fn health_check_agents(
        &self,
    ) -> Vec<(String, crate::backends::proc_linux::ProcessState)> {
        Vec::new()
    }

    /// Remove agent entry and abort its reader task.
    fn remove_agent(&self, pid_str: &str) {
        let mut agents = self.agents.write();
        // Drop triggers AgentEntry::drop, which aborts the reader and cleans
        // up the instruction temp file.
        agents.remove(pid_str);
    }
}

impl Default for PtyBackend {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl AgentRuntimeBackend for PtyBackend {
    fn name(&self) -> &'static str {
        "pty"
    }

    fn as_any(&self) -> &dyn std::any::Any {
        self
    }

    fn capabilities(&self) -> BackendCapabilities {
        BackendCapabilities {
            supports_message_injection: true, // write() to PTY stdin
            supports_output_capture: true,    // background reader buffer
            supports_resource_limits: cfg!(target_os = "linux"), // cgroups v2
            supports_workspace_reuse: true,   // logical workspaces
            supports_network_isolation: false,
            max_concurrent_agents: None,
        }
    }

    async fn initialize(&self) -> ErgataiResult<()> {
        // No external dependencies to check — PTY is built into the OS.
        info!("PtyBackend initialized (no external dependencies)");
        Ok(())
    }

    async fn create_workspace(&self, spec: WorkspaceSpec) -> ErgataiResult<WorkspaceHandle> {
        let mut metadata = HashMap::new();
        metadata.insert(
            "work_dir".to_string(),
            spec.work_dir.to_string_lossy().to_string(),
        );

        // Create cgroup controller if resource limits are specified
        let cgroup_controller =
            if spec.resources.cpu_cores.is_some() || spec.resources.memory_mb.is_some() {
                let controller = CgroupController::create(
                    &spec.id,
                    spec.resources.cpu_cores,
                    spec.resources.memory_mb,
                );
                if controller.is_active() {
                    metadata.insert(
                        "cgroup".to_string(),
                        controller.path().to_string_lossy().to_string(),
                    );
                }
                Some(controller)
            } else {
                None
            };

        let entry = WorkspaceEntry {
            id: spec.id.clone(),
            work_dir: spec.work_dir,
            env: spec.env.clone(),
            agent_pids: Vec::new(),
            cgroup_controller,
            agent_counter: 0,
        };

        self.workspaces.write().insert(spec.id.clone(), entry);

        info!(workspace_id = %spec.id, "PTY workspace created (logical)");

        Ok(WorkspaceHandle {
            id: spec.id,
            backend: "pty".to_string(),
            metadata,
        })
    }

    async fn start_agent(
        &self,
        handle: &WorkspaceHandle,
        command: &str,
        instruction: Option<&str>,
    ) -> ErgataiResult<AgentHandle> {
        // 1. Look up workspace
        let (work_dir, env) = {
            let workspaces = self.workspaces.read();
            let ws = workspaces.get(&handle.id).ok_or_else(|| {
                ErgataiError::internal(format!("Unknown workspace: {}", handle.id))
            })?;
            (ws.work_dir.clone(), ws.env.clone())
        };

        // 2. Parse command into program + args
        let mut parts = command.split_whitespace();
        let program = parts
            .next()
            .ok_or_else(|| ErgataiError::internal("Empty command".to_string()))?;
        let args: Vec<String> = parts.map(String::from).collect();

        // 3. Build PtyConfig with cwd/env
        let mut env = env.clone();

        // Inject LD_PRELOAD for transparent snapshot reads if the library exists.
        // This allows the ergatai-preload library to intercept open() calls and
        // redirect reads of locked files to Git snapshots.
        #[cfg(target_os = "linux")]
        {
            let preload_paths = [
                // Release build path
                work_dir.join("target/release/libergatai_preload.so"),
                // Debug build path
                work_dir.join("target/debug/libergatai_preload.so"),
                // Workspace root (for monorepo setups)
                work_dir.join("../../target/release/libergatai_preload.so"),
                work_dir.join("../../target/debug/libergatai_preload.so"),
            ];

            for path in &preload_paths {
                if path.exists() {
                    let path_str = path.to_string_lossy().to_string();
                    // Append to existing LD_PRELOAD if set.
                    let existing = env.get("LD_PRELOAD").cloned().unwrap_or_default();
                    let new_value = if existing.is_empty() {
                        path_str
                    } else {
                        format!("{}:{}", existing, path_str)
                    };
                    env.insert("LD_PRELOAD".to_string(), new_value);
                    info!(
                        preload_path = %path.display(),
                        "Injected LD_PRELOAD for snapshot-based reads"
                    );
                    break;
                }
            }
        }

        let config = PtyConfig {
            command: program.to_string(),
            args,
            rows: self.rows,
            cols: self.cols,
            cwd: Some(work_dir),
            env,
        };

        // 4. Spawn PTY process
        let process = PtyProcess::spawn(config)
            .map_err(|e| ErgataiError::internal(format!("Failed to spawn PTY process: {}", e)))?;
        let pid = process.pid();
        let pid_str = pid.to_string();

        // 4b. Add process to cgroup (if resource limits are configured)
        {
            let workspaces = self.workspaces.read();
            if let Some(ws) = workspaces.get(&handle.id) {
                if let Some(ref cgroup) = ws.cgroup_controller {
                    if let Err(e) = cgroup.add_process(pid.as_raw()) {
                        warn!(
                            pid = %pid_str,
                            error = %e,
                            "Failed to add agent to cgroup — resource limits may not apply"
                        );
                    }
                }
            }
        }

        let process = Arc::new(process);

        // 5. Create output buffer + background reader
        let output = Arc::new(OutputBuffer::new(OUTPUT_BUFFER_MAX_SIZE));
        let exit_code = Arc::new(TokioMutex::new(None));
        let reader_paused = Arc::new(std::sync::atomic::AtomicBool::new(false));

        let reader_process = process.clone();
        let reader_output = output.clone();
        let reader_exit_code = exit_code.clone();
        let reader_pid = pid_str.clone();
        let reader_paused_clone = reader_paused.clone();
        let reader_handle = tokio::spawn(async move {
            let mut buf = [0u8; 4096];
            loop {
                // Check if background reader is paused (WebSocket terminal connected)
                if reader_paused_clone.load(std::sync::atomic::Ordering::Relaxed) {
                    tokio::time::sleep(Duration::from_millis(100)).await;
                    continue;
                }

                // Check if process has exited
                if reader_process.has_exited().await {
                    // Drain remaining output
                    match tokio::time::timeout(
                        Duration::from_millis(100),
                        reader_process.read(&mut buf),
                    )
                    .await
                    {
                        Ok(Ok(n)) if n > 0 => {
                            reader_output.append(&buf[..n]);
                            reader_process.touch_output();
                        }
                        _ => {}
                    }
                    // Record exit code
                    let code = reader_process.wait().await.unwrap_or(-1);
                    *reader_exit_code.lock().await = Some(code);

                    // Send terminal reset sequence to restore PTY slave state.
                    // TUI apps (crossterm/ratatui) enable raw mode, mouse tracking,
                    // and alternate screen buffer. If the process dies without
                    // restoring these, the terminal stays corrupted.
                    // \x1b[!p = soft reset, \x1b[?1000l = disable mouse tracking,
                    // \x1b[?1049l = exit alternate screen, \x1b[?25h = show cursor
                    let _ = reader_process
                        .write(b"\x1b[!p\x1b[?1000l\x1b[?1049l\x1b[?25h")
                        .await;

                    break;
                }

                // Non-blocking read with short timeout
                match tokio::time::timeout(
                    Duration::from_millis(100),
                    reader_process.read(&mut buf),
                )
                .await
                {
                    Ok(Ok(n)) if n > 0 => {
                        reader_output.append(&buf[..n]);
                        reader_process.touch_output();
                    }
                    Ok(Ok(_)) => {
                        // 0 bytes — EOF, process likely exited
                        tokio::time::sleep(Duration::from_millis(50)).await;
                    }
                    Ok(Err(e)) => {
                        debug!(pid = %reader_pid, error = %e, "PTY read error");
                        break;
                    }
                    Err(_) => {
                        // Timeout — no data available, loop and check exit
                    }
                }
            }
        });

        // 6. Inject instruction if provided
        let mut instr_path: Option<String> = None;
        if let Some(instr) = instruction {
            tokio::time::sleep(INSTRUCTION_DELAY).await;

            // Write instruction to temp file (preserves formatting)
            let path = format!(
                "/tmp/ergatai-pty-instr-{}-{}.md",
                std::process::id(),
                pid_str
            );
            {
                use std::io::Write;
                use std::os::unix::fs::OpenOptionsExt;
                let write_path = path.clone();
                let content: String = instr.to_owned();
                tokio::task::spawn_blocking(move || {
                    let mut f = std::fs::OpenOptions::new()
                        .create_new(true)
                        .write(true)
                        .mode(0o600)
                        .open(&write_path)?;
                    f.write_all(content.as_bytes())?;
                    Ok::<_, std::io::Error>(())
                })
                .await
                .map_err(|e| ErgataiError::internal(format!("spawn_blocking: {e}")))?
                .map_err(|e| {
                    ErgataiError::internal(format!("Failed to write instruction file: {e}"))
                })?;
            }

            // Send prompt referencing the file
            let prompt = format!(
                "Read and follow the instructions in {} — then complete the assigned task.\r\n",
                path
            );
            process.write(prompt.as_bytes()).await.map_err(|e| {
                ErgataiError::internal(format!("Failed to write instruction prompt: {}", e))
            })?;

            info!(
                pid = %pid_str,
                instr_bytes = instr.len(),
                instr_path = %path,
                "Instruction injected via file reference"
            );
            instr_path = Some(path);
        }

        // 7. Build AgentHandle (before insertion, so it can be stored in AgentEntry
        //    and returned by discover_agents() for registry integration)
        //
        // Generate agent ID: {workspace_id}-{uuid_prefix}
        // UUID prefix (first 4 chars) provides unique, non-sequential identifier.
        // stable_id uses counter format: agent-{counter}
        let (agent_id, stable_id) = {
            let mut workspaces = self.workspaces.write();
            let ws = workspaces.get_mut(&handle.id).ok_or_else(|| {
                ErgataiError::internal(format!("Workspace disappeared: {}", handle.id))
            })?;
            ws.agent_counter += 1;
            let uuid_prefix = &Uuid::new_v4().simple().to_string()[..4];
            let agent_id = format!("{}-{}", handle.id, uuid_prefix);
            let stable_id = format!("agent-{}", ws.agent_counter);
            (agent_id, stable_id)
        };

        let mut metadata = HashMap::new();
        metadata.insert("ergatai_agent_id".to_string(), stable_id.clone());

        let agent_handle = AgentHandle {
            workspace: handle.clone(),
            agent_id: agent_id.clone(),
            process_id: Some(pid_str.clone()),
            metadata,
        };

        // 8. Register agent
        self.agents.write().insert(
            pid_str.clone(),
            AgentEntry {
                process: process.clone(),
                output: output.clone(),
                workspace_id: handle.id.clone(),
                reader_handle,
                reader_paused: reader_paused.clone(),
                exit_code: exit_code.clone(),
                instr_path,
                handle: agent_handle.clone(),
            },
        );

        // Add PID to workspace's agent list
        self.workspaces
            .write()
            .entry(handle.id.clone())
            .and_modify(|ws| ws.agent_pids.push(pid_str.clone()));

        info!(
            pid = %pid_str,
            agent_id = %agent_id,
            workspace = %handle.id,
            command = command,
            "Agent started in PTY"
        );

        Ok(agent_handle)
    }

    async fn inject_message(&self, handle: &AgentHandle, message: &str) -> ErgataiResult<()> {
        let pid_str = handle
            .process_id
            .as_ref()
            .ok_or_else(|| ErgataiError::internal("Missing PID in agent handle".to_string()))?;

        // Clone process Arc out of lock to avoid holding lock across await
        let process = {
            let agents = self.agents.read();
            let entry = agents
                .get(pid_str)
                .ok_or_else(|| ErgataiError::internal(format!("Unknown agent PID: {}", pid_str)))?;
            entry.process.clone()
        };

        // Check if process is still alive
        if process.has_exited().await {
            return Err(ErgataiError::internal(format!(
                "Cannot inject: agent {} has exited",
                pid_str
            )));
        }

        // Format message: pretty-print JSON if applicable, then add line ending
        let formatted_msg = format_message_for_pty(message);

        // Write message + carriage return + newline to PTY stdin
        // PTY terminals need \r\n (not just \n) to trigger "Enter" behavior
        let mut msg = formatted_msg;
        msg.push_str("\r\n");
        process
            .write(msg.as_bytes())
            .await
            .map_err(|e| ErgataiError::internal(format!("Failed to write to PTY stdin: {}", e)))?;

        debug!(pid = %pid_str, bytes = msg.len(), "Message injected");
        Ok(())
    }

    async fn capture_output(&self, handle: &AgentHandle) -> ErgataiResult<Option<String>> {
        let pid_str = handle
            .process_id
            .as_ref()
            .ok_or_else(|| ErgataiError::internal("Missing PID in agent handle".to_string()))?;

        let agents = self.agents.read();
        let entry = agents
            .get(pid_str)
            .ok_or_else(|| ErgataiError::internal(format!("Unknown agent PID: {}", pid_str)))?;

        let text = entry.output.capture_clean();
        if text.is_empty() {
            Ok(None)
        } else {
            Ok(Some(text))
        }
    }

    async fn is_alive(&self, handle: &AgentHandle) -> ErgataiResult<bool> {
        let pid_str = handle
            .process_id
            .as_ref()
            .ok_or_else(|| ErgataiError::internal("Missing PID in agent handle".to_string()))?;

        // Clone process Arc out of lock to avoid holding lock across await
        let process = {
            let agents = self.agents.read();
            match agents.get(pid_str) {
                Some(entry) => entry.process.clone(),
                None => return Ok(false),
            }
        };
        Ok(!process.has_exited().await)
    }

    async fn stop_agent(&self, handle: &AgentHandle) -> ErgataiResult<()> {
        let pid_str = handle
            .process_id
            .as_ref()
            .ok_or_else(|| ErgataiError::internal("Missing PID in agent handle".to_string()))?;

        // Clone process Arc out of lock to avoid holding lock across await
        let process = {
            let agents = self.agents.read();
            match agents.get(pid_str) {
                Some(entry) => entry.process.clone(),
                None => return Ok(()), // Already gone
            }
        };

        info!(pid = %pid_str, "Sending SIGTERM to agent process group");

        // Send SIGTERM to entire process group (not just child PID)
        // This kills grandchildren too — otherwise they become orphans.
        process
            .signal_group(nix::sys::signal::Signal::SIGTERM)
            .map_err(|e| {
                ErgataiError::internal(format!("Failed to send SIGTERM to process group: {}", e))
            })?;

        // Wait for grace period
        let deadline = tokio::time::Instant::now() + STOP_GRACE_PERIOD;
        while tokio::time::Instant::now() < deadline {
            if process.has_exited().await {
                info!(pid = %pid_str, "Agent exited after SIGTERM");
                // Reset terminal state
                let _ = process
                    .write(b"\x1b[!p\x1b[?1000l\x1b[?1049l\x1b[?25h")
                    .await;
                return Ok(());
            }
            tokio::time::sleep(Duration::from_millis(200)).await;
        }

        // Escalate to SIGKILL for entire process group
        warn!(pid = %pid_str, "Agent process group did not exit within grace period, sending SIGKILL");
        let _ = process.signal_group(nix::sys::signal::Signal::SIGKILL);
        // Reset terminal state after SIGKILL (process can't do it itself)
        let _ = process
            .write(b"\x1b[!p\x1b[?1000l\x1b[?1049l\x1b[?25h")
            .await;

        Ok(())
    }

    async fn kill_agent(&self, handle: &AgentHandle) -> ErgataiResult<()> {
        let pid_str = handle
            .process_id
            .as_ref()
            .ok_or_else(|| ErgataiError::internal("Missing PID in agent handle".to_string()))?;

        // Clone process Arc out of lock to avoid holding lock across await
        let process = {
            let agents = self.agents.read();
            agents.get(pid_str).map(|e| e.process.clone())
        };

        if let Some(process) = process {
            warn!(pid = %pid_str, "Force-killing agent process group (SIGKILL)");

            // Send terminal reset before killing — TUI apps leave the PTY in
            // raw mode with mouse tracking enabled. Without reset, the parent
            // terminal shows garbage on mouse movement.
            let _ = process
                .write(b"\x1b[!p\x1b[?1000l\x1b[?1049l\x1b[?25h")
                .await;

            // Kill entire process group (child + grandchildren)
            let _ = process.signal_group(nix::sys::signal::Signal::SIGKILL);
        }

        Ok(())
    }

    async fn wait_for_exit(
        &self,
        handle: &AgentHandle,
        timeout: Option<Duration>,
    ) -> ErgataiResult<WaitResult> {
        let pid_str = handle
            .process_id
            .as_ref()
            .ok_or_else(|| ErgataiError::internal("Missing PID in agent handle".to_string()))?;

        let start = tokio::time::Instant::now();

        loop {
            // Clone Arcs out of lock to avoid holding lock across await
            let (process, exit_code_slot) = {
                let agents = self.agents.read();
                match agents.get(pid_str) {
                    Some(entry) => (entry.process.clone(), entry.exit_code.clone()),
                    None => return Ok(WaitResult::Exited { code: -1 }), // Already cleaned up
                }
            };

            if process.has_exited().await {
                let code = *exit_code_slot.lock().await;
                match code {
                    Some(c) => return Ok(exit_code_to_wait_result(c)),
                    None => {
                        // Exit code not yet recorded by reader, wait for it
                        tokio::time::sleep(Duration::from_millis(50)).await;
                        continue;
                    }
                }
            }

            if let Some(timeout_dur) = timeout {
                if start.elapsed() > timeout_dur {
                    return Ok(WaitResult::Timeout);
                }
            }

            tokio::time::sleep(EXIT_POLL_INTERVAL).await;
        }
    }

    async fn list_workspaces(&self) -> ErgataiResult<Vec<WorkspaceHandle>> {
        let workspaces = self.workspaces.read();
        Ok(workspaces
            .values()
            .map(|ws| {
                let mut metadata = HashMap::new();
                metadata.insert(
                    "work_dir".to_string(),
                    ws.work_dir.to_string_lossy().to_string(),
                );
                WorkspaceHandle {
                    id: ws.id.clone(),
                    backend: "pty".to_string(),
                    metadata,
                }
            })
            .collect())
    }

    async fn cleanup_workspace(&self, handle: &WorkspaceHandle) -> ErgataiResult<()> {
        // Kill all agents in this workspace
        let agent_pids: Vec<String> = {
            let workspaces = self.workspaces.read();
            workspaces
                .get(&handle.id)
                .map(|ws| ws.agent_pids.clone())
                .unwrap_or_default()
        };

        for pid_str in &agent_pids {
            let agents = self.agents.read();
            if let Some(entry) = agents.get(pid_str) {
                // Use signal_group to kill entire process tree (child + grandchildren)
                let _ = entry
                    .process
                    .signal_group(nix::sys::signal::Signal::SIGKILL);
            }
        }

        // Remove agents from map (also aborts reader tasks)
        for pid_str in &agent_pids {
            self.remove_agent(pid_str);
        }

        // Remove workspace (CgroupController::drop will clean up the cgroup directory)
        self.workspaces.write().remove(&handle.id);

        info!(
            workspace_id = %handle.id,
            agents_killed = agent_pids.len(),
            "Workspace cleaned up"
        );

        Ok(())
    }

    async fn shutdown(&self) -> ErgataiResult<()> {
        let workspace_ids: Vec<String> = self.workspaces.read().keys().cloned().collect();

        for ws_id in &workspace_ids {
            let handle = WorkspaceHandle {
                id: ws_id.clone(),
                backend: "pty".to_string(),
                metadata: HashMap::new(),
            };
            if let Err(e) = self.cleanup_workspace(&handle).await {
                warn!(workspace_id = %ws_id, error = %e, "Failed to cleanup workspace during shutdown");
            }
        }

        info!(count = workspace_ids.len(), "PtyBackend shutdown complete");
        Ok(())
    }

    async fn discover_agents(&self) -> ErgataiResult<Vec<(String, AgentHandle)>> {
        // Snapshot (pid, handle, process) triples out of the lock so we can
        // await on each process without holding the RwLock.
        let snapshot: Vec<(String, AgentHandle, Arc<PtyProcess>)> = {
            let agents = self.agents.read();
            agents
                .iter()
                .map(|(pid, entry)| (pid.clone(), entry.handle.clone(), entry.process.clone()))
                .collect()
        };

        let mut result = Vec::with_capacity(snapshot.len());
        for (pid_str, handle, process) in snapshot {
            // Skip exited agents — they're no longer discoverable.
            // The entry itself is kept until stop_agent/remove_agent so that
            // wait_for_exit can still harvest the exit code.
            if process.has_exited().await {
                debug!(pid = %pid_str, agent_id = %handle.agent_id, "Skipping exited agent during discovery");
                continue;
            }
            result.push((handle.agent_id.clone(), handle));
        }

        debug!(count = result.len(), "PtyBackend discover_agents");
        Ok(result)
    }

    async fn get_pty_process(
        &self,
        handle: &AgentHandle,
    ) -> ErgataiResult<Option<Arc<PtyProcess>>> {
        let pid_str = handle
            .process_id
            .as_ref()
            .ok_or_else(|| ErgataiError::internal("Agent has no process_id"))?;

        let agents = self.agents.read();
        let entry = agents
            .get(pid_str)
            .ok_or_else(|| ErgataiError::internal(format!("Agent {} not found", pid_str)))?;

        // Pause the background reader so it doesn't compete with the WebSocket reader
        entry
            .reader_paused
            .store(true, std::sync::atomic::Ordering::Relaxed);
        debug!(pid = %pid_str, "Paused background PTY reader for WebSocket terminal");

        Ok(Some(entry.process.clone()))
    }

    async fn resize_pty(&self, handle: &AgentHandle, rows: u16, cols: u16) -> ErgataiResult<()> {
        let pid_str = handle
            .process_id
            .as_ref()
            .ok_or_else(|| ErgataiError::internal("Agent has no process_id"))?;

        // Clone process Arc out of lock to avoid holding lock across await
        let process = {
            let agents = self.agents.read();
            let entry = agents
                .get(pid_str)
                .ok_or_else(|| ErgataiError::internal(format!("Agent {} not found", pid_str)))?;
            entry.process.clone()
        };

        process
            .resize(rows, cols)
            .await
            .map_err(|e| ErgataiError::internal(format!("Failed to resize PTY: {}", e)))
    }

    async fn resume_pty_reader(&self, handle: &AgentHandle) -> ErgataiResult<()> {
        let pid_str = handle
            .process_id
            .as_ref()
            .ok_or_else(|| ErgataiError::internal("Agent has no process_id"))?;

        let agents = self.agents.read();
        if let Some(entry) = agents.get(pid_str) {
            entry
                .reader_paused
                .store(false, std::sync::atomic::Ordering::Relaxed);
            debug!(pid = %pid_str, "Resumed background PTY reader after WebSocket disconnect");
        }

        Ok(())
    }

    fn last_output_age(&self, handle: &AgentHandle) -> Option<Duration> {
        let pid_str = handle.process_id.as_ref()?;
        let agents = self.agents.read();
        agents.get(pid_str).map(|e| e.process.last_output_age())
    }
}

/// Convert a shell exit code to a `WaitResult`.
fn exit_code_to_wait_result(code: i32) -> WaitResult {
    if code > 128 {
        WaitResult::Signaled { signal: code - 128 }
    } else {
        WaitResult::Exited { code }
    }
}

/// Format a message for PTY injection.
///
/// If the message is valid JSON, pretty-print it with 2-space indentation
/// for better readability in the terminal. Otherwise, return as-is.
fn format_message_for_pty(message: &str) -> String {
    // Try to parse as JSON and pretty-print
    if let Ok(json_value) = serde_json::from_str::<serde_json::Value>(message) {
        if let Ok(pretty) = serde_json::to_string_pretty(&json_value) {
            return pretty;
        }
    }
    // Not JSON or formatting failed, return original
    message.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_backend_name() {
        let backend = PtyBackend::new();
        assert_eq!(backend.name(), "pty");
    }

    #[test]
    fn test_capabilities() {
        let backend = PtyBackend::new();
        let caps = backend.capabilities();
        assert!(caps.supports_message_injection);
        assert!(caps.supports_output_capture);
        assert!(caps.supports_workspace_reuse);
        // Resource limits are supported on Linux (cgroups v2) when available
        assert_eq!(caps.supports_resource_limits, cfg!(target_os = "linux"));
    }

    #[test]
    fn test_as_any_downcast() {
        let backend = PtyBackend::new();
        let trait_obj: &dyn AgentRuntimeBackend = &backend;
        let downcast = trait_obj.as_any().downcast_ref::<PtyBackend>();
        assert!(downcast.is_some());
    }

    #[test]
    fn test_output_buffer_append_and_eviction() {
        let buffer = OutputBuffer::new(100);
        let chunk = vec![b'a'; 60];
        buffer.append(&chunk);
        assert_eq!(buffer.data.read().len(), 60);

        let chunk2 = vec![b'b'; 60];
        buffer.append(&chunk2);
        // Should evict oldest 20 bytes to stay at 100
        assert_eq!(buffer.data.read().len(), 100);
        // First 40 bytes should be 'a', rest should be 'b'
        let data = buffer.data.read();
        assert!(data[..40].iter().all(|&b| b == b'a'));
        assert!(data[40..].iter().all(|&b| b == b'b'));
    }

    #[test]
    fn test_output_buffer_capture_clean() {
        let buffer = OutputBuffer::new(1024);
        // Include ANSI color codes
        buffer.append(b"\x1b[32mHello\x1b[0m World");
        let clean = buffer.capture_clean();
        assert_eq!(clean, "Hello World");
    }

    #[test]
    fn test_exit_code_to_wait_result() {
        assert!(matches!(
            exit_code_to_wait_result(0),
            WaitResult::Exited { code: 0 }
        ));
        assert!(matches!(
            exit_code_to_wait_result(1),
            WaitResult::Exited { code: 1 }
        ));
        assert!(matches!(
            exit_code_to_wait_result(143),
            WaitResult::Signaled { signal: 15 }
        ));
        assert!(matches!(
            exit_code_to_wait_result(137),
            WaitResult::Signaled { signal: 9 }
        ));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn test_discover_agents_returns_started_agent() {
        let backend = PtyBackend::new();
        backend.initialize().await.unwrap();

        // Create a workspace with a real (temporary) working directory
        let tmp = tempfile::tempdir().unwrap();
        let ws_spec = WorkspaceSpec {
            id: "test-ws".to_string(),
            work_dir: tmp.path().to_path_buf(),
            env: HashMap::new(),
            resources: crate::types::ResourceLimits::default(),
        };
        let ws_handle = backend.create_workspace(ws_spec).await.unwrap();

        // Initially, discover_agents should return nothing
        let discovered = backend.discover_agents().await.unwrap();
        assert!(
            discovered.is_empty(),
            "should be empty before any agent starts"
        );

        // Start an agent with a harmless long-running command
        let agent_handle = backend
            .start_agent(&ws_handle, "sleep 60", None)
            .await
            .unwrap();

        // Give the reader task a moment to start
        tokio::time::sleep(Duration::from_millis(100)).await;

        // discover_agents should now return the started agent
        let discovered = backend.discover_agents().await.unwrap();
        assert_eq!(discovered.len(), 1);
        let (agent_id, handle) = &discovered[0];
        assert_eq!(*agent_id, agent_handle.agent_id);
        assert_eq!(handle.process_id, agent_handle.process_id);
        assert_eq!(handle.workspace.id, ws_handle.id);

        // Stop the agent
        backend.stop_agent(&agent_handle).await.unwrap();

        // Give the reader task time to observe the exit and record the exit
        // code. (Skipped wait_for_exit deliberately: it has a separate
        // race-condition issue with the exit_code_slot being populated by the
        // reader task — out of scope for the discover_agents test.)
        tokio::time::sleep(Duration::from_secs(1)).await;

        let discovered = backend.discover_agents().await.unwrap();
        assert!(
            discovered.is_empty(),
            "exited agents should not appear in discovery"
        );

        // Clean up
        backend.cleanup_workspace(&ws_handle).await.unwrap();
    }

    #[test]
    fn test_format_message_for_pty_json() {
        // JSON should be pretty-printed
        let json = r#"{"name":"test","value":123}"#;
        let formatted = format_message_for_pty(json);
        assert!(formatted.contains('\n'));
        assert!(formatted.contains("  \"name\""));
        assert!(formatted.contains("  \"value\""));
    }

    #[test]
    fn test_format_message_for_pty_plain_text() {
        // Plain text should be returned as-is
        let text = "Hello, world!";
        let formatted = format_message_for_pty(text);
        assert_eq!(formatted, text);
    }

    #[test]
    fn test_format_message_for_pty_invalid_json() {
        // Invalid JSON should be returned as-is
        let invalid = "{not valid json}";
        let formatted = format_message_for_pty(invalid);
        assert_eq!(formatted, invalid);
    }
}
