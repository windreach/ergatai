//! Global DAG scheduler registry.
//!
//! Maps `dag_id → DagScheduler` in a process-wide `OnceLock<Mutex<HashMap>>`.
//! All free functions (`set_dag_scheduler`, `get_dag_scheduler`, etc.) operate
//! on this single registry. Poisoned-lock recovery is uniform across all entry
//! points.

use std::collections::HashMap;
use std::sync::Mutex as StdMutex;

use super::DagScheduler;

static GLOBAL_DAGS: std::sync::OnceLock<StdMutex<HashMap<String, DagScheduler>>> =
    std::sync::OnceLock::new();

fn dag_registry() -> &'static StdMutex<HashMap<String, DagScheduler>> {
    GLOBAL_DAGS.get_or_init(|| StdMutex::new(HashMap::new()))
}

/// Set the active DAG scheduler (replaces any existing one with the same dag_id)
pub fn set_dag_scheduler(scheduler: DagScheduler) {
    let dag_id = scheduler.dag_id().to_string();
    match dag_registry().lock() {
        Ok(mut guard) => {
            guard.insert(dag_id, scheduler);
        }
        Err(poisoned) => {
            tracing::error!("Global DAG registry lock poisoned, recovering");
            poisoned.into_inner().insert(dag_id, scheduler);
        }
    }
}

/// Get a clone of the active DAG scheduler by dag_id, or the most recent one if dag_id is None
pub fn get_dag_scheduler() -> Option<DagScheduler> {
    get_dag_scheduler_by_id(None)
}

/// Get a clone of a specific DAG scheduler by dag_id
///
/// When `dag_id` is `None`, returns the scheduler with the most recent
/// `created_at` timestamp. HashMap iteration order is non-deterministic,
/// so we explicitly find the maximum by creation time.
pub fn get_dag_scheduler_by_id(dag_id: Option<&str>) -> Option<DagScheduler> {
    match dag_registry().lock() {
        Ok(guard) => {
            if let Some(id) = dag_id {
                guard.get(id).cloned()
            } else {
                // Return the most recently created DAG
                guard
                    .values()
                    .max_by_key(|s| s.created_at())
                    .cloned()
            }
        }
        Err(poisoned) => {
            tracing::error!("Global DAG registry lock poisoned, recovering");
            let guard = poisoned.into_inner();
            if let Some(id) = dag_id {
                guard.get(id).cloned()
            } else {
                guard
                    .values()
                    .max_by_key(|s| s.created_at())
                    .cloned()
            }
        }
    }
}

/// List all active DAG schedulers
pub fn list_dag_schedulers() -> Vec<DagScheduler> {
    match dag_registry().lock() {
        Ok(guard) => guard.values().cloned().collect(),
        Err(poisoned) => {
            tracing::error!("Global DAG registry lock poisoned, recovering");
            poisoned.into_inner().values().cloned().collect()
        }
    }
}

/// Clear a specific DAG scheduler by dag_id, or all if dag_id is None
pub fn clear_dag_scheduler() {
    clear_dag_scheduler_by_id(None)
}

/// Clear a specific DAG scheduler by dag_id
pub fn clear_dag_scheduler_by_id(dag_id: Option<&str>) {
    match dag_registry().lock() {
        Ok(mut guard) => {
            if let Some(id) = dag_id {
                guard.remove(id);
            } else {
                guard.clear();
            }
        }
        Err(poisoned) => {
            tracing::error!("Global DAG registry lock poisoned, recovering");
            let mut guard = poisoned.into_inner();
            if let Some(id) = dag_id {
                guard.remove(id);
            } else {
                guard.clear();
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use ergatai_dag::{TaskGraph, TaskNode};

    use super::*;

    /// Global test lock — serializes tests that share the `GLOBAL_DAGS` static.
    ///
    /// Both registry tests call `clear_dag_scheduler()` / `set_dag_scheduler()`
    /// which mutate the same `OnceLock<Mutex<HashMap>>`. Running them in parallel
    /// causes race conditions. This lock ensures sequential execution.
    static TEST_LOCK: std::sync::LazyLock<tokio::sync::Mutex<()>> =
        std::sync::LazyLock::new(|| tokio::sync::Mutex::new(()));

    fn sample_graph() -> TaskGraph {
        TaskGraph::new(vec![
            TaskNode::new("n1", "agent-a", "Task A"),
            TaskNode::new("n2", "agent-b", "Task B").with_dependencies(vec!["n1".into()]),
        ])
    }

    #[tokio::test]
    async fn test_global_dag_scheduler_lifecycle() {
        let _guard = TEST_LOCK.lock().await;
        // Clean slate
        clear_dag_scheduler();
        assert!(get_dag_scheduler().is_none());

        // Set
        let graph = sample_graph();
        let scheduler = DagScheduler::new(PathBuf::from("/tmp"), graph);
        set_dag_scheduler(scheduler);

        // Get
        let retrieved = get_dag_scheduler();
        assert!(retrieved.is_some());
        assert!(!retrieved.unwrap().is_complete().await);

        // Clear
        clear_dag_scheduler();
        assert!(get_dag_scheduler().is_none());
    }

    #[tokio::test]
    async fn test_global_dag_scheduler_replace() {
        let _guard = TEST_LOCK.lock().await;
        clear_dag_scheduler();

        // Set first scheduler
        let graph1 = sample_graph();
        set_dag_scheduler(DagScheduler::new(PathBuf::from("/tmp"), graph1));
        assert!(get_dag_scheduler().is_some());

        // Replace with second scheduler
        let graph2 = TaskGraph::new(vec![TaskNode::new("x1", "agent", "Task X")]);
        set_dag_scheduler(DagScheduler::new(PathBuf::from("/tmp"), graph2));

        // Should have the new one
        let s = get_dag_scheduler().unwrap();
        assert_eq!(s.progress().await, 0.0);

        clear_dag_scheduler();
    }
}
