//! `list_agents` MCP tool — discover online agents.

use rmcp::{
    handler::server::wrapper::Parameters,
    model::{CallToolResult, ContentBlock},
    ErrorData,
};

use super::super::params::ListAgentsParams;
use super::super::server::ErgataiMcpServer;

pub(crate) async fn handle(
    server: &ErgataiMcpServer,
    params: Parameters<ListAgentsParams>,
) -> Result<CallToolResult, ErrorData> {
    let _include_capabilities = params.0.include_capabilities.unwrap_or(false);
    let filter = params.0.filter;

    // Get the calling agent's ID to mark is_self.
    let my_agent_id = server.session_agent_id().read().await.clone();

    // Resolve caller's runtime ID so we can exclude self from the listing.
    let my_runtime_id = match &my_agent_id {
        Some(id) => crate::services::agent_service::resolve_agent_id(id).await,
        None => None,
    };

    // Build the shared filter.
    let mut exclude = std::collections::HashSet::new();
    if let Some(ref id) = my_agent_id {
        exclude.insert(id.clone());
    }
    if let Some(ref rid) = my_runtime_id {
        exclude.insert(rid.clone());
    }
    let svc_filter = crate::services::agent_service::AgentListFilter {
        in_dag: filter.as_ref().and_then(|f| f.in_dag.clone()),
        status: filter.as_ref().and_then(|f| f.status.clone()),
        exclude_agent_ids: exclude,
    };

    let items = crate::services::agent_service::list_agents_filtered(svc_filter).await;

    let agents_json: Vec<serde_json::Value> = items
        .into_iter()
        .map(|info| {
            serde_json::json!({
                "agent_id": info.agent_id,
                "agent_uuid": info.agent_uuid,
                "mcp_agent_id": info.mcp_agent_id,
                "workspace_id": info.workspace_id,
                // Lifecycle state (lowercase) from unified state machine
                "state": info.state,
                "lifecycle_state": info.state,
                "task_id": info.task_id,
                "is_alive": info.is_alive,
                "is_idle": info.is_idle,
                "is_processing": info.is_processing,
                "status": if info.mcp_agent_id.is_some() { "active" } else { "discovered" },
                // ID Unification: prefer MCP URL path name (e.g., "agent-1") when
                // the agent is MCP-bound, so it matches the `from` field in messages
                // and the `target_agent_id` agents use in send_message.
                // Fall back to workspace ID (e.g., "start-opencode-3-agent-1") for
                // agents not yet bound to an MCP connection.
                "ergatai_agent_id": info.mcp_agent_id,
                "last_heartbeat": info.last_heartbeat,
            })
        })
        .collect();

    let filter_applied = filter.as_ref().is_some_and(|f| {
        f.can_communicate_with.is_some() || f.in_dag.is_some() || f.status.is_some()
    });
    let result = serde_json::json!({
        "agents": agents_json,
        "total": agents_json.len(),
        "filter_applied": filter_applied,
        "note": if filter_applied {
            "User-supplied filter applied."
        } else {
            "All online agents are listed."
        }
    });

    Ok(CallToolResult::success(vec![ContentBlock::text(
        serde_json::to_string_pretty(&result).unwrap_or_default(),
    )]))
}
