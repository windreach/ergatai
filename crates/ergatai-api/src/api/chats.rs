//! Chats API endpoints
//!
//! REST API for managing chats (workspaces) and sub-chats (conversation threads).

use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    response::IntoResponse,
    Json,
};
use serde::{Deserialize, Serialize};

use crate::user_data_db::{self, Chat, SubChat};
use crate::AppState;

// ── Request/Response Types ───────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
pub struct ListChatsParams {
    pub project_id: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct CreateChatRequest {
    pub name: Option<String>,
    pub project_id: String,
    pub collaboration_mode: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct UpdateChatRequest {
    pub name: Option<String>,
    pub collaboration_mode: Option<Option<String>>,
    pub worktree_path: Option<Option<String>>,
    pub branch: Option<Option<String>>,
    pub base_branch: Option<Option<String>>,
    pub pr_url: Option<Option<String>>,
    pub pr_number: Option<Option<i32>>,
}

#[derive(Debug, Deserialize)]
pub struct CreateSubChatRequest {
    pub name: Option<String>,
    pub session_id: Option<String>,
    pub stream_id: Option<String>,
    pub mode: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct UpdateSubChatRequest {
    pub name: Option<String>,
    pub session_id: Option<String>,
    pub stream_id: Option<String>,
    pub mode: Option<String>,
    pub messages: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct ChatResponse {
    pub id: String,
    pub name: Option<String>,
    pub project_id: String,
    pub collaboration_mode: String,
    pub created_at: i64,
    pub updated_at: i64,
    pub archived_at: Option<i64>,
    pub worktree_path: Option<String>,
    pub branch: Option<String>,
    pub base_branch: Option<String>,
    pub pr_url: Option<String>,
    pub pr_number: Option<i32>,
}

#[derive(Debug, Serialize)]
pub struct SubChatResponse {
    pub id: String,
    pub name: Option<String>,
    pub chat_id: String,
    pub session_id: Option<String>,
    pub stream_id: Option<String>,
    pub mode: String,
    pub messages: String,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Serialize)]
pub struct ErrorResponse {
    pub error: String,
}

// ── Helper Functions ─────────────────────────────────────────────────────────

fn chat_to_response(chat: Chat) -> ChatResponse {
    ChatResponse {
        id: chat.id,
        name: chat.name,
        project_id: chat.project_id,
        collaboration_mode: chat.collaboration_mode,
        created_at: chat.created_at,
        updated_at: chat.updated_at,
        archived_at: chat.archived_at,
        worktree_path: chat.worktree_path,
        branch: chat.branch,
        base_branch: chat.base_branch,
        pr_url: chat.pr_url,
        pr_number: chat.pr_number,
    }
}

fn sub_chat_to_response(sub_chat: SubChat) -> SubChatResponse {
    SubChatResponse {
        id: sub_chat.id,
        name: sub_chat.name,
        chat_id: sub_chat.chat_id,
        session_id: sub_chat.session_id,
        stream_id: sub_chat.stream_id,
        mode: sub_chat.mode,
        messages: sub_chat.messages,
        created_at: sub_chat.created_at,
        updated_at: sub_chat.updated_at,
    }
}

fn generate_id() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    format!("chat_{}", timestamp)
}

fn generate_sub_chat_id() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    format!("subchat_{}", timestamp)
}

// ── Chat API Handlers ────────────────────────────────────────────────────────

/// GET /api/v1/chats
///
/// List all chats, optionally filtered by project_id.
pub async fn list_chats(
    State(_state): State<AppState>,
    Query(params): Query<ListChatsParams>,
) -> impl IntoResponse {
    match user_data_db::chats::list(params.project_id.as_deref()) {
        Ok(chats) => {
            let response: Vec<ChatResponse> = chats
                .into_iter()
                .map(chat_to_response)
                .collect();
            (StatusCode::OK, Json(response)).into_response()
        }
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse {
                error: format!("Failed to list chats: {}", e),
            }),
        )
            .into_response(),
    }
}

/// POST /api/v1/chats
///
/// Create a new chat.
pub async fn create_chat(
    State(_state): State<AppState>,
    Json(req): Json<CreateChatRequest>,
) -> impl IntoResponse {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs() as i64;

    let chat = Chat {
        id: generate_id(),
        name: req.name,
        project_id: req.project_id,
        collaboration_mode: req.collaboration_mode.unwrap_or_else(|| "supervisor".to_string()),
        created_at: now,
        updated_at: now,
        archived_at: None,
        worktree_path: None,
        branch: None,
        base_branch: None,
        pr_url: None,
        pr_number: None,
    };

    match user_data_db::chats::create(chat) {
        Ok(created) => {
            let response = chat_to_response(created);
            (StatusCode::CREATED, Json(response)).into_response()
        }
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse {
                error: format!("Failed to create chat: {}", e),
            }),
        )
            .into_response(),
    }
}

/// GET /api/v1/chats/:id
///
/// Get a specific chat by ID.
pub async fn get_chat(
    State(_state): State<AppState>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    match user_data_db::chats::get(&id) {
        Ok(Some(chat)) => {
            let response = chat_to_response(chat);
            (StatusCode::OK, Json(response)).into_response()
        }
        Ok(None) => (
            StatusCode::NOT_FOUND,
            Json(ErrorResponse {
                error: format!("Chat not found: {}", id),
            }),
        )
            .into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse {
                error: format!("Failed to get chat: {}", e),
            }),
        )
            .into_response(),
    }
}

/// PUT /api/v1/chats/:id
///
/// Update an existing chat.
pub async fn update_chat(
    State(_state): State<AppState>,
    Path(id): Path<String>,
    Json(req): Json<UpdateChatRequest>,
) -> impl IntoResponse {
    // First, get the existing chat
    let existing = match user_data_db::chats::get(&id) {
        Ok(Some(chat)) => chat,
        Ok(None) => {
            return (
                StatusCode::NOT_FOUND,
                Json(ErrorResponse {
                    error: format!("Chat not found: {}", id),
                }),
            )
                .into_response()
        }
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ErrorResponse {
                    error: format!("Failed to load chat: {}", e),
                }),
            )
                .into_response()
        }
    };

    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64;

    let name = req.name.or(existing.name);
    let collaboration_mode = req.collaboration_mode.flatten().unwrap_or(existing.collaboration_mode);
    let worktree_path = req.worktree_path.flatten().or(existing.worktree_path);
    let branch = req.branch.flatten().or(existing.branch);
    let base_branch = req.base_branch.flatten().or(existing.base_branch);
    let pr_url = req.pr_url.flatten().or(existing.pr_url);
    let pr_number = req.pr_number.flatten().or(existing.pr_number);

    let updated_chat = Chat {
        id: existing.id.clone(),
        name,
        project_id: existing.project_id.clone(),
        collaboration_mode,
        created_at: existing.created_at,
        updated_at: now,
        archived_at: existing.archived_at,
        worktree_path,
        branch,
        base_branch,
        pr_url,
        pr_number,
    };

    match user_data_db::chats::update(updated_chat) {
        Ok(_) => match user_data_db::chats::get(&id) {
            Ok(Some(chat)) => (StatusCode::OK, Json(chat_to_response(chat))).into_response(),
            Ok(None) => (
                StatusCode::NOT_FOUND,
                Json(ErrorResponse {
                    error: format!("Chat not found: {}", id),
                }),
            )
                .into_response(),
            Err(e) => (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ErrorResponse {
                    error: format!("Failed to load chat: {}", e),
                }),
            )
                .into_response(),
        },
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse {
                error: format!("Failed to update chat: {}", e),
            }),
        )
            .into_response(),
    }
}

/// POST /api/v1/chats/:id/archive
///
/// Archive a chat.
pub async fn archive_chat(
    State(_state): State<AppState>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    match user_data_db::chats::archive(&id) {
        Ok(_) => StatusCode::NO_CONTENT.into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse {
                error: format!("Failed to archive chat: {}", e),
            }),
        )
            .into_response(),
    }
}

/// POST /api/v1/chats/:id/unarchive
///
/// Unarchive a chat (restore from archive).
pub async fn unarchive_chat(
    State(_state): State<AppState>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    match user_data_db::chats::unarchive(&id) {
        Ok(_) => StatusCode::NO_CONTENT.into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse {
                error: format!("Failed to unarchive chat: {}", e),
            }),
        )
            .into_response(),
    }
}

/// DELETE /api/v1/chats/:id
///
/// Delete a chat. This will also delete all associated sub-chats (cascade).
pub async fn delete_chat(
    State(_state): State<AppState>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    match user_data_db::chats::delete(&id) {
        Ok(_) => StatusCode::NO_CONTENT.into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse {
                error: format!("Failed to delete chat: {}", e),
            }),
        )
            .into_response(),
    }
}

// ── Sub-Chat API Handlers ────────────────────────────────────────────────────

/// GET /api/v1/chats/:id/sub-chats
///
/// List all sub-chats for a specific chat.
pub async fn list_sub_chats(
    State(_state): State<AppState>,
    Path(chat_id): Path<String>,
) -> impl IntoResponse {
    match user_data_db::sub_chats::list(&chat_id) {
        Ok(sub_chats) => {
            let response: Vec<SubChatResponse> = sub_chats
                .into_iter()
                .map(sub_chat_to_response)
                .collect();
            (StatusCode::OK, Json(response)).into_response()
        }
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse {
                error: format!("Failed to list sub-chats: {}", e),
            }),
        )
            .into_response(),
    }
}

/// POST /api/v1/chats/:id/sub-chats
///
/// Create a new sub-chat.
pub async fn create_sub_chat(
    State(_state): State<AppState>,
    Path(chat_id): Path<String>,
    Json(req): Json<CreateSubChatRequest>,
) -> impl IntoResponse {
    // Verify chat exists
    match user_data_db::chats::get(&chat_id) {
        Ok(Some(_)) => {}
        Ok(None) => {
            return (
                StatusCode::NOT_FOUND,
                Json(ErrorResponse {
                    error: format!("Chat not found: {}", chat_id),
                }),
            )
                .into_response()
        }
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ErrorResponse {
                    error: format!("Failed to get chat: {}", e),
                }),
            )
                .into_response()
        }
    }

    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs() as i64;

    let sub_chat = SubChat {
        id: generate_sub_chat_id(),
        name: req.name,
        chat_id,
        session_id: req.session_id,
        stream_id: req.stream_id,
        mode: req.mode.unwrap_or_else(|| "agent".to_string()),
        messages: "[]".to_string(),
        created_at: now,
        updated_at: now,
    };

    match user_data_db::sub_chats::create(sub_chat) {
        Ok(created) => {
            let response = sub_chat_to_response(created);
            (StatusCode::CREATED, Json(response)).into_response()
        }
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse {
                error: format!("Failed to create sub-chat: {}", e),
            }),
        )
            .into_response(),
    }
}

/// DELETE /api/v1/chats/:chat_id/sub-chats/:sub_chat_id
///
/// Delete a sub-chat.
pub async fn delete_sub_chat(
    State(_state): State<AppState>,
    Path((_chat_id, sub_chat_id)): Path<(String, String)>,
) -> impl IntoResponse {
    match user_data_db::sub_chats::delete(&sub_chat_id) {
        Ok(_) => StatusCode::NO_CONTENT.into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse {
                error: format!("Failed to delete sub-chat: {}", e),
            }),
        )
            .into_response(),
    }
}

/// GET /api/v1/chats/:chat_id/sub-chats/:sub_chat_id
///
/// Get a specific sub-chat.
pub async fn get_sub_chat(
    State(_state): State<AppState>,
    Path((_chat_id, sub_chat_id)): Path<(String, String)>,
) -> impl IntoResponse {
    match user_data_db::sub_chats::get(&sub_chat_id) {
        Ok(Some(sub_chat)) => {
            let response = sub_chat_to_response(sub_chat);
            (StatusCode::OK, Json(response)).into_response()
        }
        Ok(None) => (
            StatusCode::NOT_FOUND,
            Json(ErrorResponse {
                error: "Sub-chat not found".to_string(),
            }),
        )
            .into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse {
                error: format!("Failed to get sub-chat: {}", e),
            }),
        )
            .into_response(),
    }
}

/// PUT /api/v1/chats/:chat_id/sub-chats/:sub_chat_id
///
/// Update a sub-chat.
pub async fn update_sub_chat(
    State(_state): State<AppState>,
    Path((_chat_id, sub_chat_id)): Path<(String, String)>,
    Json(req): Json<UpdateSubChatRequest>,
) -> impl IntoResponse {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs() as i64;

    match user_data_db::sub_chats::update_full(
        &sub_chat_id,
        req.name.as_deref(),
        req.session_id.as_deref(),
        req.stream_id.as_deref(),
        req.mode.as_deref(),
        req.messages.as_deref(),
        now,
    ) {
        Ok(_) => {
            // Fetch and return the updated sub-chat
            match user_data_db::sub_chats::get(&sub_chat_id) {
                Ok(Some(sub_chat)) => {
                    let response = sub_chat_to_response(sub_chat);
                    (StatusCode::OK, Json(response)).into_response()
                }
                Ok(None) => (
                    StatusCode::NOT_FOUND,
                    Json(ErrorResponse {
                        error: "Sub-chat not found after update".to_string(),
                    }),
                )
                    .into_response(),
                Err(e) => (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(ErrorResponse {
                        error: format!("Failed to fetch updated sub-chat: {}", e),
                    }),
                )
                    .into_response(),
            }
        }
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse {
                error: format!("Failed to update sub-chat: {}", e),
            }),
        )
            .into_response(),
    }
}
