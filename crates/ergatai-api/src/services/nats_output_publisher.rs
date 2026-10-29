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
use lru::LruCache;
use std::future::Future;
use std::num::NonZeroUsize;
use std::pin::Pin;
use std::sync::{Arc, Weak};
use tokio::sync::Mutex;
use tracing::debug;

/// Per-conversation state for ordering and deduplication.
struct ConversationState {
    /// Async lock for FIFO ordering
    lock: Weak<Mutex<()>>,
    /// LRU cache for deduplication (stores event fingerprints)
    /// Capacity: 1000 events per conversation (covers ~10 seconds of streaming at 100 events/sec)
    dedup_cache: LruCache<String, ()>,
}

/// NATS-based output publisher.
///
/// Publishes agent output events to:
/// - `ergatai.conversation.message.{conversation_id}` (unified SSE)
///
/// Uses per-conversation weak-referenced locks to ensure events are published in order
/// while allowing automatic cleanup when no tasks are actively publishing.
/// Also includes per-conversation LRU cache for automatic deduplication of events
/// with the same fingerprint (event_type + id), preventing duplicate events from
/// reaching NATS due to ACP protocol's at-least-once semantics or network retransmissions.
pub struct NatsOutputPublisher {
    nats_connection: ergatai_nats::NatsConnection,
    /// Per-conversation state (locks + dedup cache)
    /// Uses Weak reference for lock to allow automatic cleanup when no tasks are active.
    conversation_states: Arc<DashMap<String, ConversationState>>,
    /// Capacity for dedup cache per conversation
    dedup_cache_capacity: usize,
}

impl NatsOutputPublisher {
    /// Create a new NATS output publisher.
    pub fn new(nats_connection: ergatai_nats::NatsConnection) -> Self {
        Self::with_dedup_capacity(nats_connection, 1000)
    }

    /// Create a new NATS output publisher with custom dedup cache capacity.
    ///
    /// # Panics
    ///
    /// Panics if `capacity` is 0, as the LRU cache requires a positive size.
    pub fn with_dedup_capacity(
        nats_connection: ergatai_nats::NatsConnection,
        capacity: usize,
    ) -> Self {
        assert!(capacity > 0, "dedup cache capacity must be greater than 0");
        Self {
            nats_connection,
            conversation_states: Arc::new(DashMap::new()),
            dedup_cache_capacity: capacity,
        }
    }

    /// Clean up expired weak references to prevent memory growth.
    ///
    /// This is safe to call periodically - only removes entries where all tasks
    /// have completed (strong_count == 0). Active locks are never removed.
    pub fn cleanup_expired_locks(&self) {
        self.conversation_states.retain(|_, state| {
            // Keep if lock is still alive, or if dedup cache is non-empty
            state.lock.strong_count() > 0 || !state.dedup_cache.is_empty()
        });
    }

    /// Generate a fingerprint for an event for deduplication purposes.
    /// Returns None for events that should not be deduplicated (like Text, Thinking).
    fn event_fingerprint(event: &AgentOutputEvent) -> Option<String> {
        match event {
            AgentOutputEvent::ToolCallStart { id, .. } => Some(format!("tool_call_start:{}", id)),
            AgentOutputEvent::ToolCallInput { id, .. } => Some(format!("tool_call_input:{}", id)),
            AgentOutputEvent::ToolCallComplete { id, .. } => {
                Some(format!("tool_call_complete:{}", id))
            }
            AgentOutputEvent::ToolCallError { id, .. } => Some(format!("tool_call_error:{}", id)),
            // Text and Thinking events are not deduplicated (no stable ID)
            _ => None,
        }
    }
}

impl OutputPublisher for NatsOutputPublisher {
    fn publish(
        &self,
        conversation_id: &str,
        event: AgentOutputEvent,
    ) -> Pin<Box<dyn Future<Output = ErgataiResult<()>> + Send + '_>> {
        // Clone necessary values before entering async block to avoid borrowing &self
        let conversation_id_owned = conversation_id.to_string();
        let nats_conn = self.nats_connection.clone();
        let conversation_states = self.conversation_states.clone();
        let dedup_cache_capacity = self.dedup_cache_capacity;

        Box::pin(async move {
            // Deduplication check: skip if we've seen this exact event before.
            // This handles ACP protocol's at-least-once semantics or network retransmissions.
            let fingerprint = Self::event_fingerprint(&event);

            // Get or create conversation state atomically, and check/update dedup cache.
            // We must hold the state entry across both the dedup check and lock acquisition
            // to ensure atomicity.
            let lock = {
                let mut state_entry = conversation_states
                    .entry(conversation_id_owned.clone())
                    .or_insert_with(|| {
                        let new_lock = Arc::new(Mutex::new(()));
                        ConversationState {
                            lock: Arc::downgrade(&new_lock),
                            dedup_cache: LruCache::new(
                                NonZeroUsize::new(dedup_cache_capacity).unwrap(),
                            ),
                        }
                    });

                // Deduplication check (if this event type supports it)
                if let Some(ref fp) = fingerprint {
                    if state_entry.dedup_cache.contains(fp) {
                        debug!(
                            conversation_id = %conversation_id_owned,
                            fingerprint = %fp,
                            "Duplicate event detected and skipped (auto-dedup)"
                        );
                        return Ok(());
                    }
                    // Add fingerprint to cache
                    state_entry.dedup_cache.put(fp.clone(), ());
                }

                // Get or create the lock for FIFO ordering
                match state_entry.lock.upgrade() {
                    Some(arc_lock) => arc_lock,
                    None => {
                        // Weak expired, create new lock
                        let new_lock = Arc::new(Mutex::new(()));
                        state_entry.lock = Arc::downgrade(&new_lock);
                        new_lock
                    }
                }
            };

            // Serialize event to JSON
            let json = serde_json::to_vec(&event)?;

            // Publish to conversation subject for unified SSE
            // This allows the frontend to subscribe to only `/conversations/{id}/sse`
            // to receive all events (user messages, agent messages, agent output).
            let conversation_subject =
                format!("ergatai.conversation.message.{}", conversation_id_owned);

            tracing::info!(
                conversation_id = %conversation_id_owned,
                event_type = %std::any::type_name::<AgentOutputEvent>(),
                "Publishing agent output event to NATS"
            );

            // CRITICAL: Acquire lock permit BEFORE spawning the task to ensure FIFO ordering.
            // If we acquire the lock inside the spawned task, multiple tasks may race to
            // acquire the lock in arbitrary order, breaking the ordering guarantee.
            // By acquiring the permit here (in the calling async context), we ensure that permits
            // are granted in the order that publish() is called, maintaining FIFO order.
            //
            // Use lock_owned() to get an OwnedMutexGuard that doesn't borrow from the Arc,
            // allowing it to be moved into the spawned task.
            let permit = lock.lock_owned().await;

            tokio::spawn(async move {
                // Hold the permit for the duration of this task
                let _guard = permit;
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
        })
    }
}
