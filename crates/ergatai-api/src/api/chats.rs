//! Chats API endpoints
//!
//! REST API for managing chats (workspaces).

use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use ergatai_core::id::{format as format_id, IdType};
use ergatai_error::{ChatId, WorkspaceId};
use serde::{Deserialize, Serialize};
use utoipa::{IntoParams, ToSchema};

use crate::user_data_db::{self, Chat, DEFAULT_COLLABORATION_MODE};
use crate::AppState;

// ── Request/Response Types ───────────────────────────────────────────────────

#[derive(Debug, Deserialize, IntoParams)]
pub struct ListChatsParams {
    pub workspace_id: Option<String>,
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct CreateChatRequest {
    pub name: Option<String>,
    #[schema(min_length = 1)]
    pub workspace_id: String,
    pub collaboration_mode: Option<String>,
    pub worktree_path: Option<String>,
    pub branch: Option<String>,
    pub base_branch: Option<String>,
    pub pr_url: Option<String>,
    pub pr_number: Option<i32>,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct ChatResponse {
    pub id: String,
    pub name: Option<String>,
    pub workspace_id: String,
    pub collaboration_mode: Option<String>,
    pub worktree_path: Option<String>,
    pub branch: Option<String>,
    pub base_branch: Option<String>,
    pub pr_url: Option<String>,
    pub pr_number: Option<i32>,
    pub created_at: i64,
    pub updated_at: i64,
    pub archived_at: Option<i64>,
}

#[derive(Debug, Serialize)]
pub struct ErrorResponse {
    pub error: String,
}

fn db_error(operation: &'static str, error: rusqlite::Error) -> Response {
    crate::http_error::internal(error, operation).into_response()
}

// ── Helper Functions ─────────────────────────────────────────────────────────

fn chat_to_response(chat: Chat) -> ChatResponse {
    ChatResponse {
        id: chat.chat_id.to_string(),
        name: chat.name,
        workspace_id: chat.workspace_id.to_string(),
        collaboration_mode: chat.collaboration_mode,
        worktree_path: chat.worktree_path,
        branch: chat.branch,
        base_branch: chat.base_branch,
        pr_url: chat.pr_url,
        pr_number: chat.pr_number,
        created_at: chat.created_at,
        updated_at: chat.updated_at,
        archived_at: chat.archived_at,
    }
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
    let workspace_id = match params.workspace_id.as_deref() {
        Some(ws_id) => match crate::http_error::parse_typed_id::<WorkspaceId>(ws_id, "Workspace") {
            Ok(id) => Some(id),
            Err((status, json)) => return (status, json).into_response(),
        },
        None => None,
    };
    match tokio::task::spawn_blocking(move || user_data_db::chats::list(workspace_id)).await {
        Ok(Ok(chats)) => {
            let response: Vec<ChatResponse> = chats.into_iter().map(chat_to_response).collect();
            (StatusCode::OK, Json(response)).into_response()
        }
        Ok(Err(error)) => db_error("Failed to list chats", error),
        Err(e) => crate::http_error::internal(e, "list_chats_join").into_response(),
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
        (status = 401, description = "Unauthorized", body = crate::api::ApiError),
        (status = 415, description = "Unsupported Media Type", body = crate::api::ApiError),
        (status = 422, description = "Validation error", body = crate::api::ApiError),
        (status = 500, description = "Internal server error", body = crate::api::ApiError),
    )
)]
pub async fn create_chat(
    State(_state): State<AppState>,
    Json(req): Json<CreateChatRequest>,
) -> impl IntoResponse {
    // Validate workspace_id
    if req.workspace_id.is_empty() {
        return crate::http_error::bad_request("Workspace ID cannot be empty").into_response();
    }

    let workspace_id_for_check =
        match crate::http_error::parse_typed_id::<WorkspaceId>(&req.workspace_id, "Workspace") {
            Ok(id) => id,
            Err((status, json)) => return (status, json).into_response(),
        };
    match tokio::task::spawn_blocking(move || user_data_db::workspaces::get(workspace_id_for_check))
        .await
    {
        Ok(Ok(Some(_))) => {}
        Ok(Ok(None)) => {
            return crate::http_error::not_found("Workspace", &req.workspace_id).into_response();
        }
        Ok(Err(error)) => {
            return db_error("Failed to validate workspace", error);
        }
        Err(e) => {
            return crate::http_error::internal(e, "validate_workspace_join").into_response();
        }
    }

    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs() as i64;

    let workspace_id_for_create =
        match crate::http_error::parse_typed_id::<WorkspaceId>(&req.workspace_id, "Workspace") {
            Ok(id) => id,
            Err((status, json)) => return (status, json).into_response(),
        };

    let chat = Chat {
        chat_id: ChatId::generate(),
        name: req.name,
        workspace_id: workspace_id_for_create,
        collaboration_mode: req
            .collaboration_mode
            .or_else(|| Some(DEFAULT_COLLABORATION_MODE.to_string())),
        worktree_path: req.worktree_path,
        branch: req.branch,
        base_branch: req.base_branch,
        pr_url: req.pr_url,
        pr_number: req.pr_number,
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
        Err(e) => crate::http_error::internal(e, "create_chat_join").into_response(),
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
        (status = 401, description = "Unauthorized", body = crate::api::ApiError),
        (status = 404, description = "Chat not found", body = crate::api::ApiError),
        (status = 500, description = "Internal server error", body = crate::api::ApiError),
    )
)]
pub async fn get_chat(State(_state): State<AppState>, Path(id): Path<String>) -> impl IntoResponse {
    let id = match crate::http_error::parse_typed_id::<ChatId>(&id, "Chat") {
        Ok(id) => id,
        Err((status, json)) => return (status, json).into_response(),
    };
    match tokio::task::spawn_blocking(move || user_data_db::chats::get(id)).await {
        Ok(Ok(Some(chat))) => {
            let response = chat_to_response(chat);
            (StatusCode::OK, Json(response)).into_response()
        }
        Ok(Ok(None)) => crate::http_error::not_found("Chat", &id.to_string()).into_response(),
        Ok(Err(error)) => db_error("Failed to get chat", error),
        Err(e) => crate::http_error::internal(e, "get_chat_join").into_response(),
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
        (status = 401, description = "Unauthorized", body = crate::api::ApiError),
        (status = 500, description = "Internal server error", body = crate::api::ApiError),
    )
)]
pub async fn archive_chat(
    State(_state): State<AppState>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    let id = match crate::http_error::parse_typed_id::<ChatId>(&id, "Chat") {
        Ok(id) => id,
        Err((status, json)) => return (status, json).into_response(),
    };
    match tokio::task::spawn_blocking(move || user_data_db::chats::archive(id)).await {
        Ok(Ok(_)) => StatusCode::NO_CONTENT.into_response(),
        Ok(Err(error)) => db_error("Failed to archive chat", error),
        Err(e) => crate::http_error::internal(e, "archive_chat_join").into_response(),
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
        (status = 401, description = "Unauthorized", body = crate::api::ApiError),
        (status = 500, description = "Internal server error", body = crate::api::ApiError),
    )
)]
pub async fn unarchive_chat(
    State(_state): State<AppState>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    let id = match crate::http_error::parse_typed_id::<ChatId>(&id, "Chat") {
        Ok(id) => id,
        Err((status, json)) => return (status, json).into_response(),
    };
    match tokio::task::spawn_blocking(move || user_data_db::chats::unarchive(id)).await {
        Ok(Ok(_)) => StatusCode::NO_CONTENT.into_response(),
        Ok(Err(error)) => db_error("Failed to unarchive chat", error),
        Err(e) => crate::http_error::internal(e, "unarchive_chat_join").into_response(),
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
    let id = match crate::http_error::parse_typed_id::<ChatId>(&id, "Chat") {
        Ok(id) => id,
        Err((status, json)) => return (status, json).into_response(),
    };
    match tokio::task::spawn_blocking(move || user_data_db::chats::delete(id)).await {
        Ok(Ok(_)) => StatusCode::NO_CONTENT.into_response(),
        Ok(Err(error)) => db_error("Failed to delete chat", error),
        Err(e) => crate::http_error::internal(e, "delete_chat_join").into_response(),
    }
}

/// GET /api/v1/chats/{chat_id}/agents — 列出该 chat 下绑定的 agent
#[utoipa::path(
    get,
    path = "/api/v1/chats/{chat_id}/agents",
    tag = "Chats",
    params(("chat_id" = String, Path, description = "Chat ID")),
    responses(
        (status = 200, description = "List bound agents for this chat, including stopped bindings"),
        (status = 500, description = "Internal server error", body = crate::api::ApiError),
    )
)]
pub async fn list_chat_agents(
    State(_state): State<AppState>,
    Path(chat_id): Path<String>,
) -> Response {
    // 1. 查询该 chat 下所有 conversations
    let chat_id = match crate::http_error::parse_typed_id::<ChatId>(&chat_id, "Chat") {
        Ok(id) => id,
        Err((status, json)) => return (status, json).into_response(),
    };
    let chat_exists = matches!(
        tokio::task::spawn_blocking({
            let cid = chat_id;
            move || crate::user_data_db::chats::get(cid)
        })
        .await,
        Ok(Ok(Some(_)))
    );
    if !chat_exists {
        return crate::http_error::not_found("Chat", &chat_id.to_string()).into_response();
    }
    let conversations = match tokio::task::spawn_blocking({
        move || crate::user_data_db::conversations::list_by_chat(chat_id)
    })
    .await
    {
        Ok(Ok(convs)) => convs,
        Ok(Err(e)) => return crate::http_error::internal(e, "list conversations").into_response(),
        Err(e) => return crate::http_error::internal(e, "task join error").into_response(),
    };

    // 2. 查询每个 conversation 的运行中 agent；停止的 binding 在后面补齐
    //    同时查询 group_agent_bindings 以获取绑定创建时间（而非最后心跳时间），
    //    使前端 dedup 逻辑能基于绑定时间而非心跳时间。
    let registry = crate::context::get_app_context()
        .agent_runtime
        .registry()
        .clone();
    let mut agents = Vec::new();
    let mut represented_binding_ids = std::collections::HashSet::new();

    let bindings: Vec<crate::user_data_db::GroupAgentBinding> = match tokio::task::spawn_blocking(
        move || crate::user_data_db::group_agent_bindings::list(chat_id),
    )
    .await
    {
        Ok(Ok(b)) => b,
        Ok(Err(e)) => {
            tracing::warn!(error = %e, "Failed to list agent bindings for chat; falling back to heartbeat timestamps");
            Vec::new()
        }
        Err(e) => {
            tracing::warn!(error = %e, "Task join error listing agent bindings");
            Vec::new()
        }
    };

    for conv in conversations {
        let conversation_id_str = conv.conversation_id.to_string();
        if let Some(agent) = registry.resolve_conversation_id(&conversation_id_str).await {
            if agent.lifecycle.is_alive() {
                // Prefer the binding's created_at/updated_at (stable binding time)
                // over last_heartbeat (frequently-updated activity timestamp).
                let (created_at, updated_at) = bindings
                    .iter()
                    .find(|b| b.conversation_id.to_string() == conversation_id_str)
                    .map(|b| {
                        represented_binding_ids.insert(b.agent_id);
                        (b.created_at, b.updated_at)
                    })
                    .unwrap_or_else(|| {
                        let hb = agent.last_heartbeat.timestamp();
                        (hb, hb)
                    });
                agents.push(serde_json::json!({
                    "agent_id": agent.agent_id,
                    "conversation_id": conversation_id_str,
                    "state": format!("{:?}", agent.lifecycle),
                    "profile": agent.profile,
                    "last_heartbeat": agent.last_heartbeat,
                    "created_at": created_at,
                    "updated_at": updated_at,
                }));
            }
        }
    }

    // Agent bindings are durable, while the runtime registry only contains
    // alive processes. Include stopped bindings so historical messages can
    // still resolve a sender to its configured profile/display name.
    for binding in &bindings {
        if represented_binding_ids.contains(&binding.agent_id) {
            continue;
        }

        agents.push(serde_json::json!({
            "agent_id": format_id(binding.agent_id, IdType::Agent),
            "conversation_id": binding.conversation_id.to_string(),
            "state": "Stopped",
            "profile": binding.agent_command,
            "last_heartbeat": "",
            "created_at": binding.created_at,
            "updated_at": binding.updated_at,
        }));
    }

    // 3. 统计状态
    let running = agents
        .iter()
        .filter(|a| a["state"].as_str().unwrap_or("").contains("Processing"))
        .count();
    let idle = agents
        .iter()
        .filter(|a| a["state"].as_str().unwrap_or("").contains("Idle"))
        .count();

    Json(serde_json::json!({
        "agents": agents,
        "total": agents.len(),
        "running": running,
        "idle": idle
    }))
    .into_response()
}

/// GET /api/v1/chats/{chat_id}/agent-graph — 获取 agent 拓扑图谱
#[utoipa::path(
    get,
    path = "/api/v1/chats/{chat_id}/agent-graph",
    tag = "Chats",
    params(("chat_id" = String, Path, description = "Chat ID")),
    responses(
        (status = 200, description = "Agent topology graph"),
        (status = 500, description = "Internal server error", body = crate::api::ApiError),
    )
)]
pub async fn get_agent_graph(
    State(_state): State<AppState>,
    Path(chat_id): Path<String>,
) -> Response {
    // 0. Ensure the chat still exists (deleted chats must yield 404).
    let chat_id = match crate::http_error::parse_typed_id::<ChatId>(&chat_id, "Chat") {
        Ok(id) => id,
        Err((status, json)) => return (status, json).into_response(),
    };
    match tokio::task::spawn_blocking(move || crate::user_data_db::chats::get(chat_id)).await {
        Ok(Ok(Some(_))) => {}
        Ok(Ok(None)) => {
            return crate::http_error::not_found("Chat", &chat_id.to_string()).into_response();
        }
        Ok(Err(e)) => return crate::http_error::internal(e, "get chat").into_response(),
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({ "error": format!("Task join error: {}", e) })),
            )
                .into_response();
        }
    }
    let conversations = match tokio::task::spawn_blocking({
        move || crate::user_data_db::conversations::list_by_chat(chat_id)
    })
    .await
    {
        Ok(Ok(convs)) => convs,
        Ok(Err(e)) => return crate::http_error::internal(e, "list conversations").into_response(),
        Err(e) => return crate::http_error::internal(e, "task join error").into_response(),
    };

    // 2. 查询每个 conversation 的 agent，构建节点
    let registry = crate::context::get_app_context()
        .agent_runtime
        .registry()
        .clone();
    let mut nodes = Vec::new();
    let mut conversation_to_agent: std::collections::HashMap<String, String> =
        std::collections::HashMap::new();
    let mut agent_to_session: std::collections::HashMap<String, String> =
        std::collections::HashMap::new();

    for conv in &conversations {
        let conversation_id_str = conv.conversation_id.to_string();
        if let Some(agent) = registry.resolve_conversation_id(&conversation_id_str).await {
            if agent.lifecycle.is_alive() {
                let agent_id = agent.agent_id.clone();
                let state_str = format!("{:?}", agent.lifecycle);

                nodes.push(serde_json::json!({
                    "id": agent_id,
                    "conversation_id": conversation_id_str,
                    "state": state_str,
                    "profile": agent.profile,
                    "capabilities": agent.capabilities,
                    "is_alive": true,
                }));

                conversation_to_agent.insert(conversation_id_str.clone(), agent_id.clone());
                agent_to_session.insert(agent_id, conv.collaboration_session_id.to_string());
            }
        }
    }

    // 3. 构建边：基于 collaboration session 的关系
    // 如果两个 agent 属于同一个 collaboration session，则它们之间有一条边
    let mut session_to_agents: std::collections::HashMap<String, Vec<String>> =
        std::collections::HashMap::new();
    for (agent_id, session_id) in &agent_to_session {
        session_to_agents
            .entry(session_id.clone())
            .or_default()
            .push(agent_id.clone());
    }

    let mut edges = Vec::new();
    for agents_in_session in session_to_agents.values() {
        // 对于同一 session 中的 agent，构建完全连接的边
        for i in 0..agents_in_session.len() {
            for j in (i + 1)..agents_in_session.len() {
                edges.push(serde_json::json!({
                    "source": agents_in_session[i],
                    "target": agents_in_session[j],
                    "relation": "same_session",
                }));
            }
        }
    }

    // 4. 统计
    let total_nodes = nodes.len();
    let running = nodes
        .iter()
        .filter(|n| n["state"].as_str().unwrap_or("").contains("Processing"))
        .count();
    let idle = nodes
        .iter()
        .filter(|n| n["state"].as_str().unwrap_or("").contains("Idle"))
        .count();
    let unique_sessions = session_to_agents.len();

    Json(serde_json::json!({
        "chat_id": chat_id,
        "nodes": nodes,
        "edges": edges,
        "metadata": {
            "total_nodes": total_nodes,
            "total_edges": edges.len(),
            "running": running,
            "idle": idle,
            "collaboration_sessions": unique_sessions,
        }
    }))
    .into_response()
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
    path = "/api/v1/chats/{id}",
    tag = "Chats",
    params(("id" = String, Path, description = "Chat ID")),
    request_body = PatchChatRequest,
    responses(
        (status = 200, description = "Chat updated", body = ChatResponse),
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
    let chat_id_for_get = match crate::http_error::parse_typed_id::<ChatId>(&chat_id, "Chat") {
        Ok(id) => id,
        Err((status, json)) => return (status, json).into_response(),
    };
    match tokio::task::spawn_blocking(move || user_data_db::chats::get(chat_id_for_get)).await {
        Ok(Ok(Some(chat))) => {
            // Update fields
            let updated = user_data_db::Chat {
                name: req.name.or(chat.name),
                collaboration_mode: req.collaboration_mode.or(chat.collaboration_mode),
                worktree_path: req.worktree_path.or(chat.worktree_path),
                branch: req.branch.or(chat.branch),
                base_branch: req.base_branch.or(chat.base_branch),
                pr_url: req.pr_url.or(chat.pr_url),
                pr_number: req.pr_number.or(chat.pr_number),
                updated_at: std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_secs() as i64,
                ..chat
            };

            match tokio::task::spawn_blocking(move || user_data_db::chats::update(updated)).await {
                Ok(Ok(())) => {
                    // Fetch updated chat
                    let chat_id_for_refetch =
                        match crate::http_error::parse_typed_id::<ChatId>(&chat_id, "Chat") {
                            Ok(id) => id,
                            Err((status, json)) => return (status, json).into_response(),
                        };
                    match tokio::task::spawn_blocking(move || {
                        user_data_db::chats::get(chat_id_for_refetch)
                    })
                    .await
                    {
                        Ok(Ok(Some(updated_chat))) => {
                            let response = chat_to_response(updated_chat);
                            (StatusCode::OK, Json(response)).into_response()
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
