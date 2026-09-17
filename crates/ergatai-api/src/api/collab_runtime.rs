//! Implicit collaboration runtime API endpoints.

use axum::{
    http::StatusCode,
    response::{
        sse::{Event, Sse},
        IntoResponse,
    },
    Json,
};
use futures::stream::{self, Stream, StreamExt};
use serde::Deserialize;
use serde_json::Value;
use std::{convert::Infallible, pin::Pin, sync::Arc};

use crate::context::try_get_app_context;
use crate::services::collab_runtime::CollabRuntimeManager;

fn collaboration_runtime() -> Option<Arc<CollabRuntimeManager>> {
    try_get_app_context().and_then(|context| context.collab_runtime.clone())
}

#[derive(Debug, Deserialize)]
pub struct SubmitInteractionRequest {
    pub interaction: Value,
    #[serde(default)]
    pub collaboration_mode: Option<String>,
}

/// POST /api/v1/collab-runtime/interactions
pub async fn submit_interaction(
    Json(request): Json<SubmitInteractionRequest>,
) -> impl IntoResponse {
    let manager = match collaboration_runtime() {
        Some(manager) => manager,
        None => {
            return (
                StatusCode::SERVICE_UNAVAILABLE,
                Json(serde_json::json!({
                    "error": "Collaboration runtime is not enabled"
                })),
            )
        }
    };

    match manager
        .apply_interaction(request.interaction, request.collaboration_mode.as_deref())
        .await
    {
        Ok(result) => (StatusCode::OK, Json(result)),
        Err(error) => {
            tracing::error!(error = %error, "Failed to apply collaboration interaction");
            (
                StatusCode::BAD_GATEWAY,
                Json(serde_json::json!({
                    "error": "Collaboration runtime request failed"
                })),
            )
        }
    }
}

/// GET /api/v1/collab-runtime/stream
pub async fn stream_events() -> Sse<Pin<Box<dyn Stream<Item = Result<Event, Infallible>> + Send>>> {
    let manager = collaboration_runtime();
    let Some(manager) = manager else {
        return Sse::new(Box::pin(stream::empty()));
    };

    let recent = manager.recent_events(50).await;
    let recent_events = recent
        .into_iter()
        .filter_map(|event| {
            serde_json::to_string(&event)
                .ok()
                .map(|json| Ok(Event::default().data(json)))
        })
        .collect::<Vec<_>>();

    let receiver = manager.subscribe();
    let live_events = stream::unfold(receiver, |mut receiver| async move {
        loop {
            match receiver.recv().await {
                Ok(event) => {
                    let json = serde_json::to_string(&event).ok()?;
                    return Some((Ok(Event::default().data(json)), receiver));
                }
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                Err(tokio::sync::broadcast::error::RecvError::Closed) => return None,
            }
        }
    });

    Sse::new(Box::pin(stream::iter(recent_events).chain(live_events))
        as Pin<Box<dyn Stream<Item = Result<Event, Infallible>> + Send>>)
}
