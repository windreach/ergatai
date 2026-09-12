//! AgentRegistry — 封装所有 agent 索引的一致性管理。
//!
//! 将 5 个独立的 HashMap 索引封装在单一 RwLock 下，确保 insert/remove
//! 操作原子性地更新所有反向索引（uuid, mcp, stable_id, unhealthy_streaks）。
//!
//! 这消除了"忘记清理某个索引"的 bug 类别——之前 `stop_agent()` 和
//! `prune_unhealthy_agents()` 曾只清理主 registry 而泄漏其他索引。

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use tokio::sync::{RwLock, RwLockReadGuard, RwLockWriteGuard};

use crate::types::AgentInfo;

// ── Internal data ──

/// 所有索引的内部存储。受单一 RwLock 保护。
struct RegistryInner {
    /// agent_id → AgentInfo
    primary: HashMap<String, AgentInfo>,
    /// agent_uuid → agent_id
    uuid_index: HashMap<String, String>,
    /// mcp_agent_id → agent_id
    mcp_index: HashMap<String, String>,
    /// stable_id → agent_id
    stable_id_index: HashMap<String, String>,
    /// agent_id → consecutive unhealthy count
    unhealthy_streaks: HashMap<String, u32>,
}

impl RegistryInner {
    fn new() -> Self {
        Self {
            primary: HashMap::new(),
            uuid_index: HashMap::new(),
            mcp_index: HashMap::new(),
            stable_id_index: HashMap::new(),
            unhealthy_streaks: HashMap::new(),
        }
    }

    /// 从所有反向索引中移除给定 agent 的条目（不触碰 primary）。
    fn clean_reverse_indices(&mut self, info: &AgentInfo) {
        self.uuid_index.remove(&info.agent_uuid);
        if let Some(ref mcp_id) = info.mcp_agent_id {
            self.mcp_index.remove(mcp_id);
        }
        if let Some(ref stable_id) = info.stable_id {
            self.stable_id_index.remove(stable_id);
        }
        self.unhealthy_streaks.remove(&info.agent_id);
    }

    /// 为给定 agent 添加反向索引条目。
    fn add_reverse_indices(&mut self, info: &AgentInfo) {
        self.uuid_index
            .insert(info.agent_uuid.clone(), info.agent_id.clone());
        if let Some(ref mcp_id) = info.mcp_agent_id {
            self.mcp_index.insert(mcp_id.clone(), info.agent_id.clone());
        }
        if let Some(ref stable_id) = info.stable_id {
            self.stable_id_index
                .insert(stable_id.clone(), info.agent_id.clone());
        }
    }

    fn reconcile_indices(&mut self) {
        self.uuid_index = self
            .primary
            .iter()
            .map(|(agent_id, info)| (info.agent_uuid.clone(), agent_id.clone()))
            .collect();
        self.mcp_index = self
            .primary
            .iter()
            .filter_map(|(agent_id, info)| {
                info.mcp_agent_id
                    .as_ref()
                    .map(|mcp_id| (mcp_id.clone(), agent_id.clone()))
            })
            .collect();
        self.stable_id_index = self
            .primary
            .iter()
            .filter_map(|(agent_id, info)| {
                info.stable_id
                    .as_ref()
                    .map(|stable_id| (stable_id.clone(), agent_id.clone()))
            })
            .collect();

        let active_agent_ids: HashSet<String> = self.primary.keys().cloned().collect();
        self.unhealthy_streaks
            .retain(|agent_id, _| active_agent_ids.contains(agent_id));
    }
}

// ── AgentRegistry ──

/// 封装所有 agent 索引的一致性管理。
///
/// 所有 insert/remove 操作原子性地更新所有反向索引。
/// Clone 只是 Arc clone，开销极低。
pub struct AgentRegistry {
    inner: Arc<RwLock<RegistryInner>>,
}

impl Clone for AgentRegistry {
    fn clone(&self) -> Self {
        Self {
            inner: self.inner.clone(),
        }
    }
}

impl AgentRegistry {
    /// 创建空的注册表。
    pub fn new() -> Self {
        Self {
            inner: Arc::new(RwLock::new(RegistryInner::new())),
        }
    }

    // ── 原子操作 ──

    /// 插入 agent，自动更新所有反向索引。
    ///
    /// 若 agent_id 已存在，先清理旧条目的反向索引再插入新条目。
    pub async fn insert(&self, info: AgentInfo) {
        let mut inner = self.inner.write().await;
        // 清理旧条目（如果存在）
        if let Some(old) = inner.primary.get(&info.agent_id).cloned() {
            inner.clean_reverse_indices(&old);
        }
        // 插入新条目 + 反向索引
        inner.add_reverse_indices(&info);
        inner.primary.insert(info.agent_id.clone(), info);
    }

    /// 移除 agent，自动清理所有反向索引。
    pub async fn remove(&self, agent_id: &str) -> Option<AgentInfo> {
        let mut inner = self.inner.write().await;
        let info = inner.primary.remove(agent_id)?;
        inner.clean_reverse_indices(&info);
        Some(info)
    }

    // ── 只读操作 ──

    /// 获取 agent 信息的克隆。
    pub async fn get(&self, agent_id: &str) -> Option<AgentInfo> {
        let inner = self.inner.read().await;
        inner.primary.get(agent_id).cloned()
    }

    /// 检查 agent 是否存在。
    pub async fn contains(&self, agent_id: &str) -> bool {
        let inner = self.inner.read().await;
        inner.primary.contains_key(agent_id)
    }

    /// 列出所有 agent。
    pub async fn list(&self) -> Vec<AgentInfo> {
        let inner = self.inner.read().await;
        inner.primary.values().cloned().collect()
    }

    /// agent 数量。
    pub async fn len(&self) -> usize {
        let inner = self.inner.read().await;
        inner.primary.len()
    }

    /// 是否为空。
    pub async fn is_empty(&self) -> bool {
        let inner = self.inner.read().await;
        inner.primary.is_empty()
    }

    /// UUID → agent_id 解析。
    pub async fn resolve_uuid(&self, uuid: &str) -> Option<String> {
        let inner = self.inner.read().await;
        inner.uuid_index.get(uuid).cloned()
    }

    /// MCP ID → agent_id 解析。
    pub async fn resolve_mcp_id(&self, mcp_id: &str) -> Option<String> {
        let inner = self.inner.read().await;
        inner.mcp_index.get(mcp_id).cloned()
    }

    /// stable_id → agent_id 解析。
    pub async fn resolve_stable_id(&self, stable_id: &str) -> Option<String> {
        let inner = self.inner.read().await;
        inner.stable_id_index.get(stable_id).cloned()
    }

    /// 获取 agent 关联的 MCP ID。
    pub async fn get_mcp_agent_id(&self, runtime_id: &str) -> Option<String> {
        let inner = self.inner.read().await;
        inner
            .primary
            .get(runtime_id)
            .and_then(|info| info.mcp_agent_id.clone())
    }

    // ── Streak 操作 ──

    /// 增加不健康计数，返回新值。
    pub async fn increment_streak(&self, agent_id: &str) -> u32 {
        let mut inner = self.inner.write().await;
        let count = inner
            .unhealthy_streaks
            .entry(agent_id.to_string())
            .or_insert(0);
        *count += 1;
        *count
    }

    /// 重置不健康计数。
    pub async fn reset_streak(&self, agent_id: &str) {
        let mut inner = self.inner.write().await;
        inner.unhealthy_streaks.remove(agent_id);
    }

    /// 获取当前不健康计数。
    pub async fn get_streak(&self, agent_id: &str) -> u32 {
        let inner = self.inner.read().await;
        inner.unhealthy_streaks.get(agent_id).copied().unwrap_or(0)
    }

    /// 移除不健康计数条目。
    pub async fn remove_streak(&self, agent_id: &str) {
        let mut inner = self.inner.write().await;
        inner.unhealthy_streaks.remove(agent_id);
    }

    /// 批量操作 streaks（用于 prune_unhealthy_agents 的读-改-写模式）。
    ///
    /// 在一次锁获取中执行闭包内的所有操作。
    pub async fn with_streaks<F, R>(&self, f: F) -> R
    where
        F: FnOnce(&mut HashMap<String, u32>) -> R,
    {
        let mut inner = self.inner.write().await;
        f(&mut inner.unhealthy_streaks)
    }

    // ── Guards ──

    /// 获取写守卫，用于复杂操作。
    pub async fn write(&self) -> AgentRegistryWriteGuard<'_> {
        AgentRegistryWriteGuard {
            inner: self.inner.write().await,
        }
    }

    /// 获取读守卫，用于复杂查询。
    pub async fn read(&self) -> AgentRegistryReadGuard<'_> {
        AgentRegistryReadGuard {
            inner: self.inner.read().await,
        }
    }
}

impl Default for AgentRegistry {
    fn default() -> Self {
        Self::new()
    }
}

// ── WriteGuard ──

/// 写守卫 — 持有所有索引的写锁。
///
/// 用于需要跨多个索引进行复杂操作的场景（如 discover_and_register_agents）。
pub struct AgentRegistryWriteGuard<'a> {
    inner: RwLockWriteGuard<'a, RegistryInner>,
}

impl<'a> AgentRegistryWriteGuard<'a> {
    /// 原子插入 — 若 agent_id 已存在，先清理旧条目。
    pub fn insert(&mut self, info: AgentInfo) {
        if let Some(old) = self.inner.primary.get(&info.agent_id).cloned() {
            self.inner.clean_reverse_indices(&old);
        }
        self.inner.add_reverse_indices(&info);
        self.inner.primary.insert(info.agent_id.clone(), info);
    }

    /// 原子移除。
    pub fn remove(&mut self, agent_id: &str) -> Option<AgentInfo> {
        let info = self.inner.primary.remove(agent_id)?;
        self.inner.clean_reverse_indices(&info);
        Some(info)
    }

    /// 获取 agent 信息（不可变引用）。
    pub fn get(&self, agent_id: &str) -> Option<&AgentInfo> {
        self.inner.primary.get(agent_id)
    }

    /// 获取 agent 信息（可变引用）。
    pub fn get_mut(&mut self, agent_id: &str) -> Option<&mut AgentInfo> {
        self.inner.primary.get_mut(agent_id)
    }

    /// 检查 agent 是否存在。
    pub fn contains_key(&self, agent_id: &str) -> bool {
        self.inner.primary.contains_key(agent_id)
    }

    /// 遍历所有 agent。
    pub fn iter(&self) -> impl Iterator<Item = (&String, &AgentInfo)> {
        self.inner.primary.iter()
    }

    /// 可变遍历所有 agent。
    pub fn iter_mut(&mut self) -> impl Iterator<Item = (&String, &mut AgentInfo)> {
        self.inner.primary.iter_mut()
    }

    /// 遍历所有 agent 值。
    pub fn values(&self) -> impl Iterator<Item = &AgentInfo> {
        self.inner.primary.values()
    }

    /// Entry API — 原子性的检查-并-插入。
    pub fn entry(
        &mut self,
        key: String,
    ) -> std::collections::hash_map::Entry<'_, String, AgentInfo> {
        self.inner.primary.entry(key)
    }

    /// agent 数量。
    pub fn len(&self) -> usize {
        self.inner.primary.len()
    }

    /// 是否为空。
    pub fn is_empty(&self) -> bool {
        self.inner.primary.is_empty()
    }

    /// 清理所有反向索引，确保只包含 primary 中存在的 agent。
    ///
    /// 用于批量操作后的一致性修复（如 discover_and_register_agents）。
    pub fn reconcile_indices(&mut self) {
        self.inner.reconcile_indices();
    }

    /// UUID → agent_id 解析（返回引用）。
    pub fn resolve_uuid(&self, uuid: &str) -> Option<&str> {
        self.inner.uuid_index.get(uuid).map(|s| s.as_str())
    }

    /// MCP ID → agent_id 解析（返回引用）。
    pub fn resolve_mcp_id(&self, mcp_id: &str) -> Option<&str> {
        self.inner.mcp_index.get(mcp_id).map(|s| s.as_str())
    }

    /// stable_id → agent_id 解析（返回引用）。
    pub fn resolve_stable_id(&self, stable_id: &str) -> Option<&str> {
        self.inner
            .stable_id_index
            .get(stable_id)
            .map(|s| s.as_str())
    }
}

// ── ReadGuard ──

/// 读守卫 — 持有所有索引的读锁。
///
/// 用于需要跨多个索引进行一致查询的场景。
pub struct AgentRegistryReadGuard<'a> {
    inner: RwLockReadGuard<'a, RegistryInner>,
}

impl<'a> AgentRegistryReadGuard<'a> {
    /// 获取 agent 信息。
    pub fn get(&self, agent_id: &str) -> Option<&AgentInfo> {
        self.inner.primary.get(agent_id)
    }

    /// 检查 agent 是否存在。
    pub fn contains_key(&self, agent_id: &str) -> bool {
        self.inner.primary.contains_key(agent_id)
    }

    /// 遍历所有 agent。
    pub fn iter(&self) -> impl Iterator<Item = (&String, &AgentInfo)> {
        self.inner.primary.iter()
    }

    /// 遍历所有 agent 值。
    pub fn values(&self) -> impl Iterator<Item = &AgentInfo> {
        self.inner.primary.values()
    }

    /// UUID → agent_id 解析（返回引用）。
    pub fn resolve_uuid(&self, uuid: &str) -> Option<&str> {
        self.inner.uuid_index.get(uuid).map(|s| s.as_str())
    }

    /// MCP ID → agent_id 解析（返回引用）。
    pub fn resolve_mcp_id(&self, mcp_id: &str) -> Option<&str> {
        self.inner.mcp_index.get(mcp_id).map(|s| s.as_str())
    }

    /// stable_id → agent_id 解析（返回引用）。
    pub fn resolve_stable_id(&self, stable_id: &str) -> Option<&str> {
        self.inner
            .stable_id_index
            .get(stable_id)
            .map(|s| s.as_str())
    }

    /// agent 数量。
    pub fn len(&self) -> usize {
        self.inner.primary.len()
    }

    /// 是否为空。
    pub fn is_empty(&self) -> bool {
        self.inner.primary.is_empty()
    }
}

// ── Tests ──

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent_lifecycle::AgentLifecycleState;
    use crate::types::{AgentHandle, WorkspaceHandle};
    use std::collections::HashMap as StdHashMap;

    fn make_agent_info(id: &str, uuid: &str) -> AgentInfo {
        let now = chrono::Utc::now();
        AgentInfo {
            agent_uuid: uuid.to_string(),
            agent_id: id.to_string(),
            stable_id: Some(format!("stable-{id}")),
            workspace_id: "ws-test".to_string(),
            handle: AgentHandle {
                workspace: WorkspaceHandle {
                    id: "ws-test".to_string(),
                    backend: "mock".to_string(),
                    metadata: StdHashMap::new(),
                },
                agent_id: id.to_string(),
                process_id: None,
                metadata: StdHashMap::new(),
            },
            lifecycle: AgentLifecycleState::Running {
                task_id: None,
                started_at: now,
                last_heartbeat: now,
            },
            task_id: None,
            created_at: now,
            mcp_agent_id: Some(format!("mcp-{id}")),
            last_heartbeat: now,
            profile: None,
            capabilities: Vec::new(),
            state_changed_at: now,
            state_history: Vec::new(),
        }
    }

    #[tokio::test]
    async fn test_insert_and_get() {
        let registry = AgentRegistry::new();
        let info = make_agent_info("agent-1", "uuid-1");
        registry.insert(info.clone()).await;

        let got = registry.get("agent-1").await.unwrap();
        assert_eq!(got.agent_id, "agent-1");
        assert_eq!(got.agent_uuid, "uuid-1");
    }

    #[tokio::test]
    async fn test_remove_cleans_all_indices() {
        let registry = AgentRegistry::new();
        let info = make_agent_info("agent-1", "uuid-1");
        registry.insert(info).await;

        // 验证所有索引存在
        assert!(registry.contains("agent-1").await);
        assert_eq!(
            registry.resolve_uuid("uuid-1").await.as_deref(),
            Some("agent-1")
        );
        assert_eq!(
            registry.resolve_mcp_id("mcp-agent-1").await.as_deref(),
            Some("agent-1")
        );
        assert_eq!(
            registry
                .resolve_stable_id("stable-agent-1")
                .await
                .as_deref(),
            Some("agent-1")
        );

        // 移除
        let removed = registry.remove("agent-1").await;
        assert!(removed.is_some());

        // 验证所有索引已清理
        assert!(!registry.contains("agent-1").await);
        assert!(registry.resolve_uuid("uuid-1").await.is_none());
        assert!(registry.resolve_mcp_id("mcp-agent-1").await.is_none());
        assert!(registry.resolve_stable_id("stable-agent-1").await.is_none());
    }

    #[tokio::test]
    async fn test_re_insert_cleans_old_indices() {
        let registry = AgentRegistry::new();

        // 插入第一个版本
        let info1 = make_agent_info("agent-1", "uuid-old");
        registry.insert(info1).await;
        assert_eq!(
            registry.resolve_uuid("uuid-old").await.as_deref(),
            Some("agent-1")
        );

        // 用新 UUID 重新插入同一 agent_id
        let info2 = make_agent_info("agent-1", "uuid-new");
        registry.insert(info2).await;

        // 旧 UUID 应该被清理
        assert!(registry.resolve_uuid("uuid-old").await.is_none());
        // 新 UUID 应该存在
        assert_eq!(
            registry.resolve_uuid("uuid-new").await.as_deref(),
            Some("agent-1")
        );
    }

    #[tokio::test]
    async fn test_streak_operations() {
        let registry = AgentRegistry::new();

        assert_eq!(registry.get_streak("agent-1").await, 0);

        let count = registry.increment_streak("agent-1").await;
        assert_eq!(count, 1);

        let count = registry.increment_streak("agent-1").await;
        assert_eq!(count, 2);

        assert_eq!(registry.get_streak("agent-1").await, 2);

        registry.reset_streak("agent-1").await;
        assert_eq!(registry.get_streak("agent-1").await, 0);
    }

    #[tokio::test]
    async fn test_write_guard_insert_remove() {
        let registry = AgentRegistry::new();

        {
            let mut guard = registry.write().await;
            let info = make_agent_info("agent-1", "uuid-1");
            guard.insert(info);
            assert!(guard.contains_key("agent-1"));
        }

        assert!(registry.contains("agent-1").await);

        {
            let mut guard = registry.write().await;
            let removed = guard.remove("agent-1");
            assert!(removed.is_some());
        }

        assert!(!registry.contains("agent-1").await);
    }

    #[tokio::test]
    async fn test_write_guard_entry_api() {
        let registry = AgentRegistry::new();

        {
            let mut guard = registry.write().await;
            guard
                .entry("agent-1".to_string())
                .or_insert_with(|| make_agent_info("agent-1", "uuid-1"));
        }

        assert!(registry.contains("agent-1").await);
    }

    #[tokio::test]
    async fn test_write_guard_reconcile_indices() {
        let registry = AgentRegistry::new();

        // 插入两个 agent
        registry.insert(make_agent_info("agent-1", "uuid-1")).await;
        registry.insert(make_agent_info("agent-2", "uuid-2")).await;

        // 直接从 primary 中移除一个（模拟手动操作）
        {
            let mut guard = registry.write().await;
            guard.inner.primary.remove("agent-1");
            // 此时反向索引还残留 agent-1 的条目
            assert!(guard.inner.uuid_index.contains_key("uuid-1"));
        }

        // reconcile 应该清理残留
        {
            let mut guard = registry.write().await;
            guard.reconcile_indices();
        }

        // 验证残留已清理
        assert!(registry.resolve_uuid("uuid-1").await.is_none());
        assert!(registry.resolve_uuid("uuid-2").await.is_some());
    }

    #[tokio::test]
    async fn test_read_guard_consistent_snapshot() {
        let registry = AgentRegistry::new();
        registry.insert(make_agent_info("agent-1", "uuid-1")).await;

        let guard = registry.read().await;
        assert!(guard.contains_key("agent-1"));
        assert_eq!(guard.resolve_uuid("uuid-1"), Some("agent-1"));
        assert_eq!(guard.resolve_mcp_id("mcp-agent-1"), Some("agent-1"));
        assert_eq!(guard.resolve_stable_id("stable-agent-1"), Some("agent-1"));
    }

    #[tokio::test]
    async fn test_with_streaks_batch_operation() {
        let registry = AgentRegistry::new();
        registry.insert(make_agent_info("agent-1", "uuid-1")).await;
        registry.insert(make_agent_info("agent-2", "uuid-2")).await;

        // 批量操作
        let dead_now = vec!["agent-1".to_string(), "agent-2".to_string()];
        let healthy: Vec<String> = vec![];

        registry
            .with_streaks(|streaks| {
                for id in &healthy {
                    streaks.remove(id);
                }
                for id in &dead_now {
                    *streaks.entry(id.clone()).or_insert(0) += 1;
                }
            })
            .await;

        assert_eq!(registry.get_streak("agent-1").await, 1);
        assert_eq!(registry.get_streak("agent-2").await, 1);
    }

    #[tokio::test]
    async fn test_clone_shares_state() {
        let registry1 = AgentRegistry::new();
        let registry2 = registry1.clone();

        registry1.insert(make_agent_info("agent-1", "uuid-1")).await;

        // clone 应该看到相同的底层数据
        assert!(registry2.contains("agent-1").await);
    }

    #[tokio::test]
    async fn test_list_and_len() {
        let registry = AgentRegistry::new();
        assert!(registry.is_empty().await);
        assert_eq!(registry.len().await, 0);

        registry.insert(make_agent_info("agent-1", "uuid-1")).await;
        registry.insert(make_agent_info("agent-2", "uuid-2")).await;

        assert_eq!(registry.len().await, 2);
        assert!(!registry.is_empty().await);

        let list = registry.list().await;
        assert_eq!(list.len(), 2);
    }
}
