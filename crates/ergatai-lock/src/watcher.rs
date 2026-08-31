//! File system watcher for detecting unauthorized file modifications.
//!
//! Phase 6 (Plan): fsevents/inotify Fallback
//! Uses notify crate to monitor file system events and detect writes
//! that bypass the lock system.
//!
//! # Cross-platform auto-locking
//!
//! On Linux with fanotify, the enforcer's `FAN_MODIFY` handler auto-acquires
//! WRITE locks with precise PID-based agent attribution. On other platforms
//! (macOS, Windows), fanotify is unavailable, and this watcher serves as the
//! fallback modification detector.
//!
//! When a file modification is detected on an unlocked file:
//! 1. The watcher calls `auto_acquire_write_lock()` with agent_id="system"
//! 2. A Git snapshot is created + WRITE lock is granted
//!
//! **Agent attribution**: Non-Linux platforms cannot determine which agent
//! modified a file (no PID, no reliable workspace mapping for shared dirs).
//! All auto-acquired locks are attributed to "system". The lock still prevents
//! concurrent modifications — we just can't tell who wrote what.
//!
//! # Known limitations (non-Linux)
//!
//! - **No blocking**: writes complete before detection (post-facto)
//! - **No agent attribution**: all locks attributed to "system" (no PID available)
//! - **No LD_PRELOAD**: other agents can't transparently read snapshots
//! - **Advisory-only**: locks are SQLite records, not kernel-enforced

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use notify::{Config, Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use tokio::sync::mpsc;
use tracing::{debug, error, info, warn};

use crate::lock_manager::FileLockManager;
use ergatai_error::{ErgataiError, ErgataiResult};

/// Agent ID used for all auto-acquired locks on non-Linux platforms.
const SYSTEM_AGENT_ID: &str = "system";
/// Session ID used for all auto-acquired locks on non-Linux platforms.
const WATCHER_SESSION_ID: &str = "watcher";

/// File system watcher for detecting unauthorized modifications
/// and auto-acquiring WRITE locks (cross-platform fallback for fanotify).
pub struct FileSystemWatcher {
    /// Watcher instance
    _watcher: RecommendedWatcher,
    /// Receiver for file system events
    event_rx: Option<mpsc::Receiver<Event>>,
    /// Lock manager for checking/creating locks
    lock_manager: Arc<FileLockManager>,
    /// Project root directory
    project_root: PathBuf,
    /// Project ID (used for SnapshotManager lookup)
    project_id: String,
    /// Shutdown signal
    shutdown_tx: Option<tokio::sync::oneshot::Sender<()>>,
}

impl FileSystemWatcher {
    /// Create a new file system watcher with auto-locking support.
    ///
    /// # Arguments
    /// * `lock_manager` — the file lock manager for checking/creating locks
    /// * `project_root` — project root directory for relative path computation
    /// * `project_id` — project identifier (used for SnapshotManager lookup)
    pub fn new(
        lock_manager: Arc<FileLockManager>,
        project_root: PathBuf,
        project_id: String,
    ) -> ErgataiResult<Self> {
        // Create channel for file system events
        let (event_tx, event_rx) = mpsc::channel(1000);

        // Clone project_root for the closure so we can filter internal dirs
        let watch_root = project_root.clone();

        // Create watcher with config
        let config = Config::default()
            .with_poll_interval(Duration::from_secs(2)) // Poll every 2 seconds
            .with_compare_contents(true); // Compare file contents to detect changes

        let mut watcher = RecommendedWatcher::new(
            move |res: Result<Event, notify::Error>| {
                if let Ok(event) = res {
                    // Skip events from internal directories to prevent feedback loops:
                    // - .git/: git2 creates tmp_object_* files during snapshot, which
                    //   triggers auto-lock → more snapshots → infinite loop
                    // - .ergatai/: lock database WAL writes trigger spurious events
                    // - target/: build artifacts, not user code
                    if event.paths.iter().all(|p| {
                        if let Ok(rel) = p.strip_prefix(&watch_root) {
                            let dominated = rel.components().any(|c| {
                                let s = c.as_os_str().to_string_lossy();
                                s == ".git" || s == ".ergatai" || s == "target"
                            });
                            !dominated
                        } else {
                            true // keep events we can't relativize (shouldn't happen)
                        }
                    }) {
                        if let Err(e) = event_tx.try_send(event) {
                            warn!("File system event dropped (channel full): {}", e);
                        }
                    }
                }
            },
            config,
        )
        .map_err(|e| ErgataiError::internal(format!("Failed to create watcher: {}", e)))?;

        // Watch the project root recursively
        watcher
            .watch(&project_root, RecursiveMode::Recursive)
            .map_err(|e| ErgataiError::internal(format!("Failed to watch project root: {}", e)))?;

        info!(
            "FileSystemWatcher started for project root: {:?}",
            project_root
        );

        Ok(Self {
            _watcher: watcher,
            event_rx: Some(event_rx),
            lock_manager,
            project_root,
            project_id,
            shutdown_tx: None,
        })
    }

    /// Start the watcher background task
    pub fn start(&mut self) -> ErgataiResult<()> {
        if self.shutdown_tx.is_some() {
            return Err(ErgataiError::InvalidArgument(
                "FileSystemWatcher already started".to_string(),
            ));
        }

        let (tx, rx) = tokio::sync::oneshot::channel();
        self.shutdown_tx = Some(tx);

        // Take the event receiver out of self
        let mut event_rx = self.event_rx.take().ok_or_else(|| {
            ErgataiError::internal("FileSystemWatcher event receiver already taken")
        })?;

        let lock_manager = Arc::clone(&self.lock_manager);
        let project_root = self.project_root.clone();
        let project_id = self.project_id.clone();

        // Spawn background task to process events
        tokio::spawn(async move {
            info!("FileSystemWatcher background task started");
            let mut shutdown_rx = rx;

            loop {
                tokio::select! {
                    // Process file system events
                    event = event_rx.recv() => {
                        match event {
                            Some(event) => {
                                if let Err(e) = Self::handle_event(
                                    &lock_manager,
                                    &project_root,
                                    &project_id,
                                    event,
                                ).await {
                                    error!("Failed to handle file system event: {}", e);
                                }
                            }
                            None => {
                                // Event channel closed (notify watcher dropped), shut down
                                info!("FileSystemWatcher event channel closed, shutting down");
                                break;
                            }
                        }
                    }
                    // Shutdown signal
                    _ = &mut shutdown_rx => {
                        info!("FileSystemWatcher received shutdown signal");
                        break;
                    }
                }
            }

            info!("FileSystemWatcher background task stopped");
        });

        Ok(())
    }

    /// Stop the watcher background task
    pub fn stop(&mut self) -> ErgataiResult<()> {
        if let Some(tx) = self.shutdown_tx.take() {
            let _ = tx.send(());
            info!("FileSystemWatcher shutdown signal sent");
        }
        Ok(())
    }

    /// Handle a file system event.
    ///
    /// On unlocked file modifications, auto-acquires a WRITE lock attributed
    /// to agent_id="system" (no per-agent attribution on non-Linux).
    async fn handle_event(
        lock_manager: &Arc<FileLockManager>,
        project_root: &Path,
        project_id: &str,
        event: Event,
    ) -> ErgataiResult<()> {
        // Only process modify/create events
        match event.kind {
            EventKind::Modify(_) | EventKind::Create(_) => {}
            _ => return Ok(()),
        }

        for path in event.paths {
            // Skip directories
            if path.is_dir() {
                continue;
            }

            // Get relative path
            let relative_path = match path.strip_prefix(project_root) {
                Ok(p) => p.to_string_lossy().to_string(),
                Err(_) => continue,
            };

            // Defense-in-depth: skip internal directories.
            // The callback filter above catches most events, but a race or
            // path-normalization edge case could still let one through.
            if relative_path.starts_with(".git/")
                || relative_path.starts_with(".git\\")
                || relative_path == ".git"
                || relative_path.starts_with(".ergatai/")
                || relative_path.starts_with(".ergatai\\")
                || relative_path == ".ergatai"
                || relative_path.starts_with("target/")
                || relative_path.starts_with("target\\")
                || relative_path == "target"
            {
                continue;
            }

            // Check if file is already locked
            let is_locked = match lock_manager.is_file_locked(&relative_path) {
                Ok(locked) => locked,
                Err(e) => {
                    debug!(
                        error = %e,
                        file_path = %relative_path,
                        "watcher: is_file_locked failed, skipping"
                    );
                    continue;
                }
            };

            if is_locked {
                debug!(
                    file_path = relative_path,
                    "watcher: file modification detected (lock exists, no action needed)"
                );
                continue;
            }

            // File is unlocked and was modified → auto-acquire WRITE lock.
            // Non-Linux platforms have no PID available, so all locks are
            // attributed to "system". The lock still prevents concurrent writes.
            info!(
                file_path = %relative_path,
                "watcher: auto-acquiring WRITE lock on detected modification"
            );

            if let Err(e) = lock_manager
                .auto_acquire_write_lock(
                    &relative_path,
                    SYSTEM_AGENT_ID,
                    WATCHER_SESSION_ID,
                    project_id,
                )
                .await
            {
                warn!(
                    error = %e,
                    file_path = %relative_path,
                    "watcher: failed to auto-acquire WRITE lock"
                );
                // Fall back to logging the violation
                Self::log_violation(lock_manager, &relative_path, "unauthorized_modification")
                    .await?;
            }
        }

        Ok(())
    }

    /// Log a violation to the audit log
    async fn log_violation(
        lock_manager: &Arc<FileLockManager>,
        file_path: &str,
        action: &str,
    ) -> ErgataiResult<()> {
        // Persist the violation in the audit_log table via FileLockManager
        lock_manager.record_violation(file_path, action)?;

        warn!(
            file_path = file_path,
            action = action,
            "File access violation logged"
        );
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use notify::{Event, EventKind};
    use std::fs;
    use tempfile::TempDir;

    use crate::{FileMode, FileToken, SystemToken};

    /// Helper: create a test lock manager in a temp directory.
    fn setup() -> (TempDir, Arc<FileLockManager>, PathBuf) {
        let temp_dir = TempDir::new().unwrap();
        let db_path = temp_dir.path().join("locks.db");
        let project_root = temp_dir.path().to_path_buf();

        fs::write(project_root.join("main.rs"), "fn main() {}").unwrap();
        fs::create_dir_all(project_root.join("src")).unwrap();
        fs::write(project_root.join("src/lib.rs"), "pub fn lib() {}").unwrap();

        let manager = Arc::new(FileLockManager::new(&db_path, project_root.clone(), None).unwrap());
        (temp_dir, manager, project_root)
    }

    /// Helper: build a notify::Event with given kind and paths
    fn make_event(kind: EventKind, paths: Vec<PathBuf>) -> Event {
        let mut e = Event::new(kind);
        for p in paths {
            e = e.add_path(p);
        }
        e
    }

    /// Helper: register a system token and create a file token
    fn make_token_and_register(
        manager: &FileLockManager,
        agent_id: &str,
        session_id: &str,
        scope: &str,
        mode: FileMode,
    ) -> FileToken {
        let sys = SystemToken::new(
            agent_id.to_string(),
            session_id.to_string(),
            "/test".to_string(),
            3600,
            30,
        );
        manager.register_system_token(&sys).unwrap();
        FileToken::new(
            agent_id.to_string(),
            session_id.to_string(),
            sys.id.clone(),
            scope.to_string(),
            mode,
            Some("test".to_string()),
            "test-system".to_string(),
            3600,
            15,
        )
    }

    const PROJECT_ID: &str = "test";

    // ─── EventKind filtering ───────────────────────────────────────

    #[tokio::test]
    async fn test_handle_event_skips_remove_events() {
        let (_temp, manager, root) = setup();
        let event = make_event(
            EventKind::Remove(notify::event::RemoveKind::File),
            vec![root.join("main.rs")],
        );
        let result = FileSystemWatcher::handle_event(&manager, &root, PROJECT_ID, event).await;
        assert!(result.is_ok());
    }

    #[tokio::test]
    async fn test_handle_event_skips_access_events() {
        let (_temp, manager, root) = setup();
        let event = make_event(
            EventKind::Access(notify::event::AccessKind::Read),
            vec![root.join("main.rs")],
        );
        let result = FileSystemWatcher::handle_event(&manager, &root, PROJECT_ID, event).await;
        assert!(result.is_ok());
    }

    #[tokio::test]
    async fn test_handle_event_processes_modify_events() {
        let (_temp, manager, root) = setup();
        // main.rs is not locked — auto-lock will fail (no SnapshotManager registered),
        // falls back to log_violation, which succeeds.
        let event = make_event(
            EventKind::Modify(notify::event::ModifyKind::Data(
                notify::event::DataChange::Content,
            )),
            vec![root.join("main.rs")],
        );
        let result = FileSystemWatcher::handle_event(&manager, &root, PROJECT_ID, event).await;
        assert!(result.is_ok());
    }

    #[tokio::test]
    async fn test_handle_event_processes_create_events() {
        let (_temp, manager, root) = setup();
        let new_file = root.join("new_file.rs");
        fs::write(&new_file, "new content").unwrap();
        let event = make_event(
            EventKind::Create(notify::event::CreateKind::File),
            vec![new_file],
        );
        let result = FileSystemWatcher::handle_event(&manager, &root, PROJECT_ID, event).await;
        assert!(result.is_ok());
    }

    // ─── Path handling ─────────────────────────────────────────────

    #[tokio::test]
    async fn test_handle_event_skips_paths_outside_project_root() {
        let (_temp, manager, root) = setup();
        let event = make_event(
            EventKind::Modify(notify::event::ModifyKind::Any),
            vec![PathBuf::from("/tmp/outside_file.txt")],
        );
        let result = FileSystemWatcher::handle_event(&manager, &root, PROJECT_ID, event).await;
        assert!(result.is_ok());
    }

    #[tokio::test]
    async fn test_handle_event_skips_directories() {
        let (_temp, manager, root) = setup();
        let dir_path = root.join("new_dir");
        fs::create_dir_all(&dir_path).unwrap();
        let event = make_event(
            EventKind::Create(notify::event::CreateKind::Folder),
            vec![dir_path],
        );
        let result = FileSystemWatcher::handle_event(&manager, &root, PROJECT_ID, event).await;
        assert!(result.is_ok());
    }

    // ─── Lock-based violation detection ────────────────────────────

    #[tokio::test]
    async fn test_handle_event_unlocked_file_records_violation() {
        let (_temp, manager, root) = setup();
        // auto-lock will fail (no SnapshotManager registered for "test" project_id),
        // so handle_event falls back to log_violation.
        let event = make_event(
            EventKind::Modify(notify::event::ModifyKind::Data(
                notify::event::DataChange::Content,
            )),
            vec![root.join("main.rs")],
        );
        let result = FileSystemWatcher::handle_event(&manager, &root, PROJECT_ID, event).await;
        assert!(result.is_ok());

        let entries = manager
            .audit_manager()
            .query_audit_log(
                None,
                Some("unauthorized_modification"),
                None,
                None,
                None,
                10,
            )
            .unwrap();
        assert_eq!(entries.len(), 1, "expected one violation audit entry");
        assert_eq!(entries[0].file_path.as_deref(), Some("main.rs"));
        assert_eq!(entries[0].agent_id, "unknown");
    }

    #[tokio::test]
    async fn test_handle_event_locked_file_no_violation() {
        let (_temp, manager, root) = setup();

        let token =
            make_token_and_register(&manager, "agent-1", "session-1", "**", FileMode::Write);
        manager.acquire_lock(&token, "main.rs").await.unwrap();

        let event = make_event(
            EventKind::Modify(notify::event::ModifyKind::Data(
                notify::event::DataChange::Content,
            )),
            vec![root.join("main.rs")],
        );
        let result = FileSystemWatcher::handle_event(&manager, &root, PROJECT_ID, event).await;
        assert!(result.is_ok());
    }

    // ─── log_violation ─────────────────────────────────────────────

    #[tokio::test]
    async fn test_log_violation_succeeds() {
        let (_temp, manager, _root) = setup();
        let result =
            FileSystemWatcher::log_violation(&manager, "some/file.rs", "unauthorized_modification")
                .await;
        assert!(result.is_ok());
    }

    // ─── Multiple paths in one event ───────────────────────────────

    #[tokio::test]
    async fn test_handle_event_multiple_paths_mixed() {
        let (_temp, manager, root) = setup();

        let outside = PathBuf::from("/outside/file.txt");
        let dir_path = root.join("a_dir");
        fs::create_dir_all(&dir_path).unwrap();
        let real_file = root.join("main.rs");

        let event = make_event(
            EventKind::Modify(notify::event::ModifyKind::Any),
            vec![outside, dir_path, real_file],
        );
        let result = FileSystemWatcher::handle_event(&manager, &root, PROJECT_ID, event).await;
        assert!(result.is_ok());
    }

    // ─── Empty event (no paths) ────────────────────────────────────

    #[tokio::test]
    async fn test_handle_event_empty_paths() {
        let (_temp, manager, root) = setup();
        let event = make_event(EventKind::Modify(notify::event::ModifyKind::Any), vec![]);
        let result = FileSystemWatcher::handle_event(&manager, &root, PROJECT_ID, event).await;
        assert!(result.is_ok());
    }

    // ─── System constants ──────────────────────────────────────────

    #[test]
    fn test_system_agent_constants() {
        assert_eq!(SYSTEM_AGENT_ID, "system");
        assert_eq!(WATCHER_SESSION_ID, "watcher");
    }
}
