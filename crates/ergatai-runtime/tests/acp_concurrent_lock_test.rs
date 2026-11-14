//! Integration test: two mock ACP agents concurrently requesting permission to
//! edit the same file. The second request must be rejected by the pre-lock
//! mechanism (LockConflict) and recorded as such.

use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use agent_client_protocol::schema::v1::RequestPermissionRequest;
use async_trait::async_trait;
use ergatai_runtime::backend::AcpBackendInterface;
use ergatai_runtime::backends::acp::AcpBackend;
use ergatai_runtime::permission::{PermissionDecision, PermissionHandler};
use ergatai_runtime::permission_service::{self, PermissionMode};
use ergatai_runtime::types::{ResourceLimits, WorkspaceSpec};
use tempfile::TempDir;

fn mock_agent_command() -> String {
    let manifest_dir = env!("CARGO_MANIFEST_DIR");
    let script = PathBuf::from(manifest_dir)
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .join("scripts/mock-acp-agent.py");
    format!("python3 {}", script.display())
}

/// A permission handler that delegates locking to ergatai-lock for a fixed
/// project, recording the outcome of each request.
struct ConflictTrackingHandler {
    project_id: String,
    results: Arc<Mutex<Vec<String>>>,
}

#[async_trait]
impl PermissionHandler for ConflictTrackingHandler {
    async fn evaluate(
        &self,
        agent_id: &str,
        session_id: &str,
        request: &RequestPermissionRequest,
    ) -> PermissionDecision {
        use agent_client_protocol::schema::v1::PermissionOptionKind;
        let lock_mgr = match ergatai_lock::get_lock_manager(&self.project_id).await {
            Ok(m) => m,
            Err(_) => {
                self.results.lock().unwrap().push("no-lock-mgr".into());
                // Fall back to allow
                return request
                    .options
                    .iter()
                    .find(|o| {
                        matches!(
                            o.kind,
                            PermissionOptionKind::AllowOnce | PermissionOptionKind::AllowAlways
                        )
                    })
                    .map(|o| PermissionDecision::select(o.option_id.to_string()))
                    .unwrap_or_else(PermissionDecision::cancel);
            }
        };

        match lock_mgr
            .try_acquire_write_lock_preemptive("test.txt", agent_id, session_id, &self.project_id)
            .await
        {
            Ok(()) => {
                self.results.lock().unwrap().push("allowed".into());
                request
                    .options
                    .iter()
                    .find(|o| {
                        matches!(
                            o.kind,
                            PermissionOptionKind::AllowOnce | PermissionOptionKind::AllowAlways
                        )
                    })
                    .map(|o| PermissionDecision::select(o.option_id.to_string()))
                    .unwrap_or_else(PermissionDecision::cancel)
            }
            Err(_) => {
                self.results.lock().unwrap().push("rejected".into());
                request
                    .options
                    .iter()
                    .find(|o| {
                        matches!(
                            o.kind,
                            PermissionOptionKind::RejectOnce | PermissionOptionKind::RejectAlways
                        )
                    })
                    .map(|o| PermissionDecision::select(o.option_id.to_string()))
                    .unwrap_or_else(PermissionDecision::cancel)
            }
        }
    }
}

#[tokio::test]
async fn test_acp_concurrent_lock_conflict() {
    // FullAccess mode => auto-approve + immediate pre-lock (no manual approval needed).
    permission_service::set_permission_mode(PermissionMode::FullAccess);

    let tmp = TempDir::new().expect("tempdir");
    let work_dir = tmp.path().to_path_buf();
    // SnapshotManager requires a git repository.
    let _ = std::process::Command::new("git")
        .args(["init"])
        .current_dir(&work_dir)
        .output();
    let project_id = "test-concurrent-lock".to_string();

    ergatai_lock::init_file_access(&project_id, &work_dir)
        .await
        .expect("init file access");

    let results = Arc::new(Mutex::new(Vec::new()));
    let handler = Arc::new(ConflictTrackingHandler {
        project_id: project_id.clone(),
        results: results.clone(),
    });

    let backend = AcpBackend::new().with_permission_handler(handler);
    backend.initialize().await.unwrap();

    let spec = WorkspaceSpec {
        id: "ws-concurrent-lock".to_string(),
        work_dir: work_dir.clone(),
        env: Default::default(),
        resources: ResourceLimits::default(),
        capture_thoughts: false,
    };
    let workspace = backend.create_workspace(spec).await.unwrap();

    let command = mock_agent_command();
    let h1 = backend
        .start_agent(&workspace, &command, None)
        .await
        .unwrap();
    let h2 = backend
        .start_agent(&workspace, &command, None)
        .await
        .unwrap();

    tokio::time::sleep(Duration::from_millis(500)).await;

    // Trigger permission requests on both agents.
    backend
        .inject_message(&h1, "请修改文件 test.txt")
        .await
        .unwrap();
    backend
        .inject_message(&h2, "请修改文件 test.txt")
        .await
        .unwrap();

    // Mock agent sleeps 2s after sending the permission request.
    tokio::time::sleep(Duration::from_secs(4)).await;

    let collected = results.lock().unwrap().clone();
    // We expect at least two evaluations, with at least one allowed and one rejected.
    assert!(
        collected.contains(&"allowed".to_string()),
        "expected at least one allowed, got: {:?}",
        collected
    );
    assert!(
        collected.contains(&"rejected".to_string()),
        "expected at least one rejected (lock conflict), got: {:?}",
        collected
    );

    backend.stop_agent(&h1).await.unwrap();
    backend.stop_agent(&h2).await.unwrap();
}
