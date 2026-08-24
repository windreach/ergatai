//! High-level PTY process management
//!
//! Wraps the low-level `Pty` with async I/O and process lifecycle management.

use std::os::unix::io::AsRawFd;
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
}

impl Default for PtyConfig {
    fn default() -> Self {
        Self {
            command: "sh".into(),
            args: vec![],
            rows: 24,
            cols: 80,
        }
    }
}

/// Async PTY process handle
///
/// Provides async read/write operations and process lifecycle management.
pub struct PtyProcess {
    pty: Arc<Mutex<Pty>>,
    async_fd: Arc<AsyncFd<i32>>,
    child_pid: nix::unistd::Pid,
    /// Exit status: None = still running, Some = exit code
    exit_status: Arc<Mutex<Option<i32>>>,
}

impl PtyProcess {
    /// Spawn a new PTY process with the given configuration
    pub fn spawn(config: PtyConfig) -> anyhow::Result<Self> {
        let args_refs: Vec<&str> = config.args.iter().map(|s| s.as_str()).collect();
        let pty = Pty::spawn(&config.command, &args_refs, config.rows, config.cols)?;
        let child_pid = pty.child_pid;

        // Set non-blocking mode for async I/O
        pty.set_nonblocking()?;

        // Get raw fd and wrap in AsyncFd for tokio
        let raw_fd = pty.as_raw_fd();
        let async_fd = AsyncFd::new(raw_fd)?;

        Ok(PtyProcess {
            pty: Arc::new(Mutex::new(pty)),
            async_fd: Arc::new(async_fd),
            child_pid,
            exit_status: Arc::new(Mutex::new(None)),
        })
    }

    /// Write data to the agent's stdin
    pub async fn write(&self, data: &[u8]) -> anyhow::Result<usize> {
        let mut guard = self.async_fd.writable().await?;
        let fd = self.async_fd.as_raw_fd();

        match guard.try_io(|_| {
            nix::unistd::write(fd, data).map_err(std::io::Error::from)
        }) {
            Ok(result) => Ok(result?),
            Err(_would_block) => Ok(0),
        }
    }

    /// Read data from the agent's stdout
    pub async fn read(&self, buf: &mut [u8]) -> anyhow::Result<usize> {
        let mut guard = self.async_fd.readable().await?;
        let fd = self.async_fd.as_raw_fd();

        match guard.try_io(|_| {
            nix::unistd::read(fd, buf).map_err(std::io::Error::from)
        }) {
            Ok(result) => Ok(result?),
            Err(_would_block) => Ok(0),
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

    /// Check if the child process has exited
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
            Err(_) => {
                *exit_status = Some(-1);
                true
            }
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

    /// Get the child process PID
    pub fn pid(&self) -> nix::unistd::Pid {
        self.child_pid
    }

    /// Resize the PTY
    pub async fn resize(&self, rows: u16, cols: u16) -> anyhow::Result<()> {
        let pty = self.pty.lock().await;
        pty.resize(rows, cols)?;

        // Send SIGWINCH to notify the child
        self.signal(nix::sys::signal::Signal::SIGWINCH)?;

        Ok(())
    }
}

impl Drop for PtyProcess {
    fn drop(&mut self) {
        // Try to terminate the child gracefully
        let _ = self.signal(nix::sys::signal::Signal::SIGTERM);

        // Give it a moment to exit
        std::thread::sleep(std::time::Duration::from_millis(100));

        // Check if already exited
        use nix::sys::wait::{waitpid, WaitPidFlag, WaitStatus};
        match waitpid(self.child_pid, Some(WaitPidFlag::WNOHANG)) {
            Ok(WaitStatus::Exited(_, _)) | Ok(WaitStatus::Signaled(_, _, _)) => return,
            _ => {}
        }

        // Force kill if still alive
        let _ = self.signal(nix::sys::signal::Signal::SIGKILL);
        let _ = waitpid(self.child_pid, None);
    }
}
