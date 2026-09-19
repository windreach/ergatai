//! Unified permission request service.
//!
//! Owns the pending queue for all user-facing permission requests (ACP tool
//! permission requests, elicitations, and plugin MCP launch gates), notifies
//! subscribers in real time, and resolves decisions from the API layer.

use serde::Serialize;
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use tokio::sync::{broadcast, oneshot, RwLock};

/// Category of a pending permission request.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum PermissionRequestKind {
    /// A tool call or agent input request.
    Tool,
    /// An unapproved plugin MCP server blocking agent launch.
    #[serde(rename = "mcp-server")]
    McpServer,
}

/// Where a pending request originated. Not exposed to clients.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum PermissionSource {
    /// ACP `session/request_permission` request handled by the
    /// [`crate::permission::InteractivePermissionHandler`].
    Acp,
    /// ACP elicitation tracked by the backend.
    Elicitation,
    /// Agent launch gate for unapproved plugin MCP servers.
    LaunchGate,
}

/// A user decision for a pending permission request.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PermissionDecisionKind {
    AllowOnce,
    AllowAlways,
    RejectOnce,
    RejectAlways,
}

impl PermissionDecisionKind {
    /// Parse the wire representation used by the respond API.
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "allow_once" => Some(Self::AllowOnce),
            "allow_always" => Some(Self::AllowAlways),
            "reject_once" => Some(Self::RejectOnce),
            "reject_always" => Some(Self::RejectAlways),
            _ => None,
        }
    }

    /// Whether the decision allows the operation.
    pub fn is_allow(&self) -> bool {
        matches!(self, Self::AllowOnce | Self::AllowAlways)
    }
}

/// A pending permission request surfaced to clients.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingPermissionRequest {
    pub request_id: String,
    pub kind: PermissionRequestKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    pub title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub input: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub locations: Vec<String>,
    pub source: PermissionSource,
    /// Creation time as Unix epoch milliseconds.
    pub created_at_ms: u64,
}

/// Real-time permission lifecycle event.
#[derive(Clone, Debug, Serialize)]
#[serde(tag = "type")]
pub enum PermissionEvent {
    #[serde(rename = "permission_request")]
    Request(Box<PendingPermissionRequest>),
    #[serde(rename = "permission_resolved")]
    Resolved {
        request_id: String,
        decision: PermissionDecisionKind,
    },
}

/// Owns pending permission requests and their waiters.
pub struct PermissionRequestService {
    pending: RwLock<HashMap<String, PendingPermissionRequest>>,
    waiters: Mutex<HashMap<String, oneshot::Sender<PermissionDecisionKind>>>,
    events: broadcast::Sender<PermissionEvent>,
}

impl PermissionRequestService {
    fn new() -> Self {
        let (events, _) = broadcast::channel(256);
        Self {
            pending: RwLock::new(HashMap::new()),
            waiters: Mutex::new(HashMap::new()),
            events,
        }
    }

    /// Subscribe to real-time permission lifecycle events.
    pub fn subscribe(&self) -> broadcast::Receiver<PermissionEvent> {
        self.events.subscribe()
    }

    /// Snapshot of all pending requests, oldest first.
    pub async fn pending(&self) -> Vec<PendingPermissionRequest> {
        let mut requests: Vec<PendingPermissionRequest> =
            self.pending.read().await.values().cloned().collect();
        requests.sort_by_key(|request| request.created_at_ms);
        requests
    }

    /// Look up a single pending request.
    pub async fn get(&self, request_id: &str) -> Option<PendingPermissionRequest> {
        self.pending.read().await.get(request_id).cloned()
    }

    /// Register a pending request, notify subscribers, and return its ID.
    pub fn register(&self, mut request: PendingPermissionRequest) -> String {
        let request_id = if request.request_id.is_empty() {
            format!("perm-{}", uuid::Uuid::new_v4())
        } else {
            request.request_id.clone()
        };
        request.request_id = request_id.clone();

        // Persistence of the pending map is synchronous enough for the
        // writers here (they hold no other locks); use a blocking write via
        // try_write to keep register callable from sync contexts.
        if let Ok(mut pending) = self.pending.try_write() {
            pending.insert(request_id.clone(), request.clone());
        }
        let _ = self
            .events
            .send(PermissionEvent::Request(Box::new(request)));
        request_id
    }

    /// Register a pending request together with a decision waiter so the
    /// creator can await the user decision oneshot directly.
    pub fn register_with_waiter(
        &self,
        mut request: PendingPermissionRequest,
        waiter: oneshot::Sender<PermissionDecisionKind>,
    ) -> String {
        let request_id = if request.request_id.is_empty() {
            format!("perm-{}", uuid::Uuid::new_v4())
        } else {
            request.request_id.clone()
        };
        request.request_id = request_id.clone();

        if let Ok(mut pending) = self.pending.try_write() {
            pending.insert(request_id.clone(), request.clone());
        }
        if let Ok(mut waiters) = self.waiters.lock() {
            waiters.insert(request_id.clone(), waiter);
        }
        let _ = self
            .events
            .send(PermissionEvent::Request(Box::new(request)));
        request_id
    }

    /// Resolve a waiter-based request (ACP handler or launch gate).
    pub async fn respond(
        &self,
        request_id: &str,
        decision: PermissionDecisionKind,
    ) -> Result<PendingPermissionRequest, String> {
        let request = {
            let mut pending = self.pending.write().await;
            pending.remove(request_id)
        }
        .ok_or_else(|| format!("Permission request {} not found", request_id))?;

        if let Ok(mut waiters) = self.waiters.lock() {
            if let Some(sender) = waiters.remove(request_id) {
                let _ = sender.send(decision);
            }
        }
        let _ = self.events.send(PermissionEvent::Resolved {
            request_id: request_id.to_string(),
            decision,
        });
        Ok(request)
    }

    /// Resolve a request created without a waiter (elicitation flow).
    /// No-op when the request is unknown or already resolved.
    pub async fn resolve(&self, request_id: &str, decision: PermissionDecisionKind) {
        let existed = {
            let mut pending = self.pending.write().await;
            pending.remove(request_id).is_some()
        };
        if existed {
            let _ = self.events.send(PermissionEvent::Resolved {
                request_id: request_id.to_string(),
                decision,
            });
        }
    }

    /// Force-resolve a timed-out waiter-based request as rejected.
    pub async fn force_resolve_rejected(&self, request_id: &str) {
        self.resolve(request_id, PermissionDecisionKind::RejectOnce)
            .await;
    }

    /// Force-resolve all pending requests owned by an agent as rejected.
    pub async fn force_resolve_rejected_for_agent(&self, agent_id: &str) -> Vec<String> {
        let mut removed_request_ids = {
            let mut pending = self.pending.write().await;
            let request_ids: Vec<String> = pending
                .iter()
                .filter(|(_, request)| {
                    request.agent_id.as_deref() == Some(agent_id)
                        && request.source == PermissionSource::Acp
                })
                .map(|(request_id, _)| request_id.clone())
                .collect();

            for request_id in &request_ids {
                pending.remove(request_id);
            }
            request_ids
        };

        if !removed_request_ids.is_empty() {
            if let Ok(mut waiters) = self.waiters.lock() {
                for request_id in &removed_request_ids {
                    if let Some(sender) = waiters.remove(request_id) {
                        let _ = sender.send(PermissionDecisionKind::RejectOnce);
                    }
                }
            }

            for request_id in &removed_request_ids {
                let _ = self.events.send(PermissionEvent::Resolved {
                    request_id: request_id.clone(),
                    decision: PermissionDecisionKind::RejectOnce,
                });
            }
        }

        removed_request_ids.sort();
        removed_request_ids
    }
}

/// Global permission request service instance.
pub fn global_permission_service() -> &'static PermissionRequestService {
    static SERVICE: OnceLock<PermissionRequestService> = OnceLock::new();
    SERVICE.get_or_init(PermissionRequestService::new)
}

/// Frontend-selectable permission mode.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PermissionMode {
    /// Ask per operation (policy tiers decide what prompts).
    Ask,
    /// Auto-approve tool permission requests; elicitations still surface.
    Auto,
    /// Auto-approve everything and bypass file-lock checks (full computer access).
    FullAccess,
}

static PERMISSION_MODE: std::sync::atomic::AtomicU8 = std::sync::atomic::AtomicU8::new(0);

/// Current permission mode. Defaults to [`PermissionMode::Ask`].
pub fn get_permission_mode() -> PermissionMode {
    match PERMISSION_MODE.load(std::sync::atomic::Ordering::Relaxed) {
        1 => PermissionMode::Auto,
        2 => PermissionMode::FullAccess,
        _ => PermissionMode::Ask,
    }
}

/// Set the current permission mode.
pub fn set_permission_mode(mode: PermissionMode) {
    let value = match mode {
        PermissionMode::Ask => 0,
        PermissionMode::Auto => 1,
        PermissionMode::FullAccess => 2,
    };
    PERMISSION_MODE.store(value, std::sync::atomic::Ordering::Relaxed);
}

/// Current Unix epoch milliseconds.
pub fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_permission_request_service_register_and_get() {
        let service = PermissionRequestService::new();

        let request = PendingPermissionRequest {
            request_id: String::new(),
            kind: PermissionRequestKind::Tool,
            agent_id: Some("agent-1".to_string()),
            session_id: Some("session-1".to_string()),
            title: "Test Request".to_string(),
            tool_name: Some("edit".to_string()),
            input: None,
            locations: vec![],
            source: PermissionSource::Acp,
            created_at_ms: now_ms(),
        };

        let request_id = service.register(request);
        assert!(request_id.starts_with("perm-"));

        let retrieved = service.get(&request_id).await;
        assert!(retrieved.is_some());
        let retrieved = retrieved.unwrap();
        assert_eq!(retrieved.agent_id, Some("agent-1".to_string()));
        assert_eq!(retrieved.title, "Test Request");
    }

    #[tokio::test]
    async fn test_permission_request_service_pending_list() {
        let service = PermissionRequestService::new();

        for i in 0..3 {
            let request = PendingPermissionRequest {
                request_id: String::new(),
                kind: PermissionRequestKind::Tool,
                agent_id: Some(format!("agent-{}", i)),
                session_id: Some("session-1".to_string()),
                title: format!("Request {}", i),
                tool_name: Some("edit".to_string()),
                input: None,
                locations: vec![],
                source: PermissionSource::Acp,
                created_at_ms: now_ms() + i,
            };
            service.register(request);
        }

        let pending = service.pending().await;
        assert_eq!(pending.len(), 3);
        // Should be sorted by created_at_ms (oldest first)
        assert_eq!(pending[0].title, "Request 0");
        assert_eq!(pending[2].title, "Request 2");
    }

    #[tokio::test]
    async fn test_permission_request_service_respond() {
        let service = PermissionRequestService::new();

        let request = PendingPermissionRequest {
            request_id: "test-req-1".to_string(),
            kind: PermissionRequestKind::Tool,
            agent_id: Some("agent-1".to_string()),
            session_id: Some("session-1".to_string()),
            title: "Test".to_string(),
            tool_name: None,
            input: None,
            locations: vec![],
            source: PermissionSource::Acp,
            created_at_ms: now_ms(),
        };

        service.register(request);

        let resolved = service
            .respond("test-req-1", PermissionDecisionKind::AllowOnce)
            .await;
        assert!(resolved.is_ok());
        assert_eq!(resolved.unwrap().request_id, "test-req-1");

        // Should be removed from pending
        let pending = service.get("test-req-1").await;
        assert!(pending.is_none());
    }

    #[tokio::test]
    async fn test_permission_request_service_resolve_nonexistent() {
        let service = PermissionRequestService::new();

        let result = service
            .respond("nonexistent", PermissionDecisionKind::RejectOnce)
            .await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_force_resolve_rejected_for_agent() {
        let service = PermissionRequestService::new();
        let (target_sender, target_receiver) = tokio::sync::oneshot::channel();
        let (other_sender, _other_receiver) = tokio::sync::oneshot::channel();

        for (request_id, agent_id, waiter) in [
            ("target-request", "agent-target", Some(target_sender)),
            ("other-request", "agent-other", Some(other_sender)),
        ] {
            service.register_with_waiter(
                PendingPermissionRequest {
                    request_id: request_id.to_string(),
                    kind: PermissionRequestKind::Tool,
                    agent_id: Some(agent_id.to_string()),
                    session_id: Some("session-1".to_string()),
                    title: request_id.to_string(),
                    tool_name: Some("edit".to_string()),
                    input: None,
                    locations: vec![],
                    source: PermissionSource::Acp,
                    created_at_ms: now_ms(),
                },
                waiter.unwrap(),
            );
        }

        let mut receiver = service.subscribe();
        let removed = service
            .force_resolve_rejected_for_agent("agent-target")
            .await;
        assert_eq!(removed, vec!["target-request".to_string()]);
        assert!(service.get("target-request").await.is_none());
        assert!(service.get("other-request").await.is_some());
        assert_eq!(
            target_receiver.await,
            Ok(PermissionDecisionKind::RejectOnce)
        );

        match receiver.recv().await.unwrap() {
            PermissionEvent::Resolved {
                request_id,
                decision,
            } => {
                assert_eq!(request_id, "target-request");
                assert_eq!(decision, PermissionDecisionKind::RejectOnce);
            }
            _ => panic!("Expected Resolved event"),
        }
    }

    #[tokio::test]
    async fn test_permission_request_service_subscribe() {
        let service = PermissionRequestService::new();
        let mut receiver = service.subscribe();

        let request = PendingPermissionRequest {
            request_id: "test-sub-1".to_string(),
            kind: PermissionRequestKind::Tool,
            agent_id: Some("agent-1".to_string()),
            session_id: Some("session-1".to_string()),
            title: "Test".to_string(),
            tool_name: None,
            input: None,
            locations: vec![],
            source: PermissionSource::Acp,
            created_at_ms: now_ms(),
        };

        service.register(request);

        // Should receive the registration event
        let event = receiver.recv().await.unwrap();
        match event {
            PermissionEvent::Request(req) => {
                assert_eq!(req.request_id, "test-sub-1");
            }
            _ => panic!("Expected Request event"),
        }
    }

    #[test]
    fn test_permission_mode_transitions() {
        // Reset to default
        set_permission_mode(PermissionMode::Ask);
        assert_eq!(get_permission_mode(), PermissionMode::Ask);

        set_permission_mode(PermissionMode::Auto);
        assert_eq!(get_permission_mode(), PermissionMode::Auto);

        set_permission_mode(PermissionMode::FullAccess);
        assert_eq!(get_permission_mode(), PermissionMode::FullAccess);

        set_permission_mode(PermissionMode::Ask);
        assert_eq!(get_permission_mode(), PermissionMode::Ask);
    }

    #[test]
    fn test_permission_decision_kind_parse() {
        assert_eq!(
            PermissionDecisionKind::parse("allow_once"),
            Some(PermissionDecisionKind::AllowOnce)
        );
        assert_eq!(
            PermissionDecisionKind::parse("allow_always"),
            Some(PermissionDecisionKind::AllowAlways)
        );
        assert_eq!(
            PermissionDecisionKind::parse("reject_once"),
            Some(PermissionDecisionKind::RejectOnce)
        );
        assert_eq!(
            PermissionDecisionKind::parse("reject_always"),
            Some(PermissionDecisionKind::RejectAlways)
        );
        assert_eq!(PermissionDecisionKind::parse("invalid"), None);
    }

    #[test]
    fn test_permission_decision_kind_is_allow() {
        assert!(PermissionDecisionKind::AllowOnce.is_allow());
        assert!(PermissionDecisionKind::AllowAlways.is_allow());
        assert!(!PermissionDecisionKind::RejectOnce.is_allow());
        assert!(!PermissionDecisionKind::RejectAlways.is_allow());
    }

    #[test]
    fn test_now_ms() {
        let ms = now_ms();
        // Should be a reasonable timestamp (after 2020-01-01)
        assert!(ms > 1577836800000);
    }
}
