//! Integration tests for agent suspend/resume functionality.
//!
//! These tests verify the core suspend/resume mechanism including:
//! - SuspendStore persistence (save, load, find, remove)
//! - SuspendReason serialization
//! - AgentLifecycleState transitions for suspend/resume

use chrono::Utc;
use ergatai_runtime::{
    agent_lifecycle::AgentLifecycleState,
    suspend_store::{SuspendReason, SuspendStore, SuspendedAgentRecord},
};
use tempfile::NamedTempFile;

/// Create a temporary SuspendStore for testing.
/// Each test gets its own isolated database.
fn temp_store() -> SuspendStore {
    let tmp = NamedTempFile::new().unwrap();
    let path = tmp.path().to_path_buf();
    // Drop the tempfile so SuspendStore can create a fresh one
    drop(tmp);
    SuspendStore::open(&path).unwrap()
}

/// Create a sample SuspendedAgentRecord for testing.
fn sample_record(id: &str) -> SuspendedAgentRecord {
    SuspendedAgentRecord {
        id: id.to_string(),
        workspace_id: "ws1".to_string(),
        conversation_id: "conv-123".to_string(),
        profile_name: "claude-code".to_string(),
        work_dir: "/workspace".to_string(),
        environment: "{}".to_string(),
        suspended_at: Utc::now(),
        last_activity: Utc::now(),
        reason: SuspendReason::Manual,
        metadata: None,
    }
}

#[test]
fn test_suspend_store_save_and_load() {
    let store = temp_store();
    let record = sample_record("agent-1");
    store.save_suspended(&record).unwrap();

    let loaded = store.load_suspended("agent-1").unwrap();
    assert!(loaded.is_some());
    let loaded = loaded.unwrap();
    assert_eq!(loaded.id, "agent-1");
    assert_eq!(loaded.workspace_id, "ws1");
    assert_eq!(loaded.conversation_id, "conv-123");
    assert_eq!(loaded.profile_name, "claude-code");
    assert_eq!(loaded.work_dir, "/workspace");
    assert_eq!(loaded.environment, "{}");
    assert_eq!(loaded.reason, SuspendReason::Manual);
    assert!(loaded.metadata.is_none());
}

#[test]
fn test_suspend_store_find_by_conversation() {
    let store = temp_store();
    let record = sample_record("agent-2");
    store.save_suspended(&record).unwrap();

    let found = store.find_by_conversation("conv-123").unwrap();
    assert!(found.is_some());
    assert_eq!(found.unwrap().id, "agent-2");

    // Non-existent conversation should return None
    let not_found = store.find_by_conversation("non-existent").unwrap();
    assert!(not_found.is_none());
}

#[test]
fn test_suspend_store_remove() {
    let store = temp_store();
    let record = sample_record("agent-3");
    store.save_suspended(&record).unwrap();

    // Verify it exists
    assert!(store.load_suspended("agent-3").unwrap().is_some());

    // Remove it
    store.remove_suspended("agent-3").unwrap();

    // Verify it's gone
    let loaded = store.load_suspended("agent-3").unwrap();
    assert!(loaded.is_none());

    // Removing a non-existent record should not error
    store.remove_suspended("non-existent").unwrap();
}

#[test]
fn test_suspend_reason_serialization() {
    let reasons = vec![
        SuspendReason::Manual,
        SuspendReason::Idle,
        SuspendReason::Shutdown,
    ];

    for reason in reasons {
        let json = serde_json::to_string(&reason).unwrap();
        let deserialized: SuspendReason = serde_json::from_str(&json).unwrap();
        assert_eq!(reason, deserialized);
    }
}

#[test]
fn test_lifecycle_state_transitions() {
    use AgentLifecycleState::*;
    let now = Utc::now();

    // Running -> Suspended (valid)
    let running = Running {
        task_id: None,
        started_at: now,
        last_heartbeat: now,
    };
    let suspended = Suspended { suspended_at: now };
    assert!(running.can_transition_to(&suspended));

    // Suspended -> Running (valid - resume)
    let suspended = Suspended { suspended_at: now };
    let running = Running {
        task_id: None,
        started_at: now,
        last_heartbeat: now,
    };
    assert!(suspended.can_transition_to(&running));

    // Suspended -> Starting (invalid)
    let suspended = Suspended { suspended_at: now };
    let starting = Starting {
        workspace_id: "ws1".to_string(),
        command: "test".to_string(),
        started_at: now,
    };
    assert!(!suspended.can_transition_to(&starting));
}

#[test]
fn test_suspend_store_list_suspended() {
    let store = temp_store();

    // Initially empty
    let list = store.list_suspended().unwrap();
    assert!(list.is_empty());

    // Add multiple records
    let record1 = sample_record("agent-a");
    let record2 = sample_record("agent-b");
    store.save_suspended(&record1).unwrap();
    store.save_suspended(&record2).unwrap();

    // List should contain both
    let list = store.list_suspended().unwrap();
    assert_eq!(list.len(), 2);

    let mut ids: Vec<&str> = list.iter().map(|r| r.id.as_str()).collect();
    ids.sort();
    assert_eq!(ids, vec!["agent-a", "agent-b"]);
}

#[test]
fn test_suspend_store_upsert() {
    let store = temp_store();

    // Save initial record
    let mut record = sample_record("agent-upsert");
    store.save_suspended(&record).unwrap();

    let loaded = store.load_suspended("agent-upsert").unwrap().unwrap();
    assert_eq!(loaded.conversation_id, "conv-123");

    // Update the record (same ID, different data)
    record.conversation_id = "conv-456".to_string();
    record.reason = SuspendReason::Idle;
    store.save_suspended(&record).unwrap();

    // Load should return updated data
    let loaded = store.load_suspended("agent-upsert").unwrap().unwrap();
    assert_eq!(loaded.conversation_id, "conv-456");
    assert_eq!(loaded.reason, SuspendReason::Idle);
}

#[test]
fn test_lifecycle_suspended_state_properties() {
    let now = Utc::now();
    let suspended = AgentLifecycleState::Suspended { suspended_at: now };

    // Suspended is not a terminal state
    assert!(!suspended.is_terminal());

    // Suspended is considered "alive" (can be resumed)
    assert!(suspended.is_alive());

    // State name should be "suspended"
    assert_eq!(suspended.state_name(), "suspended");

    // No task ID when suspended
    assert!(suspended.task_id().is_none());

    // No heartbeat when suspended
    assert!(suspended.last_heartbeat().is_none());
}
