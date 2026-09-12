//! `send_message` MCP tool — send a message to another agent.

use rmcp::{
    handler::server::wrapper::Parameters,
    model::{CallToolResult, ContentBlock},
    ErrorData,
};
use tracing::info;

use super::super::params::SendMessageParams;
use super::super::server::ErgataiMcpServer;

pub(crate) async fn handle(
    server: &ErgataiMcpServer,
    params: Parameters<SendMessageParams>,
) -> Result<CallToolResult, ErrorData> {
    let target_agent_id = &params.0.target_agent_id;
    let message = &params.0.message;
    let message_type = params.0.message_type.as_deref().unwrap_or("request");
    let correlation_id = params.0.correlation_id.clone();

    info!(
        "Sending message to agent {} (type: {}, bytes: {}, correlation_id: {:?})",
        target_agent_id,
        message_type,
        message.len(),
        correlation_id
    );

    // Get the sender agent ID from MCP session
    let from_agent = server
        .session_agent_id()
        .read()
        .await
        .clone()
        .unwrap_or_else(|| "unknown-mcp-client".to_string());

    // Delegate to the shared MessageSender service (same pipeline as REST API)
    let sender = match crate::messaging::get_message_sender() {
        Some(s) => s,
        None => {
            return Err(ErrorData::internal_error(
                "MessageSender not initialized — call init_message_sender first",
                None,
            ));
        }
    };
    let send_req = crate::messaging::SendRequest {
        from: from_agent.clone(),
        to: target_agent_id.to_string(),
        message: message.to_string(),
        message_type: message_type.to_string(),
        correlation_id,
        sub_chat_id: None,
    };

    match sender.send(send_req).await {
        crate::messaging::SendMessageResult::Queued {
            target_agent,
            stream,
            sequence,
        } => {
            let response_json = serde_json::json!({
                "status": "queued",
                "target_agent": target_agent,
                "delivery_method": "nats_jetstream",
                "stream": stream,
                "sequence": sequence,
                "note": "Message persisted to NATS JetStream. Background consumer will deliver via PTY injection."
            });

            Ok(CallToolResult::success(vec![ContentBlock::text(
                serde_json::to_string_pretty(&response_json).unwrap_or_default(),
            )]))
        }
        crate::messaging::SendMessageResult::DirectDelivered { target_agent } => {
            let response_json = serde_json::json!({
                "status": "direct_delivered",
                "target_agent": target_agent,
                "delivery_method": "pty_injection",
                "note": "NATS unavailable. Message delivered directly via PTY injection (no persistence)."
            });

            Ok(CallToolResult::success(vec![ContentBlock::text(
                serde_json::to_string_pretty(&response_json).unwrap_or_default(),
            )]))
        }
        crate::messaging::SendMessageResult::Rejected { reason } => {
            Ok(CallToolResult::error(vec![ContentBlock::text(reason)]))
        }
    }
}
