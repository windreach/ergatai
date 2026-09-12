//! MCP protocol handling — `ServerHandler` implementation for `ErgataiMcpServer`.
//!
//! Handles the MCP `initialize` handshake (agent registration, peer binding,
//! reconnection support) and server capability advertisement.

use rmcp::{
    model::{InitializeRequestParams, InitializeResult, ServerCapabilities, ServerInfo},
    service::RequestContext,
    tool_handler, ErrorData, ServerHandler,
};
use tracing::{info, warn};

use super::server::ErgataiMcpServer;

#[tool_handler(router = self.tool_router)]
impl ServerHandler for ErgataiMcpServer {
    /// Handle initialize - auto-register the agent and save peer handle
    async fn initialize(
        &self,
        request: InitializeRequestParams,
        context: RequestContext<rmcp::RoleServer>,
    ) -> Result<InitializeResult, ErrorData> {
        let agent_id = request.client_info.name.clone();
        let agent_version = request.client_info.version.clone();

        // Use the MCP URL path component as the unique agent ID.
        // This is the dynamic name from the URL (e.g., /mcp/agent-1/ → "agent-1").
        // Falls back to client_info.name if no agent_identifier (default /mcp/ endpoint).
        let connection_id = uuid::Uuid::new_v4().to_string();
        let unique_agent_id = self
            .agent_identifier()
            .clone()
            .unwrap_or_else(|| agent_id.clone());

        info!(
            "Agent connecting: {} (version: {}, protocol: {}) → {}",
            agent_id, agent_version, request.protocol_version, unique_agent_id
        );

        // Store the agent ID for this session (used in send_message)
        *self.session_agent_id().write().await = Some(unique_agent_id.clone());

        // Register agent in registry
        if let Err(e) = self
            .registry()
            .register_agent(unique_agent_id.clone(), connection_id.clone(), None)
            .await
        {
            return Err(ErrorData::invalid_params(
                format!("Failed to register agent: {}", e),
                None::<serde_json::Value>,
            ));
        }

        // Save the peer handle for pushing notifications to this agent
        self.peer_registry()
            .write()
            .await
            .insert(unique_agent_id.clone(), context.peer.clone());

        info!(
            "Agent registered: {} (connection: {}, peer handle saved)",
            unique_agent_id, connection_id
        );

        // Try to bind this MCP agent to a runtime agent (PTY pane).
        // If agent_identifier is available (from URL path), use precise binding.
        // Otherwise, fall back to FIFO binding (legacy behavior).
        let runtime = crate::context::get_app_context().agent_runtime.clone();

        // Trigger immediate discovery to ensure runtime agents are available.
        // This handles the race condition where MCP connects before the periodic
        // discovery (30s interval) has run.
        if let Err(e) = runtime.discover_and_register_agents().await {
            warn!(error = %e, "Immediate discovery on MCP connect failed");
        }

        // Reconnection support: Check for stored binding first
        let mut binding_restored = false;
        if let (Some(identifier), Some(binding_store)) =
            (self.agent_identifier(), crate::mcp::get_binding_store())
        {
            if let Ok(Some(stored_binding)) = binding_store.get_binding_by_identifier(identifier) {
                // Verify the runtime agent still exists
                if runtime
                    .get_agent(&stored_binding.runtime_agent_id)
                    .await
                    .is_some()
                {
                    // Try to restore the binding
                    match runtime
                        .try_bind_mcp_agent_with_identifier(
                            &unique_agent_id,
                            &stored_binding.runtime_agent_id,
                        )
                        .await
                    {
                        Some(runtime_id) => {
                            info!(
                                mcp_agent_id = unique_agent_id,
                                runtime_id = runtime_id,
                                agent_identifier = identifier,
                                "Binding restored from persistent storage (reconnection)"
                            );
                            binding_restored = true;
                            // Update last_active timestamp
                            let _ = binding_store.touch_binding(&unique_agent_id);
                        }
                        None => {
                            warn!(
                                mcp_agent_id = unique_agent_id,
                                runtime_id = stored_binding.runtime_agent_id,
                                "Failed to restore binding, proceeding with normal binding"
                            );
                        }
                    }
                } else {
                    info!(
                        mcp_agent_id = unique_agent_id,
                        runtime_id = stored_binding.runtime_agent_id,
                        "Stored runtime agent no longer exists, proceeding with normal binding"
                    );
                }
            }
        }

        // Normal binding flow (if not restored from storage)
        if !binding_restored {
            match self.agent_identifier() {
                Some(identifier) => {
                    // Precise binding based on agent identifier from URL path
                    match runtime
                        .try_bind_mcp_agent_with_identifier(&unique_agent_id, identifier)
                        .await
                    {
                        Some(runtime_id) => {
                            info!(
                                mcp_agent_id = unique_agent_id,
                                runtime_id = runtime_id,
                                agent_identifier = identifier,
                                "MCP agent bound to runtime agent by identifier"
                            );
                        }
                        None => {
                            // Identifier mismatch (e.g. URL path "agent-1" vs runtime
                            // "ws1-agent-1"). Fall back to FIFO binding so MCP ↔ PTY
                            // mapping still works.
                            warn!(
                                mcp_agent_id = unique_agent_id,
                                agent_identifier = identifier,
                                "Identifier-based binding failed, falling back to FIFO"
                            );
                            match runtime.try_bind_mcp_agent(&unique_agent_id).await {
                                Some(runtime_id) => {
                                    info!(
                                        mcp_agent_id = unique_agent_id,
                                        runtime_id = runtime_id,
                                        "MCP agent bound via FIFO fallback"
                                    );
                                }
                                None => {
                                    info!(
                                        mcp_agent_id = unique_agent_id,
                                        "MCP agent queued for binding (no unmapped runtime agent)"
                                    );
                                }
                            }
                        }
                    }
                }
                None => {
                    // Fallback to FIFO binding (legacy behavior)
                    match runtime.try_bind_mcp_agent(&unique_agent_id).await {
                        Some(runtime_id) => {
                            info!(
                                mcp_agent_id = unique_agent_id,
                                runtime_id = runtime_id,
                                "MCP agent bound to runtime agent on connect"
                            );
                        }
                        None => {
                            info!(
                                mcp_agent_id = unique_agent_id,
                                "MCP agent queued for binding (no unmapped runtime agent yet)"
                            );
                        }
                    }
                }
            }
        } // End of if !binding_restored

        // Persist the binding for reconnection support
        if let Some(binding_store) = crate::mcp::get_binding_store() {
            // Check if we have a successful binding by looking up the runtime ID
            if let Some(runtime_id) = runtime.resolve_agent_id(&unique_agent_id).await {
                let binding = crate::mcp::AgentBinding {
                    mcp_agent_id: unique_agent_id.clone(),
                    runtime_agent_id: runtime_id.clone(),
                    agent_identifier: self.agent_identifier().clone(),
                    created_at: chrono::Utc::now(),
                    last_active: chrono::Utc::now(),
                };

                if let Err(e) = binding_store.save_binding(&binding) {
                    warn!(
                        error = %e,
                        mcp_agent_id = %unique_agent_id,
                        "Failed to persist agent binding"
                    );
                } else {
                    info!(
                        mcp_agent_id = %unique_agent_id,
                        runtime_agent_id = %runtime_id,
                        "Binding persisted for reconnection"
                    );
                }
            }
        }

        // Build the initialize result
        let mut server_info = self.get_info();
        // Negotiate: use client's version if we know it, otherwise our latest
        let client_version = &request.protocol_version;
        let known = rmcp::model::ProtocolVersion::KNOWN_VERSIONS
            .iter()
            .any(|v| v.as_str() == client_version.as_str());
        server_info.protocol_version = if known {
            client_version.clone()
        } else {
            rmcp::model::ProtocolVersion::default()
        };

        // Store peer info in context
        context.peer.set_peer_info(request);

        Ok(server_info)
    }

    /// Return server info with tools capability
    fn get_info(&self) -> ServerInfo {
        let instructions = r#"# Ergatai Multi-Agent Collaboration Protocol

Use Ergatai MCP tools when the user explicitly requests agent collaboration, or when you need to communicate/work with other agents.

## 1. Available Tools

| Tool | Purpose |
|------|---------|
| `list_agents` | Discover online agents |
| `send_message` | Send message to another agent |
| `submit_orchestration` | Submit DAG workflow |
| `validate_dag_yaml` | Validate DAG YAML without executing (dry-run) |
| `get_dag_status` | Query DAG execution status |

### 1.1 Discover agents — `list_agents`
Returns all online agents. Use `ergatai_agent_id` field (e.g., "agent-2") as `target_agent_id`. Do NOT use `agent_id` field.

### 1.2 Send messages — `send_message`
See tool description for full details.

QUICK REFERENCE (use the `ergatai_agent_id` from `list_agents` as `target_agent_id`):
```
# Send request (default)
send_message(target_agent_id="agent-2", message="Please review")

# Reply (use the `from` field of the received message)
send_message(target_agent_id="agent-1", message="Done", message_type="response")

# Broadcast
send_message(target_agent_id="agent-2", message="FYI", message_type="broadcast")
```

### 1.3 DAG orchestration

**Submit DAG** — `submit_orchestration`:
Call when user explicitly requests DAG collaboration. The YAML top-level field MUST be `tasks:` (NOT `nodes:`). Confirm fields before submitting:

| Field | Description | Required |
|-------|-------------|----------|
| `tasks[].name` | Unique task name | YES |
| `tasks[].agent` | Agent name | YES |
| `tasks[].task` | Task description | YES |
| `tasks[].depends_on` | Dependency task names | NO |
| `tasks[].priority` | `low` / `medium` / `high` | NO |
| `tasks[].timeout` | Node timeout (seconds) | NO |
| `tasks[].scope` | File access scope (glob) | NO |
| `communication` | `open` / `adjacent` / `star:{hub}` | NO |
| `timeout` | DAG timeout (seconds) | NO |
| `max_agent_calls` | Global call limit | NO |

**Validate DAG** — `validate_dag_yaml`:
Dry-run validation without execution. Returns summary or first error. Use before `submit_orchestration` to check YAML.

**Check status** — `get_dag_status`:
Returns DAG execution status, progress, collaboration session info (MeshPolicy + participants).

## 2. Message Format

MUST distinguish user messages (free-form) from agent messages (JSON).

### Agent message format
```json
{
  "from": "agent-1",
  "message": "Please review",
  "message_type": "request",
  "_reply": "MUST call send_message(target_agent_id=\"agent-1\")",
  "_rules": ["DO NOT write reply as terminal text", "After send_message, output END"]
}
```

Fields:
- `from`: Sender's MCP agent ID (e.g., "agent-1"). This is the unified ID format — use it as `target_agent_id` when replying. `from` and `_reply` always contain the same ID.
- `message`: Content
- `message_type`: "request" | "response" | "broadcast"
- `_reply`: (request only) Exact `send_message` call — MUST follow. **Absent (null) for response/broadcast** — do NOT call send_message unless there is new work or a specific task.
- `_rules`: Type-specific behavioral rules — MUST follow

### How to respond
When `message_type = "request"` with a concrete task or question:
1. Do your work
2. Call `send_message(target_agent_id="<from>", message="<reply>", message_type="response")`
3. Output `END`

When `message_type = "response"`: DO NOT reply again (conversation is done unless there's new work).
When `message_type = "broadcast"`: DO NOT reply unless it has a specific task for you.

System auto-tracks correlation_id — no manual tracking needed.

### Timeout handling
If you receive `request_timeout`, recipient didn't respond in time.

RETRY GUIDANCE:
- First timeout: Retry once after 5 seconds
- Second timeout: Escalate to user or try alternative agent
- NEVER retry more than 2 times

## 3. DAG YAML Template

```yaml
description: "Task description"
timeout: 3600
max_agent_calls: 50
communication: "open"

tasks:
  - name: "analyze"           # Unique task name (REQUIRED)
    agent: "agent-1"          # Executing agent (REQUIRED)
    task: "Analyze structure" # Task description (REQUIRED)
    depends_on: []            # Dependencies (empty = runs first)
    priority: "high"
    timeout: 600
    scope: "src/**/*.rs"

  - name: "test"
    agent: "agent-2"
    task: "Write tests"
    depends_on: ["analyze"]
    priority: "medium"

  - name: "review"
    agent: "agent-1"
    task: "Code review"
    depends_on: ["analyze", "test"]
```

## 4. File Locks

Locks are AUTOMATIC:
- READ: No lock needed
- WRITE: Automatically granted on first modification
- Reading locked file: You see Git snapshot (version before write)

NOTE: OS-level enforcement (fanotify) is Linux-only. Other platforms: advisory only.

## 5. Anti-Loop Rules

MUST follow to prevent infinite loops:
- Reply at most ONCE per received message
- Output `END` after replying
- NEVER ask "Is there anything else I can help you with?"

### WHEN NOT TO REPLY (critical)
DO NOT respond in these cases:
- message_type="broadcast" with no specific task or question → ignore silently
- message_type="response" and the conversation is clearly ending (e.g., "thanks", "ok", "got it") → no reply needed
- You've already replied to this message → stop
- Your response would just be polite acknowledgment → suppress it

### WHEN TO REPLY (only these cases)
- message_type="request" with a concrete task or question → do the work, then reply
- message_type="broadcast" with a specific task for you → do the work, then reply

### Key principle
Every reply must contain SUBSTANCE (work done, answer given, data provided). If your reply is just "thanks", "ok", "got it", or similar acknowledgment — DO NOT REPLY. Silence is better than a loop.
"#;

        ServerInfo::new(ServerCapabilities::builder().enable_tools().build())
            .with_server_info(rmcp::model::Implementation::new(
                "ergatai",
                env!("CARGO_PKG_VERSION"),
            ))
            .with_instructions(instructions)
    }
}
