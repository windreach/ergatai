//! ACP permission handler backed by `ergatai-lock` file access control.
//!
//! When an ACP agent requests permission to perform a tool call, this handler
//! inspects the tool kind and file locations:
//!
//! - **Read / Search / Think / Fetch / SwitchMode / Other**: auto-approve (no
//!   file lock needed for reads or non-file operations).
//! - **Edit / Delete / Move**: acquire a write lock via
//!   `ergatai_lock::auto_acquire_write_lock()` for each file location. If all
//!   locks succeed → approve; if any lock fails → reject.
//! - **Execute**: auto-approve (process execution is not file-lock controlled).
//!
//! The handler extracts the workspace_id from the agent_id (format: `{workspace_id}-agent-{counter}`)
//! and uses the workspace's work_dir as the project root for lock management.
//! This ensures each workspace has its own isolated lock manager.

use async_trait::async_trait;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::RwLock;
use tracing::{debug, warn};

use agent_client_protocol::schema::v1::{PermissionOptionKind, RequestPermissionRequest, ToolKind};
use ergatai_runtime::permission::{PermissionDecision, PermissionHandler};

/// Workspace information for lock manager initialization
pub struct WorkspaceInfo {
    pub work_dir: PathBuf,
}

/// Permission handler that enforces `ergatai-lock` file access control.
///
/// Write operations (Edit, Delete, Move) trigger `auto_acquire_write_lock()`
/// for each file in the tool call's locations. Read and non-file operations
/// are auto-approved.
///
/// Each workspace gets its own lock manager initialized with the workspace's work_dir
/// as the project root. This ensures proper path validation and lock isolation.
pub struct LockPermissionHandler {
    /// Cache of initialized lock managers per workspace (workspace_id → WorkspaceInfo)
    workspaces: Arc<RwLock<HashMap<String, WorkspaceInfo>>>,
}

impl Default for LockPermissionHandler {
    fn default() -> Self {
        Self::new()
    }
}

impl LockPermissionHandler {
    pub fn new() -> Self {
        Self {
            workspaces: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    /// Register a workspace with its work_dir for lock manager initialization
    pub async fn register_workspace(&self, workspace_id: &str, work_dir: PathBuf) {
        let mut workspaces = self.workspaces.write().await;
        debug!(workspace_id = workspace_id, work_dir = %work_dir.display(), "Registered workspace for lock management");
        workspaces.insert(workspace_id.to_string(), WorkspaceInfo { work_dir });
    }

    /// Unregister a workspace when it's deleted (prevents memory leak in long-running processes)
    pub async fn unregister_workspace(&self, workspace_id: &str) {
        let mut workspaces = self.workspaces.write().await;
        if workspaces.remove(workspace_id).is_some() {
            debug!(
                workspace_id = workspace_id,
                "Unregistered workspace from lock management"
            );
        }
    }

    /// Extract workspace_id from agent_id (format: `{workspace_id}-agent-{counter}`)
    fn extract_workspace_id(agent_id: &str) -> Option<&str> {
        // agent_id format: {workspace_id}-agent-{counter}
        // Find the last occurrence of "-agent-" to split
        agent_id.rfind("-agent-").map(|pos| &agent_id[..pos])
    }

    /// Get or initialize the lock manager for a workspace
    async fn get_lock_manager_for_workspace(
        &self,
        workspace_id: &str,
    ) -> Option<Arc<ergatai_lock::FileLockManager>> {
        // Try to get existing lock manager
        if let Ok(mgr) = ergatai_lock::get_lock_manager(workspace_id).await {
            return Some(mgr);
        }

        // Lock manager not initialized - try to initialize it
        let workspaces = self.workspaces.read().await;
        if let Some(workspace_info) = workspaces.get(workspace_id) {
            let work_dir = &workspace_info.work_dir;

            // Initialize lock manager for this workspace
            match ergatai_lock::init_file_access(workspace_id, work_dir).await {
                Ok(()) => {
                    debug!(workspace_id = workspace_id, work_dir = %work_dir.display(), "Initialized lock manager for workspace");
                    // Now try to get it again
                    if let Ok(mgr) = ergatai_lock::get_lock_manager(workspace_id).await {
                        return Some(mgr);
                    }
                }
                Err(e) => {
                    warn!(
                        error = %e,
                        workspace_id = workspace_id,
                        work_dir = %work_dir.display(),
                        "Failed to initialize lock manager for workspace"
                    );
                }
            }
        } else {
            warn!(
                workspace_id = workspace_id,
                "Workspace not registered, cannot initialize lock manager"
            );
        }

        None
    }
}

#[async_trait]
impl PermissionHandler for LockPermissionHandler {
    async fn evaluate(
        &self,
        agent_id: &str,
        session_id: &str,
        request: &RequestPermissionRequest,
    ) -> PermissionDecision {
        let tool_call = &request.tool_call;
        let kind = tool_call.fields.kind.as_ref();

        match kind {
            // File write operations → acquire write locks.
            Some(ToolKind::Edit | ToolKind::Delete | ToolKind::Move) => {
                let locations: Vec<String> = tool_call
                    .fields
                    .locations
                    .as_ref()
                    .map(|locs| {
                        locs.iter()
                            .map(|loc| loc.path.to_string_lossy().to_string())
                            .collect()
                    })
                    .unwrap_or_default();

                if locations.is_empty() {
                    debug!(
                        agent_id = %agent_id,
                        kind = ?kind,
                        "Write operation with no locations, auto-approving"
                    );
                    return select_allow_option(request);
                }

                // Extract workspace_id from agent_id
                let workspace_id = match Self::extract_workspace_id(agent_id) {
                    Some(id) => id,
                    None => {
                        warn!(
                            agent_id = %agent_id,
                            "Failed to extract workspace_id from agent_id, falling back to auto-approve"
                        );
                        return select_allow_option(request);
                    }
                };

                // Get lock manager for this workspace
                let lock_mgr = match self.get_lock_manager_for_workspace(workspace_id).await {
                    Some(mgr) => mgr,
                    None => {
                        warn!(
                            workspace_id = %workspace_id,
                            agent_id = %agent_id,
                            "Lock manager not available for workspace, falling back to auto-approve"
                        );
                        return select_allow_option(request);
                    }
                };

                for path in &locations {
                    match lock_mgr
                        .auto_acquire_write_lock(path, agent_id, session_id, workspace_id)
                        .await
                    {
                        Ok(()) => {
                            debug!(
                                path = %path,
                                agent_id = %agent_id,
                                workspace_id = %workspace_id,
                                "Acquired write lock for ACP permission"
                            );
                        }
                        Err(e) => {
                            warn!(
                                path = %path,
                                agent_id = %agent_id,
                                workspace_id = %workspace_id,
                                error = %e,
                                "Failed to acquire write lock, rejecting permission"
                            );
                            return select_reject_option(request);
                        }
                    }
                }

                select_allow_option(request)
            }

            // Read, search, think, fetch, execute, switch-mode, other → auto-approve.
            _ => select_allow_option(request),
        }
    }
}

/// Find the first `AllowOnce` or `AllowAlways` option in the request and
/// return a `PermissionDecision` selecting it. Falls back to cancel.
fn select_allow_option(request: &RequestPermissionRequest) -> PermissionDecision {
    request
        .options
        .iter()
        .find(|opt| {
            matches!(
                opt.kind,
                PermissionOptionKind::AllowOnce | PermissionOptionKind::AllowAlways
            )
        })
        .map(|opt| PermissionDecision::select(opt.option_id.to_string()))
        .unwrap_or_else(PermissionDecision::cancel)
}

/// Find the first `RejectOnce` or `RejectAlways` option and select it.
/// Falls back to cancel if no reject option exists (so we never accidentally
/// approve when the intent was to deny).
fn select_reject_option(request: &RequestPermissionRequest) -> PermissionDecision {
    request
        .options
        .iter()
        .find(|opt| {
            matches!(
                opt.kind,
                PermissionOptionKind::RejectOnce | PermissionOptionKind::RejectAlways
            )
        })
        .map(|opt| PermissionDecision::select(opt.option_id.to_string()))
        .unwrap_or_else(PermissionDecision::cancel)
}
