//! NATS integration tests for DAG task consumer.
//!
//! These tests verify the core message flow:
//! EventBus.publish_task_submit() → JetStream → consumer receives message
//!
//! Instead of going through global_scheduler() (which has a race between consumer
//! subscription setup and JetStream publish), these tests create a pull consumer
//! directly and verify messages are delivered.
//!
//! Tests run in parallel safely via `TEST_LOCK` (each test gets its own
//! isolated NATS server with a unique tempdir store).

use ergatai_nats::{
    init_nats_with_store_dir, shutdown_nats, EventBus, TaskSubmitPayload,
};
use futures_util::StreamExt;
use std::sync::Mutex;
use tempfile::tempdir;

static _NATS_STORE_GUARD: Mutex<Option<tempfile::TempDir>> = Mutex::new(None);
/// Serializes tests that share the global `NATS_STATE` singleton.
/// Each test calls `shutdown_nats()` + `init_nats_with_store_dir()` which
/// mutate the same `OnceLock<RwLock<NatsState>>` — running them in parallel
/// causes one test to kill the server another test is using.
static TEST_LOCK: std::sync::LazyLock<tokio::sync::Mutex<()>> =
    std::sync::LazyLock::new(|| tokio::sync::Mutex::new(()));

async fn ensure_nats() -> Option<(ergatai_nats::NatsConnection, tokio::sync::MutexGuard<'static, ()>)> {
    // Acquire the global lock FIRST — prevents concurrent shutdown_nats/init races.
    let _guard = TEST_LOCK.lock().await;

    // Clean up any stale NATS state from previous tests (zombie servers,
    // broken JetStream channels). Without this, init_nats_with_store_dir()
    // returns a cached connection whose underlying channel is dead.
    shutdown_nats().await;

    let store_dir = tempdir().expect("create temp dir");
    let store_path = store_dir.path().to_path_buf();
    match init_nats_with_store_dir(store_path).await {
        Ok(conn) => {
            *_NATS_STORE_GUARD.lock().unwrap() = Some(store_dir);
            Some((conn, _guard))
        }
        Err(e) => {
            eprintln!("⚠️  Skipping (NATS not available): {}", e);
            None
        }
    }
}

fn make_payload(task_id: &str, agent: &str) -> TaskSubmitPayload {
    TaskSubmitPayload {
        task_id: task_id.to_string(),
        plan_content: format!("# {task_id}\n\n**Objective**: Integration test"),
        plan_file: format!(".ergatai/.dag-plans/{task_id}.md"),
        target_agent: agent.to_string(),
        priority: 1,
        timeout_secs: None,
        dag_id: None,
    }
}

fn unique_id() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos()
        .to_string()
}

/// Helper: create a pull consumer on DAG_EVENTS filtered to task submissions.
/// This is the same consumer that TaskScheduler uses internally.
async fn create_task_consumer(
    conn: &ergatai_nats::NatsConnection,
) -> futures_util::stream::BoxStream<
    'static,
    Result<async_nats::jetstream::Message, Box<dyn std::error::Error + Send + Sync>>,
> {
    ergatai_nats::init_dag_stream_pull_consumer(
        conn,
        "test_task_consumer",
        "ergatai.task.submit.*",
    )
    .await
    .expect("Failed to create test consumer")
}

/// Core regression: published task is received by the consumer.
///
/// This guards against the original bug: consumer not receiving JetStream messages
/// because `wait_for_consumer_ready()` was missing, so `submit_graph` could publish
/// before the consumer was bound.
#[tokio::test]
async fn test_consumer_receives_published_task() {
    let Some((conn, _guard)) = ensure_nats().await else { return };

    // Create consumer FIRST (mimics TaskScheduler startup)
    let mut messages = create_task_consumer(&conn).await;

    // Publish a task
    let bus = EventBus::new(conn);
    let task_id = format!("test-{}", unique_id());
    let payload = make_payload(&task_id, "%test_agent");
    let ack = bus
        .publish_task_submit(&payload)
        .await
        .expect("publish should succeed");
    assert!(ack.sequence > 0, "message should be persisted to stream");

    // Consumer should receive the message within 5 seconds
    let result = tokio::time::timeout(std::time::Duration::from_secs(5), messages.next()).await;
    let msg = result
        .expect("Consumer should receive message within 5s")
        .expect("Stream should yield a message")
        .expect("Message should not be a transport error");

    // Verify the payload
    let received: TaskSubmitPayload =
        serde_json::from_slice(&msg.payload).expect("Payload should deserialize");
    assert_eq!(received.task_id, task_id);
    assert_eq!(received.target_agent, "%test_agent");

    // Ack to clean up (WorkQueue retention deletes after ack)
    msg.ack().await.ok();
}

/// Multiple tasks are received in order.
#[tokio::test]
async fn test_consumer_receives_multiple_tasks() {
    let Some((conn, _guard)) = ensure_nats().await else { return };
    let mut messages = create_task_consumer(&conn).await;
    let bus = EventBus::new(conn);

    let count = 3u32;
    let mut task_ids = Vec::new();
    for i in 0..count {
        let task_id = format!("multi-{i}-{}", unique_id());
        let payload = make_payload(&task_id, &format!("%agent_{i}"));
        bus.publish_task_submit(&payload)
            .await
            .expect("publish should succeed");
        task_ids.push(task_id);
    }

    // Consumer should receive all messages
    for expected_id in &task_ids {
        let result =
            tokio::time::timeout(std::time::Duration::from_secs(5), messages.next()).await;
        let msg = result
            .expect("Should receive message within 5s")
            .expect("Stream should yield a message")
            .expect("Message should not be a transport error");

        let received: TaskSubmitPayload =
            serde_json::from_slice(&msg.payload).expect("Payload should deserialize");
        assert_eq!(&received.task_id, expected_id);
        msg.ack().await.ok();
    }
}

/// Consumer should not crash on malformed messages.
#[tokio::test]
async fn test_consumer_survives_malformed_messages() {
    let Some((conn, _guard)) = ensure_nats().await else { return };
    let mut messages = create_task_consumer(&conn).await;

    // 1. Publish a malformed message (invalid JSON)
    conn.publish_jetstream("ergatai.task.submit._malformed", b"not valid json".to_vec())
        .await
        .expect("publish raw bytes should succeed");

    // 2. Publish a valid message
    let bus = EventBus::new(conn);
    let task_id = format!("after-malformed-{}", unique_id());
    let payload = make_payload(&task_id, "%valid_agent");
    bus.publish_task_submit(&payload)
        .await
        .expect("publish valid task should succeed");

    // 3. First message should be the malformed one
    let msg1 = tokio::time::timeout(std::time::Duration::from_secs(5), messages.next())
        .await
        .expect("Should receive first message within 5s")
        .expect("Stream should yield")
        .expect("Not a transport error");

    let malformed: Result<TaskSubmitPayload, _> = serde_json::from_slice(&msg1.payload);
    assert!(
        malformed.is_err(),
        "First message should be malformed (unparseable)"
    );
    msg1.ack().await.ok(); // Ack to discard

    // 4. Second message should be the valid one
    let msg2 = tokio::time::timeout(std::time::Duration::from_secs(5), messages.next())
        .await
        .expect("Should receive second message within 5s")
        .expect("Stream should yield")
        .expect("Not a transport error");

    let valid: TaskSubmitPayload =
        serde_json::from_slice(&msg2.payload).expect("Second message should be valid JSON");
    assert_eq!(valid.task_id, task_id);
    msg2.ack().await.ok();
}

/// Consumer ready signal from global_scheduler completes promptly.
#[tokio::test]
async fn test_consumer_ready_signal_with_nats() {
    let Some((_conn, _guard)) = ensure_nats().await else { return };
    let temp_dir = tempdir().unwrap();
    let scheduler = ergatai_collab::task_scheduler::global_scheduler(Some(
        temp_dir.path().to_path_buf(),
    ));

    let result = tokio::time::timeout(
        std::time::Duration::from_secs(5),
        scheduler.wait_for_consumer_ready(),
    )
    .await;

    assert!(
        result.is_ok(),
        "wait_for_consumer_ready() timed out with NATS available — indicates a bug"
    );
}
