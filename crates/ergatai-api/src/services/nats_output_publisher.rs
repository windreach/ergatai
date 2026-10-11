//! NATS output publisher — publishes agent output events to NATS core pub/sub.
//!
//! This module implements the `OutputPublisher` trait from `ergatai-runtime`,
//! bridging agent output events to NATS for unified message routing.
//!
//! ## Unified SSE Architecture
//!
//! Agent output events are published to `ergatai.conversation.message.{conversation_id}`
//! (same subject as conversation messages) so that the frontend only needs to subscribe
//! to `/conversations/{id}/sse` for all events (user messages, agent messages, agent output).

use ergatai_error::ErgataiResult;
use ergatai_runtime::{AgentOutputEvent, OutputPublisher};
use tracing::debug;

/// NATS-based output publisher.
///
/// Publishes agent output events to:
/// - `ergatai.conversation.message.{conversation_id}` (unified SSE)
pub struct NatsOutputPublisher {
    nats_connection: ergatai_nats::NatsConnection,
}

impl NatsOutputPublisher {
    /// Create a new NATS output publisher.
    pub fn new(nats_connection: ergatai_nats::NatsConnection) -> Self {
        Self { nats_connection }
    }
}

impl OutputPublisher for NatsOutputPublisher {
    fn publish(&self, conversation_id: &str, event: AgentOutputEvent) -> ErgataiResult<()> {
        // Serialize event to JSON
        let json = serde_json::to_vec(&event)?;

        // Publish to conversation subject for unified SSE
        // This allows the frontend to subscribe to only `/conversations/{id}/sse`
        // to receive all events (user messages, agent messages, agent output).
        let conversation_subject = format!("ergatai.conversation.message.{}", conversation_id);
        let conversation_id_owned = conversation_id.to_string();
        let nats_conn = self.nats_connection.clone();
        tokio::spawn(async move {
            if let Err(e) = nats_conn.publish(&conversation_subject, json).await {
                tracing::warn!(
                    conversation_id = %conversation_id_owned,
                    subject = %conversation_subject,
                    error = %e,
                    "Failed to publish agent output to conversation subject"
                );
            } else {
                debug!(
                    conversation_id = %conversation_id_owned,
                    subject = %conversation_subject,
                    "Published agent output to conversation subject (unified SSE)"
                );
            }
        });

        Ok(())
    }
}
