//! `submit_orchestration` and `validate_dag_yaml` MCP tools.

use rmcp::{
    handler::server::wrapper::Parameters,
    model::{CallToolResult, ContentBlock},
    ErrorData,
};
use tracing::info;

use super::super::params::{SubmitOrchestrationParams, ValidateDagParams};
use super::super::server::ErgataiMcpServer;

/// Handle `submit_orchestration` — submit a DAG workflow for execution.
pub(crate) async fn handle_submit(
    server: &ErgataiMcpServer,
    params: Parameters<SubmitOrchestrationParams>,
) -> Result<CallToolResult, ErrorData> {
    let dag_definition = &params.0.dag_definition;
    let context_value = &params.0.context;
    let parameters = params.0.parameters;

    info!(
        "Submitting DAG orchestration ({} bytes)",
        dag_definition.len()
    );

    // ── Get the submitter's agent_id ──
    let submitter_id = server.session_agent_id().read().await.clone();

    let req = crate::services::dag_service::DagSubmitRequest {
        definition: dag_definition.clone(),
        parameters,
        context: context_value.clone(),
        submitter_agent_id: submitter_id,
    };

    match crate::services::dag_service::submit_dag(req).await {
        Ok(resp) => {
            let result = serde_json::json!({
                "status": "submitted",
                "submitted_nodes": resp.submitted_nodes,
                "progress": resp.progress,
                "graph_status": resp.graph_status,
            });
            Ok(CallToolResult::success(vec![ContentBlock::text(
                serde_json::to_string_pretty(&result).unwrap_or_default(),
            )]))
        }
        Err(e) => {
            let msg = e.to_string();
            if msg.contains("already running") {
                Err(ErrorData::internal_error(msg, None))
            } else if msg.contains("Failed to parse")
                || msg.contains("cannot also be a task worker")
            {
                Err(ErrorData::invalid_params(msg, None))
            } else {
                Err(ErrorData::internal_error(msg, None))
            }
        }
    }
}

/// Handle `validate_dag_yaml` — dry-run validation of a DAG YAML definition.
pub(crate) async fn handle_validate(
    params: Parameters<ValidateDagParams>,
) -> Result<CallToolResult, ErrorData> {
    let dag_definition = &params.0.dag_definition;
    let parameters = params.0.parameters;

    info!("Validating DAG definition ({} bytes)", dag_definition.len());

    match crate::services::dag_service::validate_dag(dag_definition, parameters) {
        Ok(result) => Ok(CallToolResult::success(vec![ContentBlock::text(
            serde_json::to_string_pretty(&serde_json::to_value(result).unwrap_or_default())
                .unwrap_or_default(),
        )])),
        Err(e) => Err(ErrorData::invalid_params(
            format!("DAG validation failed: {}", e),
            None,
        )),
    }
}
