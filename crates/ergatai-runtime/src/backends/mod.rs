//! Backend implementations for the Agent Runtime.
//!
//! Each module provides a concrete `AgentRuntimeBackend` implementation:
//! - `tmux`: tmux CLI-based terminal multiplexer (preferred, default)
//! - `pty`: direct PTY-based process control (no tmux dependency)
//! - `rmux`: rmux SDK-based terminal multiplexer (deprecated)
//! - `direct_process`: direct process spawning without terminal multiplexer

pub mod direct_process;
pub mod proc_linux;
pub mod pty;
#[cfg(feature = "rmux")]
pub mod rmux;
pub mod tmux;
