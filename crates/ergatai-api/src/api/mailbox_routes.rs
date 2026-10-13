//! REST API routes for mailbox management
//!
//! Provides endpoints to query and manage agent mailboxes:
//! - GET /api/v1/mailbox — list all mailboxes (summary)
//! - GET /api/v1/agents/{id}/mailbox — get mailbox for specific agent
//! - DELETE /api/v1/agents/{id}/mailbox — clear mailbox for agent

use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::IntoResponse,
    Json,
};
use serde::Serialize;

use crate::messaging::mailbox::get_mailbox_manager;
use crate::AppState;

/// Response for mailbox not found
#[derive(Debug, Serialize)]
pub struct MailboxNotFound {
    pub error: String,
    pub agent_id: String,
}

/// GET /api/v1/mailbox — list all mailboxes with summary
pub async fn list_mailboxes(
    State(_state): State<AppState>,
) -> impl IntoResponse {
    let manager = match get_mailbox_manager() {
        Some(m) => m,
        None => {
            return crate::http_error::internal("MailboxManager not initialized", "mailbox_operation")
                .into_response();
        }
    };

    let summary = manager.get_summary();
    let mailboxes = manager.list_mailboxes();

    (
        StatusCode::OK,
        Json(serde_json::json!({
            "summary": summary,
            "mailboxes": mailboxes
        })),
    )
        .into_response()
}

/// GET /api/v1/mailbox/summary — get mailbox summary only
pub async fn get_mailbox_summary(
    State(_state): State<AppState>,
) -> impl IntoResponse {
    let manager = match get_mailbox_manager() {
        Some(m) => m,
        None => {
            return crate::http_error::internal("MailboxManager not initialized", "mailbox_operation")
                .into_response();
        }
    };

    let summary = manager.get_summary();
    (StatusCode::OK, Json(summary)).into_response()
}

/// GET /api/v1/agents/{id}/mailbox — get mailbox for specific agent
pub async fn get_agent_mailbox(
    State(_state): State<AppState>,
    Path(agent_id): Path<String>,
) -> impl IntoResponse {
    let manager = match get_mailbox_manager() {
        Some(m) => m,
        None => {
            return crate::http_error::internal("MailboxManager not initialized", "mailbox_operation")
                .into_response();
        }
    };

    match manager.get_mailbox(&agent_id) {
        Some(mailbox) => (StatusCode::OK, Json(mailbox)).into_response(),
        None => (
            StatusCode::NOT_FOUND,
            Json(MailboxNotFound {
                error: format!("Mailbox not found for agent: {}", agent_id),
                agent_id,
            }),
        )
            .into_response(),
    }
}

/// DELETE /api/v1/agents/{id}/mailbox — clear mailbox for agent
pub async fn clear_agent_mailbox(
    State(_state): State<AppState>,
    Path(agent_id): Path<String>,
) -> impl IntoResponse {
    let manager = match get_mailbox_manager() {
        Some(m) => m,
        None => {
            return crate::http_error::internal("MailboxManager not initialized", "mailbox_operation")
                .into_response();
        }
    };

    manager.clear_mailbox(&agent_id);

    (
        StatusCode::OK,
        Json(serde_json::json!({
            "status": "cleared",
            "agent_id": agent_id
        })),
    )
        .into_response()
}
