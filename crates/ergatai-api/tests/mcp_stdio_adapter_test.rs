//! Integration tests for MCP stdio-HTTP adapter

use std::io::Write;
use std::process::{Command, Stdio};

/// Test that the adapter binary exists and runs
#[test]
fn test_adapter_binary_exists() {
    let output = Command::new("cargo")
        .args(["build", "--bin", "mcp-stdio-adapter"])
        .current_dir(env!("CARGO_MANIFEST_DIR"))
        .output()
        .expect("Failed to build adapter");

    assert!(output.status.success(), "Adapter build failed");
}

/// Test adapter help message
#[test]
fn test_adapter_help() {
    let output = Command::new("cargo")
        .args(["run", "--bin", "mcp-stdio-adapter", "--", "--help"])
        .current_dir(env!("CARGO_MANIFEST_DIR"))
        .output()
        .expect("Failed to run adapter");

    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(stdout.contains("MCP stdio to HTTP bridge adapter"));
    assert!(stdout.contains("--url"));
    assert!(stdout.contains("--token"));
}

/// Test adapter with invalid JSON input
#[test]
fn test_adapter_invalid_json() {
    let mut child = Command::new("cargo")
        .args([
            "run",
            "--bin",
            "mcp-stdio-adapter",
            "--",
            "--url",
            "http://localhost:9999/mcp",
        ])
        .current_dir(env!("CARGO_MANIFEST_DIR"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("Failed to spawn adapter");

    // Send invalid JSON
    {
        let stdin = child.stdin.as_mut().expect("Failed to open stdin");
        stdin
            .write_all(b"not a json\n")
            .expect("Failed to write to stdin");
    }

    let output = child
        .wait_with_output()
        .expect("Failed to wait for adapter");
    let stdout = String::from_utf8_lossy(&output.stdout);

    // Should return a JSON-RPC error
    assert!(stdout.contains("\"jsonrpc\":\"2.0\""));
    assert!(stdout.contains("\"error\""));
    assert!(stdout.contains("-32700")); // Parse error
}

/// Test adapter with valid JSON-RPC request (will fail to connect, but should handle gracefully)
#[test]
fn test_adapter_valid_json_no_server() {
    let mut child = Command::new("cargo")
        .args([
            "run",
            "--bin",
            "mcp-stdio-adapter",
            "--",
            "--url",
            "http://localhost:9999/mcp",
            "--timeout",
            "1",
        ])
        .current_dir(env!("CARGO_MANIFEST_DIR"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("Failed to spawn adapter");

    // Send valid JSON-RPC request
    {
        let stdin = child.stdin.as_mut().expect("Failed to open stdin");
        stdin
            .write_all(b"{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/list\"}\n")
            .expect("Failed to write to stdin");
    }

    // Close stdin to signal EOF
    drop(child.stdin.take());

    let output = child
        .wait_with_output()
        .expect("Failed to wait for adapter");
    let stdout = String::from_utf8_lossy(&output.stdout);

    // Should return an error response (connection refused)
    // The exact error depends on whether the HTTP request times out or fails immediately
    assert!(stdout.contains("\"jsonrpc\":\"2.0\""));
    // Either an error or a timeout response
    assert!(stdout.contains("\"error\"") || stdout.is_empty() || output.status.code() != Some(0));
}

/// Test adapter with multiple requests
#[test]
fn test_adapter_multiple_requests() {
    let mut child = Command::new("cargo")
        .args([
            "run",
            "--bin",
            "mcp-stdio-adapter",
            "--",
            "--url",
            "http://localhost:9999/mcp",
            "--timeout",
            "1",
        ])
        .current_dir(env!("CARGO_MANIFEST_DIR"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("Failed to spawn adapter");

    // Send multiple requests
    {
        let stdin = child.stdin.as_mut().expect("Failed to open stdin");
        stdin
            .write_all(b"{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\"}\n")
            .expect("Failed to write request 1");
        stdin
            .write_all(b"invalid json\n")
            .expect("Failed to write invalid request");
        stdin
            .write_all(b"{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/list\"}\n")
            .expect("Failed to write request 2");
    }

    drop(child.stdin.take());

    let output = child
        .wait_with_output()
        .expect("Failed to wait for adapter");
    let stdout = String::from_utf8_lossy(&output.stdout);

    // Should have multiple responses (one per request)
    let responses: Vec<&str> = stdout.lines().collect();
    assert!(
        responses.len() >= 2,
        "Expected at least 2 responses, got {}",
        responses.len()
    );

    // First response should be for initialize
    assert!(responses[0].contains("\"jsonrpc\":\"2.0\""));

    // Second response should be a parse error
    assert!(responses[1].contains("-32700"));
}
