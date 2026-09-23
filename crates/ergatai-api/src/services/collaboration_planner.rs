//! Deterministic planner and normalized interaction routing for sessions.

use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use utoipa::ToSchema;

use crate::services::collaboration_session::{
    append_message, create_plan_revision, get_session, latest_context_event, CollaborationMode,
    CollaborationSessionDetail, CollaborationSessionError, CollaborationSessionParticipant,
    PlanRevisionCreated,
};

pub const MAX_PLAN_NODES: usize = 16;
pub const MAX_AGENT_CALLS: u64 = 64;
pub const MAX_NODE_TIMEOUT_SECS: u64 = 3_600;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum SessionInteractionKind {
    Goal,
    Message,
    Input,
    Artifact,
}

impl SessionInteractionKind {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Goal => "goal",
            Self::Message => "message",
            Self::Input => "input",
            Self::Artifact => "artifact",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum SessionInteractionRoute {
    Auto,
    Lightweight,
    Collaboration,
}

#[derive(Debug, Clone, Deserialize, ToSchema)]
pub struct SubmitSessionInteractionRequest {
    pub text: String,
    #[serde(default = "default_interaction_kind")]
    pub kind: SessionInteractionKind,
    #[serde(default = "default_actor_type")]
    pub actor_type: String,
    #[serde(default)]
    pub actor_id: Option<String>,
    #[serde(default)]
    pub mentioned_agent_ids: Vec<String>,
    #[serde(default)]
    pub selected_agent_ids: Vec<String>,
    #[serde(default)]
    pub constraints: Vec<String>,
    #[serde(default)]
    pub artifact_refs: Vec<String>,
    #[serde(default)]
    pub metadata: Value,
    #[serde(default)]
    pub route: Option<SessionInteractionRoute>,
    #[serde(default = "default_true")]
    pub auto_execute: bool,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct PlanGenerationInput {
    pub mode: CollaborationMode,
    pub goal: String,
    pub constraints: Vec<String>,
    pub participants: Vec<CollaborationSessionParticipant>,
    pub mentioned_agent_ids: Vec<String>,
    pub selected_agent_ids: Vec<String>,
    #[serde(default)]
    pub artifact_refs: Vec<String>,
    #[serde(default)]
    pub source_event_id: Option<String>,
    #[serde(default = "default_timeout_secs")]
    pub timeout_secs: u64,
    #[serde(default = "default_node_timeout_secs")]
    pub node_timeout_secs: u64,
    #[serde(default)]
    pub max_agent_calls: Option<u64>,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct PlanGenerationOutput {
    pub summary: String,
    pub dag_snapshot: Value,
    pub selected_agents: Vec<String>,
    pub max_agent_calls: u64,
    pub warnings: Vec<String>,
    pub requires_approval: bool,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct SessionInteractionOutcome {
    #[serde(flatten)]
    pub session: CollaborationSessionDetail,
    pub event_id: Option<String>,
    pub event_sequence: Option<i64>,
    pub route: SessionInteractionRoute,
    pub plan: Option<PlanRevisionCreated>,
}

fn default_interaction_kind() -> SessionInteractionKind {
    SessionInteractionKind::Message
}

fn default_actor_type() -> String {
    "user".to_string()
}

fn default_true() -> bool {
    true
}

fn default_timeout_secs() -> u64 {
    1_800
}

fn default_node_timeout_secs() -> u64 {
    600
}

fn extract_mentions(text: &str, participants: &[CollaborationSessionParticipant]) -> Vec<String> {
    participants
        .iter()
        .filter(|participant| text.contains(&format!("@{}", participant.agent_id)))
        .map(|participant| participant.agent_id.clone())
        .collect()
}

fn selected_group_agents(
    participants: &[CollaborationSessionParticipant],
    mentioned: &[String],
    selected: &[String],
) -> Result<Vec<CollaborationSessionParticipant>, CollaborationSessionError> {
    let participant_by_id = participants
        .iter()
        .map(|participant| (participant.agent_id.clone(), participant))
        .collect::<HashMap<_, _>>();
    let mut chosen_ids = Vec::new();
    for agent_id in selected.iter().chain(mentioned.iter()) {
        if participant_by_id.contains_key(agent_id) && !chosen_ids.contains(agent_id) {
            chosen_ids.push(agent_id.clone());
        } else if !participant_by_id.contains_key(agent_id) {
            return Err(CollaborationSessionError::Validation(format!(
                "Plan agent '{agent_id}' is not a session participant"
            )));
        }
    }

    if chosen_ids.is_empty() {
        participants
            .iter()
            .take(MAX_PLAN_NODES)
            .for_each(|participant| chosen_ids.push(participant.agent_id.clone()));
    }

    if chosen_ids.is_empty() {
        return Err(CollaborationSessionError::Validation(
            "Group planning requires at least one participant".to_string(),
        ));
    }
    if chosen_ids.len() > MAX_PLAN_NODES {
        return Err(CollaborationSessionError::Validation(format!(
            "Group plans are limited to {MAX_PLAN_NODES} nodes"
        )));
    }

    Ok(chosen_ids
        .into_iter()
        .filter_map(|agent_id| participant_by_id.get(&agent_id).copied())
        .cloned()
        .collect())
}

fn selected_supervisor_workers(
    participants: &[CollaborationSessionParticipant],
    mentioned: &[String],
    selected: &[String],
) -> Result<
    (
        CollaborationSessionParticipant,
        Vec<CollaborationSessionParticipant>,
    ),
    CollaborationSessionError,
> {
    let supervisor = participants
        .iter()
        .find(|participant| participant.role == "supervisor")
        .cloned()
        .ok_or_else(|| {
            CollaborationSessionError::Validation(
                "Supervisor planning requires a participant with role 'supervisor'".to_string(),
            )
        })?;

    let worker_participants = participants
        .iter()
        .filter(|participant| participant.agent_id != supervisor.agent_id)
        .cloned()
        .collect::<Vec<_>>();
    if worker_participants.is_empty() {
        return Ok((supervisor, Vec::new()));
    }
    let worker_selected = selected
        .iter()
        .filter(|agent_id| **agent_id != supervisor.agent_id)
        .cloned()
        .collect::<Vec<_>>();
    let worker_mentioned = mentioned
        .iter()
        .filter(|agent_id| **agent_id != supervisor.agent_id)
        .cloned()
        .collect::<Vec<_>>();
    let worker_ids = worker_participants
        .iter()
        .map(|participant| participant.agent_id.as_str())
        .collect::<Vec<_>>();
    let has_explicit_worker = worker_selected
        .iter()
        .chain(worker_mentioned.iter())
        .any(|agent_id| worker_ids.contains(&agent_id.as_str()));
    let chosen = if has_explicit_worker {
        selected_group_agents(&worker_participants, &worker_mentioned, &worker_selected)?
    } else {
        worker_participants
    };

    Ok((supervisor, chosen))
}

fn planner_node(
    id: &str,
    agent: &str,
    task: String,
    depends_on: Vec<String>,
    role: &str,
    timeout: Option<u64>,
) -> Value {
    let mut metadata = Map::new();
    metadata.insert("role".to_string(), Value::String(role.to_string()));
    json!({
        "id": id,
        "agent": agent,
        "task": task,
        "depends_on": depends_on,
        "timeout": timeout,
        "expected_outputs": {
            "summary": "Concise result or conclusion for the collaboration session"
        },
        "metadata": metadata,
    })
}

pub fn generate_plan(
    input: PlanGenerationInput,
) -> Result<PlanGenerationOutput, CollaborationSessionError> {
    let goal = input.goal.trim();
    if goal.is_empty() {
        return Err(CollaborationSessionError::Validation(
            "Planning text cannot be empty".to_string(),
        ));
    }
    if goal.chars().count() > 4_000 {
        return Err(CollaborationSessionError::Validation(
            "Planning text cannot exceed 4000 characters".to_string(),
        ));
    }
    if input.timeout_secs == 0
        || input.timeout_secs > MAX_NODE_TIMEOUT_SECS
        || input.node_timeout_secs == 0
        || input.node_timeout_secs > MAX_NODE_TIMEOUT_SECS
    {
        return Err(CollaborationSessionError::Validation(format!(
            "Planning timeouts must be between 1 and {MAX_NODE_TIMEOUT_SECS} seconds"
        )));
    }

    let mentions = if input.mentioned_agent_ids.is_empty() {
        extract_mentions(goal, &input.participants)
    } else {
        input.mentioned_agent_ids.clone()
    };
    let constraints = input
        .constraints
        .iter()
        .map(|constraint| constraint.trim())
        .filter(|constraint| !constraint.is_empty())
        .take(16)
        .map(ToString::to_string)
        .collect::<Vec<_>>();
    let mut task_text = format!("Collaboration goal: {goal}");
    if !constraints.is_empty() {
        task_text.push_str("\nConstraints:");
        for constraint in &constraints {
            task_text.push_str(&format!("\n- {constraint}"));
        }
    }
    if !input.artifact_refs.is_empty() {
        task_text.push_str("\nReferenced artifacts:");
        for artifact in &input.artifact_refs {
            task_text.push_str(&format!("\n- {artifact}"));
        }
    }

    let mut nodes = Vec::new();
    let mut warnings = Vec::new();
    let mut selected_agents;
    match input.mode {
        CollaborationMode::Supervisor => {
            let (supervisor, workers) = selected_supervisor_workers(
                &input.participants,
                &mentions,
                &input.selected_agent_ids,
            )?;
            selected_agents = vec![supervisor.agent_id.clone()];
            selected_agents.extend(workers.iter().map(|worker| worker.agent_id.clone()));
            let plan_id = "supervisor-plan";
            nodes.push(planner_node(
                plan_id,
                &supervisor.agent_id,
                format!("Analyze the goal and create worker instructions.\n{task_text}"),
                Vec::new(),
                "supervisor",
                Some(input.node_timeout_secs),
            ));
            if workers.is_empty() {
                warnings.push(
                    "No workers selected; the supervisor will handle the goal directly".to_string(),
                );
            } else {
                let worker_ids = workers
                    .iter()
                    .enumerate()
                    .map(|(index, _)| format!("worker-{}", index + 1))
                    .collect::<Vec<_>>();
                for (worker, node_id) in workers.iter().zip(worker_ids.iter()) {
                    nodes.push(planner_node(
                        node_id,
                        &worker.agent_id,
                        format!("Complete the assigned part of the goal.\n{task_text}"),
                        vec![plan_id.to_string()],
                        &worker.role,
                        Some(input.node_timeout_secs),
                    ));
                }
                nodes.push(planner_node(
                    "supervisor-review",
                    &supervisor.agent_id,
                    format!("Review worker results and synthesize the final answer.\n{task_text}"),
                    worker_ids,
                    "supervisor",
                    Some(input.node_timeout_secs),
                ));
            }
        }
        CollaborationMode::Group => {
            let peers =
                selected_group_agents(&input.participants, &mentions, &input.selected_agent_ids)?;
            let synthesizer = peers
                .iter()
                .find(|participant| participant.role == "synthesizer");
            let task_peers = peers
                .iter()
                .filter(|participant| {
                    synthesizer
                        .is_none_or(|synthesizer| participant.agent_id != synthesizer.agent_id)
                })
                .cloned()
                .collect::<Vec<_>>();
            if task_peers.is_empty() {
                selected_agents = peers.iter().map(|peer| peer.agent_id.clone()).collect();
                let peer_ids = selected_agents
                    .iter()
                    .enumerate()
                    .map(|(index, _)| format!("peer-{}", index + 1))
                    .collect::<Vec<_>>();
                for (peer, node_id) in peers.iter().zip(peer_ids.iter()) {
                    nodes.push(planner_node(
                        node_id,
                        &peer.agent_id,
                        format!("Contribute your perspective on the shared goal.\n{task_text}"),
                        Vec::new(),
                        &peer.role,
                        Some(input.node_timeout_secs),
                    ));
                }
            } else {
                selected_agents = task_peers
                    .iter()
                    .map(|peer| peer.agent_id.clone())
                    .collect();
                if let Some(synthesizer) = synthesizer {
                    selected_agents.push(synthesizer.agent_id.clone());
                }
                let peer_ids = task_peers
                    .iter()
                    .enumerate()
                    .map(|(index, _)| format!("peer-{}", index + 1))
                    .collect::<Vec<_>>();
                for (peer, node_id) in task_peers.iter().zip(peer_ids.iter()) {
                    nodes.push(planner_node(
                        node_id,
                        &peer.agent_id,
                        format!("Contribute your perspective on the shared goal.\n{task_text}"),
                        Vec::new(),
                        &peer.role,
                        Some(input.node_timeout_secs),
                    ));
                }
                if let Some(synthesizer) = synthesizer {
                    nodes.push(planner_node(
                        "group-synthesis",
                        &synthesizer.agent_id,
                        format!("Synthesize peer contributions into a shared answer.\n{task_text}"),
                        peer_ids.clone(),
                        "synthesizer",
                        Some(input.node_timeout_secs),
                    ));
                }
            }
        }
    }

    if nodes.len() > MAX_PLAN_NODES {
        return Err(CollaborationSessionError::Validation(format!(
            "Generated plan has {} nodes; the limit is {MAX_PLAN_NODES}",
            nodes.len()
        )));
    }
    let default_max_agent_calls = nodes.len() as u64 * 2;
    if let Some(max_agent_calls) = input.max_agent_calls {
        if max_agent_calls == 0 || max_agent_calls > MAX_AGENT_CALLS {
            return Err(CollaborationSessionError::Validation(format!(
                "Planning max_agent_calls must be between 1 and {MAX_AGENT_CALLS}"
            )));
        }
    }
    let max_agent_calls = input
        .max_agent_calls
        .unwrap_or(default_max_agent_calls)
        .max(1);

    // Deduplicate agents while preserving insertion order (HashSet would randomize order)
    let mut seen = HashSet::new();
    selected_agents.retain(|id| seen.insert(id.clone()));
    let summary = format!(
        "{} plan with {} node(s) for: {}",
        input.mode.as_str(),
        nodes.len(),
        goal
    );

    let mut parameters = HashMap::new();
    parameters.insert("goal".to_string(), Value::String(goal.to_string()));
    if !constraints.is_empty() {
        parameters.insert(
            "constraints".to_string(),
            Value::Array(constraints.into_iter().map(Value::String).collect()),
        );
    }

    let communication = match input.mode {
        CollaborationMode::Supervisor => None,
        CollaborationMode::Group => Some("open".to_string()),
    };
    let dag_snapshot = json!({
        "description": summary,
        "timeout": input.timeout_secs,
        "max_agent_calls": max_agent_calls,
        "node_timeout_secs": input.node_timeout_secs,
        "parameters": parameters,
        "communication": communication,
        "nodes": nodes,
    });

    Ok(PlanGenerationOutput {
        summary,
        dag_snapshot,
        selected_agents,
        max_agent_calls,
        warnings,
        requires_approval: false,
    })
}

pub fn generate_session_plan(
    session_id: &str,
    source_event_id: Option<String>,
    text: String,
    mentioned_agent_ids: Vec<String>,
    selected_agent_ids: Vec<String>,
    constraints: Vec<String>,
    artifact_refs: Vec<String>,
) -> Result<PlanRevisionCreated, CollaborationSessionError> {
    let detail = get_session(session_id)?;
    let output = generate_plan(PlanGenerationInput {
        mode: detail.session.mode,
        goal: text,
        constraints,
        participants: detail.participants.clone(),
        mentioned_agent_ids,
        selected_agent_ids,
        artifact_refs,
        source_event_id: source_event_id.clone(),
        timeout_secs: default_timeout_secs(),
        node_timeout_secs: default_node_timeout_secs(),
        max_agent_calls: None,
    })?;
    create_plan_revision(
        session_id,
        crate::services::collaboration_session::CreatePlanRevisionRequest {
            dag_snapshot: output.dag_snapshot,
            summary: Some(output.summary),
            source_event_id,
        },
    )
}

pub fn submit_session_interaction(
    session_id: &str,
    request: SubmitSessionInteractionRequest,
) -> Result<SessionInteractionOutcome, CollaborationSessionError> {
    let detail = get_session(session_id)?;
    let route = request.route.unwrap_or_else(|| {
        if request.actor_type != "user"
            || !matches!(
                request.kind,
                SessionInteractionKind::Goal | SessionInteractionKind::Message
            )
            || !matches!(
                detail.session.state,
                crate::services::collaboration_session::SessionState::Idle
                    | crate::services::collaboration_session::SessionState::Planning
                    | crate::services::collaboration_session::SessionState::Executing
                    | crate::services::collaboration_session::SessionState::Completed
            )
        {
            SessionInteractionRoute::Lightweight
        } else {
            SessionInteractionRoute::Collaboration
        }
    });

    append_message(
        session_id,
        crate::services::collaboration_session::AppendSessionMessageRequest {
            actor_type: request.actor_type.clone(),
            actor_id: request.actor_id.clone(),
            payload: json!({
                "kind": request.kind.as_str(),
                "text": request.text.clone(),
                "mentionedAgentIds": request.mentioned_agent_ids.clone(),
                "selectedAgentIds": request.selected_agent_ids.clone(),
                "constraints": request.constraints.clone(),
                "metadata": request.metadata,
            }),
            artifact_refs: request.artifact_refs.clone(),
            visibility: Some("shared".to_string()),
        },
    )?;
    let latest = latest_context_event(session_id)?;

    if route != SessionInteractionRoute::Collaboration {
        let session = get_session(session_id)?;
        return Ok(SessionInteractionOutcome {
            session,
            event_id: latest.as_ref().map(|event| event.id.clone()),
            event_sequence: latest.as_ref().map(|event| event.sequence),
            route,
            plan: None,
        });
    }

    let source_event_id = latest.as_ref().map(|event| event.id.clone());
    let text = request.text;
    let artifact_refs = request.artifact_refs;
    let plan = generate_session_plan(
        session_id,
        source_event_id,
        text,
        request.mentioned_agent_ids,
        request.selected_agent_ids,
        request.constraints,
        artifact_refs,
    )?;
    Ok(SessionInteractionOutcome {
        session: plan.session.clone(),
        event_id: latest.as_ref().map(|event| event.id.clone()),
        event_sequence: latest.as_ref().map(|event| event.sequence),
        route,
        plan: Some(plan),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn participant(agent_id: &str, role: &str) -> CollaborationSessionParticipant {
        CollaborationSessionParticipant {
            id: format!("participant-{agent_id}"),
            session_id: "session".to_string(),
            conversation_id: format!("conv-{agent_id}"),
            agent_id: agent_id.to_string(),
            role: role.to_string(),
            status: "ready".to_string(),
            created_at: 0,
            updated_at: 0,
        }
    }

    fn input(
        mode: CollaborationMode,
        participants: Vec<CollaborationSessionParticipant>,
        selected: Vec<String>,
    ) -> PlanGenerationInput {
        PlanGenerationInput {
            mode,
            goal: "Implement the collaboration runtime".to_string(),
            constraints: vec!["Keep legacy DAG compatibility".to_string()],
            participants,
            mentioned_agent_ids: Vec::new(),
            selected_agent_ids: selected,
            artifact_refs: Vec::new(),
            source_event_id: None,
            timeout_secs: 1_800,
            node_timeout_secs: 600,
            max_agent_calls: None,
        }
    }

    #[test]
    fn generates_supervisor_star_plan() {
        let output = generate_plan(input(
            CollaborationMode::Supervisor,
            vec![
                participant("supervisor", "supervisor"),
                participant("worker-a", "worker"),
                participant("worker-b", "worker"),
            ],
            vec!["worker-a".to_string(), "worker-b".to_string()],
        ))
        .unwrap();

        let nodes = output.dag_snapshot["nodes"].as_array().unwrap();
        let ids: Vec<_> = nodes
            .iter()
            .map(|node| node["id"].as_str().unwrap())
            .collect();
        assert_eq!(
            ids,
            vec![
                "supervisor-plan",
                "worker-1",
                "worker-2",
                "supervisor-review"
            ]
        );
        assert!(nodes.iter().all(|node| node["task"]
            .as_str()
            .unwrap()
            .contains("legacy DAG compatibility")));
        assert_eq!(output.max_agent_calls, 8);
    }

    #[test]
    fn generates_supervisor_only_plan() {
        let output = generate_plan(input(
            CollaborationMode::Supervisor,
            vec![participant("supervisor", "supervisor")],
            Vec::new(),
        ))
        .unwrap();

        let nodes = output.dag_snapshot["nodes"].as_array().unwrap();
        let ids: Vec<_> = nodes
            .iter()
            .map(|node| node["id"].as_str().unwrap())
            .collect();
        assert_eq!(ids, vec!["supervisor-plan"]);
        assert_eq!(output.selected_agents, vec!["supervisor"]);
        assert!(output.warnings.contains(
            &"No workers selected; the supervisor will handle the goal directly".to_string()
        ));
    }

    #[test]
    fn generates_group_peer_plan_with_synthesis() {
        let output = generate_plan(input(
            CollaborationMode::Group,
            vec![
                participant("peer-a", "peer"),
                participant("peer-b", "peer"),
                participant("synthesizer", "synthesizer"),
            ],
            vec![
                "peer-a".to_string(),
                "peer-b".to_string(),
                "synthesizer".to_string(),
            ],
        ))
        .unwrap();

        let nodes = output.dag_snapshot["nodes"].as_array().unwrap();
        let ids: Vec<_> = nodes
            .iter()
            .map(|node| node["id"].as_str().unwrap())
            .collect();
        assert_eq!(ids, vec!["peer-1", "peer-2", "group-synthesis"]);
        assert_eq!(output.dag_snapshot["communication"], "open");
        assert_eq!(nodes[2]["depends_on"], json!(["peer-1", "peer-2"]),);
    }

    #[test]
    fn rejects_unknown_agents() {
        let participants = vec![participant("peer-a", "peer")];
        let unknown = generate_plan(input(
            CollaborationMode::Group,
            participants.clone(),
            vec!["missing-agent".to_string()],
        ));
        assert!(unknown.is_err());
    }

    #[test]
    fn rejects_excessive_agent_budget() {
        let participants = vec![participant("peer-a", "peer")];
        let mut excessive = input(CollaborationMode::Group, participants, Vec::new());
        excessive.max_agent_calls = Some(MAX_AGENT_CALLS + 1);
        assert!(matches!(
            generate_plan(excessive),
            Err(CollaborationSessionError::Validation(_))
        ));
    }

    #[test]
    fn allows_valid_agent_budget() {
        let participants = vec![participant("peer-a", "peer")];
        let mut valid = input(CollaborationMode::Group, participants, Vec::new());
        valid.max_agent_calls = Some(MAX_AGENT_CALLS);
        assert!(generate_plan(valid).is_ok());
    }
}
