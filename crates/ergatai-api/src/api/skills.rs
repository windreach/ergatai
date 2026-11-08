use axum::extract::Query;
use axum::Json;
use serde::Deserialize;

#[derive(Debug, Deserialize)]
pub struct ListSkillsQuery {
    pub cwd: Option<String>,
}

pub async fn list_skills(Query(q): Query<ListSkillsQuery>) -> Json<serde_json::Value> {
    let skills = crate::services::skills_service::list_skills(q.cwd.as_deref());
    Json(serde_json::json!({ "skills": skills }))
}

/// GET /api/v1/plugins
///
/// Returns the Claude marketplace plugin scan. This is a global (non-agent)
/// endpoint so the frontend does not need to pass a dummy agent id.
pub async fn list_plugins() -> Json<serde_json::Value> {
    let plugins = crate::services::discovery_service::list_plugins();
    Json(serde_json::json!({ "plugins": plugins }))
}
