//! Integration tests for UnifiedAgentRegistry — the single source of truth
//! for agent state across all Ergatai subsystems.
//!
//! These tests exercise multi-step workflows: register → transition → query → cleanup.

use chrono::Utc;
use ergatai_core::unified_registry::UnifiedAgentRegistry;
use ergatai_runtime::{
    AgentLifecycleState, AgentRecord, RecordAgentHandle as AgentHandle,
    RecordWorkspaceHandle as WorkspaceHandle,
};
use std::collections::HashMap;

fn make_record(agent_id: &str) -> AgentRecord {
    AgentRecord::new(
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
async fn register_lookup_by_all_keys() {
    let reg = UnifiedAgentRegistry::new();
    let mut rec = make_record("agent-1");
    rec.cov_id = Some("cov-1".to_string());
    reg.register(rec).await;

    reg.set_mcp_agent_id("agent-1", "opencode@xyz".to_string())
        .await
        .unwrap();

    let by_agent = reg.get("agent-1").await.unwrap();
    let by_mcp = reg.get_by_mcp_id("opencode@xyz").await.unwrap();
    let by_cov = reg.get_by_cov_id("cov-1").await.unwrap();

    assert_eq!(by_agent.agent_id, "agent-1");
    assert_eq!(by_mcp.agent_id, "agent-1");
    assert_eq!(by_cov.agent_id, "agent-1");
}

// ── Unregister cleans up all indices ─────────────────────────────────

#[tokio::test]
async fn unregister_removes_all_indices() {
    let reg = UnifiedAgentRegistry::new();
    let mut rec = make_record("agent-2");
    rec.cov_id = Some("cov-2".to_string());
    reg.register(rec).await;
    reg.set_mcp_agent_id("agent-2", "mcp@old".to_string())
        .await
        .unwrap();

    assert!(reg.get("agent-2").await.is_some());
    assert!(reg.get_by_mcp_id("mcp@old").await.is_some());
    assert!(reg.get_by_cov_id("cov-2").await.is_some());

    reg.unregister("agent-2").await;

    assert!(reg.get("agent-2").await.is_none());
    assert!(reg.get_by_mcp_id("mcp@old").await.is_none());
    assert!(reg.get_by_cov_id("cov-2").await.is_none());
}

// ── MCP ID re-binding removes old index ──────────────────────────────

#[tokio::test]
async fn mcp_id_rebind_removes_old_binding() {
    let reg = UnifiedAgentRegistry::new();
    reg.register(make_record("agent-3")).await;

    reg.set_mcp_agent_id("agent-3", "mcp@v1".to_string())
        .await
        .unwrap();
    assert!(reg.get_by_mcp_id("mcp@v1").await.is_some());

    reg.set_mcp_agent_id("agent-3", "mcp@v2".to_string())
        .await
        .unwrap();

    assert!(reg.get_by_mcp_id("mcp@v2").await.is_some());
    assert!(reg.get_by_mcp_id("mcp@v1").await.is_none());
}

// ── State transitions ────────────────────────────────────────────────

#[tokio::test]
async fn state_transitions_update_record() {
    let reg = UnifiedAgentRegistry::new();
    reg.register(make_record("agent-4")).await;

    reg.update_state(
        "agent-4",
        AgentLifecycleState::Running {
            task_id: None,
            started_at: Utc::now(),
            last_heartbeat: Utc::now(),
        },
    )
    .await
    .unwrap();

    reg.update_state(
        "agent-4",
        AgentLifecycleState::Idle {
            ready_since: Utc::now(),
            capabilities: vec!["rust".to_string()],
        },
    )
    .await
    .unwrap();

    assert!(reg.get("agent-4").await.unwrap().is_idle());
}

// ── Terminal state makes agent non-alive ─────────────────────────────

#[tokio::test]
async fn terminal_state_makes_agent_non_alive() {
    let reg = UnifiedAgentRegistry::new();
    reg.register(make_record("agent-5")).await;
    assert!(reg.get("agent-5").await.unwrap().is_alive());

    reg.update_state(
        "agent-5",
        AgentLifecycleState::Terminated {
            outcome: ergatai_runtime::ExitOutcome::Exited { exit_code: Some(0) },
            terminated_at: Utc::now(),
            duration_secs: 42,
        },
    )
    .await
    .unwrap();

    let r = reg.get("agent-5").await.unwrap();
    assert!(!r.is_alive());
    assert!(!r.is_idle());
    assert!(!r.is_processing());
}

// ── list_* filtering ─────────────────────────────────────────────────

#[tokio::test]
async fn list_filters_by_state_category() {
    let reg = UnifiedAgentRegistry::new();
    reg.register(make_record("a")).await;
    reg.register(make_record("b")).await;
    reg.register(make_record("c")).await;

    reg.update_state(
        "a",
        AgentLifecycleState::Running {
            task_id: None,
            started_at: Utc::now(),
            last_heartbeat: Utc::now(),
        },
    )
    .await
    .unwrap();
    reg.update_state(
        "b",
        AgentLifecycleState::Idle {
            ready_since: Utc::now(),
            capabilities: vec![],
        },
    )
    .await
    .unwrap();
    reg.update_state(
        "c",
        AgentLifecycleState::Terminated {
            outcome: ergatai_runtime::ExitOutcome::Signaled { signal: 9 },
            terminated_at: Utc::now(),
            duration_secs: 10,
        },
    )
    .await
    .unwrap();

    assert_eq!(reg.list_alive().await.len(), 2);
    assert_eq!(reg.list_idle().await.len(), 1);
    assert_eq!(reg.list_idle().await[0].agent_id, "b");
    assert_eq!(reg.list_processing().await.len(), 0);
}

// ── count_by_state ───────────────────────────────────────────────────

#[tokio::test]
async fn count_by_state_counts_correctly() {
    let reg = UnifiedAgentRegistry::new();
    reg.register(make_record("x")).await;
    reg.register(make_record("y")).await;
    reg.register(make_record("z")).await;

    reg.update_state(
        "y",
        AgentLifecycleState::Idle {
            ready_since: Utc::now(),
            capabilities: vec![],
        },
    )
    .await
    .unwrap();
    reg.update_state(
        "z",
        AgentLifecycleState::Terminated {
            outcome: ergatai_runtime::ExitOutcome::Exited { exit_code: Some(0) },
            terminated_at: Utc::now(),
            duration_secs: 5,
        },
    )
    .await
    .unwrap();

    let c = reg.count_by_state().await;
    assert_eq!(c.total, 3);
    assert_eq!(c.alive, 2);
    assert_eq!(c.terminal, 1);
    assert_eq!(c.idle, 1);
}

// ── Summaries ────────────────────────────────────────────────────────

#[tokio::test]
async fn list_summaries_returns_all() {
    let reg = UnifiedAgentRegistry::new();
    let mut rec = make_record("m1");
    rec.capabilities = vec!["code-review".to_string(), "testing".to_string()];
    reg.register(rec).await;
    reg.register(make_record("m2")).await;

    let summaries = reg.list_summaries().await;
    assert_eq!(summaries.len(), 2);
    let s1 = summaries.iter().find(|s| s.agent_id == "m1").unwrap();
    assert_eq!(s1.workspace_id, "ws-test");
    assert!(s1.is_alive);
    assert_eq!(s1.capabilities.len(), 2);
}

// ── Error cases ──────────────────────────────────────────────────────

#[tokio::test]
async fn update_heartbeat_unknown_agent_returns_error() {
    let reg = UnifiedAgentRegistry::new();
    assert!(reg.update_heartbeat("ghost").await.is_err());
}

// ── Heartbeat ────────────────────────────────────────────────────────

#[tokio::test]
async fn update_heartbeat_refreshes_timestamp() {
    let reg = UnifiedAgentRegistry::new();
    reg.register(make_record("hb1")).await;
    let before = reg.get("hb1").await.unwrap().last_heartbeat;

    tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    reg.update_heartbeat("hb1").await.unwrap();

    let after = reg.get("hb1").await.unwrap().last_heartbeat;
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
            r.register(make_record(&format!("c{i}"))).await;
        }));
    }
    for h in handles {
        h.await.unwrap();
    }

    assert_eq!(reg.list().await.len(), 20);
    for i in 0..20 {
        assert!(reg.get(&format!("c{i}")).await.is_some());
    }
}
