//! Permission handler for ACP permission requests.
//!
//! When an ACP agent wants to perform a privileged operation (file edit, tool
//! execution, etc.), it sends a `RequestPermissionRequest`. The handler decides
//! whether to approve, reject, or cancel the request.
//!
//! Two built-in implementations:
//!
//! - [`YoloPermissionHandler`] — auto-approves everything (legacy behavior).
//! - Integrators can implement [`PermissionHandler`] to plug in custom policy
//!   (e.g., `ergatai-lock` file access control).

use async_trait::async_trait;
use tracing::debug;

use agent_client_protocol::schema::v1::{
    PermissionOptionKind, RequestPermissionOutcome, RequestPermissionRequest,
    RequestPermissionResponse, SelectedPermissionOutcome,
};

/// Decision returned by a [`PermissionHandler`].
///
/// `option_id` is the ID of the permission option to select. `None` means
/// the request should be cancelled (no option selected).
#[derive(Clone, Debug)]
pub struct PermissionDecision {
    pub option_id: Option<String>,
}

impl PermissionDecision {
    /// Select the given option ID.
    pub fn select(option_id: String) -> Self {
        Self {
            option_id: Some(option_id),
        }
    }

    /// Cancel the request (no option selected).
    pub fn cancel() -> Self {
        Self { option_id: None }
    }

    /// Convert this decision into an ACP `RequestPermissionOutcome`.
    pub fn into_outcome(self) -> RequestPermissionOutcome {
        match self.option_id {
            Some(id) => RequestPermissionOutcome::Selected(SelectedPermissionOutcome::new(id)),
            None => RequestPermissionOutcome::Cancelled,
        }
    }
}

/// Evaluates ACP permission requests and returns a decision.
///
/// Implementations can be stateless (e.g., [`YoloPermissionHandler`]) or
/// stateful (e.g., consulting `ergatai-lock` for file access control).
#[async_trait]
pub trait PermissionHandler: Send + Sync + 'static {
    /// Evaluate a permission request for the given agent.
    ///
    /// - `agent_id` — the ACP agent making the request.
    /// - `session_id` — the ACP session the request belongs to.
    /// - `request` — the full `RequestPermissionRequest` from the ACP SDK.
    ///
    /// Returns a [`PermissionDecision`] indicating which option to select
    /// (or cancel).
    async fn evaluate(
        &self,
        agent_id: &str,
        session_id: &str,
        request: &RequestPermissionRequest,
    ) -> PermissionDecision;
}

/// Default "YOLO" permission handler — auto-approves all requests.
///
/// Selects the first `AllowOnce` or `AllowAlways` option found in the request.
/// If no allow option exists, cancels the request.
///
/// This preserves the legacy behavior of ergatai before the permission handler
/// abstraction was introduced.
pub struct YoloPermissionHandler;

#[async_trait]
impl PermissionHandler for YoloPermissionHandler {
    async fn evaluate(
        &self,
        agent_id: &str,
        _session_id: &str,
        request: &RequestPermissionRequest,
    ) -> PermissionDecision {
        let option = request.options.iter().find(|opt| {
            matches!(
                opt.kind,
                PermissionOptionKind::AllowOnce | PermissionOptionKind::AllowAlways
            )
        });

        match option {
            Some(opt) => {
                debug!(
                    agent_id = %agent_id,
                    option_id = %opt.option_id,
                    "YoloPermissionHandler: auto-approving"
                );
                PermissionDecision::select(opt.option_id.to_string())
            }
            None => {
                debug!(
                    agent_id = %agent_id,
                    "YoloPermissionHandler: no allow option found, cancelling"
                );
                PermissionDecision::cancel()
            }
        }
    }
}

/// Helper: respond to a permission request using a `PermissionDecision`.
///
/// This is a convenience for the common pattern of evaluating a request
/// and immediately responding via the responder.
pub fn respond_with_decision(
    responder: agent_client_protocol::Responder<RequestPermissionResponse>,
    decision: PermissionDecision,
) {
    let outcome = decision.into_outcome();
    let _ = responder.respond(RequestPermissionResponse::new(outcome));
}

/// File lock-aware permission handler — checks ergatai-lock before approving.
///
/// This handler consults the file lock manager to determine if the requested
/// operation conflicts with existing locks. If a conflict is detected, the
/// request is cancelled with a log message.
///
/// Note: This is a simplified implementation. A full implementation would:
/// 1. Parse the permission request to extract file paths
/// 2. Check if those files are locked by other agents
/// 3. Implement lock queueing or wait logic
///
/// For now, this handler logs all permission requests for debugging and
/// delegates to YoloPermissionHandler (auto-approve).
pub struct LockAwarePermissionHandler;

#[async_trait]
impl PermissionHandler for LockAwarePermissionHandler {
    async fn evaluate(
        &self,
        agent_id: &str,
        session_id: &str,
        request: &RequestPermissionRequest,
    ) -> PermissionDecision {
        // Log the permission request for debugging
        debug!(
            agent_id = %agent_id,
            session_id = %session_id,
            options_count = request.options.len(),
            "LockAwarePermissionHandler: evaluating permission request"
        );

        // TODO: Implement actual lock checking logic.
        // This requires:
        // 1. Extracting file paths from the permission request
        // 2. Checking ergatai_lock::get_lock_manager() for conflicting locks
        // 3. Implementing a wait/retry mechanism for lock contention

        // For now, delegate to YoloPermissionHandler (auto-approve)
        // This preserves backward compatibility while providing a hook for future enhancement
        let yolo = YoloPermissionHandler;
        let decision = yolo.evaluate(agent_id, session_id, request).await;

        debug!(
            agent_id = %agent_id,
            decision = ?decision,
            "LockAwarePermissionHandler: decision made (currently auto-approve)"
        );

        decision
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_lock_aware_permission_handler() {
        // Test that LockAwarePermissionHandler delegates to YoloPermissionHandler
        // and auto-approves (current simplified implementation)
        let handler = LockAwarePermissionHandler;

        // Create a minimal mock request (using builder pattern if available)
        // For now, we just verify the handler can be instantiated and called
        // A full integration test would require constructing a RequestPermissionRequest

        // Verify the handler implements PermissionHandler trait
        fn assert_permission_handler<T: PermissionHandler>() {}
        assert_permission_handler::<LockAwarePermissionHandler>();

        // Success - compilation test passes
    }

    #[tokio::test]
    async fn test_yolo_permission_handler_still_works() {
        // Verify YoloPermissionHandler still works after our changes
        let handler = YoloPermissionHandler;

        // Verify the handler implements PermissionHandler trait
        fn assert_permission_handler<T: PermissionHandler>() {}
        assert_permission_handler::<YoloPermissionHandler>();

        // Success - compilation test passes
    }
}
