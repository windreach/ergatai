//! Integration tests for AdmissionGate

use std::sync::Arc;

use ergatai_api::messaging::admission::{
    AdmissionGate, AdmissionResult, AgentHealthGate, CompositeGate, ConversationLoopGate,
    MeshPolicyGate, RateLimitGate, SelfMessageGate,
};
use ergatai_api::messaging::SendRequest;
use ergatai_core::agent_registry::AgentRegistry;
use ergatai_runtime::{get_agent_runtime, AgentRuntime};

#[tokio::test]
async fn test_self_message_gate_denies_self_send() {
    let gate = SelfMessageGate::new();
    let runtime = get_agent_runtime();

    let request = SendRequest {
        from: "agent-1".to_string(),
        to: "agent-1".to_string(),
        message: "test".to_string(),
        message_type: "request".to_string(),
    };

    let result = gate.check(&request, &runtime).await;
    assert!(result.is_denied());

    if let AdmissionResult::Denied { reason } = result {
        assert!(reason.contains("Cannot send message to yourself"));
    }
}

#[tokio::test]
async fn test_self_message_gate_allows_different_agents() {
    let gate = SelfMessageGate::new();
    let runtime = get_agent_runtime();

    let request = SendRequest {
        from: "agent-1".to_string(),
        to: "agent-2".to_string(),
        message: "test".to_string(),
        message_type: "request".to_string(),
    };

    let result = gate.check(&request, &runtime).await;
    assert!(result.is_allowed());
}

#[tokio::test]
async fn test_composite_gate_short_circuits() {
    // Create a composite gate with SelfMessageGate first
    let gate = CompositeGate::new()
        .with_gate(Box::new(SelfMessageGate::new()))
        .with_gate(Box::new(RateLimitGate::new()));

    let runtime = get_agent_runtime();

    // This should be denied by SelfMessageGate before reaching RateLimitGate
    let request = SendRequest {
        from: "agent-1".to_string(),
        to: "agent-1".to_string(),
        message: "test".to_string(),
        message_type: "request".to_string(),
    };

    let result = gate.check(&request).await;
    assert!(result.is_denied());

    if let AdmissionResult::Denied { reason } = result {
        assert!(reason.contains("Cannot send message to yourself"));
    }
}

#[tokio::test]
async fn test_composite_gate_empty_allows_all() {
    let gate = CompositeGate::new();
    let runtime = get_agent_runtime();

    let request = SendRequest {
        from: "agent-1".to_string(),
        to: "agent-2".to_string(),
        message: "test".to_string(),
        message_type: "request".to_string(),
    };

    let result = gate.check(&request).await;
    assert!(result.is_allowed());
}

#[tokio::test]
async fn test_admission_result_methods() {
    let allowed = AdmissionResult::allowed();
    assert!(allowed.is_allowed());
    assert!(!allowed.is_denied());

    let denied = AdmissionResult::denied("test reason");
    assert!(!denied.is_allowed());
    assert!(denied.is_denied());

    if let AdmissionResult::Denied { reason } = denied {
        assert_eq!(reason, "test reason");
    }
}

#[tokio::test]
async fn test_composite_gate_len() {
    let empty_gate = CompositeGate::new();
    assert_eq!(empty_gate.len(), 0);
    assert!(empty_gate.is_empty());

    let gate_with_one = CompositeGate::new().with_gate(Box::new(SelfMessageGate::new()));
    assert_eq!(gate_with_one.len(), 1);
    assert!(!gate_with_one.is_empty());

    let gate_with_two = CompositeGate::new()
        .with_gate(Box::new(SelfMessageGate::new()))
        .with_gate(Box::new(RateLimitGate::new()));
    assert_eq!(gate_with_two.len(), 2);
}
