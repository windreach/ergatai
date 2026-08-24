//! Integration tests for ergatai-pty
//!
//! These tests spawn real processes via PTY and verify read/write operations.

use ergatai_pty::{PtyConfig, PtyProcess};

/// Spawn a simple `cat` process, write to it, and read back.
#[tokio::test]
async fn pty_spawn_cat_and_echo() {
    let config = PtyConfig {
        command: "cat".into(),
        args: vec![],
        rows: 24,
        cols: 80,
    };

    let process = PtyProcess::spawn(config).expect("failed to spawn cat");

    // Give cat a moment to start
    tokio::time::sleep(tokio::time::Duration::from_millis(100)).await;

    // Write a message
    process
        .write(b"hello from pty\n")
        .await
        .expect("failed to write");

    // Read the echo back
    let mut buf = [0u8; 1024];
    let clean = tokio::time::timeout(
        tokio::time::Duration::from_secs(2),
        process.read_clean(&mut buf),
    )
    .await
    .expect("timeout waiting for cat echo")
    .expect("failed to read");

    assert!(
        clean.contains("hello from pty"),
        "expected 'hello from pty' in output, got: {:?}",
        clean
    );

    // Verify process is still alive
    assert!(!process.has_exited().await, "cat should still be running");

    // Send SIGTERM
    process
        .signal(nix::sys::signal::Signal::SIGTERM)
        .expect("failed to send SIGTERM");

    // Wait for exit
    let code = tokio::time::timeout(
        tokio::time::Duration::from_secs(2),
        process.wait(),
    )
    .await
    .expect("timeout waiting for cat to exit")
    .expect("failed to wait");

    // SIGTERM → exit code 143 (128 + 15)
    assert_eq!(code, 143, "expected exit code 143 (SIGTERM)");
}

/// Spawn `echo` and verify it exits immediately after printing.
#[tokio::test]
async fn pty_spawn_echo_exits() {
    let config = PtyConfig {
        command: "echo".into(),
        args: vec!["pty_test_output".into()],
        rows: 24,
        cols: 80,
    };

    let process = PtyProcess::spawn(config).expect("failed to spawn echo");

    // Wait for exit
    let code = tokio::time::timeout(
        tokio::time::Duration::from_secs(2),
        process.wait(),
    )
    .await
    .expect("timeout waiting for echo to exit")
    .expect("failed to wait");

    assert_eq!(code, 0, "echo should exit with code 0");
}

/// Spawn `sh -c "echo hello"` and read the output.
#[tokio::test]
async fn pty_spawn_sh_and_read() {
    let config = PtyConfig {
        command: "sh".into(),
        args: vec!["-c".into(), "echo pty_shell_test".into()],
        rows: 24,
        cols: 80,
    };

    let process = PtyProcess::spawn(config).expect("failed to spawn sh");

    // Read output
    let mut buf = [0u8; 1024];
    let mut output = String::new();

    // Read until process exits
    for _ in 0..20 {
        match process.read_clean(&mut buf).await {
            Ok(text) if !text.is_empty() => output.push_str(&text),
            _ => {}
        }

        if process.has_exited().await {
            break;
        }
        tokio::time::sleep(tokio::time::Duration::from_millis(100)).await;
    }

    assert!(
        output.contains("pty_shell_test"),
        "expected 'pty_shell_test' in output, got: {:?}",
        output
    );
}
