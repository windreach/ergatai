//! File system monitor for detecting unauthorized file modifications.
//!
//! Uses the `notify` crate to watch for file changes and integrates with
//! the PID-based agent tracking to detect violations.

use notify::{Event, EventKind, RecursiveMode, Watcher};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tokio::sync::RwLock;
use tracing::{debug, error, info, warn};

use ergatai_error::{ErgataiError, ErgataiResult};

use crate::lock_manager::FileLockManager;

/// File system monitor that detects unauthorized file modifications.
///
/// Integrates with FileLockManager to check permissions and with
/// AcpBackend's PID mapping to identify which agent modified a file.
pub struct FileMonitor {
    /// File lock manager for permission checks.
    lock_manager: Arc<FileLockManager>,
    /// PID to agent_id mapping (shared with AcpBackend).
    pid_to_agent: Arc<RwLock<HashMap<u32, String>>>,
    /// Project root directory.
    project_root: PathBuf,
    /// Notify watcher instance.
    watcher: Option<notify::RecommendedWatcher>,
    /// Channel for receiving file system events.
    event_rx: Option<std::sync::mpsc::Receiver<notify::Result<Event>>>,
}

impl FileMonitor {
    /// Create a new file monitor.
    ///
    /// # Arguments
    ///
    /// * `lock_manager` - File lock manager for permission checks
    /// * `pid_to_agent` - PID to agent_id mapping (shared with AcpBackend)
    /// * `project_root` - Project root directory to monitor
    pub fn new(
        lock_manager: Arc<FileLockManager>,
        pid_to_agent: Arc<RwLock<HashMap<u32, String>>>,
        project_root: PathBuf,
    ) -> Self {
        Self {
            lock_manager,
            pid_to_agent,
            project_root,
            watcher: None,
            event_rx: None,
        }
    }

    /// Start monitoring the project directory.
    ///
    /// Spawns a background task to process file system events.
    pub fn start(&mut self) -> ErgataiResult<()> {
        let (tx, rx) = std::sync::mpsc::channel();

        let mut watcher = notify::recommended_watcher(move |res| {
            if let Err(e) = tx.send(res) {
                error!("Failed to send file system event: {}", e);
            }
        })
        .map_err(|e| ErgataiError::internal(format!("Failed to create file watcher: {}", e)))?;

        // Watch the project root recursively
        watcher
            .watch(&self.project_root, RecursiveMode::Recursive)
            .map_err(|e| ErgataiError::internal(format!("Failed to watch directory: {}", e)))?;

        info!(
            project_root = %self.project_root.display(),
            "File monitor started"
        );

        self.watcher = Some(watcher);
        self.event_rx = Some(rx);

        // Spawn background task to process events
        let lock_manager = self.lock_manager.clone();
        let pid_to_agent = self.pid_to_agent.clone();
        let project_root = self.project_root.clone();
        let event_rx = self.event_rx.take().unwrap();

        tokio::spawn(async move {
            Self::event_loop(lock_manager, pid_to_agent, project_root, event_rx).await;
        });

        Ok(())
    }

    /// Background event processing loop.
    async fn event_loop(
        lock_manager: Arc<FileLockManager>,
        pid_to_agent: Arc<RwLock<HashMap<u32, String>>>,
        project_root: PathBuf,
        event_rx: std::sync::mpsc::Receiver<notify::Result<Event>>,
    ) {
        info!("File monitor event loop started");

        for result in event_rx {
            match result {
                Ok(event) => {
                    if let Err(e) =
                        Self::handle_event(&lock_manager, &pid_to_agent, &project_root, event).await
                    {
                        warn!("Failed to handle file event: {}", e);
                    }
                }
                Err(e) => {
                    error!("File system watch error: {}", e);
                }
            }
        }

        info!("File monitor event loop ended");
    }

    /// Handle a single file system event.
    async fn handle_event(
        lock_manager: &Arc<FileLockManager>,
        _pid_to_agent: &Arc<RwLock<HashMap<u32, String>>>,
        project_root: &Path,
        event: Event,
    ) -> ErgataiResult<()> {
        // Only process modify events
        if !matches!(event.kind, EventKind::Modify(_)) {
            return Ok(());
        }

        // Get the file path
        let file_path = match event.paths.first() {
            Some(path) => path,
            None => return Ok(()),
        };

        // Convert to relative path
        let relative_path = match file_path.strip_prefix(project_root) {
            Ok(p) => p.to_string_lossy().to_string(),
            Err(_) => return Ok(()), // File outside project root
        };

        debug!(file_path = %relative_path, "File modification detected");

        // Note: notify crate doesn't provide PID information on most platforms.
        // On Linux, we could use inotify with additional syscalls to get PID,
        // but for now we'll use a simplified approach:
        // - Check if the file has an active lock
        // - If yes, update the hash (authorized modification)
        // - If no, record the violation (unauthorized modification)

        // Check if file has an active WRITE lock
        let has_lock = lock_manager
            .get_file_version(&relative_path)
            .map(|v| v.is_some())
            .unwrap_or(false);

        if has_lock {
            // File is locked - this is an authorized modification
            // Update the hash to reflect the new file content
            // We use "system" as agent_id since we can't determine the actual agent
            if let Err(e) = lock_manager.update_file_hash(&relative_path, "system") {
                warn!(
                    file_path = %relative_path,
                    error = %e,
                    "Failed to update file hash after authorized modification"
                );
            } else {
                debug!(
                    file_path = %relative_path,
                    "Updated file hash after authorized modification"
                );
            }
        } else {
            // File is not locked - record the violation
            warn!(
                file_path = %relative_path,
                "Unauthorized file modification detected (no active lock)"
            );

            // Record the violation for audit and monitoring
            if let Err(e) = lock_manager.record_lock_violation(&relative_path, "unknown") {
                error!(
                    file_path = %relative_path,
                    error = %e,
                    "Failed to record lock violation"
                );
            }

            // TODO: Implement file rollback using hash-based snapshots
            // This would restore the file to the last known good version
            // For now, we only record the violation and alert

            // TODO: Send notification via NATS event bus
            // event_bus.publish_unauthorized_modification(&relative_path).await?;
        }

        Ok(())
    }

    /// Stop monitoring.
    pub fn stop(&mut self) {
        if let Some(watcher) = self.watcher.take() {
            drop(watcher);
            info!("File monitor stopped");
        }
    }
}

impl Drop for FileMonitor {
    fn drop(&mut self) {
        self.stop();
    }
}
