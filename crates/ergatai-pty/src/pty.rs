//! PTY (pseudo-terminal) creation and management
//!
//! This module provides low-level PTY operations using `forkpty()` from nix crate.

use std::collections::HashMap;
use std::os::unix::io::{AsRawFd, OwnedFd, RawFd};
use std::path::Path;

use nix::pty::{forkpty, Winsize};
use nix::unistd::{execvp, ForkResult};
use std::ffi::CString;

/// Low-level PTY handle (master fd + child pid)
pub struct Pty {
    master_fd: OwnedFd,
    pub child_pid: nix::unistd::Pid,
}

impl Pty {
    /// Create a new PTY and fork a child process
    ///
    /// The child will execute the given command with the given arguments.
    /// The parent gets the master fd for reading/writing.
    ///
    /// # Arguments
    /// * `command` - Command to execute
    /// * `args` - Command arguments
    /// * `rows` / `cols` - Terminal dimensions
    /// * `cwd` - Working directory for child (None = inherit parent's)
    /// * `env` - Additional environment variables to set in child
    pub fn spawn(
        command: &str,
        args: &[&str],
        rows: u16,
        cols: u16,
        cwd: Option<&Path>,
        env: &HashMap<String, String>,
    ) -> anyhow::Result<Self> {
        let winsize = Winsize {
            ws_row: rows,
            ws_col: cols,
            ws_xpixel: 0,
            ws_ypixel: 0,
        };

        // forkpty creates a new PTY pair and forks
        // Child: has slave fd as stdin/stdout/stderr
        // Parent: gets master fd
        //
        // SAFETY: forkpty forks the process. The child immediately calls execvp,
        // so no Rust-owned state is shared between parent and child.
        let fork_result = unsafe { forkpty(&winsize, None)? };

        match fork_result.fork_result {
            ForkResult::Child => {
                // Child process: set up environment before exec

                // Set working directory if specified
                if let Some(dir) = cwd {
                    if std::env::set_current_dir(dir).is_err() {
                        std::process::exit(1);
                    }
                }

                // Set environment variables (merged with inherited parent env)
                for (key, value) in env {
                    std::env::set_var(key, value);
                }

                // Build c_args with proper error handling — panic after fork is UB
                let cmd = match CString::new(command) {
                    Ok(c) => c,
                    Err(_) => std::process::exit(1),
                };
                let c_args: Vec<CString> = match std::iter::once(Ok(cmd.clone()))
                    .chain(args.iter().map(|s| CString::new(*s)))
                    .collect::<Result<Vec<_>, _>>()
                {
                    Ok(args) => args,
                    Err(_) => std::process::exit(1),
                };

                // execvp replaces the current process with the command
                execvp(&cmd, &c_args)?;

                // If execvp returns, it failed
                unreachable!("execvp failed");
            }
            ForkResult::Parent { child } => {
                // Parent process: return master fd and child pid
                Ok(Pty {
                    master_fd: fork_result.master,
                    child_pid: child,
                })
            }
        }
    }

    /// Get the raw file descriptor for the master
    pub fn as_raw_fd(&self) -> RawFd {
        self.master_fd.as_raw_fd()
    }

    /// Set the master fd to non-blocking mode
    pub fn set_nonblocking(&self) -> anyhow::Result<()> {
        use nix::fcntl::{fcntl, FcntlArg, OFlag};

        let fd = self.as_raw_fd();
        let flags = fcntl(fd, FcntlArg::F_GETFL)?;
        let flags = OFlag::from_bits_truncate(flags);
        fcntl(fd, FcntlArg::F_SETFL(flags | OFlag::O_NONBLOCK))?;

        Ok(())
    }

    /// Resize the PTY window
    pub fn resize(&self, rows: u16, cols: u16) -> anyhow::Result<()> {
        use nix::libc::{ioctl, winsize, TIOCSWINSZ};

        let ws = winsize {
            ws_row: rows,
            ws_col: cols,
            ws_xpixel: 0,
            ws_ypixel: 0,
        };

        let fd = self.as_raw_fd();
        // SAFETY: ws is a valid pointer, fd is a valid fd
        let ret = unsafe { ioctl(fd, TIOCSWINSZ as _, &ws) };

        if ret < 0 {
            anyhow::bail!("ioctl TIOCSWINSZ failed");
        }

        Ok(())
    }
}

// OwnedFd handles close on drop automatically.
// OwnedFd is already Send + Sync, so Pty auto-derives these traits.
