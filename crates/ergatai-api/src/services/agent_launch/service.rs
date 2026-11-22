//! Orchestration for the unified launch policy.

use anyhow::{anyhow, bail, Context, Result};
use ergatai_error::ConversationId;
use ergatai_runtime::launch::{AgentLauncher, LaunchPlan, ResumeOverrides};

use crate::services::agent_service;

use super::context::{self, ResolvedLaunchContext};
use super::settings;
use super::{
    AgentLaunchService, AppliedModel, EnsureAgentRequest, EnsureAgentResult,
    EphemeralLaunchRequest, LaunchAction, LaunchMode, ModelInput, ModelSelection, ModelSource,
};

impl AgentLaunchService {
    /// Resolve, reuse, resume, or spawn an agent for a conversation.
    ///
    /// The conversation is the serialization key. The model is applied before
    /// any caller-visible prompt is sent.
    pub async fn ensure(&self, request: EnsureAgentRequest) -> Result<EnsureAgentResult> {
        let conversation_id = request.conversation_id.ok_or_else(|| {
            anyhow!("conversation_id is required for the unified agent launch path")
        })?;
        let conversation_key = conversation_id.encode();
        let lock = self.conversation_lock(&conversation_key);
        let _guard = lock.lock().await;

        let ctx = context::resolve(self.runtime(), &request, conversation_id).await?;
        let explicit = matches!(&request.model, ModelInput::Override(_));

        if request.mode != LaunchMode::SpawnNew {
            if let Some(info) = ctx.live_agent.clone() {
                let applied = self.apply_resolved_model(&info.agent_id, &ctx).await?;
                self.persist_binding(&conversation_key, &info.agent_id)
                    .await;
                context::persist_selection(
                    conversation_id,
                    &ctx.profile_name,
                    ctx.provider_connection_id.as_deref(),
                    ctx.model.as_ref(),
                    explicit,
                )?;
                return Ok(self.result(
                    info.agent_id,
                    LaunchAction::Reused,
                    &conversation_key,
                    &ctx,
                    applied,
                ));
            }

            if let Some(suspended) = ctx.suspended.clone() {
                let overrides = ResumeOverrides {
                    env: ctx.env.clone(),
                    transport: ctx.transport.clone(),
                    work_dir: Some(ctx.work_dir.clone()),
                };
                let agent_id = AgentLauncher::new(self.runtime())
                    .resume(&suspended.id, overrides)
                    .await
                    .map_err(|error| {
                        anyhow!(
                            "Failed to resume suspended agent {}: {}",
                            suspended.id,
                            error
                        )
                    })?;
                let applied = self.apply_resolved_model(&agent_id, &ctx).await?;
                self.persist_binding(&conversation_key, &agent_id).await;
                context::persist_selection(
                    conversation_id,
                    &ctx.profile_name,
                    ctx.provider_connection_id.as_deref(),
                    ctx.model.as_ref(),
                    explicit,
                )?;
                return Ok(self.result(
                    agent_id,
                    LaunchAction::Resumed,
                    &conversation_key,
                    &ctx,
                    applied,
                ));
            }
        }

        if request.mode == LaunchMode::ResumeOnly {
            bail!(
                "No suspended agent found for conversation {}",
                conversation_key
            );
        }

        // Centralized admission check for all ensure-driven spawns.
        let max_agents: usize = std::env::var("ERGATAI_MAX_AGENTS")
            .ok()
            .and_then(|value| value.parse().ok())
            .unwrap_or(50);
        let running_agents = self.runtime().list_agents().await.len();
        if running_agents >= max_agents {
            bail!(
                "Agent limit reached ({}/{}); cannot spawn a new agent",
                running_agents,
                max_agents
            );
        }

        let plan = LaunchPlan {
            workspace_id: ctx.workspace_id.encode(),
            work_dir: ctx.work_dir.clone(),
            env: ctx.env.clone(),
            resources: Default::default(),
            capture_thoughts: false,
            command: ctx.command.clone(),
            chat_id: Some(ctx.chat_id.clone()),
            conversation_id: Some(conversation_key.clone()),
            profile_name: Some(ctx.profile_name.clone()),
            transport: ctx.transport.clone(),
            reuse_agent_id: None,
        };
        let agent_id = AgentLauncher::new(self.runtime())
            .launch(plan)
            .await
            .map_err(|error| anyhow!("Failed to launch agent: {}", error))?;

        let applied = match self.apply_resolved_model(&agent_id, &ctx).await {
            Ok(applied) => applied,
            Err(error) => {
                // Strict policy: do not leave a process running with the wrong
                // model. Best-effort cleanup; the original error is returned.
                let _ = self.runtime().stop_agent(&agent_id).await;
                return Err(error);
            }
        };

        self.persist_binding(&conversation_key, &agent_id).await;
        context::persist_selection(
            conversation_id,
            &ctx.profile_name,
            ctx.provider_connection_id.as_deref(),
            ctx.model.as_ref(),
            explicit,
        )?;

        Ok(self.result(
            agent_id,
            LaunchAction::Spawned,
            &conversation_key,
            &ctx,
            applied,
        ))
    }

    /// Apply a model to a running agent and (when known) persist the
    /// conversation's durable selection. Returns the applied model.
    pub async fn apply_model(
        &self,
        agent_id: &str,
        conversation_id: Option<ConversationId>,
        selection: &ModelSelection,
        source: ModelSource,
    ) -> Result<AppliedModel> {
        crate::services::agent_service::set_agent_with_context(
            agent_id,
            &selection.id,
            conversation_id,
            source.as_str(),
        )
        .await
        .with_context(|| {
            format!(
                "Failed to apply model '{}' to agent {}",
                selection.id, agent_id
            )
        })?;

        if let Some(conversation_id) = conversation_id {
            settings::save(conversation_id, None, selection, source, None).with_context(|| {
                format!(
                    "Failed to persist conversation model '{}' for {}",
                    selection.id, conversation_id
                )
            })?;
        }

        Ok(AppliedModel {
            selection: selection.clone(),
            source,
            applied_at: settings::now_ms(),
        })
    }

    /// Spawn a short-lived/ephemeral agent without a conversation anchor.
    ///
    /// The caller is responsible for resolving the profile command and any
    /// provider environment; this method only performs the mechanical launch
    /// and optional model application. When `allow_native_default` is false and
    /// no model is supplied, no model is applied.
    pub async fn spawn_ephemeral(
        &self,
        request: EphemeralLaunchRequest,
    ) -> Result<EnsureAgentResult> {
        let agent_id = AgentLauncher::new(self.runtime())
            .launch(request.plan)
            .await
            .map_err(|error| anyhow!("Failed to launch ephemeral agent: {}", error))?;

        let applied = match request.model {
            Some(selection) => self
                .apply_model(&agent_id, None, &selection, request.source)
                .await
                .ok(),
            None => None,
        };

        Ok(EnsureAgentResult {
            agent_id,
            action: LaunchAction::Spawned,
            conversation_id: None,
            model: applied.clone(),
            provider_connection_id: None,
            model_source: applied.as_ref().map(|m| m.source).or_else(|| {
                if request.allow_native_default {
                    Some(ModelSource::NativeDefault)
                } else {
                    None
                }
            }),
        })
    }

    fn result(
        &self,
        agent_id: String,
        action: LaunchAction,
        conversation_key: &str,
        ctx: &ResolvedLaunchContext,
        applied: Option<AppliedModel>,
    ) -> EnsureAgentResult {
        EnsureAgentResult {
            agent_id,
            action,
            conversation_id: Some(conversation_key.to_string()),
            model_source: applied.as_ref().map(|model| model.source),
            model: applied,
            provider_connection_id: ctx.provider_connection_id.clone(),
        }
    }

    async fn apply_resolved_model(
        &self,
        agent_id: &str,
        ctx: &ResolvedLaunchContext,
    ) -> Result<Option<AppliedModel>> {
        let Some(resolved) = ctx.model.as_ref() else {
            return Ok(None);
        };

        let already_applied = ctx
            .live_model
            .as_ref()
            .and_then(|model| model.normalized())
            .as_ref()
            == Some(&resolved.selection);
        if !already_applied {
            agent_service::set_agent_with_context(
                agent_id,
                &resolved.selection.id,
                Some(ctx.conversation_id),
                resolved.source.as_str(),
            )
            .await
            .with_context(|| {
                format!(
                    "Failed to apply model '{}' to agent {}",
                    resolved.selection.id, agent_id
                )
            })?;
        }

        // `set_agent_with_context` records the model ID synchronously; update
        // the same row with provider-specific options and the conversation key.
        let options_json =
            serde_json::to_string(&settings::ModelOptions::from_selection(&resolved.selection))?;
        let agent_id_owned = agent_id.to_string();
        let profile_name = ctx.profile_name.clone();
        let model_id = resolved.selection.id.clone();
        let source = resolved.source.as_str().to_string();
        let conversation_id = ctx.conversation_id;
        tokio::task::spawn_blocking(move || {
            crate::user_data_db::set_agent_runtime_model_full(
                &agent_id_owned,
                Some(&profile_name),
                Some(conversation_id),
                Some(&model_id),
                Some(&options_json),
                &source,
            )
        })
        .await
        .context("Runtime model persistence task failed")??;

        Ok(Some(AppliedModel {
            selection: resolved.selection.clone(),
            source: resolved.source,
            applied_at: settings::now_ms(),
        }))
    }

    async fn persist_binding(&self, conversation_key: &str, agent_id: &str) {
        let Ok(conversation_id) = ConversationId::decode(conversation_key) else {
            return;
        };
        let agent_id = agent_id.to_string();
        let _ = tokio::task::spawn_blocking(move || {
            crate::user_data_db::conversations::set_current_agent_id(
                conversation_id,
                Some(&agent_id),
            )
        })
        .await;
    }
}
