//! AdmissionGate — composable admission control for message sending
//!
//! This module provides a trait-based approach to admission control, allowing
//! multiple checks to be composed into a single pipeline. Each gate can independently
//! allow or deny a message send request.
//!
//! ## Architecture
//!
//! ```text
//! SendRequest
//!     ↓
//! CompositeGate
//!     ↓
//! [RateLimitGate] → [ConversationLoopGate] → [MeshPolicyGate] → [AgentHealthGate]
//!     ↓
//! AdmissionResult (Allowed | Denied)
//! ```
//!
//! ## Usage
//!
//! ```ignore
//! use ergatai_api::messaging::admission::{CompositeGate, RateLimitGate, ConversationLoopGate};
//!
//! let gate = CompositeGate::new()
//!     .with_gate(RateLimitGate::new())
//!     .with_gate(ConversationLoopGate::new());
//!
//! match gate.check(&request).await {
//!     AdmissionResult::Allowed => { /* proceed */ }
//!     AdmissionResult::Denied { reason } => { /* reject */ }
//! }
//! ```

use std::sync::Arc;

use async_trait::async_trait;

use ergatai_core::cross_agent::list_dag_schedulers;
use ergatai_runtime::AgentRuntime;

use crate::mcp::conversation::ConversationManager;
use crate::messaging::SendRequest;

/// Result of an admission check
#[derive(Debug, Clone)]
pub enum AdmissionResult {
    /// Request is allowed to proceed
    Allowed,
    /// Request is denied with a reason
    Denied { reason: String },
}

impl AdmissionResult {
    /// Create an Allowed result
    pub fn allowed() -> Self {
        Self::Allowed
    }

    /// Create a Denied result with the given reason
    pub fn denied(reason: impl Into<String>) -> Self {
        Self::Denied {
            reason: reason.into(),
        }
    }

    /// Check if the result is Allowed
    pub fn is_allowed(&self) -> bool {
        matches!(self, Self::Allowed)
    }

    /// Check if the result is Denied
    pub fn is_denied(&self) -> bool {
        matches!(self, Self::Denied { .. })
    }
}

/// Trait for admission control gates
///
/// Each gate performs a specific check on the send request and returns
/// an AdmissionResult indicating whether the request should be allowed or denied.
#[async_trait]
pub trait AdmissionGate: Send + Sync {
    /// Check if the request should be allowed
    ///
    /// # Arguments
    /// * `request` - The send request to check
    /// * `runtime` - The agent runtime for resolving agent IDs
    ///
    /// # Returns
    /// AdmissionResult indicating whether the request is allowed or denied
    async fn check(&self, request: &SendRequest, runtime: &AgentRuntime) -> AdmissionResult;

    /// Get the name of this gate (for logging/debugging)
    fn name(&self) -> &'static str;
}

/// Composite gate that chains multiple admission gates
///
/// Evaluates gates in order. If any gate denies the request, the composite
/// gate returns that denial immediately (short-circuit evaluation).
pub struct CompositeGate {
    gates: Vec<Box<dyn AdmissionGate>>,
}

impl CompositeGate {
    /// Create a new empty composite gate
    pub fn new() -> Self {
        Self { gates: Vec::new() }
    }

    /// Add a gate to the chain
    pub fn with_gate(mut self, gate: Box<dyn AdmissionGate>) -> Self {
        self.gates.push(gate);
        self
    }

    /// Get the number of gates in the chain
    pub fn len(&self) -> usize {
        self.gates.len()
    }

    /// Check if the composite gate is empty
    pub fn is_empty(&self) -> bool {
        self.gates.is_empty()
    }
}

#[async_trait]
impl AdmissionGate for CompositeGate {
    async fn check(&self, request: &SendRequest, runtime: &AgentRuntime) -> AdmissionResult {
        for gate in &self.gates {
            let result = gate.check(request, runtime).await;
            if result.is_denied() {
                return result;
            }
        }

        AdmissionResult::Allowed
    }

    fn name(&self) -> &'static str {
        "CompositeGate"
    }
}

impl Default for CompositeGate {
    fn default() -> Self {
        Self::new()
    }
}

/// Rate limit gate — enforces per-agent rate limits
///
/// Checks the global rate limiter to ensure the sender hasn't exceeded
/// the configured message rate (default: 60 msg/min).
pub struct RateLimitGate;

impl RateLimitGate {
    /// Create a new rate limit gate
    pub fn new() -> Self {
        Self
    }
}

impl Default for RateLimitGate {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl AdmissionGate for RateLimitGate {
    async fn check(&self, request: &SendRequest, runtime: &AgentRuntime) -> AdmissionResult {
        // System senders (API, user) bypass rate limiting — they are trusted sources
        // that don't correspond to runtime agents. This allows the frontend/UI to
        // send messages without being registered as an agent.
        const SYSTEM_SENDERS: &[&str] = &["api", "user", "system"];
        if SYSTEM_SENDERS.contains(&request.from.as_str()) {
            return AdmissionResult::Allowed;
        }

        // SECURITY: Resolve sender to a known runtime agent ID. Reject unresolvable
        // senders instead of falling back to the raw string — otherwise an attacker
        // could rotate through N unique fake IDs, each getting its own 60 msg/min
        // rate-limit bucket, amplifying throughput N-fold before later gates catch it.
        let sender_id = match runtime.resolve_agent_id(&request.from).await {
            Some(id) => id,
            None => {
                return AdmissionResult::Denied {
                    reason: format!(
                        "Sender '{}' is not a registered runtime agent. \
                         Cannot enforce rate limits — message rejected.",
                        request.from
                    ),
                };
            }
        };

        match crate::mcp::get_rate_limiter().try_acquire(&sender_id) {
            Ok(_) => AdmissionResult::Allowed,
            Err(e) => AdmissionResult::Denied {
                reason: e.to_string(),
            },
        }
    }

    fn name(&self) -> &'static str {
        "RateLimitGate"
    }
}

/// Conversation loop prevention gate
///
/// Prevents infinite request-response loops between agents using
/// AutoGen-style cycle detection.
pub struct ConversationLoopGate {
    manager: Arc<ConversationManager>,
}

impl ConversationLoopGate {
    /// Create a new conversation loop gate
    pub fn new(manager: Arc<ConversationManager>) -> Self {
        Self { manager }
    }
}

#[async_trait]
impl AdmissionGate for ConversationLoopGate {
    async fn check(&self, request: &SendRequest, runtime: &AgentRuntime) -> AdmissionResult {
        let sender = runtime
            .resolve_agent_id(&request.from)
            .await
            .unwrap_or_else(|| request.from.clone());

        let receiver = runtime
            .resolve_agent_id(&request.to)
            .await
            .unwrap_or_else(|| request.to.clone());

        match self
            .manager
            .check_and_record(&sender, &receiver, &request.message)
            .await
        {
            Ok(_) => AdmissionResult::Allowed,
            Err(e) => AdmissionResult::Denied {
                reason: format!("Conversation loop prevention: {}", e),
            },
        }
    }

    fn name(&self) -> &'static str {
        "ConversationLoopGate"
    }
}

/// MeshPolicy ACL gate
///
/// Enforces DAG communication policies. If both sender and receiver are
/// participants in an active DAG session, the DAG's MeshPolicy must permit
/// this communication pair.
pub struct MeshPolicyGate;

impl MeshPolicyGate {
    /// Create a new mesh policy gate
    pub fn new() -> Self {
        Self
    }
}

impl Default for MeshPolicyGate {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl AdmissionGate for MeshPolicyGate {
    async fn check(&self, request: &SendRequest, runtime: &AgentRuntime) -> AdmissionResult {
        let sender = runtime
            .resolve_agent_id(&request.from)
            .await
            .unwrap_or_else(|| request.from.clone());

        let receiver = runtime
            .resolve_agent_id(&request.to)
            .await
            .unwrap_or_else(|| request.to.clone());

        for scheduler in list_dag_schedulers() {
            let check = scheduler.check_communication(&sender, &receiver).await;
            if check.is_denied() {
                return AdmissionResult::Denied {
                    reason: format!("{:?}", check),
                };
            }
            // NotApplicable: at least one endpoint is not a participant, skip this DAG
        }

        AdmissionResult::Allowed
    }

    fn name(&self) -> &'static str {
        "MeshPolicyGate"
    }
}

/// Agent health gate
///
/// Verifies that the target agent exists and is healthy (not zombie/dead).
pub struct AgentHealthGate;

impl AgentHealthGate {
    /// Create a new agent health gate
    pub fn new() -> Self {
        Self
    }
}

impl Default for AgentHealthGate {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl AdmissionGate for AgentHealthGate {
    async fn check(&self, request: &SendRequest, runtime: &AgentRuntime) -> AdmissionResult {
        // Resolve the target agent
        let resolved_agent_id = match runtime.resolve_agent_id(&request.to).await {
            Some(id) => id,
            None => {
                return AdmissionResult::Denied {
                    reason: format!(
                        "Agent {} not found. Agent must connect via MCP or be running in a PTY workspace.",
                        request.to
                    ),
                };
            }
        };

        // Check if agent exists in runtime
        match runtime.get_agent(&resolved_agent_id).await {
            Some(_) => AdmissionResult::Allowed,
            None => AdmissionResult::Denied {
                reason: format!("Agent {} is not available", resolved_agent_id),
            },
        }
    }

    fn name(&self) -> &'static str {
        "AgentHealthGate"
    }
}

/// Self-message gate
///
/// Prevents agents from sending messages to themselves.
pub struct SelfMessageGate;

impl SelfMessageGate {
    /// Create a new self-message gate
    pub fn new() -> Self {
        Self
    }
}

impl Default for SelfMessageGate {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl AdmissionGate for SelfMessageGate {
    async fn check(&self, request: &SendRequest, runtime: &AgentRuntime) -> AdmissionResult {
        let from_runtime_id = runtime.resolve_agent_id(&request.from).await;
        let to_runtime_id = runtime.resolve_agent_id(&request.to).await;

        // Check various forms of self-send
        let is_self_send =
            // Case 1: both resolve to the same runtime ID (if both exist)
            (from_runtime_id.is_some() && from_runtime_id == to_runtime_id)
            // Case 2: literal self-send (from == to as strings)
            || request.from == request.to
            // Case 3: from resolves to the literal to string
            || from_runtime_id.as_deref() == Some(&request.to)
            // Case 4: literal from string resolves to the to runtime ID
            || (to_runtime_id.is_some() && Some(request.from.as_str()) == to_runtime_id.as_deref());

        if is_self_send {
            AdmissionResult::Denied {
                reason: format!(
                    "Cannot send message to yourself. Agent '{}' cannot target itself.",
                    request.from
                ),
            }
        } else {
            AdmissionResult::Allowed
        }
    }

    fn name(&self) -> &'static str {
        "SelfMessageGate"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_admission_result_allowed() {
        let result = AdmissionResult::allowed();
        assert!(result.is_allowed());
        assert!(!result.is_denied());
    }

    #[test]
    fn test_admission_result_denied() {
        let result = AdmissionResult::denied("test reason");
        assert!(!result.is_allowed());
        assert!(result.is_denied());

        if let AdmissionResult::Denied { reason } = result {
            assert_eq!(reason, "test reason");
        } else {
            panic!("Expected Denied result");
        }
    }

    #[test]
    fn test_composite_gate_empty() {
        let gate = CompositeGate::new();
        assert!(gate.is_empty());
        assert_eq!(gate.len(), 0);
    }

    #[test]
    fn test_composite_gate_with_gates() {
        let gate = CompositeGate::new()
            .with_gate(Box::new(RateLimitGate::new()))
            .with_gate(Box::new(SelfMessageGate::new()));

        assert!(!gate.is_empty());
        assert_eq!(gate.len(), 2);
    }
}
