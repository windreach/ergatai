//! Chats API endpoints
//!
//! REST API for managing chats (workspaces) and sub-chats (conversation threads).

use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use ergatai_core::id::{format as format_id, generate, IdType};
use serde::{Deserialize, Serialize};
use utoipa::{IntoParams, ToSchema};

use crate::user_data_db::{self, Chat};
use crate::AppState;

// ── Request/Response Types ───────────────────────────────────────────────────

#[derive(Debug, Deserialize, IntoParams)]
pub struct ListChatsParams {
    pub workspace_id: Option<String>,
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct CreateChatRequest {
    pub name: Option<String>,
    pub workspace_id: String,
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct UpdateChatRequest {
    pub name: Option<String>,
}

/// Request to create a new conversation (formerly sub-chat).
#[derive(Debug, Deserialize, ToSchema)]
pub struct CreateConversationRequest {
    pub name: Option<String>,
    pub session_id: Option<String>,
    pub mode: Option<String>,
}

/// Backward-compatible type alias for CreateConversationRequest.
/// Deprecated: Use CreateConversationRequest instead.
pub type CreateSubChatRequest = CreateConversationRequest;

#[derive(Debug, Deserialize, ToSchema)]
pub struct UpdateConversationRequest {
    pub name: Option<String>,
    pub session_id: Option<String>,
    pub mode: Option<String>,
    pub messages: Option<String>,
}

/// Backward-compatible type alias for UpdateConversationRequest.
/// Deprecated: Use UpdateConversationRequest instead.
pub type UpdateSubChatRequest = UpdateConversationRequest;

/// Request to bind an agent to a conversation.
#[derive(Debug, Deserialize, ToSchema)]
pub struct BindGroupAgentRequest {
    pub agent_id: String,
    pub agent_name: String,
    #[serde(default)]
    pub agent_command: Option<String>,
    /// The conversation ID to bind the agent to.
    /// Accepts both `conv-` (new format) and `subchat_` (legacy format) prefixes for backward compatibility.
    #[serde(alias = "sub_chat_id")]
    pub conversation_id: String,
}

/// Request to append a message to a conversation.
#[derive(Debug, Deserialize, ToSchema)]
pub struct AppendConversationMessageRequest {
    pub role: String,
    pub text: String,
    #[serde(default)]
    #[schema(value_type = Object, nullable = true)]
    pub metadata: Option<serde_json::Value>,
}

/// Backward-compatible type alias for AppendConversationMessageRequest.
/// Deprecated: Use AppendConversationMessageRequest instead.
pub type AppendSubChatMessageRequest = AppendConversationMessageRequest;

#[derive(Debug, Deserialize)]
pub struct WorktreeLookupParams {
    pub path: String,
}

#[derive(Debug, Serialize)]
pub struct RegisteredWorktreeResponse {
    pub chat: Option<ChatResponse>,
    pub project_path: Option<String>,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct ChatResponse {
    pub id: String,
    pub name: Option<String>,
    pub workspace_id: String,
    pub created_at: i64,
    pub updated_at: i64,
    pub archived_at: Option<i64>,
}

/// Response representing a conversation (formerly sub-chat).
#[derive(Debug, Serialize, ToSchema)]
pub struct ConversationResponse {
    pub id: String,
    pub name: Option<String>,
    pub chat_id: String,
    pub collaboration_session_id: String,
    pub parent_id: Option<String>,
    pub mode: String,
    pub participant_role: String,
    pub status: String,
    pub created_at: i64,
    pub updated_at: i64,
}

/// Backward-compatible type alias for ConversationResponse.
/// Deprecated: Use ConversationResponse instead.
pub type SubChatResponse = ConversationResponse;

#[derive(Debug, Serialize)]
pub struct ErrorResponse {
    pub error: String,
}

fn now_unix_seconds() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
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

// ── Helper Functions ─────────────────────────────────────────────────────────

fn chat_to_response(chat: Chat) -> ChatResponse {
    ChatResponse {
        id: chat.chat_id,
        name: chat.name,
        workspace_id: chat.workspace_id,
        created_at: chat.created_at,
        updated_at: chat.updated_at,
        archived_at: chat.archived_at,
    }
}

fn conversation_to_response(conversation: user_data_db::Conversation) -> ConversationResponse {
    ConversationResponse {
        id: conversation.conversation_id,
        name: conversation.name,
        chat_id: conversation.chat_id,
        collaboration_session_id: conversation.collaboration_session_id,
        parent_id: conversation.parent_id,
        mode: conversation.mode,
        participant_role: conversation.participant_role,
        status: conversation.status,
        created_at: conversation.created_at,
        updated_at: conversation.updated_at,
    }
}

/// Builds a ConversationResponse by loading conversation.
fn build_conversation_response(id: &str) -> rusqlite::Result<Option<ConversationResponse>> {
    let Some(conversation) = user_data_db::conversations::get(id)? else {
        return Ok(None);
    };
    Ok(Some(conversation_to_response(conversation)))
}

fn generate_id() -> String {
    format_id(generate(), IdType::Chat)
}

fn generate_conversation_id() -> String {
    format_id(generate(), IdType::Conversation)
}

/// Normalizes a conversation ID for backward compatibility.
/// Accepts both `conv-` (new format) and `subchat_` (legacy format) prefixes.
/// Returns the ID as-is since both formats are valid for lookups.
fn normalize_conversation_id(id: &str) -> &str {
    // Both `conv-` and `subchat_` prefixes are valid.
    // The DB layer handles lookup regardless of prefix.
    id
}

// ── Chat API Handlers ────────────────────────────────────────────────────────

/// GET /api/v1/chats
///
/// List all chats, optionally filtered by project_id.
#[utoipa::path(
    get,
    path = "/api/v1/chats",
    tag = "Chats",
    params(ListChatsParams),
    responses(
        (status = 200, description = "List chats", body = Vec<ChatResponse>),
        (status = 500, description = "Internal server error", body = crate::api::ApiError),
    )
)]
pub async fn list_chats(
    State(_state): State<AppState>,
    Query(params): Query<ListChatsParams>,
) -> impl IntoResponse {
    let workspace_id = params.workspace_id.clone();
    match tokio::task::spawn_blocking(move || user_data_db::chats::list(workspace_id.as_deref()))
        .await
    {
        Ok(Ok(chats)) => {
            let response: Vec<ChatResponse> = chats.into_iter().map(chat_to_response).collect();
            (StatusCode::OK, Json(response)).into_response()
        }
        Ok(Err(error)) => db_error("Failed to list chats", error),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse {
                error: format!("Task join error: {}", e),
            }),
        )
            .into_response(),
    }
}

/// POST /api/v1/chats
///
/// Create a new chat.
#[utoipa::path(
    post,
    path = "/api/v1/chats",
    tag = "Chats",
    request_body = CreateChatRequest,
    responses(
        (status = 201, description = "Chat created", body = ChatResponse),
        (status = 500, description = "Internal server error", body = crate::api::ApiError),
    )
)]
pub async fn create_chat(
    State(_state): State<AppState>,
    Json(req): Json<CreateChatRequest>,
) -> impl IntoResponse {
    // Validate workspace_id
    if req.workspace_id.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(ErrorResponse {
                error: "Workspace ID cannot be empty".to_string(),
            }),
        )
            .into_response();
    }

    let workspace_id_for_check = req.workspace_id.clone();
    match tokio::task::spawn_blocking(move || {
        user_data_db::workspaces::get(&workspace_id_for_check)
    })
    .await
    {
        Ok(Ok(Some(_))) => {}
        Ok(Ok(None)) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(ErrorResponse {
                    error: format!("Workspace {} not found", req.workspace_id),
                }),
            )
                .into_response();
        }
        Ok(Err(error)) => {
            return db_error("Failed to validate workspace", error);
        }
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

    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs() as i64;

    let chat = Chat {
        chat_id: generate_id(),
        name: req.name,
        workspace_id: req.workspace_id,
        created_at: now,
        updated_at: now,
        archived_at: None,
    };

    match tokio::task::spawn_blocking(move || user_data_db::chats::create(chat)).await {
        Ok(Ok(created)) => {
            let response = chat_to_response(created);
            (StatusCode::CREATED, Json(response)).into_response()
        }
        Ok(Err(error)) => db_error("Failed to create chat", error),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse {
                error: format!("Task join error: {}", e),
            }),
        )
            .into_response(),
    }
}

/// GET /api/v1/chats/:id
///
/// Get a specific chat by ID.
#[utoipa::path(
    get,
    path = "/api/v1/chats/{id}",
    tag = "Chats",
    params(("id" = String, Path, description = "Chat ID")),
    responses(
        (status = 200, description = "Chat detail", body = ChatResponse),
        (status = 404, description = "Chat not found", body = crate::api::ApiError),
        (status = 500, description = "Internal server error", body = crate::api::ApiError),
    )
)]
pub async fn get_chat(State(_state): State<AppState>, Path(id): Path<String>) -> impl IntoResponse {
    let id_for_get = id.clone();
    match tokio::task::spawn_blocking(move || user_data_db::chats::get(&id_for_get)).await {
        Ok(Ok(Some(chat))) => {
            let response = chat_to_response(chat);
            (StatusCode::OK, Json(response)).into_response()
        }
        Ok(Ok(None)) => (
            StatusCode::NOT_FOUND,
            Json(ErrorResponse {
                error: format!("Chat not found: {}", id),
            }),
        )
            .into_response(),
        Ok(Err(error)) => db_error("Failed to get chat", error),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse {
                error: format!("Task join error: {}", e),
            }),
        )
            .into_response(),
    }
}

/// PUT /api/v1/chats/:id
///
/// Update an existing chat.
#[utoipa::path(
    put,
    path = "/api/v1/chats/{id}",
    tag = "Chats",
    params(("id" = String, Path, description = "Chat ID")),
    request_body = UpdateChatRequest,
    responses(
        (status = 200, description = "Chat updated", body = ChatResponse),
        (status = 404, description = "Chat not found", body = crate::api::ApiError),
        (status = 500, description = "Internal server error", body = crate::api::ApiError),
    )
)]
pub async fn update_chat(
    State(_state): State<AppState>,
    Path(id): Path<String>,
    Json(req): Json<UpdateChatRequest>,
) -> impl IntoResponse {
    // First, get the existing chat
    let id_for_get = id.clone();
    let existing =
        match tokio::task::spawn_blocking(move || user_data_db::chats::get(&id_for_get)).await {
            Ok(Ok(Some(chat))) => chat,
            Ok(Ok(None)) => {
                return (
                    StatusCode::NOT_FOUND,
                    Json(ErrorResponse {
                        error: format!("Chat not found: {}", id),
                    }),
                )
                    .into_response()
            }
            Ok(Err(error)) => {
                return db_error("Failed to load chat", error);
            }
            Err(e) => {
                return (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(ErrorResponse {
                        error: format!("Task join error: {}", e),
                    }),
                )
                    .into_response();
            }
        };

    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64;

    let name = req.name.or(existing.name);

    let updated_chat = Chat {
        chat_id: existing.chat_id.clone(),
        name,
        workspace_id: existing.workspace_id.clone(),
        created_at: existing.created_at,
        updated_at: now,
        archived_at: existing.archived_at,
    };

    let id_for_update = id.clone();
    match tokio::task::spawn_blocking(move || user_data_db::chats::update(updated_chat)).await {
        Ok(Ok(_)) => {}
        Ok(Err(error)) => {
            return db_error("Failed to update chat", error);
        }
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

    match tokio::task::spawn_blocking(move || user_data_db::chats::get(&id_for_update)).await {
        Ok(Ok(Some(chat))) => (StatusCode::OK, Json(chat_to_response(chat))).into_response(),
        Ok(Ok(None)) => (
            StatusCode::NOT_FOUND,
            Json(ErrorResponse {
                error: format!("Chat not found: {}", id),
            }),
        )
            .into_response(),
        Ok(Err(error)) => db_error("Failed to load chat", error),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse {
                error: format!("Task join error: {}", e),
            }),
        )
            .into_response(),
    }
}

/// POST /api/v1/chats/:id/archive
///
/// Archive a chat.
#[utoipa::path(
    post,
    path = "/api/v1/chats/{id}/archive",
    tag = "Chats",
    params(("id" = String, Path, description = "Chat ID")),
    responses(
        (status = 204, description = "Chat archived"),
        (status = 500, description = "Internal server error", body = crate::api::ApiError),
    )
)]
pub async fn archive_chat(
    State(_state): State<AppState>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    let id_for_archive = id.clone();
    match tokio::task::spawn_blocking(move || user_data_db::chats::archive(&id_for_archive)).await {
        Ok(Ok(_)) => StatusCode::NO_CONTENT.into_response(),
        Ok(Err(error)) => db_error("Failed to archive chat", error),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse {
                error: format!("Task join error: {}", e),
            }),
        )
            .into_response(),
    }
}

/// POST /api/v1/chats/:id/unarchive
///
/// Unarchive a chat (restore from archive).
#[utoipa::path(
    post,
    path = "/api/v1/chats/{id}/unarchive",
    tag = "Chats",
    params(("id" = String, Path, description = "Chat ID")),
    responses(
        (status = 204, description = "Chat unarchived"),
        (status = 500, description = "Internal server error", body = crate::api::ApiError),
    )
)]
pub async fn unarchive_chat(
    State(_state): State<AppState>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    let id_for_unarchive = id.clone();
    match tokio::task::spawn_blocking(move || user_data_db::chats::unarchive(&id_for_unarchive))
        .await
    {
        Ok(Ok(_)) => StatusCode::NO_CONTENT.into_response(),
        Ok(Err(error)) => db_error("Failed to unarchive chat", error),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse {
                error: format!("Task join error: {}", e),
            }),
        )
            .into_response(),
    }
}

/// DELETE /api/v1/chats/:id
///
/// Delete a chat. This will also delete all associated sub-chats (cascade).
#[utoipa::path(
    delete,
    path = "/api/v1/chats/{id}",
    tag = "Chats",
    params(("id" = String, Path, description = "Chat ID")),
    responses(
        (status = 204, description = "Chat deleted"),
        (status = 500, description = "Internal server error", body = crate::api::ApiError),
    )
)]
pub async fn delete_chat(
    State(_state): State<AppState>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    let id_for_delete = id.clone();
    match tokio::task::spawn_blocking(move || user_data_db::chats::delete(&id_for_delete)).await {
        Ok(Ok(_)) => StatusCode::NO_CONTENT.into_response(),
        Ok(Err(error)) => db_error("Failed to delete chat", error),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse {
                error: format!("Task join error: {}", e),
            }),
        )
            .into_response(),
    }
}

/// GET /api/v1/worktrees/registered?path=...
///
/// Resolve a filesystem path against backend-registered chats and projects.
/// TODO: This endpoint is temporarily stubbed since worktree tracking has been removed.
pub async fn lookup_registered_worktree(
    State(_state): State<AppState>,
    Query(_params): Query<WorktreeLookupParams>,
) -> impl IntoResponse {
    // TODO: Worktree tracking has been removed from the schema.
    // This endpoint is temporarily stubbed.
    (
        StatusCode::OK,
        Json(RegisteredWorktreeResponse {
            chat: None,
            project_path: None,
        }),
    )
        .into_response()
}

// ── Sub-Chat API Handlers ────────────────────────────────────────────────────

/// GET /api/v1/chats/:id/sub-chats
///
/// List all sub-chats for a specific chat.
#[utoipa::path(
    get,
    path = "/api/v1/chats/{chat_id}/sub-chats",
    tag = "Sub-chats",
    params(("chat_id" = String, Path, description = "Chat ID")),
    responses(
        (status = 200, description = "List sub-chats", body = Vec<SubChatResponse>),
        (status = 500, description = "Internal server error", body = crate::api::ApiError),
    )
)]
pub async fn list_sub_chats(
    State(_state): State<AppState>,
    Path(chat_id): Path<String>,
) -> impl IntoResponse {
    let chat_id_for_list = chat_id.clone();
    match tokio::task::spawn_blocking(move || {
        let children = user_data_db::conversations::list_children(&chat_id_for_list)?;
        let mut responses = Vec::with_capacity(children.len());
        for conversation in children {
            responses.push(conversation_to_response(conversation));
        }
        Ok::<_, rusqlite::Error>(responses)
    })
    .await
    {
        Ok(Ok(responses)) => (StatusCode::OK, Json(responses)).into_response(),
        Ok(Err(error)) => db_error("Failed to list sub-chats", error),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse {
                error: format!("Task join error: {}", e),
            }),
        )
            .into_response(),
    }
}

/// POST /api/v1/chats/:id/sub-chats
///
/// Create a new sub-chat.
#[utoipa::path(
    post,
    path = "/api/v1/chats/{chat_id}/sub-chats",
    tag = "Sub-chats",
    params(("chat_id" = String, Path, description = "Chat ID")),
    request_body = CreateSubChatRequest,
    responses(
        (status = 201, description = "Sub-chat created", body = SubChatResponse),
        (status = 404, description = "Chat not found", body = crate::api::ApiError),
        (status = 500, description = "Internal server error", body = crate::api::ApiError),
    )
)]
pub async fn create_sub_chat(
    State(_state): State<AppState>,
    Path(chat_id): Path<String>,
    Json(req): Json<CreateSubChatRequest>,
) -> impl IntoResponse {
    // Verify chat exists
    let chat_id_for_check = chat_id.clone();
    match tokio::task::spawn_blocking(move || user_data_db::chats::get(&chat_id_for_check)).await {
        Ok(Ok(Some(_))) => {}
        Ok(Ok(None)) => {
            return (
                StatusCode::NOT_FOUND,
                Json(ErrorResponse {
                    error: format!("Chat not found: {}", chat_id),
                }),
            )
                .into_response()
        }
        Ok(Err(error)) => {
            return db_error("Failed to get chat", error);
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

    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs() as i64;

    let conversation_id = generate_conversation_id();
    let mode = req.mode.unwrap_or_else(|| "agent".to_string());
    let name = req.name;
    let chat_id_for_create = chat_id.clone();

    // Get the chat to find its associated collaboration session
    let chat_for_session =
        match tokio::task::spawn_blocking(move || user_data_db::chats::get(&chat_id_for_create))
            .await
        {
            Ok(Ok(Some(chat))) => chat,
            Ok(Ok(None)) => {
                return (
                    StatusCode::NOT_FOUND,
                    Json(ErrorResponse {
                        error: format!("Chat {} not found", chat_id),
                    }),
                )
                    .into_response();
            }
            Ok(Err(error)) => return db_error("Failed to get chat", error),
            Err(e) => {
                return (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(ErrorResponse {
                        error: format!("Task join error: {}", e),
                    }),
                )
                    .into_response();
            }
        };

    // Get or create a default collaboration session for this chat
    let chat_id_for_list = chat_for_session.chat_id.clone();
    let chat_id_for_create = chat_for_session.chat_id.clone();
    let workspace_id_for_session = chat_for_session.workspace_id.clone();
    let collaboration_session_id = match tokio::task::spawn_blocking(move || {
        user_data_db::collaboration_sessions::list(Some(&chat_id_for_list))
    })
    .await
    {
        Ok(Ok(sessions)) if !sessions.is_empty() => sessions[0].collaboration_session_id.clone(),
        Ok(Ok(_)) => {
            // Create a default collaboration session
            let session = user_data_db::CollaborationSession {
                collaboration_session_id: format_id(generate(), IdType::Conversation),
                chat_id: chat_id_for_create.clone(),
                workspace_id: workspace_id_for_session.clone(),
                mode: "supervisor".to_string(),
                state: "idle".to_string(),
                goal: None,
                active_plan_revision: None,
                created_at: now,
                updated_at: now,
            };
            match tokio::task::spawn_blocking(move || {
                user_data_db::collaboration_sessions::create(session)
            })
            .await
            {
                Ok(Ok(session)) => session.collaboration_session_id,
                Ok(Err(error)) => return db_error("Failed to create collaboration session", error),
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
        }
        Ok(Err(error)) => return db_error("Failed to list collaboration sessions", error),
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ErrorResponse {
                    error: format!("Task join error: {}", e),
                }),
            )
                .into_response();
        }
    };

    let chat_id_for_create = chat_id;
    let collab_session_id_for_create = collaboration_session_id.clone();

    match tokio::task::spawn_blocking(move || {
        // Get parent conversation (chat is a root conversation)
        let parent = user_data_db::conversations::get(&chat_id_for_create)?
            .ok_or(rusqlite::Error::QueryReturnedNoRows)?;

        // Create child conversation
        let conversation = user_data_db::conversations::create(user_data_db::Conversation {
            conversation_id: conversation_id.clone(),
            collaboration_session_id: collab_session_id_for_create,
            chat_id: parent.chat_id.clone(),
            parent_id: Some(parent.conversation_id.clone()),
            name: name.clone(),
            mode: mode.clone(),
            participant_role: "peer".to_string(),
            status: "ready".to_string(),
            created_at: now,
            updated_at: now,
        })?;

        // Register agent session
        let agent_session = user_data_db::AgentSession {
            agent_session_id: format_id(generate(), IdType::Session),
            conversation_id: conversation_id.clone(),
            acp_session_id: None,
            mode: mode.clone(),
            created_at: now,
            updated_at: now,
        };
        user_data_db::agent_sessions::upsert(agent_session)?;

        Ok::<_, rusqlite::Error>(conversation_to_response(conversation))
    })
    .await
    {
        Ok(Ok(response)) => (StatusCode::CREATED, Json(response)).into_response(),
        Ok(Err(error)) => db_error("Failed to create sub-chat", error),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse {
                error: format!("Task join error: {}", e),
            }),
        )
            .into_response(),
    }
}

/// DELETE /api/v1/chats/:chat_id/sub-chats/:sub_chat_id
///
/// Delete a sub-chat.
#[utoipa::path(
    delete,
    path = "/api/v1/chats/{chat_id}/sub-chats/{sub_chat_id}",
    tag = "Sub-chats",
    params(("chat_id" = String, Path, description = "Chat ID"), ("sub_chat_id" = String, Path, description = "Sub-chat ID")),
    responses(
        (status = 204, description = "Sub-chat deleted"),
        (status = 500, description = "Internal server error", body = crate::api::ApiError),
    )
)]
pub async fn delete_sub_chat(
    State(_state): State<AppState>,
    Path((_chat_id, sub_chat_id)): Path<(String, String)>,
) -> impl IntoResponse {
    let sub_chat_id_for_delete = sub_chat_id.clone();
    match tokio::task::spawn_blocking(move || {
        user_data_db::conversations::delete(&sub_chat_id_for_delete)
    })
    .await
    {
        Ok(Ok(_)) => StatusCode::NO_CONTENT.into_response(),
        Ok(Err(error)) => db_error("Failed to delete sub-chat", error),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse {
                error: format!("Task join error: {}", e),
            }),
        )
            .into_response(),
    }
}

/// GET /api/v1/chats/:chat_id/sub-chats/:sub_chat_id
///
/// Get a specific sub-chat.
#[utoipa::path(
    get,
    path = "/api/v1/chats/{chat_id}/sub-chats/{sub_chat_id}",
    tag = "Sub-chats",
    params(("chat_id" = String, Path, description = "Chat ID"), ("sub_chat_id" = String, Path, description = "Sub-chat ID")),
    responses(
        (status = 200, description = "Sub-chat detail", body = SubChatResponse),
        (status = 404, description = "Sub-chat not found", body = crate::api::ApiError),
        (status = 500, description = "Internal server error", body = crate::api::ApiError),
    )
)]
pub async fn get_sub_chat(
    State(_state): State<AppState>,
    Path((_chat_id, sub_chat_id)): Path<(String, String)>,
) -> impl IntoResponse {
    let sub_chat_id_for_get = sub_chat_id.clone();
    match tokio::task::spawn_blocking(move || build_conversation_response(&sub_chat_id_for_get))
        .await
    {
        Ok(Ok(Some(response))) => (StatusCode::OK, Json(response)).into_response(),
        Ok(Ok(None)) => (
            StatusCode::NOT_FOUND,
            Json(ErrorResponse {
                error: "Sub-chat not found".to_string(),
            }),
        )
            .into_response(),
        Ok(Err(error)) => db_error("Failed to get sub-chat", error),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse {
                error: format!("Task join error: {}", e),
            }),
        )
            .into_response(),
    }
}

/// GET /api/v1/sub-chats/:sub_chat_id
///
/// Get a sub-chat without requiring the caller to know its chat ID.
#[utoipa::path(
    get,
    path = "/api/v1/sub-chats/{id}",
    tag = "Sub-chats",
    params(("id" = String, Path, description = "Sub-chat ID")),
    responses(
        (status = 200, description = "Sub-chat detail", body = SubChatResponse),
        (status = 404, description = "Sub-chat not found", body = crate::api::ApiError),
        (status = 500, description = "Internal server error", body = crate::api::ApiError),
    )
)]
pub async fn get_sub_chat_by_id(
    State(_state): State<AppState>,
    Path(sub_chat_id): Path<String>,
) -> impl IntoResponse {
    let sub_chat_id_for_get = sub_chat_id.clone();
    match tokio::task::spawn_blocking(move || build_conversation_response(&sub_chat_id_for_get))
        .await
    {
        Ok(Ok(Some(response))) => (StatusCode::OK, Json(response)).into_response(),
        Ok(Ok(None)) => (
            StatusCode::NOT_FOUND,
            Json(ErrorResponse {
                error: "Sub-chat not found".to_string(),
            }),
        )
            .into_response(),
        Ok(Err(error)) => db_error("Failed to get sub-chat", error),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse {
                error: format!("Task join error: {}", e),
            }),
        )
            .into_response(),
    }
}

/// PUT /api/v1/chats/:chat_id/sub-chats/:sub_chat_id
///
/// Update a sub-chat.
#[utoipa::path(
    put,
    path = "/api/v1/chats/{chat_id}/sub-chats/{sub_chat_id}",
    tag = "Sub-chats",
    params(("chat_id" = String, Path, description = "Chat ID"), ("sub_chat_id" = String, Path, description = "Sub-chat ID")),
    request_body = UpdateSubChatRequest,
    responses(
        (status = 200, description = "Sub-chat updated", body = SubChatResponse),
        (status = 404, description = "Sub-chat not found", body = crate::api::ApiError),
        (status = 500, description = "Internal server error", body = crate::api::ApiError),
    )
)]
pub async fn update_sub_chat(
    State(_state): State<AppState>,
    Path((_chat_id, sub_chat_id)): Path<(String, String)>,
    Json(req): Json<UpdateSubChatRequest>,
) -> impl IntoResponse {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs() as i64;

    let sub_chat_id_for_update = sub_chat_id.clone();
    let name = req.name.clone();
    let session_id = req.session_id.clone();
    let mode = req.mode.clone();
    let messages = req.messages.clone();
    match tokio::task::spawn_blocking(move || {
        // Update conversation fields
        let Some(existing) = user_data_db::conversations::get(&sub_chat_id_for_update)? else {
            return Err(rusqlite::Error::QueryReturnedNoRows);
        };
        let existing_conv_id = existing.conversation_id.clone();
        user_data_db::conversations::update(user_data_db::Conversation {
            conversation_id: existing_conv_id.clone(),
            collaboration_session_id: existing.collaboration_session_id,
            chat_id: existing.chat_id,
            parent_id: existing.parent_id,
            name: name.or(existing.name),
            mode: mode.clone().unwrap_or_else(|| existing.mode.clone()),
            participant_role: existing.participant_role,
            status: existing.status,
            created_at: existing.created_at,
            updated_at: now,
        })?;
        // Update session
        if let Some(ref sid) = session_id {
            let mode_for_session = mode.as_deref().unwrap_or(&existing.mode);
            user_data_db::agent_sessions::upsert(user_data_db::AgentSession {
                agent_session_id: format_id(generate(), IdType::Session),
                conversation_id: existing_conv_id.clone(),
                acp_session_id: Some(sid.clone()),
                mode: mode_for_session.to_string(),
                created_at: existing.created_at,
                updated_at: now,
            })?;
        }
        // Update messages
        if let Some(ref msgs) = messages {
            user_data_db::messages::replace_legacy(&sub_chat_id_for_update, msgs, now)?;
        }
        Ok::<_, rusqlite::Error>(())
    })
    .await
    {
        Ok(Ok(_)) => {}
        Ok(Err(error)) => {
            return db_error("Failed to update sub-chat", error);
        }
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

    // Fetch and return the updated sub-chat
    let sub_chat_id_for_get = sub_chat_id.clone();
    match tokio::task::spawn_blocking(move || build_conversation_response(&sub_chat_id_for_get))
        .await
    {
        Ok(Ok(Some(response))) => (StatusCode::OK, Json(response)).into_response(),
        Ok(Ok(None)) => (
            StatusCode::NOT_FOUND,
            Json(ErrorResponse {
                error: "Sub-chat not found after update".to_string(),
            }),
        )
            .into_response(),
        Ok(Err(error)) => db_error("Failed to fetch updated sub-chat", error),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse {
                error: format!("Task join error: {}", e),
            }),
        )
            .into_response(),
    }
}

/// PUT /api/v1/sub-chats/:sub_chat_id
///
/// Update a sub-chat without requiring the caller to know its chat ID.
#[utoipa::path(
    put,
    path = "/api/v1/sub-chats/{id}",
    tag = "Sub-chats",
    params(("id" = String, Path, description = "Sub-chat ID")),
    request_body = UpdateSubChatRequest,
    responses(
        (status = 200, description = "Sub-chat updated", body = SubChatResponse),
        (status = 404, description = "Sub-chat not found", body = crate::api::ApiError),
        (status = 500, description = "Internal server error", body = crate::api::ApiError),
    )
)]
pub async fn update_sub_chat_by_id(
    State(_state): State<AppState>,
    Path(sub_chat_id): Path<String>,
    Json(req): Json<UpdateSubChatRequest>,
) -> impl IntoResponse {
    let now = now_unix_seconds();

    let sub_chat_id_for_update = sub_chat_id.clone();
    let name = req.name.clone();
    let session_id = req.session_id.clone();
    let mode = req.mode.clone();
    let messages = req.messages.clone();
    match tokio::task::spawn_blocking(move || {
        let Some(existing) = user_data_db::conversations::get(&sub_chat_id_for_update)? else {
            return Err(rusqlite::Error::QueryReturnedNoRows);
        };
        user_data_db::conversations::update(user_data_db::Conversation {
            conversation_id: existing.conversation_id,
            collaboration_session_id: existing.collaboration_session_id,
            chat_id: existing.chat_id,
            parent_id: existing.parent_id,
            name: name.or(existing.name),
            mode: mode.clone().unwrap_or_else(|| existing.mode.clone()),
            participant_role: existing.participant_role,
            status: existing.status,
            created_at: existing.created_at,
            updated_at: now,
        })?;
        if let Some(ref sid) = session_id {
            let mode_for_session = mode.as_deref().unwrap_or(&existing.mode);
            let agent_session_id = format_id(generate(), IdType::Session);
            let conv_id_for_session = sub_chat_id_for_update.clone();
            user_data_db::agent_sessions::upsert(user_data_db::AgentSession {
                agent_session_id,
                conversation_id: conv_id_for_session,
                acp_session_id: Some(sid.clone()),
                mode: mode_for_session.to_string(),
                created_at: now,
                updated_at: now,
            })?;
        }
        if let Some(ref msgs) = messages {
            user_data_db::messages::replace_legacy(&sub_chat_id_for_update, msgs, now)?;
        }
        Ok::<_, rusqlite::Error>(())
    })
    .await
    {
        Ok(Ok(_)) => {}
        Ok(Err(error)) => {
            return db_error("Failed to update sub-chat", error);
        }
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

    let sub_chat_id_for_get = sub_chat_id.clone();
    match tokio::task::spawn_blocking(move || build_conversation_response(&sub_chat_id_for_get))
        .await
    {
        Ok(Ok(Some(response))) => (StatusCode::OK, Json(response)).into_response(),
        Ok(Ok(None)) => (
            StatusCode::NOT_FOUND,
            Json(ErrorResponse {
                error: "Sub-chat not found after update".to_string(),
            }),
        )
            .into_response(),
        Ok(Err(error)) => db_error("Failed to fetch updated sub-chat", error),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse {
                error: format!("Task join error: {}", e),
            }),
        )
            .into_response(),
    }
}

/// GET /api/v1/chats/:chat_id/agent-bindings
#[utoipa::path(
    get,
    path = "/api/v1/chats/{chat_id}/agent-bindings",
    tag = "Agent bindings",
    params(("chat_id" = String, Path, description = "Chat ID")),
    responses(
        (status = 200, description = "List agent bindings", body = Vec<crate::user_data_db::GroupAgentBinding>),
        (status = 500, description = "Internal server error", body = crate::api::ApiError),
    )
)]
pub async fn list_agent_bindings(
    State(_state): State<AppState>,
    Path(chat_id): Path<String>,
) -> impl IntoResponse {
    let chat_id_for_list = chat_id.clone();
    match tokio::task::spawn_blocking(move || {
        user_data_db::group_agent_bindings::list(&chat_id_for_list)
    })
    .await
    {
        Ok(Ok(bindings)) => (StatusCode::OK, Json(bindings)).into_response(),
        Ok(Err(error)) => db_error("Failed to list agent bindings", error),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse {
                error: format!("Task join error: {}", e),
            }),
        )
            .into_response(),
    }
}

/// POST /api/v1/chats/:chat_id/agent-bindings
#[utoipa::path(
    post,
    path = "/api/v1/chats/{chat_id}/agent-bindings",
    tag = "Agent bindings",
    params(("chat_id" = String, Path, description = "Chat ID")),
    request_body = BindGroupAgentRequest,
    responses(
        (status = 200, description = "Agent binding saved", body = crate::user_data_db::GroupAgentBinding),
        (status = 400, description = "Invalid binding", body = crate::api::ApiError),
        (status = 404, description = "Chat or sub-chat not found", body = crate::api::ApiError),
        (status = 500, description = "Internal server error", body = crate::api::ApiError),
    )
)]
pub async fn bind_agent(
    State(_state): State<AppState>,
    Path(chat_id): Path<String>,
    Json(req): Json<BindGroupAgentRequest>,
) -> impl IntoResponse {
    let chat_id_for_check = chat_id.clone();
    match tokio::task::spawn_blocking(move || user_data_db::chats::get(&chat_id_for_check)).await {
        Ok(Ok(Some(_))) => {} // Chat exists, proceed
        Ok(Ok(None)) => {
            return (
                StatusCode::NOT_FOUND,
                Json(ErrorResponse {
                    error: format!("Chat {} not found", chat_id),
                }),
            )
                .into_response();
        }
        Ok(Err(error)) => {
            return db_error("Failed to get chat", error);
        }
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

    // Normalize conversation ID for backward compatibility (accepts both conv- and subchat_ prefixes)
    let conversation_id_for_get = normalize_conversation_id(&req.conversation_id).to_string();
    let chat_id_for_cmp = chat_id.clone();
    let conversation = match tokio::task::spawn_blocking(move || {
        user_data_db::conversations::get(&conversation_id_for_get)
    })
    .await
    {
        Ok(Ok(Some(conv))) if conv.parent_id.as_deref() == Some(&chat_id_for_cmp) => conv,
        Ok(Ok(Some(conv))) if conv.conversation_id == chat_id_for_cmp => conv,
        Ok(Ok(_)) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(ErrorResponse {
                    error: "Conversation does not belong to this chat".to_string(),
                }),
            )
                .into_response();
        }
        Ok(Err(error)) => {
            return db_error("Failed to get conversation", error);
        }
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ErrorResponse {
                    error: format!("Task join error: {}", e),
                }),
            )
                .into_response();
        }
    };

    let now = now_unix_seconds();

    // Get workspace_id from the agent
    let workspace_id = crate::services::agent_service::get_agent_info(&req.agent_id)
        .await
        .map(|info| info.workspace_id.clone())
        .unwrap_or_else(|| chat_id.clone()); // Fallback to chat_id if agent not found

    let binding = user_data_db::GroupAgentBinding {
        workspace_id,
        chat_id,
        agent_id: req.agent_id,
        agent_name: req.agent_name,
        agent_command: req.agent_command,
        conversation_id: conversation.conversation_id,
        created_at: now,
        updated_at: now,
    };

    match tokio::task::spawn_blocking(move || user_data_db::group_agent_bindings::upsert(binding))
        .await
    {
        Ok(Ok(binding)) => (StatusCode::OK, Json(binding)).into_response(),
        Ok(Err(error)) => db_error("Failed to bind agent", error),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse {
                error: format!("Task join error: {}", e),
            }),
        )
            .into_response(),
    }
}

/// DELETE /api/v1/chats/:chat_id/agent-bindings/:agent_id
#[utoipa::path(
    delete,
    path = "/api/v1/chats/{chat_id}/agent-bindings/{agent_id}",
    tag = "Agent bindings",
    params(("chat_id" = String, Path, description = "Chat ID"), ("agent_id" = String, Path, description = "Agent ID")),
    responses(
        (status = 204, description = "Agent binding removed"),
        (status = 404, description = "Agent binding not found"),
        (status = 500, description = "Internal server error", body = crate::api::ApiError),
    )
)]
pub async fn unbind_agent(
    State(_state): State<AppState>,
    Path((chat_id, agent_id)): Path<(String, String)>,
) -> impl IntoResponse {
    let chat_id_for_delete = chat_id.clone();
    let agent_id_for_delete = agent_id.clone();
    match tokio::task::spawn_blocking(move || {
        user_data_db::group_agent_bindings::delete(&chat_id_for_delete, &agent_id_for_delete)
    })
    .await
    {
        Ok(Ok(true)) => StatusCode::NO_CONTENT.into_response(),
        Ok(Ok(false)) => StatusCode::NOT_FOUND.into_response(),
        Ok(Err(error)) => db_error("Failed to unbind agent", error),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse {
                error: format!("Task join error: {}", e),
            }),
        )
            .into_response(),
    }
}

/// Response type for GET /api/v1/chats/:chat_id/agents
#[derive(Debug, Serialize, ToSchema)]
pub struct ChatAgentResponse {
    pub agent_id: String,
    pub command: String,
    pub status: String,
    pub bound_at: i64,
}

/// GET /api/v1/chats/:chat_id/agents
/// Returns all bound agents to this chat with their current status
#[utoipa::path(
    get,
    path = "/api/v1/chats/{chat_id}/agents",
    tag = "Agent bindings",
    params(("chat_id" = String, Path, description = "Chat ID")),
    responses(
        (status = 200, description = "List chat agents", body = Vec<ChatAgentResponse>),
        (status = 500, description = "Internal server error", body = crate::api::ApiError),
    )
)]
pub async fn list_chat_agents(
    State(_state): State<AppState>,
    Path(chat_id): Path<String>,
) -> impl IntoResponse {
    // Get all agent bindings for this chat
    let chat_id_for_list = chat_id.clone();
    let bindings = match tokio::task::spawn_blocking(move || {
        user_data_db::group_agent_bindings::list(&chat_id_for_list)
    })
    .await
    {
        Ok(Ok(bindings)) => bindings,
        Ok(Err(error)) => {
            return db_error("Failed to list agent bindings", error);
        }
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ErrorResponse {
                    error: format!("Task join error: {}", e),
                }),
            )
                .into_response();
        }
    };

    // For each binding, get the agent's current status
    let agents: Vec<ChatAgentResponse> =
        futures::future::join_all(bindings.into_iter().map(|binding| async move {
            // Try to get agent info from the runtime
            let agent_info =
                crate::services::agent_service::get_agent_info(&binding.agent_id).await;

            let status = match agent_info {
                Some(info) => {
                    if info.lifecycle.is_alive() {
                        info.lifecycle.state_name().to_string().to_lowercase()
                    } else {
                        "dead".to_string()
                    }
                }
                None => "not_found".to_string(),
            };

            ChatAgentResponse {
                agent_id: binding.agent_id,
                command: binding
                    .agent_command
                    .unwrap_or_else(|| "unknown".to_string()),
                status,
                bound_at: binding.created_at,
            }
        }))
        .await;

    (StatusCode::OK, Json(agents)).into_response()
}

/// POST /api/v1/chats/:chat_id/sub-chats/:sub_chat_id/messages
#[utoipa::path(
    post,
    path = "/api/v1/chats/{chat_id}/sub-chats/{sub_chat_id}/messages",
    tag = "Sub-chats",
    params(("chat_id" = String, Path, description = "Chat ID"), ("sub_chat_id" = String, Path, description = "Sub-chat ID")),
    request_body = AppendSubChatMessageRequest,
    responses(
        (status = 201, description = "Message appended"),
        (status = 400, description = "Sub-chat does not belong to chat", body = crate::api::ApiError),
        (status = 404, description = "Sub-chat not found"),
        (status = 500, description = "Internal server error", body = crate::api::ApiError),
    )
)]
pub async fn append_sub_chat_message(
    State(_state): State<AppState>,
    Path((chat_id, sub_chat_id)): Path<(String, String)>,
    Json(req): Json<AppendSubChatMessageRequest>,
) -> impl IntoResponse {
    // Validate role is not empty
    if req.role.trim().is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(ErrorResponse {
                error: "Role cannot be empty".to_string(),
            }),
        )
            .into_response();
    }

    // Validate role is one of the allowed values
    if !matches!(req.role.as_str(), "user" | "assistant" | "system") {
        return (
            StatusCode::BAD_REQUEST,
            Json(ErrorResponse {
                error: "Role must be one of: user, assistant, system".to_string(),
            }),
        )
            .into_response();
    }

    // Verify the sub-chat belongs to the specified chat
    let sub_chat_id_for_check = sub_chat_id.clone();
    let chat_id_for_cmp = chat_id.clone();
    match tokio::task::spawn_blocking(move || {
        user_data_db::conversations::get(&sub_chat_id_for_check)
    })
    .await
    {
        Ok(Ok(Some(conv))) if conv.parent_id.as_deref() == Some(&chat_id_for_cmp) => {}
        Ok(Ok(Some(_))) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(ErrorResponse {
                    error: "Sub-chat does not belong to this chat".to_string(),
                }),
            )
                .into_response();
        }
        Ok(Ok(None)) => {
            return StatusCode::NOT_FOUND.into_response();
        }
        Ok(Err(error)) => {
            return db_error("Failed to get sub-chat", error);
        }
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

    let sub_chat_id_for_append = sub_chat_id.clone();
    let role = req.role.clone();
    let text = req.text.clone();
    let metadata = req.metadata.unwrap_or(serde_json::Value::Null);
    match tokio::task::spawn_blocking(move || {
        let parts = serde_json::json!([{ "type": "text", "text": text }]);
        user_data_db::messages::append(&sub_chat_id_for_append, &role, parts, metadata)?;
        Ok::<_, rusqlite::Error>(())
    })
    .await
    {
        Ok(Ok(())) => StatusCode::CREATED.into_response(),
        Ok(Err(rusqlite::Error::QueryReturnedNoRows)) => StatusCode::NOT_FOUND.into_response(),
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

// ════════════════════════════════════════════════════════════════════════
// Chat API（新版扁平化路由）
// ════════════════════════════════════════════════════════════════════════

#[derive(Debug, Deserialize, ToSchema)]
pub struct PatchChatRequest {
    pub name: Option<String>,
    pub collaboration_mode: Option<String>,
    pub worktree_path: Option<String>,
    pub branch: Option<String>,
    pub base_branch: Option<String>,
    pub pr_url: Option<String>,
    pub pr_number: Option<i32>,
}

/// PATCH /api/v1/chats/{chat_id}
#[utoipa::path(
    patch,
    path = "/api/v1/chats/{chat_id}",
    tag = "Chats",
    params(("chat_id" = String, Path, description = "Chat ID")),
    request_body = PatchChatRequest,
    responses(
        (status = 200, description = "Chat updated", body = Chat),
        (status = 404, description = "Chat not found", body = crate::api::ApiError),
        (status = 400, description = "Invalid request", body = crate::api::ApiError),
        (status = 500, description = "Internal server error", body = crate::api::ApiError),
    )
)]
pub async fn patch_chat(
    State(_state): State<AppState>,
    Path(chat_id): Path<String>,
    Json(req): Json<PatchChatRequest>,
) -> impl IntoResponse {
    // Get existing chat
    let chat_id_for_get = chat_id.clone();
    match tokio::task::spawn_blocking(move || user_data_db::chats::get(&chat_id_for_get)).await {
        Ok(Ok(Some(chat))) => {
            // Update fields
            let updated = user_data_db::Chat {
                name: req.name.or(chat.name),
                updated_at: std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_secs() as i64,
                ..chat
            };

            match tokio::task::spawn_blocking(move || user_data_db::chats::update(updated)).await {
                Ok(Ok(())) => {
                    // Fetch updated chat
                    let chat_id_for_refetch = chat_id.clone();
                    match tokio::task::spawn_blocking(move || {
                        user_data_db::chats::get(&chat_id_for_refetch)
                    })
                    .await
                    {
                        Ok(Ok(Some(updated_chat))) => {
                            (StatusCode::OK, Json(updated_chat)).into_response()
                        }
                        Ok(Ok(None)) => (
                            StatusCode::NOT_FOUND,
                            Json(ErrorResponse {
                                error: format!("Chat {} not found after update", chat_id),
                            }),
                        )
                            .into_response(),
                        Ok(Err(error)) => db_error("get chat after update", error),
                        Err(e) => (
                            StatusCode::INTERNAL_SERVER_ERROR,
                            Json(ErrorResponse {
                                error: format!("Task join error: {}", e),
                            }),
                        )
                            .into_response(),
                    }
                }
                Ok(Err(error)) => db_error("update chat", error),
                Err(e) => (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(ErrorResponse {
                        error: format!("Task join error: {}", e),
                    }),
                )
                    .into_response(),
            }
        }
        Ok(Ok(None)) => (
            StatusCode::NOT_FOUND,
            Json(ErrorResponse {
                error: format!("Chat {} not found", chat_id),
            }),
        )
            .into_response(),
        Ok(Err(error)) => db_error("get chat for update", error),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse {
                error: format!("Task join error: {}", e),
            }),
        )
            .into_response(),
    }
}

/// GET /api/v1/chats/{chat_id}/events
#[utoipa::path(
    get,
    path = "/api/v1/chats/{chat_id}/events",
    tag = "Chats",
    params(("chat_id" = String, Path, description = "Chat ID")),
    responses(
        (status = 200, description = "Event stream"),
        (status = 404, description = "Chat not found", body = crate::api::ApiError),
    )
)]
pub async fn stream_chat_events(Path(chat_id): Path<String>) -> impl axum::response::IntoResponse {
    use axum::response::sse::{Event, KeepAlive, Sse};
    use std::convert::Infallible;

    // Check if chat exists
    let chat_exists = matches!(
        tokio::task::spawn_blocking({
            let _chat_id = chat_id.clone();
            move || user_data_db::chats::get(&_chat_id)
        })
        .await,
        Ok(Ok(Some(_)))
    );

    // Create stream based on whether chat exists
    let stream: futures::stream::BoxStream<'static, Result<Event, Infallible>> = if !chat_exists {
        // Return empty stream for not found
        Box::pin(futures::stream::empty())
    } else {
        // Create a simple polling stream
        Box::pin(futures::stream::unfold(0, move |state| {
            let _chat_id = chat_id.clone();
            async move {
                // Simple polling every 2 seconds
                tokio::time::sleep(tokio::time::Duration::from_secs(2)).await;

                // For now, just send a keepalive event
                let event = Event::default()
                    .event("ping")
                    .data("{\"type\": \"keepalive\"}");

                Some((Ok(event), state + 1))
            }
        }))
    };

    Sse::new(stream).keep_alive(KeepAlive::default())
}
