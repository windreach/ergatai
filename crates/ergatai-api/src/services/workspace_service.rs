//! Workspace Service — 封装 Workspace 业务逻辑
//!
//! 职责：
//! - Workspace CRUD
//! - Config 管理
//! - 级联删除（删除 Workspace 时级联删除 Chat）

use crate::user_data_db::{workspaces, Workspace};
use ergatai_error::WorkspaceId;

pub struct WorkspaceService;

impl WorkspaceService {
    /// 创建 Workspace
    pub fn create_workspace(
        name: String,
        work_dir: String,
        env: Option<String>,
        resources: Option<String>,
        config: Option<String>,
        collaboration_mode: String,
    ) -> anyhow::Result<Workspace> {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs() as i64;

        let workspace = Workspace {
            workspace_id: WorkspaceId::generate(),
            name,
            work_dir,
            env: env.unwrap_or_else(|| "{}".to_string()),
            resources: resources.unwrap_or_else(|| "{}".to_string()),
            config: config.unwrap_or_else(|| "{}".to_string()),
            collaboration_mode,
            status: "active".to_string(),
            default_project_id: None,
            created_at: now,
            updated_at: now,
        };

        let workspace = workspaces::create(workspace)?;
        Ok(workspace)
    }

    /// 获取 Workspace
    pub fn get_workspace(workspace_id: WorkspaceId) -> anyhow::Result<Option<Workspace>> {
        let workspace = workspaces::get(workspace_id)?;
        Ok(workspace)
    }

    /// 列出 Workspace
    pub fn list_workspaces(collaboration_mode: Option<&str>) -> anyhow::Result<Vec<Workspace>> {
        let workspaces = workspaces::list(collaboration_mode, None)?;
        Ok(workspaces)
    }

    /// 更新 Workspace（含验证）
    pub fn update_workspace(workspace: Workspace) -> anyhow::Result<()> {
        // 验证 name 非空且长度合理
        if workspace.name.trim().is_empty() {
            anyhow::bail!("Workspace name cannot be empty");
        }
        if workspace.name.len() > 255 {
            anyhow::bail!("Workspace name cannot exceed 255 characters");
        }
        // 验证 work_dir 非空
        if workspace.work_dir.trim().is_empty() {
            anyhow::bail!("Workspace work_dir cannot be empty");
        }
        workspaces::update(workspace)?;
        Ok(())
    }

    /// 更新 Workspace Config
    pub fn update_config(workspace_id: WorkspaceId, config: &str) -> anyhow::Result<bool> {
        // Get the workspace, update config, and save
        let workspace = workspaces::get(workspace_id)?;
        if let Some(mut workspace) = workspace {
            workspace.config = config.to_string();
            workspaces::update(workspace)?;
            Ok(true)
        } else {
            Ok(false)
        }
    }

    /// 删除 Workspace（同步删除行，异步清理消息表等重资源）
    pub fn delete_workspace(workspace_id: WorkspaceId) -> anyhow::Result<bool> {
        // Collect conversation ids before cascade delete so their message tables
        // can be dropped asynchronously by the queue worker.
        let conversation_ids =
            match crate::user_data_db::conversations::list_conversation_ids_by_workspace(
                workspace_id,
            ) {
                Ok(ids) => ids,
                Err(e) => {
                    tracing::warn!(error = %e, "Failed to list conversation IDs for cleanup; proceeding with workspace deletion but message tables may not be cleaned up");
                    Vec::new()
                }
            };

        let deleted = workspaces::delete(workspace_id)?;

        if deleted {
            // Enqueue heavy cleanup (drop message tables, runtime cleanup)
            let entity_id = workspace_id.encode();
            crate::services::deletion_helpers::enqueue_conversation_cleanup(
                "workspace",
                &entity_id,
                "cleanup_workspace",
                conversation_ids,
            );
        }

        Ok(deleted)
    }

    /// 设置 Workspace 状态
    pub fn set_status(workspace_id: WorkspaceId, status: &str) -> anyhow::Result<bool> {
        let updated = workspaces::set_status(workspace_id, status)?;
        Ok(updated)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    static TEST_DB_MUTEX: Mutex<()> = Mutex::new(());
    static TEST_DB_DATA_DIR: std::sync::OnceLock<std::path::PathBuf> = std::sync::OnceLock::new();

    fn lock_db() -> std::sync::MutexGuard<'static, ()> {
        let guard = TEST_DB_MUTEX.lock().unwrap_or_else(|e| e.into_inner());
        TEST_DB_DATA_DIR.get_or_init(|| {
            let data_dir = std::env::temp_dir()
                .join("ergatai-ws-tests")
                .join(std::process::id().to_string());
            let _ = std::fs::remove_dir_all(&data_dir);
            std::fs::create_dir_all(&data_dir).unwrap();
            std::env::set_var("ERGATAI_DATA_DIR", &data_dir);
            data_dir
        });
        let _ = crate::user_data_db::get_user_data_db();
        guard
    }

    #[test]
    fn test_create_and_get() {
        let _g = lock_db();
        let ws = WorkspaceService::create_workspace(
            "ws1".to_string(),
            "/tmp/w".to_string(),
            None,
            None,
            None,
            "none".to_string(),
        )
        .unwrap();
        let fetched = WorkspaceService::get_workspace(ws.workspace_id)
            .unwrap()
            .unwrap();
        assert_eq!(fetched.name, "ws1");
    }

    #[test]
    fn test_update_validation_empty_name() {
        let _g = lock_db();
        let ws = WorkspaceService::create_workspace(
            "ws2".to_string(),
            "/tmp/w2".to_string(),
            None,
            None,
            None,
            "none".to_string(),
        )
        .unwrap();
        let mut bad = ws.clone();
        bad.name = "   ".to_string();
        assert!(WorkspaceService::update_workspace(bad).is_err());
    }

    #[test]
    fn test_update_validation_long_name() {
        let _g = lock_db();
        let ws = WorkspaceService::create_workspace(
            "ws3".to_string(),
            "/tmp/w3".to_string(),
            None,
            None,
            None,
            "none".to_string(),
        )
        .unwrap();
        let mut bad = ws.clone();
        bad.name = "a".repeat(256);
        assert!(WorkspaceService::update_workspace(bad).is_err());
    }

    #[test]
    fn test_update_validation_empty_work_dir() {
        let _g = lock_db();
        let ws = WorkspaceService::create_workspace(
            "ws4".to_string(),
            "/tmp/w4".to_string(),
            None,
            None,
            None,
            "none".to_string(),
        )
        .unwrap();
        let mut bad = ws.clone();
        bad.work_dir = "".to_string();
        assert!(WorkspaceService::update_workspace(bad).is_err());
    }

    #[test]
    fn test_delete_workspace() {
        let _g = lock_db();
        let ws = WorkspaceService::create_workspace(
            "ws5".to_string(),
            "/tmp/w5".to_string(),
            None,
            None,
            None,
            "none".to_string(),
        )
        .unwrap();
        assert!(WorkspaceService::delete_workspace(ws.workspace_id).unwrap());
        assert!(WorkspaceService::get_workspace(ws.workspace_id)
            .unwrap()
            .is_none());
    }

    #[test]
    fn test_set_status() {
        let _g = lock_db();
        let ws = WorkspaceService::create_workspace(
            "ws6".to_string(),
            "/tmp/w6".to_string(),
            None,
            None,
            None,
            "none".to_string(),
        )
        .unwrap();
        assert!(WorkspaceService::set_status(ws.workspace_id, "inactive").unwrap());
    }
}
