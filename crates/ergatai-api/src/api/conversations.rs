//! Conversation monitoring REST API handler.
//!
//! Provides read-only access to the ConversationManager for the dashboard.
//! Data comes from the in-memory ConversationManager (via MessageSender).

use axum::{
    extract::{Path, State},
    response::IntoResponse,
    Json,
};
use serde::Serialize;

use crate::messaging::get_message_sender;
use crate::AppState;

/// Response item for a single conversation.
#[derive(Debug, Serialize)]
pub struct ConversationSummary {
    pub id: String,
    pub agent_a: String,
    pub agent_b: String,
    pub state: String,
    pub message_count: u32,
    pub completed_rounds: u32,
    pub started_at: String,
    pub last_activity: String,
}

/// A single message in a conversation detail view.
#[derive(Debug, Serialize)]
pub struct ConversationMessage {
    pub from: String,
    pub to: String,
    pub content: String,
    pub message_type: String,
    pub timestamp: String,
}

/// Detailed view of a conversation including message history.
#[derive(Debug, Serialize)]
pub struct ConversationDetail {
    pub id: String,
    pub agent_a: String,
    pub agent_b: String,
    pub state: String,
    pub message_count: u32,
    pub completed_rounds: u32,
    pub started_at: String,
    pub last_activity: String,
    pub messages: Vec<ConversationMessage>,
}

/// Message type usage statistics.
#[derive(Debug, Serialize)]
pub struct MessageTypeStats {
    pub message_type: String,
    pub count: u64,
    pub percentage: f64,
}

/// GET /api/v1/conversations — list all conversations (active + recent).
pub async fn list_conversations(State(_state): State<AppState>) -> impl IntoResponse {
    let Some(sender) = get_message_sender() else {
        return Json(Vec::<ConversationSummary>::new()).into_response();
    };

    let manager = sender.conversation_manager();
    let conversations = manager.list_all_conversations().await;

    let summaries: Vec<ConversationSummary> = conversations
        .into_iter()
        .map(|c| ConversationSummary {
            id: c.id,
            agent_a: c.participants.0,
            agent_b: c.participants.1,
            state: format!("{:?}", c.state),
            message_count: c.message_count,
            completed_rounds: c.completed_rounds,
            started_at: c.started_at.to_rfc3339(),
            last_activity: c.last_activity.to_rfc3339(),
        })
        .collect();

    Json(summaries).into_response()
}

/// GET /api/v1/conversations/:id — get conversation detail with message history.
pub async fn get_conversation_detail(
    State(_state): State<AppState>,
    Path(conv_id): Path<String>,
) -> impl IntoResponse {
    let Some(sender) = get_message_sender() else {
        return Json(None::<ConversationDetail>).into_response();
    };

    let manager = sender.conversation_manager();
    let conversations = manager.list_all_conversations().await;

    // Find the conversation by ID
    let Some(conv) = conversations.into_iter().find(|c| c.id == conv_id) else {
        return Json(None::<ConversationDetail>).into_response();
    };

    let history = manager.get_conversation_history(&conv.id).await;
    let messages = history
        .into_iter()
        .map(|message| ConversationMessage {
            from: message.from,
            to: message.to,
            content: message.content,
            message_type: message.message_type,
            timestamp: message.timestamp.to_rfc3339(),
        })
        .collect();

    let detail = ConversationDetail {
        id: conv.id,
        agent_a: conv.participants.0,
        agent_b: conv.participants.1,
        state: format!("{:?}", conv.state),
        message_count: conv.message_count,
        completed_rounds: conv.completed_rounds,
        started_at: conv.started_at.to_rfc3339(),
        last_activity: conv.last_activity.to_rfc3339(),
        messages,
    };

    Json(Some(detail)).into_response()
}

/// GET /api/v1/stats/message-types — get message type usage statistics.
pub async fn get_message_type_stats(State(_state): State<AppState>) -> impl IntoResponse {
    use crate::mcp::message_delivery::get_message_type_stats;

    let stats = get_message_type_stats();
    let total: u64 = stats.iter().map(|(_, count)| count).sum();

    let response: Vec<MessageTypeStats> = stats
        .into_iter()
        .map(|(message_type, count)| {
            let percentage = if total > 0 {
                (count as f64 / total as f64) * 100.0
            } else {
                0.0
            };
            MessageTypeStats {
                message_type,
                count,
                percentage: (percentage * 10.0).round() / 10.0,
            }
        })
        .collect();

    Json(response).into_response()
}

// ── Tests ──

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_conversation_summary_serialization() {
        let summary = ConversationSummary {
            id: "conv-1".to_string(),
            agent_a: "agent-1".to_string(),
            agent_b: "agent-2".to_string(),
            state: "Active".to_string(),
            message_count: 6,
            completed_rounds: 3,
            started_at: "2026-01-01T00:00:00Z".to_string(),
            last_activity: "2026-01-01T00:05:00Z".to_string(),
        };
        let json = serde_json::to_value(&summary).unwrap();
        assert_eq!(json["id"], "conv-1");
        assert_eq!(json["agent_a"], "agent-1");
        assert_eq!(json["agent_b"], "agent-2");
        assert_eq!(json["state"], "Active");
        assert_eq!(json["message_count"], 6);
        assert_eq!(json["completed_rounds"], 3);
        // All 8 fields present
        assert_eq!(json.as_object().unwrap().len(), 8);
    }

    #[test]
    fn test_conversation_summary_serialization_terminated() {
        let summary = ConversationSummary {
            id: "conv-2".to_string(),
            agent_a: "ws1-agent-1".to_string(),
            agent_b: "ws1-agent-2".to_string(),
            state: "Terminated".to_string(),
            message_count: 2,
            completed_rounds: 1,
            started_at: "2026-01-01T00:00:00Z".to_string(),
            last_activity: "2026-01-01T00:01:00Z".to_string(),
        };
        let json = serde_json::to_value(&summary).unwrap();
        assert_eq!(json["state"], "Terminated");
        assert_eq!(json["completed_rounds"], 1);
    }

    #[test]
    fn test_conversation_summary_json_shape_is_flat() {
        let summary = ConversationSummary {
            id: "conv-3".to_string(),
            agent_a: "a".to_string(),
            agent_b: "b".to_string(),
            state: "Active".to_string(),
            message_count: 0,
            completed_rounds: 0,
            started_at: "2026-01-01T00:00:00Z".to_string(),
            last_activity: "2026-01-01T00:00:00Z".to_string(),
        };
        let json = serde_json::to_value(&summary).unwrap();
        // No nested objects — flat structure
        let obj = json.as_object().unwrap();
        for (_, v) in obj.iter() {
            assert!(
                v.is_string() || v.is_number(),
                "all values should be primitives"
            );
        }
    }
}
