//! `get_dag_status` MCP tool — query DAG execution status.

use rmcp::{
    handler::server::wrapper::Parameters,
    model::{CallToolResult, ContentBlock},
    ErrorData,
};
use tracing::info;

use super::super::params::GetDagStatusParams;

pub(crate) async fn handle(
    params: Parameters<GetDagStatusParams>,
) -> Result<CallToolResult, ErrorData> {
    let dag_id = &params.0.dag_id;

    info!("Getting DAG status");

    let info = crate::services::dag_service::get_dag_status(Some(dag_id)).await;

    // Check if this is a completed status loaded from disk
    let is_from_disk = info.progress_detail.is_some() && !info.running;

    if !info.running && info.is_complete != Some(true) {
        // No active DAG and no disk-loaded status
        let result = serde_json::json!({
            "status": "no_dag",
            "message": "No DAG scheduler is active",
        });
        return Ok(CallToolResult::success(vec![ContentBlock::text(
            serde_json::to_string_pretty(&result).unwrap_or_default(),
        )]));
    }

    if is_from_disk {
        // Disk-loaded completed status
        let nodes: Vec<serde_json::Value> = info
            .nodes
            .unwrap_or_default()
            .iter()
            .map(|n| {
                serde_json::json!({
                    "id": n.id,
                    "task": n.task,
                    "agent": n.agent,
                    "status": n.status,
                })
            })
            .collect();

        let collab =
            info.collaboration
                .unwrap_or(crate::services::dag_service::DagCollaborationInfo {
                    dag_id: "unknown".to_string(),
                    policy: "N/A".to_string(),
                    participants: Vec::new(),
                    participant_count: 0,
                    created_at: "N/A".to_string(),
                });

        let detail = info.progress_detail.unwrap();

        let result = serde_json::json!({
            "status": "completed",
            "progress": {
                "completed": detail.completed,
                "failed": detail.failed,
                "total": detail.total,
                "percent": detail.percent,
            },
            "is_complete": true,
            "graph_status": info.status_prompt.unwrap_or_default(),
            "graph_snapshot": nodes,
            "collaboration": {
                "dag_id": collab.dag_id,
                "policy": collab.policy,
                "participants": collab.participants,
                "participant_count": collab.participant_count,
                "created_at": collab.created_at,
            },
            "source": "disk",
            "message": "DAG has completed. Scheduler was removed from memory; this status was loaded from persisted state.",
        });
        return Ok(CallToolResult::success(vec![ContentBlock::text(
            serde_json::to_string_pretty(&result).unwrap_or_default(),
        )]));
    }

    // Active DAG status
    let detail = info
        .progress_detail
        .unwrap_or(crate::services::dag_service::DagProgressDetail {
            completed: 0,
            running: 0,
            failed: 0,
            pending: 0,
            total: 0,
            percent: 0,
        });

    let collab = info
        .collaboration
        .unwrap_or(crate::services::dag_service::DagCollaborationInfo {
            dag_id: String::new(),
            policy: "N/A".to_string(),
            participants: Vec::new(),
            participant_count: 0,
            created_at: String::new(),
        });

    let status = if info.is_complete == Some(true) {
        "completed"
    } else {
        "running"
    };

    let result = serde_json::json!({
        "status": status,
        "progress": {
            "completed": detail.completed,
            "running": detail.running,
            "failed": detail.failed,
            "pending": detail.pending,
            "total": detail.total,
            "percent": detail.percent,
        },
        "is_complete": info.is_complete.unwrap_or(false),
        "graph_status": info.status_prompt.unwrap_or_default(),
        "graph_snapshot": info.graph_snapshot,
        "collaboration": {
            "dag_id": collab.dag_id,
            "policy": collab.policy,
            "participants": collab.participants,
            "participant_count": collab.participant_count,
            "created_at": collab.created_at,
        }
    });
    Ok(CallToolResult::success(vec![ContentBlock::text(
        serde_json::to_string_pretty(&result).unwrap_or_default(),
    )]))
}
