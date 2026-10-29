//! Durable scheduler for the first prompt of a new chat conversation.
//!
//! `chats.create` may persist an initial user message before the conversation
//! UI is mounted.  That message must be turned into exactly one agent turn,
//! even if the frontend reloads or the backend restarts.  This module owns the
//! pending/dispatching/running lifecycle and deliberately keeps it out of the
//! frontend message list.

use std::time::Duration;

use anyhow::Result;
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use tokio_util::sync::CancellationToken;
use tracing::{error, info, warn};

use ergatai_error::{ChatId, ConversationId, MessageId, WorkspaceId};
use ergatai_runtime::types::AgentImage;

const MAX_ATTEMPTS: i64 = 3;
const WORKER_INTERVAL: Duration = Duration::from_secs(2);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InitialPromptTurn {
    pub turn_id: String,
    pub conversation_id: String,
    pub chat_id: String,
    pub workspace_id: String,
    pub message_id: String,
    pub client_request_id: String,
    pub agent_command: String,
    pub prompt: String,
    pub images: Vec<AgentImage>,
    pub status: InitialPromptStatus,
    pub attempt: i64,
    pub error: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
    pub dispatched_at: Option<i64>,
    pub completed_at: Option<i64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum InitialPromptStatus {
    Pending,
    Dispatching,
    Running,
    Completed,
    Failed,
}

impl InitialPromptStatus {
    fn as_str(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Dispatching => "dispatching",
            Self::Running => "running",
            Self::Completed => "completed",
            Self::Failed => "failed",
        }
    }

    fn from_str(value: &str) -> Self {
        match value {
            "dispatching" => Self::Dispatching,
            "running" => Self::Running,
            "completed" => Self::Completed,
            "failed" => Self::Failed,
            _ => Self::Pending,
        }
    }
}

#[derive(Debug)]
pub struct InitialPromptInput {
    pub conversation_id: ConversationId,
    pub chat_id: ChatId,
    pub workspace_id: WorkspaceId,
    pub message_id: MessageId,
    pub client_request_id: String,
    pub agent_command: String,
    pub prompt: String,
    pub images: Vec<AgentImage>,
}

const SELECT_COLUMNS: &str = "turn_id, conversation_id, chat_id, workspace_id, message_id, \
    client_request_id, agent_command, prompt, images, status, attempt, error, created_at, \
    updated_at, dispatched_at, completed_at";

fn row_to_turn(row: &rusqlite::Row<'_>) -> rusqlite::Result<InitialPromptTurn> {
    let status: String = row.get(9)?;
    let images_json: String = row.get(8)?;
    let images = serde_json::from_str::<Vec<AgentImage>>(&images_json).unwrap_or_default();

    Ok(InitialPromptTurn {
        turn_id: row.get(0)?,
        conversation_id: ConversationId::new(row.get(1)?).encode(),
        chat_id: ChatId::new(row.get(2)?).encode(),
        workspace_id: WorkspaceId::new(row.get(3)?).encode(),
        message_id: MessageId::new(row.get(4)?).encode(),
        client_request_id: row.get(5)?,
        agent_command: row.get(6)?,
        prompt: row.get(7)?,
        images,
        status: InitialPromptStatus::from_str(&status),
        attempt: row.get(10)?,
        error: row.get(11)?,
        created_at: row.get(12)?,
        updated_at: row.get(13)?,
        dispatched_at: row.get(14)?,
        completed_at: row.get(15)?,
    })
}

fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}

/// Idempotently enqueue the first prompt for a conversation.
pub fn enqueue(input: InitialPromptInput) -> Result<InitialPromptTurn> {
    let db = crate::user_data_db::get_user_data_db();
    let mut conn = db
        .lock()
        .map_err(|error| anyhow::anyhow!("Initial prompt database lock poisoned: {}", error))?;
    let tx = conn.transaction()?;
    let now = now_secs();
    let turn_id = ergatai_error::id::format(
        ergatai_error::id::generate(),
        ergatai_error::id::IdType::Turn,
    );

    tx.execute(
        r#"
        INSERT INTO initial_prompt_turns (
            turn_id, conversation_id, chat_id, workspace_id, message_id,
            client_request_id, agent_command, prompt, images,
            status, attempt, created_at, updated_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 'pending', 0, ?10, ?10)
        ON CONFLICT(conversation_id) DO NOTHING
        "#,
        params![
            turn_id,
            input.conversation_id.as_i64(),
            input.chat_id.as_i64(),
            input.workspace_id.as_i64(),
            input.message_id.as_i64(),
            input.client_request_id,
            input.agent_command,
            input.prompt,
            serde_json::to_string(&input.images)?,
            now,
        ],
    )?;

    // Read the effective row inside the same transaction/lock scope. Calling
    // get_by_conversation() here would re-lock the same global SQLite mutex and
    // deadlock the HTTP handler.
    let turn = tx
        .query_row(
            &format!(
                "SELECT {SELECT_COLUMNS} FROM initial_prompt_turns WHERE conversation_id = ?1"
            ),
            params![input.conversation_id.as_i64()],
            row_to_turn,
        )
        .optional()?
        .ok_or_else(|| anyhow::anyhow!("Initial prompt turn vanished after enqueue"))?;
    tx.commit()?;

    info!(
        turn_id = %turn.turn_id,
        conversation_id = %turn.conversation_id,
        status = ?turn.status,
        "Initial prompt turn enqueued"
    );
    Ok(turn)
}

pub fn get_by_conversation(conversation_id: ConversationId) -> Result<Option<InitialPromptTurn>> {
    let db = crate::user_data_db::get_user_data_db();
    let conn = db
        .lock()
        .map_err(|error| anyhow::anyhow!("Initial prompt database lock poisoned: {}", error))?;
    let mut stmt = conn.prepare(&format!(
        "SELECT {SELECT_COLUMNS} FROM initial_prompt_turns WHERE conversation_id = ?1"
    ))?;
    let turn = stmt
        .query_row(params![conversation_id.as_i64()], row_to_turn)
        .optional()?;
    Ok(turn)
}

fn claim_next_impl(conn: &mut Connection) -> Result<Option<InitialPromptTurn>> {
    let tx = conn.transaction()?;
    let pending = tx
        .query_row(
            &format!(
                "SELECT {SELECT_COLUMNS} FROM initial_prompt_turns
                 WHERE status = 'pending'
                 ORDER BY created_at ASC
                 LIMIT 1"
            ),
            [],
            row_to_turn,
        )
        .optional()?;

    let Some(turn) = pending else {
        return Ok(None);
    };

    let updated = tx.execute(
        "UPDATE initial_prompt_turns
         SET status = 'dispatching', updated_at = ?2
         WHERE turn_id = ?1 AND status = 'pending'",
        params![turn.turn_id, now_secs()],
    )?;
    if updated == 0 {
        return Ok(None);
    }
    tx.commit()?;

    Ok(Some(InitialPromptTurn {
        status: InitialPromptStatus::Dispatching,
        ..turn
    }))
}

fn mark_running(turn_id: &str) -> Result<()> {
    let db = crate::user_data_db::get_user_data_db();
    let conn = db
        .lock()
        .map_err(|error| anyhow::anyhow!("Initial prompt database lock poisoned: {}", error))?;
    let now = now_secs();
    let sql = "UPDATE initial_prompt_turns
         SET status = 'running', error = NULL, updated_at = ?1,
             dispatched_at = COALESCE(dispatched_at, ?1)
         WHERE turn_id = ?2 AND status = 'dispatching'";
    let updated = conn.execute(sql, params![now, turn_id])?;
    if updated == 0 {
        warn!(
            turn_id = turn_id,
            "Initial prompt status transition was stale"
        );
    }
    Ok(())
}

fn reset_interrupted_impl(conn: &Connection) -> Result<u64> {
    let now = now_secs();
    let updated = conn.execute(
        "UPDATE initial_prompt_turns
         SET status = 'pending', updated_at = ?1
         WHERE status IN ('dispatching', 'running')",
        params![now],
    )?;
    Ok(updated as u64)
}

fn finish_success_impl(conn: &Connection, turn_id: &str) -> Result<()> {
    let now = now_secs();
    conn.execute(
        "UPDATE initial_prompt_turns
         SET status = 'completed', error = NULL, updated_at = ?1, completed_at = ?1
         WHERE turn_id = ?2",
        params![now, turn_id],
    )?;
    Ok(())
}

fn update_message_delivery_status(conversation_id: ConversationId, message_id: &str, status: &str) {
    if let Ok(message_id) = MessageId::decode(message_id) {
        let _ = crate::user_data_db::messages::update_delivery_status(
            conversation_id,
            message_id.encode().as_str(),
            status,
        );
    }
}

fn finish_error_impl(
    conn: &mut Connection,
    turn_id: &str,
    attempt: i64,
    error: &str,
) -> Result<InitialPromptStatus> {
    let now = now_secs();
    let next_attempt = attempt + 1;
    let next_status = if next_attempt < MAX_ATTEMPTS {
        InitialPromptStatus::Pending
    } else {
        InitialPromptStatus::Failed
    };

    let tx = conn.transaction()?;
    tx.execute(
        "UPDATE initial_prompt_turns
         SET status = ?1, attempt = ?2, error = ?3, updated_at = ?4,
             completed_at = CASE WHEN ?1 = 'failed' THEN ?4 ELSE completed_at END
         WHERE turn_id = ?5",
        params![next_status.as_str(), next_attempt, error, now, turn_id,],
    )?;
    tx.commit()?;

    Ok(next_status)
}

fn turn_error(error: impl std::fmt::Display) -> String {
    crate::sanitize_error(&error, "initial_prompt_turn")
}

async fn ensure_agent(turn: &InitialPromptTurn) -> Result<String> {
    let runtime = crate::context::get_app_context().agent_runtime.clone();

    if let Some(agent) = runtime
        .registry()
        .resolve_conversation_id(&turn.conversation_id)
        .await
    {
        if agent.lifecycle.is_alive() {
            return Ok(agent.agent_id);
        }
    }

    if let Some(resumed) = crate::services::agent_service::try_auto_resume_suspended_agent(
        &runtime,
        &turn.agent_command,
        Some(&turn.conversation_id),
    )
    .await
    {
        return Ok(resumed);
    }

    let max_agents: usize = std::env::var("ERGATAI_MAX_AGENTS")
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(50);
    let running_agent_count = runtime.list_agents().await.len();
    if running_agent_count >= max_agents {
        return Err(anyhow::anyhow!(
            "Agent limit reached ({}/{}); cannot dispatch initial prompt",
            running_agent_count,
            max_agents
        ));
    }

    let chat_id_typed = ChatId::decode(&turn.chat_id)
        .map_err(|error| anyhow::anyhow!("Invalid chat ID: {}", error))?;
    let workspace_id_typed = WorkspaceId::decode(&turn.workspace_id)
        .map_err(|error| anyhow::anyhow!("Invalid workspace ID: {}", error))?;

    let (chat, workspace) = {
        let chat_future =
            tokio::task::spawn_blocking(move || crate::user_data_db::chats::get(chat_id_typed));
        let workspace_future = tokio::task::spawn_blocking(move || {
            crate::user_data_db::workspaces::get(workspace_id_typed)
        });
        let (chat_result, workspace_result) = tokio::join!(chat_future, workspace_future);
        (
            chat_result.map_err(|error| anyhow::anyhow!("Chat query task failed: {}", error))?,
            workspace_result
                .map_err(|error| anyhow::anyhow!("Workspace query task failed: {}", error))?,
        )
    };

    let chat = chat?.ok_or_else(|| anyhow::anyhow!("Chat {} not found", turn.chat_id))?;
    let workspace =
        workspace?.ok_or_else(|| anyhow::anyhow!("Workspace {} not found", turn.workspace_id))?;
    let work_dir = chat
        .worktree_path
        .unwrap_or_else(|| workspace.work_dir.clone());
    let work_dir = crate::validate_cwd(&work_dir)
        .map_err(|error| anyhow::anyhow!("Invalid work directory: {}", error))?;
    let env: std::collections::HashMap<String, String> =
        serde_json::from_str(&workspace.env).unwrap_or_default();
    let resources: ergatai_runtime::ResourceLimits =
        serde_json::from_str(&workspace.resources).unwrap_or_default();

    let profiles = tokio::task::spawn_blocking(|| {
        crate::services::profile_service::list_profiles_with_status()
    })
    .await
    .map_err(|error| anyhow::anyhow!("Profile query task failed: {}", error))??;
    let profile = profiles
        .into_iter()
        .find(|profile| profile.name == turn.agent_command)
        .ok_or_else(|| anyhow::anyhow!("Agent profile {} not found", turn.agent_command))?;
    if !profile.installed {
        return Err(anyhow::anyhow!(
            "Agent profile {} is not installed",
            profile.name
        ));
    }

    let spec = ergatai_runtime::WorkspaceSpec {
        id: turn.workspace_id.clone(),
        work_dir,
        env,
        resources,
        capture_thoughts: false,
    };
    let agent_id = runtime
        .launch_agent_scoped(
            spec,
            &profile.command,
            None,
            Some(&turn.chat_id),
            Some(&turn.conversation_id),
            Some(&profile.name),
            profile.transport.as_deref(),
        )
        .await
        .map_err(|error| anyhow::anyhow!("Failed to launch agent: {}", error))?;

    upsert_agent_binding(&agent_id, &profile, turn).await?;
    Ok(agent_id)
}

async fn upsert_agent_binding(
    agent_id: &str,
    profile: &ergatai_runtime::profile_registry::ProfileWithStatus,
    turn: &InitialPromptTurn,
) -> Result<()> {
    let agent_id_i64 = ergatai_core::id::parse_to_i64(agent_id).unwrap_or(0);
    let binding = crate::user_data_db::GroupAgentBinding {
        workspace_id: WorkspaceId::decode(&turn.workspace_id)
            .map_err(|error| anyhow::anyhow!("Invalid workspace ID: {}", error))?,
        chat_id: ChatId::decode(&turn.chat_id)
            .map_err(|error| anyhow::anyhow!("Invalid chat ID: {}", error))?,
        agent_id: agent_id_i64,
        agent_name: profile.name.clone(),
        agent_command: Some(profile.name.clone()),
        conversation_id: ConversationId::decode(&turn.conversation_id)
            .map_err(|error| anyhow::anyhow!("Invalid conversation ID: {}", error))?,
        created_at: now_secs(),
        updated_at: now_secs(),
    };

    let result = tokio::task::spawn_blocking(move || {
        crate::user_data_db::group_agent_bindings::upsert(binding)
    })
    .await
    .map_err(|error| anyhow::anyhow!("Agent binding task failed: {}", error))?;
    result.map_err(|error| anyhow::anyhow!("Failed to persist agent binding: {}", error))?;
    Ok(())
}

async fn dispatch_turn(mut turn: InitialPromptTurn) -> Result<()> {
    let conversation_id_typed = ConversationId::decode(&turn.conversation_id)
        .map_err(|error| anyhow::anyhow!("Invalid conversation ID: {}", error))?;
    let turn_id = turn.turn_id.clone();
    let conversation_id = turn.conversation_id.clone();

    mark_running(&turn.turn_id)?;
    turn.status = InitialPromptStatus::Running;
    turn.attempt += 1;

    match ensure_agent(&turn).await {
        Ok(agent_id) => {
            crate::services::agent_service::set_current_prompt_conversation(
                &agent_id,
                Some(turn.conversation_id.clone()),
            );
            let runtime = crate::context::get_app_context().agent_runtime.clone();
            let delivery = if turn.images.is_empty() {
                runtime
                    .inject_message_to_conversation(&turn.conversation_id, &turn.prompt)
                    .await
            } else {
                runtime
                    .inject_message_to_conversation_with_images(
                        &turn.conversation_id,
                        &turn.prompt,
                        turn.images.clone(),
                    )
                    .await
            };

            match delivery {
                Ok(()) => {
                    let closure_turn_id = turn_id.clone();
                    let result = tokio::task::spawn_blocking(move || {
                        let db = crate::user_data_db::get_user_data_db();
                        let conn = db.lock().map_err(|error| {
                            anyhow::anyhow!("Initial prompt database lock poisoned: {}", error)
                        })?;
                        finish_success_impl(&conn, &closure_turn_id)
                    })
                    .await;
                    let state_result = match result {
                        Ok(result) => result,
                        Err(error) => {
                            Err(anyhow::anyhow!("Completion state task failed: {}", error))
                        }
                    };
                    match state_result {
                        Ok(()) => info!(
                            turn_id = %turn_id,
                            conversation_id = %conversation_id,
                            agent_id = %agent_id,
                            "Initial prompt delivered"
                        ),
                        Err(error) => warn!(
                            turn_id = %turn_id,
                            error = %error,
                            "Initial prompt delivered but completion state update failed"
                        ),
                    }
                    update_message_delivery_status(
                        conversation_id_typed,
                        &turn.message_id,
                        "delivered",
                    );
                }
                Err(delivery_error) => {
                    let error = turn_error(&delivery_error);
                    warn!(
                        turn_id = %turn_id,
                        conversation_id = %conversation_id,
                        attempt = turn.attempt,
                        error = %error,
                        "Initial prompt delivery failed"
                    );
                    let closure_turn_id = turn_id.clone();
                    let result = tokio::task::spawn_blocking(move || {
                        let db = crate::user_data_db::get_user_data_db();
                        let mut conn = db.lock().map_err(|lock_error| {
                            anyhow::anyhow!("Initial prompt database lock poisoned: {}", lock_error)
                        })?;
                        finish_error_impl(&mut conn, &closure_turn_id, turn.attempt, &error)
                    })
                    .await;
                    let state_result = match result {
                        Ok(result) => result,
                        Err(error) => Err(anyhow::anyhow!("Failure state task failed: {}", error)),
                    };
                    match state_result {
                        Ok(_) => {}
                        Err(ref error) => error!(
                            turn_id = %turn_id,
                            error = %error,
                            "Failed to persist initial prompt failure"
                        ),
                    }
                    if matches!(state_result, Ok(InitialPromptStatus::Failed)) {
                        update_message_delivery_status(
                            conversation_id_typed,
                            &turn.message_id,
                            "failed",
                        );
                    }
                }
            }
        }
        Err(spawn_error) => {
            let error = turn_error(&spawn_error);
            warn!(
                turn_id = %turn_id,
                conversation_id = %conversation_id,
                attempt = turn.attempt,
                error = %error,
                "Failed to prepare initial prompt agent"
            );
            let closure_turn_id = turn_id.clone();
            let result = tokio::task::spawn_blocking(move || {
                let db = crate::user_data_db::get_user_data_db();
                let mut conn = db.lock().map_err(|lock_error| {
                    anyhow::anyhow!("Initial prompt database lock poisoned: {}", lock_error)
                })?;
                finish_error_impl(&mut conn, &closure_turn_id, turn.attempt, &error)
            })
            .await;
            let state_result = match result {
                Ok(result) => result,
                Err(error) => Err(anyhow::anyhow!("Failure state task failed: {}", error)),
            };
            match state_result {
                Ok(_) => {}
                Err(ref error) => error!(
                    turn_id = %turn_id,
                    error = %error,
                    "Failed to persist initial prompt prepare failure"
                ),
            }
            if matches!(state_result, Ok(InitialPromptStatus::Failed)) {
                update_message_delivery_status(conversation_id_typed, &turn.message_id, "failed");
            }
        }
    }
    Ok(())
}

async fn process_pending_once() {
    let next = {
        let result = tokio::task::spawn_blocking(|| {
            let db = crate::user_data_db::get_user_data_db();
            let mut conn = db.lock().map_err(|error| {
                anyhow::anyhow!("Initial prompt database lock poisoned: {}", error)
            })?;
            claim_next_impl(&mut conn)
        })
        .await;
        match result {
            Ok(Ok(turn)) => turn,
            Ok(Err(error)) => {
                warn!(error = %error, "Failed to claim initial prompt turn");
                return;
            }
            Err(error) => {
                warn!(error = %error, "Initial prompt claim task failed");
                return;
            }
        }
    };

    if let Some(turn) = next {
        tokio::spawn(dispatch_turn(turn));
    }
}

/// Start the durable initial-prompt scheduler. Any turns left in dispatching or
/// running by a previous process are reset to pending because their dispatch
/// task did not survive the restart.
pub fn spawn_worker(cancellation_token: CancellationToken) {
    tokio::spawn(async move {
        let recovered = tokio::task::spawn_blocking(|| {
            let db = crate::user_data_db::get_user_data_db();
            let conn = db.lock().map_err(|error| {
                anyhow::anyhow!("Initial prompt database lock poisoned: {}", error)
            })?;
            reset_interrupted_impl(&conn)
        })
        .await;
        match recovered {
            Ok(Ok(count)) if count > 0 => info!(
                count,
                "Recovered interrupted initial prompt turns for retry"
            ),
            Ok(Err(error)) => warn!(
                error = %error,
                "Failed to recover interrupted initial prompt turns"
            ),
            Err(error) => warn!(
                error = %error,
                "Initial prompt recovery task failed"
            ),
            _ => {}
        }

        let mut interval = tokio::time::interval(WORKER_INTERVAL);
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            tokio::select! {
                _ = cancellation_token.cancelled() => break,
                _ = interval.tick() => process_pending_once().await,
            }
        }
    });
}
