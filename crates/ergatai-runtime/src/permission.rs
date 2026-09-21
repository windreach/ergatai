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

        // Extract locations once — used by all allow-paths for pre-locking and
        // by the Ask-mode registration.
        let locations: Vec<String> = request
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

        if is_auto_approve_kind(&kind) {
            debug!(agent_id = %agent_id, kind = ?kind, "InteractivePermissionHandler: auto-approving read-class request");
            return select_allow_option(request);
        }

        let mode = get_permission_mode();
        if mode != PermissionMode::Ask {
            debug!(agent_id = %agent_id, ?mode, "InteractivePermissionHandler: auto-approving per permission mode");
            if mode == PermissionMode::FullAccess {
                // Lock pre-shift: acquire WRITE lock BEFORE the tool executes.
                // If another agent holds the lock, reject the tool call so we
                // get real mutual exclusion instead of post-hoc audit.
                if let Err(reason) = try_pre_lock_files(
                    agent_id,
                    session_id,
                    &kind,
                    &locations,
                    request.tool_call.fields.raw_input.as_ref(),
                )
                .await
                {
                    debug!(
                        agent_id = %agent_id,
                        reason = %reason,
                        "Pre-lock failed in FullAccess mode, rejecting"
                    );
                    return select_decision_option(
                        request,
                        crate::permission_service::PermissionDecisionKind::RejectOnce,
                    );
                }
                return select_allow_option(request);
            }
            if let Some(inner) = &self.inner {
                return inner.evaluate(agent_id, session_id, request).await;
            }
            if let Err(reason) = try_pre_lock_files(
                agent_id,
                session_id,
                &kind,
                &locations,
                request.tool_call.fields.raw_input.as_ref(),
            )
            .await
            {
                debug!(
                    agent_id = %agent_id,
                    reason = %reason,
                    "Pre-lock failed in auto-approve mode, rejecting"
                );
                return select_decision_option(
                    request,
                    crate::permission_service::PermissionDecisionKind::RejectOnce,
                );
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
                locations: locations.clone(),
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
            // Lock pre-shift: even when the user explicitly allows, refuse the
            // tool if another agent holds the WRITE lock. The user's "allow"
            // grants permission-to-try, not permission-to-stomp.
            if let Err(reason) = try_pre_lock_files(
                agent_id,
                session_id,
                &kind,
                &locations,
                request.tool_call.fields.raw_input.as_ref(),
            )
            .await
            {
                debug!(
                    agent_id = %agent_id,
                    reason = %reason,
                    "Pre-lock failed after user allow, rejecting"
                );
                return select_decision_option(
                    request,
                    crate::permission_service::PermissionDecisionKind::RejectOnce,
                );
            }

            if let Some(inner) = &self.inner {
                return inner.evaluate(agent_id, session_id, request).await;
            }
        }
        select_decision_option(request, decision)
    }
}

/// Pre-emptively acquire WRITE locks for files about to be modified.
///
/// Called from the ACP permission approval path — when the user/system allows
/// a tool, we take the lock NOW (before the tool executes) so two agents
/// cannot stomp on the same file. This is the "lock pre-shift" mechanism
/// described in the project design.
///
/// # Behavior by tool kind
///
/// | ToolKind | Action |
/// |----------|--------|
/// | `Edit`, `Delete`, `Move` | Attempt pre-lock on each location. Conflict → `Err`. |
/// | `Execute` (Bash) | Extract write targets from command via static analysis, then pre-lock. Extraction failure → `Ok(())` (proceed without pre-lock, watcher catches post-hoc). |
/// | Other (Read, Search, …) | No-op — returns `Ok(())`. |
///
/// # Degradation
///
/// The function **never blocks approval on infrastructure failures**:
/// - `workspace_id` cannot be derived from `agent_id` → log + return `Ok(())`
/// - `get_lock_manager(workspace_id)` fails (lock subsystem not initialized) → log + return `Ok(())`
/// - Per-agent limit (50 locks) exceeded → return `Err` (caller rejects tool)
/// - SQLite error → return `Err` (caller rejects tool)
/// - `LockConflict` → return `Err` with holder info (caller rejects tool)
///
/// Returning `Ok(())` on infra failure means the tool will run, and the
/// FileSystemWatcher's auto-acquire path will catch the modification as a
/// post-hoc fallback. This keeps the system usable even when the lock
/// subsystem is partially initialized.
async fn try_pre_lock_files(
    agent_id: &str,
    session_id: &str,
    kind: &ToolKind,
    locations: &[String],
    raw_input: Option<&serde_json::Value>,
) -> Result<(), ergatai_error::ErgataiError> {
    // Determine which paths to pre-lock based on tool kind.
    let paths_to_lock: Vec<String> = match kind {
        ToolKind::Edit | ToolKind::Delete | ToolKind::Move => {
            // ACP provides locations directly for these tool kinds.
            if locations.is_empty() {
                return Ok(());
            }
            locations.to_vec()
        }
        ToolKind::Execute => {
            // For Bash, extract write targets via static analysis.
            // If extraction yields nothing, proceed without pre-locking —
            // the watcher will catch modifications post-hoc.
            let Some(input) = raw_input else {
                tracing::debug!(
                    agent_id = %agent_id,
                    "Execute tool: no raw_input available, proceeding without pre-lock"
                );
                return Ok(());
            };
            let command = extract_command_from_raw_input(input);
            if command.is_empty() {
                tracing::debug!(
                    agent_id = %agent_id,
                    "Execute tool: no command in raw_input, proceeding without pre-lock"
                );
                return Ok(());
            }
            let extracted = crate::bash_path_extractor::extract_bash_write_targets(&command);
            if extracted.is_empty() {
                tracing::debug!(
                    agent_id = %agent_id,
                    cmd_preview = %command.chars().take(100).collect::<String>(),
                    "Execute tool: bash path extraction yielded no targets, proceeding without pre-lock"
                );
                return Ok(());
            }
            tracing::debug!(
                agent_id = %agent_id,
                extracted_paths = ?extracted,
                "Execute tool: extracted write targets for pre-lock"
            );
            extracted
        }
        _ => return Ok(()),
    };

    if paths_to_lock.is_empty() {
        return Ok(());
    }

    // Derive workspace_id from agent_id using the project-wide convention
    // `{workspace_id}-agent-{counter}` (see acp.rs:1741, acp.rs:1816).
    let Some(workspace_id) = agent_id.rfind("-agent-").map(|pos| &agent_id[..pos]) else {
        tracing::warn!(
            agent_id = %agent_id,
            "try_pre_lock_files: cannot derive workspace_id from agent_id, degrading to no-op"
        );
        return Ok(());
    };

    // Resolve the lock manager for this workspace. Failure means the lock
    // subsystem is not initialized for this project — degrade gracefully
    // rather than blocking all edits.
    let lock_mgr = match ergatai_lock::get_lock_manager(workspace_id).await {
        Ok(mgr) => mgr,
        Err(e) => {
            tracing::info!(
                agent_id = %agent_id,
                workspace_id = %workspace_id,
                error = %e,
                "try_pre_lock_files: lock manager unavailable, degrading to no-op"
            );
            return Ok(());
        }
    };

    // Attempt a pre-emptive acquire on each path. First failure short-
    // circuits the loop — we don't want to hold locks on some files while
    // rejecting the tool overall.
    for path in &paths_to_lock {
        if let Err(e) = lock_mgr
            .try_acquire_write_lock_preemptive(path, agent_id, session_id, workspace_id)
            .await
        {
            return Err(ergatai_error::ErgataiError::LockConflict(format!(
                "{}: {}",
                path, e
            )));
        }
    }

    Ok(())
}

/// Extract the command string from ACP raw_input JSON.
///
/// For Execute tools, the raw_input typically has the structure:
/// ```json
/// { "command": "echo hello > output.txt" }
/// ```
///
/// Returns an empty string if extraction fails.
fn extract_command_from_raw_input(raw_input: &serde_json::Value) -> String {
    raw_input
        .get("command")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string()
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
    use agent_client_protocol::schema::v1::{
        PermissionOption, RequestPermissionRequest, ToolCallId, ToolCallUpdate,
    };

    #[test]
    fn test_permission_decision_select() {
        let decision = PermissionDecision::select("option-1".to_string());
        assert_eq!(decision.option_id, Some("option-1".to_string()));
    }

    #[test]
    fn test_permission_decision_cancel() {
        let decision = PermissionDecision::cancel();
        assert_eq!(decision.option_id, None);
    }

    #[test]
    fn test_permission_decision_into_outcome_selected() {
        let decision = PermissionDecision::select("option-1".to_string());
        let outcome = decision.into_outcome();
        match outcome {
            RequestPermissionOutcome::Selected(selected) => {
                assert_eq!(selected.option_id.to_string(), "option-1");
            }
            RequestPermissionOutcome::Cancelled => {
                panic!("Expected Selected, got Cancelled");
            }
            _ => panic!("Unexpected outcome variant"),
        }
    }

    #[test]
    fn test_permission_decision_into_outcome_cancelled() {
        let decision = PermissionDecision::cancel();
        let outcome = decision.into_outcome();
        assert!(matches!(outcome, RequestPermissionOutcome::Cancelled));
    }

    #[test]
    fn test_extract_command_from_raw_input_with_command() {
        let raw_input = serde_json::json!({
            "command": "echo hello > output.txt"
        });
        let command = extract_command_from_raw_input(&raw_input);
        assert_eq!(command, "echo hello > output.txt");
    }

    #[test]
    fn test_extract_command_from_raw_input_without_command() {
        let raw_input = serde_json::json!({
            "other_field": "value"
        });
        let command = extract_command_from_raw_input(&raw_input);
        assert_eq!(command, "");
    }

    #[test]
    fn test_extract_command_from_raw_input_empty_object() {
        let raw_input = serde_json::json!({});
        let command = extract_command_from_raw_input(&raw_input);
        assert_eq!(command, "");
    }

    #[test]
    fn test_extract_command_from_raw_input_non_string_command() {
        let raw_input = serde_json::json!({
            "command": 123
        });
        let command = extract_command_from_raw_input(&raw_input);
        assert_eq!(command, "");
    }

    fn create_test_request(options: Vec<PermissionOption>) -> RequestPermissionRequest {
        let tool_call = ToolCallUpdate::new(
            ToolCallId::from("test-tool-call"),
            agent_client_protocol::schema::v1::ToolCallUpdateFields::default(),
        );
        RequestPermissionRequest::new("test-session", tool_call, options)
    }

    #[tokio::test]
    async fn test_yolo_permission_handler_with_allow_once() {
        let handler = YoloPermissionHandler;
        let request = create_test_request(vec![
            PermissionOption::new(
                "reject".to_string(),
                "Reject".to_string(),
                PermissionOptionKind::RejectOnce,
            ),
            PermissionOption::new(
                "allow".to_string(),
                "Allow".to_string(),
                PermissionOptionKind::AllowOnce,
            ),
        ]);

        let decision = handler.evaluate("agent-1", "session-1", &request).await;
        assert_eq!(decision.option_id, Some("allow".to_string()));
    }

    #[tokio::test]
    async fn test_yolo_permission_handler_with_allow_always() {
        let handler = YoloPermissionHandler;
        let request = create_test_request(vec![
            PermissionOption::new(
                "reject".to_string(),
                "Reject".to_string(),
                PermissionOptionKind::RejectOnce,
            ),
            PermissionOption::new(
                "allow-always".to_string(),
                "Allow Always".to_string(),
                PermissionOptionKind::AllowAlways,
            ),
        ]);

        let decision = handler.evaluate("agent-1", "session-1", &request).await;
        assert_eq!(decision.option_id, Some("allow-always".to_string()));
    }

    #[tokio::test]
    async fn test_yolo_permission_handler_no_allow_option() {
        let handler = YoloPermissionHandler;
        let request = create_test_request(vec![PermissionOption::new(
            "reject".to_string(),
            "Reject".to_string(),
            PermissionOptionKind::RejectOnce,
        )]);

        let decision = handler.evaluate("agent-1", "session-1", &request).await;
        assert_eq!(decision.option_id, None);
    }

    #[tokio::test]
    async fn test_yolo_permission_handler_empty_options() {
        let handler = YoloPermissionHandler;
        let request = create_test_request(vec![]);

        let decision = handler.evaluate("agent-1", "session-1", &request).await;
        assert_eq!(decision.option_id, None);
    }

    #[tokio::test]
    async fn test_lock_aware_permission_handler() {
        // Test that LockAwarePermissionHandler delegates to YoloPermissionHandler
        // and auto-approves (current simplified implementation)
        let handler = LockAwarePermissionHandler;

        // Verify the handler implements PermissionHandler trait
        fn assert_permission_handler<T: PermissionHandler>() {}
        assert_permission_handler::<LockAwarePermissionHandler>();

        // Create a request with an allow option
        let request = create_test_request(vec![PermissionOption::new(
            "allow".to_string(),
            "Allow".to_string(),
            PermissionOptionKind::AllowOnce,
        )]);

        let decision = handler.evaluate("agent-1", "session-1", &request).await;
        // Should auto-approve like YoloPermissionHandler
        assert_eq!(decision.option_id, Some("allow".to_string()));
    }
}
