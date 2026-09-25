//! `list_agents` MCP tool — discover all available agents (running + configured).
//!
//! This tool returns a unified list of:
//! 1. Running agents (from runtime registry) — can receive messages immediately
//! 2. Configured profiles (from profile registry) — will be auto-spawned when messaged
//!
//! The `status` field indicates which category each agent belongs to.

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

    // Get the calling agent's ID to exclude self from the listing.
    let my_agent_id = server.session_agent_id().read().await.clone();

    // Resolve caller's runtime ID so we can exclude self from the listing.
    let my_runtime_id = match &my_agent_id {
        Some(id) => crate::services::agent_service::resolve_agent_id(id).await,
        None => None,
    };

    // Build the shared filter for running agents.
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
        caller_agent_id: my_runtime_id.clone(),
        caller_workspace_id: match my_runtime_id.as_ref() {
            Some(id) => crate::services::agent_service::get_agent_info(id)
                .await
                .map(|info| info.workspace_id),
            None => None,
        },
    };

    // Get running agents
    let running_agents = crate::services::agent_service::list_agents_filtered(svc_filter).await;

    // Get configured profiles
    let profiles =
        crate::services::profile_service::list_profiles_with_status().unwrap_or_else(|e| {
            tracing::warn!(error = %e, "Failed to fetch agent profiles");
            Vec::new()
        });

    // Build set of profile names that are already running (to avoid duplicates)
    let running_profile_names: std::collections::HashSet<String> = running_agents
        .iter()
        .filter_map(|info| info.profile.clone())
        .collect();

    // Map running agents to JSON
    let mut agents_json: Vec<serde_json::Value> = running_agents
        .into_iter()
        .map(|info| {
            let health = if info.is_alive {
                "healthy"
            } else {
                "unhealthy"
            };
            let availability = if info.is_alive && !info.is_processing {
                if info.is_idle {
                    "available"
                } else {
                    "idle"
                }
            } else if info.is_alive {
                "busy"
            } else {
                "not_running"
            };
            let can_receive_messages = info.is_alive && !info.is_processing;

            serde_json::json!({
                "name": info.profile.clone().unwrap_or_else(|| info.agent_id.clone()),
                "status": "running",
                "state": info.state,
                "lifecycle_state": info.state,
                "task_id": info.task_id,
                "health": health,
                "availability": availability,
                "can_receive_messages": can_receive_messages,
                "is_alive": info.is_alive,
                "is_idle": info.is_idle,
                "is_processing": info.is_processing,
                "source": info.source,
                "ergatai_agent_id": info.mcp_agent_id.or(Some(info.agent_id.clone())),
                "last_heartbeat": info.last_heartbeat,
                "installed": true,
            })
        })
        .collect();

    // Add configured profiles that are NOT already running
    for profile in profiles {
        // Skip if this profile is already running (avoid duplicates)
        if running_profile_names.contains(&profile.name) {
            continue;
        }

        agents_json.push(serde_json::json!({
            "name": profile.name,
            "status": "configured",
            "state": "configured",
            "lifecycle_state": "configured",
            "task_id": null,
            "health": "not_running",
            "availability": "not_running",
            "can_receive_messages": false,
            "is_alive": false,
            "is_idle": false,
            "is_processing": false,
            "source": "profile",
            "ergatai_agent_id": profile.name,  // Use profile name as the target for send_message
            "last_heartbeat": null,
            "installed": profile.installed,
            "command": profile.command,
        }));
    }

    let filter_applied = filter.as_ref().is_some_and(|f| {
        f.can_communicate_with.is_some() || f.in_dag.is_some() || f.status.is_some()
    });

    let result = serde_json::json!({
        "agents": agents_json,
        "total": agents_json.len(),
        "running_count": agents_json.iter().filter(|a| a["status"] == "running").count(),
        "configured_count": agents_json.iter().filter(|a| a["status"] == "configured").count(),
        "filter_applied": filter_applied,
        "note": "Agents with status='running' can receive messages immediately. Agents with status='configured' will be auto-spawned when you send them a message."
    });

    Ok(CallToolResult::success(vec![ContentBlock::text(
        serde_json::to_string_pretty(&result).unwrap_or_default(),
    )]))
}
