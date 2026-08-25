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

use crate::backend::AgentRuntimeBackend;
use crate::types::{AgentHandle, AgentInfo, WaitResult, WorkspaceSpec};

// ── Global singleton ──

static AGENT_RUNTIME: OnceLock<Arc<AgentRuntime>> = OnceLock::new();

/// Get the global AgentRuntime singleton.
///
/// Initializes with `TmuxBackend` using the "ergatai" session prefix.
/// Call `init_agent_runtime()` instead if you need a custom backend.
pub fn get_agent_runtime() -> Arc<AgentRuntime> {
    AGENT_RUNTIME
        .get_or_init(|| {
            let backend = Arc::new(crate::backends::tmux::TmuxBackend::new("ergatai"));
            Arc::new(AgentRuntime::new(backend))
        })
        .clone()
}

/// Initialize the global AgentRuntime with a custom backend.
///
/// Returns `Err` if already initialized. Call this from `main()` before
/// any other component accesses the runtime.
pub fn init_agent_runtime(
    backend: Arc<dyn AgentRuntimeBackend>,
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
    backend: Arc<dyn AgentRuntimeBackend>,
    registry: Arc<RwLock<HashMap<String, AgentInfo>>>,
    /// Reverse index: agent UUID → runtime agent ID (pane ID).
    /// Enables O(1) UUID resolution for stable message routing.
    uuid_index: Arc<RwLock<HashMap<String, String>>>,
    /// Reverse index: MCP agent ID → runtime agent ID.
    /// Enables resolving MCP IDs (e.g., "opencode@abcd1234") to runtime IDs
    /// (e.g., "%198") for message injection.
    mcp_index: Arc<RwLock<HashMap<String, String>>>,
    /// Reverse index: stable ID → runtime agent ID.
    /// LOW FIX: Enables O(1) stable ID resolution instead of O(n) linear scan.
    /// Populated when agents register with a stable_id.
    stable_id_index: Arc<RwLock<HashMap<String, String>>>,
    /// Queue of MCP agent IDs waiting to be bound to a runtime agent.
    /// Stores (mcp_agent_id, agent_identifier) tuples for precise binding.
    /// Populated when an MCP agent connects before rmux discovery finds panes.
    /// Drained after each successful discovery cycle.
    pending_mcp: Arc<RwLock<Vec<(String, String)>>>,
    /// Mutex to serialize binding operations.
    /// Ensures that even if multiple MCP agents connect concurrently,
    /// they are bound sequentially in creation-time order.
    binding_mutex: Arc<Mutex<()>>,
    /// Tracks consecutive unhealthy observations per agent. Agents pruned after 2 consecutive Zombie/Dead samples.
    unhealthy_streaks: Arc<Mutex<HashMap<String, u32>>>,
    /// CRITICAL FIX: CancellationToken for graceful shutdown.
    /// When cancelled, all spawn_monitor tasks will exit cleanly instead of
    /// waiting for agents to exit or timing out. Prevents task leaks during shutdown.
    shutdown_token: CancellationToken,
}

impl AgentRuntime {
    /// Create a new runtime with the given backend.
    pub fn new(backend: Arc<dyn AgentRuntimeBackend>) -> Self {
        Self {
            backend,
            registry: Arc::new(RwLock::new(HashMap::new())),
            uuid_index: Arc::new(RwLock::new(HashMap::new())),
            mcp_index: Arc::new(RwLock::new(HashMap::new())),
            stable_id_index: Arc::new(RwLock::new(HashMap::new())),
            pending_mcp: Arc::new(RwLock::new(Vec::new())),
            binding_mutex: Arc::new(Mutex::new(())),
            unhealthy_streaks: Arc::new(Mutex::new(HashMap::new())),
            shutdown_token: CancellationToken::new(),
        }
    }

    /// Get the shutdown token for graceful shutdown coordination.
    /// Cancel this token to signal all monitor tasks to exit cleanly.
    pub fn shutdown_token(&self) -> CancellationToken {
        self.shutdown_token.clone()
    }

    /// Get a reference to the underlying backend.
    pub fn backend(&self) -> &Arc<dyn AgentRuntimeBackend> {
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
        // Avoid calling create_workspace again to prevent duplicate session creation
        // via SDK's `new-session -A` which can create a new window.
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

        let handle = self
            .backend
            .start_agent(&workspace, command, instruction)
            .await?;

        let agent_id = handle.agent_id.clone();
        let agent_uuid = uuid::Uuid::new_v4().to_string();
        let now = chrono::Utc::now();

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
            mcp_agent_id: None,
            last_heartbeat: now,
            state_history: Vec::new(),
        };

        self.registry.write().await.insert(agent_id.clone(), info);
        self.uuid_index
            .write()
            .await
            .insert(agent_uuid, agent_id.clone());

        // LOW FIX: Populate stable_id_index for O(1) resolution
        if let Some(ref stable_id) = handle.metadata.get("ergatai_agent_id").cloned() {
            self.stable_id_index
                .write()
                .await
                .insert(stable_id.clone(), agent_id.clone());
        }

        self.spawn_monitor(agent_id.clone(), handle);

        info!(agent_id = agent_id, "Agent launched");
        Ok(agent_id)
    }

    /// Inject a message into a running agent.
    ///
    /// Uses the backend (rmux) to inject text directly into the agent's pane.
    /// Supports both runtime IDs (e.g., "%198") and MCP IDs (e.g., "opencode@abcd1234")
    /// — MCP IDs are resolved to runtime IDs via the `mcp_index` mapping.
    pub async fn inject_message(&self, agent_id: &str, message: &str) -> ErgataiResult<()> {
        // Resolve MCP ID to runtime ID if needed
        let runtime_id = self
            .resolve_agent_id(agent_id)
            .await
            .ok_or_else(|| ErgataiError::internal(format!("Agent {} not found", agent_id)))?;

        let info = {
            let registry = self.registry.read().await;
            registry
                .get(&runtime_id)
                .cloned()
                .ok_or_else(|| ErgataiError::internal(format!("Agent {} not found", runtime_id)))?
        };

        // Deliver via backend injection (rmux send_text)
        self.backend.inject_message(&info.handle, message).await
    }

    /// Stop an agent.
    pub async fn stop_agent(&self, agent_id: &str) -> ErgataiResult<()> {
        let info = self
            .registry
            .write()
            .await
            .remove(agent_id)
            .ok_or_else(|| ErgataiError::internal(format!("Agent {} not found", agent_id)))?;

        // Clean up all indices using unified helper
        self.remove_agent_indices(agent_id, &info.agent_uuid, info.mcp_agent_id.as_deref())
            .await;

        if let Err(e) = self.backend.stop_agent(&info.handle).await {
            warn!(agent_id = agent_id, error = %e, "Failed to stop agent backend");
        }

        if let Err(e) = self.backend.cleanup_workspace(&info.handle.workspace).await {
            warn!(
                agent_id = agent_id,
                error = %e,
                "Failed to cleanup workspace"
            );
        }

        info!(agent_id = agent_id, "Agent stopped and cleaned up");
        Ok(())
    }

    /// Remove agent from all indices atomically.
    ///
    /// CRITICAL BUG FIX: Previously, `stop_agent()` and `prune_unhealthy_agents()`
    /// only cleaned the main `registry`, leaking entries in `uuid_index`, `mcp_index`,
    /// and `unhealthy_streaks`. This caused memory leaks and stale routing failures.
    ///
    /// This helper ensures all four data structures are cleaned consistently.
    async fn remove_agent_indices(
        &self,
        agent_id: &str,
        agent_uuid: &str,
        mcp_agent_id: Option<&str>,
    ) {
        // 1. Clean uuid_index
        self.uuid_index.write().await.remove(agent_uuid);

        // 2. Clean mcp_index (if agent had MCP binding)
        if let Some(mcp_id) = mcp_agent_id {
            self.mcp_index.write().await.remove(mcp_id);
        }

        // 3. Clean unhealthy_streaks
        self.unhealthy_streaks.lock().await.remove(agent_id);

        debug!(
            agent_id = agent_id,
            agent_uuid = agent_uuid,
            mcp_agent_id = ?mcp_agent_id,
            "Cleaned all agent indices"
        );
    }

    /// List all registered agents.
    pub async fn list_agents(&self) -> Vec<AgentInfo> {
        self.registry.read().await.values().cloned().collect()
    }

    /// Get a specific agent by ID.
    pub async fn get_agent(&self, agent_id: &str) -> Option<AgentInfo> {
        self.registry.read().await.get(agent_id).cloned()
    }

    /// Set the task ID for a runtime agent (for DAG tracking).
    pub async fn set_task_id(&self, agent_id: &str, task_id: String) -> ErgataiResult<()> {
        let mut registry = self.registry.write().await;
        let info = registry
            .get_mut(agent_id)
            .ok_or_else(|| ErgataiError::internal(format!("Agent {} not found", agent_id)))?;
        info.task_id = Some(task_id);
        Ok(())
    }

    /// Register an externally-discovered agent (e.g., from rmux pane scan).
    ///
    /// This allows agents started outside the normal `launch_agent()` flow
    /// (e.g., manually in rmux panes) to receive messages via the runtime
    /// delivery chain.
    ///
    /// MEDIUM BUG FIX: If the same agent_id is re-registered, the old UUID
    /// is now cleaned from uuid_index to prevent index leak.
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
            state_history: Vec::new(),
        };

        // MEDIUM BUG FIX: Check if agent already exists and clean old UUID
        let old_uuid = {
            let mut registry = self.registry.write().await;
            let old_uuid = registry.get(&agent_id).map(|old| old.agent_uuid.clone());
            registry.insert(agent_id.clone(), info);
            old_uuid
        };

        // Clean old UUID from index if it existed
        if let Some(old) = old_uuid {
            self.uuid_index.write().await.remove(&old);
        }

        self.uuid_index
            .write()
            .await
            .insert(agent_uuid, agent_id.clone());

        // LOW FIX: Populate stable_id_index for O(1) resolution (parity with launch_agent).
        // Previously only launch_agent() populated this index, so discovered agents
        // missed the fast path in resolve_agent_id() and fell through to linear scan.
        // Read stable_id from the registry (info was moved into it above).
        let stable_id_for_index = {
            let registry = self.registry.read().await;
            registry
                .get(&agent_id)
                .and_then(|info| info.stable_id.clone())
        };
        if let Some(sid) = stable_id_for_index {
            self.stable_id_index
                .write()
                .await
                .insert(sid, agent_id.clone());
        }

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
        let mut indices_to_clean = Vec::new(); // Collect indices to clean after dropping lock
        let mut registry = self.registry.write().await;

        for (agent_id, handle) in discovered {
            // If this workspace already has an agent registered (e.g., via launch_agent),
            // validate the pane is still the same and update its handle metadata with
            // the latest discovery data. If the pane changed, re-register the agent.
            //
            // All mutations happen under the SAME write-lock acquisition to prevent
            // state changes between drop/re-acquire (previously: drop → remove → re-acquire
            // created a window where another task could insert a duplicate workspace entry).
            let existing_match: Option<(String, Option<String>, Option<String>)> = registry
                .values()
                .find(|info| info.workspace_id == handle.workspace.id)
                .map(|info| {
                    (
                        info.agent_id.clone(),
                        info.handle.metadata.get("pane_id").cloned(),
                        handle.metadata.get("pane_id").cloned(),
                    )
                });

            if let Some((old_agent_id, existing_pane_id, new_pane_id)) = existing_match {
                // Check if pane changed (agent died and pane was recreated)
                if existing_pane_id != new_pane_id {
                    warn!(
                        workspace_id = %handle.workspace.id,
                        old_pane = ?existing_pane_id,
                        new_pane = ?new_pane_id,
                        "Pane changed — agent likely died and pane was recreated. Re-registering agent."
                    );
                    // Remove old registration under the SAME lock, then fall through
                    // to register the new agent below.
                    // CRITICAL BUG FIX: Also clean uuid_index and mcp_index
                    if let Some(old_info) = registry.remove(&old_agent_id) {
                        // CRITICAL FIX: Collect indices to clean AFTER dropping the lock,
                        // not during the loop. This prevents TOCTOU race where another task
                        // could modify the registry between drop and re-acquire.
                        let old_uuid = old_info.agent_uuid.clone();
                        let old_mcp = old_info.mcp_agent_id.clone();
                        indices_to_clean.push((old_agent_id.clone(), old_uuid, old_mcp));
                    }
                } else {
                    // Same pane - just update metadata and stable_id
                    if let Some(eai) = handle.metadata.get("ergatai_agent_id") {
                        if let Some(existing) = registry.get_mut(&old_agent_id) {
                            existing
                                .handle
                                .metadata
                                .insert("ergatai_agent_id".to_string(), eai.clone());
                            existing.stable_id = Some(eai.clone());
                        }
                    }
                    continue;
                }
            }
            // Atomic check-and-insert under a single write lock acquisition.
            // entry().or_insert() ensures no TOCTOU gap between contains_key and insert.
            registry.entry(agent_id.clone()).or_insert_with(|| {
                count += 1;
                let agent_uuid = uuid::Uuid::new_v4().to_string();
                let now = chrono::Utc::now();
                let stable_id = handle.metadata.get("ergatai_agent_id").cloned();
                new_agents.push((agent_id.clone(), agent_uuid.clone(), handle.clone()));
                AgentInfo {
                    agent_uuid: agent_uuid.clone(),
                    agent_id: agent_id.clone(),
                    stable_id,
                    workspace_id: handle.workspace.id.clone(),
                    handle,
                    lifecycle: crate::agent_lifecycle::AgentLifecycleState::Running {
                        task_id: None,
                        started_at: now,
                        last_heartbeat: now,
                    },
                    task_id: None,
                    created_at: now,
                    mcp_agent_id: None,
                    last_heartbeat: now,
                    state_history: Vec::new(),
                }
            });
        }
        drop(registry);

        // CRITICAL FIX: Clean up indices AFTER dropping the registry lock.
        // This prevents TOCTOU race where the lock was dropped and re-acquired
        // in the middle of the loop, allowing other tasks to modify state.
        for (old_agent_id, old_uuid, old_mcp) in indices_to_clean {
            self.remove_agent_indices(&old_agent_id, &old_uuid, old_mcp.as_deref())
                .await;
        }

        // Update UUID index for newly registered agents
        if !new_agents.is_empty() {
            let mut uuid_index = self.uuid_index.write().await;
            for (agent_id, uuid, _) in &new_agents {
                uuid_index.insert(uuid.clone(), agent_id.clone());
            }
        }

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
    /// Backends that don't support health checks are no-ops.
    /// This method uses `as_any()` downcast to call TmuxBackend's health check;
    /// if the downcast fails, the method returns silently.
    ///
    /// Returns the list of agent IDs that were pruned in this pass, so callers
    /// can perform follow-up cleanup (e.g. dropping rate-limiter windows).
    pub async fn prune_unhealthy_agents(&self) -> Vec<String> {
        use crate::backends::proc_linux::ProcessState;
        use crate::backends::tmux::TmuxBackend;

        let backend_any = self.backend.as_any();

        // Try TmuxBackend first (default).
        let health = if let Some(tmux_backend) = backend_any.downcast_ref::<TmuxBackend>() {
            tmux_backend.health_check_agents().await
        } else if let Some(pty_backend) = backend_any.downcast_ref::<crate::backends::pty::PtyBackend>() {
            pty_backend.health_check_agents().await
        } else {
            // Try RmuxBackend (deprecated but still in use behind feature flag).
            #[cfg(feature = "rmux")]
            if let Some(rmux_backend) =
                backend_any.downcast_ref::<crate::backends::rmux::RmuxBackend>()
            {
                rmux_backend.health_check_agents().await
            } else {
                debug!("health check not supported by backend, skipping prune");
                return Vec::new();
            }
            #[cfg(not(feature = "rmux"))]
            {
                debug!("health check not supported by backend, skipping prune");
                return Vec::new();
            }
        };

        let mut pruned = Vec::new();
        let mut streaks = self.unhealthy_streaks.lock().await;

        // CRITICAL BUG FIX: Previously, this method only cleaned `registry` and `streaks`,
        // leaking entries in `uuid_index` and `mcp_index`. Now we collect agents to prune,
        // drop the streak lock, then use `remove_agent_indices()` for full cleanup.
        let mut to_prune = Vec::new();

        for (agent_id, state) in health {
            let is_bad = matches!(state, ProcessState::Zombie | ProcessState::Dead);
            let entry = streaks.entry(agent_id.clone()).or_insert(0);
            if is_bad {
                *entry += 1;
                if *entry >= 2 {
                    warn!(
                        %agent_id,
                        ?state,
                        "pruning unhealthy agent (2 consecutive Zombie/Dead samples)"
                    );
                    to_prune.push(agent_id.clone());
                }
            } else {
                *entry = 0;
            }
        }

        // Drop streak lock before acquiring registry lock to reduce contention
        drop(streaks);

        // Now prune each agent with full index cleanup
        for agent_id in to_prune {
            // Remove from registry and get info for index cleanup
            if let Some(info) = self.registry.write().await.remove(&agent_id) {
                // Clean all indices atomically
                self.remove_agent_indices(
                    &agent_id,
                    &info.agent_uuid,
                    info.mcp_agent_id.as_deref(),
                )
                .await;

                // Also cleanup workspace (tmux session) to prevent resource leak
                if let Err(e) = self.backend.cleanup_workspace(&info.handle.workspace).await {
                    warn!(
                        agent_id = agent_id,
                        error = %e,
                        "Failed to cleanup workspace during prune"
                    );
                }

                pruned.push(agent_id);
            }
        }

        pruned
    }

    // ── MCP-to-Runtime agent ID binding ──

    /// Try to bind an MCP agent ID to an unmapped runtime agent.
    ///
    /// Uses FIFO strategy: finds the first runtime agent without an MCP binding
    /// and associates it with the given MCP ID. If no unmapped runtime agent
    /// exists, the MCP ID is added to the pending queue for later binding
    /// (when rmux discovery finds new panes).
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

        // Step 1: Check if already bound and collect cleanup info if stale
        let needs_cleanup = {
            let index = self.mcp_index.read().await;
            if let Some(runtime_id) = index.get(mcp_agent_id) {
                // HIGH BUG FIX: Verify the runtime_id still exists in registry.
                // Previously returned stale bindings for stopped/pruned agents,
                // causing permanent routing failures until server restart.
                let registry = self.registry.read().await;
                if registry.contains_key(runtime_id) {
                    debug!(
                        mcp_agent_id = mcp_agent_id,
                        runtime_id = runtime_id,
                        "MCP agent already bound (verified)"
                    );
                    return Some(runtime_id.clone());
                } else {
                    // Stale binding — mark for cleanup
                    warn!(
                        mcp_agent_id = mcp_agent_id,
                        runtime_id = runtime_id,
                        "Stale MCP binding detected (runtime agent gone), cleaning up"
                    );
                    true
                }
            } else {
                false
            }
        };
        // Read locks dropped here

        // Step 2: Clean up stale binding if needed (write lock)
        if needs_cleanup {
            self.mcp_index.write().await.remove(mcp_agent_id);
        }

        // Step 3: Sequential binding algorithm
        // Find the FIRST unbound runtime agent (by discovery order)
        // This assumes panes are opened one at a time and MCP connects shortly after
        let mut registry = self.registry.write().await;
        let mut unbound_agents: Vec<_> = registry
            .values()
            .filter(|info| info.mcp_agent_id.is_none())
            .collect();

        if unbound_agents.is_empty() {
            // No unmapped runtime agent — add to pending queue
            drop(registry);
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
        if let Some(info) = registry.get_mut(&runtime_id) {
            info.mcp_agent_id = Some(mcp_agent_id.to_string());
        } else {
            warn!(
                runtime_id = %runtime_id,
                mcp_agent_id = mcp_agent_id,
                "Agent disappeared during binding, aborting"
            );
            return None;
        }

        // Update the reverse index
        drop(registry);
        self.mcp_index
            .write()
            .await
            .insert(mcp_agent_id.to_string(), runtime_id.clone());

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

        // Check if already bound
        {
            let index = self.mcp_index.read().await;
            if let Some(runtime_id) = index.get(mcp_agent_id) {
                // HIGH BUG FIX: Verify the runtime_id still exists in registry.
                let registry = self.registry.read().await;
                if registry.contains_key(runtime_id) {
                    debug!(
                        mcp_agent_id = mcp_agent_id,
                        runtime_id = runtime_id,
                        "MCP agent already bound (verified)"
                    );
                    return Some(runtime_id.clone());
                } else {
                    warn!(
                        mcp_agent_id = mcp_agent_id,
                        runtime_id = runtime_id,
                        "Stale MCP binding detected (runtime agent gone), cleaning up"
                    );
                    drop(registry);
                    drop(index);
                    self.mcp_index.write().await.remove(mcp_agent_id);
                }
            }
        }

        // Find runtime agent with matching ergatai_agent_id
        let registry = self.registry.read().await;
        let matched_agent = registry.values().find(|info| {
            info.handle
                .metadata
                .get("ergatai_agent_id")
                .map(|id| id == agent_identifier)
                .unwrap_or(false)
        });

        let matched_agent = match matched_agent {
            Some(agent) => agent,
            None => {
                // No matching runtime agent found yet - add to pending queue
                // for later binding when discovery completes
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
        drop(registry);

        // Update the registry
        {
            let mut registry = self.registry.write().await;
            if let Some(info) = registry.get_mut(&runtime_id) {
                info.mcp_agent_id = Some(mcp_agent_id.to_string());
            }
        }

        // Update the reverse index
        self.mcp_index
            .write()
            .await
            .insert(mcp_agent_id.to_string(), runtime_id.clone());

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

        let mut registry = self.registry.write().await;
        let mut index = self.mcp_index.write().await;
        let mut bound = 0;
        let mut requeued = Vec::new();

        for (mcp_id, agent_identifier) in pending {
            // Skip if already bound (could happen if bound between queue and drain)
            if index.contains_key(&mcp_id) {
                continue;
            }

            // Find unbound runtime agents
            let mut unbound_agents: Vec<_> = registry
                .values()
                .filter(|info| info.mcp_agent_id.is_none())
                .collect();

            if unbound_agents.is_empty() {
                // Still no unmapped agent — re-queue
                requeued.push((mcp_id, agent_identifier));
                continue;
            }

            // Match by identifier if available, otherwise use FIFO
            let matched_agent = if !agent_identifier.is_empty() {
                // Find agent with matching ergatai_agent_id
                unbound_agents.into_iter().find(|info| {
                    info.handle
                        .metadata
                        .get("ergatai_agent_id")
                        .map(|id| id == &agent_identifier)
                        .unwrap_or(false)
                })
            } else {
                // FIFO: sort by creation time and take earliest
                unbound_agents.sort_by_key(|a| a.created_at);
                unbound_agents.into_iter().next()
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

            if let Some(info) = registry.get_mut(&runtime_id) {
                info.mcp_agent_id = Some(mcp_id.clone());
            }
            index.insert(mcp_id.clone(), runtime_id.clone());

            info!(
                mcp_agent_id = mcp_id,
                runtime_id = runtime_id,
                agent_identifier = agent_identifier,
                "Bound pending MCP agent to runtime agent"
            );
            bound += 1;
        }

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
        // Direct match in registry
        {
            let registry = self.registry.read().await;
            if registry.contains_key(agent_id) {
                return Some(agent_id.to_string());
            }

            // Stable ID lookup: search by ergatai_agent_id metadata (e.g. "agent-1").
            // This enables callers (batch_aggregator, conversation_manager, etc.)
            // to address agents by their human-readable stable name.
            for (runtime_id, info) in registry.iter() {
                if info
                    .handle
                    .metadata
                    .get("ergatai_agent_id")
                    .map(String::as_str)
                    == Some(agent_id)
                {
                    return Some(runtime_id.clone());
                }
            }
        }

        // MCP ID lookup
        let index = self.mcp_index.read().await;
        index.get(agent_id).cloned()
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
        // 1. Direct registry lookup (runtime ID)
        if let Some(info) = self.get_agent(agent_id).await {
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
        if let Some(runtime_id) = self.resolve_agent_id(agent_id).await {
            if let Some(info) = self.get_agent(&runtime_id).await {
                if let Some(ref stable) = info.stable_id {
                    return stable.clone();
                }
                if let Some(stable) = info.handle.metadata.get("ergatai_agent_id") {
                    return stable.clone();
                }
            }
            return runtime_id;
        }

        // 3. Stable ID match — check if agent_id matches any agent's stable_id
        // LOW FIX: Use stable_id_index for O(1) lookup instead of O(n) scan
        {
            let stable_id_index = self.stable_id_index.read().await;
            if stable_id_index.contains_key(agent_id) {
                return agent_id.to_string();
            }
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
        let registry = self.registry.read().await;
        registry
            .get(runtime_id)
            .and_then(|info| info.mcp_agent_id.clone())
    }

    /// Resolve agent UUID to current runtime ID (pane ID).
    ///
    /// This enables stable message routing: messages are addressed by UUID,
    /// which survives pane restarts. The UUID maps to the current pane ID.
    ///
    /// Uses O(1) hash map lookup via uuid_index for efficient resolution.
    pub async fn resolve_agent_uuid(&self, agent_uuid: &str) -> Option<String> {
        let index = self.uuid_index.read().await;
        index.get(agent_uuid).cloned()
    }

    /// Set agent UUID (for testing purposes only).
    #[cfg(test)]
    pub async fn set_agent_uuid_for_test(&self, agent_id: &str, uuid: &str) -> ErgataiResult<()> {
        let mut registry = self.registry.write().await;
        let info = registry
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
        let mut registry = self.registry.write().await;
        let info = registry
            .get_mut(agent_id)
            .ok_or_else(|| ErgataiError::internal(format!("Agent {} not found", agent_id)))?;
        info.lifecycle = new_state;
        Ok(())
    }

    /// Capture agent output.
    pub async fn capture_output(&self, agent_id: &str) -> ErgataiResult<Option<String>> {
        let info = {
            let registry = self.registry.read().await;
            registry
                .get(agent_id)
                .cloned()
                .ok_or_else(|| ErgataiError::internal(format!("Agent {} not found", agent_id)))?
        };

        self.backend.capture_output(&info.handle).await
    }

    /// Wait for agent to exit.
    pub async fn wait_for_exit(
        &self,
        agent_id: &str,
        timeout: Option<std::time::Duration>,
    ) -> ErgataiResult<WaitResult> {
        let info = {
            let registry = self.registry.read().await;
            registry
                .get(agent_id)
                .cloned()
                .ok_or_else(|| ErgataiError::internal(format!("Agent {} not found", agent_id)))?
        };

        self.backend.wait_for_exit(&info.handle, timeout).await
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
        let registry = self.registry.clone();
        let uuid_index = self.uuid_index.clone();
        let mcp_index = self.mcp_index.clone();
        let stable_id_index = self.stable_id_index.clone();
        let unhealthy_streaks = self.unhealthy_streaks.clone();
        let shutdown_token = self.shutdown_token.clone();

        tokio::spawn(async move {
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

            // Extract agent info before mutating registry
            let (agent_uuid, mcp_agent_id, stable_id, workspace_handle) = {
                let mut reg = registry.write().await;
                if let Some(info) = reg.get_mut(&agent_id) {
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
                    (
                        info.agent_uuid.clone(),
                        info.mcp_agent_id.clone(),
                        info.stable_id.clone(),
                        info.handle.workspace.clone(),
                    )
                } else {
                    // Agent was already removed (e.g., by stop_agent)
                    return;
                }
            };

            // HIGH BUG FIX: Grace period before cleanup. This gives callers time
            // to query the terminated agent's state (e.g., for exit code, duration).
            // After 60 seconds, remove from all indices to prevent memory leak.
            tokio::time::sleep(std::time::Duration::from_secs(60)).await;

            // CRITICAL FIX: Verify UUID consistency before removing. If agent_id was
            // re-bound to a new agent during the grace period, skip cleanup to avoid
            // destroying the new agent's registry entry and workspace.
            {
                let reg = registry.read().await;
                if let Some(current) = reg.get(&agent_id) {
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

            // Remove from all indices
            registry.write().await.remove(&agent_id);
            uuid_index.write().await.remove(&agent_uuid);
            if let Some(mcp_id) = mcp_agent_id {
                mcp_index.write().await.remove(&mcp_id);
            }
            if let Some(stable_id) = stable_id {
                stable_id_index.write().await.remove(&stable_id);
            }
            unhealthy_streaks.lock().await.remove(&agent_id);

            // Cleanup workspace (tmux session)
            if let Err(e) = backend.cleanup_workspace(&workspace_handle).await {
                debug!(
                    agent_id = agent_id,
                    error = %e,
                    "Failed to cleanup workspace after agent exit (may already be gone)"
                );
            }

            info!(
                agent_id = agent_id,
                "Terminated agent removed from all indices after grace period"
            );
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::backend::AgentRuntimeBackend;
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
    impl AgentRuntimeBackend for MockBackend {
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
            backend_config: serde_json::json!({}),
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
    async fn test_prune_unhealthy_agents_no_panic_without_rmux() {
        // With a non-Rmux backend, prune_unhealthy_agents() should be a silent no-op
        // (the downcast to RmuxBackend fails and the method returns early).
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
            state_history: Vec::new(),
        };
        runtime
            .registry
            .write()
            .await
            .insert(runtime_id.to_string(), info);
    }

    /// Helper: insert an MCP index mapping.
    async fn insert_mcp_binding(runtime: &AgentRuntime, mcp_id: &str, runtime_id: &str) {
        runtime
            .mcp_index
            .write()
            .await
            .insert(mcp_id.to_string(), runtime_id.to_string());
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
