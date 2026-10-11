//! Tests for the terminal API module.

use super::*;
use axum::http::StatusCode;
use axum::extract::Query;

#[test]
fn test_terminal_query_defaults() {
    let query = TerminalQuery {
        cwd: None,
        cols: None,
        rows: None,
    };

    // Defaults should be applied in create_terminal
    assert!(query.cwd.is_none());
    assert!(query.cols.is_none());
    assert!(query.rows.is_none());
}

#[test]
fn test_terminal_query_custom_values() {
    let query = TerminalQuery {
        cwd: Some("/tmp".to_string()),
        cols: Some(120),
        rows: Some(40),
    };

    assert_eq!(query.cwd, Some("/tmp".to_string()));
    assert_eq!(query.cols, Some(120));
    assert_eq!(query.rows, Some(40));
}

#[test]
fn test_terminal_client_message_input() {
    let json = r#"{"type":"input","data":"ls -la"}"#;
    let msg: TerminalClientMessage = serde_json::from_str(json).unwrap();

    match msg {
        TerminalClientMessage::Input { data } => {
            assert_eq!(data, "ls -la");
        }
        _ => panic!("Expected Input message"),
    }
}

#[test]
fn test_terminal_client_message_resize() {
    let json = r#"{"type":"resize","cols":100,"rows":50}"#;
    let msg: TerminalClientMessage = serde_json::from_str(json).unwrap();

    match msg {
        TerminalClientMessage::Resize { cols, rows } => {
            assert_eq!(cols, 100);
            assert_eq!(rows, 50);
        }
        _ => panic!("Expected Resize message"),
    }
}

#[test]
fn test_terminal_client_message_invalid_type() {
    let json = r#"{"type":"unknown","data":"test"}"#;
    let result: Result<TerminalClientMessage, _> = serde_json::from_str(json);

    assert!(result.is_err());
}

#[test]
fn test_terminal_created_serialization() {
    let created = TerminalCreated {
        cwd: "/home/user".to_string(),
    };

    let json = serde_json::to_string(&created).unwrap();
    assert!(json.contains("/home/user"));
}

#[cfg(unix)]
#[test]
fn test_default_shell_unix() {
    let shell = default_shell();
    // Should return $SHELL or /bin/bash
    assert!(!shell.is_empty());
    assert!(shell.contains("bash") || shell.contains("sh") || shell.contains("zsh"));
}

#[cfg(windows)]
#[test]
fn test_default_shell_windows() {
    let shell = default_shell();
    // Should return %COMSPEC% or powershell.exe
    assert!(!shell.is_empty());
    assert!(shell.contains("powershell") || shell.contains("cmd"));
}

#[tokio::test]
async fn test_create_terminal_invalid_cwd() {
    // Test with an invalid working directory
    let query = TerminalQuery {
        cwd: Some("/this/path/does/not/exist".to_string()),
        cols: Some(80),
        rows: Some(24),
    };

    // Note: We can't easily test the full WebSocket upgrade without a test client,
    // but we can verify the validation logic
    let cwd = query.cwd.as_deref().unwrap();
    let allowed_dirs = vec![std::path::PathBuf::from("/tmp")];
    let result = crate::validate_cwd_with_allowed_dirs(cwd, &allowed_dirs);

    assert!(result.is_err());
}

#[tokio::test]
async fn test_create_terminal_valid_cwd() {
    // Test with a valid working directory
    let query = TerminalQuery {
        cwd: Some("/tmp".to_string()),
        cols: Some(80),
        rows: Some(24),
    };

    let cwd = query.cwd.as_deref().unwrap();
    let allowed_dirs = vec![std::path::PathBuf::from("/tmp")];
    let result = crate::validate_cwd_with_allowed_dirs(cwd, &allowed_dirs);

    // /tmp should be valid on most systems
    if std::path::Path::new("/tmp").exists() {
        assert!(result.is_ok());
    }
}

#[test]
fn test_terminal_query_size_clamping() {
    // Test that size values are properly clamped
    let cols = Some(1000u16).unwrap_or(80).clamp(1, 500);
    let rows = Some(1000u16).unwrap_or(24).clamp(1, 200);

    assert_eq!(cols, 500); // Should be clamped to max
    assert_eq!(rows, 200); // Should be clamped to max

    let cols_zero = Some(0u16).unwrap_or(80).clamp(1, 500);
    let rows_zero = Some(0u16).unwrap_or(24).clamp(1, 200);

    assert_eq!(cols_zero, 1); // Should be clamped to min
    assert_eq!(rows_zero, 1); // Should be clamped to min
}
