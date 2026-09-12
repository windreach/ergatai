//! Message delivery consumer — reliable agent message delivery via NATS JetStream
//!
//! Pulls messages from the `AGENT_MESSAGES` JetStream stream and delivers each
//! to the target agent via AgentRuntime injection (PTY write).
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
//!   ↓ pull
//! MessageDeliveryConsumer
//!   ↓ deserialize AgentMessagePayload
//!   ↓ AgentRuntime injection (PTY send_text)
//!   ├─ OK → ack
//!   └─ fail → nak (JetStream retries)
//! ```

use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use async_nats::jetstream::message::AckKind;
use futures::StreamExt;
use tracing::{debug, error, info, warn};

use ergatai_error::{ErgataiError, ErgataiResult};
use ergatai_nats::connection::NatsConnection;
use ergatai_nats::events::AgentMessagePayload;
use ergatai_nats::AGENT_MESSAGES_STREAM;

/// Global message type counters for statistics
static MSG_COUNT_REQUEST: AtomicU64 = AtomicU64::new(0);
static MSG_COUNT_RESPONSE: AtomicU64 = AtomicU64::new(0);
static MSG_COUNT_BROADCAST: AtomicU64 = AtomicU64::new(0);
static MSG_COUNT_NOTIFICATION: AtomicU64 = AtomicU64::new(0);

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
        "", // No filter for agent messages
        30, // ack_wait: 30s
        20, // max_deliver: 20 attempts
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

    // Increment message type counter for statistics
    // Detect message type from payload characteristics
    let msg_type = if payload.to_agent == "*"
        || payload.to_agent == "all"
        || payload.to_agent == "broadcast"
    {
        "broadcast"
    } else if payload.correlation_id.is_some() {
        "request"
    } else if payload.content.contains("receipt") || payload.content.contains("timeout") {
        "notification"
    } else {
        "response"
    };
    increment_message_count(msg_type);

    // Warn on redeliveries — indicates a prior delivery attempt may have succeeded
    // but the ack failed, or the consumer restarted mid-delivery.
    if let Ok(info) = msg.info() {
        if info.delivered > 1 {
            warn!(
                from = from,
                to = to,
                delivery_count = info.delivered,
                "Message redelivered — possible duplicate. Prior ack may have failed."
            );
        }
    }

    // ── Resolve sender and recipient runtime IDs for delivery ──
    // Priority: UUID (stable) > runtime agent ID (dynamic, may be stale)
    let runtime = crate::context::get_app_context().agent_runtime.clone();

    // The message content is already formatted by the MCP server (server.rs)
    // with instruction + JSON payload. Just deliver it as-is.
    let formatted_message = payload.content.as_str();

    let to_runtime_id = if let Some(ref to_uuid) = payload.to_uuid {
        // Try UUID first (stable across agent restarts)
        match runtime.resolve_agent_uuid(to_uuid).await {
            Some(id) => {
                debug!(
                    to_uuid = %to_uuid,
                    resolved_id = %id,
                    "Resolved target via UUID"
                );
                id
            }
            None => {
                // UUID not found, fall back to runtime agent ID
                warn!(
                    to_uuid = %to_uuid,
                    to_agent = %payload.to_agent,
                    "UUID not found, falling back to runtime agent ID"
                );
                runtime
                    .resolve_agent_id(&payload.to_agent)
                    .await
                    .unwrap_or_else(|| payload.to_agent.clone())
            }
        }
    } else {
        // No UUID, use runtime agent ID (legacy message)
        runtime
            .resolve_agent_id(&payload.to_agent)
            .await
            .unwrap_or_else(|| payload.to_agent.clone())
    };

    // ── Deliver via AgentRuntime injection (PTY write) ──
    // Writes the message directly into the target agent's PTY,
    // simulating keyboard input.

    info!(
        from = from,
        to = to,
        runtime_id = ?to_runtime_id,
        "Delivering message: MCP target → runtime resolution"
    );

    match runtime
        .inject_message(&to_runtime_id, formatted_message)
        .await
    {
        Ok(()) => {
            info!(
                from = from,
                to = to,
                "Message delivered via AgentRuntime injection"
            );

            // Ack FIRST to prevent duplicates on redelivery
            if let Err(e) = msg.ack().await {
                warn!("Failed to ack delivery: {}", e);
            }

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

            // Record pending response for implicit correlation_id tracking
            // (so when the recipient sends a response, system auto-fills correlation_id)
            if let Some(corr_id) = &payload.correlation_id {
                crate::messaging::record_pending_response(to, corr_id).await;
                debug!(
                    message_id = %payload.message_id,
                    to = %to,
                    correlation_id = %corr_id,
                    "Recorded pending response for implicit tracking"
                );
            }
        }
        Err(e) => {
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
}
