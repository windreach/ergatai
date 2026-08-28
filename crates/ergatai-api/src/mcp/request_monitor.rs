//! Request Monitor - Track request/response patterns and detect timeouts
//!
//! Implements the reqwatch auto-monitoring system.
//! When agent A sends a request to agent B, the monitor tracks it and
//! publishes a timeout event if no response is received within the deadline.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use tokio::sync::RwLock;
use tokio_util::sync::CancellationToken;
use tracing::{debug, info, warn};

use ergatai_nats::{EventBus, RequestTimeoutPayload};

/// Pending request being tracked
#[derive(Debug, Clone)]
struct PendingRequest {
    /// Unique message ID
    message_id: String,
    /// Agent that sent the request
    from_agent: String,
    /// Agent that should respond
    to_agent: String,
    /// Correlation ID linking request → response
    correlation_id: String,
    /// Timestamp when the request was sent (Unix epoch seconds)
    sent_at: u64,
    /// Timeout in milliseconds
    timeout_ms: u64,
}

/// Maximum number of pending requests to track
///
/// Prevents unbounded memory growth if responses never arrive.
/// When limit is reached, new requests are rejected with a warning.
const MAX_PENDING_REQUESTS: usize = 10_000;

/// Request monitor service
///
/// Tracks outgoing request messages and detects when they time out
/// without receiving a response.
///
/// **Lock ordering**: Always acquire `pending` before `retry_counts` to prevent deadlock.
/// This invariant must be maintained across all methods.
pub struct RequestMonitor {
    /// Pending requests indexed by correlation_id
    pending: Arc<RwLock<HashMap<String, PendingRequest>>>,
    /// Retry attempt counts indexed by correlation_id
    retry_counts: Arc<RwLock<HashMap<String, u32>>>,
}

impl RequestMonitor {
    /// Create a new request monitor
    pub fn new() -> Self {
        Self {
            pending: Arc::new(RwLock::new(HashMap::new())),
            retry_counts: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    /// Track a new request message
    ///
    /// Called when a request message is sent. The monitor will check for
    /// a matching response and publish a timeout event if none arrives.
    pub async fn track_request(
        &self,
        message_id: String,
        from_agent: String,
        to_agent: String,
        correlation_id: String,
        timeout_ms: u64,
    ) {
        // Use saturating_sub to handle clock skew: if now < sent_at, treat as 0 elapsed
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or_else(|e| {
                warn!(
                    error = %e,
                    "System time before UNIX epoch in track_request, using 0"
                );
                0
            });

        let request = PendingRequest {
            message_id,
            from_agent,
            to_agent,
            correlation_id: correlation_id.clone(),
            sent_at: now,
            timeout_ms,
        };

        debug!(
            correlation_id = %correlation_id,
            "Tracking new request"
        );

        let mut pending = self.pending.write().await;

        // Check if we've reached the maximum capacity
        if pending.len() >= MAX_PENDING_REQUESTS && !pending.contains_key(&correlation_id) {
            warn!(
                correlation_id = %correlation_id,
                pending_count = pending.len(),
                max_capacity = MAX_PENDING_REQUESTS,
                "Pending request map at capacity, rejecting new request tracking"
            );
            return;
        }

        let was_duplicate = pending.contains_key(&correlation_id);
        pending.insert(correlation_id.clone(), request);
        if was_duplicate {
            warn!(
                correlation_id = %correlation_id,
                "Overwriting existing pending request with same correlation_id"
            );
        }
    }

    /// Mark a request as responded to
    ///
    /// Called when a response message is received with a matching correlation_id.
    /// Removes the request from the pending map and cleans up retry counts.
    pub async fn mark_responded(&self, correlation_id: &str) {
        let mut pending = self.pending.write().await;
        if pending.remove(correlation_id).is_some() {
            // Clean up retry counts
            let mut retry_counts = self.retry_counts.write().await;
            retry_counts.remove(correlation_id);
            debug!(
                correlation_id = %correlation_id,
                "Request marked as responded"
            );
        } else {
            debug!(
                correlation_id = %correlation_id,
                "Response received for unknown or already-completed request"
            );
        }
    }

    /// Check if a correlation_id is still being tracked
    pub async fn is_pending(&self, correlation_id: &str) -> bool {
        let pending = self.pending.read().await;
        pending.contains_key(correlation_id)
    }

    /// Get the retry count for a correlation_id
    pub async fn get_retry_count(&self, correlation_id: &str) -> u32 {
        let retry_counts = self.retry_counts.read().await;
        retry_counts.get(correlation_id).copied().unwrap_or(0)
    }

    /// Increment the retry count for a correlation_id
    pub async fn increment_retry_count(&self, correlation_id: &str) {
        let mut retry_counts = self.retry_counts.write().await;
        let count = retry_counts.entry(correlation_id.to_string()).or_insert(0);
        *count += 1;
    }

    /// Check for timed-out requests and return them
    ///
    /// Scans the pending requests map and returns any that have exceeded
    /// their timeout. Does NOT remove them from the map (caller should
    /// decide whether to remove or retry).
    async fn check_timeouts(&self) -> Vec<PendingRequest> {
        // Use saturating_sub to handle clock skew: if now < sent_at, treat as 0 elapsed
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or_else(|e| {
                warn!(
                    error = %e,
                    "System time before UNIX epoch in check_timeouts, using 0"
                );
                0
            });

        let pending = self.pending.read().await;
        let mut timed_out = Vec::new();

        for request in pending.values() {
            // Use checked arithmetic to prevent overflow/underflow panics
            // If clock skew causes now < sent_at, or multiplication overflows, treat as not timed out
            let elapsed_ms = now
                .checked_sub(request.sent_at)
                .and_then(|secs| secs.checked_mul(1000))
                .unwrap_or(0);
            if elapsed_ms >= request.timeout_ms {
                timed_out.push(request.clone());
            }
        }

        if !timed_out.is_empty() {
            warn!(count = timed_out.len(), "Found timed-out requests");
        }

        timed_out
    }

    /// Remove timed-out requests from the pending map
    ///
    /// Called after timeout events have been published to clean up.
    /// Also removes associated retry counts.
    pub async fn remove_timeouts(&self, correlation_ids: &[String]) {
        let mut pending = self.pending.write().await;
        let mut retry_counts = self.retry_counts.write().await;
        for id in correlation_ids {
            pending.remove(id);
            retry_counts.remove(id);
        }
    }
}

impl Default for RequestMonitor {
    fn default() -> Self {
        Self::new()
    }
}

/// Spawn the request monitor background task
///
/// Periodically checks for timed-out requests and publishes timeout events.
/// Runs until the cancellation token is triggered (graceful shutdown).
pub async fn spawn_request_monitor(monitor: Arc<RequestMonitor>) {
    spawn_request_monitor_with_cancel(monitor, CancellationToken::new()).await;
}

/// Spawn the request monitor with a cancellation token for graceful shutdown
///
/// The monitor checks for timeouts every 5 seconds. Failed publishes are retried
/// up to `MAX_RETRY_ATTEMPTS` times before the request is dropped from tracking.
pub async fn spawn_request_monitor_with_cancel(
    monitor: Arc<RequestMonitor>,
    cancel: CancellationToken,
) {
    /// Maximum number of consecutive publish failures before dropping a timed-out request
    const MAX_RETRY_ATTEMPTS: u32 = 3;

    info!("Starting request monitor background task");

    loop {
        tokio::select! {
            _ = cancel.cancelled() => {
                info!("Request monitor shutting down");
                return;
            }
            _ = tokio::time::sleep(Duration::from_secs(5)) => {}
        }

        let timed_out = monitor.check_timeouts().await;
        if timed_out.is_empty() {
            continue;
        }

        // Get NATS connection
        let conn = match ergatai_nats::get_nats_connection().await {
            Some(c) => c,
            None => {
                warn!("NATS not initialized, cannot publish timeout events");
                continue;
            }
        };

        let bus = EventBus::new(conn);
        let mut timeout_ids = Vec::new();

        for request in timed_out {
            // Re-check: a response may have arrived between check_timeouts() and now,
            // removing this entry from pending. Skip to avoid spurious timeout events.
            if !monitor.is_pending(&request.correlation_id).await {
                debug!(
                    correlation_id = %request.correlation_id,
                    "Request already responded, skipping timeout publish"
                );
                continue;
            }

            // Track retry attempts per correlation_id
            let attempt_count = monitor.get_retry_count(&request.correlation_id).await;
            if attempt_count >= MAX_RETRY_ATTEMPTS {
                warn!(
                    correlation_id = %request.correlation_id,
                    attempts = attempt_count,
                    "Dropping timed-out request after max retry attempts"
                );
                timeout_ids.push(request.correlation_id);
                continue;
            }

            let payload = RequestTimeoutPayload {
                message_id: request.message_id.clone(),
                from_agent: request.from_agent.clone(),
                to_agent: request.to_agent.clone(),
                timeout_ms: request.timeout_ms,
                sent_at: request.sent_at,
            };

            match bus.publish_request_timeout(&payload).await {
                Ok(_) => {
                    debug!(
                        correlation_id = %request.correlation_id,
                        from = %request.from_agent,
                        to = %request.to_agent,
                        "Published request timeout event"
                    );
                    timeout_ids.push(request.correlation_id);
                }
                Err(e) => {
                    warn!(
                        correlation_id = %request.correlation_id,
                        error = %e,
                        attempt = attempt_count + 1,
                        max_attempts = MAX_RETRY_ATTEMPTS,
                        "Failed to publish request timeout event, will retry"
                    );
                    monitor.increment_retry_count(&request.correlation_id).await;
                }
            }
        }

        // Remove successfully published or dropped requests from pending map
        monitor.remove_timeouts(&timeout_ids).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_track_and_respond() {
        let monitor = RequestMonitor::new();

        // Track a request
        monitor
            .track_request(
                "msg-1".to_string(),
                "agent-1".to_string(),
                "agent-2".to_string(),
                "corr-1".to_string(),
                30_000,
            )
            .await;

        // Should have 1 pending
        assert_eq!(monitor.check_timeouts().await.len(), 0); // not timed out yet

        // Mark as responded
        monitor.mark_responded("corr-1").await;

        // Should have 0 pending now
        assert_eq!(monitor.check_timeouts().await.len(), 0);
    }

    #[tokio::test]
    async fn test_timeout_detection() {
        let monitor = RequestMonitor::new();

        // Track a request with 0ms timeout (immediate timeout)
        monitor
            .track_request(
                "msg-1".to_string(),
                "agent-1".to_string(),
                "agent-2".to_string(),
                "corr-1".to_string(),
                0, // 0ms timeout = immediate
            )
            .await;

        // Should detect timeout
        let timeouts = monitor.check_timeouts().await;
        assert_eq!(timeouts.len(), 1);
        assert_eq!(timeouts[0].correlation_id, "corr-1");
    }
}
