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

const DEFAULT_AGENT_REQUEST_TIMEOUT_MS: u64 = 300_000;

/// Default working directory for auto-spawned agents when no work_dir is specified.
/// Can be overridden via ERGATAI_DEFAULT_WORK_DIR environment variable.
const DEFAULT_WORK_DIR: &str = "/tmp";

fn default_work_dir() -> String {
    std::env::var("ERGATAI_DEFAULT_WORK_DIR").unwrap_or_else(|_| DEFAULT_WORK_DIR.to_string())
}

fn configured_agent_request_timeout_ms() -> u64 {
    match std::env::var("ERGATAI_AGENT_REQUEST_TIMEOUT_MS") {
        Ok(value) => value.parse().unwrap_or_else(|_| {
            warn!(
                value = %value,
                default_ms = DEFAULT_AGENT_REQUEST_TIMEOUT_MS,
                "Invalid ERGATAI_AGENT_REQUEST_TIMEOUT_MS; using default"
            );
            DEFAULT_AGENT_REQUEST_TIMEOUT_MS
        }),
        Err(_) => DEFAULT_AGENT_REQUEST_TIMEOUT_MS,
    }
}

/// Result of a message send operation.
#[derive(Debug)]
pub enum SendMessageResult {
    /// Message queued successfully via NATS JetStream.
    Queued {
        target_agent: String,
        stream: String,
        sequence: u64,
    },
    /// Message delivered directly via ACP protocol (NATS unavailable).
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

/// Context retained while waiting for an agent's response.
#[derive(Debug, Clone, PartialEq, Eq)]
struct PendingResponseContext {
    correlation_id: String,
    conversation_id: Option<String>,
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
    /// record its correlation ID and originating conversation. When B sends a
    /// response, pop this context so the reply is persisted to the same thread.
    pending_responses: Mutex<HashMap<String, Vec<PendingResponseContext>>>,
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

        // ── Step 1: Agent resolution (BEFORE admission control) ──
        // Resolve both sender and target agents first, auto-spawning if needed.
        // This ensures rate limiting and other gates see valid runtime agent IDs.

        // 1a. Resolve sender agent (auto-spawn if it's a profile name)
        let resolved_sender_id = match runtime.resolve_agent_id(&req.from).await {
            Some(id) => id,
            None => {
                // Sender not found — try to auto-spawn from profile
                // Use a default workspace for sender auto-spawn (sender doesn't need workspace context)
                match self
                    .try_auto_spawn_agent_standalone(&runtime, &req.from)
                    .await
                {
                    Some(agent_id) => {
                        info!(
                            sender = %req.from,
                            agent_id = %agent_id,
                            "Auto-spawned sender from profile"
                        );
                        agent_id
                    }
                    None => {
                        // Not a profile — check if it's a system sender
                        const SYSTEM_SENDERS: &[&str] = &["api", "user", "system"];
                        if SYSTEM_SENDERS.contains(&req.from.as_str()) {
                            // System senders bypass resolution
                            req.from.clone()
                        } else {
                            return SendMessageResult::Rejected {
                                reason: format!(
                                    "Sender '{}' is not a registered agent or valid profile name. \
                                     Cannot auto-spawn without profile configuration.",
                                    req.from
                                ),
                            };
                        }
                    }
                }
            }
        };

        // 1b. Resolve target agent (auto-spawn if it's a profile name)
        let resolved_target_id = match self.resolve_target_agent(&runtime, &req.to).await {
            Some(id) => id,
            None => {
                // Target not found — try to spawn from profile
                match self
                    .try_auto_spawn_agent(&runtime, &req.to, &resolved_sender_id)
                    .await
                {
                    Some(agent_id) => {
                        info!(
                            target = %req.to,
                            agent_id = %agent_id,
                            "Spawned target agent from profile (message-driven)"
                        );
                        agent_id
                    }
                    None => {
                        return SendMessageResult::Rejected {
                            reason: format!(
                                "Agent {} not found. Agent must connect via MCP or be running as an ACP agent. \
                                 or be a valid profile name.",
                                req.to
                            ),
                        };
                    }
                }
            }
        };

        // 1c. Create resolved request with actual runtime agent IDs
        let resolved_req = SendRequest {
            from: resolved_sender_id.clone(),
            to: resolved_target_id.clone(),
            message: req.message.clone(),
            message_type: req.message_type.clone(),
            correlation_id: req.correlation_id.clone(),
            sub_chat_id: req.sub_chat_id.clone(),
        };

        // ── Step 2: Admission control (AFTER agent resolution) ──
        // Now all gates see valid runtime agent IDs
        if let admission::AdmissionResult::Denied { reason } =
            self.admission_gate.check(&resolved_req, &runtime).await
        {
            return SendMessageResult::Rejected { reason };
        }

        // ── Step 3: Continue with resolved IDs ──
        // from_runtime_id is now the resolved_sender_id

        // ── 3. Resolve stable IDs (used for NATS payload enrichment + formatting) ──
        let from_stable = runtime
            .resolve_to_stable_id(&resolved_sender_id, None)
            .await;
        let to_stable = runtime
            .resolve_to_stable_id(&resolved_target_id, None)
            .await;

        // ── 4. Resolve sender display name ──
        // Use the resolved sender ID for display
        let from_runtime_id_for_payload = resolved_sender_id.clone();
        let conversation_receiver = resolved_target_id.clone();

        let sender_display = match self.get_sender_display(&resolved_sender_id).await {
            Some(display) => display,
            None => {
                return SendMessageResult::Rejected {
                    reason: format!(
                        "Sender '{}' is not bound to any runtime agent. \
                         MCP clients must be bound to ACP agents before sending messages. \
                         This ensures consistent ID usage in message routing.",
                        resolved_sender_id
                    ),
                };
            }
        };

        let pending_response = if req.message_type == "response" {
            self.take_pending_response(&resolved_sender_id, req.correlation_id.as_deref())
                .await
        } else {
            None
        };

        let mut target_sub_chat_id = req.sub_chat_id.clone().or_else(|| {
            pending_response
                .as_ref()
                .and_then(|p| p.conversation_id.clone())
        });
        if target_sub_chat_id.is_none() {
            let ensured_conversation_id = self
                .ensure_target_conversation(&resolved_sender_id, &resolved_target_id, &req.to)
                .await;
            if ensured_conversation_id.is_some() {
                target_sub_chat_id = ensured_conversation_id;
            }
        }

        if target_sub_chat_id.is_none() {
            for candidate in [
                resolved_sender_id.as_str(),
                from_stable.as_str(),
                req.from.as_str(),
                resolved_target_id.as_str(),
                to_stable.as_str(),
                req.to.as_str(),
            ] {
                // Wrap synchronous DB call in spawn_blocking to avoid blocking async runtime
                let candidate = candidate.to_string();
                match tokio::task::spawn_blocking(move || {
                    user_data_db::group_agent_bindings::find_conversation_id(&candidate)
                })
                .await
                {
                    Ok(Ok(Some(conversation_id))) => {
                        target_sub_chat_id = Some(conversation_id);
                        break;
                    }
                    Ok(Ok(None)) => {}
                    Ok(Err(e)) => {
                        warn!("MessageSender: failed to resolve agent binding: {}", e);
                    }
                    Err(e) => {
                        warn!("MessageSender: spawn_blocking failed: {}", e);
                    }
                }
            }
        }

        // NOTE: Message persistence to sub_chat moved to AFTER successful delivery (see below)
        // to prevent orphaned messages when delivery fails.

        // reply target = sender's stable ID (so recipient knows who to reply to)
        //
        // Compute correlation_id + timeout BEFORE format_agent_message so they can be
        // injected into the NATS payload (but NOT into the message content — agents don't see them).
        let is_request = req.message_type == "request";
        let timeout_ms: Option<u64> = if is_request {
            Some(configured_agent_request_timeout_ms())
        } else {
            None
        };
        let correlation_id: Option<String> = match req.message_type.as_str() {
            "request" => Some(uuid::Uuid::new_v4().to_string()),
            "response" => req
                .correlation_id
                .clone()
                .or_else(|| pending_response.as_ref().map(|p| p.correlation_id.clone())),
            _ => None,
        };

        let formatted_content = Self::format_agent_message(
            &sender_display,
            &req.message,
            &resolved_sender_id, // Use resolved sender ID as the reply target
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
                .get_agent(&resolved_target_id)
                .await
                .map(|info| info.agent_uuid);

            let payload = ergatai_nats::AgentMessagePayload {
                from_agent: resolved_sender_id.clone(),
                to_agent: resolved_target_id.clone(),
                from_uuid,
                to_uuid,
                from_stable: Some(from_stable),
                to_stable: Some(to_stable),
                content: formatted_content.clone(),
                thread_id: target_sub_chat_id.clone(),
                timestamp,
                metadata,
                // Generate unique message ID for tracking
                message_id: uuid::Uuid::new_v4().to_string(),
                // Request messages require read receipts
                requires_receipt: is_request,
                // correlation_id: generated for requests, echoed from req for responses
                correlation_id: correlation_id.clone(),
                // Default timeout for requests: 5 minutes (configurable)
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
                    self.mark_response_delivered(
                        &req.message_type,
                        correlation_id.as_deref(),
                        &resolved_sender_id,
                        &resolved_target_id,
                    )
                    .await;

                    self.conversation_manager
                        .record_delivered_message(
                            &from_runtime_id_for_payload,
                            &conversation_receiver,
                            &req.message,
                            &req.message_type,
                        )
                        .await;

                    // Persist message AFTER successful delivery. The sub-chat helper
                    // owns writes to the normalized `messages` table.
                    if let Some(conversation_id) = target_sub_chat_id.clone() {
                        let message = req.message.clone();
                        let from = req.from.clone();
                        let sender_name = sender_display.clone();
                        // Wrap synchronous DB call in spawn_blocking
                        if let Err(e) = tokio::task::spawn_blocking(move || {
                            let metadata = serde_json::json!({
                                "source": "agent",
                                "senderAgentId": from,
                                "senderAgentName": sender_name,
                            });
                            if let Err(e) = user_data_db::sub_chats::append_message(
                                &conversation_id,
                                "assistant",
                                &message,
                                metadata,
                            ) {
                                warn!("Failed to persist A-to-A message to sub_chats table: {}", e);
                            }
                        })
                        .await
                        {
                            warn!("Failed to persist delivered message: {}", e);
                        }
                    }

                    return SendMessageResult::Queued {
                        target_agent: resolved_target_id,
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

        // ── Fallback: direct delivery via ACP protocol ──
        match runtime
            .inject_message(&resolved_target_id, &formatted_content)
            .await
        {
            Ok(_) => {
                self.mark_response_delivered(
                    &req.message_type,
                    correlation_id.as_deref(),
                    &resolved_sender_id,
                    &resolved_target_id,
                )
                .await;

                self.conversation_manager
                    .record_delivered_message(
                        &from_runtime_id_for_payload,
                        &conversation_receiver,
                        &req.message,
                        &req.message_type,
                    )
                    .await;

                // Persist message AFTER successful delivery. The sub-chat helper
                // owns writes to the normalized `messages` table.
                if let Some(conversation_id) = target_sub_chat_id.clone() {
                    let message = req.message.clone();
                    let from = req.from.clone();
                    let sender_name = sender_display.clone();
                    // Wrap synchronous DB call in spawn_blocking
                    if let Err(e) = tokio::task::spawn_blocking(move || {
                    let metadata = serde_json::json!({
                            "source": "agent",
                            "senderAgentId": from,
                            "senderAgentName": sender_name,
                        });
                        if let Err(e) = user_data_db::sub_chats::append_message(
                            &conversation_id,
                            "user",
                            &message,
                            metadata,
                        ) {
                            warn!("Failed to persist A-to-A message to sub_chats table: {}", e);
                        }
                    })
                    .await
                    {
                        warn!("Failed to persist delivered message: {}", e);
                    }
                }

                SendMessageResult::DirectDelivered {
                    target_agent: resolved_target_id,
                }
            }
            Err(e) => SendMessageResult::Rejected {
                reason: format!(
                    "Failed to deliver message to {}: NATS publish failed and direct injection error: {}",
                    resolved_target_id, e
                ),
            },
        }
    }

    /// Ensure an agent-to-agent target has its own conversation below the chat.
    ///
    /// The sender's binding is only used to discover the owning chat. We never
    /// persist target messages into the supervisor conversation.
    async fn ensure_target_conversation(
        &self,
        sender_id: &str,
        target_id: &str,
        target_label: &str,
    ) -> Option<String> {
        let sender_id = sender_id.to_string();
        let seed_conversation_id = match tokio::task::spawn_blocking(move || {
            user_data_db::group_agent_bindings::find_conversation_id(&sender_id)
        })
        .await
        {
            Ok(Ok(Some(conversation_id))) => conversation_id,
            Ok(Ok(None)) => return None,
            Ok(Err(error)) => {
                warn!(error = %error, "Failed to resolve sender conversation for agent target");
                return None;
            }
            Err(error) => {
                warn!(error = %error, "Failed to resolve sender conversation task");
                return None;
            }
        };

        let target_id = target_id.to_string();
        let target_id_for_lookup = target_id.clone();
        let context = tokio::task::spawn_blocking(move || -> Result<_, String> {
            let seed_conversation = user_data_db::conversations::get(&seed_conversation_id)
                .map_err(|error| error.to_string())?
                .ok_or_else(|| "Sender conversation not found".to_string())?;
            let chat_id = seed_conversation
                .parent_id
                .unwrap_or_else(|| seed_conversation_id.clone());
            let root_conversation = user_data_db::conversations::get(&chat_id)
                .map_err(|error| error.to_string())?
                .ok_or_else(|| "Chat conversation not found".to_string())?;

            let existing = user_data_db::group_agent_bindings::list(&chat_id)
                .map_err(|error| error.to_string())?
                .into_iter()
                .find(|binding| binding.agent_id == target_id_for_lookup)
                .map(|binding| binding.conversation_id);

            Ok((chat_id, root_conversation, existing))
        })
        .await;

        let (chat_id, root_conversation, existing_conversation_id) = match context {
            Ok(Ok(context)) => context,
            Ok(Err(error)) => {
                warn!(error = %error, "Failed to resolve agent target chat");
                return None;
            }
            Err(error) => {
                warn!(error = %error, "Failed to resolve agent target chat task");
                return None;
            }
        };

        if let Some(conversation_id) = existing_conversation_id {
            return Some(conversation_id);
        }

        let conversation_id = format!("conversation_{}", uuid::Uuid::new_v4());
        let timestamp = chrono::Utc::now().timestamp();
        let conversation_id_for_db = conversation_id.clone();
        let chat_id_for_conversation = chat_id.clone();
        let chat_id_for_binding = chat_id.clone();
        let root_conversation_for_db = root_conversation.clone();
        let target_id_for_db = target_id.clone();
        let target_label_for_conversation = target_label.to_string();
        let target_label_for_agent_name = target_label.to_string();
        let target_label_for_agent_command = target_label.to_string();
        let conversation_id_for_create = conversation_id_for_db.clone();
        let conversation_id_for_binding = conversation_id_for_db.clone();
        let conversation_id_for_agent_session = conversation_id_for_db.clone();
        let result = tokio::task::spawn_blocking(move || -> Result<(), String> {
            user_data_db::conversations::create(user_data_db::Conversation {
                id: conversation_id_for_create,
                parent_id: Some(chat_id_for_conversation),
                project_id: root_conversation_for_db.project_id.clone(),
                workspace_id: root_conversation_for_db.workspace_id.clone(),
                name: Some(target_label_for_conversation),
                mode: "agent".to_string(),
                created_at: timestamp,
                updated_at: timestamp,
                archived_at: None,
            })
            .map_err(|error| error.to_string())?;

            user_data_db::group_agent_bindings::upsert(user_data_db::GroupAgentBinding {
                workspace_id: root_conversation_for_db
                    .workspace_id
                    .clone()
                    .unwrap_or_default(),
                chat_id: chat_id_for_binding,
                agent_id: target_id_for_db,
                agent_name: target_label_for_agent_name,
                agent_command: Some(target_label_for_agent_command),
                conversation_id: conversation_id_for_binding,
                created_at: timestamp,
                updated_at: timestamp,
            })
            .map_err(|error| error.to_string())?;

            user_data_db::agent_sessions::upsert(
                &conversation_id_for_agent_session,
                None,
                "agent",
                timestamp,
            )
            .map_err(|error| error.to_string())?;

            Ok(())
        })
        .await;

        match result {
            Ok(Ok(())) => {}
            Ok(Err(error)) => {
                warn!(error = %error, "Failed to create target agent conversation");
                return None;
            }
            Err(error) => {
                warn!(error = %error, "Failed to create target agent conversation task");
                return None;
            }
        }

        if let Ok(Ok(Some(session))) = tokio::task::spawn_blocking(move || {
            crate::services::collaboration_session::find_session_by_chat(&chat_id)
        })
        .await
        {
            let participant_conversation_id = conversation_id.clone();
            let participant_agent_id = target_id.clone();
            if let Err(error) = tokio::task::spawn_blocking(move || {
                crate::services::collaboration_session::upsert_participant(
                    &session.id,
                    crate::services::collaboration_session::ParticipantInput {
                        conversation_id: participant_conversation_id,
                        agent_id: participant_agent_id,
                        role: "peer".to_string(),
                        status: "ready".to_string(),
                    },
                )
            })
            .await
            {
                warn!(error = %error, "Failed to register target agent participant");
            }
        }

        Some(conversation_id)
    }

    async fn mark_response_delivered(
        &self,
        message_type: &str,
        correlation_id: Option<&str>,
        from_agent: &str,
        to_agent: &str,
    ) {
        if message_type != "response" {
            return;
        }

        let Some(correlation_id) = correlation_id else {
            warn!(
                from = %from_agent,
                to = %to_agent,
                "Response delivered without correlation_id; request timeout cannot be cleared"
            );
            return;
        };

        self.request_monitor.mark_responded(correlation_id).await;
        info!(
            correlation_id = %correlation_id,
            from = %from_agent,
            to = %to_agent,
            "Response delivered and request marked as responded"
        );
    }

    async fn take_pending_response(
        &self,
        responder_agent: &str,
        correlation_id: Option<&str>,
    ) -> Option<PendingResponseContext> {
        let mut pending = self.pending_responses.lock().await;
        let contexts = pending.get_mut(responder_agent)?;
        let position = match correlation_id {
            Some(correlation_id) => contexts
                .iter()
                .position(|context| context.correlation_id == correlation_id),
            None if contexts.is_empty() => None,
            None => Some(0),
        };
        let context = position.map(|position| contexts.remove(position));
        if contexts.is_empty() {
            pending.remove(responder_agent);
        }
        context
    }

    async fn store_pending_response(&self, responder_agent: &str, context: PendingResponseContext) {
        let mut pending = self.pending_responses.lock().await;
        let contexts = pending.entry(responder_agent.to_string()).or_default();
        while contexts.len() >= MAX_PENDING_PER_AGENT {
            contexts.remove(0);
        }
        contexts.push(context);
    }

    /// Resolve target agent ID from various identifier formats.
    /// CRITICAL FIX: Check MCP peer registry first, then fall back to runtime registry.
    /// This ensures MCP-only agents (not yet fully registered in runtime) can be found.
    async fn resolve_target_agent(&self, runtime: &AgentRuntime, target: &str) -> Option<String> {
        // Step 1: Check MCP peer registry first
        if let Some(peer_info) = self.peer_registry.get_agent(target).await {
            tracing::debug!(
                target = target,
                resolved_id = %peer_info.agent_id,
                "Resolved target via MCP peer registry"
            );
            return Some(peer_info.agent_id);
        }

        // Step 2: Fall back to runtime registry
        let agents = runtime.list_agents().await;

        tracing::debug!(
            target = target,
            agent_count = agents.len(),
            "Resolving target in runtime registry"
        );

        let result = agents
            .iter()
            .find(|a| {
                let matches = a.agent_id == target
                    || a.agent_id.starts_with(&format!("{}@", target))
                    || a.agent_uuid == target
                    || a.task_id.as_deref() == Some(target)
                    || a.stable_id.as_deref() == Some(target)
                    || a.handle
                        .metadata
                        .get("ergatai_agent_id")
                        .map(|id| id == target)
                        .unwrap_or(false);
                if matches {
                    tracing::debug!(
                        target = target,
                        matched_agent_id = %a.agent_id,
                        matched_agent_uuid = %a.agent_uuid,
                        "Found matching agent in runtime registry"
                    );
                }
                matches
            })
            .map(|a| a.agent_id.clone());

        if result.is_none() {
            tracing::debug!(target = target, "Target not found in any registry");
        }

        result
    }

    /// Try to auto-spawn an agent from a profile when target is not found.
    ///
    /// This enables "message-driven agent spawning": when an agent sends a message
    /// to a profile name (e.g., "claude-code") that isn't running, the system
    /// automatically spawns that agent from the profile registry and delivers the message.
    ///
    /// Returns Some(agent_id) if successfully spawned, None otherwise.
    async fn try_auto_spawn_agent(
        &self,
        runtime: &AgentRuntime,
        target: &str,
        sender_runtime_id: &str,
    ) -> Option<String> {
        // Check if target is a profile name
        let profile = match crate::services::profile_service::get_profile_by_name(target).await {
            Ok(Some(p)) => p,
            Ok(None) => return None, // Not a profile, let it fail normally
            Err(e) => {
                warn!(error = %e, target = target, "Failed to look up profile for auto-spawn");
                return None;
            }
        };

        // Get sender's workspace to spawn in the same workspace
        let sender_info = runtime.get_agent(sender_runtime_id).await?;
        let workspace_id = sender_info.workspace_id.clone();
        let work_dir = sender_info
            .handle
            .workspace
            .metadata
            .get("work_dir")
            .cloned()
            .unwrap_or_else(default_work_dir);

        // Build WorkspaceSpec
        let spec = ergatai_runtime::types::WorkspaceSpec {
            id: workspace_id.clone(),
            work_dir: std::path::PathBuf::from(&work_dir),
            env: std::collections::HashMap::new(),
            resources: Default::default(),
            capture_thoughts: false,
        };

        // Launch the agent
        info!(
            target = target,
            profile_name = %profile.name,
            workspace = %workspace_id,
            "Auto-spawning agent from profile (message-driven)"
        );

        match runtime
            .launch_agent(
                spec,
                &profile.command,
                None, // No initial instruction — the message itself is the instruction
                Some(&profile.name),
            )
            .await
        {
            Ok(agent_id) => {
                info!(
                    agent_id = %agent_id,
                    profile = %profile.name,
                    "Agent auto-spawned successfully"
                );
                Some(agent_id)
            }
            Err(e) => {
                warn!(
                    error = %e,
                    target = target,
                    "Failed to auto-spawn agent from profile"
                );
                None
            }
        }
    }

    /// Try to auto-spawn an agent from a profile when the SENDER is not found.
    ///
    /// This is similar to `try_auto_spawn_agent` but for the sender side.
    /// Uses a default workspace since the sender doesn't need workspace context.
    ///
    /// Returns Some(agent_id) if successfully spawned, None otherwise.
    async fn try_auto_spawn_agent_standalone(
        &self,
        runtime: &AgentRuntime,
        agent_name: &str,
    ) -> Option<String> {
        let agents = runtime.list_agents().await;
        if let Some(existing_agent) = agents
            .iter()
            .filter(|agent| {
                agent.lifecycle.is_alive()
                    && agent
                        .profile
                        .as_deref()
                        .is_some_and(|profile| profile.eq_ignore_ascii_case(agent_name))
            })
            .max_by_key(|agent| agent.created_at)
            .map(|agent| agent.agent_id.clone())
        {
            info!(
                agent = %agent_name,
                agent_id = %existing_agent,
                "Resolved sender agent by running profile"
            );
            return Some(existing_agent);
        }

        // Check if agent_name is a profile name
        let profile = match crate::services::profile_service::get_profile_by_name(agent_name).await
        {
            Ok(Some(p)) => p,
            Ok(None) => return None, // Not a profile, let it fail normally
            Err(e) => {
                warn!(error = %e, agent = %agent_name, "Failed to look up profile for sender auto-spawn");
                return None;
            }
        };

        // Use a default workspace for sender auto-spawn
        // The sender will be spawned in a default workspace with default work_dir
        let workspace_id = format!("auto-{}", uuid::Uuid::new_v4());
        let work_dir = default_work_dir();

        // Build WorkspaceSpec
        let spec = ergatai_runtime::types::WorkspaceSpec {
            id: workspace_id.clone(),
            work_dir: std::path::PathBuf::from(&work_dir),
            env: std::collections::HashMap::new(),
            resources: Default::default(),
            capture_thoughts: false,
        };

        // Launch the agent
        info!(
            agent = %agent_name,
            profile_name = %profile.name,
            workspace = %workspace_id,
            "Auto-spawning sender agent from profile"
        );

        match runtime
            .launch_agent(
                spec,
                &profile.command,
                None, // No initial instruction
                Some(&profile.name),
            )
            .await
        {
            Ok(agent_id) => {
                info!(
                    agent_id = %agent_id,
                    profile = %profile.name,
                    "Sender agent auto-spawned successfully"
                );
                Some(agent_id)
            }
            Err(e) => {
                warn!(
                    error = %e,
                    agent = %agent_name,
                    "Failed to auto-spawn sender agent from profile"
                );
                None
            }
        }
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
    /// but currently unused. They may be injected into the message payload in
    /// a future version if agents need to see these values for request/response
    /// correlation or timeout awareness.
    ///
    /// ## message_type effects
    ///
    /// Each `message_type` injects different behavioral instructions into the
    /// message payload, matching the expected agent response pattern:
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
        // but intentionally not used in message output
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
/// Called from `message_delivery.rs` after successful message delivery.
/// Supports multiple concurrent requests by appending to a Vec (FIFO order).
/// Maximum pending correlation IDs tracked per agent.
///
/// If an agent accumulates more pending requests than this (because it never
/// sends responses), older entries are silently dropped. This bounds memory
/// usage in long-running sessions with unresponsive agents.
const MAX_PENDING_PER_AGENT: usize = 100;

pub async fn record_pending_response(
    to_agent: &str,
    correlation_id: &str,
    conversation_id: Option<&str>,
) {
    if let Some(sender) = get_message_sender() {
        sender
            .store_pending_response(
                to_agent,
                PendingResponseContext {
                    correlation_id: correlation_id.to_string(),
                    conversation_id: conversation_id.map(str::to_string),
                },
            )
            .await;
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_format_agent_message_request_type() {
        let result = MessageSender::format_agent_message(
            "agent-1",
            "Hello",
            "agent-2",
            "request",
            None,
            None,
        );
        let parsed: serde_json::Value = serde_json::from_str(&result).unwrap();
        assert_eq!(parsed["from"], "agent-1");
        assert_eq!(parsed["message"], "Hello");
        assert_eq!(parsed["message_type"], "request");
        assert!(parsed["_reply"].as_str().unwrap().contains("agent-2"));
        assert!(parsed["_rules"].as_array().unwrap().len() >= 2);
    }

    #[test]
    fn test_format_agent_message_response_type() {
        let result = MessageSender::format_agent_message(
            "agent-1",
            "Response",
            "agent-2",
            "response",
            Some("corr-123"),
            None,
        );
        let parsed: serde_json::Value = serde_json::from_str(&result).unwrap();
        assert_eq!(parsed["from"], "agent-1");
        assert_eq!(parsed["message_type"], "response");
        assert!(parsed["_reply"].is_null());
    }

    #[test]
    fn test_format_agent_message_broadcast_type() {
        let result = MessageSender::format_agent_message(
            "agent-1",
            "Broadcast message",
            "agent-2",
            "broadcast",
            None,
            Some(60000),
        );
        let parsed: serde_json::Value = serde_json::from_str(&result).unwrap();
        assert_eq!(parsed["message_type"], "broadcast");
        assert!(parsed["_reply"].is_null());
    }

    #[test]
    fn test_format_agent_message_unknown_type() {
        let result = MessageSender::format_agent_message(
            "agent-1",
            "Unknown",
            "agent-2",
            "unknown_type",
            None,
            None,
        );
        let parsed: serde_json::Value = serde_json::from_str(&result).unwrap();
        assert_eq!(parsed["message_type"], "unknown_type");
        // Unknown types are treated like request
        assert!(parsed["_reply"].as_str().unwrap().contains("agent-2"));
    }
}

#[cfg(test)]
mod pending_response_tests {
    use super::*;

    #[tokio::test]
    async fn pending_response_context_is_taken_by_correlation_then_fifo() {
        let sender = MessageSender::new(
            Arc::new(ConversationManager::new(ConversationConfig::default())),
            Arc::new(ergatai_core::agent_registry::AgentRegistry::new()),
            Arc::new(RequestMonitor::new()),
        );
        sender
            .store_pending_response(
                "agent-2",
                PendingResponseContext {
                    correlation_id: "corr-1".to_string(),
                    conversation_id: Some("conversation-1".to_string()),
                },
            )
            .await;
        sender
            .store_pending_response(
                "agent-2",
                PendingResponseContext {
                    correlation_id: "corr-2".to_string(),
                    conversation_id: Some("conversation-2".to_string()),
                },
            )
            .await;

        let matched = sender
            .take_pending_response("agent-2", Some("corr-2"))
            .await
            .expect("matched context");
        assert_eq!(matched.conversation_id.as_deref(), Some("conversation-2"));

        let oldest = sender.take_pending_response("agent-2", None).await.unwrap();
        assert_eq!(oldest.correlation_id, "corr-1");
        assert_eq!(oldest.conversation_id.as_deref(), Some("conversation-1"));

        assert!(sender
            .take_pending_response("agent-2", None)
            .await
            .is_none());
    }
}
