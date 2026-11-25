//! High-level DAG task agent spawner.
//!
//! `ergatai-collab` owns DAG execution but cannot depend on this crate
//! (`ergatai-api` sits above it). It therefore exposes a `DagAgentSpawner`
//! trait; this implementation is installed at startup so DAG-spawned agents
//! reuse the same launch policy as chat agents: profile command/transport,
//! provider-connection environment, and default model.

use std::path::Path;

use ergatai_core::cross_agent::DagAgentSpawner;
use ergatai_error::id::{format as format_id, generate, IdType};
use ergatai_error::{ErgataiError, ErgataiResult};
use ergatai_runtime::launch::LaunchPlan;

use super::{AgentLaunchService, EphemeralLaunchRequest, ModelSelection, ModelSource};
use crate::services::provider_connection_service;

#[async_trait::async_trait]
impl DagAgentSpawner for AgentLaunchService {
    async fn spawn_agent_for_task(
        &self,
        agent_name: &str,
        work_dir: &Path,
    ) -> ErgataiResult<String> {
        let (command, transport) =
            ergatai_runtime::launch::resolve_profile_launch(agent_name).await?;

        // Resolve the same provider environment + default model used by the
        // message-driven auto-spawn path. This carries base_url/API key/model
        // for protocols Ergatai configures via env (and intentionally skips the
        // OpenCode SDK URL, which is not a provider override).
        let (env, default_model) =
            provider_connection_service::resolve_spawn_settings(agent_name).await;
        let model = default_model
            .as_deref()
            .filter(|value| !value.trim().is_empty())
            .map(ModelSelection::new);

        tracing::info!(
            agent_name = %agent_name,
            command = %command,
            transport = ?transport,
            provider_env_keys = ?env.keys().collect::<Vec<_>>(),
            model = ?model.as_ref().map(|selection| selection.id.as_str()),
            "Launching DAG agent via AgentLaunchService"
        );

        let plan = LaunchPlan {
            workspace_id: format_id(generate(), IdType::Workspace),
            work_dir: work_dir.to_path_buf(),
            env,
            resources: Default::default(),
            capture_thoughts: false,
            command,
            chat_id: None,
            conversation_id: None,
            profile_name: Some(agent_name.to_string()),
            transport,
            reuse_agent_id: None,
        };

        let result = self
            .spawn_ephemeral(EphemeralLaunchRequest {
                plan,
                model,
                source: ModelSource::ProviderDefault,
                allow_native_default: true,
            })
            .await
            .map_err(|error| {
                ErgataiError::AgentSpawnFailed(format!(
                    "Failed to launch DAG agent for profile '{}': {}",
                    agent_name, error
                ))
            })?;

        Ok(result.agent_id)
    }
}
