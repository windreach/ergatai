//! High-level PTY process management
//!
//! Wraps the low-level `Pty` with async I/O and process lifecycle management.

use std::collections::HashMap;
use std::os::unix::io::AsRawFd;
use std::path::PathBuf;
use std::sync::Arc;

use tokio::io::unix::AsyncFd;
use tokio::sync::Mutex;

use crate::pty::Pty;

/// Configuration for spawning a PTY process
#[derive(Debug, Clone)]
pub struct PtyConfig {
    /// Command to execute (e.g., "opencode", "claude")
    pub command: String,
    /// Command arguments
    pub args: Vec<String>,
    /// Terminal rows
    pub rows: u16,
    /// Terminal columns
    pub cols: u16,
    /// Working directory for the child process (None = inherit parent's cwd)
    pub cwd: Option<PathBuf>,
    /// Environment variables to set in the child process (merged with parent's env)
    pub env: HashMap<String, String>,
}

impl Default for PtyConfig {
    fn default() -> Self {
        Self {
            command: "sh".into(),
            args: vec![],
            rows: 24,
            cols: 80,
            cwd: None,
            env: HashMap::new(),
        }
    }
}

/// Async PTY process handle
///
/// Provides async read/write operations and process lifecycle management.
pub struct PtyProcess {
    pty: Arc<Mutex<Pty>>,
    async_fd: Arc<AsyncFd<std::os::unix::io::OwnedFd>>,
    child_pid: nix::unistd::Pid,
    /// Process group ID — equal to child_pid. Used to signal the entire
    /// process tree (child + grandchildren) via `kill(-pgid, sig)`.
    process_group_id: nix::unistd::Pid,
    /// Exit status: None = still running, Some = exit code
    exit_status: Arc<Mutex<Option<i32>>>,
    /// Timestamp of last PTY output. Updated by background reader and WebSocket reader.
    /// Used by DAG watchdog to detect idle agents.
    last_output_at: Arc<std::sync::Mutex<std::time::Instant>>,
}

impl PtyProcess {
    /// Spawn a new PTY process with the given configuration
    pub fn spawn(config: PtyConfig) -> anyhow::Result<Self> {
        let args_refs: Vec<&str> = config.args.iter().map(|s| s.as_str()).collect();
        let pty = Pty::spawn(
            &config.command,
            &args_refs,
            config.rows,
            config.cols,
            config.cwd.as_deref(),
            &config.env,
        )?;
        let child_pid = pty.child_pid;

        // Set non-blocking mode for async I/O
        pty.set_nonblocking()?;

        // Duplicate the fd for AsyncFd to avoid double-close on drop.
        // Pty owns the original fd via OwnedFd; AsyncFd owns the duplicated fd.
        // Both point to the same underlying file description but are separate fd entries.
        // Wrap the duplicated fd in OwnedFd so it's closed automatically if AsyncFd::new fails.
        use std::os::fd::FromRawFd;
        let raw_fd = pty.as_raw_fd();
        let duplicated_fd = nix::unistd::dup(raw_fd)?;
        let owned_duplicated = unsafe { std::os::unix::io::OwnedFd::from_raw_fd(duplicated_fd) };
        let async_fd = AsyncFd::new(owned_duplicated)?;

        Ok(PtyProcess {
            pty: Arc::new(Mutex::new(pty)),
            async_fd: Arc::new(async_fd),
            child_pid,
            process_group_id: child_pid, // PGID = child PID (set in Pty::spawn)
            exit_status: Arc::new(Mutex::new(None)),
            last_output_at: Arc::new(std::sync::Mutex::new(std::time::Instant::now())),
        })
    }

    /// Write data to the agent's stdin
    ///
    /// Loops on EAGAIN (WouldBlock) until all bytes are written or a real error occurs.
    /// This prevents silent data loss when the PTY buffer is full and `try_io` returns
    /// `Err(WouldBlock)` — previously, returning `Ok(0)` caused callers like `inject_message`
    /// to believe the write succeeded when no bytes were actually sent.
    pub async fn write(&self, data: &[u8]) -> anyhow::Result<usize> {
        let mut written = 0;
        while written < data.len() {
            let mut guard = self.async_fd.writable().await?;
            let fd = self.async_fd.as_raw_fd();

            match guard
                .try_io(|_| nix::unistd::write(fd, &data[written..]).map_err(std::io::Error::from))
            {
                Ok(result) => {
                    let n = result?;
                    if n == 0 {
                        // Kernel returned 0 on a write — treat as transient.
                        // Continue to re-poll rather than returning a short write.
                        continue;
                    }
                    written += n;
                }
                Err(_would_block) => {
                    // Readiness was stale (kernel EAGAIN). Re-poll via writable().await.
                    continue;
                }
            }
        }
        Ok(written)
    }

    /// Read data from the agent's stdout
    ///
    /// Loops on EAGAIN (WouldBlock) until at least some bytes are read or EOF is reached.
    /// Previously, returning `Ok(0)` on WouldBlock was indistinguishable from EOF for
    /// callers like `read_clean()`, potentially causing premature stream termination.
    pub async fn read(&self, buf: &mut [u8]) -> anyhow::Result<usize> {
        loop {
            let mut guard = self.async_fd.readable().await?;
            let fd = self.async_fd.as_raw_fd();

            match guard.try_io(|_| nix::unistd::read(fd, buf).map_err(std::io::Error::from)) {
                Ok(result) => return Ok(result?),
                Err(_would_block) => {
                    // Readiness was stale (kernel EAGAIN). Re-poll via readable().await.
                    continue;
                }
            }
        }
    }

    /// Read data and parse ANSI to extract clean text
    pub async fn read_clean(&self, buf: &mut [u8]) -> anyhow::Result<String> {
        let n = self.read(buf).await?;
        if n == 0 {
            return Ok(String::new());
        }

        let raw = &buf[..n];
        Ok(crate::ansi::strip_ansi(raw))
    }

    /// Check if the child process has exited.
    ///
    /// Thread-safety: `exit_status` is behind a `tokio::sync::Mutex`, so concurrent
    /// calls serialize correctly — no waitpid race is possible.
    pub async fn has_exited(&self) -> bool {
        let mut exit_status = self.exit_status.lock().await;
        if exit_status.is_some() {
            return true;
        }

        // Check with waitpid (nohang)
        use nix::sys::wait::{waitpid, WaitPidFlag, WaitStatus};

        match waitpid(self.child_pid, Some(WaitPidFlag::WNOHANG)) {
            Ok(WaitStatus::Exited(_, code)) => {
                *exit_status = Some(code);
                true
            }
            Ok(WaitStatus::Signaled(_, sig, _)) => {
                *exit_status = Some(128 + sig as i32);
                true
            }
            Ok(WaitStatus::StillAlive) => false,
            Ok(_) => false,
            // H-2: Only mark exited on ECHILD (child already reaped).
            // Other errors (e.g. EINTR) are transient — don't set a fake exit code.
            Err(nix::Error::ECHILD) => {
                *exit_status = Some(-1);
                true
            }
            Err(_) => false,
        }
    }

    /// Wait for the child process to exit
    pub async fn wait(&self) -> anyhow::Result<i32> {
        loop {
            {
                let exit_status = self.exit_status.lock().await;
                if let Some(code) = *exit_status {
                    return Ok(code);
                }
            }

            tokio::time::sleep(tokio::time::Duration::from_millis(50)).await;

            // Check again
            if self.has_exited().await {
                let exit_status = self.exit_status.lock().await;
                return Ok(exit_status.unwrap_or(-1));
            }
        }
    }

    /// Send a signal to the child process
    pub fn signal(&self, sig: nix::sys::signal::Signal) -> anyhow::Result<()> {
        nix::sys::signal::kill(self.child_pid, sig)?;
        Ok(())
    }

    /// Send a signal to the entire process group (child + all grandchildren)
    ///
    /// Uses `kill(-pgid, sig)` — a negative PID sends the signal to every
    /// process in the group. This prevents orphaned grandchildren when the
    /// main agent process is killed.
    pub fn signal_group(&self, sig: nix::sys::signal::Signal) -> anyhow::Result<()> {
        let pgid = nix::unistd::Pid::from_raw(-self.process_group_id.as_raw());
        nix::sys::signal::kill(pgid, sig)?;
        Ok(())
    }

    /// Get the child process PID
    pub fn pid(&self) -> nix::unistd::Pid {
        self.child_pid
    }

    /// Get the process group ID
    pub fn process_group_id(&self) -> nix::unistd::Pid {
        self.process_group_id
    }

    /// Resize the PTY
    pub async fn resize(&self, rows: u16, cols: u16) -> anyhow::Result<()> {
        let pty = self.pty.lock().await;
        pty.resize(rows, cols)?;

        // Send SIGWINCH to notify the child
        self.signal(nix::sys::signal::Signal::SIGWINCH)?;

        Ok(())
    }

    /// Update the last output timestamp to now.
    /// Called by background reader and WebSocket reader when PTY output is received.
    pub fn touch_output(&self) {
        *self.last_output_at.lock().unwrap() = std::time::Instant::now();
    }

    /// Get the duration since the last PTY output.
    /// Used by DAG watchdog to detect idle agents.
    pub fn last_output_age(&self) -> std::time::Duration {
        self.last_output_at.lock().unwrap().elapsed()
    }
}

impl Drop for PtyProcess {
    fn drop(&mut self) {
        use nix::sys::wait::{waitpid, WaitPidFlag, WaitStatus};

        // Try to terminate the entire process group gracefully (not just child PID).
        // This kills grandchildren too — otherwise they become orphans.
        let _ = self.signal_group(nix::sys::signal::Signal::SIGTERM);

        // Non-blocking check if already exited
        match waitpid(self.child_pid, Some(WaitPidFlag::WNOHANG)) {
            Ok(WaitStatus::Exited(_, _)) | Ok(WaitStatus::Signaled(_, _, _)) => return,
            _ => {}
        }

        // Spawn a detached OS thread for cleanup instead of tokio::spawn.
        // tokio::spawn panics if the runtime is already shut down (e.g., during
        // process exit or panic unwinding). std::thread::spawn is safe in any context.
        let pid = self.child_pid;
        let pgid_raw = self.process_group_id.as_raw();
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(100));

            // Check again after grace period
            if let Ok(WaitStatus::StillAlive) = waitpid(pid, Some(WaitPidFlag::WNOHANG)) {
                // Force kill entire process group (not just child PID)
                let pgid = nix::unistd::Pid::from_raw(-pgid_raw);
                let _ = nix::sys::signal::kill(pgid, nix::sys::signal::Signal::SIGKILL);

                // CONCURRENT FIX: Replace blocking `waitpid(pid, None)` with a bounded
                // non-blocking loop. The original call could block indefinitely if the
                // child is stuck in uninterruptible I/O (D state), leaking the cleanup
                // thread forever. Cap at 50 iterations × 100ms = 5s total wait.
                for _ in 0..50 {
                    match waitpid(pid, Some(WaitPidFlag::WNOHANG)) {
                        Ok(WaitStatus::StillAlive) => {
                            std::thread::sleep(std::time::Duration::from_millis(100));
                        }
                        Ok(_) => return,  // Exited or signaled — cleanup done
                        Err(_) => return, // ECHILD or other error — child already reaped
                    }
                }
                // Timed out — log but don't block forever. The zombie will be reaped
                // by init (PID 1) when this process exits.
                tracing::warn!(
                    pid = pid.as_raw(),
                    "waitpid timed out after 5s — child may be in D state"
                );
            }
        });
    }
}
