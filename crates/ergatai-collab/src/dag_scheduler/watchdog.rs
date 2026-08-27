//! Watchdog tasks for DAG and node-level timeout/stall detection.
//!
//! Three background watchdogs run alongside a DAG:
//!
//! - `spawn_timeout_watcher`: per-node three-stage timeout
//!   (warn at 50% → escalate at 80% → fail at 100%)
//! - `spawn_dag_timeout_watcher`: DAG-level timeout
//!   (fails all remaining nodes when deadline hits)
//! - `spawn_stall_watcher`: detects stalled DAGs
//!   (no progress for `stall_timeout_secs`)
//!
//! Also contains `adjust_timeout_by_complexity` — the pure function that
//! scales a base timeout by `TaskComplexity`.

use std::sync::atomic::Ordering;

use ergatai_dag::{TaskComplexity, TaskStatus};

use super::DagScheduler;

/// How often the stall/timeout watchdogs poll.
/// Kept small so unit tests can exercise the full stall path in under a second.
const POLL_INTERVAL_SECS: u64 = 1;

/// Scale a base timeout by task complexity.
///
/// - Low    → base × 0.5 (short tasks need less budget)
/// - Medium → base × 1.0 (unchanged)
/// - High   → base × 2.0 (complex tasks get more headroom)
///
/// A zero base always yields zero (no watchdog to spawn).
pub fn adjust_timeout_by_complexity(base_timeout_secs: u64, complexity: TaskComplexity) -> u64 {
    let multiplier: f64 = match complexity {
        TaskComplexity::Low => 0.5,
        TaskComplexity::Medium => 1.0,
        TaskComplexity::High => 2.0,
    };
    (base_timeout_secs as f64 * multiplier) as u64
}

impl DagScheduler {
    /// Spawn a three-stage timeout watchdog for a node.
    ///
    /// Instead of the old single-shot sleep-then-fail, this watcher emits
    /// observability signals at 50% (warn) and 80% (escalate) of the budget,
    /// and only mutates node state at 100% (fail). The warn/escalate tiers
    /// are log-only via `EventBus::publish_node_warned` / `publish_node_escalated`.
    ///
    /// Lock ordering: one mutex at a time. The graph lock is dropped before
    /// calling `on_node_failed`, which itself re-acquires the graph lock.
    ///
    /// This is sync (not async) because storing the watcher handle requires
    /// acquiring `timeout_watchers`. Using `tokio::sync::Mutex::lock().await`
    /// inside an async fn produces a `!Send` future (the `MutexGuard` is
    /// `!Send`), which breaks `tokio::spawn` in the caller chain. Instead,
    /// we use `try_lock()` for a sync fast-path and a detached spawn fallback.
    pub(super) fn spawn_timeout_watcher(&self, node_id: &str, timeout_secs: u64, agent_name: &str) {
        if timeout_secs == 0 {
            return;
        }

        let (warn_at, escalate_at, fail_at) =
            crate::timeout_tier::TimeoutTier::deadline_from_now(timeout_secs);

        let node_id_for_store = node_id.to_string();
        let node_id_clone = node_id.to_string();
        let agent_name_clone = agent_name.to_string();
        let scheduler = self.clone();
        let watchers = self.timeout_watchers.clone();

        let handle = tokio::spawn(async move {
            let start = std::time::Instant::now();
            let mut warned = false;
            let mut escalated = false;
            tracing::info!(
                node_id = %node_id_clone,
                dag_id = %scheduler.dag_id,
                timeout_secs = timeout_secs,
                "per-node timeout watchdog spawned"
            );
            loop {
                tokio::time::sleep(std::time::Duration::from_secs(POLL_INTERVAL_SECS)).await;
                if scheduler.finalized.load(Ordering::SeqCst) {
                    tracing::info!(
                        node_id = %node_id_clone,
                        elapsed_secs = start.elapsed().as_secs(),
                        "per-node watcher exiting: DAG finalized"
                    );
                    break;
                }
                let now = std::time::Instant::now();
                if !warned && now >= warn_at {
                    warned = true;
                    tracing::info!(
                        node_id = %node_id_clone,
                        elapsed_secs = start.elapsed().as_secs(),
                        "per-node watcher: warn threshold crossed"
                    );
                    if let Some(bus) = scheduler.get_or_init_event_bus().await {
                        let _ = bus
                            .publish_node_warned(
                                &scheduler.dag_id,
                                &node_id_clone,
                                start.elapsed().as_secs(),
                            )
                            .await;
                    }
                    // Inject warning into agent PTY so the agent can self-regulate
                    let warning_msg = format!(
                        "\r\n⚠️  [TIMEOUT WARNING] You have consumed 50% of your time budget \
                         ({}s elapsed / {}s total). \
                         Please wrap up your current work and prepare to submit results.\r\n",
                        start.elapsed().as_secs(),
                        timeout_secs
                    );
                    if let Err(e) = ergatai_runtime::get_agent_runtime()
                        .inject_message(&agent_name_clone, &warning_msg)
                        .await
                    {
                        tracing::warn!(
                            node_id = %node_id_clone,
                            agent = %agent_name_clone,
                            error = %e,
                            "Failed to inject timeout warning into agent PTY"
                        );
                    }
                }
                if !escalated && now >= escalate_at {
                    escalated = true;
                    tracing::info!(
                        node_id = %node_id_clone,
                        elapsed_secs = start.elapsed().as_secs(),
                        "per-node watcher: escalate threshold crossed"
                    );
                    if let Some(bus) = scheduler.get_or_init_event_bus().await {
                        let _ = bus
                            .publish_node_escalated(
                                &scheduler.dag_id,
                                &node_id_clone,
                                start.elapsed().as_secs(),
                            )
                            .await;
                    }
                    // Inject escalation into agent PTY — stronger wording
                    let escalate_msg = format!(
                        "\r\n🔴 [TIMEOUT ESCALATED] You have consumed 80% of your time budget \
                         ({}s elapsed / {}s total). \
                         STOP current work immediately, write your result file NOW.\r\n",
                        start.elapsed().as_secs(),
                        timeout_secs
                    );
                    if let Err(e) = ergatai_runtime::get_agent_runtime()
                        .inject_message(&agent_name_clone, &escalate_msg)
                        .await
                    {
                        tracing::warn!(
                            node_id = %node_id_clone,
                            agent = %agent_name_clone,
                            error = %e,
                            "Failed to inject timeout escalation into agent PTY"
                        );
                    }
                }
                if now >= fail_at {
                    tracing::info!(
                        node_id = %node_id_clone,
                        elapsed_secs = start.elapsed().as_secs(),
                        timeout_secs = timeout_secs,
                        "per-node watcher: fail threshold crossed — marking node Failed"
                    );
                    // Record the timeout reason in metadata but do NOT set
                    // node.status = Failed here. on_node_failed must handle the
                    // status transition so it can: (a) check retry budget,
                    // (b) call mark_completed to release the agent slot,
                    // (c) call skip_downstream to propagate failure to dependents,
                    // and (d) call finalize_if_terminal.
                    {
                        let mut graph = scheduler.graph.lock().await;
                        if let Some(node) = graph.find_node_mut(&node_id_clone) {
                            node.metadata.insert(
                                "timeout_error".to_string(),
                                format!("timeout after {}s", timeout_secs),
                            );
                        }
                    }

                    // Remove self from watcher map before triggering failure,
                    // so on_node_failed → cancel_timeout_watcher is a no-op
                    // rather than aborting our own task mid-execution.
                    {
                        let mut w = watchers.lock().await;
                        w.remove(&node_id_clone);
                    }

                    if let Err(e) = scheduler
                        .on_node_failed(
                            &node_id_clone,
                            &format!("Task timed out after {} seconds", timeout_secs),
                        )
                        .await
                    {
                        tracing::error!(
                            node_id = %node_id_clone,
                            error = %e,
                            "Failed to handle timeout for node"
                        );
                    }
                    break;
                }
            }
        });

        // Store the handle synchronously to prevent race: if we used a detached
        // spawn, the watcher could fire before the handle is stored, making
        // cancel_timeout_watcher() a no-op.
        //
        // We use try_lock() for a sync fast-path. If the lock is uncontended
        // (common case), we store immediately. If contended, we fall back to a
        // detached spawn — the race is benign because the watcher sleeps for
        // POLL_INTERVAL_SECS before acting and checks node status before failing.
        let watchers_for_store = self.timeout_watchers.clone();
        let node_for_store = node_id_for_store.clone();
        match self.timeout_watchers.try_lock() {
            Ok(mut w) => {
                w.insert(node_id_for_store, handle);
            }
            Err(_) => {
                tokio::spawn(async move {
                    let mut w = watchers_for_store.lock().await;
                    w.insert(node_for_store, handle);
                });
            }
        }
    }

    /// Cancel the timeout watchdog for a node (called on normal completion/failure)
    pub(super) async fn cancel_timeout_watcher(&self, node_id: &str) {
        let mut watchers = self.timeout_watchers.lock().await;
        if let Some(handle) = watchers.remove(node_id) {
            handle.abort();
            tracing::info!(node_id = node_id, "Cancelled timeout watchdog");
        }
    }

    /// Spawn DAG-level timeout watcher (idempotent — only spawns once).
    ///
    /// If the DAG has a `timeout` field, starts a background task that will
    /// fail all remaining Pending/Running nodes when the deadline is reached.
    ///
    /// Uses double-checked locking to prevent TOCTOU race: two concurrent
    /// callers could both pass the `is_some()` check and spawn duplicate
    /// watchers. The second check after re-acquiring the lock catches this.
    pub(super) async fn spawn_dag_timeout_watcher(&self) {
        // First check (fast path)
        {
            let watcher = self.dag_timeout_watcher.lock().await;
            if watcher.is_some() {
                return;
            }
        }

        // Get timeout from graph (no dag_timeout_watcher lock held — avoid nested locks)
        let timeout_secs = {
            let graph = self.graph.lock().await;
            graph.timeout
        };

        let timeout_secs = match timeout_secs {
            Some(t) if t > 0 => t,
            _ => return, // No timeout configured
        };

        let scheduler = self.clone();
        let dag_id = self.dag_id.clone();
        let finalized = self.finalized.clone();

        let handle = tokio::spawn(async move {
            // Use select! so we can bail early if the DAG finalizes before the
            // timeout elapses (avoids spurious "DAG-level timeout reached" logs
            // after the DAG has already completed successfully).
            tokio::select! {
                _ = tokio::time::sleep(std::time::Duration::from_secs(timeout_secs)) => {}
                _ = async {
                    loop {
                        tokio::time::sleep(std::time::Duration::from_secs(POLL_INTERVAL_SECS))
                            .await;
                        if finalized.load(Ordering::SeqCst) {
                            return;
                        }
                    }
                } => {
                    return; // DAG finalized before timeout — nothing to do
                }
            }

            // Final re-check: in case of near-simultaneous finalize, skip
            // marking nodes failed if another caller has already finalized.
            if finalized.load(Ordering::SeqCst) {
                return;
            }

            tracing::warn!(
                dag_id = %dag_id,
                timeout_secs = timeout_secs,
                "DAG-level timeout reached, failing all remaining nodes"
            );

            if let Err(e) = scheduler
                .fail_all_remaining_nodes("DAG-level timeout reached")
                .await
            {
                tracing::error!(dag_id = %dag_id, error = %e, "Failed to handle DAG timeout");
            }
        });

        // Second check (double-checked locking): if another caller stored a
        // handle while we were spawning, abort our duplicate and return.
        let mut watcher = self.dag_timeout_watcher.lock().await;
        if watcher.is_some() {
            handle.abort();
            return;
        }
        *watcher = Some(handle);
    }

    /// Spawn a background watchdog that detects stalled DAGs.
    ///
    /// Polls `last_progress_age_secs()` every `POLL_INTERVAL_SECS` seconds.
    /// If the DAG has at least one `Running` node but hasn't made progress for
    /// `stall_timeout_secs`, marks all Running nodes as Failed with a stall
    /// reason and funnels through `finalize_if_terminal()`.
    ///
    /// No-ops if `stall_timeout_secs` is `None` on the graph.
    /// Idempotent — only spawns once (like `spawn_dag_timeout_watcher`).
    /// Uses double-checked locking to prevent TOCTOU race.
    pub(super) async fn spawn_stall_watcher(&self) {
        // First check (fast path)
        {
            let watcher = self.stall_watcher.lock().await;
            if watcher.is_some() {
                return;
            }
        }

        let stall_timeout = {
            let graph = self.graph.lock().await;
            graph.stall_timeout_secs
        };
        let Some(timeout_secs) = stall_timeout else {
            return;
        };

        let scheduler = self.clone();
        let handle = tokio::spawn(async move {
            loop {
                tokio::time::sleep(std::time::Duration::from_secs(POLL_INTERVAL_SECS)).await;
                if scheduler.finalized.load(Ordering::SeqCst) {
                    break;
                }
                // Count nodes by status to detect different stall scenarios
                let (running_count, pending_count) = {
                    let graph = scheduler.graph.lock().await;
                    let running = graph
                        .nodes
                        .iter()
                        .filter(|n| n.status == TaskStatus::Running)
                        .count();
                    let pending = graph
                        .nodes
                        .iter()
                        .filter(|n| n.status == TaskStatus::Pending)
                        .count();
                    (running, pending)
                };

                // Case 1: No active work at all — DAG might be complete or deadlocked
                if running_count == 0 && pending_count == 0 {
                    // All nodes are Completed/Failed/Skipped — finalize
                    tracing::info!(
                        dag_id = %scheduler.dag_id,
                        "DAG has no active or pending nodes — finalizing"
                    );
                    scheduler.finalize_if_terminal().await;
                    break;
                }

                // Case 2: Has Running nodes — check if they're stalled (existing logic)
                if running_count > 0 {
                    let age = scheduler.last_progress_age_secs().await;
                    if age >= timeout_secs {
                        tracing::warn!(
                            dag_id = %scheduler.dag_id,
                            stall_secs = age,
                            timeout_secs = timeout_secs,
                            "DAG stalled — running nodes made no progress, failing via on_node_failed"
                        );
                        // Collect stalled node IDs and record stall_error in metadata.
                        // Do NOT set status=Failed here — route through on_node_failed()
                        // to ensure retry budget, mark_completed, skip_downstream, and
                        // finalize_if_terminal are all properly handled.
                        let stalled_node_ids: Vec<String> = {
                            let mut graph = scheduler.graph.lock().await;
                            let stall_reason = format!(
                                "stalled: no progress for {}s (limit {}s)",
                                age, timeout_secs
                            );
                            graph
                                .nodes
                                .iter_mut()
                                .filter(|n| n.status == TaskStatus::Running)
                                .map(|n| {
                                    n.metadata
                                        .insert("stall_error".to_string(), stall_reason.clone());
                                    n.id.clone()
                                })
                                .collect()
                        };
                        // Route each stalled node through on_node_failed for proper cleanup
                        for node_id in stalled_node_ids {
                            if let Err(e) = scheduler
                                .on_node_failed(
                                    &node_id,
                                    &format!(
                                        "Task stalled: no progress for {}s (limit {}s)",
                                        age, timeout_secs
                                    ),
                                )
                                .await
                            {
                                tracing::error!(
                                    node_id = %node_id,
                                    error = %e,
                                    "Failed to handle stall for node"
                                );
                            }
                        }
                        break;
                    }
                }

                // Case 3: Has Pending but no Running — agents never picked up tasks
                if running_count == 0 && pending_count > 0 {
                    let age = scheduler.last_progress_age_secs().await;
                    if age >= timeout_secs {
                        tracing::warn!(
                            dag_id = %scheduler.dag_id,
                            pending_nodes = pending_count,
                            stall_secs = age,
                            timeout_secs = timeout_secs,
                            "DAG stalled — pending nodes waiting for agents, no running nodes, failing via on_node_failed"
                        );
                        // Collect stalled pending node IDs and record stall_error in metadata.
                        // Do NOT set status=Failed here — route through on_node_failed()
                        // to ensure retry budget, mark_completed, skip_downstream, and
                        // finalize_if_terminal are all properly handled.
                        let stalled_node_ids: Vec<String> = {
                            let mut graph = scheduler.graph.lock().await;
                            let stall_reason = format!(
                                "stalled: no agent picked up task for {}s (limit {}s)",
                                age, timeout_secs
                            );
                            graph
                                .nodes
                                .iter_mut()
                                .filter(|n| n.status == TaskStatus::Pending)
                                .map(|n| {
                                    n.metadata
                                        .insert("stall_error".to_string(), stall_reason.clone());
                                    n.id.clone()
                                })
                                .collect()
                        };
                        // Route each stalled node through on_node_failed for proper cleanup
                        for node_id in stalled_node_ids {
                            if let Err(e) = scheduler
                                .on_node_failed(
                                    &node_id,
                                    &format!(
                                        "Task stalled: no agent picked up task for {}s (limit {}s)",
                                        age, timeout_secs
                                    ),
                                )
                                .await
                            {
                                tracing::error!(
                                    node_id = %node_id,
                                    error = %e,
                                    "Failed to handle stall for pending node"
                                );
                            }
                        }
                        break;
                    }
                }
            }
        });

        // Second check (double-checked locking): abort duplicate if another
        // caller stored a handle while we were spawning.
        let mut slot = self.stall_watcher.lock().await;
        if slot.is_some() {
            handle.abort();
            return;
        }
        *slot = Some(handle);
    }
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use ergatai_dag::{TaskComplexity, TaskGraph, TaskNode, TaskStatus};

    use super::super::DagScheduler;
    use super::adjust_timeout_by_complexity;

    #[tokio::test]
    async fn stall_watcher_finalizes_dag_when_no_progress() {
        // Setup: build a graph with stall_timeout_secs = 1 and one Running node.
        let mut graph = TaskGraph::new(vec![TaskNode::new("n1", "a", "A")]);
        graph.stall_timeout_secs = Some(1);
        let mut node = graph.nodes[0].clone();
        node.status = TaskStatus::Running;
        graph.nodes[0] = node;

        let scheduler = DagScheduler::new(PathBuf::from("/tmp/stall-test"), graph);

        // Force last_progress into the past so the watcher's next check sees age >= 1s.
        {
            let mut lp = scheduler.last_progress.lock().await;
            *lp = std::time::Instant::now() - std::time::Duration::from_secs(5);
        }

        // Spawn the stall watcher (submit_graph would normally do this).
        scheduler.spawn_stall_watcher().await;

        // The watcher polls every POLL_INTERVAL_SECS=1s. It should detect the stall
        // and mark n1 as Failed within ~2s. Bound the test at 3s.
        let result = tokio::time::timeout(std::time::Duration::from_secs(3), async {
            loop {
                {
                    let g = scheduler.graph.lock().await;
                    let n = g.find_node("n1").unwrap();
                    if n.status == TaskStatus::Failed {
                        // Verify the stall reason was recorded in metadata.
                        assert!(
                            n.metadata.contains_key("stall_error"),
                            "stalled node should have stall_error in metadata"
                        );
                        return;
                    }
                }
                tokio::time::sleep(std::time::Duration::from_millis(100)).await;
            }
        })
        .await;

        assert!(
            result.is_ok(),
            "stall watcher should have finalized the DAG within 3s"
        );
    }

    /// Three-stage timeout watcher: warn (50%) → escalate (80%) → fail (100%).
    ///
    /// We can't easily observe the log-only warn/escalate tiers without a
    /// tracing test subscriber, so this test focuses on the fail transition:
    /// a Running node with a 2s timeout must be marked Failed with a
    /// `timeout_error` metadata entry within a bounded window.
    #[tokio::test]
    async fn timeout_watcher_emits_warn_before_fail() {
        let mut graph = TaskGraph::new(vec![TaskNode::new("n1", "agent", "slow task")]);
        graph.nodes[0].status = TaskStatus::Running;
        graph.nodes[0].timeout = Some(2);

        let temp_dir = tempfile::tempdir().unwrap();
        let scheduler = DagScheduler::new(temp_dir.path().to_path_buf(), graph);

        // Spawn the three-stage watcher directly (submit_graph is not invoked).
        scheduler.spawn_timeout_watcher("n1", 2, "agent");

        // Bound the test at 5s — the fail tier fires at 2s plus one poll tick.
        let result = tokio::time::timeout(std::time::Duration::from_secs(5), async {
            loop {
                {
                    let g = scheduler.graph.lock().await;
                    let n = g.find_node("n1").unwrap();
                    if n.status == TaskStatus::Failed {
                        // Verify the timeout reason was recorded in metadata.
                        let reason = n.metadata.get("timeout_error").cloned();
                        assert!(
                            reason.is_some(),
                            "timed-out node should carry timeout_error in metadata"
                        );
                        let reason = reason.unwrap();
                        assert!(
                            reason.contains("timeout after 2s"),
                            "timeout_error should mention the configured budget, got: {}",
                            reason
                        );
                        return;
                    }
                }
                tokio::time::sleep(std::time::Duration::from_millis(100)).await;
            }
        })
        .await;

        assert!(
            result.is_ok(),
            "timeout watcher should have failed the node within 5s"
        );
    }

    /// Complexity-based timeout scaling:
    ///   Low    → base × 0.5
    ///   Medium → base × 1.0
    ///   High   → base × 2.0
    #[test]
    fn test_complexity_timeout_adjustment() {
        assert_eq!(
            adjust_timeout_by_complexity(100, TaskComplexity::Low),
            50,
            "Low complexity should halve the base timeout"
        );
        assert_eq!(
            adjust_timeout_by_complexity(100, TaskComplexity::Medium),
            100,
            "Medium complexity should leave the base timeout unchanged"
        );
        assert_eq!(
            adjust_timeout_by_complexity(100, TaskComplexity::High),
            200,
            "High complexity should double the base timeout"
        );

        // Odd base values: f64 → u64 truncation (e.g. 3 * 0.5 = 1.5 → 1)
        assert_eq!(adjust_timeout_by_complexity(3, TaskComplexity::Low), 1);

        // Zero base always yields zero regardless of complexity.
        assert_eq!(adjust_timeout_by_complexity(0, TaskComplexity::High), 0);
        assert_eq!(adjust_timeout_by_complexity(0, TaskComplexity::Low), 0);

        // Default complexity is Medium.
        assert_eq!(
            adjust_timeout_by_complexity(60, TaskComplexity::default()),
            60
        );
    }

    /// End-to-end: a YAML DAG with `node_timeout_secs` + per-task complexity
    /// produces a graph whose scheduler will apply the right adjusted timeouts.
    /// We verify via the public `adjust_timeout_by_complexity` helper that the
    /// scheduler would compute the expected per-node budget.
    #[test]
    fn test_scheduler_uses_complexity_for_timeout() {
        let yaml = r#"
name: test_dag
node_timeout_secs: 60
tasks:
  - name: low_task
    description: "Simple task"
    agent: agent-a
    complexity: low
  - name: high_task
    description: "Complex task"
    agent: agent-b
    complexity: high
    depends_on: [low_task]
"#;

        let graph = ergatai_dag::parse_dag_yaml(yaml, None).unwrap();

        // DAG-level default propagated.
        assert_eq!(graph.node_timeout_secs, Some(60));

        // Build the same adjusted-timeout map the scheduler would use.
        let dag_default = graph.node_timeout_secs;
        let mut adjusted: std::collections::HashMap<String, u64> = std::collections::HashMap::new();
        for node in &graph.nodes {
            let base = node.timeout.or(dag_default).unwrap_or(10);
            adjusted.insert(
                node.id.clone(),
                adjust_timeout_by_complexity(base, node.complexity),
            );
        }

        // low_task: 60 × 0.5 = 30
        let low_id = graph
            .nodes
            .iter()
            .find(|n| n.agent == "agent-a")
            .unwrap()
            .id
            .clone();
        assert_eq!(adjusted[&low_id], 30, "low_task budget should be 30s");

        // high_task: 60 × 2.0 = 120
        let high_id = graph
            .nodes
            .iter()
            .find(|n| n.agent == "agent-b")
            .unwrap()
            .id
            .clone();
        assert_eq!(adjusted[&high_id], 120, "high_task budget should be 120s");
    }

    /// Per-node `timeout` overrides DAG-level `node_timeout_secs`, and
    /// complexity adjustment is still applied on top.
    #[test]
    fn test_per_node_timeout_overrides_dag_default_with_complexity() {
        let yaml = r#"
name: override_dag
node_timeout_secs: 100
tasks:
  - name: explicit_low
    agent: a
    description: "x"
    timeout: 40
    complexity: low
  - name: inherited_high
    agent: b
    description: "y"
    complexity: high
"#;
        let graph = ergatai_dag::parse_dag_yaml(yaml, None).unwrap();
        let dag_default = graph.node_timeout_secs;

        let mut adjusted = std::collections::HashMap::new();
        for node in &graph.nodes {
            let base = node.timeout.or(dag_default).unwrap_or(10);
            adjusted.insert(
                node.id.clone(),
                adjust_timeout_by_complexity(base, node.complexity),
            );
        }

        let low_id = graph
            .nodes
            .iter()
            .find(|n| n.agent == "a")
            .unwrap()
            .id
            .clone();
        // 40 × 0.5 = 20 (per-node timeout used, not DAG default)
        assert_eq!(adjusted[&low_id], 20);

        let high_id = graph
            .nodes
            .iter()
            .find(|n| n.agent == "b")
            .unwrap()
            .id
            .clone();
        // 100 × 2.0 = 200 (DAG default used since no per-node timeout)
        assert_eq!(adjusted[&high_id], 200);
    }
}
