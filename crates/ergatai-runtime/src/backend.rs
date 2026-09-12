//! ACP Backend Interface — the complete interface for ACP-based agent execution.
//!
//! This trait defines all operations that an ACP backend must support, including:
//! - Agent lifecycle management (start, stop, inject messages)
//! - Observation operations (get thoughts, tool calls, plan, etc.)
//! - Control operations (cancel prompt, execute commands, session management)
//!
//! # Design Rationale
//!
//! Initially, this was designed as a generic `AgentRuntimeBackend` trait supporting
//! multiple backend types (Docker, SSH, K8s). However, in practice only ACP is used,
//! and all consumers downcast to `AcpBackend`. This trait now honestly reflects that
//! reality: it's the complete ACP backend interface, not a generic abstraction.

use std::time::Duration;

use async_trait::async_trait;

use ergatai_error::{ErgataiError, ErgataiResult};

use crate::types::{AgentHandle, BackendCapabilities, WaitResult, WorkspaceHandle, WorkspaceSpec};

/// Complete interface for ACP-based agent execution.
///
/// This trait describes all operations that an ACP backend must support.
/// Unlike the previous generic `AgentRuntimeBackend`, this trait is ACP-specific
/// and includes observation and control operations that were previously only
/// accessible via downcast.
///
/// # Observation Operations
///
/// Methods like `thoughts()`, `tool_calls()`, `plan()` return `Result<Option<T>>`:
/// - `Ok(Some(value))` — data is available
/// - `Ok(None)` — no data yet (agent hasn't produced thoughts, etc.)
/// - `Err(e)` — error (agent not found, connection failed, etc.)
///
/// # Control Operations
///
/// Methods like `cancel_prompt()`, `execute_command()` return `Result<()>`:
/// - `Ok(())` — operation succeeded
/// - `Err(e)` — operation failed
#[async_trait]
pub trait AcpBackendInterface: Send + Sync + 'static {
    // ===== Core Lifecycle (from original trait) =====

    /// Human-readable backend name (e.g., "acp").
    fn name(&self) -> &'static str;

    /// Declare what this backend can do.
    fn capabilities(&self) -> BackendCapabilities;

    /// Initialize the backend (check dependencies, create resources).
    async fn initialize(&self) -> ErgataiResult<()>;

    /// Create a workspace for an agent.
    async fn create_workspace(&self, spec: WorkspaceSpec) -> ErgataiResult<WorkspaceHandle>;

    /// Start an agent in the workspace.
    async fn start_agent(
        &self,
        handle: &WorkspaceHandle,
        command: &str,
        instruction: Option<&str>,
    ) -> ErgataiResult<AgentHandle>;

    /// Pre-compute the next agent_id for a workspace (for pre-registration).
    fn next_agent_id(&self, workspace_id: &str) -> String;

    /// Inject a message into a running agent.
    async fn inject_message(&self, handle: &AgentHandle, message: &str) -> ErgataiResult<()>;

    /// Inject a message and optional image attachments into a running agent.
    async fn inject_message_with_images(
        &self,
        handle: &AgentHandle,
        message: &str,
        images: &[crate::types::AgentImage],
    ) -> ErgataiResult<()> {
        if images.is_empty() {
            self.inject_message(handle, message).await
        } else {
            Err(ErgataiError::internal(
                "Image attachments are not supported by this backend",
            ))
        }
    }

    /// Capture agent output for result collection.
    async fn capture_output(&self, handle: &AgentHandle) -> ErgataiResult<Option<String>>;

    /// Check if an agent is still running.
    async fn is_alive(&self, handle: &AgentHandle) -> ErgataiResult<bool>;

    /// Stop an agent gracefully.
    async fn stop_agent(&self, handle: &AgentHandle) -> ErgataiResult<()>;

    /// Force-kill an agent (no graceful shutdown).
    async fn kill_agent(&self, handle: &AgentHandle) -> ErgataiResult<()>;

    /// Wait for an agent to exit.
    async fn wait_for_exit(
        &self,
        handle: &AgentHandle,
        timeout: Option<Duration>,
    ) -> ErgataiResult<WaitResult>;

    /// List all active workspaces.
    async fn list_workspaces(&self) -> ErgataiResult<Vec<WorkspaceHandle>>;

    /// Cleanup a workspace.
    async fn cleanup_workspace(&self, handle: &WorkspaceHandle) -> ErgataiResult<()>;

    /// Cleanup all resources (shutdown).
    async fn shutdown(&self) -> ErgataiResult<()>;

    /// Discover agents already running in the environment.
    async fn discover_agents(&self) -> ErgataiResult<Vec<(String, AgentHandle)>> {
        Ok(Vec::new())
    }

    /// Returns how long since the agent last produced output.
    fn last_output_age(&self, handle: &AgentHandle) -> Option<Duration>;

    // ===== Observation Operations (NEW) =====

    /// Get the agent's current thoughts (if any).
    async fn thoughts(&self, agent_id: &str) -> ErgataiResult<Option<String>>;

    /// Get the agent's output (non-destructive read).
    async fn output(&self, agent_id: &str) -> ErgataiResult<Option<String>>;

    /// Get the agent's tool call history.
    async fn tool_calls(
        &self,
        agent_id: &str,
    ) -> ErgataiResult<Option<Vec<crate::backends::acp::TrackedToolCall>>>;

    /// Get the agent's execution plan.
    async fn plan(
        &self,
        agent_id: &str,
    ) -> ErgataiResult<Option<crate::backends::acp::TrackedPlan>>;

    /// Get pending elicitation requests.
    async fn elicitations(
        &self,
        agent_id: &str,
    ) -> ErgataiResult<Option<Vec<crate::backends::acp::TrackedElicitation>>>;

    /// Get the agent's session title.
    async fn session_title(&self, agent_id: &str) -> ErgataiResult<Option<String>>;

    /// Get the agent's ACP session ID.
    async fn session_id(&self, agent_id: &str) -> ErgataiResult<Option<String>>;

    /// Get the reason the agent last stopped.
    async fn stop_reason(&self, agent_id: &str) -> ErgataiResult<Option<String>>;

    /// Get workspace configuration (capture_thoughts flag).
    async fn workspace_capture_thoughts(&self, workspace_id: &str) -> ErgataiResult<Option<bool>>;

    /// Get the number of auto-continuations.
    async fn continuation_count(&self, agent_id: &str) -> ErgataiResult<Option<usize>>;

    /// Get the agent's last output age.
    async fn agent_last_output_age(&self, agent_id: &str) -> ErgataiResult<Option<Duration>>;

    /// Get the agent's exit code (if exited).
    async fn exit_code(&self, agent_id: &str) -> ErgataiResult<Option<Option<i32>>>;

    /// Get the agent's available commands.
    async fn available_commands(&self, agent_id: &str) -> ErgataiResult<Option<Vec<String>>>;

    /// Check if auto-continue is enabled.
    async fn auto_continue(&self) -> ErgataiResult<bool>;

    /// Get max auto-continues setting.
    async fn max_auto_continues(&self) -> ErgataiResult<usize>;

    /// Check if MCP-over-ACP is enabled.
    async fn mcp_over_acp_enabled(&self) -> ErgataiResult<bool>;

    /// Check if session persistence is enabled.
    async fn session_persistence_enabled(&self) -> ErgataiResult<bool>;

    // ===== Control Operations (NEW) =====

    /// Cancel the agent's current prompt.
    async fn cancel_prompt(&self, agent_id: &str) -> ErgataiResult<()>;

    /// Execute a slash command.
    async fn execute_command(&self, agent_id: &str, command: &str) -> ErgataiResult<()>;

    /// Respond to an elicitation request.
    async fn respond_to_elicitation(
        &self,
        agent_id: &str,
        elicitation_id: &str,
        response: &str,
    ) -> ErgataiResult<()>;

    /// Return self as `&dyn Any` to enable downcasting through the trait object.
    ///
    /// **Deprecated**: This is a transitional method for backward compatibility.
    /// New code should use the trait methods directly instead of downcasting.
    /// This will be removed once all callers are migrated.
    fn as_any(&self) -> &dyn std::any::Any;
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{
        AgentHandle, BackendCapabilities, ResourceLimits, WaitResult, WorkspaceHandle,
        WorkspaceSpec,
    };
    use std::collections::HashMap;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::Duration;

    /// A mock backend for testing the trait interface.
    struct MockBackend {
        name: &'static str,
        create_count: AtomicUsize,
    }

    impl MockBackend {
        fn new(name: &'static str) -> Self {
            Self {
                name,
                create_count: AtomicUsize::new(0),
            }
        }
    }

    #[async_trait]
    impl AcpBackendInterface for MockBackend {
        fn name(&self) -> &'static str {
            self.name
        }

        fn capabilities(&self) -> BackendCapabilities {
            BackendCapabilities {
                supports_message_injection: true,
                supports_output_capture: false,
                supports_resource_limits: false,
                supports_workspace_reuse: false,
                supports_network_isolation: false,
                max_concurrent_agents: None,
            }
        }

        async fn initialize(&self) -> ErgataiResult<()> {
            Ok(())
        }

        async fn create_workspace(&self, spec: WorkspaceSpec) -> ErgataiResult<WorkspaceHandle> {
            self.create_count.fetch_add(1, Ordering::SeqCst);
            Ok(WorkspaceHandle {
                id: spec.id,
                backend: self.name.to_string(),
                metadata: HashMap::new(),
            })
        }

        fn next_agent_id(&self, workspace_id: &str) -> String {
            format!("{}-agent-0", workspace_id)
        }

        async fn start_agent(
            &self,
            handle: &WorkspaceHandle,
            _command: &str,
            _instruction: Option<&str>,
        ) -> ErgataiResult<AgentHandle> {
            Ok(AgentHandle {
                workspace: handle.clone(),
                agent_id: format!("{}-agent", handle.id),
                process_id: None,
                metadata: HashMap::new(),
            })
        }

        async fn inject_message(&self, _handle: &AgentHandle, _message: &str) -> ErgataiResult<()> {
            Ok(())
        }

        async fn inject_message_with_images(
            &self,
            _handle: &AgentHandle,
            _message: &str,
            images: &[crate::types::AgentImage],
        ) -> ErgataiResult<()> {
            if images.is_empty() {
                Ok(())
            } else {
                Err(ErgataiError::internal(
                    "Image attachments are not supported by this backend",
                ))
            }
        }

        async fn capture_output(&self, _handle: &AgentHandle) -> ErgataiResult<Option<String>> {
            Ok(None)
        }

        async fn is_alive(&self, _handle: &AgentHandle) -> ErgataiResult<bool> {
            Ok(false)
        }

        async fn stop_agent(&self, _handle: &AgentHandle) -> ErgataiResult<()> {
            Ok(())
        }

        async fn kill_agent(&self, _handle: &AgentHandle) -> ErgataiResult<()> {
            Ok(())
        }

        async fn wait_for_exit(
            &self,
            _handle: &AgentHandle,
            _timeout: Option<Duration>,
        ) -> ErgataiResult<WaitResult> {
            Ok(WaitResult::Exited { code: 0 })
        }

        async fn list_workspaces(&self) -> ErgataiResult<Vec<WorkspaceHandle>> {
            Ok(vec![])
        }

        async fn cleanup_workspace(&self, _handle: &WorkspaceHandle) -> ErgataiResult<()> {
            Ok(())
        }

        async fn shutdown(&self) -> ErgataiResult<()> {
            Ok(())
        }

        fn last_output_age(&self, _handle: &AgentHandle) -> Option<Duration> {
            None
        }

        // Observation operations
        async fn thoughts(&self, _agent_id: &str) -> ErgataiResult<Option<String>> {
            Ok(None)
        }

        async fn output(&self, _agent_id: &str) -> ErgataiResult<Option<String>> {
            Ok(None)
        }

        async fn tool_calls(
            &self,
            _agent_id: &str,
        ) -> ErgataiResult<Option<Vec<crate::backends::acp::TrackedToolCall>>> {
            Ok(None)
        }

        async fn plan(
            &self,
            _agent_id: &str,
        ) -> ErgataiResult<Option<crate::backends::acp::TrackedPlan>> {
            Ok(None)
        }

        async fn elicitations(
            &self,
            _agent_id: &str,
        ) -> ErgataiResult<Option<Vec<crate::backends::acp::TrackedElicitation>>> {
            Ok(None)
        }

        async fn session_title(&self, _agent_id: &str) -> ErgataiResult<Option<String>> {
            Ok(None)
        }

        async fn session_id(&self, _agent_id: &str) -> ErgataiResult<Option<String>> {
            Ok(None)
        }

        async fn stop_reason(&self, _agent_id: &str) -> ErgataiResult<Option<String>> {
            Ok(None)
        }

        async fn workspace_capture_thoughts(
            &self,
            _workspace_id: &str,
        ) -> ErgataiResult<Option<bool>> {
            Ok(None)
        }

        async fn continuation_count(&self, _agent_id: &str) -> ErgataiResult<Option<usize>> {
            Ok(None)
        }

        async fn agent_last_output_age(&self, _agent_id: &str) -> ErgataiResult<Option<Duration>> {
            Ok(None)
        }

        async fn exit_code(&self, _agent_id: &str) -> ErgataiResult<Option<Option<i32>>> {
            Ok(None)
        }

        async fn available_commands(&self, _agent_id: &str) -> ErgataiResult<Option<Vec<String>>> {
            Ok(None)
        }

        async fn auto_continue(&self) -> ErgataiResult<bool> {
            Ok(false)
        }

        async fn max_auto_continues(&self) -> ErgataiResult<usize> {
            Ok(0)
        }

        async fn mcp_over_acp_enabled(&self) -> ErgataiResult<bool> {
            Ok(false)
        }

        async fn session_persistence_enabled(&self) -> ErgataiResult<bool> {
            Ok(false)
        }

        // Control operations
        async fn cancel_prompt(&self, _agent_id: &str) -> ErgataiResult<()> {
            Ok(())
        }

        async fn execute_command(&self, _agent_id: &str, _command: &str) -> ErgataiResult<()> {
            Ok(())
        }

        async fn respond_to_elicitation(
            &self,
            _agent_id: &str,
            _elicitation_id: &str,
            _response: &str,
        ) -> ErgataiResult<()> {
            Ok(())
        }

        fn as_any(&self) -> &dyn std::any::Any {
            self
        }
    }

    #[test]
    fn test_backend_name() {
        let backend = MockBackend::new("mock");
        assert_eq!(backend.name(), "mock");
    }

    #[test]
    fn test_backend_capabilities() {
        let backend = MockBackend::new("mock");
        let caps = backend.capabilities();
        assert!(caps.supports_message_injection);
        assert!(!caps.supports_output_capture);
        assert!(caps.max_concurrent_agents.is_none());
    }

    #[tokio::test]
    async fn test_backend_initialize() {
        let backend = MockBackend::new("mock");
        assert!(backend.initialize().await.is_ok());
    }

    #[tokio::test]
    async fn test_backend_create_workspace() {
        let backend = MockBackend::new("mock");
        let spec = WorkspaceSpec {
            id: "ws-1".to_string(),
            work_dir: PathBuf::from("/tmp"),
            env: HashMap::new(),
            resources: ResourceLimits::default(),
            capture_thoughts: false,
        };
        let handle = backend.create_workspace(spec).await.unwrap();
        assert_eq!(handle.id, "ws-1");
        assert_eq!(handle.backend, "mock");
        assert_eq!(backend.create_count.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn test_backend_start_agent() {
        let backend = MockBackend::new("mock");
        let ws = WorkspaceHandle {
            id: "ws-1".to_string(),
            backend: "mock".to_string(),
            metadata: HashMap::new(),
        };
        let agent = backend.start_agent(&ws, "echo hi", None).await.unwrap();
        assert_eq!(agent.agent_id, "ws-1-agent");
        assert_eq!(agent.workspace.id, "ws-1");
    }

    #[tokio::test]
    async fn test_backend_inject_message() {
        let backend = MockBackend::new("mock");
        let agent = AgentHandle {
            workspace: WorkspaceHandle {
                id: "ws-1".to_string(),
                backend: "mock".to_string(),
                metadata: HashMap::new(),
            },
            agent_id: "agent-1".to_string(),
            process_id: None,
            metadata: HashMap::new(),
        };
        assert!(backend.inject_message(&agent, "hello").await.is_ok());
    }

    #[tokio::test]
    async fn test_backend_wait_for_exit() {
        let backend = MockBackend::new("mock");
        let agent = AgentHandle {
            workspace: WorkspaceHandle {
                id: "ws-1".to_string(),
                backend: "mock".to_string(),
                metadata: HashMap::new(),
            },
            agent_id: "agent-1".to_string(),
            process_id: None,
            metadata: HashMap::new(),
        };
        let result = backend.wait_for_exit(&agent, None).await.unwrap();
        match result {
            WaitResult::Exited { code } => assert_eq!(code, 0),
            _ => panic!("Expected Exited"),
        }
    }

    #[tokio::test]
    async fn test_backend_shutdown() {
        let backend = MockBackend::new("mock");
        assert!(backend.shutdown().await.is_ok());
    }

    #[tokio::test]
    async fn test_backend_list_workspaces_empty() {
        let backend = MockBackend::new("mock");
        let workspaces = backend.list_workspaces().await.unwrap();
        assert!(workspaces.is_empty());
    }

    #[tokio::test]
    async fn test_observation_operations() {
        let backend = MockBackend::new("mock");
        assert!(backend.thoughts("agent-1").await.unwrap().is_none());
        assert!(backend.tool_calls("agent-1").await.unwrap().is_none());
        assert!(backend.plan("agent-1").await.unwrap().is_none());
    }

    #[tokio::test]
    async fn test_control_operations() {
        let backend = MockBackend::new("mock");
        assert!(backend.cancel_prompt("agent-1").await.is_ok());
        assert!(backend.execute_command("agent-1", "/help").await.is_ok());
    }
}
