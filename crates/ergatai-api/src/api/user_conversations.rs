//! Conversation-first user data REST API.

use std::collections::HashMap;

use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use ergatai_core::id::{format as format_id, generate, parse_to_i64, IdType};
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

use crate::user_data_db::{self, Conversation};
use crate::AppState;

#[derive(Debug, Deserialize, ToSchema)]
pub struct UpdateConversationRequest {
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub mode: Option<String>,
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

// Response DTO with formatted IDs
#[derive(Debug, Serialize, ToSchema)]
pub struct ConversationResponse {
    pub id: String,
    pub collaboration_session_id: String,
    pub chat_id: String,
    pub parent_id: Option<String>,
    pub name: Option<String>,
    pub mode: String,
    pub participant_role: String,
    pub status: String,
    pub created_at: i64,
    pub updated_at: i64,
}

impl From<Conversation> for ConversationResponse {
    fn from(c: Conversation) -> Self {
        Self {
            id: format_id(c.conversation_id, IdType::Conversation),
            collaboration_session_id: format_id(c.collaboration_session_id, IdType::Session),
            chat_id: format_id(c.chat_id, IdType::Chat),
            parent_id: c.parent_id.map(|id| format_id(id, IdType::Conversation)),
            name: c.name,
            mode: c.mode,
            participant_role: c.participant_role,
            status: c.status,
            created_at: c.created_at,
            updated_at: c.updated_at,
        }
    }
}

fn now_unix_seconds() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}

fn conversation_id() -> i64 {
    generate()
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

fn resolve_tool_file_path(
    input: &serde_json::Map<String, serde_json::Value>,
    workspace_boundary: Option<&str>,
) -> Option<String> {
    let path = input
        .get("_locations")
        .and_then(serde_json::Value::as_array)
        .and_then(|locations| locations.first())
        .and_then(|location| location.get("path"))
        .and_then(serde_json::Value::as_str)
        .map(str::to_owned)
        .or_else(|| json_object_string(input, "file_path").map(str::to_owned))
        .or_else(|| json_object_string(input, "path").map(str::to_owned))
        .or_else(|| json_object_string(input, "file").map(str::to_owned))
        .filter(|path| !path.is_empty())?;

    // Workspace boundary check: reject paths outside the workspace to prevent
    // path traversal attacks via tool call inputs. If a workspace boundary is
    // provided, the file path must be within it (after canonicalization).
    if let Some(boundary) = workspace_boundary {
        let boundary = std::path::Path::new(boundary);
        let file_path = std::path::Path::new(&path);

        // Check if the path is absolute and within the boundary
        if file_path.is_absolute() {
            // Use Path::starts_with() for component-wise comparison,
            // which prevents prefix attacks like /workspace-evil matching /workspace
            if !file_path.starts_with(boundary) {
                tracing::warn!(
                    path = %path,
                    boundary = %boundary.display(),
                    "File path outside workspace boundary, rejected"
                );
                return None;
            }
        }
        // Relative paths are allowed (they'll be resolved relative to work_dir)
    }

    Some(path)
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
                content.lines().count() as u64
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
            // Use worktree_path as workspace boundary to prevent path traversal
            let Some(file_path) = resolve_tool_file_path(input, worktree_path) else {
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

    let id_i64 = match parse_to_i64(&id) {
        Some(id) => id,
        None => {
            return (
                StatusCode::BAD_REQUEST,
                Json(ErrorResponse {
                    error: format!("Invalid ID format: {}", id),
                }),
            )
                .into_response();
        }
    };

    match tokio::task::spawn_blocking(move || user_data_db::conversations::get(id_i64)).await {
        Ok(Ok(Some(conversation))) => {
            let response = ConversationResponse::from(conversation);
            (StatusCode::OK, Json(response)).into_response()
        }
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

    let id_i64 = match parse_to_i64(&id) {
        Some(id) => id,
        None => {
            return (
                StatusCode::BAD_REQUEST,
                Json(ErrorResponse {
                    error: format!("Invalid ID format: {}", id),
                }),
            )
                .into_response();
        }
    };

    let existing =
        match tokio::task::spawn_blocking(move || user_data_db::conversations::get(id_i64)).await {
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
    let id_for_reload_i64 = match parse_to_i64(&id_for_reload) {
        Some(id) => id,
        None => {
            return (
                StatusCode::BAD_REQUEST,
                Json(ErrorResponse {
                    error: format!("Invalid ID format: {}", id_for_reload),
                }),
            )
                .into_response();
        }
    };

    match tokio::task::spawn_blocking(move || user_data_db::conversations::get(id_for_reload_i64))
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

    let id_i64 = match parse_to_i64(&id) {
        Some(id) => id,
        None => {
            return (
                StatusCode::BAD_REQUEST,
                Json(ErrorResponse {
                    error: format!("Invalid ID format: {}", id),
                }),
            )
                .into_response();
        }
    };

    match tokio::task::spawn_blocking(move || {
        user_data_db::conversations::archive(id_i64, now_unix_seconds())
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
    let id_for_get_i64 = match parse_to_i64(&id_for_get) {
        Some(id) => id,
        None => {
            return (
                StatusCode::BAD_REQUEST,
                Json(ErrorResponse {
                    error: format!("Invalid ID format: {}", id_for_get),
                }),
            )
                .into_response();
        }
    };

    match tokio::task::spawn_blocking(move || user_data_db::conversations::get(id_for_get_i64))
        .await
    {
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

    let id_i64 = match parse_to_i64(&id) {
        Some(id) => id,
        None => {
            return (
                StatusCode::BAD_REQUEST,
                Json(ErrorResponse {
                    error: format!("Invalid ID format: {}", id),
                }),
            )
                .into_response();
        }
    };

    match tokio::task::spawn_blocking(move || {
        user_data_db::conversations::unarchive(id_i64, now_unix_seconds())
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
    let id_for_get_i64 = match parse_to_i64(&id_for_get) {
        Some(id) => id,
        None => {
            return (
                StatusCode::BAD_REQUEST,
                Json(ErrorResponse {
                    error: format!("Invalid ID format: {}", id_for_get),
                }),
            )
                .into_response();
        }
    };

    match tokio::task::spawn_blocking(move || user_data_db::conversations::get(id_for_get_i64))
        .await
    {
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

    let id_i64 = match parse_to_i64(&id) {
        Some(id) => id,
        None => {
            return (
                StatusCode::BAD_REQUEST,
                Json(ErrorResponse {
                    error: format!("Invalid ID format: {}", id),
                }),
            )
                .into_response();
        }
    };

    match tokio::task::spawn_blocking(move || user_data_db::conversations::delete(id_i64)).await {
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

    let id_i64 = match parse_to_i64(&id) {
        Some(id) => id,
        None => {
            return (
                StatusCode::BAD_REQUEST,
                Json(ErrorResponse {
                    error: format!("Invalid ID format: {}", id),
                }),
            )
                .into_response();
        }
    };

    match tokio::task::spawn_blocking(move || user_data_db::messages::list(id_i64)).await {
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

    let id_i64 = match parse_to_i64(&id) {
        Some(id) => id,
        None => {
            return (
                StatusCode::BAD_REQUEST,
                Json(ErrorResponse {
                    error: format!("Invalid ID format: {}", id),
                }),
            )
                .into_response();
        }
    };

    match tokio::task::spawn_blocking(move || {
        let Some(conversation) = user_data_db::conversations::get(id_i64)? else {
            return Ok(None);
        };

        let context = user_data_db::conversation_execution_contexts::get(id_i64)?;
        let project_path = user_data_db::chats::get(conversation.chat_id)?
            .and_then(|chat| {
                user_data_db::workspaces::get(chat.workspace_id)
                    .ok()
                    .flatten()
            })
            .map(|workspace| workspace.work_dir);
        let messages = user_data_db::messages::list(id_i64)?;
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
            message_id: 12345,
            conversation_id: 67890,
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

    #[test]
    fn test_json_object_string_found() {
        let value = serde_json::json!({"key": "value"});
        let map = value.as_object().unwrap();
        assert_eq!(json_object_string(map, "key"), Some("value"));
    }

    #[test]
    fn test_json_object_string_not_found() {
        let value = serde_json::json!({"key": "value"});
        let map = value.as_object().unwrap();
        assert_eq!(json_object_string(map, "missing"), None);
    }

    #[test]
    fn test_json_object_string_wrong_type() {
        let value = serde_json::json!({"key": 123});
        let map = value.as_object().unwrap();
        assert_eq!(json_object_string(map, "key"), None);
    }

    #[test]
    fn test_is_session_file_claude_sessions() {
        assert!(is_session_file("/path/to/claude-sessions/abc"));
    }

    #[test]
    fn test_is_session_file_application_support() {
        assert!(is_session_file("/path/Application Support/app"));
    }

    #[test]
    fn test_is_session_file_false() {
        assert!(!is_session_file("/path/to/regular/file.rs"));
    }

    #[test]
    fn test_strip_path_prefix_with_slash() {
        assert_eq!(
            strip_path_prefix("/project/src/main.rs", "/project"),
            Some("src/main.rs")
        );
    }

    #[test]
    fn test_strip_path_prefix_without_slash() {
        assert_eq!(
            strip_path_prefix("/project/src/main.rs", "/project/"),
            Some("src/main.rs")
        );
    }

    #[test]
    fn test_strip_path_prefix_no_match() {
        assert_eq!(strip_path_prefix("/other/path", "/project"), None);
    }

    #[test]
    fn test_display_file_path_with_worktree() {
        let result = display_file_path(
            "/worktree/project/src/main.rs",
            Some("/worktree/project"),
            None,
        );
        assert_eq!(result, "src/main.rs");
    }

    #[test]
    fn test_display_file_path_with_project() {
        let result = display_file_path("/project/src/main.rs", None, Some("/project"));
        assert_eq!(result, "src/main.rs");
    }

    #[test]
    fn test_display_file_path_workspace_fallback() {
        let result = display_file_path("/workspace/src/main.rs", None, None);
        assert_eq!(result, "src/main.rs");
    }

    #[test]
    fn test_display_file_path_project_sandbox_fallback() {
        let result = display_file_path("/project/sandbox/src/main.rs", None, None);
        assert_eq!(result, "src/main.rs");
    }

    #[test]
    fn test_display_file_path_no_match() {
        let result = display_file_path("/random/path/file.rs", None, None);
        assert_eq!(result, "/random/path/file.rs");
    }

    #[test]
    fn test_line_count_some_content() {
        assert_eq!(line_count(Some("line1\nline2\nline3")), 3);
    }

    #[test]
    fn test_line_count_empty_content() {
        assert_eq!(line_count(Some("")), 0);
    }

    #[test]
    fn test_line_count_none() {
        assert_eq!(line_count(None), 0);
    }

    #[test]
    fn test_line_count_single_line() {
        assert_eq!(line_count(Some("single line")), 1);
    }

    #[test]
    fn test_resolve_tool_file_path_from_locations() {
        let value = serde_json::json!({
            "_locations": [{"path": "/path/to/file.rs"}]
        });
        let input = value.as_object().unwrap();
        assert_eq!(
            resolve_tool_file_path(input, None),
            Some("/path/to/file.rs".to_string())
        );
    }

    #[test]
    fn test_resolve_tool_file_path_from_file_path() {
        let value = serde_json::json!({
            "file_path": "/path/to/file.rs"
        });
        let input = value.as_object().unwrap();
        assert_eq!(
            resolve_tool_file_path(input, None),
            Some("/path/to/file.rs".to_string())
        );
    }

    #[test]
    fn test_resolve_tool_file_path_from_path() {
        let value = serde_json::json!({
            "path": "/path/to/file.rs"
        });
        let input = value.as_object().unwrap();
        assert_eq!(
            resolve_tool_file_path(input, None),
            Some("/path/to/file.rs".to_string())
        );
    }

    #[test]
    fn test_resolve_tool_file_path_from_file() {
        let value = serde_json::json!({
            "file": "/path/to/file.rs"
        });
        let input = value.as_object().unwrap();
        assert_eq!(
            resolve_tool_file_path(input, None),
            Some("/path/to/file.rs".to_string())
        );
    }

    #[test]
    fn test_resolve_tool_file_path_empty() {
        let value = serde_json::json!({});
        let input = value.as_object().unwrap();
        assert_eq!(resolve_tool_file_path(input, None), None);
    }

    #[test]
    fn test_resolve_tool_file_path_empty_string_filtered() {
        let value = serde_json::json!({
            "file_path": ""
        });
        let input = value.as_object().unwrap();
        assert_eq!(resolve_tool_file_path(input, None), None);
    }
}

// ════════════════════════════════════════════════════════════════════════
// Conversation API（新版扁平化路由）
// ════════════════════════════════════════════════════════════════════════

#[derive(Debug, Deserialize, ToSchema)]
pub struct ListConversationsQuery {
    pub collaboration_session_id: Option<String>,
    pub chat_id: Option<String>,
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct CreateConversationRequestNew {
    pub collaboration_session_id: Option<String>,
    pub chat_id: Option<String>,
    pub name: Option<String>,
    pub mode: Option<String>,
    pub participant_role: Option<String>,
}

/// GET /api/v1/conversations
///
/// List conversations by collaboration_session_id or chat_id
#[utoipa::path(
    get,
    path = "/api/v1/conversations",
    tag = "Conversations",
    params(
        ("collaboration_session_id" = Option<String>, Query, description = "Filter by collaboration session ID"),
        ("chat_id" = Option<String>, Query, description = "Filter by chat ID"),
    ),
    responses(
        (status = 200, description = "Conversations list", body = Vec<Conversation>),
        (status = 400, description = "Missing required query parameter"),
        (status = 500, description = "Internal server error"),
    )
)]
pub async fn list_conversations(Query(query): Query<ListConversationsQuery>) -> impl IntoResponse {
    let conversations = if let Some(collaboration_session_id) = query.collaboration_session_id {
        let session_id_i64 = match parse_to_i64(&collaboration_session_id) {
            Some(id) => id,
            None => {
                return (
                    StatusCode::BAD_REQUEST,
                    Json(ErrorResponse {
                        error: format!(
                            "Invalid collaboration_session_id format: {}",
                            collaboration_session_id
                        ),
                    }),
                )
                    .into_response();
            }
        };

        match tokio::task::spawn_blocking(move || {
            crate::user_data_db::conversations::list_by_collaboration_session(session_id_i64)
        })
        .await
        {
            Ok(Ok(convs)) => convs,
            Ok(Err(e)) => {
                return (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(ErrorResponse {
                        error: crate::sanitize_error(&e, "list_conversations_by_session"),
                    }),
                )
                    .into_response()
            }
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
    } else if let Some(chat_id) = query.chat_id {
        let chat_id_i64 = match parse_to_i64(&chat_id) {
            Some(id) => id,
            None => {
                return (
                    StatusCode::BAD_REQUEST,
                    Json(ErrorResponse {
                        error: format!("Invalid chat_id format: {}", chat_id),
                    }),
                )
                    .into_response();
            }
        };

        match tokio::task::spawn_blocking(move || {
            crate::user_data_db::conversations::list_by_chat(chat_id_i64)
        })
        .await
        {
            Ok(Ok(convs)) => convs,
            Ok(Err(e)) => {
                return (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(ErrorResponse {
                        error: crate::sanitize_error(&e, "list_conversations_by_chat"),
                    }),
                )
                    .into_response()
            }
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
    } else {
        return (
            StatusCode::BAD_REQUEST,
            Json(ErrorResponse {
                error: "至少需要一个查询参数：collaboration_session_id 或 chat_id".to_string(),
            }),
        )
            .into_response();
    };

    let responses: Vec<ConversationResponse> = conversations
        .into_iter()
        .map(ConversationResponse::from)
        .collect();
    (StatusCode::OK, Json(responses)).into_response()
}

/// GET /api/v1/conversations/{conversation_id}/outputs
///
/// Lists all agent output records for this conversation (thinking, tool calls, final responses)
#[utoipa::path(
    get,
    path = "/api/v1/conversations/{conversation_id}/outputs",
    tag = "Conversations",
    params(
        ("conversation_id" = String, Path, description = "Conversation ID"),
        ("limit" = Option<i64>, Query, description = "Maximum number of results"),
        ("offset" = Option<i64>, Query, description = "Offset for pagination"),
    ),
    responses(
        (status = 200, description = "Agent outputs list", body = Vec<AgentOutputResponse>),
        (status = 404, description = "Conversation not found"),
        (status = 500, description = "Internal server error"),
    )
)]
pub async fn list_conversation_outputs(
    State(_state): State<AppState>,
    Path(conversation_id): Path<String>,
    Query(params): Query<OutputListQuery>,
) -> impl IntoResponse {
    if conversation_id.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(ErrorResponse {
                error: "Conversation ID cannot be empty".to_string(),
            }),
        )
            .into_response();
    }

    let conv_id_i64 = match parse_to_i64(&conversation_id) {
        Some(id) => id,
        None => {
            return (
                StatusCode::BAD_REQUEST,
                Json(ErrorResponse {
                    error: format!("Invalid conversation ID format: {}", conversation_id),
                }),
            )
                .into_response();
        }
    };

    // Validate conversation exists
    match tokio::task::spawn_blocking(move || user_data_db::conversations::get(conv_id_i64)).await {
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

    let conv_id_for_list = conversation_id.clone();
    let conv_id_i64 = match parse_to_i64(&conv_id_for_list) {
        Some(id) => id,
        None => {
            return (
                StatusCode::BAD_REQUEST,
                Json(ErrorResponse {
                    error: format!("Invalid conversation ID format: {}", conv_id_for_list),
                }),
            )
                .into_response();
        }
    };

    let limit = params.limit;
    let offset = params.offset;
    match tokio::task::spawn_blocking(move || {
        user_data_db::agent_outputs::list_by_conversation(conv_id_i64, limit, offset)
    })
    .await
    {
        Ok(Ok(outputs)) => {
            let responses: Vec<AgentOutputResponse> =
                outputs.into_iter().map(AgentOutputResponse::from).collect();
            (StatusCode::OK, Json(responses)).into_response()
        }
        Ok(Err(error)) => db_error("Failed to list agent outputs", error),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse {
                error: format!("Task join error: {}", e),
            }),
        )
            .into_response(),
    }
}

/// GET /api/v1/conversations/{conversation_id}/outputs/{output_id}
///
/// Get detailed information about a specific agent output
#[utoipa::path(
    get,
    path = "/api/v1/conversations/{conversation_id}/outputs/{output_id}",
    tag = "Conversations",
    params(
        ("conversation_id" = String, Path, description = "Conversation ID"),
        ("output_id" = String, Path, description = "Agent Output ID"),
    ),
    responses(
        (status = 200, description = "Agent output detail", body = AgentOutputResponse),
        (status = 404, description = "Not found"),
        (status = 500, description = "Internal server error"),
    )
)]
pub async fn get_conversation_output(
    State(_state): State<AppState>,
    Path((conversation_id, output_id)): Path<(String, String)>,
) -> impl IntoResponse {
    if conversation_id.is_empty() || output_id.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(ErrorResponse {
                error: "Conversation ID and Output ID cannot be empty".to_string(),
            }),
        )
            .into_response();
    }

    let output_id_i64 = match parse_to_i64(&output_id) {
        Some(id) => id,
        None => {
            return (
                StatusCode::BAD_REQUEST,
                Json(ErrorResponse {
                    error: format!("Invalid output ID format: {}", output_id),
                }),
            )
                .into_response();
        }
    };

    let conversation_id_i64 = match parse_to_i64(&conversation_id) {
        Some(id) => id,
        None => {
            return (
                StatusCode::BAD_REQUEST,
                Json(ErrorResponse {
                    error: format!("Invalid conversation ID format: {}", conversation_id),
                }),
            )
                .into_response();
        }
    };

    match tokio::task::spawn_blocking(move || {
        let output = user_data_db::agent_outputs::get(output_id_i64)?;
        // Verify the output belongs to the specified conversation
        if let Some(ref out) = output {
            if out.conversation_id != conversation_id_i64 {
                return Ok(None);
            }
        }
        Ok(output)
    })
    .await
    {
        Ok(Ok(Some(output))) => {
            let response = AgentOutputResponse::from(output);
            (StatusCode::OK, Json(response)).into_response()
        }
        Ok(Ok(None)) => StatusCode::NOT_FOUND.into_response(),
        Ok(Err(error)) => db_error("Failed to get agent output", error),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse {
                error: format!("Task join error: {}", e),
            }),
        )
            .into_response(),
    }
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct OutputListQuery {
    pub limit: Option<i64>,
    pub offset: Option<i64>,
}

#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct AgentOutputResponse {
    pub id: String,
    pub conversation_id: String,
    pub message_id: Option<String>,
    pub sequence: i64,
    pub role: String,
    #[schema(value_type = Option<Object>, nullable = true)]
    pub thinking: Option<serde_json::Value>,
    #[schema(value_type = Option<Object>, nullable = true)]
    pub tool_calls: Option<serde_json::Value>,
    #[schema(value_type = Option<Object>, nullable = true)]
    pub text_chunks: Option<serde_json::Value>,
    pub final_text: Option<String>,
    #[schema(value_type = Option<Object>, nullable = true)]
    pub metadata: Option<serde_json::Value>,
    pub created_at: i64,
    pub updated_at: i64,
}

impl From<user_data_db::AgentOutput> for AgentOutputResponse {
    fn from(output: user_data_db::AgentOutput) -> Self {
        Self {
            id: output.id.to_string(),
            conversation_id: format_id(output.conversation_id, IdType::Conversation),
            message_id: output.message_id.map(|id| format_id(id, IdType::Message)),
            sequence: output.sequence,
            role: output.role,
            thinking: output.thinking.and_then(|s| serde_json::from_str(&s).ok()),
            tool_calls: output
                .tool_calls
                .and_then(|s| serde_json::from_str(&s).ok()),
            text_chunks: output
                .text_chunks
                .and_then(|s| serde_json::from_str(&s).ok()),
            final_text: output.final_text,
            metadata: output.metadata.and_then(|s| serde_json::from_str(&s).ok()),
            created_at: output.created_at,
            updated_at: output.updated_at,
        }
    }
}

/// POST /api/v1/conversations
///
/// Create a new conversation. Requires either `collaboration_session_id` or `chat_id`.
#[utoipa::path(
    post,
    path = "/api/v1/conversations",
    tag = "Conversations",
    request_body = CreateConversationRequestNew,
    responses(
        (status = 201, description = "Conversation created", body = Conversation),
        (status = 400, description = "Invalid request"),
        (status = 404, description = "Collaboration session or chat not found"),
        (status = 500, description = "Internal server error"),
    )
)]
pub async fn create_conversation(
    Json(req): Json<CreateConversationRequestNew>,
) -> impl IntoResponse {
    // Validate: at least one of collaboration_session_id or chat_id must be provided
    if req.collaboration_session_id.is_none() && req.chat_id.is_none() {
        return (
            StatusCode::BAD_REQUEST,
            Json(ErrorResponse {
                error: "At least one of collaboration_session_id or chat_id must be provided"
                    .to_string(),
            }),
        )
            .into_response();
    }

    let now = now_unix_seconds();

    // Resolve collaboration_session_id and chat_id
    let (collaboration_session_id, chat_id) = if let Some(session_id) = req.collaboration_session_id
    {
        let session_id_i64 = match parse_to_i64(&session_id) {
            Some(id) => id,
            None => {
                return (
                    StatusCode::BAD_REQUEST,
                    Json(ErrorResponse {
                        error: format!("Invalid collaboration_session_id format: {}", session_id),
                    }),
                )
                    .into_response();
            }
        };

        // Validate collaboration session exists
        match tokio::task::spawn_blocking(move || {
            crate::user_data_db::collaboration_sessions::get(session_id_i64)
        })
        .await
        {
            Ok(Ok(Some(session))) => (session.collaboration_session_id, session.chat_id),
            Ok(Ok(None)) => {
                return (
                    StatusCode::NOT_FOUND,
                    Json(ErrorResponse {
                        error: format!("Collaboration session {} not found", session_id),
                    }),
                )
                    .into_response();
            }
            Ok(Err(error)) => return db_error("Failed to lookup collaboration session", error),
            Err(e) => {
                return (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(ErrorResponse {
                        error: format!("Task join error: {}", e),
                    }),
                )
                    .into_response();
            }
        }
    } else if let Some(chat_id) = req.chat_id {
        let chat_id_i64 = match parse_to_i64(&chat_id) {
            Some(id) => id,
            None => {
                return (
                    StatusCode::BAD_REQUEST,
                    Json(ErrorResponse {
                        error: format!("Invalid chat_id format: {}", chat_id),
                    }),
                )
                    .into_response();
            }
        };

        // Validate chat exists and get its collaboration session
        match tokio::task::spawn_blocking(move || {
            let chat = crate::user_data_db::chats::get(chat_id_i64)?;
            if let Some(chat) = chat {
                // Get or create collaboration session for this chat
                let sessions =
                    crate::user_data_db::collaboration_sessions::list(Some(chat_id_i64))?;
                let session = if let Some(s) = sessions.into_iter().next() {
                    s
                } else {
                    // Create default collaboration session
                    let session_id = generate();
                    crate::user_data_db::collaboration_sessions::create(
                        crate::user_data_db::CollaborationSession {
                            collaboration_session_id: session_id,
                            chat_id: chat_id_i64,
                            workspace_id: chat.workspace_id,
                            mode: "supervisor".to_string(),
                            state: "idle".to_string(),
                            goal: None,
                            active_plan_revision: None,
                            created_at: now,
                            updated_at: now,
                        },
                    )?
                };
                Ok::<_, rusqlite::Error>((session, chat))
            } else {
                Err(rusqlite::Error::QueryReturnedNoRows)
            }
        })
        .await
        {
            Ok(Ok((session, _chat))) => (session.collaboration_session_id, _chat.chat_id),
            Ok(Err(rusqlite::Error::QueryReturnedNoRows)) => {
                return (
                    StatusCode::NOT_FOUND,
                    Json(ErrorResponse {
                        error: format!("Chat {} not found", chat_id),
                    }),
                )
                    .into_response();
            }
            Ok(Err(error)) => return db_error("Failed to lookup chat", error),
            Err(e) => {
                return (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(ErrorResponse {
                        error: format!("Task join error: {}", e),
                    }),
                )
                    .into_response();
            }
        }
    } else {
        unreachable!("Validated above")
    };

    let conversation = Conversation {
        conversation_id: conversation_id(),
        collaboration_session_id,
        chat_id,
        parent_id: None,
        name: req.name,
        mode: req.mode.unwrap_or_else(|| "agent".to_string()),
        participant_role: req.participant_role.unwrap_or_else(|| "peer".to_string()),
        status: "ready".to_string(),
        created_at: now,
        updated_at: now,
    };

    match tokio::task::spawn_blocking(move || user_data_db::conversations::create(conversation))
        .await
    {
        Ok(Ok(created)) => {
            let response = ConversationResponse::from(created);
            (StatusCode::CREATED, Json(response)).into_response()
        }
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
