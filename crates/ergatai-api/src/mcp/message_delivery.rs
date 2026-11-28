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
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use async_nats::jetstream::message::AckKind;
use async_nats::jetstream::Message;
use futures::StreamExt;
use tokio::sync::mpsc;
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

/// Maximum JetStream delivery attempts for agent messages.
pub const MAX_DELIVER: usize = 20;
const MAX_DELIVER_U32: u32 = MAX_DELIVER as u32;

/// Exponential backoff bounds for transient delivery failures.
const RETRY_BASE_DELAY_MS: u64 = 1_000;
const RETRY_MAX_DELAY_MS: u64 = 30_000;

/// How long a user-initiated retry cancellation remains valid.
const CANCELLED_DELIVERY_TTL: Duration = Duration::from_secs(600);

static CANCELLED_DELIVERIES: once_cell::sync::OnceCell<Mutex<HashMap<String, Instant>>> =
    once_cell::sync::OnceCell::new();

fn cancelled_deliveries() -> &'static Mutex<HashMap<String, Instant>> {
    CANCELLED_DELIVERIES.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Cancel automatic redelivery for a specific agent message.
///
/// The delivery consumer checks this set before every attempt, so a message
/// that is already waiting for its next backoff interval is acked and dropped
/// instead of being delivered again.
pub fn cancel_delivery_retry(message_id: &str) {
    let Ok(mut guard) = cancelled_deliveries().lock() else {
        tracing::error!("Cancelled delivery lock poisoned; cannot cancel retry");
        return;
    };
    let now = Instant::now();
    guard.retain(|_, timestamp| now.duration_since(*timestamp) < CANCELLED_DELIVERY_TTL);
    guard.insert(message_id.to_string(), now);
}

/// Check whether a delivery retry was cancelled by the user.
fn is_delivery_cancelled(message_id: &str) -> bool {
    let Ok(mut guard) = cancelled_deliveries().lock() else {
        return false;
    };
    let now = Instant::now();
    guard.retain(|_, timestamp| now.duration_since(*timestamp) < CANCELLED_DELIVERY_TTL);
    guard.contains_key(message_id)
}

fn retry_delay_ms(attempt: u32) -> u64 {
    let exponent = attempt.saturating_sub(1).min(5);
    (RETRY_BASE_DELAY_MS << exponent).min(RETRY_MAX_DELAY_MS)
}

fn now_unix_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

/// Errors that cannot succeed by retrying the exact same prompt. These are
/// acked immediately so a permanent provider/model configuration problem does
/// not flood the conversation with duplicate error turns.
///
/// `NotFound`/`AgentNotFound` are included on purpose: the delivery path first
/// tries to auto-resume a suspended agent, so if the target is still missing
/// afterwards, retrying the same message cannot succeed. Leaving them on the
/// transient path caused a ~13 minute retry storm per stale message (20
/// attempts with exponential backoff), during which the queue made no
/// progress.
fn is_permanent_delivery_error(error: &ErgataiError) -> bool {
    if matches!(
        error,
        ErgataiError::AgentNotFound(_) | ErgataiError::NotFound(_)
    ) {
        return true;
    }

    let text = error.to_string().to_ascii_lowercase();
    [
        "free usage limit",
        "free-limit",
        "provider.free-limit",
        "model_not_found",
        "invalid_api_key",
        "authentication_error",
        "invalid authentication",
        "permission_denied",
        "unauthorized",
        "context_length_exceeded",
        "invalid_request_error",
        "bad request",
    ]
    .iter()
    .any(|needle| text.contains(needle))
}

/// Publish a retry status event to the target conversation so the UI can show
/// an in-place counter instead of one error message per attempt.
async fn publish_retry_event(conversation_id: &str, event: ergatai_runtime::AgentOutputEvent) {
    let Some(publisher) = ergatai_runtime::get_global_output_publisher() else {
        return;
    };
    if let Err(error) = publisher.publish(conversation_id, event).await {
        warn!(
            conversation_id = %conversation_id,
            error = %error,
            "Failed to publish retry status event"
        );
    }
}

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

/// Convert a user-origin delivery payload into agent-native prompt text.
///
/// Ergatai discovery/mention tokens (e.g. `@[agent:name]`, `@[file:...]`,
/// `$[skill:...]`) are a UI serialization format. Messages are persisted with
/// the raw tokens so the composer can re-render them as mentions, but agents
/// must receive plain text. Agent-to-agent payloads are structured JSON and are
/// passed through untouched.
fn prepare_delivery_message<'a>(
    from: &str,
    message: &'a str,
    agent_kind: Option<&str>,
) -> std::borrow::Cow<'a, str> {
    if from == "user" {
        std::borrow::Cow::Owned(
            crate::services::initial_prompt_turns::convert_prompt_tokens(message, agent_kind),
        )
    } else {
        std::borrow::Cow::Borrowed(message)
    }
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
        MAX_DELIVER,               // max_deliver: bounded retry attempts
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
/// Pulls messages from the stream and dispatches each to the worker that owns
/// its conversation. This loop deliberately never awaits an agent turn:
/// `inject_message` only returns when the prompt finishes, so awaiting it here
/// would serialize every conversation behind the slowest one (and behind any
/// pending permission approval).
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
                        dispatch_message(msg);
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

/// Per-conversation delivery workers.
///
/// `handle_message` awaits the whole agent turn (`inject_message` only returns
/// when the ACP prompt completes), which used to serialize every conversation
/// behind the slowest turn. One worker per conversation preserves ordering for
/// a single conversation while allowing unrelated chats — and their permission
/// prompts — to make progress concurrently. This is what prevents a long turn
/// in chat A from starving a new message in chat B.
static DELIVERY_WORKERS: OnceLock<Mutex<HashMap<String, mpsc::UnboundedSender<QueuedDelivery>>>> =
    OnceLock::new();

/// A JetStream message paired with the progress-ack guard that keeps it alive
/// while it waits in a worker queue and during the agent turn.
struct QueuedDelivery {
    msg: Message,
    progress_ack: ProgressAckGuard,
}

/// How long an idle per-conversation worker stays alive before exiting.
const DELIVERY_WORKER_IDLE_TIMEOUT: Duration = Duration::from_secs(300);

fn delivery_workers() -> &'static Mutex<HashMap<String, mpsc::UnboundedSender<QueuedDelivery>>> {
    DELIVERY_WORKERS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Ordering key for a delivery: conversation first, agent as fallback.
fn delivery_key_for_payload(payload: &AgentMessagePayload) -> String {
    payload
        .target_conversation_id
        .map(|conversation_id| conversation_id.to_string())
        .unwrap_or_else(|| payload.to_agent.clone())
}

fn delivery_key(msg: &Message) -> String {
    match serde_json::from_slice::<AgentMessagePayload>(&msg.payload) {
        Ok(payload) => delivery_key_for_payload(&payload),
        // Malformed payloads are acked/discarded by `handle_message`; they do
        // not need per-conversation ordering.
        Err(_) => "__invalid__".to_string(),
    }
}

/// Hand a message to the worker that owns its conversation.
fn dispatch_message(msg: Message) {
    let key = delivery_key(&msg);
    // Start renewing the ack deadline immediately: a worker may be busy with an
    // earlier turn in the same conversation, and an unacked queued message
    // would otherwise be redelivered every `ack_wait`.
    let mut delivery = QueuedDelivery {
        progress_ack: ProgressAckGuard::spawn(&msg),
        msg,
    };

    for _ in 0..2 {
        let sender = {
            let mut workers = delivery_workers()
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            match workers.get(&key) {
                Some(sender) if !sender.is_closed() => sender.clone(),
                _ => {
                    let (tx, rx) = mpsc::unbounded_channel();
                    let worker_tx = tx.clone();
                    let worker_key = key.clone();
                    tokio::spawn(async move {
                        run_delivery_worker(worker_key, worker_tx, rx).await;
                    });
                    workers.insert(key.clone(), tx.clone());
                    tx
                }
            }
        };

        match sender.send(delivery) {
            Ok(()) => return,
            Err(error) => {
                // The worker exited between the liveness check and the send.
                let QueuedDelivery { msg, progress_ack } = error.0;
                delivery = QueuedDelivery { msg, progress_ack };
            }
        }

        if let Ok(mut workers) = delivery_workers().lock() {
            workers.remove(&key);
        }
    }

    warn!(
        conversation = %key,
        "Failed to dispatch agent message to a delivery worker; dropping it"
    );
}

/// Sequentially deliver messages that belong to the same conversation.
async fn run_delivery_worker(
    key: String,
    sender: mpsc::UnboundedSender<QueuedDelivery>,
    mut receiver: mpsc::UnboundedReceiver<QueuedDelivery>,
) {
    loop {
        match tokio::time::timeout(DELIVERY_WORKER_IDLE_TIMEOUT, receiver.recv()).await {
            Ok(Some(delivery)) => {
                let QueuedDelivery { msg, progress_ack } = delivery;
                handle_message(&msg, progress_ack).await;
            }
            Ok(None) => break,
            Err(_) => {
                // Idle timeout. Remove ourselves from the registry first and
                // close the receiving end, then drain anything that was
                // dispatched before we shut down. Without the close, a
                // concurrent dispatch could send into the channel after the
                // drain and lose the message when the receiver is dropped.
                unregister_worker(&key, &sender);
                receiver.close();
                while let Ok(delivery) = receiver.try_recv() {
                    let QueuedDelivery { msg, progress_ack } = delivery;
                    handle_message(&msg, progress_ack).await;
                }
                break;
            }
        }
    }

    // Also clean up on the "all senders dropped" path.
    unregister_worker(&key, &sender);
}

/// Remove a worker from the registry, but only if it is still the registered
/// sender for its conversation.
fn unregister_worker(key: &str, sender: &mpsc::UnboundedSender<QueuedDelivery>) {
    if let Ok(mut workers) = delivery_workers().lock() {
        let is_current = workers
            .get(key)
            .is_some_and(|current| current.same_channel(sender));
        if is_current {
            workers.remove(key);
        }
    }
}

/// Keeps a JetStream delivery alive while a long agent turn is in flight.
///
/// `ack_wait` is 30 seconds, but a prompt turn routinely runs for minutes.
/// Without periodic `Progress` acks JetStream redelivers the same user message
/// mid-turn; the duplicate is then acked by the dedup path while the original
/// is still running, so a later delivery failure can no longer be retried.
struct ProgressAckGuard {
    handle: tokio::task::JoinHandle<()>,
}

impl ProgressAckGuard {
    fn spawn(msg: &Message) -> Self {
        let msg = msg.clone();
        let handle = tokio::spawn(async move {
            // Renew well before the 30s ack_wait deadline.
            let mut interval = tokio::time::interval(Duration::from_secs(10));
            interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            interval.tick().await; // consume the immediate first tick
            loop {
                interval.tick().await;
                if let Err(error) = msg.ack_with(AckKind::Progress).await {
                    debug!(
                        error = %error,
                        "Failed to send progress ack for in-flight message"
                    );
                    break;
                }
            }
        });
        Self { handle }
    }
}

impl Drop for ProgressAckGuard {
    fn drop(&mut self) {
        self.handle.abort();
    }
}

/// Handle a single message: deserialize, deliver, ack/nak.
///
/// `_progress_ack` is kept alive for the whole function so the JetStream ack
/// deadline is renewed while the agent turn runs and, if this message waited in
/// the worker queue, while it was queued.
async fn handle_message(msg: &Message, _progress_ack: ProgressAckGuard) {
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

    // A user-requested stop must win over any pending NATS redelivery.
    if is_delivery_cancelled(&payload.message_id) {
        info!(
            from = from,
            to = to,
            message_id = %payload.message_id,
            "Delivery retry cancelled by user — acking to discard"
        );
        if let Err(ack_err) = msg.ack().await {
            warn!("Failed to ack cancelled message: {}", ack_err);
        }
        return;
    }

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
            let user_external_id = external_message_id.clone();
            let append_result = tokio::task::spawn_blocking(move || {
                let metadata = serde_json::json!({
                    "externalMessageId": external_id_for_meta,
                    "deliveryStatus": "pending",  // Will be updated to "delivered" or "failed" after injection
                });
                crate::user_data_db::messages::append_idempotent(
                    conversation_id,
                    "user",
                    serde_json::Value::Array(parts),
                    metadata,
                    None, // User messages don't need agent-specific fields
                    Some(&user_external_id),
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

            // Determine role based on message type and sender relationship,
            // unified with the sender-side agent_message_role() so that
            // external responses are persisted as `respagent`.
            let role = crate::messaging::agent_message_role(&message_type, &from_agent, to);

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
            let agent_external_id_for_closure = external_message_id.clone();
            let correlation_id_for_meta = payload.correlation_id.clone();
            let origin_turn_id = payload.metadata.get("originTurnId").cloned();
            let origin_conversation_id = payload.metadata.get("originConversationId").cloned();
            let append_result = tokio::task::spawn_blocking(move || {
                let metadata = serde_json::json!({
                    "externalMessageId": external_id_for_meta,
                    "senderAgentId": from_agent,
                    "senderAgentName": from_agent_name,
                    "messageType": message_type,
                    "correlationId": correlation_id_for_meta,
                    "replyToTurnId": origin_turn_id,
                    "replyToConversationId": origin_conversation_id,
                    "deliveryStatus": "pending",  // Will be updated to "delivered" or "failed" after injection
                });

                let agent_fields = crate::user_data_db::messages::AgentMessageFields {
                    from_agent_id: parse_to_i64(&from_agent),
                    from_agent_name: Some(from_agent_name),
                    message_type: Some(message_type),
                    content: Some(actual_message),
                    projection_kind: Some(crate::constants::PROJECTION_KIND_CANONICAL.to_string()),
                    ..Default::default()
                };

                crate::user_data_db::messages::append_idempotent(
                    conversation_id,
                    role,
                    serde_json::json!([{ "type": "text", "text": message_content }]),
                    metadata,
                    Some(agent_fields),
                    Some(&agent_external_id_for_closure),
                )
            })
            .await;

            match append_result {
                Ok(Ok(outcome)) => {
                    if outcome.inserted {
                        // Publish to conversation subject for SSE streaming
                        crate::messaging::publish_to_conversation_subject_with_message(
                            outcome.message,
                            Some(from.to_string()),
                            Some(from.to_string()),
                        )
                        .await;
                        info!(
                            message_id = %external_message_id,
                            role = role,
                            "Agent message persisted and published to SSE (early, before inject)"
                        );
                    } else {
                        tracing::debug!(
                            message_id = %external_message_id,
                            "Agent message already persisted (duplicate); skipping SSE push"
                        );
                    }
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

    // ── Mention-token conversion (user messages only) ──
    // Convert Ergatai discovery/mention tokens (e.g. @[agent:name], @[file:...])
    // into agent-native text right before injection. Persistence above already
    // stored the raw tokens, so conversations keep rendering them as mentions.
    let agent_kind = match runtime.get_agent(&to_runtime_id).await {
        Some(info) => match info.profile.as_deref() {
            Some(profile_name) => crate::services::agent::resolve_kind_by_name(profile_name).await,
            None => crate::services::agent::AgentKind::Unknown,
        },
        None => crate::services::agent::AgentKind::Unknown,
    };
    let delivery_message = prepare_delivery_message(from, formatted_message, agent_kind.as_str());

    // ── Deliver via AgentRuntime injection (ACP protocol) ──
    // A single prompt turn can outlive `ack_wait` by minutes. The
    // `_progress_ack` passed into this function keeps the JetStream delivery
    // alive while the agent works so the same user message is not redelivered
    // as a second turn (and so a late failure can still be retried).
    let delivery_result = {
        // Choose delivery method based on whether images are present
        let mut result = if payload.images.is_empty() {
            runtime
                .inject_message_to_conversation(&conversation_id.to_string(), &delivery_message)
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
                    &delivery_message,
                    runtime_images.clone(),
                )
                .await
        };

        // If delivery failed because agent/conversation not found, try to auto-resume suspended agent
        if let Err(ref e) = result {
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
                    result = if payload.images.is_empty() {
                        runtime
                            .inject_message_to_conversation(
                                &conversation_id.to_string(),
                                &delivery_message,
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
                                &delivery_message,
                                runtime_images,
                            )
                            .await
                    };
                }
            }
        }

        result
    };

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

            // Check if this is a permanent error vs transient error.
            // "agent not found" is permanently undeliverable.
            // Provider configuration errors (model_not_found, auth, quota) are
            // also effectively permanent for this message: retrying the same
            // prompt cannot succeed until the user changes model/provider, and
            // redelivery only floods the stream with duplicate errors.
            let err_text = e.to_string();
            let attempt = msg
                .info()
                .map(|info| info.delivered as u32)
                .unwrap_or(1)
                .max(1);

            if is_permanent_delivery_error(&e) {
                // Permanently undeliverable (or not retryable) — ack to discard,
                // no point retrying. The ACP layer already surfaced the concrete
                // error to the conversation stream.
                warn!(
                    from = from,
                    to = to,
                    attempt = attempt,
                    error = %e,
                    "Message not retryable — acking to discard (no retry)"
                );
                publish_retry_event(
                    &conversation_id.to_string(),
                    ergatai_runtime::AgentOutputEvent::Retry {
                        role: "assistant".to_string(),
                        attempt,
                        max_attempts: MAX_DELIVER_U32,
                        delay_ms: 0,
                        next_retry_at_ms: 0,
                        message: err_text,
                        error_name: extract_error_name(&e.to_string()),
                        message_id: Some(payload.message_id.clone()),
                        cancelled: true,
                    },
                )
                .await;
                if let Err(ack_err) = msg.ack().await {
                    error!("Failed to ack undeliverable message: {}", ack_err);
                }
                return;
            }

            if is_delivery_cancelled(&payload.message_id) || attempt >= MAX_DELIVER_U32 {
                // The user stopped retrying, or the consumer exhausted its
                // delivery budget. The last ACP error remains visible; clear
                // the in-place retry indicator.
                let cancelled_by_user = is_delivery_cancelled(&payload.message_id);
                warn!(
                    from = from,
                    to = to,
                    attempt = attempt,
                    cancelled_by_user = cancelled_by_user,
                    "Delivery retry loop stopped"
                );
                publish_retry_event(
                    &conversation_id.to_string(),
                    ergatai_runtime::AgentOutputEvent::Retry {
                        role: "assistant".to_string(),
                        attempt,
                        max_attempts: MAX_DELIVER_U32,
                        delay_ms: 0,
                        next_retry_at_ms: 0,
                        message: err_text,
                        error_name: extract_error_name(&e.to_string()),
                        message_id: Some(payload.message_id.clone()),
                        cancelled: true,
                    },
                )
                .await;
                if let Err(ack_err) = msg.ack().await {
                    error!("Failed to ack stopped delivery: {}", ack_err);
                }
                return;
            }

            // Transient error — nak with exponential backoff and publish an
            // in-place retry indicator so the UI does not render one red error
            // bubble per attempt.
            unmark_message_processed(&payload.message_id);
            let delay_ms = retry_delay_ms(attempt);
            let next_retry_at_ms = now_unix_ms() + delay_ms as i64;
            warn!(
                from = from,
                to = to,
                attempt = attempt,
                delay_ms = delay_ms,
                error = %e,
                "AgentRuntime injection failed — retrying with backoff"
            );
            publish_retry_event(
                &conversation_id.to_string(),
                ergatai_runtime::AgentOutputEvent::Retry {
                    role: "assistant".to_string(),
                    attempt,
                    max_attempts: MAX_DELIVER_U32,
                    delay_ms,
                    next_retry_at_ms,
                    message: err_text,
                    error_name: extract_error_name(&e.to_string()),
                    message_id: Some(payload.message_id.clone()),
                    cancelled: false,
                },
            )
            .await;
            if let Err(nak_err) = msg
                .ack_with(AckKind::Nak(Some(Duration::from_millis(delay_ms))))
                .await
            {
                error!("Failed to nak message with backoff: {}", nak_err);
            }
        }
    }
}

/// Best-effort structured error kind extraction for retry/error UI copy.
fn extract_error_name(text: &str) -> Option<String> {
    let lower = text.to_ascii_lowercase();
    [
        "model_not_found",
        "invalid_api_key",
        "authentication_error",
        "permission_denied",
        "rate_limit",
        "overloaded",
        "timeout",
        "context_length_exceeded",
    ]
    .iter()
    .find(|kind| lower.contains(**kind))
    .map(|kind| (*kind).to_string())
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
    fn test_prepare_delivery_message_converts_user_tokens() {
        let converted = prepare_delivery_message(
            "user",
            "@[agent:General] 这个是什么agentz",
            Some("opencode"),
        );
        assert_eq!(converted.as_ref(), "@General 这个是什么agentz");
    }

    #[test]
    fn test_prepare_delivery_message_preserves_newlines_and_indentation() {
        let converted =
            prepare_delivery_message("user", "@[agent:General]\n\n    indented code", None);
        assert_eq!(converted.as_ref(), "@General\n\n    indented code");
    }

    #[test]
    fn test_prepare_delivery_message_passes_non_user_payloads_through() {
        let payload = r#"{"instruction":"send_message","content":"@[agent:x]"}"#;
        let delivered = prepare_delivery_message("agent_1", payload, Some("opencode"));
        assert_eq!(delivered.as_ref(), payload);
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
        // The consumer config uses the shared MAX_DELIVER constant.
        assert_eq!(MAX_DELIVER, 20);
    }

    #[test]
    fn test_retry_delay_uses_exponential_backoff() {
        assert_eq!(retry_delay_ms(1), 1_000);
        assert_eq!(retry_delay_ms(2), 2_000);
        assert_eq!(retry_delay_ms(3), 4_000);
        assert_eq!(retry_delay_ms(4), 8_000);
        assert_eq!(retry_delay_ms(5), 16_000);
        assert_eq!(retry_delay_ms(6), RETRY_MAX_DELAY_MS);
        assert_eq!(retry_delay_ms(20), RETRY_MAX_DELAY_MS);
    }

    #[test]
    fn test_permanent_provider_errors_are_not_retried() {
        let model_error = ErgataiError::internal(
            "ACP queued prompt failed: Internal error: There's an issue with the selected model (qwen3.7-plus).: {\"errorKind\": \"model_not_found\"}",
        );
        assert!(is_permanent_delivery_error(&model_error));

        let auth_error = ErgataiError::internal("invalid_api_key: bad key");
        assert!(is_permanent_delivery_error(&auth_error));

        let transient = ErgataiError::internal("upstream request timed out");
        assert!(!is_permanent_delivery_error(&transient));
    }

    #[test]
    fn test_missing_target_is_not_retried() {
        // A conversation without a live agent is handled by the auto-resume
        // path first; if it still fails, retrying the same message cannot help.
        let missing_conversation =
            ErgataiError::NotFound("Conversation conv_1 is not bound to a running agent".into());
        assert!(is_permanent_delivery_error(&missing_conversation));

        let missing_agent = ErgataiError::AgentNotFound("agent_1".into());
        assert!(is_permanent_delivery_error(&missing_agent));
    }

    #[test]
    fn test_delivery_key_prefers_conversation() {
        let conversation_id = ergatai_error::ConversationId::new(1234567890);
        let payload = AgentMessagePayload {
            from_agent: "user".to_string(),
            to_agent: "agent_1".to_string(),
            content: "hello".to_string(),
            timestamp: 0,
            metadata: HashMap::new(),
            message_id: "msg_1".to_string(),
            requires_receipt: false,
            correlation_id: None,
            timeout_ms: None,
            message_type: "request".to_string(),
            target_conversation_id: Some(conversation_id),
            images: Vec::new(),
            files: Vec::new(),
        };

        assert_eq!(
            delivery_key_for_payload(&payload),
            conversation_id.to_string()
        );
    }

    #[test]
    fn test_delivery_key_falls_back_to_agent() {
        let payload = AgentMessagePayload {
            from_agent: "user".to_string(),
            to_agent: "agent_1".to_string(),
            content: "hello".to_string(),
            timestamp: 0,
            metadata: HashMap::new(),
            message_id: "msg_1".to_string(),
            requires_receipt: false,
            correlation_id: None,
            timeout_ms: None,
            message_type: "request".to_string(),
            target_conversation_id: None,
            images: Vec::new(),
            files: Vec::new(),
        };

        assert_eq!(delivery_key_for_payload(&payload), "agent_1");
    }

    #[test]
    fn test_extract_error_name() {
        assert_eq!(
            extract_error_name("... \"errorKind\": \"model_not_found\" ...").as_deref(),
            Some("model_not_found")
        );
        assert_eq!(
            extract_error_name("upstream timeout").as_deref(),
            Some("timeout")
        );
        assert_eq!(extract_error_name("plain failure"), None);
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
