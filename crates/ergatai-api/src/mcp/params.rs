//! MCP tool parameter types.
//!
//! Each struct corresponds to one MCP tool's JSON input schema.
//! Derive `Deserialize` for JSON-RPC parsing and `JsonSchema` for
//! MCP `tools/list` response generation.

use std::collections::HashMap;

use schemars::JsonSchema;
use serde::Deserialize;

#[derive(Debug, Deserialize, JsonSchema)]
pub(crate) struct ListAgentsParams {
    /// Whether to include agent capabilities
    #[serde(default)]
    pub include_capabilities: Option<bool>,

    /// Optional filter to narrow results.
    /// - `can_communicate_with`: reserved for future use; currently a no-op (all
    ///   agents are returned regardless of this value).
    /// - `in_dag`: Only return agents that are participants in the specified DAG.
    /// - `status`: Only return agents whose lifecycle state matches (e.g., "running", "idle", "processing").
    #[serde(default)]
    pub filter: Option<AgentFilter>,
}

/// Filter criteria for `list_agents`. All fields are optional and combined with AND.
#[derive(Debug, Deserialize, JsonSchema)]
pub struct AgentFilter {
    /// Reserved for future use; currently a no-op. All agents are returned
    /// regardless of this value.
    pub can_communicate_with: Option<String>,

    /// Filter agents that are participants in the specified DAG (by dag_id).
    pub in_dag: Option<String>,

    /// Filter agents by lifecycle status (case-insensitive).
    /// Valid values: "created", "initializing", "idle", "starting", "running", "processing", "stopping", "terminated".
    pub status: Option<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub(crate) struct SendMessageParams {
    /// ID of the target agent
    pub target_agent_id: String,
    /// Message content
    pub message: String,
    /// Message type. Controls tracking and timeout behavior:
    ///
    /// - `"request"` (default): the message expects a response. The system will
    ///   generate a correlation ID, start a 30-second timeout, and track the
    ///   request via `RequestMonitor`. If no response arrives in time, a
    ///   `request_timeout` notification is published to the sender.
    /// - `"response"`: a reply to a received request. Pass `correlation_id`
    ///   (from the request's `_meta.correlation_id`) so the system can match
    ///   this response to the original request and cancel the timeout.
    /// - `"broadcast"`: informational message, no tracking, no timeout.
    #[serde(default)]
    pub message_type: Option<String>,
    /// Correlation ID for linking a response back to its original request.
    ///
    /// **Optional**: the system automatically tracks pending requests, so you
    /// typically don't need to set this. Only provide it if you're handling
    /// advanced scenarios with multiple concurrent requests.
    /// Ignored for `"request"` and `"broadcast"` messages.
    #[serde(default)]
    pub correlation_id: Option<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub(crate) struct SubmitOrchestrationParams {
    /// DAG definition in YAML format.
    ///
    /// ```yaml
    /// tasks:
    ///   - name: Task A
    ///     agent: agent-a
    ///     task: tasks/a.md
    ///   - name: Task B
    ///     agent: agent-b
    ///     depends_on: [Task A]
    ///     timeout: 300
    /// ```
    pub dag_definition: String,
    /// Optional context variables
    #[serde(default)]
    pub context: Option<serde_json::Value>,
    /// Optional parameter values for template expansion (maps `{{var}}` in
    /// task `input` / `condition` to concrete values). Must match the
    /// `parameters` schema declared in the YAML, if any.
    #[serde(default)]
    pub parameters: Option<HashMap<String, serde_json::Value>>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub(crate) struct ValidateDagParams {
    /// DAG definition in YAML format to validate (without executing).
    /// The YAML goes through the same strict validation as `submit_orchestration`,
    /// but nothing is scheduled or run.
    pub dag_definition: String,
    /// Optional parameter values for template expansion (maps `{{var}}` in
    /// task `input` / `condition` to concrete values).
    #[serde(default)]
    pub parameters: Option<HashMap<String, serde_json::Value>>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub(crate) struct GetDagStatusParams {
    /// DAG ID to check (currently unused — there is at most one active DAG)
    pub dag_id: String,
}
