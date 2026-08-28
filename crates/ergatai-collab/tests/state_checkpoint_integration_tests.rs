//! Integration tests for StateCheckpoint

use ergatai_collab::dag_scheduler::lifecycle::StateCheckpoint;
use ergatai_dag::context::DagContext;
use ergatai_dag::{TaskGraph, TaskNode};
use tempfile::TempDir;

#[tokio::test]
async fn test_checkpoint_create_basic() {
    let graph = TaskGraph::new(vec![
        TaskNode::new("n1", "agent-a", "Task A"),
        TaskNode::new("n2", "agent-b", "Task B"),
    ]);
    let context = DagContext::empty();

    let checkpoint = StateCheckpoint::create("test-dag-1", &graph, &context, None, 1).await;

    assert_eq!(checkpoint.dag_id, "test-dag-1");
    assert_eq!(checkpoint.sequence, 1);
    assert!(checkpoint.parent_checkpoint.is_none());
    assert!(!checkpoint.checkpoint_id.is_empty());
    assert!(checkpoint.checkpoint_id.starts_with("ckpt-"));
    // created_at should be valid RFC3339
    assert!(chrono::DateTime::parse_from_rfc3339(&checkpoint.created_at).is_ok());
}

#[tokio::test]
async fn test_checkpoint_create_with_parent() {
    let graph = TaskGraph::new(vec![TaskNode::new("n1", "agent-a", "Task A")]);
    let context = DagContext::empty();

    let ckpt1 = StateCheckpoint::create("dag-1", &graph, &context, None, 1).await;
    let ckpt2 = StateCheckpoint::create(
        "dag-1",
        &graph,
        &context,
        Some(ckpt1.checkpoint_id.clone()),
        2,
    )
    .await;

    assert_eq!(ckpt2.parent_checkpoint, Some(ckpt1.checkpoint_id.clone()));
    assert_eq!(ckpt2.sequence, 2);
}

#[tokio::test]
async fn test_checkpoint_save_and_load_roundtrip() {
    let temp_dir = TempDir::new().unwrap();
    let project_root = temp_dir.path().to_path_buf();

    let graph = TaskGraph::new(vec![
        TaskNode::new("n1", "agent-a", "Task A"),
        TaskNode::new("n2", "agent-b", "Task B"),
    ]);
    let context = DagContext::empty();

    let checkpoint = StateCheckpoint::create("test-dag-1", &graph, &context, None, 1).await;
    let checkpoint_id = checkpoint.checkpoint_id.clone();

    // Save
    checkpoint.save(&project_root).await.unwrap();

    // Verify file exists
    let checkpoint_file = project_root
        .join(".ergatai")
        .join("checkpoints")
        .join(format!("{}.json", checkpoint_id));
    assert!(checkpoint_file.exists());

    // Load
    let loaded = StateCheckpoint::load(&project_root, &checkpoint_id)
        .await
        .unwrap();

    assert_eq!(loaded.checkpoint_id, checkpoint_id);
    assert_eq!(loaded.dag_id, "test-dag-1");
    assert_eq!(loaded.sequence, 1);
    assert_eq!(loaded.graph.nodes.len(), 2);
    assert_eq!(loaded.created_at, checkpoint.created_at);
}

#[tokio::test]
async fn test_checkpoint_preserves_context() {
    let temp_dir = TempDir::new().unwrap();
    let project_root = temp_dir.path().to_path_buf();

    let graph = TaskGraph::new(vec![
        TaskNode::new("n1", "agent-a", "Task A"),
        TaskNode::new("n2", "agent-b", "Task B"),
    ]);

    let mut context = DagContext::empty();
    context.set_global("global_var", "global_value");
    context.record_output("n1", serde_json::json!({"output": "data1"}));
    context.record_output("n2", serde_json::json!({"output": "data2"}));

    let checkpoint = StateCheckpoint::create("context-test-dag", &graph, &context, None, 1).await;
    checkpoint.save(&project_root).await.unwrap();

    // Load and verify context is preserved
    let loaded = StateCheckpoint::load(&project_root, &checkpoint.checkpoint_id)
        .await
        .unwrap();

    // Check global variables
    assert_eq!(
        loaded.context.get_global("global_var"),
        Some("global_value")
    );

    // Check node outputs exist
    assert!(loaded.context.has_node_outputs("n1"));
    assert!(loaded.context.has_node_outputs("n2"));

    let n1_output = loaded.context.get_node_outputs("n1").unwrap();
    assert_eq!(n1_output["output"], "data1");
}

#[tokio::test]
async fn test_checkpoint_list_for_dag() {
    let temp_dir = TempDir::new().unwrap();
    let project_root = temp_dir.path().to_path_buf();

    let graph = TaskGraph::new(vec![TaskNode::new("n1", "agent-a", "Task A")]);
    let context = DagContext::empty();

    // Create multiple checkpoints for the same DAG
    let ckpt1 = StateCheckpoint::create("dag-1", &graph, &context, None, 1).await;
    ckpt1.save(&project_root).await.unwrap();

    let ckpt2 = StateCheckpoint::create(
        "dag-1",
        &graph,
        &context,
        Some(ckpt1.checkpoint_id.clone()),
        2,
    )
    .await;
    ckpt2.save(&project_root).await.unwrap();

    let ckpt3 = StateCheckpoint::create(
        "dag-1",
        &graph,
        &context,
        Some(ckpt2.checkpoint_id.clone()),
        3,
    )
    .await;
    ckpt3.save(&project_root).await.unwrap();

    // Create a checkpoint for a different DAG
    let ckpt_other = StateCheckpoint::create("dag-2", &graph, &context, None, 1).await;
    ckpt_other.save(&project_root).await.unwrap();

    // List checkpoints for dag-1
    let checkpoints = StateCheckpoint::list_for_dag(&project_root, "dag-1")
        .await
        .unwrap();

    assert_eq!(checkpoints.len(), 3);
    // Sorted by sequence
    assert_eq!(checkpoints[0].sequence, 1);
    assert_eq!(checkpoints[1].sequence, 2);
    assert_eq!(checkpoints[2].sequence, 3);

    // Verify parent-child relationships
    assert!(checkpoints[0].parent_checkpoint.is_none());
    assert_eq!(
        checkpoints[1].parent_checkpoint,
        Some(ckpt1.checkpoint_id.clone())
    );
    assert_eq!(
        checkpoints[2].parent_checkpoint,
        Some(ckpt2.checkpoint_id.clone())
    );

    // dag-2 should only have 1 checkpoint
    let dag2_checkpoints = StateCheckpoint::list_for_dag(&project_root, "dag-2")
        .await
        .unwrap();
    assert_eq!(dag2_checkpoints.len(), 1);
}

#[tokio::test]
async fn test_checkpoint_latest_for_dag() {
    let temp_dir = TempDir::new().unwrap();
    let project_root = temp_dir.path().to_path_buf();

    let graph = TaskGraph::new(vec![TaskNode::new("n1", "agent-a", "Task A")]);
    let context = DagContext::empty();

    let ckpt1 = StateCheckpoint::create("dag-1", &graph, &context, None, 1).await;
    ckpt1.save(&project_root).await.unwrap();

    let ckpt2 = StateCheckpoint::create("dag-1", &graph, &context, None, 2).await;
    ckpt2.save(&project_root).await.unwrap();

    let ckpt3 = StateCheckpoint::create("dag-1", &graph, &context, None, 3).await;
    ckpt3.save(&project_root).await.unwrap();

    // Get the latest checkpoint
    let latest = StateCheckpoint::latest_for_dag(&project_root, "dag-1")
        .await
        .unwrap();

    assert!(latest.is_some());
    let latest = latest.unwrap();
    assert_eq!(latest.sequence, 3);
    assert_eq!(latest.checkpoint_id, ckpt3.checkpoint_id);
}

#[tokio::test]
async fn test_checkpoint_latest_for_nonexistent_dag() {
    let temp_dir = TempDir::new().unwrap();
    let project_root = temp_dir.path().to_path_buf();

    let latest = StateCheckpoint::latest_for_dag(&project_root, "nonexistent-dag")
        .await
        .unwrap();
    assert!(latest.is_none());
}

#[tokio::test]
async fn test_checkpoint_delete() {
    let temp_dir = TempDir::new().unwrap();
    let project_root = temp_dir.path().to_path_buf();

    let graph = TaskGraph::new(vec![TaskNode::new("n1", "agent-a", "Task A")]);
    let context = DagContext::empty();

    let checkpoint = StateCheckpoint::create("dag-1", &graph, &context, None, 1).await;
    let checkpoint_id = checkpoint.checkpoint_id.clone();
    checkpoint.save(&project_root).await.unwrap();

    // Verify it exists
    let checkpoint_file = project_root
        .join(".ergatai")
        .join("checkpoints")
        .join(format!("{}.json", checkpoint_id));
    assert!(checkpoint_file.exists());

    // Delete it
    StateCheckpoint::delete(&project_root, &checkpoint_id)
        .await
        .unwrap();

    // Verify it's gone
    assert!(!checkpoint_file.exists());

    // Verify load fails
    let result = StateCheckpoint::load(&project_root, &checkpoint_id).await;
    assert!(result.is_err());
}

#[tokio::test]
async fn test_checkpoint_load_nonexistent() {
    let temp_dir = TempDir::new().unwrap();
    let project_root = temp_dir.path().to_path_buf();

    let result = StateCheckpoint::load(&project_root, "nonexistent-id").await;
    assert!(result.is_err());
}

#[tokio::test]
async fn test_checkpoint_list_empty_dir() {
    let temp_dir = TempDir::new().unwrap();
    let project_root = temp_dir.path().to_path_buf();

    // List for non-existent directory should return empty vec, not error
    let checkpoints = StateCheckpoint::list_for_dag(&project_root, "dag-1")
        .await
        .unwrap();
    assert!(checkpoints.is_empty());
}

#[tokio::test]
async fn test_checkpoint_create_with_dag_scheduler() {
    let temp_dir = TempDir::new().unwrap();
    let project_root = temp_dir.path().to_path_buf();
    std::fs::create_dir_all(project_root.join(".ergatai").join("dags")).unwrap();

    let graph = TaskGraph::new(vec![
        TaskNode::new("n1", "agent-a", "Task A"),
        TaskNode::new("n2", "agent-b", "Task B").with_dependencies(vec!["n1".into()]),
    ]);

    let scheduler = ergatai_collab::DagScheduler::new(project_root.clone(), graph);

    // Create a checkpoint via the scheduler
    let checkpoint = scheduler.create_checkpoint(None, 1).await.unwrap();

    assert_eq!(checkpoint.sequence, 1);
    assert!(checkpoint.checkpoint_id.starts_with("ckpt-"));

    // Verify it was saved to disk
    let loaded = StateCheckpoint::load(&project_root, &checkpoint.checkpoint_id)
        .await
        .unwrap();
    assert_eq!(loaded.checkpoint_id, checkpoint.checkpoint_id);
}

#[tokio::test]
async fn test_checkpoint_chain_via_scheduler() {
    let temp_dir = TempDir::new().unwrap();
    let project_root = temp_dir.path().to_path_buf();
    std::fs::create_dir_all(project_root.join(".ergatai").join("dags")).unwrap();

    let graph = TaskGraph::new(vec![TaskNode::new("n1", "agent-a", "Task A")]);
    let scheduler = ergatai_collab::DagScheduler::new(project_root.clone(), graph);

    // Create a chain of checkpoints
    let ckpt1 = scheduler.create_checkpoint(None, 1).await.unwrap();
    let ckpt2 = scheduler
        .create_checkpoint(Some(ckpt1.checkpoint_id.clone()), 2)
        .await
        .unwrap();
    let ckpt3 = scheduler
        .create_checkpoint(Some(ckpt2.checkpoint_id.clone()), 3)
        .await
        .unwrap();

    // Verify the chain
    assert!(ckpt1.parent_checkpoint.is_none());
    assert_eq!(ckpt2.parent_checkpoint, Some(ckpt1.checkpoint_id.clone()));
    assert_eq!(ckpt3.parent_checkpoint, Some(ckpt2.checkpoint_id.clone()));

    // Verify latest
    let dag_id = scheduler.dag_id().to_string();
    let latest = StateCheckpoint::latest_for_dag(&project_root, &dag_id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(latest.checkpoint_id, ckpt3.checkpoint_id);
    assert_eq!(latest.sequence, 3);
}

#[tokio::test]
async fn test_checkpoint_graph_state_preserved() {
    let temp_dir = TempDir::new().unwrap();
    let project_root = temp_dir.path().to_path_buf();

    let mut graph = TaskGraph::new(vec![
        TaskNode::new("n1", "agent-a", "Task A"),
        TaskNode::new("n2", "agent-b", "Task B").with_dependencies(vec!["n1".into()]),
    ]);

    let context = DagContext::empty();

    // Mark n1 as completed to simulate mid-execution state
    {
        if let Some(node) = graph.find_node_mut("n1") {
            node.status = ergatai_dag::TaskStatus::Completed;
        }
        let checkpoint = StateCheckpoint::create("state-test-dag", &graph, &context, None, 1).await;
        checkpoint.save(&project_root).await.unwrap();

        // Load and verify status is preserved
        let loaded = StateCheckpoint::load(&project_root, &checkpoint.checkpoint_id)
            .await
            .unwrap();

        let loaded_n1 = loaded.graph.find_node("n1").unwrap();
        assert_eq!(loaded_n1.status, ergatai_dag::TaskStatus::Completed);

        let loaded_n2 = loaded.graph.find_node("n2").unwrap();
        assert_eq!(loaded_n2.status, ergatai_dag::TaskStatus::Pending);
    }
}
