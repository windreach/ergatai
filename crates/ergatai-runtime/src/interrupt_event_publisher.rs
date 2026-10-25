//! Interrupt event publisher for agent interrupt events.
//!
//! This trait abstracts the mechanism for publishing agent interrupt events
//! (message inserted at safe point) to a message system. This allows
//! the runtime to be decoupled from the specific messaging infrastructure
//! (NATS, Kafka, Redis, etc.).

use ergatai_error::ErgataiResult;
use std::sync::Arc;
use std::sync::OnceLock;

/// Global interrupt event publisher instance.
///
/// This is set once during initialization and used by all agents to publish
/// interrupt events. The global instance allows the runtime to publish events
/// without requiring each agent to hold a reference to the publisher.
static GLOBAL_INTERRUPT_EVENT_PUBLISHER: OnceLock<Arc<dyn InterruptEventPublisher>> =
    OnceLock::new();

/// Set the global interrupt event publisher.
///
/// This should be called once during application initialization, after the
/// messaging system (e.g., NATS) is available.
///
/// # Arguments
///
/// * `publisher` - The interrupt event publisher to use globally
///
/// # Returns
///
/// Returns `Ok(())` if the publisher was set successfully,
/// or `Err` if a publisher has already been set.
pub fn set_global_interrupt_event_publisher(
    publisher: Arc<dyn InterruptEventPublisher>,
) -> Result<(), Arc<dyn InterruptEventPublisher>> {
    GLOBAL_INTERRUPT_EVENT_PUBLISHER.set(publisher)
}

/// Get the global interrupt event publisher, if set.
///
/// Returns `None` if the interrupt event publisher has not been set yet.
pub fn get_global_interrupt_event_publisher() -> Option<&'static Arc<dyn InterruptEventPublisher>> {
    GLOBAL_INTERRUPT_EVENT_PUBLISHER.get()
}

/// Payload for agent message inserted event.
///
/// This is published when an interrupt message is actually inserted at a safe point.
#[derive(Debug, Clone)]
pub struct AgentMessageInsertedPayload {
    /// Agent ID that processed the interrupt
    pub agent_id: String,
    /// Message ID of the inserted message
    pub message_id: String,
    /// Timestamp when the message was inserted (Unix epoch seconds)
    pub inserted_at: u64,
    /// Conversation ID (if applicable)
    pub conversation_id: Option<String>,
    /// Client request ID (for frontend queue matching)
    pub client_request_id: Option<String>,
}

/// Trait for publishing agent interrupt events.
///
/// Implementations of this trait handle the actual publishing of events
/// to a message system. The runtime uses this trait to publish events
/// without being coupled to a specific messaging system.
///
/// # Example
///
/// ```rust,ignore
/// use ergatai_runtime::interrupt_event_publisher::InterruptEventPublisher;
/// use ergatai_runtime::interrupt_event_publisher::AgentMessageInsertedPayload;
///
/// struct NatsInterruptEventPublisher {
///     nats_connection: NatsConnection,
/// }
///
/// impl InterruptEventPublisher for NatsInterruptEventPublisher {
///     fn publish_message_inserted(&self, payload: AgentMessageInsertedPayload) -> ErgataiResult<()> {
///         // Publish to NATS
///     }
/// }
/// ```
pub trait InterruptEventPublisher: Send + Sync {
    /// Publish an agent message inserted event.
    ///
    /// # Arguments
    ///
    /// * `payload` - The event payload to publish
    ///
    /// # Returns
    ///
    /// Returns `Ok(())` if the event was published successfully,
    /// or `Err` if publishing failed.
    fn publish_message_inserted(&self, payload: AgentMessageInsertedPayload) -> ErgataiResult<()>;
}

/// A no-op interrupt event publisher that discards all events.
///
/// This is useful for testing or when interrupt events are not needed.
pub struct NoOpInterruptEventPublisher;

impl InterruptEventPublisher for NoOpInterruptEventPublisher {
    fn publish_message_inserted(&self, _payload: AgentMessageInsertedPayload) -> ErgataiResult<()> {
        // Discard the event
        Ok(())
    }
}
