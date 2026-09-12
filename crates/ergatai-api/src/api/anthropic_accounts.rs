//! Anthropic Accounts API endpoints
//!
//! REST API for managing Anthropic OAuth accounts. The backend is the
//! single source of truth for credential storage; the UI proxies here.

use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::IntoResponse,
    Json,
};
use serde::{Deserialize, Serialize};

use crate::user_data_db::{self, AnthropicAccount};
use crate::AppState;

// ── Request/Response Types ───────────────────────────────────────────────

#[derive(Debug, Deserialize)]
pub struct CreateAccountRequest {
    pub id: String,
    pub user_id: String,
    pub email: Option<String>,
    pub display_name: Option<String>,
    pub encrypted_access_token: String,
    pub encrypted_refresh_token: Option<String>,
    pub token_expires_at: Option<i64>,
}

#[derive(Debug, Deserialize)]
pub struct SetActiveRequest {
    pub account_id: String,
}

#[derive(Debug, Deserialize)]
pub struct UpdateDisplayNameRequest {
    pub display_name: String,
}

#[derive(Debug, Serialize)]
pub struct AccountResponse {
    pub id: String,
    pub user_id: String,
    pub email: Option<String>,
    pub display_name: Option<String>,
    pub encrypted_access_token: String,
    pub encrypted_refresh_token: Option<String>,
    pub token_expires_at: Option<i64>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Serialize)]
pub struct ErrorResponse {
    pub error: String,
}

fn account_to_response(account: AnthropicAccount) -> AccountResponse {
    AccountResponse {
        id: account.id,
        user_id: account.user_id,
        email: account.email,
        display_name: account.display_name,
        encrypted_access_token: account.encrypted_access_token,
        encrypted_refresh_token: account.encrypted_refresh_token,
        token_expires_at: account.token_expires_at,
        created_at: account.created_at,
        updated_at: account.updated_at,
    }
}

fn now_unix() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}

// ── Handlers ─────────────────────────────────────────────────────────────

/// GET /api/v1/anthropic-accounts
pub async fn list_accounts(_state: State<AppState>) -> impl IntoResponse {
    match user_data_db::anthropic_accounts::list() {
        Ok(accounts) => {
            let response: Vec<AccountResponse> =
                accounts.into_iter().map(account_to_response).collect();
            (StatusCode::OK, Json(response)).into_response()
        }
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse {
                error: e.to_string(),
            }),
        )
            .into_response(),
    }
}

/// POST /api/v1/anthropic-accounts
pub async fn create_account(
    State(_state): State<AppState>,
    Json(req): Json<CreateAccountRequest>,
) -> impl IntoResponse {
    let account = AnthropicAccount {
        id: req.id,
        user_id: req.user_id,
        email: req.email,
        display_name: req.display_name,
        encrypted_access_token: req.encrypted_access_token,
        encrypted_refresh_token: req.encrypted_refresh_token,
        token_expires_at: req.token_expires_at,
        created_at: now_unix(),
        updated_at: now_unix(),
    };

    match user_data_db::anthropic_accounts::create(account) {
        Ok(created) => (StatusCode::CREATED, Json(account_to_response(created))).into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse {
                error: e.to_string(),
            }),
        )
            .into_response(),
    }
}

/// GET /api/v1/anthropic-accounts/:id
pub async fn get_account(
    State(_state): State<AppState>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    match user_data_db::anthropic_accounts::get(&id) {
        Ok(Some(account)) => (StatusCode::OK, Json(account_to_response(account))).into_response(),
        Ok(None) => (
            StatusCode::NOT_FOUND,
            Json(ErrorResponse {
                error: "Account not found".to_string(),
            }),
        )
            .into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse {
                error: e.to_string(),
            }),
        )
            .into_response(),
    }
}

/// DELETE /api/v1/anthropic-accounts/:id
pub async fn delete_account(
    State(_state): State<AppState>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    match user_data_db::anthropic_accounts::delete(&id) {
        Ok(true) => (StatusCode::OK, Json(serde_json::json!({"success": true}))).into_response(),
        Ok(false) => (
            StatusCode::NOT_FOUND,
            Json(ErrorResponse {
                error: "Account not found".to_string(),
            }),
        )
            .into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse {
                error: e.to_string(),
            }),
        )
            .into_response(),
    }
}

/// GET /api/v1/anthropic-accounts/active
pub async fn get_active_account(_state: State<AppState>) -> impl IntoResponse {
    match user_data_db::anthropic_accounts::get_active() {
        Ok(Some(account)) => (StatusCode::OK, Json(account_to_response(account))).into_response(),
        Ok(None) => (
            StatusCode::NOT_FOUND,
            Json(ErrorResponse {
                error: "No active account".to_string(),
            }),
        )
            .into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse {
                error: e.to_string(),
            }),
        )
            .into_response(),
    }
}

/// POST /api/v1/anthropic-accounts/active
pub async fn set_active_account(
    State(_state): State<AppState>,
    Json(req): Json<SetActiveRequest>,
) -> impl IntoResponse {
    match user_data_db::anthropic_accounts::set_active(&req.account_id) {
        Ok(true) => (StatusCode::OK, Json(serde_json::json!({"success": true}))).into_response(),
        Ok(false) => (
            StatusCode::NOT_FOUND,
            Json(ErrorResponse {
                error: "Account not found".to_string(),
            }),
        )
            .into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse {
                error: e.to_string(),
            }),
        )
            .into_response(),
    }
}

/// PUT /api/v1/anthropic-accounts/:id/display-name
pub async fn update_display_name(
    State(_state): State<AppState>,
    Path(id): Path<String>,
    Json(req): Json<UpdateDisplayNameRequest>,
) -> impl IntoResponse {
    match user_data_db::anthropic_accounts::update_display_name(&id, &req.display_name) {
        Ok(true) => (StatusCode::OK, Json(serde_json::json!({"success": true}))).into_response(),
        Ok(false) => (
            StatusCode::NOT_FOUND,
            Json(ErrorResponse {
                error: "Account not found".to_string(),
            }),
        )
            .into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse {
                error: e.to_string(),
            }),
        )
            .into_response(),
    }
}
