pub mod acp_server;
pub mod activity;
pub mod activity_routes;
pub mod agent_profiles;
pub mod agents;
pub mod chats;
pub mod collab_runtime;
pub mod conversations;
pub mod locks;
pub mod openapi;
pub mod permissions;
pub mod projects;
pub mod status;
pub mod user_conversations;
pub mod workspaces;

use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

#[derive(Debug, Serialize, Deserialize, ToSchema)]
pub struct ApiError {
    pub error: String,
}
