//! Unified agent launch abstraction (policy + lifecycle).
//!
//! Phase 1 provides the shared vocabulary and persistence primitives:
//!
//! - [`model`] owns the single model-precedence resolver.
//! - [`settings`] owns the durable per-conversation selection.
//! - [`AgentLaunchService`] owns the per-conversation serialization locks and
//!   is the place where `ensure`/`prompt` will be implemented in Phase 2.
//!
//! The mechanical launch/resume layer lives in
//! `ergatai_runtime::launch::AgentLauncher`. Keeping the two layers separate
//! lets `ergatai-collab` reuse the mechanics without depending on the API crate.

pub mod context;
pub mod dag;
pub mod model;
pub mod service;
pub mod settings;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use ergatai_error::{ConversationId, WorkspaceId};
use ergatai_runtime::launch::LaunchPlan;
use ergatai_runtime::runtime::AgentRuntime;
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

pub use model::{
    resolve_model, ConversationModel, ModelCandidates, ModelInput, ModelSelection, ModelSource,
    ResolvedModel,
};

/// How a caller wants an agent resolved.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum LaunchMode {
    /// Reuse a live agent, resume a suspended one, or spawn a new one.
    Ensure,
    /// Always spawn a new process.
    SpawnNew,
    /// Only resume a suspended process; never spawn.
    ResumeOnly,
}

/// What the service actually did.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum LaunchAction {
    Reused,
    Resumed,
    Spawned,
}

/// A model that is known to have been applied to a running agent.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
pub struct AppliedModel {
    pub selection: ModelSelection,
    pub source: ModelSource,
    pub applied_at: i64,
}

/// Canonical request for resolving/starting an agent.
///
/// `instruction` deliberately lives outside this type: callers must apply the
/// model first, then send the first prompt through the normal prompt path.
#[derive(Debug, Clone)]
pub struct EnsureAgentRequest {
    pub conversation_id: Option<ConversationId>,
    pub profile: Option<String>,
    pub workspace_id: Option<WorkspaceId>,
    pub work_dir: Option<PathBuf>,
    pub provider_connection_id: Option<String>,
    pub model: ModelInput,
    pub mode: LaunchMode,
    pub env: std::collections::BTreeMap<String, String>,
    pub allow_native_default: bool,
}

/// Result of an ensure/resume/spawn operation.
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct EnsureAgentResult {
    pub agent_id: String,
    pub action: LaunchAction,
    pub conversation_id: Option<String>,
    pub model: Option<AppliedModel>,
    pub provider_connection_id: Option<String>,
    pub model_source: Option<ModelSource>,
}

/// Request for spawning an agent without a conversation anchor (ephemeral /
/// maintenance / temporary probe agents).
#[derive(Debug, Clone)]
pub struct EphemeralLaunchRequest {
    pub plan: LaunchPlan,
    pub model: Option<ModelSelection>,
    pub source: ModelSource,
    pub allow_native_default: bool,
}

/// High-level launch service shared by chat, resume, MCP, and fork paths.
///
/// Phase 1 provides the state primitives and `ensure`; the prompt integration
/// lands in Phase 2 once callers are migrated to the canonical API.
pub struct AgentLaunchService {
    runtime: Arc<AgentRuntime>,
    /// Weak references let the map shrink back to active conversations instead
    /// of growing with every conversation the process has seen.
    conversation_locks: Mutex<HashMap<String, std::sync::Weak<tokio::sync::Mutex<()>>>>,
}

impl AgentLaunchService {
    pub fn new(runtime: Arc<AgentRuntime>) -> Self {
        Self {
            runtime,
            conversation_locks: Mutex::new(HashMap::new()),
        }
    }

    /// The process-wide shared service. Request handlers must use this instead
    /// of constructing a new service (which would create a fresh lock map).
    pub fn shared() -> Arc<Self> {
        crate::context::get_app_context().agent_launch.clone()
    }

    pub fn runtime(&self) -> &Arc<AgentRuntime> {
        &self.runtime
    }

    /// Resolve a model using the unified precedence rules.
    pub fn resolve_model(&self, candidates: ModelCandidates) -> Option<ResolvedModel> {
        model::resolve_model(candidates)
    }

    /// Load the durable selection for a conversation.
    pub fn load_conversation_model(
        &self,
        conversation_id: ConversationId,
    ) -> anyhow::Result<Option<ConversationModel>> {
        settings::load(conversation_id)
    }

    /// Persist an explicit selection for a conversation.
    pub fn save_conversation_model(
        &self,
        conversation_id: ConversationId,
        profile_name: Option<&str>,
        selection: &ModelSelection,
        source: ModelSource,
        provider_connection_id: Option<&str>,
    ) -> anyhow::Result<()> {
        settings::save(
            conversation_id,
            profile_name,
            selection,
            source,
            provider_connection_id,
        )
    }

    /// Serialize all ensure/resume/spawn operations for one conversation.
    pub fn conversation_lock(&self, conversation_id: &str) -> Arc<tokio::sync::Mutex<()>> {
        let mut locks = self
            .conversation_locks
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        locks.retain(|_, weak| weak.strong_count() > 0);
        if let Some(existing) = locks
            .get(conversation_id)
            .and_then(std::sync::Weak::upgrade)
        {
            return existing;
        }
        let lock = Arc::new(tokio::sync::Mutex::new(()));
        locks.insert(conversation_id.to_string(), Arc::downgrade(&lock));
        lock
    }
}
