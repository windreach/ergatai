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

use ergatai_core::agent_registry::{agent_registry, AgentRegistry};
use ergatai_runtime::AgentRuntime;
use tokio::sync::Mutex;
use tracing::{info, warn};

use crate::mcp::conversation::{ConversationConfig, ConversationManager};
use crate::mcp::request_monitor::RequestMonitor;
use crate::user_data_db;
use admission::{
    AdmissionGate, AgentHealthGate, CompositeGate, ConversationLoopGate, MeshPolicyGate,
    RateLimitGate, SelfMessageGate,
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
    /// Optional UI thread to persist/render this external message.
    pub sub_chat_id: Option<String>,
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
    /// Conversation manager for tracking agent conversations (dashboard access).
    conversation_manager: Arc<ConversationManager>,
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
            conversation_manager,
        }
    }

    /// Get a reference to the conversation manager (used by dashboard API).
    pub fn conversation_manager(&self) -> &Arc<ConversationManager> {
        &self.conversation_manager
    }

    /// Send a message through the full pipeline.
    pub async fn send(&self, req: SendRequest) -> SendMessageResult {
        // SECURITY: Enforce message size limit before any processing.
        // Without this, a single agent can send multi-MB messages at 60 msg/min,
        // exhausting NATS JetStream disk (24h TTL × 60 MB/min = 86 GB/day).
        const MAX_MESSAGE_BYTES: usize = 64 * 1024; // 64 KB
        if req.message.len() > MAX_MESSAGE_BYTES {
            return SendMessageResult::Rejected {
                reason: format!(
                    "Message too large: {} bytes exceeds limit of {} bytes",
                    req.message.len(),
                    MAX_MESSAGE_BYTES
                ),
            };
        }

        let runtime = crate::context::get_app_context().agent_runtime.clone();

        info!(
            from = %req.from,
            to = %req.to,
            message_type = %req.message_type,
            message_bytes = req.message.len(),
            "MessageSender: processing send request"
        );

        // ── Admission control: run all gates ──
        if let admission::AdmissionResult::Denied { reason } =
            self.admission_gate.check(&req, &runtime).await
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
        // ID Unification: sender must be bound to a runtime agent.
        // Use the MCP URL path name (e.g., "agent-1") as the `from` field,
        // so the receiving agent sees the same ID format it uses in its own
        // MCP path — keeping IDs uniform across the system.
        let from_runtime_id_for_payload =
            from_runtime_id.clone().unwrap_or_else(|| req.from.clone());
        let conversation_receiver = runtime
            .resolve_agent_id(&req.to)
            .await
            .unwrap_or_else(|| req.to.clone());

        let sender_display = match self.get_sender_display(&req.from).await {
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

        let mut target_sub_chat_id = req.sub_chat_id.clone();
        if target_sub_chat_id.is_none() {
            for candidate in [
                resolved_agent_id.as_str(),
                to_stable.as_str(),
                req.to.as_str(),
            ] {
                match user_data_db::group_agent_bindings::find_sub_chat_id(candidate) {
                    Ok(Some(sub_chat_id)) => {
                        target_sub_chat_id = Some(sub_chat_id);
                        break;
                    }
                    Ok(None) => {}
                    Err(e) => {
                        warn!("MessageSender: failed to resolve agent binding: {}", e);
                    }
                }
            }
        }

        if let Some(sub_chat_id) = target_sub_chat_id.as_deref() {
            if let Err(e) = user_data_db::sub_chats::append_message(
                sub_chat_id,
                "user",
                &req.message,
                serde_json::json!({
                    "source": "agent",
                    "senderAgentId": req.from.clone(),
                    "senderAgentName": sender_display,
                }),
            ) {
                return SendMessageResult::Rejected {
                    reason: format!("Failed to persist external UI message: {}", e),
                };
            }
        }

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
                if let Some(cid) = req.correlation_id.clone() {
                    Some(cid)
                } else {
                    // Use .await instead of try_lock() to avoid silent failures under contention
                    let mut pending = self.pending_responses.lock().await;
                    let cid = pending
                        .get_mut(&req.from)
                        .filter(|v| !v.is_empty())
                        .map(|v| v.remove(0));
                    // Remove the key if the Vec is now empty to prevent HashMap leak.
                    // Without this, every agent that ever received a request leaves
                    // an empty Vec entry behind after its last response is popped.
                    if pending.get(&req.from).is_some_and(|v| v.is_empty()) {
                        pending.remove(&req.from);
                    }
                    cid
                }
            }
            _ => None,
        };

        let formatted_content = Self::format_agent_message(
            &sender_display,
            &req.message,
            &req.from, // Use MCP URL path name (e.g., "agent-1") as the reply target.
            // This is the unified ID format — same as what the agent
            // sees in its own MCP path (/mcp/agent-1/...).
            &req.message_type,
            correlation_id.as_deref(),
            timeout_ms,
        );

        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();

        // ── 5. NATS publish or direct inject ──
        if let Some(conn) =
            crate::context::try_get_app_context().and_then(|ctx| ctx.nats_connection.clone())
        {
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
                    self.request_monitor
                        .track_request(
                            payload.message_id.clone(),
                            payload.from_agent.clone(),
                            payload.to_agent.clone(),
                            corr_id.clone(),
                            timeout,
                        )
                        .await;
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
                    self.conversation_manager
                        .record_delivered_message(
                            &from_runtime_id_for_payload,
                            &conversation_receiver,
                            &req.message,
                            &req.message_type,
                        )
                        .await;
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
            Ok(_) => {
                self.conversation_manager
                    .record_delivered_message(
                        &from_runtime_id_for_payload,
                        &conversation_receiver,
                        &req.message,
                        &req.message_type,
                    )
                    .await;
                SendMessageResult::DirectDelivered {
                    target_agent: resolved_agent_id,
                }
            }
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
    /// Uses the MCP-registered name directly (e.g., "alice") instead of
    /// resolving to workspace agent ID. This makes the `from` field intuitive
    /// and user-controlled.
    async fn get_sender_display(&self, from: &str) -> Option<String> {
        // Use the MCP client name directly — no resolution to workspace ID
        Some(from.to_string())
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
    /// Each `message_type` injects different behavioral instructions into the
    /// PTY JSON payload, matching the expected agent response pattern:
    ///
    /// | message_type  | `_reply` | `_rules` focus                              |
    /// |---------------|----------|---------------------------------------------|
    /// | `"request"`   | ✅ MUST  | "use send_message tool, then output END"    |
    /// | `"response"`  | ✗ null   | "conversation ended, stay silent"           |
    /// | `"broadcast"` | ✗ null   | "FYI only, stay silent unless specific task"|
    ///
    /// The key insight: `_reply` is the #1 instruction LLMs follow. For
    /// response/broadcast, unconditional `_reply` creates conflicting directives
    /// (e.g. "MUST call send_message" vs "broadcast → DO NOT reply"), causing
    /// agents to message themselves or waste tokens on unnecessary replies.
    pub fn format_agent_message(
        sender_display: &str,
        message: &str,
        reply_target_stable_id: &str,
        message_type: &str,
        correlation_id: Option<&str>,
        timeout_ms: Option<u64>,
    ) -> String {
        // Note: correlation_id and timeout_ms params kept for API compatibility
        // but intentionally not used in PTY JSON output
        let _ = (correlation_id, timeout_ms);

        // Build type-specific instructions.
        // _reply is only set for "request" — response/broadcast get null to
        // avoid the LLM following a "MUST reply" instruction when silence is
        // the correct behavior.
        let (reply_value, rules): (serde_json::Value, Vec<&str>) = match message_type {
            "request" => (
                serde_json::json!(format!(
                    "MUST call send_message(target_agent_id='{}')",
                    reply_target_stable_id
                )),
                vec![
                    "DO NOT write reply as terminal text, MUST use send_message tool",
                    "After send_message, output END",
                ],
            ),
            "response" => (
                serde_json::Value::Null,
                vec![
                    "response messages end the conversation — DO NOT reply unless there is NEW work to do",
                    "Silence means done. Output END in terminal.",
                ],
            ),
            "broadcast" => (
                serde_json::Value::Null,
                vec![
                    "broadcast messages are FYI only — DO NOT reply unless the broadcast contains a SPECIFIC task for you",
                    "General greetings or announcements need NO response. Output END in terminal.",
                ],
            ),
            // Fallback: treat unknown types like request
            _ => (
                serde_json::json!(format!(
                    "MUST call send_message(target_agent_id='{}')",
                    reply_target_stable_id
                )),
                vec![
                    "DO NOT write reply as terminal text, MUST use send_message tool",
                    "After send_message, output END",
                ],
            ),
        };

        serde_json::json!({
            "from": sender_display,
            "message": message,
            "message_type": message_type,
            "_reply": reply_value,
            "_rules": rules,
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
        MessageSender::new(
            conv_manager,
            Arc::new(agent_registry().clone()),
            request_monitor,
        )
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
/// Maximum pending correlation IDs tracked per agent.
///
/// If an agent accumulates more pending requests than this (because it never
/// sends responses), older entries are silently dropped. This bounds memory
/// usage in long-running sessions with unresponsive agents.
const MAX_PENDING_PER_AGENT: usize = 100;

pub async fn record_pending_response(to_agent: &str, correlation_id: &str) {
    if let Some(sender) = get_message_sender() {
        let mut pending = sender.pending_responses.lock().await;
        let vec = pending.entry(to_agent.to_string()).or_insert_with(Vec::new);
        // Bound the Vec to prevent unbounded growth when the target agent
        // never responds. Drop oldest entries (FIFO) to stay under the cap.
        while vec.len() >= MAX_PENDING_PER_AGENT {
            vec.remove(0);
        }
        vec.push(correlation_id.to_string());
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
