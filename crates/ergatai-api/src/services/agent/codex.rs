use crate::services::agent::DiscoveredModels;
use crate::services::profile_service::{ProfileModelDetail, ProfileModelSource};
use serde_json::Value;
use std::fs;
use std::path::PathBuf;

pub async fn discover_models(_profile_name: &str, _cwd: Option<&str>) -> DiscoveredModels {
    let native_default = detect_native_config()
        .ok()
        .flatten()
        .and_then(|cfg| cfg.default_model);
    let config_details = crate::services::model_file_reader::read_codex_models();

    let mut merged: Vec<ProfileModelDetail> = Vec::new();
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut sources: Vec<ProfileModelSource> = Vec::new();

    if !config_details.is_empty() {
        sources.push(ProfileModelSource::ConfigFile);
        for d in config_details {
            if seen.insert(d.id.clone()) {
                merged.push(d);
            }
        }
    }

    // SDK discover (Codex may expose models via server API).
    let sdk = crate::services::agent_sdk_service::discover("codex", None).await;
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
        DiscoveredModels {
            details: Vec::new(),
            source: ProfileModelSource::None,
            sources: Vec::new(),
            current: None,
            default_model,
        }
    } else {
        let primary = sources
            .first()
            .copied()
            .unwrap_or(ProfileModelSource::ConfigFile);
        DiscoveredModels {
            details: merged,
            source: primary,
            sources,
            current: None,
            default_model,
        }
    }
}

pub async fn switch_model(
    _agent_id: &str,
    _model: &str,
    _cwd: Option<&str>,
    _session_id: Option<&str>,
) -> serde_json::Value {
    serde_json::json!({
        "ok": false,
        "error": "codex sdk does not support runtime model switch"
    })
}

pub async fn discover(cwd: Option<&str>) -> serde_json::Value {
    crate::services::agent_sdk_service::discover("codex", cwd).await
}

pub fn native_api_key() -> anyhow::Result<Option<String>> {
    use crate::services::native_agent_config;
    // Respect CODEX_HOME (consistent with read_models).
    let codex_home = std::env::var("CODEX_HOME")
        .ok()
        .map(PathBuf::from)
        .unwrap_or_else(|| native_agent_config::home_path(&[".codex"]));
    let auth_path = codex_home.join("auth.json");
    if auth_path.is_file() {
        let value: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(auth_path)?)?;
        if let Some(key) = value
            .get("OPENAI_API_KEY")
            .and_then(|v| v.as_str())
            .filter(|v| !v.trim().is_empty())
        {
            return Ok(Some(key.to_string()));
        }
    }
    let config_path = codex_home.join("config.toml");
    let key = if config_path.is_file() {
        let toml_value: toml::Value = toml::from_str(&std::fs::read_to_string(&config_path)?)?;
        let provider_id = toml_value
            .get("model_provider")
            .and_then(|v| v.as_str())
            .map(str::to_string);
        provider_id
            .as_deref()
            .and_then(|id| toml_value.get("model_providers").and_then(|v| v.get(id)))
            .and_then(|provider| {
                let provider: native_agent_config::CodexModelProvider =
                    provider.clone().try_into().ok()?;
                provider
                    .env_key
                    .as_deref()
                    .and_then(native_agent_config::env_var)
                    .or(provider.experimental_bearer_token.clone())
            })
            .or_else(|| native_agent_config::env_var("OPENAI_API_KEY"))
    } else {
        native_agent_config::env_var("OPENAI_API_KEY")
    };
    Ok(native_agent_config::trim_non_empty(key))
}

pub fn detect_native_config(
) -> anyhow::Result<Option<crate::services::native_agent_config::NativeAgentConfig>> {
    use crate::services::native_agent_config;
    let codex_home = std::env::var("CODEX_HOME")
        .ok()
        .map(PathBuf::from)
        .unwrap_or_else(|| native_agent_config::home_path(&[".codex"]));
    let path = codex_home.join("config.toml");
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
            .map(|provider: native_agent_config::CodexModelProvider| provider)
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
                .map(native_agent_config::env_var)
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
        || native_agent_config::env_var("OPENAI_API_KEY").is_some()
        || native_agent_config::home_path(&[".codex", "auth.json"]).is_file();

    Ok(Some(
        crate::services::native_agent_config::NativeAgentConfig {
            agent_id: "codex".to_string(),
            protocol: "openai_compatible".to_string(),
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
    let codex_home = std::env::var("CODEX_HOME")
        .ok()
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            std::env::var("HOME")
                .map(|h| PathBuf::from(h).join(".codex"))
                .unwrap_or_else(|_| PathBuf::from("/").join(".codex"))
        });
    crate::services::skills_service::scan_dir(&codex_home.join("skills"), "user", &mut out);
    crate::services::skills_service::scan_dir(
        &codex_home.join("skills").join(".system"),
        "user",
        &mut out,
    );
    if let Some(cwd) = cwd {
        crate::services::skills_service::scan_dir(
            &Path::new(cwd).join(".codex").join("skills"),
            "project",
            &mut out,
        );
    }
    out
}

pub async fn inject_mcp(
    cwd: Option<&str>,
    session_id: Option<&str>,
    servers_json: &str,
) -> serde_json::Value {
    crate::services::agent_sdk_service::inject_mcp("codex", cwd, session_id, servers_json).await
}

pub fn read_models(
    _cwd: Option<&str>,
) -> Vec<crate::services::profile_service::ProfileModelDetail> {
    use std::collections::HashSet;
    let mut models: Vec<ProfileModelDetail> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();

    let add = |models: &mut Vec<ProfileModelDetail>,
               seen: &mut HashSet<String>,
               id: String,
               name: String,
               description: String,
               provider: String| {
        if id.is_empty() || seen.contains(&id) {
            return;
        }
        seen.insert(id.clone());
        models.push(crate::services::profile_service::ProfileModelDetail {
            id,
            name,
            description,
            provider,
        });
    };

    let codex_home = std::env::var("CODEX_HOME")
        .ok()
        .map(PathBuf::from)
        .unwrap_or_else(|| dirs::home_dir().unwrap_or_default().join(".codex"));

    // Parse config.toml
    let mut top_model: Option<String> = None;
    let mut top_provider = "Codex".to_string();
    let mut catalog_path: Option<PathBuf> = None;
    let mut profile_models: Vec<(String, String)> = Vec::new();

    let mut codex_config_paths = vec![codex_home.join("config.toml")];
    if let Some(c) = _cwd {
        let project_cfg = PathBuf::from(c).join(".codex").join("config.toml");
        if project_cfg != codex_config_paths[0] {
            codex_config_paths.push(project_cfg);
        }
    }
    for cfg_path in &codex_config_paths {
        if let Ok(content) = fs::read_to_string(cfg_path) {
            let mut current: Option<String> = None;
            for raw in content.lines() {
                let t = raw.trim();
                if t.is_empty() || t.starts_with('#') {
                    continue;
                }
                // section header
                if t.starts_with('[') && t.ends_with(']') {
                    current = Some(t[1..t.len() - 1].trim().to_string());
                    continue;
                }
                let eq = match t.find('=') {
                    Some(i) => i,
                    None => continue,
                };
                let key = t[..eq].trim();
                let mut val = t[eq + 1..].trim();
                // strip inline comment
                if let Some(h) = val.find('#') {
                    val = val[..h].trim();
                }
                let val = val.trim_matches(|c| c == '"' || c == '\'');
                if val.is_empty() {
                    continue;
                }
                match &current {
                    None => {
                        if key == "model" {
                            top_model = Some(val.to_string());
                        } else if key == "model_provider" {
                            top_provider = val.to_string();
                        } else if key == "model_catalog_json" {
                            catalog_path = Some(PathBuf::from(val));
                        }
                    }
                    Some(sec) if sec.starts_with("profiles.") && key == "model" => {
                        profile_models
                            .push((sec["profiles.".len()..].to_string(), val.to_string()));
                    }
                    _ => {}
                }
            }
        }
    }

    let cp = catalog_path.unwrap_or_else(|| codex_home.join("config.models.json"));
    if let Ok(content) = fs::read_to_string(&cp) {
        if let Ok(cat) = serde_json::from_str::<Value>(&content) {
            if let Some(arr) = cat.get("models").and_then(|v| v.as_array()) {
                for m in arr {
                    let id = m
                        .get("slug")
                        .or_else(|| m.get("id"))
                        .or_else(|| m.get("model"))
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string();
                    if id.is_empty() {
                        continue;
                    }
                    let name = m
                        .get("display_name")
                        .or_else(|| m.get("name"))
                        .and_then(|v| v.as_str())
                        .unwrap_or(&id)
                        .to_string();
                    let desc = m
                        .get("description")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string();
                    add(&mut models, &mut seen, id, name, desc, top_provider.clone());
                }
            }
        }
    }

    if let Some(tm) = &top_model {
        add(
            &mut models,
            &mut seen,
            tm.clone(),
            tm.clone(),
            "Configured model".to_string(),
            top_provider.clone(),
        );
    }
    for (prof, model) in &profile_models {
        add(
            &mut models,
            &mut seen,
            model.clone(),
            model.clone(),
            format!("Configured via profile '{}'", prof),
            top_provider.clone(),
        );
    }

    // move top model to front
    if let Some(tm) = &top_model {
        if let Some(idx) = models.iter().position(|m| m.id == *tm) {
            if idx != 0 {
                let it = models.remove(idx);
                models.insert(0, it);
            }
        }
    }

    models
}
