//! DAG graph submission and node dispatch.
//!
//! Contains the `DagScheduler` methods that drive the core submit loop:
//!
//! - `submit_graph`: collect ready nodes, evaluate conditions, submit each
//! - `generate_and_submit`: build a plan file and dispatch a single node
//! - `calculate_critical_path`: CPM analysis for priority optimisation
//!
//! These methods call into sibling modules (`prompt_builder`, `watchdog`,
//! `terminal`, `lifecycle`) via `pub(super)` visibility, resolved at crate
//! level through the shared `impl DagScheduler` block.

use ergatai_dag::{TaskNode, TaskStatus};
use ergatai_error::{ErgataiError, ErgataiResult};

use super::watchdog::adjust_timeout_by_complexity;
use super::DagScheduler;

impl DagScheduler {
    /// Submit the DAG for execution
    /// Extracts all ready tasks and submits them to the scheduler
    pub async fn submit_graph(&self) -> ErgataiResult<Vec<String>> {
        // Persist dag_id and started_at on first submission
        {
            let mut graph = self.graph.lock().await;
            if graph.dag_id.is_none() {
                graph.dag_id = Some(self.dag_id.clone());
            }
            if graph.started_at.is_none() {
                graph.started_at = Some(chrono::Utc::now().to_rfc3339());
            }
        }

        // Check if DAG-level deadline has passed
        if let Some(deadline) = self.deadline {
            if std::time::Instant::now() >= deadline {
                tracing::error!(dag_id = %self.dag_id, "DAG deadline already passed before submission");
                return Err(ErgataiError::internal("DAG deadline already passed"));
            }
        }

        // Spawn DAG-level timeout watcher (idempotent — only spawns once)
        self.spawn_dag_timeout_watcher().await;

        // Spawn stall watchdog (idempotent — only spawns once, no-ops without stall_timeout_secs)
        self.spawn_stall_watcher().await;

        // Wait for the NATS task consumer to be ready before publishing any messages.
        // Prevents a race condition on the first DAG submission after server start:
        // global_scheduler() spawns the consumer in a background task, but consumer
        // initialization requires NATS round-trips. Without this wait, messages
        // published before the consumer is bound to the stream could be missed.
        self.scheduler.wait_for_consumer_ready().await;

        // Clear completed/failed agents from previous DAG runs (M14 fix)
        let launcher = crate::agent_launcher::AgentLauncher::new(self.project_root.clone());
        launcher.clear_stale_agents().await?;

        // Calculate critical path for priority optimization
        let critical_path_result = self.calculate_critical_path().await;

        // Atomically collect and preempt ready nodes in a single lock acquisition
        // to prevent TOCTOU race condition where concurrent submit_graph calls
        // could submit the same node twice.
        let ready_nodes: Vec<(TaskNode, u32)> = {
            let mut graph = self.graph.lock().await;
            let ready: Vec<TaskNode> = graph
                .ready_tasks()
                .into_iter()
                .filter(|n| n.status == TaskStatus::Pending)
                .cloned()
                .collect();

            // Check conditions and skip nodes that don't meet their conditions
            let mut filtered_ready = Vec::new();
            for node in ready {
                if let Some(ref condition_expr) = node.condition {
                    let context = self.context.lock().await;
                    let condition = ergatai_dag::Condition::new(condition_expr);
                    if !condition.evaluate(&context) {
                        tracing::info!(
                            node_id = %node.id,
                            condition = %condition_expr,
                            "Node condition not met, marking as Skipped"
                        );
                        graph.update_status(&node.id, TaskStatus::Skipped)?;
                        // Also skip downstream nodes that depend on this one
                        Self::skip_downstream_nodes(&mut graph, &node.id)?;
                        continue;
                    }
                }

                // Calculate adjusted priority using CPM
                let base_priority =
                    ergatai_lock::conflict_arbitration::priority_to_number(&node.priority)
                        .map(|p| p as u32)
                        .unwrap_or(2);

                let adjusted_priority = if let Some(ref cpm_result) = critical_path_result {
                    ergatai_dag::critical_path::adjust_priority_with_critical_path(
                        &node,
                        cpm_result,
                        base_priority,
                    )
                } else {
                    base_priority
                };

                filtered_ready.push((node, adjusted_priority));
            }

            // Immediately preempt as Running to prevent duplicate submission
            for (n, _) in &filtered_ready {
                graph.update_status(&n.id, TaskStatus::Running)?;
            }
            filtered_ready
        };

        // Mark progress at the top of submit_graph (once, not inside the per-node loop).
        // A stall watchdog will later compare this timestamp against now.
        self.touch_progress().await;

        let mut submitted = Vec::with_capacity(ready_nodes.len());
        for (node, priority) in ready_nodes {
            match self.generate_and_submit(&node, priority).await {
                Ok(task_id) => {
                    tracing::info!(
                        "Submitted node {} as task {} (priority: {})",
                        node.id,
                        task_id,
                        priority
                    );
                    submitted.push(task_id);
                }
                Err(e) => {
                    tracing::error!("Failed to submit node {}: {}", node.id, e);
                    self.handle_submission_error(&node.id, &e).await;
                }
            }
        }

        // Save graph state — serialize under lock, write without
        self.save_graph_unlocked().await?;

        Ok(submitted)
    }

    /// Calculate critical path for the DAG
    ///
    /// Uses estimated durations from node metadata or defaults to 10 seconds per node.
    /// Returns None if the graph is empty or has no valid start nodes.
    pub(super) async fn calculate_critical_path(
        &self,
    ) -> Option<ergatai_dag::critical_path::CriticalPathResult> {
        let graph = self.graph.lock().await;

        // Build estimated durations map
        // Try to use node timeout (complexity-adjusted) as estimate,
        // then DAG default, then fall back to 10 seconds
        let dag_default = graph.node_timeout_secs;
        let mut estimated_durations = std::collections::HashMap::new();
        for node in &graph.nodes {
            let base = node.timeout.or(dag_default).unwrap_or(10);
            let duration = adjust_timeout_by_complexity(base, node.complexity);
            estimated_durations.insert(node.id.clone(), duration);
        }

        // Hold the graph lock across the entire computation to prevent graph
        // mutation between building estimated_durations and computing the
        // critical path. The CPM computation is pure and fast.
        ergatai_dag::critical_path::calculate_critical_path(&graph, &estimated_durations)
    }

    /// Generate plan and submit to scheduler (no lock acquisition)
    ///
    /// Prefers NATS event publishing when available (decoupled, event-driven).
    /// Falls back to direct `task_scheduler.submit_task()` call otherwise.
    pub(super) async fn generate_and_submit(
        &self,
        node: &TaskNode,
        priority: u32,
    ) -> ErgataiResult<String> {
        // Deadline check: refuse dispatch when the DAG-level timeout has elapsed.
        // Mirrors the budget-check pattern — finalize defensively so the DAG can
        // settle, then propagate the error to the caller.
        if let Some(err) = self.check_deadline() {
            self.finalize_if_terminal().await;
            return Err(err);
        }
        // Budget check: refuse dispatch when DAG-level agent call cap is exhausted.
        // On exhaustion, defensively nudge terminal finalization so the DAG can
        // settle (callers already handle the propagated Err by reverting the
        // node to Pending and logging).
        if let Err(e) = self.check_budget() {
            self.finalize_if_terminal().await;
            return Err(e);
        }
        let new_count = self.increment_agent_calls();
        tracing::debug!(
            dag_id = %self.dag_id,
            count = new_count,
            "agent call dispatched"
        );

        // Resolve effective base timeout: per-node override or DAG default.
        let base_timeout: Option<u64> = {
            let graph = self.graph.lock().await;
            node.timeout.or(graph.node_timeout_secs)
        };
        // Scale base timeout by task complexity (Low × 0.5, Medium × 1.0, High × 2.0).
        let adjusted_timeout: Option<u64> =
            base_timeout.map(|t| adjust_timeout_by_complexity(t, node.complexity));

        if base_timeout.is_some() {
            tracing::info!(
                node_id = %node.id,
                complexity = ?node.complexity,
                complexity_score = node.complexity.as_score(),
                base_timeout_secs = base_timeout,
                adjusted_timeout_secs = adjusted_timeout,
                "submitting node with complexity-adjusted timeout"
            );
        }

        // Generate plan file (still needed — agents read it as a document)
        let plan_file = self.generate_node_plan(node).await?;
        let task_id = node.id.clone();

        if ergatai_nats::is_nats_initialized().await {
            // NATS path: publish task submission event with inline plan content
            if let Some(conn) = ergatai_nats::get_nats_connection().await {
                let bus = ergatai_nats::EventBus::new(conn);
                let plan_content = tokio::fs::read_to_string(&plan_file).await?;
                let dag_id = self.dag_id().to_string();

                let payload = ergatai_nats::TaskSubmitPayload {
                    task_id: task_id.clone(),
                    plan_content,
                    plan_file: plan_file.to_string_lossy().to_string(),
                    target_agent: node.agent.clone(),
                    priority,
                    timeout_secs: adjusted_timeout,
                    dag_id: Some(dag_id),
                    expected_outputs: node.expected_outputs.clone(),
                };

                bus.publish_task_submit(&payload).await?;
                tracing::info!(task_id = task_id, "Submitted node via NATS event");

                // Start timeout watchdog if timeout is configured
                if let Some(timeout_secs) = adjusted_timeout {
                    self.spawn_timeout_watcher(&task_id, timeout_secs, &node.agent);
                }

                return Ok(task_id);
            }
        }

        // Fallback: direct task_scheduler call
        let tid = self
            .scheduler
            .submit_task_with_priority(plan_file, priority)
            .await?;

        // Start timeout watchdog if timeout is configured
        if let Some(timeout_secs) = adjusted_timeout {
            self.spawn_timeout_watcher(&tid, timeout_secs, &node.agent);
        }

        Ok(tid)
    }
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use ergatai_dag::{TaskGraph, TaskNode};
    use ergatai_error::ErgataiError;

    use super::super::DagScheduler;

    fn sample_graph() -> TaskGraph {
        TaskGraph::new(vec![
            TaskNode::new("n1", "agent-a", "Task A"),
            TaskNode::new("n2", "agent-b", "Task B").with_dependencies(vec!["n1".into()]),
        ])
    }

    #[tokio::test]
    async fn dag_budget_exhausted_returns_error() {
        // Setup: construct a DagScheduler with max_agent_calls = Some(1).
        let mut graph = sample_graph();
        graph.max_agent_calls = Some(1);
        let scheduler = DagScheduler::new(PathBuf::from("/tmp/budget"), graph);

        // First budget check should succeed (counter = 0, limit = 1).
        assert!(
            scheduler.check_budget().is_ok(),
            "check_budget should be Ok before any calls"
        );

        // Consume the single allowed agent call.
        let new_count = scheduler.increment_agent_calls();
        assert_eq!(new_count, 1, "first increment should yield 1");

        // Second budget check should fail with DagBudgetExhausted variant.
        let err = scheduler
            .check_budget()
            .expect_err("check_budget should be Err after exhausting the budget");
        assert!(
            matches!(err, ErgataiError::DagBudgetExhausted { .. }),
            "expected DagBudgetExhausted variant, got: {:?}",
            err
        );
        assert!(
            err.is_permanent_dag_failure(),
            "DagBudgetExhausted should be classified as permanent failure"
        );
    }

    #[tokio::test]
    async fn dag_deadline_check_returns_reason_when_expired() {
        let graph = sample_graph();
        let mut scheduler = DagScheduler::new(PathBuf::from("/tmp/deadline"), graph);
        // No deadline set → should return None
        assert!(scheduler.check_deadline().is_none());
        // Set deadline to past
        scheduler.deadline = Some(std::time::Instant::now() - std::time::Duration::from_secs(10));
        // Should return Some(DagDeadlineExceeded) with dag_id
        let err = scheduler.check_deadline().unwrap();
        assert!(
            matches!(err, ErgataiError::DagDeadlineExceeded { .. }),
            "expected DagDeadlineExceeded variant, got: {:?}",
            err
        );
        assert!(
            err.is_permanent_dag_failure(),
            "DagDeadlineExceeded should be classified as permanent failure"
        );
        // Error message should include the dag_id for observability
        let reason = err.to_string();
        assert!(
            reason.contains(scheduler.dag_id()),
            "expected dag_id in reason, got: {}",
            reason
        );
    }

    /// P0: Submit graph with zero nodes.
    ///
    /// Verifies that submit_graph handles an empty DAG gracefully,
    /// returning an empty task list and marking the DAG as complete
    /// without panicking or hanging. The DAG should be considered "complete" immediately.
    #[tokio::test]
    async fn test_submit_graph_empty_graph_returns_empty_and_finalizes() {
        let graph = TaskGraph::new(vec![]); // Empty graph
        let temp_dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(temp_dir.path().join(".ergatai")).unwrap();
        let scheduler = DagScheduler::new(temp_dir.path().to_path_buf(), graph);

        // Submit the empty graph — should return immediately with no tasks
        let result = scheduler.submit_graph().await;
        assert!(result.is_ok(), "submit_graph should succeed on empty graph");

        let submitted = result.unwrap();
        assert!(
            submitted.is_empty(),
            "Empty graph should submit zero tasks, got {:?}",
            submitted
        );

        // The graph should be considered complete (all zero nodes are terminal)
        let g = scheduler.graph.lock().await;
        assert!(
            g.is_complete(),
            "Empty graph should be immediately complete"
        );
    }

    /// P0: Submit graph when deadline has already passed.
    ///
    /// Verifies that submit_graph rejects submission when the deadline is in the past,
    /// rather than hanging or proceeding with invalid state.
    ///
    /// Note: DagScheduler auto-adjusts `graph.timeout` upward to critical path + 30s.
    /// For a single default node, the auto-timeout is 60s (30s base + 30s buffer).
    /// We set `started_at` 120s in the past so the deadline is past even after the
    /// auto-adjustment.
    #[tokio::test]
    async fn test_submit_graph_deadline_in_past_returns_error() {
        let mut graph = TaskGraph::new(vec![TaskNode::new("n1", "agent-a", "Task A")]);
        // Set a deadline that's already passed (small user timeout, started long ago).
        // The auto-timeout will bump `timeout` up to 60s, but started_at is 120s ago,
        // so the effective deadline is still 60s in the past.
        graph.timeout = Some(1);
        graph.started_at =
            Some((chrono::Utc::now() - chrono::Duration::seconds(120)).to_rfc3339());

        let temp_dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(temp_dir.path().join(".ergatai")).unwrap();
        let scheduler = DagScheduler::new(temp_dir.path().to_path_buf(), graph);

        // Submit should fail because deadline has passed
        let result = scheduler.submit_graph().await;
        assert!(
            result.is_err(),
            "submit_graph should fail when deadline is in the past"
        );

        let err = result.unwrap_err();
        assert!(
            err.to_string().contains("deadline") || err.to_string().contains("passed"),
            "Error should mention deadline: {}",
            err
        );
    }
}
