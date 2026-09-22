//! Authoritative collaboration session state and shared context persistence.

use std::fmt;

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use utoipa::ToSchema;

use crate::user_data_db::get_user_data_db;

/// Acquire the user-data DB lock, mapping a poisoned mutex to a validation
/// error instead of panicking. The macro expands to a `let db = ...` binding
/// in the caller's scope (keeping the Arc alive) plus the guard assignment.
///
/// Usage:
/// ```ignore
/// lock_db!(connection);          // immutable guard
/// lock_db!(mut connection);      // mutable binding (if needed for later mutations)
/// ```
macro_rules! lock_db {
    ($guard:ident) => {
        let db = get_user_data_db();
        let $guard = db.lock().map_err(|poisoned| {
            CollaborationSessionError::Validation(format!("Database lock poisoned: {}", poisoned))
        })?;
    };
    (mut $guard:ident) => {
        let db = get_user_data_db();
        let mut $guard = db.lock().map_err(|poisoned| {
            CollaborationSessionError::Validation(format!("Database lock poisoned: {}", poisoned))
        })?;
    };
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum CollaborationMode {
    Supervisor,
    Group,
}

impl CollaborationMode {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Supervisor => "supervisor",
            Self::Group => "group",
        }
    }

    pub fn parse(value: &str) -> Result<Self, CollaborationSessionError> {
        match value {
            "supervisor" => Ok(Self::Supervisor),
            "group" => Ok(Self::Group),
            _ => Err(CollaborationSessionError::Validation(format!(
                "Unknown collaboration mode: {value}"
            ))),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum SessionState {
    Idle,
    Planning,
    Executing,
    WaitingInput,
    WaitingApproval,
    Synthesizing,
    Completed,
    Failed,
    Cancelled,
}

impl SessionState {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Idle => "idle",
            Self::Planning => "planning",
            Self::Executing => "executing",
            Self::WaitingInput => "waiting_input",
            Self::WaitingApproval => "waiting_approval",
            Self::Synthesizing => "synthesizing",
            Self::Completed => "completed",
            Self::Failed => "failed",
            Self::Cancelled => "cancelled",
        }
    }

    pub fn parse(value: &str) -> Result<Self, CollaborationSessionError> {
        match value {
            "idle" => Ok(Self::Idle),
            "planning" => Ok(Self::Planning),
            "executing" => Ok(Self::Executing),
            "waiting_input" => Ok(Self::WaitingInput),
            "waiting_approval" => Ok(Self::WaitingApproval),
            "synthesizing" => Ok(Self::Synthesizing),
            "completed" => Ok(Self::Completed),
            "failed" => Ok(Self::Failed),
            "cancelled" => Ok(Self::Cancelled),
            _ => Err(CollaborationSessionError::Validation(format!(
                "Unknown session state: {value}"
            ))),
        }
    }

    pub const fn can_transition_to(self, next: Self) -> bool {
        use SessionState::*;
        matches!(
            (self, next),
            (
                Idle,
                Planning | WaitingInput | Completed | Failed | Cancelled
            ) | (
                Planning,
                Executing | WaitingInput | WaitingApproval | Failed | Cancelled
            ) | (
                Executing,
                WaitingInput | WaitingApproval | Synthesizing | Planning | Failed | Cancelled
            ) | (WaitingInput, Planning | Executing | Failed | Cancelled)
                | (
                    WaitingApproval,
                    Executing | Planning | Synthesizing | Failed | Cancelled
                )
                | (Synthesizing, Completed | Planning | Failed | Cancelled)
                | (Completed | Failed | Cancelled, Planning)
        )
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct CollaborationSessionParticipant {
    pub id: String,
    pub session_id: String,
    pub agent_id: String,
    pub role: String,
    pub status: String,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct CollaborationSession {
    pub id: String,
    pub chat_id: String,
    pub workspace_id: Option<String>,
    pub project_id: Option<String>,
    pub mode: CollaborationMode,
    pub state: SessionState,
    pub goal: Option<String>,
    pub active_plan_revision: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct CollaborationContextEvent {
    pub id: String,
    pub session_id: String,
    pub sequence: i64,
    #[serde(rename = "type")]
    pub event_type: String,
    pub actor_type: String,
    pub actor_id: Option<String>,
    pub payload: Value,
    pub visibility: String,
    pub artifact_refs: Vec<String>,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct CollaborationSessionDetail {
    #[serde(flatten)]
    pub session: CollaborationSession,
    pub participants: Vec<CollaborationSessionParticipant>,
}

#[derive(Debug, Clone, Deserialize, ToSchema)]
pub struct ParticipantInput {
    pub agent_id: String,
    #[serde(default = "default_participant_role")]
    pub role: String,
    #[serde(default = "default_participant_status")]
    pub status: String,
}

#[derive(Debug, Clone, Deserialize, ToSchema)]
pub struct CreateCollaborationSessionRequest {
    pub chat_id: String,
    #[serde(default)]
    pub workspace_id: Option<String>,
    #[serde(default)]
    pub project_id: Option<String>,
    pub mode: CollaborationMode,
    #[serde(default)]
    pub goal: Option<String>,
    #[serde(default)]
    pub participants: Vec<ParticipantInput>,
}

#[derive(Debug, Clone, Deserialize, ToSchema)]
pub struct AppendSessionMessageRequest {
    #[serde(default = "default_actor_type")]
    pub actor_type: String,
    #[serde(default)]
    pub actor_id: Option<String>,
    pub payload: Value,
    #[serde(default)]
    pub artifact_refs: Vec<String>,
    #[serde(default)]
    pub visibility: Option<String>,
}

#[derive(Debug, Clone, Deserialize, ToSchema)]
pub struct SessionStateTransitionRequest {
    pub state: SessionState,
    #[serde(default)]
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct CollaborationPlanRevision {
    pub id: String,
    pub session_id: String,
    pub revision: i64,
    pub status: String,
    pub source_event_id: Option<String>,
    pub dag_snapshot: Value,
    pub summary: Option<String>,
    pub created_at: i64,
}

#[derive(Debug, Clone, Deserialize, ToSchema)]
pub struct CreatePlanRevisionRequest {
    pub dag_snapshot: Value,
    #[serde(default)]
    pub summary: Option<String>,
    #[serde(default)]
    pub source_event_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct PlanRevisionCreated {
    #[serde(flatten)]
    pub session: CollaborationSessionDetail,
    pub plan_revision: CollaborationPlanRevision,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum ApprovalStatus {
    Pending,
    Approved,
    Rejected,
    Cancelled,
}

impl ApprovalStatus {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Approved => "approved",
            Self::Rejected => "rejected",
            Self::Cancelled => "cancelled",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct CollaborationApproval {
    pub id: String,
    pub session_id: String,
    pub plan_revision_id: Option<String>,
    pub node_id: Option<String>,
    pub kind: String,
    pub request: Value,
    pub status: ApprovalStatus,
    pub decided_by: Option<String>,
    pub decision_payload: Value,
    pub created_at: i64,
    pub decided_at: Option<i64>,
}

#[derive(Debug, Clone, Deserialize, ToSchema)]
pub struct CreateApprovalRequest {
    pub kind: String,
    #[serde(default)]
    pub node_id: Option<String>,
    #[serde(default)]
    pub plan_revision_id: Option<String>,
    #[serde(default)]
    pub request: Value,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum ApprovalDecision {
    Approve,
    Reject,
}

impl ApprovalDecision {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Approve => "approve",
            Self::Reject => "reject",
        }
    }
}

#[derive(Debug, Clone, Deserialize, ToSchema)]
pub struct ApprovalDecisionRequest {
    pub decision: ApprovalDecision,
    #[serde(default)]
    pub decided_by: Option<String>,
    #[serde(default)]
    pub decision_payload: Value,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct ApprovalDecisionResult {
    #[serde(flatten)]
    pub session: CollaborationSessionDetail,
    pub approval: CollaborationApproval,
}

#[derive(Debug)]
pub enum CollaborationSessionError {
    Validation(String),
    NotFound(String),
    InvalidTransition {
        from: SessionState,
        to: SessionState,
    },
    Database(rusqlite::Error),
    Serialization(serde_json::Error),
}

impl fmt::Display for CollaborationSessionError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Validation(message) => write!(formatter, "{message}"),
            Self::NotFound(message) => write!(formatter, "{message}"),
            Self::InvalidTransition { from, to } => write!(
                formatter,
                "Invalid collaboration state transition from {} to {}",
                from.as_str(),
                to.as_str()
            ),
            Self::Database(error) => write!(formatter, "Collaboration database error: {error}"),
            Self::Serialization(error) => {
                write!(formatter, "Collaboration serialization error: {error}")
            }
        }
    }
}

impl std::error::Error for CollaborationSessionError {}

impl From<rusqlite::Error> for CollaborationSessionError {
    fn from(error: rusqlite::Error) -> Self {
        Self::Database(error)
    }
}

impl From<serde_json::Error> for CollaborationSessionError {
    fn from(error: serde_json::Error) -> Self {
        Self::Serialization(error)
    }
}

fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}

fn default_participant_role() -> String {
    "peer".to_string()
}

fn default_participant_status() -> String {
    "ready".to_string()
}

fn default_actor_type() -> String {
    "user".to_string()
}

fn validate_actor_type(value: &str) -> Result<(), CollaborationSessionError> {
    if matches!(value, "user" | "agent" | "system") {
        Ok(())
    } else {
        Err(CollaborationSessionError::Validation(
            "actor_type must be user, agent, or system".to_string(),
        ))
    }
}

fn validate_visibility(value: &str) -> Result<(), CollaborationSessionError> {
    if matches!(value, "shared" | "private" | "system") {
        Ok(())
    } else {
        Err(CollaborationSessionError::Validation(
            "visibility must be shared, private, or system".to_string(),
        ))
    }
}

fn session_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<CollaborationSession> {
    let mode = row.get::<_, String>(4)?;
    let state = row.get::<_, String>(5)?;
    Ok(CollaborationSession {
        id: row.get(0)?,
        chat_id: row.get(1)?,
        workspace_id: row.get(2)?,
        project_id: row.get(3)?,
        mode: CollaborationMode::parse(&mode).map_err(|_| {
            rusqlite::Error::FromSqlConversionFailure(4, rusqlite::types::Type::Text, mode.into())
        })?,
        state: SessionState::parse(&state).map_err(|_| {
            rusqlite::Error::FromSqlConversionFailure(5, rusqlite::types::Type::Text, state.into())
        })?,
        goal: row.get(6)?,
        active_plan_revision: row.get(7)?,
        created_at: row.get(8)?,
        updated_at: row.get(9)?,
    })
}

const SESSION_COLUMNS: &str = "id, chat_id, workspace_id, project_id, mode, state, goal, active_plan_revision, created_at, updated_at";

fn participant_from_row(
    row: &rusqlite::Row<'_>,
) -> rusqlite::Result<CollaborationSessionParticipant> {
    Ok(CollaborationSessionParticipant {
        id: row.get(0)?,
        session_id: row.get(1)?,
        agent_id: row.get(2)?,
        role: row.get(3)?,
        status: row.get(4)?,
        created_at: row.get(5)?,
        updated_at: row.get(6)?,
    })
}

const PARTICIPANT_COLUMNS: &str = "id, session_id, agent_id, role, status, created_at, updated_at";

fn context_event_from_row(
    row: &rusqlite::Row<'_>,
) -> Result<CollaborationContextEvent, CollaborationSessionError> {
    Ok(CollaborationContextEvent {
        id: row.get(0)?,
        session_id: row.get(1)?,
        sequence: row.get(2)?,
        event_type: row.get(3)?,
        actor_type: row.get(4)?,
        actor_id: row.get(5)?,
        payload: serde_json::from_str(&row.get::<_, String>(6)?)?,
        visibility: row.get(7)?,
        artifact_refs: serde_json::from_str(&row.get::<_, String>(8)?)?,
        created_at: row.get(9)?,
    })
}

const CONTEXT_EVENT_COLUMNS: &str =
    "id, session_id, sequence, type, actor_type, actor_id, payload, visibility, artifact_refs, created_at";

fn plan_revision_from_row(
    row: &rusqlite::Row<'_>,
) -> Result<CollaborationPlanRevision, CollaborationSessionError> {
    Ok(CollaborationPlanRevision {
        id: row.get(0)?,
        session_id: row.get(1)?,
        revision: row.get(2)?,
        status: row.get(3)?,
        source_event_id: row.get(4)?,
        dag_snapshot: serde_json::from_str(&row.get::<_, String>(5)?)?,
        summary: row.get(6)?,
        created_at: row.get(7)?,
    })
}

const PLAN_REVISION_COLUMNS: &str =
    "id, session_id, revision, status, source_event_id, dag_snapshot, summary, created_at";

fn approval_from_row(
    row: &rusqlite::Row<'_>,
) -> Result<CollaborationApproval, CollaborationSessionError> {
    let status = row.get::<_, String>(6)?;
    let status = match status.as_str() {
        "pending" => ApprovalStatus::Pending,
        "approved" => ApprovalStatus::Approved,
        "rejected" => ApprovalStatus::Rejected,
        "cancelled" => ApprovalStatus::Cancelled,
        _ => {
            return Err(CollaborationSessionError::Validation(format!(
                "Unknown approval status: {status}"
            )))
        }
    };
    Ok(CollaborationApproval {
        id: row.get(0)?,
        session_id: row.get(1)?,
        plan_revision_id: row.get(2)?,
        node_id: row.get(3)?,
        kind: row.get(4)?,
        request: serde_json::from_str(&row.get::<_, String>(5)?)?,
        status,
        decided_by: row.get(7)?,
        decision_payload: serde_json::from_str(&row.get::<_, String>(8)?)?,
        created_at: row.get(9)?,
        decided_at: row.get(10)?,
    })
}

const APPROVAL_COLUMNS: &str = "id, session_id, plan_revision_id, node_id, kind, request, status, decided_by, decision_payload, created_at, decided_at";

fn insert_participant(
    transaction: &rusqlite::Transaction<'_>,
    session_id: &str,
    participant: &ParticipantInput,
    timestamp: i64,
) -> Result<(), CollaborationSessionError> {
    if participant.agent_id.trim().is_empty() {
        return Err(CollaborationSessionError::Validation(
            "participant agent_id cannot be empty".to_string(),
        ));
    }
    transaction.execute(
        "INSERT INTO collaboration_session_participants
         (id, session_id, agent_id, role, status, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT(session_id, agent_id) DO UPDATE SET
           role = excluded.role,
           status = excluded.status,
           updated_at = excluded.updated_at",
        params![
            format!("part-{}", uuid::Uuid::new_v4().as_simple()),
            session_id,
            participant.agent_id.trim(),
            participant.role,
            participant.status,
            timestamp,
            timestamp,
        ],
    )?;
    Ok(())
}

struct NewContextEvent<'a> {
    event_type: &'a str,
    actor_type: &'a str,
    actor_id: Option<&'a str>,
    payload: &'a Value,
    visibility: &'a str,
    artifact_refs: &'a [String],
}

fn append_event_in_transaction(
    transaction: &rusqlite::Transaction<'_>,
    session_id: &str,
    draft: NewContextEvent<'_>,
) -> Result<CollaborationContextEvent, CollaborationSessionError> {
    validate_actor_type(draft.actor_type)?;
    validate_visibility(draft.visibility)?;
    let sequence: i64 = transaction.query_row(
        "SELECT COALESCE(MAX(sequence), 0) + 1 FROM collaboration_context_events WHERE session_id = ?1",
        params![session_id],
        |row| row.get(0),
    )?;
    let timestamp = now();
    let event = CollaborationContextEvent {
        id: format!("evt-{}", uuid::Uuid::new_v4().as_simple()),
        session_id: session_id.to_string(),
        sequence,
        event_type: draft.event_type.to_string(),
        actor_type: draft.actor_type.to_string(),
        actor_id: draft.actor_id.map(str::to_string),
        payload: draft.payload.clone(),
        visibility: draft.visibility.to_string(),
        artifact_refs: draft.artifact_refs.to_vec(),
        created_at: timestamp,
    };
    transaction.execute(
        "INSERT INTO collaboration_context_events
         (id, session_id, sequence, type, actor_type, actor_id, payload, visibility, artifact_refs, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
        params![
            event.id,
            event.session_id,
            event.sequence,
            event.event_type,
            event.actor_type,
            event.actor_id,
            serde_json::to_string(&event.payload)?,
            event.visibility,
            serde_json::to_string(&event.artifact_refs)?,
            event.created_at,
        ],
    )?;
    Ok(event)
}

fn load_participants(
    connection: &Connection,
    session_id: &str,
) -> Result<Vec<CollaborationSessionParticipant>, CollaborationSessionError> {
    let mut statement = connection.prepare(&format!(
        "SELECT {PARTICIPANT_COLUMNS} FROM collaboration_session_participants WHERE session_id = ?1 ORDER BY created_at ASC"
    ))?;
    let participants = statement
        .query_map(params![session_id], participant_from_row)?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(participants)
}

fn get_session_with_connection(
    connection: &Connection,
    session_id: &str,
) -> Result<Option<CollaborationSession>, CollaborationSessionError> {
    let mut statement = connection.prepare(&format!(
        "SELECT {SESSION_COLUMNS} FROM collaboration_sessions WHERE id = ?1"
    ))?;
    let session = statement
        .query_row(params![session_id], session_from_row)
        .optional()?;
    Ok(session)
}

pub fn create_session(
    request: CreateCollaborationSessionRequest,
) -> Result<CollaborationSessionDetail, CollaborationSessionError> {
    if request.chat_id.trim().is_empty() {
        return Err(CollaborationSessionError::Validation(
            "chat_id cannot be empty".to_string(),
        ));
    }
    let chat_id = request.chat_id.trim().to_string();
    if let Some(existing) = find_session_by_chat(&chat_id)? {
        lock_db!(connection);
        return Ok(CollaborationSessionDetail {
            participants: load_participants(&connection, &existing.id)?,
            session: existing,
        });
    }

    let timestamp = now();
    let session_id = format!("collab-{}", uuid::Uuid::new_v4().as_simple());
    {
        lock_db!(mut connection);
        let transaction = connection.transaction()?;
        transaction.execute(
            &format!(
                "INSERT INTO collaboration_sessions ({SESSION_COLUMNS})
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)"
            ),
            params![
                session_id,
                chat_id,
                request.workspace_id,
                request.project_id,
                request.mode.as_str(),
                SessionState::Idle.as_str(),
                request.goal,
                Option::<String>::None,
                timestamp,
                timestamp,
            ],
        )?;
        for participant in &request.participants {
            insert_participant(&transaction, &session_id, participant, timestamp)?;
        }
        append_event_in_transaction(
            &transaction,
            &session_id,
            NewContextEvent {
                event_type: "session_created",
                actor_type: "system",
                actor_id: None,
                payload: &serde_json::json!({
                "chatId": chat_id,
                "mode": request.mode.as_str(),
                }),
                visibility: "system",
                artifact_refs: &[],
            },
        )?;
        transaction.commit()?;
    }

    lock_db!(connection);
    let session = get_session_with_connection(&connection, &session_id)?.ok_or_else(|| {
        CollaborationSessionError::NotFound("Session disappeared after creation".to_string())
    })?;
    Ok(CollaborationSessionDetail {
        participants: load_participants(&connection, &session_id)?,
        session,
    })
}

pub fn find_session_by_chat(
    chat_id: &str,
) -> Result<Option<CollaborationSession>, CollaborationSessionError> {
    lock_db!(connection);
    let mut statement = connection.prepare(&format!(
        "SELECT {SESSION_COLUMNS} FROM collaboration_sessions WHERE chat_id = ?1"
    ))?;
    let session = statement
        .query_row(params![chat_id], session_from_row)
        .optional()?;
    Ok(session)
}

pub fn get_session(
    session_id: &str,
) -> Result<CollaborationSessionDetail, CollaborationSessionError> {
    lock_db!(connection);
    let session = get_session_with_connection(&connection, session_id)?.ok_or_else(|| {
        CollaborationSessionError::NotFound("Collaboration session not found".to_string())
    })?;
    let participants = load_participants(&connection, session_id)?;
    Ok(CollaborationSessionDetail {
        session,
        participants,
    })
}

pub fn append_message(
    session_id: &str,
    request: AppendSessionMessageRequest,
) -> Result<CollaborationSessionDetail, CollaborationSessionError> {
    lock_db!(mut connection);
    let current = get_session_with_connection(&connection, session_id)?.ok_or_else(|| {
        CollaborationSessionError::NotFound("Collaboration session not found".to_string())
    })?;
    if matches!(
        current.state,
        SessionState::Failed | SessionState::Cancelled
    ) {
        return Err(CollaborationSessionError::InvalidTransition {
            from: current.state,
            to: SessionState::Planning,
        });
    }

    let transaction = connection.transaction()?;
    append_event_in_transaction(
        &transaction,
        session_id,
        NewContextEvent {
            event_type: if request.actor_type == "user" {
                "user_message_added"
            } else {
                "message_added"
            },
            actor_type: &request.actor_type,
            actor_id: request.actor_id.as_deref(),
            payload: &request.payload,
            visibility: request.visibility.as_deref().unwrap_or("shared"),
            artifact_refs: &request.artifact_refs,
        },
    )?;
    if matches!(current.state, SessionState::Idle | SessionState::Completed) {
        transaction.execute(
            "UPDATE collaboration_sessions SET state = ?1, updated_at = ?2 WHERE id = ?3",
            params![SessionState::Planning.as_str(), now(), session_id],
        )?;
    }
    transaction.commit()?;

    drop(connection);
    get_session(session_id)
}

pub fn append_context_event(
    session_id: &str,
    event_type: &str,
    actor_type: &str,
    actor_id: Option<&str>,
    payload: &Value,
    visibility: &str,
    artifact_refs: &[String],
) -> Result<CollaborationContextEvent, CollaborationSessionError> {
    lock_db!(mut connection);
    if get_session_with_connection(&connection, session_id)?.is_none() {
        return Err(CollaborationSessionError::NotFound(
            "Collaboration session not found".to_string(),
        ));
    }

    let transaction = connection.transaction()?;
    let event = append_event_in_transaction(
        &transaction,
        session_id,
        NewContextEvent {
            event_type,
            actor_type,
            actor_id,
            payload,
            visibility,
            artifact_refs,
        },
    )?;
    transaction.commit()?;
    Ok(event)
}

pub fn transition_state(
    session_id: &str,
    request: SessionStateTransitionRequest,
) -> Result<CollaborationSessionDetail, CollaborationSessionError> {
    lock_db!(mut connection);
    let current = get_session_with_connection(&connection, session_id)?.ok_or_else(|| {
        CollaborationSessionError::NotFound("Collaboration session not found".to_string())
    })?;
    if !current.state.can_transition_to(request.state) {
        return Err(CollaborationSessionError::InvalidTransition {
            from: current.state,
            to: request.state,
        });
    }
    let transaction = connection.transaction()?;
    append_event_in_transaction(
        &transaction,
        session_id,
        NewContextEvent {
            event_type: "session_state_changed",
            actor_type: "system",
            actor_id: None,
            payload: &serde_json::json!({
            "from": current.state.as_str(),
            "to": request.state.as_str(),
            "reason": request.reason,
            }),
            visibility: "system",
            artifact_refs: &[],
        },
    )?;
    transaction.execute(
        "UPDATE collaboration_sessions SET state = ?1, updated_at = ?2 WHERE id = ?3",
        params![request.state.as_str(), now(), session_id],
    )?;
    transaction.commit()?;
    drop(connection);
    get_session(session_id)
}

pub fn list_events(
    session_id: &str,
    after_sequence: Option<i64>,
    limit: usize,
) -> Result<Vec<CollaborationContextEvent>, CollaborationSessionError> {
    lock_db!(connection);
    if get_session_with_connection(&connection, session_id)?.is_none() {
        return Err(CollaborationSessionError::NotFound(
            "Collaboration session not found".to_string(),
        ));
    }
    let limit = limit.clamp(1, 500);
    let mut statement = connection.prepare(&format!(
        "SELECT {CONTEXT_EVENT_COLUMNS} FROM collaboration_context_events
         WHERE session_id = ?1 AND sequence > ?2 ORDER BY sequence ASC LIMIT ?3"
    ))?;
    let events = statement
        .query_map(
            params![session_id, after_sequence.unwrap_or(0), limit as i64],
            |row| {
                context_event_from_row(row)
                    .map_err(|error| rusqlite::Error::ToSqlConversionFailure(error.into()))
            },
        )?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(events)
}

pub fn latest_context_event(
    session_id: &str,
) -> Result<Option<CollaborationContextEvent>, CollaborationSessionError> {
    lock_db!(connection);
    if get_session_with_connection(&connection, session_id)?.is_none() {
        return Err(CollaborationSessionError::NotFound(
            "Collaboration session not found".to_string(),
        ));
    }
    let mut statement = connection.prepare(&format!(
        "SELECT {CONTEXT_EVENT_COLUMNS} FROM collaboration_context_events
         WHERE session_id = ?1 ORDER BY sequence DESC LIMIT 1"
    ))?;
    statement
        .query_row(params![session_id], |row| {
            context_event_from_row(row)
                .map_err(|error| rusqlite::Error::ToSqlConversionFailure(error.into()))
        })
        .optional()
        .map_err(CollaborationSessionError::from)
}

pub fn create_plan_revision(
    session_id: &str,
    request: CreatePlanRevisionRequest,
) -> Result<PlanRevisionCreated, CollaborationSessionError> {
    if !request.dag_snapshot.is_object() {
        return Err(CollaborationSessionError::Validation(
            "dag_snapshot must be a JSON object".to_string(),
        ));
    }

    lock_db!(mut connection);
    let current = get_session_with_connection(&connection, session_id)?.ok_or_else(|| {
        CollaborationSessionError::NotFound("Collaboration session not found".to_string())
    })?;
    if !matches!(
        current.state,
        SessionState::Idle | SessionState::Planning | SessionState::Executing
    ) {
        return Err(CollaborationSessionError::Validation(
            "A plan revision can only be created while idle, planning, or executing".to_string(),
        ));
    }

    let mut dag_snapshot = request.dag_snapshot.clone();
    if let Some(workspace_id) = dag_snapshot.get("workspace_id") {
        if workspace_id.as_str() != current.workspace_id.as_deref() {
            return Err(CollaborationSessionError::Validation(
                "Plan workspace boundary does not match the session".to_string(),
            ));
        }
    }
    if let Some(project_id) = dag_snapshot.get("project_id") {
        if project_id.as_str() != current.project_id.as_deref() {
            return Err(CollaborationSessionError::Validation(
                "Plan project boundary does not match the session".to_string(),
            ));
        }
    }
    if let Some(snapshot) = dag_snapshot.as_object_mut() {
        snapshot.insert(
            "workspace_id".to_string(),
            current
                .workspace_id
                .clone()
                .map(serde_json::Value::String)
                .unwrap_or(serde_json::Value::Null),
        );
        snapshot.insert(
            "project_id".to_string(),
            current
                .project_id
                .clone()
                .map(serde_json::Value::String)
                .unwrap_or(serde_json::Value::Null),
        );
    }

    let transaction = connection.transaction()?;
    let previous_plan_id: Option<String> = transaction
        .query_row(
            "SELECT id FROM collaboration_plan_revisions
             WHERE session_id = ?1 AND status = 'active'
             ORDER BY created_at DESC LIMIT 1",
            params![session_id],
            |row| row.get(0),
        )
        .optional()?;
    if let Some(previous_plan_id) = previous_plan_id {
        let mut statement = transaction.prepare(
            "SELECT payload FROM collaboration_context_events
             WHERE session_id = ?1 AND type = 'task_completed'
             ORDER BY sequence ASC",
        )?;
        let completed = statement
            .query_map(params![session_id], |row| row.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?;
        drop(statement);
        let preserved_outputs = completed
            .iter()
            .filter_map(|payload| serde_json::from_str::<Value>(payload).ok())
            .filter(|payload| {
                payload.get("planRevisionId").and_then(Value::as_str)
                    == Some(previous_plan_id.as_str())
            })
            .map(|payload| {
                json!({
                    "node_id": payload.get("nodeId").cloned().unwrap_or(Value::Null),
                    "agent": payload.get("agent").cloned().unwrap_or(Value::Null),
                    "result_path": payload.get("resultPath").cloned().unwrap_or(Value::Null),
                    "summary": payload.get("summary").cloned().unwrap_or(Value::Null),
                })
            })
            .collect::<Vec<_>>();
        if !preserved_outputs.is_empty() {
            if let Some(snapshot) = dag_snapshot.as_object_mut() {
                snapshot.insert(
                    "preserved_outputs".to_string(),
                    Value::Array(preserved_outputs),
                );
            }
        }
    }

    let revision: i64 = transaction.query_row(
        "SELECT COALESCE(MAX(revision), 0) + 1 FROM collaboration_plan_revisions WHERE session_id = ?1",
        params![session_id],
        |row| row.get(0),
    )?;
    let timestamp = now();
    let plan_id = format!("plan-{}", uuid::Uuid::new_v4().as_simple());
    transaction.execute(
        &format!(
            "INSERT INTO collaboration_plan_revisions ({PLAN_REVISION_COLUMNS})
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)"
        ),
        params![
            plan_id,
            session_id,
            revision,
            "active",
            request.source_event_id,
            serde_json::to_string(&dag_snapshot)?,
            request.summary,
            timestamp,
        ],
    )?;
    transaction.execute(
        "UPDATE collaboration_plan_revisions
         SET status = 'superseded'
         WHERE session_id = ?1 AND id != ?2 AND status = 'active'",
        params![session_id, plan_id],
    )?;
    let next_state = if matches!(current.state, SessionState::Idle) {
        Some(SessionState::Planning)
    } else {
        None
    };
    append_event_in_transaction(
        &transaction,
        session_id,
        NewContextEvent {
            event_type: "plan_revision_created",
            actor_type: "system",
            actor_id: None,
            payload: &serde_json::json!({
                "planRevisionId": plan_id,
                "revision": revision,
                "summary": request.summary,
                "nextState": next_state.map(SessionState::as_str),
            }),
            visibility: "system",
            artifact_refs: &[],
        },
    )?;
    transaction.execute(
        "UPDATE collaboration_sessions
         SET active_plan_revision = ?1, state = COALESCE(?2, state), updated_at = ?3
         WHERE id = ?4",
        params![
            plan_id,
            next_state.map(SessionState::as_str),
            now(),
            session_id
        ],
    )?;
    transaction.commit()?;
    drop(connection);

    let session = get_session(session_id)?;

    lock_db!(connection);
    let mut statement = connection.prepare(&format!(
        "SELECT {PLAN_REVISION_COLUMNS} FROM collaboration_plan_revisions WHERE id = ?1"
    ))?;
    let plan_revision = statement
        .query_row(params![plan_id], |row| {
            plan_revision_from_row(row)
                .map_err(|error| rusqlite::Error::ToSqlConversionFailure(error.into()))
        })
        .map_err(CollaborationSessionError::from)?;
    Ok(PlanRevisionCreated {
        session,
        plan_revision,
    })
}

pub fn list_plan_revisions(
    session_id: &str,
) -> Result<Vec<CollaborationPlanRevision>, CollaborationSessionError> {
    lock_db!(connection);
    if get_session_with_connection(&connection, session_id)?.is_none() {
        return Err(CollaborationSessionError::NotFound(
            "Collaboration session not found".to_string(),
        ));
    }
    let mut statement = connection.prepare(&format!(
        "SELECT {PLAN_REVISION_COLUMNS} FROM collaboration_plan_revisions
         WHERE session_id = ?1 ORDER BY revision DESC"
    ))?;
    let revisions = statement
        .query_map(params![session_id], |row| {
            plan_revision_from_row(row)
                .map_err(|error| rusqlite::Error::ToSqlConversionFailure(error.into()))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(revisions)
}

pub fn get_plan_revision(
    session_id: &str,
    plan_revision_id: &str,
) -> Result<CollaborationPlanRevision, CollaborationSessionError> {
    lock_db!(connection);
    let mut statement = connection.prepare(&format!(
        "SELECT {PLAN_REVISION_COLUMNS} FROM collaboration_plan_revisions
         WHERE session_id = ?1 AND id = ?2"
    ))?;
    statement
        .query_row(params![session_id, plan_revision_id], |row| {
            plan_revision_from_row(row)
                .map_err(|error| rusqlite::Error::ToSqlConversionFailure(error.into()))
        })
        .optional()?
        .ok_or_else(|| {
            CollaborationSessionError::NotFound("Collaboration plan revision not found".to_string())
        })
}

pub fn create_approval(
    session_id: &str,
    request: CreateApprovalRequest,
) -> Result<ApprovalDecisionResult, CollaborationSessionError> {
    if request.kind.trim().is_empty() {
        return Err(CollaborationSessionError::Validation(
            "approval kind cannot be empty".to_string(),
        ));
    }

    lock_db!(mut connection);
    let current = get_session_with_connection(&connection, session_id)?.ok_or_else(|| {
        CollaborationSessionError::NotFound("Collaboration session not found".to_string())
    })?;
    if current.state != SessionState::Executing {
        return Err(CollaborationSessionError::Validation(
            "Approvals can only be requested while executing".to_string(),
        ));
    }

    let timestamp = now();
    let approval_id = format!("approval-{}", uuid::Uuid::new_v4().as_simple());
    let transaction = connection.transaction()?;
    transaction.execute(
        &format!(
            "INSERT INTO collaboration_approvals ({APPROVAL_COLUMNS})
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)"
        ),
        params![
            approval_id,
            session_id,
            request
                .plan_revision_id
                .or(current.active_plan_revision.clone()),
            request.node_id,
            request.kind,
            serde_json::to_string(&request.request)?,
            ApprovalStatus::Pending.as_str(),
            Option::<String>::None,
            serde_json::to_string(&Value::Null)?,
            timestamp,
            Option::<i64>::None,
        ],
    )?;
    append_event_in_transaction(
        &transaction,
        session_id,
        NewContextEvent {
            event_type: "approval_required",
            actor_type: "system",
            actor_id: None,
            payload: &serde_json::json!({
                "approvalId": approval_id,
                "kind": request.kind,
                "nodeId": request.node_id,
                "request": request.request,
            }),
            visibility: "system",
            artifact_refs: &[],
        },
    )?;
    transaction.execute(
        "UPDATE collaboration_sessions SET state = ?1, updated_at = ?2 WHERE id = ?3",
        params![SessionState::WaitingApproval.as_str(), now(), session_id],
    )?;
    transaction.commit()?;
    drop(connection);

    let session = get_session(session_id)?;
    let approval = get_approval(&approval_id)?;
    Ok(ApprovalDecisionResult { session, approval })
}

fn get_approval(approval_id: &str) -> Result<CollaborationApproval, CollaborationSessionError> {
    lock_db!(connection);
    let mut statement = connection.prepare(&format!(
        "SELECT {APPROVAL_COLUMNS} FROM collaboration_approvals WHERE id = ?1"
    ))?;
    statement
        .query_row(params![approval_id], |row| {
            approval_from_row(row)
                .map_err(|error| rusqlite::Error::ToSqlConversionFailure(error.into()))
        })
        .map_err(CollaborationSessionError::from)
}

pub fn decide_approval(
    session_id: &str,
    approval_id: &str,
    request: ApprovalDecisionRequest,
) -> Result<ApprovalDecisionResult, CollaborationSessionError> {
    lock_db!(mut connection);
    let current = get_session_with_connection(&connection, session_id)?.ok_or_else(|| {
        CollaborationSessionError::NotFound("Collaboration session not found".to_string())
    })?;
    let approval = {
        let mut statement = connection.prepare(&format!(
            "SELECT {APPROVAL_COLUMNS} FROM collaboration_approvals WHERE id = ?1 AND session_id = ?2"
        ))?;
        statement
            .query_row(params![approval_id, session_id], |row| {
                approval_from_row(row)
                    .map_err(|error| rusqlite::Error::ToSqlConversionFailure(error.into()))
            })
            .optional()?
            .ok_or_else(|| {
                CollaborationSessionError::NotFound("Collaboration approval not found".to_string())
            })?
    };
    if current.state != SessionState::WaitingApproval || approval.status != ApprovalStatus::Pending
    {
        return Err(CollaborationSessionError::Validation(
            "Approval is no longer pending or session is not waiting for approval".to_string(),
        ));
    }

    let next_state = match request.decision {
        ApprovalDecision::Approve => SessionState::Executing,
        ApprovalDecision::Reject => SessionState::Planning,
    };
    let status = match request.decision {
        ApprovalDecision::Approve => ApprovalStatus::Approved,
        ApprovalDecision::Reject => ApprovalStatus::Rejected,
    };
    let timestamp = now();
    let transaction = connection.transaction()?;
    transaction.execute(
        "UPDATE collaboration_approvals
         SET status = ?1, decided_by = ?2, decision_payload = ?3, decided_at = ?4
         WHERE id = ?5 AND session_id = ?6",
        params![
            status.as_str(),
            request.decided_by,
            serde_json::to_string(&request.decision_payload)?,
            timestamp,
            approval_id,
            session_id,
        ],
    )?;
    append_event_in_transaction(
        &transaction,
        session_id,
        NewContextEvent {
            event_type: match request.decision {
                ApprovalDecision::Approve => "approval_granted",
                ApprovalDecision::Reject => "approval_rejected",
            },
            actor_type: "user",
            actor_id: request.decided_by.as_deref(),
            payload: &serde_json::json!({
                "approvalId": approval_id,
                "decision": request.decision.as_str(),
                "decisionPayload": request.decision_payload,
            }),
            visibility: "system",
            artifact_refs: &[],
        },
    )?;
    transaction.execute(
        "UPDATE collaboration_sessions SET state = ?1, updated_at = ?2 WHERE id = ?3",
        params![next_state.as_str(), now(), session_id],
    )?;
    transaction.commit()?;
    drop(connection);

    let session = get_session(session_id)?;
    let approval = get_approval(approval_id)?;
    Ok(ApprovalDecisionResult { session, approval })
}

pub fn cancel_session(
    session_id: &str,
    reason: Option<String>,
) -> Result<CollaborationSessionDetail, CollaborationSessionError> {
    lock_db!(mut connection);
    let current = get_session_with_connection(&connection, session_id)?.ok_or_else(|| {
        CollaborationSessionError::NotFound("Collaboration session not found".to_string())
    })?;
    if matches!(
        current.state,
        SessionState::Idle
            | SessionState::Completed
            | SessionState::Failed
            | SessionState::Cancelled
    ) {
        return Err(CollaborationSessionError::Validation(
            "Session has no running work to cancel".to_string(),
        ));
    }
    let transaction = connection.transaction()?;
    transaction.execute(
        "UPDATE collaboration_approvals
         SET status = ?1, decided_at = ?2
         WHERE session_id = ?3 AND status = ?4",
        params![
            ApprovalStatus::Cancelled.as_str(),
            now(),
            session_id,
            ApprovalStatus::Pending.as_str(),
        ],
    )?;
    append_event_in_transaction(
        &transaction,
        session_id,
        NewContextEvent {
            event_type: "session_cancelled",
            actor_type: "system",
            actor_id: None,
            payload: &serde_json::json!({ "reason": reason }),
            visibility: "system",
            artifact_refs: &[],
        },
    )?;
    transaction.execute(
        "UPDATE collaboration_sessions SET state = ?1, updated_at = ?2 WHERE id = ?3",
        params![SessionState::Cancelled.as_str(), now(), session_id],
    )?;
    transaction.commit()?;
    drop(connection);
    get_session(session_id)
}

const ACTIVE_SESSION_STATES_SQL: &str =
    "'planning', 'executing', 'waiting_input', 'waiting_approval', 'synthesizing'";

pub fn list_active_sessions() -> Result<Vec<CollaborationSessionDetail>, CollaborationSessionError>
{
    lock_db!(connection);
    let mut statement = connection.prepare(&format!(
        "SELECT {SESSION_COLUMNS} FROM collaboration_sessions
         WHERE state IN ({ACTIVE_SESSION_STATES_SQL})
         ORDER BY updated_at DESC"
    ))?;
    let sessions = statement
        .query_map([], session_from_row)?
        .collect::<Result<Vec<_>, _>>()?;
    sessions
        .into_iter()
        .map(|session| {
            let participants = load_participants(&connection, &session.id)?;
            Ok(CollaborationSessionDetail {
                session,
                participants,
            })
        })
        .collect()
}

pub fn list_active_plan_revisions(
) -> Result<Vec<CollaborationPlanRevision>, CollaborationSessionError> {
    lock_db!(connection);
    let mut statement = connection.prepare(&format!(
        "SELECT {PLAN_REVISION_COLUMNS} FROM collaboration_plan_revisions
         WHERE status = 'active'
           AND session_id IN (
             SELECT id FROM collaboration_sessions
             WHERE state IN ({ACTIVE_SESSION_STATES_SQL})
           )
         ORDER BY created_at DESC"
    ))?;
    let revisions = statement
        .query_map([], |row| {
            plan_revision_from_row(row)
                .map_err(|error| rusqlite::Error::ToSqlConversionFailure(error.into()))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(revisions)
}

pub fn list_pending_approvals() -> Result<Vec<CollaborationApproval>, CollaborationSessionError> {
    lock_db!(connection);
    let mut statement = connection.prepare(&format!(
        "SELECT {APPROVAL_COLUMNS} FROM collaboration_approvals
         WHERE status = 'pending'
           AND session_id IN (
             SELECT id FROM collaboration_sessions
             WHERE state IN ({ACTIVE_SESSION_STATES_SQL})
           )
         ORDER BY created_at DESC"
    ))?;
    let approvals = statement
        .query_map([], |row| {
            approval_from_row(row)
                .map_err(|error| rusqlite::Error::ToSqlConversionFailure(error.into()))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(approvals)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn state_machine_rejects_invalid_transitions() {
        assert!(SessionState::Idle.can_transition_to(SessionState::Planning));
        assert!(SessionState::Executing.can_transition_to(SessionState::WaitingApproval));
        assert!(!SessionState::Idle.can_transition_to(SessionState::Synthesizing));
        assert!(!SessionState::Cancelled.can_transition_to(SessionState::Executing));
    }
}
