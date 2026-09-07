//! Activity feed API endpoints — SSE stream and REST recent events

use axum::{
    extract::{Query, State},
    http::StatusCode,
    response::{
        sse::{Event, Sse},
        IntoResponse,
    },
    Json,
};
use futures::stream::{self, Stream, StreamExt};
use serde::Deserialize;
use std::convert::Infallible;
use std::sync::atomic::{AtomicUsize, Ordering};

use crate::api::activity::{get_activity_feed, ActivityEntry};
use crate::AppState;

// ── SSE connection limiter ─────────────────────────────────────────────
//
// SECURITY (P1 #15): Cap the number of concurrent SSE connections to prevent
// a single client (or a fleet of them) from exhausting file descriptors and
// broadcast subscribers. Default: 100 concurrent connections. Override with
// ERGATAI_MAX_SSE_CONNECTIONS.

static SSE_CONNECTION_COUNT: AtomicUsize = AtomicUsize::new(0);

fn max_sse_connections() -> usize {
    std::env::var("ERGATAI_MAX_SSE_CONNECTIONS")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(100)
}

/// RAII guard that decrements the SSE connection count on drop.
struct SseConnectionGuard;

impl Drop for SseConnectionGuard {
    fn drop(&mut self) {
        let prev = SSE_CONNECTION_COUNT.fetch_sub(1, Ordering::SeqCst);
        tracing::debug!(remaining = prev - 1, "SSE connection closed");
    }
}

/// Query parameters for recent events endpoint
#[derive(Debug, Deserialize)]
pub struct RecentQuery {
    #[serde(default = "default_limit")]
    pub limit: usize,
}

fn default_limit() -> usize {
    50
}

/// GET /api/v1/activity/recent — get recent activity events
pub async fn get_recent_events(
    State(_state): State<AppState>,
    Query(params): Query<RecentQuery>,
) -> impl IntoResponse {
    let feed = match get_activity_feed() {
        Some(feed) => feed,
        None => {
            return Json(Vec::<ActivityEntry>::new()).into_response();
        }
    };

    let events = feed.recent(params.limit).await;
    Json(events).into_response()
}

/// GET /api/v1/activity/stream — SSE stream of activity events
///
/// SECURITY (P1 #15): Rejects with 503 when the connection cap
/// (`ERGATAI_MAX_SSE_CONNECTIONS`, default 100) is reached. Each accepted
/// connection increments an atomic counter that is decremented when the
/// client disconnects (via the RAII [`SseConnectionGuard`]).
pub async fn stream_events(
    State(_state): State<AppState>,
) -> impl IntoResponse {
    // Enforce SSE connection cap with a CAS loop to avoid the TOCTOU race
    // inherent in fetch_add + check + fetch_sub: under contention, N concurrent
    // callers can all succeed fetch_add and then roll back, briefly admitting
    // more than `max` connections. compare_exchange is strictly atomic.
    let max = max_sse_connections();
    loop {
        let current = SSE_CONNECTION_COUNT.load(Ordering::SeqCst);
        if current >= max {
            return (
                StatusCode::SERVICE_UNAVAILABLE,
                Json(serde_json::json!({
                    "error": format!(
                        "SSE connection limit reached ({}/{}). Close an existing connection or raise ERGATAI_MAX_SSE_CONNECTIONS.",
                        current, max
                    )
                })),
            )
                .into_response();
        }
        match SSE_CONNECTION_COUNT.compare_exchange_weak(
            current,
            current + 1,
            Ordering::SeqCst,
            Ordering::SeqCst,
        ) {
            Ok(_) => {
                tracing::debug!(active = current + 1, max = max, "SSE connection opened");
                break;
            }
            Err(_) => {
                // Lost the race — yield a spin-loop hint to the CPU (reduces
                // power/scheduling pressure under extreme contention), then
                // reload and try again.
                std::hint::spin_loop();
                continue;
            }
        }
    }

    // Guard will decrement the counter when this response is dropped
    // (client disconnects, server shutdown, stream error, etc.).
    let _guard = SseConnectionGuard;

    let feed = match get_activity_feed() {
        Some(feed) => feed,
        None => {
            // Return empty stream if feed not initialized
            let empty_stream: std::pin::Pin<
                Box<dyn Stream<Item = Result<Event, Infallible>> + Send>,
            > = Box::pin(stream::empty());
            return Sse::new(empty_stream)
                .keep_alive(
                    axum::response::sse::KeepAlive::new()
                        .interval(std::time::Duration::from_secs(15)),
                )
                .into_response();
        }
    };

    let receiver = feed.subscribe();

    // Get recent events first
    let recent = feed.recent(50).await;
    let recent_events: Vec<Result<Event, Infallible>> = recent
        .into_iter()
        .rev()
        .filter_map(|entry| {
            serde_json::to_string(&entry)
                .ok()
                .map(|json| Ok(Event::default().data(json)))
        })
        .collect();

    // Create a stream for new events
    let new_events_stream = stream::unfold(receiver, |mut rx| async move {
        loop {
            match rx.recv().await {
                Ok(entry) => {
                    if let Ok(json) = serde_json::to_string(&entry) {
                        return Some((Ok(Event::default().data(json)), rx));
                    }
                }
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                    continue;
                }
                Err(tokio::sync::broadcast::error::RecvError::Closed) => {
                    return None;
                }
            }
        }
    });

    let combined: std::pin::Pin<Box<dyn Stream<Item = Result<Event, Infallible>> + Send>> =
        Box::pin(stream::iter(recent_events).chain(new_events_stream));

    Sse::new(combined)
        .keep_alive(
            axum::response::sse::KeepAlive::new()
                .interval(std::time::Duration::from_secs(15)),
        )
        .into_response()
}
