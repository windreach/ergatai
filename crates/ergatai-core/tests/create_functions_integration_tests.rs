//! Integration tests for create_* functions across Ergatai crates.
//!
//! Covers the "create" lifecycle: create entity → verify → use → cleanup.

use ergatai_dag::{parse_dag_yaml, DagContext, TaskComplexity, TaskNode, TaskStatus};
use ergatai_nats::{init_nats_with_store_dir, shutdown_nats, NatsConnection};
use std::collections::HashMap;
use std::sync::Mutex;
use tempfile::tempdir;

// ── NATS test infrastructure ─────────────────────────────────────────

static _NATS_STORE_GUARD: Mutex<Option<tempfile::TempDir>> = Mutex::new(None);
static TEST_LOCK: std::sync::LazyLock<tokio::sync::Mutex<()>> =
    std::sync::LazyLock::new(|| tokio::sync::Mutex::new(()));

async fn ensure_nats() -> Option<(NatsConnection, tokio::sync::MutexGuard<'static, ()>)> {
    let _guard = TEST_LOCK.lock().await;
    shutdown_nats().await;
    let store_dir = tempdir().expect("tempdir");
    let store_path = store_dir.path().to_path_buf();
    match init_nats_with_store_dir(store_path).await {
        Ok(conn) => {
            *_NATS_STORE_GUARD.lock().unwrap() = Some(store_dir);
            Some((conn, _guard))
        }
        Err(e) => {
            eprintln!("⚠️  Skipping (NATS): {e}");
            None
        }
    }
}

// ═════════════════════════════════════════════════════════════════════
// 1. NATS create_stream
// ═════════════════════════════════════════════════════════════════════

#[tokio::test]
async fn create_custom_stream_and_verify() {
    let Some((conn, _guard)) = ensure_nats().await else {
        return;
    };

    use async_nats::jetstream::stream::{Config, RetentionPolicy};

    let config = Config {
        name: "TEST_CUSTOM_STREAM".to_string(),
        subjects: vec!["test.custom.>".to_string()],
        retention: RetentionPolicy::Limits,
        max_messages: 100,
        ..Default::default()
    };

    let stream = conn.create_stream(config).await;
    assert!(
        stream.is_ok(),
        "create_stream should succeed: {:?}",
        stream.err()
    );

    let mut stream = stream.unwrap();
    let info = stream.info().await.unwrap();
    assert_eq!(info.config.name, "TEST_CUSTOM_STREAM");
    assert_eq!(info.config.subjects, vec!["test.custom.>"]);
}

#[tokio::test]
async fn create_stream_idempotent() {
    let Some((conn, _guard)) = ensure_nats().await else {
        return;
    };

    use async_nats::jetstream::stream::Config;

    let config = Config {
        name: "TEST_IDEMPOTENT".to_string(),
        subjects: vec!["test.idem.>".to_string()],
        ..Default::default()
    };

    let r1 = conn.create_stream(config.clone()).await;
    assert!(r1.is_ok());

    let r2 = conn.create_stream(config).await;
    assert!(
        r2.is_ok(),
        "creating same stream twice should be idempotent"
    );
}

// ═════════════════════════════════════════════════════════════════════
// 2. DAG TaskGraph creation
// ═════════════════════════════════════════════════════════════════════

#[tokio::test]
async fn create_taskgraph_from_yaml_minimal() {
    let yaml = "tasks:\n  - name: only-task\n    agent: agent-1\n";
    let graph = parse_dag_yaml(yaml, None).unwrap();
    assert_eq!(graph.nodes.len(), 1);
    assert_eq!(graph.nodes[0].task, "only-task");
    assert_eq!(graph.nodes[0].agent, "agent-1");
    assert!(graph.nodes[0].depends_on.is_empty());
}

#[tokio::test]
async fn create_taskgraph_with_all_fields() {
    let yaml = r#"
name: full-dag
description: A complete DAG with all fields
priority: high
max_agent_calls: 50
stall_timeout_secs: 120
node_timeout_secs: 300
communication: adjacent
parameters:
  - name: query
    default: "test"

tasks:
  - name: step1
    agent: planner
    priority: high
    complexity: high
    timeout: 600
    input: "Plan {{query}}"
    scope: "src/**/*.rs"
    retry: 3

  - name: step2
    agent: coder
    depends_on: [step1]
    priority: medium
    complexity: medium
    input: "Implement based on step1"
    scope: "src/"
"#;
    let params = HashMap::from([(
        "query".to_string(),
        serde_json::Value::String("build feature X".into()),
    )]);
    let graph = parse_dag_yaml(yaml, Some(params)).unwrap();

    assert_eq!(graph.nodes.len(), 2);
    assert_eq!(graph.max_agent_calls, Some(50));
    assert_eq!(graph.stall_timeout_secs, Some(120));
    assert_eq!(graph.node_timeout_secs, Some(300));
    assert_eq!(graph.priority.as_deref(), Some("high"));

    let s1 = &graph.nodes[0];
    assert_eq!(s1.task, "step1");
    assert_eq!(s1.priority.as_deref(), Some("high"));
    assert_eq!(s1.complexity, TaskComplexity::High);
    assert_eq!(s1.max_retries, 3);

    let s2 = &graph.nodes[1];
    assert_eq!(s2.task, "step2");
    assert_eq!(s2.complexity, TaskComplexity::Medium);
    // depends_on uses UUIDs after parsing, so just verify length
    assert_eq!(s2.depends_on.len(), 1);
}

// ═════════════════════════════════════════════════════════════════════
// 3. TaskNode creation + state transitions
// ═════════════════════════════════════════════════════════════════════

#[test]
fn create_task_node_default_state_is_pending() {
    let node = TaskNode::new(
        "n1".to_string(),
        "agent-1".to_string(),
        "my-task".to_string(),
    );
    assert_eq!(node.status, TaskStatus::Pending);
    assert_eq!(node.task, "my-task");
    assert!(node.depends_on.is_empty());
}

#[test]
fn task_node_status_transitions() {
    let mut node = TaskNode::new("n1".to_string(), "agent".to_string(), "task".to_string());

    node.status = TaskStatus::Running;
    assert_eq!(node.status, TaskStatus::Running);

    node.status = TaskStatus::Completed;
    assert_eq!(node.status, TaskStatus::Completed);
}

// ═════════════════════════════════════════════════════════════════════
// 4. DagContext creation and template pipeline
// ═════════════════════════════════════════════════════════════════════

#[test]
fn create_dag_context_empty() {
    let ctx = DagContext::empty();
    assert_eq!(ctx.render_template("{{unknown}}"), "{{unknown}}");
}

#[test]
fn create_dag_context_with_parameters() {
    let mut params = HashMap::new();
    params.insert(
        "name".to_string(),
        serde_json::Value::String("world".into()),
    );

    let ctx = DagContext::with_parameters(HashMap::new(), params);
    assert_eq!(ctx.render_template("hello {{param.name}}"), "hello world");
}

#[test]
fn dag_context_record_output_and_reference() {
    use serde_json::json;

    let mut ctx = DagContext::empty();
    ctx.record_output("step1", json!({"result": "done", "count": 42}));

    assert_eq!(
        ctx.render_template("Step1 said: {{step1.result}}"),
        "Step1 said: done"
    );
}

// ═════════════════════════════════════════════════════════════════════
// 5. TaskComplexity creation + scaling
// ═════════════════════════════════════════════════════════════════════

#[test]
fn task_complexity_as_score_ordering() {
    let low = TaskComplexity::Low.as_score();
    let med = TaskComplexity::Medium.as_score();
    let high = TaskComplexity::High.as_score();
    assert!(low < med);
    assert!(med < high);
}

// ═════════════════════════════════════════════════════════════════════
// 6. Graph operations after creation
// ═════════════════════════════════════════════════════════════════════

#[tokio::test]
async fn graph_ready_tasks_after_creation() {
    let yaml = "tasks:\n  - name: A\n    agent: a1\n  - name: B\n    agent: a2\n    depends_on: [A]\n  - name: C\n    agent: a3\n    depends_on: [A]\n";
    let graph = parse_dag_yaml(yaml, None).unwrap();

    let ready = graph.ready_tasks();
    assert_eq!(ready.len(), 1);
    // ready_tasks returns TaskNode refs; .task holds the YAML name
    assert_eq!(ready[0].task, "A");
}

#[tokio::test]
async fn graph_is_complete_check() {
    let yaml = "tasks:\n  - name: only\n    agent: a1\n";
    let mut graph = parse_dag_yaml(yaml, None).unwrap();
    assert!(!graph.is_complete());

    // After YAML parsing, node ids are UUIDs — use the actual id
    let node_id = graph.nodes[0].id.clone();
    graph
        .update_status(&node_id, TaskStatus::Completed)
        .unwrap();
    assert!(graph.is_complete());
}

#[tokio::test]
async fn graph_find_node_operations() {
    let yaml = "tasks:\n  - name: alpha\n    agent: a1\n  - name: beta\n    agent: a2\n";
    let graph = parse_dag_yaml(yaml, None).unwrap();

    // find_node works by UUID id, not by name
    let id_alpha = graph.nodes[0].id.clone();
    let id_beta = graph.nodes[1].id.clone();
    assert!(graph.find_node(&id_alpha).is_some());
    assert!(graph.find_node(&id_beta).is_some());
    assert!(graph.find_node("nonexistent-uuid").is_none());
}

// ═════════════════════════════════════════════════════════════════════
// 7. Payload creation + serialization roundtrip
// ═════════════════════════════════════════════════════════════════════

#[test]
fn task_submit_payload_roundtrip() {
    use ergatai_nats::TaskSubmitPayload;

    let payload = TaskSubmitPayload {
        task_id: "t1".to_string(),
        plan_content: "# Plan\n\nDo the thing".to_string(),
        plan_file: ".ergatai/plans/t1.md".to_string(),
        target_agent: "%15".to_string(),
        priority: 5,
        timeout_secs: Some(300),
        dag_id: Some("dag-123".to_string()),
    };

    let json = serde_json::to_string(&payload).unwrap();
    let deser: TaskSubmitPayload = serde_json::from_str(&json).unwrap();

    assert_eq!(deser.task_id, "t1");
    assert_eq!(deser.target_agent, "%15");
    assert_eq!(deser.timeout_secs, Some(300));
    assert_eq!(deser.dag_id.as_deref(), Some("dag-123"));
}

#[test]
fn agent_message_payload_roundtrip() {
    use ergatai_nats::AgentMessagePayload;

    let payload = AgentMessagePayload {
        from_agent: "%10".to_string(),
        to_agent: "%20".to_string(),
        from_uuid: Some("uuid-1".to_string()),
        to_uuid: Some("uuid-2".to_string()),
        from_stable: None,
        to_stable: None,
        content: "Hello from agent 10".to_string(),
        thread_id: Some("thread-abc".to_string()),
        timestamp: 1700000000,
        metadata: HashMap::from([("priority".to_string(), "high".to_string())]),
    };

    let json = serde_json::to_string(&payload).unwrap();
    let deser: AgentMessagePayload = serde_json::from_str(&json).unwrap();

    assert_eq!(deser.from_agent, "%10");
    assert_eq!(deser.to_agent, "%20");
    assert_eq!(deser.content, "Hello from agent 10");
    assert_eq!(deser.metadata.get("priority").unwrap(), "high");
}
