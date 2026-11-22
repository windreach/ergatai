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

use ergatai_error::ErgataiResult;

use crate::runtime::AgentRuntime;
use crate::types::{ResourceLimits, WorkspaceSpec};

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
