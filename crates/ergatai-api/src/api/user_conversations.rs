//! Conversation-first user data REST API.

use std::collections::HashMap;

use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

use crate::user_data_db::{self, Conversation};
use crate::AppState;

#[derive(Debug, Deserialize, ToSchema)]
pub struct CreateConversationRequest {
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub mode: Option<String>,
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct UpdateConversationRequest {
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub mode: Option<String>,
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct AppendConversationMessageRequest {
    pub role: String,
    #[serde(default)]
    #[schema(value_type = Vec<Object>, nullable = true)]
    pub parts: Option<serde_json::Value>,
    #[serde(default)]
    pub text: Option<String>,
    #[serde(default)]
    #[schema(value_type = Object, nullable = true)]
    pub metadata: Option<serde_json::Value>,
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct ReplaceConversationMessagesRequest {
    #[schema(value_type = Vec<Object>)]
    pub messages: Vec<serde_json::Value>,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct ErrorResponse {
    pub error: String,
}

#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ConversationFileChange {
    pub file_path: String,
    pub display_path: String,
    pub additions: u64,
    pub deletions: u64,
}

fn now_unix_seconds() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}

fn conversation_id() -> String {
    format!("conversation_{}", uuid::Uuid::new_v4())
}

fn db_error(operation: &'static str, error: rusqlite::Error) -> Response {
    let response = (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(ErrorResponse {
            error: crate::sanitize_error(&error, operation),
        }),
    );
    response.into_response()
}

#[derive(Debug)]
struct ConversationFileState {
    original_content: Option<String>,
    current_content: Option<String>,
    display_path: String,
}

fn json_object_string<'a>(
    input: &'a serde_json::Map<String, serde_json::Value>,
    key: &str,
) -> Option<&'a str> {
    input.get(key).and_then(serde_json::Value::as_str)
}

fn resolve_tool_file_path(input: &serde_json::Map<String, serde_json::Value>) -> Option<String> {
    input
        .get("_locations")
        .and_then(serde_json::Value::as_array)
        .and_then(|locations| locations.first())
        .and_then(|location| location.get("path"))
        .and_then(serde_json::Value::as_str)
        .map(str::to_owned)
        .or_else(|| json_object_string(input, "file_path").map(str::to_owned))
        .or_else(|| json_object_string(input, "path").map(str::to_owned))
        .or_else(|| json_object_string(input, "file").map(str::to_owned))
        .filter(|path| !path.is_empty())
}

fn is_session_file(path: &str) -> bool {
    path.contains("claude-sessions") || path.contains("Application Support")
}

fn strip_path_prefix<'a>(path: &'a str, prefix: &str) -> Option<&'a str> {
    let prefix = prefix.trim_end_matches('/');
    let suffix = path.strip_prefix(prefix)?;
    Some(suffix.strip_prefix('/').unwrap_or(suffix))
}

fn display_file_path(
    path: &str,
    worktree_path: Option<&str>,
    project_path: Option<&str>,
) -> String {
    for base_path in [worktree_path, project_path].into_iter().flatten() {
        if let Some(relative_path) = strip_path_prefix(path, base_path) {
            return relative_path.to_owned();
        }
    }

    for prefix in ["/workspace", "/project/sandbox", "/project"] {
        if let Some(relative_path) = strip_path_prefix(path, prefix) {
            return relative_path.to_owned();
        }
    }

    for marker in [".ergatai/worktrees/", ".21st/worktrees/"] {
        if let Some(marker_index) = path.find(marker) {
            let after_worktrees = &path[marker_index + marker.len()..];
            let mut segments = after_worktrees.splitn(3, '/');
            let _project_segment = segments.next();
            let _conversation_segment = segments.next();
            if let Some(relative_path) = segments.next() {
                return relative_path.to_owned();
            }
        }
    }

    path.to_owned()
}

fn line_count(content: Option<&str>) -> u64 {
    content
        .map(|content| {
            if content.is_empty() {
                0
            } else {
                content.split('\n').count() as u64
            }
        })
        .unwrap_or(0)
}

fn calculate_conversation_file_changes(
    messages: &[user_data_db::Message],
    worktree_path: Option<&str>,
    project_path: Option<&str>,
) -> Vec<ConversationFileChange> {
    let mut file_states: HashMap<String, ConversationFileState> = HashMap::new();

    for message in messages {
        if message.role != "assistant" {
            continue;
        }

        let Ok(parts) = serde_json::from_str::<serde_json::Value>(&message.parts) else {
            continue;
        };
        let Some(parts) = parts.as_array() else {
            continue;
        };

        for part in parts {
            let Some(part_type) = part.get("type").and_then(serde_json::Value::as_str) else {
                continue;
            };
            let is_write = part_type == "tool-Write";
            if !is_write && part_type != "tool-Edit" {
                continue;
            }

            let Some(input) = part.get("input").and_then(serde_json::Value::as_object) else {
                continue;
            };
            let Some(file_path) = resolve_tool_file_path(input) else {
                continue;
            };
            if is_session_file(&file_path) {
                continue;
            }

            let new_string = if is_write {
                json_object_string(input, "content")
            } else {
                json_object_string(input, "new_string")
            };
            let old_string = if is_write {
                None
            } else {
                json_object_string(input, "old_string")
            };
            let Some(new_string) = new_string else {
                continue;
            };
            if !is_write && old_string.is_none() {
                continue;
            }

            let file_state =
                file_states
                    .entry(file_path.clone())
                    .or_insert_with(|| ConversationFileState {
                        original_content: None,
                        current_content: None,
                        display_path: display_file_path(&file_path, worktree_path, project_path),
                    });

            if is_write {
                file_state.original_content = None;
            } else if file_state.current_content.is_none() {
                file_state.original_content = old_string.map(str::to_owned);
            }
            file_state.current_content = Some(new_string.to_owned());
        }
    }

    file_states
        .into_iter()
        .filter_map(|(file_path, state)| {
            let current_content = state.current_content?;
            let original_content = state.original_content.clone().unwrap_or_default();
            if current_content == original_content {
                return None;
            }

            Some(ConversationFileChange {
                file_path,
                display_path: state.display_path,
                additions: line_count(Some(&current_content)),
                deletions: line_count(state.original_content.as_deref()),
            })
        })
        .collect()
}

#[utoipa::path(
    get,
    path = "/api/v1/workspaces/{workspace_id}/conversations",
    tag = "Conversations",
    params(("workspace_id" = String, Path, description = "Persistent workspace ID")),
    responses(
        (status = 200, description = "Root conversations", body = Vec<crate::user_data_db::Conversation>),
        (status = 404, description = "Workspace not found"),
        (status = 500, description = "Internal server error"),
    )
)]
pub async fn list_workspace_conversations(
    State(_state): State<AppState>,
    Path(workspace_id): Path<String>,
) -> impl IntoResponse {
    // Validate workspace_id is non-empty
    if workspace_id.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(ErrorResponse {
                error: "Workspace ID cannot be empty".to_string(),
            }),
        )
            .into_response();
    }

    // Validate workspace exists
    let workspace_id_for_check = workspace_id.clone();
    match tokio::task::spawn_blocking(move || {
        user_data_db::workspaces::get(&workspace_id_for_check)
    })
    .await
    {
        Ok(Ok(Some(_workspace))) => {}
        Ok(Ok(None)) => return StatusCode::NOT_FOUND.into_response(),
        Ok(Err(error)) => return db_error("Failed to load workspace", error),
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ErrorResponse {
                    error: format!("Task join error: {}", e),
                }),
            )
                .into_response()
        }
    }

    let workspace_id_for_list = workspace_id.clone();
    match tokio::task::spawn_blocking(move || {
        user_data_db::conversations::list_roots(None, Some(&workspace_id_for_list))
    })
    .await
    {
        Ok(Ok(conversations)) => (StatusCode::OK, Json(conversations)).into_response(),
        Ok(Err(error)) => db_error("Failed to list conversations", error),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse {
                error: format!("Task join error: {}", e),
            }),
        )
            .into_response(),
    }
}

#[utoipa::path(
    post,
    path = "/api/v1/workspaces/{workspace_id}/conversations",
    tag = "Conversations",
    params(("workspace_id" = String, Path, description = "Persistent workspace ID")),
    request_body = CreateConversationRequest,
    responses(
        (status = 201, description = "Conversation created", body = crate::user_data_db::Conversation),
        (status = 404, description = "Workspace not found"),
        (status = 500, description = "Internal server error"),
    )
)]
pub async fn create_workspace_conversation(
    State(_state): State<AppState>,
    Path(workspace_id): Path<String>,
    Json(request): Json<CreateConversationRequest>,
) -> impl IntoResponse {
    // Validate workspace_id is non-empty
    if workspace_id.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(ErrorResponse {
                error: "Workspace ID cannot be empty".to_string(),
            }),
        )
            .into_response();
    }

    let workspace_id_for_get = workspace_id.clone();
    let workspace = match tokio::task::spawn_blocking(move || {
        user_data_db::workspaces::get(&workspace_id_for_get)
    })
    .await
    {
        Ok(Ok(Some(workspace))) => workspace,
        Ok(Ok(None)) => return StatusCode::NOT_FOUND.into_response(),
        Ok(Err(error)) => return db_error("Failed to load workspace", error),
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ErrorResponse {
                    error: format!("Task join error: {}", e),
                }),
            )
                .into_response()
        }
    };

    let now = now_unix_seconds();
    let conversation = Conversation {
        id: conversation_id(),
        parent_id: None,
        project_id: workspace.project_id,
        workspace_id: Some(workspace_id),
        name: request.name,
        mode: request.mode.unwrap_or_else(|| "agent".to_string()),
        created_at: now,
        updated_at: now,
        archived_at: None,
    };

    match tokio::task::spawn_blocking(move || user_data_db::conversations::create(conversation))
        .await
    {
        Ok(Ok(conversation)) => (StatusCode::CREATED, Json(conversation)).into_response(),
        Ok(Err(error)) => db_error("Failed to create conversation", error),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse {
                error: format!("Task join error: {}", e),
            }),
        )
            .into_response(),
    }
}

#[utoipa::path(
    get,
    path = "/api/v1/conversations/{id}",
    tag = "Conversations",
    params(("id" = String, Path, description = "Conversation ID")),
    responses(
        (status = 200, description = "Conversation", body = crate::user_data_db::Conversation),
        (status = 404, description = "Conversation not found"),
        (status = 500, description = "Internal server error"),
    )
)]
pub async fn get_conversation(
    State(_state): State<AppState>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    if id.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(ErrorResponse {
                error: "Conversation ID cannot be empty".to_string(),
            }),
        )
            .into_response();
    }

    let id_for_get = id.clone();
    match tokio::task::spawn_blocking(move || user_data_db::conversations::get(&id_for_get)).await {
        Ok(Ok(Some(conversation))) => (StatusCode::OK, Json(conversation)).into_response(),
        Ok(Ok(None)) => StatusCode::NOT_FOUND.into_response(),
        Ok(Err(error)) => db_error("Failed to load conversation", error),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse {
                error: format!("Task join error: {}", e),
            }),
        )
            .into_response(),
    }
}

#[utoipa::path(
    patch,
    path = "/api/v1/conversations/{id}",
    tag = "Conversations",
    params(("id" = String, Path, description = "Conversation ID")),
    request_body = UpdateConversationRequest,
    responses(
        (status = 200, description = "Updated conversation", body = crate::user_data_db::Conversation),
        (status = 404, description = "Conversation not found"),
        (status = 500, description = "Internal server error"),
    )
)]
pub async fn update_conversation(
    State(_state): State<AppState>,
    Path(id): Path<String>,
    Json(request): Json<UpdateConversationRequest>,
) -> impl IntoResponse {
    if id.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(ErrorResponse {
                error: "Conversation ID cannot be empty".to_string(),
            }),
        )
            .into_response();
    }

    let id_for_get = id.clone();
    let existing =
        match tokio::task::spawn_blocking(move || user_data_db::conversations::get(&id_for_get))
            .await
        {
            Ok(Ok(Some(existing))) => existing,
            Ok(Ok(None)) => return StatusCode::NOT_FOUND.into_response(),
            Ok(Err(error)) => return db_error("Failed to load conversation", error),
            Err(e) => {
                return (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(ErrorResponse {
                        error: format!("Task join error: {}", e),
                    }),
                )
                    .into_response()
            }
        };

    let conversation = Conversation {
        name: request.name.or(existing.name),
        mode: request.mode.unwrap_or_else(|| existing.mode.clone()),
        ..existing
    };

    match tokio::task::spawn_blocking(move || user_data_db::conversations::update(conversation))
        .await
    {
        Ok(Ok(())) => {}
        Ok(Err(error)) => return db_error("Failed to update conversation", error),
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ErrorResponse {
                    error: format!("Task join error: {}", e),
                }),
            )
                .into_response()
        }
    }

    let id_for_reload = id.clone();
    match tokio::task::spawn_blocking(move || user_data_db::conversations::get(&id_for_reload))
        .await
    {
        Ok(Ok(Some(conversation))) => (StatusCode::OK, Json(conversation)).into_response(),
        Ok(Ok(None)) => StatusCode::NOT_FOUND.into_response(),
        Ok(Err(error)) => db_error("Failed to reload conversation", error),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse {
                error: format!("Task join error: {}", e),
            }),
        )
            .into_response(),
    }
}

#[utoipa::path(
    post,
    path = "/api/v1/conversations/{id}/archive",
    tag = "Conversations",
    params(("id" = String, Path, description = "Conversation ID")),
    responses(
        (status = 200, description = "Conversation archived", body = crate::user_data_db::Conversation),
        (status = 404, description = "Conversation not found"),
        (status = 500, description = "Internal server error"),
    )
)]
pub async fn archive_conversation(
    State(_state): State<AppState>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    if id.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(ErrorResponse {
                error: "Conversation ID cannot be empty".to_string(),
            }),
        )
            .into_response();
    }

    let id_for_archive = id.clone();
    match tokio::task::spawn_blocking(move || {
        user_data_db::conversations::archive(&id_for_archive, now_unix_seconds())
    })
    .await
    {
        Ok(Ok(())) => {}
        Ok(Err(error)) => return db_error("Failed to archive conversation", error),
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ErrorResponse {
                    error: format!("Task join error: {}", e),
                }),
            )
                .into_response()
        }
    }

    let id_for_get = id.clone();
    match tokio::task::spawn_blocking(move || user_data_db::conversations::get(&id_for_get)).await {
        Ok(Ok(Some(conversation))) => (StatusCode::OK, Json(conversation)).into_response(),
        Ok(Ok(None)) => StatusCode::NOT_FOUND.into_response(),
        Ok(Err(error)) => db_error("Failed to load conversation", error),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse {
                error: format!("Task join error: {}", e),
            }),
        )
            .into_response(),
    }
}

#[utoipa::path(
    post,
    path = "/api/v1/conversations/{id}/unarchive",
    tag = "Conversations",
    params(("id" = String, Path, description = "Conversation ID")),
    responses(
        (status = 200, description = "Conversation unarchived", body = crate::user_data_db::Conversation),
        (status = 404, description = "Conversation not found"),
        (status = 500, description = "Internal server error"),
    )
)]
pub async fn unarchive_conversation(
    State(_state): State<AppState>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    if id.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(ErrorResponse {
                error: "Conversation ID cannot be empty".to_string(),
            }),
        )
            .into_response();
    }

    let id_for_unarchive = id.clone();
    match tokio::task::spawn_blocking(move || {
        user_data_db::conversations::unarchive(&id_for_unarchive, now_unix_seconds())
    })
    .await
    {
        Ok(Ok(())) => {}
        Ok(Err(error)) => return db_error("Failed to unarchive conversation", error),
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ErrorResponse {
                    error: format!("Task join error: {}", e),
                }),
            )
                .into_response()
        }
    }

    let id_for_get = id.clone();
    match tokio::task::spawn_blocking(move || user_data_db::conversations::get(&id_for_get)).await {
        Ok(Ok(Some(conversation))) => (StatusCode::OK, Json(conversation)).into_response(),
        Ok(Ok(None)) => StatusCode::NOT_FOUND.into_response(),
        Ok(Err(error)) => db_error("Failed to load conversation", error),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse {
                error: format!("Task join error: {}", e),
            }),
        )
            .into_response(),
    }
}

#[utoipa::path(
    delete,
    path = "/api/v1/conversations/{id}",
    tag = "Conversations",
    params(("id" = String, Path, description = "Conversation ID")),
    responses(
        (status = 204, description = "Conversation deleted"),
        (status = 500, description = "Internal server error"),
    )
)]
pub async fn delete_conversation(
    State(_state): State<AppState>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    if id.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(ErrorResponse {
                error: "Conversation ID cannot be empty".to_string(),
            }),
        )
            .into_response();
    }

    let id_for_delete = id.clone();
    match tokio::task::spawn_blocking(move || user_data_db::conversations::delete(&id_for_delete))
        .await
    {
        Ok(Ok(())) => StatusCode::NO_CONTENT.into_response(),
        Ok(Err(error)) => db_error("Failed to delete conversation", error),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse {
                error: format!("Task join error: {}", e),
            }),
        )
            .into_response(),
    }
}

#[utoipa::path(
    get,
    path = "/api/v1/conversations/{id}/children",
    tag = "Conversations",
    params(("id" = String, Path, description = "Parent conversation ID")),
    responses(
        (status = 200, description = "Child conversations", body = Vec<crate::user_data_db::Conversation>),
        (status = 500, description = "Internal server error"),
    )
)]
pub async fn list_child_conversations(
    State(_state): State<AppState>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    if id.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(ErrorResponse {
                error: "Conversation ID cannot be empty".to_string(),
            }),
        )
            .into_response();
    }

    let id_for_children = id.clone();
    match tokio::task::spawn_blocking(move || {
        user_data_db::conversations::list_children(&id_for_children)
    })
    .await
    {
        Ok(Ok(conversations)) => (StatusCode::OK, Json(conversations)).into_response(),
        Ok(Err(error)) => db_error("Failed to list child conversations", error),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse {
                error: format!("Task join error: {}", e),
            }),
        )
            .into_response(),
    }
}

#[utoipa::path(
    post,
    path = "/api/v1/conversations/{id}/children",
    tag = "Conversations",
    params(("id" = String, Path, description = "Parent conversation ID")),
    request_body = CreateConversationRequest,
    responses(
        (status = 201, description = "Child conversation created", body = crate::user_data_db::Conversation),
        (status = 404, description = "Parent conversation not found"),
        (status = 500, description = "Internal server error"),
    )
)]
pub async fn create_child_conversation(
    State(_state): State<AppState>,
    Path(id): Path<String>,
    Json(request): Json<CreateConversationRequest>,
) -> impl IntoResponse {
    // Validate parent ID is non-empty
    if id.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(ErrorResponse {
                error: "Parent conversation ID cannot be empty".to_string(),
            }),
        )
            .into_response();
    }

    let id_for_get = id.clone();
    let parent =
        match tokio::task::spawn_blocking(move || user_data_db::conversations::get(&id_for_get))
            .await
        {
            Ok(Ok(Some(parent))) => parent,
            Ok(Ok(None)) => return StatusCode::NOT_FOUND.into_response(),
            Ok(Err(error)) => return db_error("Failed to load parent conversation", error),
            Err(e) => {
                return (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(ErrorResponse {
                        error: format!("Task join error: {}", e),
                    }),
                )
                    .into_response()
            }
        };

    let now = now_unix_seconds();
    let conversation = Conversation {
        id: conversation_id(),
        parent_id: Some(parent.id),
        project_id: parent.project_id,
        workspace_id: parent.workspace_id,
        name: request.name,
        mode: request.mode.unwrap_or_else(|| "agent".to_string()),
        created_at: now,
        updated_at: now,
        archived_at: None,
    };

    match tokio::task::spawn_blocking(move || user_data_db::conversations::create(conversation))
        .await
    {
        Ok(Ok(conversation)) => (StatusCode::CREATED, Json(conversation)).into_response(),
        Ok(Err(error)) => db_error("Failed to create conversation", error),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse {
                error: format!("Task join error: {}", e),
            }),
        )
            .into_response(),
    }
}

#[utoipa::path(
    get,
    path = "/api/v1/conversations/{id}/messages",
    tag = "Conversations",
    params(("id" = String, Path, description = "Conversation ID")),
    responses(
        (status = 200, description = "Ordered messages", body = Vec<crate::user_data_db::Message>),
        (status = 500, description = "Internal server error"),
    )
)]
pub async fn list_conversation_messages(
    State(_state): State<AppState>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    if id.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(ErrorResponse {
                error: "Conversation ID cannot be empty".to_string(),
            }),
        )
            .into_response();
    }

    let id_for_list = id.clone();
    match tokio::task::spawn_blocking(move || user_data_db::messages::list(&id_for_list)).await {
        Ok(Ok(messages)) => (StatusCode::OK, Json(messages)).into_response(),
        Ok(Err(error)) => db_error("Failed to list messages", error),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse {
                error: format!("Task join error: {}", e),
            }),
        )
            .into_response(),
    }
}

#[utoipa::path(
    get,
    path = "/api/v1/conversations/{id}/file-changes",
    tag = "Conversations",
    params(("id" = String, Path, description = "Conversation ID")),
    responses(
        (status = 200, description = "Derived conversation file changes", body = Vec<ConversationFileChange>),
        (status = 404, description = "Conversation not found"),
        (status = 500, description = "Internal server error"),
    )
)]
pub async fn list_conversation_file_changes(
    State(_state): State<AppState>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    if id.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(ErrorResponse {
                error: "Conversation ID cannot be empty".to_string(),
            }),
        )
            .into_response();
    }

    let id_for_changes = id.clone();
    match tokio::task::spawn_blocking(move || {
        let Some(conversation) = user_data_db::conversations::get(&id_for_changes)? else {
            return Ok(None);
        };

        let context = user_data_db::conversation_execution_contexts::get(&id_for_changes)?;
        let project_path =
            user_data_db::projects::get(&conversation.project_id)?.map(|project| project.path);
        let messages = user_data_db::messages::list(&id_for_changes)?;
        let worktree_path = context.and_then(|context| context.worktree_path);

        Ok(Some(calculate_conversation_file_changes(
            &messages,
            worktree_path.as_deref(),
            project_path.as_deref(),
        )))
    })
    .await
    {
        Ok(Ok(Some(file_changes))) => (StatusCode::OK, Json(file_changes)).into_response(),
        Ok(Ok(None)) => StatusCode::NOT_FOUND.into_response(),
        Ok(Err(error)) => db_error("Failed to derive file changes", error),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse {
                error: format!("Task join error: {}", e),
            }),
        )
            .into_response(),
    }
}

#[cfg(test)]
mod conversation_file_change_tests {
    use super::*;
    use crate::user_data_db::Message;

    fn message(role: &str, parts: serde_json::Value) -> Message {
        Message {
            id: format!("msg_{}", role),
            conversation_id: "conversation_test".to_owned(),
            sequence: 0,
            role: role.to_owned(),
            parts: parts.to_string(),
            metadata: None,
            created_at: 0,
            updated_at: 0,
        }
    }

    fn edit_part(path: &str, old_string: &str, new_string: &str) -> serde_json::Value {
        serde_json::json!({
            "type": "tool-Edit",
            "input": {
                "_locations": [{ "path": path }],
                "old_string": old_string,
                "new_string": new_string,
            },
        })
    }

    #[test]
    fn write_creates_additions_only() {
        let messages = [message(
            "assistant",
            serde_json::json!([{
                "type": "tool-Write",
                "input": {
                    "_locations": [{ "path": "/worktrees/chat/src/main.rs" }],
                    "content": "fn main() {}\nfn helper() {}",
                },
            }]),
        )];

        let changes = calculate_conversation_file_changes(&messages, Some("/worktrees/chat"), None);
        assert_eq!(changes.len(), 1);
        assert_eq!(changes[0].file_path, "/worktrees/chat/src/main.rs");
        assert_eq!(changes[0].display_path, "src/main.rs");
        assert_eq!(changes[0].additions, 2);
        assert_eq!(changes[0].deletions, 0);
    }

    #[test]
    fn edit_counts_changed_lines() {
        let messages = [message(
            "assistant",
            serde_json::json!([edit_part(
                "/project/src/lib.rs",
                "let old = 1;\nlet stale = 2;",
                "let new = 3;\nlet extra = 4;",
            )]),
        )];

        let changes = calculate_conversation_file_changes(&messages, None, Some("/project"));
        assert_eq!(changes[0].file_path, "/project/src/lib.rs");
        assert_eq!(changes[0].display_path, "src/lib.rs");
        assert_eq!(changes[0].additions, 2);
        assert_eq!(changes[0].deletions, 2);
    }

    #[test]
    fn duplicate_paths_use_latest_state() {
        let messages = [
            message(
                "assistant",
                serde_json::json!([edit_part(
                    "/project/src/lib.rs",
                    "let original = 1;",
                    "let intermediate = 2;",
                )]),
            ),
            message(
                "assistant",
                serde_json::json!([edit_part(
                    "/project/src/lib.rs",
                    "let intermediate = 2;",
                    "let latest = 3;",
                )]),
            ),
        ];

        let changes = calculate_conversation_file_changes(&messages, None, Some("/project"));
        assert_eq!(changes.len(), 1);
        assert_eq!(changes[0].additions, 1);
        assert_eq!(changes[0].deletions, 1);
    }

    #[test]
    fn session_files_and_invalid_parts_are_excluded() {
        let messages = [message(
            "assistant",
            serde_json::json!([
                {
                    "type": "tool-Write",
                    "input": {
                        "_locations": [{ "path": "/tmp/claude-sessions/plan.md" }],
                        "content": "plan",
                    },
                },
                {
                    "type": "tool-Edit",
                    "input": { "old_string": "old" },
                },
            ]),
        )];

        assert!(calculate_conversation_file_changes(&messages, None, None).is_empty());
    }

    #[test]
    fn common_path_fallback_is_used() {
        let messages = [message(
            "assistant",
            serde_json::json!([{
                "type": "tool-Edit",
                "input": {
                    "file_path": "/workspace/src/app.tsx",
                    "old_string": "const old = 1;",
                    "new_string": "const new = 2;\nconst added = 3;",
                },
            }]),
        )];

        let changes = calculate_conversation_file_changes(&messages, None, None);
        assert_eq!(changes[0].file_path, "/workspace/src/app.tsx");
        assert_eq!(changes[0].display_path, "src/app.tsx");
        assert_eq!(changes[0].additions, 2);
        assert_eq!(changes[0].deletions, 1);
    }
}

#[utoipa::path(
    post,
    path = "/api/v1/conversations/{id}/messages",
    tag = "Conversations",
    params(("id" = String, Path, description = "Conversation ID")),
    request_body = AppendConversationMessageRequest,
    responses(
        (status = 201, description = "Message appended", body = crate::user_data_db::Message),
        (status = 400, description = "Invalid message"),
        (status = 500, description = "Internal server error"),
    )
)]
pub async fn append_conversation_message(
    State(_state): State<AppState>,
    Path(id): Path<String>,
    Json(request): Json<AppendConversationMessageRequest>,
) -> impl IntoResponse {
    if id.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(ErrorResponse {
                error: "Conversation ID cannot be empty".to_string(),
            }),
        )
            .into_response();
    }

    // Validate role against allowed values
    if !matches!(request.role.as_str(), "user" | "assistant" | "system") {
        return (
            StatusCode::BAD_REQUEST,
            Json(ErrorResponse {
                error: "Role must be one of: user, assistant, system".to_string(),
            }),
        )
            .into_response();
    }

    let (parts, metadata) = match (request.parts, request.text) {
        (Some(parts), _) => (parts, request.metadata.unwrap_or(serde_json::Value::Null)),
        (None, Some(text)) => (
            serde_json::json!([{ "type": "text", "text": text }]),
            request.metadata.unwrap_or(serde_json::Value::Null),
        ),
        (None, None) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(ErrorResponse {
                    error: "Message must contain either text or parts".to_string(),
                }),
            )
                .into_response();
        }
    };

    let id_for_append = id.clone();
    let role = request.role.clone();
    match tokio::task::spawn_blocking(move || {
        user_data_db::messages::append(&id_for_append, &role, parts, metadata)
    })
    .await
    {
        Ok(Ok(message)) => (StatusCode::CREATED, Json(message)).into_response(),
        Ok(Err(error)) => db_error("Failed to append message", error),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse {
                error: format!("Task join error: {}", e),
            }),
        )
            .into_response(),
    }
}

#[utoipa::path(
    put,
    path = "/api/v1/conversations/{id}/messages",
    tag = "Conversations",
    params(("id" = String, Path, description = "Conversation ID")),
    request_body = ReplaceConversationMessagesRequest,
    responses(
        (status = 200, description = "Messages replaced", body = Vec<crate::user_data_db::Message>),
        (status = 400, description = "Invalid messages"),
        (status = 404, description = "Conversation not found"),
        (status = 500, description = "Internal server error"),
    )
)]
pub async fn replace_conversation_messages(
    State(_state): State<AppState>,
    Path(id): Path<String>,
    Json(request): Json<ReplaceConversationMessagesRequest>,
) -> impl IntoResponse {
    if id.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(ErrorResponse {
                error: "Conversation ID cannot be empty".to_string(),
            }),
        )
            .into_response();
    }

    let id_for_get = id.clone();
    match tokio::task::spawn_blocking(move || crate::user_data_db::conversations::get(&id_for_get))
        .await
    {
        Ok(Ok(Some(_conversation))) => {}
        Ok(Ok(None)) => return StatusCode::NOT_FOUND.into_response(),
        Ok(Err(error)) => return db_error("Failed to load conversation", error),
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ErrorResponse {
                    error: format!("Task join error: {}", e),
                }),
            )
                .into_response()
        }
    }

    let messages = match serde_json::to_string(&request.messages) {
        Ok(messages) => messages,
        Err(_) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(ErrorResponse {
                    error: "Messages must be serializable".to_string(),
                }),
            )
                .into_response()
        }
    };

    let now = now_unix_seconds();
    let id_for_replace = id.clone();
    let messages_for_replace = messages.clone();
    match tokio::task::spawn_blocking(move || {
        crate::user_data_db::messages::replace_legacy(&id_for_replace, &messages_for_replace, now)
    })
    .await
    {
        Ok(Ok(())) => {}
        Ok(Err(error)) => return db_error("Failed to replace messages", error),
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ErrorResponse {
                    error: format!("Task join error: {}", e),
                }),
            )
                .into_response()
        }
    }

    let id_for_list = id.clone();
    match tokio::task::spawn_blocking(move || crate::user_data_db::messages::list(&id_for_list))
        .await
    {
        Ok(Ok(messages)) => (StatusCode::OK, Json(messages)).into_response(),
        Ok(Err(error)) => db_error("Failed to list messages", error),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse {
                error: format!("Task join error: {}", e),
            }),
        )
            .into_response(),
    }
}
