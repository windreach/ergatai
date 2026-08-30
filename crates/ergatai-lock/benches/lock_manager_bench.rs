//! Benchmarks for ergatai-lock hot paths.
//!
//! Run with: `cargo bench -p ergatai-lock`
//!
//! Benchmarks cover the file lock manager's most-called methods:
//! - `check_file_lock_status`: sync query, called on every fanotify event
//! - `is_file_locked`: sync boolean check
//! - `acquire_lock` / `release_lock`: async lock lifecycle

use criterion::{black_box, criterion_group, criterion_main, BenchmarkId, Criterion, Throughput};
use ergatai_lock::{FileLockManager, FileMode, FileToken, SystemToken};
use std::sync::Arc;
use tempfile::TempDir;

/// Create a FileLockManager backed by a temp SQLite DB (no NATS).
fn create_test_manager() -> (FileLockManager, TempDir) {
    let tempdir = TempDir::new().unwrap();
    let project_root = tempdir.path().to_path_buf();
    std::fs::create_dir_all(project_root.join(".ergatai")).unwrap();
    // acquire_lock calls validate_and_normalize_path which canonicalizes,
    // so the `src/` subdirectory must exist for path resolution.
    std::fs::create_dir_all(project_root.join("src")).unwrap();
    let db_path = project_root.join(".ergatai/locks.db");
    let manager = FileLockManager::new(&db_path, project_root.clone(), None).unwrap();
    (manager, tempdir)
}

/// Register a SystemToken + FileToken pair and return them.
fn setup_agent_tokens(
    manager: &FileLockManager,
    agent_id: &str,
    session_id: &str,
    project_root: &str,
) -> (SystemToken, FileToken) {
    let system_token = SystemToken::new(
        agent_id.to_string(),
        session_id.to_string(),
        project_root.to_string(),
        3600,
        30,
    );
    manager.register_system_token(&system_token).unwrap();

    let file_token = FileToken::new(
        agent_id.to_string(),
        session_id.to_string(),
        system_token.id.clone(),
        "**".to_string(),
        FileMode::Write,
        Some("benchmark".to_string()),
        "bench".to_string(),
        3600,
        30,
    );
    (system_token, file_token)
}

// ── Sync benchmarks ──

fn bench_check_file_lock_status(c: &mut Criterion) {
    let (manager, tempdir) = create_test_manager();
    let project_root = tempdir.path().to_string_lossy().to_string();
    let (_sys, file_token) =
        setup_agent_tokens(&manager, "bench-agent", "bench-session", &project_root);

    // Acquire a lock so check_file_lock_status has something to find
    let rt = tokio::runtime::Runtime::new().unwrap();
    rt.block_on(manager.acquire_lock(&file_token, "src/main.rs"))
        .unwrap();

    let mut group = c.benchmark_group("check_file_lock_status");
    group.throughput(Throughput::Elements(1));
    group.bench_function("locked_file", |b| {
        b.iter(|| black_box(manager.check_file_lock_status("src/main.rs")).unwrap())
    });
    group.bench_function("unlocked_file", |b| {
        b.iter(|| black_box(manager.check_file_lock_status("src/other.rs")).unwrap())
    });
    group.finish();
}

fn bench_is_file_locked(c: &mut Criterion) {
    let (manager, tempdir) = create_test_manager();
    let project_root = tempdir.path().to_string_lossy().to_string();
    let (_sys, file_token) =
        setup_agent_tokens(&manager, "bench-agent", "bench-session", &project_root);

    let rt = tokio::runtime::Runtime::new().unwrap();
    rt.block_on(manager.acquire_lock(&file_token, "src/main.rs"))
        .unwrap();

    let mut group = c.benchmark_group("is_file_locked");
    group.throughput(Throughput::Elements(1));
    group.bench_function("locked", |b| {
        b.iter(|| black_box(manager.is_file_locked("src/main.rs")).unwrap())
    });
    group.bench_function("unlocked", |b| {
        b.iter(|| black_box(manager.is_file_locked("src/other.rs")).unwrap())
    });
    group.finish();
}

// ── Async benchmarks ──

fn bench_acquire_release_lock(c: &mut Criterion) {
    let rt = tokio::runtime::Runtime::new().unwrap();

    let mut group = c.benchmark_group("acquire_release_lock");
    group.throughput(Throughput::Elements(1));

    group.bench_function("acquire_then_release", |b| {
        b.iter(|| {
            rt.block_on(async {
                let (manager, tempdir) = create_test_manager();
                let project_root = tempdir.path().to_string_lossy().to_string();
                let (_sys, file_token) =
                    setup_agent_tokens(&manager, "bench-agent", "bench-session", &project_root);

                // Each iteration: acquire lock, then release it
                manager
                    .acquire_lock(&file_token, "src/main.rs")
                    .await
                    .unwrap();
                manager
                    .release_lock(file_token.id.as_str(), "src/main.rs")
                    .await
                    .unwrap();
            });
        })
    });
    group.finish();
}

fn bench_concurrent_lock_checks(c: &mut Criterion) {
    let (manager, tempdir) = create_test_manager();
    let manager = Arc::new(manager);
    let project_root = tempdir.path().to_string_lossy().to_string();

    // Pre-populate with 100 locked files.
    // Register 10 agents (unique agent_id + session_id pairs),
    // then create file tokens to lock 100 files across them.
    let rt = tokio::runtime::Runtime::new().unwrap();
    rt.block_on(async {
        // Register 10 agents first (unique session_ids)
        let mut file_tokens = Vec::new();
        for i in 0..10 {
            let (_sys, file_token) = setup_agent_tokens(
                &manager,
                &format!("agent-{}", i),
                &format!("session-{}", i),
                &project_root,
            );
            file_tokens.push(file_token);
        }
        // Each agent locks 10 files
        for (agent_idx, ft) in file_tokens.iter().enumerate() {
            for j in 0..10 {
                let path = format!("src/file_{}.rs", agent_idx * 10 + j);
                manager.acquire_lock(ft, &path).await.unwrap();
            }
        }
    });

    let mut group = c.benchmark_group("concurrent_lock_checks");
    for &n_files in &[10, 50, 100] {
        group.bench_with_input(
            BenchmarkId::new("check_random_files", n_files),
            &n_files,
            |b, &n| {
                b.iter(|| {
                    for i in 0..n {
                        let path = format!("src/file_{}.rs", i);
                        let _ = black_box(manager.is_file_locked(&path));
                    }
                })
            },
        );
    }
    group.finish();
}

criterion_group!(
    benches,
    bench_check_file_lock_status,
    bench_is_file_locked,
    bench_acquire_release_lock,
    bench_concurrent_lock_checks,
);
criterion_main!(benches);
