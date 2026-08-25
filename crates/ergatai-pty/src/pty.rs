//! PTY (pseudo-terminal) creation and management
//!
//! This module provides low-level PTY operations using `forkpty()` from nix crate.

use std::collections::HashMap;
use std::os::unix::io::{AsRawFd, OwnedFd, RawFd};
use std::path::Path;

use nix::pty::{forkpty, Winsize};
use nix::unistd::{execve, ForkResult};
use std::ffi::CString;

/// Low-level PTY handle (master fd + child pid + process group id)
pub struct Pty {
    master_fd: OwnedFd,
    pub child_pid: nix::unistd::Pid,
    /// Process group ID (PGID) for signaling the entire process tree.
    /// Equal to `child_pid` — the child is the process group leader.
    pub process_group_id: nix::unistd::Pid,
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

        // ── Pre-fork: build all CStrings in the parent ──────────────────────
        // This is critical: after fork, in a multi-threaded program, we cannot
        // call setenv/putenv/set_var (they modify `environ` and take a lock that
        // another thread may hold → deadlock or UB). Only async-signal-safe
        // operations are permitted between fork and exec.
        let c_cmd = CString::new(command)
            .map_err(|_| anyhow::anyhow!("command contains interior NUL byte"))?;
        let c_args: Vec<CString> = std::iter::once(Ok(c_cmd.clone()))
            .chain(args.iter().map(|s| CString::new(*s)))
            .collect::<Result<Vec<_>, _>>()
            .map_err(|_| anyhow::anyhow!("argument contains interior NUL byte"))?;

        // Resolve command via PATH if it doesn't contain a slash (matches execvp semantics).
        let resolved_cmd = if command.contains('/') {
            c_cmd.clone()
        } else {
            resolve_in_path(command)?
        };

        // Build envp: start from inherited parent env, override/append extras.
        // Ordering: extras last so they override earlier duplicates (execve uses
        // first-match, so actually we need extras FIRST to win). Reverse logic:
        // build a dedup map, extras win, then emit.
        let mut env_map: HashMap<String, String> = std::env::vars().collect();
        for (k, v) in env {
            env_map.insert(k.clone(), v.clone());
        }
        let c_env: Vec<CString> = env_map
            .into_iter()
            .map(|(k, v)| CString::new(format!("{}={}", k, v)))
            .collect::<Result<Vec<_>, _>>()
            .map_err(|_| anyhow::anyhow!("environment variable contains interior NUL byte"))?;

        // ── Fork ────────────────────────────────────────────────────────────
        // SAFETY: forkpty forks the process. The child only calls async-signal-safe
        // functions (chdir, execve) and _exit on failure — no Rust-owned state is
        // shared between parent and child.
        let fork_result = unsafe { forkpty(&winsize, None)? };

        match fork_result.fork_result {
            ForkResult::Child => {
                // NOTE: No setpgid() call here — forkpty() already called setsid()
                // in the child, which makes the child a session leader with PGID = PID.
                // Calling setpgid() on a session leader returns EPERM, so we must NOT
                // call it here. The PGID is already set correctly.
                //
                // Any grandchildren spawned by the child will inherit this session
                // and process group, so kill(-pgid, sig) will reach the whole tree.

                // Change working directory (chdir syscall is async-signal-safe).
                if let Some(dir) = cwd {
                    if let Err(e) = nix::unistd::chdir(dir) {
                        write_child_error_and_exit("chdir failed", &e);
                    }
                }

                // execve: replace process image with explicit env (no environ access).
                // resolved_cmd, c_args, c_env are all valid CStrings built pre-fork.
                execve(&resolved_cmd, &c_args, &c_env)?;

                // execve only returns on error
                write_child_error_and_exit("execve failed", &std::io::Error::last_os_error());
            }
            ForkResult::Parent { child } => {
                // After forkpty() returns, the child has already called setsid()
                // (inside forkpty), which creates a new session with PGID = PID.
                // No setpgid() needed here — the PGID is already correct.
                // (Calling setpgid() on a child in a different session would fail
                // with EPERM/ESRCH anyway.)
                Ok(Pty {
                    master_fd: fork_result.master,
                    child_pid: child,
                    process_group_id: child, // PGID = PID after setsid()
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

/// Resolve a bare command name via the PATH environment variable.
///
/// Mirrors `execvp` semantics: if `command` contains a `/` it's returned as-is;
/// otherwise each PATH directory is probed for an executable file.
///
/// Must be called BEFORE fork (uses std::env, allocates).
fn resolve_in_path(command: &str) -> anyhow::Result<CString> {
    use std::os::unix::fs::PermissionsExt;

    let path_var = std::env::var_os("PATH").unwrap_or_default();
    for dir in std::env::split_paths(&path_var) {
        let candidate = dir.join(command);
        if let Ok(meta) = std::fs::metadata(&candidate) {
            if meta.is_file() && (meta.permissions().mode() & 0o111 != 0) {
                if let Ok(c) = CString::new(candidate.into_os_string().into_string().ok().unwrap_or_default()) {
                    return Ok(c);
                }
            }
        }
    }
    // Not found in PATH — return the bare command and let execve fail with ENOENT.
    CString::new(command).map_err(|_| anyhow::anyhow!("command contains interior NUL byte"))
}

/// Write a diagnostic to stderr and `_exit(127)`.
///
/// Only async-signal-safe operations are used: `libc::write` to fd 2 and `libc::_exit`.
/// This is the ONLY safe way to report errors between `fork` and `exec` in a
/// multi-threaded program — `println!`, `eprintln!`, `std::process::exit`, and
/// any allocator-backed I/O risk deadlock or heap corruption.
fn write_child_error_and_exit(context: &str, err: &dyn std::fmt::Display) -> ! {
    use std::os::unix::io::RawFd;
    const STDERR: RawFd = 2;

    // Build a small stack buffer — no allocator required.
    let mut buf = [0u8; 256];
    let mut pos = 0;

    // Manual ASCII write helper (never allocates).
    let mut write_bytes = |bytes: &[u8]| {
        for &b in bytes {
            if pos < buf.len() {
                buf[pos] = b;
                pos += 1;
            }
        }
    };

    write_bytes(b"ergatai-pty: ");
    write_bytes(context.as_bytes());
    write_bytes(b": ");

    // Format the error Display into the buffer (ASCII-safe truncation).
    let err_str = format!("{}", err);
    write_bytes(err_str.as_bytes());
    write_bytes(b"\n");

    // Best-effort write to stderr; ignore errors (we're exiting anyway).
    unsafe {
        nix::libc::write(STDERR, buf.as_ptr() as *const nix::libc::c_void, pos);
        nix::libc::_exit(127)
    }
}
