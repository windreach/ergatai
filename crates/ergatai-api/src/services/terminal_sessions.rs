//! Backend-owned workspace terminal sessions.
//!
//! Terminal transports share one executor boundary. Interactive shells use a
//! Unix PTY; pipes remain available for non-TTY diagnostics and future
//! non-interactive command execution without conflating this domain with ACP.

use std::collections::{HashMap, VecDeque};
use std::env;
use std::fs::File;
use std::os::fd::{AsRawFd, FromRawFd};
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::{SystemTime, UNIX_EPOCH};

use async_trait::async_trait;
use ergatai_core::id::{format as format_id, generate, IdType};
use serde::{Deserialize, Serialize};
use tokio::fs::File as AsyncFile;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::process::{Child, ChildStderr, ChildStdin, ChildStdout};
use tokio::sync::{broadcast, Mutex};
use utoipa::ToSchema;

use crate::user_data_db::terminal_sessions::{
    self as terminal_session_store, TerminalSessionRecord,
};

const REPLAY_MAX_BYTES: usize = 256 * 1024;
const AUDIT_MAX_EVENTS: usize = 1_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum TerminalTransport {
    Pty,
    Pipes,
}

fn default_transport() -> TerminalTransport {
    TerminalTransport::Pty
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum TerminalSessionStatus {
    Starting,
    Running,
    Exited,
    Failed,
    Terminated,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum TerminalProfile {
    WorkspaceShell,
    AgentObservation,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct TerminalSession {
    pub session_id: String,
    pub workspace_id: String,
    pub user_id: String,
    pub profile: TerminalProfile,
    pub transport: TerminalTransport,
    pub status: TerminalSessionStatus,
    pub cwd: String,
    pub pid: Option<u32>,
    pub exit_code: Option<i32>,
    pub agent_session_id: Option<String>,
    pub last_sequence: u64,
    pub recoverable: bool,
    pub created_at_ms: u64,
    pub updated_at_ms: u64,
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct CreateTerminalSessionRequest {
    pub workspace_id: String,
    pub profile: TerminalProfile,
    #[serde(default = "default_transport")]
    pub transport: TerminalTransport,
    #[serde(default)]
    pub cwd: Option<String>,
    #[serde(default = "default_user_id")]
    pub user_id: String,
    #[serde(default)]
    pub agent_session_id: Option<String>,
}

fn default_user_id() -> String {
    "local".to_string()
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct TerminalInputRequest {
    pub data: String,
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct TerminalSignalRequest {
    /// POSIX signal name without the SIG prefix, e.g. `INT`, `TERM`, `KILL`.
    pub signal: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum TerminalAuditAction {
    Create,
    Input,
    Resize,
    Signal,
    Exit,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum TerminalAuditOutcome {
    Allowed,
    Rejected,
    Failed,
    Completed,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct TerminalAuditEvent {
    pub sequence: u64,
    pub timestamp_ms: u64,
    pub session_id: Option<String>,
    pub workspace_id: Option<String>,
    pub user_id: Option<String>,
    pub action: TerminalAuditAction,
    pub outcome: TerminalAuditOutcome,
    pub signal: Option<String>,
    pub input_bytes: Option<usize>,
    pub profile: Option<TerminalProfile>,
    pub transport: Option<TerminalTransport>,
    pub agent_session_id: Option<String>,
    pub cols: Option<u16>,
    pub rows: Option<u16>,
    pub exit_code: Option<i32>,
    pub reason: Option<String>,
}

fn audit_event(action: TerminalAuditAction, outcome: TerminalAuditOutcome) -> TerminalAuditEvent {
    TerminalAuditEvent {
        sequence: 0,
        timestamp_ms: 0,
        session_id: None,
        workspace_id: None,
        user_id: None,
        action,
        outcome,
        signal: None,
        input_bytes: None,
        profile: None,
        transport: None,
        agent_session_id: None,
        cols: None,
        rows: None,
        exit_code: None,
        reason: None,
    }
}

fn audit_session_metadata(event: &mut TerminalAuditEvent, metadata: &TerminalSession) {
    event.session_id = Some(metadata.session_id.clone());
    event.workspace_id = Some(metadata.workspace_id.clone());
    event.user_id = Some(metadata.user_id.clone());
    event.profile = Some(metadata.profile);
    event.transport = Some(metadata.transport);
    event.agent_session_id = metadata.agent_session_id.clone();
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum TerminalStreamEvent {
    Data { sequence: u64, data: String },
    Exit { sequence: u64, exit_code: i32 },
}

impl TerminalStreamEvent {
    fn stream_sequence(&self) -> u64 {
        match self {
            Self::Data { sequence, .. } | Self::Exit { sequence, .. } => *sequence,
        }
    }

    fn serialized_size(&self) -> usize {
        serde_json::to_vec(self).map_or(0, |bytes| bytes.len())
    }
}

#[derive(Debug)]
struct TerminalReplayBuffer {
    next_sequence: u64,
    events: VecDeque<TerminalStreamEvent>,
    bytes: usize,
}

impl TerminalReplayBuffer {
    fn new() -> Self {
        Self {
            next_sequence: 1,
            events: VecDeque::new(),
            bytes: 0,
        }
    }

    fn push(&mut self, mut event: TerminalStreamEvent) {
        match &mut event {
            TerminalStreamEvent::Data { sequence, .. }
            | TerminalStreamEvent::Exit { sequence, .. } => *sequence = self.next_sequence,
        }
        self.next_sequence += 1;

        let event_bytes = event.serialized_size();
        while self.bytes + event_bytes > REPLAY_MAX_BYTES {
            match self.events.pop_front() {
                Some(removed) => self.bytes -= removed.serialized_size(),
                None => break,
            }
        }

        self.bytes += event_bytes;
        self.events.push_back(event);
    }

    fn replay_after(
        &self,
        after: Option<u64>,
    ) -> Result<(Vec<TerminalStreamEvent>, bool), TerminalSessionError> {
        let Some(after) = after else {
            return Ok((self.events.iter().cloned().collect(), false));
        };

        if after >= self.next_sequence {
            return Err(TerminalSessionError::Validation(
                "Terminal stream cursor is ahead of the session".into(),
            ));
        }

        let contiguous = self
            .events
            .front()
            .is_none_or(|oldest| oldest.stream_sequence() <= after.saturating_add(1));
        if contiguous {
            Ok((
                self.events
                    .iter()
                    .filter(|event| event.stream_sequence() > after)
                    .cloned()
                    .collect(),
                false,
            ))
        } else {
            Ok((self.events.iter().cloned().collect(), true))
        }
    }
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct TerminalResizeRequest {
    pub cols: u16,
    pub rows: u16,
}

struct TerminalProcess {
    metadata: TerminalSession,
    executor: Box<dyn TerminalExecutor>,
    events: broadcast::Sender<TerminalStreamEvent>,
    replay: TerminalReplayBuffer,
}

struct SpawnedTerminal {
    child: Child,
    executor: Box<dyn TerminalExecutor>,
    output: Option<AsyncFile>,
    stdout: Option<ChildStdout>,
    stderr: Option<ChildStderr>,
}

#[async_trait]
trait TerminalExecutor: Send {
    async fn write_input(&mut self, data: &[u8]) -> Result<(), std::io::Error>;
    async fn resize(&mut self, cols: u16, rows: u16) -> Result<(), std::io::Error>;
}

struct PipesExecutor {
    stdin: ChildStdin,
}

#[async_trait]
impl TerminalExecutor for PipesExecutor {
    async fn write_input(&mut self, data: &[u8]) -> Result<(), std::io::Error> {
        self.stdin.write_all(data).await?;
        self.stdin.flush().await
    }

    async fn resize(&mut self, _cols: u16, _rows: u16) -> Result<(), std::io::Error> {
        Err(std::io::Error::other("Resize requires the pty transport"))
    }
}

struct PtyExecutor {
    writer: AsyncFile,
}

#[async_trait]
impl TerminalExecutor for PtyExecutor {
    async fn write_input(&mut self, data: &[u8]) -> Result<(), std::io::Error> {
        self.writer.write_all(data).await?;
        self.writer.flush().await
    }

    async fn resize(&mut self, cols: u16, rows: u16) -> Result<(), std::io::Error> {
        set_pty_size(self.writer.as_raw_fd(), cols, rows)
    }
}

fn set_pty_size(fd: i32, cols: u16, rows: u16) -> Result<(), std::io::Error> {
    let window_size = libc::winsize {
        ws_col: cols,
        ws_row: rows,
        ws_xpixel: 0,
        ws_ypixel: 0,
    };

    if unsafe { libc::ioctl(fd, libc::TIOCSWINSZ, &window_size) } == -1 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(())
}

fn open_pty(cols: u16, rows: u16) -> Result<(File, File), std::io::Error> {
    let mut master_fd = -1;
    let mut slave_fd = -1;
    let window_size = libc::winsize {
        ws_col: cols,
        ws_row: rows,
        ws_xpixel: 0,
        ws_ypixel: 0,
    };

    if unsafe {
        libc::openpty(
            &mut master_fd,
            &mut slave_fd,
            std::ptr::null_mut(),
            std::ptr::null(),
            &window_size,
        )
    } != 0
    {
        return Err(std::io::Error::last_os_error());
    }

    let flags = unsafe { libc::fcntl(master_fd, libc::F_GETFD) };
    if flags == -1
        || unsafe { libc::fcntl(master_fd, libc::F_SETFD, flags | libc::FD_CLOEXEC) } == -1
    {
        let error = std::io::Error::last_os_error();
        // Close file descriptors to avoid resource leak
        unsafe {
            libc::close(master_fd);
            libc::close(slave_fd);
        }
        return Err(error);
    }

    Ok((unsafe { File::from_raw_fd(master_fd) }, unsafe {
        File::from_raw_fd(slave_fd)
    }))
}
static SESSIONS: OnceLock<Mutex<HashMap<String, TerminalProcess>>> = OnceLock::new();
static AUDIT_LOG: OnceLock<Mutex<VecDeque<TerminalAuditEvent>>> = OnceLock::new();

fn sessions() -> &'static Mutex<HashMap<String, TerminalProcess>> {
    SESSIONS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn audit_log() -> &'static Mutex<VecDeque<TerminalAuditEvent>> {
    AUDIT_LOG.get_or_init(|| Mutex::new(VecDeque::new()))
}

fn unix_timestamp_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |duration| duration.as_millis() as u64)
}

fn push_audit_event(log: &mut VecDeque<TerminalAuditEvent>, mut event: TerminalAuditEvent) -> u64 {
    event.sequence = log.back().map_or(1, |event| event.sequence + 1);
    event.timestamp_ms = unix_timestamp_ms();

    while log.len() >= AUDIT_MAX_EVENTS {
        log.pop_front();
    }
    let sequence = event.sequence;
    log.push_back(event);
    sequence
}

async fn record_audit(event: TerminalAuditEvent) {
    let mut log = audit_log().lock().await;
    push_audit_event(&mut log, event);
}

pub async fn list_audit(session_id: &str) -> Result<Vec<TerminalAuditEvent>, TerminalSessionError> {
    get_session(session_id).await?;
    let log = audit_log().lock().await;
    Ok(log
        .iter()
        .filter(|event| event.session_id.as_deref() == Some(session_id))
        .cloned()
        .collect())
}

#[derive(Debug)]
pub enum TerminalSessionError {
    WorkspaceNotFound,
    Validation(String),
    Forbidden(String),
    NotFound,
    ProcessFailed(String),
}

fn user_has_workspace_access(user_id: &str, metadata: &HashMap<String, String>) -> bool {
    if user_id == "local" {
        return true;
    }

    let is_owner = metadata
        .get("owner_id")
        .is_some_and(|owner_id| owner_id == user_id);
    let is_allowed = metadata.get("allowed_users").is_some_and(|allowed_users| {
        allowed_users
            .split(',')
            .map(str::trim)
            .any(|allowed_user_id| allowed_user_id == user_id)
    });

    is_owner || is_allowed
}

fn profile_command(profile: TerminalProfile) -> (&'static str, &'static [&'static str]) {
    match profile {
        TerminalProfile::WorkspaceShell | TerminalProfile::AgentObservation => {
            ("/bin/bash", &["--noprofile", "--norc", "-i"])
        }
    }
}

async fn workspace_root(
    workspace_id: &str,
    user_id: &str,
) -> Result<PathBuf, TerminalSessionError> {
    let runtime = crate::context::get_app_context().agent_runtime.clone();
    let workspaces = runtime
        .backend()
        .list_workspaces()
        .await
        .map_err(|error| TerminalSessionError::ProcessFailed(error.to_string()))?;

    let workspace = workspaces
        .into_iter()
        .find(|workspace| workspace.id == workspace_id)
        .ok_or(TerminalSessionError::WorkspaceNotFound)?;

    if !user_has_workspace_access(user_id, &workspace.metadata) {
        return Err(TerminalSessionError::Forbidden(
            "User does not have access to workspace".into(),
        ));
    }

    let raw_root = workspace
        .metadata
        .get("work_dir")
        .ok_or_else(|| TerminalSessionError::Validation("Workspace has no work_dir".into()))?;
    let root = crate::validate_cwd(raw_root).map_err(TerminalSessionError::Validation)?;
    Ok(root)
}

fn path_contains(root: &Path, candidate: &Path) -> bool {
    candidate.starts_with(root)
}

fn publish(process: &mut TerminalProcess, event: TerminalStreamEvent) {
    process.replay.push(event.clone());
    process.metadata.last_sequence = process.replay.next_sequence.saturating_sub(1);
    let _ = process.events.send(event);
}

fn profile_name(profile: TerminalProfile) -> &'static str {
    match profile {
        TerminalProfile::WorkspaceShell => "workspace_shell",
        TerminalProfile::AgentObservation => "agent_observation",
    }
}

fn transport_name(transport: TerminalTransport) -> &'static str {
    match transport {
        TerminalTransport::Pty => "pty",
        TerminalTransport::Pipes => "pipes",
    }
}

fn status_name(status: TerminalSessionStatus) -> &'static str {
    match status {
        TerminalSessionStatus::Starting => "starting",
        TerminalSessionStatus::Running => "running",
        TerminalSessionStatus::Exited => "exited",
        TerminalSessionStatus::Failed => "failed",
        TerminalSessionStatus::Terminated => "terminated",
    }
}

fn metadata_to_record(metadata: &TerminalSession) -> TerminalSessionRecord {
    TerminalSessionRecord {
        session_id: metadata.session_id.clone(),
        workspace_id: metadata.workspace_id.clone(),
        user_id: metadata.user_id.clone(),
        profile: profile_name(metadata.profile).to_string(),
        transport: transport_name(metadata.transport).to_string(),
        status: status_name(metadata.status).to_string(),
        cwd: metadata.cwd.clone(),
        pid: metadata.pid.map(i64::from),
        exit_code: metadata.exit_code,
        agent_session_id: metadata.agent_session_id.clone(),
        last_sequence: metadata.last_sequence as i64,
        recoverable: metadata.recoverable,
        created_at_ms: metadata.created_at_ms as i64,
        updated_at_ms: metadata.updated_at_ms as i64,
    }
}

fn persist_metadata(metadata: &TerminalSession) {
    if let Err(error) = terminal_session_store::upsert(&metadata_to_record(metadata)) {
        tracing::warn!(
            session_id = %metadata.session_id,
            error = %error,
            "Failed to persist terminal session metadata"
        );
    }
}

fn record_to_metadata(
    record: terminal_session_store::TerminalSessionRecord,
) -> Result<TerminalSession, TerminalSessionError> {
    let profile = match record.profile.as_str() {
        "workspace_shell" => TerminalProfile::WorkspaceShell,
        "agent_observation" => TerminalProfile::AgentObservation,
        _ => {
            return Err(TerminalSessionError::ProcessFailed(
                "Unknown terminal profile".into(),
            ))
        }
    };
    let transport = match record.transport.as_str() {
        "pty" => TerminalTransport::Pty,
        "pipes" => TerminalTransport::Pipes,
        _ => {
            return Err(TerminalSessionError::ProcessFailed(
                "Unknown terminal transport".into(),
            ))
        }
    };
    let status = match record.status.as_str() {
        "starting" => TerminalSessionStatus::Starting,
        "running" => TerminalSessionStatus::Running,
        "exited" => TerminalSessionStatus::Exited,
        "failed" => TerminalSessionStatus::Failed,
        "terminated" => TerminalSessionStatus::Terminated,
        _ => {
            return Err(TerminalSessionError::ProcessFailed(
                "Unknown terminal status".into(),
            ))
        }
    };

    Ok(TerminalSession {
        session_id: record.session_id,
        workspace_id: record.workspace_id,
        user_id: record.user_id,
        profile,
        transport,
        status,
        cwd: record.cwd,
        pid: record.pid.map(|pid| pid as u32),
        exit_code: record.exit_code,
        agent_session_id: record.agent_session_id,
        last_sequence: record.last_sequence.max(0) as u64,
        recoverable: record.recoverable,
        created_at_ms: record.created_at_ms.max(0) as u64,
        updated_at_ms: record.updated_at_ms.max(0) as u64,
    })
}

fn signal_from_name(name: &str) -> Option<nix::sys::signal::Signal> {
    let normalized = name.trim().trim_start_matches("SIG").to_ascii_uppercase();
    format!("SIG{normalized}")
        .parse::<nix::sys::signal::Signal>()
        .ok()
}

fn is_safe_environment_variable(name: &str) -> bool {
    const SAFE_VARIABLES: [&str; 8] = [
        "PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "TZ", "TMPDIR",
    ];

    SAFE_VARIABLES.contains(&name) || name.starts_with("LC_")
}

fn sanitized_environment(
    variables: impl IntoIterator<Item = (String, String)>,
) -> HashMap<String, String> {
    let mut environment: HashMap<String, String> = variables
        .into_iter()
        .filter(|(name, _)| is_safe_environment_variable(name))
        .collect();
    environment.insert("TERM".to_string(), "xterm-256color".to_string());
    environment
}

fn configure_sanitized_environment(command: &mut tokio::process::Command) {
    let environment = sanitized_environment(env::vars());
    command.env_clear();
    command.envs(environment);
}

fn spawn_terminal(
    mut command: tokio::process::Command,
    transport: TerminalTransport,
) -> Result<SpawnedTerminal, TerminalSessionError> {
    match transport {
        TerminalTransport::Pty => {
            let (master, slave) = open_pty(80, 24)
                .map_err(|error| TerminalSessionError::ProcessFailed(error.to_string()))?;
            let controlling_tty = slave
                .try_clone()
                .map_err(|error| TerminalSessionError::ProcessFailed(error.to_string()))?;

            unsafe {
                command.as_std_mut().pre_exec(move || {
                    if libc::setsid() == -1 {
                        return Err(std::io::Error::last_os_error());
                    }
                    if libc::ioctl(controlling_tty.as_raw_fd(), libc::TIOCSCTTY, 0) == -1 {
                        return Err(std::io::Error::last_os_error());
                    }
                    Ok(())
                });
            }

            command
                .stdin(std::process::Stdio::from(slave.try_clone().map_err(
                    |error| TerminalSessionError::ProcessFailed(error.to_string()),
                )?))
                .stdout(std::process::Stdio::from(slave.try_clone().map_err(
                    |error| TerminalSessionError::ProcessFailed(error.to_string()),
                )?))
                .stderr(std::process::Stdio::from(slave));

            let mut child = command
                .spawn()
                .map_err(|error| TerminalSessionError::ProcessFailed(error.to_string()))?;
            let master_reader = match master.try_clone() {
                Ok(reader) => reader,
                Err(error) => {
                    // Kill the child to prevent orphan process leak.
                    // start_kill() sends SIGKILL synchronously; the background
                    // supervisor task will reap the zombie.
                    let _ = child.start_kill();
                    return Err(TerminalSessionError::ProcessFailed(error.to_string()));
                }
            };
            let master_writer = master;

            Ok(SpawnedTerminal {
                child,
                executor: Box::new(PtyExecutor {
                    writer: AsyncFile::from_std(master_writer),
                }),
                output: Some(AsyncFile::from_std(master_reader)),
                stdout: None,
                stderr: None,
            })
        }
        TerminalTransport::Pipes => {
            command
                .stdin(std::process::Stdio::piped())
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::piped());

            let mut child = command
                .spawn()
                .map_err(|error| TerminalSessionError::ProcessFailed(error.to_string()))?;
            let stdin = child
                .stdin
                .take()
                .ok_or_else(|| TerminalSessionError::ProcessFailed("stdin unavailable".into()))?;
            let stdout = child
                .stdout
                .take()
                .ok_or_else(|| TerminalSessionError::ProcessFailed("stdout unavailable".into()))?;
            let stderr = child
                .stderr
                .take()
                .ok_or_else(|| TerminalSessionError::ProcessFailed("stderr unavailable".into()))?;

            Ok(SpawnedTerminal {
                child,
                executor: Box::new(PipesExecutor { stdin }),
                output: None,
                stdout: Some(stdout),
                stderr: Some(stderr),
            })
        }
    }
}

pub async fn create_session(
    request: CreateTerminalSessionRequest,
) -> Result<TerminalSession, TerminalSessionError> {
    let workspace_id = request.workspace_id.clone();
    let user_id = request.user_id.clone();
    let profile = request.profile;
    let transport = request.transport;
    let agent_session_id = request.agent_session_id.clone();
    let result = create_session_inner(request).await;

    let mut event = audit_event(
        TerminalAuditAction::Create,
        match &result {
            Ok(_) => TerminalAuditOutcome::Allowed,
            Err(TerminalSessionError::ProcessFailed(_)) => TerminalAuditOutcome::Failed,
            Err(_) => TerminalAuditOutcome::Rejected,
        },
    );
    event.workspace_id = Some(workspace_id);
    event.user_id = Some(user_id);
    event.profile = Some(profile);
    event.transport = Some(transport);
    event.agent_session_id = agent_session_id;
    if let Ok(metadata) = &result {
        event.session_id = Some(metadata.session_id.clone());
    }
    if result.is_err() {
        event.reason = Some("Terminal session request rejected or failed".into());
    }
    record_audit(event).await;
    result
}

async fn create_session_inner(
    request: CreateTerminalSessionRequest,
) -> Result<TerminalSession, TerminalSessionError> {
    if request.workspace_id.trim().is_empty() {
        return Err(TerminalSessionError::Validation(
            "workspace_id is required".into(),
        ));
    }
    if request.user_id.trim().is_empty() {
        return Err(TerminalSessionError::Validation(
            "user_id is required".into(),
        ));
    }
    if request.profile != TerminalProfile::WorkspaceShell {
        if request.profile != TerminalProfile::AgentObservation {
            return Err(TerminalSessionError::Validation(
                "Only workspace_shell and agent_observation profiles are approved".into(),
            ));
        }
        if request.transport != TerminalTransport::Pty {
            return Err(TerminalSessionError::Validation(
                "agent_observation requires the pty transport".into(),
            ));
        }
        if request
            .agent_session_id
            .as_deref()
            .is_none_or(|agent_session_id| agent_session_id.trim().is_empty())
        {
            return Err(TerminalSessionError::Validation(
                "agent_observation requires an agent_session_id".into(),
            ));
        }
    } else if request.agent_session_id.is_some() {
        return Err(TerminalSessionError::Validation(
            "agent_session_id is only valid for agent_observation".into(),
        ));
    }

    let root = workspace_root(&request.workspace_id, &request.user_id).await?;
    let cwd = match request.cwd.as_deref().map(str::trim) {
        Some("") | None => root.clone(),
        Some(raw) => {
            let candidate = crate::validate_cwd(raw).map_err(TerminalSessionError::Validation)?;
            if !path_contains(&root, &candidate) {
                return Err(TerminalSessionError::Validation(
                    "cwd must remain inside the workspace".into(),
                ));
            }
            candidate
        }
    };

    let (shell, args) = profile_command(request.profile);
    let mut command = tokio::process::Command::new(shell);
    configure_sanitized_environment(&mut command);
    command.args(args).current_dir(&cwd).kill_on_drop(false);

    let transport = request.transport;
    let spawned = spawn_terminal(command, transport)?;
    let child = spawned.child;
    let executor = spawned.executor;
    let output = spawned.output;
    let stdout = spawned.stdout;
    let stderr = spawned.stderr;
    let pid = child.id();

    let session_id = format_id(generate(), IdType::Session);
    let metadata = TerminalSession {
        session_id: session_id.clone(),
        workspace_id: request.workspace_id,
        user_id: request.user_id,
        profile: request.profile,
        transport,
        status: TerminalSessionStatus::Running,
        cwd: cwd.to_string_lossy().into_owned(),
        pid,
        exit_code: None,
        agent_session_id: request.agent_session_id,
        last_sequence: 0,
        recoverable: true,
        created_at_ms: unix_timestamp_ms(),
        updated_at_ms: unix_timestamp_ms(),
    };
    let (events, _) = broadcast::channel(1024);

    {
        let mut processes = sessions().lock().await;
        processes.insert(
            session_id.clone(),
            TerminalProcess {
                metadata: metadata.clone(),
                executor,
                events: events.clone(),
                replay: TerminalReplayBuffer::new(),
            },
        );
    }
    persist_metadata(&metadata);

    if let Some(mut output) = output {
        let session_id = session_id.clone();
        tokio::spawn(async move {
            let mut buffer = [0_u8; 8192];
            loop {
                match output.read(&mut buffer).await {
                    Ok(0) | Err(_) => break,
                    Ok(size) => append_output(&session_id, &buffer[..size]).await,
                }
            }
        });
    }
    if let Some(mut stdout) = stdout {
        let session_id = session_id.clone();
        tokio::spawn(async move {
            let mut buffer = [0_u8; 8192];
            loop {
                match stdout.read(&mut buffer).await {
                    Ok(0) | Err(_) => break,
                    Ok(size) => append_output(&session_id, &buffer[..size]).await,
                }
            }
        });
    }
    if let Some(mut stderr) = stderr {
        let session_id = session_id.clone();
        tokio::spawn(async move {
            let mut buffer = [0_u8; 8192];
            loop {
                match stderr.read(&mut buffer).await {
                    Ok(0) | Err(_) => break,
                    Ok(size) => append_output(&session_id, &buffer[..size]).await,
                }
            }
        });
    }

    let exit_session_id = session_id.clone();
    tokio::spawn(async move {
        let mut child: Child = child;
        let exit_code = match child.wait().await {
            Ok(status) => status.code().unwrap_or(-1),
            Err(_) => -1,
        };
        finish_session(&exit_session_id, exit_code).await;
    });

    Ok(metadata)
}

async fn with_process<T>(
    session_id: &str,
    operation: impl FnOnce(&mut TerminalProcess) -> T,
) -> Result<T, TerminalSessionError> {
    let mut processes = sessions().lock().await;
    let process = processes
        .get_mut(session_id)
        .ok_or(TerminalSessionError::NotFound)?;
    Ok(operation(process))
}

async fn append_output(session_id: &str, bytes: &[u8]) {
    let data = String::from_utf8_lossy(bytes).into_owned();
    let _ = with_process(session_id, |process| {
        publish(process, TerminalStreamEvent::Data { sequence: 0, data });
    })
    .await;
}

async fn finish_session(session_id: &str, code: i32) {
    let metadata = with_process(session_id, |process| {
        process.metadata.status = if code == 0 {
            TerminalSessionStatus::Exited
        } else {
            TerminalSessionStatus::Failed
        };
        process.metadata.exit_code = Some(code);
        process.metadata.recoverable = false;
        // Clear PID to prevent signaling a reused PID after the process exits
        process.metadata.pid = None;
        process.metadata.updated_at_ms = unix_timestamp_ms();
        publish(
            process,
            TerminalStreamEvent::Exit {
                sequence: 0,
                exit_code: code,
            },
        );
        process.metadata.clone()
    })
    .await;
    if let Ok(metadata) = metadata {
        persist_metadata(&metadata);
        let mut event = audit_event(
            TerminalAuditAction::Exit,
            if code == 0 {
                TerminalAuditOutcome::Completed
            } else {
                TerminalAuditOutcome::Failed
            },
        );
        audit_session_metadata(&mut event, &metadata);
        event.exit_code = Some(code);
        record_audit(event).await;
    }

    // Remove the session from the in-memory map after a delay to prevent memory leak.
    // The metadata is persisted to the database, so clients can still query it via list_sessions.
    // The 5-minute delay allows clients to read the final output and exit status.
    let sid = session_id.to_string();
    tokio::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_secs(300)).await;
        let mut processes = sessions().lock().await;
        processes.remove(&sid);
    });
}

pub async fn get_session(session_id: &str) -> Result<TerminalSession, TerminalSessionError> {
    with_process(session_id, |process| process.metadata.clone()).await
}

pub async fn list_sessions(
    workspace_id: &str,
    user_id: &str,
) -> Result<Vec<TerminalSession>, TerminalSessionError> {
    if workspace_id.trim().is_empty() {
        return Err(TerminalSessionError::Validation(
            "workspace_id is required".into(),
        ));
    }
    if user_id.trim().is_empty() {
        return Err(TerminalSessionError::Validation(
            "user_id is required".into(),
        ));
    }

    workspace_root(workspace_id, user_id).await?;
    let live_sessions: Vec<TerminalSession> = {
        let processes = sessions().lock().await;
        processes
            .values()
            .filter(|process| {
                process.metadata.workspace_id == workspace_id && process.metadata.user_id == user_id
            })
            .map(|process| process.metadata.clone())
            .collect()
    };
    let records = terminal_session_store::list(workspace_id, user_id)
        .map_err(|error| TerminalSessionError::ProcessFailed(error.to_string()))?;

    let mut sessions = Vec::with_capacity(records.len());
    let mut pending_live = live_sessions;
    for record in records {
        if let Some(index) = pending_live
            .iter()
            .position(|metadata| metadata.session_id == record.session_id)
        {
            let metadata = pending_live.remove(index);
            persist_metadata(&metadata);
            sessions.push(metadata);
            continue;
        }

        if record.status == "starting" || record.status == "running" {
            let mut metadata = record_to_metadata(record)?;
            metadata.status = TerminalSessionStatus::Failed;
            metadata.exit_code = Some(-1);
            metadata.recoverable = false;
            metadata.updated_at_ms = unix_timestamp_ms();
            persist_metadata(&metadata);
            sessions.push(metadata);
        } else {
            sessions.push(record_to_metadata(record)?);
        }
    }
    for metadata in pending_live {
        persist_metadata(&metadata);
        sessions.push(metadata);
    }

    sessions.sort_by_key(|metadata| std::cmp::Reverse(metadata.created_at_ms));
    Ok(sessions)
}

pub async fn write_input(
    session_id: &str,
    request: TerminalInputRequest,
) -> Result<(), TerminalSessionError> {
    let metadata = match get_session(session_id).await {
        Ok(metadata) => metadata,
        Err(error) => {
            let mut event = audit_event(TerminalAuditAction::Input, TerminalAuditOutcome::Rejected);
            event.session_id = Some(session_id.to_string());
            event.reason = Some("Terminal session not found".into());
            record_audit(event).await;
            return Err(error);
        }
    };
    let input_bytes = request.data.len();
    let result = {
        let mut processes = sessions().lock().await;
        let process = processes
            .get_mut(session_id)
            .ok_or(TerminalSessionError::NotFound)?;
        process.executor.write_input(request.data.as_bytes()).await
    };
    let mut event = audit_event(
        TerminalAuditAction::Input,
        if result.is_ok() {
            TerminalAuditOutcome::Allowed
        } else {
            TerminalAuditOutcome::Failed
        },
    );
    audit_session_metadata(&mut event, &metadata);
    event.input_bytes = Some(input_bytes);
    if result.is_err() {
        event.reason = Some("Terminal input write failed".into());
    }
    record_audit(event).await;
    result.map_err(|error| TerminalSessionError::ProcessFailed(error.to_string()))
}

pub async fn resize_session(
    session_id: &str,
    request: TerminalResizeRequest,
) -> Result<(), TerminalSessionError> {
    let metadata = match get_session(session_id).await {
        Ok(metadata) => metadata,
        Err(error) => {
            let mut event =
                audit_event(TerminalAuditAction::Resize, TerminalAuditOutcome::Rejected);
            event.session_id = Some(session_id.to_string());
            event.reason = Some("Terminal session not found".into());
            record_audit(event).await;
            return Err(error);
        }
    };
    if request.cols == 0 || request.rows == 0 {
        let mut event = audit_event(TerminalAuditAction::Resize, TerminalAuditOutcome::Rejected);
        audit_session_metadata(&mut event, &metadata);
        event.cols = Some(request.cols);
        event.rows = Some(request.rows);
        event.reason = Some("Terminal dimensions must be greater than zero".into());
        record_audit(event).await;
        return Err(TerminalSessionError::Validation(
            "Terminal dimensions must be greater than zero".into(),
        ));
    }

    let result = {
        let mut processes = sessions().lock().await;
        let process = processes
            .get_mut(session_id)
            .ok_or(TerminalSessionError::NotFound)?;
        process.executor.resize(request.cols, request.rows).await
    };
    let mut event = audit_event(
        TerminalAuditAction::Resize,
        if result.is_ok() {
            TerminalAuditOutcome::Allowed
        } else {
            TerminalAuditOutcome::Failed
        },
    );
    audit_session_metadata(&mut event, &metadata);
    event.cols = Some(request.cols);
    event.rows = Some(request.rows);
    if result.is_err() {
        event.reason = Some("Terminal resize failed".into());
    }
    record_audit(event).await;
    result.map_err(|error| TerminalSessionError::ProcessFailed(error.to_string()))
}

pub async fn send_signal(
    session_id: &str,
    request: TerminalSignalRequest,
) -> Result<(), TerminalSessionError> {
    let metadata = match get_session(session_id).await {
        Ok(metadata) => metadata,
        Err(error) => {
            let mut event =
                audit_event(TerminalAuditAction::Signal, TerminalAuditOutcome::Rejected);
            event.session_id = Some(session_id.to_string());
            event.reason = Some("Terminal session not found".into());
            record_audit(event).await;
            return Err(error);
        }
    };
    let Some(signal) = signal_from_name(&request.signal) else {
        let mut event = audit_event(TerminalAuditAction::Signal, TerminalAuditOutcome::Rejected);
        audit_session_metadata(&mut event, &metadata);
        event.reason = Some("Unsupported signal".into());
        record_audit(event).await;
        return Err(TerminalSessionError::Validation(
            "Unsupported signal".into(),
        ));
    };
    let Some(pid) = metadata.pid else {
        let mut event = audit_event(TerminalAuditAction::Signal, TerminalAuditOutcome::Rejected);
        audit_session_metadata(&mut event, &metadata);
        event.reason = Some("Terminal process is unavailable".into());
        record_audit(event).await;
        return Err(TerminalSessionError::NotFound);
    };
    let result = nix::sys::signal::kill(nix::unistd::Pid::from_raw(pid as i32), signal);
    let mut event = audit_event(
        TerminalAuditAction::Signal,
        if result.is_ok() {
            TerminalAuditOutcome::Allowed
        } else {
            TerminalAuditOutcome::Failed
        },
    );
    audit_session_metadata(&mut event, &metadata);
    event.signal = Some(signal.to_string());
    if result.is_err() {
        event.reason = Some("Terminal signal failed".into());
    }
    record_audit(event).await;
    result.map_err(|error| TerminalSessionError::ProcessFailed(error.to_string()))
}

pub async fn terminate_session(session_id: &str) -> Result<TerminalSession, TerminalSessionError> {
    send_signal(
        session_id,
        TerminalSignalRequest {
            signal: "TERM".into(),
        },
    )
    .await?;

    // Poll until the child exits so callers see the final Exited/Failed/Terminated
    // status rather than the still-Running state the wait task has not yet observed.
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(5);
    loop {
        let metadata = get_session(session_id).await?;
        if matches!(
            metadata.status,
            TerminalSessionStatus::Exited
                | TerminalSessionStatus::Failed
                | TerminalSessionStatus::Terminated
        ) {
            return Ok(metadata);
        }
        if tokio::time::Instant::now() >= deadline {
            // Process didn't exit after SIGTERM — escalate to SIGKILL
            tracing::warn!(
                session_id = %session_id,
                "Process did not exit after SIGTERM, sending SIGKILL"
            );
            let _ = send_signal(
                session_id,
                TerminalSignalRequest {
                    signal: "KILL".into(),
                },
            )
            .await;

            // Wait briefly for SIGKILL to take effect
            let kill_deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(2);
            loop {
                let metadata = get_session(session_id).await?;
                if matches!(
                    metadata.status,
                    TerminalSessionStatus::Exited
                        | TerminalSessionStatus::Failed
                        | TerminalSessionStatus::Terminated
                ) {
                    return Ok(metadata);
                }
                if tokio::time::Instant::now() >= kill_deadline {
                    return Ok(metadata);
                }
                tokio::time::sleep(std::time::Duration::from_millis(50)).await;
            }
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
}

pub async fn subscribe(
    session_id: &str,
    after: Option<u64>,
) -> Result<TerminalStreamSubscription, TerminalSessionError> {
    let mut processes = sessions().lock().await;
    let process = processes
        .get_mut(session_id)
        .ok_or(TerminalSessionError::NotFound)?;
    let (events, reset) = process.replay.replay_after(after)?;
    Ok(TerminalStreamSubscription {
        events,
        reset,
        receiver: process.events.subscribe(),
    })
}

#[derive(Debug)]
pub struct TerminalStreamSubscription {
    pub events: Vec<TerminalStreamEvent>,
    pub reset: bool,
    pub receiver: broadcast::Receiver<TerminalStreamEvent>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn workspace_metadata(pairs: &[(&str, &str)]) -> HashMap<String, String> {
        pairs
            .iter()
            .map(|(key, value)| (key.to_string(), value.to_string()))
            .collect()
    }

    #[test]
    fn workspace_profile_resolves_to_bounded_shell_argv() {
        let (program, args) = profile_command(TerminalProfile::WorkspaceShell);
        assert_eq!(program, "/bin/bash");
        assert_eq!(args, &["--noprofile", "--norc", "-i"]);
    }

    #[test]
    fn profile_rejects_unknown_values_and_arbitrary_fields() {
        let valid = serde_json::from_value::<CreateTerminalSessionRequest>(json!({
            "workspace_id": "workspace",
            "profile": "workspace_shell"
        }));
        assert!(valid.is_ok());

        let unknown_profile = serde_json::from_value::<CreateTerminalSessionRequest>(json!({
            "workspace_id": "workspace",
            "profile": "arbitrary_command"
        }));
        assert!(unknown_profile.is_err());

        let arbitrary_command = serde_json::from_value::<CreateTerminalSessionRequest>(json!({
            "workspace_id": "workspace",
            "profile": "workspace_shell",
            "command": "echo pwned"
        }));
        assert!(arbitrary_command.is_err());
    }

    #[test]
    fn transport_defaults_to_pty_and_rejects_unknown_values() {
        let request = serde_json::from_value::<CreateTerminalSessionRequest>(json!({
            "workspace_id": "workspace",
            "profile": "workspace_shell"
        }))
        .unwrap();
        assert_eq!(request.transport, TerminalTransport::Pty);

        let pipes = serde_json::from_value::<CreateTerminalSessionRequest>(json!({
            "workspace_id": "workspace",
            "profile": "workspace_shell",
            "transport": "pipes"
        }))
        .unwrap();
        assert_eq!(pipes.transport, TerminalTransport::Pipes);

        let unknown = serde_json::from_value::<CreateTerminalSessionRequest>(json!({
            "workspace_id": "workspace",
            "profile": "workspace_shell",
            "transport": "arbitrary"
        }));
        assert!(unknown.is_err());
    }

    #[tokio::test]
    async fn agent_observation_requires_pty_and_agent_session_id() {
        let pipes = create_session_inner(CreateTerminalSessionRequest {
            workspace_id: "workspace".to_string(),
            profile: TerminalProfile::AgentObservation,
            transport: TerminalTransport::Pipes,
            cwd: None,
            user_id: "local".to_string(),
            agent_session_id: Some("agent-session".to_string()),
        })
        .await
        .unwrap_err();
        assert!(matches!(
            pipes,
            TerminalSessionError::Validation(message) if message.contains("pty")
        ));

        let missing_agent_session = create_session_inner(CreateTerminalSessionRequest {
            workspace_id: "workspace".to_string(),
            profile: TerminalProfile::AgentObservation,
            transport: TerminalTransport::Pty,
            cwd: None,
            user_id: "local".to_string(),
            agent_session_id: None,
        })
        .await
        .unwrap_err();
        assert!(matches!(
            missing_agent_session,
            TerminalSessionError::Validation(message) if message.contains("agent_session_id")
        ));
    }

    #[tokio::test]
    async fn workspace_shell_rejects_agent_session_id() {
        let result = create_session_inner(CreateTerminalSessionRequest {
            workspace_id: "workspace".to_string(),
            profile: TerminalProfile::WorkspaceShell,
            transport: TerminalTransport::Pty,
            cwd: None,
            user_id: "local".to_string(),
            agent_session_id: Some("agent-session".to_string()),
        })
        .await
        .unwrap_err();

        assert!(matches!(
            result,
            TerminalSessionError::Validation(message) if message.contains("agent_session_id")
        ));
    }

    #[test]
    fn terminal_metadata_round_trips_recovery_fields() {
        let metadata = TerminalSession {
            session_id: "session-1".to_string(),
            workspace_id: "workspace".to_string(),
            user_id: "local".to_string(),
            profile: TerminalProfile::AgentObservation,
            transport: TerminalTransport::Pty,
            status: TerminalSessionStatus::Running,
            cwd: "/tmp".to_string(),
            pid: Some(4321),
            exit_code: None,
            agent_session_id: Some("agent-session".to_string()),
            last_sequence: 18,
            recoverable: true,
            created_at_ms: 123,
            updated_at_ms: 456,
        };

        let restored = record_to_metadata(metadata_to_record(&metadata)).unwrap();
        assert_eq!(restored.session_id, metadata.session_id);
        assert_eq!(restored.profile, metadata.profile);
        assert_eq!(restored.transport, metadata.transport);
        assert_eq!(restored.status, metadata.status);
        assert_eq!(restored.agent_session_id, metadata.agent_session_id);
        assert_eq!(restored.last_sequence, metadata.last_sequence);
        assert_eq!(restored.recoverable, metadata.recoverable);
        assert_eq!(restored.created_at_ms, metadata.created_at_ms);
        assert_eq!(restored.updated_at_ms, metadata.updated_at_ms);
    }

    #[test]
    fn pty_resize_updates_kernel_window_size() {
        let (master, _slave) = open_pty(80, 24).unwrap();
        set_pty_size(master.as_raw_fd(), 101, 31).unwrap();

        let mut window_size = libc::winsize {
            ws_col: 0,
            ws_row: 0,
            ws_xpixel: 0,
            ws_ypixel: 0,
        };
        let result = unsafe { libc::ioctl(master.as_raw_fd(), libc::TIOCGWINSZ, &mut window_size) };
        assert_eq!(result, 0);
        assert_eq!(window_size.ws_col, 101);
        assert_eq!(window_size.ws_row, 31);
    }

    #[tokio::test]
    async fn pty_transport_writes_input_and_reports_exit() {
        let mut command = tokio::process::Command::new("/bin/bash");
        command.args([
            "--noprofile",
            "--norc",
            "-c",
            "read line; printf 'received:%s\\n' \"$line\"",
        ]);
        let mut spawned = spawn_terminal(command, TerminalTransport::Pty).unwrap();

        spawned.executor.write_input(b"hello\r").await.unwrap();
        let mut output = spawned.output.take().unwrap();
        let mut output_text = String::new();
        let mut buffer = [0_u8; 4096];
        loop {
            let size =
                tokio::time::timeout(std::time::Duration::from_secs(5), output.read(&mut buffer))
                    .await
                    .unwrap()
                    .unwrap();
            if size == 0 {
                break;
            }
            output_text.push_str(&String::from_utf8_lossy(&buffer[..size]));
            if output_text.contains("received:hello") {
                break;
            }
        }

        let status = spawned.child.wait().await.unwrap();
        assert!(status.success());
        assert!(
            output_text.contains("received:hello"),
            "output: {output_text}"
        );
    }

    #[tokio::test]
    async fn pty_transport_applies_signal_and_supervises_exit() {
        let mut command = tokio::process::Command::new("/bin/bash");
        command.args([
            "--noprofile",
            "--norc",
            "-c",
            "trap 'exit 7' TERM; echo READY; sleep 30",
        ]);
        let mut spawned = spawn_terminal(command, TerminalTransport::Pty).unwrap();
        let pid = spawned.child.id().unwrap();

        let mut output = spawned.output.take().unwrap();
        let mut output_text = String::new();
        let mut buffer = [0_u8; 4096];
        while !output_text.contains("READY") {
            let size =
                tokio::time::timeout(std::time::Duration::from_secs(5), output.read(&mut buffer))
                    .await
                    .unwrap()
                    .unwrap();
            assert_ne!(size, 0, "process exited before READY");
            output_text.push_str(&String::from_utf8_lossy(&buffer[..size]));
        }

        nix::sys::signal::kill(
            nix::unistd::Pid::from_raw(pid as i32),
            nix::sys::signal::Signal::SIGTERM,
        )
        .unwrap();
        let status = spawned.child.wait().await.unwrap();
        assert_eq!(status.code(), Some(7));
    }

    #[tokio::test]
    async fn pty_transport_allocates_controlling_terminal_and_resizes() {
        let mut command = tokio::process::Command::new("/bin/bash");
        command.args(["-c", "if [ -t 0 ]; then stty size; fi"]);
        let mut spawned = spawn_terminal(command, TerminalTransport::Pty).unwrap();

        spawned.executor.resize(101, 31).await.unwrap();

        // Drop the executor (and its master writer FD) so the master reader
        // can observe EOF/EIO after the child exits.
        drop(spawned.executor);

        let mut output = spawned.output.take().unwrap();
        let output_task = tokio::spawn(async move {
            let mut output_text = String::new();
            let mut buffer = [0_u8; 4096];
            loop {
                match tokio::time::timeout(
                    std::time::Duration::from_secs(5),
                    output.read(&mut buffer),
                )
                .await
                {
                    Ok(Ok(0)) => break, // EOF
                    Ok(Ok(size)) => {
                        output_text.push_str(&String::from_utf8_lossy(&buffer[..size]));
                    }
                    Ok(Err(error)) if error.raw_os_error() == Some(libc::EIO) => {
                        break; // PTY slave closed
                    }
                    Ok(Err(error)) => return Err(error),
                    Err(_) => break, // read timeout — child exited, no more output
                }
            }
            Ok::<String, std::io::Error>(output_text)
        });

        let status = spawned.child.wait().await.unwrap();
        let output_text = tokio::time::timeout(std::time::Duration::from_secs(10), output_task)
            .await
            .unwrap()
            .unwrap()
            .unwrap();

        assert!(status.success());
        assert!(output_text.contains("31 101"), "output: {output_text}");
    }

    #[tokio::test]
    async fn pipes_transport_rejects_resize() {
        let mut child = tokio::process::Command::new("/bin/cat")
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .unwrap();
        let stdin = child.stdin.take().unwrap();
        let mut executor = PipesExecutor { stdin };

        let error = executor.resize(101, 31).await.unwrap_err();
        assert_eq!(error.kind(), std::io::ErrorKind::Other);

        child.kill().await.unwrap();
        child.wait().await.unwrap();
    }

    #[tokio::test]
    async fn pipes_transport_preserves_exact_output_without_line_discipline() {
        let mut command = tokio::process::Command::new("/bin/bash");
        command.args(["--noprofile", "--norc", "-c", "printf 'a\\tb\\n'"]);
        let mut spawned = spawn_terminal(command, TerminalTransport::Pipes).unwrap();
        let mut stdout = spawned.stdout.take().unwrap();

        let mut output = String::new();
        stdout.read_to_string(&mut output).await.unwrap();
        let status = spawned.child.wait().await.unwrap();

        assert!(status.success());
        assert_eq!(output, "a\tb\n");
    }

    #[test]
    fn workspace_access_accepts_local_owner_and_allowed_user() {
        let owner = workspace_metadata(&[("owner_id", "alice")]);
        let allowed = workspace_metadata(&[("allowed_users", "bob, alice ")]);

        assert!(user_has_workspace_access("local", &owner));
        assert!(user_has_workspace_access("alice", &owner));
        assert!(user_has_workspace_access("alice", &allowed));
        assert!(!user_has_workspace_access("carol", &owner));
        assert!(!user_has_workspace_access("carol", &allowed));
    }

    #[test]
    fn cwd_policy_rejects_paths_outside_workspace_root() {
        let root = Path::new("/workspace");

        assert!(path_contains(root, Path::new("/workspace")));
        assert!(path_contains(root, Path::new("/workspace/project")));
        assert!(!path_contains(root, Path::new("/workspace-escape")));
        assert!(!path_contains(root, Path::new("/etc")));
    }

    #[test]
    fn audit_event_records_input_size_without_payload() {
        let request = TerminalInputRequest {
            data: "secret-terminal-payload".to_string(),
        };
        let mut event = audit_event(TerminalAuditAction::Input, TerminalAuditOutcome::Allowed);
        event.session_id = Some("session".into());
        event.input_bytes = Some(request.data.len());

        let serialized = serde_json::to_string(&event).unwrap();
        assert_eq!(event.action, TerminalAuditAction::Input);
        assert_eq!(event.input_bytes, Some(request.data.len()));
        assert!(!serialized.contains(request.data.as_str()));
        assert!(!serialized.contains("\"data\""));
        assert!(!serialized.contains("\"output\""));
        assert!(!serialized.contains("\"file_change\""));
    }

    #[test]
    fn audit_log_is_bounded_and_sequences_are_monotonic() {
        let mut log = VecDeque::new();
        for _ in 0..AUDIT_MAX_EVENTS + 16 {
            push_audit_event(
                &mut log,
                audit_event(TerminalAuditAction::Create, TerminalAuditOutcome::Allowed),
            );
        }

        assert_eq!(log.len(), AUDIT_MAX_EVENTS);
        assert_eq!(log.front().unwrap().sequence, 17);
        assert_eq!(log.back().unwrap().sequence, AUDIT_MAX_EVENTS as u64 + 16);
        let sequences: Vec<u64> = log.iter().map(|event| event.sequence).collect();
        assert!(sequences.windows(2).all(|pair| pair[0] < pair[1]));
    }

    fn data_event(data: &str) -> TerminalStreamEvent {
        TerminalStreamEvent::Data {
            sequence: 0,
            data: data.to_string(),
        }
    }

    fn event_sequences(events: &[TerminalStreamEvent]) -> Vec<u64> {
        events
            .iter()
            .map(TerminalStreamEvent::stream_sequence)
            .collect()
    }

    #[test]
    fn replay_buffer_assigns_sequences_and_resumes_from_cursor() {
        let mut buffer = TerminalReplayBuffer::new();
        buffer.push(data_event("one"));
        buffer.push(data_event("two"));
        buffer.push(TerminalStreamEvent::Exit {
            sequence: 0,
            exit_code: 0,
        });

        assert_eq!(buffer.next_sequence, 4);
        let (replay, reset) = buffer.replay_after(None).unwrap();
        assert_eq!(event_sequences(&replay), [1, 2, 3]);
        assert!(!reset);

        let (replay, reset) = buffer.replay_after(Some(1)).unwrap();
        assert_eq!(event_sequences(&replay), [2, 3]);
        assert!(!reset);

        let (replay, reset) = buffer.replay_after(Some(3)).unwrap();
        assert!(replay.is_empty());
        assert!(!reset);

        assert!(matches!(
            buffer.replay_after(Some(4)),
            Err(TerminalSessionError::Validation(_))
        ));
    }

    #[test]
    fn replay_buffer_resets_when_cursor_is_before_retained_history() {
        let mut buffer = TerminalReplayBuffer::new();
        buffer.push(data_event(&"x".repeat(REPLAY_MAX_BYTES)));
        buffer.push(data_event("latest"));

        let (replay, reset) = buffer.replay_after(Some(0)).unwrap();
        assert_eq!(event_sequences(&replay), [2]);
        assert_eq!(replay[0].stream_sequence(), 2);
        assert!(reset);
    }

    #[test]
    fn replay_buffer_stays_bounded_by_serialized_bytes() {
        let mut buffer = TerminalReplayBuffer::new();
        let output = "x".repeat(1024);
        for _ in 0..(REPLAY_MAX_BYTES / 512 + 16) {
            buffer.push(data_event(&output));
        }

        assert!(buffer.bytes <= REPLAY_MAX_BYTES);
        assert!(!buffer.events.is_empty());
        let (replay, reset) = buffer.replay_after(None).unwrap();
        assert_eq!(event_sequences(&replay), event_sequences(&replay));
        assert!(!reset);
    }

    #[test]
    fn environment_policy_keeps_only_safe_variables_and_sets_term() {
        let environment = sanitized_environment([
            ("PATH".to_string(), "/usr/bin".to_string()),
            ("SECRET_TOKEN".to_string(), "redacted".to_string()),
            ("LC_ALL".to_string(), "C.UTF-8".to_string()),
            ("TERM".to_string(), "xterm".to_string()),
        ]);

        assert_eq!(
            environment.get("PATH").map(String::as_str),
            Some("/usr/bin")
        );
        assert_eq!(
            environment.get("LC_ALL").map(String::as_str),
            Some("C.UTF-8")
        );
        assert_eq!(
            environment.get("TERM").map(String::as_str),
            Some("xterm-256color")
        );
        assert!(!environment.contains_key("SECRET_TOKEN"));
    }
}
