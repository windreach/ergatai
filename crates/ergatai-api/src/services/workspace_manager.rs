//! Workspace-first management service.

use ergatai_core::id::{format as format_id, generate, parse_to_i64, IdType};
use ergatai_error::{ProjectId, WorkspaceId};
use ergatai_runtime::ResourceLimits;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use utoipa::ToSchema;

use crate::user_data_db::{
    chats, projects, workspaces, Chat as DbChat, Project as DbProject, Workspace,
};

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
    pub default_project_id: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Deserialize, ToSchema)]
pub struct CreateManagedWorkspaceRequest {
    #[schema(pattern = "^ws_[0-9]+_[0-9]{1,3}_[0-9]{1,4}$", min_length = 1)]
    pub id: Option<String>,
    #[schema(min_length = 1)]
    pub name: Option<String>,
    #[schema(min_length = 1)]
    pub work_dir: String,
    #[serde(default)]
    pub env: Option<HashMap<String, String>>,
    #[serde(default)]
    pub resources: Option<serde_json::Value>,
    #[serde(default)]
    pub config: Option<String>,
    #[serde(default)]
    pub collaboration_mode: Option<crate::services::collaboration_session::CollaborationMode>,
    #[serde(default)]
    pub default_project_id: Option<String>,
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
    #[serde(default)]
    pub default_project_id: Option<Option<String>>,
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

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct Project {
    pub project_id: String,
    pub workspace_id: String,
    pub name: String,
    pub path: String,
    pub description: Option<String>,
    pub git_remote_url: Option<String>,
    pub git_provider: Option<String>,
    pub git_owner: Option<String>,
    pub git_repo: Option<String>,
    pub icon_path: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Deserialize, ToSchema)]
pub struct RegisterWorkspaceProjectRequest {
    #[schema(min_length = 1)]
    pub name: String,
    #[schema(min_length = 1)]
    pub path: String,
    pub description: Option<String>,
    pub git_remote_url: Option<String>,
    pub git_provider: Option<String>,
    pub git_owner: Option<String>,
    pub git_repo: Option<String>,
    pub icon_path: Option<String>,
}

#[derive(Debug, Clone, Deserialize, ToSchema)]
pub struct UpdateWorkspaceProjectRequest {
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub path: Option<String>,
    #[serde(default)]
    pub description: Option<Option<String>>,
    #[serde(default)]
    pub git_remote_url: Option<Option<String>>,
    #[serde(default)]
    pub git_provider: Option<Option<String>>,
    #[serde(default)]
    pub git_owner: Option<Option<String>>,
    #[serde(default)]
    pub git_repo: Option<Option<String>>,
    #[serde(default)]
    pub icon_path: Option<Option<String>>,
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

/// Normalize stored paths for API consumers and downstream filesystem use.
fn normalized_path(path: &str) -> String {
    crate::expand_home_path(path).to_string_lossy().into_owned()
}

fn canonical_path(path: &str) -> Result<String, WorkspaceManagerError> {
    let expanded_path = crate::expand_home_path(path);
    let path = expanded_path.to_string_lossy();
    let path = path.as_ref();

    // Accept paths that do not yet exist (common in tests / newly generated
    // schemathesis requests) while still rejecting traversal attempts.
    for component in std::path::Path::new(path).components() {
        if matches!(component, std::path::Component::ParentDir) {
            return Err(WorkspaceManagerError::Validation(
                "Path traversal (..) not allowed in work_dir".to_string(),
            ));
        }
    }
    // If the path exists, fully validate (canonicalize, dir check, whitelist).
    if std::path::Path::new(path).exists() {
        return crate::validate_cwd(path)
            .map(|path| path.to_string_lossy().into_owned())
            .map_err(WorkspaceManagerError::Validation);
    }
    Ok(path.to_string())
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
        workspace_id: workspace.workspace_id.to_string(),
        name: workspace.name,
        work_dir: normalized_path(&workspace.work_dir),
        env: workspace.env,
        resources: workspace.resources,
        config: workspace.config,
        collaboration_mode: workspace.collaboration_mode,
        status: workspace.status,
        default_project_id: workspace.default_project_id.map(|id| id.to_string()),
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
    let id = WorkspaceId::decode(workspace_id).map_err(|_| {
        WorkspaceManagerError::NotFound(format!("Invalid workspace ID format: {}", workspace_id))
    })?;
    let workspace = tokio::task::spawn_blocking(move || workspaces::get(id))
        .await
        .map_err(|e| WorkspaceManagerError::Internal(e.into()))?
        .map_err(WorkspaceManagerError::from)?
        .ok_or_else(|| WorkspaceManagerError::NotFound(workspace_id.to_string()))?;
    to_managed(workspace).await
}

pub async fn create(
    request: CreateManagedWorkspaceRequest,
) -> Result<ManagedWorkspace, WorkspaceManagerError> {
    let workspace_id = match &request.id {
        None => WorkspaceId::generate(),
        Some(id) if WorkspaceId::decode(id).is_ok() => WorkspaceId::decode(id).unwrap(),
        Some(_) => {
            return Err(WorkspaceManagerError::Validation(
                "Invalid workspace ID format".to_string(),
            ))
        }
    };
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

    if request.work_dir.trim().is_empty() {
        return Err(WorkspaceManagerError::Validation(
            "Work directory cannot be empty".to_string(),
        ));
    }
    if let Some(name) = &request.name {
        if name.trim().is_empty() {
            return Err(WorkspaceManagerError::Validation(
                "Name cannot be empty".to_string(),
            ));
        }
    }
    let work_dir = canonical_path(&request.work_dir)?;
    let (env, resources) = validate_json_settings(request.env, request.resources)?;
    let config = request.config.unwrap_or_else(|| "{}".to_string());
    let collaboration_mode = request
        .collaboration_mode
        .unwrap_or(crate::services::collaboration_session::CollaborationMode::Supervisor);

    // Validate default_project_id if provided
    let default_project_id = match request.default_project_id {
        None => None,
        Some(id_str) => {
            let id = ProjectId::decode(&id_str).map_err(|_| {
                WorkspaceManagerError::Validation(format!(
                    "Invalid default_project_id format: {}",
                    id_str
                ))
            })?;

            // Validate that the project exists
            let project_exists = tokio::task::spawn_blocking(move || {
                crate::user_data_db::projects::exists(id.as_i64())
            })
            .await
            .map_err(|e| WorkspaceManagerError::Internal(e.into()))??;

            if !project_exists {
                return Err(WorkspaceManagerError::Validation(format!(
                    "Project {} does not exist",
                    id_str
                )));
            }

            Some(id)
        }
    };

    let timestamp = now();
    let workspace = Workspace {
        workspace_id,
        name: request.name.unwrap_or_default(),
        work_dir,
        env,
        resources,
        config,
        collaboration_mode: collaboration_mode.as_str().to_string(),
        status: "active".to_string(),
        default_project_id,
        created_at: timestamp,
        updated_at: timestamp,
    };
    let workspace_clone = workspace.clone();
    tokio::task::spawn_blocking(move || workspaces::create(workspace_clone))
        .await
        .map_err(|e| WorkspaceManagerError::Internal(e.into()))?
        .map_err(WorkspaceManagerError::from)?;
    // Return the workspace we just created, avoiding a redundant database query
    to_managed(workspace).await
}

pub async fn update(
    workspace_id: &str,
    request: UpdateManagedWorkspaceRequest,
) -> Result<ManagedWorkspace, WorkspaceManagerError> {
    let id = WorkspaceId::decode(workspace_id).map_err(|_| {
        WorkspaceManagerError::NotFound(format!("Invalid workspace ID format: {}", workspace_id))
    })?;
    let existing = tokio::task::spawn_blocking(move || workspaces::get(id))
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

    // Update default_project_id if provided
    let default_project_id = if let Some(project_id_opt) = request.default_project_id {
        match project_id_opt {
            None => None, // Set to null
            Some(id_str) => {
                let project_id = ProjectId::decode(&id_str).map_err(|_| {
                    WorkspaceManagerError::Validation(format!(
                        "Invalid default_project_id format: {}",
                        id_str
                    ))
                })?;

                // Validate that the project exists and belongs to this workspace
                let project_exists = tokio::task::spawn_blocking({
                    let workspace_id = existing.workspace_id;
                    move || {
                        crate::user_data_db::projects::exists_and_belongs_to(
                            project_id.as_i64(),
                            workspace_id.as_i64(),
                        )
                    }
                })
                .await
                .map_err(|e| WorkspaceManagerError::Internal(e.into()))??;

                if !project_exists {
                    return Err(WorkspaceManagerError::Validation(format!(
                        "Project {} does not exist or does not belong to workspace {}",
                        id_str, workspace_id
                    )));
                }

                Some(project_id)
            }
        }
    } else {
        existing.default_project_id
    };

    let updated = Workspace {
        workspace_id: existing.workspace_id,
        name: request.name.clone().unwrap_or(existing.name.clone()),
        work_dir,
        env,
        resources,
        config,
        collaboration_mode: existing.collaboration_mode,
        status,
        default_project_id,
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
    let id = WorkspaceId::decode(workspace_id).map_err(|_| {
        WorkspaceManagerError::NotFound(format!("Invalid workspace ID format: {}", workspace_id))
    })?;
    let status_owned = status.to_string();
    let success = tokio::task::spawn_blocking(move || workspaces::set_status(id, &status_owned))
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
        .filter(|agent| {
            agent.workspace_id.to_string() == workspace_id && agent.lifecycle.is_alive()
        })
        .count();
    let workspace_id = WorkspaceId::decode(&workspace.workspace_id).map_err(|_| {
        WorkspaceManagerError::Internal(anyhow::anyhow!(
            "Invalid workspace ID format: {}",
            workspace.workspace_id
        ))
    })?;
    let chats =
        tokio::task::spawn_blocking(move || crate::user_data_db::chats::list(Some(workspace_id)))
            .await
            .map_err(|e| WorkspaceManagerError::Internal(e.into()))?
            .map_err(WorkspaceManagerError::from)?;
    let active_chat_count = chats
        .iter()
        .filter(|chat| chat.archived_at.is_none())
        .count();

    // Expand ~ to home directory for proper path checking
    let expanded_work_dir = if workspace.work_dir.starts_with("~/") {
        std::env::var("HOME")
            .map(|home| format!("{}/{}", home, &workspace.work_dir[2..]))
            .unwrap_or_else(|_| workspace.work_dir.clone())
    } else {
        workspace.work_dir.clone()
    };
    let work_dir_exists = std::path::Path::new(&expanded_work_dir).is_dir();

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
        .filter(|agent| {
            agent.workspace_id.to_string() == workspace_id && agent.lifecycle.is_alive()
        })
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
        let workspace_id = WorkspaceId::decode(workspace_id).map_err(|_| {
            WorkspaceManagerError::NotFound(format!(
                "Invalid workspace ID format: {}",
                workspace_id
            ))
        })?;
        let chats_result = tokio::task::spawn_blocking(move || {
            crate::user_data_db::chats::list(Some(workspace_id))
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

    // Unregister workspace from permission handler to prevent memory leak.
    // Key format must match register_workspace() in main.rs: raw i64 decimal string
    // (e.g. "1234567890"), not the formatted typed ID (e.g. "ws_123_001_0001").
    if let Some(permission_handler) = crate::get_permission_handler() {
        let unregister_key = match WorkspaceId::decode(workspace_id) {
            Ok(typed_id) => typed_id.as_i64().to_string(),
            Err(_) => workspace_id.to_string(),
        };
        permission_handler
            .unregister_workspace(&unregister_key)
            .await;
    }

    let workspace_id = WorkspaceId::decode(workspace_id).map_err(|_| {
        WorkspaceManagerError::NotFound(format!("Invalid workspace ID format: {}", workspace_id))
    })?;
    tokio::task::spawn_blocking(move || workspaces::delete(workspace_id))
        .await
        .map_err(|e| WorkspaceManagerError::Internal(e.into()))?
        .map_err(WorkspaceManagerError::from)?;
    Ok(())
}

/// 停止 workspace（停止所有 agent，保留数据）
pub async fn stop_workspace(workspace_id: &str) -> Result<Workspace, WorkspaceManagerError> {
    let workspace_id = WorkspaceId::decode(workspace_id).map_err(|_| {
        WorkspaceManagerError::NotFound(format!("Invalid workspace ID format: {}", workspace_id))
    })?;

    // 1. 检查 workspace 存在且状态为 active
    let workspace = tokio::task::spawn_blocking(move || workspaces::get(workspace_id))
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
        .filter(|agent| {
            agent.workspace_id == workspace_id.to_string() && agent.lifecycle.is_alive()
        })
        .collect();

    for agent in active_agents {
        let _ = runtime.stop_agent(&agent.agent_id).await;
    }

    // 3. 清理运行时 workspace
    if let Ok(workspaces) = runtime.backend().list_workspaces().await {
        if let Some(ws) = workspaces
            .into_iter()
            .find(|w| w.id == workspace_id.to_string())
        {
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
    let workspace_id = WorkspaceId::decode(workspace_id).map_err(|_| {
        WorkspaceManagerError::NotFound(format!("Invalid workspace ID format: {}", workspace_id))
    })?;

    // 1. 检查 workspace 存在且状态为 stopped
    let workspace = tokio::task::spawn_blocking(move || workspaces::get(workspace_id))
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
    let workspace_id = WorkspaceId::decode(workspace_id).map_err(|_| {
        WorkspaceManagerError::NotFound(format!("Invalid workspace ID format: {}", workspace_id))
    })?;

    // 1. 检查 workspace 存在
    let workspace = tokio::task::spawn_blocking(move || workspaces::get(workspace_id))
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
        .filter(|agent| {
            agent.workspace_id == workspace_id.to_string() && agent.lifecycle.is_alive()
        })
        .collect();

    if !active_agents.is_empty() {
        return Err(WorkspaceManagerError::Conflict(format!(
            "Workspace has {} active agent(s); stop them or use DELETE with force",
            active_agents.len()
        )));
    }

    // 3. 清理运行时 workspace
    if let Ok(workspaces) = runtime.backend().list_workspaces().await {
        if let Some(ws) = workspaces
            .into_iter()
            .find(|w| w.id == workspace_id.to_string())
        {
            if let Err(e) = runtime.backend().cleanup_workspace(&ws).await {
                tracing::warn!(error = %e, "Failed to cleanup runtime workspace");
            }
        }
    }

    // 4. 从权限处理器注销
    // Key format must match register_workspace() in main.rs: raw i64 decimal string,
    // not the formatted typed ID (e.g. "ws_123_001_0001").
    if let Some(permission_handler) = crate::get_permission_handler() {
        permission_handler
            .unregister_workspace(&workspace_id.as_i64().to_string())
            .await;
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
    let workspace_id = WorkspaceId::decode(workspace_id).map_err(|_| {
        WorkspaceManagerError::NotFound(format!("Invalid workspace ID format: {}", workspace_id))
    })?;

    // 1. 检查 workspace 存在且状态为 archived
    let workspace = tokio::task::spawn_blocking(move || workspaces::get(workspace_id))
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

// ── Project Management ──

/// List all projects in a workspace
pub fn list_projects(workspace_id: &str) -> Result<Vec<Project>, WorkspaceManagerError> {
    let workspace_id = WorkspaceId::decode(workspace_id).map_err(|_| {
        WorkspaceManagerError::NotFound(format!("Invalid workspace ID format: {}", workspace_id))
    })?;

    // Check workspace exists
    let _ws = workspaces::get(workspace_id)
        .map_err(WorkspaceManagerError::from)?
        .ok_or_else(|| WorkspaceManagerError::NotFound(workspace_id.to_string()))?;

    // List projects from database
    let db_projects = projects::list(workspace_id.as_i64()).map_err(WorkspaceManagerError::from)?;

    // Convert to Project type
    Ok(db_projects
        .into_iter()
        .map(|p| Project {
            project_id: format_id(p.project_id, IdType::Project),
            workspace_id: format_id(p.workspace_id, IdType::Workspace),
            name: p.name,
            path: normalized_path(&p.path),
            description: p.description,
            git_remote_url: p.git_remote_url,
            git_provider: p.git_provider,
            git_owner: p.git_owner,
            git_repo: p.git_repo,
            icon_path: p.icon_path,
            created_at: p.created_at,
            updated_at: p.updated_at,
        })
        .collect())
}

/// Register a new project in a workspace
pub fn register_project(
    workspace_id: &str,
    request: RegisterWorkspaceProjectRequest,
) -> Result<Project, WorkspaceManagerError> {
    let workspace_id = WorkspaceId::decode(workspace_id).map_err(|_| {
        WorkspaceManagerError::NotFound(format!("Invalid workspace ID format: {}", workspace_id))
    })?;

    // Check workspace exists
    let _ws = workspaces::get(workspace_id)
        .map_err(WorkspaceManagerError::from)?
        .ok_or_else(|| WorkspaceManagerError::NotFound(workspace_id.to_string()))?;

    // Validate project path
    let canonical_path = canonical_path(&request.path)?;

    // Create project in database
    let now = now();
    let project_id = generate();
    let db_project = DbProject {
        project_id,
        workspace_id: workspace_id.as_i64(),
        name: request.name.clone(),
        path: canonical_path,
        description: request.description.clone(),
        git_remote_url: request.git_remote_url.clone(),
        git_provider: request.git_provider.clone(),
        git_owner: request.git_owner.clone(),
        git_repo: request.git_repo.clone(),
        icon_path: request.icon_path.clone(),
        created_at: now,
        updated_at: now,
    };

    let created = projects::create(db_project).map_err(WorkspaceManagerError::from)?;

    // Convert to Project type
    Ok(Project {
        project_id: format_id(created.project_id, IdType::Project),
        workspace_id: format_id(created.workspace_id, IdType::Workspace),
        name: created.name,
        path: created.path,
        description: created.description,
        git_remote_url: created.git_remote_url,
        git_provider: created.git_provider,
        git_owner: created.git_owner,
        git_repo: created.git_repo,
        icon_path: created.icon_path,
        created_at: created.created_at,
        updated_at: created.updated_at,
    })
}

/// Remove a project from a workspace
pub fn remove_project(workspace_id: &str, project_id: &str) -> Result<(), WorkspaceManagerError> {
    let workspace_id = WorkspaceId::decode(workspace_id).map_err(|_| {
        WorkspaceManagerError::NotFound(format!("Invalid workspace ID format: {}", workspace_id))
    })?;

    let project_id_i64 = parse_to_i64(project_id).ok_or_else(|| {
        WorkspaceManagerError::NotFound(format!("Invalid project ID format: {}", project_id))
    })?;

    // Check workspace exists
    let _ws = workspaces::get(workspace_id)
        .map_err(WorkspaceManagerError::from)?
        .ok_or_else(|| WorkspaceManagerError::NotFound(workspace_id.to_string()))?;

    // Check project exists
    let project = projects::get(project_id_i64)
        .map_err(WorkspaceManagerError::from)?
        .ok_or_else(|| WorkspaceManagerError::NotFound(project_id.to_string()))?;

    // Verify project belongs to workspace
    if project.workspace_id != workspace_id.as_i64() {
        return Err(WorkspaceManagerError::Validation(
            "Project does not belong to this workspace".to_string(),
        ));
    }

    // Delete project from database
    projects::delete(project_id_i64).map_err(WorkspaceManagerError::from)?;

    Ok(())
}

/// Update a project in a workspace
pub fn update_project(
    workspace_id: &str,
    project_id: &str,
    request: UpdateWorkspaceProjectRequest,
) -> Result<Project, WorkspaceManagerError> {
    let workspace_id = WorkspaceId::decode(workspace_id).map_err(|_| {
        WorkspaceManagerError::NotFound(format!("Invalid workspace ID format: {}", workspace_id))
    })?;

    let project_id_i64 = parse_to_i64(project_id).ok_or_else(|| {
        WorkspaceManagerError::NotFound(format!("Invalid project ID format: {}", project_id))
    })?;

    // Check workspace exists
    let _ws = workspaces::get(workspace_id)
        .map_err(WorkspaceManagerError::from)?
        .ok_or_else(|| WorkspaceManagerError::NotFound(workspace_id.to_string()))?;

    // Get existing project
    let mut project = projects::get(project_id_i64)
        .map_err(WorkspaceManagerError::from)?
        .ok_or_else(|| WorkspaceManagerError::NotFound(project_id.to_string()))?;

    // Verify project belongs to workspace
    if project.workspace_id != workspace_id.as_i64() {
        return Err(WorkspaceManagerError::Validation(
            "Project does not belong to this workspace".to_string(),
        ));
    }

    // Update fields if provided
    if let Some(name) = request.name {
        if name.trim().is_empty() {
            return Err(WorkspaceManagerError::Validation(
                "Project name cannot be empty".to_string(),
            ));
        }
        project.name = name;
    }

    if let Some(path) = request.path {
        let canonical_path = canonical_path(&path)?;
        project.path = canonical_path;
    }

    if let Some(description) = request.description {
        project.description = description;
    }

    if let Some(git_remote_url) = request.git_remote_url {
        project.git_remote_url = git_remote_url;
    }

    if let Some(git_provider) = request.git_provider {
        project.git_provider = git_provider;
    }

    if let Some(git_owner) = request.git_owner {
        project.git_owner = git_owner;
    }

    if let Some(git_repo) = request.git_repo {
        project.git_repo = git_repo;
    }

    if let Some(icon_path) = request.icon_path {
        project.icon_path = icon_path;
    }

    // Update timestamp
    project.updated_at = now();

    // Save to database
    projects::update(project.clone()).map_err(WorkspaceManagerError::from)?;

    // Convert to Project type
    Ok(Project {
        project_id: format_id(project.project_id, IdType::Project),
        workspace_id: format_id(project.workspace_id, IdType::Workspace),
        name: project.name,
        path: normalized_path(&project.path),
        description: project.description,
        git_remote_url: project.git_remote_url,
        git_provider: project.git_provider,
        git_owner: project.git_owner,
        git_repo: project.git_repo,
        icon_path: project.icon_path,
        created_at: project.created_at,
        updated_at: project.updated_at,
    })
}

/// Response for path registration lookup.
/// Used by GET /api/v1/registered-path to resolve a filesystem path to its registered project and/or chat.
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct RegisteredPathResponse {
    /// The project whose path matches (exact or parent), if any.
    pub project: Option<Project>,
    /// The chat whose worktree_path matches (exact or parent), if any.
    pub chat: Option<ChatResponse>,
}

/// Lightweight chat representation for the registered-path endpoint.
/// Mirrors the fields the frontend needs from a chat record (matches BackendChat type).
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct ChatResponse {
    pub id: String,
    pub workspace_id: String,
    pub name: Option<String>,
    pub collaboration_mode: Option<String>,
    pub worktree_path: Option<String>,
    pub branch: Option<String>,
    pub base_branch: Option<String>,
    pub pr_url: Option<String>,
    pub pr_number: Option<i32>,
    pub created_at: i64,
    pub updated_at: i64,
    pub archived_at: Option<i64>,
}

fn db_chat_to_response(chat: DbChat) -> ChatResponse {
    ChatResponse {
        id: chat.chat_id.to_string(),
        workspace_id: chat.workspace_id.to_string(),
        name: chat.name,
        collaboration_mode: chat.collaboration_mode,
        worktree_path: chat.worktree_path,
        branch: chat.branch,
        base_branch: chat.base_branch,
        pr_url: chat.pr_url,
        pr_number: chat.pr_number,
        created_at: chat.created_at,
        updated_at: chat.updated_at,
        archived_at: chat.archived_at,
    }
}

/// Resolve a filesystem path to its registered project and/or chat.
///
/// Uses prefix matching: if the input path is a subdirectory of a registered project path
/// or chat worktree_path, the most specific (longest) match is returned.
///
/// Example:
///   - Input: `/home/user/project/.ergatai/worktrees/ws/branch`
///   - Matches project path: `/home/user/project`
pub fn find_registered_path(path: &str) -> Result<RegisteredPathResponse, WorkspaceManagerError> {
    let db_project = projects::find_by_path_or_parent(path).map_err(WorkspaceManagerError::from)?;
    let db_chat =
        chats::find_by_worktree_path_or_parent(path).map_err(WorkspaceManagerError::from)?;

    let project = db_project.map(|p| Project {
        project_id: format_id(p.project_id, IdType::Project),
        workspace_id: format_id(p.workspace_id, IdType::Workspace),
        name: p.name,
        path: p.path,
        description: p.description,
        git_remote_url: p.git_remote_url,
        git_provider: p.git_provider,
        git_owner: p.git_owner,
        git_repo: p.git_repo,
        icon_path: p.icon_path,
        created_at: p.created_at,
        updated_at: p.updated_at,
    });

    let chat = db_chat.map(db_chat_to_response);

    Ok(RegisteredPathResponse { project, chat })
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
