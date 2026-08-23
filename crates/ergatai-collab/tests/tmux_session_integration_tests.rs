//! Integration tests for TmuxManager::create_session — real tmux binary required.
//!
//! These tests create actual detached tmux sessions, verify their existence,
//! and clean them up. They require `tmux` to be installed and in PATH.

use ergatai_collab::TmuxManager;

/// Generate a unique session name for test isolation.
fn unique_session_name() -> String {
    format!(
        "ergatai-test-{}",
        uuid::Uuid::new_v4().to_string().split('-').next().unwrap()
    )
}

/// Check if a tmux session exists.
async fn session_exists(name: &str) -> bool {
    let output = tokio::process::Command::new("tmux")
        .args(["has-session", "-t", name])
        .output()
        .await;
    match output {
        Ok(o) => o.status.success(),
        Err(_) => false,
    }
}

/// Kill a tmux session, ignoring errors (already dead is fine).
async fn kill_session(name: &str) {
    let _ = tokio::process::Command::new("tmux")
        .args(["kill-session", "-t", name])
        .output()
        .await;
}

/// Check tmux is available; return None to skip the test if not.
async fn require_tmux() -> Option<()> {
    let output = tokio::process::Command::new("tmux")
        .arg("-V")
        .output()
        .await;
    match output {
        Ok(o) if o.status.success() => Some(()),
        _ => {
            eprintln!("⚠️  Skipping (tmux not available)");
            None
        }
    }
}

// ── create_session ───────────────────────────────────────────────────

#[tokio::test]
async fn create_session_succeeds_and_session_exists() {
    if require_tmux().await.is_none() { return; }
    let name = unique_session_name();
    let mgr = TmuxManager::new(&name);

    let result = mgr.create_session(80, 24).await;
    assert!(result.is_ok(), "create_session failed: {:?}", result.err());

    assert!(
        session_exists(&name).await,
        "session should exist after creation"
    );

    // Cleanup
    kill_session(&name).await;
    assert!(
        !session_exists(&name).await,
        "session should be gone after kill"
    );
}

#[tokio::test]
async fn create_session_with_large_dimensions() {
    if require_tmux().await.is_none() { return; }
    let name = unique_session_name();
    let mgr = TmuxManager::new(&name);

    let result = mgr.create_session(200, 50).await;
    assert!(
        result.is_ok(),
        "large dimensions should work: {:?}",
        result.err()
    );

    kill_session(&name).await;
}

#[tokio::test]
async fn create_session_with_minimum_dimensions() {
    if require_tmux().await.is_none() { return; }
    let name = unique_session_name();
    let mgr = TmuxManager::new(&name);

    let result = mgr.create_session(1, 1).await;
    assert!(
        result.is_ok(),
        "minimum dimensions should work: {:?}",
        result.err()
    );

    kill_session(&name).await;
}

#[tokio::test]
async fn create_session_duplicate_name_fails() {
    if require_tmux().await.is_none() { return; }
    let name = unique_session_name();
    let mgr = TmuxManager::new(&name);

    // First creation succeeds
    mgr.create_session(80, 24).await.unwrap();
    assert!(session_exists(&name).await);

    // Second creation with same name should fail
    let result = mgr.create_session(80, 24).await;
    assert!(result.is_err(), "duplicate session name should fail");

    kill_session(&name).await;
}

// ── kill_session ─────────────────────────────────────────────────────

#[tokio::test]
async fn kill_session_removes_existing_session() {
    if require_tmux().await.is_none() { return; }
    let name = unique_session_name();
    let mgr = TmuxManager::new(&name);

    mgr.create_session(80, 24).await.unwrap();
    assert!(session_exists(&name).await);

    let result = mgr.kill_session().await;
    assert!(result.is_ok(), "kill_session should succeed");
    assert!(!session_exists(&name).await, "session should be gone");
}

#[tokio::test]
async fn kill_session_nonexistent_does_not_panic() {
    if require_tmux().await.is_none() { return; }
    let name = unique_session_name();
    let mgr = TmuxManager::new(&name);

    // Session doesn't exist — kill may error but shouldn't panic
    let _result = mgr.kill_session().await;
}

// ── check_tmux ───────────────────────────────────────────────────────

#[tokio::test]
async fn check_tmux_succeeds_when_installed() {
    if require_tmux().await.is_none() { return; }
    let result = TmuxManager::check_tmux().await;
    assert!(
        result.is_ok(),
        "check_tmux should succeed when tmux is installed"
    );
}

// ── Multiple sessions ────────────────────────────────────────────────

#[tokio::test]
async fn multiple_independent_sessions() {
    if require_tmux().await.is_none() { return; }

    let name1 = unique_session_name();
    let name2 = unique_session_name();
    let mgr1 = TmuxManager::new(&name1);
    let mgr2 = TmuxManager::new(&name2);

    mgr1.create_session(80, 24).await.unwrap();
    mgr2.create_session(100, 30).await.unwrap();

    assert!(session_exists(&name1).await);
    assert!(session_exists(&name2).await);

    // Kill one, the other survives
    mgr1.kill_session().await.unwrap();
    assert!(!session_exists(&name1).await);
    assert!(
        session_exists(&name2).await,
        "other session should survive"
    );

    kill_session(&name2).await;
}

// ── Session name edge cases ──────────────────────────────────────────

#[tokio::test]
async fn session_name_with_dashes() {
    if require_tmux().await.is_none() { return; }
    let name = format!("{}-test-session", unique_session_name());
    let mgr = TmuxManager::new(&name);

    let result = mgr.create_session(80, 24).await;
    assert!(
        result.is_ok(),
        "dashes in name should work: {:?}",
        result.err()
    );

    kill_session(&name).await;
}

#[tokio::test]
async fn session_name_with_underscores() {
    if require_tmux().await.is_none() { return; }
    let name = format!("{}-test_session", unique_session_name());
    let mgr = TmuxManager::new(&name);

    let result = mgr.create_session(80, 24).await;
    assert!(
        result.is_ok(),
        "underscores in name should work: {:?}",
        result.err()
    );

    kill_session(&name).await;
}
