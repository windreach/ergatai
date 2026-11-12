//! Agent Profile 服务 — 封装 ProfileRegistry 的全局单例访问。
//!
//! 职责：
//! - 使用 OnceLock 持有 ProfileRegistry 单例，避免每次请求都打开数据库。
//! - 提供业务层 API（注册、列表、查询、删除 agent profile）。
//! - 返回 `anyhow::Result<T>`，不涉及 HTTP 类型（handler 负责 HTTP 格式化）。
//!
//! 启动时调用 `init_profile_registry()` 初始化单例，
//! handler 通过 `get_profile_registry()` 获取单例引用。

use std::sync::OnceLock;

use anyhow::{Context, Result};
use ergatai_runtime::profile_registry::{AgentRegistration, ProfileRegistry, ProfileWithStatus};
use serde::{Deserialize, Serialize};

/// ProfileRegistry 全局单例。
///
/// 使用 OnceLock 确保只初始化一次，避免每次 handler 调用都打开 SQLite 数据库。
static PROFILE_REGISTRY: OnceLock<ProfileRegistry> = OnceLock::new();

/// Lifecycle of the profile-level model catalog. This is intentionally
/// separate from the runtime selection: `current` belongs to an agent session,
/// while this cache only describes the models an agent type can expose.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProfileModelStatus {
    Available,
    Unsupported,
    NotDetected,
}

/// Where the model catalog came from. The legacy cache had no source field;
/// it was produced by ACP config-option detection.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProfileModelSource {
    /// Detected via ACP `/config` options (legacy path).
    AcpConfigOptions,
    /// Detected via the agent's proprietary SDK (Claude `supportedModels()`,
    /// OpenCode provider config, etc.). Takes precedence over ACP detection.
    AgentSdk,
    /// Detected by reading the agent's config files directly (fast path).
    ConfigFile,
    /// No models detected yet.
    None,
}

/// Rich model metadata returned by agent SDKs.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ProfileModelDetail {
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub description: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub provider: String,
}

/// Profile-level model catalog returned by the HTTP API.
///
/// `current` is deliberately not persisted here. A profile can have multiple
/// running agents with different selected models; the runtime value must come
/// from the active agent's ACP config options.
#[derive(Debug, Clone, Serialize)]
pub struct ProfileModelCatalog {
    pub status: ProfileModelStatus,
    pub source: ProfileModelSource,
    pub models: Vec<String>,
    /// Rich model metadata (name/description) when detected via SDK.
    #[serde(skip_serializing_if = "Vec::is_empty", rename = "model_details")]
    pub model_details: Vec<ProfileModelDetail>,
    /// The last successfully observed list, preserved when a later refresh
    /// proves that the current agent does not expose a model selector.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub last_known_models: Vec<String>,
    /// ACP config option id, when the catalog came from a model selector.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub option_id: Option<String>,
    pub verified_at: Option<i64>,
    /// Backwards-compatible field. Runtime selected model is not cached here.
    pub current: Option<String>,
}

#[derive(Debug, Deserialize)]
struct StoredProfileModels {
    #[serde(default)]
    status: Option<ProfileModelStatus>,
    #[serde(default)]
    source: Option<ProfileModelSource>,
    #[serde(default)]
    models: Vec<String>,
    #[serde(default, rename = "model_details")]
    model_details: Vec<ProfileModelDetail>,
    #[serde(default)]
    last_known_models: Vec<String>,
    #[serde(default)]
    option_id: Option<String>,
}

fn normalize_profile_models(
    json_str: &str,
    updated_at: Option<i64>,
) -> Result<ProfileModelCatalog> {
    let stored: StoredProfileModels = serde_json::from_str(json_str)
        .map_err(|e| anyhow::anyhow!("Failed to parse models JSON: {}", e))?;

    let (status, source) = match (stored.status, stored.source) {
        (Some(status), Some(source)) => (status, source),
        // Legacy JSON had models/current only and was written by ACP detection.
        (None, _) if !stored.models.is_empty() => (
            ProfileModelStatus::Available,
            ProfileModelSource::AcpConfigOptions,
        ),
        _ => (ProfileModelStatus::NotDetected, ProfileModelSource::None),
    };

    // Guard against a stale/corrupt cache claiming success with no models.
    let (status, models) = if status == ProfileModelStatus::Available && stored.models.is_empty() {
        (ProfileModelStatus::NotDetected, Vec::new())
    } else {
        (status, stored.models)
    };

    Ok(ProfileModelCatalog {
        status,
        source,
        models,
        model_details: stored.model_details,
        last_known_models: stored.last_known_models,
        option_id: stored.option_id,
        verified_at: updated_at,
        current: None,
    })
}

fn models_json(models: &[String], option_id: Option<&str>) -> String {
    models_json_with_source(models, option_id, ProfileModelSource::AcpConfigOptions)
}

fn models_json_with_source(
    models: &[String],
    option_id: Option<&str>,
    source: ProfileModelSource,
) -> String {
    serde_json::json!({
        "status": ProfileModelStatus::Available,
        "source": source,
        "models": models,
        "last_known_models": models,
        "option_id": option_id,
        "verified_at": chrono::Utc::now().timestamp_millis(),
    })
    .to_string()
}

fn unsupported_json(previous_json: Option<&str>) -> Result<String> {
    let previous = previous_json
        .map(serde_json::from_str::<StoredProfileModels>)
        .transpose()
        .map_err(|e| anyhow::anyhow!("Failed to parse models JSON: {}", e))?;
    let last_known_models = match previous {
        Some(previous) if previous.status != Some(ProfileModelStatus::Unsupported) => {
            previous.models
        }
        Some(previous) => previous.last_known_models,
        None => Vec::new(),
    };

    Ok(serde_json::json!({
        "status": ProfileModelStatus::Unsupported,
        "source": ProfileModelSource::AcpConfigOptions,
        "models": [],
        "last_known_models": last_known_models,
        "option_id": Option::<String>::None,
        "verified_at": chrono::Utc::now().timestamp_millis(),
    })
    .to_string())
}

/// Profile 注册表数据库路径（与原始 handler 保持一致）。
///
/// 使用函数而非常量，因为路径现在从用户数据目录动态解析。
pub fn profile_registry_db_path() -> String {
    ergatai_runtime::dirs::profile_registry_db_path()
        .to_string_lossy()
        .to_string()
}

/// 初始化 ProfileRegistry 全局单例（启动时调用）。
///
/// 在 main.rs 启动流程中调用，确保 handler 使用前单例已就绪。
/// 多次调用不会重新初始化（OnceLock 保证）。
pub fn init_profile_registry() -> Result<&'static ProfileRegistry> {
    let registry = PROFILE_REGISTRY.get_or_init(|| {
        ProfileRegistry::new(profile_registry_db_path())
            .expect("Failed to open profile registry database")
    });
    Ok(registry)
}

/// 获取 ProfileRegistry 全局单例引用（handler 中调用）。
///
/// 如果 `init_profile_registry()` 未被调用，返回错误。
pub fn get_profile_registry() -> Result<&'static ProfileRegistry> {
    PROFILE_REGISTRY
        .get()
        .context("Profile registry not initialized — call init_profile_registry() at startup")
}

/// 注册新的 agent profile。
///
/// # Arguments
/// * `name` - profile 显示名称（用户友好的名称）
/// * `command` - agent 启动命令
/// * `agent_type` - agent 类型标识
/// * `package_name` - npm 包名（可选，用于安装/卸载）
/// * `avatar_url` - 头像 URL（可选）
pub async fn register_profile(
    name: String,
    command: String,
    agent_type: String,
    package_name: Option<String>,
    avatar_url: Option<String>,
    native_triggers: Option<Vec<serde_json::Value>>,
    discovery_triggers: Option<Vec<serde_json::Value>>,
) -> Result<()> {
    let registry = get_profile_registry()?;
    let mut registration =
        AgentRegistration::with_avatar_url(name, command, agent_type, package_name, avatar_url);
    let native_triggers = native_triggers
        .map(|triggers| {
            triggers
                .into_iter()
                .map(serde_json::from_value::<ergatai_runtime::profile_registry::AgentTriggerSpec>)
                .collect::<Result<Vec<_>, _>>()
        })
        .transpose()
        .map_err(|e| anyhow::anyhow!("Invalid native trigger metadata: {}", e))?;
    registration.native_triggers_json =
        ergatai_runtime::profile_registry::agent_triggers_json(native_triggers)
            .map_err(|e| anyhow::anyhow!("{}", e))?;

    // Discovery triggers use a looser schema (char, position, types, kind) — store as raw JSON.
    registration.discovery_triggers_json =
        discovery_triggers.map(|triggers| serde_json::to_string(&triggers).unwrap_or_default());

    registry
        .register(registration)
        .await
        .map_err(|e| anyhow::anyhow!("Failed to register profile: {}", e))
}

/// 列出所有已注册的 agent profiles。
pub async fn list_profiles() -> Result<Vec<AgentRegistration>> {
    let registry = get_profile_registry()?;
    registry
        .list()
        .await
        .map_err(|e| anyhow::anyhow!("Failed to list profiles: {}", e))
}

/// 获取指定 ID 的 agent profile。
///
/// 返回 None 表示 profile 不存在。
pub async fn get_profile(id: &str) -> Result<Option<AgentRegistration>> {
    let registry = get_profile_registry()?;
    registry
        .get(id)
        .await
        .map_err(|e| anyhow::anyhow!("Failed to get profile: {}", e))
}

/// 获取指定 name 的 agent profile。
///
/// 返回 None 表示 profile 不存在。
pub async fn get_profile_by_name(name: &str) -> Result<Option<AgentRegistration>> {
    let registry = get_profile_registry()?;
    registry
        .get_by_name(name)
        .await
        .map_err(|e| anyhow::anyhow!("Failed to get profile by name: {}", e))
}

/// 删除指定 ID 的 agent profile。
///
/// 同时删除该 profile 关联的所有 MCP 服务器配置（级联清理）。
/// 返回 true 表示删除成功，false 表示 profile 不存在。
pub async fn delete_profile(id: &str) -> Result<bool> {
    let registry = get_profile_registry()?;
    let deleted = registry
        .delete(id)
        .await
        .map_err(|e| anyhow::anyhow!("Failed to delete profile: {}", e))?;

    // Cascade: delete MCP servers bound to this profile
    // (profile_id FK can't be enforced at DB level because profile_registry.db is a separate database)
    if deleted {
        match crate::user_data_db::mcp_servers::delete_by_profile(id) {
            Ok(count) => {
                if count > 0 {
                    tracing::info!(
                        profile_id = %id,
                        deleted_count = count,
                        "Cascade deleted MCP servers for removed profile"
                    );
                }
            }
            Err(e) => {
                tracing::warn!(
                    profile_id = %id,
                    error = %e,
                    "Failed to cascade delete MCP servers for removed profile"
                );
            }
        }
    }

    Ok(deleted)
}

/// 列出所有 profile 及其安装状态。
pub fn list_profiles_with_status() -> Result<Vec<ProfileWithStatus>> {
    let registry = get_profile_registry()?;
    registry
        .list_with_status()
        .map_err(|e| anyhow::anyhow!("Failed to list profiles with status: {}", e))
}

/// 安装指定 profile ID 对应的 agent（通过 npm install -g）。
pub async fn install_agent(id: &str) -> Result<String> {
    let registry = get_profile_registry()?;
    registry
        .install(id)
        .await
        .map_err(|e| anyhow::anyhow!("Failed to install agent: {}", e))
}

/// 卸载指定 profile ID 对应的 agent（通过 npm uninstall -g）。
pub async fn uninstall_agent(id: &str) -> Result<String> {
    let registry = get_profile_registry()?;
    registry
        .uninstall(id)
        .await
        .map_err(|e| anyhow::anyhow!("Failed to uninstall agent: {}", e))
}

/// 获取指定 profile 的模型目录（按 profile name 查询）。
pub async fn get_profile_models_by_name(name: &str) -> Result<ProfileModelCatalog> {
    let registry = get_profile_registry()?;
    match registry.get_models_by_name(name).await {
        Ok(Some((json_str, updated_at))) => normalize_profile_models(&json_str, Some(updated_at)),
        Ok(None) => Ok(ProfileModelCatalog {
            status: ProfileModelStatus::NotDetected,
            source: ProfileModelSource::None,
            models: Vec::new(),
            model_details: Vec::new(),
            last_known_models: Vec::new(),
            option_id: None,
            verified_at: None,
            current: None,
        }),
        Err(e) => Err(anyhow::anyhow!("Failed to get profile models: {}", e)),
    }
}

/// 保存探测到的模型列表到 profile（按 profile name 保存，单次查询避免 TOCTOU）。
pub async fn save_profile_models_by_name(
    name: &str,
    models: &[String],
    option_id: Option<&str>,
) -> Result<()> {
    let registry = get_profile_registry()?;
    let json = models_json(models, option_id);
    let now_ms = chrono::Utc::now().timestamp_millis();
    registry
        .update_models_by_name(name, &json, now_ms)
        .await
        .map_err(|e| anyhow::anyhow!("Failed to save profile models: {}", e))
}

/// 通过 agent SDK 探测模型列表并保存到 profile。
///
/// 调用 `agent_sdk_service::discover` 获取 SDK 报告的模型列表，
/// 非空时以 `source=agent_sdk` 持久化到 profile cache，优先于 ACP 探测。
/// 返回实际保存的模型列表（空表示 SDK 未返回模型）。
pub async fn refresh_profile_models_via_sdk(
    agent_kind: &str,
    profile_name: &str,
    cwd: Option<&str>,
) -> Result<Vec<ProfileModelDetail>> {
    let sdk = crate::services::agent_sdk_service::discover(agent_kind, cwd).await;
    let mut details: Vec<ProfileModelDetail> = sdk
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
                    let mut provider = m
                        .get("provider")
                        .or_else(|| m.get("providerID"))
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string();
                    if provider.is_empty() {
                        provider = match agent_kind {
                            "claude" => "Anthropic".to_string(),
                            "codex" => "Codex".to_string(),
                            _ => String::new(),
                        };
                    }
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

    // Claude Code may be configured to use an external/gateway model (e.g. qwen)
    // that is not part of the SDK's built-in supportedModels() list. Merge the
    // CLI-reported current model so detection reflects the user's configuration.
    if agent_kind == "claude" {
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
                if let Some(current) = parsed.get("current").and_then(|v| v.as_str()) {
                    if !current.is_empty() && !details.iter().any(|d| d.id == current) {
                        // Prefer the user-configured model as the first entry so it
                        // becomes the default selection in the UI.
                        details.insert(
                            0,
                            ProfileModelDetail {
                                id: current.to_string(),
                                name: current.to_string(),
                                description: "Configured model".to_string(),
                                provider: "Configured".to_string(),
                            },
                        );
                    }
                }
            }
        }
    }

    // Codex has no SDK model list. Read ~/.codex/config.toml (honouring CODEX_HOME)
    // plus the configured model_catalog_json so the available models can be
    // enumerated instead of only the single configured default.
    if agent_kind == "codex" {
        let codex_home = std::env::var("CODEX_HOME")
            .ok()
            .map(std::path::PathBuf::from)
            .filter(|p| p.is_dir())
            .or_else(|| dirs::home_dir().map(|h| h.join(".codex")))
            .unwrap_or_default();

        let config_path = codex_home.join("config.toml");
        if let Ok(content) = tokio::fs::read_to_string(&config_path).await {
            // Parse top-level keys and [profiles.*] sections.
            let mut top_model: Option<String> = None;
            let mut top_provider = "Codex".to_string();
            let mut catalog_path: Option<std::path::PathBuf> = None;
            let mut profile_models: Vec<(String, String)> = Vec::new();
            let mut current_section: Option<String> = None;

            for raw in content.lines() {
                let trimmed = raw.trim();
                if trimmed.is_empty() || trimmed.starts_with('#') {
                    continue;
                }
                if trimmed.starts_with('[') && trimmed.ends_with(']') {
                    current_section = Some(
                        trimmed
                            .trim_start_matches('[')
                            .trim_end_matches(']')
                            .trim()
                            .to_string(),
                    );
                    continue;
                }
                let Some(eq) = trimmed.find('=') else {
                    continue;
                };
                let key = trimmed[..eq].trim();
                let mut val = trimmed[eq + 1..].trim().to_string();
                // Strip inline comments and surrounding quotes.
                if let Some(hash) = val.find('#') {
                    val = val[..hash].trim().to_string();
                }
                val = val.trim_matches('"').trim_matches('\'').trim().to_string();
                if val.is_empty() {
                    continue;
                }

                match current_section.as_deref() {
                    None => {
                        if key == "model" {
                            top_model = Some(val);
                        } else if key == "model_provider" {
                            top_provider = val;
                        } else if key == "model_catalog_json" {
                            catalog_path = Some(std::path::PathBuf::from(val));
                        }
                    }
                    Some(sec) if sec.starts_with("profiles.") && key == "model" => {
                        profile_models.push((sec.trim_start_matches("profiles.").to_string(), val));
                    }
                    _ => {}
                }
            }

            // 1. Enumerate from model_catalog_json (if present / readable).
            let cat_path = catalog_path.unwrap_or_else(|| codex_home.join("config.models.json"));
            if let Ok(cat_content) = tokio::fs::read_to_string(&cat_path).await {
                if let Ok(json) = serde_json::from_str::<serde_json::Value>(&cat_content) {
                    if let Some(arr) = json.get("models").and_then(|v| v.as_array()) {
                        for m in arr {
                            let id = m
                                .get("slug")
                                .or_else(|| m.get("id"))
                                .or_else(|| m.get("model"))
                                .and_then(|v| v.as_str())
                                .unwrap_or("");
                            if id.is_empty() || details.iter().any(|d| d.id == id) {
                                continue;
                            }
                            let name = m
                                .get("display_name")
                                .or_else(|| m.get("name"))
                                .and_then(|v| v.as_str())
                                .unwrap_or(id)
                                .to_string();
                            let description = m
                                .get("description")
                                .and_then(|v| v.as_str())
                                .unwrap_or("")
                                .to_string();
                            details.push(ProfileModelDetail {
                                id: id.to_string(),
                                name,
                                description,
                                provider: top_provider.clone(),
                            });
                        }
                    }
                }
            }

            // 2. Configured default model (prioritised first).
            if let Some(current) = top_model {
                if !details.iter().any(|d| d.id == current) {
                    details.insert(
                        0,
                        ProfileModelDetail {
                            id: current.clone(),
                            name: current.clone(),
                            description: "Configured model".to_string(),
                            provider: top_provider.clone(),
                        },
                    );
                } else if let Some(pos) = details.iter().position(|d| d.id == current) {
                    if pos != 0 {
                        let item = details.remove(pos);
                        details.insert(0, item);
                    }
                }
            }

            // 3. Models configured via profiles (kept as additional selectable entries).
            for (prof, model) in profile_models {
                if model.is_empty() || details.iter().any(|d| d.id == model) {
                    continue;
                }
                details.push(ProfileModelDetail {
                    id: model.clone(),
                    name: model.clone(),
                    description: format!("Configured via profile '{}'", prof),
                    provider: top_provider.clone(),
                });
            }
        }
    }

    // OpenCode: supplement from ~/.config/opencode/opencode.{json,jsonc} when the
    // running server/SDK is unavailable (degraded stage), so models are still
    // enumerated before the agent starts.
    if agent_kind == "opencode" {
        let mut config_paths: Vec<std::path::PathBuf> = Vec::new();
        if let Ok(p) = std::env::var("OPENCODE_CONFIG") {
            config_paths.push(std::path::PathBuf::from(p));
        }
        if let Some(home) = dirs::home_dir() {
            let base = home.join(".config").join("opencode");
            config_paths.push(base.join("opencode.json"));
            config_paths.push(base.join("opencode.jsonc"));
        }

        for config_path in config_paths {
            let Ok(content) = tokio::fs::read_to_string(&config_path).await else {
                continue;
            };
            let stripped = strip_json_comments(&content);
            let Ok(json) = serde_json::from_str::<serde_json::Value>(&stripped) else {
                continue;
            };

            // Providers -> models.
            if let Some(providers) = json.get("provider").and_then(|v| v.as_object()) {
                for (pname, pval) in providers {
                    let provider_name = pval
                        .get("name")
                        .and_then(|v| v.as_str())
                        .unwrap_or(pname)
                        .to_string();
                    if let Some(models) = pval.get("models").and_then(|v| v.as_object()) {
                        for mkey in models.keys() {
                            if details.iter().any(|d| d.id == *mkey) {
                                continue;
                            }
                            details.push(ProfileModelDetail {
                                id: mkey.clone(),
                                name: mkey.clone(),
                                description: String::new(),
                                provider: provider_name.clone(),
                            });
                        }
                    }
                }
            }

            // Default model (form "provider/model" -> model id).
            if let Some(dm) = json.get("model").and_then(|v| v.as_str()) {
                let id = dm.rsplit('/').next().unwrap_or(dm).to_string();
                if !id.is_empty() {
                    if !details.iter().any(|d| d.id == id) {
                        details.insert(
                            0,
                            ProfileModelDetail {
                                id: id.clone(),
                                name: id.clone(),
                                description: "Configured model".to_string(),
                                provider: "Configured".to_string(),
                            },
                        );
                    } else if let Some(pos) = details.iter().position(|d| d.id == id) {
                        if pos != 0 {
                            let item = details.remove(pos);
                            details.insert(0, item);
                        }
                    }
                }
            }
            break; // use first readable config
        }
    }

    // Claude: supplement from ~/.claude/settings.json when the CLI/SDK is
    // unavailable (degraded stage), reflecting configured model slots.
    if agent_kind == "claude" {
        if let Some(home) = dirs::home_dir() {
            let settings_path = home.join(".claude").join("settings.json");
            if let Ok(content) = tokio::fs::read_to_string(&settings_path).await {
                if let Ok(json) = serde_json::from_str::<serde_json::Value>(&content) {
                    let env = json.get("env");
                    let get_env = |key: &str| -> Option<String> {
                        env.and_then(|e| e.get(key))
                            .and_then(|v| v.as_str())
                            .map(|s| s.to_string())
                            .filter(|s| !s.is_empty())
                    };

                    // Configured model slots.
                    let slots = [
                        ("ANTHROPIC_DEFAULT_OPUS_MODEL", "opus"),
                        ("ANTHROPIC_DEFAULT_SONNET_MODEL", "sonnet"),
                        ("ANTHROPIC_DEFAULT_HAIKU_MODEL", "haiku"),
                    ];
                    for (env_key, slot) in slots {
                        if let Some(m) = get_env(env_key) {
                            if !details.iter().any(|d| d.id == m) {
                                details.push(ProfileModelDetail {
                                    id: m.clone(),
                                    name: m,
                                    description: format!("Configured {}", slot),
                                    provider: "Configured".to_string(),
                                });
                            }
                        }
                    }
                    // Default model (top-level "model" or ANTHROPIC_MODEL).
                    let mut default_model = json
                        .get("model")
                        .and_then(|v| v.as_str())
                        .map(|s| s.to_string())
                        .filter(|s| !s.is_empty());
                    if default_model.is_none() {
                        default_model = get_env("ANTHROPIC_MODEL");
                    }
                    if let Some(m) = default_model {
                        if !details.iter().any(|d| d.id == m) {
                            details.insert(
                                0,
                                ProfileModelDetail {
                                    id: m.clone(),
                                    name: m.clone(),
                                    description: "Configured model".to_string(),
                                    provider: "Configured".to_string(),
                                },
                            );
                        } else if let Some(pos) = details.iter().position(|d| d.id == m) {
                            if pos != 0 {
                                let item = details.remove(pos);
                                details.insert(0, item);
                            }
                        }
                    }
                }
            }
        }
    }

    if details.is_empty() {
        return Ok(details);
    }

    let models: Vec<String> = details.iter().map(|d| d.id.clone()).collect();
    let registry = get_profile_registry()?;
    // Persist both compact IDs and rich metadata in the existing JSON column.
    let json = serde_json::json!({
        "status": ProfileModelStatus::Available,
        "source": ProfileModelSource::AgentSdk,
        "models": models,
        "model_details": details,
        "last_known_models": models,
        "option_id": Option::<String>::None,
        "verified_at": chrono::Utc::now().timestamp_millis(),
    })
    .to_string();
    let now_ms = chrono::Utc::now().timestamp_millis();
    registry
        .update_models_by_name(profile_name, &json, now_ms)
        .await
        .map_err(|e| anyhow::anyhow!("Failed to save SDK-detected models: {}", e))?;

    Ok(details)
}

/// Persist a detected model list to the profile cache.
async fn persist_profile_models(
    profile_name: &str,
    details: &[ProfileModelDetail],
    source: ProfileModelSource,
) -> Result<()> {
    if details.is_empty() {
        return Ok(());
    }
    let models: Vec<String> = details.iter().map(|d| d.id.clone()).collect();
    let registry = get_profile_registry()?;
    let json = serde_json::json!({
        "status": ProfileModelStatus::Available,
        "source": source,
        "models": models,
        "model_details": details,
        "last_known_models": models,
        "option_id": Option::<String>::None,
        "verified_at": chrono::Utc::now().timestamp_millis(),
    })
    .to_string();
    let now_ms = chrono::Utc::now().timestamp_millis();
    registry
        .update_models_by_name(profile_name, &json, now_ms)
        .await
        .map_err(|e| anyhow::anyhow!("Failed to save models: {}", e))?;
    Ok(())
}

/// Fast model enumeration via direct config-file reads.
///
/// Primary path: reads the agent's own config files (milliseconds, no
/// subprocess). Falls back to the SDK only when `ERGATAI_MODEL_USE_SDK=1`
/// is set and file reading yielded nothing. Returns the persisted details.
pub async fn refresh_profile_models(
    agent_kind: &str,
    profile_name: &str,
    cwd: Option<&str>,
) -> Result<Vec<ProfileModelDetail>> {
    let details = crate::services::model_file_reader::read_models(agent_kind, cwd);
    if !details.is_empty() {
        persist_profile_models(profile_name, &details, ProfileModelSource::ConfigFile).await?;
        return Ok(details);
    }

    // Degraded fallback: file reading yielded nothing, try the SDK path
    // (slower, may require a running agent server) before giving up.
    match refresh_profile_models_via_sdk(agent_kind, profile_name, cwd).await {
        Ok(sdk_details) if !sdk_details.is_empty() => Ok(sdk_details),
        Ok(_) => Ok(details),
        Err(_) => Ok(details),
    }
}

/// 获取指定 profile 的模型目录（按 profile ID 查询）。
pub async fn get_profile_models(id: &str) -> Result<ProfileModelCatalog> {
    let registry = get_profile_registry()?;
    match registry.get_models(id).await {
        Ok(Some((json_str, updated_at))) => normalize_profile_models(&json_str, Some(updated_at)),
        Ok(None) => Ok(ProfileModelCatalog {
            status: ProfileModelStatus::NotDetected,
            source: ProfileModelSource::None,
            models: Vec::new(),
            model_details: Vec::new(),
            last_known_models: Vec::new(),
            option_id: None,
            verified_at: None,
            current: None,
        }),
        Err(e) => Err(anyhow::anyhow!("Failed to get profile models: {}", e)),
    }
}

/// 保存探测到的模型列表到 profile。
pub async fn save_profile_models(
    id: &str,
    models: &[String],
    option_id: Option<&str>,
) -> Result<()> {
    let registry = get_profile_registry()?;
    let json = models_json(models, option_id);
    let now_ms = chrono::Utc::now().timestamp_millis();
    registry
        .update_models(id, &json, now_ms)
        .await
        .map_err(|e| anyhow::anyhow!("Failed to save profile models: {}", e))
}

/// Mark a model catalog as unsupported after a definitive ACP read.
///
/// This does not erase the old list: it is retained as `last_known_models`
/// so diagnostics/UI can distinguish "stale" from "never detected".
pub async fn mark_profile_models_unavailable_by_name(name: &str) -> Result<()> {
    let registry = get_profile_registry()?;
    let previous = registry
        .get_models_by_name(name)
        .await
        .map_err(|e| anyhow::anyhow!("Failed to get profile models: {}", e))?
        .map(|(json, _)| json);
    let json = unsupported_json(previous.as_deref())?;
    let now_ms = chrono::Utc::now().timestamp_millis();
    registry
        .update_models_by_name(name, &json, now_ms)
        .await
        .map_err(|e| anyhow::anyhow!("Failed to save profile models: {}", e))
}

/// Strip `//` and `/* */` comments from a JSON-with-comments (JSONC) string so
/// it can be parsed by `serde_json`.
fn strip_json_comments(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let bytes = input.as_bytes();
    let mut i = 0;
    let mut in_string = false;
    let mut escape = false;
    while i < bytes.len() {
        let c = bytes[i] as char;
        if in_string {
            out.push(c);
            if escape {
                escape = false;
            } else if c == '\\' {
                escape = true;
            } else if c == '"' {
                in_string = false;
            }
            i += 1;
            continue;
        }
        // line comment
        if c == '/' && i + 1 < bytes.len() && bytes[i + 1] as char == '/' {
            while i < bytes.len() && bytes[i] as char != '\n' {
                i += 1;
            }
            continue;
        }
        // block comment
        if c == '/' && i + 1 < bytes.len() && bytes[i + 1] as char == '*' {
            i += 2;
            while i + 1 < bytes.len() && !(bytes[i] as char == '*' && bytes[i + 1] as char == '/') {
                i += 1;
            }
            i += 2;
            continue;
        }
        if c == '"' {
            in_string = true;
        }
        out.push(c);
        i += 1;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_legacy_available_models() {
        let catalog =
            normalize_profile_models(r#"{"models":["model-a"],"current":"model-a"}"#, Some(123))
                .unwrap();
        assert_eq!(catalog.status, ProfileModelStatus::Available);
        assert_eq!(catalog.source, ProfileModelSource::AcpConfigOptions);
        assert_eq!(catalog.models, vec!["model-a"]);
        assert_eq!(catalog.verified_at, Some(123));
        assert_eq!(catalog.current, None);
    }

    #[test]
    fn unsupported_preserves_last_known_models_once() {
        let json =
            unsupported_json(Some(r#"{"status":"available","models":["model-a"]}"#)).unwrap();
        let catalog = normalize_profile_models(&json, Some(456)).unwrap();
        assert_eq!(catalog.status, ProfileModelStatus::Unsupported);
        assert_eq!(catalog.last_known_models, vec!["model-a"]);

        let json = unsupported_json(Some(&json)).unwrap();
        let catalog = normalize_profile_models(&json, Some(457)).unwrap();
        assert_eq!(catalog.last_known_models, vec!["model-a"]);
    }
}
