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
//! If the lock manager is not initialized for the project (e.g., during tests
//! or on non-Linux platforms without fanotify), the handler falls back to
//! auto-approve with a warning (fail-open).

use async_trait::async_trait;
use tracing::{debug, warn};

use agent_client_protocol::schema::v1::{PermissionOptionKind, RequestPermissionRequest, ToolKind};
use ergatai_runtime::permission::{PermissionDecision, PermissionHandler};

/// Permission handler that enforces `ergatai-lock` file access control.
///
/// Write operations (Edit, Delete, Move) trigger `auto_acquire_write_lock()`
/// for each file in the tool call's locations. Read and non-file operations
/// are auto-approved.
pub struct LockPermissionHandler {
    /// Project identifier used to look up the `FileLockManager`.
    project_id: String,
}

impl LockPermissionHandler {
    pub fn new(project_id: String) -> Self {
        Self { project_id }
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

                let lock_mgr = match ergatai_lock::get_lock_manager(&self.project_id).await {
                    Ok(mgr) => mgr,
                    Err(e) => {
                        warn!(
                            error = %e,
                            project_id = %self.project_id,
                            "Lock manager not initialized, falling back to auto-approve"
                        );
                        return select_allow_option(request);
                    }
                };

                for path in &locations {
                    match lock_mgr
                        .auto_acquire_write_lock(path, agent_id, session_id, &self.project_id)
                        .await
                    {
                        Ok(()) => {
                            debug!(
                                path = %path,
                                agent_id = %agent_id,
                                "Acquired write lock for ACP permission"
                            );
                        }
                        Err(e) => {
                            warn!(
                                path = %path,
                                agent_id = %agent_id,
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
