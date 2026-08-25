//! Backend implementations for the Agent Runtime.
//!
//! Each module provides a concrete `AgentRuntimeBackend` implementation:
//! - `pty`: direct PTY-based process control (no external dependencies)

pub mod proc_linux;
pub mod pty;
