use axum::{http::StatusCode, response::IntoResponse, response::Response, Json};

use crate::api::ApiError;

pub fn is_valid_project_id(id: &str) -> bool {
    let Some(hex) = id.strip_prefix("proj_") else {
        return false;
    };

    hex.len() == 32
        && hex
            .bytes()
            .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
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
    fn accepts_only_canonical_project_ids() {
        assert!(is_valid_project_id("proj_0123456789abcdef0123456789abcdef"));
    }

    #[test]
    fn rejects_non_canonical_project_ids() {
        assert!(!is_valid_project_id(""));
        assert!(!is_valid_project_id(
            "workspace_0123456789abcdef0123456789abcdef"
        ));
        assert!(!is_valid_project_id(
            "proj_0123456789ABCDEF0123456789abcdef"
        ));
        assert!(!is_valid_project_id("proj_0123456789abcdef0123456789abcde"));
        assert!(!is_valid_project_id(
            "proj_0123456789abcdef0123456789abcdeg"
        ));
    }
}
