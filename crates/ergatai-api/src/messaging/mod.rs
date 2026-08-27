//! MessageSender — unified message sending service for both REST API and MCP.
//!
//! This module encapsulates the message sending pipeline:
//! 1. Agent resolution
//! 2. Self-message check
//! 2.5 Rate limit check (per-agent, 60 msg/min)
//! 2.55 Conversation loop prevention (AutoGen-style)
//! 2.6 MeshPolicy ACL check (DAG communication policy)
//! 3. Stable ID resolution (for NATS payload enrichment)
//! 4. Sender display name resolution + message formatting (hint injection)
//! 5. NATS publish / direct inject
//!
//! Both REST API and MCP handlers call `MessageSender::send()` to ensure
//! consistent behavior across all entry points.

use std::sync::Arc;
use std::sync::OnceLock;
use std::time::{SystemTime, UNIX_EPOCH};

use ergatai_core::agent_registry::{agent_registry, AgentRegistry};
use ergatai_runtime::{get_agent_runtime, AgentRuntime};
use tracing::{info, warn};

use crate::mcp::conversation::{ConversationConfig, ConversationManager};

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
}

/// Unified message sending service.
///
/// Encapsulates the full send pipeline so both REST API and MCP
/// use identical protection logic.
pub struct MessageSender {
    peer_registry: Arc<AgentRegistry>,
    conversation_manager: Arc<ConversationManager>,
}

impl MessageSender {
    /// Create a new MessageSender with the given conversation manager and peer registry.
    pub fn new(
        conversation_manager: Arc<ConversationManager>,
        peer_registry: Arc<AgentRegistry>,
    ) -> Self {
        Self {
            peer_registry,
            conversation_manager,
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

        // ── 1. Agent resolution ──
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

        // ── 2. Self-message check ──
        // Compare runtime IDs and raw input to catch self-send forms.
        let from_runtime_id = runtime.resolve_agent_id(&req.from).await;

        // Case 1: runtime ID match (works when MCP is bound to PTY agent)
        // Case 2: raw input match (catches direct ID → ID self-send)
        // Case 3: from == to (catches literal self-send before any resolution)
        let is_self_send = from_runtime_id.as_deref() == Some(&resolved_agent_id)
            || req.from == resolved_agent_id
            || req.from == req.to;

        if is_self_send {
            return SendMessageResult::Rejected {
                reason: format!(
                    "Cannot send message to yourself. Agent '{}' cannot target itself.",
                    req.from
                ),
            };
        }

        // ── 2.5 Rate limit check (per-agent, 60 msg/min) ──
        let sender_id_for_rate = from_runtime_id.clone().unwrap_or_else(|| req.from.clone());
        if let Err(e) = crate::mcp::get_rate_limiter().try_acquire(&sender_id_for_rate) {
            return SendMessageResult::Rejected {
                reason: e.to_string(),
            };
        }

        // ── 2.55 Conversation loop prevention ──
        // AutoGen-style one-question-one-answer cycle breaker.
        let sender_for_conv = from_runtime_id.clone().unwrap_or_else(|| req.from.clone());
        let receiver_for_conv = runtime
            .resolve_agent_id(&resolved_agent_id)
            .await
            .unwrap_or_else(|| resolved_agent_id.clone());
        if let Err(e) = self
            .conversation_manager
            .check_and_record(&sender_for_conv, &receiver_for_conv, &req.message)
            .await
        {
            return SendMessageResult::Rejected {
                reason: format!("Conversation loop prevention: {}", e),
            };
        }

        // ── 2.6 MeshPolicy ACL check ──
        // If both sender and receiver are participants in any active DAG session,
        // the DAG's communication policy must permit this pair.
        let sender_for_acl = from_runtime_id.clone().unwrap_or_else(|| req.from.clone());
        let receiver_for_acl = runtime
            .resolve_agent_id(&resolved_agent_id)
            .await
            .unwrap_or_else(|| resolved_agent_id.clone());
        for scheduler in ergatai_core::cross_agent::list_dag_schedulers() {
            let check = scheduler
                .check_communication(&sender_for_acl, &receiver_for_acl)
                .await;
            if check.is_denied() {
                return SendMessageResult::Rejected {
                    reason: format!("{:?}", check),
                };
            }
            // NotApplicable: at least one endpoint is not a participant, skip this DAG
        }

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
        let formatted_content =
            Self::format_agent_message(&sender_display, &req.message, &from_stable);

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
            };

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
    /// The message instructs the recipient agent to use `send_message` to reply.
    pub fn format_agent_message(
        sender_display: &str,
        message: &str,
        reply_target_stable_id: &str,
    ) -> String {
        serde_json::json!({
            "from": sender_display,
            "message": message,
            "_reply": format!("MUST call send_message(target_agent_id=\"{}\")", reply_target_stable_id),
            "_rules": [
                "DO NOT write reply as terminal text, MUST use send_message tool",
                "After send_message, output END"
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
        MessageSender::new(conv_manager, Arc::new(agent_registry().clone()))
    })
}

/// Get the global MessageSender reference.
/// Returns None if `init_message_sender()` was not called at startup.
/// MEDIUM FIX: Return Option instead of panicking, allowing graceful error handling.
pub fn get_message_sender() -> Option<&'static MessageSender> {
    MESSAGE_SENDER.get()
}
