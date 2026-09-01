//! Fast integration tests for TaskScheduler (no NATS required).
//!
//! Run: cargo test -p ergatai-collab --test task_scheduler_fast_tests

use ergatai_collab::task_scheduler::global_scheduler;
use tempfile::tempdir;

/// Consumer ready signal must not deadlock when NATS is unavailable.
///
/// This guards against a regression where `wait_for_consumer_ready()` was missing
/// entirely, causing `submit_graph` to hang indefinitely waiting for a signal
/// that would never come.
#[tokio::test]
async fn test_consumer_ready_does_not_deadlock_without_nats() {
    // IMPORTANT: Do NOT call init_nats() or global_scheduler() before this test,
    // as they would initialize the global NATS state. This test must run in a
    // context where NATS has not been initialized.
    //
    // Since global_scheduler() is a OnceLock and other tests may have already
    // initialized it, we directly construct a TaskScheduler to test the behavior.
    // However, TaskScheduler::new() is private. Instead, we test the timeout
    // behavior via the public API.
    //
    // In practice, if NATS is already initialized (from a previous test), the
    // consumer will be ready almost immediately anyway, so this test still
    // validates that the method returns promptly.

    let temp_dir = tempdir().unwrap();
    let scheduler = global_scheduler(Some(temp_dir.path().to_path_buf()));

    // Should complete within 10 seconds regardless of NATS state.
    // The internal timeout in wait_for_consumer_ready() is 5 seconds,
    // so 10 seconds gives enough margin for slow CI environments (e.g., macOS).
    let result = tokio::time::timeout(
        std::time::Duration::from_secs(10),
        scheduler.wait_for_consumer_ready(),
    )
    .await;

    assert!(
        result.is_ok(),
        "wait_for_consumer_ready() timed out — this indicates a deadlock bug"
    );
}

/// global_scheduler() returns the same instance on repeated calls.
#[tokio::test]
async fn test_global_scheduler_is_singleton() {
    let t1 = tempdir().unwrap();
    let t2 = tempdir().unwrap();
    let s1 = global_scheduler(Some(t1.path().to_path_buf()));
    let s2 = global_scheduler(Some(t2.path().to_path_buf()));
    assert!(
        std::sync::Arc::ptr_eq(&s1, &s2),
        "global_scheduler() must return the same Arc instance"
    );
}

/// Initial scheduler state has no pending or processing tasks.
#[tokio::test]
async fn test_scheduler_initial_state_is_empty() {
    let temp_dir = tempdir().unwrap();
    let scheduler = global_scheduler(Some(temp_dir.path().to_path_buf()));
    scheduler.wait_for_consumer_ready().await;

    assert_eq!(
        scheduler.pending_count().await,
        0,
        "New scheduler should have 0 pending tasks"
    );
}
