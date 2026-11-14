//! Thin compatibility wrapper over `agent::*` config readers.
//!
//! The per-agent implementations now live in `crate::services::agent`.

use crate::services::agent::{self, AgentKind};
use crate::services::profile_service::ProfileModelDetail;

/// Dispatch by agent kind.
pub fn read_models(agent_kind: &str, cwd: Option<&str>) -> Vec<ProfileModelDetail> {
    let kind = match agent_kind {
        "claude" => AgentKind::Claude,
        "codex" => AgentKind::Codex,
        "opencode" => AgentKind::OpenCode,
        _ => AgentKind::Unknown,
    };
    agent::read_models(kind, cwd)
}

pub fn read_claude_models() -> Vec<ProfileModelDetail> {
    read_models("claude", None)
}

pub fn read_opencode_models(cwd: Option<&str>) -> Vec<ProfileModelDetail> {
    read_models("opencode", cwd)
}

pub fn read_codex_models() -> Vec<ProfileModelDetail> {
    read_models("codex", None)
}

pub fn strip_json_comments(s: &str) -> String {
    // Delegate to the string-aware implementation in native_agent_config so that
    // comment markers inside string literals are preserved.
    crate::services::native_agent_config::strip_json_comments(s)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn read_claude_returns_configured_or_empty() {
        let m = read_claude_models();
        for model in &m {
            assert!(!model.id.is_empty());
        }
    }

    #[test]
    fn strip_comments_works() {
        let s = r#"{ "a": 1 // x
        /* block */ "b": 2 }"#;
        let out = strip_json_comments(s);
        assert!(!out.contains("x"));
        assert!(!out.contains("block"));
    }
}
