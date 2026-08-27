//! DAG Scheduler - Integrates TaskGraph with TaskScheduler
//!
//! Bridges the DAG-based orchestration with the existing task scheduling system.
//! Main Agent submits a DAG → DagScheduler extracts ready tasks → TaskScheduler executes them
//! → On completion → DagScheduler checks for newly ready nodes → Repeat

mod dispatcher;
mod lifecycle;
mod prompt_builder;
mod registry;
mod terminal;
mod watchdog;

pub use registry::*;
pub use watchdog::adjust_timeout_by_complexity;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;

use ergatai_dag::context::DagContext;
use ergatai_error::{ErgataiError, ErgataiResult};
use tokio::sync::Mutex;

use super::task_scheduler::TaskScheduler;
use ergatai_dag::{TaskGraph, TaskStatus};

/// DAG Scheduler - manages DAG-based task orchestration
#[derive(Clone)]
pub struct DagScheduler {
    /// The task graph being executed
    graph: Arc<Mutex<TaskGraph>>,

    /// Execution context (global vars + per-node outputs) for template rendering
    context: Arc<Mutex<DagContext>>,

    /// Project root for file paths
    project_root: PathBuf,

    /// Reference to the global task scheduler
    scheduler: Arc<TaskScheduler>,

    /// Unique DAG identifier (UUID, generated at construction)
    dag_id: String,

    /// DAG creation timestamp (for duration tracking)
    created_at: std::time::Instant,

    /// Active timeout watchdog handles (node_id → JoinHandle)
    timeout_watchers: Arc<Mutex<HashMap<String, tokio::task::JoinHandle<()>>>>,

    /// DAG-level deadline (if timeout is set). When elapsed, all remaining nodes are failed.
    deadline: Option<std::time::Instant>,

    /// DAG-level timeout watchdog handle
    dag_timeout_watcher: Arc<Mutex<Option<tokio::task::JoinHandle<()>>>>,

    /// Handle for the stall watchdog task (if spawned).
    stall_watcher: Arc<Mutex<Option<tokio::task::JoinHandle<()>>>>,

    /// Guard against duplicate `finalize_if_terminal` runs when concurrent
    /// node completions race past the `is_complete()` check. The first caller
    /// to `swap(true)` proceeds with the NATS publish + registry cleanup;
    /// subsequent callers return early.
    finalized: Arc<AtomicBool>,

    /// Wall-clock of last observable progress (node completed, failed, or new submit).
    last_progress: Arc<Mutex<std::time::Instant>>,

    /// Monotonic counter of agent invocations (generate_and_submit calls).
    agent_call_count: Arc<AtomicU64>,
    /// Cap on agent invocations, from TaskGraph.max_agent_calls.
    max_agent_calls: Option<u64>,

    /// Lazily-initialized event bus for the three-stage timeout watcher.
    /// Wrapped in `Arc<Mutex<…>>` because the constructors are sync but
    /// NATS initialisation is async; the first watcher tick that needs it
    /// will populate the slot. `None` when NATS is not available (no-ops).
    event_bus: Arc<Mutex<Option<Arc<ergatai_nats::EventBus>>>>,
}

impl DagScheduler {

    /// Get a clone of the execution context
    pub fn context(&self) -> Arc<Mutex<DagContext>> {
        self.context.clone()
    }

    /// Get a clone of the task graph
    pub fn graph(&self) -> Arc<Mutex<TaskGraph>> {
        self.graph.clone()
    }

    /// Set a global variable in the context
    pub async fn set_global(&self, key: impl Into<String>, value: impl Into<String>) {
        let mut ctx = self.context.lock().await;
        ctx.set_global(key, value);
    }

    /// Record outputs from a completed node into the context
    pub async fn record_outputs(&self, node_id: &str, outputs: serde_json::Value) {
        let mut ctx = self.context.lock().await;
        ctx.record_output(node_id, outputs);
    }


    /// Get the unique DAG identifier (UUID)
    pub fn dag_id(&self) -> &str {
        &self.dag_id
    }

    /// Get the creation timestamp (for ordering schedulers by recency)
    pub fn created_at(&self) -> std::time::Instant {
        self.created_at
    }

    /// Get elapsed time since DAG creation (for duration reporting)
    fn elapsed_secs(&self) -> u64 {
        self.created_at.elapsed().as_secs()
    }

    /// Refresh the last-progress timestamp to `Instant::now()`.
    ///
    /// Called on every observable progress event: a new submit, a node
    /// completion, or a node failure. The stall watchdog (Phase 2) polls
    /// `last_progress_age_secs()` and raises an alarm if this goes stale.
    async fn touch_progress(&self) {
        let mut lp = self.last_progress.lock().await;
        *lp = std::time::Instant::now();
    }

    /// Lazily build (and cache) the `EventBus` for the three-stage timeout
    /// watcher. Returns `None` when NATS has not been initialised — callers
    /// should treat that as "no-op, just log".
    async fn get_or_init_event_bus(&self) -> Option<Arc<ergatai_nats::EventBus>> {
        // Fast path: already populated.
        {
            let guard = self.event_bus.lock().await;
            if let Some(bus) = guard.as_ref() {
                return Some(bus.clone());
            }
        }
        // Slow path: ask NATS for a connection and wrap it. One acquisition
        // of the slot mutex at a time — drop before awaiting.
        if let Some(conn) = ergatai_nats::get_nats_connection().await {
            let bus = Arc::new(ergatai_nats::EventBus::new(conn));
            let mut guard = self.event_bus.lock().await;
            // Re-check: another concurrent caller may have populated the slot
            // while we awaited the NATS connection above.
            if let Some(existing) = guard.as_ref() {
                return Some(existing.clone());
            }
            *guard = Some(bus.clone());
            Some(bus)
        } else {
            None
        }
    }

    /// Seconds elapsed since the last progress event.
    ///
    /// A large value indicates the DAG is stalled (no node completions,
    /// failures, or new submits for a while).
    pub async fn last_progress_age_secs(&self) -> u64 {
        let lp = self.last_progress.lock().await;
        lp.elapsed().as_secs()
    }

    /// Returns Ok(()) if budget allows another agent call, or Err if exhausted.
    fn check_budget(&self) -> Result<(), ErgataiError> {
        let Some(limit) = self.max_agent_calls else {
            return Ok(());
        };
        let current = self.agent_call_count.load(Ordering::SeqCst);
        if current >= limit {
            Err(ErgataiError::DagBudgetExhausted {
                dag_id: self.dag_id.clone(),
                used: current,
                limit,
            })
        } else {
            Ok(())
        }
    }

    /// Returns Some(error) if the DAG deadline has passed, None otherwise.
    fn check_deadline(&self) -> Option<ErgataiError> {
        let deadline = self.deadline?;
        let now = std::time::Instant::now();
        if now >= deadline {
            Some(ErgataiError::DagDeadlineExceeded {
                dag_id: self.dag_id.clone(),
                exceeded_by_secs: now.duration_since(deadline).as_secs(),
            })
        } else {
            None
        }
    }

    fn increment_agent_calls(&self) -> u64 {
        self.agent_call_count.fetch_add(1, Ordering::SeqCst) + 1
    }

    /// Start listening for DAG events via JetStream pull consumer
    ///
    /// Pulls messages from the `DAG_EVENTS` stream with filter `ergatai.dag.>`.
    /// Dispatches by subject:
    /// - `ergatai.dag.node_complete.*` → `on_node_completed()`
    /// - `ergatai.dag.node_failed.*`   → `on_node_failed()`
    /// - `ergatai.dag.complete.*`      → logged (no handler yet)
    ///
    /// Returns a `JoinHandle` that can be aborted to stop listening.
    pub fn start_event_listener(self) -> tokio::task::JoinHandle<()> {
        tokio::spawn(async move {
            let conn = match ergatai_nats::get_nats_connection().await {
                Some(c) => c,
                None => {
                    tracing::warn!("NATS not initialized, event listener not started");
                    return;
                }
            };

            let mut messages = match init_dag_event_consumer(&conn).await {
                Ok(m) => m,
                Err(e) => {
                    tracing::error!(error = %e, "Failed to initialize DAG event consumer");
                    return;
                }
            };

            tracing::info!(
                "JetStream DAG event listener started (stream: {}, filter: ergatai.dag.>)",
                ergatai_nats::DAG_EVENTS_STREAM
            );

            use futures_util::StreamExt;
            loop {
                let next =
                    tokio::time::timeout(std::time::Duration::from_secs(5), messages.next()).await;

                match next {
                    Err(_) => continue, // idle timeout — loop for abort check

                    Ok(None) => {
                        tracing::warn!("DAG event stream closed, listener exiting");
                        break;
                    }

                    Ok(Some(Ok(js_msg))) => {
                        handle_dag_event(&js_msg, &self).await;
                    }

                    Ok(Some(Err(e))) => {
                        tracing::warn!(error = %e, "Error receiving DAG event from stream");
                    }
                }
            }

            tracing::info!("DAG event listener stopped");
        })
    }

    /// Get current progress
    pub async fn progress(&self) -> f32 {
        let graph = self.graph.lock().await;
        graph.progress()
    }

    /// Get graph status as AI-friendly text
    pub async fn status_prompt(&self) -> String {
        let graph = self.graph.lock().await;
        graph.to_ai_prompt()
    }

    /// Check if all nodes are complete
    pub async fn is_complete(&self) -> bool {
        let graph = self.graph.lock().await;
        graph.is_complete()
    }


    /// Check if the DAG has any viable nodes (Pending or Running) after recovery.
    ///
    /// Returns true if at least one node is Pending or Running.
    /// Returns false if all nodes are Failed, Completed, or Skipped.
    pub async fn has_viable_nodes(&self) -> bool {
        let graph = self.graph.lock().await;
        graph
            .nodes
            .iter()
            .any(|n| n.status == TaskStatus::Pending || n.status == TaskStatus::Running)
    }

    /// Count nodes by status for diagnostics
    pub async fn count_nodes_by_status(&self) -> std::collections::HashMap<String, usize> {
        let graph = self.graph.lock().await;
        let mut counts = std::collections::HashMap::new();
        for node in &graph.nodes {
            let status_str = format!("{:?}", node.status);
            *counts.entry(status_str).or_insert(0) += 1;
        }
        counts
    }
}

/// Generate a random delay value in [0, max_secs) for jitter.
///
/// Uses a simple approach without external rand crate: hash the current
/// time with a counter to get pseudo-random bits.
fn rand_delay(max_secs: u64) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    std::time::SystemTime::now().hash(&mut hasher);
    // Add thread id for extra entropy across concurrent retries
    std::thread::current().id().hash(&mut hasher);
    hasher.finish() % max_secs
}

/// Initialize the JetStream pull consumer for DAG events on the DAG_EVENTS stream.
///
/// Returns a boxed stream of JetStream messages filtered to `ergatai.dag.>`.
/// The consumer is durable (`dag_events`) and resumes from the last ack on restart.
async fn init_dag_event_consumer(
    connection: &ergatai_nats::NatsConnection,
) -> ErgataiResult<
    futures_util::stream::BoxStream<
        'static,
        Result<async_nats::jetstream::Message, Box<dyn std::error::Error + Send + Sync>>,
    >,
> {
    ergatai_nats::init_dag_stream_pull_consumer(
        connection,
        ergatai_nats::DAG_EVENTS_CONSUMER,
        "ergatai.dag.>",
    )
    .await
    .map_err(ErgataiError::NatsError)
}

/// Handle a single DAG event by subject-prefix dispatch.
///
/// - `ergatai.dag.node_complete.*` → deserialize NodeCompletePayload, run `on_node_completed`
/// - `ergatai.dag.node_failed.*`   → deserialize NodeFailedPayload,  run `on_node_failed`
/// - `ergatai.dag.complete.*`      → deserialize DagCompletePayload, log (no action yet)
///
/// Acks on success; naks on handler error; acks malformed messages to discard.
async fn handle_dag_event(js_msg: &async_nats::jetstream::Message, scheduler: &DagScheduler) {
    let subject = js_msg.subject.as_str();

    // ── node_complete.* ──
    if subject.starts_with("ergatai.dag.node_complete.") {
        let payload: ergatai_nats::NodeCompletePayload = match serde_json::from_slice(
            &js_msg.payload,
        ) {
            Ok(p) => p,
            Err(e) => {
                tracing::warn!(error = %e, subject = subject, "Malformed node_complete — acking to discard");
                let _ = js_msg.ack().await;
                return;
            }
        };

        tracing::info!(node_id = %payload.node_id, "Received JetStream node_complete event");

        // Validate expected_outputs vs actual outputs before recording
        {
            let mut graph = scheduler.graph.lock().await;
            if let Some(node) = graph.find_node_mut(&payload.node_id) {
                if !node.expected_outputs.is_empty() {
                    let actual_keys: std::collections::HashSet<&String> = payload
                        .outputs
                        .as_object()
                        .map(|o| o.keys().collect())
                        .unwrap_or_default();
                    let missing: Vec<&String> = node
                        .expected_outputs
                        .keys()
                        .filter(|k| !actual_keys.contains(k))
                        .collect();
                    if !missing.is_empty() {
                        let warning = format!(
                            "Result file missing expected output keys: {}",
                            missing
                                .iter()
                                .map(|k| k.as_str())
                                .collect::<Vec<_>>()
                                .join(", ")
                        );
                        tracing::warn!(
                            node_id = %payload.node_id,
                            missing_keys = ?missing,
                            "{}", warning
                        );
                        node.metadata
                            .insert("output_warnings".to_string(), warning);
                    }
                }
            }
        }

        // Check if outputs is a non-empty object
        let has_outputs =
            matches!(&payload.outputs, serde_json::Value::Object(obj) if !obj.is_empty());
        if has_outputs {
            scheduler
                .record_outputs(&payload.node_id, payload.outputs)
                .await;
        }

        match scheduler
            .on_node_completed(&payload.node_id, payload.result_file)
            .await
        {
            Ok(newly_submitted) => {
                tracing::info!(
                    node_id = %payload.node_id,
                    newly_submitted = newly_submitted.len(),
                    "Processed node_complete, submitted downstream"
                );
                let _ = js_msg.ack().await;
            }
            Err(e) => {
                tracing::error!(node_id = %payload.node_id, error = %e, "Failed to process node_complete — naking");
                let _ = js_msg
                    .ack_with(async_nats::jetstream::message::AckKind::Nak(None))
                    .await;
            }
        }
        return;
    }

    // ── node_failed.* ──
    if subject.starts_with("ergatai.dag.node_failed.") {
        let payload: ergatai_nats::NodeFailedPayload = match serde_json::from_slice(&js_msg.payload)
        {
            Ok(p) => p,
            Err(e) => {
                tracing::warn!(error = %e, subject = subject, "Malformed node_failed — acking to discard");
                let _ = js_msg.ack().await;
                return;
            }
        };

        tracing::info!(node_id = %payload.node_id, error = %payload.error, "Received JetStream node_failed event");

        match scheduler
            .on_node_failed(&payload.node_id, &payload.error)
            .await
        {
            Ok(()) => {
                tracing::info!(node_id = %payload.node_id, "Processed node_failed");
                let _ = js_msg.ack().await;
            }
            Err(e) => {
                tracing::error!(node_id = %payload.node_id, error = %e, "Failed to process node_failed — naking");
                let _ = js_msg
                    .ack_with(async_nats::jetstream::message::AckKind::Nak(None))
                    .await;
            }
        }
        return;
    }

    // ── complete.* (informational) ──
    if subject.starts_with("ergatai.dag.complete.") {
        match serde_json::from_slice::<ergatai_nats::DagCompletePayload>(&js_msg.payload) {
            Ok(payload) => {
                tracing::info!(
                    dag_id = %payload.dag_id,
                    completed = payload.completed_nodes,
                    failed = payload.failed_nodes,
                    total = payload.total_nodes,
                    "Received JetStream dag_complete event"
                );
            }
            Err(e) => {
                tracing::warn!(error = %e, subject = subject, "Malformed dag_complete — acking to discard");
            }
        }
        let _ = js_msg.ack().await;
        return;
    }

    // ── Unknown subject under ergatai.dag.> — ack to discard ──
    tracing::warn!(
        subject = subject,
        "Unhandled DAG event subject — acking to discard"
    );
    let _ = js_msg.ack().await;
}

#[cfg(test)]
mod tests {
    use super::*;
    use ergatai_dag::TaskNode;

    fn sample_graph() -> TaskGraph {
        TaskGraph::new(vec![
            TaskNode::new("n1", "agent-a", "Task A"),
            TaskNode::new("n2", "agent-b", "Task B").with_dependencies(vec!["n1".into()]),
        ])
    }

    #[tokio::test]
    async fn test_progress_tracking() {
        let graph = sample_graph();
        let scheduler = DagScheduler::new(PathBuf::from("/tmp"), graph);
        assert_eq!(scheduler.progress().await, 0.0);
    }

    /// Integration test: verify end-to-end data flow through template rendering.
    /// A → B (B depends on A), with B's input referencing A's output and a global var.
    #[tokio::test]
    async fn test_data_flow_template_rendering() {
        // Setup: 2-node DAG with B depending on A
        let mut node_a = TaskNode::new("n1", "agent-a", "Review code");
        let _ = &mut node_a; // use it
        let node_b = TaskNode::new("n2", "agent-b", "Fix issues")
            .with_dependencies(vec!["n1".into()])
            .with_input(
                "Fix issues found in review: {{n1.review_result}}. Query: {{global.user_query}}",
            );

        let graph = TaskGraph::new(vec![TaskNode::new("n1", "agent-a", "Review code"), node_b]);

        let temp_dir = tempfile::tempdir().unwrap();
        let ctx = DagContext::new({
            let mut m = HashMap::new();
            m.insert("user_query".to_string(), "improve performance".to_string());
            m
        });

        let scheduler = DagScheduler::with_context(temp_dir.path().to_path_buf(), graph, ctx);

        // Simulate: node n1 completes with outputs
        let mut outputs = serde_json::Map::new();
        outputs.insert(
            "review_result".to_string(),
            serde_json::Value::String("3 issues found: unused imports".to_string()),
        );
        scheduler
            .record_outputs("n1", serde_json::Value::Object(outputs))
            .await;

        // Now generate plan for n2 and verify template was rendered
        let graph = scheduler.graph.lock().await;
        let n2 = graph.find_node("n2").unwrap().clone();
        drop(graph);

        let plan_file = scheduler.generate_node_plan(&n2).await.unwrap();
        let plan_content = tokio::fs::read_to_string(&plan_file).await.unwrap();

        // The plan should contain the RESOLVED values, not the raw templates
        assert!(
            plan_content.contains("3 issues found: unused imports"),
            "Plan should contain rendered upstream output, got:\n{}",
            plan_content
        );
        assert!(
            plan_content.contains("improve performance"),
            "Plan should contain rendered global var, got:\n{}",
            plan_content
        );
        assert!(
            !plan_content.contains("{{n1.review_result}}"),
            "Plan should NOT contain unresolved template"
        );
        assert!(
            !plan_content.contains("{{global.user_query}}"),
            "Plan should NOT contain unresolved template"
        );

        // Upstream context block should show n1's outputs
        assert!(
            plan_content.contains("Upstream Context"),
            "Plan should include upstream context section"
        );
        assert!(
            plan_content.contains("review_result"),
            "Upstream context should list output keys"
        );
    }

    #[tokio::test]
    async fn test_set_global_and_record_outputs_persist_in_context() {
        let graph = sample_graph();
        let scheduler = DagScheduler::new(PathBuf::from("/tmp/ctx"), graph);

        scheduler.set_global("greeting", "hello").await;
        let mut outputs = serde_json::Map::new();
        outputs.insert(
            "result".to_string(),
            serde_json::Value::String("done".to_string()),
        );
        scheduler
            .record_outputs("n1", serde_json::Value::Object(outputs))
            .await;

        let ctx = scheduler.context();
        let ctx = ctx.lock().await;
        assert_eq!(ctx.get_global("greeting"), Some("hello"));
        let outputs = ctx.get_node_outputs("n1");
        assert!(outputs.is_some());
        if let Some(serde_json::Value::Object(obj)) = outputs {
            assert_eq!(obj.get("result").and_then(|v| v.as_str()), Some("done"));
        } else {
            panic!("Expected Object");
        }
    }

    #[tokio::test]
    async fn test_is_complete_true_when_all_nodes_completed() {
        let graph = TaskGraph::new(vec![TaskNode::new("n1", "a", "A")]);
        let scheduler = DagScheduler::new(PathBuf::from("/tmp/complete"), graph);

        // Mark the only node as completed directly on the graph
        {
            let mut g = scheduler.graph.lock().await;
            g.update_status("n1", TaskStatus::Completed).unwrap();
        }
        assert!(scheduler.is_complete().await);
    }

    #[tokio::test]
    async fn test_is_complete_false_with_pending_nodes() {
        let graph = TaskGraph::new(vec![TaskNode::new("n1", "a", "A")]);
        let scheduler = DagScheduler::new(PathBuf::from("/tmp/incomplete"), graph);
        assert!(!scheduler.is_complete().await);
    }

    #[tokio::test]
    async fn test_progress_increases_after_completion() {
        let graph = TaskGraph::new(vec![
            TaskNode::new("n1", "a", "A"),
            TaskNode::new("n2", "a", "B"),
        ]);
        let scheduler = DagScheduler::new(PathBuf::from("/tmp/progress"), graph);
        assert_eq!(scheduler.progress().await, 0.0);

        {
            let mut g = scheduler.graph.lock().await;
            g.update_status("n1", TaskStatus::Completed).unwrap();
        }
        let p = scheduler.progress().await;
        assert!((p - 0.5).abs() < 0.01, "expected ~0.5 progress, got {}", p);
    }


    #[tokio::test]
    async fn test_status_prompt_returns_non_empty() {
        let graph = sample_graph();
        let scheduler = DagScheduler::new(PathBuf::from("/tmp/status"), graph);
        let prompt = scheduler.status_prompt().await;
        assert!(!prompt.is_empty());
    }

    #[tokio::test]
    async fn last_progress_initializes_grows_and_refreshes() {
        let graph = sample_graph();
        let scheduler = DagScheduler::new(PathBuf::from("/tmp/progress-ts"), graph);

        // 1. Immediately after construction, age should be small (< 2s).
        let initial = scheduler.last_progress_age_secs().await;
        assert!(
            initial < 2,
            "initial last_progress age should be < 2s, got {}s",
            initial
        );

        // 2. Wait a bit, then age should have grown to >= 1s.
        tokio::time::sleep(std::time::Duration::from_millis(1100)).await;
        let grown = scheduler.last_progress_age_secs().await;
        assert!(
            grown >= 1,
            "last_progress age should have grown to >= 1s after sleeping, got {}s",
            grown
        );

        // 3. touch_progress resets the timestamp; age should be small again.
        scheduler.touch_progress().await;
        let refreshed = scheduler.last_progress_age_secs().await;
        assert!(
            refreshed < 2,
            "last_progress age should be < 2s after touch_progress, got {}s",
            refreshed
        );
    }


    // ===== handle_submission_error tests =====

    /// Helper: build a 3-node chain n1 → n2 → n3 in a scheduler.
    /// n1 is set to the given initial status.
    pub(super) async fn chain_scheduler(n1_status: TaskStatus) -> (DagScheduler, tempfile::TempDir) {
        let graph = TaskGraph::new(vec![
            TaskNode::new("n1", "a", "A"),
            TaskNode::new("n2", "a", "B").with_dependencies(vec!["n1".into()]),
            TaskNode::new("n3", "a", "C").with_dependencies(vec!["n2".into()]),
        ]);
        let temp_dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(temp_dir.path().join(".ergatai")).unwrap();
        let scheduler = DagScheduler::new(temp_dir.path().to_path_buf(), graph);
        // Put n1 into Running first so update_status to the desired state is valid
        if n1_status != TaskStatus::Pending {
            let mut g = scheduler.graph.lock().await;
            g.update_status("n1", TaskStatus::Running).unwrap();
            if n1_status != TaskStatus::Running {
                g.update_status("n1", n1_status).unwrap();
            }
        }
        (scheduler, temp_dir)
    }
}
