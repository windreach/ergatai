use crate::services::profile_service::{ProfileModelDetail, ProfileModelSource};
use serde_json::Value;

use super::source::SourceReading;

/// Claude Code CLI `/model` query. Ranked below live ACP but above the SDK:
/// it reflects the CLI's own view of usable models.
pub async fn read_cli_models() -> SourceReading {
    let claude = if std::path::Path::new("/root/.local/bin/claude").exists() {
        "/root/.local/bin/claude"
    } else {
        "claude"
    };
    let output = match tokio::process::Command::new(claude)
        .arg("/model")
        .output()
        .await
    {
        Ok(output) => output,
        Err(error) => {
            return SourceReading::unavailable(
                ProfileModelSource::CliModelCommand,
                format!("failed to run claude /model: {error}"),
            )
        }
    };

    let text = String::from_utf8_lossy(&output.stdout);
    let Some(parsed) = crate::api::agents::parse_model_output(&text) else {
        return SourceReading::unavailable(
            ProfileModelSource::CliModelCommand,
            "claude /model returned no parseable model list",
        );
    };

    let current = parsed
        .get("current")
        .and_then(Value::as_str)
        .map(ToString::to_string);
    let is_gateway = current
        .as_ref()
        .map(|c| {
            let lower = c.to_lowercase();
            !(lower.contains("sonnet")
                || lower.contains("opus")
                || lower.contains("haiku")
                || lower.contains("fable")
                || lower.contains("claude"))
        })
        .unwrap_or(false);

    let models: Vec<String> = parsed
        .get("models")
        .and_then(Value::as_array)
        .map(|values| {
            values
                .iter()
                .filter_map(Value::as_str)
                .filter(|m| {
                    if !is_gateway {
                        return true;
                    }
                    let lower = m.to_lowercase();
                    !lower.contains('[')
                        && lower != "best"
                        && lower != "opusplan"
                        && lower != "default"
                })
                .map(ToString::to_string)
                .collect()
        })
        .unwrap_or_default();

    if models.is_empty() {
        return SourceReading::unavailable(
            ProfileModelSource::CliModelCommand,
            "claude /model returned an empty model list",
        );
    }

    let details = models
        .into_iter()
        .map(|model| ProfileModelDetail {
            id: model.clone(),
            name: model,
            description: String::new(),
            provider: "Anthropic".to_string(),
        })
        .collect();
    SourceReading::success(ProfileModelSource::CliModelCommand, details, current, None)
}

/// Claude Agent SDK `supportedModels()`.
pub async fn read_sdk() -> SourceReading {
    let sdk = crate::services::agent_sdk_service::discover("claude", None).await;
    if let Some(error) = sdk.get("error").and_then(Value::as_str) {
        return SourceReading::unavailable(ProfileModelSource::AgentSdk, error);
    }

    let default_model = sdk
        .get("default_model")
        .and_then(Value::as_str)
        .map(str::to_string);

    let details: Vec<ProfileModelDetail> = sdk
        .get("models")
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter_map(|m| {
                    let id = m
                        .get("id")
                        .or_else(|| m.get("value"))
                        .or_else(|| m.get("name"))
                        .or_else(|| m.get("model"))
                        .and_then(Value::as_str)?
                        .to_string();
                    if id.is_empty() {
                        return None;
                    }
                    let name = m
                        .get("name")
                        .or_else(|| m.get("displayName"))
                        .and_then(Value::as_str)
                        .unwrap_or(&id)
                        .to_string();
                    let description = m
                        .get("description")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_string();
                    let provider = m
                        .get("provider")
                        .or_else(|| m.get("providerID"))
                        .and_then(Value::as_str)
                        .filter(|provider| !provider.is_empty())
                        .unwrap_or("Anthropic")
                        .to_string();
                    Some(ProfileModelDetail {
                        id,
                        name,
                        description,
                        provider,
                    })
                })
                .collect()
        })
        .unwrap_or_default();

    if details.is_empty() {
        SourceReading::unavailable(
            ProfileModelSource::AgentSdk,
            "Claude SDK returned no models",
        )
    } else {
        SourceReading::success(ProfileModelSource::AgentSdk, details, None, default_model)
    }
}

// Runtime model switching is performed in-process by the ACP agent.
// SDK-based runtime switching has been removed.

pub async fn discover(cwd: Option<&str>) -> serde_json::Value {
    crate::services::agent_sdk_service::discover("claude", cwd).await
}

/// Deep-merge overlay into base for Claude settings (env deep-merged, others override).
pub fn merge_claude_settings(base: &mut serde_json::Value, overlay: serde_json::Value) {
    if let (Some(b), Some(o)) = (base.as_object_mut(), overlay.as_object()) {
        for (k, v) in o {
            if k == "env" {
                if let Some(env_obj) = v.as_object() {
                    let target = b
                        .entry("env".to_string())
                        .or_insert_with(|| serde_json::json!({}));
                    if let Some(t) = target.as_object_mut() {
                        for (ek, ev) in env_obj {
                            t.insert(ek.clone(), ev.clone());
                        }
                    }
                }
            } else {
                b.insert(k.clone(), v.clone());
            }
        }
    }
}

/// Load and merge Claude settings from home, with `settings.local.json` overriding
/// `settings.json` (env deep-merged). Returns None when neither exists.
pub fn load_claude_settings() -> Option<serde_json::Value> {
    load_claude_settings_with_cwd(None)
}

/// Load home + optional project-level Claude settings (`.claude/settings*.json`),
/// merged in priority order: home base -> home local -> project base -> project local.
pub fn load_claude_settings_with_cwd(cwd: Option<&str>) -> Option<serde_json::Value> {
    use crate::services::native_agent_config;
    let home = dirs::home_dir()?;
    let mut merged = serde_json::json!({});
    let mut found = false;

    // Home-level
    for name in ["settings.json", "settings.local.json"] {
        let path = home.join(".claude").join(name);
        if !path.is_file() {
            continue;
        }
        if let Ok(raw) = std::fs::read_to_string(&path) {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&raw) {
                merge_claude_settings(&mut merged, v);
                found = true;
            }
        }
    }

    // Project-level (when cwd provided)
    if let Some(c) = cwd {
        for name in ["settings.json", "settings.local.json"] {
            let path = std::path::Path::new(c).join(".claude").join(name);
            if !path.is_file() {
                continue;
            }
            if let Ok(raw) = std::fs::read_to_string(&path) {
                if let Ok(v) = serde_json::from_str::<serde_json::Value>(&raw) {
                    merge_claude_settings(&mut merged, v);
                    found = true;
                }
            }
        }
    }

    if !found {
        let _ = native_agent_config::env_var;
        return None;
    }
    Some(merged)
}

pub fn native_api_key() -> anyhow::Result<Option<String>> {
    use crate::services::native_agent_config;
    let value = match load_claude_settings() {
        Some(v) => v,
        None => {
            return Ok(native_agent_config::env_var("ANTHROPIC_API_KEY")
                .or_else(|| native_agent_config::env_var("ANTHROPIC_AUTH_TOKEN")));
        }
    };
    let env: std::collections::HashMap<String, String> = value
        .get("env")
        .map(native_agent_config::json_str_map)
        .unwrap_or_default();
    let key = ["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY"]
        .iter()
        .find_map(|name| env.get(*name).filter(|v| !v.trim().is_empty()).cloned())
        .or_else(|| native_agent_config::env_var("ANTHROPIC_AUTH_TOKEN"))
        .or_else(|| native_agent_config::env_var("ANTHROPIC_API_KEY"));
    Ok(native_agent_config::trim_non_empty(key))
}

pub fn detect_native_config(
) -> anyhow::Result<Option<crate::services::native_agent_config::NativeAgentConfig>> {
    use crate::services::native_agent_config;
    let value = match load_claude_settings() {
        Some(v) => v,
        None => return Ok(None),
    };
    let path = native_agent_config::home_path(&[".claude", "settings.json"]);

    let env: std::collections::HashMap<String, String> = value
        .get("env")
        .map(native_agent_config::json_str_map)
        .unwrap_or_default();
    let base_url = env
        .get("ANTHROPIC_BASE_URL")
        .cloned()
        .or_else(|| native_agent_config::env_var("ANTHROPIC_BASE_URL"));
    let default_model = env
        .get("ANTHROPIC_MODEL")
        .cloned()
        .or_else(|| {
            value
                .get("model")
                .and_then(|v| v.as_str())
                .map(str::to_string)
        })
        .or_else(|| native_agent_config::env_var("ANTHROPIC_MODEL"));
    let has_api_key = ["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY"]
        .iter()
        .any(|name| {
            env.get(*name)
                .map(|v| !v.trim().is_empty())
                .unwrap_or(false)
        })
        || native_agent_config::env_var("ANTHROPIC_AUTH_TOKEN").is_some()
        || native_agent_config::env_var("ANTHROPIC_API_KEY").is_some();

    Ok(Some(
        crate::services::native_agent_config::NativeAgentConfig {
            agent_id: "claude-code".to_string(),
            protocol: "anthropic".to_string(),
            source_path: path.to_string_lossy().to_string(),
            base_url: native_agent_config::trim_non_empty(base_url),
            default_model: native_agent_config::trim_non_empty(default_model),
            has_api_key,
        },
    ))
}

/// Agent-specific skill mention conversion rules.
/// Claude: skill mentions become slash commands (`$[skill:name]` -> `/name`).
pub fn convert_skill_mentions(message: &str) -> String {
    use regex::Regex;
    let mut result = message.to_string();
    for trig in ["@", "$", "#"] {
        if let Ok(re) = Regex::new(&format!(r"{}\[(skill):([^\]]+)\]", regex::escape(trig))) {
            result = re.replace_all(&result, "/$2").to_string();
        }
    }
    result
}

pub fn list_skills(cwd: Option<&str>) -> Vec<crate::services::skills_service::SkillInfo> {
    use std::path::Path;
    let mut out = Vec::new();
    let home = std::env::var("HOME")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|_| std::path::PathBuf::from("/"));
    crate::services::skills_service::scan_dir(
        &home.join(".claude").join("skills"),
        "user",
        &mut out,
    );
    if let Some(cwd) = cwd {
        crate::services::skills_service::scan_dir(
            &Path::new(cwd).join(".claude").join("skills"),
            "project",
            &mut out,
        );
    }
    crate::services::skills_service::scan_claude_plugin_skills(&home, cwd, &mut out);
    crate::services::skills_service::apply_claude_skill_overrides(&home, cwd, &mut out);
    out
}

pub async fn inject_mcp(
    cwd: Option<&str>,
    session_id: Option<&str>,
    servers_json: &str,
) -> serde_json::Value {
    crate::services::agent_sdk_service::inject_mcp("claude", cwd, session_id, servers_json).await
}

/// Claude Code models are served by Anthropic unless the configured model ID
/// carries an explicit provider prefix.
fn resolve_configured_provider(model_id: &str) -> String {
    model_id
        .split_once('/')
        .map(|(provider, _)| provider)
        .filter(|provider| !provider.is_empty())
        .unwrap_or("Anthropic")
        .to_string()
}

pub(crate) fn base_catalog() -> Vec<ProfileModelDetail> {
    ["opus", "sonnet", "haiku"]
        .into_iter()
        .map(|model| ProfileModelDetail {
            id: model.to_string(),
            name: model.to_string(),
            description: String::new(),
            provider: "Anthropic".to_string(),
        })
        .collect()
}

pub fn read_models(
    _cwd: Option<&str>,
) -> Vec<crate::services::profile_service::ProfileModelDetail> {
    // Base catalog mirrors frontend CLAUDE_MODELS so the selector is never
    // empty even when settings.json has no overrides.
    let mut models: Vec<ProfileModelDetail> = Vec::new();

    let cfg = match load_claude_settings_with_cwd(_cwd) {
        Some(v) => v,
        None => return models,
    };

    let env = cfg.get("env").and_then(|v| v.as_object());

    // Configured slot overrides.
    let slots = [
        ("ANTHROPIC_DEFAULT_OPUS_MODEL", "opus"),
        ("ANTHROPIC_DEFAULT_SONNET_MODEL", "sonnet"),
        ("ANTHROPIC_DEFAULT_HAIKU_MODEL", "haiku"),
    ];
    for (env_key, slot) in slots {
        let val = env
            .and_then(|e| e.get(env_key))
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
            .or_else(|| {
                cfg.get(env_key)
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string())
            });
        if let Some(m) = val {
            if !m.is_empty() && !models.iter().any(|x| x.id == m) {
                models.push(crate::services::profile_service::ProfileModelDetail {
                    id: m.clone(),
                    name: m.clone(),
                    description: format!("Configured {}", slot),
                    provider: resolve_configured_provider(&m),
                });
            }
        }
    }

    // Default model.
    let default_model = cfg
        .get("model")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .or_else(|| {
            env.and_then(|e| e.get("ANTHROPIC_MODEL"))
                .and_then(|v| v.as_str())
                .map(|s| s.to_string())
        });

    if let Some(dm) = default_model {
        if !dm.is_empty() {
            if let Some(idx) = models.iter().position(|x| x.id == dm) {
                if idx != 0 {
                    let it = models.remove(idx);
                    models.insert(0, it);
                }
            } else {
                models.insert(
                    0,
                    crate::services::profile_service::ProfileModelDetail {
                        id: dm.clone(),
                        name: dm.clone(),
                        description: "Configured model".to_string(),
                        provider: resolve_configured_provider(&dm),
                    },
                );
            }
        }
    }

    models
}
