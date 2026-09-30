use axum::{http::StatusCode, response::IntoResponse, response::Response, Json};

use crate::api::ApiError;

/// Validate a project ID.
///
/// Accepts the Snowflake format: `proj_{timestamp}_{instance}_{sequence}`
/// Also accepts the legacy format: `proj_{32 hex chars}` for backwards compatibility.
pub fn is_valid_project_id(id: &str) -> bool {
    let Some(rest) = id.strip_prefix("proj_") else {
        return false;
    };

    if rest.is_empty() {
        return false;
    }

    // Snowflake format: proj_{timestamp}_{instance}_{sequence}
    let parts: Vec<&str> = rest.split('_').collect();
    if parts.len() == 3 {
        // All parts must be non-empty and contain only digits
        let timestamp_ok = !parts[0].is_empty() && parts[0].bytes().all(|b| b.is_ascii_digit());
        let instance_ok = parts[1]
            .parse::<u64>()
            .map(|val| val <= 1023)
            .unwrap_or(false);
        let sequence_ok = !parts[2].is_empty() && parts[2].bytes().all(|b| b.is_ascii_digit());
        return timestamp_ok && instance_ok && sequence_ok;
    }

    // Legacy format: proj_{32 lowercase hex chars}
    rest.len() == 32 && rest.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

pub fn invalid_project_id_response() -> Response {
    (
        StatusCode::BAD_REQUEST,
        Json(ApiError {
            error: "Invalid project ID".to_string(),
        }),
    )
        .into_response()
}

#[cfg(test)]
mod tests {
    use super::is_valid_project_id;

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
}
