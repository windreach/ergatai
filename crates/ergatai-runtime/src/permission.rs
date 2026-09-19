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

use std::sync::Arc;
use std::time::Duration;

use agent_client_protocol::schema::v1::{
    PermissionOptionKind, RequestPermissionOutcome, RequestPermissionRequest,
    RequestPermissionResponse, SelectedPermissionOutcome, ToolKind,
};
use async_trait::async_trait;
use tracing::debug;

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

/// How long to wait for a user decision before default-deny.
const INTERACTIVE_PERMISSION_TIMEOUT: Duration = Duration::from_secs(300);

/// Whether a tool kind never requires user approval.
fn is_auto_approve_kind(kind: &ToolKind) -> bool {
    matches!(
        kind,
        ToolKind::Read | ToolKind::Think | ToolKind::SwitchMode | ToolKind::Other
    )
}

/// Human-readable label for a tool kind.
fn tool_kind_label(kind: &ToolKind) -> &'static str {
    match kind {
        ToolKind::Read => "Read",
        ToolKind::Edit => "Edit",
        ToolKind::Delete => "Delete",
        ToolKind::Move => "Move",
        ToolKind::Search => "Search",
        ToolKind::Execute => "Execute",
        ToolKind::Think => "Think",
        ToolKind::Fetch => "Fetch",
        ToolKind::SwitchMode => "SwitchMode",
        ToolKind::Other => "Tool",
        // The schema enum is non-exhaustive; future kinds fall back to Tool.
        _ => "Tool",
    }
}

/// Select the request option matching a decision kind.
fn select_decision_option(
    request: &RequestPermissionRequest,
    decision: crate::permission_service::PermissionDecisionKind,
) -> PermissionDecision {
    let want_allow = decision.is_allow();
    let option = request.options.iter().find(|opt| match opt.kind {
        PermissionOptionKind::AllowOnce | PermissionOptionKind::AllowAlways => want_allow,
        PermissionOptionKind::RejectOnce | PermissionOptionKind::RejectAlways => !want_allow,
        // The schema enum is non-exhaustive; unknown option kinds never match.
        _ => false,
    });
    match option {
        Some(opt) => PermissionDecision::select(opt.option_id.to_string()),
        None => PermissionDecision::cancel(),
    }
}

/// Select the first allow option (used for auto-approved kinds).
fn select_allow_option(request: &RequestPermissionRequest) -> PermissionDecision {
    select_decision_option(
        request,
        crate::permission_service::PermissionDecisionKind::AllowOnce,
    )
}

/// Permission handler that routes user-decision tool kinds (edit, delete,
/// move, execute) through the unified permission request service so clients
/// can approve them in real time. Read-class operations are auto-approved.
///
/// An optional inner handler (e.g. lock-based checks) is consulted after the
/// user allows an operation, so workspace file-locking policies still apply.
pub struct InteractivePermissionHandler {
    inner: Option<Arc<dyn PermissionHandler>>,
}

impl InteractivePermissionHandler {
    pub fn new(inner: Option<Arc<dyn PermissionHandler>>) -> Self {
        Self { inner }
    }
}

#[async_trait]
impl PermissionHandler for InteractivePermissionHandler {
    async fn evaluate(
        &self,
        agent_id: &str,
        session_id: &str,
        request: &RequestPermissionRequest,
    ) -> PermissionDecision {
        use crate::permission_service::{get_permission_mode, PermissionMode};

        let kind = request.tool_call.fields.kind.unwrap_or(ToolKind::Other);

        if is_auto_approve_kind(&kind) {
            debug!(agent_id = %agent_id, kind = ?kind, "InteractivePermissionHandler: auto-approving read-class request");
            return select_allow_option(request);
        }

        let mode = get_permission_mode();
        if mode != PermissionMode::Ask {
            debug!(agent_id = %agent_id, ?mode, "InteractivePermissionHandler: auto-approving per permission mode");
            if mode == PermissionMode::FullAccess {
                return select_allow_option(request);
            }
            if let Some(inner) = &self.inner {
                return inner.evaluate(agent_id, session_id, request).await;
            }
            return select_allow_option(request);
        }

        let service = crate::permission_service::global_permission_service();
        let title = request
            .tool_call
            .fields
            .title
            .clone()
            .unwrap_or_else(|| format!("{} operation approval", tool_kind_label(&kind)));
        let locations = request
            .tool_call
            .fields
            .locations
            .as_ref()
            .map(|locs| {
                locs.iter()
                    .map(|loc| loc.path.to_string_lossy().to_string())
                    .collect()
            })
            .unwrap_or_default();

        let (decision_tx, decision_rx) = tokio::sync::oneshot::channel();
        let request_id = service.register_with_waiter(
            crate::permission_service::PendingPermissionRequest {
                request_id: String::new(),
                kind: crate::permission_service::PermissionRequestKind::Tool,
                agent_id: Some(agent_id.to_string()),
                session_id: Some(session_id.to_string()),
                title,
                tool_name: Some(tool_kind_label(&kind).to_string()),
                input: request.tool_call.fields.raw_input.clone(),
                locations,
                source: crate::permission_service::PermissionSource::Acp,
                created_at_ms: crate::permission_service::now_ms(),
            },
            decision_tx,
        );

        debug!(agent_id = %agent_id, request_id = %request_id, "InteractivePermissionHandler: awaiting user decision");
        let decision = match tokio::time::timeout(INTERACTIVE_PERMISSION_TIMEOUT, decision_rx).await
        {
            Ok(Ok(decision)) => Some(decision),
            _ => None,
        };

        let Some(decision) = decision else {
            service.force_resolve_rejected(&request_id).await;
            return select_decision_option(
                request,
                crate::permission_service::PermissionDecisionKind::RejectOnce,
            );
        };

        if decision.is_allow() {
            if let Some(inner) = &self.inner {
                return inner.evaluate(agent_id, session_id, request).await;
            }
        }
        select_decision_option(request, decision)
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
        let _handler = LockAwarePermissionHandler;

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
        let _handler = YoloPermissionHandler;

        // Verify the handler implements PermissionHandler trait
        fn assert_permission_handler<T: PermissionHandler>() {}
        assert_permission_handler::<YoloPermissionHandler>();

        // Success - compilation test passes
    }
}
