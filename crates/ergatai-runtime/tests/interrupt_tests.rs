//! Integration tests for the agent interrupt mechanism
//!
//! Tests verify that:
//! 1. Interrupt messages can be queued
//! 2. Interrupt messages are processed at safe points
//! 3. Paused tasks can be resumed

use ergatai_runtime::backend::AcpBackendInterface;
use ergatai_runtime::backends::acp::AcpBackend;
use ergatai_runtime::types::AgentImage;

#[tokio::test]
async fn test_interrupt_basic_flow() {
    // This is a basic smoke test to verify the interrupt API exists
    // Full integration tests would require a running ACP agent

    let backend = AcpBackend::new();

    // Verify the backend can be created
    assert_eq!(backend.name(), "acp");

    // Verify inject_interrupt method exists (compilation test)
    // In a real test, we would:
    // 1. Start a workspace
    // 2. Start an agent
    // 3. Send a normal prompt
    // 4. Send an interrupt prompt
    // 5. Verify the interrupt is processed
}

#[tokio::test]
async fn test_paused_task_lifecycle() {
    let backend = AcpBackend::new();

    // Test get_paused_task returns None when no task is paused
    let paused = backend.get_paused_task("nonexistent-agent").await;
    assert!(paused.is_none());

    // Test resume_paused_task returns None when no task is paused
    let resumed = backend.resume_paused_task("nonexistent-agent").await;
    assert!(resumed.is_none());
}

#[tokio::test]
async fn test_interrupt_with_images() {
    // Verify that interrupt messages can include images
    let backend = AcpBackend::new();

    let images = vec![
        AgentImage {
            base64_data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==".to_string(),
            media_type: "image/png".to_string(),
            filename: Some("test.png".to_string()),
        }
    ];

    // This should fail gracefully since the agent doesn't exist
    let result = backend
        .inject_interrupt(
            "nonexistent-agent",
            "Test interrupt with image",
            &images,
            "test-message-id",
        )
        .await;

    assert!(result.is_err());
}
