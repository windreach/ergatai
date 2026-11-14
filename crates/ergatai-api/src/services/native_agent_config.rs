//! Detect an agent's own native default configuration and import it as a
//! provider connection.
//!
//! Users typically configure their agents before ever opening Ergatai:
//! Claude Code via `~/.claude/settings.json`, Codex via `~/.codex/config.toml`
//! (+ `auth.json`), OpenCode via `~/.config/opencode/opencode.json`. The
//! Connections panel surfaces that configuration as the initial, pre-owned
//! default for the agent so users start from what already works instead of an
//! empty list.

use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use utoipa::ToSchema;

use crate::services::provider_connection_service;
use crate::user_data_db::provider_connections::ProviderConnectionUpsert;

/// The agent's own default configuration, read from its config files.
/// Never contains the API key itself — only whether one exists.
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct NativeAgentConfig {
    pub agent_id: String,
    pub protocol: String,
    /// Config file the values were read from (for display).
    pub source_path: String,
    pub base_url: Option<String>,
    pub default_model: Option<String>,
    /// True when an API key/token was found in the agent's own configuration.
    pub has_api_key: bool,
}

pub fn home_path(relative: &[&str]) -> PathBuf {
    let mut path = std::env::var("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("/"));
    for segment in relative {
        path.push(segment);
    }
    path
}

pub fn trim_non_empty(value: Option<String>) -> Option<String> {
    value.and_then(|v| {
        let trimmed = v.trim().to_string();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed)
        }
    })
}

/// Look up an environment variable, returning None when unset or empty.
pub fn env_var(name: &str) -> Option<String> {
    trim_non_empty(std::env::var(name).ok())
}

/// Extract the string-valued subset of a JSON object (e.g. settings.json `env`).
pub fn json_str_map(value: &serde_json::Value) -> HashMap<String, String> {
    value
        .as_object()
        .map(|object| {
            object
                .iter()
                .filter_map(|(key, value)| value.as_str().map(|v| (key.clone(), v.to_string())))
                .collect()
        })
        .unwrap_or_default()
}

#[derive(Debug, Deserialize)]
pub struct CodexModelProvider {
    #[serde(default)]
    pub base_url: Option<String>,
    #[serde(default)]
    pub env_key: Option<String>,
    #[serde(default)]
    pub experimental_bearer_token: Option<String>,
}

pub fn opencode_config_candidates() -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    for base in [vec![".config", "opencode"], vec![".opencode"]] {
        for name in ["opencode.json", "opencode.jsonc"] {
            let mut rel = base.clone();
            rel.push(name);
            candidates.push(home_path(&rel.to_vec()));
        }
    }
    candidates
}

pub fn opencode_config_path() -> Option<PathBuf> {
    opencode_config_candidates()
        .into_iter()
        .find(|path| path.is_file())
}

/// Strip `//` and `/* */` comments from a JSONC document so it can be parsed
/// by serde_json. String literals are preserved verbatim.
pub fn strip_json_comments(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let bytes = input.as_bytes();
    let mut i = 0;
    let mut in_string = false;
    let mut escape = false;
    while i < bytes.len() {
        if in_string {
            out.push(bytes[i] as char);
            if escape {
                escape = false;
            } else if bytes[i] == b'\\' {
                escape = true;
            } else if bytes[i] == b'"' {
                in_string = false;
            }
            i += 1;
            continue;
        }
        // Detect string start
        if bytes[i] == b'"' {
            in_string = true;
            out.push('"');
            i += 1;
            continue;
        }
        // Line comment
        if i + 1 < bytes.len() && bytes[i] == b'/' && bytes[i + 1] == b'/' {
            i += 2;
            while i < bytes.len() && bytes[i] != b'\n' {
                i += 1;
            }
            continue;
        }
        // Block comment
        if i + 1 < bytes.len() && bytes[i] == b'/' && bytes[i + 1] == b'*' {
            i += 2;
            while i + 1 < bytes.len() && !(bytes[i] == b'*' && bytes[i + 1] == b'/') {
                i += 1;
            }
            i = (i + 2).min(bytes.len());
            continue;
        }
        out.push(bytes[i] as char);
        i += 1;
    }
    out
}

pub fn read_opencode_config(path: &PathBuf) -> Result<serde_json::Value> {
    let raw = std::fs::read_to_string(path)?;
    let stripped = strip_json_comments(&raw);
    Ok(serde_json::from_str(&stripped)?)
}

/// Detect the agent's own default configuration. Returns None when the agent
/// has no recognizable config file.
pub fn detect(agent_id: &str) -> Result<Option<NativeAgentConfig>> {
    let kind = match agent_id {
        "claude-code" => crate::services::agent::AgentKind::Claude,
        "codex" => crate::services::agent::AgentKind::Codex,
        "opencode" => crate::services::agent::AgentKind::OpenCode,
        _ => crate::services::agent::AgentKind::Unknown,
    };
    if kind == crate::services::agent::AgentKind::Unknown {
        return Ok(None);
    }
    crate::services::agent::detect_native_config(kind)
}

/// Read the API key from the agent's native configuration (memory only).
fn native_api_key(agent_id: &str) -> Result<Option<String>> {
    let kind = match agent_id {
        "claude-code" => crate::services::agent::AgentKind::Claude,
        "codex" => crate::services::agent::AgentKind::Codex,
        "opencode" => crate::services::agent::AgentKind::OpenCode,
        _ => crate::services::agent::AgentKind::Unknown,
    };
    if kind == crate::services::agent::AgentKind::Unknown {
        return Ok(None);
    }
    crate::services::agent::native_api_key(kind)
}

/// Import the agent's native default configuration as a provider connection
/// owned by that agent. The connection becomes the agent's default so it
/// reproduces exactly what the agent used before registration.
pub fn import(
    agent_id: &str,
) -> Result<crate::user_data_db::provider_connections::ProviderConnection> {
    let config = detect(agent_id)?
        .ok_or_else(|| anyhow!("No native configuration found for agent '{}'", agent_id))?;

    // Reuse the imported connection if it already exists for this agent.
    let existing = provider_connection_service::list()?
        .into_iter()
        .find(|connection| {
            connection.agent_id == agent_id && connection.name == "Default (imported)"
        })
        .map(|connection| connection.id);

    let api_key = native_api_key(agent_id)?;
    let saved = provider_connection_service::upsert(
        ProviderConnectionUpsert {
            id: existing,
            name: "Default (imported)".to_string(),
            agent_id: agent_id.to_string(),
            protocol: config.protocol.clone(),
            base_url: config.base_url.clone(),
            default_model: config.default_model.clone(),
            is_default: true,
        },
        api_key.as_deref(),
    )?;
    Ok(saved)
}
