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
//! The handler queries the agent runtime registry to get the workspace_id from the agent_id
//! and uses the workspace's work_dir as the project root for lock management.
//! This ensures each workspace has its own isolated lock manager.

use async_trait::async_trait;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::{Mutex, RwLock};
use tracing::{debug, info, warn};

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
    /// Per-workspace initialization locks to prevent race conditions during lock manager setup
    initialization_locks: Arc<Mutex<HashMap<String, Arc<Mutex<()>>>>>,
    /// Cache of agent_id → workspace_id mappings to avoid repeated registry lookups.
    /// Agent IDs are Snowflake IDs that cannot be parsed for workspace_id, so we cache
    /// the mapping after the first lookup to reduce async registry queries.
    agent_workspace_cache: Arc<RwLock<HashMap<String, String>>>,
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
            initialization_locks: Arc::new(Mutex::new(HashMap::new())),
            agent_workspace_cache: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    /// Register a workspace with its work_dir for lock manager initialization
    pub async fn register_workspace(&self, workspace_id: i64, work_dir: PathBuf) {
        let workspace_id_str = workspace_id.to_string();
        let mut workspaces = self.workspaces.write().await;
        debug!(workspace_id = workspace_id, work_dir = %work_dir.display(), "Registered workspace for lock management");
        workspaces.insert(
            workspace_id_str.clone(),
            WorkspaceInfo {
                work_dir: work_dir.clone(),
            },
        );

        // Initialize lock manager for this workspace eagerly
        // This ensures locks are available when agents request permissions
        drop(workspaces); // Release write lock before calling init_file_access
        match ergatai_lock::init_file_access(&workspace_id_str, &work_dir).await {
            Ok(()) => {
                info!(workspace_id = workspace_id_str, work_dir = %work_dir.display(), "Initialized lock manager for workspace");
            }
            Err(e) => {
                warn!(
                    workspace_id = workspace_id_str,
                    work_dir = %work_dir.display(),
                    error = %e,
                    "Failed to initialize lock manager for workspace (will retry on demand)"
                );
            }
        }
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
        // Also clean up the initialization lock to prevent memory leak
        let mut init_locks = self.initialization_locks.lock().await;
        init_locks.remove(workspace_id);
        // Clean up agent workspace cache entries for this workspace
        let mut cache = self.agent_workspace_cache.write().await;
        let keys_to_remove: Vec<String> = cache
            .iter()
            .filter(|(_, ws_id)| ws_id.as_str() == workspace_id)
            .map(|(agent_id, _)| agent_id.clone())
            .collect();
        let removed_count = keys_to_remove.len();
        for key in keys_to_remove {
            cache.remove(&key);
        }
        if removed_count > 0 {
            debug!(
                workspace_id = workspace_id,
                entries_removed = removed_count,
                "Cleaned up agent workspace cache entries"
            );
        }
    }

    /// Extract workspace_id from agent_id by looking up the agent in the runtime registry.
    ///
    /// Since agent_id is now a Snowflake ID (e.g., `agent_502816809136_000_0000`),
    /// we cannot extract workspace_id from the string format. Instead, we query
    /// the agent runtime registry to get the agent's workspace_id.
    ///
    /// Uses a cache to avoid repeated registry lookups for the same agent_id.
    async fn extract_workspace_id(&self, agent_id: &str) -> Option<String> {
        // Check cache first
        {
            let cache = self.agent_workspace_cache.read().await;
            if let Some(workspace_id) = cache.get(agent_id) {
                debug!(
                    agent_id = %agent_id,
                    workspace_id = %workspace_id,
                    "Cache hit for agent workspace lookup"
                );
                return Some(workspace_id.clone());
            }
        }

        // Cache miss - query runtime registry
        let runtime = ergatai_runtime::get_agent_runtime();

        // Look up the agent in the registry
        let result = if let Some(agent_info) = runtime.get_agent(agent_id).await {
            let workspace_id = agent_info.workspace_id.clone();
            // Populate cache
            let mut cache = self.agent_workspace_cache.write().await;
            cache.insert(agent_id.to_string(), workspace_id.clone());
            debug!(
                agent_id = %agent_id,
                workspace_id = %workspace_id,
                "Populated cache for agent workspace lookup"
            );
            Some(workspace_id)
        } else {
            debug!(
                agent_id = %agent_id,
                "Agent not found in runtime registry, cannot extract workspace_id"
            );
            None
        };

        result
    }

    /// Get or initialize the lock manager for a workspace
    async fn get_lock_manager_for_workspace(
        &self,
        workspace_id: &str,
    ) -> Option<Arc<ergatai_lock::FileLockManager>> {
        // Try to get existing lock manager (fast path)
        if let Ok(mgr) = ergatai_lock::get_lock_manager(workspace_id).await {
            return Some(mgr);
        }

        // Lock manager not initialized - acquire per-workspace initialization lock
        // to prevent race conditions when multiple tasks try to initialize simultaneously
        let init_lock = {
            let mut locks = self.initialization_locks.lock().await;
            locks
                .entry(workspace_id.to_string())
                .or_insert_with(|| Arc::new(Mutex::new(())))
                .clone()
        };

        // Hold the initialization lock while checking and initializing
        let _guard = init_lock.lock().await;

        // Double-check after acquiring lock (another task may have initialized while we waited)
        if let Ok(mgr) = ergatai_lock::get_lock_manager(workspace_id).await {
            return Some(mgr);
        }

        // Still not initialized - try to initialize it
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

                // Extract workspace_id from agent_id by querying runtime registry (with cache)
                let workspace_id = match self.extract_workspace_id(agent_id).await {
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
                let lock_mgr = match self.get_lock_manager_for_workspace(&workspace_id).await {
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
                        .auto_acquire_write_lock(path, agent_id, session_id, &workspace_id)
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[tokio::test]
    async fn test_extract_workspace_id_from_registry() {
        // Since agent_id is now a Snowflake ID, we cannot extract workspace_id
        // from the string format. Instead, we query the runtime registry.
        // This test verifies that the function returns None for non-existent agents.
        let handler = LockPermissionHandler::new();
        let result = handler
            .extract_workspace_id("agent_502816809136_000_0000")
            .await;
        assert_eq!(result, None, "Non-existent agent should return None");

        let result = handler.extract_workspace_id("").await;
        assert_eq!(result, None, "Empty agent_id should return None");
    }

    #[tokio::test]
    async fn test_register_and_unregister_workspace() {
        let handler = LockPermissionHandler::new();
        let work_dir = PathBuf::from("/tmp/test-workspace");

        // 注册工作区 (使用 i64 ID)
        handler.register_workspace(1i64, work_dir.clone()).await;

        // 验证工作区已注册 (内部存储为 String)
        let workspaces = handler.workspaces.read().await;
        assert!(workspaces.contains_key("1"));
        assert_eq!(workspaces.get("1").unwrap().work_dir, work_dir);
        drop(workspaces);

        // 注销工作区
        handler.unregister_workspace("1").await;

        // 验证工作区已移除
        let workspaces = handler.workspaces.read().await;
        assert!(!workspaces.contains_key("1"));
    }

    #[tokio::test]
    async fn test_unregister_nonexistent_workspace() {
        let handler = LockPermissionHandler::new();

        // 注销不存在的工作区不应该 panic
        handler.unregister_workspace("999999").await;
    }

    #[tokio::test]
    async fn test_initialization_locks_cleanup() {
        let handler = LockPermissionHandler::new();
        let work_dir = PathBuf::from("/tmp/test-workspace");

        // 注册工作区 (使用 i64 ID)
        handler.register_workspace(1i64, work_dir).await;

        // 触发初始化锁的创建（通过 get_lock_manager_for_workspace）
        // 注意：由于 ergatai_lock 未初始化，这会返回 None，但会创建初始化锁
        let _ = handler.get_lock_manager_for_workspace("1").await;

        // 验证初始化锁已创建
        let init_locks = handler.initialization_locks.lock().await;
        assert!(init_locks.contains_key("1"));
        drop(init_locks);

        // 注销工作区
        handler.unregister_workspace("1").await;

        // 验证初始化锁也已清理
        let init_locks = handler.initialization_locks.lock().await;
        assert!(!init_locks.contains_key("1"));
    }

    #[tokio::test]
    async fn test_multiple_workspace_isolation() {
        let handler = LockPermissionHandler::new();

        // 注册多个工作区 (使用 i64 ID)
        handler
            .register_workspace(1i64, PathBuf::from("/tmp/ws1"))
            .await;
        handler
            .register_workspace(2i64, PathBuf::from("/tmp/ws2"))
            .await;

        // 验证工作区已注册 (内部存储为 String)
        {
            let workspaces = handler.workspaces.read().await;
            assert!(workspaces.contains_key("1"));
            assert!(workspaces.contains_key("2"));
        }

        // 注销一个工作区
        handler.unregister_workspace("1").await;

        // 验证只移除了指定的工作区
        {
            let workspaces = handler.workspaces.read().await;
            assert!(!workspaces.contains_key("1"));
            assert!(workspaces.contains_key("2"));
        }
    }

    #[test]
    fn test_select_allow_option() {
        use agent_client_protocol::schema::v1::{
            PermissionOption, PermissionOptionKind, RequestPermissionRequest, SessionId,
            ToolCallUpdate, ToolCallUpdateFields,
        };

        let tool_call = ToolCallUpdate::new("test-tool", ToolCallUpdateFields::new());
        let options = vec![
            PermissionOption::new("allow-once", "Allow once", PermissionOptionKind::AllowOnce),
            PermissionOption::new("reject", "Reject", PermissionOptionKind::RejectOnce),
        ];
        let request =
            RequestPermissionRequest::new(SessionId::new("test-session"), tool_call, options);

        let decision = select_allow_option(&request);
        assert_eq!(decision.option_id.as_deref(), Some("allow-once"));
    }

    #[test]
    fn test_select_reject_option() {
        use agent_client_protocol::schema::v1::{
            PermissionOption, PermissionOptionKind, RequestPermissionRequest, SessionId,
            ToolCallUpdate, ToolCallUpdateFields,
        };

        let tool_call = ToolCallUpdate::new("test-tool", ToolCallUpdateFields::new());
        let options = vec![
            PermissionOption::new("allow", "Allow", PermissionOptionKind::AllowOnce),
            PermissionOption::new(
                "reject-once",
                "Reject once",
                PermissionOptionKind::RejectOnce,
            ),
        ];
        let request =
            RequestPermissionRequest::new(SessionId::new("test-session"), tool_call, options);

        let decision = select_reject_option(&request);
        assert_eq!(decision.option_id.as_deref(), Some("reject-once"));
    }
}
