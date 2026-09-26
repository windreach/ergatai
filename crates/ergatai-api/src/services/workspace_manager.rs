//! Workspace-first management service.

use ergatai_runtime::ResourceLimits;
use rusqlite::params;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use utoipa::ToSchema;

use crate::user_data_db::{workspace_projects, workspaces, Project, Workspace, WorkspaceProject};

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct ManagedWorkspaceProject {
    pub workspace_id: String,
    pub project_id: String,
    pub project_name: String,
    pub project_path: String,
    pub is_default: bool,
    pub status: String,
    pub settings_json: String,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct ManagedWorkspace {
    pub id: String,
    pub project_id: String,
    pub name: Option<String>,
    pub work_dir: String,
    pub env: String,
    pub resources: String,
    pub capture_thoughts: bool,
    pub collaboration_mode: String,
    pub status: String,
    pub created_at: i64,
    pub updated_at: i64,
    pub projects: Vec<ManagedWorkspaceProject>,
}

#[derive(Debug, Clone, Deserialize, ToSchema)]
pub struct CreateManagedWorkspaceRequest {
    pub id: Option<String>,
    pub name: Option<String>,
    pub work_dir: String,
    #[serde(default)]
    pub project_id: Option<String>,
    #[serde(default)]
    pub project_path: Option<String>,
    #[serde(default)]
    pub project_name: Option<String>,
    #[serde(default)]
    pub env: Option<HashMap<String, String>>,
    #[serde(default)]
    pub resources: Option<serde_json::Value>,
    #[serde(default)]
    pub capture_thoughts: bool,
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
    pub capture_thoughts: Option<bool>,
    #[serde(default)]
    pub status: Option<String>,
    #[serde(default)]
    pub default_project_id: Option<String>,
}

#[derive(Debug, Clone, Deserialize, ToSchema)]
pub struct RegisterWorkspaceProjectRequest {
    #[serde(default)]
    pub project_id: Option<String>,
    #[serde(default)]
    pub project_path: Option<String>,
    #[serde(default)]
    pub project_name: Option<String>,
    #[serde(default)]
    pub is_default: bool,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct WorkspaceStatus {
    pub workspace_id: String,
    pub status: String,
    pub work_dir: String,
    pub work_dir_exists: bool,
    pub project_count: usize,
    pub active_agent_count: usize,
    pub conversation_count: usize,
    pub active_conversation_count: usize,
    pub worktree_count: usize,
    pub dirty_worktree_count: usize,
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
async fn count_dirty_worktrees(paths: &[&str]) -> usize {
    let checks: Vec<_> = paths.iter().map(|path| is_dirty_worktree(path)).collect();
    futures::future::join_all(checks)
        .await
        .into_iter()
        .filter(|&dirty| dirty)
        .count()
}

async fn find_or_create_project(
    project_id: Option<&str>,
    project_path: Option<&str>,
    project_name: Option<&str>,
) -> Result<Project, WorkspaceManagerError> {
    if let Some(project_id) = project_id.filter(|id| !id.is_empty()) {
        let project_id = project_id.to_string();
        let result =
            tokio::task::spawn_blocking(move || crate::user_data_db::projects::get(&project_id))
                .await
                .map_err(|e| WorkspaceManagerError::Internal(e.into()))?
                .map_err(WorkspaceManagerError::from)?;
        return result
            .ok_or_else(|| WorkspaceManagerError::NotFound("Project not found".to_string()));
    }

    let raw_path = project_path
        .filter(|path| !path.is_empty())
        .ok_or_else(|| {
            WorkspaceManagerError::Validation("project_id or project_path is required".to_string())
        })?;
    let path = canonical_path(raw_path)?;
    let path_clone = path.clone();
    let existing = tokio::task::spawn_blocking(move || {
        crate::user_data_db::projects::find_by_path(&path_clone)
    })
    .await
    .map_err(|e| WorkspaceManagerError::Internal(e.into()))?
    .map_err(WorkspaceManagerError::from)?;
    if let Some(existing) = existing {
        return Ok(existing);
    }

    let timestamp = now();
    let project = Project {
        id: format!("proj-{}", uuid::Uuid::new_v4()),
        name: project_name
            .filter(|name| !name.trim().is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| {
                std::path::Path::new(&path)
                    .file_name()
                    .map(|name| name.to_string_lossy().into_owned())
                    .unwrap_or_else(|| "Project".to_string())
            }),
        path,
        git_remote_url: None,
        git_provider: None,
        git_owner: None,
        git_repo: None,
        icon_path: None,
        created_at: timestamp,
        updated_at: timestamp,
    };
    let project_clone = project.clone();
    tokio::task::spawn_blocking(move || crate::user_data_db::projects::create(project_clone))
        .await
        .map_err(|e| WorkspaceManagerError::Internal(e.into()))?
        .map_err(WorkspaceManagerError::from)?;
    Ok(project)
}

fn project_link(link: WorkspaceProject, project: &Project) -> ManagedWorkspaceProject {
    ManagedWorkspaceProject {
        workspace_id: link.workspace_id,
        project_id: link.project_id,
        project_name: project.name.clone(),
        project_path: project.path.clone(),
        is_default: link.is_default,
        status: link.status,
        settings_json: link.settings_json,
        created_at: link.created_at,
        updated_at: link.updated_at,
    }
}

pub async fn to_managed(workspace: Workspace) -> Result<ManagedWorkspace, WorkspaceManagerError> {
    validate_resource_json(&workspace.resources)?;
    let workspace_id = workspace.id.clone();
    let project_ids = tokio::task::spawn_blocking(move || workspace_projects::list(&workspace_id))
        .await
        .map_err(|e| WorkspaceManagerError::Internal(e.into()))?
        .map_err(WorkspaceManagerError::from)?;

    let mut projects = Vec::new();
    for link in project_ids {
        let project_id = link.project_id.clone();
        let project =
            tokio::task::spawn_blocking(move || crate::user_data_db::projects::get(&project_id))
                .await
                .map_err(|e| WorkspaceManagerError::Internal(e.into()))?
                .map_err(WorkspaceManagerError::from)?
                .ok_or_else(|| {
                    WorkspaceManagerError::Internal(anyhow::anyhow!("Registered project missing"))
                })?;
        projects.push(project_link(link, &project));
    }

    Ok(ManagedWorkspace {
        id: workspace.id,
        project_id: workspace.project_id,
        name: workspace.name,
        work_dir: workspace.work_dir,
        env: workspace.env,
        resources: workspace.resources,
        capture_thoughts: workspace.capture_thoughts,
        collaboration_mode: workspace.collaboration_mode,
        status: workspace.status,
        created_at: workspace.created_at,
        updated_at: workspace.updated_at,
        projects,
    })
}

pub async fn list(
    project_id: Option<&str>,
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

    let project_id_owned = project_id.map(|s| s.to_string());
    let collaboration_mode_owned = collaboration_mode.map(|s| s.to_string());
    let workspaces = tokio::task::spawn_blocking(move || {
        workspaces::list(
            project_id_owned.as_deref(),
            collaboration_mode_owned.as_deref(),
        )
    })
    .await
    .map_err(|e| WorkspaceManagerError::Internal(e.into()))?
    .map_err(WorkspaceManagerError::from)?;

    let mut result = Vec::new();
    for workspace in workspaces {
        result.push(to_managed(workspace).await?);
    }
    Ok(result)
}

pub async fn get(id: &str) -> Result<ManagedWorkspace, WorkspaceManagerError> {
    let id_owned = id.to_string();
    let workspace = tokio::task::spawn_blocking(move || workspaces::get(&id_owned))
        .await
        .map_err(|e| WorkspaceManagerError::Internal(e.into()))?
        .map_err(WorkspaceManagerError::from)?
        .ok_or_else(|| WorkspaceManagerError::NotFound(id.to_string()))?;
    to_managed(workspace).await
}

pub async fn create(
    request: CreateManagedWorkspaceRequest,
) -> Result<ManagedWorkspace, WorkspaceManagerError> {
    let id = request
        .id
        .filter(|id| !id.is_empty())
        .unwrap_or_else(|| format!("ws-{}", uuid::Uuid::new_v4().simple()));
    let id_check = id.clone();
    let exists = tokio::task::spawn_blocking(move || workspaces::get(&id_check))
        .await
        .map_err(|e| WorkspaceManagerError::Internal(e.into()))?
        .map_err(WorkspaceManagerError::from)?
        .is_some();
    if exists {
        return Err(WorkspaceManagerError::Conflict(format!(
            "Workspace {} already exists",
            id
        )));
    }

    let work_dir = canonical_path(&request.work_dir)?;
    let project = find_or_create_project(
        request.project_id.as_deref(),
        request.project_path.as_deref().or(Some(&work_dir)),
        request.project_name.as_deref(),
    )
    .await?;
    let (env, resources) = validate_json_settings(request.env, request.resources)?;
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
        id,
        project_id: project.id,
        name: request.name,
        work_dir,
        env,
        resources,
        capture_thoughts: request.capture_thoughts,
        collaboration_mode: collaboration_mode.to_string(),
        status: "active".to_string(),
        created_at: timestamp,
        updated_at: timestamp,
    };
    let workspace_clone = workspace.clone();
    tokio::task::spawn_blocking(move || workspaces::create_with_default_project(workspace_clone))
        .await
        .map_err(|e| WorkspaceManagerError::Internal(e.into()))?
        .map_err(WorkspaceManagerError::from)?;
    get(&workspace.id).await
}

pub async fn update(
    id: &str,
    request: UpdateManagedWorkspaceRequest,
) -> Result<ManagedWorkspace, WorkspaceManagerError> {
    let id_owned = id.to_string();
    let existing = tokio::task::spawn_blocking(move || workspaces::get(&id_owned))
        .await
        .map_err(|e| WorkspaceManagerError::Internal(e.into()))?
        .map_err(WorkspaceManagerError::from)?
        .ok_or_else(|| WorkspaceManagerError::NotFound(id.to_string()))?;
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
    let status = request.status.clone().unwrap_or(existing.status.clone());
    if !matches!(status.as_str(), "active" | "archived" | "error") {
        return Err(WorkspaceManagerError::Validation(format!(
            "Unsupported workspace status: {}",
            status
        )));
    }
    let updated = Workspace {
        id: existing.id.clone(),
        project_id: existing.project_id.clone(),
        name: request.name.clone().or(existing.name.clone()),
        work_dir,
        env,
        resources,
        capture_thoughts: request
            .capture_thoughts
            .unwrap_or(existing.capture_thoughts),
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
    if let Some(default_project_id) = request.default_project_id.as_deref() {
        let id_owned = id.to_string();
        let default_project_id_owned = default_project_id.to_string();
        tokio::task::spawn_blocking(move || {
            workspaces::set_default_project(&id_owned, &default_project_id_owned)
        })
        .await
        .map_err(|e| WorkspaceManagerError::Internal(e.into()))?
        .map_err(WorkspaceManagerError::from)?;
    }
    get(id).await
}

pub async fn set_status(id: &str, status: &str) -> Result<ManagedWorkspace, WorkspaceManagerError> {
    if !matches!(status, "active" | "archived" | "error") {
        return Err(WorkspaceManagerError::Validation(format!(
            "Unsupported workspace status: {}",
            status
        )));
    }
    let id_owned = id.to_string();
    let status_owned = status.to_string();
    let success =
        tokio::task::spawn_blocking(move || workspaces::set_status(&id_owned, &status_owned))
            .await
            .map_err(|e| WorkspaceManagerError::Internal(e.into()))?
            .map_err(WorkspaceManagerError::from)?;
    if !success {
        return Err(WorkspaceManagerError::NotFound(id.to_string()));
    }
    get(id).await
}

pub async fn register_project(
    workspace_id: &str,
    request: RegisterWorkspaceProjectRequest,
) -> Result<ManagedWorkspace, WorkspaceManagerError> {
    let workspace_id_owned = workspace_id.to_string();
    let existing = tokio::task::spawn_blocking(move || workspaces::get(&workspace_id_owned))
        .await
        .map_err(|e| WorkspaceManagerError::Internal(e.into()))?
        .map_err(WorkspaceManagerError::from)?
        .ok_or_else(|| WorkspaceManagerError::NotFound(workspace_id.to_string()))?;
    let project = find_or_create_project(
        request.project_id.as_deref(),
        request.project_path.as_deref(),
        request.project_name.as_deref(),
    )
    .await?;
    let workspace_id_check = workspace_id.to_string();
    let project_id_check = project.id.clone();
    let already_exists = tokio::task::spawn_blocking(move || {
        workspace_projects::get(&workspace_id_check, &project_id_check)
    })
    .await
    .map_err(|e| WorkspaceManagerError::Internal(e.into()))?
    .map_err(WorkspaceManagerError::from)?
    .is_some();
    if already_exists {
        return Err(WorkspaceManagerError::Conflict(
            "Project is already registered in this workspace".to_string(),
        ));
    }
    let timestamp = now();
    let workspace_project = WorkspaceProject {
        workspace_id: existing.id,
        project_id: project.id.clone(),
        is_default: false,
        status: "active".to_string(),
        settings_json: "{}".to_string(),
        created_at: timestamp,
        updated_at: timestamp,
    };
    let workspace_project_clone = workspace_project.clone();
    tokio::task::spawn_blocking(move || workspace_projects::create(workspace_project_clone))
        .await
        .map_err(|e| WorkspaceManagerError::Internal(e.into()))?
        .map_err(WorkspaceManagerError::from)?;
    if request.is_default {
        let workspace_id_set = workspace_id.to_string();
        let project_id_set = project.id.clone();
        tokio::task::spawn_blocking(move || {
            workspaces::set_default_project(&workspace_id_set, &project_id_set)
        })
        .await
        .map_err(|e| WorkspaceManagerError::Internal(e.into()))?
        .map_err(WorkspaceManagerError::from)?;
    }
    get(workspace_id).await
}

pub async fn list_projects(
    workspace_id: &str,
) -> Result<Vec<ManagedWorkspaceProject>, WorkspaceManagerError> {
    Ok(get(workspace_id).await?.projects)
}

pub async fn remove_project(
    workspace_id: &str,
    project_id: &str,
) -> Result<ManagedWorkspace, WorkspaceManagerError> {
    let workspace = get(workspace_id).await?;
    if workspace.projects.len() <= 1 {
        return Err(WorkspaceManagerError::Conflict(
            "A workspace must retain at least one registered project".to_string(),
        ));
    }
    let workspace_id_owned = workspace_id.to_string();
    let project_id_owned = project_id.to_string();
    let deleted = tokio::task::spawn_blocking(move || {
        workspace_projects::delete(&workspace_id_owned, &project_id_owned)
    })
    .await
    .map_err(|e| WorkspaceManagerError::Internal(e.into()))?
    .map_err(WorkspaceManagerError::from)?;
    if !deleted {
        return Err(WorkspaceManagerError::NotFound(
            "Project link not found".to_string(),
        ));
    }
    if workspace.project_id == project_id {
        let next_default = workspace
            .projects
            .iter()
            .find(|link| link.project_id != project_id)
            .ok_or_else(|| WorkspaceManagerError::Conflict("No project remains".to_string()))?;
        let workspace_id_set = workspace_id.to_string();
        let project_id_set = next_default.project_id.clone();
        tokio::task::spawn_blocking(move || {
            workspaces::set_default_project(&workspace_id_set, &project_id_set)
        })
        .await
        .map_err(|e| WorkspaceManagerError::Internal(e.into()))?
        .map_err(WorkspaceManagerError::from)?;
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
    let workspace_id_owned = workspace_id.to_string();
    let conversations = tokio::task::spawn_blocking(move || {
        crate::user_data_db::chats::list(None, Some(&workspace_id_owned))
    })
    .await
    .map_err(|e| WorkspaceManagerError::Internal(e.into()))?
    .map_err(WorkspaceManagerError::from)?;
    let active_conversation_count = conversations
        .iter()
        .filter(|conversation| conversation.archived_at.is_none())
        .count();
    let worktree_count = conversations
        .iter()
        .filter(|chat| chat.worktree_path.as_deref().is_some_and(|p| !p.is_empty()))
        .count();
    let worktree_paths: Vec<&str> = conversations
        .iter()
        .filter_map(|chat| chat.worktree_path.as_deref())
        .filter(|path| !path.is_empty())
        .collect();
    let dirty_worktree_count = count_dirty_worktrees(&worktree_paths).await;
    let work_dir_exists = std::path::Path::new(&workspace.work_dir).is_dir();
    Ok(WorkspaceStatus {
        workspace_id: workspace.id,
        status: workspace.status,
        work_dir: workspace.work_dir,
        work_dir_exists,
        project_count: workspace.projects.len(),
        active_agent_count,
        conversation_count: conversations.len(),
        active_conversation_count,
        worktree_count,
        dirty_worktree_count,
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

    // Data safety checks: prevent deletion when active conversations or dirty worktrees exist
    // (unless force=true). These guards protect in-progress user work from accidental destruction.
    if !force {
        // Check for active (non-archived) conversations
        let workspace_id_str = workspace_id.to_string();
        let conversations_result = tokio::task::spawn_blocking(move || {
            crate::user_data_db::conversations::list_roots(None, Some(&workspace_id_str))
        })
        .await;

        match conversations_result {
            Ok(Ok(conversations)) => {
                let active_conversations: Vec<_> = conversations
                    .iter()
                    .filter(|c| c.archived_at.is_none())
                    .collect();
                if !active_conversations.is_empty() {
                    return Err(WorkspaceManagerError::Conflict(format!(
                        "Workspace has {} active conversation(s) (in-progress work); archive them or use force",
                        active_conversations.len()
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

        // Check for dirty worktrees (uncommitted changes)
        // Query worktree paths from conversation_execution_contexts for this workspace's conversations
        let workspace_id_str = workspace_id.to_string();
        let worktree_result = tokio::task::spawn_blocking(move || {
            let db = crate::user_data_db::get_user_data_db();
            let conn = db.lock().unwrap();
            let mut stmt = conn.prepare(
                "SELECT DISTINCT e.worktree_path
                 FROM conversation_execution_contexts e
                 JOIN conversations c ON c.id = e.conversation_id
                 WHERE c.workspace_id = ?1 AND e.worktree_path IS NOT NULL",
            )?;
            let paths: Vec<String> = stmt
                .query_map(params![workspace_id_str], |row| row.get(0))?
                .collect::<Result<Vec<_>, _>>()?;
            Ok::<_, rusqlite::Error>(paths)
        })
        .await;

        match worktree_result {
            Ok(Ok(worktree_paths)) => {
                let worktree_refs: Vec<&str> = worktree_paths.iter().map(|s| s.as_str()).collect();
                let dirty_worktree_count = count_dirty_worktrees(&worktree_refs).await;
                if dirty_worktree_count > 0 {
                    return Err(WorkspaceManagerError::Conflict(format!(
                        "Workspace has {} dirty worktree(s) with uncommitted changes; commit or discard them or use force",
                        dirty_worktree_count
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

    let workspace_id_delete = workspace_id.to_string();
    tokio::task::spawn_blocking(move || workspaces::delete(&workspace_id_delete))
        .await
        .map_err(|e| WorkspaceManagerError::Internal(e.into()))?
        .map_err(WorkspaceManagerError::from)?;
    Ok(())
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
