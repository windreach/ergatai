//! MCP (Model Context Protocol) module
//!
//! Implements the MCP server for agent communication using rmcp SDK.
//! Supports MCP protocol 2025-06-18 with Streamable HTTP transport.

pub mod agent_binding;
pub mod conversation;
pub mod message_delivery;
pub mod rate_limiter;
pub mod server;

// Re-export AgentRegistry for backward compatibility
pub use agent_binding::{get_binding_store, init_binding_store, AgentBinding};
pub use conversation::{start_conversation_reaper, ConversationManager};
pub use ergatai_core::agent_registry::AgentRegistry;
pub use message_delivery::start_message_delivery_consumer;
pub use rate_limiter::{get_rate_limiter, AgentRateLimiter};
pub use server::create_mcp_service;
pub use server::start_peer_reaper;
