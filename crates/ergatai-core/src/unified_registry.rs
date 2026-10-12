//! Unified Agent Registry - Single source of truth for all agent information
//!
//! This module consolidates the three separate agent registries into one:
//! - ergatai-runtime: AgentRuntime registry (tracks runtime agents)
//! - ergatai-collab: agent_launcher registry (tracks running agents in tasks)
//! - ergatai-core: agent_registry (tracks MCP-connected agents)
//!
//! The unified registry provides a consistent API for querying and managing
//! agent state across all subsystems.

use std::collections::HashMap;
use std::sync::{Arc, OnceLock};

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use tokio::sync::RwLock;
use tracing::debug;

use ergatai_runtime::{AgentLifecycleState, AgentRecord};

/// Global unified registry instance.
static UNIFIED_REGISTRY: OnceLock<UnifiedAgentRegistry> = OnceLock::new();

/// Get the global unified agent registry instance.
pub fn unified_registry() -> &'static UnifiedAgentRegistry {
    UNIFIED_REGISTRY.get_or_init(UnifiedAgentRegistry::new)
}

/// Unified agent registry - single source of truth for all agents
#[derive(Clone)]
pub struct UnifiedAgentRegistry {
    /// Agent records indexed by agent_id (primary key)
    agents: Arc<RwLock<HashMap<String, AgentRecord>>>,
    /// Index by mcp_agent_id (for MCP-connected agents)
    mcp_id_to_agent_id: Arc<RwLock<HashMap<String, String>>>,
    /// Index by conversation_id (for Conversation-centric routing)
    conversation_id_to_agent_id: Arc<RwLock<HashMap<String, String>>>,
    /// Optional NATS event bus for publishing lifecycle events.
    event_bus: Arc<RwLock<Option<Arc<ergatai_nats::EventBus>>>>,
}

/// Summary view of an agent for API responses
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentSummary {
    pub agent_id: String,
    pub conversation_id: Option<String>,
    pub state: String,
    pub workspace_id: String,
    pub task_id: Option<String>,
    pub mcp_agent_id: Option<String>,
    pub capabilities: Vec<String>,
    pub is_alive: bool,
    pub is_idle: bool,
    pub is_processing: bool,
    pub last_heartbeat: DateTime<Utc>,
    pub state_changed_at: DateTime<Utc>,
}

/// State category counts for the registry
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct StateCounts {
    pub total: usize,
    pub alive: usize,
    pub terminal: usize,
    pub idle: usize,
}

impl UnifiedAgentRegistry {
    /// Create a new empty unified registry
    pub fn new() -> Self {
        Self {
            agents: Arc::new(RwLock::new(HashMap::new())),
            mcp_id_to_agent_id: Arc::new(RwLock::new(HashMap::new())),
            conversation_id_to_agent_id: Arc::new(RwLock::new(HashMap::new())),
            event_bus: Arc::new(RwLock::new(None)),
        }
    }

    /// Set the NATS event bus for publishing lifecycle events.
    pub async fn set_event_bus(&self, bus: Arc<ergatai_nats::EventBus>) {
        *self.event_bus.write().await = Some(bus);
    }

    /// Register a new agent
    ///
    /// # Lock ordering
    ///
    /// Acquires write locks on `agents`, `mcp_id_to_agent_id`, and
    /// `conversation_id_to_agent_id` in that order. The same order is used in
    /// `unregister()` and `set_mcp_agent_id()` to prevent deadlocks. Holding
    /// all three write locks simultaneously is intentional — it keeps the
    /// primary key and both secondary indices consistent. If profiling ever
    /// shows this as a contention bottleneck, the indices could be merged into
    /// a single `RwLock`-protected struct, but until then the separate locks
    /// are clearer and avoid spurious write contention on read-only paths.
    pub async fn register(&self, record: AgentRecord) {
        let agent_id = record.agent_id.clone();
        let mcp_id = record.mcp_agent_id.clone();
        let conversation_id = record.conversation_id.clone();

        // Acquire write locks and perform all operations atomically
        let mut agents = self.agents.write().await;
        let mut mcp_index = self.mcp_id_to_agent_id.write().await;
        let mut conversation_index = self.conversation_id_to_agent_id.write().await;

        // Remove old indices if this agent_id already exists
        if let Some(old_record) = agents.get(&agent_id) {
            if let Some(ref old_mcp) = old_record.mcp_agent_id {
                mcp_index.remove(old_mcp);
            }
            if let Some(ref old_conversation) = old_record.conversation_id {
                conversation_index.remove(old_conversation);
            }
        }

        // Insert new record
        agents.insert(agent_id.clone(), record);

        // Update indices
        if let Some(ref mcp) = mcp_id {
            mcp_index.insert(mcp.clone(), agent_id.clone());
        }
        if let Some(ref conversation) = conversation_id {
            conversation_index.insert(conversation.clone(), agent_id.clone());
        }

        debug!(agent_id = %agent_id, "Registered agent in unified registry");
    }

    /// Unregister an agent
    ///
    /// Lock ordering: `agents` → `mcp_id_to_agent_id` → `conversation_id_to_agent_id`.
    /// See `register()` for rationale on holding all three write locks simultaneously.
    pub async fn unregister(&self, agent_id: &str) -> Option<AgentRecord> {
        let mut agents = self.agents.write().await;
        let mut mcp_index = self.mcp_id_to_agent_id.write().await;
        let mut conversation_index = self.conversation_id_to_agent_id.write().await;

        if let Some(record) = agents.remove(agent_id) {
            if let Some(ref mcp) = record.mcp_agent_id {
                mcp_index.remove(mcp);
            }
            if let Some(ref conversation) = record.conversation_id {
                conversation_index.remove(conversation);
            }
            debug!(agent_id = %agent_id, "Unregistered agent from unified registry");
            Some(record)
        } else {
            None
        }
    }

    /// Get an agent by agent_id
    pub async fn get(&self, agent_id: &str) -> Option<AgentRecord> {
        self.agents.read().await.get(agent_id).cloned()
    }

    /// Get an agent by MCP ID
    ///
    /// Both the index and agents map are read-locked simultaneously to prevent
    /// a race where the agent is unregistered between the index lookup and the
    /// agents lookup (which would silently return None).
    pub async fn get_by_mcp_id(&self, mcp_id: &str) -> Option<AgentRecord> {
        let agents_guard = self.agents.read().await;
        let mcp_index = self.mcp_id_to_agent_id.read().await;
        let agent_id = mcp_index.get(mcp_id)?;
        agents_guard.get(agent_id).cloned()
    }

    /// Get an agent by Conversation ID
    ///
    /// Both the index and agents map are read-locked simultaneously to prevent
    /// a race where the agent is unregistered between the index lookup and the
    /// agents lookup (which would silently return None).
    pub async fn get_by_conversation_id(&self, conversation_id: &str) -> Option<AgentRecord> {
        let agents_guard = self.agents.read().await;
        let conversation_index = self.conversation_id_to_agent_id.read().await;
        let agent_id = conversation_index.get(conversation_id)?;
        agents_guard.get(agent_id).cloned()
    }

    /// List all agents
    pub async fn list(&self) -> Vec<AgentRecord> {
        self.agents.read().await.values().cloned().collect()
    }

    /// List agents as summaries
    pub async fn list_summaries(&self) -> Vec<AgentSummary> {
        self.agents
            .read()
            .await
            .values()
            .map(|record| AgentSummary {
                agent_id: record.agent_id.clone(),
                conversation_id: record.conversation_id.clone(),
                state: format!("{:?}", record.state),
                workspace_id: record.workspace_id.clone(),
                task_id: record.task_id.clone(),
                mcp_agent_id: record.mcp_agent_id.clone(),
                capabilities: record.capabilities.clone(),
                is_alive: record.state.is_alive(),
                is_idle: record.state.is_idle(),
                is_processing: record.state.is_processing(),
                last_heartbeat: record.last_heartbeat,
                state_changed_at: record.state_changed_at,
            })
            .collect()
    }

    /// Update agent state and publish lifecycle event if event_bus is set.
    ///
    /// Validates the state transition using `AgentRecord::transition_to()`, which:
    /// - Rejects transitions from terminal states
    /// - Records the transition in state_history
    /// - Updates heartbeat appropriately
    ///
    /// Returns `Err` if the transition is invalid.
    pub async fn update_state(
        &self,
        agent_id: &str,
        new_state: AgentLifecycleState,
    ) -> Result<(), String> {
        // Capture event data under write lock, then release lock before publishing
        // to avoid holding the write lock during async I/O operations.
        let event_payload = {
            let mut agents = self.agents.write().await;
            let record = agents
                .get_mut(agent_id)
                .ok_or_else(|| format!("Agent {} not found", agent_id))?;

            let old_state = record.state.state_name().to_string();

            // Use transition_to() for validation and history tracking
            record.transition_to(new_state.clone(), None, serde_json::json!({}))?;

            let new_state_str = new_state.state_name().to_string();
            let is_terminal = !new_state.is_alive();
            let is_alive = new_state.is_alive();

            debug!(agent_id = %agent_id, "Updated agent state");

            // Build event payload while still holding the write lock
            // (to ensure consistent state capture)
            Some(ergatai_nats::AgentLifecycleEventPayload {
                agent_id: agent_id.to_string(),
                from_state: old_state,
                to_state: new_state_str,
                reason: None,
                task_id: record.task_id.clone(),
                is_terminal,
                is_alive,
                timestamp: chrono::Utc::now().to_rfc3339(),
                metadata: serde_json::json!({}),
            })
        }; // agents write lock released here

        // Publish lifecycle event outside the write lock to avoid lock contention
        if let Some(payload) = event_payload {
            let event_bus = self.event_bus.read().await;
            if let Some(ref bus) = *event_bus {
                if let Err(e) = bus.publish_agent_lifecycle(&payload).await {
                    tracing::warn!(
                        agent_id = %agent_id,
                        error = %e,
                        "Failed to publish lifecycle event"
                    );
                }
            }
        }

        Ok(())
    }

    /// Set or update the MCP agent ID binding for an agent.
    /// Removes any previous MCP ID binding for this agent.
    pub async fn set_mcp_agent_id(&self, agent_id: &str, mcp_id: String) -> Result<(), String> {
        let mut agents = self.agents.write().await;
        let mut mcp_index = self.mcp_id_to_agent_id.write().await;

        let record = agents
            .get_mut(agent_id)
            .ok_or_else(|| format!("Agent {} not found", agent_id))?;

        // Remove old MCP ID binding if any
        if let Some(ref old_mcp) = record.mcp_agent_id {
            mcp_index.remove(old_mcp);
        }

        // Set new binding
        record.mcp_agent_id = Some(mcp_id.clone());
        mcp_index.insert(mcp_id, agent_id.to_string());
        debug!(agent_id = %agent_id, "Updated MCP agent ID");
        Ok(())
    }

    /// Update the last heartbeat timestamp for an agent.
    pub async fn update_heartbeat(&self, agent_id: &str) -> Result<(), String> {
        let mut agents = self.agents.write().await;
        let record = agents
            .get_mut(agent_id)
            .ok_or_else(|| format!("Agent {} not found", agent_id))?;
        record.last_heartbeat = chrono::Utc::now();
        debug!(agent_id = %agent_id, "Updated heartbeat");
        Ok(())
    }

    /// List all alive (non-terminal) agents
    pub async fn list_alive(&self) -> Vec<AgentRecord> {
        self.agents
            .read()
            .await
            .values()
            .filter(|r| r.state.is_alive())
            .cloned()
            .collect()
    }

    /// List all idle agents
    pub async fn list_idle(&self) -> Vec<AgentRecord> {
        self.agents
            .read()
            .await
            .values()
            .filter(|r| r.state.is_idle())
            .cloned()
            .collect()
    }

    /// List all processing agents
    pub async fn list_processing(&self) -> Vec<AgentRecord> {
        self.agents
            .read()
            .await
            .values()
            .filter(|r| r.state.is_processing())
            .cloned()
            .collect()
    }

    /// Get agent count by state category
    pub async fn count_by_state(&self) -> StateCounts {
        let agents = self.agents.read().await;
        let total = agents.len();
        let alive = agents.values().filter(|r| r.state.is_alive()).count();
        let terminal = agents.values().filter(|r| !r.state.is_alive()).count();
        let idle = agents.values().filter(|r| r.state.is_idle()).count();
        StateCounts {
            total,
            alive,
            terminal,
            idle,
        }
    }

    /// Get agent count
    pub async fn len(&self) -> usize {
        self.agents.read().await.len()
    }

    /// Check if registry is empty
    pub async fn is_empty(&self) -> bool {
        self.agents.read().await.is_empty()
    }
}

impl Default for UnifiedAgentRegistry {
    fn default() -> Self {
        Self::new()
    }
}
