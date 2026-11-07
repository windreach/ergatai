use axum::extract::Query;
use axum::Json;
use serde::Deserialize;

#[derive(Debug, Deserialize)]
pub struct DiscoverQuery {
    pub agent: String,
    pub cwd: Option<String>,
}

pub async fn discover(Query(q): Query<DiscoverQuery>) -> Json<serde_json::Value> {
    Json(crate::services::agent_sdk_service::discover(&q.agent, q.cwd.as_deref()).await)
}
