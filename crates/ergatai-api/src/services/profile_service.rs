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
use ergatai_runtime::binary_detection;
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
    seed_default_profiles(registry);
    Ok(registry)
}

/// Official agent profiles auto-registered at startup if not already present.
fn seed_default_profiles(registry: &ProfileRegistry) {
    // Remove stale dev-adapter registrations (command contains "/adapters/")
    // These were manually registered before auto-seeding existed and use
    // `node .../adapters/...` commands that pass the is_installed check
    // because `node` itself is on PATH.
    tokio::task::block_in_place(|| {
        tokio::runtime::Handle::current().block_on(async {
            let all = match registry.list().await {
                Ok(items) => items,
                Err(_) => return,
            };
            for reg in all {
                if reg.command.contains("/adapters/") {
                    let _ = registry.delete(&reg.id).await;
                    tracing::info!("Removed stale adapter profile '{}' (id: {})", reg.name, reg.id);
                }
            }
        })
    });

    let defaults: &[(&str, &str, &str, &str, Option<&str>)] = &[
        (
            "claude-code",
            "npx -y @agentclientprotocol/claude-agent-acp@latest",
            "claude",
            "acp",
            Some("@agentclientprotocol/claude-agent-acp"),
        ),
        (
            "codex",
            "npx -y @agentclientprotocol/codex-acp@latest",
            "codex",
            "acp",
            Some("@agentclientprotocol/codex-acp"),
        ),
        (
            "gemini",
            "gemini --acp",
            "gemini",
            "acp",
            Some("@google/gemini-cli"),
        ),
        ("goose", "goose run --acp", "goose", "acp", None),
        (
            "opencode",
            "opencode acp",
            "opencode",
            "acp",
            Some("opencode"),
        ),
        ("cline", "cline --acp", "cline", "acp", Some("cline")),
        ("kiro", "kiro-cli acp", "kiro-cli", "acp", Some("@kiro/cli")),
        ("hermes", "hermes acp", "hermes", "acp", None),
        ("openclaw", "openclaw acp", "openclaw", "acp", None),
        ("auggie", "auggie --acp", "auggie", "acp", None),
    ];

    for (name, command, host_binary, agent_type, package_name) in defaults {
        // Only register agents whose binary is actually installed on the system
        if !binary_detection::is_installed(host_binary) {
            tracing::debug!("Default profile '{}' skipped — binary not installed", name);
            continue;
        }

        // Use name as the stable ID for default profiles
        let registration = AgentRegistration::with_id(
            name.to_string(),
            name.to_string(),
            command.to_string(),
            agent_type.to_string(),
            package_name.map(|s| s.to_string()),
        );
        let registry_ref = registry;
        // Upsert: register if missing, update if command differs
        match tokio::task::block_in_place(|| {
            tokio::runtime::Handle::current().block_on(async {
                match registry_ref.get(name).await {
                    Ok(Some(existing))
                        if existing.command == *command
                            && existing.package_name == package_name.map(|s| s.to_string()) =>
                    {
                        Ok(())
                    }
                    Ok(Some(_existing)) => {
                        // Stale command — replace with the canonical default
                        let _ = registry_ref.delete(name).await;
                        registry_ref.register(registration).await
                    }
                    Ok(None) => registry_ref.register(registration).await,
                    Err(_) => Ok(()),
                }
            })
        }) {
            Ok(_) => {}
            Err(e) => {
                tracing::debug!("Default profile '{}' skipped: {}", name, e);
            }
        }

        // Background update: silently update npm adapter packages for installed agents
        if let Some(pkg) = package_name {
            if binary_detection::is_installed(host_binary) {
                let pkg = pkg.to_string();
                tokio::spawn(async move {
                    tracing::info!(package = %pkg, "Updating adapter package in background");
                    match ergatai_runtime::agent_installer::install_npm(&pkg).await {
                        Ok(_) => {
                            tracing::info!(package = %pkg, "Adapter package updated");
                        }
                        Err(e) => {
                            tracing::debug!(package = %pkg, error = %e, "Background adapter update skipped");
                        }
                    }
                });
            }
        }
    }
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
) -> Result<()> {
    let registry = get_profile_registry()?;
    let registration = AgentRegistration::with_avatar_url(
        name,
        command,
        agent_type,
        package_name,
        avatar_url,
    );
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

/// 删除指定 ID 的 agent profile。
///
/// 返回 true 表示删除成功，false 表示 profile 不存在。
pub async fn delete_profile(id: &str) -> Result<bool> {
    let registry = get_profile_registry()?;
    registry
        .delete(id)
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
