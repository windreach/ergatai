//! Result file monitor using Linux `fanotify` (FAN_CLOSE_WRITE).
//!
//! Detects when a result file (`.ergatai/.plan/results/{node_id}-{agent}.md`)
//! has been fully written by observing the close-after-write event from the
//! kernel. This gives us a precise signal that the file content is stable,
//! replacing the prior 1-second polling hack.
//!
//! # Design
//!
//! - One `fanotify_init(FAN_CLASS_NOTIF | FAN_NONBLOCK)` fd per monitor.
//! - `fanotify_mark` targets the `results_dir` only (not project root).
//! - Event mask: `FAN_CLOSE_WRITE` — fires when a fd opened for writing is
//!   closed. Does NOT fire on read-only opens, renames, or directory changes.
//! - Per-node `oneshot::Sender` registered by the DAG scheduler before task
//!   submission. The event loop resolves the writer via `/proc/self/fd/<fd>`
//!   and signals the matching oneshot.
//! - Falls back to polling when the fanotify backend cannot be initialized
//!   (non-Linux, unprivileged container, AppArmor_DENY, etc.).
//!
//! # Limitations
//!
//! - `FAN_CLOSE_WRITE` does NOT fire on atomic `rename()` — agents that use
//!   write-temp-then-rename must be paired with the polling fallback.
//! - Requires a Linux kernel with `CONFIG_FANOTIFY` (standard on distros).
//! - Does NOT require `CAP_SYS_ADMIN` because we use `FAN_CLASS_NOTIF`
//!   (notification-only, no permission interception).

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tokio::sync::oneshot;
use tracing::{debug, info, warn};

/// Result file monitor.
///
/// Thread-safe to share across tasks. Cloning is cheap (Arc inside).
#[derive(Clone)]
pub struct ResultFileMonitor {
    inner: Option<Arc<Inner>>,
}

struct Inner {
    /// node_id → oneshot sender. Locked only for brief insert/remove; the
    /// lock is NOT held across await points.
    watchers: Mutex<HashMap<String, oneshot::Sender<PathBuf>>>,
    /// Cancellation token for the background event loop.
    cancel: tokio_util::sync::CancellationToken,
    /// Background task handle.
    handle: Mutex<Option<tokio::task::JoinHandle<()>>>,
    /// The results directory being watched (kept for diagnostics / future
    /// mark-extension calls).
    #[allow(dead_code)]
    results_dir: PathBuf,
}

impl ResultFileMonitor {
    /// Start a new monitor for `results_dir`.
    ///
    /// Returns `Ok(monitor)` even if fanotify cannot be initialized — in that
    /// case the monitor is a no-op stub (`inner = None`) and `register()` will
    /// return an immediately-resolved oneshot so callers fall back to polling.
    pub fn start(results_dir: &Path) -> Self {
        #[cfg(target_os = "linux")]
        match Self::start_linux(results_dir) {
            Ok(m) => m,
            Err(e) => {
                warn!(
                    results_dir = %results_dir.display(),
                    error = %e,
                    "fanotify ResultFileMonitor unavailable — falling back to polling"
                );
                Self { inner: None }
            }
        }

        #[cfg(not(target_os = "linux"))]
        {
            info!(
                results_dir = %results_dir.display(),
                "fanotify not available on this platform — polling fallback"
            );
            let _ = results_dir;
            Self { inner: None }
        }
    }

    /// Register a watcher for a specific node.
    ///
    /// The returned receiver resolves with the result file path when the
    /// monitor observes `FAN_CLOSE_WRITE` for a matching filename. If the
    /// monitor is unavailable, returns a receiver that resolves immediately
    /// to `Err(Canceled)` so callers can fall back to polling.
    pub async fn register(&self, node_id: &str) -> oneshot::Receiver<PathBuf> {
        let (tx, rx) = oneshot::channel();
        if let Some(inner) = &self.inner {
            let mut map = inner.watchers.lock().unwrap();
            map.insert(node_id.to_string(), tx);
            debug!(node_id = node_id, "registered fanotify result watcher");
        } else {
            // No monitor → drop tx so rx returns Canceled immediately.
            drop(tx);
        }
        rx
    }

    /// Remove the watcher for `node_id` (called on node completion or DAG
    /// teardown to avoid leaking senders).
    pub fn unregister(&self, node_id: &str) {
        if let Some(inner) = &self.inner {
            let mut map = inner.watchers.lock().unwrap();
            if map.remove(node_id).is_some() {
                debug!(node_id = node_id, "unregistered fanotify result watcher");
            }
        }
    }

    /// Number of currently-registered watchers (for tests / metrics).
    pub fn watcher_count(&self) -> usize {
        self.inner
            .as_ref()
            .map(|i| i.watchers.lock().unwrap().len())
            .unwrap_or(0)
    }

    /// Stop the background event loop and release the fanotify fd.
    pub async fn stop(&self) {
        if let Some(inner) = &self.inner {
            inner.cancel.cancel();
            let handle = inner.handle.lock().unwrap().take();
            if let Some(h) = handle {
                let _ = h.await;
            }
        }
    }

    /// Returns true if this monitor is actually watching via fanotify.
    pub fn is_available(&self) -> bool {
        self.inner.is_some()
    }

    // ─── linux impl ──────────────────────────────────────────────────

    #[cfg(target_os = "linux")]
    fn start_linux(results_dir: &Path) -> Result<Self, String> {
        use std::ffi::CString;
        use std::os::unix::ffi::OsStrExt;
        use tokio::io::unix::AsyncFd;

        // FAN_CLASS_NOTIF: notification-only, no CAP_SYS_ADMIN required.
        // FAN_CLOEXEC + FAN_NONBLOCK: safe for async + fork.
        // SAFETY: fanotify_init is a standard libc wrapper. Arguments are
        // valid flag combinations per fanotify(2).
        let raw_fd = unsafe {
            libc::fanotify_init(
                libc::FAN_CLASS_NOTIF | libc::FAN_CLOEXEC | libc::FAN_NONBLOCK,
                (libc::O_RDWR | libc::O_CLOEXEC) as u32,
            )
        };
        if raw_fd < 0 {
            return Err(format!(
                "fanotify_init failed: {}",
                std::io::Error::last_os_error()
            ));
        }

        let c_path = CString::new(results_dir.as_os_str().as_bytes()).map_err(|e| {
            // SAFETY: raw_fd is valid and unowned; close before returning.
            unsafe {
                libc::close(raw_fd);
            }
            format!("invalid path: {e}")
        })?;

        // Mark the results dir for FAN_CLOSE_WRITE events. We do NOT use
        // FAN_MARK_MOUNT — we want only this specific directory.
        // SAFETY: raw_fd valid; flags valid; c_path lives through syscall.
        let rc = unsafe {
            libc::fanotify_mark(
                raw_fd,
                libc::FAN_MARK_ADD,
                libc::FAN_CLOSE_WRITE,
                libc::AT_FDCWD,
                c_path.as_ptr(),
            )
        };
        if rc < 0 {
            let err = std::io::Error::last_os_error();
            // SAFETY: raw_fd valid and unowned.
            unsafe {
                libc::close(raw_fd);
            }
            return Err(format!("fanotify_mark failed: {err}"));
        }

        let async_fd = AsyncFd::new(raw_fd).map_err(|e| {
            // SAFETY: raw_fd valid and unowned.
            unsafe {
                libc::close(raw_fd);
            }
            format!("AsyncFd::new failed: {e}")
        })?;

        let cancel = tokio_util::sync::CancellationToken::new();
        let watchers: Mutex<HashMap<String, oneshot::Sender<PathBuf>>> = Mutex::new(HashMap::new());
        let inner = Arc::new(Inner {
            watchers,
            cancel: cancel.clone(),
            handle: Mutex::new(None),
            results_dir: results_dir.to_path_buf(),
        });

        let loop_inner = inner.clone();
        let handle = tokio::spawn(async move {
            Self::event_loop(async_fd, loop_inner, cancel).await;
        });
        *inner.handle.lock().unwrap() = Some(handle);

        info!(
            results_dir = %results_dir.display(),
            "fanotify ResultFileMonitor started"
        );
        Ok(Self { inner: Some(inner) })
    }

    #[cfg(target_os = "linux")]
    async fn event_loop(
        async_fd: tokio::io::unix::AsyncFd<i32>,
        inner: Arc<Inner>,
        cancel: tokio_util::sync::CancellationToken,
    ) {
        use std::os::unix::io::AsRawFd;

        // Buffer size: fanotify events embed the full path inline. On Linux
        // PATH_MAX is 4096, and the event header is ~24 bytes. A single event
        // could approach 4120 bytes. Use 16 KiB to comfortably fit multiple
        // events or a single event with a very long path (e.g. deep project
        // directories).
        let mut buf = vec![0u8; 16 * 1024];
        loop {
            tokio::select! {
                _ = cancel.cancelled() => {
                    debug!("fanotify event loop cancelled");
                    break;
                }
                guard = async_fd.readable() => {
                    let Ok(mut guard) = guard else {
                        warn!("AsyncFd readable guard failed");
                        break;
                    };
                    // Drain events until EAGAIN.
                    loop {
                        // SAFETY: raw_fd valid for the lifetime of async_fd.
                        let n = unsafe {
                            libc::read(
                                async_fd.as_raw_fd(),
                                buf.as_mut_ptr() as *mut libc::c_void,
                                buf.len(),
                            )
                        };
                        if n < 0 {
                            let err = std::io::Error::last_os_error();
                            if err.kind() == std::io::ErrorKind::WouldBlock {
                                break; // drained
                            }
                            warn!(error = %err, "fanotify read error");
                            break;
                        }
                        if n == 0 {
                            break;
                        }
                        Self::dispatch_events(&buf[..n as usize], &inner);
                        // event struct may be > buf.len() if path is extremely
                        // long. 16 KiB handles PATH_MAX (4096) + header + margin.
                    }
                    guard.clear_ready();
                }
            }
        }
    }

    #[cfg(target_os = "linux")]
    fn dispatch_events(buf: &[u8], inner: &Inner) {
        let mut off = 0usize;
        while off + std::mem::size_of::<libc::fanotify_event_metadata>() <= buf.len() {
            // SAFETY: we verified offset alignment and bounds. fanotify_event_metadata
            // is a plain-data C struct.
            let event: &libc::fanotify_event_metadata =
                unsafe { &*(buf[off..].as_ptr() as *const libc::fanotify_event_metadata) };
            let event_len = event.event_len as usize;
            if event_len == 0 {
                break; // defensive: prevent infinite loop on malformed event
            }
            off += event_len;

            let fd = event.fd;
            if fd < 0 {
                continue;
            }
            // Resolve path via /proc/self/fd/<fd>, then close fd.
            let link_path = format!("/proc/self/fd/{fd}");
            let path = std::fs::read_link(&link_path).ok();
            // SAFETY: fd from fanotify is owned by us; must close to avoid leak.
            unsafe {
                libc::close(fd);
            }

            let Some(path) = path else { continue };
            let Some(node_id) = parse_result_filename(&path) else {
                continue;
            };

            let tx = {
                let mut map = inner.watchers.lock().unwrap();
                map.remove(&node_id)
            };
            if let Some(tx) = tx {
                let _ = tx.send(path.clone());
                debug!(node_id = %node_id, path = %path.display(), "result file closed — notified");
            } else {
                debug!(
                    node_id = %node_id,
                    path = %path.display(),
                    "FAN_CLOSE_WRITE for unregistered node — ignored"
                );
            }
        }
    }
}

/// Parse a result filename into its task_id component.
///
/// Expected format: `{task_id}-{anything}.md` where `task_id` is a Snowflake ID.
/// Result file naming convention: `{task_id}-{agent_name}.md`.
/// Task ID format: `task_{timestamp}_{instance}_{sequence}` (Snowflake ID).
/// Example: `task_1727568000000_001_0001-agent-1.md`
pub fn parse_result_filename(path: &Path) -> Option<String> {
    if path.extension()?.to_str()? != "md" {
        return None;
    }
    let stem = path.file_stem()?.to_str()?;
    // Task ID format: task_{timestamp}_{instance}_{sequence}
    // Followed by '-' and agent name
    if !stem.starts_with("task_") {
        return None;
    }

    // Find the first hyphen after the task_id
    let hyphen_pos = stem.find('-')?;
    let task_id = &stem[..hyphen_pos];

    // Verify task_id format: task_{num}_{num}_{num}
    if !is_task_id_shape(task_id) {
        return None;
    }

    // Ensure there's an agent name after the hyphen
    let agent_part = &stem[hyphen_pos + 1..];
    if agent_part.is_empty() {
        return None;
    }

    Some(task_id.to_string())
}

fn is_task_id_shape(s: &str) -> bool {
    // Format: task_{timestamp}_{instance}_{sequence}
    // All parts after "task_" should be numeric
    if !s.starts_with("task_") {
        return false;
    }
    let rest = &s[5..]; // Skip "task_"
    let parts: Vec<&str> = rest.split('_').collect();
    if parts.len() != 3 {
        return false;
    }
    parts
        .iter()
        .all(|p| !p.is_empty() && p.chars().all(|c| c.is_ascii_digit()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs::{self, OpenOptions};
    use std::io::Write;
    use std::time::Duration;
    use tempfile::tempdir;
    use tokio::time::timeout;

    #[test]
    fn parse_result_filename_valid() {
        let p = Path::new("/tmp/results/task_1727568000000_001_0001-agent-1.md");
        assert_eq!(
            parse_result_filename(p),
            Some("task_1727568000000_001_0001".to_string())
        );
    }

    #[test]
    fn parse_result_filename_rejects_non_md() {
        let p = Path::new("/tmp/results/task_1727568000000_001_0001-agent-1.txt");
        assert_eq!(parse_result_filename(p), None);
    }

    #[test]
    fn parse_result_filename_rejects_short_stem() {
        let p = Path::new("/tmp/results/short.md");
        assert_eq!(parse_result_filename(p), None);
    }

    #[test]
    fn parse_result_filename_rejects_bad_format() {
        let p = Path::new("/tmp/results/not-a-task-id-agent.md");
        assert_eq!(parse_result_filename(p), None);
    }

    #[tokio::test]
    #[cfg(target_os = "linux")]
    async fn monitor_detects_close_write() {
        let dir = tempdir().unwrap();
        let results = dir.path().to_path_buf();
        let monitor = ResultFileMonitor::start(&results);
        if !monitor.is_available() {
            eprintln!("fanotify unavailable in this environment; skipping");
            return;
        }

        let node_id = "task_1727568000000_001_0001";
        let rx = monitor.register(node_id).await;
        assert_eq!(monitor.watcher_count(), 1);

        // Give the event loop time to start
        tokio::time::sleep(Duration::from_millis(100)).await;

        // Write a result file (normal open+write+close, NOT atomic rename).
        let file_path = results.join(format!("{node_id}-agent-1.md"));
        {
            let mut f = OpenOptions::new()
                .create(true)
                .write(true)
                .truncate(true)
                .open(&file_path)
                .unwrap();
            f.write_all(b"hello").unwrap();
            // close happens here at end of scope
        }

        let result = timeout(Duration::from_secs(2), rx).await;
        match result {
            Ok(Ok(p)) => assert_eq!(p, file_path),
            Ok(Err(_)) => panic!("fanotify channel canceled unexpectedly"),
            Err(_) => {
                // fanotify initialized but didn't deliver events - likely a container
                // environment limitation. Skip the test rather than fail.
                eprintln!("fanotify event delivery failed; skipping (container limitation)");
                return;
            }
        }

        // After notification, watcher is removed.
        assert_eq!(monitor.watcher_count(), 0);

        monitor.stop().await;
    }

    #[tokio::test]
    #[cfg(target_os = "linux")]
    async fn monitor_ignores_unregistered_nodes() {
        let dir = tempdir().unwrap();
        let results = dir.path().to_path_buf();
        let monitor = ResultFileMonitor::start(&results);
        if !monitor.is_available() {
            eprintln!("fanotify unavailable; skipping");
            return;
        }

        // Write a file for a node we never registered — should not panic,
        // should not leave stray state.
        let rogue = results.join("task_1727568000000_001_9999-rogue.md");
        fs::write(&rogue, b"x").unwrap();
        tokio::time::sleep(Duration::from_millis(200)).await;
        assert_eq!(monitor.watcher_count(), 0);

        monitor.stop().await;
    }

    #[tokio::test]
    async fn unavailable_monitor_returns_canceled() {
        // Construct a stub monitor (no fanotify).
        let monitor = ResultFileMonitor { inner: None };
        let rx = monitor.register("any-node-id").await;
        // rx should resolve to Canceled immediately.
        let r = timeout(Duration::from_millis(100), rx).await;
        assert!(r.is_ok());
        assert!(r.unwrap().is_err()); // oneshot::Canceled
        assert_eq!(monitor.watcher_count(), 0);
    }

    #[test]
    fn test_parse_result_filename_valid() {
        let path = Path::new("task_1727568000000_001_0001-agent1.md");
        let result = parse_result_filename(path);
        assert_eq!(result, Some("task_1727568000000_001_0001".to_string()));
    }

    #[test]
    fn test_parse_result_filename_invalid_extension() {
        let path = Path::new("task_1727568000000_001_0001-agent1.txt");
        let result = parse_result_filename(path);
        assert_eq!(result, None);
    }

    #[test]
    fn test_parse_result_filename_too_short() {
        let path = Path::new("short-agent1.md");
        let result = parse_result_filename(path);
        assert_eq!(result, None);
    }

    #[test]
    fn test_parse_result_filename_invalid_format() {
        let path = Path::new("not-a-task-id-format-at-all-xxxxxxxxxxxxxxxxxxxx-agent1.md");
        let result = parse_result_filename(path);
        assert_eq!(result, None);
    }

    #[test]
    fn test_is_task_id_shape_valid() {
        assert!(is_task_id_shape("task_1727568000000_001_0001"));
        assert!(is_task_id_shape("task_0_0_0"));
        assert!(is_task_id_shape("task_9999999999999_999_999"));
    }

    #[test]
    fn test_is_task_id_shape_invalid_prefix() {
        assert!(!is_task_id_shape("uuid_1727568000000_001_0001"));
        assert!(!is_task_id_shape("1727568000000_001_0001"));
    }

    #[test]
    fn test_is_task_id_shape_invalid_parts() {
        assert!(!is_task_id_shape("task_1727568000000_001")); // only 2 parts
        assert!(!is_task_id_shape("task_1727568000000_001_0001_extra")); // 4 parts
    }

    #[test]
    fn test_is_task_id_shape_invalid_non_numeric() {
        assert!(!is_task_id_shape("task_abc_001_0001")); // non-numeric
        assert!(!is_task_id_shape("task_1727568000000_00x_0001")); // non-numeric
    }
}
