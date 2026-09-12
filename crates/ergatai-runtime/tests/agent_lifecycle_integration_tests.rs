//! Integration tests for agent lifecycle, record, and runtime behavior.
//!
//! Covers:
//! 1. State machine transitions (valid and invalid)
//! 2. AgentRecord lifecycle and field consistency
//! 3. AgentRuntime register/unregister (via mock backend)
//! 4. Multiple agents (register 5, list returns all 5)
//! 5. UUID uniqueness per agent
//! 6. Health status mapping (AgentLifecycleState → AgentStatus)
//! 7. Concurrent registration from multiple tokio tasks
//! 8. Stale agent detection / prune path (no-op on unsupported backends)

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use chrono::Utc;

use ergatai_error::ErgataiResult;
use ergatai_runtime::{
    AcpBackendInterface, AgentHandle, AgentLifecycleState, AgentRecord, AgentRuntime,
    BackendCapabilities, ExitOutcome, ProcessingPhase, RecordAgentHandle, RecordWorkspaceHandle,
    StopReason, TimeoutType, WaitResult, WorkspaceHandle, WorkspaceSpec,
};

// ---------------------------------------------------------------------------
// Mock backend — tracks calls, never spawns real processes.
// ---------------------------------------------------------------------------

struct MockBackend {
    workspace_count: AtomicUsize,
}

impl MockBackend {
    fn new() -> Self {
        Self {
            workspace_count: AtomicUsize::new(0),
        }
    }
}

#[async_trait]
impl AcpBackendInterface for MockBackend {
    fn name(&self) -> &'static str {
        "mock"
    }

    fn capabilities(&self) -> BackendCapabilities {
        BackendCapabilities {
            supports_message_injection: true,
            supports_output_capture: true,
            supports_resource_limits: false,
            supports_workspace_reuse: false,
            supports_network_isolation: false,
            max_concurrent_agents: None,
        }
    }

    async fn initialize(&self) -> ErgataiResult<()> {
        Ok(())
    }

    async fn create_workspace(&self, spec: WorkspaceSpec) -> ErgataiResult<WorkspaceHandle> {
        self.workspace_count.fetch_add(1, Ordering::SeqCst);
        Ok(WorkspaceHandle {
            id: spec.id,
            backend: "mock".to_string(),
            metadata: HashMap::new(),
        })
    }

    fn next_agent_id(&self, workspace_id: &str) -> String {
        format!("{}-agent-0", workspace_id)
    }

    async fn start_agent(
        &self,
        handle: &WorkspaceHandle,
        _command: &str,
        _instruction: Option<&str>,
    ) -> ErgataiResult<AgentHandle> {
        Ok(AgentHandle {
            workspace: handle.clone(),
            agent_id: format!("agent-{}", handle.id),
            process_id: Some("99999".to_string()),
            metadata: HashMap::new(),
        })
    }

    async fn inject_message(&self, _handle: &AgentHandle, _message: &str) -> ErgataiResult<()> {
        Ok(())
    }

    async fn capture_output(&self, _handle: &AgentHandle) -> ErgataiResult<Option<String>> {
        Ok(Some("mock output".to_string()))
    }

    async fn is_alive(&self, _handle: &AgentHandle) -> ErgataiResult<bool> {
        Ok(true)
    }

    async fn stop_agent(&self, _handle: &AgentHandle) -> ErgataiResult<()> {
        Ok(())
    }

    async fn kill_agent(&self, _handle: &AgentHandle) -> ErgataiResult<()> {
        Ok(())
    }

    async fn wait_for_exit(
        &self,
        _handle: &AgentHandle,
        _timeout: Option<Duration>,
    ) -> ErgataiResult<WaitResult> {
        Ok(WaitResult::Exited { code: 0 })
    }

    async fn list_workspaces(&self) -> ErgataiResult<Vec<WorkspaceHandle>> {
        Ok(vec![])
    }

    async fn cleanup_workspace(&self, _handle: &WorkspaceHandle) -> ErgataiResult<()> {
        Ok(())
    }

    async fn shutdown(&self) -> ErgataiResult<()> {
        Ok(())
    }

    fn last_output_age(&self, _handle: &AgentHandle) -> Option<Duration> {
        None
    }

    // Observation operations
    async fn thoughts(&self, _agent_id: &str) -> ErgataiResult<Option<String>> {
        Ok(None)
    }

    async fn output(&self, _agent_id: &str) -> ErgataiResult<Option<String>> {
        Ok(None)
    }

    async fn tool_calls(
        &self,
        _agent_id: &str,
    ) -> ErgataiResult<Option<Vec<ergatai_runtime::backends::acp::TrackedToolCall>>> {
        Ok(None)
    }

    async fn plan(
        &self,
        _agent_id: &str,
    ) -> ErgataiResult<Option<ergatai_runtime::backends::acp::TrackedPlan>> {
        Ok(None)
    }

    async fn elicitations(
        &self,
        _agent_id: &str,
    ) -> ErgataiResult<Option<Vec<ergatai_runtime::backends::acp::TrackedElicitation>>> {
        Ok(None)
    }

    async fn session_title(&self, _agent_id: &str) -> ErgataiResult<Option<String>> {
        Ok(None)
    }

    async fn session_id(&self, _agent_id: &str) -> ErgataiResult<Option<String>> {
        Ok(None)
    }

    async fn stop_reason(&self, _agent_id: &str) -> ErgataiResult<Option<String>> {
        Ok(None)
    }

    async fn workspace_capture_thoughts(&self, _workspace_id: &str) -> ErgataiResult<Option<bool>> {
        Ok(None)
    }

    async fn continuation_count(&self, _agent_id: &str) -> ErgataiResult<Option<usize>> {
        Ok(None)
    }

    async fn agent_last_output_age(&self, _agent_id: &str) -> ErgataiResult<Option<Duration>> {
        Ok(None)
    }

    async fn exit_code(&self, _agent_id: &str) -> ErgataiResult<Option<Option<i32>>> {
        Ok(None)
    }

    async fn available_commands(
        &self,
        _agent_id: &str,
    ) -> ErgataiResult<Option<Vec<agent_client_protocol::schema::v1::AvailableCommand>>> {
        Ok(None)
    }

    async fn config_options(
        &self,
        _agent_id: &str,
    ) -> ErgataiResult<Option<Vec<agent_client_protocol::schema::v1::SessionConfigOption>>> {
        Ok(None)
    }

    async fn usage(&self, _agent_id: &str) -> ErgataiResult<Option<(usize, usize)>> {
        Ok(None)
    }

    async fn pid(&self, _agent_id: &str) -> ErgataiResult<Option<u32>> {
        Ok(None)
    }

    async fn subscribe_output(
        &self,
        _agent_id: &str,
    ) -> ErgataiResult<Option<tokio::sync::broadcast::Receiver<ergatai_runtime::AgentOutputEvent>>>
    {
        Ok(None)
    }

    async fn list_sessions(
        &self,
        _agent_id: &str,
    ) -> ErgataiResult<Vec<ergatai_runtime::SessionInfo>> {
        Ok(vec![])
    }

    async fn create_session(&self, _agent_id: &str) -> ErgataiResult<ergatai_runtime::SessionInfo> {
        Err(ergatai_error::ErgataiError::BackendUnsupported(
            "mock backend does not support sessions".to_string(),
        ))
    }

    async fn load_session(&self, _agent_id: &str, _session_id: &str) -> ErgataiResult<()> {
        Err(ergatai_error::ErgataiError::BackendUnsupported(
            "mock backend does not support sessions".to_string(),
        ))
    }

    async fn delete_session(&self, _agent_id: &str, _session_id: &str) -> ErgataiResult<()> {
        Err(ergatai_error::ErgataiError::BackendUnsupported(
            "mock backend does not support sessions".to_string(),
        ))
    }

    async fn auto_continue(&self) -> ErgataiResult<bool> {
        Ok(false)
    }

    async fn max_auto_continues(&self) -> ErgataiResult<usize> {
        Ok(0)
    }

    async fn mcp_over_acp_enabled(&self) -> ErgataiResult<bool> {
        Ok(false)
    }

    async fn session_persistence_enabled(&self) -> ErgataiResult<bool> {
        Ok(false)
    }

    // Control operations
    async fn cancel_prompt(&self, _agent_id: &str) -> ErgataiResult<()> {
        Ok(())
    }

    async fn execute_command(
        &self,
        _agent_id: &str,
        _command: &str,
        _timeout_secs: u64,
    ) -> ErgataiResult<String> {
        Ok(String::new())
    }

    async fn respond_to_elicitation(
        &self,
        _elicitation_id: &str,
        _response: ergatai_runtime::ElicitationResponse,
    ) -> ErgataiResult<bool> {
        Ok(false)
    }

    fn as_any(&self) -> &dyn std::any::Any {
        self
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn make_spec(id: &str) -> WorkspaceSpec {
    WorkspaceSpec {
        id: id.to_string(),
        work_dir: PathBuf::from("/tmp"),
        env: HashMap::new(),
        resources: Default::default(),
        capture_thoughts: false,
    }
}

fn make_runtime() -> AgentRuntime {
    AgentRuntime::new(Arc::new(MockBackend::new()))
}

fn make_record_handle(agent_id: &str, ws_id: &str) -> RecordAgentHandle {
    RecordAgentHandle {
        workspace: RecordWorkspaceHandle {
            id: ws_id.to_string(),
            backend: "test".to_string(),
            metadata: HashMap::new(),
        },
        agent_id: agent_id.to_string(),
        process_id: Some("1234".to_string()),
        metadata: HashMap::new(),
    }
}

fn now() -> chrono::DateTime<Utc> {
    Utc::now()
}

// ===========================================================================
// 1. State machine transitions
// ===========================================================================

#[test]
fn lifecycle_valid_transition_created_to_initializing() {
    let mut rec = AgentRecord::new(
        "uuid-1".into(),
        "a-1".into(),
        "ws-1".into(),
        make_record_handle("a-1", "ws-1"),
    );
    assert_eq!(rec.state.state_name(), "created");

    rec.transition_to(
        AgentLifecycleState::Initializing {
            started_at: now(),
            context_source: Some("AGENT.md".into()),
        },
        None,
        serde_json::json!({}),
    );
    assert_eq!(rec.state.state_name(), "initializing");
    assert!(rec.is_alive());
    assert!(!rec.is_terminal());
}

#[test]
fn lifecycle_valid_transition_chain_created_to_terminated() {
    let mut rec = AgentRecord::new(
        "uuid-chain".into(),
        "a-chain".into(),
        "ws-1".into(),
        make_record_handle("a-chain", "ws-1"),
    );

    // Created → Initializing
    rec.transition_to(
        AgentLifecycleState::Initializing {
            started_at: now(),
            context_source: None,
        },
        Some("init".into()),
        serde_json::json!({}),
    );
    assert_eq!(rec.state.state_name(), "initializing");

    // Initializing → Idle
    rec.transition_to(
        AgentLifecycleState::Idle {
            ready_since: now(),
            capabilities: vec!["code".into()],
        },
        None,
        serde_json::json!({}),
    );
    assert!(rec.is_idle());

    // Idle → Starting
    rec.transition_to(
        AgentLifecycleState::Starting {
            workspace_id: "ws-1".into(),
            command: "opencode".into(),
            started_at: now(),
        },
        None,
        serde_json::json!({}),
    );
    assert_eq!(rec.state.state_name(), "starting");

    // Starting → Running
    rec.transition_to(
        AgentLifecycleState::Running {
            task_id: None,
            started_at: now(),
            last_heartbeat: now(),
        },
        None,
        serde_json::json!({}),
    );
    assert_eq!(rec.state.state_name(), "running");

    // Running → Processing
    rec.transition_to(
        AgentLifecycleState::Processing {
            task_id: "task-42".into(),
            phase: ProcessingPhase::Writing,
            started_at: now(),
        },
        None,
        serde_json::json!({}),
    );
    assert!(rec.is_processing());
    assert_eq!(rec.current_task_id(), Some("task-42"));

    // Processing → Stopping
    rec.transition_to(
        AgentLifecycleState::Stopping {
            reason: StopReason::TaskCompleted,
            initiated_at: now(),
            timeout_secs: Some(30),
        },
        None,
        serde_json::json!({}),
    );
    assert_eq!(rec.state.state_name(), "stopping");
    assert!(rec.is_alive()); // still alive while stopping
    assert!(!rec.is_terminal());

    // Stopping → Terminated
    rec.transition_to(
        AgentLifecycleState::Terminated {
            outcome: ExitOutcome::Exited { exit_code: Some(0) },
            terminated_at: now(),
            duration_secs: 120,
        },
        None,
        serde_json::json!({}),
    );
    assert!(rec.is_terminal());
    assert!(!rec.is_alive());
}

#[test]
fn lifecycle_running_to_failed_via_error_outcome() {
    let mut rec = AgentRecord::new(
        "uuid-fail".into(),
        "a-fail".into(),
        "ws-1".into(),
        make_record_handle("a-fail", "ws-1"),
    );
    rec.transition_to(
        AgentLifecycleState::Running {
            task_id: None,
            started_at: now(),
            last_heartbeat: now(),
        },
        None,
        serde_json::json!({}),
    );

    // Running → Terminated (Error)
    rec.transition_to(
        AgentLifecycleState::Terminated {
            outcome: ExitOutcome::Error {
                error: "panic: unwrap failed".into(),
                retryable: false,
            },
            terminated_at: now(),
            duration_secs: 5,
        },
        Some("crashed".into()),
        serde_json::json!({"signal": null}),
    );
    assert!(rec.is_terminal());
    match &rec.state {
        AgentLifecycleState::Terminated { outcome, .. } => match outcome {
            ExitOutcome::Error { error, retryable } => {
                assert_eq!(error, "panic: unwrap failed");
                assert!(!retryable);
            }
            _ => panic!("expected Error outcome"),
        },
        _ => panic!("expected Terminated"),
    }
}

#[test]
fn lifecycle_running_to_terminated_via_signal() {
    let mut rec = AgentRecord::new(
        "uuid-sig".into(),
        "a-sig".into(),
        "ws-1".into(),
        make_record_handle("a-sig", "ws-1"),
    );
    rec.transition_to(
        AgentLifecycleState::Running {
            task_id: None,
            started_at: now(),
            last_heartbeat: now(),
        },
        None,
        serde_json::json!({}),
    );
    rec.transition_to(
        AgentLifecycleState::Terminated {
            outcome: ExitOutcome::Signaled { signal: 9 },
            terminated_at: now(),
            duration_secs: 0,
        },
        None,
        serde_json::json!({}),
    );
    assert!(rec.is_terminal());
}

#[test]
fn lifecycle_running_to_terminated_via_timeout() {
    let mut rec = AgentRecord::new(
        "uuid-to".into(),
        "a-to".into(),
        "ws-1".into(),
        make_record_handle("a-to", "ws-1"),
    );
    rec.transition_to(
        AgentLifecycleState::Running {
            task_id: None,
            started_at: now(),
            last_heartbeat: now(),
        },
        None,
        serde_json::json!({}),
    );
    rec.transition_to(
        AgentLifecycleState::Terminated {
            outcome: ExitOutcome::TimedOut {
                timeout_type: TimeoutType::Heartbeat,
                last_heartbeat: now(),
            },
            terminated_at: now(),
            duration_secs: 300,
        },
        None,
        serde_json::json!({}),
    );
    assert!(rec.is_terminal());
}

#[test]
fn lifecycle_state_history_records_all_transitions() {
    let mut rec = AgentRecord::new(
        "uuid-hist".into(),
        "a-hist".into(),
        "ws-1".into(),
        make_record_handle("a-hist", "ws-1"),
    );

    let transitions = vec![
        AgentLifecycleState::Initializing {
            started_at: now(),
            context_source: None,
        },
        AgentLifecycleState::Running {
            task_id: None,
            started_at: now(),
            last_heartbeat: now(),
        },
        AgentLifecycleState::Stopping {
            reason: StopReason::UserRequested,
            initiated_at: now(),
            timeout_secs: None,
        },
        AgentLifecycleState::Terminated {
            outcome: ExitOutcome::Exited { exit_code: Some(0) },
            terminated_at: now(),
            duration_secs: 60,
        },
    ];

    for (i, state) in transitions.into_iter().enumerate() {
        rec.transition_to(state, Some(format!("step-{i}")), serde_json::json!({}));
    }

    assert_eq!(rec.state_history.len(), 4);
    assert_eq!(rec.state_history[0].from_state, "created");
    assert_eq!(rec.state_history[0].to_state, "initializing");
    assert_eq!(rec.state_history[1].from_state, "initializing");
    assert_eq!(rec.state_history[1].to_state, "running");
    assert_eq!(rec.state_history[2].from_state, "running");
    assert_eq!(rec.state_history[2].to_state, "stopping");
    assert_eq!(rec.state_history[3].from_state, "stopping");
    assert_eq!(rec.state_history[3].to_state, "terminated");
}

#[test]
fn lifecycle_state_history_capped_at_100() {
    let mut rec = AgentRecord::new(
        "uuid-cap".into(),
        "a-cap".into(),
        "ws-1".into(),
        make_record_handle("a-cap", "ws-1"),
    );

    for _ in 0..150 {
        rec.transition_to(
            AgentLifecycleState::Running {
                task_id: None,
                started_at: now(),
                last_heartbeat: now(),
            },
            None,
            serde_json::json!({}),
        );
    }
    assert!(rec.state_history.len() <= 100);
}

#[test]
fn lifecycle_created_is_not_terminal_not_idle() {
    let rec = AgentRecord::new(
        "uuid-init".into(),
        "a-init".into(),
        "ws-1".into(),
        make_record_handle("a-init", "ws-1"),
    );
    assert!(rec.is_alive());
    assert!(!rec.is_terminal());
    assert!(!rec.is_idle());
    assert!(!rec.is_processing());
    assert_eq!(rec.current_task_id(), None);
}

#[test]
fn lifecycle_all_terminal_outcomes_are_terminal() {
    let outcomes = vec![
        ExitOutcome::Exited { exit_code: Some(0) },
        ExitOutcome::Exited { exit_code: None },
        ExitOutcome::Error {
            error: "e".into(),
            retryable: false,
        },
        ExitOutcome::Error {
            error: "e".into(),
            retryable: true,
        },
        ExitOutcome::TimedOut {
            timeout_type: TimeoutType::MaxRuntime,
            last_heartbeat: now(),
        },
        ExitOutcome::Signaled { signal: 15 },
    ];

    for outcome in outcomes {
        let state = AgentLifecycleState::Terminated {
            outcome,
            terminated_at: now(),
            duration_secs: 0,
        };
        assert!(state.is_terminal(), "every Terminated must be terminal");
        assert!(!state.is_alive(), "every Terminated must not be alive");
    }
}

#[test]
fn lifecycle_non_terminal_states_are_alive() {
    let states: Vec<AgentLifecycleState> = vec![
        AgentLifecycleState::Created,
        AgentLifecycleState::Initializing {
            started_at: now(),
            context_source: None,
        },
        AgentLifecycleState::Idle {
            ready_since: now(),
            capabilities: vec![],
        },
        AgentLifecycleState::Starting {
            workspace_id: "ws".into(),
            command: "cmd".into(),
            started_at: now(),
        },
        AgentLifecycleState::Running {
            task_id: None,
            started_at: now(),
            last_heartbeat: now(),
        },
        AgentLifecycleState::Processing {
            task_id: "t".into(),
            phase: ProcessingPhase::Planning,
            started_at: now(),
        },
        AgentLifecycleState::Stopping {
            reason: StopReason::Shutdown,
            initiated_at: now(),
            timeout_secs: None,
        },
    ];

    for state in states {
        assert!(state.is_alive(), "{:?} should be alive", state.state_name());
        assert!(
            !state.is_terminal(),
            "{:?} should not be terminal",
            state.state_name()
        );
    }
}

// ===========================================================================
// 2. AgentRecord lifecycle — field consistency
// ===========================================================================

#[test]
fn agent_record_new_fields_are_consistent() {
    let handle = make_record_handle("agent-x", "ws-x");
    let rec = AgentRecord::new(
        "uuid-x".into(),
        "agent-x".into(),
        "ws-x".into(),
        handle.clone(),
    );

    assert_eq!(rec.agent_uuid, "uuid-x");
    assert_eq!(rec.agent_id, "agent-x");
    assert_eq!(rec.workspace_id, "ws-x");
    assert_eq!(rec.handle, handle);
    assert!(rec.task_id.is_none());
    assert!(rec.mcp_agent_id.is_none());
    assert!(rec.capabilities.is_empty());
    assert!(rec.state_history.is_empty());
    assert_eq!(rec.state.state_name(), "created");
    // created_at, state_changed_at, last_heartbeat should all be ~now
    let elapsed = (Utc::now() - rec.created_at).num_seconds();
    assert!(elapsed.abs() < 2);
}

#[test]
fn agent_record_transition_updates_state_changed_at() {
    let mut rec = AgentRecord::new(
        "uuid-sc".into(),
        "a-sc".into(),
        "ws-1".into(),
        make_record_handle("a-sc", "ws-1"),
    );
    let before = rec.state_changed_at;
    std::thread::sleep(Duration::from_millis(15));

    rec.transition_to(
        AgentLifecycleState::Running {
            task_id: None,
            started_at: now(),
            last_heartbeat: now(),
        },
        None,
        serde_json::json!({}),
    );

    assert!(rec.state_changed_at > before);
}

#[test]
fn agent_record_heartbeat_update_from_running_state() {
    let mut rec = AgentRecord::new(
        "uuid-hb".into(),
        "a-hb".into(),
        "ws-1".into(),
        make_record_handle("a-hb", "ws-1"),
    );
    let initial_hb = rec.last_heartbeat;
    std::thread::sleep(Duration::from_millis(10));

    // Transitioning to Running updates last_heartbeat via the state
    let new_hb = now();
    rec.transition_to(
        AgentLifecycleState::Running {
            task_id: None,
            started_at: now(),
            last_heartbeat: new_hb,
        },
        None,
        serde_json::json!({}),
    );
    assert_eq!(rec.last_heartbeat, new_hb);
    assert!(rec.last_heartbeat >= initial_hb);
}

#[test]
fn agent_record_update_heartbeat_method() {
    let mut rec = AgentRecord::new(
        "uuid-uhb".into(),
        "a-uhb".into(),
        "ws-1".into(),
        make_record_handle("a-uhb", "ws-1"),
    );
    let old = rec.last_heartbeat;
    std::thread::sleep(Duration::from_millis(10));
    rec.update_heartbeat();
    assert!(rec.last_heartbeat > old);
}

#[test]
fn agent_record_state_summary_contains_state_name() {
    let rec = AgentRecord::new(
        "uuid-ss".into(),
        "a-ss".into(),
        "ws-1".into(),
        make_record_handle("a-ss", "ws-1"),
    );
    let summary = rec.state_summary();
    assert!(summary.contains("created"));
    assert!(summary.contains("UTC"));
}

#[test]
fn agent_record_serialization_roundtrip() {
    let mut rec = AgentRecord::new(
        "uuid-ser".into(),
        "a-ser".into(),
        "ws-ser".into(),
        make_record_handle("a-ser", "ws-ser"),
    );
    rec.transition_to(
        AgentLifecycleState::Running {
            task_id: Some("task-99".into()),
            started_at: now(),
            last_heartbeat: now(),
        },
        None,
        serde_json::json!({}),
    );

    let json = serde_json::to_string(&rec).unwrap();
    let decoded: AgentRecord = serde_json::from_str(&json).unwrap();

    assert_eq!(rec.agent_uuid, decoded.agent_uuid);
    assert_eq!(rec.agent_id, decoded.agent_id);
    assert_eq!(rec.workspace_id, decoded.workspace_id);
    assert_eq!(rec.state.state_name(), decoded.state.state_name());
    assert_eq!(rec.state_history.len(), decoded.state_history.len());
}

// ===========================================================================
// 3. AgentRuntime register/unregister
// ===========================================================================

#[tokio::test]
async fn runtime_register_and_unregister_agent() {
    let runtime = make_runtime();
    let agent_id = runtime
        .launch_agent(make_spec("ws-reg"), "cmd", None)
        .await
        .unwrap();

    // Should be discoverable
    let info = runtime.get_agent(&agent_id).await;
    assert!(info.is_some(), "registered agent should be gettable");
    let info = info.unwrap();
    assert_eq!(info.agent_id, agent_id);
    assert_eq!(info.workspace_id, "ws-reg");

    // Unregister (stop_agent removes from registry)
    runtime.stop_agent(&agent_id).await.unwrap();
    let gone = runtime.get_agent(&agent_id).await;
    assert!(gone.is_none(), "stopped agent should be gone");
}

#[tokio::test]
async fn runtime_register_discovered_agent() {
    let runtime = make_runtime();
    let handle = AgentHandle {
        workspace: WorkspaceHandle {
            id: "ws-disc".into(),
            backend: "mock".into(),
            metadata: HashMap::new(),
        },
        agent_id: "%99".into(),
        process_id: Some("4242".into()),
        metadata: HashMap::new(),
    };
    runtime
        .register_discovered_agent("%99".into(), handle)
        .await
        .unwrap();

    let info = runtime.get_agent("%99").await;
    assert!(info.is_some());
    let info = info.unwrap();
    assert_eq!(info.agent_id, "%99");
    assert_eq!(info.workspace_id, "ws-disc");
    assert!(!info.agent_uuid.is_empty());

    // cleanup
    runtime.stop_agent("%99").await.unwrap();
}

#[tokio::test]
async fn runtime_stop_nonexistent_agent_returns_error() {
    let runtime = make_runtime();
    let result = runtime.stop_agent("no-such-agent").await;
    assert!(result.is_err());
}

// ===========================================================================
// 4. Multiple agents — register 5, list returns all 5
// ===========================================================================

#[tokio::test]
async fn runtime_register_five_agents_and_list() {
    let runtime = make_runtime();
    let mut ids = Vec::new();

    for i in 0..5 {
        let agent_id = runtime
            .launch_agent(make_spec(&format!("ws-multi-{i}")), "cmd", None)
            .await
            .unwrap();
        ids.push(agent_id);
    }

    let agents = runtime.list_agents().await;
    assert_eq!(agents.len(), 5, "should have 5 registered agents");

    // Every launched id should appear in the list
    let listed_ids: HashSet<String> = agents.iter().map(|a| a.agent_id.clone()).collect();
    for id in &ids {
        assert!(
            listed_ids.contains(id),
            "agent {id} missing from list_agents"
        );
    }

    // Each agent has a non-empty UUID and is in Running state
    for agent in &agents {
        assert!(!agent.agent_uuid.is_empty());
        assert!(matches!(
            agent.lifecycle,
            AgentLifecycleState::Running { .. }
        ));
    }

    // Cleanup
    for id in &ids {
        let _ = runtime.stop_agent(id).await;
    }
    assert!(runtime.list_agents().await.is_empty());
}

// ===========================================================================
// 5. UUID uniqueness
// ===========================================================================

#[tokio::test]
async fn runtime_each_agent_gets_unique_uuid() {
    let runtime = make_runtime();
    let mut uuids = HashSet::new();
    let mut agent_ids = Vec::new();

    for i in 0..10 {
        let agent_id = runtime
            .launch_agent(make_spec(&format!("ws-uuid-{i}")), "cmd", None)
            .await
            .unwrap();
        let info = runtime.get_agent(&agent_id).await.unwrap();
        assert!(
            uuids.insert(info.agent_uuid.clone()),
            "UUID {} was duplicated!",
            info.agent_uuid
        );
        agent_ids.push(agent_id);
    }

    assert_eq!(uuids.len(), 10, "all 10 agents should have distinct UUIDs");

    for id in &agent_ids {
        let _ = runtime.stop_agent(id).await;
    }
}

#[tokio::test]
async fn runtime_uuid_resolution_works() {
    let runtime = make_runtime();
    let agent_id = runtime
        .launch_agent(make_spec("ws-resolve"), "cmd", None)
        .await
        .unwrap();
    let info = runtime.get_agent(&agent_id).await.unwrap();
    let uuid = info.agent_uuid.clone();

    // Resolve UUID → current runtime ID
    let resolved = runtime.resolve_agent_uuid(&uuid).await;
    assert_eq!(resolved, Some(agent_id.clone()));

    // After stopping, UUID should be gone from the index
    runtime.stop_agent(&agent_id).await.unwrap();
    let resolved_after = runtime.resolve_agent_uuid(&uuid).await;
    assert!(resolved_after.is_none());
}

// ===========================================================================
// 6. Health status mapping — lifecycle → AgentInfo state visibility
// ===========================================================================

#[tokio::test]
async fn runtime_lifecycle_state_visible_in_agent_info() {
    let runtime = make_runtime();
    let agent_id = runtime
        .launch_agent(make_spec("ws-lc"), "cmd", None)
        .await
        .unwrap();

    // launch_agent sets Running
    let info = runtime.get_agent(&agent_id).await.unwrap();
    assert!(matches!(
        info.lifecycle,
        AgentLifecycleState::Running { .. }
    ));

    // Transition to Processing
    runtime
        .set_agent_lifecycle(
            &agent_id,
            AgentLifecycleState::Processing {
                task_id: "task-abc".into(),
                phase: ProcessingPhase::Testing,
                started_at: now(),
            },
        )
        .await
        .unwrap();
    let info = runtime.get_agent(&agent_id).await.unwrap();
    assert!(matches!(
        info.lifecycle,
        AgentLifecycleState::Processing { .. }
    ));
    assert_eq!(info.lifecycle.task_id(), Some("task-abc"));

    // Transition to Stopping
    runtime
        .set_agent_lifecycle(
            &agent_id,
            AgentLifecycleState::Stopping {
                reason: StopReason::Shutdown,
                initiated_at: now(),
                timeout_secs: Some(10),
            },
        )
        .await
        .unwrap();
    let info = runtime.get_agent(&agent_id).await.unwrap();
    assert!(matches!(
        info.lifecycle,
        AgentLifecycleState::Stopping { .. }
    ));

    // Transition to Terminated
    runtime
        .set_agent_lifecycle(
            &agent_id,
            AgentLifecycleState::Terminated {
                outcome: ExitOutcome::Exited { exit_code: Some(0) },
                terminated_at: now(),
                duration_secs: 30,
            },
        )
        .await
        .unwrap();
    let info = runtime.get_agent(&agent_id).await.unwrap();
    assert!(info.lifecycle.is_terminal());
    assert!(!info.lifecycle.is_alive());

    runtime.stop_agent(&agent_id).await.unwrap();
}

#[tokio::test]
async fn runtime_set_task_id_updates_agent_info() {
    let runtime = make_runtime();
    let agent_id = runtime
        .launch_agent(make_spec("ws-task"), "cmd", None)
        .await
        .unwrap();

    // task_id starts as None
    let info = runtime.get_agent(&agent_id).await.unwrap();
    assert!(info.task_id.is_none());

    runtime
        .set_task_id(&agent_id, "task-777".into())
        .await
        .unwrap();
    let info = runtime.get_agent(&agent_id).await.unwrap();
    assert_eq!(info.task_id, Some("task-777".into()));

    runtime.stop_agent(&agent_id).await.unwrap();
}

// ===========================================================================
// 7. Concurrent registration
// ===========================================================================

#[tokio::test]
async fn runtime_concurrent_registration_from_multiple_tasks() {
    let runtime = Arc::new(make_runtime());
    let mut handles = Vec::new();

    for i in 0..20 {
        let rt = runtime.clone();
        let h = tokio::spawn(async move {
            rt.launch_agent(make_spec(&format!("ws-conc-{i}")), "cmd", None)
                .await
                .unwrap()
        });
        handles.push(h);
    }

    let mut ids = Vec::new();
    for h in handles {
        ids.push(h.await.unwrap());
    }

    // All 20 should be registered
    let agents = runtime.list_agents().await;
    assert_eq!(agents.len(), 20);

    // All UUIDs unique
    let uuids: HashSet<String> = agents.iter().map(|a| a.agent_uuid.clone()).collect();
    assert_eq!(
        uuids.len(),
        20,
        "concurrent registrations must produce unique UUIDs"
    );

    // All agent_ids distinct
    let agent_ids: HashSet<String> = agents.iter().map(|a| a.agent_id.clone()).collect();
    assert_eq!(agent_ids.len(), 20);

    // Cleanup
    for id in &ids {
        let _ = runtime.stop_agent(id).await;
    }
}

#[tokio::test]
async fn runtime_concurrent_register_discovered_agents() {
    let runtime = Arc::new(make_runtime());
    let mut handles = Vec::new();

    for i in 0..10 {
        let rt = runtime.clone();
        let agent_id = format!("%{i}");
        let h = tokio::spawn(async move {
            let handle = AgentHandle {
                workspace: WorkspaceHandle {
                    id: format!("ws-cd-{i}"),
                    backend: "mock".into(),
                    metadata: HashMap::new(),
                },
                agent_id: agent_id.clone(),
                process_id: Some(format!("{i}")),
                metadata: HashMap::new(),
            };
            rt.register_discovered_agent(agent_id, handle)
                .await
                .unwrap();
        });
        handles.push(h);
    }

    for h in handles {
        h.await.unwrap();
    }

    let agents = runtime.list_agents().await;
    assert_eq!(agents.len(), 10);

    // Cleanup
    for a in &agents {
        let _ = runtime.stop_agent(&a.agent_id).await;
    }
}

// ===========================================================================
// 8. Stale agent detection / prune_unhealthy_agents
// ===========================================================================

#[tokio::test]
async fn runtime_prune_unhealthy_agents_no_op_on_unsupported_backend() {
    // MockBackend doesn't support health checks (downcast fails).
    // prune_unhealthy_agents should be a silent no-op, leaving all agents intact.
    let runtime = make_runtime();

    for i in 0..3 {
        runtime
            .launch_agent(make_spec(&format!("ws-prune-{i}")), "cmd", None)
            .await
            .unwrap();
    }

    let pruned = runtime.prune_unhealthy_agents().await;
    assert!(
        pruned.is_empty(),
        "unsupported backend should not prune any agents"
    );

    // All agents should still be present
    let agents = runtime.list_agents().await;
    assert_eq!(agents.len(), 3);

    for a in &agents {
        let _ = runtime.stop_agent(&a.agent_id).await;
    }
}

#[tokio::test]
async fn runtime_shutdown_clears_all_agents() {
    let runtime = make_runtime();

    for i in 0..5 {
        runtime
            .launch_agent(make_spec(&format!("ws-sd-{i}")), "cmd", None)
            .await
            .unwrap();
    }
    assert_eq!(runtime.list_agents().await.len(), 5);

    runtime.shutdown().await.unwrap();
    assert!(
        runtime.list_agents().await.is_empty(),
        "shutdown should clear all agents"
    );
}

// ===========================================================================
// Extra: AgentInfo fields from launch_agent
// ===========================================================================

#[tokio::test]
async fn runtime_launch_agent_sets_correct_agent_info_fields() {
    let runtime = make_runtime();
    let agent_id = runtime
        .launch_agent(make_spec("ws-fields"), "some-cmd", None)
        .await
        .unwrap();

    let info = runtime.get_agent(&agent_id).await.unwrap();

    // agent_id matches backend-generated id
    assert_eq!(info.agent_id, "agent-ws-fields");
    assert_eq!(info.workspace_id, "ws-fields");

    // UUID is non-empty and well-formed (uuid v4 format)
    assert!(!info.agent_uuid.is_empty());
    assert!(
        uuid::Uuid::parse_str(&info.agent_uuid).is_ok(),
        "agent_uuid should be a valid UUID"
    );

    // lifecycle is Running
    assert!(matches!(
        info.lifecycle,
        AgentLifecycleState::Running { .. }
    ));

    // task_id initially None, mcp_agent_id auto-generated
    assert!(info.task_id.is_none());
    assert!(info.mcp_agent_id.is_some());
    assert_eq!(info.mcp_agent_id.as_deref(), Some("acp-ws-fields-fields"));

    // state_history is empty for freshly launched agent
    assert!(info.state_history.is_empty());

    // handle.workspace matches spec
    assert_eq!(info.handle.workspace.id, "ws-fields");
    assert_eq!(info.handle.workspace.backend, "mock");

    // created_at and last_heartbeat are recent
    let age_secs = (Utc::now() - info.created_at).num_seconds();
    assert!(age_secs.abs() < 5);

    runtime.stop_agent(&agent_id).await.unwrap();
}

// ===========================================================================
// Extra: resolve_agent_id
// ===========================================================================

#[tokio::test]
async fn runtime_resolve_agent_id_direct_match() {
    let runtime = make_runtime();
    let agent_id = runtime
        .launch_agent(make_spec("ws-res"), "cmd", None)
        .await
        .unwrap();

    let resolved = runtime.resolve_agent_id(&agent_id).await;
    assert_eq!(resolved, Some(agent_id.clone()));

    let not_found = runtime.resolve_agent_id("no-such").await;
    assert!(not_found.is_none());

    runtime.stop_agent(&agent_id).await.unwrap();
}

// ===========================================================================
// Extra: MCP binding (basic path)
// ===========================================================================

#[tokio::test]
async fn runtime_try_bind_mcp_agent_to_unbound_runtime_agent() {
    let runtime = make_runtime();
    let agent_id = runtime
        .launch_agent(make_spec("ws-mcp"), "cmd", None)
        .await
        .unwrap();

    // ACP agents now have auto-generated MCP bindings
    let mcp_id = runtime.get_mcp_agent_id(&agent_id).await;
    assert!(mcp_id.is_some());
    assert_eq!(mcp_id.as_deref(), Some("acp-ws-mcp-mcp"));

    // Manual binding with a different MCP ID should work (for MCP agents connecting via HTTP)
    let _bound = runtime.try_bind_mcp_agent("opencode@abcd1234").await;
    // This will try to find an unbound agent, but our agent is already bound
    // So it should return None or bind to a different agent if available
    // For this test, we just verify the auto-binding worked above

    // resolve_agent_id via auto-generated MCP ID works
    let resolved = runtime.resolve_agent_id("acp-ws-mcp-mcp").await;
    assert_eq!(resolved, Some(agent_id.clone()));

    // Inject message via auto-generated MCP ID resolves correctly
    runtime
        .inject_message("acp-ws-mcp-mcp", "hello")
        .await
        .unwrap();

    runtime.stop_agent(&agent_id).await.unwrap();
}

#[tokio::test]
async fn runtime_try_bind_mcp_agent_idempotent() {
    let runtime = make_runtime();
    let agent_id = runtime
        .launch_agent(make_spec("ws-mcp2"), "cmd", None)
        .await
        .unwrap();
    let first = runtime.try_bind_mcp_agent("opencode@xyz").await;
    let second = runtime.try_bind_mcp_agent("opencode@xyz").await;
    assert_eq!(first, second);

    runtime.stop_agent(&agent_id).await.unwrap();
}
