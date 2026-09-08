//! 文件锁服务 — 封装 LockManager 的访问逻辑。
//!
//! 职责：
//! - 统一 `get_lock_manager("default")` 调用，避免 handler 重复相同代码。
//! - 提供业务层 API（获取活跃锁、查询审计日志、获取锁竞争信息）。
//! - 返回 `anyhow::Result<T>`，不涉及 HTTP 类型（handler 负责 HTTP 格式化）。

use std::sync::Arc;

use anyhow::{Context, Result};
use ergatai_lock::{get_lock_manager, AuditEntry, FileLock, FileLockManager};

/// 获取活跃的文件锁列表。
///
/// 返回当前所有活跃的锁（包括内部系统文件的锁）。
/// 过滤内部路径的逻辑放在 handler 层。
pub async fn list_active_locks() -> Result<Vec<FileLock>> {
    let manager = get_default_manager().await?;
    manager
        .get_all_active_locks()
        .map_err(|e| anyhow::anyhow!("Failed to get active locks: {}", e))
}

/// 查询审计日志。
///
/// # Arguments
/// * `agent_id` - 按 agent 过滤（可选）
/// * `action` - 按操作类型过滤（可选）
/// * `file_path` - 按文件路径过滤（可选）
/// * `limit` - 返回的最大条目数
pub async fn query_audit(
    agent_id: Option<&str>,
    action: Option<&str>,
    file_path: Option<&str>,
    limit: usize,
) -> Result<Vec<AuditEntry>> {
    let manager = get_default_manager().await?;
    let audit = manager.audit_manager();
    audit
        .query_audit_log(agent_id, action, file_path, None, None, limit)
        .map_err(|e| anyhow::anyhow!("Failed to query audit log: {}", e))
}

/// 锁竞争信息 — 一个文件被多个 agent 争用时的状态。
pub struct LockContentionInfo {
    pub file_path: String,
    pub current_holder: Option<String>,
    pub waiting_agents: Vec<String>,
    pub wait_time_secs: u64,
    pub conflict_count: u32,
}

/// 获取锁竞争信息。
///
/// 分析当前活跃锁，找出存在多个 agent 争用的文件。
/// 返回的每个条目包含当前持有者、等待者列表、等待时间和冲突次数。
pub async fn get_lock_contention() -> Result<Vec<LockContentionInfo>> {
    let locks = list_active_locks().await?;

    // 按 file_path 分组
    let mut file_map: std::collections::HashMap<String, Vec<FileLock>> =
        std::collections::HashMap::new();
    for lock in locks {
        file_map
            .entry(lock.file_path.clone())
            .or_default()
            .push(lock);
    }

    // 构建竞争信息（只保留有冲突的文件）
    let contentions = file_map
        .into_iter()
        .filter_map(|(file_path, locks)| {
            if locks.is_empty() {
                return None;
            }

            let current_holder = locks.first().map(|l| l.agent_id.clone());
            let waiting_agents: Vec<String> =
                locks.iter().skip(1).map(|l| l.agent_id.clone()).collect();

            let wait_time_secs = locks
                .first()
                .map(|l| {
                    let now = chrono::Utc::now();
                    (now - l.created_at).num_seconds().max(0) as u64
                })
                .unwrap_or(0);

            let conflict_count = waiting_agents.len() as u32;

            if conflict_count == 0 {
                return None;
            }

            Some(LockContentionInfo {
                file_path,
                current_holder,
                waiting_agents,
                wait_time_secs,
                conflict_count,
            })
        })
        .collect();

    Ok(contentions)
}

/// 获取默认的 LockManager 实例。
///
/// 内部统一调用 `get_lock_manager("default")`，
/// 失败时返回带上下文的错误。
async fn get_default_manager() -> Result<Arc<FileLockManager>> {
    get_lock_manager("default")
        .await
        .context("File lock manager not initialized")
}
