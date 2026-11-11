use axum::extract::Query;
use axum::Json;
use serde::Deserialize;

#[derive(Debug, Deserialize)]
pub struct ListSkillsQuery {
    pub cwd: Option<String>,
}

pub async fn list_skills(Query(q): Query<ListSkillsQuery>) -> Json<serde_json::Value> {
    let skills = crate::services::skills_service::list_skills(q.cwd.as_deref(), None);
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

/// GET /api/v1/discovery/static
///
/// Static discovery: returns filesystem-based sources (convention_skills + plugins)
/// without requiring an agent_id. Usable in new-chat / no-agent scenarios.
#[derive(Debug, Deserialize)]
pub struct StaticDiscoveryQuery {
    pub cwd: Option<String>,
    pub agent: Option<String>,
    pub refresh: Option<String>,
}

pub async fn get_static_discovery(
    Query(q): Query<StaticDiscoveryQuery>,
) -> Json<serde_json::Value> {
    let refresh = q.refresh.as_deref() == Some("1") || q.refresh.as_deref() == Some("true");
    let result = crate::services::discovery_service::discover_static(
        q.cwd.as_deref(),
        q.agent.as_deref(),
        refresh,
    )
    .await;
    Json(result)
}

/// GET /api/v1/triggers
///
/// Returns the registered triggers for the editor (/, @, etc.).
/// When agent_id is provided, returns triggers with full types (skill, command, mcp, plugin, agent).
/// Without agent_id, returns static triggers (skill, plugin only).
///
/// This endpoint is independent of discovery, allowing frontend to cache trigger config separately.
#[derive(Debug, Deserialize)]
pub struct TriggersQuery {
    pub cwd: Option<String>,
    pub agent_id: Option<String>,
}

pub async fn get_triggers(Query(q): Query<TriggersQuery>) -> Json<serde_json::Value> {
    let triggers =
        crate::services::discovery_service::get_triggers(q.agent_id.as_deref(), q.cwd.as_deref())
            .await;
    Json(serde_json::json!({ "triggers": triggers }))
}
