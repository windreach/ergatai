//! Ergatai Runtime — pluggable agent execution backends.
//!
//! This crate provides the `AcpBackendInterface` trait and the `AcpBackend`
//! implementation for running agents via the Agent Client Protocol (ACP).
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
//!     capture_thoughts: false,
//! };
//!
//! let agent_id = runtime
//!     .launch_agent(spec, "claude", Some("Read CLAUDE.md"), None, None)
//!     .await?;
//! # Ok(())
//! # }
//! ```

// Core types
pub mod activity_monitor;
pub mod adapter_manager;
pub mod agent_installer;
pub mod agent_lifecycle;
pub mod agent_profile;
pub mod agent_record;
pub mod agent_registry;
pub mod bash_path_extractor;
pub mod binary_detection;
pub mod cgroups;
pub mod dirs;
pub mod mcp_config;
pub mod mcp_lifecycle;
pub mod mcp_over_acp;
pub mod output_accumulator;
pub mod permission;
pub mod permission_service;
pub mod profile_registry;
pub mod session_store;
pub mod suspend_store;
pub mod transport_probe;
pub mod types;

// Backend trait
pub mod backend;

// Backend implementations
pub mod backends;

// Output publisher trait
pub mod output_publisher;

// Runtime facade
pub mod runtime;

// Re-export primary API
pub use agent_lifecycle::{
    AgentLifecycleState, ExitOutcome, ProcessingPhase, StopReason, TimeoutType,
};
pub use agent_profile::{discover_profiles, load_profile, AgentProfile, ToolPolicy};
pub use agent_record::{
    AgentHandle as RecordAgentHandle, AgentRecord, StateTransition,
    WorkspaceHandle as RecordWorkspaceHandle,
};
pub use agent_registry::{AgentRegistry, AgentRegistryReadGuard, AgentRegistryWriteGuard};
pub use backend::AcpBackendInterface;
pub use backends::acp::{
    AcpBackend, AgentOutputEvent, ElicitationResponse, TrackedElicitation, TrackedPlan,
    TrackedPlanEntry, TrackedToolCall,
};
pub use backends::acp_http::AcpHttpBackend;

// Global conversation tracking for current prompt
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

static CURRENT_PROMPT_CONVERSATION: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();

fn current_prompt_conversation_state() -> &'static Mutex<HashMap<String, String>> {
    CURRENT_PROMPT_CONVERSATION.get_or_init(|| Mutex::new(HashMap::new()))
}

pub fn set_current_prompt_conversation(agent_id: &str, conversation_id: Option<String>) {
    let Ok(mut map) = current_prompt_conversation_state().lock() else {
        return;
    };
    match conversation_id {
        Some(id) => {
            map.insert(agent_id.to_string(), id);
        }
        None => {
            map.remove(agent_id);
        }
    }
}

pub fn get_current_prompt_conversation(agent_id: &str) -> Option<String> {
    current_prompt_conversation_state()
        .lock()
        .ok()?
        .get(agent_id)
        .cloned()
}

pub use output_accumulator::{
    get_global_accumulator_registry, get_global_persist_callback, set_global_accumulator_registry,
    set_global_persist_callback, AgentOutputData, OutputAccumulatorRegistry,
    OutputMetadata, PersistCallback, TextChunk, ThinkingBlock, TokenUsage, ToolCallLocation,
    ToolCallRecord, TurnAccumulator,
};
pub use output_publisher::{
    get_global_output_publisher, set_global_output_publisher, NoOpOutputPublisher, OutputPublisher,
};
pub use permission::{
    InteractivePermissionHandler, PermissionDecision, PermissionHandler, YoloPermissionHandler,
};
pub use permission_service::{
    global_permission_service, PermissionDecisionKind, PermissionEvent, PermissionRequestKind,
    PermissionRequestService, PermissionSource,
};
pub use runtime::{
    get_agent_runtime, init_agent_runtime, init_agent_runtime_with_http, AgentRuntime,
};
pub use session_store::{SessionRecord, SessionStore};
pub use suspend_store::{SuspendReason, SuspendStore, SuspendedAgentRecord};
pub use types::{
    AgentHandle, AgentImage, AgentInfo, BackendCapabilities, ResourceLimits, SessionInfo,
    WaitResult, WorkspaceHandle, WorkspaceSpec,
};
