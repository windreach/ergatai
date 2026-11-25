//! Mechanical agent launch abstraction.
//!
//! This module owns the low-level "start or resume a process" mechanics. It
//! deliberately does not know about conversations, model selection, provider
//! connections, or persistence; those belong to the higher-level
//! `AgentLaunchService` in `ergatai-api`.
//!
//! All production callers should use `AgentLauncher` instead of calling
//! `AgentRuntime::launch_agent_scoped` or `AgentRuntime::resume_agent` directly.

use std::collections::HashMap;
use std::path::PathBuf;

use ergatai_error::{ErgataiError, ErgataiResult};

use crate::runtime::AgentRuntime;
use crate::types::{ResourceLimits, WorkspaceSpec};

/// Resolve a profile name into the command and transport used to launch it.
///
/// This is the shared entry point for every launch path that references an
/// agent by profile name (DAG task dispatch, suspended-agent resume, ...).
/// Keeping profile lookup and transport probing here avoids each subsystem
/// re-implementing them (and accidentally diverging, e.g. hard-coding a CLI).
pub async fn resolve_profile_launch(profile_name: &str) -> ErgataiResult<(String, Option<String>)> {
    let registry =
        crate::profile_registry::ProfileRegistry::new(crate::dirs::profile_registry_db_path())?;
    resolve_profile_launch_with(&registry, profile_name).await
}

/// Same as [`resolve_profile_launch`], but against an explicit registry.
///
/// Split out so tests and callers that already hold a registry (or a custom DB
/// path) can reuse the resolution rules.
pub async fn resolve_profile_launch_with(
    registry: &crate::profile_registry::ProfileRegistry,
    profile_name: &str,
) -> ErgataiResult<(String, Option<String>)> {
    let profile = registry.get_by_name(profile_name).await?.ok_or_else(|| {
        ErgataiError::AgentSpawnFailed(format!(
            "Agent profile '{}' is not registered",
            profile_name
        ))
    })?;

    if profile.command.trim().is_empty() {
        return Err(ErgataiError::AgentSpawnFailed(format!(
            "Agent profile '{}' has an empty command",
            profile_name
        )));
    }

    // Probe/cache transport only when the profile has no explicit value.
    // The runtime then defaults to stdio if probing cannot determine one.
    let transport = match profile.transport {
        Some(transport) => Some(transport),
        None => registry.resolve_transport(profile_name).await,
    };

    Ok((profile.command, transport))
}

#[cfg(test)]
mod tests {
    use tempfile::TempDir;

    use crate::profile_registry::{AgentRegistration, ProfileRegistry};

    use super::resolve_profile_launch_with;

    fn registry() -> (TempDir, ProfileRegistry) {
        let dir = tempfile::tempdir().unwrap();
        let registry = ProfileRegistry::new(dir.path().join("profiles.db")).unwrap();
        (dir, registry)
    }

    #[tokio::test]
    async fn resolves_command_and_transport_from_profile() {
        let (_dir, registry) = registry();
        registry
            .register(AgentRegistration::with_id_and_transport(
                "agent_launch_test".to_string(),
                "launch-test-profile".to_string(),
                "opencode acp".to_string(),
                "acp".to_string(),
                None,
                Some("stdio".to_string()),
            ))
            .await
            .unwrap();

        let (command, transport) = resolve_profile_launch_with(&registry, "launch-test-profile")
            .await
            .unwrap();

        assert_eq!(command, "opencode acp");
        assert_eq!(transport.as_deref(), Some("stdio"));
    }

    #[tokio::test]
    async fn missing_profile_is_reported() {
        let (_dir, registry) = registry();
        let error = resolve_profile_launch_with(&registry, "does-not-exist")
            .await
            .unwrap_err();
        assert!(error.to_string().contains("not registered"), "{error}");
    }
}

/// A fully resolved plan for starting a new agent process.
///
/// `instruction` is intentionally absent: callers must apply the model first
/// and then send the first prompt explicitly. This prevents the historical bug
/// where an initial instruction ran with the adapter's default model before the
/// user's selected model was applied.
#[derive(Debug, Clone)]
pub struct LaunchPlan {
    pub workspace_id: String,
    pub work_dir: PathBuf,
    pub env: HashMap<String, String>,
    pub resources: ResourceLimits,
    pub capture_thoughts: bool,
    pub command: String,
    pub chat_id: Option<String>,
    pub conversation_id: Option<String>,
    pub profile_name: Option<String>,
    pub transport: Option<String>,
    /// Reuse an existing agent ID (for example when resuming a suspended
    /// agent). When `None`, the runtime allocates a fresh Snowflake ID.
    pub reuse_agent_id: Option<String>,
}

impl LaunchPlan {
    pub fn workspace_spec(&self) -> WorkspaceSpec {
        WorkspaceSpec {
            id: self.workspace_id.clone(),
            work_dir: self.work_dir.clone(),
            env: self.env.clone(),
            resources: self.resources.clone(),
            capture_thoughts: self.capture_thoughts,
        }
    }
}

/// Context that the high-level service re-resolves before resuming a process.
///
/// Provider credentials and model selection are intentionally not persisted in
/// the suspend store. The high-level service resolves the provider connection
/// and model, then passes the resulting environment/transport/work directory
/// here.
#[derive(Debug, Clone, Default)]
pub struct ResumeOverrides {
    pub env: HashMap<String, String>,
    pub transport: Option<String>,
    pub work_dir: Option<PathBuf>,
}

/// Low-level launcher shared by API, collaboration, and maintenance paths.
pub struct AgentLauncher<'a> {
    runtime: &'a AgentRuntime,
}

impl<'a> AgentLauncher<'a> {
    pub fn new(runtime: &'a AgentRuntime) -> Self {
        Self { runtime }
    }

    /// Start a new agent process. No instruction is sent; the caller applies
    /// the model and sends the first prompt after this returns.
    pub async fn launch(&self, plan: LaunchPlan) -> ErgataiResult<String> {
        let spec = plan.workspace_spec();
        self.runtime
            .launch_agent_scoped(
                spec,
                &plan.command,
                None,
                plan.chat_id.as_deref(),
                plan.conversation_id.as_deref(),
                plan.profile_name.as_deref(),
                plan.transport.as_deref(),
                plan.reuse_agent_id.as_deref(),
            )
            .await
    }

    /// Resume a suspended agent. The caller is responsible for resolving the
    /// provider environment and model before/after this call.
    pub async fn resume(
        &self,
        suspended_id: &str,
        overrides: ResumeOverrides,
    ) -> ErgataiResult<String> {
        self.runtime
            .resume_agent_with_overrides(suspended_id, Some(overrides))
            .await
    }
}
