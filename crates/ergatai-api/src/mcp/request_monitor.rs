//! Request Monitor - Track request/response patterns and detect timeouts
//!
//! Implements the reqwatch auto-monitoring system inspired by hcom.
//! When agent A sends a request to agent B, the monitor tracks it and
//! publishes a timeout event if no response is received within the deadline.

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::RwLock;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

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

/// Request monitor service
///
/// Tracks outgoing request messages and detects when they time out
/// without receiving a response.
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
    pub fn track_request(
        &self,
        message_id: String,
        from_agent: String,
        to_agent: String,
        correlation_id: String,
        timeout_ms: u64,
    ) {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_else(|e| {
                warn!(
                    error = %e,
                    "System time before UNIX epoch in track_request, using 0"
                );
                Duration::from_secs(0)
            })
            .as_secs();

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

        match self.pending.write() {
            Ok(mut pending) => {
                let was_duplicate = pending.contains_key(&correlation_id);
                pending.insert(correlation_id.clone(), request);
                if was_duplicate {
                    warn!(
                        correlation_id = %correlation_id,
                        "Overwriting existing pending request with same correlation_id"
                    );
                }
            }
            Err(e) => {
                warn!(
                    error = %e,
                    correlation_id = %correlation_id,
                    "Failed to acquire write lock on pending map, request not tracked"
                );
            }
        }
    }

    /// Mark a request as responded to
    ///
    /// Called when a response message is received with a matching correlation_id.
    /// Removes the request from the pending map and cleans up retry counts.
    pub fn mark_responded(&self, correlation_id: &str) {
        match self.pending.write() {
            Ok(mut pending) => {
                if pending.remove(correlation_id).is_some() {
                    // Clean up retry counts
                    if let Ok(mut retry_counts) = self.retry_counts.write() {
                        retry_counts.remove(correlation_id);
                    }
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
            Err(e) => {
                warn!(
                    error = %e,
                    correlation_id = %correlation_id,
                    "Failed to acquire write lock on pending map"
                );
            }
        }
    }

    /// Check if a correlation_id is still being tracked
    pub fn is_pending(&self, correlation_id: &str) -> bool {
        self.pending
            .read()
            .ok()
            .is_some_and(|pending| pending.contains_key(correlation_id))
    }

    /// Get the retry count for a correlation_id
    pub fn get_retry_count(&self, correlation_id: &str) -> u32 {
        self.retry_counts
            .read()
            .ok()
            .and_then(|counts| counts.get(correlation_id).copied())
            .unwrap_or(0)
    }

    /// Increment the retry count for a correlation_id
    pub fn increment_retry_count(&self, correlation_id: &str) {
        match self.retry_counts.write() {
            Ok(mut retry_counts) => {
                let count = retry_counts.entry(correlation_id.to_string()).or_insert(0);
                *count += 1;
            }
            Err(e) => {
                warn!(
                    error = %e,
                    correlation_id = %correlation_id,
                    "Failed to acquire write lock on retry_counts map"
                );
            }
        }
    }

    /// Check for timed-out requests and return them
    ///
    /// Scans the pending requests map and returns any that have exceeded
    /// their timeout. Does NOT remove them from the map (caller should
    /// decide whether to remove or retry).
    fn check_timeouts(&self) -> Vec<PendingRequest> {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_else(|e| {
                warn!(
                    error = %e,
                    "System time before UNIX epoch in check_timeouts, using 0"
                );
                Duration::from_secs(0)
            })
            .as_secs();

        let pending = match self.pending.read() {
            Ok(guard) => guard,
            Err(e) => {
                warn!(
                    error = %e,
                    "Failed to acquire read lock on pending map in check_timeouts"
                );
                return Vec::new();
            }
        };
        let mut timed_out = Vec::new();

        for request in pending.values() {
            let elapsed_ms = (now - request.sent_at) * 1000;
            if elapsed_ms >= request.timeout_ms {
                timed_out.push(request.clone());
            }
        }

        if !timed_out.is_empty() {
            warn!(
                count = timed_out.len(),
                "Found timed-out requests"
            );
        }

        timed_out
    }

    /// Remove timed-out requests from the pending map
    ///
    /// Called after timeout events have been published to clean up.
    /// Also removes associated retry counts.
    pub fn remove_timeouts(&self, correlation_ids: &[String]) {
        match (self.pending.write(), self.retry_counts.write()) {
            (Ok(mut pending), Ok(mut retry_counts)) => {
                for id in correlation_ids {
                    pending.remove(id);
                    retry_counts.remove(id);
                }
            }
            (Err(e), _) => {
                warn!(
                    error = %e,
                    "Failed to acquire write lock on pending map in remove_timeouts"
                );
            }
            (_, Err(e)) => {
                warn!(
                    error = %e,
                    "Failed to acquire write lock on retry_counts in remove_timeouts"
                );
            }
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

        let timed_out = monitor.check_timeouts();
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
            if !monitor.is_pending(&request.correlation_id) {
                debug!(
                    correlation_id = %request.correlation_id,
                    "Request already responded, skipping timeout publish"
                );
                continue;
            }

            // Track retry attempts per correlation_id
            let attempt_count = monitor.get_retry_count(&request.correlation_id);
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
                    monitor.increment_retry_count(&request.correlation_id);
                }
            }
        }

        // Remove successfully published or dropped requests from pending map
        monitor.remove_timeouts(&timeout_ids);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_track_and_respond() {
        let monitor = RequestMonitor::new();

        // Track a request
        monitor.track_request(
            "msg-1".to_string(),
            "agent-1".to_string(),
            "agent-2".to_string(),
            "corr-1".to_string(),
            30_000,
        );

        // Should have 1 pending
        assert_eq!(monitor.check_timeouts().len(), 0); // not timed out yet

        // Mark as responded
        monitor.mark_responded("corr-1");

        // Should have 0 pending now
        assert_eq!(monitor.check_timeouts().len(), 0);
    }

    #[test]
    fn test_timeout_detection() {
        let monitor = RequestMonitor::new();

        // Track a request with 0ms timeout (immediate timeout)
        monitor.track_request(
            "msg-1".to_string(),
            "agent-1".to_string(),
            "agent-2".to_string(),
            "corr-1".to_string(),
            0, // 0ms timeout = immediate
        );

        // Should detect timeout
        let timeouts = monitor.check_timeouts();
        assert_eq!(timeouts.len(), 1);
        assert_eq!(timeouts[0].correlation_id, "corr-1");
    }
}
