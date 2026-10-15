//! Workspace-first management service.

use ergatai_core::id::{format as format_id, generate, parse_to_i64, IdType};
use ergatai_runtime::ResourceLimits;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use utoipa::ToSchema;

use crate::user_data_db::{workspaces, Workspace};

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct ManagedWorkspace {
    pub workspace_id: String,
    pub name: String,
    pub work_dir: String,
    pub env: String,
    pub resources: String,
    pub config: String,
    pub collaboration_mode: String,
    pub status: String,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Deserialize, ToSchema)]
pub struct CreateManagedWorkspaceRequest {
    pub id: Option<String>,
    pub name: Option<String>,
    pub work_dir: String,
    #[serde(default)]
    pub env: Option<HashMap<String, String>>,
    #[serde(default)]
    pub resources: Option<serde_json::Value>,
    #[serde(default)]
    pub config: Option<String>,
    #[serde(default)]
    pub collaboration_mode: Option<String>,
}

#[derive(Debug, Clone, Deserialize, ToSchema)]
pub struct UpdateManagedWorkspaceRequest {
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub work_dir: Option<String>,
    #[serde(default)]
    pub env: Option<HashMap<String, String>>,
    #[serde(default)]
    pub resources: Option<serde_json::Value>,
    #[serde(default)]
    pub config: Option<String>,
    #[serde(default)]
    pub status: Option<String>,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct WorkspaceStatus {
    pub workspace_id: String,
    pub status: String,
    pub work_dir: String,
    pub work_dir_exists: bool,
    pub active_agent_count: usize,
    pub chat_count: usize,
    pub active_chat_count: usize,
    pub healthy: bool,
}

#[derive(Debug)]
pub enum WorkspaceManagerError {
    Validation(String),
    NotFound(String),
    Conflict(String),
    Internal(anyhow::Error),
}

impl From<rusqlite::Error> for WorkspaceManagerError {
    fn from(error: rusqlite::Error) -> Self {
        Self::Internal(error.into())
    }
}

fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}

fn canonical_path(path: &str) -> Result<String, WorkspaceManagerError> {
    crate::validate_cwd(path)
        .map(|path| path.to_string_lossy().into_owned())
        .map_err(WorkspaceManagerError::Validation)
}

fn validate_json_settings(
    env: Option<HashMap<String, String>>,
    resources: Option<serde_json::Value>,
) -> Result<(String, String), WorkspaceManagerError> {
    let env_json = serde_json::to_string(&env.unwrap_or_default())
        .map_err(|e| WorkspaceManagerError::Internal(e.into()))?;
    let resources_json = serde_json::to_string(&resources.unwrap_or_else(|| serde_json::json!({})))
        .map_err(|e| WorkspaceManagerError::Internal(e.into()))?;
    serde_json::from_str::<ResourceLimits>(&resources_json)
        .map_err(|e| WorkspaceManagerError::Validation(format!("Invalid resources: {}", e)))?;
    Ok((env_json, resources_json))
}

fn validate_resource_json(resources: &str) -> Result<ResourceLimits, WorkspaceManagerError> {
    serde_json::from_str(resources).map_err(|e| {
        WorkspaceManagerError::Validation(format!("Invalid workspace resources: {}", e))
    })
}

#[allow(dead_code)] // Reserved for future dirty worktree detection
async fn is_dirty_worktree(path: &str) -> bool {
    let worktree = std::path::Path::new(path);
    if !worktree.is_dir() {
        return false;
    }

    let path_owned = worktree.to_path_buf();
    tokio::task::spawn_blocking(move || {
        std::process::Command::new("git")
            .current_dir(&path_owned)
            .args(["status", "--porcelain"])
            .output()
            .map(|output| output.status.success() && !output.stdout.is_empty())
            .unwrap_or(false)
    })
    .await
    .unwrap_or(false)
}

/// Count how many of the given worktree paths have uncommitted changes.
/// Checks are performed in parallel via `futures::future::join_all`.
#[allow(dead_code)] // Reserved for future dirty worktree counting
async fn count_dirty_worktrees(paths: &[&str]) -> usize {
    let checks: Vec<_> = paths.iter().map(|path| is_dirty_worktree(path)).collect();
    futures::future::join_all(checks)
        .await
        .into_iter()
        .filter(|&dirty| dirty)
        .count()
}

pub async fn to_managed(workspace: Workspace) -> Result<ManagedWorkspace, WorkspaceManagerError> {
    validate_resource_json(&workspace.resources)?;

    Ok(ManagedWorkspace {
        workspace_id: format_id(workspace.workspace_id, IdType::Workspace),
        name: workspace.name,
        work_dir: workspace.work_dir,
        env: workspace.env,
        resources: workspace.resources,
        config: workspace.config,
        collaboration_mode: workspace.collaboration_mode,
        status: workspace.status,
        created_at: workspace.created_at,
        updated_at: workspace.updated_at,
    })
}

pub async fn list(
    collaboration_mode: Option<&str>,
) -> Result<Vec<ManagedWorkspace>, WorkspaceManagerError> {
    let collaboration_mode = collaboration_mode.filter(|mode| !mode.is_empty());
    if let Some(mode) = collaboration_mode {
        if !matches!(mode, "supervisor" | "group") {
            return Err(WorkspaceManagerError::Validation(format!(
                "Invalid collaboration_mode: {mode}"
            )));
        }
    }

    let collaboration_mode_owned = collaboration_mode.map(|s| s.to_string());
    let workspaces =
        tokio::task::spawn_blocking(move || workspaces::list(collaboration_mode_owned.as_deref()))
            .await
            .map_err(|e| WorkspaceManagerError::Internal(e.into()))?
            .map_err(WorkspaceManagerError::from)?;

    let mut result = Vec::new();
    for workspace in workspaces {
        result.push(to_managed(workspace).await?);
    }
    Ok(result)
}

pub async fn get(workspace_id: &str) -> Result<ManagedWorkspace, WorkspaceManagerError> {
    let id_i64 = parse_to_i64(workspace_id).ok_or_else(|| {
        WorkspaceManagerError::NotFound(format!("Invalid workspace ID format: {}", workspace_id))
    })?;
    let workspace = tokio::task::spawn_blocking(move || workspaces::get(id_i64))
        .await
        .map_err(|e| WorkspaceManagerError::Internal(e.into()))?
        .map_err(WorkspaceManagerError::from)?
        .ok_or_else(|| WorkspaceManagerError::NotFound(workspace_id.to_string()))?;
    to_managed(workspace).await
}

pub async fn create(
    request: CreateManagedWorkspaceRequest,
) -> Result<ManagedWorkspace, WorkspaceManagerError> {
    let workspace_id = request
        .id
        .filter(|id| !id.is_empty())
        .map(|id| {
            parse_to_i64(&id).ok_or_else(|| {
                WorkspaceManagerError::Validation("Invalid workspace ID format".to_string())
            })
        })
        .transpose()?
        .unwrap_or_else(generate);
    let id_check = workspace_id;
    let exists = tokio::task::spawn_blocking(move || workspaces::get(id_check))
        .await
        .map_err(|e| WorkspaceManagerError::Internal(e.into()))?
        .map_err(WorkspaceManagerError::from)?
        .is_some();
    if exists {
        return Err(WorkspaceManagerError::Conflict(format!(
            "Workspace {} already exists",
            workspace_id
        )));
    }

    let work_dir = canonical_path(&request.work_dir)?;
    let (env, resources) = validate_json_settings(request.env, request.resources)?;
    let config = request.config.unwrap_or_else(|| "{}".to_string());
    let collaboration_mode = request
        .collaboration_mode
        .as_deref()
        .unwrap_or("supervisor");
    if !matches!(collaboration_mode, "supervisor" | "group") {
        return Err(WorkspaceManagerError::Validation(format!(
            "Invalid collaboration_mode: {collaboration_mode}"
        )));
    }
    let timestamp = now();
    let workspace = Workspace {
        workspace_id,
        name: request.name.unwrap_or_default(),
        work_dir,
        env,
        resources,
        config,
        collaboration_mode: collaboration_mode.to_string(),
        status: "active".to_string(),
        created_at: timestamp,
        updated_at: timestamp,
    };
    let workspace_clone = workspace.clone();
    tokio::task::spawn_blocking(move || workspaces::create(workspace_clone))
        .await
        .map_err(|e| WorkspaceManagerError::Internal(e.into()))?
        .map_err(WorkspaceManagerError::from)?;
    get(&format_id(workspace.workspace_id, IdType::Workspace)).await
}

pub async fn update(
    workspace_id: &str,
    request: UpdateManagedWorkspaceRequest,
) -> Result<ManagedWorkspace, WorkspaceManagerError> {
    let id_i64 = parse_to_i64(workspace_id).ok_or_else(|| {
        WorkspaceManagerError::NotFound(format!("Invalid workspace ID format: {}", workspace_id))
    })?;
    let existing = tokio::task::spawn_blocking(move || workspaces::get(id_i64))
        .await
        .map_err(|e| WorkspaceManagerError::Internal(e.into()))?
        .map_err(WorkspaceManagerError::from)?
        .ok_or_else(|| WorkspaceManagerError::NotFound(workspace_id.to_string()))?;
    let work_dir = match request.work_dir.as_deref() {
        Some(path) => canonical_path(path)?,
        None => existing.work_dir.clone(),
    };
    let resources_input = request.resources.clone();
    let (env, resources) = validate_json_settings(request.env.clone(), resources_input)?;
    let env = if request.env.is_some() {
        env
    } else {
        existing.env.clone()
    };
    let resources = if request.resources.is_some() {
        resources
    } else {
        existing.resources.clone()
    };
    let config = if let Some(config) = request.config {
        config
    } else {
        existing.config.clone()
    };
    let status = request.status.clone().unwrap_or(existing.status.clone());
    if !matches!(status.as_str(), "active" | "archived" | "error") {
        return Err(WorkspaceManagerError::Validation(format!(
            "Unsupported workspace status: {}",
            status
        )));
    }
    let updated = Workspace {
        workspace_id: existing.workspace_id,
        name: request.name.clone().unwrap_or(existing.name.clone()),
        work_dir,
        env,
        resources,
        config,
        collaboration_mode: existing.collaboration_mode,
        status,
        created_at: existing.created_at,
        updated_at: now(),
    };
    let updated_clone = updated.clone();
    tokio::task::spawn_blocking(move || workspaces::update(updated_clone))
        .await
        .map_err(|e| WorkspaceManagerError::Internal(e.into()))?
        .map_err(WorkspaceManagerError::from)?;
    get(workspace_id).await
}

pub async fn set_status(
    workspace_id: &str,
    status: &str,
) -> Result<ManagedWorkspace, WorkspaceManagerError> {
    if !matches!(status, "active" | "archived" | "error") {
        return Err(WorkspaceManagerError::Validation(format!(
            "Unsupported workspace status: {}",
            status
        )));
    }
    let id_i64 = parse_to_i64(workspace_id).ok_or_else(|| {
        WorkspaceManagerError::NotFound(format!("Invalid workspace ID format: {}", workspace_id))
    })?;
    let status_owned = status.to_string();
    let success =
        tokio::task::spawn_blocking(move || workspaces::set_status(id_i64, &status_owned))
            .await
            .map_err(|e| WorkspaceManagerError::Internal(e.into()))?
            .map_err(WorkspaceManagerError::from)?;
    if !success {
        return Err(WorkspaceManagerError::NotFound(workspace_id.to_string()));
    }
    get(workspace_id).await
}

pub async fn status(workspace_id: &str) -> Result<WorkspaceStatus, WorkspaceManagerError> {
    let workspace = get(workspace_id).await?;
    let runtime = crate::context::get_app_context().agent_runtime.clone();
    let active_agent_count = runtime
        .list_agents()
        .await
        .iter()
        .filter(|agent| agent.workspace_id == workspace_id && agent.lifecycle.is_alive())
        .count();
    let workspace_id_i64 = parse_to_i64(&workspace.workspace_id).ok_or_else(|| {
        WorkspaceManagerError::Internal(anyhow::anyhow!(
            "Invalid workspace ID format: {}",
            workspace.workspace_id
        ))
    })?;
    let chats = tokio::task::spawn_blocking(move || {
        crate::user_data_db::chats::list(Some(workspace_id_i64))
    })
    .await
    .map_err(|e| WorkspaceManagerError::Internal(e.into()))?
    .map_err(WorkspaceManagerError::from)?;
    let active_chat_count = chats
        .iter()
        .filter(|chat| chat.archived_at.is_none())
        .count();
    let work_dir_exists = std::path::Path::new(&workspace.work_dir).is_dir();
    Ok(WorkspaceStatus {
        workspace_id: workspace.workspace_id,
        status: workspace.status,
        work_dir: workspace.work_dir,
        work_dir_exists,
        active_agent_count,
        chat_count: chats.len(),
        active_chat_count,
        healthy: work_dir_exists,
    })
}

pub async fn delete(workspace_id: &str, force: bool) -> Result<(), WorkspaceManagerError> {
    get(workspace_id).await?;
    let runtime = crate::context::get_app_context().agent_runtime.clone();
    let active_agents: Vec<_> = runtime
        .list_agents()
        .await
        .into_iter()
        .filter(|agent| agent.workspace_id == workspace_id && agent.lifecycle.is_alive())
        .collect();
    if !active_agents.is_empty() && !force {
        return Err(WorkspaceManagerError::Conflict(format!(
            "Workspace has {} active agent(s); stop them or use force",
            active_agents.len()
        )));
    }

    // Data safety checks: prevent deletion when active chats exist
    // (unless force=true). These guards protect in-progress user work from accidental destruction.
    if !force {
        // Check for active (non-archived) chats
        let workspace_id_i64 = parse_to_i64(workspace_id).ok_or_else(|| {
            WorkspaceManagerError::NotFound(format!(
                "Invalid workspace ID format: {}",
                workspace_id
            ))
        })?;
        let chats_result = tokio::task::spawn_blocking(move || {
            crate::user_data_db::chats::list(Some(workspace_id_i64))
        })
        .await;

        match chats_result {
            Ok(Ok(chats)) => {
                let active_chats: Vec<_> =
                    chats.iter().filter(|c| c.archived_at.is_none()).collect();
                if !active_chats.is_empty() {
                    return Err(WorkspaceManagerError::Conflict(format!(
                        "Workspace has {} active chat(s) (in-progress work); archive them or use force",
                        active_chats.len()
                    )));
                }
            }
            Ok(Err(e)) => {
                return Err(WorkspaceManagerError::from(e));
            }
            Err(e) => {
                return Err(WorkspaceManagerError::Internal(e.into()));
            }
        }
    }

    for agent in active_agents {
        let _ = runtime.stop_agent(&agent.agent_id).await;
    }

    // Unregister workspace from permission handler to prevent memory leak
    if let Some(permission_handler) = crate::get_permission_handler() {
        permission_handler.unregister_workspace(workspace_id).await;
    }

    let workspace_id_i64 = parse_to_i64(workspace_id).ok_or_else(|| {
        WorkspaceManagerError::NotFound(format!("Invalid workspace ID format: {}", workspace_id))
    })?;
    tokio::task::spawn_blocking(move || workspaces::delete(workspace_id_i64))
        .await
        .map_err(|e| WorkspaceManagerError::Internal(e.into()))?
        .map_err(WorkspaceManagerError::from)?;
    Ok(())
}

/// 停止 workspace（停止所有 agent，保留数据）
pub async fn stop_workspace(workspace_id: &str) -> Result<Workspace, WorkspaceManagerError> {
    let workspace_id_i64 = parse_to_i64(workspace_id).ok_or_else(|| {
        WorkspaceManagerError::NotFound(format!("Invalid workspace ID format: {}", workspace_id))
    })?;

    // 1. 检查 workspace 存在且状态为 active
    let workspace = tokio::task::spawn_blocking(move || workspaces::get(workspace_id_i64))
        .await
        .map_err(|e| WorkspaceManagerError::Internal(e.into()))?
        .map_err(WorkspaceManagerError::from)?
        .ok_or_else(|| WorkspaceManagerError::NotFound(workspace_id.to_string()))?;

    if workspace.status == "archived" {
        return Err(WorkspaceManagerError::Conflict(
            "Cannot stop archived workspace; restore it first".to_string(),
        ));
    }
    if workspace.status == "stopped" {
        return Err(WorkspaceManagerError::Conflict(
            "Workspace already stopped".to_string(),
        ));
    }

    // 2. 停止所有活跃 agent
    let runtime = crate::context::get_app_context().agent_runtime.clone();
    let active_agents: Vec<_> = runtime
        .list_agents()
        .await
        .into_iter()
        .filter(|agent| agent.workspace_id == workspace_id && agent.lifecycle.is_alive())
        .collect();

    for agent in active_agents {
        let _ = runtime.stop_agent(&agent.agent_id).await;
    }

    // 3. 清理运行时 workspace
    if let Ok(workspaces) = runtime.backend().list_workspaces().await {
        if let Some(ws) = workspaces.into_iter().find(|w| w.id == workspace_id) {
            if let Err(e) = runtime.backend().cleanup_workspace(&ws).await {
                tracing::warn!(error = %e, "Failed to cleanup runtime workspace");
            }
        }
    }

    // 4. 更新数据库状态为 stopped
    let mut updated_workspace = workspace.clone();
    updated_workspace.status = "stopped".to_string();
    updated_workspace.updated_at = now();

    let workspace_for_update = updated_workspace.clone();
    tokio::task::spawn_blocking(move || workspaces::update(workspace_for_update))
        .await
        .map_err(|e| WorkspaceManagerError::Internal(e.into()))?
        .map_err(WorkspaceManagerError::from)?;

    Ok(updated_workspace)
}

/// 启动 workspace（从 stopped 状态恢复）
pub async fn start_workspace(workspace_id: &str) -> Result<Workspace, WorkspaceManagerError> {
    let workspace_id_i64 = parse_to_i64(workspace_id).ok_or_else(|| {
        WorkspaceManagerError::NotFound(format!("Invalid workspace ID format: {}", workspace_id))
    })?;

    // 1. 检查 workspace 存在且状态为 stopped
    let workspace = tokio::task::spawn_blocking(move || workspaces::get(workspace_id_i64))
        .await
        .map_err(|e| WorkspaceManagerError::Internal(e.into()))?
        .map_err(WorkspaceManagerError::from)?
        .ok_or_else(|| WorkspaceManagerError::NotFound(workspace_id.to_string()))?;

    if workspace.status == "archived" {
        return Err(WorkspaceManagerError::Conflict(
            "Cannot start archived workspace; restore it first".to_string(),
        ));
    }
    if workspace.status == "active" {
        return Err(WorkspaceManagerError::Conflict(
            "Workspace already active".to_string(),
        ));
    }

    // 2. 更新数据库状态为 active
    let mut updated_workspace = workspace.clone();
    updated_workspace.status = "active".to_string();
    updated_workspace.updated_at = now();

    let workspace_for_update = updated_workspace.clone();
    tokio::task::spawn_blocking(move || workspaces::update(workspace_for_update))
        .await
        .map_err(|e| WorkspaceManagerError::Internal(e.into()))?
        .map_err(WorkspaceManagerError::from)?;

    Ok(updated_workspace)
}

/// 归档 workspace（软删除，停止所有 agent）
pub async fn archive_workspace(workspace_id: &str) -> Result<Workspace, WorkspaceManagerError> {
    let workspace_id_i64 = parse_to_i64(workspace_id).ok_or_else(|| {
        WorkspaceManagerError::NotFound(format!("Invalid workspace ID format: {}", workspace_id))
    })?;

    // 1. 检查 workspace 存在
    let workspace = tokio::task::spawn_blocking(move || workspaces::get(workspace_id_i64))
        .await
        .map_err(|e| WorkspaceManagerError::Internal(e.into()))?
        .map_err(WorkspaceManagerError::from)?
        .ok_or_else(|| WorkspaceManagerError::NotFound(workspace_id.to_string()))?;

    if workspace.status == "archived" {
        return Err(WorkspaceManagerError::Conflict(
            "Workspace already archived".to_string(),
        ));
    }

    // 2. 检查是否有活跃 agent
    let runtime = crate::context::get_app_context().agent_runtime.clone();
    let active_agents: Vec<_> = runtime
        .list_agents()
        .await
        .into_iter()
        .filter(|agent| agent.workspace_id == workspace_id && agent.lifecycle.is_alive())
        .collect();

    if !active_agents.is_empty() {
        return Err(WorkspaceManagerError::Conflict(format!(
            "Workspace has {} active agent(s); stop them or use DELETE with force",
            active_agents.len()
        )));
    }

    // 3. 清理运行时 workspace
    if let Ok(workspaces) = runtime.backend().list_workspaces().await {
        if let Some(ws) = workspaces.into_iter().find(|w| w.id == workspace_id) {
            if let Err(e) = runtime.backend().cleanup_workspace(&ws).await {
                tracing::warn!(error = %e, "Failed to cleanup runtime workspace");
            }
        }
    }

    // 4. 从权限处理器注销
    if let Some(permission_handler) = crate::get_permission_handler() {
        permission_handler.unregister_workspace(workspace_id).await;
    }

    // 5. 更新数据库状态为 archived
    let mut updated_workspace = workspace.clone();
    updated_workspace.status = "archived".to_string();
    updated_workspace.updated_at = now();

    let workspace_for_update = updated_workspace.clone();
    tokio::task::spawn_blocking(move || workspaces::update(workspace_for_update))
        .await
        .map_err(|e| WorkspaceManagerError::Internal(e.into()))?
        .map_err(WorkspaceManagerError::from)?;

    Ok(updated_workspace)
}

/// 从归档恢复 workspace
pub async fn restore_workspace(workspace_id: &str) -> Result<Workspace, WorkspaceManagerError> {
    let workspace_id_i64 = parse_to_i64(workspace_id).ok_or_else(|| {
        WorkspaceManagerError::NotFound(format!("Invalid workspace ID format: {}", workspace_id))
    })?;

    // 1. 检查 workspace 存在且状态为 archived
    let workspace = tokio::task::spawn_blocking(move || workspaces::get(workspace_id_i64))
        .await
        .map_err(|e| WorkspaceManagerError::Internal(e.into()))?
        .map_err(WorkspaceManagerError::from)?
        .ok_or_else(|| WorkspaceManagerError::NotFound(workspace_id.to_string()))?;

    if workspace.status != "archived" {
        return Err(WorkspaceManagerError::Conflict(
            "Workspace not archived".to_string(),
        ));
    }

    // 2. 更新数据库状态为 active
    let mut updated_workspace = workspace.clone();
    updated_workspace.status = "active".to_string();
    updated_workspace.updated_at = now();

    let workspace_for_update = updated_workspace.clone();
    tokio::task::spawn_blocking(move || workspaces::update(workspace_for_update))
        .await
        .map_err(|e| WorkspaceManagerError::Internal(e.into()))?
        .map_err(WorkspaceManagerError::from)?;

    Ok(updated_workspace)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_validate_json_settings_valid() {
        let env = Some(HashMap::from([("KEY1".to_string(), "value1".to_string())]));
        let resources = Some(serde_json::json!({
            "max_cpu": 2.0,
            "max_memory_mb": 1024
        }));

        let result = validate_json_settings(env, resources);
        assert!(result.is_ok());

        let (env_json, resources_json) = result.unwrap();
        assert!(env_json.contains("KEY1"));
        assert!(resources_json.contains("max_cpu"));
    }

    #[test]
    fn test_validate_json_settings_defaults() {
        let result = validate_json_settings(None, None);
        assert!(result.is_ok());

        let (env_json, resources_json) = result.unwrap();
        assert_eq!(env_json, "{}");
        assert_eq!(resources_json, "{}");
    }

    #[test]
    fn test_validate_resource_json_valid() {
        let json = r#"{"max_cpu": 2.0, "max_memory_mb": 1024}"#;
        let result = validate_resource_json(json);
        assert!(result.is_ok());
    }

    #[test]
    fn test_validate_resource_json_invalid() {
        let result = validate_resource_json("invalid json");
        assert!(matches!(result, Err(WorkspaceManagerError::Validation(_))));
    }

    #[test]
    fn test_canonical_path_valid() {
        let result = canonical_path("/tmp");
        assert!(result.is_ok());
    }

    #[test]
    fn test_canonical_path_with_trailing_slash() {
        let result = canonical_path("/tmp/");
        assert!(result.is_ok());
        assert_eq!(result.unwrap(), "/tmp");
    }

    #[test]
    fn test_now() {
        let timestamp = now();
        assert!(timestamp > 0);
    }

    #[test]
    fn test_validate_json_settings_with_empty_env() {
        let env = Some(HashMap::new());
        let result = validate_json_settings(env, None);
        assert!(result.is_ok());
    }

    #[test]
    fn test_validate_json_settings_with_multiple_env_vars() {
        let env = Some(HashMap::from([
            ("KEY1".to_string(), "value1".to_string()),
            ("KEY2".to_string(), "value2".to_string()),
            ("KEY3".to_string(), "value3".to_string()),
        ]));
        let result = validate_json_settings(env, None);
        assert!(result.is_ok());
        let (env_json, _) = result.unwrap();
        assert!(env_json.contains("KEY1"));
        assert!(env_json.contains("KEY2"));
        assert!(env_json.contains("KEY3"));
    }

    #[test]
    fn test_validate_resource_json_with_zero_values() {
        let json = r#"{"max_cpu": 0.0, "max_memory_mb": 0}"#;
        let result = validate_resource_json(json);
        assert!(result.is_ok());
    }

    #[test]
    fn test_validate_resource_json_with_large_values() {
        let json = r#"{"max_cpu": 128.0, "max_memory_mb": 65536}"#;
        let result = validate_resource_json(json);
        assert!(result.is_ok());
    }
}
