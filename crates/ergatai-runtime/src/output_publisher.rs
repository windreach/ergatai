//! Output publisher trait for agent output events.
//!
//! This trait abstracts the mechanism for publishing agent output events
//! (text, thinking, tool calls, etc.) to a message system. This allows
//! the runtime to be decoupled from the specific messaging infrastructure
//! (NATS, Kafka, Redis, etc.).

use crate::backends::acp::AgentOutputEvent;
use ergatai_error::ErgataiResult;
use std::sync::Arc;
use std::sync::OnceLock;

/// Global output publisher instance.
///
/// This is set once during initialization and used by all agents to publish
/// output events. The global instance allows the runtime to publish events
/// without requiring each agent to hold a reference to the publisher.
static GLOBAL_OUTPUT_PUBLISHER: OnceLock<Arc<dyn OutputPublisher>> = OnceLock::new();

/// Set the global output publisher.
///
/// This should be called once during application initialization, after the
/// messaging system (e.g., NATS) is available.
///
/// # Arguments
///
/// * `publisher` - The output publisher to use globally
///
/// # Returns
///
/// Returns `Ok(())` if the publisher was set successfully,
/// or `Err` if a publisher has already been set.
pub fn set_global_output_publisher(
    publisher: Arc<dyn OutputPublisher>,
) -> Result<(), Arc<dyn OutputPublisher>> {
    GLOBAL_OUTPUT_PUBLISHER.set(publisher)
}

/// Get the global output publisher, if set.
///
/// Returns `None` if the publisher has not been set yet.
pub fn get_global_output_publisher() -> Option<&'static Arc<dyn OutputPublisher>> {
    GLOBAL_OUTPUT_PUBLISHER.get()
}

/// Trait for publishing agent output events.
///
/// Implementations of this trait handle the actual publishing of events
/// to a message system. The runtime uses this trait to publish output
/// events without being coupled to a specific messaging system.
///
/// # Example
///
/// ```rust,ignore
/// use ergatai_runtime::output_publisher::OutputPublisher;
/// use ergatai_runtime::backends::acp::AgentOutputEvent;
///
/// struct NatsOutputPublisher {
///     nats_connection: NatsConnection,
/// }
///
/// impl OutputPublisher for NatsOutputPublisher {
///     fn publish(&self, conversation_id: &str, event: AgentOutputEvent) -> ErgataiResult<()> {
///         // Publish to NATS
///     }
/// }
/// ```
pub trait OutputPublisher: Send + Sync {
    /// Publish an agent output event.
    ///
    /// # Arguments
    ///
    /// * `conversation_id` - The conversation ID (conversation_id) of the agent that produced the output
    /// * `event` - The output event to publish
    ///
    /// # Returns
    ///
    /// Returns `Ok(())` if the event was published successfully,
    /// or `Err` if publishing failed.
    fn publish(&self, conversation_id: &str, event: AgentOutputEvent) -> ErgataiResult<()>;
}

/// A no-op output publisher that discards all events.
///
/// This is useful for testing or when output events are not needed.
pub struct NoOpOutputPublisher;

impl OutputPublisher for NoOpOutputPublisher {
    fn publish(&self, _conversation_id: &str, _event: AgentOutputEvent) -> ErgataiResult<()> {
        // Discard the event
        Ok(())
    }
}
