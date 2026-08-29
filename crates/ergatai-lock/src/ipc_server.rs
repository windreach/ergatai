//! Unix socket IPC server for LD_PRELOAD snapshot reads.
//!
//! The [`ergatai-preload`](../ergatai-preload/) crate intercepts `open()` calls
//! via `LD_PRELOAD`. When a read-only open targets a locked file, the preload
//! library queries this server over a Unix domain socket to get snapshot content.
//!
//! # Protocol
//!
//! Requests are JSON objects on a single Unix stream connection. Responses are
//! either JSON (for `check_lock`) or binary (for `get_snapshot`).
//!
//! ## `check_lock`
//!
//! Request:  `{"action":"check_lock","file_path":"src/foo.rs"}`
//! Response: `{"is_locked":true,"snapshot_hash":"abc123..."}` or `{"is_locked":false}`
//!
//! ## `get_snapshot`
//!
//! Request:  `{"action":"get_snapshot","git_hash":"abc123..."}`
//! Response: 4-byte big-endian length prefix followed by raw content bytes.
//!
//! # Lifecycle
//!
//! The server is started by [`start_ipc_server`] when file access control is
//! initialized with enforcement enabled. It runs in a background thread
//! (blocking accept loop). The socket file is cleaned up on drop via
//! [`IpcServerHandle`].

use std::io::{Read as _, Write as _};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::PathBuf;
use std::sync::Arc;
use tracing::{debug, info, warn};

use crate::lock_manager::FileLockManager;
use crate::snapshot::SnapshotManager;

/// Default socket path template. `{}` is replaced with the current UID.
const DEFAULT_SOCKET_TEMPLATE: &str = "/tmp/ergatai-lock-{}.sock";

/// Handle for the running IPC server.
///
/// The socket file is removed when this handle is dropped.
pub struct IpcServerHandle {
    socket_path: PathBuf,
    _cancel: tokio_util::sync::CancellationToken,
}

impl Drop for IpcServerHandle {
    fn drop(&mut self) {
        // Best-effort cleanup of the socket file.
        if let Err(e) = std::fs::remove_file(&self.socket_path) {
            if e.kind() != std::io::ErrorKind::NotFound {
                warn!(
                    path = %self.socket_path.display(),
                    error = %e,
                    "failed to remove IPC socket"
                );
            }
        }
    }
}

/// Start the IPC server for LD_PRELOAD snapshot queries.
///
/// Binds a Unix domain socket and spawns a background thread to accept
/// connections. Returns a handle that cleans up the socket on drop.
///
/// # Arguments
/// * `lock_manager` — shared reference to the file lock manager
/// * `snapshot_manager` — shared reference to the snapshot manager
/// * `socket_path` — optional override for the socket path (defaults to
///   `/tmp/ergatai-lock-{uid}.sock`)
pub fn start_ipc_server(
    lock_manager: Arc<FileLockManager>,
    snapshot_manager: Arc<SnapshotManager>,
    socket_path: Option<&str>,
) -> Result<IpcServerHandle, std::io::Error> {
    let path = match socket_path {
        Some(p) => PathBuf::from(p),
        None => {
            // SAFETY: getuid() always succeeds, no safety invariants.
            let uid = unsafe { libc::getuid() };
            PathBuf::from(DEFAULT_SOCKET_TEMPLATE.replace("{}", &uid.to_string()))
        }
    };

    // Bind socket directly — bind() will fail with EADDRINUSE if socket exists.
    // We handle stale sockets by attempting to remove and retry once.
    let listener = match UnixListener::bind(&path) {
        Ok(l) => l,
        Err(ref e) if e.kind() == std::io::ErrorKind::AddrInUse => {
            // Socket exists — remove stale socket and retry.
            if let Err(remove_err) = std::fs::remove_file(&path) {
                if remove_err.kind() != std::io::ErrorKind::NotFound {
                    return Err(remove_err);
                }
            }
            UnixListener::bind(&path)?
        }
        Err(e) => return Err(e),
    };

    // Set restrictive permissions on the socket (owner-only).
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let perms = std::fs::Permissions::from_mode(0o700);
        let _ = std::fs::set_permissions(&path, perms);
    }
    // Set non-blocking so we can poll for cancellation.
    listener.set_nonblocking(true)?;

    info!(path = %path.display(), "IPC server listening for LD_PRELOAD queries");

    let cancel = tokio_util::sync::CancellationToken::new();
    let cancel_inner = cancel.clone();
    let path_clone = path.clone();

    // Spawn the accept loop in a dedicated thread (UnixListener is synchronous).
    std::thread::Builder::new()
        .name("ergatai-ipc-server".into())
        .spawn(move || {
            accept_loop(listener, lock_manager, snapshot_manager, cancel_inner);
        })
        .map_err(std::io::Error::other)?;

    Ok(IpcServerHandle {
        socket_path: path_clone,
        _cancel: cancel,
    })
}

/// Main accept loop — runs in a dedicated thread.
///
/// Concurrency: caps concurrent connection-handling threads via an atomic counter
/// to prevent unbounded thread spawn under a flood of connections. Over the cap,
/// connections are dropped (the LD_PRELOAD client retries on its own timeout).
fn accept_loop(
    listener: UnixListener,
    lock_manager: Arc<FileLockManager>,
    snapshot_manager: Arc<SnapshotManager>,
    cancel: tokio_util::sync::CancellationToken,
) {
    // Cap concurrent connection threads. LD_PRELOAD IPC clients are agents in the
    // current DAG — typically <50 — so 64 provides headroom while bounding resource use.
    const MAX_CONCURRENT_CONNECTIONS: usize = 64;
    let active_connections = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));

    loop {
        if cancel.is_cancelled() {
            break;
        }

        match listener.accept() {
            Ok((stream, _addr)) => {
                let current = active_connections.load(std::sync::atomic::Ordering::Relaxed);
                if current >= MAX_CONCURRENT_CONNECTIONS {
                    // Over capacity — drop the connection immediately.
                    // The LD_PRELOAD client has a 100ms read timeout and will
                    // fail-open (fall through to real open()).
                    debug!(
                        active = current,
                        cap = MAX_CONCURRENT_CONNECTIONS,
                        "IPC connection rejected: over capacity"
                    );
                    drop(stream);
                    continue;
                }

                let lm = lock_manager.clone();
                let sm = snapshot_manager.clone();
                let counter = active_connections.clone();
                // Increment before spawn so the cap is enforced atomically.
                counter.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                // Handle each connection in a dedicated thread to avoid
                // blocking the accept loop. Connections are short-lived.
                std::thread::Builder::new()
                    .name("ergatai-ipc-conn".into())
                    .spawn(move || {
                        // Decrement on exit (success or panic) to release the slot.
                        struct DecrementOnDrop(std::sync::Arc<std::sync::atomic::AtomicUsize>);
                        impl Drop for DecrementOnDrop {
                            fn drop(&mut self) {
                                self.0.fetch_sub(1, std::sync::atomic::Ordering::Relaxed);
                            }
                        }
                        let _guard = DecrementOnDrop(counter);
                        if let Err(e) = handle_connection(stream, &lm, &sm) {
                            debug!(error = %e, "IPC connection error");
                        }
                    })
                    .ok();
            }
            Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                // No pending connection — sleep briefly and retry.
                std::thread::sleep(std::time::Duration::from_millis(10));
            }
            Err(e) => {
                warn!(error = %e, "IPC accept error");
                std::thread::sleep(std::time::Duration::from_millis(100));
            }
        }
    }
}

/// Handle a single IPC connection.
///
/// Reads one JSON request, processes it, writes the response, and closes.
fn handle_connection(
    mut stream: UnixStream,
    lock_manager: &FileLockManager,
    snapshot_manager: &SnapshotManager,
) -> Result<(), Box<dyn std::error::Error>> {
    // Set timeouts to prevent hung connections.
    stream.set_read_timeout(Some(std::time::Duration::from_secs(2)))?;
    stream.set_write_timeout(Some(std::time::Duration::from_secs(5)))?;

    // Verify peer credentials (only accept connections from the same user).
    #[cfg(target_os = "linux")]
    {
        use std::os::unix::io::AsRawFd;
        let fd = stream.as_raw_fd();
        let mut cred: libc::ucred = unsafe { std::mem::zeroed() };
        let mut len = std::mem::size_of::<libc::ucred>() as libc::socklen_t;
        // SAFETY: getsockopt with SO_PEERCRED is safe on Unix domain sockets.
        let ret = unsafe {
            libc::getsockopt(
                fd,
                libc::SOL_SOCKET,
                libc::SO_PEERCRED,
                &mut cred as *mut _ as *mut libc::c_void,
                &mut len,
            )
        };
        if ret == 0 {
            let my_uid = unsafe { libc::getuid() };
            if cred.uid != my_uid {
                debug!(
                    peer_uid = cred.uid,
                    my_uid = my_uid,
                    "rejecting IPC connection from different user"
                );
                return Ok(()); // Silently close — don't leak info to unauthorized users.
            }
        }
    }

    // Read request — loop until we have a complete JSON message or timeout.
    // Unix stream sockets don't preserve message boundaries, so we must read
    // until we have a complete JSON object (ends with '}').
    let mut buf = Vec::with_capacity(8192);
    let mut tmp = [0u8; 4096];
    loop {
        match stream.read(&mut tmp) {
            Ok(0) => return Ok(()), // EOF
            Ok(n) => {
                buf.extend_from_slice(&tmp[..n]);
                // Check if we have a complete JSON object (simple heuristic: ends with '}').
                if buf
                    .iter()
                    .rev()
                    .find(|&&b| b != b' ' && b != b'\n' && b != b'\r')
                    .copied()
                    == Some(b'}')
                {
                    break;
                }
                // Cap at 8 KiB to prevent OOM from malicious clients.
                if buf.len() > 8192 {
                    warn!("IPC request too large, closing connection");
                    return Ok(());
                }
            }
            Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                // Timeout — process what we have (may be incomplete).
                break;
            }
            Err(e) => return Err(e.into()),
        }
    }

    if buf.is_empty() {
        return Ok(());
    }

    let request = std::str::from_utf8(&buf)?;

    // Parse action (minimal JSON parsing without serde).
    let action = extract_json_string(request, "action").unwrap_or_default();

    match action.as_str() {
        "check_lock" => {
            let file_path = extract_json_string(request, "file_path").unwrap_or_default();
            handle_check_lock(&mut stream, lock_manager, &file_path)?;
        }
        "get_snapshot" => {
            let git_hash = extract_json_string(request, "git_hash").unwrap_or_default();
            handle_get_snapshot(&mut stream, snapshot_manager, &git_hash)?;
        }
        _ => {
            let resp = r#"{"error":"unknown action"}"#;
            stream.write_all(resp.as_bytes())?;
        }
    }

    Ok(())
}

/// Handle a `check_lock` query.
///
/// Checks if the file has an active WRITE lock and returns the snapshot hash
/// if one exists.
fn handle_check_lock(
    stream: &mut UnixStream,
    lock_manager: &FileLockManager,
    file_path: &str,
) -> Result<(), Box<dyn std::error::Error>> {
    // Normalize the path once and use it consistently for both lock check and snapshot lookup.
    // Remove leading '/' to make it relative (matches how paths are stored in the database).
    let normalized_path = file_path.trim_start_matches('/').to_string();

    // Check lock status using the normalized path.
    let (is_locked, _holder) = lock_manager
        .check_file_lock_status(&normalized_path)
        .unwrap_or((false, None));

    if is_locked {
        // Look up the latest snapshot hash for this file using the same normalized path.
        let snapshot_hash = get_latest_snapshot_hash(lock_manager, &normalized_path);

        let response = if let Some(hash) = snapshot_hash {
            format!(r#"{{"is_locked":true,"snapshot_hash":"{}"}}"#, hash)
        } else {
            r#"{"is_locked":true,"snapshot_hash":""}"#.to_string()
        };
        stream.write_all(response.as_bytes())?;
    } else {
        stream.write_all(br#"{"is_locked":false}"#)?;
    }

    Ok(())
}

/// Handle a `get_snapshot` query.
///
/// Reads the snapshot content from the Git object store and writes it
/// with a 4-byte big-endian length prefix.
fn handle_get_snapshot(
    stream: &mut UnixStream,
    snapshot_manager: &SnapshotManager,
    git_hash: &str,
) -> Result<(), Box<dyn std::error::Error>> {
    if git_hash.is_empty() {
        // No snapshot — send zero-length response.
        stream.write_all(&[0u8; 4])?;
        return Ok(());
    }

    match snapshot_manager.read_snapshot(git_hash) {
        Ok(content) => {
            // Check for overflow before casting to u32.
            let len = content.len();
            if len > u32::MAX as usize {
                warn!(
                    git_hash = git_hash,
                    len = len,
                    "snapshot too large for IPC protocol"
                );
                stream.write_all(&[0u8; 4])?; // Send zero-length on error.
                return Ok(());
            }
            stream.write_all(&(len as u32).to_be_bytes())?;
            stream.write_all(&content)?;
        }
        Err(e) => {
            warn!(git_hash = git_hash, error = %e, "failed to read snapshot");
            // Send zero-length response on error (fail-open for the reader).
            stream.write_all(&[0u8; 4])?;
        }
    }

    Ok(())
}

/// Look up the latest snapshot hash for a file from the database.
///
/// Queries the `snapshots` table for the most recent entry matching the file path.
/// Returns `None` if no snapshot exists (the LD_PRELOAD library will fall through
/// to reading the actual file in that case).
fn get_latest_snapshot_hash(lock_manager: &FileLockManager, file_path: &str) -> Option<String> {
    lock_manager
        .get_latest_snapshot_hash(file_path)
        .unwrap_or(None)
}

/// Extract a string value from a simple JSON object.
///
/// Handles `{"key":"value"}` patterns. Does NOT handle nested objects,
/// arrays, or unicode escapes. Sufficient for the IPC protocol which
/// uses flat JSON with short string values.
fn extract_json_string(json: &str, key: &str) -> Option<String> {
    let search = format!(r#""{}""#, key);
    let key_pos = json.find(&search)?;
    let after_key = &json[key_pos + search.len()..];

    // Skip colon and whitespace.
    let after_colon = after_key.trim_start().strip_prefix(':')?;
    let after_colon = after_colon.trim_start();

    // Value must start with a quote.
    let value_start = after_colon.strip_prefix('"')?;

    // Find the closing quote (handle escaped quotes).
    let mut escaped = false;
    let mut end = None;
    for (i, c) in value_start.char_indices() {
        if escaped {
            escaped = false;
            continue;
        }
        match c {
            '\\' => escaped = true,
            '"' => {
                end = Some(i);
                break;
            }
            _ => {}
        }
    }

    let end = end?;
    Some(value_start[..end].to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_extract_json_string_basic() {
        let json = r#"{"action":"check_lock","file_path":"src/foo.rs"}"#;
        assert_eq!(
            extract_json_string(json, "action"),
            Some("check_lock".to_string())
        );
        assert_eq!(
            extract_json_string(json, "file_path"),
            Some("src/foo.rs".to_string())
        );
        assert_eq!(extract_json_string(json, "missing"), None);
    }

    #[test]
    fn test_extract_json_string_with_escapes() {
        let json = r#"{"path":"src/fo\"o.rs"}"#;
        assert_eq!(
            extract_json_string(json, "path"),
            Some(r#"src/fo\"o.rs"#.to_string())
        );
    }

    #[test]
    fn test_extract_json_string_empty() {
        let json = r#"{"key":""}"#;
        assert_eq!(extract_json_string(json, "key"), Some(String::new()));
    }
}
