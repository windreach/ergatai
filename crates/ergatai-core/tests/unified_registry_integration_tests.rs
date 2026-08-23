//! Integration tests for UnifiedAgentRegistry — the single source of truth
//! for agent state across all Ergatai subsystems.
//!
//! These tests exercise multi-step workflows: register → transition → query → cleanup.

use chrono::Utc;
use ergatai_core::unified_registry::UnifiedAgentRegistry;
use ergatai_runtime::{
    AgentLifecycleState, AgentRecord, ExitOutcome,
    RecordAgentHandle as AgentHandle, RecordWorkspaceHandle as WorkspaceHandle,
};
use std::collections::HashMap;

fn make_record(uuid: &str, agent_id: &str) -> AgentRecord {
    AgentRecord::new(
        uuid.to_string(),
        agent_id.to_string(),
        "ws-test".to_string(),
        AgentHandle {
            workspace: WorkspaceHandle {
                id: "ws-test".to_string(),
                backend: "test".to_string(),
                metadata: HashMap::new(),
            },
            agent_id: agent_id.to_string(),
            process_id: Some("1234".to_string()),
            metadata: HashMap::new(),
        },
    )
}

// ── Register + multi-index lookup ────────────────────────────────────

#[tokio::test]
async fn register_lookup_by_all_three_keys() {
    let reg = UnifiedAgentRegistry::new();
    let rec = make_record("u1", "%10");
    reg.register(rec).await;

    reg.set_mcp_agent_id("u1", "opencode@xyz".to_string())
        .await
        .unwrap();

    let by_uuid = reg.get_by_uuid("u1").await.unwrap();
    let by_agent = reg.get_by_agent_id("%10").await.unwrap();
    let by_mcp = reg.get_by_mcp_id("opencode@xyz").await.unwrap();

    assert_eq!(by_uuid.agent_uuid, "u1");
    assert_eq!(by_agent.agent_uuid, "u1");
    assert_eq!(by_mcp.agent_uuid, "u1");
}

// ── Unregister cleans up all indices ─────────────────────────────────

#[tokio::test]
async fn unregister_removes_all_indices() {
    let reg = UnifiedAgentRegistry::new();
    let rec = make_record("u2", "%20");
    reg.register(rec).await;
    reg.set_mcp_agent_id("u2", "mcp@old".to_string())
        .await
        .unwrap();

    assert!(reg.get_by_uuid("u2").await.is_some());
    assert!(reg.get_by_agent_id("%20").await.is_some());
    assert!(reg.get_by_mcp_id("mcp@old").await.is_some());

    reg.unregister("u2").await;

    assert!(reg.get_by_uuid("u2").await.is_none());
    assert!(reg.get_by_agent_id("%20").await.is_none());
    assert!(reg.get_by_mcp_id("mcp@old").await.is_none());
}

// ── MCP ID re-binding removes old index ──────────────────────────────

#[tokio::test]
async fn mcp_id_rebind_removes_old_binding() {
    let reg = UnifiedAgentRegistry::new();
    let rec = make_record("u3", "%30");
    reg.register(rec).await;

    reg.set_mcp_agent_id("u3", "mcp@v1".to_string())
        .await
        .unwrap();
    assert!(reg.get_by_mcp_id("mcp@v1").await.is_some());

    reg.set_mcp_agent_id("u3", "mcp@v2".to_string())
        .await
        .unwrap();

    assert!(reg.get_by_mcp_id("mcp@v2").await.is_some());
    assert!(reg.get_by_mcp_id("mcp@v1").await.is_none());
}

// ── State transitions build history ──────────────────────────────────

#[tokio::test]
async fn state_transitions_record_history() {
    let reg = UnifiedAgentRegistry::new();
    reg.register(make_record("u4", "%40")).await;

    reg.transition_state(
        "u4",
        AgentLifecycleState::Running { task_id: None, started_at: Utc::now(), last_heartbeat: Utc::now() },
        Some("started task".to_string()),
        serde_json::json!({"task": "T1"}),
    )
    .await
    .unwrap();

    reg.transition_state(
        "u4",
        AgentLifecycleState::Idle {
            ready_since: Utc::now(),
            capabilities: vec!["rust".to_string()],
        },
        None,
        serde_json::json!({}),
    )
    .await
    .unwrap();

    assert!(reg.get_by_uuid("u4").await.unwrap().is_idle());

    let history = reg.get_state_history("u4").await.unwrap();
    assert!(history.len() >= 2, "got {}", history.len());
}

// ── Terminal state makes agent non-alive ─────────────────────────────

#[tokio::test]
async fn terminal_state_makes_agent_non_alive() {
    let reg = UnifiedAgentRegistry::new();
    reg.register(make_record("u5", "%50")).await;
    assert!(reg.get_by_uuid("u5").await.unwrap().is_alive());

    reg.transition_state(
        "u5",
        AgentLifecycleState::Terminated {
            outcome: ExitOutcome::Exited { exit_code: Some(0) },
            terminated_at: Utc::now(),
            duration_secs: 42,
        },
        None,
        serde_json::json!({}),
    )
    .await
    .unwrap();

    let r = reg.get_by_uuid("u5").await.unwrap();
    assert!(!r.is_alive());
    assert!(!r.is_idle());
    assert!(!r.is_processing());
}

// ── list_* filtering ─────────────────────────────────────────────────

#[tokio::test]
async fn list_filters_by_state_category() {
    let reg = UnifiedAgentRegistry::new();
    reg.register(make_record("a", "%a")).await;
    reg.register(make_record("b", "%b")).await;
    reg.register(make_record("c", "%c")).await;

    reg.transition_state("a", AgentLifecycleState::Running { task_id: None, started_at: Utc::now(), last_heartbeat: Utc::now() }, None, serde_json::json!({})).await.unwrap();
    reg.transition_state("b", AgentLifecycleState::Idle { ready_since: Utc::now(), capabilities: vec![] }, None, serde_json::json!({})).await.unwrap();
    reg.transition_state("c", AgentLifecycleState::Terminated { outcome: ExitOutcome::Signaled { signal: 9 }, terminated_at: Utc::now(), duration_secs: 10 }, None, serde_json::json!({})).await.unwrap();

    assert_eq!(reg.list_alive().await.len(), 2);
    assert_eq!(reg.list_idle().await.len(), 1);
    assert_eq!(reg.list_idle().await[0].agent_uuid, "b");
    assert_eq!(reg.list_processing().await.len(), 0);
}

// ── count_by_state ───────────────────────────────────────────────────

#[tokio::test]
async fn count_by_state_counts_correctly() {
    let reg = UnifiedAgentRegistry::new();
    reg.register(make_record("x", "%x")).await;
    reg.register(make_record("y", "%y")).await;
    reg.register(make_record("z", "%z")).await;

    reg.transition_state("y", AgentLifecycleState::Idle { ready_since: Utc::now(), capabilities: vec![] }, None, serde_json::json!({})).await.unwrap();
    reg.transition_state("z", AgentLifecycleState::Terminated { outcome: ExitOutcome::Exited { exit_code: Some(0) }, terminated_at: Utc::now(), duration_secs: 5 }, None, serde_json::json!({})).await.unwrap();

    let c = reg.count_by_state().await;
    assert_eq!(c.total, 3);
    assert_eq!(c.alive, 2);
    assert_eq!(c.terminal, 1);
    assert_eq!(c.idle, 1);
}

// ── Summaries ────────────────────────────────────────────────────────

#[tokio::test]
async fn get_summary_returns_correct_fields() {
    let reg = UnifiedAgentRegistry::new();
    let mut rec = make_record("s1", "%s1");
    rec.capabilities = vec!["code-review".to_string(), "testing".to_string()];
    reg.register(rec).await;

    let summary = reg.get_summary("s1").await.unwrap();
    assert_eq!(summary.agent_uuid, "s1");
    assert_eq!(summary.agent_id, "%s1");
    assert_eq!(summary.workspace_id, "ws-test");
    assert!(summary.is_alive);
    assert_eq!(summary.capabilities.len(), 2);
}

#[tokio::test]
async fn list_summaries_returns_all() {
    let reg = UnifiedAgentRegistry::new();
    reg.register(make_record("m1", "%m1")).await;
    reg.register(make_record("m2", "%m2")).await;
    assert_eq!(reg.list_summaries().await.len(), 2);
}

// ── Error cases ──────────────────────────────────────────────────────

#[tokio::test]
async fn transition_nonexistent_agent_returns_error() {
    let reg = UnifiedAgentRegistry::new();
    let err = reg.transition_state("ghost", AgentLifecycleState::Idle { ready_since: Utc::now(), capabilities: vec![] }, None, serde_json::json!({})).await.unwrap_err();
    assert!(err.contains("not found"));
}

#[tokio::test]
async fn update_heartbeat_unknown_agent_returns_error() {
    let reg = UnifiedAgentRegistry::new();
    assert!(reg.update_heartbeat("ghost").await.is_err());
}

// ── Heartbeat ────────────────────────────────────────────────────────

#[tokio::test]
async fn update_heartbeat_refreshes_timestamp() {
    let reg = UnifiedAgentRegistry::new();
    reg.register(make_record("hb1", "%hb1")).await;
    let before = reg.get_by_uuid("hb1").await.unwrap().last_heartbeat;

    tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    reg.update_heartbeat("hb1").await.unwrap();

    let after = reg.get_by_uuid("hb1").await.unwrap().last_heartbeat;
    assert!(after > before);
}

// ── Concurrent registration ──────────────────────────────────────────

#[tokio::test]
async fn concurrent_registration_is_consistent() {
    let reg = UnifiedAgentRegistry::new();
    let mut handles = Vec::new();
    for i in 0..20 {
        let r = reg.clone();
        handles.push(tokio::spawn(async move {
            r.register(make_record(&format!("c{i}"), &format!("%c{i}"))).await;
        }));
    }
    for h in handles { h.await.unwrap(); }

    assert_eq!(reg.list_all().await.len(), 20);
    for i in 0..20 {
        assert!(reg.get_by_uuid(&format!("c{i}")).await.is_some());
    }
}
