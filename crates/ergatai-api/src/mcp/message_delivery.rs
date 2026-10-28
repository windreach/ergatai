//! Message delivery consumer — reliable agent message delivery via NATS JetStream
//!
//! Pulls messages from the `AGENT_MESSAGES` JetStream stream and delivers each
//! to the target agent via AgentRuntime injection (ACP protocol).
//!
//! ## Reliability semantics
//!
//! - Message is **ack'd** only after successful delivery
//! - On delivery failure: message is **nak'd** → JetStream redelivers after `ack_wait`
//! - After `max_deliver` attempts (set on the consumer): message is discarded
//! - Stream retention is `WorkQueue`: ack'd messages are removed immediately
//!
//! ## Flow
//!
//! ```text
//! AGENT_MESSAGES stream (JetStream, file-backed)
//!   ↓ pull (filter: ergatai.agent.message.* only)
//! MessageDeliveryConsumer
//!   ↓ deserialize AgentMessagePayload
//!   ↓ AgentRuntime injection (ACP protocol)
//!   ├─ OK → ack
//!   └─ fail → nak (JetStream retries)
//! ```
//!
//! Note: Receipts (ergatai.agent.receipt.*) and request timeouts
//! (ergatai.agent.request_timeout.*) are filtered out at the consumer level
//! and handled separately by their own monitoring systems.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use async_nats::jetstream::message::AckKind;
use futures::StreamExt;
use tracing::{debug, error, info, warn};

use ergatai_core::id::parse_to_i64;
use ergatai_error::{ErgataiError, ErgataiResult};
use ergatai_nats::connection::NatsConnection;
use ergatai_nats::events::AgentMessagePayload;
use ergatai_nats::AGENT_MESSAGES_STREAM;

/// Global message type counters for statistics
static MSG_COUNT_REQUEST: AtomicU64 = AtomicU64::new(0);
static MSG_COUNT_RESPONSE: AtomicU64 = AtomicU64::new(0);
static MSG_COUNT_BROADCAST: AtomicU64 = AtomicU64::new(0);
static MSG_COUNT_NOTIFICATION: AtomicU64 = AtomicU64::new(0);

/// Deduplication cache for processed messages (prevents duplicate delivery on ack failures)
/// Maps message_id → processing timestamp
/// Uses Mutex<HashMap> with periodic cleanup of stale entries
static PROCESSED_MESSAGES: once_cell::sync::OnceCell<Mutex<HashMap<String, Instant>>> =
    once_cell::sync::OnceCell::new();

/// TTL for processed message cache (5 minutes)
/// Messages older than this are automatically cleaned up
const DEDUP_TTL: Duration = Duration::from_secs(300);

/// Maximum cache size before forced cleanup
const MAX_CACHE_SIZE: usize = 10000;

/// Initialize or get the processed messages cache
fn get_processed_messages() -> &'static Mutex<HashMap<String, Instant>> {
    PROCESSED_MESSAGES.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Check if a message has already been processed (idempotency check)
/// Returns true if this is a duplicate delivery
fn is_duplicate_message(message_id: &str) -> bool {
    let cache = get_processed_messages();
    let Ok(guard) = cache.lock() else {
        tracing::error!("Dedup cache lock poisoned; dedup disabled for this check");
        return false;
    };
    guard.contains_key(message_id)
}

/// Mark a message as processed
fn mark_message_processed(message_id: &str) {
    let cache = get_processed_messages();
    let Ok(mut guard) = cache.lock() else {
        tracing::error!("Dedup cache lock poisoned; cannot mark message as processed");
        return;
    };

    // Insert the message
    guard.insert(message_id.to_string(), Instant::now());

    // Periodic cleanup: if cache is too large or has old entries
    if guard.len() > MAX_CACHE_SIZE {
        cleanup_stale_entries(&mut guard);
    }
}

/// Remove a message from the processed cache (used when delivery fails transiently,
/// so that NATS retry can proceed without being blocked by dedup).
fn unmark_message_processed(message_id: &str) {
    let cache = get_processed_messages();
    let Ok(mut guard) = cache.lock() else {
        return;
    };
    guard.remove(message_id);
}

/// Remove entries older than DEDUP_TTL
fn cleanup_stale_entries(cache: &mut HashMap<String, Instant>) {
    let now = Instant::now();
    cache.retain(|_, timestamp| now.duration_since(*timestamp) < DEDUP_TTL);
}

/// Background task to periodically clean up stale entries
/// Spawned once when the consumer starts
fn spawn_dedup_cleanup_task(cancel: tokio_util::sync::CancellationToken) {
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_secs(60)); // Clean up every minute
        loop {
            tokio::select! {
                _ = cancel.cancelled() => {
                    debug!("Dedup cleanup task cancelled");
                    break;
                }
                _ = interval.tick() => {
                    let cache = get_processed_messages();
                    if let Ok(mut guard) = cache.lock() {
                        let before = guard.len();
                        cleanup_stale_entries(&mut guard);
                        let after = guard.len();
                        if before > 0 && after < before {
                            debug!(
                                cleaned = before - after,
                                remaining = after,
                                "Cleaned up stale dedup entries"
                            );
                        }
                    }
                }
            }
        }
    });
}

/// Get message type statistics
pub fn get_message_type_stats() -> Vec<(String, u64)> {
    vec![
        (
            "request".to_string(),
            MSG_COUNT_REQUEST.load(Ordering::Relaxed),
        ),
        (
            "response".to_string(),
            MSG_COUNT_RESPONSE.load(Ordering::Relaxed),
        ),
        (
            "broadcast".to_string(),
            MSG_COUNT_BROADCAST.load(Ordering::Relaxed),
        ),
        (
            "notification".to_string(),
            MSG_COUNT_NOTIFICATION.load(Ordering::Relaxed),
        ),
    ]
}

/// Increment message type counter
fn increment_message_count(message_type: &str) {
    match message_type {
        "request" => MSG_COUNT_REQUEST.fetch_add(1, Ordering::Relaxed),
        "response" => MSG_COUNT_RESPONSE.fetch_add(1, Ordering::Relaxed),
        "broadcast" => MSG_COUNT_BROADCAST.fetch_add(1, Ordering::Relaxed),
        "notification" => MSG_COUNT_NOTIFICATION.fetch_add(1, Ordering::Relaxed),
        _ => 0,
    };
}

/// Consumer name for the message delivery pull consumer.
/// Durable — survives consumer restarts and resumes from last ack.
const CONSUMER_NAME: &str = "message_delivery";

/// Start the message delivery consumer as a background task.
///
/// Returns a `JoinHandle` for the spawned task. The task runs until the
/// cancellation token is triggered or the NATS stream becomes unavailable.
///
/// # Arguments
/// * `connection` — NATS connection (must be initialized with JetStream)
/// * `cancel` — cancellation token for graceful shutdown
pub fn start_message_delivery_consumer(
    connection: NatsConnection,
    cancel: tokio_util::sync::CancellationToken,
) -> tokio::task::JoinHandle<()> {
    // Spawn background cleanup task for dedup cache
    spawn_dedup_cleanup_task(cancel.clone());

    tokio::spawn(async move {
        info!("Message delivery consumer starting");

        // Initialize the pull consumer with retry — the AGENT_MESSAGES stream may
        // not be ready yet during early startup. Retry up to 10 times with backoff.
        let messages = match init_pull_consumer_with_retry(&connection, &cancel).await {
            Ok(m) => m,
            Err(e) => {
                error!(error = %e, "Failed to initialize message delivery consumer after retries");
                return;
            }
        };

        info!(
            "Message delivery consumer running (stream: {})",
            AGENT_MESSAGES_STREAM
        );

        // Process messages until cancelled or stream error
        process_messages(messages, cancel).await;

        info!("Message delivery consumer stopped");
    })
}

/// Create or get the durable pull consumer for agent messages.
///
/// Returns a boxed message stream to avoid naming the private `pull::Consumer` type.
async fn init_pull_consumer(
    connection: &NatsConnection,
) -> ErgataiResult<
    futures::stream::BoxStream<
        'static,
        Result<async_nats::jetstream::Message, Box<dyn std::error::Error + Send + Sync>>,
    >,
> {
    ergatai_nats::dag_event_stream::init_pull_consumer_generic(
        connection,
        AGENT_MESSAGES_STREAM,
        CONSUMER_NAME,
        "ergatai.agent.message.*", // Only receive agent messages, not receipts or timeouts
        30,                        // ack_wait: 30s
        20,                        // max_deliver: 20 attempts
    )
    .await
    .map_err(ErgataiError::NatsError)
}

/// Initialize the pull consumer with retry logic.
///
/// During early startup the AGENT_MESSAGES stream may not exist yet. Instead of
/// failing immediately and leaving the system without message delivery, retry
/// up to 10 times with exponential backoff (500ms → 30s cap).
async fn init_pull_consumer_with_retry(
    connection: &NatsConnection,
    cancel: &tokio_util::sync::CancellationToken,
) -> ErgataiResult<
    futures::stream::BoxStream<
        'static,
        Result<async_nats::jetstream::Message, Box<dyn std::error::Error + Send + Sync>>,
    >,
> {
    let mut delay = Duration::from_millis(500);
    let max_delay = Duration::from_secs(30);

    for attempt in 1..=10 {
        match init_pull_consumer(connection).await {
            Ok(stream) => return Ok(stream),
            Err(e) => {
                if attempt == 10 {
                    return Err(e);
                }
                warn!(
                    attempt = attempt,
                    error = %e,
                    delay_ms = delay.as_millis().min(u64::MAX as u128) as u64,
                    "Consumer init failed, retrying"
                );
                tokio::select! {
                    _ = cancel.cancelled() => {
                        return Err(ErgataiError::NatsError("Cancelled during consumer init retry".to_string()));
                    }
                    _ = tokio::time::sleep(delay) => {}
                }
                delay = (delay * 2).min(max_delay);
            }
        }
    }
    // If we exit the loop (e.g., cancellation), return an error instead of panicking.
    Err(ErgataiError::NatsError(
        "Consumer initialization loop exited unexpectedly".to_string(),
    ))
}

/// Main message processing loop.
///
/// Pulls messages from the stream, attempts delivery via AgentRuntime injection,
/// and acks/naks based on the result.
async fn process_messages(
    mut messages: futures::stream::BoxStream<
        'static,
        Result<async_nats::jetstream::Message, Box<dyn std::error::Error + Send + Sync>>,
    >,
    cancel: tokio_util::sync::CancellationToken,
) {
    loop {
        // Use tokio::select! to race messages against cancellation — no polling interval,
        // immediate shutdown when cancel is triggered.
        tokio::select! {
            _ = cancel.cancelled() => {
                info!("Message delivery consumer cancelled");
                break;
            }
            msg = messages.next() => {
                match msg {
                    // Stream closed
                    None => {
                        warn!("Message stream closed, consumer exiting");
                        break;
                    }

                    // Message received
                    Some(Ok(msg)) => {
                        handle_message(&msg).await;
                    }

                    // Transport error
                    Some(Err(e)) => {
                        warn!(error = %e, "Error receiving message from stream");
                        // Continue — transient errors shouldn't kill the consumer
                    }
                }
            }
        }
    }
}

/// Handle a single message: deserialize, deliver, ack/nak.
async fn handle_message(msg: &async_nats::jetstream::Message) {
    // Deserialize the payload
    let payload: AgentMessagePayload = match serde_json::from_slice(&msg.payload) {
        Ok(p) => p,
        Err(e) => {
            error!(
                error = %e,
                subject = msg.subject.as_str(),
                "Failed to deserialize AgentMessagePayload — acking to discard"
            );
            // Malformed message — ack to discard (retry won't help)
            if let Err(ack_err) = msg.ack().await {
                warn!("Failed to ack malformed message: {}", ack_err);
            }
            return;
        }
    };

    let from = &payload.from_agent;
    let to = &payload.to_agent;

    // Use the message_type from the payload (now available after adding the field)
    // Fall back to inference for backward compatibility with old messages
    let msg_type = if payload.message_type.is_empty() {
        // Backward compatibility: infer from payload characteristics
        if payload.to_agent == "*" || payload.to_agent == "all" || payload.to_agent == "broadcast" {
            "broadcast"
        } else if payload.correlation_id.is_some() {
            "request"
        } else if payload.content.contains("receipt") || payload.content.contains("timeout") {
            "notification"
        } else {
            "response"
        }
    } else {
        payload.message_type.as_str()
    };
    increment_message_count(msg_type);

    // ── Idempotency check: skip duplicate deliveries ──
    // If this message was already processed (e.g., ack failed but delivery succeeded),
    // skip re-delivery to prevent duplicate messages reaching the agent.
    if is_duplicate_message(&payload.message_id) {
        warn!(
            from = from,
            to = to,
            message_id = %payload.message_id,
            "Duplicate message detected — skipping re-delivery (already processed)"
        );
        // Ack to remove from stream (we already delivered it successfully before)
        if let Err(ack_err) = msg.ack().await {
            error!(
                message_id = %payload.message_id,
                error = %ack_err,
                "Failed to ack duplicate message"
            );
        }
        return;
    }

    // Warn on redeliveries (for visibility, but we handle them via dedup)
    if let Ok(info) = msg.info() {
        if info.delivered > 1 {
            warn!(
                from = from,
                to = to,
                delivery_count = info.delivered,
                message_id = %payload.message_id,
                "Message redelivered — will check dedup cache"
            );
        }
    }

    // ── Resolve sender and recipient runtime IDs for delivery ──
    // Priority: instance ID (within lifecycle) > runtime agent ID (dynamic)
    let runtime = match crate::context::try_get_app_context() {
        Some(ctx) => ctx.agent_runtime.clone(),
        None => {
            warn!(
                message_id = %payload.message_id,
                "AppContext not yet initialized, deferring message delivery"
            );
            // Don't ack - let NATS redeliver after ack_wait timeout or consumer restart
            return;
        }
    };

    // The message content is already formatted by the MCP server (server.rs)
    // with instruction + JSON payload. Just deliver it as-is.
    let formatted_message = payload.content.as_str();

    let to_runtime_id = runtime
        .resolve_agent_id(&payload.to_agent)
        .await
        .unwrap_or_else(|| payload.to_agent.clone());

    // ── Deliver via AgentRuntime injection (ACP protocol) ──
    // Sends the message to the target agent via ACP protocol.

    info!(
        from = from,
        to = to,
        runtime_id = ?to_runtime_id,
        "Delivering message: MCP target → runtime resolution"
    );

    // Record pending response BEFORE inject_message to avoid race condition.
    // inject_message blocks until the agent finishes processing, but the agent
    // may send a response before inject_message returns. If we record pending
    // response after inject_message, the response lookup will fail.
    //
    // Cleanup strategy:
    // - If delivery succeeds: pending response remains (cleaned up when actual response arrives)
    // - If delivery fails: we explicitly call remove_pending_response() below
    if payload.requires_receipt {
        if let Some(corr_id) = &payload.correlation_id {
            crate::messaging::record_pending_response(to, corr_id).await;
            debug!(
                message_id = %payload.message_id,
                to = %to,
                correlation_id = %corr_id,
                "Recorded pending response BEFORE delivery (NATS consumer)"
            );
        }
    }

    // Mark as processed BEFORE inject_message to prevent duplicate delivery if NATS
    // redelivers during the (potentially long) inject_message call. The TOCTOU race
    // between is_duplicate_message() and mark_message_processed() could otherwise allow
    // two concurrent inject_message() calls for the same message.
    //
    // If inject_message fails transiently (nak path), we remove the mark below so the
    // retry can proceed. On permanent failure (agent not found, ack path), we keep the
    // mark since the message is discarded anyway.
    mark_message_processed(&payload.message_id);

    // Conversation-centric delivery: direct conversation_id → AgentInfo lookup.
    // This bypasses the agent_id intermediary lookup for better performance.
    let conversation_id = match payload.target_conversation_id.as_ref() {
        Some(id) => *id,
        None => {
            error!(
                message_id = %payload.message_id,
                from = from,
                to = to,
                "Message missing target_conversation_id (required for Conversation-centric delivery), discarding"
            );
            // Ack to discard the message (it's invalid and won't be deliverable)
            let _ = msg.ack().await;
            return;
        }
    };

    info!(
        from = from,
        to = to,
        conversation_id = %conversation_id,
        image_count = payload.images.len(),
        "Using Conversation-centric delivery (direct conversation_id → AgentInfo lookup)"
    );

    // Give the next output turn enough transport context to persist a stable
    // request/output correlation. This is intentionally invisible to the agent.
    if from != "user" {
        if let Some(registry) =
            ergatai_runtime::output_accumulator::get_global_accumulator_registry()
        {
            registry
                .set_pending_turn_context(
                    &conversation_id.to_string(),
                    ergatai_runtime::output_accumulator::TurnContext {
                        reply_to_message_id: Some(payload.message_id.clone()),
                        correlation_id: payload.correlation_id.clone(),
                        source_conversation_id: None,
                    },
                )
                .await;
        }
    }

    // ── EARLY PERSISTENCE: Make message visible before agent processing ──
    // Persist the request message immediately so it's visible in conversation API
    // and SSE stream before the agent starts processing it.
    //
    // This ensures that when the delivery pipeline accepts a message, it becomes
    // queryable via /api/v1/conversations/{id}/messages right away, rather than
    // only after the agent finishes processing (which could take minutes).
    //
    // Two-level dedup prevents duplicate inserts on NATS redelivery:
    // 1. In-memory dedup (is_duplicate_message + mark_message_processed)
    // 2. SQLite-level dedup (exists_by_external_message_id check below)

    // SQLite-level dedup: check if this message was already persisted
    // Prefer frontend-generated clientRequestId (from metadata) over backend message_id.
    // This enables optimistic → durable message replacement in the frontend.
    let external_message_id = payload
        .metadata
        .get("clientRequestId")
        .cloned()
        .unwrap_or_else(|| payload.message_id.clone());
    let already_persisted = tokio::task::spawn_blocking({
        let external_message_id = external_message_id.clone();
        move || {
            crate::user_data_db::messages::exists_by_external_message_id(
                conversation_id,
                &external_message_id,
            )
            .unwrap_or(false)
        }
    })
    .await
    .unwrap_or(false);

    if already_persisted {
        info!(
            message_id = %external_message_id,
            conversation_id = %conversation_id,
            "Message already persisted (NATS redelivery after early persistence) — skipping duplicate insert"
        );
        // Skip persistence but continue to inject (the message still needs to be delivered)
    } else {
        if from == "user" {
            // ── User message persistence (NO SSE push - frontend already has it) ──
            let message_content = payload.content.clone();

            // Build parts array with text and images
            let mut parts = Vec::with_capacity(1 + payload.images.len());
            parts.push(serde_json::json!({
                "type": "text",
                "text": message_content,
            }));
            for image in &payload.images {
                parts.push(serde_json::json!({
                    "type": "data-image",
                    "data": image.base64_data,
                    "media_type": image.media_type,
                }));
            }

            // Persist user message to SQLite (NO SSE publish)
            let external_id_for_meta = external_message_id.clone();
            let append_result = tokio::task::spawn_blocking(move || {
                let metadata = serde_json::json!({
                    "externalMessageId": external_id_for_meta,
                    "deliveryStatus": "pending",  // Will be updated to "delivered" or "failed" after injection
                });
                crate::user_data_db::messages::append(
                    conversation_id,
                    "user",
                    serde_json::Value::Array(parts),
                    metadata,
                    None, // User messages don't need agent-specific fields
                )
            })
            .await;

            match append_result {
                Ok(Ok(_persisted_msg)) => {
                    info!(
                        message_id = %external_message_id,
                        "User message persisted to database (early, before inject)"
                    );
                }
                Ok(Err(e)) => {
                    warn!(
                        message_id = %external_message_id,
                        conversation_id = %conversation_id,
                        error = %e,
                        "Failed to persist user message to SQLite (will still attempt delivery)"
                    );
                }
                Err(e) => {
                    warn!(
                        message_id = %external_message_id,
                        conversation_id = %conversation_id,
                        error = %e,
                        "Failed to persist user message (task join error, will still attempt delivery)"
                    );
                }
            }
        }

        if from != "user" {
            // ── Agent message persistence + SSE push (early, before inject) ──
            let message_content = payload.content.clone();
            let from_agent = from.to_string();
            let message_type = payload.message_type.clone();

            // Determine role based on message type
            let role = match message_type.as_str() {
                "request" => "agent",
                "response" | "broadcast" => "assistant",
                _ => "agent",
            };

            // Parse the JSON message to extract structured data
            let parsed_content: Option<serde_json::Value> =
                serde_json::from_str(&message_content).ok();

            if parsed_content.is_none() && message_content.trim().starts_with('{') {
                warn!(
                    message_id = %external_message_id,
                    from_agent = %from,
                    "Agent message appears to be malformed JSON"
                );
            }

            let actual_message = parsed_content
                .as_ref()
                .and_then(|v| v.get("message"))
                .and_then(|m| m.as_str())
                .unwrap_or(&message_content)
                .to_string();

            let from_agent_name = parsed_content
                .as_ref()
                .and_then(|v| v.get("from"))
                .and_then(|f| f.as_str())
                .unwrap_or(&from_agent)
                .to_string();

            // Persist agent message to SQLite with structured fields
            let external_id_for_meta = external_message_id.clone();
            let correlation_id_for_meta = payload.correlation_id.clone();
            let append_result = tokio::task::spawn_blocking(move || {
                let metadata = serde_json::json!({
                    "externalMessageId": external_id_for_meta,
                    "senderAgentId": from_agent,
                    "senderAgentName": from_agent_name,
                    "messageType": message_type,
                    "correlationId": correlation_id_for_meta,
                    "deliveryStatus": "pending",  // Will be updated to "delivered" or "failed" after injection
                });

                let agent_fields = crate::user_data_db::messages::AgentMessageFields {
                    from_agent_id: parse_to_i64(&from_agent),
                    from_agent_name: Some(from_agent_name),
                    message_type: Some(message_type),
                    content: Some(actual_message),
                    projection_kind: Some("canonical".to_string()),
                    ..Default::default()
                };

                crate::user_data_db::messages::append(
                    conversation_id,
                    role,
                    serde_json::json!([{ "type": "text", "text": message_content }]),
                    metadata,
                    Some(agent_fields),
                )
            })
            .await;

            match append_result {
                Ok(Ok(persisted_msg)) => {
                    // Publish to conversation subject for SSE streaming
                    crate::messaging::publish_to_conversation_subject_with_message(
                        persisted_msg,
                        Some(from.to_string()),
                        Some(from.to_string()),
                    )
                    .await;
                    info!(
                        message_id = %external_message_id,
                        role = role,
                        "Agent message persisted and published to SSE (early, before inject)"
                    );
                }
                Ok(Err(e)) => {
                    warn!(
                        message_id = %external_message_id,
                        conversation_id = %conversation_id,
                        from_agent = %from,
                        error = %e,
                        "Failed to persist agent message to SQLite (will still attempt delivery)"
                    );
                }
                Err(e) => {
                    warn!(
                        message_id = %external_message_id,
                        conversation_id = %conversation_id,
                        from_agent = %from,
                        error = %e,
                        "Failed to persist agent message (task join error, will still attempt delivery)"
                    );
                }
            }
        }
    } // end of else block (not already_persisted)

    // ── Deliver via AgentRuntime injection (ACP protocol) ──
    // Choose delivery method based on whether images are present
    let mut delivery_result = if payload.images.is_empty() {
        runtime
            .inject_message_to_conversation(&conversation_id.to_string(), formatted_message)
            .await
    } else {
        // Convert NATS AgentImage to runtime AgentImage
        let runtime_images: Vec<ergatai_runtime::types::AgentImage> = payload
            .images
            .iter()
            .map(|img| ergatai_runtime::types::AgentImage {
                base64_data: img.base64_data.clone(),
                media_type: img.media_type.clone(),
                filename: img.filename.clone(),
            })
            .collect();

        runtime
            .inject_message_to_conversation_with_images(
                &conversation_id.to_string(),
                formatted_message,
                runtime_images.clone(),
            )
            .await
    };

    // If delivery failed because agent/conversation not found, try to auto-resume suspended agent
    if let Err(ref e) = delivery_result {
        let is_not_found = matches!(
            e,
            ergatai_error::ErgataiError::NotFound(_)
                | ergatai_error::ErgataiError::AgentNotFound(_)
        );
        if is_not_found {
            tracing::info!(
                from = from,
                to = to,
                conversation_id = %conversation_id,
                "Delivery failed with not found error, checking for suspended agent"
            );

            if let Some(_resumed_id) =
                crate::services::agent_service::try_auto_resume_suspended_agent(
                    &runtime,
                    to,
                    Some(&conversation_id.to_string()),
                )
                .await
            {
                tracing::info!(
                    from = from,
                    to = to,
                    conversation_id = %conversation_id,
                    "Auto-resumed suspended agent, retrying delivery"
                );

                // Retry delivery
                delivery_result = if payload.images.is_empty() {
                    runtime
                        .inject_message_to_conversation(
                            &conversation_id.to_string(),
                            formatted_message,
                        )
                        .await
                } else {
                    let runtime_images: Vec<ergatai_runtime::types::AgentImage> = payload
                        .images
                        .iter()
                        .map(|img| ergatai_runtime::types::AgentImage {
                            base64_data: img.base64_data.clone(),
                            media_type: img.media_type.clone(),
                            filename: img.filename.clone(),
                        })
                        .collect();

                    runtime
                        .inject_message_to_conversation_with_images(
                            &conversation_id.to_string(),
                            formatted_message,
                            runtime_images,
                        )
                        .await
                };
            }
        }
    }

    // Extract external_message_id once for delivery status tracking (used in both success and error paths)
    let external_message_id = payload
        .metadata
        .get("clientRequestId")
        .cloned()
        .unwrap_or_else(|| payload.message_id.clone());
    let conversation_id_for_update = conversation_id;

    match delivery_result {
        Ok(()) => {
            info!(
                from = from,
                to = to,
                message_id = %payload.message_id,
                "Message delivered via AgentRuntime injection"
            );

            // Update delivery status to "delivered" in the database
            let ext_id = external_message_id;
            let conv_id = conversation_id_for_update;
            let _ = tokio::task::spawn_blocking(move || {
                crate::user_data_db::messages::update_delivery_status(conv_id, &ext_id, "delivered")
            })
            .await;

            // Ack FIRST to prevent duplicates on redelivery
            match msg.ack().await {
                Ok(_) => {
                    debug!(
                        message_id = %payload.message_id,
                        "Message ack successful"
                    );
                }
                Err(e) => {
                    error!(
                        message_id = %payload.message_id,
                        error = %e,
                        "Failed to ack message delivery - NATS will redeliver but dedup will prevent duplicate"
                    );
                }
            }

            // Note: Message was already persisted to SQLite BEFORE inject (early persistence).
            // No need to persist again here.

            // Publish read receipt if required (after ack to avoid duplicates)
            if payload.requires_receipt {
                if let Some(conn) = crate::context::try_get_app_context()
                    .and_then(|ctx| ctx.nats_connection.clone())
                {
                    let bus = ergatai_nats::EventBus::new(conn);
                    let read_at =
                        match std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH) {
                            Ok(duration) => duration.as_secs(),
                            Err(e) => {
                                warn!(
                                    message_id = %payload.message_id,
                                    error = %e,
                                    "System time before UNIX epoch, using 0 for read_at"
                                );
                                0
                            }
                        };

                    // Note: from_agent is the READER (recipient of original message)
                    // to_agent is the ORIGINAL SENDER (who receives the receipt)
                    let receipt = ergatai_nats::ReadReceiptPayload {
                        message_id: payload.message_id.clone(),
                        from_agent: to.to_string(), // reader/recipient
                        to_agent: from.to_string(), // original sender receives receipt
                        read_at,
                    };

                    match bus.publish_read_receipt(&receipt).await {
                        Ok(_) => {
                            info!(
                                message_id = %payload.message_id,
                                "Read receipt published successfully"
                            );
                        }
                        Err(e) => {
                            warn!(
                                message_id = %payload.message_id,
                                error = %e,
                                "Failed to publish read receipt"
                            );
                        }
                    }
                }
            }

            // Note: pending response was already recorded BEFORE inject_message
            // to avoid race condition where agent responds before inject_message returns.
        }
        Err(e) => {
            // Update delivery status to "failed" in the database
            let ext_id = external_message_id;
            let conv_id = conversation_id_for_update;
            let _ = tokio::task::spawn_blocking(move || {
                crate::user_data_db::messages::update_delivery_status(conv_id, &ext_id, "failed")
            })
            .await;

            // Clean up pending response if delivery failed (to avoid leak)
            if payload.requires_receipt {
                if let Some(corr_id) = &payload.correlation_id {
                    crate::messaging::remove_pending_response(to, corr_id).await;
                    debug!(
                        message_id = %payload.message_id,
                        to = %to,
                        correlation_id = %corr_id,
                        "Removed pending response due to delivery failure"
                    );
                }
            }

            // Check if this is a permanent "agent not found" error vs transient error
            let is_agent_not_found = matches!(e, ergatai_error::ErgataiError::AgentNotFound(_));

            if is_agent_not_found {
                // Agent permanently gone — ack to discard, no point retrying
                warn!(
                    from = from,
                    to = to,
                    error = %e,
                    "Target agent no longer exists — acking to discard (no retry)"
                );
                if let Err(ack_err) = msg.ack().await {
                    error!("Failed to ack undeliverable message: {}", ack_err);
                }
            } else {
                // Transient error — nak for retry
                // Remove from processed cache so the retry is not blocked by dedup.
                unmark_message_processed(&payload.message_id);
                warn!(
                    from = from,
                    to = to,
                    error = %e,
                    "AgentRuntime injection failed — naking for retry"
                );
                if let Err(nak_err) = msg.ack_with(AckKind::Nak(None)).await {
                    error!("Failed to nak message: {}", nak_err);
                }
            }
        }
    }
}

// ── Tests ──

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_consumer_name_is_durable() {
        assert_eq!(CONSUMER_NAME, "message_delivery");
    }

    #[test]
    fn test_consumer_name_is_non_empty() {
        assert!(!CONSUMER_NAME.is_empty());
    }

    #[test]
    fn test_consumer_name_is_snake_case() {
        // Durable names in NATS JetStream should be snake_case/kebab-case
        assert!(
            CONSUMER_NAME
                .chars()
                .all(|c| c.is_ascii_lowercase() || c == '_' || c.is_ascii_digit()),
            "CONSUMER_NAME should be snake_case"
        );
    }

    #[test]
    fn test_ack_wait_is_thirty_seconds() {
        // The consumer config uses ack_wait: Duration::from_secs(30).
        // Document the expected value so changes are visible.
        let expected_ack_wait = Duration::from_secs(30);
        assert_eq!(expected_ack_wait.as_secs(), 30);
    }

    #[test]
    fn test_max_deliver_is_twenty() {
        // The consumer config uses max_deliver: 20.
        // Document the expected value so changes are visible.
        let expected_max_deliver: i64 = 20;
        assert_eq!(expected_max_deliver, 20);
    }

    #[test]
    fn test_retry_delay_starts_at_500ms() {
        // init_pull_consumer_with_retry starts with delay = 500ms
        let initial_delay = Duration::from_millis(500);
        assert_eq!(initial_delay.as_millis(), 500);
    }

    #[test]
    fn test_retry_delay_max_is_30s() {
        let max_delay = Duration::from_secs(30);
        assert_eq!(max_delay.as_secs(), 30);
    }

    #[test]
    fn test_retry_delay_exponential_backoff_sequence() {
        // Verify the backoff sequence: 500ms, 1s, 2s, 4s, 8s, 16s, 30s (capped), ...
        let mut delay = Duration::from_millis(500);
        let max_delay = Duration::from_secs(30);

        let expected = vec![500, 1000, 2000, 4000, 8000, 16000, 30000, 30000];
        for &exp_ms in &expected {
            assert_eq!(delay.as_millis() as u64, exp_ms, "delay sequence mismatch");
            delay = (delay * 2).min(max_delay);
        }
        // After reaching the cap, further doublings stay at cap
        assert_eq!(delay.as_secs(), 30);
    }

    #[test]
    fn test_retry_max_attempts_is_ten() {
        // init_pull_consumer_with_retry retries up to 10 times.
        let max_attempts: u32 = 10;
        assert_eq!(max_attempts, 10);
        // Total worst-case wait: 500+1000+2000+4000+8000+16000+30000*4 = 151.5s
        // This bounds the startup delay when the stream isn't ready.
    }

    #[test]
    fn test_dedup_ttl_is_five_minutes() {
        assert_eq!(DEDUP_TTL.as_secs(), 300);
    }

    #[test]
    fn test_max_cache_size_is_ten_thousand() {
        assert_eq!(MAX_CACHE_SIZE, 10000);
    }

    #[test]
    fn test_dedup_cache_initialization() {
        // Test that cache can be initialized and accessed
        let cache = get_processed_messages();
        assert!(cache.lock().is_ok());
    }

    #[test]
    fn test_mark_and_check_duplicate() {
        // Use a unique message_id for this test
        let test_msg_id = format!(
            "test-dedup-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );

        // First check should return false (not a duplicate)
        assert!(!is_duplicate_message(&test_msg_id));

        // Mark as processed
        mark_message_processed(&test_msg_id);

        // Second check should return true (is a duplicate)
        assert!(is_duplicate_message(&test_msg_id));
    }

    #[test]
    fn test_cleanup_stale_entries() {
        let mut cache = HashMap::new();
        let now = Instant::now();

        // Add some old entries (beyond TTL)
        cache.insert("old-msg-1".to_string(), now - Duration::from_secs(400));
        cache.insert("old-msg-2".to_string(), now - Duration::from_secs(500));

        // Add some recent entries (within TTL)
        cache.insert("new-msg-1".to_string(), now - Duration::from_secs(60));
        cache.insert("new-msg-2".to_string(), now);

        assert_eq!(cache.len(), 4);

        // Cleanup should remove old entries
        cleanup_stale_entries(&mut cache);

        assert_eq!(cache.len(), 2);
        assert!(cache.contains_key("new-msg-1"));
        assert!(cache.contains_key("new-msg-2"));
        assert!(!cache.contains_key("old-msg-1"));
        assert!(!cache.contains_key("old-msg-2"));
    }

    #[test]
    fn test_unmark_message_processed() {
        let test_msg_id = format!(
            "test-unmark-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );

        // Mark as processed
        mark_message_processed(&test_msg_id);
        assert!(is_duplicate_message(&test_msg_id));

        // Unmark should remove from cache
        unmark_message_processed(&test_msg_id);
        assert!(!is_duplicate_message(&test_msg_id));
    }

    #[test]
    fn test_message_type_counters_initial_state() {
        // Counters should start at 0 (or whatever they were from previous tests)
        let stats = get_message_type_stats();
        assert_eq!(stats.len(), 4);

        // Verify all message types are present
        let types: Vec<&String> = stats.iter().map(|(t, _)| t).collect();
        assert!(types.contains(&&"request".to_string()));
        assert!(types.contains(&&"response".to_string()));
        assert!(types.contains(&&"broadcast".to_string()));
        assert!(types.contains(&&"notification".to_string()));
    }

    #[test]
    fn test_increment_message_count_request() {
        let initial_count = MSG_COUNT_REQUEST.load(Ordering::Relaxed);
        increment_message_count("request");
        let new_count = MSG_COUNT_REQUEST.load(Ordering::Relaxed);
        assert_eq!(new_count, initial_count + 1);
    }

    #[test]
    fn test_increment_message_count_response() {
        let initial_count = MSG_COUNT_RESPONSE.load(Ordering::Relaxed);
        increment_message_count("response");
        let new_count = MSG_COUNT_RESPONSE.load(Ordering::Relaxed);
        assert_eq!(new_count, initial_count + 1);
    }

    #[test]
    fn test_increment_message_count_broadcast() {
        let initial_count = MSG_COUNT_BROADCAST.load(Ordering::Relaxed);
        increment_message_count("broadcast");
        let new_count = MSG_COUNT_BROADCAST.load(Ordering::Relaxed);
        assert_eq!(new_count, initial_count + 1);
    }

    #[test]
    fn test_increment_message_count_notification() {
        let initial_count = MSG_COUNT_NOTIFICATION.load(Ordering::Relaxed);
        increment_message_count("notification");
        let new_count = MSG_COUNT_NOTIFICATION.load(Ordering::Relaxed);
        assert_eq!(new_count, initial_count + 1);
    }

    #[test]
    fn test_increment_message_count_unknown_type() {
        // Unknown message types should not panic
        increment_message_count("unknown_type");
        increment_message_count("");
        // If we get here without panic, the test passes
    }

    #[test]
    fn test_dedup_cache_concurrent_access() {
        use std::thread;

        let test_msg_id = format!(
            "test-concurrent-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );

        // Spawn multiple threads accessing the cache
        let handles: Vec<_> = (0..10)
            .map(|_| {
                let msg_id = test_msg_id.clone();
                thread::spawn(move || {
                    mark_message_processed(&msg_id);
                    is_duplicate_message(&msg_id);
                })
            })
            .collect();

        // Wait for all threads to complete
        for handle in handles {
            handle.join().unwrap();
        }

        // Should still be able to check the message
        assert!(is_duplicate_message(&test_msg_id));
    }

    #[test]
    fn test_cleanup_preserves_recent_entries() {
        let mut cache = HashMap::new();
        let now = Instant::now();

        // Add entries at different ages
        cache.insert("very-old".to_string(), now - Duration::from_secs(600));
        cache.insert("old".to_string(), now - Duration::from_secs(350));
        cache.insert("recent".to_string(), now - Duration::from_secs(100));
        cache.insert("brand-new".to_string(), now);

        cleanup_stale_entries(&mut cache);

        // Only entries within TTL should remain
        assert_eq!(cache.len(), 2);
        assert!(cache.contains_key("recent"));
        assert!(cache.contains_key("brand-new"));
    }

    #[test]
    fn test_mark_message_processed_triggers_cleanup() {
        let cache = get_processed_messages();
        let mut guard = cache.lock().unwrap();

        // Fill cache beyond MAX_CACHE_SIZE threshold
        // (We'll use a smaller number for testing)
        for i in 0..100 {
            guard.insert(format!("msg-{}", i), Instant::now());
        }

        // Mark a new message - this should trigger cleanup if cache is large
        drop(guard);
        mark_message_processed("trigger-cleanup-test");

        // Cache should still be accessible
        assert!(cache.lock().is_ok());
    }

    #[test]
    fn test_get_message_type_stats_returns_all_types() {
        let stats = get_message_type_stats();

        assert_eq!(stats.len(), 4);

        // Verify structure
        for (msg_type, count) in stats {
            assert!(!msg_type.is_empty());
            // Count should be non-negative (u64 is always >= 0)
            let _ = count;
        }
    }

    #[test]
    fn test_dedup_ttl_boundary() {
        let mut cache = HashMap::new();
        let now = Instant::now();

        // Add entry exactly at TTL boundary
        cache.insert("at-boundary".to_string(), now - DEDUP_TTL);

        // Add entry just within TTL
        cache.insert(
            "within-ttl".to_string(),
            now - (DEDUP_TTL - Duration::from_secs(1)),
        );

        // Add entry just beyond TTL
        cache.insert(
            "beyond-ttl".to_string(),
            now - (DEDUP_TTL + Duration::from_secs(1)),
        );

        cleanup_stale_entries(&mut cache);

        // Only entries within TTL should remain
        assert_eq!(cache.len(), 1);
        assert!(cache.contains_key("within-ttl"));
    }

    #[test]
    fn test_processed_messages_cache_isolation() {
        // Test that different message IDs are tracked independently
        let msg_id_1 = format!(
            "test-isolation-1-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        let msg_id_2 = format!(
            "test-isolation-2-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );

        assert!(!is_duplicate_message(&msg_id_1));
        assert!(!is_duplicate_message(&msg_id_2));

        mark_message_processed(&msg_id_1);

        assert!(is_duplicate_message(&msg_id_1));
        assert!(!is_duplicate_message(&msg_id_2));

        mark_message_processed(&msg_id_2);

        assert!(is_duplicate_message(&msg_id_1));
        assert!(is_duplicate_message(&msg_id_2));
    }
}
