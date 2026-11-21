use axum::extract::Query;
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::Json;
use serde::Deserialize;
use serde_json::json;

#[derive(Debug, Deserialize)]
pub struct ReadFileQuery {
    pub path: String,
}

/// GET /api/v1/files/read?path=...
///
/// Read a text file from the backend filesystem. Used by the frontend to read
/// plan files (and other artifacts) without relying on the local Electron
/// main-process file scope.
pub async fn read_file(Query(q): Query<ReadFileQuery>) -> impl IntoResponse {
    match tokio::fs::read_to_string(&q.path).await {
        Ok(content) => (StatusCode::OK, Json(json!({ "content": content }))).into_response(),
        Err(err) => (
            StatusCode::NOT_FOUND,
            Json(json!({ "error": err.to_string() })),
        )
            .into_response(),
    }
}
