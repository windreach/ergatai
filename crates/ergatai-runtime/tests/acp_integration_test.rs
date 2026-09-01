//! Integration test: AcpBackend with a mock ACP agent (Python).
//!
//! Tests the full lifecycle: start_agent → inject_message → capture_output → stop_agent.

use std::path::PathBuf;
use std::time::Duration;

use ergatai_runtime::backend::AgentRuntimeBackend;
use ergatai_runtime::backends::acp::AcpBackend;
use ergatai_runtime::types::{ResourceLimits, WorkspaceSpec};

/// Build the command string for the mock ACP agent.
fn mock_agent_command() -> String {
    let manifest_dir = env!("CARGO_MANIFEST_DIR");
    let script = PathBuf::from(manifest_dir).join("tests/mock_acp_agent.py");
    format!("python3 {}", script.display())
}

/// Create a test workspace.
async fn create_test_workspace(
    backend: &AcpBackend,
    id: &str,
) -> ergatai_runtime::types::WorkspaceHandle {
    let spec = WorkspaceSpec {
        id: id.to_string(),
        work_dir: PathBuf::from("/tmp"),
        env: Default::default(),
        resources: ResourceLimits::default(),
        capture_thoughts: false,
    };
    backend.create_workspace(spec).await.unwrap()
}

#[tokio::test]
async fn test_acp_start_agent_and_inject_message() {
    let backend = AcpBackend::new();
    backend.initialize().await.unwrap();

    let workspace = create_test_workspace(&backend, "ws-test-acp-1").await;

    let command = mock_agent_command();
    let handle = backend
        .start_agent(&workspace, &command, None)
        .await
        .expect("start_agent should succeed");

    assert_eq!(handle.agent_id, "ws-test-acp-1-agent-0");

    // Give the agent a moment to fully initialize.
    tokio::time::sleep(Duration::from_millis(500)).await;

    // Agent should be alive.
    assert!(backend.is_alive(&handle).await.unwrap());

    // Inject a message.
    backend
        .inject_message(&handle, "Hello, ACP agent!")
        .await
        .expect("inject_message should succeed");

    // Wait for response to be captured.
    tokio::time::sleep(Duration::from_millis(500)).await;

    // Capture output — should contain the mock response.
    let output = backend.capture_output(&handle).await.unwrap();
    if let Some(ref text) = output {
        assert!(
            text.contains("Mock response to: Hello, ACP agent!"),
            "Output should contain mock response, got: {text}"
        );
    }

    // Stop the agent.
    backend.stop_agent(&handle).await.unwrap();

    // Agent should no longer be alive.
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert!(!backend.is_alive(&handle).await.unwrap());
}

#[tokio::test]
async fn test_acp_start_agent_with_initial_instruction() {
    let backend = AcpBackend::new();
    backend.initialize().await.unwrap();

    let workspace = create_test_workspace(&backend, "ws-test-acp-2").await;

    let command = mock_agent_command();
    let handle = backend
        .start_agent(&workspace, &command, Some("Do something initial"))
        .await
        .expect("start_agent with instruction should succeed");

    // Wait for the initial instruction to be processed.
    tokio::time::sleep(Duration::from_secs(1)).await;

    // Output should contain the mock response to the initial instruction.
    let output = backend.capture_output(&handle).await.unwrap();
    if let Some(ref text) = output {
        assert!(
            text.contains("Mock response to: Do something initial"),
            "Output should contain response to initial instruction, got: {text}"
        );
    }

    backend.kill_agent(&handle).await.unwrap();
}

#[tokio::test]
async fn test_acp_multiple_agents() {
    let backend = AcpBackend::new();
    backend.initialize().await.unwrap();

    let workspace = create_test_workspace(&backend, "ws-test-acp-3").await;
    let command = mock_agent_command();

    // Start two agents.
    let h1 = backend
        .start_agent(&workspace, &command, None)
        .await
        .unwrap();
    let h2 = backend
        .start_agent(&workspace, &command, None)
        .await
        .unwrap();

    assert_ne!(h1.agent_id, h2.agent_id);

    tokio::time::sleep(Duration::from_millis(500)).await;

    // Both should be alive.
    assert!(backend.is_alive(&h1).await.unwrap());
    assert!(backend.is_alive(&h2).await.unwrap());

    // Send messages to both.
    backend
        .inject_message(&h1, "msg for agent 1")
        .await
        .unwrap();
    backend
        .inject_message(&h2, "msg for agent 2")
        .await
        .unwrap();

    tokio::time::sleep(Duration::from_millis(500)).await;

    // Each should have its own output.
    let out1 = backend
        .capture_output(&h1)
        .await
        .unwrap()
        .unwrap_or_default();
    let out2 = backend
        .capture_output(&h2)
        .await
        .unwrap()
        .unwrap_or_default();
    assert!(out1.contains("msg for agent 1"));
    assert!(out2.contains("msg for agent 2"));

    // Stop both.
    backend.stop_agent(&h1).await.unwrap();
    backend.stop_agent(&h2).await.unwrap();
}

#[tokio::test]
async fn test_acp_invalid_command() {
    let backend = AcpBackend::new();
    backend.initialize().await.unwrap();

    let workspace = create_test_workspace(&backend, "ws-test-acp-4").await;

    // A command that doesn't exist should fail.
    let result = backend
        .start_agent(&workspace, "/nonexistent/binary", None)
        .await;
    assert!(result.is_err(), "Should fail for nonexistent binary");
}
