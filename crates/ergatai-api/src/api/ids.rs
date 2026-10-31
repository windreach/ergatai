//! HTTP handlers for backend-issued identifiers.

use axum::{
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use serde::Serialize;
use utoipa::ToSchema;

#[derive(Debug, Serialize, ToSchema)]
pub struct MessageIdResponse {
    pub message_id: String,
}

/// GET /api/v1/ids/message
#[utoipa::path(
    get,
    path = "/api/v1/ids/message",
    tag = "Identifiers",
    responses(
        (status = 200, description = "Backend-issued message identifier", body = MessageIdResponse),
    )
)]
pub async fn next_message_id() -> Response {
    (
        StatusCode::OK,
        Json(MessageIdResponse {
            message_id: ergatai_error::MessageId::generate().encode(),
        }),
    )
        .into_response()
}
