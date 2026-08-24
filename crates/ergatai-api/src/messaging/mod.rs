//! MessageSender — unified message sending service for both REST API and MCP.
//!
//! This module encapsulates the full message sending pipeline:
//! 1. Rate limit check
//! 2. Agent resolution
//! 3. Self-message check
//! 4. MeshPolicy ACL
//! 5. is_reply detection
//! 6. ConversationManager check
//! 7. BatchAggregator record
//! 8. Message formatting (hint injection)
//! 9. NATS publish / direct inject
//!
//! Both REST API and MCP handlers call `MessageSender::send()` to ensure
//! consistent protection across all entry points.

use std::sync::Arc;
use std::sync::OnceLock;
use std::time::{SystemTime, UNIX_EPOCH};

use ergatai_core::agent_registry::{agent_registry, AgentRegistry};
use ergatai_core::cross_agent::{list_dag_schedulers, CommunicationCheck};
use ergatai_runtime::{get_agent_runtime, AgentRuntime};
use tracing::{info, warn};

use crate::mcp::batch_aggregator::get_batch_aggregator;
use crate::mcp::conversation::ConversationManager;
use crate::mcp::rate_limiter::get_rate_limiter;

/// Result of a message send operation.
#[derive(Debug)]
pub enum SendMessageResult {
    /// Message queued successfully via NATS JetStream.
    Queued {
        target_agent: String,
        stream: String,
        sequence: u64,
    },
    /// Message delivered directly via tmux injection (NATS unavailable).
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
    conversation_manager: Arc<ConversationManager>,
    peer_registry: Arc<AgentRegistry>,
}

impl MessageSender {
    /// Create a new MessageSender with the given conversation manager and peer registry.
    pub fn new(
        conversation_manager: Arc<ConversationManager>,
        peer_registry: Arc<AgentRegistry>,
    ) -> Self {
        Self {
            conversation_manager,
            peer_registry,
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

        // ── 1. Rate limit check ──
        let rl = get_rate_limiter();
        if let Err(e) = rl.try_acquire(&req.to) {
            warn!(%e, "MessageSender: rate-limited");
            return SendMessageResult::Rejected {
                reason: format!("Rate limited: {}", e),
            };
        }

        // ── 2. Agent resolution ──
        let resolved_agent_id = match self.resolve_target_agent(&runtime, &req.to).await {
            Some(id) => id,
            None => {
                return SendMessageResult::Rejected {
                    reason: format!(
                        "Agent {} not found. Agent must connect via MCP or be running in tmux.",
                        req.to
                    ),
                };
            }
        };

        // ── 3. Self-message check ──
        let from_runtime_id = runtime.resolve_agent_id(&req.from).await;
        if from_runtime_id.as_deref() == Some(&resolved_agent_id) {
            return SendMessageResult::Rejected {
                reason: format!(
                    "Cannot send message to yourself. Agent '{}' cannot target itself.",
                    req.from
                ),
            };
        }

        // ── 4. Resolve stable IDs (needed for MeshPolicy + conversation tracking) ──
        let from_stable = runtime.resolve_to_stable_id(&req.from, None).await;
        let to_stable = runtime.resolve_to_stable_id(&resolved_agent_id, None).await;

        // LOW NOTE: REST API messages (from='api') create separate conversations
        // (e.g., 'conv-api-agent-2') isolated from MCP-tracked conversations
        // (e.g., 'conv-agent-1-agent-2'). This is expected: REST is for external
        // tools/CI, not agent-to-agent communication. Rate limiting (step 1)
        // prevents abuse. Conversation loop prevention still applies, just with
        // independent tracking per sender.

        // ── 5. MeshPolicy ACL ──
        if let Some(reason) = self
            .check_mesh_policy(
                &req.from,
                &req.to,
                &resolved_agent_id,
                &from_runtime_id,
                &from_stable,
                &to_stable,
            )
            .await
        {
            return SendMessageResult::Rejected { reason };
        }

        // ── 6. is_reply detection ──
        let from_runtime_id_for_batch = from_runtime_id.clone().unwrap_or_else(|| req.from.clone());

        let is_reply = self
            .is_reply_message(
                &from_runtime_id_for_batch,
                &resolved_agent_id,
                &from_stable,
                &to_stable,
            )
            .await;

        info!(
            from = %req.from,
            from_stable = %from_stable,
            to = %resolved_agent_id,
            to_stable = %to_stable,
            is_reply = is_reply,
            "MessageSender: is_reply check complete"
        );

        // ── 7. Conversation loop prevention ──
        if let Err(e) = self
            .conversation_manager
            .check_and_record(&from_stable, &to_stable, &req.message)
            .await
        {
            warn!(
                from = %req.from,
                to = %resolved_agent_id,
                error = %e,
                "MessageSender: conversation loop prevention blocked message"
            );
            return SendMessageResult::Rejected {
                reason: format!("Message blocked by conversation loop prevention: {}", e),
            };
        }

        // ── 8. Batch aggregator record ──
        let batch_id = get_batch_aggregator()
            .record_send(&from_stable, &to_stable, is_reply)
            .await;

        if let Some(ref bid) = batch_id {
            info!(
                from = %req.from,
                to = %resolved_agent_id,
                batch_id = %bid,
                "MessageSender: message is part of a batch"
            );
        }

        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();

        // ── 9. Message formatting ──
        let sender_display = self.get_sender_display(&runtime, &req.from).await;
        let formatted_content = Self::format_agent_message(&sender_display, &req.message, is_reply);

        // ── 10. NATS publish or direct inject ──
        if let Some(conn) = ergatai_nats::get_nats_connection().await {
            let bus = ergatai_nats::EventBus::new(conn);
            let mut metadata = std::collections::HashMap::new();
            if let Some(ref bid) = batch_id {
                metadata.insert("batch_id".to_string(), bid.clone());
            }

            let from_uuid = runtime
                .get_agent(&from_runtime_id_for_batch)
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

        // ── Fallback: direct tmux injection ──
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

    /// Check MeshPolicy ACL for communication between agents.
    /// Returns Some(reason) if denied, None if allowed.
    ///
    /// CRITICAL FIX: Include both stable names AND runtime IDs in sender/receiver
    /// arrays, because DAG participants are declared as stable names (e.g., "agent-2")
    /// but messages may carry runtime IDs (e.g., "%16"). Without both, the ACL
    /// returns NotApplicable and is effectively bypassed.
    ///
    /// CRITICAL FIX 2: Include raw target ID in receiver_ids to handle cases where
    /// the original target identifier differs from resolved_agent_id and to_stable.
    async fn check_mesh_policy(
        &self,
        from: &str,
        raw_to: &str,
        resolved_to_id: &str,
        from_runtime_id: &Option<String>,
        from_stable: &str,
        to_stable: &str,
    ) -> Option<String> {
        let sender_ids = [from, from_runtime_id.as_deref().unwrap_or(""), from_stable];
        let receiver_ids = [raw_to, resolved_to_id, to_stable];

        'scheduler_loop: for scheduler in list_dag_schedulers() {
            for &s in &sender_ids {
                if s.is_empty() {
                    continue;
                }
                for &r in &receiver_ids {
                    if r.is_empty() {
                        continue;
                    }
                    match scheduler.check_communication(s, r).await {
                        CommunicationCheck::Denied(reason) => {
                            warn!(
                                from = %s,
                                to = %r,
                                reason = %reason,
                                "MessageSender: MeshPolicy denied message"
                            );
                            return Some(format!(
                                "Message rejected by DAG communication policy: {}. \
                                 Use `list_agents` to see which agents you can message, \
                                 or `get_collaboration_status` to inspect the active DAG rules.",
                                reason
                            ));
                        }
                        CommunicationCheck::Allowed => {
                            continue 'scheduler_loop;
                        }
                        CommunicationCheck::NotApplicable => {}
                    }
                }
            }
        }
        None
    }

    /// Check if this message is a reply (recipient previously sent to sender).
    async fn is_reply_message(
        &self,
        _from_runtime_id: &str,
        _to_runtime_id: &str,
        from_stable: &str,
        to_stable: &str,
    ) -> bool {
        // Build conversation ID (sorted alphabetically)
        let (a, b) = if from_stable < to_stable {
            (from_stable, to_stable)
        } else {
            (to_stable, from_stable)
        };
        let conversation_id = format!("conv-{}-{}", a, b);

        // Check token ownership
        if let Some(conv) = self
            .conversation_manager
            .get_conversation(&conversation_id)
            .await
        {
            matches!(&conv.token_owner, crate::mcp::conversation::TokenOwner::Held(holder) if holder.as_str() == from_stable)
        } else {
            false
        }
    }

    /// Get display name for sender (for message formatting).
    async fn get_sender_display(&self, runtime: &AgentRuntime, from: &str) -> String {
        let sender_runtime_id = runtime
            .resolve_agent_id(from)
            .await
            .unwrap_or_else(|| from.to_string());

        runtime
            .get_agent(&sender_runtime_id)
            .await
            .and_then(|info| {
                info.stable_id
                    .clone()
                    .or_else(|| info.handle.metadata.get("ergatai_agent_id").cloned())
            })
            .unwrap_or(sender_runtime_id)
    }

    /// Format agent message with JSON structure and hint.
    pub fn format_agent_message(sender_display: &str, message: &str, is_reply: bool) -> String {
        let message_json = serde_json::json!({
            "from": sender_display,
            "message": message
        });

        let hint = if is_reply {
            "[System prompt: No questions → output \"END\" in terminal, DO NOT call any tools; Has questions → reply via send_message MCP]"
        } else {
            "[System prompt: Reply via send_message MCP, then END]"
        };

        // Hint 保持可见 — ANSI conceal 和同色隐藏方案因终端兼容性差被否决
        format!("{}\n{}", message_json, hint)
    }
}

// ── Global accessor ──────────────────────────────────────────────────

static MESSAGE_SENDER: OnceLock<MessageSender> = OnceLock::new();

/// Initialize the global MessageSender (called once at startup).
pub fn init_message_sender(
    conversation_manager: Arc<ConversationManager>,
) -> &'static MessageSender {
    MESSAGE_SENDER.get_or_init(|| {
        MessageSender::new(conversation_manager, Arc::new(agent_registry().clone()))
    })
}

/// Get the global MessageSender reference.
/// Returns None if `init_message_sender()` was not called at startup.
/// MEDIUM FIX: Return Option instead of panicking, allowing graceful error handling.
pub fn get_message_sender() -> Option<&'static MessageSender> {
    MESSAGE_SENDER.get()
}
