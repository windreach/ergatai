//! File lock monitoring REST API handlers.
//!
//! Provides read-only endpoints for the dashboard to query active file locks
//! and audit log entries. All data comes from `FileLockManager` (SQLite WAL).
//!
//! 业务逻辑已迁移到 `crate::services::lock_service`，handler 只负责
//! HTTP 请求解析和响应格式化。

use axum::{
    extract::{Query, State},
    response::IntoResponse,
    Json,
};
use serde::{Deserialize, Serialize};

use crate::services::lock_service;
use crate::AppState;

/// Response item for a single active file lock.
#[derive(Debug, Serialize)]
pub struct LockInfo {
    pub id: String,
    pub file_path: String,
    pub agent_id: String,
    pub session_id: String,
    pub mode: String,
    pub scope: String,
    pub created_at: String,
    pub expires_at: String,
    pub heartbeat_at: String,
    pub status: String,
}

/// Returns true if the file path is an internal system file that should be
/// hidden from the dashboard (git internals, ergatai database, etc.).
fn is_internal_path(path: &str) -> bool {
    path.starts_with(".git/")
        || path.starts_with(".git\\")
        || path == ".git"
        || path.starts_with(".ergatai/")
        || path.starts_with(".ergatai\\")
        || path == ".ergatai"
}

/// GET /api/v1/locks — list all active file locks.
///
/// Internal system files (`.git/`, `.ergatai/`) are filtered out to reduce
/// noise from FileSystemWatcher auto-locks on git objects and database files.
pub async fn list_locks(State(_state): State<AppState>) -> impl IntoResponse {
    let locks = match lock_service::list_active_locks().await {
        Ok(locks) => locks,
        Err(e) => {
            tracing::debug!(error = %e, "File lock manager not initialized");
            return Json(Vec::<LockInfo>::new()).into_response();
        }
    };

    let infos: Vec<LockInfo> = locks
        .into_iter()
        .filter(|l| !is_internal_path(&l.file_path))
        .map(|l| LockInfo {
            id: l.id,
            file_path: l.file_path,
            agent_id: l.agent_id,
            session_id: l.session_id,
            mode: format!("{:?}", l.mode),
            scope: l.scope,
            created_at: l.created_at.to_rfc3339(),
            expires_at: l.expires_at.to_rfc3339(),
            heartbeat_at: l.heartbeat_at.to_rfc3339(),
            status: format!("{:?}", l.status),
        })
        .collect();
    Json(infos).into_response()
}

/// Query parameters for audit log endpoint.
#[derive(Debug, Deserialize)]
pub struct AuditQuery {
    pub agent_id: Option<String>,
    pub action: Option<String>,
    pub file_path: Option<String>,
    #[serde(default = "default_audit_limit")]
    pub limit: usize,
}

fn default_audit_limit() -> usize {
    50
}

/// Maximum number of audit entries returned in a single query.
/// Prevents unbounded memory allocation from malicious or mistaken `?limit=` values.
const MAX_AUDIT_LIMIT: usize = 1000;

/// GET /api/v1/locks/audit — query audit log entries.
pub async fn list_audit(
    State(_state): State<AppState>,
    Query(query): Query<AuditQuery>,
) -> impl IntoResponse {
    let limit = query.limit.min(MAX_AUDIT_LIMIT);
    match lock_service::query_audit(
        query.agent_id.as_deref(),
        query.action.as_deref(),
        query.file_path.as_deref(),
        limit,
    )
    .await
    {
        Ok(entries) => Json(entries).into_response(),
        Err(e) => {
            tracing::debug!(error = %e, "File lock manager not initialized");
            Json(Vec::<ergatai_lock::AuditEntry>::new()).into_response()
        }
    }
}

/// Response for lock contention monitoring
#[derive(Debug, Serialize)]
pub struct LockContentionInfo {
    pub file_path: String,
    pub current_holder: Option<String>,
    pub waiting_agents: Vec<String>,
    pub wait_time_secs: u64,
    pub conflict_count: u32,
}

/// GET /api/v1/locks/contention — get lock contention information
pub async fn get_lock_contention(State(_state): State<AppState>) -> impl IntoResponse {
    match lock_service::get_lock_contention().await {
        Ok(contentions) => {
            let infos: Vec<LockContentionInfo> = contentions
                .into_iter()
                .map(|c| LockContentionInfo {
                    file_path: c.file_path,
                    current_holder: c.current_holder,
                    waiting_agents: c.waiting_agents,
                    wait_time_secs: c.wait_time_secs,
                    conflict_count: c.conflict_count,
                })
                .collect();
            Json(infos).into_response()
        }
        Err(e) => {
            tracing::debug!(error = %e, "File lock manager not initialized");
            Json(Vec::<LockContentionInfo>::new()).into_response()
        }
    }
}

// ── Tests ──

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn test_lock_info_serialization() {
        let info = LockInfo {
            id: "lock-1".to_string(),
            file_path: "src/main.rs".to_string(),
            agent_id: "agent-1".to_string(),
            session_id: "session-1".to_string(),
            mode: "Write".to_string(),
            scope: "**".to_string(),
            created_at: "2026-01-01T00:00:00Z".to_string(),
            expires_at: "2026-01-01T01:00:00Z".to_string(),
            heartbeat_at: "2026-01-01T00:30:00Z".to_string(),
            status: "Active".to_string(),
        };
        let json = serde_json::to_value(&info).unwrap();
        assert_eq!(json["id"], "lock-1");
        assert_eq!(json["file_path"], "src/main.rs");
        assert_eq!(json["agent_id"], "agent-1");
        assert_eq!(json["mode"], "Write");
        assert_eq!(json["status"], "Active");
        // All 10 fields present
        assert_eq!(json.as_object().unwrap().len(), 10);
    }

    #[test]
    fn test_audit_query_all_optional_fields_omitted() {
        let query: AuditQuery = serde_json::from_value(json!({})).unwrap();
        assert!(query.agent_id.is_none());
        assert!(query.action.is_none());
        assert!(query.file_path.is_none());
        assert_eq!(query.limit, 50); // default
    }

    #[test]
    fn test_audit_query_all_fields_provided() {
        let query: AuditQuery = serde_json::from_value(json!({
            "agent_id": "agent-1",
            "action": "acquire_lock",
            "file_path": "src/main.rs",
            "limit": 100
        }))
        .unwrap();
        assert_eq!(query.agent_id.as_deref(), Some("agent-1"));
        assert_eq!(query.action.as_deref(), Some("acquire_lock"));
        assert_eq!(query.file_path.as_deref(), Some("src/main.rs"));
        assert_eq!(query.limit, 100);
    }

    #[test]
    fn test_audit_query_custom_limit() {
        let query: AuditQuery = serde_json::from_value(json!({"limit": 10})).unwrap();
        assert_eq!(query.limit, 10);
    }

    #[test]
    fn test_audit_query_null_optional_fields() {
        let query: AuditQuery = serde_json::from_value(json!({
            "agent_id": null,
            "action": null,
            "file_path": null
        }))
        .unwrap();
        assert!(query.agent_id.is_none());
        assert!(query.action.is_none());
        assert!(query.file_path.is_none());
        assert_eq!(query.limit, 50);
    }

    #[test]
    fn test_default_audit_limit_value() {
        assert_eq!(default_audit_limit(), 50);
    }

    #[test]
    fn test_max_audit_limit_constant() {
        // MAX_AUDIT_LIMIT must be >= default to avoid silently truncating normal queries
        assert!(MAX_AUDIT_LIMIT >= default_audit_limit());
        // Clamping: any user-supplied limit above MAX_AUDIT_LIMIT is capped
        let user_limit = 999_999;
        let effective = user_limit.min(MAX_AUDIT_LIMIT);
        assert_eq!(effective, MAX_AUDIT_LIMIT);
    }

    #[test]
    fn test_is_internal_path_git() {
        assert!(is_internal_path(".git/objects/ab/1234"));
        assert!(is_internal_path(".git/objects/tmp_object_git2_b2193b"));
        assert!(is_internal_path(".git/HEAD"));
        assert!(is_internal_path(".git"));
        // Windows-style
        assert!(is_internal_path(".git\\objects\\ab\\1234"));
    }

    #[test]
    fn test_is_internal_path_ergatai() {
        assert!(is_internal_path(".ergatai/locks.db"));
        assert!(is_internal_path(".ergatai/locks.db-wal"));
        assert!(is_internal_path(".ergatai/ergatai.db"));
        assert!(is_internal_path(".ergatai"));
    }

    #[test]
    fn test_is_internal_path_user_files_not_filtered() {
        assert!(!is_internal_path("src/main.rs"));
        assert!(!is_internal_path("Cargo.toml"));
        assert!(!is_internal_path("README.md"));
        assert!(!is_internal_path("docs/guide.md"));
        assert!(!is_internal_path("crates/ergatai-lock/src/lib.rs"));
    }
}
