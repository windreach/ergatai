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

fn home_path(relative: &[&str]) -> PathBuf {
    let mut path = std::env::var("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("/"));
    for segment in relative {
        path.push(segment);
    }
    path
}

fn trim_non_empty(value: Option<String>) -> Option<String> {
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
fn env_var(name: &str) -> Option<String> {
    trim_non_empty(std::env::var(name).ok())
}

/// Extract the string-valued subset of a JSON object (e.g. settings.json `env`).
fn json_str_map(value: &serde_json::Value) -> HashMap<String, String> {
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

fn detect_claude_code() -> Result<Option<NativeAgentConfig>> {
    let path = home_path(&[".claude", "settings.json"]);
    if !path.is_file() {
        return Ok(None);
    }
    let raw = std::fs::read_to_string(&path)?;
    let value: serde_json::Value = serde_json::from_str(&raw)?;

    let env: HashMap<String, String> = value.get("env").map(json_str_map).unwrap_or_default();
    let base_url = env
        .get("ANTHROPIC_BASE_URL")
        .cloned()
        .or_else(|| env_var("ANTHROPIC_BASE_URL"));
    let default_model = env
        .get("ANTHROPIC_MODEL")
        .cloned()
        .or_else(|| {
            value
                .get("model")
                .and_then(|v| v.as_str())
                .map(str::to_string)
        })
        .or_else(|| env_var("ANTHROPIC_MODEL"));
    let has_api_key = ["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY"]
        .iter()
        .any(|name| {
            env.get(*name)
                .map(|v| !v.trim().is_empty())
                .unwrap_or(false)
        })
        || env_var("ANTHROPIC_AUTH_TOKEN").is_some()
        || env_var("ANTHROPIC_API_KEY").is_some();

    Ok(Some(NativeAgentConfig {
        agent_id: "claude-code".to_string(),
        protocol: "anthropic".to_string(),
        source_path: path.to_string_lossy().to_string(),
        base_url: trim_non_empty(base_url),
        default_model: trim_non_empty(default_model),
        has_api_key,
    }))
}

#[derive(Debug, Deserialize)]
struct CodexModelProvider {
    #[serde(default)]
    base_url: Option<String>,
    #[serde(default)]
    env_key: Option<String>,
    #[serde(default)]
    experimental_bearer_token: Option<String>,
}

fn detect_codex() -> Result<Option<NativeAgentConfig>> {
    let path = home_path(&[".codex", "config.toml"]);
    if !path.is_file() {
        return Ok(None);
    }
    let raw = std::fs::read_to_string(&path)?;
    let value: toml::Value = toml::from_str(&raw)?;

    let default_model = value
        .get("model")
        .and_then(|v| v.as_str())
        .map(str::to_string);
    let provider_id = value
        .get("model_provider")
        .and_then(|v| v.as_str())
        .map(str::to_string);
    let provider = provider_id.as_deref().and_then(|id| {
        value
            .get("model_providers")
            .and_then(|v| v.get(id))
            .and_then(|v| v.clone().try_into().ok())
            .map(|provider: CodexModelProvider| provider)
    });

    let base_url = provider
        .as_ref()
        .and_then(|provider| provider.base_url.clone());
    let has_api_key = provider
        .as_ref()
        .map(|provider| {
            provider
                .env_key
                .as_deref()
                .map(env_var)
                .and_then(|v| v)
                .is_some()
                || provider
                    .experimental_bearer_token
                    .as_deref()
                    .map(|token| !token.trim().is_empty())
                    .unwrap_or(false)
        })
        .unwrap_or(false);
    let has_api_key = has_api_key
        || env_var("OPENAI_API_KEY").is_some()
        || home_path(&[".codex", "auth.json"]).is_file();

    Ok(Some(NativeAgentConfig {
        agent_id: "codex".to_string(),
        protocol: "openai_compatible".to_string(),
        source_path: path.to_string_lossy().to_string(),
        base_url: trim_non_empty(base_url),
        default_model: trim_non_empty(default_model),
        has_api_key,
    }))
}

fn opencode_config_candidates() -> Vec<PathBuf> {
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

fn opencode_config_path() -> Option<PathBuf> {
    opencode_config_candidates()
        .into_iter()
        .find(|path| path.is_file())
}

/// Strip `//` and `/* */` comments from a JSONC document so it can be parsed
/// by serde_json. String literals are preserved verbatim.
fn strip_json_comments(input: &str) -> String {
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

fn read_opencode_config(path: &PathBuf) -> Result<serde_json::Value> {
    let raw = std::fs::read_to_string(path)?;
    let stripped = strip_json_comments(&raw);
    Ok(serde_json::from_str(&stripped)?)
}

fn detect_opencode() -> Result<Option<NativeAgentConfig>> {
    let path = match opencode_config_path() {
        Some(path) => path,
        None => return Ok(None),
    };
    let value = read_opencode_config(&path)?;

    let default_model = value
        .get("model")
        .and_then(|v| v.as_str())
        .map(str::to_string);
    // model is "provider/model"; pick that provider's options when present.
    let provider_id = default_model
        .as_deref()
        .and_then(|model| model.split('/').next())
        .map(str::to_string);
    let options = provider_id.as_deref().and_then(|id| {
        value
            .get("provider")
            .and_then(|v| v.get(id))
            .and_then(|v| v.get("options"))
    });
    // Fall back to the first provider's options when no model/provider id is set.
    let options = options.or_else(|| {
        value
            .get("provider")
            .and_then(|v| v.as_object())
            .and_then(|obj| obj.values().next())
            .and_then(|v| v.get("options"))
    });
    let base_url = options
        .and_then(|v| v.get("baseURL"))
        .and_then(|v| v.as_str())
        .map(str::to_string);
    let has_api_key = options
        .and_then(|v| v.get("apiKey"))
        .and_then(|v| v.as_str())
        .map(|v| !v.trim().is_empty())
        .unwrap_or(false)
        || home_path(&[".local", "share", "opencode", "auth.json"]).is_file();

    Ok(Some(NativeAgentConfig {
        agent_id: "opencode".to_string(),
        protocol: "opencode".to_string(),
        source_path: path.to_string_lossy().to_string(),
        base_url: trim_non_empty(base_url),
        default_model: trim_non_empty(default_model),
        has_api_key,
    }))
}

/// Detect the agent's own default configuration. Returns None when the agent
/// has no recognizable config file.
pub fn detect(agent_id: &str) -> Result<Option<NativeAgentConfig>> {
    match agent_id {
        "claude-code" => detect_claude_code(),
        "codex" => detect_codex(),
        "opencode" => detect_opencode(),
        _ => Ok(None),
    }
}

/// Read the API key from the agent's native configuration (memory only).
fn native_api_key(agent_id: &str) -> Result<Option<String>> {
    let key = match agent_id {
        "claude-code" => {
            let path = home_path(&[".claude", "settings.json"]);
            let value: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(path)?)?;
            let env: HashMap<String, String> =
                value.get("env").map(json_str_map).unwrap_or_default();
            ["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY"]
                .iter()
                .find_map(|name| env.get(*name).filter(|v| !v.trim().is_empty()).cloned())
                .or_else(|| env_var("ANTHROPIC_AUTH_TOKEN"))
                .or_else(|| env_var("ANTHROPIC_API_KEY"))
        }
        "codex" => {
            let auth_path = home_path(&[".codex", "auth.json"]);
            if auth_path.is_file() {
                let value: serde_json::Value =
                    serde_json::from_str(&std::fs::read_to_string(auth_path)?)?;
                if let Some(key) = value
                    .get("OPENAI_API_KEY")
                    .and_then(|v| v.as_str())
                    .filter(|v| !v.trim().is_empty())
                {
                    return Ok(Some(key.to_string()));
                }
            }
            let config_path = home_path(&[".codex", "config.toml"]);
            let toml_value: toml::Value = toml::from_str(&std::fs::read_to_string(config_path)?)?;
            let provider_id = toml_value
                .get("model_provider")
                .and_then(|v| v.as_str())
                .map(str::to_string);
            provider_id
                .as_deref()
                .and_then(|id| toml_value.get("model_providers").and_then(|v| v.get(id)))
                .and_then(|provider| {
                    let provider: CodexModelProvider = provider.clone().try_into().ok()?;
                    provider
                        .env_key
                        .as_deref()
                        .and_then(env_var)
                        .or(provider.experimental_bearer_token.clone())
                })
                .or_else(|| env_var("OPENAI_API_KEY"))
        }
        "opencode" => {
            // Prefer the API key stored in the opencode config file (provider options).
            if let Some(path) = opencode_config_path() {
                if let Ok(value) = read_opencode_config(&path) {
                    let provider_id = value
                        .get("model")
                        .and_then(|v| v.as_str())
                        .and_then(|model| model.split('/').next())
                        .map(str::to_string);
                    let mut key = provider_id
                        .as_deref()
                        .and_then(|id| {
                            value
                                .get("provider")
                                .and_then(|v| v.get(id))
                                .and_then(|v| v.get("options"))
                                .and_then(|v| v.get("apiKey"))
                                .and_then(|v| v.as_str())
                        })
                        .map(str::to_string);
                    if key.is_none() {
                        if let Some(providers) = value.get("provider").and_then(|v| v.as_object()) {
                            for (_, provider) in providers {
                                if let Some(found) = provider
                                    .get("options")
                                    .and_then(|v| v.get("apiKey"))
                                    .and_then(|v| v.as_str())
                                {
                                    if !found.trim().is_empty() {
                                        key = Some(found.to_string());
                                        break;
                                    }
                                }
                            }
                        }
                    }
                    if let Some(key) = key {
                        if !key.trim().is_empty() {
                            return Ok(Some(key));
                        }
                    }
                }
            }
            // Fall back to the separate auth.json store.
            let auth_path = home_path(&[".local", "share", "opencode", "auth.json"]);
            if auth_path.is_file() {
                let value: serde_json::Value =
                    serde_json::from_str(&std::fs::read_to_string(auth_path)?)?;
                if let Some(entry) = value.as_object() {
                    if let Some((_, entry)) = entry.iter().next() {
                        if let Some(key) = entry.get("api_key").and_then(|v| v.as_str()) {
                            return Ok(Some(key.to_string()));
                        }
                    }
                }
            }
            None
        }
        _ => None,
    };
    Ok(trim_non_empty(key))
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
