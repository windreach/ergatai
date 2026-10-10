//! Conversation SSE stream — real-time message streaming per conversation

use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    response::{
        sse::{Event, KeepAlive, Sse},
        IntoResponse,
    },
    Json,
};
use futures::stream::{self, Stream, StreamExt};
use serde::Deserialize;
use std::convert::Infallible;
use std::sync::atomic::{AtomicUsize, Ordering};

use crate::AppState;

// ── SSE connection limiter ─────────────────────────────────────────────
//
// SECURITY: Cap the number of concurrent conversation SSE connections to prevent
// resource exhaustion. Default: 100 concurrent connections. Override with
// ERGATAI_MAX_CONVERSATION_SSE_CONNECTIONS.

static CONVERSATION_SSE_CONNECTION_COUNT: AtomicUsize = AtomicUsize::new(0);

fn max_conversation_sse_connections() -> usize {
    std::env::var("ERGATAI_MAX_CONVERSATION_SSE_CONNECTIONS")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(100)
}

/// RAII guard that decrements the SSE connection count on drop.
struct ConversationSseConnectionGuard;

impl Drop for ConversationSseConnectionGuard {
    fn drop(&mut self) {
        let prev = CONVERSATION_SSE_CONNECTION_COUNT.fetch_sub(1, Ordering::SeqCst);
        // Use saturating_sub to prevent underflow panic in case of bugs
        tracing::debug!(
            remaining = prev.saturating_sub(1),
            "Conversation SSE connection closed"
        );
    }
}

/// Query parameters for conversation SSE endpoint
#[derive(Debug, Deserialize)]
pub struct ConversationSseQuery {
    /// Replay messages after this sequence number (exclusive)
    #[serde(default)]
    pub after_sequence: Option<i64>,
}

/// GET /api/v1/conversations/{id}/sse — SSE stream of conversation messages
///
/// On connect:
/// 1. Query SQLite for messages with sequence > after_sequence
/// 2. Send them as initial SSE events
/// 3. Subscribe to NATS `ergatai.conversation.message.{conversation_id}`
/// 4. Stream new messages as they arrive
/// 5. Send keep-alive every 15s
///
/// SECURITY: Rejects with 503 when the connection cap is reached.
pub async fn stream_conversation_messages(
    State(_state): State<AppState>,
    Path(conversation_id): Path<String>,
    Query(params): Query<ConversationSseQuery>,
) -> impl IntoResponse {
    // Enforce SSE connection cap
    let max = max_conversation_sse_connections();
    loop {
        let current = CONVERSATION_SSE_CONNECTION_COUNT.load(Ordering::SeqCst);
        if current >= max {
            return (
                StatusCode::SERVICE_UNAVAILABLE,
                Json(serde_json::json!({
                    "error": format!(
                        "Conversation SSE connection limit reached ({}/{}). Close an existing connection or raise ERGATAI_MAX_CONVERSATION_SSE_CONNECTIONS.",
                        current, max
                    )
                })),
            )
                .into_response();
        }
        match CONVERSATION_SSE_CONNECTION_COUNT.compare_exchange_weak(
            current,
            current + 1,
            Ordering::SeqCst,
            Ordering::SeqCst,
        ) {
            Ok(_) => {
                tracing::debug!(
                    active = current + 1,
                    max = max,
                    conversation_id = %conversation_id,
                    "Conversation SSE connection opened"
                );
                break;
            }
            Err(_) => {
                // Yield to prevent CPU spin loop under high contention
                tokio::task::yield_now().await;
                continue;
            }
        }
    }

    let _guard = ConversationSseConnectionGuard;

    // Verify conversation exists
    let conv_id_for_check = conversation_id.clone();
    let conversation_exists = match tokio::task::spawn_blocking(move || {
        crate::user_data_db::conversations::get(&conv_id_for_check)
    })
    .await
    {
        Ok(Ok(Some(_))) => true,
        Ok(Ok(None)) => false,
        Ok(Err(e)) => {
            tracing::warn!(
                conversation_id = %conversation_id,
                error = %e,
                "Failed to check conversation existence"
            );
            false
        }
        Err(e) => {
            tracing::warn!(
                conversation_id = %conversation_id,
                error = %e,
                "Failed to check conversation existence (task join error)"
            );
            false
        }
    };

    if !conversation_exists {
        return (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({
                "error": format!("Conversation {} not found", conversation_id)
            })),
        )
            .into_response();
    }

    // Step 1: Query SQLite for historical messages
    let after_sequence = params.after_sequence.unwrap_or(0);
    let conv_id_for_query = conversation_id.clone();
    let historical_messages = match tokio::task::spawn_blocking(move || {
        crate::user_data_db::messages::list_after_sequence(&conv_id_for_query, after_sequence)
    })
    .await
    {
        Ok(Ok(messages)) => messages,
        Ok(Err(e)) => {
            tracing::warn!(
                conversation_id = %conversation_id,
                error = %e,
                "Failed to query historical messages"
            );
            Vec::new()
        }
        Err(e) => {
            tracing::warn!(
                conversation_id = %conversation_id,
                error = %e,
                "Failed to query historical messages (task join error)"
            );
            Vec::new()
        }
    };

    // Convert historical messages to SSE events
    let historical_events: Vec<Result<Event, Infallible>> = historical_messages
        .into_iter()
        .filter_map(|msg| {
            let parts: serde_json::Value = serde_json::from_str(&msg.parts).unwrap_or_default();
            let metadata: serde_json::Value = msg
                .metadata
                .as_deref()
                .and_then(|m| serde_json::from_str(m).ok())
                .unwrap_or_default();

            // Extract content from parts using shared utility
            let content = crate::messaging::extract_text_from_parts(&msg.parts);

            // Clone IDs for error logging before moving into payload
            let msg_id_for_log = msg.id.clone();
            let conv_id_for_log = msg.conversation_id.clone();

            let payload = ergatai_nats::ConversationMessagePayload {
                conversation_id: msg.conversation_id,
                message_id: msg.id,
                role: msg.role,
                content,
                parts: Some(parts),
                metadata: Some(metadata),
                timestamp: msg.created_at as u64,
                sequence: msg.sequence,
                sender_agent_id: None,
                sender_agent_name: None,
            };

            match serde_json::to_string(&payload) {
                Ok(json) => Some(Ok(Event::default().data(json))),
                Err(e) => {
                    tracing::warn!(
                        message_id = %msg_id_for_log,
                        conversation_id = %conv_id_for_log,
                        error = %e,
                        "Failed to serialize historical message for SSE (skipping)"
                    );
                    None
                }
            }
        })
        .collect();

    // Step 2: Subscribe to NATS for new messages
    let nats_subscription = if let Some(conn) =
        crate::context::try_get_app_context().and_then(|ctx| ctx.nats_connection.clone())
    {
        let bus = ergatai_nats::EventBus::new(conn);
        match bus.subscribe_conversation_message(&conversation_id).await {
            Ok(sub) => Some(sub),
            Err(e) => {
                tracing::warn!(
                    conversation_id = %conversation_id,
                    error = %e,
                    "Failed to subscribe to conversation subject"
                );
                None
            }
        }
    } else {
        None
    };

    // Step 3: Create stream for new messages
    let new_messages_stream = if let Some(sub) = nats_subscription {
        let stream = stream::unfold(sub, |mut subscriber| async move {
            loop {
                match subscriber.next().await {
                    Some(msg) => {
                        match serde_json::from_slice::<ergatai_nats::ConversationMessagePayload>(
                            &msg.payload,
                        ) {
                            Ok(payload) => {
                                if let Ok(json) = serde_json::to_string(&payload) {
                                    return Some((Ok(Event::default().data(json)), subscriber));
                                }
                            }
                            Err(e) => {
                                tracing::warn!(
                                    error = %e,
                                    "Failed to deserialize conversation message"
                                );
                            }
                        }
                    }
                    None => {
                        // Stream closed
                        return None;
                    }
                }
            }
        });
        Box::pin(stream) as std::pin::Pin<Box<dyn Stream<Item = Result<Event, Infallible>> + Send>>
    } else {
        // No NATS subscription — return empty stream (historical only)
        Box::pin(stream::empty())
            as std::pin::Pin<Box<dyn Stream<Item = Result<Event, Infallible>> + Send>>
    };

    // Step 4: Combine historical + new messages
    let combined: std::pin::Pin<Box<dyn Stream<Item = Result<Event, Infallible>> + Send>> =
        Box::pin(stream::iter(historical_events).chain(new_messages_stream));

    // Use configurable keep-alive interval (default: 15s)
    let keep_alive_secs = std::env::var("ERGATAI_SSE_KEEP_ALIVE")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(15);

    Sse::new(combined)
        .keep_alive(KeepAlive::new().interval(std::time::Duration::from_secs(keep_alive_secs)))
        .into_response()
}
