//! Workspace Service — 封装 Workspace 业务逻辑
//!
//! 职责：
//! - Workspace CRUD
//! - Config 管理
//! - 级联删除（删除 Workspace 时级联删除 Chat）

use crate::user_data_db::{workspaces, Workspace};
use ergatai_core::id::generate;

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
            workspace_id: generate(),
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
    pub fn get_workspace(workspace_id: i64) -> anyhow::Result<Option<Workspace>> {
        let workspace = workspaces::get(workspace_id)?;
        Ok(workspace)
    }

    /// 列出 Workspace
    pub fn list_workspaces(collaboration_mode: Option<&str>) -> anyhow::Result<Vec<Workspace>> {
        let workspaces = workspaces::list(collaboration_mode)?;
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
    pub fn update_config(workspace_id: i64, config: &str) -> anyhow::Result<bool> {
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

    /// 删除 Workspace（事务性级联删除 Chat、Conversation、Message 等）
    pub fn delete_workspace(workspace_id: i64) -> anyhow::Result<bool> {
        let deleted = workspaces::delete(workspace_id)?;
        Ok(deleted)
    }

    /// 设置 Workspace 状态
    pub fn set_status(workspace_id: i64, status: &str) -> anyhow::Result<bool> {
        let updated = workspaces::set_status(workspace_id, status)?;
        Ok(updated)
    }
}
