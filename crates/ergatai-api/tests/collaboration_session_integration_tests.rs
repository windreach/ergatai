use std::path::PathBuf;

use ergatai_api::services::collaboration_planner::{
    submit_session_interaction, SessionInteractionKind, SessionInteractionRoute,
    SubmitSessionInteractionRequest,
};
use ergatai_api::services::collaboration_session::{
    append_context_event, append_message, cancel_session, create_approval, create_plan_revision,
    create_session, decide_approval, get_plan_revision, get_session, list_active_plan_revisions,
    list_active_sessions, list_events, list_pending_approvals, transition_state,
    AppendSessionMessageRequest, ApprovalDecision, ApprovalDecisionRequest, ApprovalStatus,
    CreateApprovalRequest, CreateCollaborationSessionRequest, CreatePlanRevisionRequest,
    ParticipantInput, SessionState,
};
use ergatai_api::services::collaboration_session_dag::{
    cancel_session_execution, recover_session_dag,
};
use http_body_util::BodyExt;
use serde_json::json;

static TEST_DB_MUTEX: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
static TEST_DB_DATA_DIR: std::sync::OnceLock<PathBuf> = std::sync::OnceLock::new();

fn lock_user_data_db_for_tests() -> tokio::sync::MutexGuard<'static, ()> {
    let guard = TEST_DB_MUTEX.blocking_lock();
    TEST_DB_DATA_DIR.get_or_init(|| {
        let data_dir = std::env::temp_dir()
            .join("ergatai-collaboration-session-tests")
            .join(std::process::id().to_string());
        let _ = std::fs::remove_dir_all(&data_dir);
        std::fs::create_dir_all(&data_dir).unwrap();
        std::env::set_var("ERGATAI_DATA_DIR", &data_dir);
        data_dir
    });
    guard
}

async fn lock_user_data_db_for_tests_async() -> tokio::sync::MutexGuard<'static, ()> {
    let guard = TEST_DB_MUTEX.lock().await;
    TEST_DB_DATA_DIR.get_or_init(|| {
        let data_dir = std::env::temp_dir()
            .join("ergatai-collaboration-session-tests")
            .join(std::process::id().to_string());
        let _ = std::fs::remove_dir_all(&data_dir);
        std::fs::create_dir_all(&data_dir).unwrap();
        std::env::set_var("ERGATAI_DATA_DIR", &data_dir);
        data_dir
    });
    guard
}

#[test]
fn recovery_queries_track_active_sessions_plans_and_approvals() {
    let _database_guard = lock_user_data_db_for_tests();
    let chat_id = format!("chat-{}", uuid::Uuid::new_v4());
    let created = create_session(CreateCollaborationSessionRequest {
        chat_id,
        workspace_id: Some("workspace-recovery".to_string()),
        project_id: Some("project-recovery".to_string()),
        mode: ergatai_api::services::collaboration_session::CollaborationMode::Group,
        goal: Some("Recover after restart".to_string()),
        participants: vec![ParticipantInput {
            agent_id: "agent-recovery".to_string(),
            role: "peer".to_string(),
            status: "ready".to_string(),
        }],
    })
    .unwrap();

    transition_state(
        &created.session.id,
        ergatai_api::services::collaboration_session::SessionStateTransitionRequest {
            state: SessionState::Planning,
            reason: Some("Prepare recovery test".to_string()),
        },
    )
    .unwrap();
    transition_state(
        &created.session.id,
        ergatai_api::services::collaboration_session::SessionStateTransitionRequest {
            state: SessionState::Executing,
            reason: Some("Recovery test".to_string()),
        },
    )
    .unwrap();
    let plan = create_plan_revision(
        &created.session.id,
        CreatePlanRevisionRequest {
            dag_snapshot: json!({
                "nodes": [{ "id": "recover", "agent": "agent-recovery" }]
            }),
            summary: Some("Recovery plan".to_string()),
            source_event_id: None,
        },
    )
    .unwrap();
    create_approval(
        &created.session.id,
        CreateApprovalRequest {
            kind: "file_write".to_string(),
            node_id: Some("recover".to_string()),
            plan_revision_id: Some(plan.plan_revision.id.clone()),
            request: json!({ "path": "/tmp/recovery.txt" }),
        },
    )
    .unwrap();

    let active_sessions = list_active_sessions().unwrap();
    assert!(active_sessions
        .iter()
        .any(|session| session.session.id == created.session.id));
    let active_plans = list_active_plan_revisions().unwrap();
    assert!(active_plans
        .iter()
        .any(|revision| revision.id == plan.plan_revision.id));
    let pending_approvals = list_pending_approvals().unwrap();
    assert!(pending_approvals
        .iter()
        .any(|approval| approval.plan_revision_id == Some(plan.plan_revision.id.clone())));

    cancel_session(&created.session.id, Some("Test finished".to_string())).unwrap();
    assert!(list_active_sessions()
        .unwrap()
        .iter()
        .all(|session| session.session.id != created.session.id));
    assert!(list_active_plan_revisions()
        .unwrap()
        .iter()
        .all(|revision| revision.session_id != created.session.id));
    assert!(list_pending_approvals()
        .unwrap()
        .iter()
        .all(|approval| approval.session_id != created.session.id));
}

#[tokio::test]
async fn concurrent_session_dag_registries_stay_isolated() {
    let _database_guard = lock_user_data_db_for_tests_async().await;

    let make_active_session = |agent_id: &'static str| async move {
        let created = create_session(CreateCollaborationSessionRequest {
            chat_id: format!("chat-{}", uuid::Uuid::new_v4()),
            workspace_id: Some("workspace-concurrent".to_string()),
            project_id: Some("project-concurrent".to_string()),
            mode: ergatai_api::services::collaboration_session::CollaborationMode::Group,
            goal: Some("Execute concurrent session DAGs".to_string()),
            participants: vec![ParticipantInput {
                agent_id: agent_id.to_string(),
                role: "peer".to_string(),
                status: "ready".to_string(),
            }],
        })
        .unwrap();
        transition_state(
            &created.session.id,
            ergatai_api::services::collaboration_session::SessionStateTransitionRequest {
                state: SessionState::Planning,
                reason: Some("Prepare concurrent execution".to_string()),
            },
        )
        .unwrap();
        let plan = create_plan_revision(
            &created.session.id,
            CreatePlanRevisionRequest {
                dag_snapshot: json!({
                    "nodes": [{ "id": "work", "agent": agent_id, "task": "Work" }]
                }),
                summary: Some("Concurrent plan".to_string()),
                source_event_id: None,
            },
        )
        .unwrap();
        (created.session.id, plan.plan_revision.id)
    };

    let (first, second) = tokio::join!(
        make_active_session("agent-concurrent-a"),
        make_active_session("agent-concurrent-b"),
    );
    let first_temp = tempfile::tempdir().unwrap();
    let first_scheduler = ergatai_core::cross_agent::DagScheduler::new(
        first_temp.path().to_path_buf(),
        ergatai_core::orchestration::TaskGraph::new(vec![
            ergatai_core::orchestration::TaskNode::new("work", "agent-concurrent-a", "Work A"),
        ]),
    )
    .with_collaboration_scope(ergatai_core::cross_agent::CollaborationExecutionScope::new(
        first.0.clone(),
        None,
        first.1,
    ));
    let second_temp = tempfile::tempdir().unwrap();
    let second_scheduler = ergatai_core::cross_agent::DagScheduler::new(
        second_temp.path().to_path_buf(),
        ergatai_core::orchestration::TaskGraph::new(vec![
            ergatai_core::orchestration::TaskNode::new("work", "agent-concurrent-b", "Work B"),
        ]),
    )
    .with_collaboration_scope(ergatai_core::cross_agent::CollaborationExecutionScope::new(
        second.0.clone(),
        None,
        second.1,
    ));

    let set_first = tokio::spawn({
        let scheduler = first_scheduler.clone();
        let session_id = first.0.clone();
        async move {
            ergatai_core::cross_agent::set_session_dag_scheduler(scheduler);
            session_id
        }
    });
    let set_second = tokio::spawn({
        let scheduler = second_scheduler.clone();
        let session_id = second.0.clone();
        async move {
            ergatai_core::cross_agent::set_session_dag_scheduler(scheduler);
            session_id
        }
    });
    assert_eq!(set_first.await.unwrap(), first.0);
    assert_eq!(set_second.await.unwrap(), second.0);

    let retrieved_first =
        ergatai_core::cross_agent::get_session_dag_scheduler(Some(&first.0)).unwrap();
    let retrieved_second =
        ergatai_core::cross_agent::get_session_dag_scheduler(Some(&second.0)).unwrap();
    assert_eq!(
        retrieved_first.collaboration_scope().unwrap().session_id,
        first.0
    );
    assert_eq!(
        retrieved_second.collaboration_scope().unwrap().session_id,
        second.0
    );
    assert_ne!(
        retrieved_first.dag_id(),
        retrieved_second.dag_id(),
        "session DAGs must not share an execution identity"
    );
}

#[tokio::test]
async fn inactive_session_plan_is_not_recovered() {
    let _database_guard = lock_user_data_db_for_tests_async().await;
    let created = create_session(CreateCollaborationSessionRequest {
        chat_id: format!("chat-{}", uuid::Uuid::new_v4()),
        workspace_id: Some("workspace-recovery".to_string()),
        project_id: Some("project-recovery".to_string()),
        mode: ergatai_api::services::collaboration_session::CollaborationMode::Group,
        goal: Some("Do not recover inactive plan".to_string()),
        participants: vec![ParticipantInput {
            agent_id: "agent-inactive".to_string(),
            role: "peer".to_string(),
            status: "ready".to_string(),
        }],
    })
    .unwrap();
    let plan = create_plan_revision(
        &created.session.id,
        CreatePlanRevisionRequest {
            dag_snapshot: json!({
                "nodes": [{ "id": "work", "agent": "agent-inactive" }]
            }),
            summary: None,
            source_event_id: None,
        },
    )
    .unwrap();
    let temp_dir = tempfile::tempdir().unwrap();
    let scheduler = ergatai_core::cross_agent::DagScheduler::new(
        temp_dir.path().to_path_buf(),
        ergatai_core::orchestration::TaskGraph::new(vec![
            ergatai_core::orchestration::TaskNode::new("work", "agent-inactive", "Work"),
        ]),
    )
    .with_collaboration_scope(ergatai_core::cross_agent::CollaborationExecutionScope::new(
        created.session.id.clone(),
        Some(created.session.chat_id.clone()),
        plan.plan_revision.id.clone(),
    ));

    assert!(recover_session_dag(scheduler).await.unwrap().is_none());
}

#[tokio::test]
async fn executing_user_message_hot_swaps_active_revision() {
    let _database_guard = lock_user_data_db_for_tests_async().await;
    ergatai_api::app_state_with_token(None);
    let created = create_session(CreateCollaborationSessionRequest {
        chat_id: format!("chat-{}", uuid::Uuid::new_v4()),
        workspace_id: Some("workspace-hot-swap".to_string()),
        project_id: Some("project-hot-swap".to_string()),
        mode: ergatai_api::services::collaboration_session::CollaborationMode::Group,
        goal: Some("Hot-swap the active plan".to_string()),
        participants: vec![ParticipantInput {
            agent_id: "peer-a".to_string(),
            role: "peer".to_string(),
            status: "ready".to_string(),
        }],
    })
    .unwrap();
    transition_state(
        &created.session.id,
        ergatai_api::services::collaboration_session::SessionStateTransitionRequest {
            state: SessionState::Planning,
            reason: Some("Prepare first plan".to_string()),
        },
    )
    .unwrap();
    let first = create_plan_revision(
        &created.session.id,
        CreatePlanRevisionRequest {
            dag_snapshot: json!({
                "nodes": [{ "id": "peer-1", "agent": "peer-a", "task": "First work" }]
            }),
            summary: Some("First revision".to_string()),
            source_event_id: None,
        },
    )
    .unwrap();
    transition_state(
        &created.session.id,
        ergatai_api::services::collaboration_session::SessionStateTransitionRequest {
            state: SessionState::Executing,
            reason: Some("Activate first plan".to_string()),
        },
    )
    .unwrap();
    append_context_event(
        &created.session.id,
        "task_completed",
        "agent",
        Some("peer-a"),
        &json!({
            "planRevisionId": first.plan_revision.id,
            "nodeId": "peer-1",
            "agent": "peer-a",
            "resultPath": "/tmp/hot-swap-output.md",
            "summary": "First work completed"
        }),
        "shared",
        &["/tmp/hot-swap-output.md".to_string()],
    )
    .unwrap();

    let mut first_graph = ergatai_core::orchestration::TaskGraph::new(vec![
        ergatai_core::orchestration::TaskNode::new("peer-1", "peer-a", "First work"),
    ]);
    first_graph.nodes[0].status = ergatai_core::orchestration::TaskStatus::Completed;
    first_graph.nodes[0].result_path = Some("/tmp/hot-swap-output.md".to_string());
    let old_project_root = tempfile::tempdir().unwrap();
    let old_scheduler = ergatai_core::cross_agent::DagScheduler::new(
        old_project_root.path().to_path_buf(),
        first_graph,
    )
    .with_collaboration_scope(ergatai_core::cross_agent::CollaborationExecutionScope::new(
        created.session.id.clone(),
        Some(created.session.chat_id.clone()),
        first.plan_revision.id.clone(),
    ));
    ergatai_core::cross_agent::set_session_dag_scheduler(old_scheduler);

    let submitted = ergatai_api::services::collaboration_session_dag::submit_session_interaction(
        &created.session.id,
        SubmitSessionInteractionRequest {
            text: "Please add a security review before finishing".to_string(),
            kind: SessionInteractionKind::Message,
            actor_type: "user".to_string(),
            actor_id: Some("user-1".to_string()),
            mentioned_agent_ids: Vec::new(),
            selected_agent_ids: Vec::new(),
            constraints: vec!["Include a security review".to_string()],
            artifact_refs: Vec::new(),
            metadata: json!({ "source": "hot-swap-test" }),
            route: None,
            auto_execute: true,
        },
    )
    .await
    .unwrap();

    assert_eq!(
        submitted.outcome.route,
        SessionInteractionRoute::Collaboration
    );
    let activation = submitted.activation.as_ref().unwrap();
    assert_eq!(activation.plan_revision.revision, 2);
    assert_eq!(
        submitted
            .outcome
            .session
            .session
            .active_plan_revision
            .as_deref(),
        Some(activation.plan_revision.id.as_str())
    );
    let preserved = activation.plan_revision.dag_snapshot["preserved_outputs"]
        .as_array()
        .unwrap();
    assert_eq!(preserved.len(), 1);
    assert_eq!(preserved[0]["node_id"], "peer-1");
    assert_eq!(activation.submitted_nodes, 0);

    let old_revision = get_plan_revision(&created.session.id, &first.plan_revision.id).unwrap();
    assert_eq!(old_revision.status, "superseded");
    assert!(list_events(&created.session.id, None, 100)
        .unwrap()
        .iter()
        .any(|event| event.event_type == "plan_hot_swapped"));
}

#[test]
fn collaboration_interaction_routes_lightweight_and_plans() {
    let _database_guard = lock_user_data_db_for_tests();
    let created = create_session(CreateCollaborationSessionRequest {
        chat_id: format!("chat-{}", uuid::Uuid::new_v4()),
        workspace_id: Some("workspace-interactions".to_string()),
        project_id: Some("project-interactions".to_string()),
        mode: ergatai_api::services::collaboration_session::CollaborationMode::Group,
        goal: Some("Route interactions".to_string()),
        participants: vec![
            ParticipantInput {
                agent_id: "peer-a".to_string(),
                role: "peer".to_string(),
                status: "ready".to_string(),
            },
            ParticipantInput {
                agent_id: "peer-b".to_string(),
                role: "peer".to_string(),
                status: "ready".to_string(),
            },
        ],
    })
    .unwrap();

    let collaboration = submit_session_interaction(
        &created.session.id,
        SubmitSessionInteractionRequest {
            text: "@peer-a please review the shared context".to_string(),
            kind: SessionInteractionKind::Message,
            actor_type: "user".to_string(),
            actor_id: Some("user-1".to_string()),
            mentioned_agent_ids: vec!["peer-a".to_string()],
            selected_agent_ids: Vec::new(),
            constraints: vec!["Use the session runtime".to_string()],
            artifact_refs: Vec::new(),
            metadata: json!({ "source": "test" }),
            route: Some(SessionInteractionRoute::Collaboration),
            auto_execute: false,
        },
    )
    .unwrap();
    assert_eq!(collaboration.route, SessionInteractionRoute::Collaboration);
    assert_eq!(collaboration.session.session.state, SessionState::Planning);
    let plan = collaboration.plan.as_ref().unwrap();
    assert_eq!(plan.plan_revision.revision, 1);
    assert_eq!(
        plan.plan_revision.source_event_id.as_deref(),
        collaboration.event_id.as_deref()
    );
    let nodes = plan.plan_revision.dag_snapshot["nodes"].as_array().unwrap();
    assert_eq!(nodes.len(), 1);
    assert_eq!(nodes[0]["agent"], "peer-a");

    let lightweight = submit_session_interaction(
        &created.session.id,
        SubmitSessionInteractionRequest {
            text: "Just add this to the shared context".to_string(),
            kind: SessionInteractionKind::Message,
            actor_type: "user".to_string(),
            actor_id: Some("user-1".to_string()),
            mentioned_agent_ids: Vec::new(),
            selected_agent_ids: Vec::new(),
            constraints: Vec::new(),
            artifact_refs: Vec::new(),
            metadata: json!({}),
            route: Some(SessionInteractionRoute::Lightweight),
            auto_execute: false,
        },
    )
    .unwrap();
    assert_eq!(lightweight.route, SessionInteractionRoute::Lightweight);
    assert!(lightweight.plan.is_none());
    if let (Some(next), Some(previous)) = (lightweight.event_sequence, collaboration.event_sequence)
    {
        assert!(next > previous);
    }
}

#[tokio::test]
async fn collaboration_session_stream_replays_requested_events() {
    let _database_guard = lock_user_data_db_for_tests_async().await;
    let created = create_session(CreateCollaborationSessionRequest {
        chat_id: format!("chat-{}", uuid::Uuid::new_v4()),
        workspace_id: Some("workspace-stream".to_string()),
        project_id: Some("project-stream".to_string()),
        mode: ergatai_api::services::collaboration_session::CollaborationMode::Group,
        goal: Some("Stream replay".to_string()),
        participants: vec![ParticipantInput {
            agent_id: "agent-stream".to_string(),
            role: "peer".to_string(),
            status: "ready".to_string(),
        }],
    })
    .unwrap();

    let response = ergatai_api::api::collaboration_sessions::stream_collaboration_session_events(
        axum::extract::Path(created.session.id.clone()),
        axum::extract::Query(ergatai_api::api::collaboration_sessions::StreamEventQuery {
            after_sequence: Some(0),
            poll_interval_ms: Some(50),
        }),
    )
    .await;
    assert_eq!(response.status(), axum::http::StatusCode::OK);
    let first_frame = response.into_body().frame().await.unwrap().unwrap();
    let first_chunk = first_frame.into_data().unwrap();
    let body = String::from_utf8_lossy(&first_chunk).to_string();
    assert!(body.contains("event: session_created"));
    assert!(body.contains("id: 1"));

    let response = ergatai_api::api::collaboration_sessions::stream_collaboration_session_events(
        axum::extract::Path(created.session.id),
        axum::extract::Query(ergatai_api::api::collaboration_sessions::StreamEventQuery {
            after_sequence: Some(1),
            poll_interval_ms: Some(50),
        }),
    )
    .await;
    assert_eq!(response.status(), axum::http::StatusCode::OK);
}

#[test]
fn collaboration_session_persists_context_plans_and_approvals() {
    let _database_guard = lock_user_data_db_for_tests();
    let chat_id = format!("chat-{}", uuid::Uuid::new_v4());

    let created = create_session(CreateCollaborationSessionRequest {
        chat_id: chat_id.clone(),
        workspace_id: Some("workspace-1".to_string()),
        project_id: Some("project-1".to_string()),
        mode: ergatai_api::services::collaboration_session::CollaborationMode::Supervisor,
        goal: Some("Fix the failing test".to_string()),
        participants: vec![ParticipantInput {
            agent_id: "agent-1".to_string(),
            role: "worker".to_string(),
            status: "ready".to_string(),
        }],
    })
    .unwrap();
    assert_eq!(created.session.state, SessionState::Idle);
    assert_eq!(created.participants.len(), 1);

    let found = ergatai_api::services::collaboration_session::find_session_by_chat(&chat_id)
        .unwrap()
        .unwrap();
    assert_eq!(found.id, created.session.id);

    let messaged = append_message(
        &created.session.id,
        AppendSessionMessageRequest {
            actor_type: "user".to_string(),
            actor_id: Some("user-1".to_string()),
            payload: json!({ "text": "Investigate the failure" }),
            artifact_refs: vec![],
            visibility: Some("shared".to_string()),
        },
    )
    .unwrap();
    assert_eq!(messaged.session.state, SessionState::Planning);

    transition_state(
        &created.session.id,
        ergatai_api::services::collaboration_session::SessionStateTransitionRequest {
            state: SessionState::Executing,
            reason: Some("Plan accepted".to_string()),
        },
    )
    .unwrap();

    let plan = create_plan_revision(
        &created.session.id,
        CreatePlanRevisionRequest {
            dag_snapshot: json!({
                "nodes": [{ "id": "investigate", "agent": "agent-1" }]
            }),
            summary: Some("Investigate the failure".to_string()),
            source_event_id: None,
        },
    )
    .unwrap();
    assert_eq!(plan.plan_revision.revision, 1);
    assert_eq!(
        get_plan_revision(&created.session.id, &plan.plan_revision.id)
            .unwrap()
            .id,
        plan.plan_revision.id
    );

    let approval = create_approval(
        &created.session.id,
        CreateApprovalRequest {
            kind: "file_write".to_string(),
            node_id: Some("investigate".to_string()),
            plan_revision_id: Some(plan.plan_revision.id.clone()),
            request: json!({ "path": "/tmp/example.txt" }),
        },
    )
    .unwrap();
    assert_eq!(approval.approval.status, ApprovalStatus::Pending);
    assert_eq!(
        approval.session.session.state,
        SessionState::WaitingApproval
    );

    let decided = decide_approval(
        &created.session.id,
        &approval.approval.id,
        ApprovalDecisionRequest {
            decision: ApprovalDecision::Approve,
            decided_by: Some("user-1".to_string()),
            decision_payload: json!({ "approved": true }),
        },
    )
    .unwrap();
    assert_eq!(decided.approval.status, ApprovalStatus::Approved);
    assert_eq!(decided.session.session.state, SessionState::Executing);

    let cancelled = cancel_session(&created.session.id, Some("Test complete".to_string())).unwrap();
    assert_eq!(cancelled.session.state, SessionState::Cancelled);

    let events = list_events(&created.session.id, None, 100).unwrap();
    let event_types: Vec<_> = events
        .iter()
        .map(|event| event.event_type.as_str())
        .collect();
    assert!(event_types.contains(&"session_created"));
    assert!(event_types.contains(&"user_message_added"));
    assert!(event_types.contains(&"plan_revision_created"));
    assert!(event_types.contains(&"approval_required"));
    assert!(event_types.contains(&"approval_granted"));
    assert!(event_types.contains(&"session_cancelled"));

    let detail = get_session(&created.session.id).unwrap();
    assert_eq!(detail.session.state, SessionState::Cancelled);
}

#[tokio::test]
async fn approval_rejection_and_cancellation_cancel_pending_work() {
    let _database_guard = lock_user_data_db_for_tests_async().await;
    let created = create_session(CreateCollaborationSessionRequest {
        chat_id: format!("chat-{}", uuid::Uuid::new_v4()),
        workspace_id: Some("workspace-lifecycle".to_string()),
        project_id: Some("project-lifecycle".to_string()),
        mode: ergatai_api::services::collaboration_session::CollaborationMode::Group,
        goal: Some("Cancel rejected and pending work".to_string()),
        participants: vec![ParticipantInput {
            agent_id: "agent-lifecycle".to_string(),
            role: "peer".to_string(),
            status: "ready".to_string(),
        }],
    })
    .unwrap();
    transition_state(
        &created.session.id,
        ergatai_api::services::collaboration_session::SessionStateTransitionRequest {
            state: SessionState::Planning,
            reason: Some("Prepare lifecycle test".to_string()),
        },
    )
    .unwrap();
    let plan = create_plan_revision(
        &created.session.id,
        CreatePlanRevisionRequest {
            dag_snapshot: json!({
                "nodes": [{ "id": "work", "agent": "agent-lifecycle", "task": "Work" }]
            }),
            summary: Some("Lifecycle plan".to_string()),
            source_event_id: None,
        },
    )
    .unwrap();
    transition_state(
        &created.session.id,
        ergatai_api::services::collaboration_session::SessionStateTransitionRequest {
            state: SessionState::Executing,
            reason: Some("Activate lifecycle plan".to_string()),
        },
    )
    .unwrap();
    let scheduler_project_root = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(scheduler_project_root.path().join(".ergatai")).unwrap();
    let scheduler = ergatai_core::cross_agent::DagScheduler::new(
        scheduler_project_root.path().to_path_buf(),
        ergatai_core::orchestration::TaskGraph::new(vec![
            ergatai_core::orchestration::TaskNode::new("work", "agent-lifecycle", "Work"),
        ]),
    )
    .with_collaboration_scope(ergatai_core::cross_agent::CollaborationExecutionScope::new(
        created.session.id.clone(),
        Some(created.session.chat_id.clone()),
        plan.plan_revision.id.clone(),
    ));
    ergatai_core::cross_agent::set_session_dag_scheduler(scheduler);

    let first = create_approval(
        &created.session.id,
        CreateApprovalRequest {
            kind: "file_write".to_string(),
            node_id: Some("work".to_string()),
            plan_revision_id: Some(plan.plan_revision.id.clone()),
            request: json!({ "path": "/tmp/rejected.txt" }),
        },
    )
    .unwrap();
    assert_eq!(first.session.session.state, SessionState::WaitingApproval);

    let rejected = decide_approval(
        &created.session.id,
        &first.approval.id,
        ApprovalDecisionRequest {
            decision: ApprovalDecision::Reject,
            decided_by: Some("user-1".to_string()),
            decision_payload: json!({ "reason": "needs another plan" }),
        },
    )
    .unwrap();
    assert_eq!(rejected.approval.status, ApprovalStatus::Rejected);
    assert_eq!(rejected.session.session.state, SessionState::Planning);

    transition_state(
        &created.session.id,
        ergatai_api::services::collaboration_session::SessionStateTransitionRequest {
            state: SessionState::Executing,
            reason: Some("Prepare pending approval cancellation".to_string()),
        },
    )
    .unwrap();

    let second = create_approval(
        &created.session.id,
        CreateApprovalRequest {
            kind: "file_write".to_string(),
            node_id: Some("work".to_string()),
            plan_revision_id: Some(plan.plan_revision.id.clone()),
            request: json!({ "path": "/tmp/cancelled.txt" }),
        },
    )
    .unwrap();
    assert!(list_pending_approvals()
        .unwrap()
        .iter()
        .any(|approval| approval.id == second.approval.id));

    let cancelled =
        cancel_session_execution(&created.session.id, Some("User cancelled".to_string()))
            .await
            .unwrap();
    assert_eq!(cancelled.session.state, SessionState::Cancelled);
    assert!(
        ergatai_core::cross_agent::get_session_dag_scheduler(Some(&created.session.id)).is_none()
    );
    assert!(list_active_sessions()
        .unwrap()
        .iter()
        .all(|session| session.session.id != created.session.id));
    assert!(list_active_plan_revisions()
        .unwrap()
        .iter()
        .all(|revision| revision.session_id != created.session.id));
    assert!(list_pending_approvals()
        .unwrap()
        .iter()
        .all(|approval| approval.id != second.approval.id));
    assert!(list_events(&created.session.id, None, 100)
        .unwrap()
        .iter()
        .any(|event| event.event_type == "approval_rejected"));
}

#[test]
fn plan_revision_preserves_completed_outputs() {
    let _database_guard = lock_user_data_db_for_tests();
    let created = create_session(CreateCollaborationSessionRequest {
        chat_id: format!("chat-{}", uuid::Uuid::new_v4()),
        workspace_id: Some("workspace-preserve".to_string()),
        project_id: Some("project-preserve".to_string()),
        mode: ergatai_api::services::collaboration_session::CollaborationMode::Group,
        goal: Some("Preserve outputs across revisions".to_string()),
        participants: vec![ParticipantInput {
            agent_id: "agent-preserve".to_string(),
            role: "peer".to_string(),
            status: "ready".to_string(),
        }],
    })
    .unwrap();
    transition_state(
        &created.session.id,
        ergatai_api::services::collaboration_session::SessionStateTransitionRequest {
            state: SessionState::Planning,
            reason: Some("Prepare output preservation test".to_string()),
        },
    )
    .unwrap();

    let first = create_plan_revision(
        &created.session.id,
        CreatePlanRevisionRequest {
            dag_snapshot: json!({
                "nodes": [{ "id": "work", "agent": "agent-preserve", "task": "Do work" }]
            }),
            summary: Some("First revision".to_string()),
            source_event_id: None,
        },
    )
    .unwrap();
    append_context_event(
        &created.session.id,
        "task_completed",
        "agent",
        Some("agent-preserve"),
        &json!({
            "planRevisionId": first.plan_revision.id,
            "nodeId": "work",
            "agent": "agent-preserve",
            "resultPath": "/tmp/preserved-work.md",
            "summary": "Work completed"
        }),
        "shared",
        &["/tmp/preserved-work.md".to_string()],
    )
    .unwrap();

    let second = create_plan_revision(
        &created.session.id,
        CreatePlanRevisionRequest {
            dag_snapshot: json!({
                "nodes": [{ "id": "work", "agent": "agent-preserve", "task": "Continue work" }]
            }),
            summary: Some("Second revision".to_string()),
            source_event_id: None,
        },
    )
    .unwrap();
    let preserved = second.plan_revision.dag_snapshot["preserved_outputs"]
        .as_array()
        .unwrap();

    assert_eq!(preserved.len(), 1);
    assert_eq!(preserved[0]["node_id"], "work");
    assert_eq!(preserved[0]["result_path"], "/tmp/preserved-work.md");
    assert_eq!(preserved[0]["summary"], "Work completed");
    assert_eq!(
        second.plan_revision.dag_snapshot["workspace_id"],
        "workspace-preserve"
    );
}
