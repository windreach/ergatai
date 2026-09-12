//! Data types for the Agent Runtime abstraction.
//!
//! These types define the interface between Ergatai and pluggable execution backends.
//! They are backend-agnostic — each backend interprets them according to its own model.

use std::collections::HashMap;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

/// An image attachment delivered with an agent prompt.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentImage {
    /// Base64-encoded image payload without the data-URI prefix.
    pub base64_data: String,

    /// MIME type of the encoded image payload.
    pub media_type: String,

    /// Optional filename used for logging and UI context.
    pub filename: Option<String>,
}

/// Specification for creating a new agent workspace.
///
/// A workspace is the execution environment for an agent — it is a PTY-backed
/// container with a working directory, environment variables, and resource limits.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkspaceSpec {
    /// Unique workspace identifier (e.g., "dag-task-123-agent-a")
    pub id: String,

    /// Working directory mounted/available in the workspace
    pub work_dir: PathBuf,

    /// Environment variables to set in the workspace
    pub env: HashMap<String, String>,

    /// Resource limits (CPU, memory, disk)
    pub resources: ResourceLimits,

    /// Whether to capture agent thoughts (default: false)
    pub capture_thoughts: bool,
}

/// Resource limits for a workspace.
///
/// All fields are optional — `None` means "no limit" or "use backend default".
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ResourceLimits {
    /// CPU cores (e.g., 2.5 = 2.5 cores)
    pub cpu_cores: Option<f64>,

    /// Memory in megabytes
    pub memory_mb: Option<u64>,

    /// Disk space in megabytes
    pub disk_mb: Option<u64>,
}

/// Opaque handle to a created workspace.
///
/// The `metadata` field contains backend-specific information (e.g., work_dir,
/// cgroup path).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorkspaceHandle {
    /// Workspace ID (matches `WorkspaceSpec.id`)
    pub id: String,

    /// Backend name that created this workspace
    pub backend: String,

    /// Backend-specific metadata (e.g., `{"work_dir": "/path/to/project"}`)
    pub metadata: HashMap<String, String>,
}

/// Opaque handle to a running agent.
///
/// Contains the workspace handle plus agent-specific identifiers.
///
/// ## ID System
///
/// - `agent_id`: **Runtime ID** — deterministic ID assigned by PTY backend
///   (`{workspace_id}-agent-{counter}`). Not stable across process restarts.
///   Use `metadata["ergatai_agent_id"]` (stable ID) for cross-restart
///   identification when available.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AgentHandle {
    /// The workspace this agent runs in
    pub workspace: WorkspaceHandle,

    /// **Runtime ID** — deterministic identifier from the backend.
    ///
    /// For PTY backend: `{workspace_id}-agent-{counter}` (e.g., `ws1-agent-1`).
    /// For fallback: sequential `agent_0`, `agent_1` (unstable).
    ///
    /// This ID changes when the process is recreated. For a stable identifier
    /// that survives restarts, use `metadata["ergatai_agent_id"]` (set via
    /// `ERGATAI_AGENT_ID` env var by ergatai agent_launcher).
    pub agent_id: String,

    /// Process identifier (PID, container ID, etc.) — backend-specific
    pub process_id: Option<String>,

    /// Backend-specific metadata.
    ///
    /// Key entries:
    /// - `ergatai_agent_id`: **Stable ID** — survives agent restarts (e.g., `agent-1`)
    /// - `work_dir`: agent working directory
    pub metadata: HashMap<String, String>,
}

/// Result of waiting for an agent to exit.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum WaitResult {
    /// Agent exited normally with an exit code
    Exited {
        /// Exit code (0 = success)
        code: i32,
    },

    /// Agent was killed by a signal
    Signaled {
        /// Signal number (e.g., 9 = SIGKILL, 15 = SIGTERM)
        signal: i32,
    },

    /// Wait timed out before agent exited
    Timeout,

    /// Error occurred while waiting
    Error(String),
}

/// Backend capability flags.
///
/// Callers should check these before attempting operations to provide graceful degradation.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct BackendCapabilities {
    /// Can inject messages into a running agent (e.g., PTY write)
    pub supports_message_injection: bool,

    /// Can capture agent output (e.g., PTY read buffer)
    pub supports_output_capture: bool,

    /// Can enforce resource limits (e.g., cgroups, Docker limits)
    pub supports_resource_limits: bool,

    /// Can reuse a workspace for multiple agents sequentially
    pub supports_workspace_reuse: bool,

    /// Can isolate agent network access
    pub supports_network_isolation: bool,

    /// Maximum concurrent agents (None = unlimited)
    pub max_concurrent_agents: Option<usize>,
}

/// ACP session information.
///
/// Represents a conversation session managed by the ACP agent.
/// Sessions can be listed, created, loaded, and deleted via the ACP protocol.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionInfo {
    /// Unique session identifier (assigned by the ACP agent)
    pub session_id: String,

    /// Human-readable title (may be auto-generated or user-provided)
    pub title: Option<String>,

    /// Session creation timestamp (ISO 8601 format, e.g., "2026-09-10T14:30:00Z")
    pub created_at: Option<String>,

    /// Last update timestamp (ISO 8601 format)
    pub updated_at: Option<String>,
}

/// Agent information tracked by the runtime facade.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentInfo {
    /// Stable agent UUID (persistent across agent restarts, used for message routing)
    pub agent_uuid: String,

    /// Runtime agent ID (e.g., "ws1-agent-1", used for terminal injection)
    /// Changes when the process dies and a new one is created.
    pub agent_id: String,

    /// Human-readable stable identifier (e.g., "agent-1").
    /// Populated from `handle.metadata["ergatai_agent_id"]` during discovery.
    /// Used for user-facing display, conversation tracking, and batch aggregation.
    /// Unlike `agent_id` (runtime ID), this survives agent restarts.
    pub stable_id: Option<String>,

    /// Workspace ID this agent belongs to
    pub workspace_id: String,

    /// Backend handle for this agent
    pub handle: AgentHandle,

    /// New unified lifecycle state machine
    pub lifecycle: crate::agent_lifecycle::AgentLifecycleState,

    /// Optional task ID (for DAG orchestration)
    pub task_id: Option<String>,

    /// When this agent was created
    pub created_at: chrono::DateTime<chrono::Utc>,

    /// Associated MCP agent ID (e.g., "opencode@abcd1234").
    /// Set when an MCP client connects and is bound to this runtime agent.
    /// Enables resolving MCP IDs to runtime IDs for message injection.
    pub mcp_agent_id: Option<String>,

    /// Last heartbeat timestamp (for hang detection)
    pub last_heartbeat: chrono::DateTime<chrono::Utc>,

    /// Agent profile name (from profile registry)
    pub profile: Option<String>,

    /// Agent capabilities (from profile or runtime discovery)
    pub capabilities: Vec<String>,

    /// When the lifecycle state last changed
    pub state_changed_at: chrono::DateTime<chrono::Utc>,

    /// State transition history (for debugging and audit)
    pub state_history: Vec<crate::agent_record::StateTransition>,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_spec() -> WorkspaceSpec {
        WorkspaceSpec {
            id: "ws-1".to_string(),
            work_dir: PathBuf::from("/tmp/ws-1"),
            env: HashMap::new(),
            resources: ResourceLimits::default(),
            capture_thoughts: false,
        }
    }

    #[test]
    fn test_workspace_spec_construction() {
        let spec = sample_spec();
        assert_eq!(spec.id, "ws-1");
        assert_eq!(spec.work_dir, PathBuf::from("/tmp/ws-1"));
        assert!(spec.env.is_empty());
        assert!(spec.resources.cpu_cores.is_none());
        assert!(spec.resources.memory_mb.is_none());
        assert!(spec.resources.disk_mb.is_none());
    }

    #[test]
    fn test_workspace_spec_with_env() {
        let mut env = HashMap::new();
        env.insert("KEY".to_string(), "VALUE".to_string());
        let spec = WorkspaceSpec {
            id: "ws-2".to_string(),
            work_dir: PathBuf::from("/tmp"),
            env,
            resources: ResourceLimits::default(),
            capture_thoughts: false,
        };
        assert_eq!(spec.env.get("KEY"), Some(&"VALUE".to_string()));
    }

    #[test]
    fn test_workspace_spec_with_resources() {
        let spec = WorkspaceSpec {
            id: "ws-3".to_string(),
            work_dir: PathBuf::from("/tmp"),
            env: HashMap::new(),
            resources: ResourceLimits {
                cpu_cores: Some(2.5),
                memory_mb: Some(512),
                disk_mb: Some(1024),
            },
            capture_thoughts: false,
        };
        assert_eq!(spec.resources.cpu_cores, Some(2.5));
        assert_eq!(spec.resources.memory_mb, Some(512));
        assert_eq!(spec.resources.disk_mb, Some(1024));
    }

    #[test]
    fn test_workspace_spec_clone() {
        let spec = sample_spec();
        let cloned = spec.clone();
        assert_eq!(cloned.id, spec.id);
        assert_eq!(cloned.work_dir, spec.work_dir);
    }

    #[test]
    fn test_workspace_spec_debug() {
        let spec = sample_spec();
        let debug_str = format!("{:?}", spec);
        assert!(debug_str.contains("ws-1"));
        assert!(debug_str.contains("WorkspaceSpec"));
    }

    #[test]
    fn test_workspace_spec_serialize_roundtrip() {
        let spec = sample_spec();
        let json = serde_json::to_string(&spec).unwrap();
        let decoded: WorkspaceSpec = serde_json::from_str(&json).unwrap();
        assert_eq!(decoded.id, spec.id);
        assert_eq!(decoded.work_dir, spec.work_dir);
    }

    #[test]
    fn test_resource_limits_default() {
        let limits = ResourceLimits::default();
        assert!(limits.cpu_cores.is_none());
        assert!(limits.memory_mb.is_none());
        assert!(limits.disk_mb.is_none());
    }

    #[test]
    fn test_workspace_handle_eq() {
        let h1 = WorkspaceHandle {
            id: "ws-1".to_string(),
            backend: "pty".to_string(),
            metadata: HashMap::new(),
        };
        let h2 = h1.clone();
        assert_eq!(h1, h2);
    }

    #[test]
    fn test_workspace_handle_metadata() {
        let mut metadata = HashMap::new();
        metadata.insert("work_dir".to_string(), "/tmp/project".to_string());
        let handle = WorkspaceHandle {
            id: "ws-1".to_string(),
            backend: "pty".to_string(),
            metadata,
        };
        assert_eq!(
            handle.metadata.get("work_dir"),
            Some(&"/tmp/project".to_string())
        );
    }

    #[test]
    fn test_workspace_handle_serialize_roundtrip() {
        let handle = WorkspaceHandle {
            id: "ws-1".to_string(),
            backend: "direct-process".to_string(),
            metadata: HashMap::new(),
        };
        let json = serde_json::to_string(&handle).unwrap();
        let decoded: WorkspaceHandle = serde_json::from_str(&json).unwrap();
        assert_eq!(decoded, handle);
    }

    #[test]
    fn test_agent_handle_fields() {
        let handle = AgentHandle {
            workspace: WorkspaceHandle {
                id: "ws-1".to_string(),
                backend: "pty".to_string(),
                metadata: HashMap::new(),
            },
            agent_id: "agent-1".to_string(),
            process_id: Some("1234".to_string()),
            metadata: HashMap::new(),
        };
        assert_eq!(handle.agent_id, "agent-1");
        assert_eq!(handle.process_id, Some("1234".to_string()));
        assert_eq!(handle.workspace.id, "ws-1");
    }

    #[test]
    fn test_agent_handle_no_process_id() {
        let handle = AgentHandle {
            workspace: WorkspaceHandle {
                id: "ws-1".to_string(),
                backend: "pty".to_string(),
                metadata: HashMap::new(),
            },
            agent_id: "agent-1".to_string(),
            process_id: None,
            metadata: HashMap::new(),
        };
        assert!(handle.process_id.is_none());
    }

    #[test]
    fn test_wait_result_variants() {
        let exited = WaitResult::Exited { code: 0 };
        let signaled = WaitResult::Signaled { signal: 9 };
        let timeout = WaitResult::Timeout;
        let error = WaitResult::Error("boom".to_string());

        // Just verify construction and debug formatting
        assert!(format!("{:?}", exited).contains("Exited"));
        assert!(format!("{:?}", signaled).contains("Signaled"));
        assert!(format!("{:?}", timeout).contains("Timeout"));
        assert!(format!("{:?}", error).contains("boom"));
    }

    #[test]
    fn test_wait_result_serialize_roundtrip() {
        let results = vec![
            WaitResult::Exited { code: 0 },
            WaitResult::Exited { code: 1 },
            WaitResult::Signaled { signal: 15 },
            WaitResult::Timeout,
            WaitResult::Error("err".to_string()),
        ];
        for r in results {
            let json = serde_json::to_string(&r).unwrap();
            let decoded: WaitResult = serde_json::from_str(&json).unwrap();
            assert!(format!("{:?}", decoded) == format!("{:?}", r));
        }
    }

    #[test]
    fn test_backend_capabilities_default() {
        let caps = BackendCapabilities::default();
        assert!(!caps.supports_message_injection);
        assert!(!caps.supports_output_capture);
        assert!(!caps.supports_resource_limits);
        assert!(!caps.supports_workspace_reuse);
        assert!(!caps.supports_network_isolation);
        assert!(caps.max_concurrent_agents.is_none());
    }

    #[test]
    fn test_backend_capabilities_custom() {
        let caps = BackendCapabilities {
            supports_message_injection: true,
            supports_output_capture: true,
            supports_resource_limits: false,
            supports_workspace_reuse: true,
            supports_network_isolation: false,
            max_concurrent_agents: Some(10),
        };
        assert!(caps.supports_message_injection);
        assert!(caps.supports_output_capture);
        assert!(!caps.supports_resource_limits);
        assert!(caps.supports_workspace_reuse);
        assert_eq!(caps.max_concurrent_agents, Some(10));
    }

    #[test]
    fn test_backend_capabilities_serialize() {
        let caps = BackendCapabilities {
            supports_message_injection: true,
            supports_output_capture: false,
            supports_resource_limits: false,
            supports_workspace_reuse: false,
            supports_network_isolation: false,
            max_concurrent_agents: Some(5),
        };
        let json = serde_json::to_string(&caps).unwrap();
        let decoded: BackendCapabilities = serde_json::from_str(&json).unwrap();
        assert!(decoded.supports_message_injection);
        assert_eq!(decoded.max_concurrent_agents, Some(5));
    }

    #[test]
    fn test_agent_info_construction() {
        let now = chrono::Utc::now();
        let info = AgentInfo {
            agent_uuid: "550e8400-e29b-41d4-a716-446655440000".to_string(),
            agent_id: "agent-1".to_string(),
            stable_id: None,
            workspace_id: "ws-1".to_string(),
            handle: AgentHandle {
                workspace: WorkspaceHandle {
                    id: "ws-1".to_string(),
                    backend: "pty".to_string(),
                    metadata: HashMap::new(),
                },
                agent_id: "agent-1".to_string(),
                process_id: None,
                metadata: HashMap::new(),
            },
            lifecycle: crate::agent_lifecycle::AgentLifecycleState::Running {
                task_id: None,
                started_at: now,
                last_heartbeat: now,
            },
            task_id: None,
            created_at: now,
            mcp_agent_id: None,
            last_heartbeat: now,
            profile: None,
            capabilities: Vec::new(),
            state_changed_at: now,
            state_history: Vec::new(),
        };
        assert_eq!(info.agent_id, "agent-1");
        assert_eq!(info.agent_uuid, "550e8400-e29b-41d4-a716-446655440000");
        assert_eq!(info.workspace_id, "ws-1");
        assert!(info.task_id.is_none());
    }

    #[test]
    fn test_agent_info_with_task() {
        let now = chrono::Utc::now();
        let info = AgentInfo {
            agent_uuid: "550e8400-e29b-41d4-a716-446655440001".to_string(),
            agent_id: "agent-1".to_string(),
            stable_id: None,
            workspace_id: "ws-1".to_string(),
            handle: AgentHandle {
                workspace: WorkspaceHandle {
                    id: "ws-1".to_string(),
                    backend: "pty".to_string(),
                    metadata: HashMap::new(),
                },
                agent_id: "agent-1".to_string(),
                process_id: None,
                metadata: HashMap::new(),
            },
            lifecycle: crate::agent_lifecycle::AgentLifecycleState::Starting {
                workspace_id: "ws-1".to_string(),
                command: "test".to_string(),
                started_at: now,
            },
            task_id: Some("task-42".to_string()),
            created_at: now,
            mcp_agent_id: None,
            last_heartbeat: now,
            profile: None,
            capabilities: Vec::new(),
            state_changed_at: now,
            state_history: Vec::new(),
        };
        assert_eq!(info.task_id, Some("task-42".to_string()));
    }
}
