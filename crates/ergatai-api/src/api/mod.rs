pub mod acp_server;
pub mod activity;
pub mod activity_routes;
pub mod agent_profiles;
pub mod agents;
pub mod chats;
pub mod collaboration_sessions;
pub mod locks;
pub mod mcp_servers;
pub mod openapi;
pub mod permissions;
pub mod status;
pub mod terminal_sessions;
pub mod user_conversations;
pub mod validation;
pub mod workspaces;

use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

#[derive(Debug, Serialize, Deserialize, ToSchema)]
pub struct ApiError {
    pub error: String,
}
