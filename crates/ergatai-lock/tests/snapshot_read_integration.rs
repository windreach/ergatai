//! Snapshot read integration tests.
//!
//! These tests verify that when Agent A locks and modifies a file,
//! Agent B can read the original content via LD_PRELOAD snapshot redirection.
//!
//! Requires:
//! - Docker with fanotify support
//! - libergatai_preload.so built and available
//! - IPC socket for snapshot queries

use std::fs;
use std::path::PathBuf;
use std::process::Command;
use tempfile::TempDir;

use ergatai_lock::manager::{get_lock_manager, init_file_access_with_enforcer};
use ergatai_lock::NoopPidResolver;
use git2::Repository;
use std::sync::Arc;

/// Test: Snapshot read via LD_PRELOAD (requires Docker)
///
/// Scenario:
/// 1. Create file.txt with "ORIGINAL CONTENT"
/// 2. Commit to Git
/// 3. Agent A auto-acquires lock (creates snapshot)
/// 4. Agent A modifies file to "MODIFIED CONTENT"
/// 5. Agent B reads with LD_PRELOAD → should get "ORIGINAL CONTENT"
/// 6. Agent B reads without LD_PRELOAD → gets "MODIFIED CONTENT"
///
/// This test verifies the complete snapshot read flow:
/// - Snapshot creation (via auto_acquire_write_lock)
/// - LD_PRELOAD interception (via libergatai_preload.so)
/// - IPC query to get snapshot hash
/// - Reading snapshot content from temp file
#[tokio::test]
#[ignore = "Requires Docker with LD_PRELOAD and IPC socket"]
async fn test_snapshot_read_via_preload() {
    // Create temporary directory with Git repository
    let temp_dir = TempDir::new().unwrap();
    let project_root = temp_dir.path().to_path_buf();

    // Initialize Git repository
    let repo = Repository::init(&project_root).unwrap();
    {
        let mut config = repo.config().unwrap();
        config.set_str("user.name", "Test User").unwrap();
        config.set_str("user.email", "test@example.com").unwrap();
    }

    // Create a test file with original content
    let test_file = project_root.join("snapshot_test.txt");
    let original_content = "ORIGINAL CONTENT - this should be read by Agent B via snapshot";
    fs::write(&test_file, original_content).unwrap();

    // Commit the file to Git (creates baseline for snapshot)
    let mut index = repo.index().unwrap();
    index
        .add_path(std::path::Path::new("snapshot_test.txt"))
        .unwrap();
    index.write().unwrap();

    let tree_id = index.write_tree().unwrap();
    let tree = repo.find_tree(tree_id).unwrap();
    let sig = repo.signature().unwrap();
    repo.commit(Some("HEAD"), &sig, &sig, "Initial commit", &tree, &[])
        .unwrap();

    // Initialize file access control with enforcer (required for IPC server)
    let project_id = "test-snapshot-read";
    let pid_resolver = Arc::new(NoopPidResolver);
    init_file_access_with_enforcer(project_id, &project_root, pid_resolver)
        .await
        .unwrap();

    let manager = get_lock_manager(project_id).await.unwrap();

    let agent_a = "agent-a";
    let _agent_b = "agent-b";
    let file_path = "snapshot_test.txt";

    // Step 1: Agent A auto-acquires lock (creates snapshot of original content)
    let result_a = manager
        .auto_acquire_write_lock(file_path, agent_a, "session-a", project_id)
        .await;
    assert!(result_a.is_ok(), "Agent A should acquire lock");

    // Debug: Check if snapshot record was stored in database
    println!("DEBUG: Checking snapshots table...");
    let lock_db_path = project_root.join(".ergatai").join("locks.db");
    let conn = rusqlite::Connection::open(&lock_db_path).unwrap();
    let snapshot_count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM snapshots WHERE file_path = ?1",
            rusqlite::params![file_path],
            |row| row.get(0),
        )
        .unwrap();
    println!(
        "DEBUG: Found {} snapshot records for file_path={}",
        snapshot_count, file_path
    );

    if snapshot_count > 0 {
        let (id, git_hash, created_by): (String, String, String) = conn
            .query_row(
                "SELECT id, git_hash, created_by FROM snapshots WHERE file_path = ?1 LIMIT 1",
                rusqlite::params![file_path],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        println!(
            "DEBUG: Snapshot record: id={}, git_hash={}, created_by={}",
            id, git_hash, created_by
        );
    }

    // Debug: Check if snapshot was created immediately after auto_acquire
    println!("DEBUG: After auto_acquire_write_lock, checking Git blobs...");
    let git_repo = git2::Repository::open(&project_root).unwrap();
    let mut blob_count_after_lock = 0;
    git_repo
        .odb()
        .unwrap()
        .foreach(|oid| {
            let obj = git_repo.find_object(*oid, None).unwrap();
            if obj.kind() == Some(git2::ObjectType::Blob) {
                blob_count_after_lock += 1;
                println!("DEBUG: Found blob: {}", oid);
            }
            true
        })
        .unwrap();
    println!(
        "DEBUG: Git repository has {} blobs after auto_acquire",
        blob_count_after_lock
    );

    // Step 2: Agent A modifies the file
    let modified_content = "MODIFIED CONTENT by Agent A - should NOT be read by Agent B";
    fs::write(&test_file, modified_content).unwrap();

    // Debug: Check if snapshot was created in Git
    println!("DEBUG: Checking Git repository for snapshots...");
    let git_repo = git2::Repository::open(&project_root).unwrap();
    let mut snapshot_count = 0;
    git_repo
        .odb()
        .unwrap()
        .foreach(|oid| {
            let obj = git_repo.find_object(*oid, None).unwrap();
            if obj.kind() == Some(git2::ObjectType::Blob) {
                snapshot_count += 1;
            }
            true
        })
        .unwrap();
    println!(
        "DEBUG: Git repository has {} blobs (including snapshots)",
        snapshot_count
    );

    // Step 3: Agent B reads WITHOUT LD_PRELOAD → gets modified content
    let content_without_preload = fs::read_to_string(&test_file).unwrap();
    assert_eq!(
        content_without_preload, modified_content,
        "Without LD_PRELOAD, should read modified content"
    );

    // Step 4: Agent B reads WITH LD_PRELOAD → should get original snapshot
    // Find the preload library
    let preload_lib = find_preload_library()
        .expect("LD_PRELOAD library not found. Build with: cargo build -p ergatai-preload");

    // Debug: Check if IPC socket exists
    let uid = unsafe { libc::getuid() };
    let socket_path = format!("/tmp/ergatai-lock-{}.sock", uid);
    println!("DEBUG: IPC socket path: {}", socket_path);
    println!(
        "DEBUG: IPC socket exists: {}",
        std::path::Path::new(&socket_path).exists()
    );

    // Run a subprocess with LD_PRELOAD to read the file
    // The LD_PRELOAD library intercepts open() and redirects to snapshot
    let output = Command::new("sh")
        .arg("-c")
        .arg(format!(
            "echo 'LD_PRELOAD={}' && ls -l {} 2>&1 && cat {}",
            preload_lib.display(),
            preload_lib.display(),
            test_file.display()
        ))
        .env("LD_PRELOAD", &preload_lib)
        .env("ERGATAI_PROJECT_ROOT", &project_root)
        .output()
        .expect("Failed to execute shell with LD_PRELOAD");

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        println!("LD_PRELOAD stderr: {}", stderr);
        panic!("shell with LD_PRELOAD failed");
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    println!("DEBUG: Shell output with LD_PRELOAD:\n{}", stdout);

    // Extract the last line (the file content from cat)
    let content_with_preload = stdout.lines().last().unwrap_or("");

    // Verify that with LD_PRELOAD, Agent B reads the original snapshot
    assert_eq!(
        content_with_preload.trim(),
        original_content,
        "With LD_PRELOAD, Agent B should read original snapshot content, not modified content"
    );

    println!("✅ Snapshot read verified: Agent B read original content via LD_PRELOAD");
}

/// Test: Snapshot read with multiple modifications
///
/// Verifies that snapshot captures the content at the moment of lock acquisition,
/// not subsequent modifications.
#[tokio::test]
#[ignore = "Requires Docker with LD_PRELOAD"]
async fn test_snapshot_captures_content_at_lock_time() {
    let temp_dir = TempDir::new().unwrap();
    let project_root = temp_dir.path().to_path_buf();

    let repo = Repository::init(&project_root).unwrap();
    {
        let mut config = repo.config().unwrap();
        config.set_str("user.name", "Test User").unwrap();
        config.set_str("user.email", "test@example.com").unwrap();
    }

    let test_file = project_root.join("multi_modify.txt");
    let version_1 = "VERSION 1 - original";
    fs::write(&test_file, version_1).unwrap();

    let mut index = repo.index().unwrap();
    index
        .add_path(std::path::Path::new("multi_modify.txt"))
        .unwrap();
    index.write().unwrap();

    let tree_id = index.write_tree().unwrap();
    let tree = repo.find_tree(tree_id).unwrap();
    let sig = repo.signature().unwrap();
    repo.commit(Some("HEAD"), &sig, &sig, "Initial commit", &tree, &[])
        .unwrap();

    let project_id = "test-multi-modify";
    let pid_resolver = Arc::new(NoopPidResolver);
    init_file_access_with_enforcer(project_id, &project_root, pid_resolver)
        .await
        .unwrap();

    let manager = get_lock_manager(project_id).await.unwrap();

    // Agent A locks (snapshot captures VERSION 1)
    manager
        .auto_acquire_write_lock("multi_modify.txt", "agent-a", "session-a", project_id)
        .await
        .unwrap();

    // Agent A modifies to VERSION 2
    let version_2 = "VERSION 2 - first modification";
    fs::write(&test_file, version_2).unwrap();

    // Agent A modifies again to VERSION 3
    let version_3 = "VERSION 3 - second modification";
    fs::write(&test_file, version_3).unwrap();

    // Agent B reads with LD_PRELOAD → should get VERSION 1 (the snapshot)
    let preload_lib = find_preload_library().unwrap();
    let output = Command::new("cat")
        .arg(&test_file)
        .env("LD_PRELOAD", &preload_lib)
        .env("ERGATAI_PROJECT_ROOT", &project_root)
        .output()
        .unwrap();

    let content = String::from_utf8_lossy(&output.stdout);
    assert_eq!(
        content.trim(),
        version_1,
        "Snapshot should capture content at lock time (VERSION 1), not later modifications"
    );
}

/// Test: Snapshot read fails open
///
/// Verifies that if IPC socket is unavailable, the preload library
/// falls back to reading the actual file (not blocking).
#[tokio::test]
#[ignore = "Requires Docker with LD_PRELOAD"]
async fn test_snapshot_read_fails_open() {
    let temp_dir = TempDir::new().unwrap();
    let project_root = temp_dir.path().to_path_buf();

    let test_file = project_root.join("fail_open.txt");
    let content = "test content";
    fs::write(&test_file, content).unwrap();

    // Find preload library
    let preload_lib = find_preload_library().unwrap();

    // Run cat with LD_PRELOAD but WITHOUT IPC socket
    // Should fall through to real open() and read actual content
    let output = Command::new("cat")
        .arg(&test_file)
        .env("LD_PRELOAD", &preload_lib)
        // No ERGATAI_PROJECT_ROOT, no IPC socket → should fail open
        .output()
        .unwrap();

    assert!(
        output.status.success(),
        "LD_PRELOAD should fail open, not block read"
    );

    let read_content = String::from_utf8_lossy(&output.stdout);
    assert_eq!(
        read_content, content,
        "Without IPC socket, should read actual file content (fail-open)"
    );
}

/// Find the ergatai-preload library
fn find_preload_library() -> Option<PathBuf> {
    let search_paths = vec![
        // Docker mount location (when run via run_snapshot_read_test.sh)
        PathBuf::from("/app/libergatai_preload.so"),
        // Debug build
        PathBuf::from("target/debug/libergatai_preload.so"),
        // Release build
        PathBuf::from("target/release/libergatai_preload.so"),
        // Absolute path
        PathBuf::from("/app/target/debug/libergatai_preload.so"),
    ];

    search_paths.into_iter().find(|path| path.exists())
}

/// Helper: Check if running in Docker
fn _is_running_in_docker() -> bool {
    // Check for .dockerenv file (common Docker indicator)
    PathBuf::from("/.dockerenv").exists()
        // Or check cgroup (another Docker indicator)
        || std::fs::read_to_string("/proc/1/cgroup")
            .map(|c| c.contains("docker"))
            .unwrap_or(false)
}
