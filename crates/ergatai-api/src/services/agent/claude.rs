use crate::services::agent::DiscoveredModels;
use crate::services::profile_service::{ProfileModelDetail, ProfileModelSource};
use serde_json::Value;
use std::fs;

pub async fn discover_models(_profile_name: &str, _cwd: Option<&str>) -> DiscoveredModels {
    let native_default = detect_native_config()
        .ok()
        .flatten()
        .and_then(|cfg| cfg.default_model);

    let mut merged: Vec<ProfileModelDetail> = Vec::new();
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut sources: Vec<ProfileModelSource> = Vec::new();
    let mut current: Option<String> = None;

    // 1. Config file (includes configured model slots).
    let config_details = crate::services::model_file_reader::read_claude_models();
    if !config_details.is_empty() {
        sources.push(ProfileModelSource::ConfigFile);
        for d in config_details {
            if seen.insert(d.id.clone()) {
                merged.push(d);
            }
        }
    }

    // 2. CLI /model.
    let claude = if std::path::Path::new("/root/.local/bin/claude").exists() {
        "/root/.local/bin/claude"
    } else {
        "claude"
    };
    if let Ok(output) = tokio::process::Command::new(claude)
        .arg("/model")
        .output()
        .await
    {
        let text = String::from_utf8_lossy(&output.stdout);
        if let Some(parsed) = crate::api::agents::parse_model_output(&text) {
            let cli_current = parsed
                .get("current")
                .and_then(Value::as_str)
                .map(ToString::to_string);
            if current.is_none() {
                current = cli_current;
            }
            let is_gateway = current
                .as_ref()
                .map(|c| {
                    let l = c.to_lowercase();
                    !(l.contains("sonnet")
                        || l.contains("opus")
                        || l.contains("haiku")
                        || l.contains("fable")
                        || l.contains("claude"))
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

            if !models.is_empty() {
                sources.push(ProfileModelSource::AcpConfigOptions);
                let details: Vec<ProfileModelDetail> = models
                    .into_iter()
                    .map(|m| ProfileModelDetail {
                        id: m.clone(),
                        name: m.clone(),
                        description: String::new(),
                        provider: "Anthropic".to_string(),
                    })
                    .collect();
                for d in details {
                    if seen.insert(d.id.clone()) {
                        merged.push(d);
                    }
                }
            }
        }
    }

    // SDK discover (optional).
    let sdk = crate::services::agent_sdk_service::discover("claude", None).await;
    let sdk_details: Vec<ProfileModelDetail> = sdk
        .get("models")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|m| {
                    let id = m
                        .get("id")
                        .or_else(|| m.get("value"))
                        .or_else(|| m.get("name"))
                        .or_else(|| m.get("model"))
                        .and_then(|v| v.as_str())?
                        .to_string();
                    if id.is_empty() {
                        return None;
                    }
                    let name = m
                        .get("name")
                        .or_else(|| m.get("displayName"))
                        .and_then(|v| v.as_str())
                        .unwrap_or(&id)
                        .to_string();
                    let description = m
                        .get("description")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string();
                    let provider = m
                        .get("provider")
                        .or_else(|| m.get("providerID"))
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
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
    if !sdk_details.is_empty() {
        sources.push(ProfileModelSource::AgentSdk);
        for d in sdk_details {
            if seen.insert(d.id.clone()) {
                merged.push(d);
            }
        }
    }

    let default_model = native_default;

    if merged.is_empty() {
        // Base catalog fallback so the selector is never empty.
        let fallback = vec![
            ProfileModelDetail {
                id: "opus".to_string(),
                name: "Opus".to_string(),
                description: String::new(),
                provider: "Anthropic".to_string(),
            },
            ProfileModelDetail {
                id: "sonnet".to_string(),
                name: "Sonnet".to_string(),
                description: String::new(),
                provider: "Anthropic".to_string(),
            },
            ProfileModelDetail {
                id: "haiku".to_string(),
                name: "Haiku".to_string(),
                description: String::new(),
                provider: "Anthropic".to_string(),
            },
        ];
        return DiscoveredModels {
            details: fallback,
            source: ProfileModelSource::ConfigFile,
            sources: vec![ProfileModelSource::ConfigFile],
            current,
            default_model,
        };
    }

    let primary = sources
        .first()
        .copied()
        .unwrap_or(ProfileModelSource::ConfigFile);
    DiscoveredModels {
        details: merged,
        source: primary,
        sources,
        current,
        default_model,
    }
}

pub async fn switch_model(
    _agent_id: &str,
    model: &str,
    cwd: Option<&str>,
    session_id: Option<&str>,
) -> Value {
    let sdk =
        crate::services::agent_sdk_service::switch_model("claude", model, cwd, session_id).await;
    if sdk.get("ok").and_then(|v| v.as_bool()).unwrap_or(false) {
        return sdk;
    }

    serde_json::json!({
        "ok": false,
        "error": sdk.get("error").cloned().unwrap_or_else(|| serde_json::json!("claude sdk failed")),
        "via": "sdk_failed",
        "sdk_error": sdk.get("error").cloned(),
    })
}

pub async fn discover(cwd: Option<&str>) -> serde_json::Value {
    crate::services::agent_sdk_service::discover("claude", cwd).await
}

pub fn native_api_key() -> anyhow::Result<Option<String>> {
    use crate::services::native_agent_config;
    let path = native_agent_config::home_path(&[".claude", "settings.json"]);
    let value: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(path)?)?;
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
    let path = native_agent_config::home_path(&[".claude", "settings.json"]);
    if !path.is_file() {
        return Ok(None);
    }
    let raw = std::fs::read_to_string(&path)?;
    let value: serde_json::Value = serde_json::from_str(&raw)?;

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
    crate::services::skills_service::scan_marketplaces(&home, &mut out);
    out
}

pub async fn inject_mcp(
    cwd: Option<&str>,
    session_id: Option<&str>,
    servers_json: &str,
) -> serde_json::Value {
    crate::services::agent_sdk_service::inject_mcp("claude", cwd, session_id, servers_json).await
}

pub fn read_models(
    _cwd: Option<&str>,
) -> Vec<crate::services::profile_service::ProfileModelDetail> {
    // Base catalog mirrors frontend CLAUDE_MODELS so the selector is never
    // empty even when settings.json has no overrides.
    let mut models: Vec<ProfileModelDetail> = Vec::new();

    let settings_path = match dirs::home_dir() {
        Some(h) => h.join(".claude").join("settings.json"),
        None => return models,
    };
    let content = match fs::read_to_string(&settings_path) {
        Ok(c) => c,
        Err(_) => return models,
    };
    let cfg: Value = match serde_json::from_str(&content) {
        Ok(v) => v,
        Err(_) => return models,
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
                    provider: "Configured".to_string(),
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
                        provider: "Configured".to_string(),
                    },
                );
            }
        }
    }

    models
}
