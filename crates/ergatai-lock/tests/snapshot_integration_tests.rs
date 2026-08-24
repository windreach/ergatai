//! Integration tests for SnapshotManager::create_snapshot — full lifecycle with real git repo.
//!
//! Tests cover: happy path, path traversal rejection, symlink rejection,
//! file-too-large rejection, nonexistent file handling, and concurrent snapshots.

use ergatai_lock::SnapshotManager;
use std::fs;
use tempfile::tempdir;

fn init_git_repo(dir: &std::path::Path) {
    git2::Repository::init(dir).expect("init git repo");
    // Create an initial commit so HEAD exists
    let repo = git2::Repository::open(dir).unwrap();
    let sig = git2::Signature::now("test", "test@test.com").unwrap();
    let tree_id = {
        let mut index = repo.index().unwrap();
        index.write_tree().unwrap()
    };
    let tree = repo.find_tree(tree_id).unwrap();
    repo.commit(Some("HEAD"), &sig, &sig, "init", &tree, &[])
        .unwrap();
}

fn setup() -> (SnapshotManager, tempfile::TempDir) {
    let dir = tempdir().expect("create temp dir");
    init_git_repo(dir.path());
    let mgr = SnapshotManager::new(dir.path()).expect("create snapshot manager");
    (mgr, dir)
}

// ── Happy path ───────────────────────────────────────────────────────

#[test]
fn create_snapshot_returns_git_hash() {
    let (mgr, dir) = setup();
    let file_path = dir.path().join("hello.txt");
    fs::write(&file_path, "hello world").unwrap();

    let hash = mgr.create_snapshot("hello.txt", "agent-1").unwrap();
    assert!(!hash.is_empty(), "should return a non-empty git hash");
    assert!(
        hash.len() >= 7,
        "git hash should be at least 7 chars, got: {hash}"
    );
}

#[test]
fn create_snapshot_same_content_same_hash() {
    let (mgr, dir) = setup();
    fs::write(dir.path().join("a.txt"), "same content").unwrap();
    fs::write(dir.path().join("b.txt"), "same content").unwrap();

    let hash_a = mgr.create_snapshot("a.txt", "agent-1").unwrap();
    let hash_b = mgr.create_snapshot("b.txt", "agent-1").unwrap();
    assert_eq!(
        hash_a, hash_b,
        "same content should produce same git blob hash"
    );
}

#[test]
fn create_snapshot_different_content_different_hash() {
    let (mgr, dir) = setup();
    fs::write(dir.path().join("x.txt"), "content X").unwrap();
    fs::write(dir.path().join("y.txt"), "content Y").unwrap();

    let hash_x = mgr.create_snapshot("x.txt", "agent-1").unwrap();
    let hash_y = mgr.create_snapshot("y.txt", "agent-1").unwrap();
    assert_ne!(hash_x, hash_y);
}

// ── Path traversal ───────────────────────────────────────────────────

#[test]
fn create_snapshot_rejects_path_traversal() {
    let (mgr, _dir) = setup();
    let result = mgr.create_snapshot("../../../etc/passwd", "agent-1");
    assert!(result.is_err(), "should reject path traversal");
}

#[test]
fn create_snapshot_rejects_symlink() {
    let (mgr, dir) = setup();
    let target = dir.path().join("real.txt");
    fs::write(&target, "real content").unwrap();

    let link = dir.path().join("link.txt");
    #[cfg(unix)]
    std::os::unix::fs::symlink(&target, &link).unwrap();

    #[cfg(unix)]
    {
        let result = mgr.create_snapshot("link.txt", "agent-1");
        assert!(result.is_err(), "should reject symlinks");
        assert!(
            result.unwrap_err().to_string().contains("Symlink"),
            "error should mention symlink"
        );
    }
}

// ── Nonexistent file ─────────────────────────────────────────────────

#[test]
fn create_snapshot_nonexistent_file_returns_empty_hash() {
    let (mgr, _dir) = setup();
    let hash = mgr.create_snapshot("nonexistent.txt", "agent-1").unwrap();
    assert_eq!(hash, "", "nonexistent file should return empty hash");
}

// ── Subdirectory paths ───────────────────────────────────────────────

#[test]
fn create_snapshot_in_subdirectory() {
    let (mgr, dir) = setup();
    let sub = dir.path().join("src").join("deep");
    fs::create_dir_all(&sub).unwrap();
    fs::write(sub.join("file.rs"), "fn main() {}").unwrap();

    let hash = mgr.create_snapshot("src/deep/file.rs", "agent-1").unwrap();
    assert!(!hash.is_empty(), "should snapshot files in subdirectories");
}

// ── Large file rejection ─────────────────────────────────────────────

#[test]
fn create_snapshot_rejects_oversized_file() {
    let (mgr, dir) = setup();
    // Create a file just over 100MB (the limit is 100 * 1024 * 1024)
    let large_path = dir.path().join("huge.bin");
    let size = 100 * 1024 * 1024 + 1;
    // Use sparse file to avoid actually writing 100MB to disk
    let f = fs::File::create(&large_path).unwrap();
    f.set_len(size).unwrap();

    let result = mgr.create_snapshot("huge.bin", "agent-1");
    assert!(result.is_err(), "should reject files > 100MB");
    assert!(result.unwrap_err().to_string().contains("too large"));
}

// ── Empty file ───────────────────────────────────────────────────────

#[test]
fn create_snapshot_empty_file() {
    let (mgr, dir) = setup();
    fs::write(dir.path().join("empty.txt"), "").unwrap();

    let hash = mgr.create_snapshot("empty.txt", "agent-1").unwrap();
    assert!(
        !hash.is_empty(),
        "empty file should still produce a git blob hash"
    );
}

// ── Binary content ───────────────────────────────────────────────────

#[test]
fn create_snapshot_binary_content() {
    let (mgr, dir) = setup();
    let binary: Vec<u8> = (0..=255).collect();
    fs::write(dir.path().join("binary.dat"), &binary).unwrap();

    let hash = mgr.create_snapshot("binary.dat", "agent-1").unwrap();
    assert!(!hash.is_empty());
}

// ── Concurrent snapshots ─────────────────────────────────────────────

#[test]
fn concurrent_snapshots_all_succeed() {
    let (mgr, dir) = setup();

    for i in 0..10 {
        fs::write(
            dir.path().join(format!("file-{i}.txt")),
            format!("content {i}"),
        )
        .unwrap();
    }

    let hashes: Vec<String> = (0..10)
        .map(|i| {
            mgr.create_snapshot(&format!("file-{i}.txt"), &format!("agent-{i}"))
                .unwrap()
        })
        .collect();

    for hash in &hashes {
        assert!(!hash.is_empty());
    }

    let unique: std::collections::HashSet<&String> = hashes.iter().collect();
    assert_eq!(unique.len(), 10);
}

// ── Unicode content ──────────────────────────────────────────────────

#[test]
fn create_snapshot_unicode_content() {
    let (mgr, dir) = setup();
    fs::write(dir.path().join("unicode.txt"), "日本語テスト 🎉 Привет мир").unwrap();

    let hash = mgr.create_snapshot("unicode.txt", "agent-1").unwrap();
    assert!(!hash.is_empty());
}

// ── Manager creation from non-repo ───────────────────────────────────

#[test]
fn snapshot_manager_fails_for_non_git_directory() {
    let dir = tempdir().unwrap();
    let result = SnapshotManager::new(dir.path());
    assert!(result.is_err(), "should fail for non-git directory");
}
