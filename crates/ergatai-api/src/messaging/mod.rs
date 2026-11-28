//! MessageSender — unified message sending service for both REST API and MCP.
//!
//! This module encapsulates the message sending pipeline:
//! 1. Agent resolution
//! 2. Self-message check
//!    - Rate limit check (per-agent, 60 msg/min)
//!    - Conversation loop prevention (AutoGen-style)
//!    - MeshPolicy ACL check (DAG communication policy)
//! 3. Agent ID resolution (for NATS payload enrichment)
//! 4. Sender display name resolution + message formatting (hint injection)
//! 5. NATS publish / direct inject
//!
//! Both REST API and MCP handlers call `MessageSender::send()` to ensure
//! consistent behavior across all entry points.

pub mod admission;
pub mod mailbox;

use std::collections::HashMap;
use std::sync::{Arc, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

use ergatai_core::agent_registry::{agent_registry, AgentRegistry};
use ergatai_core::id::{format as format_id, generate, parse_to_i64, IdType};
use ergatai_error::{AgentId, ChatId, ConversationId};
use ergatai_runtime::launch::{AgentLauncher, LaunchPlan};
use ergatai_runtime::AgentRuntime;
use tokio::sync::Mutex;
use tracing::{info, warn};

use crate::mcp::conversation::{ConversationConfig, ConversationManager};
use crate::mcp::request_monitor::RequestMonitor;
use crate::services::agent_launch::{EnsureAgentRequest, LaunchMode, ModelInput};
use crate::user_data_db;
use admission::{
    AdmissionGate, AgentHealthGate, CompositeGate, ConversationLoopGate, MeshPolicyGate,
    RateLimitGate, SelfMessageGate,
};

// Default timeout for agent requests: 5 minutes (300,000 ms).
//
// This was previously 30 seconds but was increased to 5 minutes to accommodate
// longer-running operations (e.g., large code generation, complex refactoring tasks).
// Agents performing multi-step work or waiting for user input may need more than 30s.
// Can be overridden via ERGATAI_AGENT_REQUEST_TIMEOUT_MS environment variable.
const DEFAULT_AGENT_REQUEST_TIMEOUT_MS: u64 = 300_000;

/// Default working directory for auto-spawned agents when no work_dir is specified.
/// Can be overridden via ERGATAI_DEFAULT_WORK_DIR environment variable.
const DEFAULT_WORK_DIR: &str = "/tmp";

fn default_work_dir() -> String {
    std::env::var("ERGATAI_DEFAULT_WORK_DIR").unwrap_or_else(|_| DEFAULT_WORK_DIR.to_string())
}

/// Whether a chat binding belongs to the given agent/profile name.
///
/// The authoritative field is `agent_name`, but older builds overwrote it with
/// the runtime agent id when a user prompted the participant directly. Fall
/// back to the binding's command (e.g. `opencode acp`) so name-addressed
/// messages still reuse the participant's existing conversation instead of
/// auto-spawning a duplicate.
fn binding_matches_agent_name(
    binding: &user_data_db::GroupAgentBinding,
    target_name: &str,
) -> bool {
    if binding.agent_name.eq_ignore_ascii_case(target_name) {
        return true;
    }

    binding
        .agent_command
        .as_deref()
        .map(str::trim)
        .filter(|command| !command.is_empty())
        .is_some_and(|command| {
            command.eq_ignore_ascii_case(target_name)
                || command
                    .split_whitespace()
                    .next()
                    .is_some_and(|program| program.eq_ignore_ascii_case(target_name))
        })
}

/// Apply the profile's default provider model to a freshly launched agent.
///
/// This is the same runtime switch the model selector uses. Failures are logged
/// but never block message delivery — the agent can still answer with whatever
/// model its own configuration selected.
async fn apply_spawn_default_model(
    agent_id: &str,
    profile_name: &str,
    default_model: Option<&str>,
) {
    let Some(model) = default_model
        .map(str::trim)
        .filter(|model| !model.is_empty())
    else {
        return;
    };
    if let Err(error) = crate::services::agent_service::set_agent(agent_id, model).await {
        warn!(
            agent_id = %agent_id,
            profile = profile_name,
            model = %model,
            error = %error,
            "Failed to apply default provider model to auto-spawned agent"
        );
    }
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

/// Parse an agent ID string to i64 for database storage.
///
/// Accepts both:
/// - Snowflake IDs (e.g., "agent_123_001_0001") - preferred format
/// - Legacy simple IDs (e.g., "ws1-agent-1") - extracts trailing counter for backward compatibility
///
/// Returns None if the input cannot be parsed to a valid i64.
#[inline]
fn parse_agent_id_to_i64(id_str: &str) -> Option<i64> {
    // Try Snowflake format first
    if let Some(id) = ergatai_error::id::parse_to_i64(id_str) {
        return Some(id);
    }

    // Fallback: try to extract numeric counter from legacy format (e.g., "ws1-agent-1" → 1)
    // This maintains backward compatibility with old data in the database
    // Only accept IDs that match the pattern "*-agent-{counter}" to avoid incorrect parsing
    if id_str.contains("-agent-") {
        if let Some(last_dash_pos) = id_str.rfind('-') {
            if let Some(counter_str) = id_str.get((last_dash_pos + 1)..) {
                if let Ok(counter) = counter_str.parse::<i64>() {
                    tracing::debug!(
                        original_id = %id_str,
                        parsed_counter = counter,
                        "Parsed legacy agent ID format, extracted trailing counter"
                    );
                    return Some(counter);
                }
            }
        }
    }

    tracing::debug!(
        id_str = %id_str,
        "Failed to parse agent ID: not a Snowflake ID and no trailing numeric counter found"
    );
    None
}

/// Result of a message send operation.
#[derive(Debug)]
pub enum SendMessageResult {
    /// Message queued successfully via NATS JetStream.
    Queued {
        target_agent: String,
        stream: String,
        sequence: u64,
        /// Stable ID of the request envelope persisted in the target
        /// conversation. Used for request/output correlation.
        message_id: String,
        correlation_id: Option<String>,
    },
    /// Message delivered directly via ACP protocol (NATS unavailable).
    DirectDelivered {
        target_agent: String,
        message_id: String,
        correlation_id: Option<String>,
    },
    /// Message was rejected.
    Rejected { reason: String },
}

/// Request to send a message.
#[derive(Debug, Clone)]
pub struct SendRequest {
    /// Sender identifier (MCP session ID, "api", or agent ID).
    pub from: String,
    /// Target agent ID (supports runtime ID, conversation_id, or name prefix).
    pub to: String,
    /// When present, the system uses `ergatai.conversation.message.{conversation_id}` subject
    /// instead of `ergatai.agent.message.{agent_id}`.
    /// This is the new preferred routing; `to` is kept for backward compatibility.
    pub target_conversation_id: Option<String>,
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
    pub conversation_id: Option<String>,
    /// Frontend-generated request ID for optimistic → durable message replacement.
    /// Stored in NATS payload metadata and persisted as `externalMessageId` in SQLite.
    pub client_request_id: Option<String>,
}

/// Context retained while waiting for an agent's response.
#[derive(Debug, Clone, PartialEq, Eq)]
struct PendingResponseContext {
    correlation_id: String,
}

/// Unified message sending service.
///
/// Encapsulates the full send pipeline so both REST API and MCP
/// use identical protection logic.
/// Process-wide per-target spawn locks.
///
/// Concurrent sends to the same target (agent ID, profile name or conversation
/// ID) are serialized so that auto-resume / auto-spawn cannot both observe
/// "no agent" and create duplicates. The lock is held only for the duration of
/// target resolution (including spawn), not for the whole send pipeline.
static SPAWN_LOCKS: OnceLock<std::sync::Mutex<HashMap<String, Arc<Mutex<()>>>>> = OnceLock::new();

fn spawn_locks() -> &'static std::sync::Mutex<HashMap<String, Arc<Mutex<()>>>> {
    SPAWN_LOCKS.get_or_init(|| std::sync::Mutex::new(HashMap::new()))
}

fn spawn_lock(key: &str) -> Arc<Mutex<()>> {
    let mut map = spawn_locks().lock().unwrap_or_else(|e| e.into_inner());
    map.entry(key.to_string())
        .or_insert_with(|| Arc::new(Mutex::new(())))
        .clone()
}

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

/// Find a running agent by conversation_id.
///
/// Uses the conversation_id index for O(1) lookup since conversation_id == conversation_id
/// (populated from `handle.metadata.get("conversation_id")`).
///
/// This is useful for routing messages to agents when only the conversation_id
/// is known (e.g., when resuming a suspended agent's conversation).
async fn find_agent_by_conversation(
    runtime: &AgentRuntime,
    conversation_id: &str,
) -> Option<String> {
    // Use conversation_id index for O(1) lookup (conversation_id == conversation_id)
    let info = runtime
        .registry()
        .resolve_conversation_id(conversation_id)
        .await?;
    if info.lifecycle.is_alive() {
        tracing::debug!(
            conversation_id = %conversation_id,
            agent_id = %info.agent_id,
            "Found running agent with matching conversation_id (O(1) conversation_id index)"
        );
        Some(info.agent_id)
    } else {
        None
    }
}

/// Whether a string is a typed routing id (`conv_...`, `agent_...`) rather than
/// a human/profile name.
fn looks_like_typed_id(value: &str) -> bool {
    let value = value.trim();
    value.starts_with("conv_") || value.starts_with("agent_")
}

/// Targets that must be resolved through the runtime/MCP registries instead of
/// the chat-scoped name binding.
fn target_looks_like_explicit_id(target: &str) -> bool {
    let target = target.trim();
    looks_like_typed_id(target) || target.contains('@')
}

/// Derive the profile name a participant should be spawned/resumed as.
///
/// `agent_command` is usually the profile command (`opencode`, `codex`, ...).
/// Full paths or commands with arguments are not profile names, so fall back to
/// `agent_name` when it is not a runtime id.
fn binding_profile_name(binding: &user_data_db::GroupAgentBinding) -> Option<String> {
    binding
        .agent_command
        .as_deref()
        .map(str::trim)
        .filter(|command| !command.is_empty() && !command.contains('/') && !command.contains(' '))
        .map(str::to_string)
        .or_else(|| (!looks_like_typed_id(&binding.agent_name)).then(|| binding.agent_name.clone()))
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

        // 1b. Resolve target agent (auto-spawn if it's a profile name).
        //
        // Routing order is conversation-first:
        //   1. An explicit conversation id always wins and never triggers
        //      name-based auto-spawn.
        //   2. Profile names resolve through the sender's chat participant
        //      binding before any global runtime/MCP lookup.
        //   3. Typed runtime ids / MCP ids fall back to the registries.
        //
        // Serialize concurrent sends to the same target so auto-resume /
        // auto-spawn cannot both observe "no agent" and create duplicates.
        let explicit_target_conversation = req
            .target_conversation_id
            .as_deref()
            .or(req.conversation_id.as_deref())
            .and_then(|id| ConversationId::decode(id).ok());

        let resolved_target_id = {
            let lock_key = explicit_target_conversation
                .map(|conversation_id| format!("conv:{}", conversation_id.encode()))
                .unwrap_or_else(|| format!("target:{}", req.to));
            let _target_spawn_mutex = spawn_lock(&lock_key);
            let _target_resolution_guard = _target_spawn_mutex.lock().await;

            if let Some(conversation_id) = explicit_target_conversation {
                let conversation_id_str = conversation_id.encode();
                match crate::services::agent_service::resolve_agent_for_conversation(
                    &conversation_id_str,
                )
                .await
                {
                    Some(agent_id) => {
                        info!(
                            target = %req.to,
                            conversation_id = %conversation_id_str,
                            agent_id = %agent_id,
                            "Resolved target from explicit conversation"
                        );
                        agent_id
                    }
                    None => {
                        // The process is gone. Reuse the conversation's
                        // participant binding so a respawn stays on the same
                        // conversation instead of creating a second one.
                        let binding = tokio::task::spawn_blocking(move || {
                            user_data_db::group_agent_bindings::find_by_conversation_id(
                                conversation_id,
                            )
                        })
                        .await
                        .ok()
                        .and_then(|result| result.ok())
                        .flatten();

                        let Some(binding) = binding else {
                            return SendMessageResult::Rejected {
                                reason: format!(
                                    "No participant is bound to conversation {}. \
                                     Bind the participant before sending.",
                                    conversation_id_str
                                ),
                            };
                        };
                        let Some(profile_name) = binding_profile_name(&binding) else {
                            return SendMessageResult::Rejected {
                                reason: format!(
                                    "Conversation {} has no resolvable profile name.",
                                    conversation_id_str
                                ),
                            };
                        };

                        match self
                            .try_auto_spawn_agent(&runtime, &profile_name, &resolved_sender_id)
                            .await
                        {
                            Some(agent_id) => {
                                info!(
                                    target = %profile_name,
                                    conversation_id = %conversation_id_str,
                                    agent_id = %agent_id,
                                    "Spawned target for explicit conversation"
                                );
                                agent_id
                            }
                            None => {
                                return SendMessageResult::Rejected {
                                    reason: format!(
                                        "Conversation {} has no running agent and profile '{}' \
                                         could not be spawned.",
                                        conversation_id_str, profile_name
                                    ),
                                };
                            }
                        }
                    }
                }
            } else if !target_looks_like_explicit_id(&req.to) {
                // Profile-name routing: the chat-scoped binding is the
                // authority. It is unique per (chat, name) after the identity
                // migration, so this cannot select a duplicate participant.
                if let Some(agent_id) = self
                    .resolve_target_in_sender_chat(&resolved_sender_id, &req.to)
                    .await
                {
                    info!(
                        target = %req.to,
                        agent_id = %agent_id,
                        "Resolved target via chat-scoped agent-name binding"
                    );
                    agent_id
                } else {
                    // Not running/resumable (or not bound yet). Auto-spawn
                    // reuses the chat-scoped binding's conversation when
                    // present, otherwise it creates the first binding.
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
                            // Fall back to MCP/runtime ids that don't match our
                            // typed prefixes (custom adapters).
                            match self.resolve_target_agent(&runtime, &req.to).await {
                                Some(agent_id) => agent_id,
                                None => {
                                    return SendMessageResult::Rejected {
                                        reason: format!(
                                            "Agent {} not found. Agent must connect via MCP \
                                             or be running as an ACP agent, or be a valid \
                                             profile name.",
                                            req.to
                                        ),
                                    };
                                }
                            }
                        }
                    }
                }
            } else {
                // Explicit runtime/agent/conversation/MCP id.
                if let Some(agent_id) = self.resolve_target_agent(&runtime, &req.to).await {
                    agent_id
                } else if let Some(agent_id) = find_agent_by_conversation(&runtime, &req.to).await {
                    agent_id
                } else if let Some(auto_resumed_id) = self
                    .try_auto_resume_suspended_agent(
                        &runtime,
                        &req.to,
                        req.conversation_id
                            .as_deref()
                            .or(req.target_conversation_id.as_deref()),
                    )
                    .await
                {
                    info!(
                        target = %req.to,
                        conversation_id = ?req.conversation_id,
                        resumed_agent_id = %auto_resumed_id,
                        "Auto-resumed suspended target agent"
                    );
                    auto_resumed_id
                } else {
                    return SendMessageResult::Rejected {
                        reason: format!(
                            "Agent {} not found. Agent must connect via MCP or be running as \
                             an ACP agent.",
                            req.to
                        ),
                    };
                }
            }
        };

        // A conversation-first send may have resumed or respawned the
        // participant; keep the binding's process pointer current.
        if let Some(conversation_id) = explicit_target_conversation {
            self.sync_conversation_agent(conversation_id, &resolved_target_id)
                .await;
        }

        // 1c. Create resolved request with actual runtime agent IDs
        let resolved_req = SendRequest {
            from: resolved_sender_id.clone(),
            to: resolved_target_id.clone(),
            target_conversation_id: req.target_conversation_id.clone(), // Pass through Conversation ID
            message: req.message.clone(),
            message_type: req.message_type.clone(),
            correlation_id: req.correlation_id.clone(),
            conversation_id: req.conversation_id.clone(),
            client_request_id: req.client_request_id.clone(),
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

        // Explicit conversation ids win; only name/id-addressed sends need the
        // participant binding to supply (or create) the conversation.
        let mut target_conversation_id = explicit_target_conversation;
        if target_conversation_id.is_none() {
            let ensured_conversation_id = self
                .ensure_target_conversation(&resolved_sender_id, &resolved_target_id, &req.to)
                .await;
            if ensured_conversation_id.is_some() {
                target_conversation_id = ensured_conversation_id;
            }
        }

        if target_conversation_id.is_none() {
            for candidate in [
                resolved_sender_id.as_str(),
                req.from.as_str(),
                resolved_target_id.as_str(),
                req.to.as_str(),
            ] {
                // Parse agent ID string to i64 for database query.
                // Accepts both Snowflake IDs (e.g., "agent_123_001_0001") and legacy format (e.g., "ws1-agent-1").
                let candidate = candidate.to_string();
                let Some(agent_id_i64) = parse_agent_id_to_i64(&candidate) else {
                    warn!("MessageSender: failed to parse agent ID '{}'", candidate);
                    continue;
                };

                // Wrap synchronous DB call in spawn_blocking to avoid blocking async runtime
                match tokio::task::spawn_blocking(move || {
                    user_data_db::group_agent_bindings::find_conversation_id(agent_id_i64)
                })
                .await
                {
                    Ok(Ok(Some(conversation_id))) => {
                        target_conversation_id = Some(conversation_id);
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

        // Conversation-centric delivery requires a real Conversation ID. Never
        // queue a message that the consumer would have to discard later.
        let Some(target_conversation_id) = target_conversation_id else {
            return SendMessageResult::Rejected {
                reason: format!(
                    "Unable to resolve a bound Conversation for target '{}'. \
                     Bind the target to a chat/conversation before sending.",
                    req.to
                ),
            };
        };

        // NOTE: Message persistence to sub_chat moved to AFTER successful delivery (see below)
        // to prevent orphaned messages when delivery fails.

        // reply target = sender's ergatai_agent_id (so recipient knows who to reply to)
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
            "request" => Some(format_id(generate(), IdType::Message)),
            "response" => pending_response
                .as_ref()
                .map(|p| p.correlation_id.clone())
                .or_else(|| req.correlation_id.clone()),
            _ => None,
        };

        // Responses carry the origin of the request they answer. Read it here,
        // before `mark_response_delivered` removes the pending request, and
        // persist it on the reply as `replyToTurnId`. The UI can then attach
        // replies without re-parsing agent-specific tool-call shapes.
        let request_origin = if req.message_type == "response" {
            match correlation_id.as_deref() {
                Some(correlation_id) => self.request_monitor.request_origin(correlation_id).await,
                None => None,
            }
        } else {
            None
        };
        if let Some(origin) = &request_origin {
            info!(
                correlation_id = ?correlation_id,
                origin_conversation_id = ?origin.conversation_id,
                origin_turn_id = ?origin.turn_id,
                "Attaching response to originating request turn"
            );
        }

        let formatted_content = Self::format_agent_message(
            &sender_display,
            &self.get_sender_conversation_id(&resolved_sender_id).await,
            &req.message,
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
            let mut metadata = std::collections::HashMap::new();
            // Store frontend-generated client_request_id in metadata for dedup matching
            if let Some(client_request_id) = &req.client_request_id {
                metadata.insert("clientRequestId".to_string(), client_request_id.clone());
            }
            // Link a response to the conversation/turn that issued the request.
            if let Some(origin) = &request_origin {
                if let Some(turn_id) = &origin.turn_id {
                    metadata.insert("originTurnId".to_string(), turn_id.clone());
                }
                if let Some(conversation_id) = &origin.conversation_id {
                    metadata.insert("originConversationId".to_string(), conversation_id.clone());
                }
            }
            let queued_message_id = format_id(generate(), IdType::Message);
            let queued_external_message_id = req
                .client_request_id
                .clone()
                .unwrap_or_else(|| queued_message_id.clone());
            let queued_conversation_id = target_conversation_id;
            let sender_conversation_id = self.get_sender_conversation_id(&resolved_sender_id).await;
            let _sender_conversation_id_for_copy =
                ConversationId::decode(&sender_conversation_id).ok();

            let payload = ergatai_nats::AgentMessagePayload {
                from_agent: resolved_sender_id.clone(),
                to_agent: resolved_target_id.clone(),
                content: formatted_content.clone(),
                timestamp,
                metadata,
                message_id: queued_message_id.clone(),
                // Request messages require read receipts
                requires_receipt: is_request,
                // correlation_id: generated for requests, echoed from req for responses
                correlation_id: correlation_id.clone(),
                // Default timeout for requests: 5 minutes (configurable)
                timeout_ms,
                // Message type for proper classification on the receiving end
                message_type: req.message_type.clone(),
                // Conversation ID for direct delivery (bypasses agent_id intermediary).
                target_conversation_id: Some(target_conversation_id),
                // Images/files (empty for agent-to-agent messages, used for user messages)
                images: vec![],
                files: vec![],
            };

            // Track request for reqwatch monitoring
            if is_request {
                if let (Some(corr_id), Some(timeout)) =
                    (&payload.correlation_id, payload.timeout_ms)
                {
                    // Capture the issuing turn so the eventual response can be
                    // linked back to it (see `request_origin` above).
                    let origin_turn_id =
                        match ergatai_runtime::output_accumulator::get_global_accumulator_registry()
                        {
                            Some(registry) => registry
                                .get_current_token(&sender_conversation_id)
                                .await
                                .map(|token| token.turn_id),
                            None => None,
                        };
                    self.request_monitor
                        .track_request_with_origin(
                            payload.message_id.clone(),
                            payload.from_agent.clone(),
                            payload.to_agent.clone(),
                            corr_id.clone(),
                            timeout,
                            Some(sender_conversation_id.clone()),
                            origin_turn_id.clone(),
                        )
                        .await;
                    info!(
                        correlation_id = %corr_id,
                        from = %payload.from_agent,
                        to = %payload.to_agent,
                        timeout_ms = timeout,
                        origin_conversation_id = %sender_conversation_id,
                        origin_turn_id = ?origin_turn_id,
                        "Tracking request for reqwatch"
                    );
                }
            }

            // Unified agent-centric routing: publish to ergatai.agent.message.{agent_id}
            // The target_conversation_id is included in the payload for direct Cov delivery on the consumer side.
            let publish_result = bus
                .publish_agent_message_reliable(&payload)
                .await
                .map(|ack| (ack.stream, ack.sequence));

            match publish_result {
                Ok((stream, sequence)) => {
                    // Persist the queued inter-agent message immediately. The
                    // delivery consumer checks the same external ID and skips
                    // its later persistence pass, so this only moves the UI
                    // visibility point from injection time to acceptance time.
                    let parsed_content: Option<serde_json::Value> =
                        serde_json::from_str(&formatted_content).ok();
                    let actual_message = parsed_content
                        .as_ref()
                        .and_then(|value| value.get("message"))
                        .and_then(serde_json::Value::as_str)
                        .unwrap_or(&formatted_content)
                        .to_string();
                    let sender_name = parsed_content
                        .as_ref()
                        .and_then(|value| value.get("from"))
                        .and_then(serde_json::Value::as_str)
                        .unwrap_or(&sender_display)
                        .to_string();
                    let early_metadata = serde_json::json!({
                        "externalMessageId": queued_external_message_id,
                        "clientRequestId": req.client_request_id.clone(),
                        "senderAgentId": resolved_sender_id,
                        "senderAgentName": sender_name,
                        "messageType": req.message_type,
                        "correlationId": correlation_id.clone(),
                        "replyToTurnId": request_origin.as_ref().and_then(|origin| origin.turn_id.clone()),
                        "replyToConversationId": request_origin.as_ref().and_then(|origin| origin.conversation_id.clone()),
                        "deliveryStatus": "pending",
                    });
                    let early_parts =
                        serde_json::json!([{ "type": "text", "text": actual_message }]);
                    let early_from = resolved_sender_id.clone();
                    let early_sender_name = sender_name.clone();
                    let early_message_type = req.message_type.clone();
                    let early_content = actual_message.clone();
                    let early_target_id = resolved_target_id.clone();
                    let queued_external_message_id_for_log = queued_external_message_id.clone();
                    let append_result = tokio::task::spawn_blocking(move || {
                        let early_external_message_id = queued_external_message_id.clone();
                        let role =
                            agent_message_role(&early_message_type, &early_from, &early_target_id);
                        let agent_fields = user_data_db::messages::AgentMessageFields {
                            from_agent_id: parse_to_i64(&early_from),
                            from_agent_name: Some(early_sender_name),
                            message_type: Some(early_message_type),
                            content: Some(early_content),
                            ..Default::default()
                        };

                        user_data_db::messages::append_idempotent(
                            queued_conversation_id,
                            role,
                            early_parts,
                            early_metadata,
                            Some(agent_fields),
                            Some(&early_external_message_id),
                        )
                    })
                    .await;

                    match append_result {
                        Ok(Ok(outcome)) => {
                            if outcome.inserted {
                                publish_to_conversation_subject_with_message(
                                    outcome.message,
                                    Some(resolved_sender_id.clone()),
                                    Some(sender_display.clone()),
                                )
                                .await;
                            } else {
                                tracing::debug!(
                                    external_message_id = %queued_external_message_id_for_log,
                                    "Sender early persist skipped (already exists); not re-pushing SSE"
                                );
                            }
                        }
                        Ok(Err(error)) => {
                            warn!(
                                message_id = %queued_message_id,
                                conversation_id = %queued_conversation_id,
                                error = %error,
                                "Failed to persist queued agent message early"
                            );
                        }
                        Err(error) => {
                            warn!(
                                message_id = %queued_message_id,
                                conversation_id = %queued_conversation_id,
                                error = %error,
                                "Failed to join early queued message persistence task"
                            );
                        }
                    }

                    // Note: With per-conversation tables, messages are only stored in the
                    // target conversation. No side-copy is needed, eliminating duplicate rendering.

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

                    // Note: Message persistence and SSE streaming are now handled by the consumer
                    // in message_delivery.rs, not here. This ensures unified delivery path for
                    // both user and agent messages.

                    return SendMessageResult::Queued {
                        target_agent: resolved_target_id,
                        stream,
                        sequence,
                        message_id: queued_message_id.clone(),
                        correlation_id,
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
        let direct_message_id = format_id(generate(), IdType::Message);
        let conversation_key = target_conversation_id.to_string();
        if let Some(registry) =
            ergatai_runtime::output_accumulator::get_global_accumulator_registry()
        {
            registry
                .set_pending_turn_context(
                    &conversation_key,
                    ergatai_runtime::output_accumulator::TurnContext {
                        reply_to_message_id: Some(direct_message_id.clone()),
                        correlation_id: correlation_id.clone(),
                        source_conversation_id: None,
                    },
                )
                .await;
        }

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

                // Persist message AFTER successful delivery. The conversation helper
                // owns writes to the normalized `messages` table.
                {
                    let conversation_id = target_conversation_id;
                    let message = req.message.clone();
                    let from = req.from.clone();
                    let sender_name = sender_display.clone();
                    let message_type = req.message_type.clone();
                    let direct_external_message_id_for_meta = req
                        .client_request_id
                        .clone()
                        .unwrap_or_else(|| direct_message_id.clone());
                    let correlation_id_for_meta = correlation_id.clone();
                    let conversation_id_for_persist = conversation_id;
                    let target_agent_id = conversation_receiver.clone();
                    // Wrap synchronous DB call in spawn_blocking
                    let append_result = tokio::task::spawn_blocking(move || {
                        let role = agent_message_role(&message_type, &from, &target_agent_id);
                        let metadata = serde_json::json!({
                            "externalMessageId": direct_external_message_id_for_meta,
                            "senderAgentId": from,
                            "senderAgentName": sender_name,
                            "messageType": message_type,
                            "correlationId": correlation_id_for_meta,
                            "replyToTurnId": request_origin.as_ref().and_then(|origin| origin.turn_id.clone()),
                            "replyToConversationId": request_origin.as_ref().and_then(|origin| origin.conversation_id.clone()),
                        });

                        // Use AgentMessageFields for structured storage
                        let agent_fields = user_data_db::messages::AgentMessageFields {
                            from_agent_id: parse_to_i64(&from),
                            from_agent_name: Some(sender_name),
                            message_type: Some(message_type),
                            content: Some(message.clone()),
                            ..Default::default()
                        };

                        user_data_db::messages::append_idempotent(
                            conversation_id_for_persist,
                            role,
                            serde_json::json!([{ "type": "text", "text": message }]),
                            metadata,
                            Some(agent_fields),
                            Some(&direct_external_message_id_for_meta),
                        )
                    })
                    .await;

                    // Publish to conversation subject for SSE streaming
                    // Use the Message returned by append() to avoid race condition
                    match append_result {
                        Ok(Ok(outcome)) => {
                            if outcome.inserted {
                                publish_to_conversation_subject_with_message(
                                    outcome.message,
                                    Some(req.from.clone()),
                                    Some(sender_display.clone()),
                                )
                                .await;
                            }
                        }
                        Ok(Err(e)) => {
                            warn!("Failed to persist A-to-A message to messages table: {}", e);
                        }
                        Err(e) => {
                            warn!(
                                "Failed to persist delivered message (task join error): {}",
                                e
                            );
                        }
                    }
                }

                SendMessageResult::DirectDelivered {
                    target_agent: resolved_target_id,
                    message_id: direct_message_id.clone(),
                    correlation_id,
                }
            }
            Err(e) => {
                // Clean up the pending turn context on error to prevent it from
                // leaking into the next turn on this conversation.
                if let Some(registry) =
                    ergatai_runtime::output_accumulator::get_global_accumulator_registry()
                {
                    registry.clear_pending_turn_context(&conversation_key).await;
                }
                SendMessageResult::Rejected {
                    reason: format!(
                        "Failed to deliver message to {}: NATS publish failed and direct injection error: {}",
                        resolved_target_id, e
                    ),
                }
            }
        }
    }

    /// Keep the chat participant binding's volatile `agent_id` in sync after a
    /// conversation-first send resumed or respawned the participant.
    async fn sync_conversation_agent(&self, conversation_id: ConversationId, agent_id: &str) {
        let Some(agent_id_i64) = ergatai_core::id::parse_to_i64(agent_id) else {
            return;
        };
        let binding = tokio::task::spawn_blocking(move || {
            user_data_db::group_agent_bindings::find_by_conversation_id(conversation_id)
        })
        .await
        .ok()
        .and_then(|result| result.ok())
        .flatten();
        let Some(binding) = binding else {
            return;
        };
        let participant_name =
            binding_profile_name(&binding).unwrap_or_else(|| binding.agent_name.clone());
        let participant_command = binding.agent_command.clone();

        let result = tokio::task::spawn_blocking(move || {
            user_data_db::group_agent_bindings::bind_participant(
                binding.workspace_id,
                binding.chat_id,
                &participant_name,
                participant_command.as_deref(),
                conversation_id,
                agent_id_i64,
                user_data_db::group_agent_bindings::ParticipantBindingPolicy::KeepConversation,
            )
        })
        .await;

        if let Ok(Err(error)) = result {
            warn!(
                error = %error,
                conversation_id = %conversation_id,
                "Failed to sync conversation agent binding"
            );
        }
    }

    /// Ensure an agent-to-agent target has its own conversation below the chat.
    ///
    /// The sender's binding is only used to discover the owning chat. We never
    /// persist target messages into the supervisor conversation.
    async fn update_agent_conversation_id(&self, agent_id: &str, conversation_id: ConversationId) {
        let runtime = crate::context::get_app_context().agent_runtime.clone();
        let conversation_id_formatted = conversation_id.encode();
        let conversation_id_i64 = conversation_id.as_i64().to_string();

        // Use atomic update to avoid read-modify-write race conditions.
        let updated = runtime
            .registry()
            .update(agent_id, |info| {
                info.handle.metadata.insert(
                    "conversation_id".to_string(),
                    conversation_id_formatted.clone(),
                );
                info.handle.metadata.insert(
                    "conversation_id_i64".to_string(),
                    conversation_id_i64.clone(),
                );
                info.conversation_id = Some(conversation_id_formatted.clone());
            })
            .await;

        if updated.is_some() {
            info!(
                agent_id = %agent_id,
                conversation_id = %conversation_id_formatted,
                "Updated AgentInfo with conversation_id for message routing"
            );
        } else {
            warn!(
                agent_id = %agent_id,
                "AgentInfo not found in registry, cannot update conversation_id"
            );
        }
    }

    async fn ensure_target_conversation(
        &self,
        sender_id: &str,
        target_id: &str,
        target_label: &str,
    ) -> Option<ConversationId> {
        let sender_id = sender_id.to_string();
        let sender_id_i64 = match ergatai_core::id::parse_to_i64(&sender_id) {
            Some(id) => id,
            None => {
                warn!("Failed to parse sender ID '{}'", sender_id);
                return None;
            }
        };

        // Prefer the live AgentInfo conversation. This handles the normal
        // prompt path even if the database binding was not yet repaired.
        let sender_runtime = crate::context::get_app_context().agent_runtime.clone();
        let metadata_conversation_id = sender_runtime
            .get_agent(&sender_id)
            .await
            .and_then(|agent_info| agent_info.handle.metadata.get("conversation_id").cloned())
            .and_then(|id| ConversationId::decode(&id).ok());

        let seed_conversation_id = if let Some(conversation_id) = metadata_conversation_id {
            conversation_id
        } else {
            // Try to find sender's existing conversation_id
            let sender_conversation_id = tokio::task::spawn_blocking(move || {
                user_data_db::group_agent_bindings::find_conversation_id(sender_id_i64)
            })
            .await;

            match sender_conversation_id {
                Ok(Ok(Some(conversation_id))) => conversation_id,
                Ok(Ok(None)) => {
                    // Sender has no GroupAgentBinding — create a default chat and binding
                    info!(
                        sender = %sender_id,
                        "Sender has no GroupAgentBinding, creating default chat and binding"
                    );
                    match self
                        .create_default_chat_for_sender(&sender_id, sender_id_i64)
                        .await
                    {
                        Some(conv_id) => conv_id,
                        None => {
                            warn!("Failed to create default chat for sender '{}'", sender_id);
                            return None;
                        }
                    }
                }
                Ok(Err(error)) => {
                    warn!(error = %error, "Failed to resolve sender conversation for agent target");
                    return None;
                }
                Err(error) => {
                    warn!(error = %error, "Failed to resolve sender conversation task");
                    return None;
                }
            }
        };

        let target_id = target_id.to_string();
        let target_id_i64 = match ergatai_core::id::parse_to_i64(&target_id) {
            Some(id) => id,
            None => {
                warn!(target = %target_id, "Failed to parse target agent ID");
                return None;
            }
        };
        let target_label = target_label.to_string();

        let target_runtime_info = crate::context::get_app_context()
            .agent_runtime
            .get_agent(&target_id)
            .await;
        let target_profile = target_runtime_info
            .as_ref()
            .and_then(|info| info.profile.clone());

        // Discover the chat that owns the sender and the participant binding
        // for this target (by runtime id, name, or command).
        let seed_conversation_for_lookup = seed_conversation_id;
        let target_label_for_lookup = target_label.clone();
        let target_id_for_lookup = target_id.clone();
        let context = tokio::task::spawn_blocking(move || -> Result<_, String> {
            let seed_conversation = user_data_db::conversations::get(seed_conversation_for_lookup)
                .map_err(|error| error.to_string())?
                .ok_or_else(|| "Sender conversation not found".to_string())?;
            let chat_id = seed_conversation.chat_id;
            let root_conversation = user_data_db::conversations::get(
                seed_conversation
                    .parent_id
                    .unwrap_or(seed_conversation_for_lookup),
            )
            .map_err(|error| error.to_string())?
            .ok_or_else(|| "Chat conversation not found".to_string())?;
            let bindings = user_data_db::group_agent_bindings::list(chat_id)
                .map_err(|error| error.to_string())?;
            let target_id_i64 = ergatai_core::id::parse_to_i64(&target_id_for_lookup);
            let existing = bindings
                .iter()
                .find(|binding| Some(binding.agent_id) == target_id_i64)
                .or_else(|| {
                    bindings.iter().find(|binding| {
                        binding_matches_agent_name(binding, &target_label_for_lookup)
                    })
                })
                .cloned();
            let existing_conversation_name = existing.as_ref().and_then(|binding| {
                user_data_db::conversations::get(binding.conversation_id)
                    .ok()
                    .flatten()
                    .and_then(|conversation| conversation.name)
            });
            let workspace_id = user_data_db::chats::get(chat_id)
                .map_err(|error| error.to_string())?
                .ok_or_else(|| "Chat not found".to_string())?
                .workspace_id;
            Ok((
                chat_id,
                workspace_id,
                root_conversation,
                existing,
                existing_conversation_name,
            ))
        })
        .await;

        let (
            chat_id,
            workspace_id,
            root_conversation,
            existing_binding,
            existing_conversation_name,
        ) = match context {
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

        // The participant's public name is the profile name. Never persist a
        // runtime id as `agent_name`; fall back to an existing non-id name or
        // the target label when it is a real profile name.
        let participant_name = target_profile
            .clone()
            .or_else(|| {
                existing_binding
                    .as_ref()
                    .map(|binding| binding.agent_name.clone())
                    .filter(|name| !looks_like_typed_id(name))
            })
            .or_else(|| (!looks_like_typed_id(&target_label)).then(|| target_label.clone()))
            .or_else(|| {
                existing_conversation_name
                    .clone()
                    .filter(|name| !looks_like_typed_id(name))
            })
            .or_else(|| {
                existing_binding
                    .as_ref()
                    .map(|binding| binding.agent_name.clone())
            })
            .unwrap_or_else(|| target_id.clone());

        let participant_command = target_profile
            .clone()
            .or_else(|| {
                existing_binding
                    .as_ref()
                    .and_then(|binding| binding.agent_command.clone())
            })
            .or_else(|| (!looks_like_typed_id(&target_label)).then(|| target_label.clone()));

        // Keep the participant's existing conversation. Only when this is a
        // first-time participant do we create a conversation row.
        let conversation_id = match existing_binding.as_ref() {
            Some(binding) => binding.conversation_id,
            None => {
                let conversation_id = target_runtime_info
                    .as_ref()
                    .and_then(|info| info.conversation_id.clone())
                    .and_then(|id| ConversationId::decode(&id).ok())
                    .unwrap_or_else(ConversationId::generate);
                let timestamp = chrono::Utc::now().timestamp();
                let root_conversation_for_db = root_conversation.clone();
                let conversation_name = participant_name.clone();
                let conversation_id_for_create = conversation_id;
                let session_id_i64 = generate();

                let create_result = tokio::task::spawn_blocking(move || -> Result<(), String> {
                    if user_data_db::conversations::get(conversation_id_for_create)
                        .map_err(|error| error.to_string())?
                        .is_none()
                    {
                        user_data_db::conversations::create(user_data_db::Conversation {
                            conversation_id: conversation_id_for_create,
                            collaboration_session_id: root_conversation_for_db
                                .collaboration_session_id,
                            chat_id: root_conversation_for_db.chat_id,
                            parent_id: Some(
                                root_conversation_for_db
                                    .parent_id
                                    .unwrap_or(root_conversation_for_db.conversation_id),
                            ),
                            name: Some(conversation_name),
                            mode: "agent".to_string(),
                            participant_role: "peer".to_string(),
                            status: "ready".to_string(),
                            created_at: timestamp,
                            updated_at: timestamp,
                            context_used: 0,
                            context_window: 0,
                            context_updated_at: 0,
                        })
                        .map_err(|error| error.to_string())?;
                        user_data_db::agent_sessions::upsert(user_data_db::AgentSession {
                            agent_session_id: session_id_i64,
                            conversation_id: conversation_id_for_create.as_i64(),
                            acp_session_id: None,
                            agent_id: None,
                            mode: "agent".to_string(),
                            created_at: timestamp,
                            updated_at: timestamp,
                            imported_count: 0,
                            import_cursor: None,
                            has_more: false,
                            total_captured: 0,
                            last_error: None,
                            resume_supported: true,
                        })
                        .map_err(|error| error.to_string())?;
                    }
                    Ok(())
                })
                .await;

                match create_result {
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
                conversation_id
            }
        };

        // Single binding write path: keep the participant's conversation,
        // replace only the volatile runtime pointer.
        let participant_name_for_db = participant_name.clone();
        let participant_command_for_db = participant_command.clone();
        let binding = tokio::task::spawn_blocking(move || {
            user_data_db::group_agent_bindings::bind_participant(
                workspace_id,
                chat_id,
                &participant_name_for_db,
                participant_command_for_db.as_deref(),
                conversation_id,
                target_id_i64,
                user_data_db::group_agent_bindings::ParticipantBindingPolicy::KeepConversation,
            )
        })
        .await;

        let binding = match binding {
            Ok(Ok(binding)) => binding,
            Ok(Err(error)) => {
                warn!(error = %error, "Failed to bind target agent participant");
                return None;
            }
            Err(error) => {
                warn!(error = %error, "Failed to bind target agent participant task");
                return None;
            }
        };
        let conversation_id = binding.conversation_id;

        self.update_agent_conversation_id(&target_id, conversation_id)
            .await;

        // Keep the collaboration-session participant row in sync (idempotent).
        if let Ok(Ok(Some(session))) = tokio::task::spawn_blocking(move || {
            crate::services::collaboration_session::find_session_by_chat(&chat_id.to_string())
        })
        .await
        {
            let participant_conversation_id = conversation_id;
            let participant_agent_id = target_id.clone();
            if let Err(error) = tokio::task::spawn_blocking(move || {
                crate::services::collaboration_session::upsert_participant(
                    &session.collaboration_session_id,
                    crate::services::collaboration_session::ParticipantInput {
                        conversation_id: participant_conversation_id.to_string(),
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

    /// Create a default chat and binding for a sender that has no GroupAgentBinding.
    ///
    /// This is used when MCP agents (like opencode) send messages but don't have
    /// a GroupAgentBinding yet. We create a default chat and conversation so that
    /// message routing can work.
    ///
    /// Returns the conversation_id of the newly created conversation.
    async fn create_default_chat_for_sender(
        &self,
        sender_id: &str,
        sender_id_i64: i64,
    ) -> Option<ConversationId> {
        let runtime = crate::context::get_app_context().agent_runtime.clone();

        // Get sender's workspace_id from runtime registry
        let Some(agent_info) = runtime.get_agent(sender_id).await else {
            warn!(
                sender = %sender_id,
                "Sender not found in runtime registry; cannot create default chat"
            );
            return None;
        };
        let Some(workspace_id_i64) = ergatai_core::id::parse_to_i64(&agent_info.workspace_id)
        else {
            warn!(
                sender = %sender_id,
                workspace_id = %agent_info.workspace_id,
                "Failed to parse sender workspace_id; cannot create default chat"
            );
            return None;
        };
        let workspace_id = ergatai_error::WorkspaceId::new(workspace_id_i64);

        // Prefer the profile name so the default participant binding remains
        // addressable by name. Runtime ids are volatile process pointers.
        let sender_id_for_label = agent_info
            .profile
            .clone()
            .filter(|profile| !profile.trim().is_empty())
            .unwrap_or_else(|| sender_id.to_string());
        let timestamp = chrono::Utc::now().timestamp();

        // Generate IDs (all ID types implement Copy, so they can be used
        // directly in the spawn_blocking closure without _for_xxx aliases).
        let chat_id = ergatai_error::ChatId::generate();
        let collaboration_session_id = ergatai_error::CollaborationSessionId::generate();
        let root_conversation_id = ConversationId::generate();
        let sender_conversation_id = ConversationId::generate();
        let session_id_i64 = generate();

        let result = tokio::task::spawn_blocking(move || {
            // Create all 6 records in a single transaction for atomicity.
            // This prevents orphaned records if any step fails.
            crate::user_data_db::create_default_chat_with_binding(
                crate::user_data_db::Chat {
                    chat_id,
                    workspace_id,
                    name: Some(format!("Default chat for {}", sender_id_for_label)),
                    collaboration_mode: Some("supervisor".to_string()),
                    worktree_path: None,
                    branch: None,
                    base_branch: None,
                    pr_url: None,
                    pr_number: None,
                    created_at: timestamp,
                    updated_at: timestamp,
                    archived_at: None,
                },
                crate::user_data_db::CollaborationSession {
                    collaboration_session_id,
                    chat_id,
                    workspace_id,
                    mode: "supervisor".to_string(),
                    state: "idle".to_string(),
                    goal: None,
                    active_plan_revision: None,
                    created_at: timestamp,
                    updated_at: timestamp,
                },
                crate::user_data_db::Conversation {
                    conversation_id: root_conversation_id,
                    collaboration_session_id,
                    chat_id,
                    parent_id: None,
                    name: Some(format!("Chat root for {}", sender_id_for_label.clone())),
                    mode: "chat".to_string(),
                    participant_role: "system".to_string(),
                    status: "ready".to_string(),
                    created_at: timestamp,
                    updated_at: timestamp,
                    context_used: 0,
                    context_window: 0,
                    context_updated_at: 0,
                },
                crate::user_data_db::Conversation {
                    conversation_id: sender_conversation_id,
                    collaboration_session_id,
                    chat_id,
                    parent_id: Some(root_conversation_id),
                    name: Some(sender_id_for_label.clone()),
                    mode: "agent".to_string(),
                    participant_role: "assistant".to_string(),
                    status: "ready".to_string(),
                    created_at: timestamp,
                    updated_at: timestamp,
                    context_used: 0,
                    context_window: 0,
                    context_updated_at: 0,
                },
                crate::user_data_db::GroupAgentBinding {
                    workspace_id,
                    chat_id,
                    agent_id: sender_id_i64,
                    agent_name: sender_id_for_label.clone(),
                    agent_command: Some(sender_id_for_label),
                    conversation_id: sender_conversation_id,
                    created_at: timestamp,
                    updated_at: timestamp,
                },
                crate::user_data_db::AgentSession {
                    agent_session_id: session_id_i64,
                    conversation_id: sender_conversation_id.as_i64(),
                    acp_session_id: None,
                    agent_id: None,
                    mode: "agent".to_string(),
                    created_at: timestamp,
                    updated_at: timestamp,
                    imported_count: 0,
                    import_cursor: None,
                    has_more: false,
                    total_captured: 0,
                    last_error: None,
                    resume_supported: true,
                },
            )
            .map(|_| ()) // Discard the returned ConversationId, we already have it
            .map_err(|e| e.to_string())
        })
        .await;

        match result {
            Ok(Ok(())) => {
                self.update_agent_conversation_id(sender_id, sender_conversation_id)
                    .await;
                info!(
                    sender = %sender_id,
                    chat_id = %chat_id,
                    conversation_id = %sender_conversation_id,
                    "Created default chat and binding for sender"
                );
                Some(sender_conversation_id)
            }
            Ok(Err(error)) => {
                warn!(
                    error = %error,
                    sender = %sender_id,
                    "Failed to create default chat for sender"
                );
                None
            }
            Err(error) => {
                warn!(
                    error = %error,
                    sender = %sender_id,
                    "Failed to create default chat task"
                );
                None
            }
        }
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
                .position(|context| context.correlation_id == correlation_id)
                .or_else(|| {
                    if contexts.is_empty() {
                        None
                    } else {
                        // Some ACP clients mint their own response correlation
                        // id. Server-side pending-response state is
                        // authoritative; otherwise the original request times
                        // out even though a valid response was delivered.
                        tracing::warn!(
                            responder_agent = %responder_agent,
                            client_correlation_id = %correlation_id,
                            pending_correlation_id = %contexts[0].correlation_id,
                            "Ignoring client response correlation_id; using pending request"
                        );
                        Some(0)
                    }
                }),
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
                    || a.task_id.as_deref() == Some(target)
                    || a.handle
                        .metadata
                        .get("ergatai_agent_id")
                        .map(|id| id == target)
                        .unwrap_or(false);
                if matches {
                    tracing::debug!(
                        target = target,
                        matched_agent_id = %a.agent_id,
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

    /// Get the sender's current ConversationId from runtime metadata, falling
    /// back to its durable chat binding.
    async fn sender_conversation_id(&self, sender_runtime_id: &str) -> Option<ConversationId> {
        let runtime = crate::context::get_app_context().agent_runtime.clone();
        if let Some(info) = runtime.get_agent(sender_runtime_id).await {
            if let Some(conversation_id) = info
                .conversation_id
                .as_deref()
                .and_then(|id| ConversationId::decode(id).ok())
            {
                return Some(conversation_id);
            }
            if let Some(conversation_id) = info
                .handle
                .metadata
                .get("conversation_id")
                .and_then(|id| ConversationId::decode(id).ok())
            {
                return Some(conversation_id);
            }
        }

        let sender_id_i64 = ergatai_core::id::parse_to_i64(sender_runtime_id)?;
        tokio::task::spawn_blocking(move || {
            user_data_db::group_agent_bindings::find_conversation_id(sender_id_i64)
                .ok()
                .flatten()
        })
        .await
        .ok()
        .flatten()
    }

    /// Get the chat that owns the sender's current conversation.
    async fn sender_chat_id(&self, sender_runtime_id: &str) -> Option<ChatId> {
        let conversation_id = self.sender_conversation_id(sender_runtime_id).await?;
        tokio::task::spawn_blocking(move || {
            user_data_db::conversations::get(conversation_id)
                .ok()
                .flatten()
                .map(|conversation| conversation.chat_id)
        })
        .await
        .ok()
        .flatten()
    }

    /// Find the binding for an agent name (e.g. `"opencode"`) in the given chat.
    ///
    /// A profile name is only unique inside a chat; looking it up globally can
    /// select another chat's participant. All name-based routing must therefore
    /// start from the sender's chat.
    async fn find_chat_scoped_binding(
        &self,
        chat_id: ChatId,
        target_name: &str,
    ) -> Option<user_data_db::GroupAgentBinding> {
        let target_name = target_name.to_string();

        tokio::task::spawn_blocking(move || {
            user_data_db::group_agent_bindings::find_by_agent_name(chat_id, &target_name)
                .ok()
                .flatten()
        })
        .await
        .ok()
        .flatten()
    }

    /// Resolve a target addressed by agent name (typically a profile name such
    /// as `"opencode"`) to the agent bound to that name inside the sender's chat.
    ///
    /// The conversation is the anchor: the chat-scoped binding gives us the
    /// participant conversation, and `resolve_agent_for_conversation` reuses a
    /// live agent or resumes the suspended one for that exact conversation.
    /// This is what prevents a second `opencode` pane/process from appearing
    /// when the peer is already running.
    async fn resolve_target_in_sender_chat(
        &self,
        sender_runtime_id: &str,
        target_name: &str,
    ) -> Option<String> {
        let chat_id = self.sender_chat_id(sender_runtime_id).await?;
        let binding = self.find_chat_scoped_binding(chat_id, target_name).await?;

        let conversation_id = binding.conversation_id.encode();
        let agent_id =
            crate::services::agent_service::resolve_agent_for_conversation(&conversation_id)
                .await?;

        info!(
            target = %target_name,
            chat_id = %binding.chat_id,
            conversation_id = %conversation_id,
            agent_id = %agent_id,
            "Resolved target by chat-scoped agent-name binding"
        );

        Some(agent_id)
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
        tracing::info!(target = target, sender = %sender_runtime_id, "Attempting to auto-spawn agent from profile");

        // Check if target is a profile name
        let profile = match crate::services::profile_service::get_profile_by_name(target).await {
            Ok(Some(p)) => {
                tracing::info!(target = target, profile_name = %p.name, "Found profile for auto-spawn");
                p
            }
            Ok(None) => {
                tracing::debug!(target = target, "Target is not a profile name");
                return None; // Not a profile, let it fail normally
            }
            Err(e) => {
                tracing::warn!(error = %e, target = target, "Failed to look up profile for auto-spawn");
                return None;
            }
        };

        // Get sender's workspace to spawn in the same workspace
        let sender_info = match runtime.get_agent(sender_runtime_id).await {
            Some(info) => info,
            None => {
                tracing::warn!(sender = %sender_runtime_id, "Sender not found in runtime registry");
                return None;
            }
        };
        let workspace_id = sender_info.workspace_id.clone();
        let work_dir = sender_info
            .handle
            .workspace
            .metadata
            .get("work_dir")
            .cloned()
            .unwrap_or_else(default_work_dir);

        // Start with the same provider settings/model as a user-created chat.
        let (provider_env, default_model) =
            crate::services::provider_connection_service::resolve_spawn_settings(&profile.name)
                .await;

        // Launch the agent
        tracing::info!(
            target = target,
            profile_name = %profile.name,
            workspace = %workspace_id,
            command = %profile.command,
            work_dir = %work_dir,
            "Auto-spawning agent from profile (message-driven)"
        );

        // Reuse the chat's participant conversation for this agent name. The ACP
        // backend captures `conversation_id` at spawn time, so the process must
        // start with the same conversation we route messages to.
        let sender_chat_id = self.sender_chat_id(sender_runtime_id).await;
        let binding = match sender_chat_id {
            Some(chat_id) => self.find_chat_scoped_binding(chat_id, target).await,
            None => None,
        };
        let spawn_chat_id = sender_chat_id.map(|chat_id| chat_id.encode());
        let spawn_conversation_id = binding.as_ref().map(|b| b.conversation_id.encode());
        if let Some(conversation_id) = spawn_conversation_id.as_deref() {
            tracing::info!(
                target = target,
                conversation_id = conversation_id,
                "Reusing chat-scoped conversation for auto-spawn"
            );
        }

        // When the target already has a conversation, use the canonical launch
        // service so the conversation's durable model wins over the provider
        // default. This is the message-driven counterpart of the chat path.
        if let Some(conversation_id) = spawn_conversation_id.as_deref() {
            if let Ok(typed_conversation_id) = ConversationId::decode(conversation_id) {
                let request = EnsureAgentRequest {
                    conversation_id: Some(typed_conversation_id),
                    profile: Some(profile.name.clone()),
                    workspace_id: None,
                    work_dir: None,
                    provider_connection_id: None,
                    model: ModelInput::None,
                    mode: LaunchMode::Ensure,
                    env: Default::default(),
                    allow_native_default: false,
                };
                let service = crate::context::get_app_context().agent_launch.clone();
                match service.ensure(request).await {
                    Ok(result) => {
                        tracing::info!(
                            agent_id = %result.agent_id,
                            profile = %profile.name,
                            action = ?result.action,
                            "Agent ensured through conversation launch settings"
                        );
                        crate::api::agents::spawn_model_detection(
                            result.agent_id.clone(),
                            profile.name.clone(),
                        );
                        if self
                            .ensure_target_conversation(sender_runtime_id, &result.agent_id, target)
                            .await
                            .is_none()
                        {
                            tracing::error!(
                                agent_id = %result.agent_id,
                                target = %target,
                                "Failed to bind ensured agent to a Conversation"
                            );
                            return None;
                        }
                        return Some(result.agent_id);
                    }
                    Err(error) => {
                        tracing::warn!(
                            target = target,
                            conversation_id = %conversation_id,
                            error = %error,
                            "Conversation-aware ensure failed; falling back to provider default"
                        );
                    }
                }
            }
        }

        let plan = LaunchPlan {
            workspace_id: workspace_id.clone(),
            work_dir: std::path::PathBuf::from(&work_dir),
            env: provider_env,
            resources: Default::default(),
            capture_thoughts: false,
            command: profile.command.clone(),
            chat_id: spawn_chat_id,
            conversation_id: spawn_conversation_id,
            profile_name: Some(profile.name.clone()),
            transport: profile.transport.clone(),
            reuse_agent_id: None,
        };

        match AgentLauncher::new(runtime).launch(plan).await {
            Ok(agent_id) => {
                tracing::info!(
                    agent_id = %agent_id,
                    profile = %profile.name,
                    "Agent auto-spawned successfully"
                );

                // Apply the model before the queued message is delivered and
                // before model detection snapshots the session's current model.
                apply_spawn_default_model(&agent_id, &profile.name, default_model.as_deref()).await;

                // Spawn background model detection (two-phase polling with exponential backoff)
                crate::api::agents::spawn_model_detection(agent_id.clone(), profile.name.clone());

                // Bind the newly spawned target immediately. A message must not
                // enter the queue without a resolvable Conversation ID.
                if self
                    .ensure_target_conversation(sender_runtime_id, &agent_id, target)
                    .await
                    .is_none()
                {
                    tracing::error!(
                        agent_id = %agent_id,
                        target = %target,
                        "Failed to bind auto-spawned agent to a Conversation"
                    );
                    return None;
                }

                Some(agent_id)
            }
            Err(e) => {
                tracing::error!(
                    error = %e,
                    target = target,
                    profile = %profile.name,
                    command = %profile.command,
                    "Failed to auto-spawn agent from profile"
                );
                None
            }
        }
    }

    /// Try to auto-resume a suspended agent when the target is not found in running agents.
    ///
    /// This enables "message-driven agent resumption": when a message is sent to a suspended
    /// agent (identified by agent ID or conversation_id), the system automatically resumes
    /// that agent and delivers the message.
    ///
    /// Returns Some(new_agent_id) if successfully resumed, None otherwise.
    async fn try_auto_resume_suspended_agent(
        &self,
        runtime: &AgentRuntime,
        target: &str,
        conversation_id: Option<&str>,
    ) -> Option<String> {
        // Delegate to shared service function
        crate::services::agent_service::try_auto_resume_suspended_agent(
            runtime,
            target,
            conversation_id,
        )
        .await
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

        // Do not resume an arbitrary suspended agent by profile name here. A
        // suspended record is a historical conversation; resuming it for an
        // unrelated sender would move the message into that old conversation
        // and start a duplicate process.
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
        let workspace_id = format_id(generate(), IdType::Workspace);
        let work_dir = default_work_dir();

        // Start with the same provider settings/model as a user-created chat.
        let (provider_env, default_model) =
            crate::services::provider_connection_service::resolve_spawn_settings(&profile.name)
                .await;

        // Launch the agent
        info!(
            agent = %agent_name,
            profile_name = %profile.name,
            workspace = %workspace_id,
            "Auto-spawning sender agent from profile"
        );

        let plan = LaunchPlan {
            workspace_id: workspace_id.clone(),
            work_dir: std::path::PathBuf::from(&work_dir),
            env: provider_env,
            resources: Default::default(),
            capture_thoughts: false,
            command: profile.command.clone(),
            chat_id: None,
            conversation_id: None,
            profile_name: Some(profile.name.clone()),
            transport: profile.transport.clone(),
            reuse_agent_id: None,
        };

        match AgentLauncher::new(runtime).launch(plan).await {
            Ok(agent_id) => {
                info!(
                    agent_id = %agent_id,
                    profile = %profile.name,
                    "Sender agent auto-spawned successfully"
                );

                // Apply the model before the sender handles the message.
                apply_spawn_default_model(&agent_id, &profile.name, default_model.as_deref()).await;

                // Spawn background model detection (two-phase polling with exponential backoff)
                crate::api::agents::spawn_model_detection(agent_id.clone(), profile.name.clone());
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

    /// Look up the sender's conversation_id from the runtime registry.
    /// Falls back to the sender's agent_id if conversation_id is not set.
    async fn get_sender_conversation_id(&self, from: &str) -> String {
        let runtime = crate::context::get_app_context().agent_runtime.clone();
        if let Some(info) = runtime.get_agent(from).await {
            if let Some(conversation_id) = info.conversation_id.clone() {
                return conversation_id;
            }
            if let Some(conversation_id) = info.handle.metadata.get("conversation_id").cloned() {
                return conversation_id;
            }
        }

        // Fall back to the durable participant binding so `_reply` stays
        // conversation-addressed even before AgentInfo metadata is refreshed.
        if let Some(agent_id_i64) = ergatai_core::id::parse_to_i64(from) {
            if let Ok(Ok(Some(conversation_id))) = tokio::task::spawn_blocking(move || {
                user_data_db::group_agent_bindings::find_conversation_id(agent_id_i64)
            })
            .await
            {
                return conversation_id.encode();
            }
        }

        from.to_string()
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
        sender_conversation_id: &str,
        message: &str,
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
                    "MUST call send_message(target_conversation_id='{}')",
                    sender_conversation_id,
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
                    "MUST call send_message(target_conversation_id='{}')",
                    sender_conversation_id,
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

/// Decide the DB `role` for an A-to-A message based on its `message_type`.
///
/// This is a rendering-strategy decision that preserves semantic clarity:
/// - `agent`: agent-initiated messages (requests) that should open a new
///   conversation group in the UI, clearly distinguished from user input
/// - `assistant`: agent responses and FYI messages (response/broadcast) that
///   append to the current conversation group
///
/// The three-tier role system provides clear semantics:
/// - `user`: human user input
/// - `agent`: agent-initiated messages (requests to other agents)
/// - `assistant`: agent responses and outputs
/// - `system`: system events
///
/// Origin metadata (`metadata.source`, `senderAgentId`) is preserved separately
/// for detailed tracking and display purposes.
/// Determine the message role based on message type and sender relationship.
///
/// Rules:
/// - If sender is the conversation owner → "assistant" (host agent's own message)
/// - If sender is external:
///   - "request" → "agent" (external agent's request, opens new conversation group)
///   - "response" → "respagent" (external agent's response, filtered from main chat)
///   - "broadcast" → "broadcast" (broadcast message)
///   - unknown → "agent"
pub(crate) fn agent_message_role(
    message_type: &str,
    sender_agent_id: &str,
    conversation_owner_agent_id: &str,
) -> &'static str {
    if sender_agent_id == conversation_owner_agent_id {
        "assistant"
    } else {
        match message_type {
            "request" => "agent",
            "response" => "respagent",
            "broadcast" => "broadcast",
            _ => "agent",
        }
    }
}

// ── Global accessor ──────────────────────────────────────────────────

static MESSAGE_SENDER: OnceLock<MessageSender> = OnceLock::new();

/// Initialize the global MessageSender (called once at startup).
pub fn init_message_sender() -> &'static MessageSender {
    MESSAGE_SENDER.get_or_init(|| {
        let config = ConversationConfig::default();
        let conversation_manager = Arc::new(ConversationManager::new(config));
        let request_monitor = Arc::new(RequestMonitor::new());
        MessageSender::new(
            conversation_manager,
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

pub async fn record_pending_response(to_agent: &str, correlation_id: &str) {
    if let Some(sender) = get_message_sender() {
        sender
            .store_pending_response(
                to_agent,
                PendingResponseContext {
                    correlation_id: correlation_id.to_string(),
                },
            )
            .await;
    }
}

/// Helper: Publish a message to the conversation subject for SSE streaming
///
/// This is called after persisting a message to SQLite. It uses the persisted Message
/// object directly to avoid race conditions, then publishes to the conversation subject.
/// Failures are logged but don't affect the overall send operation.
///
/// # Arguments
/// * `persisted_msg` - The Message object returned by `user_data_db::messages::append()`
/// * `sender_agent_id` - The sender's agent ID (if agent-sourced)
/// * `sender_agent_name` - The sender's display name (if agent-sourced)
pub async fn publish_to_conversation_subject_with_message(
    persisted_msg: crate::user_data_db::Message,
    sender_agent_id: Option<String>,
    sender_agent_name: Option<String>,
) {
    let Some(conn) =
        crate::context::try_get_app_context().and_then(|ctx| ctx.nats_connection.clone())
    else {
        return;
    };

    let conversation_id_for_log = persisted_msg.conversation_id;
    let msg_id_for_log = persisted_msg.message_id;

    // Note: With per-conversation tables, side_copy projections are no longer created.
    // Messages are stored only in their target conversation, eliminating duplicates.

    // Structured agent messages keep the user-facing content in `content`,
    // while `parts` preserves the original wire envelope (for example a JSON
    // inter-agent request). Prefer `content` so the UI does not render the
    // envelope; fall back to parts for regular assistant/user messages.
    let content = persisted_msg
        .content
        .as_ref()
        .filter(|content| !content.trim().is_empty())
        .cloned()
        .unwrap_or_else(|| {
            persisted_msg
                .parts
                .as_ref()
                .map(|p| extract_text_from_parts(p))
                .unwrap_or_default()
        });

    // Fire-and-forget: spawn task but don't await, so send_message is not blocked
    tokio::spawn(async move {
        let bus = ergatai_nats::EventBus::new(conn);
        let payload = ergatai_nats::ConversationMessagePayload {
            conversation_id: persisted_msg.conversation_id,
            message_id: persisted_msg.message_id,
            role: persisted_msg.role,
            content,
            parts: Some(match &persisted_msg.parts {
                Some(parts_str) => serde_json::from_str(parts_str).unwrap_or_else(|e| {
                    warn!(
                        message_id = %msg_id_for_log,
                        error = %e,
                        "Failed to parse message parts, using empty array"
                    );
                    serde_json::json!([])
                }),
                None => serde_json::json!([]),
            }),
            metadata: persisted_msg
                .metadata
                .as_ref()
                .and_then(|m| serde_json::from_str(m).ok()),
            timestamp: persisted_msg.created_at as u64,
            sequence: persisted_msg.sequence,
            sender_agent_id: sender_agent_id
                .as_deref()
                .and_then(|id| AgentId::decode(id).ok()),
            sender_agent_name,
        };

        if let Err(e) = bus.publish_conversation_message(&payload).await {
            warn!(
                conversation_id = %conversation_id_for_log,
                message_id = %payload.message_id,
                error = %e,
                "Failed to publish to conversation subject (non-fatal)"
            );
        }
    });
}

/// Extract text content from a JSON parts array
///
/// Parses the parts JSON and extracts all text content, joining with newlines.
/// Returns empty string if parsing fails or no text parts exist.
pub(crate) fn extract_text_from_parts(parts_str: &str) -> String {
    serde_json::from_str::<serde_json::Value>(parts_str)
        .ok()
        .and_then(|v| v.as_array().cloned())
        .map(|arr| {
            arr.iter()
                .filter_map(|p| {
                    let obj = p.as_object()?;
                    if obj.get("type")?.as_str()? == "text" {
                        obj.get("text")?.as_str().map(String::from)
                    } else {
                        None
                    }
                })
                .collect::<Vec<_>>()
                .join("\n")
        })
        .unwrap_or_default()
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

/// Remove a specific pending response by correlation_id.
/// Called when message delivery fails after recording the pending response.
pub async fn remove_pending_response(responder_agent: &str, correlation_id: &str) {
    if let Some(sender) = get_message_sender() {
        let mut pending = sender.pending_responses.lock().await;
        if let Some(contexts) = pending.get_mut(responder_agent) {
            contexts.retain(|ctx| ctx.correlation_id != correlation_id);
            if contexts.is_empty() {
                pending.remove(responder_agent);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_format_agent_message_request_type() {
        let result =
            MessageSender::format_agent_message("agent-1", "cov-1", "Hello", "request", None, None);
        let parsed: serde_json::Value = serde_json::from_str(&result).unwrap();
        assert_eq!(parsed["from"], "agent-1");
        assert_eq!(parsed["message"], "Hello");
        assert_eq!(parsed["message_type"], "request");
        assert!(parsed["_reply"].as_str().unwrap().contains("cov-1"));
        assert!(parsed["_rules"].as_array().unwrap().len() >= 2);
    }

    #[test]
    fn test_format_agent_message_response_type() {
        let result = MessageSender::format_agent_message(
            "agent-1",
            "cov-1",
            "Response",
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
            "cov-1",
            "Broadcast message",
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
            "cov-1",
            "Unknown",
            "unknown_type",
            None,
            None,
        );
        let parsed: serde_json::Value = serde_json::from_str(&result).unwrap();
        assert_eq!(parsed["message_type"], "unknown_type");
        // Unknown types are treated like request
        assert!(parsed["_reply"].as_str().unwrap().contains("cov-1"));
    }

    #[test]
    fn agent_message_role_maps_message_type_to_render_group() {
        let host_agent = "agent-host";
        let external_agent = "agent-external";

        // Host agent's own message → "assistant"
        assert_eq!(
            agent_message_role("request", host_agent, host_agent),
            "assistant"
        );
        assert_eq!(
            agent_message_role("response", host_agent, host_agent),
            "assistant"
        );
        assert_eq!(
            agent_message_role("broadcast", host_agent, host_agent),
            "assistant"
        );

        // External agent's request → "agent" (opens new conversation group)
        assert_eq!(
            agent_message_role("request", external_agent, host_agent),
            "agent"
        );

        // External agent's response → "respagent" (filtered from main chat)
        assert_eq!(
            agent_message_role("response", external_agent, host_agent),
            "respagent"
        );

        // External agent's broadcast → "broadcast"
        assert_eq!(
            agent_message_role("broadcast", external_agent, host_agent),
            "broadcast"
        );

        // Unknown future types default to "agent" (open new group)
        assert_eq!(
            agent_message_role("some-future-type", external_agent, host_agent),
            "agent"
        );
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
                },
            )
            .await;
        sender
            .store_pending_response(
                "agent-2",
                PendingResponseContext {
                    correlation_id: "corr-2".to_string(),
                },
            )
            .await;

        let _matched = sender
            .take_pending_response("agent-2", Some("corr-2"))
            .await
            .expect("matched context");

        let oldest = sender.take_pending_response("agent-2", None).await.unwrap();
        assert_eq!(oldest.correlation_id, "corr-1");

        assert!(sender
            .take_pending_response("agent-2", None)
            .await
            .is_none());
    }

    // NOTE: The role consistency contract (both NATS and fallback paths use role="assistant")
    // is documented in the code at lines ~490 and ~561. Integration tests should verify this
    // behavior end-to-end by sending agent-to-agent messages and checking the database.
    // A unit test cannot verify this without mocking the entire message delivery pipeline.
}
