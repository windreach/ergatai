//! Activity feed API endpoints — SSE stream and REST recent events

use axum::{
    extract::{Query, State},
    response::{
        sse::{Event, Sse},
        IntoResponse,
    },
    Json,
};
use futures::stream::{self, Stream, StreamExt};
use serde::Deserialize;
use std::convert::Infallible;

use crate::api::activity::{get_activity_feed, ActivityEntry};
use crate::AppState;

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
pub async fn stream_events(
    State(_state): State<AppState>,
) -> Sse<impl Stream<Item = Result<Event, Infallible>>> {
    let feed = match get_activity_feed() {
        Some(feed) => feed,
        None => {
            // Return empty stream if feed not initialized
            let empty_stream: std::pin::Pin<
                Box<dyn Stream<Item = Result<Event, Infallible>> + Send>,
            > = Box::pin(stream::empty());
            return Sse::new(empty_stream).keep_alive(
                axum::response::sse::KeepAlive::new().interval(std::time::Duration::from_secs(15)),
            );
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

    Sse::new(combined).keep_alive(
        axum::response::sse::KeepAlive::new().interval(std::time::Duration::from_secs(15)),
    )
}
