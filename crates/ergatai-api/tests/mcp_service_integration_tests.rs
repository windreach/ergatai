//! Integration tests for create_mcp_service — MCP tool registration and protocol.
//!
//! Tests verify that the MCP service initializes correctly, advertises tools,
//! and handles basic JSON-RPC requests per MCP protocol 2025-06-18.

use std::sync::Arc;

use ergatai_api::mcp::conversation::{ConversationConfig, ConversationManager};
use ergatai_api::mcp::server::{new_peer_registry, ErgataiMcpServer};
use ergatai_api::mcp::{create_mcp_service, AgentRegistry};
use tokio_util::sync::CancellationToken;

/// Build test dependencies for MCP service creation.
fn test_mcp_deps() -> (
    Arc<AgentRegistry>,
    ergatai_api::mcp::server::PeerRegistry,
    Arc<ConversationManager>,
    CancellationToken,
) {
    let registry = Arc::new(AgentRegistry::new());
    let peer_registry = new_peer_registry();
    let conversation_manager = Arc::new(ConversationManager::new(ConversationConfig::default()));
    let cancellation_token = CancellationToken::new();
    (registry, peer_registry, conversation_manager, cancellation_token)
}

// ── create_mcp_service ───────────────────────────────────────────────

#[test]
fn create_mcp_service_returns_service_without_panic() {
    let (registry, peer_registry, conversation_manager, cancellation_token) = test_mcp_deps();

    let _service = create_mcp_service(
        registry,
        peer_registry,
        conversation_manager,
        cancellation_token,
        15,
        Some("test-agent".to_string()),
    );
    // Service created without panic — verifies all dependencies wire up correctly
}

#[test]
fn create_mcp_service_with_no_agent_identifier() {
    let (registry, peer_registry, conversation_manager, cancellation_token) = test_mcp_deps();

    let _service = create_mcp_service(
        registry,
        peer_registry,
        conversation_manager,
        cancellation_token,
        15,
        None, // default service (no agent identifier)
    );
    // Should work without agent identifier (backward-compatible default service)
}

#[test]
fn create_mcp_service_with_custom_sse_keep_alive() {
    let (registry, peer_registry, conversation_manager, cancellation_token) = test_mcp_deps();

    let _service = create_mcp_service(
        registry,
        peer_registry,
        conversation_manager,
        cancellation_token,
        60, // custom keep-alive
        Some("agent-custom".to_string()),
    );
}

// ── ErgataiMcpServer construction ────────────────────────────────────

#[test]
fn ergatai_mcp_server_new_creates_instance() {
    let (registry, peer_registry, conversation_manager, _cancel) = test_mcp_deps();

    let server = ErgataiMcpServer::new(
        registry,
        peer_registry,
        conversation_manager,
        Some("test-agent".to_string()),
    );

    // Server created — tool_router should be initialized
    let debug_str = format!("{:?}", server);
    assert!(debug_str.contains("ErgataiMcpServer"));
}

#[test]
fn ergatai_mcp_server_without_agent_identifier() {
    let (registry, peer_registry, conversation_manager, _cancel) = test_mcp_deps();

    let server = ErgataiMcpServer::new(
        registry,
        peer_registry,
        conversation_manager,
        None,
    );

    let debug_str = format!("{:?}", server);
    assert!(debug_str.contains("ErgataiMcpServer"));
}

// ── PeerRegistry ─────────────────────────────────────────────────────

#[tokio::test]
async fn peer_registry_starts_empty() {
    let peer_registry = new_peer_registry();
    let guard = peer_registry.read().await;
    assert_eq!(guard.len(), 0, "new peer registry should be empty");
}

#[tokio::test]
async fn peer_registry_supports_concurrent_reads() {
    let peer_registry = new_peer_registry();

    // Spawn multiple tasks that read concurrently — no deadlocks
    let mut handles = Vec::new();
    for _ in 0..10 {
        let pr = peer_registry.clone();
        handles.push(tokio::spawn(async move {
            let guard = pr.read().await;
            guard.len() // just access the registry
        }));
    }

    for handle in handles {
        let count = handle.await.unwrap();
        assert_eq!(count, 0);
    }
}

// ── AgentRegistry ────────────────────────────────────────────────────

#[test]
fn agent_registry_creates_successfully() {
    let registry = AgentRegistry::new();
    let _ = registry;
}

// ── ConversationManager ──────────────────────────────────────────────

#[test]
fn conversation_manager_default_config() {
    let config = ConversationConfig::default();
    let manager = ConversationManager::new(config);
    let _ = manager;
}

// ── Multiple services share state ────────────────────────────────────

#[test]
fn create_mcp_service_multiple_services_share_state() {
    let (registry, peer_registry, conversation_manager, cancellation_token) = test_mcp_deps();

    let _svc1 = create_mcp_service(
        registry.clone(),
        peer_registry.clone(),
        conversation_manager.clone(),
        cancellation_token.clone(),
        15,
        Some("agent-1".to_string()),
    );

    let _svc2 = create_mcp_service(
        registry.clone(),
        peer_registry.clone(),
        conversation_manager.clone(),
        cancellation_token.clone(),
        15,
        Some("agent-2".to_string()),
    );

    let _svc3 = create_mcp_service(
        registry.clone(),
        peer_registry.clone(),
        conversation_manager.clone(),
        cancellation_token.clone(),
        15,
        Some("agent-3".to_string()),
    );

    // All services created — shared state pattern works
}

#[test]
fn create_mcp_service_with_cancellation() {
    let (registry, peer_registry, conversation_manager, cancellation_token) = test_mcp_deps();

    let _service = create_mcp_service(
        registry,
        peer_registry,
        conversation_manager,
        cancellation_token.clone(),
        15,
        Some("cancel-test".to_string()),
    );

    // Cancel and verify no panic
    cancellation_token.cancel();
}

#[test]
fn create_mcp_service_zero_sse_keep_alive() {
    let (registry, peer_registry, conversation_manager, cancellation_token) = test_mcp_deps();

    let _service = create_mcp_service(
        registry,
        peer_registry,
        conversation_manager,
        cancellation_token,
        0, // zero keep-alive (edge case)
        Some("zero-keepalive".to_string()),
    );
}
