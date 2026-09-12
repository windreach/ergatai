//! AgentRuntime — high-level facade for agent management.
//!
//! Combines a backend, state tracking, and optional MCP integration into a
//! single API. This is what callers interact with instead of using the raw
//! backend trait directly.
//!
//! The runtime also provides a global singleton (`get_agent_runtime()`) to fix
//! the AgentLauncher lifetime bug — all components share the same runtime
//! instance instead of creating ephemeral managers.

use std::collections::HashMap;
use std::sync::{Arc, OnceLock};

use tokio::sync::{Mutex, RwLock};
use tokio_util::sync::CancellationToken;
use tracing::{debug, error, info, warn};

use ergatai_error::{ErgataiError, ErgataiResult};

use crate::agent_registry::AgentRegistry;
use crate::backend::AcpBackendInterface;
use crate::types::{AgentHandle, AgentInfo, WaitResult, WorkspaceSpec};

// ── Global singleton ──

static AGENT_RUNTIME: OnceLock<Arc<AgentRuntime>> = OnceLock::new();

/// Get the global AgentRuntime singleton.
///
/// Initializes with `AcpBackend` (ACP protocol, structured communication).
/// Call `init_agent_runtime()` instead if you need a custom backend.
pub fn get_agent_runtime() -> Arc<AgentRuntime> {
    AGENT_RUNTIME
        .get_or_init(|| {
            let backend = Arc::new(crate::backends::acp::AcpBackend::new());
            Arc::new(AgentRuntime::new(backend))
        })
        .clone()
}

/// Initialize the global AgentRuntime with a custom backend.
///
/// Returns `Err` if already initialized. Call this from `main()` before
/// any other component accesses the runtime.
pub fn init_agent_runtime(
    backend: Arc<dyn AcpBackendInterface>,
) -> ErgataiResult<Arc<AgentRuntime>> {
    let runtime = Arc::new(AgentRuntime::new(backend));
    AGENT_RUNTIME
        .set(runtime.clone())
        .map_err(|_| ErgataiError::internal("AgentRuntime already initialized".to_string()))?;
    Ok(runtime)
}

// ── AgentRuntime ──

/// High-level facade for agent management.
///
/// Wraps a backend + agent registry.
pub struct AgentRuntime {
    backend: Arc<dyn AcpBackendInterface>,
    /// 统一 agent 注册表 — 封装所有 5 个索引（primary, uuid, mcp, stable_id, streaks）。
    /// 所有 insert/remove 操作原子性地更新所有反向索引。
    registry: AgentRegistry,
    /// Queue of MCP agent IDs waiting to be bound to a runtime agent.
    /// Stores (mcp_agent_id, agent_identifier) tuples for precise binding.
    /// Populated when an MCP agent connects before runtime discovery finds agents.
    /// Drained after each successful discovery cycle.
    pending_mcp: Arc<RwLock<Vec<(String, String)>>>,
    /// Mutex to serialize binding operations.
    /// Ensures that even if multiple MCP agents connect concurrently,
    /// they are bound sequentially in creation-time order.
    binding_mutex: Arc<Mutex<()>>,
    /// CRITICAL FIX: CancellationToken for graceful shutdown.
    /// When cancelled, all spawn_monitor tasks will exit cleanly instead of
    /// waiting for agents to exit or timing out. Prevents task leaks during shutdown.
    shutdown_token: CancellationToken,
    /// CONCURRENT FIX: Track monitor task JoinHandles so `shutdown()` can join them.
    /// Without this, monitor tasks are detached and may still be running after
    /// shutdown() returns, racing with process exit or subsequent runtime reuse.
    /// Uses std::sync::Mutex because `spawn_monitor()` is a sync fn called from
    /// async contexts — tokio::sync::Mutex::blocking_lock would panic there.
    monitor_handles: std::sync::Arc<std::sync::Mutex<HashMap<String, tokio::task::JoinHandle<()>>>>,
}

impl AgentRuntime {
    /// Create a new runtime with the given backend.
    pub fn new(backend: Arc<dyn AcpBackendInterface>) -> Self {
        Self {
            backend,
            registry: AgentRegistry::new(),
            pending_mcp: Arc::new(RwLock::new(Vec::new())),
            binding_mutex: Arc::new(Mutex::new(())),
            shutdown_token: CancellationToken::new(),
            monitor_handles: std::sync::Arc::new(std::sync::Mutex::new(HashMap::new())),
        }
    }

    /// Get the shutdown token for graceful shutdown coordination.
    /// Cancel this token to signal all monitor tasks to exit cleanly.
    pub fn shutdown_token(&self) -> CancellationToken {
        self.shutdown_token.clone()
    }

    /// Get a reference to the underlying backend.
    pub fn backend(&self) -> &Arc<dyn AcpBackendInterface> {
        &self.backend
    }

    /// Initialize the backend.
    pub async fn initialize(&self) -> ErgataiResult<()> {
        self.backend.initialize().await
    }

    /// Launch an agent.
    ///
    /// Creates a workspace, starts the agent process, registers it, and
    /// spawns a background monitor.
    pub async fn launch_agent(
        &self,
        spec: WorkspaceSpec,
        command: &str,
        instruction: Option<&str>,
    ) -> ErgataiResult<String> {
        // Check if workspace already exists (e.g., created by CLI POST /api/v1/workspaces).
        // Avoid calling create_workspace again to prevent duplicate workspace entries.
        let existing_workspaces = self.backend.list_workspaces().await.unwrap_or_default();
        let workspace = if existing_workspaces.iter().any(|w| w.id == spec.id) {
            debug!(workspace_id = spec.id, "Reusing existing workspace");
            let mut ws = existing_workspaces
                .into_iter()
                .find(|w| w.id == spec.id)
                .unwrap();
            // Ensure work_dir from spec is in metadata (may be missing if
            // server restarted and in-memory cache was lost).
            if !ws.metadata.contains_key("work_dir") {
                ws.metadata.insert(
                    "work_dir".to_string(),
                    spec.work_dir.to_string_lossy().to_string(),
                );
            }
            ws
        } else {
            self.backend.create_workspace(spec.clone()).await?
        };

        // Pre-compute agent_id for workspace registration before starting the agent.
        // This eliminates the race window where agent could modify files before workspace is registered.
        // Note: next_agent_id() increments the counter, so start_agent() must use this pre-computed ID.
        let agent_id = self.backend.next_agent_id(&workspace.id);

        // Register workspace boundary BEFORE starting the agent to prevent race condition.
        // Convert absolute work_dir to relative path (relative to project root)
        let workspace_dir = if let Ok(relative) = std::path::Path::new(&spec.work_dir)
            .strip_prefix(std::env::current_dir().unwrap_or_default())
        {
            relative.to_string_lossy().to_string()
        } else {
            spec.work_dir.to_string_lossy().to_string()
        };

        if let Err(e) =
            ergatai_lock::register_workspace_for_project("default", &agent_id, &workspace_dir).await
        {
            warn!(
                agent_id = %agent_id,
                workspace = %workspace_dir,
                error = %e,
                "Failed to pre-register workspace boundary (non-fatal, continuing)"
            );
        } else {
            debug!(
                agent_id = %agent_id,
                workspace = %workspace_dir,
                "Pre-registered workspace boundary before agent start"
            );
        }

        // Pass the pre-computed agent_id via workspace metadata
        let mut workspace_with_id = workspace.clone();
        workspace_with_id
            .metadata
            .insert("precomputed_agent_id".to_string(), agent_id.clone());

        let handle = self
            .backend
            .start_agent(&workspace_with_id, command, instruction)
            .await?;

        let agent_id = handle.agent_id.clone();
        let agent_uuid = uuid::Uuid::new_v4().to_string();
        let now = chrono::Utc::now();

        // Generate MCP agent ID for ACP agents to enable cross-protocol addressing.
        // Format: "acp-{workspace_id}-{counter}" (e.g., "acp-ws1-1")
        // This allows ACP agents to be addressable via MCP tools like send_message.
        let mcp_agent_id = {
            let counter = agent_id.split('-').next_back().unwrap_or(&agent_id);
            format!("acp-{}-{}", spec.id, counter)
        };

        let info = AgentInfo {
            agent_uuid: agent_uuid.clone(),
            agent_id: agent_id.clone(),
            stable_id: handle.metadata.get("ergatai_agent_id").cloned(),
            workspace_id: spec.id,
            handle: handle.clone(),
            lifecycle: crate::agent_lifecycle::AgentLifecycleState::Running {
                task_id: None,
                started_at: now,
                last_heartbeat: now,
            },
            task_id: None,
            created_at: now,
            mcp_agent_id: Some(mcp_agent_id.clone()),
            last_heartbeat: now,
            profile: None,
            capabilities: Vec::new(),
            state_changed_at: now,
            state_history: Vec::new(),
        };

        self.registry.insert(info).await;

        self.spawn_monitor(agent_id.clone(), handle);

        info!(agent_id = agent_id, "Agent launched");
        Ok(agent_id)
    }

    /// Inject a message into a running agent.
    ///
    /// Uses the backend to inject text directly into the agent's input.
    /// Supports both runtime IDs (e.g., "%198") and MCP IDs (e.g., "opencode@abcd1234")
    /// — MCP IDs are resolved to runtime IDs via the `mcp_index` mapping.
    pub async fn inject_message(&self, agent_id: &str, message: &str) -> ErgataiResult<()> {
        // Resolve MCP ID to runtime ID if needed
        let runtime_id = self
            .resolve_agent_id(agent_id)
            .await
            .ok_or_else(|| ErgataiError::internal(format!("Agent {} not found", agent_id)))?;

        let info = self
            .registry
            .get(&runtime_id)
            .await
            .ok_or_else(|| ErgataiError::internal(format!("Agent {} not found", runtime_id)))?;

        // Deliver via backend injection
        self.backend.inject_message(&info.handle, message).await
    }

    /// Inject a message and optional image attachments into a running agent.
    pub async fn inject_message_with_images(
        &self,
        agent_id: &str,
        message: &str,
        images: Vec<crate::types::AgentImage>,
    ) -> ErgataiResult<()> {
        let runtime_id = self
            .resolve_agent_id(agent_id)
            .await
            .ok_or_else(|| ErgataiError::internal(format!("Agent {} not found", agent_id)))?;

        let info = self
            .registry
            .get(&runtime_id)
            .await
            .ok_or_else(|| ErgataiError::internal(format!("Agent {} not found", runtime_id)))?;

        self.backend
            .inject_message_with_images(&info.handle, message, &images)
            .await
    }

    /// Stop an agent.
    pub async fn stop_agent(&self, agent_id: &str) -> ErgataiResult<()> {
        // 原子移除 — 自动清理所有反向索引（uuid, mcp, stable_id, streaks）
        let info = self
            .registry
            .remove(agent_id)
            .await
            .ok_or_else(|| ErgataiError::internal(format!("Agent {} not found", agent_id)))?;

        if let Err(e) = self.backend.stop_agent(&info.handle).await {
            warn!(agent_id = agent_id, error = %e, "Failed to stop agent backend");
        }

        if let Some(handle) = self.monitor_handles.lock().unwrap().remove(agent_id) {
            handle.abort();
        }

        // NOTE: Do NOT call cleanup_workspace here. The workspace may be shared
        // by multiple agents. Workspace lifecycle should be managed explicitly
        // via a dedicated delete_workspace API, not implicitly when one agent stops.

        info!(agent_id = agent_id, "Agent stopped");
        Ok(())
    }

    /// List all registered agents.
    pub async fn list_agents(&self) -> Vec<AgentInfo> {
        self.registry.list().await
    }

    /// Get a specific agent by ID.
    pub async fn get_agent(&self, agent_id: &str) -> Option<AgentInfo> {
        self.registry.get(agent_id).await
    }

    /// Set the task ID for a runtime agent (for DAG tracking).
    pub async fn set_task_id(&self, agent_id: &str, task_id: String) -> ErgataiResult<()> {
        let mut guard = self.registry.write().await;
        let info = guard
            .get_mut(agent_id)
            .ok_or_else(|| ErgataiError::internal(format!("Agent {} not found", agent_id)))?;
        info.task_id = Some(task_id);
        Ok(())
    }

    /// Register an externally-discovered agent.
    ///
    /// This allows agents started outside the normal `launch_agent()` flow
    /// (e.g., externally managed agents) to receive messages via the runtime
    /// delivery chain.
    ///
    /// CRITICAL FIX: Spawn lifecycle monitor for the registered agent to prevent
    /// zombie state accumulation when the agent exits. Previously, agents registered
    /// through this path had no monitor, causing memory leaks.
    pub async fn register_discovered_agent(
        &self,
        agent_id: String,
        handle: AgentHandle,
    ) -> ErgataiResult<()> {
        let agent_uuid = uuid::Uuid::new_v4().to_string();
        let now = chrono::Utc::now();
        let stable_id = handle.metadata.get("ergatai_agent_id").cloned();
        let info = AgentInfo {
            agent_uuid: agent_uuid.clone(),
            agent_id: agent_id.clone(),
            stable_id,
            workspace_id: handle.workspace.id.clone(),
            handle: handle.clone(),
            lifecycle: crate::agent_lifecycle::AgentLifecycleState::Running {
                task_id: None,
                started_at: now,
                last_heartbeat: now,
            },
            task_id: None,
            created_at: now,
            mcp_agent_id: None,
            last_heartbeat: now,
            profile: None,
            capabilities: Vec::new(),
            state_changed_at: now,
            state_history: Vec::new(),
        };

        // 原子插入 — 自动清理旧条目的反向索引（如果 agent_id 已存在）
        self.registry.insert(info).await;

        // CRITICAL FIX: Spawn lifecycle monitor to track agent exit and cleanup
        self.spawn_monitor(agent_id.clone(), handle);

        debug!(agent_id = agent_id, "Registered discovered agent");
        Ok(())
    }

    /// Scan the backend for running agents and register any new ones.
    ///
    /// Returns the number of newly registered agents. Already-registered
    /// agents are skipped (idempotent).
    ///
    /// Each agent is registered atomically (single write-lock acquisition)
    /// to prevent TOCTOU races when this method is called concurrently
    /// (e.g., from the periodic re-discovery loop and manual triggers).
    ///
    /// CRITICAL BUG FIX: Previously, discovered agents had no lifecycle monitor,
    /// causing zombie state accumulation when they exited. Now spawns a monitor
    /// for each newly discovered agent.
    pub async fn discover_and_register_agents(&self) -> ErgataiResult<usize> {
        let discovered = self.backend.discover_agents().await?;
        let mut count = 0;
        let mut new_agents = Vec::new();

        // 获取 WriteGuard — 持有所有索引的写锁，确保原子性
        let mut guard = self.registry.write().await;

        for (agent_id, handle) in discovered {
            // If this workspace already has an agent registered (e.g., via launch_agent),
            // validate the agent is still the same and update its handle metadata with
            // the latest discovery data. If the agent changed, re-register.
            //
            // All mutations happen under the SAME write-lock acquisition to prevent
            // state changes between drop/re-acquire (previously: drop → remove → re-acquire
            // created a window where another task could insert a duplicate workspace entry).
            //
            // Track MCP binding from the old entry so we can preserve it across restarts.
            let mut preserved_mcp_id: Option<String> = None;
            let existing_match: Option<(String, Option<String>, Option<String>)> = guard
                .values()
                .find(|info| info.workspace_id == handle.workspace.id)
                .map(|info| {
                    (
                        info.agent_id.clone(),
                        info.handle.metadata.get("ergatai_agent_id").cloned(),
                        handle.metadata.get("ergatai_agent_id").cloned(),
                    )
                });

            if let Some((old_agent_id, existing_agent_key, new_agent_key)) = existing_match {
                // Check if agent changed (process died and was recreated)
                if existing_agent_key != new_agent_key {
                    warn!(
                        workspace_id = %handle.workspace.id,
                        old_agent = ?existing_agent_key,
                        new_agent = ?new_agent_key,
                        "Agent changed — process likely died and was recreated. Re-registering agent."
                    );
                    // 原子移除 — 自动清理所有反向索引
                    if let Some(old_info) = guard.remove(&old_agent_id) {
                        // Preserve MCP binding across restart — the MCP client is still
                        // connected, just the underlying agent process was recreated.
                        preserved_mcp_id = old_info.mcp_agent_id.clone();
                    }
                } else {
                    // Same agent - update metadata but preserve MCP binding.
                    // The ACP backend re-discovery returns workspace ID format
                    // (e.g., "start-opencode-3-agent-1"). If the agent is already
                    // MCP-bound, keep the MCP URL path name as ergatai_agent_id
                    // to maintain ID consistency across list_agents and message routing.
                    if let Some(eai) = handle.metadata.get("ergatai_agent_id") {
                        if let Some(existing) = guard.get_mut(&old_agent_id) {
                            if existing.mcp_agent_id.is_none() {
                                // Not MCP-bound — safe to use workspace ID
                                existing
                                    .handle
                                    .metadata
                                    .insert("ergatai_agent_id".to_string(), eai.clone());
                                existing.stable_id = Some(eai.clone());
                            }
                            // MCP-bound — keep mcp_agent_id as ergatai_agent_id
                            // (already set during binding). Update stable_id to match.
                            else if let Some(ref mcp_id) = existing.mcp_agent_id {
                                existing.stable_id = Some(mcp_id.clone());
                            }
                        }
                    }
                    continue;
                }
            }
            // Atomic check-and-insert under a single write lock acquisition.
            // entry().or_insert() ensures no TOCTOU gap between contains_key and insert.
            guard.entry(agent_id.clone()).or_insert_with(|| {
                count += 1;
                let agent_uuid = uuid::Uuid::new_v4().to_string();
                let now = chrono::Utc::now();
                // If the previous entry had an MCP binding (process restart case),
                // preserve it. Use MCP path name as ergatai_agent_id + stable_id
                // for ID consistency.
                let (mcp_agent_id, ergatai_id, stable_id) =
                    if let Some(ref mcp_id) = preserved_mcp_id {
                        (
                            Some(mcp_id.clone()),
                            Some(mcp_id.clone()),
                            Some(mcp_id.clone()),
                        )
                    } else {
                        (
                            None,
                            handle.metadata.get("ergatai_agent_id").cloned(),
                            handle.metadata.get("ergatai_agent_id").cloned(),
                        )
                    };
                let mut new_handle = handle;
                if let Some(ref eid) = ergatai_id {
                    new_handle
                        .metadata
                        .insert("ergatai_agent_id".to_string(), eid.clone());
                }
                new_agents.push((agent_id.clone(), agent_uuid.clone(), new_handle.clone()));
                AgentInfo {
                    agent_uuid: agent_uuid.clone(),
                    agent_id: agent_id.clone(),
                    stable_id,
                    workspace_id: new_handle.workspace.id.clone(),
                    handle: new_handle,
                    lifecycle: crate::agent_lifecycle::AgentLifecycleState::Running {
                        task_id: None,
                        started_at: now,
                        last_heartbeat: now,
                    },
                    task_id: None,
                    created_at: now,
                    mcp_agent_id,
                    last_heartbeat: now,
                    profile: None,
                    capabilities: Vec::new(),
                    state_changed_at: now,
                    state_history: Vec::new(),
                }
            });
        }

        // 重建所有反向索引，确保一致性
        guard.reconcile_indices();

        drop(guard);

        // CRITICAL BUG FIX: Spawn lifecycle monitor for each newly discovered agent.
        // Previously, discovered agents had no monitor, causing zombie state accumulation.
        for (agent_id, _uuid, handle) in new_agents {
            self.spawn_monitor(agent_id, handle);
        }

        if count > 0 {
            info!(count = count, "Discovered and registered new agents");
        }

        // After discovery, try to bind pending MCP agents to newly discovered runtime agents
        if count > 0 {
            self.drain_pending_bindings().await;
        }

        Ok(count)
    }

    /// Prune agents that have been observed as Zombie or Dead for 2 consecutive health checks.
    ///
    /// Called from the periodic discovery loop (main.rs). One bad sample isn't
    /// enough — a process briefly in Z state during exit is normal.
    ///
    /// Returns the list of agent IDs that were pruned in this pass, so callers
    /// can perform follow-up cleanup (e.g. dropping rate-limiter windows).
    pub async fn prune_unhealthy_agents(&self) -> Vec<String> {
        // Step 1: Snapshot agent IDs + handles (release read lock before async calls)
        let agents_snapshot: Vec<(String, AgentHandle)> = {
            let guard = self.registry.read().await;
            guard
                .iter()
                .map(|(id, info)| (id.clone(), info.handle.clone()))
                .collect()
        };

        if agents_snapshot.is_empty() {
            return Vec::new();
        }

        // Step 2: Check liveness without holding any lock
        let mut dead_now: Vec<String> = Vec::new();
        let mut healthy: Vec<String> = Vec::new();
        for (agent_id, handle) in agents_snapshot {
            match self.backend.is_alive(&handle).await {
                Ok(true) => healthy.push(agent_id),
                Ok(false) => dead_now.push(agent_id),
                Err(e) => {
                    warn!(agent_id = %dead_now.last().unwrap_or(&agent_id), error = %e,
                          "is_alive check failed, treating as dead");
                    dead_now.push(agent_id);
                }
            }
        }

        // Step 3: Reset streaks for healthy agents, increment for dead
        // 使用 with_streaks 批量操作
        let pruned: Vec<String> = self
            .registry
            .with_streaks(|streaks| {
                for id in &healthy {
                    streaks.remove(id);
                }
                for id in &dead_now {
                    *streaks.entry(id.clone()).or_insert(0) += 1;
                }

                // Step 4: Collect agents that reached threshold (2 consecutive dead observations)
                dead_now
                    .iter()
                    .filter(|id| streaks.get(*id).copied().unwrap_or(0) >= 2)
                    .cloned()
                    .collect()
            })
            .await;

        if pruned.is_empty() {
            return pruned;
        }

        // Step 5: Remove pruned agents from registry — 原子移除，自动清理所有反向索引
        {
            let mut guard = self.registry.write().await;
            for agent_id in &pruned {
                guard.remove(agent_id);
            }
            // No need to call reconcile_indices() here — each remove() call
            // already cleans up all reverse indices via clean_reverse_indices()
        }

        info!(
            count = pruned.len(),
            agents = ?pruned,
            "Pruned unhealthy agents after 2 consecutive dead observations"
        );

        pruned
    }

    // ── MCP-to-Runtime agent ID binding ──

    /// Try to bind an MCP agent ID to an unmapped runtime agent.
    ///
    /// Uses FIFO strategy: finds the first runtime agent without an MCP binding
    /// and associates it with the given MCP ID. If no unmapped runtime agent
    /// exists, the MCP ID is added to the pending queue for later binding
    /// (when discovery finds new agents).
    ///
    /// Returns the runtime agent ID if binding succeeded, or `None` if queued.
    ///
    /// CRITICAL FIX: Optimized lock acquisition to eliminate TOCTOU race.
    /// Previously, read locks were dropped before acquiring write lock for cleanup,
    /// creating a window where state could change. Now collects cleanup info first,
    /// then performs all mutations without intermediate lock releases.
    pub async fn try_bind_mcp_agent(&self, mcp_agent_id: &str) -> Option<String> {
        // Acquire binding lock to serialize binding operations
        // This ensures that even with concurrent MCP connections,
        // bindings happen sequentially in creation-time order
        let _guard = self.binding_mutex.lock().await;

        let mut guard = self.registry.write().await;
        if let Some(runtime_id) = guard.resolve_mcp_id(mcp_agent_id) {
            if guard.contains_key(runtime_id) {
                debug!(
                    mcp_agent_id = mcp_agent_id,
                    runtime_id = runtime_id,
                    "MCP agent already bound (verified)"
                );
                return Some(runtime_id.to_string());
            }

            warn!(
                mcp_agent_id = mcp_agent_id,
                runtime_id = runtime_id,
                "Stale MCP binding detected (runtime agent gone), cleaning up"
            );
            // Remove stale entry in O(1) instead of O(n) reconcile_indices()
            guard.remove_stale_mcp_binding(mcp_agent_id);
        }

        // Sequential binding algorithm
        // Find the FIRST unbound runtime agent (by discovery order)
        // This assumes panes are opened one at a time and MCP connects shortly after
        let mut unbound_agents: Vec<_> = guard
            .values()
            .filter(|info| info.mcp_agent_id.is_none())
            .cloned()
            .collect();

        if unbound_agents.is_empty() {
            // No unmapped runtime agent — add to pending queue
            drop(guard);
            let mut pending = self.pending_mcp.write().await;
            if !pending.iter().any(|(id, _)| id == mcp_agent_id) {
                pending.push((mcp_agent_id.to_string(), String::new()));
                info!(
                    mcp_agent_id = mcp_agent_id,
                    pending_count = pending.len(),
                    "No unmapped runtime agent, queued MCP agent for later binding"
                );
            }
            return None;
        }

        // Sort by creation time (earliest first) - sequential binding
        // The first unbound agent should match the first MCP connection
        unbound_agents.sort_by_key(|a| a.created_at);

        // Bind to the earliest unbound agent
        let matched_agent = unbound_agents.into_iter().next()?;
        let runtime_id = matched_agent.agent_id.clone();

        // Update the registry — agent may have been removed between sort and bind
        if let Some(info) = guard.get_mut(&runtime_id) {
            info.mcp_agent_id = Some(mcp_agent_id.to_string());
            // Unify ergatai_agent_id to MCP URL path name for consistent IDs
            // across list_agents, message routing, and reply targets.
            info.handle
                .metadata
                .insert("ergatai_agent_id".to_string(), mcp_agent_id.to_string());
            // 重建反向索引以包含新的 MCP 绑定
            guard.reconcile_indices();
        } else {
            warn!(
                runtime_id = %runtime_id,
                mcp_agent_id = mcp_agent_id,
                "Agent disappeared during binding, aborting"
            );
            return None;
        }

        info!(
            mcp_agent_id = mcp_agent_id,
            runtime_id = runtime_id,
            "Bound MCP agent to runtime agent (sequential algorithm with lock)"
        );
        Some(runtime_id)
    }

    /// Try to bind an MCP agent ID to a runtime agent using agent_identifier.
    ///
    /// This method matches MCP connections to runtime agents based on the
    /// ERGATAI_AGENT_ID environment variable set in startup scripts.
    /// Returns the runtime agent ID if binding succeeded.
    pub async fn try_bind_mcp_agent_with_identifier(
        &self,
        mcp_agent_id: &str,
        agent_identifier: &str,
    ) -> Option<String> {
        let _guard = self.binding_mutex.lock().await;

        // Check if already bound — 使用 ReadGuard 获取一致的快照
        {
            let guard = self.registry.read().await;
            if let Some(runtime_id) = guard.resolve_mcp_id(mcp_agent_id) {
                // HIGH BUG FIX: Verify the runtime_id still exists in registry.
                if guard.contains_key(runtime_id) {
                    debug!(
                        mcp_agent_id = mcp_agent_id,
                        runtime_id = runtime_id,
                        "MCP agent already bound (verified)"
                    );
                    return Some(runtime_id.to_string());
                } else {
                    warn!(
                        mcp_agent_id = mcp_agent_id,
                        runtime_id = runtime_id,
                        "Stale MCP binding detected (runtime agent gone), cleaning up"
                    );
                    drop(guard);
                    // Clean up stale binding
                    let mut write_guard = self.registry.write().await;
                    write_guard.reconcile_indices();
                }
            }
        }

        // Find runtime agent with matching ergatai_agent_id.
        // The ACP backend sets ergatai_agent_id to the workspace ID format
        // (e.g., "start-opencode-3-agent-1"), while agent_identifier comes from
        // the MCP URL path (e.g., "agent-1").
        //
        // Strategy: prefer exact match first; fall back to suffix match only if
        // unambiguous (exactly one match). Multiple suffix matches are ambiguous
        // and must NOT silently route to the wrong agent.
        let guard = self.registry.read().await;
        let suffix = format!("-{}", agent_identifier);
        let matched_agent = guard
            .values()
            .find(|info| {
                info.handle
                    .metadata
                    .get("ergatai_agent_id")
                    .is_some_and(|id| id == agent_identifier)
            })
            .or_else(|| {
                // Collect suffix matches — only use if exactly one
                let suffix_matches: Vec<_> = guard
                    .values()
                    .filter(|info| {
                        info.handle
                            .metadata
                            .get("ergatai_agent_id")
                            .is_some_and(|id| id.ends_with(&suffix))
                    })
                    .collect();
                if suffix_matches.len() == 1 {
                    suffix_matches.into_iter().next()
                } else {
                    if suffix_matches.len() > 1 {
                        warn!(
                            agent_identifier = agent_identifier,
                            match_count = suffix_matches.len(),
                            "Ambiguous suffix match — multiple agents match, refusing to route"
                        );
                    }
                    None
                }
            });

        let matched_agent = match matched_agent {
            Some(agent) => agent.clone(),
            None => {
                // No matching runtime agent found yet - add to pending queue
                // for later binding when discovery completes
                drop(guard);
                let mut pq = self.pending_mcp.write().await;
                if !pq.iter().any(|(id, _)| id == mcp_agent_id) {
                    info!(
                        mcp_agent_id = mcp_agent_id,
                        agent_identifier = agent_identifier,
                        "No runtime agent found yet, added to pending queue"
                    );
                    pq.push((mcp_agent_id.to_string(), agent_identifier.to_string()));
                } else {
                    debug!(
                        mcp_agent_id = mcp_agent_id,
                        agent_identifier = agent_identifier,
                        "Already in pending queue"
                    );
                }
                return None;
            }
        };

        let runtime_id = matched_agent.agent_id.clone();
        drop(guard);

        // Update the registry: set mcp_agent_id and unify ergatai_agent_id
        // metadata to the MCP URL path name, so all downstream lookups
        // (list_agents, resolve_to_stable_id, message routing) see a single
        // consistent identifier.
        {
            let mut registry = self.registry.write().await;
            if let Some(info) = registry.get_mut(&runtime_id) {
                info.mcp_agent_id = Some(mcp_agent_id.to_string());
                // Unify ergatai_agent_id from workspace format
                // (e.g., "start-opencode-3-agent-1") to MCP URL path name
                // (e.g., "agent-1"). This makes list_agents, message `from`,
                // and reply target all use the same ID.
                info.handle
                    .metadata
                    .insert("ergatai_agent_id".to_string(), mcp_agent_id.to_string());
            }
            // 重建反向索引以包含新的 MCP 绑定
            registry.reconcile_indices();
        }

        info!(
            mcp_agent_id = mcp_agent_id,
            runtime_id = runtime_id,
            agent_identifier = agent_identifier,
            "Bound MCP agent to runtime agent by identifier"
        );
        Some(runtime_id)
    }

    /// Drain the pending MCP queue by binding pending agents to newly discovered
    /// runtime agents. Called after `discover_and_register_agents` finds new agents.
    async fn drain_pending_bindings(&self) {
        let pending: Vec<(String, String)> = {
            let mut pq = self.pending_mcp.write().await;
            std::mem::take(&mut *pq)
        };

        if pending.is_empty() {
            return;
        }

        info!(
            pending_count = pending.len(),
            "Draining pending MCP bindings"
        );

        // 使用单个 WriteGuard 替代分离的 registry + mcp_index 锁
        let mut guard = self.registry.write().await;
        let mut bound = 0;
        let mut requeued = Vec::new();

        for (mcp_id, agent_identifier) in pending {
            // Skip if already bound (could happen if bound between queue and drain)
            if guard.resolve_mcp_id(&mcp_id).is_some() {
                continue;
            }

            // Find unbound runtime agents
            let mut unbound_agents: Vec<_> = guard
                .values()
                .filter(|info| info.mcp_agent_id.is_none())
                .cloned()
                .collect();

            if unbound_agents.is_empty() {
                // Still no unmapped agent — re-queue
                requeued.push((mcp_id, agent_identifier));
                continue;
            }

            // Match by identifier if available, otherwise use FIFO.
            // For identifier matching, accept both exact match and suffix match
            // (workspace ID format "start-opencode-3-agent-1" ends with "-agent-1").
            // Strategy: prefer exact match first; fall back to suffix match only if
            // unambiguous (exactly one match). Multiple suffix matches are ambiguous.
            let suffix = format!("-{}", agent_identifier);
            let matched_agent: Option<AgentInfo> = if !agent_identifier.is_empty() {
                // Exact match first
                unbound_agents.iter().find(|info| {
                    info.handle
                        .metadata
                        .get("ergatai_agent_id")
                        .is_some_and(|id| id == &agent_identifier)
                }).or_else(|| {
                    // Suffix match — only if exactly one
                    let suffix_matches: Vec<_> = unbound_agents.iter().filter(|info| {
                        info.handle
                            .metadata
                            .get("ergatai_agent_id")
                            .is_some_and(|id| id.ends_with(&suffix))
                    }).collect();
                    if suffix_matches.len() == 1 {
                        suffix_matches.into_iter().next()
                    } else {
                        if suffix_matches.len() > 1 {
                            tracing::warn!(
                                agent_identifier = %agent_identifier,
                                match_count = suffix_matches.len(),
                                "Ambiguous suffix match in drain_pending_bindings — refusing to route"
                            );
                        }
                        None
                    }
                }).cloned()
            } else {
                // FIFO: sort by creation time and take earliest
                unbound_agents.sort_by_key(|a| a.created_at);
                unbound_agents.first().cloned()
            };

            let matched_agent = match matched_agent {
                Some(agent) => agent,
                None => {
                    // No matching agent found — re-queue
                    requeued.push((mcp_id, agent_identifier));
                    continue;
                }
            };

            let runtime_id = matched_agent.agent_id.clone();

            if let Some(info) = guard.get_mut(&runtime_id) {
                info.mcp_agent_id = Some(mcp_id.clone());
                // Unify ergatai_agent_id to MCP URL path name
                info.handle
                    .metadata
                    .insert("ergatai_agent_id".to_string(), mcp_id.clone());
            }
            // MCP 绑定通过 reconcile_indices() 在循环结束后统一重建

            info!(
                mcp_agent_id = mcp_id,
                runtime_id = runtime_id,
                agent_identifier = agent_identifier,
                "Bound pending MCP agent to runtime agent"
            );
            bound += 1;
        }

        // 重建所有反向索引，确保一致性
        guard.reconcile_indices();
        drop(guard);

        // Put back any that couldn't be bound
        if !requeued.is_empty() {
            let mut pq = self.pending_mcp.write().await;
            pq.extend(requeued);
        }

        if bound > 0 {
            info!(bound = bound, "Drained pending MCP bindings");
        }
    }

    /// Resolve any agent ID (MCP ID or runtime ID) to a runtime agent ID.
    ///
    /// First checks if the ID is a direct runtime ID, then checks the MCP index.
    pub async fn resolve_agent_id(&self, agent_id: &str) -> Option<String> {
        // 使用 ReadGuard 获取一致的快照
        let guard = self.registry.read().await;

        // Direct match in registry
        if guard.contains_key(agent_id) {
            return Some(agent_id.to_string());
        }

        // Stable ID lookup (O(1) via stable_id_index).
        // This enables callers to address agents by their human-readable stable name.
        if let Some(runtime_id) = guard.resolve_stable_id(agent_id) {
            return Some(runtime_id.to_string());
        }

        // MCP ID lookup
        guard.resolve_mcp_id(agent_id).map(|s| s.to_string())
    }

    /// Resolve any agent identifier to the stable `ergatai_agent_id` (e.g., "agent-1").
    ///
    /// This is the single source of truth for stable ID resolution. Both MCP server
    /// and message delivery use this method to ensure consistent batch tracking keys.
    ///
    /// # Resolution order
    /// 1. Direct registry lookup (agent_id is a runtime ID like "%49")
    /// 2. MCP index lookup (agent_id is an MCP ID like "opencode@abcd")
    /// 3. Stable ID match (agent_id is already a stable ID like "agent-1")
    /// 4. agent_identifier fallback (from MCP session URL path)
    /// 5. Return input as-is (unresolved)
    ///
    /// # Arguments
    /// * `agent_id` — any agent identifier (runtime, MCP, stable, or unknown)
    /// * `agent_identifier` — optional fallback from MCP session context (URL path)
    pub async fn resolve_to_stable_id(
        &self,
        agent_id: &str,
        agent_identifier: Option<&str>,
    ) -> String {
        // 使用 ReadGuard 获取一致的快照
        let guard = self.registry.read().await;

        // 1. Direct registry lookup (runtime ID)
        if let Some(info) = guard.get(agent_id) {
            // Prefer first-class stable_id field, fallback to metadata for backward compat
            if let Some(ref stable) = info.stable_id {
                return stable.clone();
            }
            if let Some(stable) = info.handle.metadata.get("ergatai_agent_id") {
                return stable.clone();
            }
            return agent_id.to_string();
        }

        // 2. MCP index lookup
        if let Some(runtime_id) = guard.resolve_mcp_id(agent_id) {
            if let Some(info) = guard.get(runtime_id) {
                if let Some(ref stable) = info.stable_id {
                    return stable.clone();
                }
                if let Some(stable) = info.handle.metadata.get("ergatai_agent_id") {
                    return stable.clone();
                }
            }
            return runtime_id.to_string();
        }

        // 3. Stable ID match — check if agent_id matches any agent's stable_id
        if guard.resolve_stable_id(agent_id).is_some() {
            return agent_id.to_string();
        }

        // 4. agent_identifier fallback (MCP session context)
        if let Some(identifier) = agent_identifier {
            return identifier.to_string();
        }

        // 5. Unresolved — return as-is
        agent_id.to_string()
    }

    /// Get the MCP agent ID associated with a runtime agent.
    pub async fn get_mcp_agent_id(&self, runtime_id: &str) -> Option<String> {
        self.registry.get_mcp_agent_id(runtime_id).await
    }

    /// Resolve agent UUID to current runtime ID.
    ///
    /// This enables stable message routing: messages are addressed by UUID,
    /// which survives agent restarts. The UUID maps to the current runtime agent ID.
    ///
    /// Uses O(1) hash map lookup via uuid_index for efficient resolution.
    pub async fn resolve_agent_uuid(&self, agent_uuid: &str) -> Option<String> {
        self.registry.resolve_uuid(agent_uuid).await
    }

    /// Set agent UUID (for testing purposes only).
    #[cfg(test)]
    pub async fn set_agent_uuid_for_test(&self, agent_id: &str, uuid: &str) -> ErgataiResult<()> {
        let mut guard = self.registry.write().await;
        let info = guard
            .get_mut(agent_id)
            .ok_or_else(|| ErgataiError::internal(format!("Agent {} not found", agent_id)))?;
        info.agent_uuid = uuid.to_string();
        Ok(())
    }

    /// Update agent lifecycle state (preferred).
    ///
    /// Transitions the agent's `lifecycle` field to the new state.
    pub async fn set_agent_lifecycle(
        &self,
        agent_id: &str,
        new_state: crate::agent_lifecycle::AgentLifecycleState,
    ) -> ErgataiResult<()> {
        let mut guard = self.registry.write().await;
        let info = guard
            .get_mut(agent_id)
            .ok_or_else(|| ErgataiError::internal(format!("Agent {} not found", agent_id)))?;
        info.lifecycle = new_state;
        Ok(())
    }

    /// Capture agent output.
    pub async fn capture_output(&self, agent_id: &str) -> ErgataiResult<Option<String>> {
        let info = self
            .registry
            .get(agent_id)
            .await
            .ok_or_else(|| ErgataiError::internal(format!("Agent {} not found", agent_id)))?;

        self.backend.capture_output(&info.handle).await
    }

    /// Wait for agent to exit.
    pub async fn wait_for_exit(
        &self,
        agent_id: &str,
        timeout: Option<std::time::Duration>,
    ) -> ErgataiResult<WaitResult> {
        let info = self
            .registry
            .get(agent_id)
            .await
            .ok_or_else(|| ErgataiError::internal(format!("Agent {} not found", agent_id)))?;

        self.backend.wait_for_exit(&info.handle, timeout).await
    }

    /// Get how long since the agent last produced output.
    /// Used by DAG watchdog to detect idle agents.
    /// Returns None if the agent is not found or the backend doesn't track output.
    pub async fn agent_last_output_age(&self, agent_id: &str) -> Option<std::time::Duration> {
        let info = self.registry.get(agent_id).await?;
        self.backend.last_output_age(&info.handle)
    }

    /// Shutdown the runtime — stop all agents and cleanup all workspaces.
    ///
    /// CRITICAL FIX: Cancels shutdown_token to signal all monitor tasks to exit
    /// cleanly, preventing task leaks during shutdown.
    pub async fn shutdown(&self) -> ErgataiResult<()> {
        // Cancel shutdown token to signal monitor tasks to exit
        self.shutdown_token.cancel();

        let agents = self.list_agents().await;
        info!(count = agents.len(), "Shutting down agent runtime");

        for agent in &agents {
            if let Err(e) = self.stop_agent(&agent.agent_id).await {
                error!(agent_id = agent.agent_id, error = %e, "Failed to stop agent during shutdown");
            }
        }

        // CONCURRENT FIX: Join all monitor tasks with a bounded timeout.
        // This ensures monitors have exited before we return from shutdown,
        // preventing races with process exit or subsequent runtime reuse.
        let handles: Vec<_> = {
            let mut guard = self.monitor_handles.lock().unwrap();
            guard.drain().map(|(_, handle)| handle).collect()
        };
        if !handles.is_empty() {
            info!(count = handles.len(), "Joining monitor tasks");
            let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(5);
            for handle in handles {
                let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
                if remaining.is_zero() {
                    warn!("Monitor join deadline exceeded — some monitors may still be running");
                    break;
                }
                let _ = tokio::time::timeout(remaining, handle).await;
            }
        }

        self.backend.shutdown().await?;
        info!("Agent runtime shutdown complete");
        Ok(())
    }

    /// Spawn a background monitor for an agent.
    ///
    /// The monitor waits for the agent process to exit and updates the registry.
    /// A 24-hour safety timeout prevents leaked tasks if the backend hangs.
    ///
    /// HIGH BUG FIX: After setting Terminated state, the monitor now removes
    /// the agent from all indices after a 60-second grace period, preventing
    /// unbounded memory growth from accumulated terminated agents.
    ///
    /// CRITICAL FIX: Added CancellationToken support for graceful shutdown.
    /// The monitor task will exit cleanly when shutdown_token is cancelled,
    /// preventing task leaks during runtime shutdown.
    fn spawn_monitor(&self, agent_id: String, handle: AgentHandle) {
        let backend = self.backend.clone();
        let registry = self.registry.clone(); // AgentRegistry is Clone (Arc clone)
        let shutdown_token = self.shutdown_token.clone();
        let monitor_handles = self.monitor_handles.clone();
        let agent_id_for_handle = agent_id.clone();

        let join_handle = tokio::spawn(async move {
            use crate::agent_lifecycle::AgentLifecycleState;
            // Safety timeout: 24 hours to prevent leaked tasks on hung backends
            let timeout_duration = std::time::Duration::from_secs(86400);
            let now = chrono::Utc::now();

            // CRITICAL FIX: Use tokio::select! to wait for either:
            // 1. Agent exits normally (backend.wait_for_exit)
            // 2. Shutdown token is cancelled (graceful shutdown)
            // 3. Timeout (24h safety net)
            let result = tokio::select! {
                res = tokio::time::timeout(timeout_duration, backend.wait_for_exit(&handle, None)) => res,
                _ = shutdown_token.cancelled() => {
                    info!(agent_id = agent_id, "Monitor task cancelled during shutdown");
                    return; // Exit cleanly without cleanup during shutdown
                }
            };

            // Determine the appropriate terminal lifecycle state based on how the agent exited.
            // The `created_at` will be filled in below once we have the registry lock.
            let terminal_state = match result {
                Ok(Ok(crate::types::WaitResult::Exited { code })) => {
                    if code == 0 {
                        info!(
                            agent_id = agent_id,
                            code = code,
                            "Agent exited successfully"
                        );
                        AgentLifecycleState::Terminated {
                            outcome: crate::agent_lifecycle::ExitOutcome::Exited {
                                exit_code: Some(0),
                            },
                            terminated_at: now,
                            duration_secs: 0, // placeholder, recomputed below
                        }
                    } else {
                        warn!(
                            agent_id = agent_id,
                            code = code,
                            "Agent exited with error code"
                        );
                        AgentLifecycleState::Terminated {
                            outcome: crate::agent_lifecycle::ExitOutcome::Error {
                                error: format!("Agent exited with code {}", code),
                                retryable: false,
                            },
                            terminated_at: now,
                            duration_secs: 0,
                        }
                    }
                }
                Ok(Ok(crate::types::WaitResult::Signaled { signal })) => {
                    warn!(
                        agent_id = agent_id,
                        signal = signal,
                        "Agent killed by signal"
                    );
                    AgentLifecycleState::Terminated {
                        outcome: crate::agent_lifecycle::ExitOutcome::Signaled { signal },
                        terminated_at: now,
                        duration_secs: 0,
                    }
                }
                Ok(Ok(crate::types::WaitResult::Timeout)) => {
                    warn!(agent_id = agent_id, "Agent monitor timed out (unexpected)");
                    AgentLifecycleState::Terminated {
                        outcome: crate::agent_lifecycle::ExitOutcome::TimedOut {
                            timeout_type: crate::agent_lifecycle::TimeoutType::MaxRuntime,
                            last_heartbeat: now,
                        },
                        terminated_at: now,
                        duration_secs: 0,
                    }
                }
                Ok(Ok(crate::types::WaitResult::Error(e))) => {
                    error!(agent_id = agent_id, error = %e, "Agent monitor error");
                    AgentLifecycleState::Terminated {
                        outcome: crate::agent_lifecycle::ExitOutcome::Error {
                            error: e,
                            retryable: true,
                        },
                        terminated_at: now,
                        duration_secs: 0,
                    }
                }
                Ok(Err(e)) => {
                    error!(agent_id = agent_id, error = %e, "Agent wait failed");
                    AgentLifecycleState::Terminated {
                        outcome: crate::agent_lifecycle::ExitOutcome::Error {
                            error: format!("Backend wait failed: {}", e),
                            retryable: true,
                        },
                        terminated_at: now,
                        duration_secs: 0,
                    }
                }
                Err(_) => {
                    // tokio::time::timeout elapsed (24h)
                    warn!(
                        agent_id = agent_id,
                        "Agent monitor timed out after 24h, forcing TimedOut state"
                    );
                    AgentLifecycleState::Terminated {
                        outcome: crate::agent_lifecycle::ExitOutcome::TimedOut {
                            timeout_type: crate::agent_lifecycle::TimeoutType::MaxRuntime,
                            last_heartbeat: now,
                        },
                        terminated_at: now,
                        duration_secs: 0,
                    }
                }
            };

            // Extract agent UUID before mutating registry (for consistency check)
            let agent_uuid = {
                let mut guard = registry.write().await;
                if let Some(info) = guard.get_mut(&agent_id) {
                    // Fill in the real duration for Terminated states
                    let final_state = match terminal_state {
                        AgentLifecycleState::Terminated {
                            outcome,
                            terminated_at,
                            duration_secs: _,
                        } => {
                            let duration_secs = now
                                .signed_duration_since(info.created_at)
                                .num_seconds()
                                .max(0) as u64;
                            AgentLifecycleState::Terminated {
                                outcome,
                                terminated_at,
                                duration_secs,
                            }
                        }
                        other => other,
                    };
                    info.lifecycle = final_state;
                    info.last_heartbeat = now;
                    info.agent_uuid.clone()
                } else {
                    // Agent was already removed (e.g., by stop_agent)
                    return;
                }
            };

            // HIGH BUG FIX: Grace period before cleanup. This gives callers time
            // to query the terminated agent's state (e.g., for exit code, duration).
            // After 60 seconds, remove from all indices to prevent memory leak.
            tokio::select! {
                _ = tokio::time::sleep(std::time::Duration::from_secs(60)) => {}
                _ = shutdown_token.cancelled() => {
                    info!(
                        agent_id = agent_id,
                        "Monitor grace period cancelled during runtime shutdown"
                    );
                    return;
                }
            }

            // CRITICAL FIX: Verify UUID consistency before removing. If agent_id was
            // re-bound to a new agent during the grace period, skip cleanup to avoid
            // destroying the new agent's registry entry and workspace.
            {
                let guard = registry.read().await;
                if let Some(current) = guard.get(&agent_id) {
                    if current.agent_uuid != agent_uuid {
                        info!(
                            agent_id = agent_id,
                            old_uuid = agent_uuid,
                            new_uuid = current.agent_uuid,
                            "agent_id re-bound to new UUID during grace period — skipping cleanup"
                        );
                        return;
                    }
                }
            }

            // 原子移除所有索引 — AgentRegistry 自动清理 uuid, mcp, stable_id, streaks
            registry.remove(&agent_id).await;

            // NOTE: Do NOT cleanup workspace here. The workspace may be shared
            // by multiple agents. Workspace lifecycle is managed explicitly.

            info!(
                agent_id = agent_id,
                "Terminated agent removed from all indices after grace period"
            );
        });

        // Track the JoinHandle so shutdown() can join it.
        // Use std::sync::Mutex (not tokio::sync::Mutex) because spawn_monitor is
        // a sync fn called from async contexts — blocking_lock would panic.
        let mut handles = monitor_handles.lock().unwrap();
        if let Some(existing_handle) = handles.insert(agent_id_for_handle, join_handle) {
            existing_handle.abort();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::backend::AcpBackendInterface;
    use crate::types::{
        AgentHandle, BackendCapabilities, WaitResult, WorkspaceHandle, WorkspaceSpec,
    };
    use ergatai_error::{ErgataiError, ErgataiResult};
    use std::collections::HashMap;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use std::time::Duration;

    /// Mock backend that tracks calls and doesn't spawn processes.
    struct MockBackend {
        initialized: AtomicBool,
        workspace_count: AtomicUsize,
        inject_fail: bool,
    }

    impl MockBackend {
        fn new() -> Self {
            Self {
                initialized: AtomicBool::new(false),
                workspace_count: AtomicUsize::new(0),
                inject_fail: false,
            }
        }

        fn with_inject_fail() -> Self {
            Self {
                initialized: AtomicBool::new(false),
                workspace_count: AtomicUsize::new(0),
                inject_fail: true,
            }
        }
    }

    #[async_trait::async_trait]
    impl AcpBackendInterface for MockBackend {
        fn name(&self) -> &'static str {
            "mock"
        }
        fn capabilities(&self) -> BackendCapabilities {
            BackendCapabilities {
                supports_message_injection: !self.inject_fail,
                supports_output_capture: true,
                supports_resource_limits: false,
                supports_workspace_reuse: false,
                supports_network_isolation: false,
                max_concurrent_agents: None,
            }
        }
        async fn initialize(&self) -> ErgataiResult<()> {
            self.initialized.store(true, Ordering::SeqCst);
            Ok(())
        }
        async fn create_workspace(&self, spec: WorkspaceSpec) -> ErgataiResult<WorkspaceHandle> {
            self.workspace_count.fetch_add(1, Ordering::SeqCst);
            Ok(WorkspaceHandle {
                id: spec.id.clone(),
                backend: "mock".to_string(),
                metadata: HashMap::new(),
            })
        }
        fn next_agent_id(&self, workspace_id: &str) -> String {
            format!("{}-agent-0", workspace_id)
        }
        async fn start_agent(
            &self,
            handle: &WorkspaceHandle,
            _command: &str,
            _instruction: Option<&str>,
        ) -> ErgataiResult<AgentHandle> {
            Ok(AgentHandle {
                workspace: handle.clone(),
                agent_id: format!("agent-{}", handle.id),
                process_id: Some("12345".to_string()),
                metadata: HashMap::new(),
            })
        }
        async fn inject_message(&self, _handle: &AgentHandle, _message: &str) -> ErgataiResult<()> {
            if self.inject_fail {
                Err(ErgataiError::internal("inject failed".to_string()))
            } else {
                Ok(())
            }
        }
        async fn capture_output(&self, _handle: &AgentHandle) -> ErgataiResult<Option<String>> {
            Ok(Some("captured output".to_string()))
        }
        async fn is_alive(&self, _handle: &AgentHandle) -> ErgataiResult<bool> {
            Ok(false)
        }
        async fn stop_agent(&self, _handle: &AgentHandle) -> ErgataiResult<()> {
            Ok(())
        }
        async fn kill_agent(&self, _handle: &AgentHandle) -> ErgataiResult<()> {
            Ok(())
        }
        async fn wait_for_exit(
            &self,
            _handle: &AgentHandle,
            _timeout: Option<Duration>,
        ) -> ErgataiResult<WaitResult> {
            Ok(WaitResult::Exited { code: 0 })
        }
        async fn list_workspaces(&self) -> ErgataiResult<Vec<WorkspaceHandle>> {
            Ok(vec![])
        }
        async fn cleanup_workspace(&self, _handle: &WorkspaceHandle) -> ErgataiResult<()> {
            Ok(())
        }
        async fn shutdown(&self) -> ErgataiResult<()> {
            Ok(())
        }
        fn last_output_age(&self, _handle: &AgentHandle) -> Option<Duration> {
            None
        }
        // Observation operations
        async fn thoughts(&self, _agent_id: &str) -> ErgataiResult<Option<String>> {
            Ok(None)
        }
        async fn output(&self, _agent_id: &str) -> ErgataiResult<Option<String>> {
            Ok(None)
        }
        async fn tool_calls(
            &self,
            _agent_id: &str,
        ) -> ErgataiResult<Option<Vec<crate::backends::acp::TrackedToolCall>>> {
            Ok(None)
        }
        async fn plan(
            &self,
            _agent_id: &str,
        ) -> ErgataiResult<Option<crate::backends::acp::TrackedPlan>> {
            Ok(None)
        }
        async fn elicitations(
            &self,
            _agent_id: &str,
        ) -> ErgataiResult<Option<Vec<crate::backends::acp::TrackedElicitation>>> {
            Ok(None)
        }
        async fn session_title(&self, _agent_id: &str) -> ErgataiResult<Option<String>> {
            Ok(None)
        }
        async fn session_id(&self, _agent_id: &str) -> ErgataiResult<Option<String>> {
            Ok(None)
        }
        async fn stop_reason(&self, _agent_id: &str) -> ErgataiResult<Option<String>> {
            Ok(None)
        }
        async fn workspace_capture_thoughts(
            &self,
            _workspace_id: &str,
        ) -> ErgataiResult<Option<bool>> {
            Ok(None)
        }
        async fn continuation_count(&self, _agent_id: &str) -> ErgataiResult<Option<usize>> {
            Ok(None)
        }
        async fn agent_last_output_age(&self, _agent_id: &str) -> ErgataiResult<Option<Duration>> {
            Ok(None)
        }
        async fn exit_code(&self, _agent_id: &str) -> ErgataiResult<Option<Option<i32>>> {
            Ok(None)
        }
        async fn available_commands(
            &self,
            _agent_id: &str,
        ) -> ErgataiResult<Option<Vec<agent_client_protocol::schema::v1::AvailableCommand>>>
        {
            Ok(None)
        }
        async fn auto_continue(&self) -> ErgataiResult<bool> {
            Ok(false)
        }
        async fn max_auto_continues(&self) -> ErgataiResult<usize> {
            Ok(0)
        }
        async fn mcp_over_acp_enabled(&self) -> ErgataiResult<bool> {
            Ok(false)
        }
        async fn session_persistence_enabled(&self) -> ErgataiResult<bool> {
            Ok(false)
        }
        async fn config_options(
            &self,
            _agent_id: &str,
        ) -> ErgataiResult<Option<Vec<agent_client_protocol::schema::v1::SessionConfigOption>>>
        {
            Ok(None)
        }
        async fn usage(&self, _agent_id: &str) -> ErgataiResult<Option<(usize, usize)>> {
            Ok(None)
        }
        async fn pid(&self, _agent_id: &str) -> ErgataiResult<Option<u32>> {
            Ok(None)
        }
        async fn subscribe_output(
            &self,
            _agent_id: &str,
        ) -> ErgataiResult<
            Option<tokio::sync::broadcast::Receiver<crate::backends::acp::AgentOutputEvent>>,
        > {
            Ok(None)
        }
        async fn list_sessions(
            &self,
            _agent_id: &str,
        ) -> ErgataiResult<Vec<crate::types::SessionInfo>> {
            Ok(Vec::new())
        }
        async fn create_session(
            &self,
            _agent_id: &str,
        ) -> ErgataiResult<crate::types::SessionInfo> {
            Err(ErgataiError::internal(
                "MockBackend does not support sessions",
            ))
        }
        async fn load_session(&self, _agent_id: &str, _session_id: &str) -> ErgataiResult<()> {
            Err(ErgataiError::internal(
                "MockBackend does not support sessions",
            ))
        }
        async fn delete_session(&self, _agent_id: &str, _session_id: &str) -> ErgataiResult<()> {
            Err(ErgataiError::internal(
                "MockBackend does not support sessions",
            ))
        }
        // Control operations
        async fn cancel_prompt(&self, _agent_id: &str) -> ErgataiResult<()> {
            Ok(())
        }
        async fn execute_command(
            &self,
            _agent_id: &str,
            _command: &str,
            _timeout_secs: u64,
        ) -> ErgataiResult<String> {
            Ok(String::new())
        }
        async fn respond_to_elicitation(
            &self,
            _elicitation_id: &str,
            _response: crate::ElicitationResponse,
        ) -> ErgataiResult<bool> {
            Ok(false)
        }
        fn as_any(&self) -> &dyn std::any::Any {
            self
        }
    }

    fn make_spec(id: &str) -> WorkspaceSpec {
        WorkspaceSpec {
            id: id.to_string(),
            work_dir: PathBuf::from("/tmp"),
            env: HashMap::new(),
            resources: Default::default(),
            capture_thoughts: false,
        }
    }

    fn make_runtime() -> AgentRuntime {
        AgentRuntime::new(Arc::new(MockBackend::new()))
    }

    #[test]
    fn test_runtime_new() {
        let runtime = make_runtime();
        assert_eq!(runtime.backend().name(), "mock");
    }

    #[tokio::test]
    async fn test_runtime_initialize() {
        let backend = Arc::new(MockBackend::new());
        let runtime = AgentRuntime::new(backend.clone());
        assert!(!backend.initialized.load(Ordering::SeqCst));
        runtime.initialize().await.unwrap();
        assert!(backend.initialized.load(Ordering::SeqCst));
    }

    #[tokio::test]
    async fn test_launch_agent() {
        let runtime = make_runtime();
        let spec = make_spec("ws-1");
        let agent_id = runtime.launch_agent(spec, "cmd", None).await.unwrap();
        assert_eq!(agent_id, "agent-ws-1");
    }

    #[tokio::test]
    async fn test_launch_agent_registers() {
        let runtime = make_runtime();
        runtime
            .launch_agent(make_spec("ws-1"), "cmd", None)
            .await
            .unwrap();
        let info = runtime.get_agent("agent-ws-1").await;
        assert!(info.is_some());
        let info = info.unwrap();
        assert_eq!(info.agent_id, "agent-ws-1");
        assert_eq!(info.workspace_id, "ws-1");
        assert!(matches!(
            info.lifecycle,
            crate::agent_lifecycle::AgentLifecycleState::Running { .. }
        ));
    }

    #[tokio::test]
    async fn test_launch_multiple_agents() {
        let runtime = make_runtime();
        runtime
            .launch_agent(make_spec("ws-1"), "cmd", None)
            .await
            .unwrap();
        runtime
            .launch_agent(make_spec("ws-2"), "cmd", None)
            .await
            .unwrap();
        let agents = runtime.list_agents().await;
        assert_eq!(agents.len(), 2);
    }

    #[tokio::test]
    async fn test_get_agent_not_found() {
        let runtime = make_runtime();
        let result = runtime.get_agent("nonexistent").await;
        assert!(result.is_none());
    }

    #[tokio::test]
    async fn test_list_agents_empty() {
        let runtime = make_runtime();
        let agents = runtime.list_agents().await;
        assert!(agents.is_empty());
    }

    #[tokio::test]
    async fn test_stop_agent() {
        let runtime = make_runtime();
        let agent_id = runtime
            .launch_agent(make_spec("ws-1"), "cmd", None)
            .await
            .unwrap();
        runtime.stop_agent(&agent_id).await.unwrap();
        let info = runtime.get_agent(&agent_id).await;
        assert!(info.is_none());
    }

    #[tokio::test]
    async fn test_stop_agent_not_found() {
        let runtime = make_runtime();
        let result = runtime.stop_agent("nonexistent").await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_inject_message_success() {
        let runtime = make_runtime();
        let agent_id = runtime
            .launch_agent(make_spec("ws-1"), "cmd", None)
            .await
            .unwrap();
        runtime.inject_message(&agent_id, "hello").await.unwrap();
    }

    #[tokio::test]
    async fn test_inject_message_unknown_agent() {
        let runtime = make_runtime();
        let result = runtime.inject_message("nonexistent", "hello").await;
        assert!(result.is_err());
        assert!(result.unwrap_err().to_string().contains("not found"));
    }

    #[tokio::test]
    async fn test_inject_message_falls_back_to_mcp() {
        // Backend fails injection; MCP not configured → should fail
        let backend = Arc::new(MockBackend::with_inject_fail());
        let runtime = AgentRuntime::new(backend);
        let agent_id = runtime
            .launch_agent(make_spec("ws-1"), "cmd", None)
            .await
            .unwrap();
        // No MCP integration set → error
        let result = runtime.inject_message(&agent_id, "hello").await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_set_task_id() {
        let runtime = make_runtime();
        let agent_id = runtime
            .launch_agent(make_spec("ws-1"), "cmd", None)
            .await
            .unwrap();
        runtime
            .set_task_id(&agent_id, "task-42".to_string())
            .await
            .unwrap();
        let info = runtime.get_agent(&agent_id).await.unwrap();
        assert_eq!(info.task_id, Some("task-42".to_string()));
    }

    #[tokio::test]
    async fn test_set_task_id_not_found() {
        let runtime = make_runtime();
        let result = runtime
            .set_task_id("nonexistent", "task-42".to_string())
            .await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_set_agent_lifecycle() {
        let runtime = make_runtime();
        let agent_id = runtime
            .launch_agent(make_spec("ws-1"), "cmd", None)
            .await
            .unwrap();
        let now = chrono::Utc::now();
        runtime
            .set_agent_lifecycle(
                &agent_id,
                crate::agent_lifecycle::AgentLifecycleState::Stopping {
                    reason: crate::agent_lifecycle::StopReason::UserRequested,
                    timeout_secs: Some(30),
                    initiated_at: now,
                },
            )
            .await
            .unwrap();
        let info = runtime.get_agent(&agent_id).await.unwrap();
        assert!(matches!(
            info.lifecycle,
            crate::agent_lifecycle::AgentLifecycleState::Stopping { .. }
        ));
    }

    #[tokio::test]
    async fn test_set_agent_lifecycle_not_found() {
        let runtime = make_runtime();
        let result = runtime
            .set_agent_lifecycle(
                "nonexistent",
                crate::agent_lifecycle::AgentLifecycleState::Terminated {
                    outcome: crate::agent_lifecycle::ExitOutcome::Exited { exit_code: Some(0) },
                    terminated_at: chrono::Utc::now(),
                    duration_secs: 0,
                },
            )
            .await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_capture_output() {
        let runtime = make_runtime();
        let agent_id = runtime
            .launch_agent(make_spec("ws-1"), "cmd", None)
            .await
            .unwrap();
        let output = runtime.capture_output(&agent_id).await.unwrap();
        assert_eq!(output, Some("captured output".to_string()));
    }

    #[tokio::test]
    async fn test_capture_output_unknown_agent() {
        let runtime = make_runtime();
        let result = runtime.capture_output("nonexistent").await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_wait_for_exit() {
        let runtime = make_runtime();
        let agent_id = runtime
            .launch_agent(make_spec("ws-1"), "cmd", None)
            .await
            .unwrap();
        let result = runtime.wait_for_exit(&agent_id, None).await.unwrap();
        match result {
            WaitResult::Exited { code } => assert_eq!(code, 0),
            _ => panic!("Expected Exited"),
        }
    }

    #[tokio::test]
    async fn test_wait_for_exit_unknown_agent() {
        let runtime = make_runtime();
        let result = runtime.wait_for_exit("nonexistent", None).await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_shutdown_stops_all() {
        let runtime = make_runtime();
        runtime
            .launch_agent(make_spec("ws-1"), "cmd", None)
            .await
            .unwrap();
        runtime
            .launch_agent(make_spec("ws-2"), "cmd", None)
            .await
            .unwrap();
        runtime.shutdown().await.unwrap();
        let agents = runtime.list_agents().await;
        assert!(agents.is_empty());
    }

    #[tokio::test]
    async fn test_inject_message_backend_failure_propagates() {
        // Backend injection fails → error propagates (no MCP fallback)
        let backend = Arc::new(MockBackend::with_inject_fail());
        let runtime = AgentRuntime::new(backend);
        let agent_id = runtime
            .launch_agent(make_spec("ws-1"), "cmd", None)
            .await
            .unwrap();

        let result = runtime.inject_message(&agent_id, "hello").await;
        assert!(result.is_err(), "backend failure should propagate as error");
    }

    #[tokio::test]
    async fn test_prune_unhealthy_agents_no_panic_without_matching_backend() {
        // With AcpBackend, prune_unhealthy_agents() is a no-op
        // (health check not yet implemented).
        let runtime = make_runtime();
        runtime
            .launch_agent(make_spec("ws-1"), "cmd", None)
            .await
            .unwrap();
        // Should not panic; agent remains in registry since health check is unsupported.
        runtime.prune_unhealthy_agents().await;
        let agents = runtime.list_agents().await;
        assert_eq!(agents.len(), 1);
    }

    // ── resolve_to_stable_id tests ──

    /// Helper: insert an AgentInfo directly into the registry with ergatai_agent_id metadata.
    async fn insert_agent_with_stable_id(
        runtime: &AgentRuntime,
        runtime_id: &str,
        stable_id: &str,
    ) {
        let now = chrono::Utc::now();
        let mut metadata = HashMap::new();
        metadata.insert("ergatai_agent_id".to_string(), stable_id.to_string());
        let info = AgentInfo {
            agent_uuid: format!("uuid-{}", runtime_id),
            agent_id: runtime_id.to_string(),
            stable_id: Some(stable_id.to_string()),
            workspace_id: "ws-test".to_string(),
            handle: AgentHandle {
                workspace: WorkspaceHandle {
                    id: "ws-test".to_string(),
                    backend: "mock".to_string(),
                    metadata: HashMap::new(),
                },
                agent_id: runtime_id.to_string(),
                process_id: None,
                metadata,
            },
            lifecycle: crate::agent_lifecycle::AgentLifecycleState::Running {
                task_id: None,
                started_at: now,
                last_heartbeat: now,
            },
            task_id: None,
            created_at: now,
            mcp_agent_id: None,
            last_heartbeat: now,
            profile: None,
            capabilities: Vec::new(),
            state_changed_at: now,
            state_history: Vec::new(),
        };
        runtime.registry.write().await.insert(info);
    }

    /// Helper: insert an MCP index mapping by setting mcp_agent_id on the existing agent.
    async fn insert_mcp_binding(runtime: &AgentRuntime, mcp_id: &str, runtime_id: &str) {
        let mut info = runtime
            .registry
            .get(runtime_id)
            .await
            .unwrap_or_else(|| panic!("insert_mcp_binding: agent {} not found", runtime_id));
        info.mcp_agent_id = Some(mcp_id.to_string());
        runtime.registry.insert(info).await;
    }

    /// resolve_to_stable_id: runtime ID → stable ID from metadata
    #[tokio::test]
    async fn test_resolve_to_stable_id_from_runtime_id() {
        let runtime = make_runtime();
        insert_agent_with_stable_id(&runtime, "%15", "agent-1").await;

        let result = runtime.resolve_to_stable_id("%15", None).await;
        assert_eq!(result, "agent-1");
    }

    /// resolve_to_stable_id: MCP ID → runtime ID → stable ID
    #[tokio::test]
    async fn test_resolve_to_stable_id_from_mcp_id() {
        let runtime = make_runtime();
        insert_agent_with_stable_id(&runtime, "%20", "agent-2").await;
        insert_mcp_binding(&runtime, "opencode@abcd", "%20").await;

        let result = runtime.resolve_to_stable_id("opencode@abcd", None).await;
        assert_eq!(result, "agent-2");
    }

    /// resolve_to_stable_id: stable ID passthrough (already a stable ID)
    #[tokio::test]
    async fn test_resolve_to_stable_id_passthrough() {
        let runtime = make_runtime();
        insert_agent_with_stable_id(&runtime, "%30", "agent-3").await;

        // "agent-3" is not a runtime ID or MCP ID, but matches ergatai_agent_id
        let result = runtime.resolve_to_stable_id("agent-3", None).await;
        assert_eq!(result, "agent-3");
    }

    /// resolve_to_stable_id: agent_identifier fallback when nothing else matches
    #[tokio::test]
    async fn test_resolve_to_stable_id_agent_identifier_fallback() {
        let runtime = make_runtime();

        let result = runtime
            .resolve_to_stable_id("unknown-id", Some("agent-from-url"))
            .await;
        assert_eq!(result, "agent-from-url");
    }

    /// resolve_to_stable_id: returns input as-is when no match and no fallback
    #[tokio::test]
    async fn test_resolve_to_stable_id_unresolved() {
        let runtime = make_runtime();

        let result = runtime
            .resolve_to_stable_id("completely-unknown", None)
            .await;
        assert_eq!(result, "completely-unknown");
    }

    /// resolve_to_stable_id: runtime ID without ergatai_agent_id returns runtime ID
    #[tokio::test]
    async fn test_resolve_to_stable_id_no_stable_in_metadata() {
        let runtime = make_runtime();
        // Launch agent without ergatai_agent_id in metadata
        runtime
            .launch_agent(make_spec("ws-nostable"), "cmd", None)
            .await
            .unwrap();

        let result = runtime
            .resolve_to_stable_id("agent-ws-nostable", None)
            .await;
        // No ergatai_agent_id in metadata, so returns the runtime ID itself
        assert_eq!(result, "agent-ws-nostable");
    }
}
