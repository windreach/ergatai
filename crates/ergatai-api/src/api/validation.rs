use axum::response::{IntoResponse, Response};

/// Validate a Snowflake-format ID with the given prefix.
///
/// Expected format: `{prefix}_{timestamp}_{instance}_{sequence}`
/// - timestamp: digits only (variable length)
/// - instance: 1-3 digits, value <= 1023
/// - sequence: 1-4 digits
pub fn is_valid_snowflake_id(id: &str, prefix: &str) -> bool {
    let Some(rest) = id.strip_prefix(prefix) else {
        return false;
    };
    let Some(rest) = rest.strip_prefix('_') else {
        return false;
    };
    if rest.is_empty() {
        return false;
    }
    let parts: Vec<&str> = rest.split('_').collect();
    if parts.len() != 3 {
        return false;
    }
    let timestamp_ok = !parts[0].is_empty() && parts[0].bytes().all(|b| b.is_ascii_digit());
    let instance_ok = !parts[1].is_empty()
        && parts[1].bytes().all(|b| b.is_ascii_digit())
        && parts[1].parse::<u64>().map(|v| v <= 1023).unwrap_or(false);
    let sequence_ok = !parts[2].is_empty() && parts[2].bytes().all(|b| b.is_ascii_digit());
    timestamp_ok && instance_ok && sequence_ok
}

/// Validate a project ID.
///
/// Accepts the Snowflake format: `proj_{timestamp}_{instance}_{sequence}`
/// Also accepts the legacy format: `proj_{32 hex chars}` for backwards compatibility.
pub fn is_valid_project_id(id: &str) -> bool {
    // Snowflake format
    if is_valid_snowflake_id(id, "proj") {
        return true;
    }

    // Legacy format: proj_{32 lowercase hex chars}
    let Some(rest) = id.strip_prefix("proj_") else {
        return false;
    };
    if rest.is_empty() {
        return false;
    }
    rest.len() == 32 && rest.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

/// Validate a workspace ID in Snowflake format: `ws_{timestamp}_{instance}_{sequence}`
pub fn is_valid_ws_id(id: &str) -> bool {
    is_valid_snowflake_id(id, "ws")
}

/// Validate a chat ID in Snowflake format: `chat_{timestamp}_{instance}_{sequence}`
pub fn is_valid_chat_id(id: &str) -> bool {
    is_valid_snowflake_id(id, "chat")
}

/// Validate a conversation ID in Snowflake format: `conv_{timestamp}_{instance}_{sequence}`
pub fn is_valid_conversation_id(id: &str) -> bool {
    is_valid_snowflake_id(id, "conv")
}

/// Validate an agent ID in Snowflake format: `agent_{timestamp}_{instance}_{sequence}`
pub fn is_valid_agent_id(id: &str) -> bool {
    is_valid_snowflake_id(id, "agent")
}

pub fn invalid_project_id_response() -> Response {
    crate::http_error::bad_request("Invalid project ID").into_response()
}

#[cfg(test)]
mod tests {
    use super::{
        is_valid_agent_id, is_valid_chat_id, is_valid_conversation_id, is_valid_project_id,
        is_valid_snowflake_id, is_valid_ws_id,
    };

    #[test]
    fn accepts_snowflake_project_ids() {
        assert!(is_valid_project_id("proj_1727568000000_001_0001"));
        assert!(is_valid_project_id("proj_1727568000000_0_0000"));
        assert!(is_valid_project_id("proj_1234567890_1023_4095"));
        assert!(is_valid_project_id("proj_123_1023_001")); // instance at max (1023)
    }

    #[test]
    fn accepts_legacy_project_ids() {
        assert!(is_valid_project_id("proj_0123456789abcdef0123456789abcdef"));
    }

    #[test]
    fn rejects_invalid_project_ids() {
        assert!(!is_valid_project_id(""));
        assert!(!is_valid_project_id("ws_1727568000000_001_0001"));
        assert!(!is_valid_project_id("proj_"));
        assert!(!is_valid_project_id("proj_abc_001_0001")); // non-numeric timestamp
        assert!(!is_valid_project_id("proj_123_001")); // only 2 parts
        assert!(!is_valid_project_id("proj__001_0001")); // empty timestamp
        assert!(!is_valid_project_id("proj_123__0001")); // empty instance
        assert!(!is_valid_project_id("proj_123_001_")); // empty sequence
        assert!(!is_valid_project_id("proj_123_1024_0001")); // instance > 1023
        assert!(!is_valid_project_id("proj_123_9999_0001")); // instance > 1023
        assert!(!is_valid_project_id(
            "proj_0123456789ABCDEF0123456789abcdef"
        )); // uppercase hex
        assert!(!is_valid_project_id("proj_0123456789abcdef0123456789abcde")); // 31 chars
        assert!(!is_valid_project_id(
            "proj_0123456789abcdef0123456789abcdeg"
        )); // invalid hex char
    }

    #[test]
    fn test_snowflake_id_validation() {
        // Valid IDs
        assert!(is_valid_snowflake_id("ws_1234567890_001_0001", "ws"));
        assert!(is_valid_snowflake_id("chat_1727568000000_000_0001", "chat"));
        assert!(is_valid_snowflake_id("conv_123_1023_4095", "conv"));
        assert!(is_valid_snowflake_id("agent_999_0_0", "agent"));

        // Invalid - wrong prefix
        assert!(!is_valid_snowflake_id("ws_123_001_0001", "chat"));

        // Invalid - empty parts
        assert!(!is_valid_snowflake_id("ws__001_0001", "ws"));
        assert!(!is_valid_snowflake_id("ws_123__0001", "ws"));
        assert!(!is_valid_snowflake_id("ws_123_001_", "ws"));

        // Invalid - non-numeric
        assert!(!is_valid_snowflake_id("ws_abc_001_0001", "ws"));
        assert!(!is_valid_snowflake_id("ws_123_abc_0001", "ws"));
        assert!(!is_valid_snowflake_id("ws_123_001_abc", "ws"));

        // Invalid - instance too large
        assert!(!is_valid_snowflake_id("ws_123_1024_0001", "ws"));

        // Invalid - too few/many parts
        assert!(!is_valid_snowflake_id("ws_123_001", "ws"));
        assert!(!is_valid_snowflake_id("ws_123_001_0001_extra", "ws"));
    }

    #[test]
    fn test_typed_id_validators() {
        // Workspace IDs
        assert!(is_valid_ws_id("ws_503232550030_000_0000"));
        assert!(!is_valid_ws_id("ws_invalid"));
        assert!(!is_valid_ws_id("chat_123_001_0001"));

        // Chat IDs
        assert!(is_valid_chat_id("chat_503232550030_000_0000"));
        assert!(!is_valid_chat_id("chat_invalid"));
        assert!(!is_valid_chat_id("ws_123_001_0001"));

        // Conversation IDs
        assert!(is_valid_conversation_id("conv_503232550030_000_0000"));
        assert!(!is_valid_conversation_id("conv_invalid"));

        // Agent IDs
        assert!(is_valid_agent_id("agent_503232550030_000_0000"));
        assert!(!is_valid_agent_id("agent_invalid"));

        // Empty and edge cases
        assert!(!is_valid_ws_id(""));
        assert!(!is_valid_chat_id(""));
        assert!(!is_valid_conversation_id(""));
        assert!(!is_valid_agent_id(""));
    }
}
