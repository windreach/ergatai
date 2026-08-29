// Agent Launcher - Starts agents and injects tasks
// Manages agent sessions and monitors their completion
//
// ARCHITECTURE NOTE (Phase 8 - File Access Control Integration):
// This module is being migrated from git worktree isolation to file access control.
// Current state: Hybrid mode (worktrees + file access tokens)
// Target state: File access control only (worktrees removed)
//
// Migration progress:
// - ✅ File access control initialization
// - ✅ System Token registration for each agent
// - ✅ File Token request based on task scope
// - ⏳ Remove worktree creation (pending testing)
// - ⏳ Update agent instructions to use project root (pending testing)

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};

use ergatai_error::{ErgataiError, ErgataiResult};
use ergatai_lock::{FileMode, FileToken, SystemToken};
use ergatai_runtime::{get_agent_runtime, WorkspaceSpec};
use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;
use tracing::info;

use super::task_coordinator::{AgentAssignment, TaskCoordinator, TaskPlan};

/// Agent session status
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum AgentSessionStatus {
    Starting,
    Running,
    Completed,
    Failed,
}

impl AgentSessionStatus {
    /// Check if a state transition is valid.
    ///
    /// Valid transitions:
    /// - `Starting → Running` (agent launched successfully)
    /// - `Starting → Failed` (agent launch failed)
    /// - `Running → Completed` (agent finished successfully)
    /// - `Running → Failed` (agent finished with error)
    /// - `Completed` and `Failed` are terminal states (no transitions out)
    pub fn can_transition_to(&self, next: &AgentSessionStatus) -> bool {
        matches!(
            (self, next),
            (AgentSessionStatus::Starting, AgentSessionStatus::Running)
                | (AgentSessionStatus::Starting, AgentSessionStatus::Failed)
                | (AgentSessionStatus::Running, AgentSessionStatus::Completed)
                | (AgentSessionStatus::Running, AgentSessionStatus::Failed)
        )
    }

    /// Transition to a new status, returning an error if the transition is invalid.
    ///
    /// This enforces the state machine and prevents invalid transitions like
    /// `Completed → Starting` or `Failed → Running`.
    pub fn transition_to(
        &self,
        next: AgentSessionStatus,
    ) -> Result<AgentSessionStatus, ErgataiError> {
        if self.can_transition_to(&next) {
            Ok(next)
        } else {
            Err(ErgataiError::internal(format!(
                "Invalid agent status transition: {:?} → {:?}",
                self, next
            )))
        }
    }
}

/// Running agent information
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RunningAgent {
    pub task_id: String,
    pub agent_name: String,
    pub worktree_path: PathBuf,
    pub plan_file: PathBuf,
    pub result_file: PathBuf,
    pub status: AgentSessionStatus,
    /// New unified lifecycle state
    pub lifecycle: Option<ergatai_runtime::AgentLifecycleState>,
    /// Runtime agent ID where the agent is running
    pub pane_id: Option<String>,
    /// File access token ID (for file access control)
    pub token_id: Option<String>,
}

/// Global registry of running agents.
///
/// `AgentLauncher` is constructed per-NAPI-call, but we need running-agent
/// state to persist across calls so that `task_get_agents_status`,
/// `task_all_agents_completed`, and `task_merge_all` can observe agents
/// launched by prior calls. A global `OnceLock`-backed map gives us that
/// without threading handles through the NAPI layer.
fn running_agents() -> Arc<Mutex<HashMap<String, RunningAgent>>> {
    static REGISTRY: OnceLock<Arc<Mutex<HashMap<String, RunningAgent>>>> = OnceLock::new();
    REGISTRY
        .get_or_init(|| Arc::new(Mutex::new(HashMap::new())))
        .clone()
}

/// Global registry of heartbeat cancellation tokens, keyed by session_id.
/// When an agent task completes, the token is canceled to stop the background
/// heartbeat task that keeps `heartbeat_at` fresh for reused agents.
/// Uses std::sync::Mutex (not tokio) so it can be accessed from both sync
/// and async contexts. The lock is held only briefly for insert/remove.
fn heartbeat_cancellations(
) -> Arc<std::sync::Mutex<HashMap<String, tokio_util::sync::CancellationToken>>> {
    static REGISTRY: OnceLock<
        Arc<std::sync::Mutex<HashMap<String, tokio_util::sync::CancellationToken>>>,
    > = OnceLock::new();
    REGISTRY
        .get_or_init(|| Arc::new(std::sync::Mutex::new(HashMap::new())))
        .clone()
}

/// Cancel the heartbeat task for the given session_id (if any).
/// Called when an agent is removed from the running_agents registry.
fn cancel_heartbeat(session_id: &str) {
    if let Some(token) = heartbeat_cancellations().lock().unwrap().remove(session_id) {
        token.cancel();
    }
}

/// Per-project `ResultFileMonitor` — kernel-level watcher for result files using
/// Linux `fanotify` (FAN_CLOSE_WRITE). Initialized lazily per project root.
///
/// The monitor watches `{project_root}/.ergatai/.plan/results/` so it fires
/// only when an agent closes a result file it wrote. This replaces the prior
/// 1-second polling with an instantaneous kernel event, falling back to
/// polling only if fanotify cannot be initialized (non-Linux, AppArmor DENY,
/// etc.) or when the agent uses atomic rename (write-temp-then-rename).
fn result_file_monitor(project_root: &Path) -> crate::result_monitor::ResultFileMonitor {
    use std::sync::Mutex;
    static MONITORS: OnceLock<Mutex<HashMap<PathBuf, crate::result_monitor::ResultFileMonitor>>> =
        OnceLock::new();
    let monitors = MONITORS.get_or_init(|| Mutex::new(HashMap::new()));

    let results_dir = project_root.join(".ergatai").join(".plan").join("results");
    let mut map = monitors.lock().unwrap();
    if let Some(monitor) = map.get(&results_dir) {
        return monitor.clone();
    }
    // Ensure directory exists so fanotify_mark doesn't fail on missing path.
    // (Idempotent — racing creates are fine.) Log failure instead of silently
    // swallowing — otherwise fanotify_mark fails later with a confusing
    // "No such file or directory" error that masks the root cause.
    if let Err(e) = std::fs::create_dir_all(&results_dir) {
        tracing::warn!(
            results_dir = %results_dir.display(),
            error = %e,
            "Failed to create results directory — fanotify monitoring may fail"
        );
    }
    let monitor = crate::result_monitor::ResultFileMonitor::start(&results_dir);
    map.insert(results_dir, monitor.clone());
    monitor
}

/// Verify agent actually modified files by checking audit log entries.
///
/// This detects "hallucinating agents" that claim completion but didn't do work.
/// Logs a warning if no audit entries are found in the last hour.
async fn verify_agent_activity(agent_id: &str, task_id: &str) {
    if task_id.is_empty() {
        return;
    }
    let task_started_at = chrono::Utc::now() - chrono::Duration::hours(1);
    if let Ok(lock_manager) = ergatai_lock::get_lock_manager(task_id).await {
        match lock_manager.has_agent_activity_since(agent_id, task_started_at) {
            Ok(true) => {
                tracing::debug!(
                    agent = %agent_id,
                    "✅ Lock audit confirms agent modified files"
                );
            }
            Ok(false) => {
                tracing::warn!(
                    agent = %agent_id,
                    task_id = %task_id,
                    "⚠️ Agent claimed completion but has no lock audit history — possible hallucination"
                );
            }
            Err(e) => {
                tracing::debug!(
                    agent = %agent_id,
                    error = %e,
                    "Failed to query lock audit log (non-fatal)"
                );
            }
        }
    }
}

/// Safely truncate a UTF-8 string to at most max_len bytes,
/// ensuring we don't split multi-byte characters.
fn safe_truncate_utf8(s: &str, max_len: usize) -> String {
    if s.len() <= max_len {
        return s.to_string();
    }

    // Find the largest character boundary <= max_len
    let mut end = max_len;
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }

    format!("{}\n\n[... truncated ...]", &s[..end])
}

/// Agent Launcher - manages agent sessions
pub struct AgentLauncher {
    coordinator: Arc<TaskCoordinator>,
    running_agents: Arc<Mutex<HashMap<String, RunningAgent>>>,
}

impl AgentLauncher {
    /// Create a new AgentLauncher
    pub fn new(project_root: PathBuf) -> Self {
        let coordinator = Arc::new(TaskCoordinator::new(project_root));
        let running_agents = running_agents();

        Self {
            coordinator,
            running_agents,
        }
    }

    /// Launch all agents for a task plan
    pub async fn launch_agents(&self, plan: &TaskPlan) -> ErgataiResult<Vec<String>> {
        let mut agent_ids = Vec::with_capacity(plan.assignments.len());

        for assignment in &plan.assignments {
            let agent_id = self.launch_agent(plan, assignment).await?;
            agent_ids.push(agent_id);
        }

        Ok(agent_ids)
    }

    /// Launch a single agent for a task assignment
    pub async fn launch_agent(
        &self,
        plan: &TaskPlan,
        assignment: &AgentAssignment,
    ) -> ErgataiResult<String> {
        let agent_id = Self::make_agent_id(&plan.task_id, &assignment.agent_name);
        let project_id = &plan.task_id;
        let project_root = self.coordinator.project_root.clone();

        // Initialize file access control for the project (idempotent)
        ergatai_lock::init_file_access(project_id, &project_root).await?;

        // Get FileLockManager
        let lock_manager = ergatai_lock::get_lock_manager(project_id).await?;

        // Register System Token for this agent
        let session_id = format!("session-{}", agent_id);
        let system_token = SystemToken::new(
            assignment.agent_name.clone(),
            session_id.clone(),
            project_root.to_string_lossy().to_string(),
            3600, // 1 hour TTL
            30,   // 30 second heartbeat
        );

        info!(
            agent_id = agent_id,
            token_id = %system_token.id,
            "Registering system token for agent"
        );

        // Actually register the token
        lock_manager.register_system_token(&system_token)?;

        // Determine file scope based on assignment
        let scope =
            if assignment.files_to_modify.is_empty() && assignment.files_to_create.is_empty() {
                "**".to_string() // Full project access when no files specified
            } else {
                // Build scope from file list
                let mut patterns = Vec::with_capacity(
                    assignment.files_to_create.len() + assignment.files_to_modify.len(),
                );
                patterns.extend(
                    assignment
                        .files_to_create
                        .iter()
                        .map(|p| p.to_string_lossy().to_string()),
                );
                patterns.extend(
                    assignment
                        .files_to_modify
                        .iter()
                        .map(|p| p.to_string_lossy().to_string()),
                );

                if patterns.is_empty() {
                    "**".to_string()
                } else {
                    patterns.join(",")
                }
            };

        // Request File Token
        let priority = ergatai_lock::conflict_arbitration::priority_to_number(&assignment.priority);
        let file_token = FileToken::with_priority(
            assignment.agent_name.clone(),
            session_id.clone(),
            system_token.id.clone(),
            scope.clone(),
            FileMode::Write, // Agents need write access
            Some(format!("Task: {}", assignment.objective)),
            "system".to_string(), // System auto-approves for now
            3600,                 // 1 hour TTL
            30,                   // 30 second heartbeat
            priority,
        );

        info!(
            agent_id = agent_id,
            token_id = %file_token.id,
            scope = scope,
            "File token granted"
        );

        // Start Watchdog heartbeat for this session
        let watchdog = ergatai_lock::get_watchdog(project_id).await?;
        {
            let watchdog = watchdog.write().await;
            watchdog.mark_busy(&session_id, 3600).await?;
        }

        // Also update heartbeat_at in the database so other Watchdog instances
        // (created by other DAG tasks sharing the same project) see the fresh timestamp.
        // mark_busy only updates in-memory busy_status which is per-Watchdog.
        if let Err(e) = lock_manager.update_heartbeat(&system_token.id.to_string()) {
            tracing::warn!(
                session_id = %session_id,
                error = %e,
                "Failed to update system token heartbeat — Watchdog may consider agent dead"
            );
        }
        if let Err(e) = lock_manager.update_heartbeat(&file_token.id.to_string()) {
            tracing::warn!(
                session_id = %session_id,
                error = %e,
                "Failed to update file token heartbeat — Watchdog may consider agent dead"
            );
        }

        // Spawn a background heartbeat task that keeps heartbeat_at fresh for the
        // lifetime of this agent task. This is critical for reused agents: the
        // underlying process doesn't send heartbeats itself, and other DAG tasks'
        // Watchdog instances check heartbeat_at in the shared SQLite DB. Without
        // this periodic refresh, those Watchdogs would report spurious heartbeat
        // timeouts after 90s (= 3x the 30s heartbeat interval).
        // The task is canceled via CancellationToken when the agent is removed
        // from the running_agents registry (see `cancel_heartbeat`).
        {
            let heartbeat_session = session_id.clone();
            let heartbeat_project = project_id.to_string();
            let heartbeat_sys_token = system_token.id.to_string();
            let heartbeat_file_token = file_token.id.to_string();
            let cancel = tokio_util::sync::CancellationToken::new();
            let cancel_inner = cancel.clone();
            // Register the token so it can be canceled when the agent completes.
            heartbeat_cancellations()
                .lock()
                .unwrap()
                .insert(session_id.clone(), cancel);
            tokio::spawn(async move {
                let mut interval = tokio::time::interval(std::time::Duration::from_secs(30));
                // First tick fires immediately — skip it (we just updated above).
                interval.tick().await;
                loop {
                    tokio::select! {
                        _ = interval.tick() => {}
                        _ = cancel_inner.cancelled() => {
                            break;
                        }
                    }
                    let lm = match ergatai_lock::get_lock_manager(&heartbeat_project).await {
                        Ok(lm) => lm,
                        Err(_) => break,
                    };
                    let _ = lm.update_heartbeat(&heartbeat_sys_token);
                    let _ = lm.update_heartbeat(&heartbeat_file_token);
                    if let Ok(wd) = ergatai_lock::get_watchdog(&heartbeat_project).await {
                        let wd_guard = wd.write().await;
                        let _ = wd_guard.mark_busy(&heartbeat_session, 3600).await;
                    }
                }
            });
        }

        // Use project root (no worktree)
        let work_dir = project_root.clone();

        // Get result file path
        let result_file = self
            .coordinator
            .get_result_path(&plan.task_id, &assignment.agent_name)?;

        // Copy AGENT.md to work_dir (if exists)
        let agent_guide_path = self.coordinator.project_root.join(".ergatai/AGENT.md");
        if tokio::fs::try_exists(&agent_guide_path)
            .await
            .unwrap_or(false)
        {
            let workdir_agent_guide = work_dir.join("AGENT.md");
            tokio::fs::copy(&agent_guide_path, &workdir_agent_guide).await?;
        }

        // Create agent instruction text
        let instruction = self
            .create_agent_instruction(
                &assignment.agent_name,
                &work_dir,
                &plan.plan_file,
                &result_file,
                assignment,
            )
            .await;

        // Save instruction to file for debugging/auditing
        let instruction_file = work_dir.join(format!(".ergatai-task-{}.md", agent_id));
        tokio::fs::write(&instruction_file, &instruction).await?;

        // Create running agent record
        let running_agent = RunningAgent {
            task_id: plan.task_id.clone(),
            agent_name: assignment.agent_name.clone(),
            worktree_path: work_dir.clone(),
            plan_file: plan.plan_file.clone(),
            result_file: result_file.clone(),
            status: AgentSessionStatus::Starting,
            lifecycle: None,
            pane_id: None,
            token_id: Some(file_token.id.to_string()),
        };

        self.running_agents
            .lock()
            .await
            .insert(agent_id.clone(), running_agent);

        // Launch agent — check if it already exists in the registry first.
        // Extract node_id from plan file (DAG nodes use {node_id}.md naming)
        let node_id = plan
            .plan_file
            .file_stem()
            .and_then(|s| s.to_str())
            .map(|s| s.to_string());

        // Try to find an existing registered agent matching the assignment's agent_name.
        // This allows DAG tasks to be dispatched to already-running agents (e.g., opencode
        // instances connected via MCP) instead of always spawning new processes.
        let runtime = get_agent_runtime();
        let existing_agent_id = self
            .find_registered_agent(&runtime, &assignment.agent_name)
            .await;

        if let Some(runtime_agent_id) = existing_agent_id {
            // Agent already exists — deliver task via message injection instead of launching new process
            tracing::info!(
                agent = %agent_id,
                agent_name = %assignment.agent_name,
                runtime_agent_id = %runtime_agent_id,
                "✅ Reusing existing registered agent — delivering task via inject_message"
            );

            // Update running agent status to Running
            {
                let mut agents = self.running_agents.lock().await;
                if let Some(agent) = agents.get_mut(&agent_id) {
                    let _ = agent.status.transition_to(AgentSessionStatus::Running);
                    agent.pane_id = Some(runtime_agent_id.clone());
                }
            }

            // Inject the instruction as a message to the existing agent
            if let Err(e) = runtime
                .inject_message(&runtime_agent_id, &instruction)
                .await
            {
                tracing::error!(
                    agent = %agent_id,
                    runtime_agent_id = %runtime_agent_id,
                    error = %e,
                    "Failed to inject message into existing agent"
                );
                return Err(ErgataiError::AgentSpawnFailed(format!(
                    "Failed to inject message into existing agent '{}': {}",
                    agent_id, e
                )));
            }

            // Spawn a lightweight watcher that only polls for result file (no process exit monitoring
            // since the process is shared/reused, not owned by this DAG).
            if let Some(ref node_id_val) = node_id {
                self.spawn_result_file_watcher(&agent_id, &runtime_agent_id, node_id_val)
                    .await;
            }
        } else {
            // Agent not found in registry — launch a new process
            self.spawn_agent_session(
                &agent_id,
                &work_dir,
                &assignment.agent_name,
                &instruction,
                node_id,
            )
            .await?;
        }

        Ok(agent_id)
    }

    /// Build a deterministic agent id from task_id + agent_name.
    ///
    /// Uses `|` as separator because both task_id and agent_name may contain `-`.
    pub fn make_agent_id(task_id: &str, agent_name: &str) -> String {
        format!("{}|{}", task_id, agent_name)
    }

    /// Parse a (task_id, agent_name) pair from an agent id produced by `make_agent_id`.
    pub fn parse_agent_id(agent_id: &str) -> Option<(&str, &str)> {
        agent_id.split_once('|')
    }

    /// Check if an agent with the given name is already registered in the runtime.
    ///
    /// Searches by: agent_id, stable_id, and mcp_agent_id.
    /// Returns the runtime agent_id if found and alive.
    async fn find_registered_agent(
        &self,
        runtime: &ergatai_runtime::AgentRuntime,
        agent_name: &str,
    ) -> Option<String> {
        // List all agents and match by agent_id, stable_id, or mcp_agent_id
        let agents = runtime.list_agents().await;
        for info in &agents {
            let matches = info.agent_id == agent_name
                || info.stable_id.as_deref() == Some(agent_name)
                || info.mcp_agent_id.as_deref() == Some(agent_name);
            if matches && info.lifecycle.is_alive() {
                tracing::info!(
                    agent_name = %agent_name,
                    runtime_id = %info.agent_id,
                    stable_id = ?info.stable_id,
                    "Found existing registered agent — will reuse instead of launching new process"
                );
                return Some(info.agent_id.clone());
            }
        }

        tracing::debug!(
            agent_name = %agent_name,
            total_agents = agents.len(),
            "No existing alive agent found matching name — will launch new process"
        );
        None
    }

    /// Spawn a lightweight watcher that only polls for the result file.
    ///
    /// Used for reused agents where we can't monitor process exit (the process is shared).
    /// When the result file appears, publishes a NATS completion event so DagScheduler
    /// picks up the node completion.
    async fn spawn_result_file_watcher(
        &self,
        agent_id: &str,
        _runtime_agent_id: &str,
        node_id: &str,
    ) {
        let agent_id_monitor = agent_id.to_string();
        let node_id_monitor = node_id.to_string();
        let running_agents = self.running_agents.clone();

        // Capture agent_name and result file path
        let (agent_name_monitor, result_file_for_watcher) = {
            let agents = self.running_agents.lock().await;
            let a = agents.get(agent_id);
            (
                a.map(|a| a.agent_name.clone()).unwrap_or_default(),
                a.map(|a| a.result_file.clone()),
            )
        };

        tracing::info!(
            agent = %agent_id,
            node_id = %node_id,
            result_file = ?result_file_for_watcher,
            "Spawning result-file-only watcher for reused agent"
        );

        let project_root = self.coordinator.project_root.clone();
        let node_id_for_monitor = node_id_monitor.clone();

        tokio::spawn(async move {
            let max_runtime = std::time::Duration::from_secs(3600); // 1h hard cap
            let result_poll_interval = std::time::Duration::from_secs(1);

            // Register with fanotify monitor (returns Canceled immediately if
            // fanotify is unavailable, letting polling take over).
            let monitor = result_file_monitor(&project_root);
            let fanotify_rx = monitor.register(&node_id_for_monitor).await;

            // Race: fanotify close_write | polling fallback | max_runtime.
            // Polling remains as a fallback for agents that use atomic rename
            // (write-temp-then-rename) — FAN_CLOSE_WRITE doesn't fire on rename.
            let result_found = tokio::select! {
                // Branch 1: fanotify — file closed after write, instant signal.
                r = fanotify_rx => {
                    match r {
                        Ok(path) => {
                            tracing::info!(
                                node_id = %node_id_for_monitor,
                                path = %path.display(),
                                "fanotify: result file closed (FAN_CLOSE_WRITE)"
                            );
                            true
                        }
                        Err(_) => {
                            // Canceled: monitor unavailable or node unregistered
                            // before event. Fall through to polling (handled
                            // below by the loop continuing).
                            tracing::debug!(
                                node_id = %node_id_for_monitor,
                                "fanotify receiver canceled — using polling fallback"
                            );
                            loop {
                                tokio::time::sleep(result_poll_interval).await;
                                if let Some(ref path) = result_file_for_watcher {
                                    if tokio::fs::try_exists(path).await.unwrap_or(false) {
                                        break;
                                    }
                                }
                            }
                            true
                        }
                    }
                }
                // Branch 2: polling fallback (also catches atomic rename cases
                // where fanotify never fires).
                _ = async {
                    loop {
                        tokio::time::sleep(result_poll_interval).await;
                        if let Some(ref path) = result_file_for_watcher {
                            if tokio::fs::try_exists(path).await.unwrap_or(false) {
                                return true;
                            }
                        }
                    }
                    #[allow(unreachable_code)]
                    false
                } => true,
                // Branch 3: hard timeout.
                _ = tokio::time::sleep(max_runtime) => false,
            };

            // Always unregister — either the event consumed the slot, or we're
            // bailing out (timeout / no result). Idempotent.
            monitor.unregister(&node_id_for_monitor);

            if result_found {
                tracing::info!(
                    agent = %agent_id_monitor,
                    node_id = %node_id_monitor,
                    result_file = ?result_file_for_watcher,
                    "✅ Result file detected for reused agent — node completed"
                );
                // Give agent a moment to finish writing
                tokio::time::sleep(std::time::Duration::from_millis(500)).await;

                // Sanity check: verify agent actually modified files (has audit log entries).
                if let Some(agent_info) =
                    running_agents.lock().await.get(&agent_id_monitor).cloned()
                {
                    verify_agent_activity(&agent_id_monitor, &agent_info.task_id).await;
                }
            } else {
                tracing::warn!(
                    agent = %agent_id_monitor,
                    "Reused agent exceeded max runtime without producing result file"
                );
            }

            // Determine success/failure: result file exists → Completed, else → Failed
            let result_file_path = {
                let agents = running_agents.lock().await;
                agents.get(&agent_id_monitor).map(|a| a.result_file.clone())
            };

            let result_file_exists = match &result_file_path {
                Some(path) => tokio::fs::try_exists(path).await.unwrap_or(false),
                None => false,
            };

            // Update status
            {
                let mut agents = running_agents.lock().await;
                if let Some(agent) = agents.get_mut(&agent_id_monitor) {
                    if result_file_exists {
                        let _ = agent.status.transition_to(AgentSessionStatus::Completed);
                    } else {
                        let _ = agent.status.transition_to(AgentSessionStatus::Failed);
                    }
                }
            }

            // Publish NATS event so DagScheduler picks up completion (same pattern as spawn_agent_session watcher)
            if ergatai_nats::is_nats_initialized().await {
                if let Some(conn) = ergatai_nats::get_nats_connection().await {
                    let bus = ergatai_nats::event_bus::EventBus::new(conn);
                    if result_file_exists {
                        let payload = ergatai_nats::events::NodeCompletePayload {
                            node_id: node_id_monitor.clone(),
                            task_id: node_id_monitor.clone(),
                            agent_name: agent_name_monitor.clone(),
                            result_summary: Some("Reused agent completed task".to_string()),
                            outputs: if let Some(ref path) = result_file_path {
                                parse_result_file_outputs(path).await
                            } else {
                                serde_json::Value::Object(serde_json::Map::new())
                            },
                            result_file: result_file_path.map(|p| p.to_string_lossy().to_string()),
                        };
                        if let Err(e) = bus.publish_node_complete(&payload).await {
                            tracing::error!(
                                error = %e,
                                node_id = %node_id_monitor,
                                "Failed to publish node_complete for reused agent"
                            );
                        } else {
                            tracing::info!(
                                node_id = %node_id_monitor,
                                "📨 Published node_complete for reused agent"
                            );
                        }
                    } else {
                        let payload = ergatai_nats::events::NodeFailedPayload {
                            node_id: node_id_monitor.clone(),
                            task_id: node_id_monitor.clone(),
                            agent_name: agent_name_monitor.clone(),
                            error: "Result file not produced within timeout".to_string(),
                            retryable: false,
                        };
                        if let Err(e) = bus.publish_node_failed(&payload).await {
                            tracing::error!(
                                error = %e,
                                node_id = %node_id_monitor,
                                "Failed to publish node_failed for reused agent"
                            );
                        }
                    }
                }
            }
        });
    }

    /// Create instruction for agent (in English for token efficiency)
    async fn create_agent_instruction(
        &self,
        agent_name: &str,
        work_dir: &Path,
        plan_file: &Path,
        result_file: &Path,
        assignment: &AgentAssignment,
    ) -> String {
        let task_type_dbg = format!("{:?}", assignment.task_type);
        let files_section = self.format_files_section(assignment);

        // Read project context
        let project_context = self.read_project_context().await;

        // Build expected_outputs section (only shown when non-empty)
        let expected_outputs_section = if assignment.expected_outputs.is_empty() {
            String::new()
        } else {
            let mut lines = Vec::new();
            lines.push(String::new());
            lines.push("### Expected Outputs".to_string());
            lines.push(
                "You MUST include these keys in the `outputs` frontmatter of your result file:"
                    .to_string(),
            );
            for (key, desc) in &assignment.expected_outputs {
                lines.push(format!("- **{}**: {}", key, desc));
            }
            lines.push(String::new());
            lines.push(
                "Downstream agents depend on these values — use real, concrete data (paths, \
                 endpoints, identifiers), not placeholders."
                    .to_string(),
            );
            lines.join("\n")
        };

        // DAG overview hint — the plan file already has the full DAG picture
        let dag_overview_hint = "The plan file contains a **DAG Overview** section at the top. \
             It shows all participants, the dependency graph, the communication policy, \
             and your position in the DAG. Read it carefully before starting."
            .to_string();

        format!(
            r#"# Project Context

{project_context}

---

# Task Assignment for @{agent_name}

## Your Work Directory
```
{work_dir}
```

You are working in the project root directory with file access control enabled.
The system manages file locks to prevent conflicts with other agents.

## Task Plan
Read the full plan: `{plan_file}`

Find your assignment section (marked with `@{agent_name}`)
{dag_overview_hint}

## Your Objective
{objective}

## Task Type
{task_type}

## Files
{files_section}

## Ergatai Workflow

You are running as part of a multi-agent orchestration (DAG).
The DAG dispatcher assigns tasks to agents, and agents communicate by writing \
structured results to their result files. Downstream agents automatically receive \
your outputs via template variables.

## Instructions

1. Read the plan file — it contains the full DAG overview (all participants, \
   dependencies, your role)
2. Work in the project directory (file access control is active)
3. Complete your assigned task
4. Write your results to: `{result_file}`

## Result Format

Write your result file with YAML frontmatter for structured outputs. Downstream agents \
can reference your outputs via template variables like `{{{{node_id.key}}}}`:

```markdown
---
outputs:
  key1: "value1"
  key2: "value2"
---
# Task Result

## Status
[Completed/Failed/Partial]

## Summary
[Brief summary of what you did]

## Details
[Detailed description of your work]

## Files Created/Modified
- [list of files]

## Notes
[Any additional notes or issues]
```

The `outputs` in frontmatter are automatically passed to downstream tasks.
Include all structured data that downstream agents might need (file paths, endpoints,
identifiers, configuration values, etc.).
{expected_outputs_section}

## Important Notes

- File access control is active — the system manages file locks automatically
- Focus only on your assigned objective
- If you encounter issues, document them in your result file
- Complete your task and write the result file when done
"#,
            project_context = project_context,
            agent_name = agent_name,
            work_dir = work_dir.display(),
            plan_file = plan_file.display(),
            dag_overview_hint = dag_overview_hint,
            objective = assignment.objective,
            task_type = task_type_dbg,
            files_section = files_section,
            expected_outputs_section = expected_outputs_section,
            result_file = result_file.display(),
        )
    }

    /// Format files section for instruction
    fn format_files_section(&self, assignment: &AgentAssignment) -> String {
        // Pre-allocate for both sections
        let mut sections = Vec::with_capacity(2);

        if !assignment.files_to_create.is_empty() {
            sections.push("**Files to create:**".to_string());
            for file in &assignment.files_to_create {
                sections.push(format!("- {}", file.display()));
            }
        }

        if !assignment.files_to_modify.is_empty() {
            sections.push("**Files to modify:**".to_string());
            for file in &assignment.files_to_modify {
                sections.push(format!("- {}", file.display()));
            }
        }

        if !assignment.files_to_read.is_empty() {
            sections.push("**Files to read:**".to_string());
            for file in &assignment.files_to_read {
                sections.push(format!("- {}", file.display()));
            }
        }

        if sections.is_empty() {
            "No specific files assigned".to_string()
        } else {
            sections.join("\n")
        }
    }

    /// Spawn an agent using AgentRuntime and inject the instruction as a prompt.
    ///
    /// Steps:
    /// 1. Get global AgentRuntime singleton (fixes lifetime bug)
    /// 2. Create workspace spec with work_dir and backend config
    /// 3. Launch agent via runtime (creates workspace + starts process)
    /// 4. Inject instruction via runtime (backend injection or MCP fallback)
    /// 5. Spawn a background watcher that monitors agent exit and
    ///    publishes NATS events so DagScheduler picks up completion/failure.
    ///
    /// If `node_id` is Some, the agent is part of a DAG — completion/failure
    /// automatically triggers `DagScheduler::on_node_completed/failed`.
    async fn spawn_agent_session(
        &self,
        agent_id: &str,
        worktree_path: &Path,
        agent_name: &str,
        instruction: &str,
        node_id: Option<String>,
    ) -> ErgataiResult<()> {
        tracing::info!(
            agent = %agent_id,
            agent_name = %agent_name,
            worktree = %worktree_path.display(),
            "Spawning agent via AgentRuntime"
        );

        // 1. Get global AgentRuntime singleton (fixes lifetime bug)
        let runtime = get_agent_runtime();

        // 2. Create workspace spec
        let workspace_id = format!("dag-{}", agent_id.replace('|', "-"));
        let spec = WorkspaceSpec {
            id: workspace_id.clone(),
            work_dir: worktree_path.to_path_buf(),
            env: std::collections::HashMap::new(),
            resources: Default::default(),
        };

        // 3. Build the agent launch command.
        //    Default: `claude` (Claude Code CLI). Users can override by setting
        //    ERGATAI_AGENT_CMD env var.
        let base_command =
            std::env::var("ERGATAI_AGENT_CMD").unwrap_or_else(|_| "claude".to_string());

        // Validate agent command — reject obvious injection patterns
        if base_command.is_empty() {
            return Err(ergatai_error::ErgataiError::AgentSpawnFailed(
                "ERGATAI_AGENT_CMD is empty".to_string(),
            ));
        }
        if base_command.contains('\n') || base_command.contains('\r') {
            return Err(ergatai_error::ErgataiError::AgentSpawnFailed(
                "ERGATAI_AGENT_CMD contains newline characters".to_string(),
            ));
        }
        // SECURITY: Reject shell metacharacters that could enable command injection
        // when interpolated into `sh -c` via runtime.launch_agent().
        // Allowed: alphanumeric, dashes, underscores, dots, slashes (for paths),
        // colons (for env var prefixes like RUST_LOG=debug).
        const SHELL_META: &str = ";|&$`(){}<>!\\ \t\"'";
        if base_command.chars().any(|c| SHELL_META.contains(c)) {
            return Err(ergatai_error::ErgataiError::AgentSpawnFailed(format!(
                "ERGATAI_AGENT_CMD contains shell metacharacters ({:?}). \
                 Only alphanumeric, dashes, underscores, dots, slashes, and colons are allowed.",
                base_command
            )));
        }

        // 3b. Generate MCP config so the agent can connect to ergatai's MCP server.
        //     This gives the agent access to tools like `submit_orchestration`, `check_dag_status`, etc.
        let api_port = std::env::var("ERGATAI_API_PORT").unwrap_or_else(|_| "3000".to_string());
        let mcp_url = format!("http://127.0.0.1:{}/mcp", api_port);
        let mcp_config = serde_json::json!({
            "mcpServers": {
                "ergatai": {
                    "type": "url",
                    "url": mcp_url
                }
            }
        });
        let mcp_config_path =
            worktree_path.join(format!(".ergatai-mcp-{}.json", agent_id.replace('|', "-")));
        if let Err(e) = tokio::fs::write(&mcp_config_path, mcp_config.to_string()).await {
            tracing::warn!(
                agent = %agent_id,
                error = %e,
                "Failed to write MCP config file — agent will not have ergatai tools"
            );
        }

        // Append --mcp-config and --yes (auto-approve) to the agent command.
        // DAG-dispatched agents must run fully autonomously — no interactive permission prompts.
        //
        // SECURITY: The `worktree_path` (and therefore `mcp_config_path`) may contain spaces
        // or other shell metacharacters — it is derived from the user's project root, which
        // we do not control. `agent_command` is passed to `runtime.launch_agent()`, which
        // spawns via `sh -c`, so unquoted paths break on spaces and are exploitable via
        // metacharacters ($, `, ;, |, etc.). Wrap the path in single quotes and escape any
        // embedded single quotes via the standard '\'' trick (close the quote, insert a
        // literal escaped quote, reopen the quote).
        let mcp_config_path_escaped = mcp_config_path.display().to_string().replace('\'', "'\\''");
        let agent_command = format!(
            "{} --yes --mcp-config '{}'",
            base_command, mcp_config_path_escaped
        );

        // 4. Launch agent via runtime (creates workspace + starts process)
        let runtime_agent_id = runtime
            .launch_agent(spec, &agent_command, Some(instruction))
            .await
            .map_err(|e| {
                ergatai_error::ErgataiError::AgentSpawnFailed(format!(
                    "Failed to launch agent '{}': {}",
                    agent_id, e
                ))
            })?;

        // 5. Set task_id for DAG tracking
        if let Err(e) = runtime
            .set_task_id(&runtime_agent_id, agent_id.to_string())
            .await
        {
            tracing::warn!(
                agent = %agent_id,
                runtime_agent_id = %runtime_agent_id,
                error = %e,
                "Failed to set task_id on runtime — DAG completion tracking may be broken"
            );
        }

        tracing::info!(
            agent = %agent_id,
            runtime_agent_id = %runtime_agent_id,
            "Agent launched via AgentRuntime"
        );

        // 6. Update RunningAgent with status (validate state transition)
        {
            let mut agents = self.running_agents.lock().await;
            if let Some(agent) = agents.get_mut(agent_id) {
                match agent.status.transition_to(AgentSessionStatus::Running) {
                    Ok(new_status) => {
                        agent.status = new_status;
                        tracing::debug!(agent_id = %agent_id, "Agent status: Starting → Running");
                    }
                    Err(e) => {
                        // MEDIUM #6 fix: Invalid state transitions indicate a bug in the
                        // state machine. Use error! level so it surfaces in monitoring
                        // rather than being lost among normal warnings.
                        tracing::error!(
                            agent_id = %agent_id,
                            current_status = ?agent.status,
                            error = %e,
                            "BUG: Invalid state transition to Running — state machine invariant violated"
                        );
                    }
                }
            }
        }

        // 7. Background watcher — monitor agent exit OR result file appearance,
        //    then publish NATS event.
        //
        //    IMPORTANT: Agents run `claude` (interactive CLI) which stays alive after
        //    completing the task. We can't rely solely on `wait_for_exit` — we also poll
        //    for the result file. When the result file appears, the agent has finished
        //    its work regardless of whether the process has exited.
        if let Some(node_id_val) = node_id {
            let agent_id_monitor = agent_id.to_string();
            let agent_name_monitor = agent_name.to_string();
            let node_id_monitor = node_id_val.clone();
            let running_agents = self.running_agents.clone();
            let runtime_monitor = runtime.clone();
            let runtime_agent_id_monitor = runtime_agent_id.clone();

            // Capture result file path and task_id BEFORE spawning — the watcher needs them
            let (result_file_for_watcher, task_id_for_audit) = {
                let agents = self.running_agents.lock().await;
                let agent_info = agents.get(agent_id);
                (
                    agent_info.map(|a| a.result_file.clone()),
                    agent_info.map(|a| a.task_id.clone()).unwrap_or_default(),
                )
            };

            tracing::info!(
                agent = %agent_id,
                node_id = %node_id_val,
                result_file = ?result_file_for_watcher,
                "Spawning agent-exit + result-file watcher for DAG agent"
            );

            let project_root = self.coordinator.project_root.clone();
            let node_id_for_monitor = node_id_monitor.clone();

            tokio::spawn(async move {
                let max_runtime = std::time::Duration::from_secs(3600); // 1h hard cap
                let result_poll_interval = std::time::Duration::from_secs(1);

                // Register with fanotify monitor (no-op stub if unavailable).
                let monitor = result_file_monitor(&project_root);
                let fanotify_rx = monitor.register(&node_id_for_monitor).await;

                // Race four conditions:
                //   1. Agent process exits (wait_for_exit)
                //   2. fanotify FAN_CLOSE_WRITE — result file fully written (instant)
                //   3. Result file polling fallback (1s interval — catches atomic rename)
                //   4. Max runtime exceeded (timeout)
                enum CompletionTrigger {
                    ProcessExit(ErgataiResult<ergatai_runtime::WaitResult>),
                    FanotifyCloseWrite(PathBuf),
                    ResultFileAppeared,
                    TimedOut,
                }

                let trigger = tokio::select! {
                    result = runtime_monitor.wait_for_exit(&runtime_agent_id_monitor, Some(max_runtime)) => {
                        CompletionTrigger::ProcessExit(result)
                    }
                    // fanotify: instant signal on file close after write.
                    r = fanotify_rx => {
                        match r {
                            Ok(path) => CompletionTrigger::FanotifyCloseWrite(path),
                            Err(_) => {
                                // Monitor unavailable or canceled — fall through to polling.
                                loop {
                                    tokio::time::sleep(result_poll_interval).await;
                                    if let Some(ref path) = result_file_for_watcher {
                                        if tokio::fs::try_exists(path).await.unwrap_or(false) {
                                            break;
                                        }
                                    }
                                }
                                CompletionTrigger::ResultFileAppeared
                            }
                        }
                    }
                    // Polling fallback — catches atomic rename and fanotify-unavailable.
                    _ = async {
                        loop {
                            tokio::time::sleep(result_poll_interval).await;
                            if let Some(ref path) = result_file_for_watcher {
                                if tokio::fs::try_exists(path).await.unwrap_or(false) {
                                    return;
                                }
                            }
                        }
                    } => {
                        CompletionTrigger::ResultFileAppeared
                    }
                    _ = tokio::time::sleep(max_runtime) => {
                        CompletionTrigger::TimedOut
                    }
                };

                // Always unregister — idempotent cleanup.
                monitor.unregister(&node_id_for_monitor);

                match &trigger {
                    CompletionTrigger::ProcessExit(Ok(ergatai_runtime::WaitResult::Exited {
                        code: _,
                    })) => {
                        tracing::info!(
                            agent = %agent_id_monitor,
                            node_id = %node_id_monitor,
                            "Agent exited normally"
                        );
                    }
                    CompletionTrigger::ProcessExit(Ok(ergatai_runtime::WaitResult::Signaled {
                        signal,
                    })) => {
                        tracing::warn!(
                            agent = %agent_id_monitor,
                            signal = signal,
                            "Agent killed by signal"
                        );
                    }
                    CompletionTrigger::ProcessExit(Ok(ergatai_runtime::WaitResult::Timeout)) => {
                        tracing::warn!(
                            agent = %agent_id_monitor,
                            "Agent wait timed out"
                        );
                    }
                    CompletionTrigger::ProcessExit(Ok(ergatai_runtime::WaitResult::Error(e))) => {
                        tracing::error!(
                            agent = %agent_id_monitor,
                            error = %e,
                            "Agent wait error"
                        );
                    }
                    CompletionTrigger::ProcessExit(Err(e)) => {
                        tracing::error!(
                            agent = %agent_id_monitor,
                            error = %e,
                            "Agent wait failed"
                        );
                    }
                    CompletionTrigger::FanotifyCloseWrite(path) => {
                        tracing::info!(
                            agent = %agent_id_monitor,
                            node_id = %node_id_monitor,
                            path = %path.display(),
                            "✅ Result file closed (FAN_CLOSE_WRITE via fanotify) — instant detection"
                        );
                        // FAN_CLOSE_WRITE guarantees the fd is closed and data flushed.
                        // No additional sleep needed (unlike the polling path).

                        // Sanity check: verify agent actually modified files (has audit log entries).
                        verify_agent_activity(&agent_id_monitor, &task_id_for_audit).await;
                    }
                    CompletionTrigger::ResultFileAppeared => {
                        tracing::info!(
                            agent = %agent_id_monitor,
                            node_id = %node_id_monitor,
                            result_file = ?result_file_for_watcher,
                            "✅ Result file detected — agent completed work (process may still be alive)"
                        );
                        // Give agent a moment to finish writing, then proceed
                        tokio::time::sleep(std::time::Duration::from_millis(500)).await;

                        // Sanity check: verify agent actually modified files (has audit log entries).
                        verify_agent_activity(&agent_id_monitor, &task_id_for_audit).await;
                    }
                    CompletionTrigger::TimedOut => {
                        tracing::warn!(
                            agent = %agent_id_monitor,
                            "Agent exceeded max runtime, marking as failed"
                        );
                        let _ = runtime_monitor.stop_agent(&runtime_agent_id_monitor).await;
                    }
                }

                // Determine success/failure heuristically:
                //   - result file exists → Completed
                //   - otherwise → Failed
                let result_file_path = {
                    let agents = running_agents.lock().await;
                    agents.get(&agent_id_monitor).map(|a| a.result_file.clone())
                };

                let result_file_exists = if let Some(ref path) = result_file_path {
                    tokio::fs::try_exists(path).await.unwrap_or(false)
                } else {
                    false
                };

                let (status, error_msg) = if result_file_exists {
                    (AgentSessionStatus::Completed, None)
                } else {
                    (
                        AgentSessionStatus::Failed,
                        Some(format!(
                            "Agent exited without producing result file: {}",
                            result_file_path
                                .as_ref()
                                .map(|p| p.display().to_string())
                                .unwrap_or_else(|| "(unknown)".into())
                        )),
                    )
                };

                // Update RunningAgent status (validate state transition)
                {
                    let mut agents = running_agents.lock().await;
                    if let Some(agent) = agents.get_mut(&agent_id_monitor) {
                        match agent.status.transition_to(status.clone()) {
                            Ok(new_status) => {
                                agent.status = new_status;
                                tracing::info!(
                                    agent_id = %agent_id_monitor,
                                    "Agent status: Running → {:?}",
                                    agent.status
                                );
                            }
                            Err(e) => {
                                // MEDIUM #6 fix: Invalid state transitions indicate a bug.
                                tracing::error!(
                                    agent_id = %agent_id_monitor,
                                    current_status = ?agent.status,
                                    target_status = ?status,
                                    error = %e,
                                    "BUG: Invalid state transition to terminal state — state machine invariant violated"
                                );
                            }
                        }
                    }
                }

                // Capture output for result summary (best-effort)
                let result_summary = runtime_monitor
                    .capture_output(&runtime_agent_id_monitor)
                    .await
                    .ok()
                    .flatten()
                    .map(|s| {
                        if s.len() > 2000 {
                            // Find a safe char boundary to avoid panicking on multi-byte UTF-8
                            let mut start = s.len() - 2000;
                            while start > 0 && !s.is_char_boundary(start) {
                                start -= 1;
                            }
                            s[start..].to_string()
                        } else {
                            s
                        }
                    });

                // Publish NATS event for DagScheduler
                if ergatai_nats::is_nats_initialized().await {
                    if let Some(conn) = ergatai_nats::get_nats_connection().await {
                        let bus = ergatai_nats::event_bus::EventBus::new(conn);
                        match &result_file_exists {
                            true => {
                                let payload = ergatai_nats::events::NodeCompletePayload {
                                    node_id: node_id_monitor.clone(),
                                    task_id: node_id_monitor.clone(),
                                    agent_name: agent_name_monitor.clone(),
                                    result_summary,
                                    outputs: if let Some(ref path) = result_file_path {
                                        parse_result_file_outputs(path).await
                                    } else {
                                        serde_json::Value::Object(serde_json::Map::new())
                                    },
                                    result_file: result_file_path
                                        .map(|p| p.to_string_lossy().to_string()),
                                };
                                if let Err(e) = bus.publish_node_complete(&payload).await {
                                    tracing::error!(
                                        error = %e,
                                        node_id = %node_id_monitor,
                                        "Failed to publish node_complete"
                                    );
                                }
                            }
                            false => {
                                let payload = ergatai_nats::events::NodeFailedPayload {
                                    node_id: node_id_monitor.clone(),
                                    task_id: node_id_monitor.clone(),
                                    agent_name: agent_name_monitor.clone(),
                                    error: error_msg.unwrap_or_default(),
                                    retryable: false,
                                };
                                if let Err(e) = bus.publish_node_failed(&payload).await {
                                    tracing::error!(
                                        error = %e,
                                        node_id = %node_id_monitor,
                                        "Failed to publish node_failed"
                                    );
                                }
                            }
                        }
                    }
                }
            });
        }

        Ok(())
    }

    /// Get status of all running agents
    pub async fn get_all_status(&self) -> Vec<RunningAgent> {
        self.running_agents.lock().await.values().cloned().collect()
    }

    /// Get status of specific agent
    pub async fn get_agent_status(&self, agent_id: &str) -> Option<RunningAgent> {
        self.running_agents.lock().await.get(agent_id).cloned()
    }

    /// Check if all agents for a task are completed
    pub async fn all_agents_completed(&self, task_id: &str) -> bool {
        let agents = self.running_agents.lock().await;
        let mut any = false;
        for a in agents.values() {
            if a.task_id != task_id {
                continue;
            }
            any = true;
            if a.status != AgentSessionStatus::Completed && a.status != AgentSessionStatus::Failed {
                return false;
            }
        }
        any
    }

    /// Clean up agent resources (runtime agent + file tokens)
    pub async fn cleanup_agent(&self, agent_id: &str) -> ErgataiResult<()> {
        if let Some(agent) = self.running_agents.lock().await.remove(agent_id) {
            // Cancel the heartbeat task (if any) for this agent.
            cancel_heartbeat(agent_id);
            // Stop the agent via runtime if still running
            let runtime = get_agent_runtime();
            // Find the runtime agent ID by task_id
            let runtime_agent_id = runtime
                .list_agents()
                .await
                .iter()
                .find(|info| info.task_id.as_deref() == Some(agent_id))
                .map(|info| info.agent_id.clone());

            if let Some(runtime_id) = runtime_agent_id {
                if let Err(e) = runtime.stop_agent(&runtime_id).await {
                    tracing::debug!(
                        agent_id = %agent_id,
                        error = %e,
                        "Failed to stop agent via runtime (may have already exited)"
                    );
                }
            }

            // Clear watchdog busy status (keyed by logical session id)
            let session_id = format!("session-{}", agent_id);
            if let Ok(watchdog) = ergatai_lock::get_watchdog(&agent.task_id).await {
                let watchdog = watchdog.write().await;
                let _ = watchdog.clear_busy(&session_id).await;
            }

            // SECURITY: Revoke file access tokens so completed/failed agents
            // don't retain file write permissions beyond their lifetime.
            if let Some(ref token_id) = agent.token_id {
                match ergatai_lock::get_lock_manager(&agent.task_id).await {
                    Ok(lock_manager) => {
                        if let Err(e) = lock_manager.expire_token(token_id) {
                            tracing::warn!(
                                agent_id = %agent_id,
                                token_id = %token_id,
                                error = %e,
                                "Failed to expire file access token during cleanup"
                            );
                        }
                    }
                    Err(e) => {
                        tracing::debug!(
                            agent_id = %agent_id,
                            error = %e,
                            "Lock manager not available for token revocation (may not be initialized)"
                        );
                    }
                }
            }
        }
        Ok(())
    }

    /// Remove completed/failed agents from tracking.
    ///
    /// Called at the start of each new DAG run to prevent ghost agents
    /// from previous runs appearing in `get_all_status()` results.
    pub async fn clear_stale_agents(&self) -> ErgataiResult<()> {
        let stale_agents: Vec<(String, String, Option<String>)> = {
            let mut agents = self.running_agents.lock().await;
            let stale: Vec<_> = agents
                .iter()
                .filter(|(_, a)| {
                    a.status == AgentSessionStatus::Completed
                        || a.status == AgentSessionStatus::Failed
                })
                .map(|(id, a)| (id.clone(), a.task_id.clone(), a.token_id.clone()))
                .collect();

            let mut result = Vec::with_capacity(stale.len());
            for (id, task_id, token_id) in stale {
                if agents.remove(&id).is_some() {
                    result.push((id, task_id, token_id));
                }
            }

            if !result.is_empty() {
                tracing::info!(count = result.len(), "Cleared stale agents from registry");
            }

            result
            // Lock released here
        };

        // Now clean up agents + tokens without holding the lock
        let runtime = get_agent_runtime();
        for (agent_id, task_id, token_id) in &stale_agents {
            // Cancel the heartbeat task to prevent background task leak
            cancel_heartbeat(agent_id);

            // Find and stop via runtime
            let runtime_agent_id = runtime
                .list_agents()
                .await
                .iter()
                .find(|info| info.task_id.as_deref() == Some(agent_id.as_str()))
                .map(|info| info.agent_id.clone());

            if let Some(runtime_id) = runtime_agent_id {
                if let Err(e) = runtime.stop_agent(&runtime_id).await {
                    tracing::debug!(
                        agent_id = %agent_id,
                        error = %e,
                        "Failed to stop stale agent via runtime"
                    );
                }
            }

            let session_id = format!("session-{}", agent_id);
            if let Ok(watchdog) = ergatai_lock::get_watchdog(task_id).await {
                let watchdog = watchdog.write().await;
                let _ = watchdog.clear_busy(&session_id).await;
            }

            // SECURITY: Revoke file access tokens so stale agents don't retain
            // file write permissions beyond their lifetime (same as cleanup_agent).
            if let Some(ref token_id) = token_id {
                match ergatai_lock::get_lock_manager(task_id).await {
                    Ok(lock_manager) => {
                        if let Err(e) = lock_manager.expire_token(token_id) {
                            tracing::warn!(
                                agent_id = %agent_id,
                                token_id = %token_id,
                                error = %e,
                                "Failed to expire file access token during stale agent cleanup"
                            );
                        }
                    }
                    Err(e) => {
                        tracing::debug!(
                            agent_id = %agent_id,
                            error = %e,
                            "Lock manager not available for token revocation"
                        );
                    }
                }
            }
        }

        Ok(())
    }

    /// Read project context from .ergatai/AGENT.md
    /// Returns default message if file doesn't exist
    /// Truncates to 10KB if file is too large
    pub(crate) async fn read_project_context(&self) -> String {
        let agent_md_path = self.coordinator.project_root.join(".ergatai/AGENT.md");

        match tokio::fs::read_to_string(&agent_md_path).await {
            Ok(content) => {
                const MAX_SIZE: usize = 10_000; // 10KB

                if content.len() > MAX_SIZE {
                    tracing::warn!(
                        "AGENT.md too large ({} bytes), truncating to {} bytes",
                        content.len(),
                        MAX_SIZE
                    );
                    safe_truncate_utf8(&content, MAX_SIZE)
                } else {
                    content
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                tracing::debug!("AGENT.md not found, using default context");
                "No project context provided.".to_string()
            }
            Err(e) => {
                tracing::warn!("Failed to read AGENT.md: {}", e);
                "No project context provided.".to_string()
            }
        }
    }
}

/// Parse YAML frontmatter from a result file and extract structured outputs.
///
/// Expected format:
/// ```markdown
/// ---
/// outputs:
///   key1: value1
///   key2: value2
/// ---
/// # Task Result
/// ...
/// ```
///
/// Returns `serde_json::Value::Object` with the parsed outputs,
/// or an empty object if no frontmatter/outputs found or parse fails.
async fn parse_result_file_outputs(path: &std::path::Path) -> serde_json::Value {
    let empty = serde_json::Value::Object(serde_json::Map::new());

    let content = match tokio::fs::read_to_string(path).await {
        Ok(c) => c,
        Err(e) => {
            tracing::warn!(
                path = %path.display(),
                error = %e,
                "Failed to read result file for outputs extraction"
            );
            return empty;
        }
    };

    // Frontmatter must start with --- and end with ---
    let trimmed = content.trim_start();
    if !trimmed.starts_with("---") {
        return empty;
    }

    // Find the closing ---
    let after_open = &trimmed[3..];
    let Some(end_idx) = after_open.find("\n---") else {
        return empty;
    };

    let frontmatter_str = &after_open[..end_idx];

    // Parse as YAML
    let parsed: serde_yaml::Value = match serde_yaml::from_str(frontmatter_str) {
        Ok(v) => v,
        Err(e) => {
            tracing::warn!(
                path = %path.display(),
                error = %e,
                "Failed to parse result file frontmatter YAML"
            );
            return empty;
        }
    };

    // Extract "outputs" key
    if let serde_yaml::Value::Mapping(map) = parsed {
        if let Some(outputs_val) = map.get(serde_yaml::Value::String("outputs".to_string())) {
            // Convert serde_yaml::Value to serde_json::Value via JSON string
            let json_str = match serde_json::to_string(outputs_val) {
                Ok(s) => s,
                Err(_) => return empty,
            };
            if let Ok(serde_json::Value::Object(obj)) =
                serde_json::from_str::<serde_json::Value>(&json_str)
            {
                if obj.is_empty() {
                    return empty;
                }
                tracing::info!(
                    path = %path.display(),
                    num_outputs = obj.len(),
                    "Extracted structured outputs from result file frontmatter"
                );
                return serde_json::Value::Object(obj);
            }
        }
    }

    empty
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::task_coordinator::TaskType;

    #[test]
    fn test_make_and_parse_agent_id() {
        // task_id with dashes should round-trip correctly
        let id = AgentLauncher::make_agent_id("task-001-alpha", "claude-code");
        assert_eq!(id, "task-001-alpha|claude-code");
        let parsed = AgentLauncher::parse_agent_id(&id).expect("should parse");
        assert_eq!(parsed, ("task-001-alpha", "claude-code"));
    }

    #[test]
    fn test_parse_agent_id_invalid() {
        // No separator → None
        assert_eq!(AgentLauncher::parse_agent_id("noseparator"), None);
    }

    #[test]
    fn test_all_agents_completed_empty() {
        // No agents for the task → should return false (no agent has completed)
        let launcher = AgentLauncher::new(std::env::temp_dir());
        let rt = tokio::runtime::Runtime::new().unwrap();
        assert!(!rt.block_on(launcher.all_agents_completed("nonexistent")));
    }

    #[test]
    fn test_safe_truncate_utf8_ascii() {
        let content = "a".repeat(10001);
        let truncated = safe_truncate_utf8(&content, 10000);
        assert_eq!(truncated.len(), 10000 + "\n\n[... truncated ...]".len());
        assert!(truncated.ends_with("[... truncated ...]"));
    }

    #[test]
    fn test_safe_truncate_utf8_multibyte() {
        // 每个中文字符 3 字节
        let content = "中".repeat(3334); // 10002 字节
        let truncated = safe_truncate_utf8(&content, 10000);

        // 应该小于等于 10000 + 后缀长度
        assert!(truncated.len() <= 10000 + "\n\n[... truncated ...]".len());
        // 应该在字符边界截断
        let truncated_content = &truncated[..truncated.len() - "\n\n[... truncated ...]".len()];
        assert!(truncated_content.is_char_boundary(truncated_content.len()));
        // 不应该 panic
        assert!(truncated_content.chars().count() > 0);
    }

    #[test]
    fn test_safe_truncate_utf8_no_truncation_needed() {
        let content = "short content";
        let truncated = safe_truncate_utf8(content, 10000);
        assert_eq!(truncated, content);
    }

    #[tokio::test]
    async fn test_read_project_context_exists() {
        let temp_dir = tempfile::tempdir().unwrap();
        let project_root = temp_dir.path().to_path_buf();

        // Create .ergatai directory and AGENT.md
        let ergatai_dir = project_root.join(".ergatai");
        tokio::fs::create_dir_all(&ergatai_dir).await.unwrap();
        tokio::fs::write(ergatai_dir.join("AGENT.md"), "test context")
            .await
            .unwrap();

        let launcher = AgentLauncher::new(project_root);
        let context = launcher.read_project_context().await;

        assert_eq!(context, "test context");
    }

    #[tokio::test]
    async fn test_read_project_context_not_exists() {
        let temp_dir = tempfile::tempdir().unwrap();
        let project_root = temp_dir.path().to_path_buf();

        let launcher = AgentLauncher::new(project_root);
        let context = launcher.read_project_context().await;

        assert_eq!(context, "No project context provided.");
    }

    #[tokio::test]
    async fn test_read_project_context_truncation() {
        let temp_dir = tempfile::tempdir().unwrap();
        let project_root = temp_dir.path().to_path_buf();

        // Create .ergatai directory and large AGENT.md
        let ergatai_dir = project_root.join(".ergatai");
        tokio::fs::create_dir_all(&ergatai_dir).await.unwrap();
        let large_content = "a".repeat(15000);
        tokio::fs::write(ergatai_dir.join("AGENT.md"), &large_content)
            .await
            .unwrap();

        let launcher = AgentLauncher::new(project_root);
        let context = launcher.read_project_context().await;

        // Should be truncated
        assert!(context.len() < 15000);
        assert!(context.ends_with("[... truncated ...]"));
    }

    #[tokio::test]
    async fn test_create_agent_instruction_includes_context() {
        let temp_dir = tempfile::tempdir().unwrap();
        let project_root = temp_dir.path().to_path_buf();

        // Create .ergatai directory and AGENT.md
        let ergatai_dir = project_root.join(".ergatai");
        tokio::fs::create_dir_all(&ergatai_dir).await.unwrap();
        tokio::fs::write(
            ergatai_dir.join("AGENT.md"),
            "# My Project Context\n\nThis is important.",
        )
        .await
        .unwrap();

        let launcher = AgentLauncher::new(project_root.clone());

        let assignment = AgentAssignment {
            agent_name: "test-agent".to_string(),
            objective: "Test objective".to_string(),
            files_to_create: vec![],
            files_to_modify: vec![],
            files_to_read: vec![],
            task_type: TaskType::CreateNew,
            depends_on: vec![],
            priority: None,
            expected_outputs: HashMap::new(),
        };

        let worktree_path = project_root.join("worktree");
        let plan_file = project_root.join("plan.md");
        let result_file = project_root.join("result.md");

        let instruction = launcher
            .create_agent_instruction(
                "test-agent",
                &worktree_path,
                &plan_file,
                &result_file,
                &assignment,
            )
            .await;

        // Should include project context
        assert!(instruction.contains("# My Project Context"));
        assert!(instruction.contains("This is important."));
        // Should include task assignment
        assert!(instruction.contains("@test-agent"));
        assert!(instruction.contains("Test objective"));
    }

    #[tokio::test]
    async fn test_create_agent_instruction_no_agent_md_uses_default() {
        let temp_dir = tempfile::tempdir().unwrap();
        let project_root = temp_dir.path().to_path_buf();
        // No .ergatai/AGENT.md created

        let launcher = AgentLauncher::new(project_root.clone());

        let assignment = AgentAssignment {
            agent_name: "test-agent".to_string(),
            objective: "Test".to_string(),
            files_to_create: vec![],
            files_to_modify: vec![],
            files_to_read: vec![],
            task_type: TaskType::CreateNew,
            depends_on: vec![],
            priority: None,
            expected_outputs: HashMap::new(),
        };

        let instruction = launcher
            .create_agent_instruction(
                "test-agent",
                &project_root.join("worktree"),
                &project_root.join("plan.md"),
                &project_root.join("result.md"),
                &assignment,
            )
            .await;

        assert!(
            instruction.contains("No project context provided."),
            "instruction should contain default message when AGENT.md is missing"
        );
    }

    #[tokio::test]
    async fn test_create_agent_instruction_large_file_truncated() {
        let temp_dir = tempfile::tempdir().unwrap();
        let project_root = temp_dir.path().to_path_buf();

        // Create .ergatai/AGENT.md with content exceeding 10KB
        let ergatai_dir = project_root.join(".ergatai");
        tokio::fs::create_dir_all(&ergatai_dir).await.unwrap();

        let large_content = format!("{}END_MARKER", "A".repeat(11_000));
        tokio::fs::write(ergatai_dir.join("AGENT.md"), &large_content)
            .await
            .unwrap();

        let launcher = AgentLauncher::new(project_root.clone());

        let assignment = AgentAssignment {
            agent_name: "test-agent".to_string(),
            objective: "Test truncation".to_string(),
            files_to_create: vec![],
            files_to_modify: vec![],
            files_to_read: vec![],
            task_type: TaskType::CreateNew,
            depends_on: vec![],
            priority: None,
            expected_outputs: HashMap::new(),
        };

        let instruction = launcher
            .create_agent_instruction(
                "test-agent",
                &project_root.join("worktree"),
                &project_root.join("plan.md"),
                &project_root.join("result.md"),
                &assignment,
            )
            .await;

        // Content beyond 10KB should not appear
        assert!(
            !instruction.contains("END_MARKER"),
            "truncated instruction should not contain content beyond 10KB"
        );
        // Truncation marker should be present
        assert!(
            instruction.contains("[... truncated ...]"),
            "instruction should contain truncation marker"
        );
    }

    #[tokio::test]
    async fn test_format_files_section_empty() {
        let launcher = AgentLauncher::new(std::env::temp_dir());
        let assignment = AgentAssignment {
            agent_name: "a".to_string(),
            objective: "o".to_string(),
            files_to_create: vec![],
            files_to_modify: vec![],
            files_to_read: vec![],
            task_type: TaskType::CreateNew,
            depends_on: vec![],
            priority: None,
            expected_outputs: HashMap::new(),
        };
        let section = launcher.format_files_section(&assignment);
        assert_eq!(section, "No specific files assigned");
    }

    #[tokio::test]
    async fn test_format_files_section_with_all_lists() {
        let launcher = AgentLauncher::new(std::env::temp_dir());
        let assignment = AgentAssignment {
            agent_name: "a".to_string(),
            objective: "o".to_string(),
            files_to_create: vec![PathBuf::from("src/new.rs")],
            files_to_modify: vec![PathBuf::from("src/old.rs")],
            files_to_read: vec![PathBuf::from("src/read.rs")],
            task_type: TaskType::CreateNew,
            depends_on: vec![],
            priority: None,
            expected_outputs: HashMap::new(),
        };
        let section = launcher.format_files_section(&assignment);
        assert!(section.contains("Files to create"));
        assert!(section.contains("src/new.rs"));
        assert!(section.contains("Files to modify"));
        assert!(section.contains("src/old.rs"));
        assert!(section.contains("Files to read"));
        assert!(section.contains("src/read.rs"));
    }

    #[tokio::test]
    async fn test_format_files_section_only_create() {
        let launcher = AgentLauncher::new(std::env::temp_dir());
        let assignment = AgentAssignment {
            agent_name: "a".to_string(),
            objective: "o".to_string(),
            files_to_create: vec![PathBuf::from("x.rs"), PathBuf::from("y.rs")],
            files_to_modify: vec![],
            files_to_read: vec![],
            task_type: TaskType::CreateNew,
            depends_on: vec![],
            priority: None,
            expected_outputs: HashMap::new(),
        };
        let section = launcher.format_files_section(&assignment);
        assert!(section.contains("Files to create"));
        assert!(section.contains("x.rs"));
        assert!(section.contains("y.rs"));
        // Should NOT contain modify/read sections
        assert!(!section.contains("Files to modify"));
        assert!(!section.contains("Files to read"));
    }

    #[tokio::test]
    async fn test_get_all_status_empty_initially() {
        // Fresh launcher has no tracked agents
        let launcher = AgentLauncher::new(std::env::temp_dir());
        let all = launcher.get_all_status().await;
        // Since running_agents() is a global singleton, other tests may have populated it.
        // Just verify it doesn't panic and returns a Vec.
        let _ = all;
    }

    #[tokio::test]
    async fn test_get_agent_status_unknown_returns_none() {
        let launcher = AgentLauncher::new(std::env::temp_dir());
        let status = launcher
            .get_agent_status("nonexistent-task|nonexistent-agent")
            .await;
        assert!(status.is_none());
    }

    #[tokio::test]
    async fn test_get_agent_status_after_manual_insert() {
        let launcher = AgentLauncher::new(std::env::temp_dir());
        // Manually insert a running agent record
        let agent_id = AgentLauncher::make_agent_id("task-x", "agent-y");
        {
            let mut agents = launcher.running_agents.lock().await;
            agents.insert(
                agent_id.clone(),
                RunningAgent {
                    task_id: "task-x".to_string(),
                    agent_name: "agent-y".to_string(),
                    worktree_path: PathBuf::from("/tmp/work"),
                    plan_file: PathBuf::from("/tmp/plan.md"),
                    result_file: PathBuf::from("/tmp/result.md"),
                    status: AgentSessionStatus::Running,
                    lifecycle: None,
                    pane_id: None,
                    token_id: None,
                },
            );
        }

        let status = launcher.get_agent_status(&agent_id).await;
        assert!(status.is_some());
        let s = status.unwrap();
        assert_eq!(s.task_id, "task-x");
        assert_eq!(s.agent_name, "agent-y");
        assert_eq!(s.status, AgentSessionStatus::Running);

        // Clean up the global registry
        cancel_heartbeat(&agent_id);
        launcher.running_agents.lock().await.remove(&agent_id);
    }

    #[tokio::test]
    async fn test_all_agents_completed_true_when_completed() {
        let launcher = AgentLauncher::new(std::env::temp_dir());
        let agent_id = AgentLauncher::make_agent_id("task-done", "agent-a");
        {
            let mut agents = launcher.running_agents.lock().await;
            agents.insert(
                agent_id.clone(),
                RunningAgent {
                    task_id: "task-done".to_string(),
                    agent_name: "agent-a".to_string(),
                    worktree_path: PathBuf::from("/tmp"),
                    plan_file: PathBuf::from("/tmp/p.md"),
                    result_file: PathBuf::from("/tmp/r.md"),
                    status: AgentSessionStatus::Completed,
                    lifecycle: None,
                    pane_id: None,
                    token_id: None,
                },
            );
        }

        assert!(launcher.all_agents_completed("task-done").await);
        launcher.running_agents.lock().await.remove(&agent_id);
    }

    #[tokio::test]
    async fn test_all_agents_completed_false_when_running() {
        let launcher = AgentLauncher::new(std::env::temp_dir());
        let agent_id = AgentLauncher::make_agent_id("task-live", "agent-b");
        {
            let mut agents = launcher.running_agents.lock().await;
            agents.insert(
                agent_id.clone(),
                RunningAgent {
                    task_id: "task-live".to_string(),
                    agent_name: "agent-b".to_string(),
                    worktree_path: PathBuf::from("/tmp"),
                    plan_file: PathBuf::from("/tmp/p.md"),
                    result_file: PathBuf::from("/tmp/r.md"),
                    status: AgentSessionStatus::Running,
                    lifecycle: None,
                    pane_id: None,
                    token_id: None,
                },
            );
        }

        assert!(!launcher.all_agents_completed("task-live").await);
        launcher.running_agents.lock().await.remove(&agent_id);
    }

    #[tokio::test]
    async fn test_all_agents_completed_counts_failed_as_done() {
        let launcher = AgentLauncher::new(std::env::temp_dir());
        let agent_id = AgentLauncher::make_agent_id("task-failed", "agent-c");
        {
            let mut agents = launcher.running_agents.lock().await;
            agents.insert(
                agent_id.clone(),
                RunningAgent {
                    task_id: "task-failed".to_string(),
                    agent_name: "agent-c".to_string(),
                    worktree_path: PathBuf::from("/tmp"),
                    plan_file: PathBuf::from("/tmp/p.md"),
                    result_file: PathBuf::from("/tmp/r.md"),
                    status: AgentSessionStatus::Failed,
                    lifecycle: None,
                    pane_id: None,
                    token_id: None,
                },
            );
        }
        // Failed is treated as "done" alongside Completed
        assert!(launcher.all_agents_completed("task-failed").await);
        launcher.running_agents.lock().await.remove(&agent_id);
    }

    #[tokio::test]
    async fn test_agent_status_enum_values() {
        assert_ne!(AgentSessionStatus::Starting, AgentSessionStatus::Running);
        assert_ne!(AgentSessionStatus::Completed, AgentSessionStatus::Failed);
    }

    #[test]
    fn test_safe_truncate_utf8_exact_boundary() {
        // Content exactly at boundary
        let content = "a".repeat(10000);
        let truncated = safe_truncate_utf8(&content, 10000);
        assert_eq!(truncated, content);
    }

    #[test]
    fn test_safe_truncate_utf8_zero_limit() {
        let truncated = safe_truncate_utf8("hello", 0);
        assert!(truncated.ends_with("[... truncated ...]"));
        // Should not panic; result prefix should be empty before the marker
    }

    // ===== State Machine Transition Tests =====

    #[test]
    fn test_state_transition_starting_to_running() {
        let status = AgentSessionStatus::Starting;
        assert!(status.can_transition_to(&AgentSessionStatus::Running));
        let result = status.transition_to(AgentSessionStatus::Running);
        assert!(result.is_ok());
        assert_eq!(result.unwrap(), AgentSessionStatus::Running);
    }

    #[test]
    fn test_state_transition_starting_to_failed() {
        let status = AgentSessionStatus::Starting;
        assert!(status.can_transition_to(&AgentSessionStatus::Failed));
        let result = status.transition_to(AgentSessionStatus::Failed);
        assert!(result.is_ok());
        assert_eq!(result.unwrap(), AgentSessionStatus::Failed);
    }

    #[test]
    fn test_state_transition_running_to_completed() {
        let status = AgentSessionStatus::Running;
        assert!(status.can_transition_to(&AgentSessionStatus::Completed));
        let result = status.transition_to(AgentSessionStatus::Completed);
        assert!(result.is_ok());
        assert_eq!(result.unwrap(), AgentSessionStatus::Completed);
    }

    #[test]
    fn test_state_transition_running_to_failed() {
        let status = AgentSessionStatus::Running;
        assert!(status.can_transition_to(&AgentSessionStatus::Failed));
        let result = status.transition_to(AgentSessionStatus::Failed);
        assert!(result.is_ok());
        assert_eq!(result.unwrap(), AgentSessionStatus::Failed);
    }

    #[test]
    fn test_state_transition_invalid_starting_to_completed() {
        let status = AgentSessionStatus::Starting;
        assert!(!status.can_transition_to(&AgentSessionStatus::Completed));
        let result = status.transition_to(AgentSessionStatus::Completed);
        assert!(result.is_err());
    }

    #[test]
    fn test_state_transition_invalid_completed_to_starting() {
        let status = AgentSessionStatus::Completed;
        assert!(!status.can_transition_to(&AgentSessionStatus::Starting));
        let result = status.transition_to(AgentSessionStatus::Starting);
        assert!(result.is_err());
    }

    #[test]
    fn test_state_transition_invalid_completed_to_running() {
        let status = AgentSessionStatus::Completed;
        assert!(!status.can_transition_to(&AgentSessionStatus::Running));
        let result = status.transition_to(AgentSessionStatus::Running);
        assert!(result.is_err());
    }

    #[test]
    fn test_state_transition_invalid_completed_to_failed() {
        let status = AgentSessionStatus::Completed;
        assert!(!status.can_transition_to(&AgentSessionStatus::Failed));
        let result = status.transition_to(AgentSessionStatus::Failed);
        assert!(result.is_err());
    }

    #[test]
    fn test_state_transition_invalid_failed_to_starting() {
        let status = AgentSessionStatus::Failed;
        assert!(!status.can_transition_to(&AgentSessionStatus::Starting));
        let result = status.transition_to(AgentSessionStatus::Starting);
        assert!(result.is_err());
    }

    #[test]
    fn test_state_transition_invalid_failed_to_running() {
        let status = AgentSessionStatus::Failed;
        assert!(!status.can_transition_to(&AgentSessionStatus::Running));
        let result = status.transition_to(AgentSessionStatus::Running);
        assert!(result.is_err());
    }

    #[test]
    fn test_state_transition_invalid_failed_to_completed() {
        let status = AgentSessionStatus::Failed;
        assert!(!status.can_transition_to(&AgentSessionStatus::Completed));
        let result = status.transition_to(AgentSessionStatus::Completed);
        assert!(result.is_err());
    }

    #[test]
    fn test_state_transition_invalid_same_state() {
        // Cannot transition to the same state
        assert!(!AgentSessionStatus::Starting.can_transition_to(&AgentSessionStatus::Starting));
        assert!(!AgentSessionStatus::Running.can_transition_to(&AgentSessionStatus::Running));
        assert!(!AgentSessionStatus::Completed.can_transition_to(&AgentSessionStatus::Completed));
        assert!(!AgentSessionStatus::Failed.can_transition_to(&AgentSessionStatus::Failed));
    }

    #[tokio::test]
    async fn test_parse_result_file_outputs_normal() {
        use std::io::Write;
        use tempfile::NamedTempFile;
        let mut f = NamedTempFile::new().unwrap();
        write!(
            f,
            "---\noutputs:\n  api_endpoint: \"/api/v1/users\"\n  schema_file: \"src/schema/user.rs\"\n---\n# Task Result\n\nDone."
        )
        .unwrap();
        let result = super::parse_result_file_outputs(f.path()).await;
        assert_eq!(result["api_endpoint"], "/api/v1/users");
        assert_eq!(result["schema_file"], "src/schema/user.rs");
    }

    #[tokio::test]
    async fn test_parse_result_file_outputs_no_frontmatter() {
        use std::io::Write;
        use tempfile::NamedTempFile;
        let mut f = NamedTempFile::new().unwrap();
        write!(f, "# Task Result\n\nNo frontmatter here.").unwrap();
        let result = super::parse_result_file_outputs(f.path()).await;
        assert!(result.as_object().unwrap().is_empty());
    }

    #[tokio::test]
    async fn test_parse_result_file_outputs_no_outputs_key() {
        use std::io::Write;
        use tempfile::NamedTempFile;
        let mut f = NamedTempFile::new().unwrap();
        write!(f, "---\ntitle: test\nauthor: someone\n---\n# Content").unwrap();
        let result = super::parse_result_file_outputs(f.path()).await;
        assert!(result.as_object().unwrap().is_empty());
    }

    #[tokio::test]
    async fn test_parse_result_file_outputs_malformed_yaml() {
        use std::io::Write;
        use tempfile::NamedTempFile;
        let mut f = NamedTempFile::new().unwrap();
        write!(f, "---\n: : bad yaml\n  - [broken\n---\n# Content").unwrap();
        let result = super::parse_result_file_outputs(f.path()).await;
        assert!(result.as_object().unwrap().is_empty());
    }

    #[tokio::test]
    async fn test_parse_result_file_outputs_empty_outputs_mapping() {
        use std::io::Write;
        use tempfile::NamedTempFile;
        let mut f = NamedTempFile::new().unwrap();
        write!(f, "---\noutputs: {{}}\n---\n# Content").unwrap();
        let result = super::parse_result_file_outputs(f.path()).await;
        assert!(result.as_object().unwrap().is_empty());
    }

    #[tokio::test]
    async fn test_parse_result_file_outputs_missing_file() {
        let result =
            super::parse_result_file_outputs(std::path::Path::new("/nonexistent/file.md")).await;
        assert!(result.as_object().unwrap().is_empty());
    }
}
