//! DAG Scheduler - Integrates TaskGraph with TaskScheduler
//!
//! Bridges the DAG-based orchestration with the existing task scheduling system.
//! Main Agent submits a DAG → DagScheduler extracts ready tasks → TaskScheduler executes them
//! → On completion → DagScheduler checks for newly ready nodes → Repeat

mod dispatcher;
pub mod lifecycle;
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

    /// Collaboration session bound to this DAG execution.
    /// Defines the communication policy (MeshPolicy) for participants.
    collaboration: Arc<Mutex<crate::collaboration::CollaborationSession>>,

    /// Enable automatic checkpoint creation on node completion
    auto_checkpoint: Arc<AtomicBool>,

    /// Checkpoint sequence counter (monotonically increasing per DAG)
    checkpoint_sequence: Arc<AtomicU64>,

    /// ID of the last created checkpoint (for parent-child chaining)
    last_checkpoint_id: Arc<Mutex<Option<String>>>,
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

    /// Record outputs with schema validation
    ///
    /// Validates that the outputs conform to the StateChannel schema before recording.
    /// Returns an error if validation fails.
    pub async fn record_outputs_validated(
        &self,
        node_id: &str,
        outputs: serde_json::Value,
        channel: &ergatai_dag::StateChannel,
    ) -> Result<(), Vec<String>> {
        let mut ctx = self.context.lock().await;
        ctx.record_output_validated(node_id, outputs, channel)
    }

    /// Create a state checkpoint from current DAG execution state
    ///
    /// Captures a snapshot of the task graph and context for crash recovery.
    /// Checkpoints are saved to `.ergatai/checkpoints/` directory.
    pub async fn create_checkpoint(
        &self,
        parent_checkpoint: Option<String>,
        sequence: u64,
    ) -> ErgataiResult<crate::dag_scheduler::lifecycle::StateCheckpoint> {
        let graph = self.graph.lock().await;
        let context = self.context.lock().await;

        let checkpoint = crate::dag_scheduler::lifecycle::StateCheckpoint::create(
            &self.dag_id,
            &*graph,
            &*context,
            parent_checkpoint,
            sequence,
        )
        .await;

        checkpoint.save(&self.project_root).await?;

        tracing::info!(
            dag_id = %self.dag_id,
            checkpoint_id = %checkpoint.checkpoint_id,
            sequence = checkpoint.sequence,
            "Created state checkpoint"
        );

        Ok(checkpoint)
    }

    /// Enable automatic checkpoint creation on node completion
    ///
    /// When enabled, a checkpoint is automatically created after each node completes.
    /// Checkpoints are chained (parent-child) for incremental recovery.
    pub fn enable_auto_checkpoint(&self) {
        self.auto_checkpoint.store(true, std::sync::atomic::Ordering::SeqCst);
        tracing::info!(dag_id = %self.dag_id, "Auto-checkpoint enabled");
    }

    /// Disable automatic checkpoint creation
    pub fn disable_auto_checkpoint(&self) {
        self.auto_checkpoint.store(false, std::sync::atomic::Ordering::SeqCst);
    }

    /// Check if auto-checkpoint is enabled
    pub fn is_auto_checkpoint_enabled(&self) -> bool {
        self.auto_checkpoint.load(std::sync::atomic::Ordering::SeqCst)
    }

    /// Create an automatic checkpoint (called internally on node completion)
    async fn create_auto_checkpoint(&self) -> Option<String> {
        if !self.is_auto_checkpoint_enabled() {
            return None;
        }

        let sequence = self.checkpoint_sequence.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1;
        let parent = self.last_checkpoint_id.lock().await.clone();

        match self.create_checkpoint(parent, sequence).await {
            Ok(checkpoint) => {
                let checkpoint_id = checkpoint.checkpoint_id.clone();
                *self.last_checkpoint_id.lock().await = Some(checkpoint_id.clone());
                tracing::debug!(
                    dag_id = %self.dag_id,
                    checkpoint_id = %checkpoint_id,
                    sequence = sequence,
                    "Auto-checkpoint created on node completion"
                );
                Some(checkpoint_id)
            }
            Err(e) => {
                tracing::warn!(
                    dag_id = %self.dag_id,
                    error = %e,
                    "Failed to create auto-checkpoint"
                );
                None
            }
        }
    }

    /// Spawn a background task that periodically creates checkpoints
    ///
    /// The checkpoint watcher saves a checkpoint every `interval_secs` seconds.
    /// Returns a JoinHandle that can be used to stop the watcher.
    pub async fn spawn_checkpoint_watcher(
        &self,
        interval_secs: u64,
    ) -> tokio::task::JoinHandle<()> {
        let scheduler = self.clone();
        let dag_id = self.dag_id.clone();

        tokio::spawn(async move {
            let mut sequence = 0u64;
            let mut last_checkpoint: Option<String> = None;
            let mut interval = tokio::time::interval(tokio::time::Duration::from_secs(interval_secs));

            loop {
                interval.tick().await;

                // Check if DAG is still active
                {
                    let graph = scheduler.graph.lock().await;
                    if graph.is_complete() {
                        tracing::debug!(
                            dag_id = %dag_id,
                            "DAG completed or failed, stopping checkpoint watcher"
                        );
                        break;
                    }
                }

                // Create checkpoint
                sequence += 1;
                match scheduler.create_checkpoint(last_checkpoint.clone(), sequence).await {
                    Ok(checkpoint) => {
                        last_checkpoint = Some(checkpoint.checkpoint_id.clone());
                        tracing::debug!(
                            dag_id = %dag_id,
                            checkpoint_id = %checkpoint.checkpoint_id,
                            sequence = checkpoint.sequence,
                            "Periodic checkpoint created"
                        );
                    }
                    Err(e) => {
                        tracing::warn!(
                            dag_id = %dag_id,
                            error = %e,
                            "Failed to create periodic checkpoint"
                        );
                    }
                }
            }
        })
    }

    /// Restore a DAG scheduler from a state checkpoint
    ///
    /// Creates a new DagScheduler instance from a previously saved checkpoint.
    /// The restored scheduler will have the same graph and context state as when
    /// the checkpoint was created.
    pub async fn restore_from_checkpoint(
        project_root: PathBuf,
        checkpoint: &crate::dag_scheduler::lifecycle::StateCheckpoint,
    ) -> ErgataiResult<Self> {
        tracing::info!(
            dag_id = %checkpoint.dag_id,
            checkpoint_id = %checkpoint.checkpoint_id,
            sequence = checkpoint.sequence,
            "Restoring DAG from checkpoint"
        );

        // Create a new scheduler with the checkpoint's graph and context
        let scheduler = Self::with_context(
            project_root,
            checkpoint.graph.clone(),
            checkpoint.context.clone(),
        );

        // Rollback any Running nodes to Pending (they were interrupted by the crash)
        scheduler.rollback_running_nodes().await?;

        Ok(scheduler)
    }

    /// Restore a DAG scheduler from the latest checkpoint for a given DAG ID
    ///
    /// Finds the most recent checkpoint for the specified DAG and restores from it.
    /// Returns None if no checkpoints exist for the DAG.
    pub async fn restore_from_latest_checkpoint(
        project_root: PathBuf,
        dag_id: &str,
    ) -> ErgataiResult<Option<Self>> {
        let checkpoint = crate::dag_scheduler::lifecycle::StateCheckpoint::latest_for_dag(
            &project_root,
            dag_id,
        )
        .await?;

        match checkpoint {
            Some(ckpt) => {
                let scheduler = Self::restore_from_checkpoint(project_root, &ckpt).await?;
                Ok(Some(scheduler))
            }
            None => Ok(None),
        }
    }


    /// Get the unique DAG identifier (UUID)
    pub fn dag_id(&self) -> &str {
        &self.dag_id
    }

    /// Get the creation timestamp (for ordering schedulers by recency)
    pub fn created_at(&self) -> std::time::Instant {
        self.created_at
    }

    /// Get a snapshot of the collaboration session bound to this DAG.
    pub async fn collaboration(&self) -> crate::collaboration::CollaborationSession {
        self.collaboration.lock().await.clone()
    }

    /// Check whether `from → to` messaging is permitted under this DAG's
    /// communication policy.
    ///
    /// Returns:
    /// - `CommunicationCheck::NotApplicable` if at least one endpoint is not a participant
    /// - `CommunicationCheck::Allowed` if both are participants and the policy permits
    /// - `CommunicationCheck::Denied(reason)` if both are participants but the policy forbids
    pub async fn check_communication(
        &self,
        from: &str,
        to: &str,
    ) -> crate::collaboration::CommunicationCheck {
        use crate::collaboration::CommunicationCheck;
        let session = self.collaboration.lock().await;
        if !session.participants.contains(from) || !session.participants.contains(to) {
            return CommunicationCheck::NotApplicable;
        }
        if session.allows(from, to) {
            CommunicationCheck::Allowed
        } else {
            CommunicationCheck::Denied(format!(
                "DAG {} policy ({:?}) does not permit {} → {}",
                self.dag_id, session.policy, from, to
            ))
        }
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

    /// Validate that an agent has the required profile
    ///
    /// Checks if the specified agent has a profile matching the required profile name.
    /// If profiles directory doesn't exist or no profiles are defined, validation passes
    /// (backward compatibility). If profiles exist but the required profile is not found,
    /// returns an error.
    async fn validate_agent_profile(
        &self,
        agent_name: &str,
        required_profile: &str,
    ) -> ErgataiResult<()> {
        // Discover profiles from project root
        let profiles = match ergatai_runtime::discover_profiles(&self.project_root) {
            Ok(profiles) => profiles,
            Err(e) => {
                tracing::warn!(
                    "Failed to discover agent profiles, skipping validation: {}",
                    e
                );
                // Fail open: if we can't read profiles, don't block execution
                return Ok(());
            }
        };

        // If no profiles defined, skip validation (backward compatibility)
        if profiles.is_empty() {
            tracing::debug!(
                agent = %agent_name,
                required_profile = %required_profile,
                "No profiles defined, skipping profile validation"
            );
            return Ok(());
        }

        // Check if the required profile exists
        let profile_exists = profiles.iter().any(|p| p.name == required_profile);

        if !profile_exists {
            return Err(ErgataiError::InvalidArgument(format!(
                "Required profile '{}' not found for agent '{}'. Available profiles: {:?}",
                required_profile,
                agent_name,
                profiles.iter().map(|p| &p.name).collect::<Vec<_>>()
            )));
        }

        tracing::debug!(
            agent = %agent_name,
            required_profile = %required_profile,
            "Agent profile validation passed"
        );

        Ok(())
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
