//! Backend implementations for the Agent Runtime.
//!
//! Each module provides a concrete `AgentRuntimeBackend` implementation:
//! - `acp`: ACP (Agent Client Protocol) based process control

pub mod proc_linux;
pub mod acp;
