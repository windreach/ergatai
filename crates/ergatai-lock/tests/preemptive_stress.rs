//! Stress test for preemptive write-lock acquisition under high concurrency.
//!
//! Verifies that when N tasks concurrently try to acquire a write lock on the
//! same file, exactly one succeeds and the rest receive a LockConflict error
//! (no panics, no duplicate grants, no lost updates).

use ergatai_lock::{get_lock_manager, init_file_access};
use tempfile::TempDir;
use tokio::task::JoinSet;

#[tokio::test(flavor = "multi_thread", worker_threads = 8)]
async fn thousand_concurrent_acquires_one_winner() {
    let tmp = TempDir::new().expect("tempdir");
    let work_dir = tmp.path().to_path_buf();

    // SnapshotManager requires a git repo.
    let _ = std::process::Command::new("git")
        .args(["init"])
        .current_dir(&work_dir)
        .output();

    let project_id = "stress-project".to_string();
    init_file_access(&project_id, &work_dir).await.unwrap();
    let lock_mgr = get_lock_manager(&project_id).await.unwrap();

    const N: usize = 1000;
    let mut set = JoinSet::new();
    for i in 0..N {
        let mgr = lock_mgr.clone();
        let pid = project_id.clone();
        set.spawn(async move {
            mgr.try_acquire_write_lock_preemptive(
                "stress.txt",
                &format!("agent-{}", i),
                &format!("sess-{}", i),
                &pid,
            )
            .await
        });
    }

    let mut ok = 0usize;
    let mut conflict = 0usize;
    let mut other = 0usize;
    while let Some(res) = set.join_next().await {
        match res.unwrap() {
            Ok(()) => ok += 1,
            Err(e) => {
                if format!("{:?}", e).contains("LockConflict") {
                    conflict += 1;
                } else {
                    other += 1;
                }
            }
        }
    }

    assert_eq!(ok, 1, "expected exactly one winner, got {}", ok);
    assert_eq!(
        conflict,
        N - 1,
        "expected {} conflicts, got {}",
        N - 1,
        conflict
    );
    assert_eq!(other, 0, "unexpected errors: {}", other);
}
