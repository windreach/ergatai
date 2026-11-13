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
    /// All sources that contributed to this catalog.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub sources: Vec<ProfileModelSource>,
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
    /// Default model detected from native config / SDK.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_model: Option<String>,
}

#[derive(Debug, Deserialize)]
struct StoredProfileModels {
    #[serde(default)]
    status: Option<ProfileModelStatus>,
    #[serde(default)]
    source: Option<ProfileModelSource>,
    #[serde(default)]
    sources: Vec<ProfileModelSource>,
    #[serde(default)]
    models: Vec<String>,
    #[serde(default, rename = "model_details")]
    model_details: Vec<ProfileModelDetail>,
    #[serde(default)]
    last_known_models: Vec<String>,
    #[serde(default)]
    option_id: Option<String>,
    #[serde(default)]
    default_model: Option<String>,
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

    let sources = if stored.sources.is_empty() {
        if source == ProfileModelSource::None {
            Vec::new()
        } else {
            vec![source]
        }
    } else {
        stored.sources
    };

    Ok(ProfileModelCatalog {
        status,
        source,
        sources,
        models,
        model_details: stored.model_details,
        last_known_models: stored.last_known_models,
        option_id: stored.option_id,
        verified_at: updated_at,
        current: None,
        default_model: stored.default_model,
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
    // Load cached catalog from DB.
    let cached = match registry.get_models_by_name(name).await {
        Ok(Some((json_str, updated_at))) => {
            Some(normalize_profile_models(&json_str, Some(updated_at))?)
        }
        Ok(None) => None,
        Err(e) => return Err(anyhow::anyhow!("Failed to get profile models: {}", e)),
    };

    // Real-time static config file read + merge (per plan: static file read on every open).
    let mut catalog = cached.unwrap_or(ProfileModelCatalog {
        status: ProfileModelStatus::NotDetected,
        source: ProfileModelSource::None,
        sources: Vec::new(),
        models: Vec::new(),
        model_details: Vec::new(),
        last_known_models: Vec::new(),
        option_id: None,
        verified_at: None,
        current: None,
        default_model: None,
    });

    // Resolve agent kind for this profile to read its config file.
    if let Ok(Some(profile)) = get_profile_by_name(name).await {
        let kind = crate::services::agent::resolve_kind(&profile);
        let file_details = crate::services::agent::read_models(kind, None);
        if !file_details.is_empty() {
            // Merge file details into catalog (file takes precedence for metadata).
            let mut seen: std::collections::HashSet<String> =
                catalog.models.iter().cloned().collect();
            let mut merged_details = catalog.model_details.clone();
            // Ensure all file models present.
            for fd in &file_details {
                if !seen.contains(&fd.id) {
                    seen.insert(fd.id.clone());
                    merged_details.push(fd.clone());
                    catalog.models.push(fd.id.clone());
                } else {
                    // Update metadata if already present.
                    if let Some(existing) = merged_details.iter_mut().find(|d| d.id == fd.id) {
                        if !fd.name.is_empty() {
                            existing.name = fd.name.clone();
                        }
                        if !fd.description.is_empty() {
                            existing.description = fd.description.clone();
                        }
                        if !fd.provider.is_empty() {
                            existing.provider = fd.provider.clone();
                        }
                    }
                }
            }
            catalog.model_details = merged_details;
            if catalog.status == ProfileModelStatus::NotDetected {
                catalog.status = ProfileModelStatus::Available;
            }
            if !catalog.sources.contains(&ProfileModelSource::ConfigFile) {
                catalog.sources.push(ProfileModelSource::ConfigFile);
            }
            if catalog.source == ProfileModelSource::None {
                catalog.source = ProfileModelSource::ConfigFile;
            }
            // last_known_models
            if catalog.last_known_models.is_empty() {
                catalog.last_known_models = catalog.models.clone();
            }
            catalog.verified_at = Some(chrono::Utc::now().timestamp_millis());
            // Persist merged catalog back to DB (best effort).
            let _ = persist_merged_catalog(name, &catalog).await;
        }
    }

    Ok(catalog)
}

/// Persist a full merged catalog back to profile (best-effort, used by real-time file merge).
async fn persist_merged_catalog(name: &str, catalog: &ProfileModelCatalog) -> Result<()> {
    let registry = get_profile_registry()?;
    let json = serde_json::json!({
        "status": catalog.status,
        "source": catalog.source,
        "sources": catalog.sources,
        "models": catalog.models,
        "model_details": catalog.model_details,
        "last_known_models": catalog.last_known_models,
        "option_id": catalog.option_id,
        "verified_at": catalog.verified_at,
        "default_model": catalog.default_model,
    })
    .to_string();
    let now_ms = chrono::Utc::now().timestamp_millis();
    registry
        .update_models_by_name(name, &json, now_ms)
        .await
        .map_err(|e| anyhow::anyhow!("Failed to save models: {}", e))?;
    Ok(())
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
/// Persist a detected model list to the profile cache.
pub async fn persist_profile_models(
    profile_name: &str,
    details: &[ProfileModelDetail],
    source: ProfileModelSource,
    sources: &[ProfileModelSource],
    default_model: Option<&str>,
) -> Result<()> {
    if details.is_empty() {
        return Ok(());
    }
    let models: Vec<String> = details.iter().map(|d| d.id.clone()).collect();
    let registry = get_profile_registry()?;
    let sources = if sources.is_empty() {
        vec![source]
    } else {
        sources.to_vec()
    };
    let json = serde_json::json!({
        "status": ProfileModelStatus::Available,
        "source": source,
        "sources": sources,
        "models": models,
        "model_details": details,
        "last_known_models": models,
        "option_id": Option::<String>::None,
        "verified_at": chrono::Utc::now().timestamp_millis(),
        "default_model": default_model,
    })
    .to_string();
    let now_ms = chrono::Utc::now().timestamp_millis();
    registry
        .update_models_by_name(profile_name, &json, now_ms)
        .await
        .map_err(|e| anyhow::anyhow!("Failed to save models: {}", e))?;
    Ok(())
}
/// 获取指定 profile 的模型目录（按 profile ID 查询）。
pub async fn get_profile_models(id: &str) -> Result<ProfileModelCatalog> {
    let registry = get_profile_registry()?;
    match registry.get_models(id).await {
        Ok(Some((json_str, updated_at))) => normalize_profile_models(&json_str, Some(updated_at)),
        Ok(None) => Ok(ProfileModelCatalog {
            status: ProfileModelStatus::NotDetected,
            source: ProfileModelSource::None,
            sources: Vec::new(),
            models: Vec::new(),
            model_details: Vec::new(),
            last_known_models: Vec::new(),
            option_id: None,
            verified_at: None,
            current: None,
            default_model: None,
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
