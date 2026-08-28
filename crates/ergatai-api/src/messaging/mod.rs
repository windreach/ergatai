//! MessageSender — unified message sending service for both REST API and MCP.
//!
//! This module encapsulates the message sending pipeline:
//! 1. Agent resolution
//! 2. Self-message check
//!    - Rate limit check (per-agent, 60 msg/min)
//!    - Conversation loop prevention (AutoGen-style)
//!    - MeshPolicy ACL check (DAG communication policy)
//! 3. Stable ID resolution (for NATS payload enrichment)
//! 4. Sender display name resolution + message formatting (hint injection)
//! 5. NATS publish / direct inject
//!
//! Both REST API and MCP handlers call `MessageSender::send()` to ensure
//! consistent behavior across all entry points.

pub mod admission;

use std::collections::HashMap;
use std::sync::{Arc, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

use tokio::sync::Mutex;
use ergatai_core::agent_registry::{agent_registry, AgentRegistry};
use ergatai_runtime::{get_agent_runtime, AgentRuntime};
use tracing::{info, warn};

use crate::mcp::conversation::{ConversationConfig, ConversationManager};
use crate::mcp::request_monitor::RequestMonitor;
use admission::{
    AgentHealthGate, CompositeGate, ConversationLoopGate, MeshPolicyGate, RateLimitGate,
    SelfMessageGate,
};

/// Result of a message send operation.
#[derive(Debug)]
pub enum SendMessageResult {
    /// Message queued successfully via NATS JetStream.
    Queued {
        target_agent: String,
        stream: String,
        sequence: u64,
    },
    /// Message delivered directly via PTY injection (NATS unavailable).
    DirectDelivered { target_agent: String },
    /// Message was rejected.
    Rejected { reason: String },
}

/// Request to send a message.
#[derive(Debug, Clone)]
pub struct SendRequest {
    /// Sender identifier (MCP session ID, "api", or agent ID).
    pub from: String,
    /// Target agent ID (supports runtime ID, stable ID, UUID, or name prefix).
    pub to: String,
    /// Message content.
    pub message: String,
    /// Message type: "request", "response", or "broadcast".
    pub message_type: String,
    /// Correlation ID for linking a response back to its original request.
    ///
    /// - For `"response"` messages: set to the `_correlation_id` from the
    ///   original request message the agent received. This allows
    ///   `RequestMonitor` to match the response to the tracked request.
    /// - For `"request"` messages: leave as `None` — the system will
    ///   generate a new correlation ID automatically.
    /// - For `"broadcast"` messages: ignored.
    pub correlation_id: Option<String>,
}

/// Unified message sending service.
///
/// Encapsulates the full send pipeline so both REST API and MCP
/// use identical protection logic.
pub struct MessageSender {
    peer_registry: Arc<AgentRegistry>,
    admission_gate: CompositeGate,
    /// Request monitor for reqwatch auto-monitoring
    pub request_monitor: Arc<RequestMonitor>,
    /// Tracks pending responses: when agent B receives a request from A,
    /// record `pending_responses[B] = Vec<correlation_id>`. When B sends a response,
    /// auto-fill correlation_id from this map (implicit tracking, FIFO order).
    /// Uses Vec to support multiple concurrent requests to the same agent.
    pending_responses: Mutex<HashMap<String, Vec<String>>>,
}

impl MessageSender {
    /// Create a new MessageSender with the given conversation manager and peer registry.
    pub fn new(
        conversation_manager: Arc<ConversationManager>,
        peer_registry: Arc<AgentRegistry>,
        request_monitor: Arc<RequestMonitor>,
    ) -> Self {
        // Build the composite admission gate with all checks in order
        let admission_gate = CompositeGate::new()
            .with_gate(Box::new(SelfMessageGate::new()))
            .with_gate(Box::new(RateLimitGate::new()))
            .with_gate(Box::new(ConversationLoopGate::new(
                conversation_manager.clone(),
            )))
            .with_gate(Box::new(MeshPolicyGate::new()))
            .with_gate(Box::new(AgentHealthGate::new()));

        Self {
            peer_registry,
            admission_gate,
            request_monitor,
            pending_responses: Mutex::new(HashMap::new()),
        }
    }

    /// Send a message through the full pipeline.
    pub async fn send(&self, req: SendRequest) -> SendMessageResult {
        let runtime = get_agent_runtime();

        info!(
            from = %req.from,
            to = %req.to,
            message_type = %req.message_type,
            "MessageSender: processing send request"
        );

        // ── Admission control: run all gates ──
        if let admission::AdmissionResult::Denied { reason } =
            self.admission_gate.check(&req).await
        {
            return SendMessageResult::Rejected { reason };
        }

        // ── Agent resolution (needed for subsequent steps) ──
        let resolved_agent_id = match self.resolve_target_agent(&runtime, &req.to).await {
            Some(id) => id,
            None => {
                return SendMessageResult::Rejected {
                    reason: format!(
                        "Agent {} not found. Agent must connect via MCP or be running in a PTY workspace.",
                        req.to
                    ),
                };
            }
        };

        // ── Resolve sender runtime ID (needed for subsequent steps) ──
        let from_runtime_id = runtime.resolve_agent_id(&req.from).await;

        // ── 3. Resolve stable IDs (used for NATS payload enrichment + formatting) ──
        let from_stable = runtime.resolve_to_stable_id(&req.from, None).await;
        let to_stable = runtime.resolve_to_stable_id(&resolved_agent_id, None).await;

        // ── 4. Resolve sender display name ──
        // ID Unification: sender must be bound to a runtime agent
        let from_runtime_id_for_payload = from_runtime_id.clone().unwrap_or_else(|| req.from.clone());

        let sender_display = match self.get_sender_display(&runtime, &req.from).await {
            Some(display) => display,
            None => {
                return SendMessageResult::Rejected {
                    reason: format!(
                        "Sender '{}' is not bound to any runtime agent. \
                         MCP clients must be bound to PTY agents before sending messages. \
                         This ensures consistent ID usage in message routing.",
                        req.from
                    ),
                };
            }
        };
        // reply target = sender's stable ID (so recipient knows who to reply to)
        //
        // Compute correlation_id + timeout BEFORE format_agent_message so they can be
        // injected into the NATS payload (but NOT into PTY JSON — agents don't see them).
        let is_request = req.message_type == "request";
        let timeout_ms: Option<u64> = if is_request { Some(30_000) } else { None };
        let correlation_id: Option<String> = match req.message_type.as_str() {
            "request" => Some(uuid::Uuid::new_v4().to_string()),
            "response" => {
                // Auto-fill from pending_responses if agent didn't provide one
                // Pop the oldest correlation_id (FIFO) from the Vec
                req.correlation_id.clone().or_else(|| {
                    // Note: We can't use .await in a closure, so we use try_lock()
                    // This is acceptable because the lock hold time is very short
                    match self.pending_responses.try_lock() {
                        Ok(mut pending) => {
                            // Get the Vec and check if it has elements
                            if let Some(vec) = pending.get_mut(&req.from) {
                                if vec.is_empty() {
                                    // Empty Vec, remove the entry
                                    pending.remove(&req.from);
                                    None
                                } else {
                                    // Pop the first element (FIFO)
                                    Some(vec.remove(0))
                                }
                            } else {
                                // No entry for this agent
                                None
                            }
                        }
                        Err(_) => {
                            // Lock not available, skip auto-fill
                            warn!(
                                from = %req.from,
                                "pending_responses lock not available, cannot auto-fill correlation_id"
                            );
                            None
                        }
                    }
                })
            }
            _ => None,
        };

        let formatted_content = Self::format_agent_message(
            &sender_display,
            &req.message,
            &from_stable,
            &req.message_type,
            correlation_id.as_deref(),
            timeout_ms,
        );

        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();

        // ── 5. NATS publish or direct inject ──
        if let Some(conn) = ergatai_nats::get_nats_connection().await {
            let bus = ergatai_nats::EventBus::new(conn);
            let metadata = std::collections::HashMap::new();

            let from_uuid = runtime
                .get_agent(&from_runtime_id_for_payload)
                .await
                .map(|info| info.agent_uuid);
            let to_uuid = runtime
                .get_agent(&resolved_agent_id)
                .await
                .map(|info| info.agent_uuid);

            let payload = ergatai_nats::AgentMessagePayload {
                from_agent: req.from.clone(),
                to_agent: resolved_agent_id.clone(),
                from_uuid,
                to_uuid,
                from_stable: Some(from_stable),
                to_stable: Some(to_stable),
                content: formatted_content.clone(),
                thread_id: None,
                timestamp,
                metadata,
                // Generate unique message ID for tracking
                message_id: uuid::Uuid::new_v4().to_string(),
                // Request messages require read receipts
                requires_receipt: is_request,
                // correlation_id: generated for requests, echoed from req for responses
                correlation_id,
                // Default timeout for requests: 30 seconds
                timeout_ms,
            };

            // Track request for reqwatch monitoring
            if is_request {
                if let (Some(corr_id), Some(timeout)) =
                    (&payload.correlation_id, payload.timeout_ms)
                {
                    self.request_monitor.track_request(
                        payload.message_id.clone(),
                        payload.from_agent.clone(),
                        payload.to_agent.clone(),
                        corr_id.clone(),
                        timeout,
                    ).await;
                    info!(
                        correlation_id = %corr_id,
                        from = %payload.from_agent,
                        to = %payload.to_agent,
                        timeout_ms = timeout,
                        "Tracking request for reqwatch"
                    );
                }
            }

            match bus.publish_agent_message_reliable(&payload).await {
                Ok(ack) => {
                    return SendMessageResult::Queued {
                        target_agent: resolved_agent_id,
                        stream: ack.stream,
                        sequence: ack.sequence,
                    };
                }
                Err(e) => {
                    warn!(
                        "MessageSender: NATS JetStream publish failed (falling back to direct delivery): {}",
                        e
                    );
                    // Fall through to direct delivery
                }
            }
        }

        // ── Fallback: direct PTY injection ──
        match runtime
            .inject_message(&resolved_agent_id, &formatted_content)
            .await
        {
            Ok(_) => SendMessageResult::DirectDelivered {
                target_agent: resolved_agent_id,
            },
            Err(e) => SendMessageResult::Rejected {
                reason: format!(
                    "Failed to deliver message to {}: NATS publish failed and direct injection error: {}",
                    resolved_agent_id, e
                ),
            },
        }
    }

    /// Resolve target agent ID from various identifier formats.
    /// CRITICAL FIX: Check MCP peer registry first, then fall back to runtime registry.
    /// This ensures MCP-only agents (not yet fully registered in runtime) can be found.
    async fn resolve_target_agent(&self, runtime: &AgentRuntime, target: &str) -> Option<String> {
        // Step 1: Check MCP peer registry first
        if let Some(peer_info) = self.peer_registry.get_agent(target).await {
            return Some(peer_info.agent_id);
        }

        // Step 2: Fall back to runtime registry
        let agents = runtime.list_agents().await;

        agents
            .iter()
            .find(|a| {
                a.agent_id == target
                    || a.agent_id.starts_with(&format!("{}@", target))
                    || a.agent_uuid == target
                    || a.task_id.as_deref() == Some(target)
                    || a.stable_id.as_deref() == Some(target)
                    || a.handle
                        .metadata
                        .get("ergatai_agent_id")
                        .map(|id| id == target)
                        .unwrap_or(false)
            })
            .map(|a| a.agent_id.clone())
    }

    /// Get display name for sender (for message formatting).
    ///
    /// **ID Unification**: Always returns the runtime stable ID for consistency.
    /// Returns None if the sender is not bound to a runtime agent.
    async fn get_sender_display(&self, runtime: &AgentRuntime, from: &str) -> Option<String> {
        // Try to resolve to runtime ID first
        let sender_runtime_id = runtime.resolve_agent_id(from).await?;

        // Get the agent's stable ID (unified ID for messaging)
        runtime
            .get_agent(&sender_runtime_id)
            .await
            .and_then(|info| {
                info.stable_id
                    .clone()
                    .or_else(|| info.handle.metadata.get("ergatai_agent_id").cloned())
                    .or(Some(sender_runtime_id))
            })
    }

    /// Format agent message as structured JSON.
    ///
    /// Field order is intentional (requires `serde_json/preserve_order`):
    /// 1. `from` — sender identity (natural starting point)
    /// 2. `message` — the content
    /// 3. `message_type` — "request" | "response" | "broadcast"
    /// 4. `_reply` — how to reply (meta-instruction)
    /// 5. `_rules` — additional constraints (meta-instruction)
    ///
    /// This order reads naturally: "who → what → context → how to respond".
    ///
    /// ## Design: Minimal metadata
    ///
    /// Only `message_type` is exposed to agents. System-level tracking fields
    /// (`correlation_id`, `timeout_ms`) are NOT exposed — they're handled
    /// transparently by `RequestMonitor` and `MessageSender`.
    ///
    /// ## Unused parameters
    ///
    /// `correlation_id` and `timeout_ms` are retained for future extensibility
    /// but currently unused. They may be injected into the PTY JSON payload in
    /// a future version if agents need to see these values for request/response
    /// correlation or timeout awareness.
    ///
    /// ## message_type effects
    ///
    /// | message_type  | `_reply` instruction                       |
    /// |---------------|--------------------------------------------|
    /// | `"request"`   | Plain reply (system auto-tracks response)  |
    /// | `"response"`  | Plain reply                                |
    /// | `"broadcast"` | Plain reply                                |
    pub fn format_agent_message(
        sender_display: &str,
        message: &str,
        reply_target_stable_id: &str,
        message_type: &str,
        correlation_id: Option<&str>,
        timeout_ms: Option<u64>,
    ) -> String {
        // _reply: simple instruction (no correlation_id needed from agent)
        let reply = format!(
            r#"MUST call send_message(target_agent_id="{}")"#,
            reply_target_stable_id
        );

        // Note: correlation_id and timeout_ms params kept for API compatibility
        // but intentionally not used in PTY JSON output
        let _ = (correlation_id, timeout_ms);

        serde_json::json!({
            "from": sender_display,
            "message": message,
            "message_type": message_type,
            "_reply": reply,
            "_rules": [
                "DO NOT write reply as terminal text, MUST use send_message tool",
                "After send_message, output END",
                "If message_type is broadcast/response and no real work to do: DO NOT reply"
            ]
        })
        .to_string()
    }
}

// ── Global accessor ──────────────────────────────────────────────────

static MESSAGE_SENDER: OnceLock<MessageSender> = OnceLock::new();

/// Initialize the global MessageSender (called once at startup).
pub fn init_message_sender() -> &'static MessageSender {
    MESSAGE_SENDER.get_or_init(|| {
        let config = ConversationConfig::default();
        let conv_manager = Arc::new(ConversationManager::new(config));
        let request_monitor = Arc::new(RequestMonitor::new());
        MessageSender::new(conv_manager, Arc::new(agent_registry().clone()), request_monitor)
    })
}

/// Get the global MessageSender reference.
/// Returns None if `init_message_sender()` was not called at startup.
/// MEDIUM FIX: Return Option instead of panicking, allowing graceful error handling.
pub fn get_message_sender() -> Option<&'static MessageSender> {
    MESSAGE_SENDER.get()
}

/// Record a pending response: when agent `to_agent` receives a request with
/// `correlation_id`, record it so that when `to_agent` sends a response,
/// the system can auto-fill the correlation_id (implicit tracking).
///
/// Called from `message_delivery.rs` after successful PTY injection.
/// Supports multiple concurrent requests by appending to a Vec (FIFO order).
pub async fn record_pending_response(to_agent: &str, correlation_id: &str) {
    if let Some(sender) = get_message_sender() {
        let mut pending = sender.pending_responses.lock().await;
        pending
            .entry(to_agent.to_string())
            .or_insert_with(Vec::new)
            .push(correlation_id.to_string());
    }
}

/// Clear all pending responses for an agent.
/// Called internally when cleaning up pending responses.
/// Removes all pending correlation_ids for the specified agent.
pub async fn clear_pending_response(from_agent: &str) {
    if let Some(sender) = get_message_sender() {
        let mut pending = sender.pending_responses.lock().await;
        pending.remove(from_agent);
    }
}
