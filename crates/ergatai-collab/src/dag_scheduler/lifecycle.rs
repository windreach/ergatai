//! DAG scheduler lifecycle: construction, persistence, and recovery.
//!
//! Contains the `DagScheduler` constructors, disk serialization, and
//! crash-recovery routines:
//!
//! - `new` / `with_context`: construct a fresh scheduler
//! - `save_graph_unlocked`: serialize graph + context to disk
//! - `load_from_disk` / `load_all_from_disk`: deserialize (with legacy fallback)
//! - `rollback_running_nodes`: post-crash recovery of Running nodes
//! - `graph_snapshot`: JSON diagnostic dump
//!
//! All other `DagScheduler` methods live in sibling modules and share the
//! same struct via separate `impl DagScheduler` blocks.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64};
use std::sync::Arc;

use ergatai_dag::context::DagContext;
use ergatai_dag::{TaskGraph, TaskStatus};
use ergatai_error::{ErgataiError, ErgataiResult};
use tokio::sync::Mutex;

use crate::task_scheduler::global_scheduler;
use super::DagScheduler;

impl DagScheduler {
    /// Create a new DAG scheduler with an empty context
    pub fn new(project_root: PathBuf, graph: TaskGraph) -> Self {
        // Initialize context with parameters from graph
        let context = DagContext::with_parameters(HashMap::new(), graph.parameters.clone());
        Self::with_context(project_root, graph, context)
    }

    /// Create a new DAG scheduler with the given context
    pub fn with_context(project_root: PathBuf, mut graph: TaskGraph, context: DagContext) -> Self {
        // Use persisted dag_id if available (for recovery), otherwise generate new one
        let dag_id = graph
            .dag_id
            .clone()
            .unwrap_or_else(|| format!("dag-{}", uuid::Uuid::new_v4()));

        // Read max_agent_calls before moving graph into the Arc.
        let max_agent_calls = graph.max_agent_calls;

        // Auto-compute DAG global timeout from critical path if missing or too short.
        // Critical path = sum of adjusted node timeouts along the longest dependency chain.
        // Each node's adjusted timeout = base_timeout * complexity_multiplier.
        // Buffer = 30s to absorb scheduling overhead and agent startup time.
        {
            let default_node_timeout = graph.node_timeout_secs.unwrap_or(30);
            let mut estimated: std::collections::HashMap<String, u64> =
                std::collections::HashMap::new();
            for node in &graph.nodes {
                let base = node.timeout.unwrap_or(default_node_timeout);
                let multiplier = match node.complexity {
                    ergatai_dag::dag_topology::TaskComplexity::Low => 0.5,
                    ergatai_dag::dag_topology::TaskComplexity::Medium => 1.0,
                    ergatai_dag::dag_topology::TaskComplexity::High => 2.0,
                };
                let adjusted = ((base as f64) * multiplier).ceil() as u64;
                estimated.insert(node.id.clone(), adjusted);
            }
            if let Some(cpr) =
                ergatai_dag::critical_path::calculate_critical_path(&graph, &estimated)
            {
                let min_timeout = cpr.total_duration.saturating_add(30);
                match graph.timeout {
                    None => {
                        tracing::info!(
                            dag_id = %dag_id,
                            critical_path_secs = cpr.total_duration,
                            auto_timeout_secs = min_timeout,
                            "Auto-computed DAG global timeout from critical path"
                        );
                        graph.timeout = Some(min_timeout);
                    }
                    Some(t) if t < min_timeout => {
                        tracing::warn!(
                            dag_id = %dag_id,
                            user_timeout = t,
                            critical_path_secs = cpr.total_duration,
                            min_required = min_timeout,
                            "User-specified DAG timeout too short; auto-adjusted to critical path + 30s"
                        );
                        graph.timeout = Some(min_timeout);
                    }
                    Some(_) => {}
                }
            }
        }

        // Restore deadline from persisted started_at + timeout
        let deadline = if let (Some(ref started_at), Some(timeout)) =
            (&graph.started_at, graph.timeout)
        {
            // Parse RFC3339 timestamp and calculate remaining deadline
            if let Ok(start_time) = chrono::DateTime::parse_from_rfc3339(started_at) {
                let start_utc = start_time.with_timezone(&chrono::Utc);
                let elapsed = chrono::Utc::now() - start_utc;
                let timeout_duration = std::time::Duration::from_secs(timeout);
                // Clamp to zero: if the system clock was adjusted backward,
                // elapsed could be negative. num_seconds() returns i64; casting
                // a negative value to u64 would produce ~u64::MAX.
                let elapsed_duration =
                    std::time::Duration::from_secs(elapsed.num_seconds().max(0) as u64);
                if elapsed_duration < timeout_duration {
                    Some(std::time::Instant::now() + (timeout_duration - elapsed_duration))
                } else {
                    // Already expired
                    Some(std::time::Instant::now())
                }
            } else {
                // Fallback: treat as fresh start
                Some(std::time::Instant::now() + std::time::Duration::from_secs(timeout))
            }
        } else {
            graph
                .timeout
                .map(|timeout| std::time::Instant::now() + std::time::Duration::from_secs(timeout))
        };

        // Build the collaboration session from the graph's communication field.
        // Default to MeshPolicy::Open if no communication mode is specified.
        let policy = match graph.communication.as_deref() {
            Some(s) => crate::collaboration::MeshPolicy::parse(s).unwrap_or_else(|e| {
                tracing::warn!(
                    dag_id = %dag_id,
                    communication = s,
                    error = %e,
                    "Invalid communication policy, defaulting to Open"
                );
                crate::collaboration::MeshPolicy::Open
            }),
            None => crate::collaboration::MeshPolicy::Open,
        };
        let collaboration = crate::collaboration::CollaborationSession::from_graph(
            &dag_id, &graph, policy,
        );

        Self {
            graph: Arc::new(Mutex::new(graph)),
            context: Arc::new(Mutex::new(context)),
            project_root: project_root.clone(),
            scheduler: global_scheduler(Some(project_root)),
            dag_id,
            created_at: std::time::Instant::now(),
            timeout_watchers: Arc::new(Mutex::new(HashMap::new())),
            deadline,
            dag_timeout_watcher: Arc::new(Mutex::new(None)),
            stall_watcher: Arc::new(Mutex::new(None)),
            finalized: Arc::new(AtomicBool::new(false)),
            last_progress: Arc::new(Mutex::new(std::time::Instant::now())),
            agent_call_count: Arc::new(AtomicU64::new(0)),
            max_agent_calls,
            event_bus: Arc::new(Mutex::new(None)),
            collaboration: Arc::new(Mutex::new(collaboration)),
        }
    }

    /// Save graph and context to disk (serializes under lock, writes without holding it)
    pub(super) async fn save_graph_unlocked(&self) -> ErgataiResult<()> {
        let ergatai_dir = self.project_root.join(".ergatai");
        // Use per-DAG filenames to support multiple concurrent DAGs
        let dag_id_safe = self
            .dag_id
            .replace(|c: char| !c.is_alphanumeric() && c != '-' && c != '_', "_");

        // Serialize graph
        let graph_json = {
            let graph = self.graph.lock().await;
            serde_json::to_string(&*graph)
                .map_err(|e| ErgataiError::json_with_source("Failed to serialize graph", e))?
        };
        let graph_file = ergatai_dir.join(format!("dag-state-{}.json", dag_id_safe));
        tokio::fs::write(&graph_file, graph_json.as_bytes()).await?;

        // Serialize context
        let context_json = {
            let ctx = self.context.lock().await;
            serde_json::to_string(&*ctx)
                .map_err(|e| ErgataiError::json_with_source("Failed to serialize context", e))?
        };
        let context_file = ergatai_dir.join(format!("dag-context-{}.json", dag_id_safe));
        tokio::fs::write(&context_file, context_json.as_bytes()).await?;

        Ok(())
    }

    /// Load graph and context from disk (for recovery)
    pub async fn load_from_disk(project_root: PathBuf) -> ErgataiResult<Self> {
        // Try the legacy single-DAG filename first (backward compatibility)
        let legacy_graph_file = project_root.join(".ergatai").join("dag-state.json");
        if legacy_graph_file.exists() {
            let graph = TaskGraph::load_from_file(&legacy_graph_file).await?;
            let context_file = project_root.join(".ergatai").join("dag-context.json");
            let context = if context_file.exists() {
                DagContext::load_from_file(&context_file).await?
            } else {
                DagContext::empty()
            };
            return Ok(Self::with_context(project_root, graph, context));
        }

        // Load the most recent DAG (by modification time) from per-DAG files
        let ergatai_dir = project_root.join(".ergatai");
        let mut dag_files: Vec<PathBuf> = Vec::new();
        if let Ok(mut entries) = tokio::fs::read_dir(&ergatai_dir).await {
            while let Some(entry) = entries.next_entry().await? {
                let path = entry.path();
                if let Some(ext) = path.extension() {
                    if ext.to_str() == Some("json") {
                        if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
                            if name.starts_with("dag-state-") {
                                dag_files.push(path);
                            }
                        }
                    }
                }
            }
        }

        if dag_files.is_empty() {
            return Err(ErgataiError::NotFound(
                "No DAG state files found".to_string(),
            ));
        }

        // Sort by modification time (most recent first)
        dag_files.sort_by(|a, b| {
            let a_time = a.metadata().and_then(|m| m.modified()).ok();
            let b_time = b.metadata().and_then(|m| m.modified()).ok();
            b_time.cmp(&a_time)
        });

        let graph_file = &dag_files[0];
        let graph = TaskGraph::load_from_file(graph_file).await?;

        // Derive context filename from graph filename
        let context_file = graph_file
            .file_name()
            .and_then(|n| n.to_str())
            .and_then(|n| n.strip_prefix("dag-state-"))
            .map(|id| ergatai_dir.join(format!("dag-context-{}", id)))
            .ok_or_else(|| ErgataiError::NotFound("Invalid DAG state filename".to_string()))?;

        let context = if context_file.exists() {
            DagContext::load_from_file(&context_file).await?
        } else {
            DagContext::empty()
        };

        Ok(Self::with_context(project_root, graph, context))
    }

    /// Load all DAGs from disk (for multi-DAG recovery)
    pub async fn load_all_from_disk(project_root: PathBuf) -> ErgataiResult<Vec<Self>> {
        let ergatai_dir = project_root.join(".ergatai");

        // Collect all DAG state files
        let mut dag_files: Vec<PathBuf> = Vec::new();
        if let Ok(mut entries) = tokio::fs::read_dir(&ergatai_dir).await {
            while let Some(entry) = entries.next_entry().await? {
                let path = entry.path();
                if let Some(ext) = path.extension() {
                    if ext.to_str() == Some("json") {
                        if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
                            if name.starts_with("dag-state-") {
                                dag_files.push(path);
                            }
                        }
                    }
                }
            }
        }

        let mut schedulers = Vec::new();
        for graph_file in dag_files {
            match TaskGraph::load_from_file(&graph_file).await {
                Ok(graph) => {
                    // Derive context filename
                    let context_file = graph_file
                        .file_name()
                        .and_then(|n| n.to_str())
                        .and_then(|n| n.strip_prefix("dag-state-"))
                        .map(|id| ergatai_dir.join(format!("dag-context-{}", id)));

                    let context = if let Some(ref ctx_file) = context_file {
                        if ctx_file.exists() {
                            DagContext::load_from_file(ctx_file)
                                .await
                                .unwrap_or_else(|e| {
                                    tracing::warn!(file = ?ctx_file, error = %e, "Failed to load context file, using empty context");
                                    DagContext::empty()
                                })
                        } else {
                            DagContext::empty()
                        }
                    } else {
                        DagContext::empty()
                    };

                    schedulers.push(Self::with_context(project_root.clone(), graph, context));
                }
                Err(e) => {
                    tracing::warn!(file = ?graph_file, error = %e, "Failed to load DAG state file");
                }
            }
        }

        // Also try loading legacy single-DAG file
        let legacy_graph_file = project_root.join(".ergatai").join("dag-state.json");
        if legacy_graph_file.exists() {
            if let Ok(graph) = TaskGraph::load_from_file(&legacy_graph_file).await {
                let context_file = project_root.join(".ergatai").join("dag-context.json");
                let context = if context_file.exists() {
                    DagContext::load_from_file(&context_file)
                        .await
                        .unwrap_or_else(|e| {
                            tracing::warn!(file = ?context_file, error = %e, "Failed to load legacy context file, using empty context");
                            DagContext::empty()
                        })
                } else {
                    DagContext::empty()
                };
                schedulers.push(Self::with_context(project_root.clone(), graph, context));
            }
        }

        Ok(schedulers)
    }

    /// Rollback all Running nodes to Pending (for recovery after crash)
    ///
    /// When the server crashes, nodes left in Running state are actually stopped.
    /// This method resets them to Pending so they can be resubmitted on recovery.
    ///
    /// Additionally, nodes whose target agents no longer exist are marked as Failed
    /// to prevent zombie DAGs that can never complete.
    pub async fn rollback_running_nodes(&self) -> ErgataiResult<()> {
        use ergatai_runtime::get_agent_runtime;

        let runtime = get_agent_runtime();

        // Phase 1: Collect all unique agent IDs referenced by Pending/Running nodes
        let agents_needed: Vec<String> = {
            let graph = self.graph.lock().await;
            graph
                .nodes
                .iter()
                .filter(|n| n.status == TaskStatus::Pending || n.status == TaskStatus::Running)
                .map(|n| n.agent.clone())
                .collect::<std::collections::HashSet<_>>()
                .into_iter()
                .collect()
        };

        // Phase 2: Check which agents exist
        let mut alive_agents = std::collections::HashSet::new();
        for agent_id in &agents_needed {
            // Check if agent exists in runtime (either by ID or as a prefix match)
            if runtime.get_agent(agent_id).await.is_some() {
                alive_agents.insert(agent_id.clone());
            } else {
                // Also try resolve_agent_id for stable IDs or named agents
                if runtime.resolve_agent_id(agent_id).await.is_some() {
                    alive_agents.insert(agent_id.clone());
                }
            }
        }

        // Phase 2.5: Re-check "missing" agents before marking any node Failed.
        //
        // Rationale: The startup sequence in main.rs is:
        //   1. discover_and_register_agents() (blocking, once)
        //   2. init_nats()
        //   3. DagScheduler::load_all_from_disk() → rollback_running_nodes()
        //   4. spawn periodic discovery (every 30s)
        //
        // Between step 1 and step 3, some agents may still be starting up
        // (agent session created but child process not yet registered in the runtime).
        // Without this re-check, their Pending nodes would be marked
        // Failed, and 30s later periodic discovery would find them — too late.
        //
        // Fix: trigger one more discovery scan and wait briefly, then re-check.
        let potentially_missing: Vec<String> = agents_needed
            .iter()
            .filter(|a| !alive_agents.contains(*a))
            .cloned()
            .collect();

        if !potentially_missing.is_empty() {
            tracing::info!(
                dag_id = %self.dag_id,
                missing_agents = ?potentially_missing,
                "Re-checking potentially-missing agents (they may still be starting up)"
            );

            // Trigger a fresh discovery scan
            if let Err(e) = runtime.discover_and_register_agents().await {
                tracing::warn!(
                    dag_id = %self.dag_id,
                    error = %e,
                    "Re-discovery scan failed during DAG recovery — proceeding with initial agent list"
                );
            }

            // Brief pause to let any in-flight PTY output and agent registry
            // updates settle before re-probing. 2s is conservative — enough for
            // a discover_and_register_agents cycle (typically <500ms) but short
            // enough to not noticeably delay DAG recovery.
            tokio::time::sleep(std::time::Duration::from_secs(2)).await;

            // Re-check each previously-missing agent
            for agent_id in potentially_missing {
                if runtime.get_agent(&agent_id).await.is_some()
                    || runtime.resolve_agent_id(&agent_id).await.is_some()
                {
                    tracing::info!(
                        dag_id = %self.dag_id,
                        agent = %agent_id,
                        "Agent appeared on re-check — will not mark its nodes as Failed"
                    );
                    alive_agents.insert(agent_id);
                }
            }
        }

        // Phase 3: Rollback Running→Pending for alive agents, mark Failed for dead agents
        let mut graph = self.graph.lock().await;
        let mut rolled_back = 0;
        let mut failed_dead = 0;
        let mut dead_agents_logged = std::collections::HashSet::new();

        for node in &mut graph.nodes {
            if node.status == TaskStatus::Running {
                if alive_agents.contains(&node.agent) {
                    node.status = TaskStatus::Pending;
                    node.retry_count = 0;
                    rolled_back += 1;
                } else {
                    node.status = TaskStatus::Failed;
                    node.metadata.insert(
                        "recovery_error".to_string(),
                        format!(
                            "Target agent '{}' no longer exists after crash recovery",
                            node.agent
                        ),
                    );
                    failed_dead += 1;
                    dead_agents_logged.insert(node.agent.clone());
                }
            } else if node.status == TaskStatus::Pending && !alive_agents.contains(&node.agent) {
                // Pending nodes with dead agents should also be marked Failed
                node.status = TaskStatus::Failed;
                node.metadata.insert(
                    "recovery_error".to_string(),
                    format!(
                        "Target agent '{}' no longer exists after crash recovery",
                        node.agent
                    ),
                );
                failed_dead += 1;
                dead_agents_logged.insert(node.agent.clone());
            }
        }
        drop(graph);

        if rolled_back > 0 || failed_dead > 0 {
            for agent in &dead_agents_logged {
                tracing::warn!(
                    dag_id = %self.dag_id,
                    agent = %agent,
                    "Target agent not found during DAG recovery"
                );
            }
            tracing::info!(
                dag_id = %self.dag_id,
                rolled_back,
                failed_dead,
                alive_agents = alive_agents.len(),
                "DAG recovery: rolled back Running nodes, failed nodes with dead agents"
            );
            self.save_graph_unlocked().await?;
        }

        Ok(())
    }

    /// Get a JSON snapshot of the current graph state
    pub async fn graph_snapshot(&self) -> ErgataiResult<String> {
        let graph = self.graph.lock().await;
        serde_json::to_string(&*graph)
            .map_err(|e| ErgataiError::json_with_source("Failed to serialize graph", e))
    }
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use ergatai_dag::{TaskGraph, TaskNode, TaskStatus};

    use super::super::DagScheduler;

    fn sample_graph() -> TaskGraph {
        TaskGraph::new(vec![
            TaskNode::new("n1", "agent-a", "Task A"),
            TaskNode::new("n2", "agent-b", "Task B").with_dependencies(vec!["n1".into()]),
        ])
    }

    #[tokio::test]
    async fn test_dag_scheduler_creation() {
        let graph = sample_graph();
        let scheduler = DagScheduler::new(PathBuf::from("/tmp"), graph);
        assert!(!scheduler.is_complete().await);
    }

    #[tokio::test]
    async fn test_dag_id_is_unique() {
        let graph = sample_graph();
        let path = PathBuf::from("/tmp/project-x");
        let s1 = DagScheduler::new(path.clone(), graph.clone());
        let s2 = DagScheduler::new(path, TaskGraph::new(vec![]));
        // Each scheduler gets a unique UUID-based dag_id
        assert_ne!(s1.dag_id(), s2.dag_id());
        assert!(s1.dag_id().starts_with("dag-"));
        // UUID format: dag-xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
        assert!(s1.dag_id().len() > 10);
    }

    #[tokio::test]
    async fn test_dag_id_differs_for_different_paths() {
        let s1 = DagScheduler::new(PathBuf::from("/tmp/a"), sample_graph());
        let s2 = DagScheduler::new(PathBuf::from("/tmp/b"), sample_graph());
        // Different schedulers always have different IDs (UUID-based)
        assert_ne!(s1.dag_id(), s2.dag_id());
    }

    #[tokio::test]
    async fn test_graph_snapshot_returns_valid_json() {
        let graph = sample_graph();
        let scheduler = DagScheduler::new(PathBuf::from("/tmp/snap"), graph);
        let snapshot = scheduler.graph_snapshot().await.unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&snapshot).unwrap();
        // Snapshot should contain the graph's nodes array
        assert!(parsed.get("nodes").is_some());
        assert_eq!(parsed["nodes"].as_array().unwrap().len(), 2);
    }

    #[tokio::test]
    async fn test_load_from_disk_roundtrip() {
        let graph = sample_graph();
        let temp_dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(temp_dir.path().join(".ergatai")).unwrap();

        let scheduler = DagScheduler::new(temp_dir.path().to_path_buf(), graph);
        scheduler.set_global("k", "v").await;
        scheduler.save_graph_unlocked().await.unwrap();

        // Reload
        let loaded = DagScheduler::load_from_disk(temp_dir.path().to_path_buf())
            .await
            .unwrap();
        assert!(!loaded.is_complete().await);
        let ctx = loaded.context();
        let ctx = ctx.lock().await;
        assert_eq!(ctx.get_global("k"), Some("v"));
    }

    #[tokio::test]
    async fn test_rollback_running_nodes() {
        let graph = TaskGraph::new(vec![
            TaskNode::new("n1", "agent-a", "Task A"),
            TaskNode::new("n2", "agent-b", "Task B"),
            TaskNode::new("n3", "agent-c", "Task C"),
        ]);
        let temp_dir = tempfile::tempdir().unwrap();
        // Create the .ergatai/dags/ directory that save_graph_unlocked expects
        std::fs::create_dir_all(temp_dir.path().join(".ergatai").join("dags")).unwrap();
        let scheduler = DagScheduler::new(temp_dir.path().to_path_buf(), graph);

        {
            let mut g = scheduler.graph.lock().await;
            for node in g.nodes.iter_mut() {
                match node.id.as_str() {
                    "n1" => {
                        node.status = TaskStatus::Running;
                        node.retry_count = 3;
                    }
                    "n2" => node.status = TaskStatus::Running,
                    "n3" => node.status = TaskStatus::Completed,
                    _ => {}
                }
            }
        }

        scheduler.rollback_running_nodes().await.unwrap();

        let g = scheduler.graph.lock().await;
        // When agents don't exist in runtime, Running nodes are marked as Failed
        // (not rolled back to Pending) to prevent zombie DAGs
        let n1 = g.find_node("n1").unwrap();
        assert_eq!(n1.status, TaskStatus::Failed);
        assert!(n1.metadata.contains_key("recovery_error"));
        let n2 = g.find_node("n2").unwrap();
        assert_eq!(n2.status, TaskStatus::Failed);
        assert!(n2.metadata.contains_key("recovery_error"));
        // Completed nodes should not be affected
        assert_eq!(g.find_node("n3").unwrap().status, TaskStatus::Completed);
    }
}
