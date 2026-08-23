//! NATS pub/sub integration tests.
//!
//! These tests exercise core NATS publish/subscribe flows end-to-end against
//! an isolated, embedded nats-server (one per test, via `init_nats_with_store_dir`).
//!
//! ## Test isolation
//!
//! All tests share a global `NATS_STATE` singleton (`OnceLock<RwLock<NatsState>>`),
//! so they must run sequentially. Each test acquires `TEST_LOCK` then calls
//! `shutdown_nats()` + `init_nats_with_store_dir()` to get a fresh server with
//! its own tempdir store. Tests skip gracefully if nats-server is not on PATH.

use ergatai_nats::{
    init_nats_with_store_dir, shutdown_nats,
    AgentMessagePayload, DagEvent, EventBus, NodeCompletePayload, TaskSubmitPayload,
};
use futures_util::StreamExt;
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Duration;
use tempfile::tempdir;

/// Keeps the tempdir alive for the duration of the test — dropping it early
/// would delete the JetStream store out from under the running nats-server.
static _NATS_STORE_GUARD: Mutex<Option<tempfile::TempDir>> = Mutex::new(None);

/// Serializes tests that share the global `NATS_STATE` singleton.
/// Without this lock, concurrent `shutdown_nats` / `init_nats_with_store_dir`
/// calls from different tests would race and tear down each other's servers.
static TEST_LOCK: std::sync::LazyLock<tokio::sync::Mutex<()>> =
    std::sync::LazyLock::new(|| tokio::sync::Mutex::new(()));

/// Acquire the global lock, shut down any stale NATS state, and start a fresh
/// embedded server backed by a unique tempdir. Returns `(connection, guard)`
/// where `guard` keeps the `TEST_LOCK` held for the test's duration.
///
/// Returns `None` (and the test should early-return) if nats-server is not
/// available on PATH — this lets the suite skip gracefully in CI environments
/// without the binary.
async fn ensure_nats() -> Option<(
    ergatai_nats::NatsConnection,
    tokio::sync::MutexGuard<'static, ()>,
)> {
    // Acquire the global lock FIRST — prevents concurrent shutdown_nats/init races.
    let guard = TEST_LOCK.lock().await;

    // Clean up any stale NATS state from previous tests (zombie servers,
    // broken JetStream channels). Without this, init_nats_with_store_dir()
    // returns a cached connection whose underlying channel is dead.
    shutdown_nats().await;

    let store_dir = tempdir().expect("create temp dir");
    let store_path = store_dir.path().to_path_buf();
    match init_nats_with_store_dir(store_path).await {
        Ok(conn) => {
            *_NATS_STORE_GUARD.lock().unwrap() = Some(store_dir);
            Some((conn, guard))
        }
        Err(e) => {
            eprintln!("⚠️  Skipping (NATS not available): {}", e);
            None
        }
    }
}

/// Timeout for receiving a single message. Generous enough to survive slow CI
/// but short enough that a broken test fails fast rather than hanging.
const RECV_TIMEOUT: Duration = Duration::from_secs(5);

// ---------------------------------------------------------------------------
// 1. Core pub/sub: publish to a subject, subscribe and receive
// ---------------------------------------------------------------------------

#[tokio::test]
async fn test_core_pubsub() {
    let Some((conn, _guard)) = ensure_nats().await else {
        return;
    };

    let mut sub = conn.subscribe("test.core.pubsub").await.unwrap();

    conn.publish("test.core.pubsub", b"hello world".to_vec())
        .await
        .unwrap();

    let msg = tokio::time::timeout(RECV_TIMEOUT, sub.next())
        .await
        .expect("should receive message within timeout")
        .expect("stream should yield a message");

    assert_eq!(&msg.payload[..], b"hello world");
}

// ---------------------------------------------------------------------------
// 2. JetStream publish + ack: publish_jetstream returns PublishAck with
//    sequence > 0
// ---------------------------------------------------------------------------

#[tokio::test]
async fn test_jetstream_publish_returns_ack_with_sequence() {
    let Some((conn, _guard)) = ensure_nats().await else {
        return;
    };

    // publish_jetstream targets a subject bound to one of the streams created
    // by init_nats_with_store_dir (DAG_EVENTS covers ergatai.task.submit.*).
    let ack = conn
        .publish_jetstream("ergatai.task.submit.ack-test", b"persisted".to_vec())
        .await
        .expect("JetStream publish should succeed");

    assert!(
        ack.sequence > 0,
        "PublishAck sequence should be > 0, got {}",
        ack.sequence
    );
    assert_eq!(ack.stream, "DAG_EVENTS");
}

// ---------------------------------------------------------------------------
// 3. Multiple subscribers: two subscribers on the same subject both receive
//    the message (fan-out, not competing consumers)
// ---------------------------------------------------------------------------

#[tokio::test]
async fn test_multiple_subscribers_both_receive() {
    let Some((conn, _guard)) = ensure_nats().await else {
        return;
    };

    let mut sub_a = conn.subscribe("test.fanout").await.unwrap();
    let mut sub_b = conn.subscribe("test.fanout").await.unwrap();

    conn.publish("test.fanout", b"broadcast".to_vec())
        .await
        .unwrap();

    let msg_a = tokio::time::timeout(RECV_TIMEOUT, sub_a.next())
        .await
        .expect("sub_a should receive within timeout")
        .expect("sub_a stream should yield");
    let msg_b = tokio::time::timeout(RECV_TIMEOUT, sub_b.next())
        .await
        .expect("sub_b should receive within timeout")
        .expect("sub_b stream should yield");

    assert_eq!(&msg_a.payload[..], b"broadcast");
    assert_eq!(&msg_b.payload[..], b"broadcast");
}

// ---------------------------------------------------------------------------
// 4. Subject isolation: subscriber on "a.b" does NOT receive messages on "a.c"
// ---------------------------------------------------------------------------

#[tokio::test]
async fn test_subject_isolation() {
    let Some((conn, _guard)) = ensure_nats().await else {
        return;
    };

    let mut sub_ab = conn.subscribe("iso.a.b").await.unwrap();

    // Publish to a DIFFERENT subject — sub_ab should NOT see this.
    conn.publish("iso.a.c", b"wrong-subject".to_vec())
        .await
        .unwrap();

    // Publish to the CORRECT subject.
    conn.publish("iso.a.b", b"right-subject".to_vec())
        .await
        .unwrap();

    // sub_ab should only receive the second message.
    let msg = tokio::time::timeout(RECV_TIMEOUT, sub_ab.next())
        .await
        .expect("should receive within timeout")
        .expect("stream should yield");
    assert_eq!(
        &msg.payload[..],
        b"right-subject",
        "subscriber on iso.a.b should not receive messages from iso.a.c"
    );
}

// ---------------------------------------------------------------------------
// 5. EventBus agent message: publish_agent_message → subscriber on
//    ergatai.agent.message.{id} receives it
// ---------------------------------------------------------------------------

#[tokio::test]
async fn test_event_bus_agent_message_roundtrip() {
    let Some((conn, _guard)) = ensure_nats().await else {
        return;
    };

    let bus = EventBus::new(conn.clone());
    let agent_id = "test-agent-5";
    let mut sub = bus.subscribe_agent_message(agent_id).await.unwrap();

    let payload = AgentMessagePayload {
        from_agent: "sender-agent".to_string(),
        to_agent: agent_id.to_string(),
        from_uuid: None,
        to_uuid: None,
        content: "@test-agent-5 please review".to_string(),
        thread_id: Some("thread-1".to_string()),
        timestamp: 1_700_000_000,
        metadata: HashMap::new(),
    };

    bus.publish_agent_message(&payload).await.unwrap();

    let msg = tokio::time::timeout(RECV_TIMEOUT, sub.next())
        .await
        .expect("should receive agent message within timeout")
        .expect("stream should yield");

    let received: AgentMessagePayload =
        serde_json::from_slice(&msg.payload).expect("payload should deserialize");
    assert_eq!(received.from_agent, "sender-agent");
    assert_eq!(received.to_agent, agent_id);
    assert_eq!(received.content, "@test-agent-5 please review");
    assert_eq!(received.thread_id, Some("thread-1".to_string()));
}

// ---------------------------------------------------------------------------
// 6. EventBus DAG events: publish_node_complete → subscriber receives the
//    payload and can wrap it as DagEvent::NodeComplete
// ---------------------------------------------------------------------------

#[tokio::test]
async fn test_event_bus_node_complete_as_dag_event() {
    let Some((conn, _guard)) = ensure_nats().await else {
        return;
    };

    let bus = EventBus::new(conn.clone());
    let mut sub = bus.subscribe_all_node_complete().await.unwrap();

    let mut outputs = serde_json::Map::new();
    outputs.insert(
        "result".to_string(),
        serde_json::Value::String("done".to_string()),
    );

    let payload = NodeCompletePayload {
        node_id: "node-6".to_string(),
        task_id: "task-6".to_string(),
        agent_name: "agent-6".to_string(),
        result_summary: Some("ok".to_string()),
        outputs: serde_json::Value::Object(outputs),
        result_file: None,
    };

    bus.publish_node_complete(&payload).await.unwrap();

    let msg = tokio::time::timeout(RECV_TIMEOUT, sub.next())
        .await
        .expect("should receive node_complete within timeout")
        .expect("stream should yield");

    // Deserialize as NodeCompletePayload first, then wrap in DagEvent to
    // prove the payload is compatible with the DagEvent tagged enum.
    let received: NodeCompletePayload =
        serde_json::from_slice(&msg.payload).expect("payload should deserialize");
    assert_eq!(received.node_id, "node-6");

    let dag_event = DagEvent::NodeComplete(received.clone());
    let json = serde_json::to_string(&dag_event).expect("DagEvent should serialize");
    let roundtrip: DagEvent = serde_json::from_str(&json).expect("DagEvent should roundtrip");
    match roundtrip {
        DagEvent::NodeComplete(p) => assert_eq!(p.node_id, "node-6"),
        other => panic!("expected DagEvent::NodeComplete, got {other:?}"),
    }
}

// ---------------------------------------------------------------------------
// 7. EventBus task submit: publish_task_submit → pull consumer receives
//    TaskSubmitPayload (end-to-end via JetStream pull consumer)
// ---------------------------------------------------------------------------

#[tokio::test]
async fn test_event_bus_task_submit_via_pull_consumer() {
    let Some((conn, _guard)) = ensure_nats().await else {
        return;
    };

    // Create a pull consumer FIRST (mimics TaskScheduler startup).
    let mut messages = ergatai_nats::init_dag_stream_pull_consumer(
        &conn,
        "test_pubsub_task_consumer",
        "ergatai.task.submit.*",
    )
    .await
    .expect("consumer should be created");

    let bus = EventBus::new(conn.clone());
    let payload = TaskSubmitPayload {
        task_id: "task-7".to_string(),
        plan_content: "# Plan\nDo the thing".to_string(),
        plan_file: ".ergatai/.dag-plans/task-7.md".to_string(),
        target_agent: "%agent_7".to_string(),
        priority: 2,
        timeout_secs: Some(300),
        dag_id: Some("dag-7".to_string()),
    };

    let ack = bus
        .publish_task_submit(&payload)
        .await
        .expect("publish should succeed");
    assert!(ack.sequence > 0);

    let msg = tokio::time::timeout(RECV_TIMEOUT, messages.next())
        .await
        .expect("pull consumer should receive within timeout")
        .expect("stream should yield")
        .expect("not a transport error");

    let received: TaskSubmitPayload =
        serde_json::from_slice(&msg.payload).expect("payload should deserialize");
    assert_eq!(received.task_id, "task-7");
    assert_eq!(received.target_agent, "%agent_7");
    assert_eq!(received.priority, 2);
    assert_eq!(received.timeout_secs, Some(300));

    // Ack so WorkQueue retention deletes the message.
    msg.ack().await.ok();
}

// ---------------------------------------------------------------------------
// 8. Malformed message resilience: publish invalid bytes, verify subscriber
//    gets raw bytes without crashing
// ---------------------------------------------------------------------------

#[tokio::test]
async fn test_malformed_message_resilience() {
    let Some((conn, _guard)) = ensure_nats().await else {
        return;
    };

    let mut sub = conn.subscribe("test.malformed").await.unwrap();

    // Publish garbage bytes — core NATS doesn't care about payload shape.
    let garbage: Vec<u8> = vec![0xFF, 0xFE, 0x00, 0x01, 0xAB, 0xCD];
    conn.publish("test.malformed", garbage.clone())
        .await
        .unwrap();

    let msg = tokio::time::timeout(RECV_TIMEOUT, sub.next())
        .await
        .expect("should receive within timeout")
        .expect("stream should yield");

    // Subscriber receives the exact bytes — NATS is payload-agnostic.
    assert_eq!(msg.payload.as_ref(), garbage.as_slice());

    // Deserializing as JSON should fail gracefully — no crash.
    let deser: Result<serde_json::Value, _> = serde_json::from_slice(&msg.payload);
    assert!(
        deser.is_err(),
        "garbage bytes should not deserialize as JSON"
    );
}

// ---------------------------------------------------------------------------
// 9. Large payload: publish a 100KB message, verify subscriber receives it
//    intact
// ---------------------------------------------------------------------------

#[tokio::test]
async fn test_large_payload_roundtrip() {
    let Some((conn, _guard)) = ensure_nats().await else {
        return;
    };

    let mut sub = conn.subscribe("test.large").await.unwrap();

    // 100 KiB payload — comfortably under NATS default max_msg_size (1 MiB)
    // but large enough to catch any truncation bugs.
    let large_payload: Vec<u8> = (0..100_000).map(|i| (i % 256) as u8).collect();
    let expected_len = large_payload.len();

    conn.publish("test.large", large_payload.clone())
        .await
        .unwrap();

    let msg = tokio::time::timeout(RECV_TIMEOUT, sub.next())
        .await
        .expect("should receive within timeout")
        .expect("stream should yield");

    assert_eq!(
        msg.payload.len(),
        expected_len,
        "payload length should be preserved"
    );
    assert_eq!(
        msg.payload.as_ref(),
        large_payload.as_slice(),
        "payload bytes should be identical"
    );
}

// ---------------------------------------------------------------------------
// 10. Stream persistence: publish to JetStream, then create consumer AFTER
//     publish — consumer should still receive the message (DeliverPolicy::All)
// ---------------------------------------------------------------------------

#[tokio::test]
async fn test_stream_persistence_consumer_after_publish() {
    let Some((conn, _guard)) = ensure_nats().await else {
        return;
    };

    // Publish FIRST, before any consumer exists.
    let payload = TaskSubmitPayload {
        task_id: "persisted-task-10".to_string(),
        plan_content: "# Persisted".to_string(),
        plan_file: ".ergatai/.dag-plans/persisted-task-10.md".to_string(),
        target_agent: "%late_consumer_agent".to_string(),
        priority: 1,
        timeout_secs: None,
        dag_id: None,
    };
    let json = serde_json::to_vec(&payload).expect("serialize");
    let ack = conn
        .publish_jetstream("ergatai.task.submit.%late_consumer_agent", json)
        .await
        .expect("JetStream publish should succeed");
    assert!(ack.sequence > 0);

    // NOW create the consumer — DeliverPolicy::All should replay the message.
    let mut messages = ergatai_nats::init_dag_stream_pull_consumer(
        &conn,
        "test_late_consumer",
        "ergatai.task.submit.*",
    )
    .await
    .expect("consumer should be created");

    let msg = tokio::time::timeout(RECV_TIMEOUT, messages.next())
        .await
        .expect("late consumer should receive the pre-published message")
        .expect("stream should yield")
        .expect("not a transport error");

    let received: TaskSubmitPayload =
        serde_json::from_slice(&msg.payload).expect("payload should deserialize");
    assert_eq!(received.task_id, "persisted-task-10");
    assert_eq!(received.target_agent, "%late_consumer_agent");

    msg.ack().await.ok();
}
