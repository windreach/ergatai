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
    // Remove // line comments and /* */ block comments (naive, matches JS).
    let mut out = String::with_capacity(s.len());
    let bytes = s.as_bytes();
    let mut i = 0;
    let n = bytes.len();
    while i < n {
        if i + 1 < n && bytes[i] == b'/' && bytes[i + 1] == b'/' {
            while i < n && bytes[i] != b'\n' {
                i += 1;
            }
        } else if i + 1 < n && bytes[i] == b'/' && bytes[i + 1] == b'*' {
            i += 2;
            while i + 1 < n && !(bytes[i] == b'*' && bytes[i + 1] == b'/') {
                i += 1;
            }
            i = (i + 2).min(n);
        } else {
            out.push(bytes[i] as char);
            i += 1;
        }
    }
    out
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
