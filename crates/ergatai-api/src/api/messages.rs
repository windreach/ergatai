//! Message API endpoints

use axum::{
    extract::{Path, Query},
    http::StatusCode,
    response::IntoResponse,
    Json,
};
use serde::{Deserialize, Serialize};
use utoipa::{IntoParams, ToSchema};

use crate::user_data_db;

// ── Request/Response Types ───────────────────────────────────────────────────

#[derive(Debug, Deserialize, IntoParams)]
pub struct ListMessagesParams {
    pub conversation_id: Option<String>,
    pub collaboration_session_id: Option<String>,
    pub chat_id: Option<String>,
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct CreateMessageRequest {
    pub conversation_id: String,
    pub role: String,
    #[serde(default)]
    pub parts: Option<serde_json::Value>,
    #[serde(default)]
    pub text: Option<String>,
    #[serde(default)]
    pub metadata: Option<serde_json::Value>,
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct UpdateMessageRequest {
    #[serde(default)]
    pub parts: Option<serde_json::Value>,
    #[serde(default)]
    pub metadata: Option<serde_json::Value>,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct MessageResponse {
    pub message_id: String,
    pub conversation_id: String,
    pub sequence: i64,
    pub role: String,
    pub parts: serde_json::Value,
    pub metadata: Option<serde_json::Value>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Serialize)]
pub struct ErrorResponse {
    pub error: String,
}

// ── Handlers ─────────────────────────────────────────────────────────────────

/// GET /api/v1/messages
#[utoipa::path(
    get,
    path = "/api/v1/messages",
    tag = "Messages",
    params(ListMessagesParams),
    responses(
        (status = 200, description = "List messages", body = Vec<MessageResponse>),
        (status = 400, description = "Invalid request", body = crate::api::ApiError),
        (status = 500, description = "Internal server error", body = crate::api::ApiError),
    )
)]
pub async fn list_messages(Query(params): Query<ListMessagesParams>) -> impl IntoResponse {
    let messages = if let Some(conversation_id) = params.conversation_id {
        match tokio::task::spawn_blocking(move || user_data_db::messages::list(&conversation_id))
            .await
        {
            Ok(Ok(msgs)) => msgs,
            Ok(Err(e)) => {
                return (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(ErrorResponse {
                        error: crate::sanitize_error(&e, "list_messages_by_conversation"),
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
    } else if let Some(collaboration_session_id) = params.collaboration_session_id {
        match tokio::task::spawn_blocking(move || {
            user_data_db::messages::list_by_collaboration_session(&collaboration_session_id)
        })
        .await
        {
            Ok(Ok(msgs)) => msgs,
            Ok(Err(e)) => {
                return (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(ErrorResponse {
                        error: crate::sanitize_error(&e, "list_messages_by_session"),
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
    } else if let Some(chat_id) = params.chat_id {
        match tokio::task::spawn_blocking(move || user_data_db::messages::list_by_chat(&chat_id))
            .await
        {
            Ok(Ok(msgs)) => msgs,
            Ok(Err(e)) => {
                return (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(ErrorResponse {
                        error: crate::sanitize_error(&e, "list_messages_by_chat"),
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
                error:
                    "至少需要一个查询参数：conversation_id, collaboration_session_id, 或 chat_id"
                        .to_string(),
            }),
        )
            .into_response();
    };

    let response: Vec<MessageResponse> = messages
        .into_iter()
        .map(|m| MessageResponse {
            message_id: m.message_id,
            conversation_id: m.conversation_id,
            sequence: m.sequence,
            role: m.role,
            parts: serde_json::from_str(&m.parts).unwrap_or_default(),
            metadata: m.metadata.and_then(|s| serde_json::from_str(&s).ok()),
            created_at: m.created_at,
            updated_at: m.updated_at,
        })
        .collect();

    (StatusCode::OK, Json(response)).into_response()
}

/// POST /api/v1/messages
#[utoipa::path(
    post,
    path = "/api/v1/messages",
    tag = "Messages",
    request_body = CreateMessageRequest,
    responses(
        (status = 201, description = "Message created", body = MessageResponse),
        (status = 400, description = "Invalid request", body = crate::api::ApiError),
        (status = 404, description = "Conversation not found", body = crate::api::ApiError),
        (status = 500, description = "Internal server error", body = crate::api::ApiError),
    )
)]
pub async fn create_message(Json(req): Json<CreateMessageRequest>) -> impl IntoResponse {
    // Determine parts
    let parts_value = if let Some(parts_value) = req.parts {
        parts_value
    } else if let Some(text) = req.text {
        // Convert text to parts format
        serde_json::json!([{
            "type": "text",
            "text": text
        }])
    } else {
        serde_json::json!([])
    };

    let metadata_value = req.metadata.unwrap_or(serde_json::Value::Null);

    let conversation_id = req.conversation_id.clone();
    let role = req.role.clone();

    match tokio::task::spawn_blocking(move || {
        user_data_db::messages::append(&conversation_id, &role, parts_value, metadata_value)
    })
    .await
    {
        Ok(Ok(message)) => {
            let response = MessageResponse {
                message_id: message.message_id,
                conversation_id: message.conversation_id,
                sequence: message.sequence,
                role: message.role,
                parts: serde_json::from_str(&message.parts).unwrap_or_default(),
                metadata: message
                    .metadata
                    .as_ref()
                    .and_then(|s| serde_json::from_str(s).ok()),
                created_at: message.created_at,
                updated_at: message.updated_at,
            };
            (StatusCode::CREATED, Json(response)).into_response()
        }
        Ok(Err(e)) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse {
                error: crate::sanitize_error(&e, "create_message"),
            }),
        )
            .into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse {
                error: format!("Task join error: {}", e),
            }),
        )
            .into_response(),
    }
}

/// GET /api/v1/messages/{message_id}
#[utoipa::path(
    get,
    path = "/api/v1/messages/{message_id}",
    tag = "Messages",
    params(("message_id" = String, Path, description = "Message ID")),
    responses(
        (status = 200, description = "Message details", body = MessageResponse),
        (status = 404, description = "Message not found", body = crate::api::ApiError),
        (status = 500, description = "Internal server error", body = crate::api::ApiError),
    )
)]
pub async fn get_message(Path(message_id): Path<String>) -> impl IntoResponse {
    match user_data_db::messages::get(&message_id).await {
        Ok(Some(message)) => {
            let response = MessageResponse {
                message_id: message.message_id,
                conversation_id: message.conversation_id,
                sequence: message.sequence,
                role: message.role,
                parts: serde_json::from_str(&message.parts).unwrap_or_default(),
                metadata: message
                    .metadata
                    .as_ref()
                    .and_then(|s| serde_json::from_str(s).ok()),
                created_at: message.created_at,
                updated_at: message.updated_at,
            };
            (StatusCode::OK, Json(response)).into_response()
        }
        Ok(None) => (
            StatusCode::NOT_FOUND,
            Json(ErrorResponse {
                error: format!("Message {} not found", message_id),
            }),
        )
            .into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse {
                error: crate::sanitize_error(&e, "get_message"),
            }),
        )
            .into_response(),
    }
}

/// PATCH /api/v1/messages/{message_id}
#[utoipa::path(
    patch,
    path = "/api/v1/messages/{message_id}",
    tag = "Messages",
    params(("message_id" = String, Path, description = "Message ID")),
    request_body = UpdateMessageRequest,
    responses(
        (status = 200, description = "Message updated", body = MessageResponse),
        (status = 404, description = "Message not found", body = crate::api::ApiError),
        (status = 500, description = "Internal server error", body = crate::api::ApiError),
    )
)]
pub async fn update_message(
    Path(message_id): Path<String>,
    Json(req): Json<UpdateMessageRequest>,
) -> impl IntoResponse {
    let parts = req.parts.and_then(|p| serde_json::to_string(&p).ok());
    let metadata = req.metadata.and_then(|m| serde_json::to_string(&m).ok());

    match user_data_db::messages::update(&message_id, parts, metadata).await {
        Ok(Some(message)) => {
            let response = MessageResponse {
                message_id: message.message_id,
                conversation_id: message.conversation_id,
                sequence: message.sequence,
                role: message.role,
                parts: serde_json::from_str(&message.parts).unwrap_or_default(),
                metadata: message
                    .metadata
                    .as_ref()
                    .and_then(|s| serde_json::from_str(s).ok()),
                created_at: message.created_at,
                updated_at: message.updated_at,
            };
            (StatusCode::OK, Json(response)).into_response()
        }
        Ok(None) => (
            StatusCode::NOT_FOUND,
            Json(ErrorResponse {
                error: format!("Message {} not found", message_id),
            }),
        )
            .into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse {
                error: crate::sanitize_error(&e, "update_message"),
            }),
        )
            .into_response(),
    }
}

/// DELETE /api/v1/messages/{message_id}
#[utoipa::path(
    delete,
    path = "/api/v1/messages/{message_id}",
    tag = "Messages",
    params(("message_id" = String, Path, description = "Message ID")),
    responses(
        (status = 204, description = "Message deleted"),
        (status = 404, description = "Message not found", body = crate::api::ApiError),
        (status = 500, description = "Internal server error", body = crate::api::ApiError),
    )
)]
pub async fn delete_message(Path(message_id): Path<String>) -> impl IntoResponse {
    match user_data_db::messages::delete(&message_id).await {
        Ok(true) => StatusCode::NO_CONTENT.into_response(),
        Ok(false) => (
            StatusCode::NOT_FOUND,
            Json(ErrorResponse {
                error: format!("Message {} not found", message_id),
            }),
        )
            .into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse {
                error: crate::sanitize_error(&e, "delete_message"),
            }),
        )
            .into_response(),
    }
}
