//! Bridge between collaboration plan revisions and session-scoped DAG execution.

use std::collections::{HashMap, HashSet};
use std::fmt;
use std::path::PathBuf;

use ergatai_core::cross_agent::{
    clear_session_dag_scheduler, get_session_dag_scheduler, try_set_session_dag_scheduler,
    CollaborationExecutionScope, DagScheduler, MeshPolicy,
};
use ergatai_core::orchestration::{TaskGraph, TaskNode, TaskStatus};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use utoipa::ToSchema;

use crate::services::collaboration_planner::{
    submit_session_interaction as submit_planned_interaction, SessionInteractionOutcome,
    SubmitSessionInteractionRequest, MAX_AGENT_CALLS, MAX_NODE_TIMEOUT_SECS, MAX_PLAN_NODES,
};
use crate::services::collaboration_session::{
    append_context_event, cancel_session, get_plan_revision, get_session, transition_state,
    CollaborationPlanRevision, CollaborationSessionDetail, CollaborationSessionError, SessionState,
};

#[derive(Debug, Serialize, ToSchema)]
pub struct SessionPlanActivation {
    #[serde(flatten)]
    pub session: CollaborationSessionDetail,
    pub plan_revision: CollaborationPlanRevision,
    pub dag_id: String,
    pub submitted_nodes: usize,
    pub progress: f64,
    pub graph_status: String,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct SessionInteractionSubmitted {
    #[serde(flatten)]
    pub outcome: SessionInteractionOutcome,
    pub activation: Option<SessionPlanActivation>,
}

pub async fn submit_session_interaction(
    session_id: &str,
    request: SubmitSessionInteractionRequest,
) -> Result<SessionInteractionSubmitted, CollaborationSessionDagError> {
    let should_execute = request.auto_execute;
    let session_id = session_id.to_string();
    let outcome =
        tokio::task::spawn_blocking(move || submit_planned_interaction(&session_id, request))
            .await
            .map_err(|error| {
                CollaborationSessionDagError::Execution(format!(
                    "Collaboration interaction task failed: {error}"
                ))
            })?
            .map_err(CollaborationSessionDagError::from)?;

    let activation = if should_execute
        && outcome.route
            == crate::services::collaboration_planner::SessionInteractionRoute::Collaboration
    {
        if let Some(plan) = outcome.plan.as_ref() {
            let plan_revision_id = plan.plan_revision.id.clone();
            match plan.session.session.state {
                SessionState::Planning => Some(
                    activate_plan_revision(&outcome.session.session.id, &plan_revision_id).await?,
                ),
                SessionState::Executing => Some(
                    replace_session_plan_revision(&outcome.session.session.id, &plan_revision_id)
                        .await?,
                ),
                _ => None,
            }
        } else {
            None
        }
    } else {
        None
    };

    let mut outcome = outcome;
    if let Some(activation) = activation.as_ref() {
        outcome.session = activation.session.clone();
    }

    Ok(SessionInteractionSubmitted {
        outcome,
        activation,
    })
}

static SESSION_MONITORS: std::sync::OnceLock<
    std::sync::Mutex<HashMap<String, tokio::task::JoinHandle<()>>>,
> = std::sync::OnceLock::new();

fn register_session_monitor(session_id: &str, handle: tokio::task::JoinHandle<()>) {
    let monitors = SESSION_MONITORS.get_or_init(|| std::sync::Mutex::new(HashMap::new()));
    match monitors.lock() {
        Ok(mut guard) => {
            guard.insert(session_id.to_string(), handle);
        }
        Err(poisoned) => {
            tracing::error!("Session monitor registry lock poisoned, recovering");
            poisoned.into_inner().insert(session_id.to_string(), handle);
        }
    }
}

fn stop_session_monitor(session_id: &str) {
    let Some(monitors) = SESSION_MONITORS.get() else {
        return;
    };
    let handle = match monitors.lock() {
        Ok(mut guard) => guard.remove(session_id),
        Err(poisoned) => poisoned.into_inner().remove(session_id),
    };
    if let Some(handle) = handle {
        handle.abort();
    }
}

static SESSION_EVENT_LISTENERS: std::sync::OnceLock<
    std::sync::Mutex<HashMap<String, tokio::task::JoinHandle<()>>>,
> = std::sync::OnceLock::new();

fn register_session_event_listener(session_id: &str, handle: tokio::task::JoinHandle<()>) {
    let listeners = SESSION_EVENT_LISTENERS.get_or_init(|| std::sync::Mutex::new(HashMap::new()));
    match listeners.lock() {
        Ok(mut guard) => {
            guard.insert(session_id.to_string(), handle);
        }
        Err(poisoned) => {
            tracing::error!("Session event listener registry lock poisoned, recovering");
            poisoned.into_inner().insert(session_id.to_string(), handle);
        }
    }
}

fn stop_session_event_listener(session_id: &str) {
    let Some(listeners) = SESSION_EVENT_LISTENERS.get() else {
        return;
    };
    let handle = match listeners.lock() {
        Ok(mut guard) => guard.remove(session_id),
        Err(poisoned) => poisoned.into_inner().remove(session_id),
    };
    if let Some(handle) = handle {
        handle.abort();
    }
}

#[derive(Debug)]
pub enum CollaborationSessionDagError {
    Session(CollaborationSessionError),
    Conflict(String),
    Validation(String),
    Execution(String),
}

impl fmt::Display for CollaborationSessionDagError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Session(error) => write!(formatter, "{error}"),
            Self::Conflict(message) | Self::Validation(message) | Self::Execution(message) => {
                write!(formatter, "{message}")
            }
        }
    }
}

impl std::error::Error for CollaborationSessionDagError {}

impl From<CollaborationSessionError> for CollaborationSessionDagError {
    fn from(error: CollaborationSessionError) -> Self {
        Self::Session(error)
    }
}

#[derive(Debug, Deserialize)]
struct PlanGraphSpec {
    nodes: Vec<PlanNodeSpec>,
    #[serde(default)]
    workspace_id: Option<String>,
    #[serde(default)]
    project_id: Option<String>,
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    timeout: Option<u64>,
    #[serde(default)]
    max_agent_calls: Option<u64>,
    #[serde(default)]
    stall_timeout_secs: Option<u64>,
    #[serde(default)]
    node_timeout_secs: Option<u64>,
    #[serde(default)]
    priority: Option<String>,
    #[serde(default)]
    parameters: HashMap<String, Value>,
    #[serde(default)]
    communication: Option<String>,
    #[serde(default)]
    preserved_outputs: Vec<PreservedOutputSpec>,
}

#[derive(Debug, Deserialize)]
struct PreservedOutputSpec {
    node_id: String,
    agent: Option<String>,
    result_path: Option<String>,
    summary: Option<String>,
}

#[derive(Debug, Deserialize)]
struct PlanNodeSpec {
    id: String,
    agent: String,
    #[serde(default)]
    task: Option<String>,
    #[serde(default)]
    depends_on: Vec<String>,
    #[serde(default)]
    input: Option<String>,
    #[serde(default)]
    output: Option<String>,
    #[serde(default)]
    max_retries: u32,
    #[serde(default)]
    priority: Option<String>,
    #[serde(default)]
    timeout: Option<u64>,
    #[serde(default)]
    scope: Option<String>,
    #[serde(default)]
    metadata: HashMap<String, String>,
    #[serde(default)]
    condition: Option<String>,
    #[serde(default)]
    expected_outputs: HashMap<String, String>,
    #[serde(default)]
    required_profile: Option<String>,
}

fn status_label(status: &TaskStatus) -> String {
    match status {
        TaskStatus::Pending => "pending".to_string(),
        TaskStatus::Running => "running".to_string(),
        TaskStatus::Completed => "completed".to_string(),
        TaskStatus::Failed => "failed".to_string(),
        TaskStatus::Skipped => "skipped".to_string(),
    }
}

#[derive(Clone)]
struct NodeSnapshot {
    id: String,
    agent: String,
    task: String,
    status: String,
    result_path: Option<String>,
    error: Option<String>,
}

async fn node_snapshots(scheduler: &DagScheduler) -> Vec<NodeSnapshot> {
    let graph = scheduler.graph();
    let graph = graph.lock().await;
    graph
        .nodes
        .iter()
        .map(|node| NodeSnapshot {
            id: node.id.clone(),
            agent: node.agent.clone(),
            task: node.task.clone(),
            status: status_label(&node.status),
            result_path: node.result_path.clone(),
            error: node.metadata.get("last_error").cloned(),
        })
        .collect()
}

async fn record_task_event(
    session_id: &str,
    dag_id: &str,
    plan_revision_id: &str,
    snapshot: &NodeSnapshot,
    event_type: &str,
) {
    let mut artifact_refs = Vec::new();
    if let Some(result_path) = &snapshot.result_path {
        artifact_refs.push(result_path.clone());
    }
    let payload = serde_json::json!({
        "dagId": dag_id,
        "planRevisionId": plan_revision_id,
        "nodeId": snapshot.id,
        "agent": snapshot.agent,
        "task": snapshot.task,
        "status": snapshot.status,
        "resultPath": snapshot.result_path,
        "error": snapshot.error,
    });

    if let Err(error) = append_context_event(
        session_id,
        event_type,
        "agent",
        Some(&snapshot.agent),
        &payload,
        "shared",
        &artifact_refs,
    ) {
        tracing::warn!(
            session_id,
            dag_id,
            node_id = snapshot.id,
            event_type,
            error = %error,
            "Failed to append collaboration DAG event"
        );
    }
}

async fn transition_if_allowed(
    session_id: &str,
    next_state: SessionState,
    reason: &str,
) -> Result<CollaborationSessionDetail, CollaborationSessionDagError> {
    transition_state(
        session_id,
        crate::services::collaboration_session::SessionStateTransitionRequest {
            state: next_state,
            reason: Some(reason.to_string()),
        },
    )
    .map_err(CollaborationSessionDagError::from)
}

fn build_graph(
    snapshot: &Value,
    mode: crate::services::collaboration_session::CollaborationMode,
    participants: &[crate::services::collaboration_session::CollaborationSessionParticipant],
    workspace_id: Option<&str>,
    project_id: Option<&str>,
) -> Result<TaskGraph, CollaborationSessionDagError> {
    let spec: PlanGraphSpec = serde_json::from_value(snapshot.clone()).map_err(|error| {
        CollaborationSessionDagError::Validation(format!("Invalid plan DAG snapshot: {error}"))
    })?;

    if spec.nodes.is_empty() {
        return Err(CollaborationSessionDagError::Validation(
            "A collaboration plan must contain at least one node".to_string(),
        ));
    }
    if spec.nodes.len() > MAX_PLAN_NODES {
        return Err(CollaborationSessionDagError::Validation(format!(
            "Collaboration plans are limited to {MAX_PLAN_NODES} nodes"
        )));
    }
    if spec.workspace_id.as_deref() != workspace_id {
        return Err(CollaborationSessionDagError::Validation(
            "Plan workspace boundary does not match the session".to_string(),
        ));
    }
    if spec.project_id.as_deref() != project_id {
        return Err(CollaborationSessionDagError::Validation(
            "Plan project boundary does not match the session".to_string(),
        ));
    }
    if let Some(timeout) = spec.timeout {
        if timeout == 0 || timeout > MAX_NODE_TIMEOUT_SECS {
            return Err(CollaborationSessionDagError::Validation(format!(
                "Plan timeout must be between 1 and {MAX_NODE_TIMEOUT_SECS} seconds"
            )));
        }
    }
    if let Some(timeout) = spec.node_timeout_secs {
        if timeout == 0 || timeout > MAX_NODE_TIMEOUT_SECS {
            return Err(CollaborationSessionDagError::Validation(format!(
                "Node timeout must be between 1 and {MAX_NODE_TIMEOUT_SECS} seconds"
            )));
        }
    }
    if let Some(max_agent_calls) = spec.max_agent_calls {
        if max_agent_calls == 0 || max_agent_calls > MAX_AGENT_CALLS {
            return Err(CollaborationSessionDagError::Validation(format!(
                "Plan max_agent_calls must be between 1 and {MAX_AGENT_CALLS}"
            )));
        }
    }

    let mut graph = TaskGraph::new(Vec::new());
    graph.description = spec.description;
    graph.timeout = spec.timeout;
    graph.max_agent_calls = spec.max_agent_calls;
    graph.stall_timeout_secs = spec.stall_timeout_secs;
    graph.node_timeout_secs = spec.node_timeout_secs;
    graph.priority = spec.priority;
    graph.parameters = spec.parameters;
    graph.communication = spec.communication;

    if mode == crate::services::collaboration_session::CollaborationMode::Supervisor {
        let supervisor = participants
            .iter()
            .find(|participant| participant.role == "supervisor")
            .map(|participant| participant.agent_id.clone())
            .ok_or_else(|| {
                CollaborationSessionDagError::Validation(
                    "Supervisor sessions require a participant with role 'supervisor'".to_string(),
                )
            })?;
        graph.communication = Some(format!("star:{supervisor}"));
    } else if graph.communication.is_none() {
        graph.communication = Some("open".to_string());
    }

    let communication = graph.communication.clone().unwrap_or_else(|| "open".into());
    MeshPolicy::parse(&communication).map_err(|error| {
        CollaborationSessionDagError::Validation(format!(
            "Invalid collaboration topology '{communication}': {error}"
        ))
    })?;

    let participant_agents: HashSet<String> = participants
        .iter()
        .map(|participant| participant.agent_id.clone())
        .collect();
    graph.nodes = spec
        .nodes
        .into_iter()
        .map(|node_spec| {
            let task = node_spec
                .task
                .filter(|task| !task.trim().is_empty())
                .unwrap_or_else(|| format!("Complete {}", node_spec.id));
            let mut node = TaskNode::new(node_spec.id, node_spec.agent, task);
            node.depends_on = node_spec.depends_on;
            node.input = node_spec.input;
            node.output = node_spec.output;
            node.max_retries = node_spec.max_retries;
            node.priority = node_spec.priority;
            node.timeout = node_spec.timeout;
            node.scope = node_spec.scope;
            node.metadata = node_spec.metadata;
            node.condition = node_spec.condition;
            node.expected_outputs = node_spec.expected_outputs;
            node.required_profile = node_spec.required_profile;
            if let Some(preserved) = spec
                .preserved_outputs
                .iter()
                .find(|output| output.node_id == node.id)
            {
                if preserved
                    .agent
                    .as_deref()
                    .is_some_and(|agent| agent != node.agent)
                {
                    return Err(CollaborationSessionDagError::Validation(format!(
                        "Preserved output for node '{}' belongs to a different agent",
                        node.id
                    )));
                }
                node.status = TaskStatus::Completed;
                node.result_path = preserved.result_path.clone();
                if let Some(summary) = &preserved.summary {
                    node.metadata
                        .insert("preserved_summary".to_string(), summary.clone());
                }
            }
            Ok(node)
        })
        .collect::<Result<Vec<_>, _>>()?;

    for node in &graph.nodes {
        if node.agent.trim().is_empty() {
            return Err(CollaborationSessionDagError::Validation(format!(
                "Plan node '{}' has no agent",
                node.id
            )));
        }
        if !participant_agents.contains(&node.agent) {
            return Err(CollaborationSessionDagError::Validation(format!(
                "Plan node '{}' uses agent '{}' that is not a session participant",
                node.id, node.agent
            )));
        }
        if let Some(scope) = &node.scope {
            if scope.trim().is_empty()
                || scope.contains("..")
                || scope.starts_with('/')
                || scope.starts_with('\\')
                || scope.contains('\\')
            {
                return Err(CollaborationSessionDagError::Validation(format!(
                    "Plan node '{}' has an unsafe file access scope",
                    node.id
                )));
            }
        }
    }

    graph
        .validate()
        .map_err(|error| CollaborationSessionDagError::Validation(error.to_string()))?;
    Ok(graph)
}

fn spawn_context_monitor(session_id: String, scheduler: DagScheduler) {
    let scope = match scheduler.collaboration_scope() {
        Some(scope) => scope.clone(),
        None => return,
    };

    let monitor_session_id = session_id.clone();
    let monitor = tokio::spawn(async move {
        let mut previous: HashMap<String, String> = HashMap::new();
        loop {
            tokio::time::sleep(std::time::Duration::from_millis(250)).await;
            let snapshots = node_snapshots(&scheduler).await;

            for snapshot in snapshots.iter().filter(|snapshot| {
                previous
                    .get(&snapshot.id)
                    .is_none_or(|status| status != &snapshot.status)
            }) {
                let event_type = match snapshot.status.as_str() {
                    "running" => "task_started",
                    "completed" => "task_completed",
                    "failed" => "task_failed",
                    "skipped" => "task_skipped",
                    _ => continue,
                };
                record_task_event(
                    &monitor_session_id,
                    scheduler.dag_id(),
                    &scope.plan_revision_id,
                    snapshot,
                    event_type,
                )
                .await;
            }

            previous = snapshots
                .iter()
                .map(|snapshot| (snapshot.id.clone(), snapshot.status.clone()))
                .collect();

            if scheduler.is_complete().await {
                let failed = snapshots.iter().any(|snapshot| snapshot.status == "failed");
                if failed {
                    let _ = transition_if_allowed(
                        &monitor_session_id,
                        SessionState::Failed,
                        "Collaboration DAG execution failed",
                    )
                    .await;
                    let summary = serde_json::json!({
                        "dagId": scheduler.dag_id(),
                        "planRevisionId": scope.plan_revision_id,
                        "failed": snapshots.iter().filter(|node| node.status == "failed").count(),
                    });
                    let _ = append_context_event(
                        &monitor_session_id,
                        "dag_failed",
                        "system",
                        None,
                        &summary,
                        "system",
                        &[],
                    );
                } else {
                    let _ = transition_if_allowed(
                        &monitor_session_id,
                        SessionState::Completed,
                        "Collaboration DAG execution completed",
                    )
                    .await;
                    let summary = serde_json::json!({
                        "dagId": scheduler.dag_id(),
                        "planRevisionId": scope.plan_revision_id,
                        "completed": snapshots.iter().filter(|node| node.status == "completed").count(),
                    });
                    let _ = append_context_event(
                        &monitor_session_id,
                        "dag_completed",
                        "system",
                        None,
                        &summary,
                        "system",
                        &[],
                    );
                }
                break;
            }
        }
        stop_session_event_listener(&monitor_session_id);
        SESSION_MONITORS
            .get()
            .and_then(|monitors| monitors.lock().ok())
            .and_then(|mut guard| guard.remove(&monitor_session_id));
    });

    register_session_monitor(&session_id, monitor);
}

pub async fn activate_plan_revision(
    session_id: &str,
    plan_revision_id: &str,
) -> Result<SessionPlanActivation, CollaborationSessionDagError> {
    let detail = get_session(session_id)?;
    let revision = get_plan_revision(session_id, plan_revision_id)?;

    if revision.status != "active"
        || detail.session.active_plan_revision.as_deref() != Some(plan_revision_id)
    {
        return Err(CollaborationSessionDagError::Validation(
            "Only the session's active plan revision can be executed".to_string(),
        ));
    }
    // Fast-path check to fail early before expensive graph building
    if get_session_dag_scheduler(Some(session_id)).is_some() {
        return Err(CollaborationSessionDagError::Conflict(
            "A DAG is already running for this collaboration session".to_string(),
        ));
    }

    let graph = build_graph(
        &revision.dag_snapshot,
        detail.session.mode,
        &detail.participants,
        detail.session.workspace_id.as_deref(),
        detail.session.project_id.as_deref(),
    )?;

    if !matches!(
        detail.session.state,
        SessionState::Planning | SessionState::WaitingInput | SessionState::WaitingApproval
    ) {
        return Err(CollaborationSessionDagError::Validation(format!(
            "Session state '{}' cannot execute a plan",
            detail.session.state.as_str()
        )));
    }

    let detail =
        transition_if_allowed(session_id, SessionState::Executing, "Plan activated").await?;
    let dag_id = format!("dag-session-{}-{}", detail.session.id, revision.id);
    let mut graph = graph;
    graph.dag_id = Some(dag_id.clone());
    let scope = CollaborationExecutionScope::new(
        detail.session.id.clone(),
        Some(detail.session.chat_id.clone()),
        revision.id.clone(),
    );
    let scheduler = DagScheduler::new(
        PathBuf::from(crate::get_app_state().default_cwd.clone()),
        graph,
    )
    .with_collaboration_scope(scope);

    // Atomic check-and-set to prevent TOCTOU race: two concurrent activations
    // could both pass the early check above, then the second would silently
    // overwrite the first, leaking its spawned tasks.
    if let Err(_displaced_scheduler) = try_set_session_dag_scheduler(scheduler.clone()) {
        // Another scheduler was registered between our check and set.
        // This shouldn't happen in practice due to the early check, but handle it defensively.
        tracing::warn!(
            session_id,
            "Concurrent DAG activation detected, aborting duplicate"
        );
        return Err(CollaborationSessionDagError::Conflict(
            "A DAG was concurrently registered for this collaboration session".to_string(),
        ));
    }
    let event_listener = scheduler.clone().start_event_listener();
    register_session_event_listener(session_id, event_listener);

    let submitted = match scheduler.submit_graph().await {
        Ok(submitted) => submitted,
        Err(error) => {
            stop_session_event_listener(session_id);
            clear_session_dag_scheduler(Some(session_id));
            let _ =
                transition_if_allowed(session_id, SessionState::Failed, &error.to_string()).await;
            let _ = append_context_event(
                session_id,
                "dag_failed",
                "system",
                None,
                &serde_json::json!({
                    "dagId": dag_id,
                    "planRevisionId": revision.id,
                    "error": error.to_string(),
                }),
                "system",
                &[],
            );
            return Err(CollaborationSessionDagError::Execution(error.to_string()));
        }
    };

    let plan_event = serde_json::json!({
        "dagId": dag_id,
        "planRevisionId": revision.id,
        "submittedNodes": submitted.len(),
    });
    append_context_event(
        session_id,
        "plan_activated",
        "system",
        None,
        &plan_event,
        "system",
        &[],
    )?;

    spawn_context_monitor(session_id.to_string(), scheduler.clone());
    let progress = scheduler.progress().await as f64;
    let graph_status = scheduler.status_prompt().await;

    Ok(SessionPlanActivation {
        session: detail,
        plan_revision: revision,
        dag_id,
        submitted_nodes: submitted.len(),
        progress,
        graph_status,
    })
}

pub async fn recover_session_dag(
    scheduler: DagScheduler,
) -> Result<Option<SessionPlanActivation>, CollaborationSessionDagError> {
    let Some(scope) = scheduler.collaboration_scope().cloned() else {
        return Err(CollaborationSessionDagError::Validation(
            "Cannot recover a DAG without a collaboration session scope".to_string(),
        ));
    };

    let detail = get_session(&scope.session_id)?;
    let revision = get_plan_revision(&scope.session_id, &scope.plan_revision_id)?;
    if revision.status != "active"
        || detail.session.active_plan_revision.as_deref() != Some(scope.plan_revision_id.as_str())
        || detail.session.state != SessionState::Executing
    {
        return Ok(None);
    }
    // Fast-path check to fail early
    if get_session_dag_scheduler(Some(&scope.session_id)).is_some() {
        return Err(CollaborationSessionDagError::Conflict(
            "A DAG is already running for this collaboration session".to_string(),
        ));
    }

    scheduler.rollback_running_nodes().await.map_err(|error| {
        CollaborationSessionDagError::Execution(format!(
            "Failed to roll back session DAG for recovery: {error}"
        ))
    })?;

    // Atomic check-and-set to prevent TOCTOU race
    if let Err(_) = try_set_session_dag_scheduler(scheduler.clone()) {
        tracing::warn!(
            session_id = %scope.session_id,
            "Concurrent DAG recovery detected, aborting duplicate"
        );
        return Err(CollaborationSessionDagError::Conflict(
            "A DAG was concurrently registered for this collaboration session".to_string(),
        ));
    }
    let event_listener = scheduler.clone().start_event_listener();
    register_session_event_listener(&scope.session_id, event_listener);
    let submitted = match scheduler.submit_graph().await {
        Ok(submitted) => submitted,
        Err(error) => {
            stop_session_event_listener(&scope.session_id);
            clear_session_dag_scheduler(Some(&scope.session_id));
            let _ =
                transition_if_allowed(&scope.session_id, SessionState::Failed, &error.to_string())
                    .await;
            let _ = append_context_event(
                &scope.session_id,
                "dag_failed",
                "system",
                None,
                &serde_json::json!({
                    "dagId": scheduler.dag_id(),
                    "planRevisionId": scope.plan_revision_id,
                    "error": error.to_string(),
                }),
                "system",
                &[],
            );
            return Err(CollaborationSessionDagError::Execution(error.to_string()));
        }
    };

    append_context_event(
        &scope.session_id,
        "dag_recovered",
        "system",
        None,
        &serde_json::json!({
            "dagId": scheduler.dag_id(),
            "planRevisionId": scope.plan_revision_id,
            "submittedNodes": submitted.len(),
        }),
        "system",
        &[],
    )?;
    spawn_context_monitor(scope.session_id.clone(), scheduler.clone());

    Ok(Some(SessionPlanActivation {
        session: detail,
        plan_revision: revision,
        dag_id: scheduler.dag_id().to_string(),
        submitted_nodes: submitted.len(),
        progress: scheduler.progress().await as f64,
        graph_status: scheduler.status_prompt().await,
    }))
}

pub async fn replace_session_plan_revision(
    session_id: &str,
    plan_revision_id: &str,
) -> Result<SessionPlanActivation, CollaborationSessionDagError> {
    let detail = get_session(session_id)?;
    let revision = get_plan_revision(session_id, plan_revision_id)?;

    if revision.status != "active"
        || detail.session.active_plan_revision.as_deref() != Some(plan_revision_id)
        || detail.session.state != SessionState::Executing
    {
        return Err(CollaborationSessionDagError::Validation(
            "Only the active plan revision of an executing session can be hot-swapped".to_string(),
        ));
    }

    let graph = build_graph(
        &revision.dag_snapshot,
        detail.session.mode,
        &detail.participants,
        detail.session.workspace_id.as_deref(),
        detail.session.project_id.as_deref(),
    )?;

    let old_scheduler = get_session_dag_scheduler(Some(session_id));
    let previous = old_scheduler.as_ref().map(|scheduler| {
        let scope = scheduler
            .collaboration_scope()
            .expect("registered session scheduler has collaboration scope");
        (
            scheduler.dag_id().to_string(),
            scope.plan_revision_id.clone(),
        )
    });

    if let Some(old_scheduler) = old_scheduler {
        stop_session_monitor(session_id);
        stop_session_event_listener(session_id);
        old_scheduler
            .cancel_remaining_nodes("Superseded by a new collaboration plan revision")
            .await
            .map_err(|error| {
                CollaborationSessionDagError::Execution(format!(
                    "Failed to cancel superseded session DAG: {error}"
                ))
            })?;
        clear_session_dag_scheduler(Some(session_id));
    }

    let dag_id = format!("dag-session-{}-{}", detail.session.id, revision.id);
    let mut graph = graph;
    graph.dag_id = Some(dag_id.clone());
    let scope = CollaborationExecutionScope::new(
        detail.session.id.clone(),
        Some(detail.session.chat_id.clone()),
        revision.id.clone(),
    );
    let scheduler = DagScheduler::new(
        PathBuf::from(crate::get_app_state().default_cwd.clone()),
        graph,
    )
    .with_collaboration_scope(scope);

    // Atomic check-and-set to prevent TOCTOU race between clear and set
    if let Err(_) = try_set_session_dag_scheduler(scheduler.clone()) {
        tracing::error!(
            session_id,
            "Failed to register replacement DAG scheduler after clearing old one"
        );
        return Err(CollaborationSessionDagError::Execution(
            "Failed to register replacement plan revision due to concurrent modification".to_string(),
        ));
    }
    let event_listener = scheduler.clone().start_event_listener();
    register_session_event_listener(session_id, event_listener);

    let submitted = match scheduler.submit_graph().await {
        Ok(submitted) => submitted,
        Err(error) => {
            stop_session_event_listener(session_id);
            clear_session_dag_scheduler(Some(session_id));
            let _ =
                transition_if_allowed(session_id, SessionState::Failed, &error.to_string()).await;
            let _ = append_context_event(
                session_id,
                "dag_failed",
                "system",
                None,
                &serde_json::json!({
                    "dagId": dag_id,
                    "planRevisionId": revision.id,
                    "error": error.to_string(),
                }),
                "system",
                &[],
            );
            return Err(CollaborationSessionDagError::Execution(error.to_string()));
        }
    };

    append_context_event(
        session_id,
        "plan_hot_swapped",
        "system",
        None,
        &serde_json::json!({
            "previousDagId": previous.as_ref().map(|(dag_id, _)| dag_id.clone()),
            "previousPlanRevisionId": previous.as_ref().map(|(_, revision_id)| revision_id.clone()),
            "dagId": dag_id,
            "planRevisionId": revision.id,
            "submittedNodes": submitted.len(),
        }),
        "system",
        &[],
    )?;

    spawn_context_monitor(session_id.to_string(), scheduler.clone());
    let progress = scheduler.progress().await as f64;
    let graph_status = scheduler.status_prompt().await;

    Ok(SessionPlanActivation {
        session: detail,
        plan_revision: revision,
        dag_id,
        submitted_nodes: submitted.len(),
        progress,
        graph_status,
    })
}

pub async fn cancel_session_execution(
    session_id: &str,
    reason: Option<String>,
) -> Result<CollaborationSessionDetail, CollaborationSessionDagError> {
    // Cancel DAG execution first, then stop monitors. This ensures that if cancellation
    // fails, the monitors are still active to observe state transitions. Stopping monitors
    // before cancel could leave the session in Executing state with no observers if cancel fails.
    if let Some(scheduler) = get_session_dag_scheduler(Some(session_id)) {
        scheduler
            .cancel_remaining_nodes(reason.as_deref().unwrap_or("Cancelled by user"))
            .await
            .map_err(|error| {
                CollaborationSessionDagError::Execution(format!(
                    "Failed to cancel DAG execution: {error}"
                ))
            })?;
        clear_session_dag_scheduler(Some(session_id));
    }

    // Stop monitors only after successful cancellation
    stop_session_monitor(session_id);
    stop_session_event_listener(session_id);

    Ok(cancel_session(session_id, reason)?)
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn participant(
        agent_id: &str,
        role: &str,
    ) -> crate::services::collaboration_session::CollaborationSessionParticipant {
        crate::services::collaboration_session::CollaborationSessionParticipant {
            id: format!("participant-{agent_id}"),
            session_id: "session".to_string(),
            agent_id: agent_id.to_string(),
            role: role.to_string(),
            status: "ready".to_string(),
            created_at: 0,
            updated_at: 0,
        }
    }

    #[test]
    fn supervisor_snapshot_uses_star_topology() {
        let snapshot = json!({
            "nodes": [
                { "id": "worker-a", "agent": "agent-a", "task": "Investigate" }
            ]
        });
        let graph = build_graph(
            &snapshot,
            crate::services::collaboration_session::CollaborationMode::Supervisor,
            &[
                participant("agent-a", "worker"),
                participant("supervisor", "supervisor"),
            ],
            None,
            None,
        )
        .unwrap();

        assert_eq!(graph.communication.as_deref(), Some("star:supervisor"));
    }

    #[test]
    fn graph_validation_rejects_missing_dependency() {
        let snapshot = json!({
            "nodes": [
                { "id": "b", "agent": "agent-a", "task": "Build", "depends_on": ["a"] }
            ]
        });
        let error = build_graph(
            &snapshot,
            crate::services::collaboration_session::CollaborationMode::Group,
            &[participant("agent-a", "peer")],
            None,
            None,
        )
        .unwrap_err();

        assert!(matches!(error, CollaborationSessionDagError::Validation(_)));
    }

    #[test]
    fn graph_validation_rejects_workspace_boundary_mismatch() {
        let snapshot = json!({
            "workspace_id": "workspace-other",
            "nodes": [
                { "id": "work", "agent": "agent-a", "task": "Build" }
            ]
        });
        let error = build_graph(
            &snapshot,
            crate::services::collaboration_session::CollaborationMode::Group,
            &[participant("agent-a", "peer")],
            Some("workspace-session"),
            None,
        )
        .unwrap_err();

        assert!(matches!(error, CollaborationSessionDagError::Validation(_)));
    }

    #[test]
    fn graph_validation_rejects_unsafe_file_scope() {
        let snapshot = json!({
            "nodes": [
                {
                    "id": "work",
                    "agent": "agent-a",
                    "task": "Build",
                    "scope": "../outside/**"
                }
            ]
        });
        let error = build_graph(
            &snapshot,
            crate::services::collaboration_session::CollaborationMode::Group,
            &[participant("agent-a", "peer")],
            None,
            None,
        )
        .unwrap_err();

        assert!(matches!(error, CollaborationSessionDagError::Validation(_)));
    }

    #[test]
    fn graph_preserves_completed_outputs() {
        let snapshot = json!({
            "nodes": [
                { "id": "work", "agent": "agent-a", "task": "Build" }
            ],
            "preserved_outputs": [
                {
                    "node_id": "work",
                    "agent": "agent-a",
                    "result_path": "/tmp/work-result.md",
                    "summary": "Completed work"
                }
            ]
        });
        let graph = build_graph(
            &snapshot,
            crate::services::collaboration_session::CollaborationMode::Group,
            &[participant("agent-a", "peer")],
            None,
            None,
        )
        .unwrap();
        let node = graph.find_node("work").unwrap();

        assert_eq!(node.status, TaskStatus::Completed);
        assert_eq!(node.result_path.as_deref(), Some("/tmp/work-result.md"));
        assert_eq!(
            node.metadata.get("preserved_summary").map(String::as_str),
            Some("Completed work")
        );
    }
}
