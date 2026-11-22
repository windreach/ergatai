//! Conversation → launch context resolution.
//!
//! This is the only place that combines conversation state, profile registry,
//! provider connections, and model candidates. Callers must not re-implement
//! this precedence.

use std::collections::HashMap;
use std::path::PathBuf;

use anyhow::{anyhow, Context, Result};
use ergatai_error::{ConversationId, WorkspaceId};
use ergatai_runtime::runtime::AgentRuntime;
use ergatai_runtime::{AgentInfo, SuspendedAgentRecord};

use crate::services::{agent_service, profile_service, provider_connection_service};
use crate::user_data_db::{
    self, Chat, Conversation, ConversationExecutionContext, ConversationLaunchSettings,
    GroupAgentBinding, Workspace,
};

use super::model::{resolve_model, ModelCandidates, ModelInput, ModelSelection, ResolvedModel};
use super::settings;

/// Everything needed to start or resume one process.
#[derive(Debug, Clone)]
pub struct ResolvedLaunchContext {
    pub conversation_id: ConversationId,
    /// Runtime chat-scope metadata for `LaunchPlan`.
    pub chat_id: String,
    pub profile_name: String,
    pub command: String,
    pub transport: Option<String>,
    pub workspace_id: WorkspaceId,
    pub work_dir: PathBuf,
    pub env: HashMap<String, String>,
    pub provider_connection_id: Option<String>,
    /// `None` only when the caller explicitly allowed the adapter default.
    pub model: Option<ResolvedModel>,
    /// Live ACP model observed before resolution, used to skip redundant
    /// switches on every prompt.
    pub live_model: Option<ModelSelection>,
    pub allow_native_default: bool,
    pub live_agent: Option<AgentInfo>,
    pub suspended: Option<SuspendedAgentRecord>,
}

struct ConversationSnapshot {
    conversation: Conversation,
    chat: Chat,
    workspace: Workspace,
    execution_context: Option<ConversationExecutionContext>,
    group_binding: Option<GroupAgentBinding>,
    initial_prompt: Option<crate::services::initial_prompt_turns::InitialPromptTurn>,
    current_agent_id: Option<String>,
    launch_settings: Option<ConversationLaunchSettings>,
    runtime_model: Option<String>,
}

fn load_snapshot(conversation_id: ConversationId) -> Result<ConversationSnapshot> {
    let conversation = user_data_db::conversations::get(conversation_id)?
        .ok_or_else(|| anyhow!("Conversation not found: {}", conversation_id))?;
    let chat = user_data_db::chats::get(conversation.chat_id)?
        .ok_or_else(|| anyhow!("Chat not found for conversation {}", conversation_id))?;
    let workspace = user_data_db::workspaces::get(chat.workspace_id)?
        .ok_or_else(|| anyhow!("Workspace not found for conversation {}", conversation_id))?;
    let execution_context = user_data_db::conversation_execution_contexts::get(conversation_id)?;
    let group_binding =
        user_data_db::group_agent_bindings::find_by_conversation_id(conversation_id)?;
    let initial_prompt =
        crate::services::initial_prompt_turns::get_by_conversation(conversation_id)?;
    let current_agent_id = user_data_db::conversations::get_current_agent_id(conversation_id)?;
    let launch_settings = user_data_db::conversation_launch_settings::get(conversation_id)?;
    let mut runtime_model =
        user_data_db::get_latest_agent_runtime_model_for_conversation(conversation_id, None)?;

    // Backward compatibility for rows written before `conversation_id` was
    // added to `agent_runtime_models`: fall back to the conversation's current
    // agent ID.
    if runtime_model.is_none() {
        if let Some(agent_id) = current_agent_id.as_deref() {
            if let Ok(Some((_, Some(model), _, _))) =
                user_data_db::get_agent_runtime_model(agent_id)
            {
                runtime_model = Some(model);
            }
        }
    }

    Ok(ConversationSnapshot {
        conversation,
        chat,
        workspace,
        execution_context,
        group_binding,
        initial_prompt,
        current_agent_id,
        launch_settings,
        runtime_model,
    })
}

async fn find_live_agent(
    runtime: &AgentRuntime,
    conversation_id: &str,
    current_agent_id: Option<&str>,
) -> Option<AgentInfo> {
    if let Some(info) = runtime
        .registry()
        .resolve_conversation_id(conversation_id)
        .await
    {
        if info.lifecycle.is_alive() {
            return Some(info);
        }
    }

    if let Some(agent_id) = current_agent_id {
        if let Some(info) = runtime.get_agent(agent_id).await {
            if info.lifecycle.is_alive() {
                return Some(info);
            }
        }
    }

    None
}

fn non_empty(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

/// Resolve the full launch context for a conversation.
pub async fn resolve(
    runtime: &AgentRuntime,
    request: &super::EnsureAgentRequest,
    conversation_id: ConversationId,
) -> Result<ResolvedLaunchContext> {
    let snapshot = tokio::task::spawn_blocking(move || load_snapshot(conversation_id))
        .await
        .context("Conversation snapshot task failed")??;

    // Conversation is the launch anchor. A caller may echo the workspace ID,
    // but it must match; a different workspace would launch the process in the
    // wrong place.
    if let Some(requested_workspace) = request.workspace_id {
        if requested_workspace != snapshot.chat.workspace_id {
            return Err(anyhow!(
                "workspace_id does not match the conversation workspace"
            ));
        }
    }
    if request.work_dir.is_some() {
        tracing::warn!(
            conversation_id = %conversation_id,
            "Ignoring work_dir override for conversation launch; work_dir is derived from the chat/worktree"
        );
    }

    let conversation_key = conversation_id.encode();
    let live_agent = find_live_agent(
        runtime,
        &conversation_key,
        snapshot.current_agent_id.as_deref(),
    )
    .await;
    let suspended = runtime
        .suspend_store()
        .find_by_conversation(&conversation_key)
        .ok()
        .flatten();

    let profile_name = request
        .profile
        .as_deref()
        .and_then(non_empty)
        .or_else(|| live_agent.as_ref().and_then(|info| info.profile.clone()))
        .or_else(|| suspended.as_ref().map(|record| record.profile_name.clone()))
        .or_else(|| {
            snapshot
                .group_binding
                .as_ref()
                .and_then(|binding| binding.agent_command.clone())
        })
        .or_else(|| {
            snapshot
                .initial_prompt
                .as_ref()
                .map(|turn| turn.agent_command.clone())
        })
        .ok_or_else(|| {
            anyhow!(
                "Cannot resolve agent profile for conversation {}",
                conversation_key
            )
        })?;

    let registration = profile_service::get_profile_by_name(&profile_name).await?;
    let (command, profile_transport) = match registration {
        Some(profile) => (profile.command, profile.transport),
        None => {
            // Backward compatibility: a raw command may have been registered as
            // a profile earlier. Keep the historical behavior but make it visible.
            tracing::warn!(
                profile = %profile_name,
                "Agent profile not found; using profile name as raw command"
            );
            (profile_name.clone(), None)
        }
    };
    let transport = profile_transport;

    // Fall back to a profile that shares the same command when the requested
    // profile has no provider connection of its own (inheritance).
    let connection = if request.provider_connection_id.is_some() {
        provider_connection_service::resolve(
            request.provider_connection_id.as_deref(),
            Some(&profile_name),
        )?
    } else {
        let mut candidates = vec![profile_name.clone()];
        if let Ok(Some(profile)) = profile_service::get_profile_by_name(&profile_name).await {
            if let Ok(all) = profile_service::list_profiles().await {
                for other in all {
                    if other.name != profile_name && other.command == profile.command {
                        candidates.push(other.name);
                    }
                }
            }
        }
        let mut found = None;
        for candidate in &candidates {
            if let Some(conn) = provider_connection_service::resolve(None, Some(candidate))? {
                found = Some(conn);
                break;
            }
        }
        found
    };
    let provider_connection_id = connection.as_ref().map(|value| value.id.clone());
    let provider_default = connection
        .as_ref()
        .and_then(|value| value.default_model.clone())
        .and_then(|value| non_empty(&value))
        .map(ModelSelection::new);

    let mut env: HashMap<String, String> =
        serde_json::from_str(&snapshot.workspace.env).unwrap_or_default();
    if let Some(connection) = connection.as_ref() {
        env.extend(provider_connection_service::env_for_connection(connection)?);
    }
    for (key, value) in &request.env {
        env.insert(key.clone(), value.clone());
    }

    let raw_work_dir = snapshot
        .execution_context
        .as_ref()
        .and_then(|context| context.worktree_path.clone())
        .or_else(|| snapshot.chat.worktree_path.clone())
        .unwrap_or_else(|| snapshot.workspace.work_dir.clone());
    let work_dir = crate::expand_home_path(&raw_work_dir);

    let conversation_model = snapshot
        .launch_settings
        .as_ref()
        .and_then(settings::from_row);
    let live_model = match live_agent.as_ref() {
        Some(info) => agent_service::get_agent_config_options(&info.agent_id)
            .await
            .ok()
            .flatten()
            .and_then(|options| {
                crate::services::agent::acp::extract_models_from_config_options(&options)
            })
            .and_then(|detected| detected.current)
            .and_then(|value| non_empty(&value))
            .map(ModelSelection::new),
        None => None,
    };
    let profile_default = match profile_service::get_profile_models_by_name(&profile_name).await {
        Ok(catalog) => catalog
            .default_model
            .and_then(|value| non_empty(&value))
            .map(ModelSelection::new),
        Err(error) => {
            tracing::debug!(
                profile = %profile_name,
                error = %error,
                "Profile model catalogue unavailable during launch context resolution"
            );
            None
        }
    };

    let (explicit_override, seed) = match &request.model {
        ModelInput::Override(selection) => (Some(selection.clone()), None),
        ModelInput::Seed(selection) => (None, Some(selection.clone())),
        ModelInput::None => (None, None),
    };
    let model = resolve_model(ModelCandidates {
        explicit_override,
        seed,
        conversation: conversation_model,
        live: live_model.clone(),
        runtime: snapshot.runtime_model.clone().map(ModelSelection::new),
        provider_default,
        profile_default,
    });

    if model.is_none() && !request.allow_native_default {
        return Err(anyhow!(
            "No model is selected for conversation {}. Choose a model first.",
            conversation_key
        ));
    }

    let chat_id = snapshot
        .conversation
        .parent_id
        .unwrap_or(snapshot.conversation.conversation_id)
        .encode();

    Ok(ResolvedLaunchContext {
        conversation_id,
        chat_id,
        profile_name,
        command,
        transport,
        workspace_id: snapshot.chat.workspace_id,
        work_dir,
        env,
        provider_connection_id,
        model,
        live_model,
        allow_native_default: request.allow_native_default,
        live_agent,
        suspended,
    })
}

/// Persist the effective selection if the conversation does not already have a
/// durable one. Explicit overrides are always persisted.
pub fn persist_selection(
    conversation_id: ConversationId,
    profile_name: &str,
    provider_connection_id: Option<&str>,
    model: Option<&ResolvedModel>,
    explicit: bool,
) -> Result<()> {
    let Some(model) = model else {
        return Ok(());
    };
    if !explicit && settings::load(conversation_id)?.is_some() {
        return Ok(());
    }
    settings::save(
        conversation_id,
        Some(profile_name),
        &model.selection,
        model.source,
        provider_connection_id,
    )?;
    Ok(())
}
