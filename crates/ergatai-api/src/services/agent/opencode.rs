use crate::services::agent::DiscoveredModels;
use crate::services::profile_service::{ProfileModelDetail, ProfileModelSource};
use serde_json::Value;
use std::fs;
use std::path::PathBuf;

pub async fn discover_models(_profile_name: &str, cwd: Option<&str>) -> DiscoveredModels {
    let native_default = detect_native_config()
        .ok()
        .flatten()
        .and_then(|cfg| cfg.default_model);
    let current = native_default.clone();

    // Parallel read: config file + SDK.
    let config_details = crate::services::model_file_reader::read_opencode_models(cwd);
    let sdk_future = crate::services::agent_sdk_service::discover("opencode", cwd);

    // Run SDK discovery concurrently with (already sync) config read by awaiting now.
    let sdk = sdk_future.await;

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

    // SDK default model if present
    let sdk_default = sdk
        .get("default_model")
        .and_then(|v| v.as_str())
        .map(str::to_string);

    let default_model = native_default.or(sdk_default);

    if merged.is_empty() {
        DiscoveredModels {
            details: Vec::new(),
            source: ProfileModelSource::None,
            sources: Vec::new(),
            current,
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
            current,
            default_model,
        }
    }
}

// Runtime model switching is performed in-process by the ACP agent.
// SDK-based runtime switching has been removed.

pub async fn discover(cwd: Option<&str>) -> serde_json::Value {
    crate::services::agent_sdk_service::discover("opencode", cwd).await
}

pub fn native_api_key() -> anyhow::Result<Option<String>> {
    use crate::services::native_agent_config;
    if let Some(path) = native_agent_config::opencode_config_path() {
        if let Ok(value) = native_agent_config::read_opencode_config(&path) {
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
    let auth_path = native_agent_config::home_path(&[".local", "share", "opencode", "auth.json"]);
    if auth_path.is_file() {
        let value: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(auth_path)?)?;
        if let Some(entry) = value.as_object() {
            if let Some((_, entry)) = entry.iter().next() {
                if let Some(key) = entry.get("api_key").and_then(|v| v.as_str()) {
                    return Ok(Some(key.to_string()));
                }
            }
        }
    }
    Ok(None)
}

pub fn detect_native_config(
) -> anyhow::Result<Option<crate::services::native_agent_config::NativeAgentConfig>> {
    use crate::services::native_agent_config;
    let path = match native_agent_config::opencode_config_path() {
        Some(path) => path,
        None => return Ok(None),
    };
    let value = native_agent_config::read_opencode_config(&path)?;

    let default_model = value
        .get("model")
        .and_then(|v| v.as_str())
        .map(str::to_string);
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
        || native_agent_config::home_path(&[".local", "share", "opencode", "auth.json"]).is_file();

    Ok(Some(
        crate::services::native_agent_config::NativeAgentConfig {
            agent_id: "opencode".to_string(),
            protocol: "opencode".to_string(),
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
    // OpenCode reads skills from its own directories plus Claude-compatible
    // and agent-ecosystem-compatible locations.
    crate::services::skills_service::scan_dir(
        &home.join(".config").join("opencode").join("skills"),
        "user",
        &mut out,
    );
    crate::services::skills_service::scan_dir(
        &home.join(".claude").join("skills"),
        "user",
        &mut out,
    );
    crate::services::skills_service::scan_dir(
        &home.join(".agents").join("skills"),
        "user",
        &mut out,
    );
    if let Some(cwd) = cwd {
        crate::services::skills_service::scan_dir(
            &Path::new(cwd).join(".opencode").join("skills"),
            "project",
            &mut out,
        );
        crate::services::skills_service::scan_dir(
            &Path::new(cwd).join(".claude").join("skills"),
            "project",
            &mut out,
        );
        crate::services::skills_service::scan_dir(
            &Path::new(cwd).join(".agents").join("skills"),
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
    crate::services::agent_sdk_service::inject_mcp("opencode", cwd, session_id, servers_json).await
}

/// Resolve the provider for a model that only appears in the config's
/// `model` field. OpenCode model IDs are normally `provider/model`.
fn resolve_model_provider(model_id: &str, providers: &serde_json::Map<String, Value>) -> String {
    if let Some((provider_id, _)) = model_id.split_once('/') {
        return providers
            .get(provider_id)
            .and_then(|provider| provider.get("name"))
            .and_then(|name| name.as_str())
            .filter(|name| !name.is_empty())
            .unwrap_or(provider_id)
            .to_string();
    }

    for (provider_id, provider) in providers {
        let contains_model = provider
            .get("models")
            .and_then(|models| models.as_object())
            .map(|models| models.contains_key(model_id))
            .unwrap_or(false);
        if contains_model {
            return provider
                .get("name")
                .and_then(|name| name.as_str())
                .unwrap_or(provider_id.as_str())
                .to_string();
        }
    }

    // A single configured provider can safely be inferred for a bare model ID.
    if providers.len() == 1 {
        if let Some((provider_id, provider)) = providers.iter().next() {
            return provider
                .get("name")
                .and_then(|name| name.as_str())
                .unwrap_or(provider_id.as_str())
                .to_string();
        }
    }

    String::new()
}

pub fn read_models(cwd: Option<&str>) -> Vec<crate::services::profile_service::ProfileModelDetail> {
    let mut models: Vec<ProfileModelDetail> = Vec::new();
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();

    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Ok(p) = std::env::var("OPENCODE_CONFIG") {
        if !p.trim().is_empty() {
            candidates.push(PathBuf::from(p));
        }
    }
    if let Some(home) = dirs::home_dir() {
        candidates.push(home.join(".config").join("opencode").join("opencode.json"));
        candidates.push(home.join(".config").join("opencode").join("opencode.jsonc"));
    }
    // cwd-local config as a last resort.
    if let Some(c) = cwd {
        candidates.push(PathBuf::from(c).join("opencode.json"));
    }

    let mut loaded = false;
    for cp in candidates {
        let content = match fs::read_to_string(&cp) {
            Ok(c) => c,
            Err(_) => continue,
        };
        // strip comments
        let stripped = crate::services::model_file_reader::strip_json_comments(&content);
        let cfg: Value = match serde_json::from_str(&stripped) {
            Ok(v) => v,
            Err(_) => continue,
        };
        loaded = true;

        let providers = cfg
            .get("provider")
            .and_then(|v| v.as_object())
            .cloned()
            .unwrap_or_default();
        for (pname, pval) in providers.iter() {
            let pname_str = pval
                .get("name")
                .and_then(|v| v.as_str())
                .unwrap_or(pname)
                .to_string();
            if let Some(mobj) = pval.get("models").and_then(|v| v.as_object()) {
                for mkey in mobj.keys() {
                    // Keep the provider-qualified ID so it matches the IDs reported
                    // by OpenCode ACP config options (e.g. `opencode-go/foo`).
                    let full_id = format!("{}/{}", pname, mkey);
                    if seen.contains(&full_id) {
                        continue;
                    }
                    seen.insert(full_id.clone());
                    models.push(crate::services::profile_service::ProfileModelDetail {
                        id: full_id,
                        name: mkey.clone(),
                        description: String::new(),
                        provider: pname_str.clone(),
                    });
                }
            }
        }

        // default model
        let dm = cfg
            .get("model")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
        if let Some(dm) = dm {
            if !dm.is_empty() {
                // Keep the full provider-qualified default model ID so it matches
                // ACP config option values.
                let id = dm.clone();
                if !seen.contains(&id) {
                    let name = id
                        .split_once('/')
                        .map(|(_, model)| model)
                        .unwrap_or(&id)
                        .to_string();
                    let provider = resolve_model_provider(&id, &providers);
                    models.insert(
                        0,
                        crate::services::profile_service::ProfileModelDetail {
                            id: id.clone(),
                            name,
                            description: "Configured model".to_string(),
                            provider,
                        },
                    );
                    seen.insert(id);
                } else {
                    if let Some(idx) = models.iter().position(|m| m.id == id) {
                        if idx != 0 {
                            let it = models.remove(idx);
                            models.insert(0, it);
                        }
                    }
                }
            }
        }

        if !models.is_empty() {
            break;
        }
    }

    if !loaded && models.is_empty() {
        // nothing found; leave empty so caller can fall back
    }
    models
}
