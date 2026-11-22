use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    response::IntoResponse,
    Json,
};
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

use crate::{
    http_error::internal,
    services::provider_connection_service,
    user_data_db::provider_connections::{ProviderConnection, ProviderConnectionUpsert},
    AppState,
};

#[derive(Debug, Deserialize, ToSchema)]
pub struct NativeConfigQuery {
    pub agent_id: String,
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct ImportNativeConfigRequest {
    /// Owning agent profile name (e.g. "claude-code").
    pub agent_id: String,
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct CopyProviderConnectionRequest {
    /// Source connection to copy.
    pub id: String,
    /// Target agent profile name that will own the copied connection.
    pub agent_id: String,
    /// Optional name for the copied connection (defaults to the source name).
    pub name: Option<String>,
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct ProviderConnectionInput {
    pub id: Option<String>,
    pub name: String,
    /// Owning agent profile name (e.g. "claude-code"). Required: a connection
    /// belongs to exactly one agent, and an agent may own many connections.
    pub agent_id: String,
    pub protocol: String,
    pub base_url: Option<String>,
    pub default_model: Option<String>,
    #[serde(default)]
    pub is_default: bool,
    /// Accepted on write only and never returned in list/get responses.
    pub api_key: Option<String>,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct ProviderConnectionMutationResponse {
    pub connection: ProviderConnection,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct ProviderConnectionDeleteResponse {
    pub deleted: bool,
}

#[utoipa::path(
    get,
    path = "/api/v1/provider-connections",
    tag = "Provider Connections",
    responses(
        (status = 200, description = "Provider connections", body = [ProviderConnection]),
        (status = 500, description = "Internal server error", body = crate::api::ApiError)
    )
)]
pub async fn list_provider_connections(
    State(_state): State<AppState>,
) -> impl axum::response::IntoResponse {
    match tokio::task::spawn_blocking(provider_connection_service::list).await {
        Ok(Ok(connections)) => Json(
            connections
                .into_iter()
                .map(provider_connection_service::with_secret_hint)
                .collect::<Vec<_>>(),
        )
        .into_response(),
        Ok(Err(error)) => internal(error, "list_provider_connections").into_response(),
        Err(error) => internal(error, "list_provider_connections_join").into_response(),
    }
}

/// Detect the agent's own default configuration (from its config files).
/// The API key is never returned — only whether one exists.
#[utoipa::path(
    get,
    path = "/api/v1/provider-connections/native",
    tag = "Provider Connections",
    params(("agent_id" = String, Query, description = "Owning agent profile name")),
    responses(
        (status = 200, description = "Native agent configuration (null when none found)", body = Option<crate::services::native_agent_config::NativeAgentConfig>),
        (status = 500, description = "Internal server error", body = crate::api::ApiError)
    )
)]
pub async fn detect_native_config(
    Query(query): Query<NativeConfigQuery>,
) -> impl axum::response::IntoResponse {
    let kind = crate::services::agent::resolve_kind_by_name(&query.agent_id).await;
    let agent_id = query.agent_id.clone();
    match tokio::task::spawn_blocking(move || {
        if kind == crate::services::agent::AgentKind::Unknown {
            crate::services::native_agent_config::detect(&agent_id)
        } else {
            crate::services::agent::detect_native_config(kind)
        }
    })
    .await
    {
        Ok(Ok(config)) => Json(config).into_response(),
        Ok(Err(error)) => internal(error, "detect_native_config").into_response(),
        Err(error) => internal(error, "detect_native_config_join").into_response(),
    }
}

/// Import the agent's native default configuration as a provider connection
/// owned by that agent (becomes the agent's default).
#[utoipa::path(
    post,
    path = "/api/v1/provider-connections/import-native",
    tag = "Provider Connections",
    request_body = ImportNativeConfigRequest,
    responses(
        (status = 200, description = "Imported connection", body = ProviderConnectionMutationResponse),
        (status = 400, description = "No native configuration found", body = crate::api::ApiError),
        (status = 500, description = "Internal server error", body = crate::api::ApiError)
    )
)]
pub async fn import_native_config(
    Json(request): Json<ImportNativeConfigRequest>,
) -> impl axum::response::IntoResponse {
    if request.agent_id.trim().is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(crate::ErrorResponse {
                error: "agent_id is required".to_string(),
            }),
        )
            .into_response();
    }
    let agent_id = request.agent_id.trim().to_string();
    let kind = crate::services::agent::resolve_kind_by_name(&agent_id).await;
    match tokio::task::spawn_blocking(move || {
        crate::services::native_agent_config::import_for_kind(kind, &agent_id)
    })
    .await
    {
        Ok(Ok(connection)) => (
            StatusCode::OK,
            Json(ProviderConnectionMutationResponse {
                connection: provider_connection_service::with_secret_hint(connection),
            }),
        )
            .into_response(),
        Ok(Err(error)) => internal(error, "import_native_config").into_response(),
        Err(error) => internal(error, "import_native_config_join").into_response(),
    }
}

#[utoipa::path(
    post,
    path = "/api/v1/provider-connections/copy",
    tag = "Provider Connections",
    request_body = CopyProviderConnectionRequest,
    responses(
        (status = 200, description = "Copied provider connection", body = ProviderConnectionMutationResponse),
        (status = 400, description = "Invalid copy request", body = crate::api::ApiError),
        (status = 500, description = "Internal server error", body = crate::api::ApiError)
    )
)]
pub async fn copy_provider_connection(
    Json(input): Json<CopyProviderConnectionRequest>,
) -> impl axum::response::IntoResponse {
    if input.agent_id.trim().is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(crate::ErrorResponse {
                error: "agent_id is required".to_string(),
            }),
        )
            .into_response();
    }
    match tokio::task::spawn_blocking(move || {
        provider_connection_service::copy_to_agent(
            &input.id,
            &input.agent_id,
            input.name.as_deref(),
        )
    })
    .await
    {
        Ok(Ok(connection)) => (
            StatusCode::OK,
            Json(ProviderConnectionMutationResponse { connection }),
        )
            .into_response(),
        Ok(Err(error)) => internal(error, "copy_provider_connection").into_response(),
        Err(error) => internal(error, "copy_provider_connection_join").into_response(),
    }
}

#[utoipa::path(
    post,
    path = "/api/v1/provider-connections",
    tag = "Provider Connections",
    request_body = ProviderConnectionInput,
    responses(
        (status = 200, description = "Created or updated provider connection", body = ProviderConnectionMutationResponse),
        (status = 400, description = "Invalid provider connection", body = crate::api::ApiError),
        (status = 500, description = "Internal server error", body = crate::api::ApiError)
    )
)]
pub async fn create_or_update_provider_connection(
    State(_state): State<AppState>,
    Json(input): Json<ProviderConnectionInput>,
) -> impl axum::response::IntoResponse {
    if input.name.trim().is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(crate::ErrorResponse {
                error: "name is required".to_string(),
            }),
        )
            .into_response();
    }
    if input.agent_id.trim().is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(crate::ErrorResponse {
                error: "agent_id is required: a provider connection belongs to exactly one agent"
                    .to_string(),
            }),
        )
            .into_response();
    }

    let result = tokio::task::spawn_blocking(move || {
        provider_connection_service::upsert(
            ProviderConnectionUpsert {
                id: input.id,
                name: input.name,
                agent_id: input.agent_id,
                protocol: input.protocol,
                base_url: input.base_url,
                default_model: input.default_model,
                is_default: input.is_default,
            },
            input.api_key.as_deref(),
        )
    })
    .await;

    match result {
        Ok(Ok(connection)) => (
            StatusCode::OK,
            Json(ProviderConnectionMutationResponse {
                connection: provider_connection_service::with_secret_hint(connection),
            }),
        )
            .into_response(),
        Ok(Err(error)) => internal(error, "save_provider_connection").into_response(),
        Err(error) => internal(error, "save_provider_connection_join").into_response(),
    }
}

#[utoipa::path(
    post,
    path = "/api/v1/provider-connections/{id}/default",
    tag = "Provider Connections",
    params(("id" = String, Path, description = "Provider connection ID")),
    responses(
        (status = 200, description = "Default provider connection", body = ProviderConnectionMutationResponse),
        (status = 404, description = "Provider connection not found", body = crate::api::ApiError),
        (status = 500, description = "Internal server error", body = crate::api::ApiError)
    )
)]
pub async fn set_default_provider_connection(
    State(_state): State<AppState>,
    Path(id): Path<String>,
) -> impl axum::response::IntoResponse {
    match tokio::task::spawn_blocking(move || provider_connection_service::set_default(&id)).await {
        Ok(Ok(connection)) => (
            StatusCode::OK,
            Json(ProviderConnectionMutationResponse {
                connection: provider_connection_service::with_secret_hint(connection),
            }),
        )
            .into_response(),
        Ok(Err(error)) => internal(error, "set_default_provider_connection").into_response(),
        Err(error) => internal(error, "set_default_provider_connection_join").into_response(),
    }
}

#[utoipa::path(
    delete,
    path = "/api/v1/provider-connections/{id}",
    tag = "Provider Connections",
    params(("id" = String, Path, description = "Provider connection ID")),
    responses(
        (status = 200, description = "Deletion result", body = ProviderConnectionDeleteResponse),
        (status = 404, description = "Provider connection not found", body = crate::api::ApiError),
        (status = 500, description = "Internal server error", body = crate::api::ApiError)
    )
)]
pub async fn delete_provider_connection(
    State(_state): State<AppState>,
    Path(id): Path<String>,
) -> impl axum::response::IntoResponse {
    match tokio::task::spawn_blocking(move || provider_connection_service::delete(&id)).await {
        Ok(Ok(deleted)) => Json(ProviderConnectionDeleteResponse { deleted }).into_response(),
        Ok(Err(error)) => internal(error, "delete_provider_connection").into_response(),
        Err(error) => internal(error, "delete_provider_connection_join").into_response(),
    }
}
