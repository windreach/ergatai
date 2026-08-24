//! Integration tests for TaskCoordinator — create_plan → parse_plan → cleanup lifecycle.
//!
//! These tests exercise the full plan management workflow using real filesystem
//! operations (temp dirs) to catch path handling, concurrency, and cleanup bugs.

use ergatai_collab::TaskCoordinator;
use std::path::PathBuf;
use tempfile::tempdir;

async fn setup_coordinator() -> (TaskCoordinator, tempfile::TempDir) {
    let dir = tempdir().expect("create temp dir");
    let coord = TaskCoordinator::new(dir.path().to_path_buf());
    coord.init().await.expect("init coordinator");
    (coord, dir)
}

async fn coordinator_at(root: &std::path::Path) -> TaskCoordinator {
    let coord = TaskCoordinator::new(root.to_path_buf());
    coord.init().await.expect("init coordinator");
    coord
}

// ── create_plan ──────────────────────────────────────────────────────

#[tokio::test]
async fn create_plan_writes_file_and_returns_path() {
    let (coord, _dir) = setup_coordinator().await;

    let path = coord
        .create_plan("task-1", "# Plan\nDo the thing")
        .await
        .unwrap();

    assert!(path.exists(), "plan file should exist");
    assert_eq!(path.file_name().unwrap(), "task-1.md");
    let content = tokio::fs::read_to_string(&path).await.unwrap();
    assert_eq!(content, "# Plan\nDo the thing");
}

#[tokio::test]
async fn create_plan_overwrites_existing() {
    let (coord, _dir) = setup_coordinator().await;

    coord.create_plan("task-2", "version 1").await.unwrap();
    coord.create_plan("task-2", "version 2").await.unwrap();

    // Read back via create_plan's returned path pattern
    let path = coord.create_plan("task-2", "version 2").await.unwrap();
    let content = tokio::fs::read_to_string(&path).await.unwrap();
    assert_eq!(content, "version 2");
}

#[tokio::test]
async fn create_plan_rejects_path_traversal() {
    let (coord, _dir) = setup_coordinator().await;

    let result = coord.create_plan("../evil", "malicious").await;
    assert!(result.is_err(), "should reject path traversal in task_id");
}

#[tokio::test]
async fn create_plan_rejects_slash_in_task_id() {
    let (coord, _dir) = setup_coordinator().await;

    let result = coord.create_plan("foo/bar", "content").await;
    assert!(result.is_err(), "should reject slash in task_id");
}

#[tokio::test]
async fn create_multiple_plans_independent() {
    let (coord, _dir) = setup_coordinator().await;

    let p1 = coord.create_plan("alpha", "plan A").await.unwrap();
    let p2 = coord.create_plan("beta", "plan B").await.unwrap();
    let p3 = coord.create_plan("gamma", "plan C").await.unwrap();

    assert!(p1.exists());
    assert!(p2.exists());
    assert!(p3.exists());

    assert_eq!(tokio::fs::read_to_string(&p1).await.unwrap(), "plan A");
    assert_eq!(tokio::fs::read_to_string(&p2).await.unwrap(), "plan B");
    assert_eq!(tokio::fs::read_to_string(&p3).await.unwrap(), "plan C");
}

// ── parse_plan ───────────────────────────────────────────────────────

#[tokio::test]
async fn parse_plan_extracts_task_info() {
    let (coord, _dir) = setup_coordinator().await;

    let content = r#"# Task: Implement Feature X
**Coordinator**: @planner

### @coder - Write Implementation
**Objective**: Write the implementation
**Type**: implementation

### @reviewer - Review PR
**Objective**: Review the PR
**Type**: review

## Merge Strategy
Rebase onto main
"#;
    let path = coord.create_plan("parse-test", content).await.unwrap();
    let plan = coord.parse_plan(&path).await.unwrap();

    assert_eq!(plan.task_id, "parse-test");
    assert_eq!(plan.task_name, "Implement Feature X");
    assert_eq!(plan.coordinator, "@planner");
    assert_eq!(plan.assignments.len(), 2);
    assert_eq!(plan.assignments[0].agent_name, "coder");
    assert_eq!(plan.assignments[1].agent_name, "reviewer");
}

#[tokio::test]
async fn parse_plan_missing_file_returns_error() {
    let (coord, _dir) = setup_coordinator().await;

    let fake_path = PathBuf::from("/nonexistent/plan.md");
    let result = coord.parse_plan(&fake_path).await;
    assert!(result.is_err());
}

// ── cleanup_task ─────────────────────────────────────────────────────

#[tokio::test]
async fn cleanup_removes_plan_file() {
    let (coord, _dir) = setup_coordinator().await;

    let path = coord
        .create_plan("to-cleanup", "temporary plan")
        .await
        .unwrap();
    assert!(path.exists());

    coord.cleanup_task("to-cleanup").await.unwrap();
    assert!(!path.exists(), "plan file should be removed after cleanup");
}

#[tokio::test]
async fn cleanup_nonexistent_task_is_ok() {
    let (coord, _dir) = setup_coordinator().await;

    let result = coord.cleanup_task("never-existed").await;
    assert!(result.is_ok());
}

#[tokio::test]
async fn cleanup_rejects_path_traversal() {
    let (coord, _dir) = setup_coordinator().await;

    let result = coord.cleanup_task("../evil").await;
    assert!(result.is_err(), "should reject path traversal in cleanup");
}

// ── Full lifecycle ───────────────────────────────────────────────────

#[tokio::test]
async fn full_lifecycle_create_parse_cleanup() {
    let (coord, _dir) = setup_coordinator().await;

    let content = r#"# Task: Fix Bug #42
**Coordinator**: @lead

### @dev - Fix the Bug
**Objective**: Fix the bug
**Type**: bugfix

### @qa - Regression Test
**Objective**: Write regression test
**Type**: test

## Merge Strategy
Squash merge
"#;
    let path = coord.create_plan("bug-42", content).await.unwrap();
    assert!(path.exists());

    let plan = coord.parse_plan(&path).await.unwrap();
    assert_eq!(plan.task_id, "bug-42");
    assert_eq!(plan.task_name, "Fix Bug #42");
    assert_eq!(plan.coordinator, "@lead");
    assert_eq!(plan.assignments.len(), 2);

    coord.cleanup_task("bug-42").await.unwrap();
    assert!(!path.exists());
}

// ── Concurrent plan creation ─────────────────────────────────────────

#[tokio::test]
async fn concurrent_plan_creation_all_succeed() {
    let (_coord, dir) = setup_coordinator().await;
    let root = dir.path().to_path_buf();

    let mut handles = Vec::new();
    for i in 0..20 {
        let root = root.clone();
        handles.push(tokio::spawn(async move {
            let c = coordinator_at(&root).await;
            c.create_plan(&format!("concurrent-{i}"), &format!("plan {i}"))
                .await
                .unwrap()
        }));
    }

    let results = futures::future::join_all(handles).await;
    for (i, handle_result) in results.into_iter().enumerate() {
        let path = handle_result.unwrap();
        assert!(path.exists(), "concurrent plan {i} should exist");
    }
}

// ── Empty and large content ──────────────────────────────────────────

#[tokio::test]
async fn create_plan_with_empty_content() {
    let (coord, _dir) = setup_coordinator().await;

    let path = coord.create_plan("empty", "").await.unwrap();
    assert!(path.exists());
    let content = tokio::fs::read_to_string(&path).await.unwrap();
    assert_eq!(content, "");
}

#[tokio::test]
async fn create_plan_with_large_content() {
    let (coord, _dir) = setup_coordinator().await;

    let content = "x".repeat(100 * 1024);
    let path = coord.create_plan("large", &content).await.unwrap();
    assert!(path.exists());
    let read_back = tokio::fs::read_to_string(&path).await.unwrap();
    assert_eq!(read_back.len(), 100 * 1024);
}

// ── Unicode task IDs ─────────────────────────────────────────────────

#[tokio::test]
async fn create_plan_with_unicode_task_id() {
    let (coord, _dir) = setup_coordinator().await;

    let path = coord
        .create_plan("task-日本語", "unicode plan")
        .await
        .unwrap();
    assert!(path.exists());
}
