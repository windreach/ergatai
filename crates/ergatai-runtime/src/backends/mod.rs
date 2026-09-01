//! Backend implementations for the Agent Runtime.
//!
//! Each module provides a concrete `AgentRuntimeBackend` implementation:
//! - `acp`: ACP (Agent Client Protocol) based process control (stdio transport)
//! - `acp_http`: ACP over HTTP/SSE/WebSocket (network transport)

pub mod acp;
pub mod acp_http;
pub mod proc_linux;
