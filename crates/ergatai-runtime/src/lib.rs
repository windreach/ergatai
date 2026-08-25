//! Ergatai Runtime — pluggable agent execution backends.
//!
//! This crate provides the `AgentRuntimeBackend` trait and the `PtyBackend`
//! implementation for running agents with direct PTY-based process control.
//!
//! The `AgentRuntime` facade wraps a backend with state tracking and MCP
//! integration, providing a high-level API for launching, messaging, and
//! stopping agents.
//!
//! # Quick Start
//!
//! ```rust,no_run
//! use ergatai_runtime::{get_agent_runtime, WorkspaceSpec};
//! use std::collections::HashMap;
//! use std::path::PathBuf;
//!
//! # async fn example() -> ergatai_error::ErgataiResult<()> {
//! let runtime = get_agent_runtime();
//! runtime.initialize().await?;
//!
//! let spec = WorkspaceSpec {
//!     id: "my-task-agent-a".to_string(),
//!     work_dir: PathBuf::from("/tmp/work"),
//!     env: HashMap::new(),
//!     resources: Default::default(),
//!     backend_config: serde_json::json!({}),
//! };
//!
//! let agent_id = runtime.launch_agent(spec, "claude", Some("Read CLAUDE.md")).await?;
//! # Ok(())
//! # }
//! ```

// Core types
pub mod agent_lifecycle;
pub mod agent_record;
pub mod cgroups;
pub mod types;

// Backend trait
pub mod backend;

// Backend implementations
pub mod backends;

// Runtime facade
pub mod runtime;

// Re-export primary API
pub use agent_lifecycle::{
    AgentLifecycleState, ExitOutcome, ProcessingPhase, StopReason, TimeoutType,
};
pub use agent_record::{
    AgentHandle as RecordAgentHandle, AgentRecord, StateTransition,
    WorkspaceHandle as RecordWorkspaceHandle,
};
pub use backend::AgentRuntimeBackend;
pub use backends::pty::PtyBackend;
pub use runtime::{get_agent_runtime, init_agent_runtime, AgentRuntime};
pub use types::{
    AgentHandle, AgentInfo, BackendCapabilities, ResourceLimits, WaitResult, WorkspaceHandle,
    WorkspaceSpec,
};
