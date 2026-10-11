//! Workspace Service — 封装 Workspace 业务逻辑
//!
//! 职责：
//! - Workspace CRUD
//! - Config 管理
//! - 级联删除（删除 Workspace 时级联删除 Chat）

use crate::user_data_db::{chats, workspaces, Workspace};
use ergatai_core::id::{format as format_id, generate, IdType};

pub struct WorkspaceService;

impl WorkspaceService {
    /// 创建 Workspace
    pub async fn create_workspace(
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
            workspace_id: format_id(generate(), IdType::Workspace),
            name,
            work_dir,
            env: env.unwrap_or_else(|| "{}".to_string()),
            resources: resources.unwrap_or_else(|| "{}".to_string()),
            config: config.unwrap_or_else(|| "{}".to_string()),
            collaboration_mode,
            status: "active".to_string(),
            created_at: now,
            updated_at: now,
        };

        let workspace = workspaces::create(workspace)?;
        Ok(workspace)
    }

    /// 获取 Workspace
    pub async fn get_workspace(workspace_id: &str) -> anyhow::Result<Option<Workspace>> {
        let workspace = workspaces::get(workspace_id)?;
        Ok(workspace)
    }

    /// 列出 Workspace
    pub async fn list_workspaces(
        collaboration_mode: Option<&str>,
    ) -> anyhow::Result<Vec<Workspace>> {
        let workspaces = workspaces::list(collaboration_mode)?;
        Ok(workspaces)
    }

    /// 更新 Workspace
    pub async fn update_workspace(workspace: Workspace) -> anyhow::Result<()> {
        workspaces::update(workspace)?;
        Ok(())
    }

    /// 更新 Workspace Config
    pub async fn update_config(workspace_id: &str, config: &str) -> anyhow::Result<bool> {
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

    /// 删除 Workspace（级联删除 Chat）
    pub async fn delete_workspace(workspace_id: &str) -> anyhow::Result<bool> {
        // 1. 获取该 workspace 下的所有 chat
        let chats_list = chats::list(Some(workspace_id))?;

        // 2. 级联删除所有 chat
        for chat in chats_list {
            chats::delete(&chat.chat_id)?;
        }

        // 3. 删除 workspace
        let deleted = workspaces::delete(workspace_id)?;
        Ok(deleted)
    }

    /// 设置 Workspace 状态
    pub async fn set_status(workspace_id: &str, status: &str) -> anyhow::Result<bool> {
        let updated = workspaces::set_status(workspace_id, status)?;
        Ok(updated)
    }
}
