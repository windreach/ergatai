//! Conversation-first user data REST API.

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
            error: format!("{operation}: {error}"),
        }),
    );
    response.into_response()
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
    match user_data_db::workspaces::get(&workspace_id) {
        Ok(Some(_workspace)) => {}
        Ok(None) => return StatusCode::NOT_FOUND.into_response(),
        Err(error) => return db_error("Failed to load workspace", error).into_response(),
    }

    match user_data_db::conversations::list_roots(None, Some(&workspace_id)) {
        Ok(conversations) => (StatusCode::OK, Json(conversations)).into_response(),
        Err(error) => db_error("Failed to list conversations", error).into_response(),
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
    let workspace = match user_data_db::workspaces::get(&workspace_id) {
        Ok(Some(workspace)) => workspace,
        Ok(None) => return StatusCode::NOT_FOUND.into_response(),
        Err(error) => return db_error("Failed to load workspace", error).into_response(),
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

    match user_data_db::conversations::create(conversation) {
        Ok(conversation) => (StatusCode::CREATED, Json(conversation)).into_response(),
        Err(error) => db_error("Failed to create conversation", error).into_response(),
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
    match user_data_db::conversations::get(&id) {
        Ok(Some(conversation)) => (StatusCode::OK, Json(conversation)).into_response(),
        Ok(None) => StatusCode::NOT_FOUND.into_response(),
        Err(error) => db_error("Failed to load conversation", error).into_response(),
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
    match user_data_db::conversations::get(&id) {
        Ok(Some(existing)) => {
            let conversation = Conversation {
                name: request.name.or(existing.name),
                mode: request.mode.unwrap_or_else(|| existing.mode.clone()),
                ..existing
            };

            match user_data_db::conversations::update(conversation) {
                Ok(()) => {}
                Err(error) => {
                    return db_error("Failed to update conversation", error).into_response()
                }
            }
            match user_data_db::conversations::get(&id) {
                Ok(Some(conversation)) => (StatusCode::OK, Json(conversation)).into_response(),
                Ok(None) => StatusCode::NOT_FOUND.into_response(),
                Err(error) => db_error("Failed to reload conversation", error).into_response(),
            }
        }
        Ok(None) => StatusCode::NOT_FOUND.into_response(),
        Err(error) => db_error("Failed to load conversation", error).into_response(),
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
    match user_data_db::conversations::archive(&id, now_unix_seconds()) {
        Ok(()) => {}
        Err(error) => return db_error("Failed to archive conversation", error).into_response(),
    }
    match user_data_db::conversations::get(&id) {
        Ok(Some(conversation)) => (StatusCode::OK, Json(conversation)).into_response(),
        Ok(None) => StatusCode::NOT_FOUND.into_response(),
        Err(error) => db_error("Failed to load conversation", error).into_response(),
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
    match user_data_db::conversations::unarchive(&id, now_unix_seconds()) {
        Ok(()) => {}
        Err(error) => return db_error("Failed to unarchive conversation", error).into_response(),
    }
    match user_data_db::conversations::get(&id) {
        Ok(Some(conversation)) => (StatusCode::OK, Json(conversation)).into_response(),
        Ok(None) => StatusCode::NOT_FOUND.into_response(),
        Err(error) => db_error("Failed to load conversation", error).into_response(),
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
    match user_data_db::conversations::delete(&id) {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(error) => db_error("Failed to delete conversation", error).into_response(),
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
    match user_data_db::conversations::list_children(&id) {
        Ok(conversations) => (StatusCode::OK, Json(conversations)).into_response(),
        Err(error) => db_error("Failed to list child conversations", error).into_response(),
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
    let parent = match user_data_db::conversations::get(&id) {
        Ok(Some(parent)) => parent,
        Ok(None) => return StatusCode::NOT_FOUND.into_response(),
        Err(error) => return db_error("Failed to load parent conversation", error).into_response(),
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

    match user_data_db::conversations::create(conversation) {
        Ok(conversation) => (StatusCode::CREATED, Json(conversation)).into_response(),
        Err(error) => db_error("Failed to create conversation", error).into_response(),
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
    match user_data_db::messages::list(&id) {
        Ok(messages) => (StatusCode::OK, Json(messages)).into_response(),
        Err(error) => db_error("Failed to list messages", error).into_response(),
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

    match user_data_db::messages::append(&id, &request.role, parts, metadata) {
        Ok(message) => (StatusCode::CREATED, Json(message)).into_response(),
        Err(error) => db_error("Failed to append message", error).into_response(),
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
    match crate::user_data_db::conversations::get(&id) {
        Ok(Some(_conversation)) => {}
        Ok(None) => return StatusCode::NOT_FOUND.into_response(),
        Err(error) => return db_error("Failed to load conversation", error).into_response(),
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
    if let Err(error) = crate::user_data_db::messages::replace_legacy(&id, &messages, now) {
        return db_error("Failed to replace messages", error).into_response();
    }

    match crate::user_data_db::messages::list(&id) {
        Ok(messages) => (StatusCode::OK, Json(messages)).into_response(),
        Err(error) => db_error("Failed to list messages", error).into_response(),
    }
}
