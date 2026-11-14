//! Agent-specific model discovery and runtime model switching.
//!
//! `agent` is intentionally thin: it resolves an agent kind and dispatches
//! to the corresponding agent module. All Claude / Codex / OpenCode details live
//! in their own files.

use crate::services::profile_service::{self, ProfileModelSource};
use ergatai_runtime::profile_registry::AgentRegistration;
use serde_json::Value;

pub mod claude;
pub mod codex;
pub mod opencode;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AgentKind {
    Claude,
    Codex,
    OpenCode,
    Unknown,
}

pub struct DiscoveredModels {
    pub details: Vec<profile_service::ProfileModelDetail>,
    /// Primary source (kept for backwards compatibility).
    pub source: ProfileModelSource,
    /// All sources that contributed models (merged read).
    pub sources: Vec<ProfileModelSource>,
    pub current: Option<String>,
    /// Default model detected from native config / SDK.
    pub default_model: Option<String>,
}

pub fn resolve_kind(profile: &AgentRegistration) -> AgentKind {
    resolve_kind_parts(&profile.name, &profile.command, &profile.agent_type)
}

pub fn resolve_kind_parts(name: &str, command: &str, agent_type: &str) -> AgentKind {
    // Prefer command + agent_type so custom profile names do not misclassify
    // an agent.
    let hay = format!("{} {} {}", name, command, agent_type).to_lowercase();
    if hay.contains("opencode") {
        AgentKind::OpenCode
    } else if hay.contains("codex") {
        AgentKind::Codex
    } else if hay.contains("claude") {
        AgentKind::Claude
    } else {
        AgentKind::Unknown
    }
}

pub async fn resolve_kind_by_name(name: &str) -> AgentKind {
    if let Ok(registry) = profile_service::get_profile_registry() {
        if let Ok(profiles) = registry.list_with_status() {
            if let Some(profile) = profiles.into_iter().find(|p| p.name == name) {
                return resolve_kind_parts(&profile.name, &profile.command, &profile.agent_type);
            }
        }
    }

    let hay = name.to_lowercase();
    if hay.contains("opencode") {
        AgentKind::OpenCode
    } else if hay.contains("codex") {
        AgentKind::Codex
    } else if hay.contains("claude") {
        AgentKind::Claude
    } else {
        AgentKind::Unknown
    }
}

pub async fn discover_models(
    kind: AgentKind,
    profile_name: &str,
    cwd: Option<&str>,
) -> DiscoveredModels {
    match kind {
        AgentKind::Claude => claude::discover_models(profile_name, cwd).await,
        AgentKind::Codex => codex::discover_models(profile_name, cwd).await,
        AgentKind::OpenCode => opencode::discover_models(profile_name, cwd).await,
        AgentKind::Unknown => DiscoveredModels {
            details: Vec::new(),
            source: ProfileModelSource::None,
            sources: Vec::new(),
            current: None,
            default_model: None,
        },
    }
}

// Runtime model switching is performed in-process by the ACP agent.
// SDK-based runtime switching has been removed.
pub async fn discover(kind: AgentKind, cwd: Option<&str>) -> Value {
    match kind {
        AgentKind::Claude => claude::discover(cwd).await,
        AgentKind::Codex => codex::discover(cwd).await,
        AgentKind::OpenCode => opencode::discover(cwd).await,
        AgentKind::Unknown => crate::services::agent_sdk_service::discover("", cwd).await,
    }
}

pub async fn inject_mcp(
    kind: AgentKind,
    cwd: Option<&str>,
    session_id: Option<&str>,
    servers_json: &str,
) -> Value {
    match kind {
        AgentKind::Claude => claude::inject_mcp(cwd, session_id, servers_json).await,
        AgentKind::Codex => codex::inject_mcp(cwd, session_id, servers_json).await,
        AgentKind::OpenCode => opencode::inject_mcp(cwd, session_id, servers_json).await,
        AgentKind::Unknown => serde_json::json!({"ok": false, "error": "unknown agent kind"}),
    }
}

pub fn read_models(
    kind: AgentKind,
    cwd: Option<&str>,
) -> Vec<crate::services::profile_service::ProfileModelDetail> {
    match kind {
        AgentKind::Claude => claude::read_models(cwd),
        AgentKind::Codex => codex::read_models(cwd),
        AgentKind::OpenCode => opencode::read_models(cwd),
        AgentKind::Unknown => Vec::new(),
    }
}

pub fn list_skills(
    kind: AgentKind,
    cwd: Option<&str>,
) -> Vec<crate::services::skills_service::SkillInfo> {
    match kind {
        AgentKind::Claude => claude::list_skills(cwd),
        AgentKind::Codex => codex::list_skills(cwd),
        AgentKind::OpenCode => opencode::list_skills(cwd),
        AgentKind::Unknown => crate::services::skills_service::list_skills(cwd, None),
    }
}

pub fn detect_native_config(
    kind: AgentKind,
) -> anyhow::Result<Option<crate::services::native_agent_config::NativeAgentConfig>> {
    match kind {
        AgentKind::Claude => claude::detect_native_config(),
        AgentKind::Codex => codex::detect_native_config(),
        AgentKind::OpenCode => opencode::detect_native_config(),
        AgentKind::Unknown => Ok(None),
    }
}

pub fn native_api_key(kind: AgentKind) -> anyhow::Result<Option<String>> {
    match kind {
        AgentKind::Claude => claude::native_api_key(),
        AgentKind::Codex => codex::native_api_key(),
        AgentKind::OpenCode => opencode::native_api_key(),
        AgentKind::Unknown => Ok(None),
    }
}

pub fn import_native_config(
    kind: AgentKind,
) -> anyhow::Result<crate::user_data_db::provider_connections::ProviderConnection> {
    let agent_id = match kind {
        AgentKind::Claude => "claude-code",
        AgentKind::Codex => "codex",
        AgentKind::OpenCode => "opencode",
        AgentKind::Unknown => return Err(anyhow::anyhow!("unknown agent kind")),
    };
    crate::services::native_agent_config::import(agent_id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use ergatai_runtime::profile_registry::AgentRegistration;

    #[test]
    fn resolve_kind_prefers_command_and_agent_type() {
        let profile = AgentRegistration::new(
            "my-custom-profile".to_string(),
            "opencode serve".to_string(),
            "acp".to_string(),
        );
        assert_eq!(resolve_kind(&profile), AgentKind::OpenCode);

        let profile =
            AgentRegistration::new("worker".to_string(), "codex".to_string(), "acp".to_string());
        assert_eq!(resolve_kind(&profile), AgentKind::Codex);

        let profile = AgentRegistration::new(
            "assistant".to_string(),
            "claude".to_string(),
            "acp".to_string(),
        );
        assert_eq!(resolve_kind(&profile), AgentKind::Claude);
    }

    #[test]
    fn resolve_kind_unknown_for_unrelated() {
        let profile = AgentRegistration::new(
            "worker".to_string(),
            "python3 agent.py".to_string(),
            "acp".to_string(),
        );
        assert_eq!(resolve_kind(&profile), AgentKind::Unknown);
    }
}
