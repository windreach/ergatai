//! NATS interrupt event publisher — publishes agent interrupt events to NATS core pub/sub.
//!
//! This module implements the `InterruptEventPublisher` trait from `ergatai-runtime`,
//! bridging agent interrupt events to NATS for real-time frontend notifications.
//!
//! ## Events
//!
//! - `AgentMessageInserted`: Published when an interrupt message is actually inserted at a safe point
//!   - Subject: `ergatai.agent.message_inserted.{agent_id}`
//!   - Frontend uses this to remove the message from the queue

use ergatai_error::{AgentId, ConversationId, ErgataiResult};
use ergatai_runtime::interrupt_event_publisher::{
    AgentMessageInsertedPayload, InterruptEventPublisher,
};
/// NATS-based interrupt event publisher.
///
/// Publishes agent interrupt events to:
/// - `ergatai.agent.message_inserted.{agent_id}` (message inserted at safe point)
pub struct NatsInterruptEventPublisher {
    nats_connection: ergatai_nats::NatsConnection,
}

impl NatsInterruptEventPublisher {
    /// Create a new NATS interrupt event publisher.
    pub fn new(nats_connection: ergatai_nats::NatsConnection) -> Self {
        Self { nats_connection }
    }
}

impl InterruptEventPublisher for NatsInterruptEventPublisher {
    fn publish_message_inserted(&self, payload: AgentMessageInsertedPayload) -> ErgataiResult<()> {
        // Convert payload to NATS event type
        // agent_id may be in snowflake format (agent_ts_inst_seq) or workspace format (ws1-agent-N).
        // Use parse_to_i64 for snowflake IDs; fall back to sentinel AgentId(0) for other formats.
        let agent_id = match ergatai_error::id::parse_to_i64(&payload.agent_id) {
            Some(id) => AgentId::new(id),
            None => {
                tracing::warn!(
                    agent_id = %payload.agent_id,
                    "Failed to parse agent_id for message_inserted event; using sentinel AgentId(0)"
                );
                AgentId::new(0)
            }
        };

        let conversation_id =
            payload
                .conversation_id
                .as_deref()
                .and_then(|id| match ConversationId::decode(id) {
                    Ok(cid) => Some(cid),
                    Err(e) => {
                        tracing::warn!(
                            conversation_id = %id,
                            error = %e,
                            "Failed to decode conversation_id for message_inserted event"
                        );
                        None
                    }
                });

        let event = ergatai_nats::events::AgentMessageInserted {
            agent_id,
            message_id: payload.message_id,
            inserted_at: payload.inserted_at,
            conversation_id,
            client_request_id: payload.client_request_id,
        };

        // Spawn an async task to publish to NATS instead of blocking
        // This avoids deadlocks from calling async code in a sync context
        let nats_connection = self.nats_connection.clone();
        tokio::spawn(async move {
            let bus = ergatai_nats::EventBus::new(nats_connection);
            if let Err(e) = bus.publish_message_inserted_event(&event).await {
                tracing::warn!(
                    agent_id = %event.agent_id,
                    message_id = %event.message_id,
                    error = %e,
                    "Failed to publish message_inserted event"
                );
            } else {
                tracing::debug!(
                    agent_id = %event.agent_id,
                    message_id = %event.message_id,
                    "Published AgentMessageInserted event"
                );
            }
        });

        Ok(())
    }
}
