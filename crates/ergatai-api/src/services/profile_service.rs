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

/// ProfileRegistry 全局单例。
///
/// 使用 OnceLock 确保只初始化一次，避免每次 handler 调用都打开 SQLite 数据库。
static PROFILE_REGISTRY: OnceLock<ProfileRegistry> = OnceLock::new();

/// Profile 注册表数据库路径（与原始 handler 保持一致）。
const PROFILE_REGISTRY_DB_PATH: &str = ".ergatai/profile_registry.db";

/// 初始化 ProfileRegistry 全局单例（启动时调用）。
///
/// 在 main.rs 启动流程中调用，确保 handler 使用前单例已就绪。
/// 多次调用不会重新初始化（OnceLock 保证）。
pub fn init_profile_registry() -> Result<&'static ProfileRegistry> {
    let registry = PROFILE_REGISTRY.get_or_init(|| {
        ProfileRegistry::new(PROFILE_REGISTRY_DB_PATH)
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
/// * `name` - profile 名称（唯一）
/// * `command` - agent 启动命令
/// * `agent_type` - agent 类型标识
/// * `package_name` - npm 包名（可选，用于安装/卸载）
pub async fn register_profile(
    name: String,
    command: String,
    agent_type: String,
    package_name: Option<String>,
) -> Result<()> {
    let registry = get_profile_registry()?;
    let registration = AgentRegistration::with_package_name(name, command, agent_type, package_name);
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

/// 获取指定名称的 agent profile。
///
/// 返回 None 表示 profile 不存在。
pub async fn get_profile(name: &str) -> Result<Option<AgentRegistration>> {
    let registry = get_profile_registry()?;
    registry
        .get(name)
        .await
        .map_err(|e| anyhow::anyhow!("Failed to get profile: {}", e))
}

/// 删除指定名称的 agent profile。
///
/// 返回 true 表示删除成功，false 表示 profile 不存在。
pub async fn delete_profile(name: &str) -> Result<bool> {
    let registry = get_profile_registry()?;
    registry
        .delete(name)
        .await
        .map_err(|e| anyhow::anyhow!("Failed to delete profile: {}", e))
}

/// 列出所有 profile 及其安装状态。
pub fn list_profiles_with_status() -> Result<Vec<ProfileWithStatus>> {
    let registry = get_profile_registry()?;
    registry
        .list_with_status()
        .map_err(|e| anyhow::anyhow!("Failed to list profiles with status: {}", e))
}

/// 安装指定 profile 对应的 agent（通过 npm install -g）。
pub async fn install_agent(name: &str) -> Result<String> {
    let registry = get_profile_registry()?;
    registry
        .install(name)
        .await
        .map_err(|e| anyhow::anyhow!("Failed to install agent: {}", e))
}

/// 卸载指定 profile 对应的 agent（通过 npm uninstall -g）。
pub async fn uninstall_agent(name: &str) -> Result<String> {
    let registry = get_profile_registry()?;
    registry
        .uninstall(name)
        .await
        .map_err(|e| anyhow::anyhow!("Failed to uninstall agent: {}", e))
}
