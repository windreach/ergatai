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
//!
//! ## Ordering Guarantee
//!
//! Events for the same conversation are published in FIFO order using per-conversation
//! async locks. The locks use weak references to allow automatic cleanup when no tasks
//! are actively publishing, preventing memory leaks while maintaining ordering guarantees.

use dashmap::DashMap;
use ergatai_error::ErgataiResult;
use ergatai_runtime::{AgentOutputEvent, OutputPublisher};
use std::sync::{Arc, Weak};
use tokio::sync::Mutex;
use tracing::debug;

/// NATS-based output publisher.
///
/// Publishes agent output events to:
/// - `ergatai.conversation.message.{conversation_id}` (unified SSE)
///
/// Uses per-conversation weak-referenced locks to ensure events are published in order
/// while allowing automatic cleanup when no tasks are actively publishing.
pub struct NatsOutputPublisher {
    nats_connection: ergatai_nats::NatsConnection,
    /// Per-conversation async locks (weak-referenced for automatic cleanup)
    ///
    /// The Weak reference allows the lock to be automatically deallocated when
    /// all spawned tasks complete, preventing memory leaks. Cleanup only removes
    /// entries where strong_count == 0, ensuring ordering guarantees are maintained.
    publish_locks: Arc<DashMap<String, Weak<Mutex<()>>>>,
}

impl NatsOutputPublisher {
    /// Create a new NATS output publisher.
    pub fn new(nats_connection: ergatai_nats::NatsConnection) -> Self {
        Self {
            nats_connection,
            publish_locks: Arc::new(DashMap::new()),
        }
    }

    /// Clean up expired weak references to prevent memory growth.
    ///
    /// This is safe to call periodically - only removes entries where all tasks
    /// have completed (strong_count == 0). Active locks are never removed.
    pub fn cleanup_expired_locks(&self) {
        self.publish_locks.retain(|_, weak| weak.strong_count() > 0);
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

        // Acquire or create per-conversation lock to ensure FIFO ordering.
        // Uses weak references to allow automatic cleanup when no tasks are active.
        //
        // CRITICAL: Use entry() API for atomic check-and-insert to prevent TOCTOU race.
        // If we use get() followed by insert(), two threads could both see None and
        // create different locks, breaking ordering guarantees.
        let lock = {
            use dashmap::mapref::entry::Entry;

            match self.publish_locks.entry(conversation_id_owned.clone()) {
                Entry::Occupied(mut occupied) => {
                    // Lock exists, try to upgrade Weak reference
                    match occupied.get().upgrade() {
                        Some(arc_lock) => arc_lock,
                        None => {
                            // Weak expired, create new lock and update the entry
                            let new_lock = Arc::new(Mutex::new(()));
                            let weak = Arc::downgrade(&new_lock);
                            occupied.insert(weak);
                            new_lock
                        }
                    }
                }
                Entry::Vacant(vacant) => {
                    // No lock exists, create one and insert
                    let new_lock = Arc::new(Mutex::new(()));
                    let weak = Arc::downgrade(&new_lock);
                    vacant.insert(weak);
                    new_lock
                }
            }
        };

        tokio::spawn(async move {
            // Wait for previous publish to complete before starting this one
            let _guard = lock.lock().await;
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
            // Lock is released when _guard is dropped, allowing next publish to proceed.
            // When all tasks complete, strong_count reaches 0 and Weak reference expires,
            // enabling automatic cleanup.
        });

        Ok(())
    }
}
