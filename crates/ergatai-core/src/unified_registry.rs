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
use tracing::{debug, warn};

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
    /// Agent records indexed by agent_uuid (stable identifier)
    agents_by_uuid: Arc<RwLock<HashMap<String, AgentRecord>>>,
    /// Index by agent_id (dynamic, e.g., pane ID like "%72")
    agent_id_to_uuid: Arc<RwLock<HashMap<String, String>>>,
    /// Index by mcp_agent_id (for MCP-connected agents)
    mcp_id_to_uuid: Arc<RwLock<HashMap<String, String>>>,
    /// Optional NATS event bus for publishing lifecycle events.
    /// Set via `set_event_bus()` during server initialization.
    event_bus: Arc<RwLock<Option<Arc<ergatai_nats::EventBus>>>>,
}

/// Summary view of an agent for API responses
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentSummary {
    pub agent_uuid: String,
    pub agent_id: String,
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

impl UnifiedAgentRegistry {
    /// Create a new empty unified registry
    pub fn new() -> Self {
        Self {
            agents_by_uuid: Arc::new(RwLock::new(HashMap::new())),
            agent_id_to_uuid: Arc::new(RwLock::new(HashMap::new())),
            mcp_id_to_uuid: Arc::new(RwLock::new(HashMap::new())),
            event_bus: Arc::new(RwLock::new(None)),
        }
    }

    /// Set the NATS event bus for publishing lifecycle events.
    ///
    /// Called during server initialization after NATS is connected.
    /// Once set, every state transition will publish an
    /// `AgentLifecycleEventPayload` to `ergatai.agent.lifecycle.{agent_uuid}`.
    pub async fn set_event_bus(&self, bus: Arc<ergatai_nats::EventBus>) {
        *self.event_bus.write().await = Some(bus);
    }

    /// Register a new agent
    ///
    /// MEDIUM BUG FIX: If `agent_id` or `mcp_agent_id` was already mapped to a
    /// different UUID, the old index entry is cleaned up to prevent orphaned
    /// records in `agents_by_uuid`. Without this, re-registering an agent with
    /// the same agent_id but a new UUID would leave the old record unreachable
    /// by any index — a memory leak.
    ///
    /// CRITICAL FIX: Use fixed lock acquisition order (agents_by_uuid → mcp_id_to_uuid → agent_id_to_uuid)
    /// to prevent ABBA deadlock. Previously, different code paths acquired locks in different orders,
    /// creating deadlock risk under concurrent registration.
    pub async fn register(&self, record: AgentRecord) {
        let uuid = record.agent_uuid.clone();
        let agent_id = record.agent_id.clone();
        let mcp_id = record.mcp_agent_id.clone();

        // Step 1: Collect cleanup information using read locks (no mutations)
        let (old_uuid_by_agent_id, old_record_by_agent_id, old_uuid_by_mcp_id) = {
            let id_to_uuid = self.agent_id_to_uuid.read().await;
            let old_uuid_by_agent = id_to_uuid.get(&agent_id).cloned();

            let old_record = if let Some(ref old_uuid) = old_uuid_by_agent {
                if *old_uuid != uuid {
                    self.agents_by_uuid.read().await.get(old_uuid).cloned()
                } else {
                    None
                }
            } else {
                None
            };

            let mcp_to_uuid = self.mcp_id_to_uuid.read().await;
            let old_uuid_by_mcp = if let Some(ref mcp) = mcp_id {
                mcp_to_uuid.get(mcp).cloned()
            } else {
                None
            };
            let old_uuid_by_mcp = if let Some(ref old_uuid) = old_uuid_by_mcp {
                if *old_uuid != uuid {
                    Some(old_uuid.clone())
                } else {
                    None
                }
            } else {
                None
            };

            (old_uuid_by_agent, old_record, old_uuid_by_mcp)
        };
        // All read locks dropped here

        // Step 2: Log warnings before acquiring write locks
        if let Some(ref old_uuid) = old_uuid_by_agent_id {
            warn!(
                old_agent_uuid = %old_uuid,
                new_agent_uuid = %uuid,
                agent_id = %agent_id,
                "agent_id re-bound to different UUID — removing old record"
            );
        }
        if let Some(ref old_uuid) = old_uuid_by_mcp_id {
            if let Some(ref mcp) = mcp_id {
                warn!(
                    old_agent_uuid = %old_uuid,
                    new_agent_uuid = %uuid,
                    mcp_agent_id = %mcp,
                    "mcp_agent_id re-bound to different UUID — removing old record"
                );
            }
        }

        // Step 3: Acquire write locks in FIXED ORDER and perform all mutations
        // Order: agents_by_uuid → mcp_id_to_uuid → agent_id_to_uuid

        // 3a. Remove old records from agents_by_uuid
        {
            let mut agents = self.agents_by_uuid.write().await;
            if let Some(ref old_uuid) = old_uuid_by_agent_id {
                agents.remove(old_uuid);
            }
            if let Some(ref old_uuid) = old_uuid_by_mcp_id {
                agents.remove(old_uuid);
            }
            // Insert new record
            agents.insert(uuid.clone(), record);
        }

        // 3b. Update mcp_id_to_uuid
        {
            let mut mcp_to_uuid = self.mcp_id_to_uuid.write().await;
            // Remove stale mcp_id bindings
            if let Some(ref old_rec) = old_record_by_agent_id {
                if let Some(ref old_mcp_id) = old_rec.mcp_agent_id {
                    if mcp_to_uuid.get(old_mcp_id) == old_uuid_by_agent_id.as_ref() {
                        mcp_to_uuid.remove(old_mcp_id);
                    }
                }
            }
            if let Some(ref old_uuid) = old_uuid_by_mcp_id {
                // Find and remove the mcp_id that pointed to old_uuid
                if let Some(ref mcp) = mcp_id {
                    if mcp_to_uuid.get(mcp) == Some(old_uuid) {
                        mcp_to_uuid.remove(mcp);
                    }
                }
            }
            // Insert new mcp_id binding
            if let Some(ref mcp) = mcp_id {
                mcp_to_uuid.insert(mcp.clone(), uuid.clone());
            }
        }

        // 3c. Update agent_id_to_uuid
        {
            let mut id_to_uuid = self.agent_id_to_uuid.write().await;
            // Remove stale agent_id binding if it pointed to a different UUID
            if let Some(ref old_uuid) = old_uuid_by_agent_id {
                if id_to_uuid.get(&agent_id) == Some(old_uuid) {
                    id_to_uuid.remove(&agent_id);
                }
            }
            // Insert new binding
            id_to_uuid.insert(agent_id.clone(), uuid.clone());
        }

        debug!(agent_uuid = %uuid, "Agent registered in unified registry");
    }

    /// Unregister an agent by UUID
    pub async fn unregister(&self, agent_uuid: &str) -> Option<AgentRecord> {
        let record = self.agents_by_uuid.write().await.remove(agent_uuid);

        if let Some(ref r) = record {
            // Clean up indices
            self.agent_id_to_uuid.write().await.remove(&r.agent_id);

            if let Some(ref mcp) = r.mcp_agent_id {
                self.mcp_id_to_uuid.write().await.remove(mcp);
            }

            debug!(agent_uuid = %agent_uuid, "Agent unregistered from unified registry");
        }

        record
    }

    /// Get agent by UUID
    pub async fn get_by_uuid(&self, agent_uuid: &str) -> Option<AgentRecord> {
        self.agents_by_uuid.read().await.get(agent_uuid).cloned()
    }

    /// Get agent by dynamic agent_id (e.g., pane ID "%72")
    pub async fn get_by_agent_id(&self, agent_id: &str) -> Option<AgentRecord> {
        let uuid = self.agent_id_to_uuid.read().await.get(agent_id)?.clone();
        self.get_by_uuid(&uuid).await
    }

    /// Get agent by MCP agent_id (e.g., "opencode@abcd1234")
    pub async fn get_by_mcp_id(&self, mcp_agent_id: &str) -> Option<AgentRecord> {
        let uuid = self.mcp_id_to_uuid.read().await.get(mcp_agent_id)?.clone();
        self.get_by_uuid(&uuid).await
    }

    /// Update agent state with transition tracking
    ///
    /// If an event bus is configured, publishes an `AgentLifecycleEventPayload`
    /// to `ergatai.agent.lifecycle.{agent_uuid}` after the transition.
    pub async fn transition_state(
        &self,
        agent_uuid: &str,
        new_state: AgentLifecycleState,
        reason: Option<String>,
        metadata: serde_json::Value,
    ) -> Result<(), String> {
        // Capture event data under the write lock, then release before publishing
        let event_payload = {
            let mut agents = self.agents_by_uuid.write().await;
            let record = agents
                .get_mut(agent_uuid)
                .ok_or_else(|| format!("Agent {} not found", agent_uuid))?;

            let from_state = record.state.state_name().to_string();
            let task_id = record.task_id.clone();

            record.transition_to(new_state, reason.clone(), metadata.clone());

            let to_state = record.state.state_name().to_string();
            let is_terminal = record.state.is_terminal();
            let is_alive = record.state.is_alive();
            let agent_id = record.agent_id.clone();

            debug!(agent_uuid = %agent_uuid, state = %to_state, "Agent state transitioned");

            // Build the event payload (if event bus is configured we'll publish below)
            Some(ergatai_nats::AgentLifecycleEventPayload {
                agent_uuid: agent_uuid.to_string(),
                agent_id,
                from_state,
                to_state,
                reason,
                task_id,
                is_terminal,
                is_alive,
                timestamp: Utc::now().to_rfc3339(),
                metadata,
            })
        }; // write lock released here

        // Publish lifecycle event (best-effort, don't fail the transition)
        if let Some(payload) = event_payload {
            let bus = self.event_bus.read().await.clone();
            if let Some(bus) = bus {
                if let Err(e) = bus.publish_agent_lifecycle(&payload).await {
                    warn!(
                        agent_uuid = %agent_uuid,
                        error = %e,
                        "Failed to publish agent lifecycle event"
                    );
                }
            }
        }

        Ok(())
    }

    /// Update agent heartbeat
    pub async fn update_heartbeat(&self, agent_uuid: &str) -> Result<(), String> {
        let mut agents = self.agents_by_uuid.write().await;
        let record = agents
            .get_mut(agent_uuid)
            .ok_or_else(|| format!("Agent {} not found", agent_uuid))?;

        record.update_heartbeat();
        Ok(())
    }

    /// Update MCP agent ID binding
    ///
    /// Concurrency: holds both `agents_by_uuid` and `mcp_id_to_uuid` write locks
    /// simultaneously to ensure readers never see an intermediate state where the
    /// record's `mcp_agent_id` disagrees with `mcp_id_to_uuid`. Lock acquisition
    /// order is `agents_by_uuid → mcp_id_to_uuid` (consistent with doc comment at
    /// struct definition, line 88).
    pub async fn set_mcp_agent_id(
        &self,
        agent_uuid: &str,
        mcp_agent_id: String,
    ) -> Result<(), String> {
        // Hold agents_by_uuid write lock for the entire operation.
        let mut agents = self.agents_by_uuid.write().await;
        let record = agents
            .get_mut(agent_uuid)
            .ok_or_else(|| format!("Agent {} not found", agent_uuid))?;

        // Capture old binding BEFORE mutating the record, so we can clean up
        // mcp_id_to_uuid after acquiring its lock.
        let old_mcp = record.mcp_agent_id.take();

        // Acquire mcp_id_to_uuid write lock (second in the fixed order) and
        // apply both mutations atomically from the reader's perspective.
        let mut mcp_map = self.mcp_id_to_uuid.write().await;
        if let Some(old) = old_mcp {
            mcp_map.remove(&old);
        }
        mcp_map.insert(mcp_agent_id.clone(), agent_uuid.to_string());

        // NOW update the record — both indices are locked, so no reader can
        // observe the record's new mcp_agent_id before mcp_id_to_uuid is updated.
        record.mcp_agent_id = Some(mcp_agent_id);

        Ok(())
    }

    /// List all agents
    pub async fn list_all(&self) -> Vec<AgentRecord> {
        self.agents_by_uuid.read().await.values().cloned().collect()
    }

    /// List agents by state predicate
    pub async fn list_by_predicate<F>(&self, predicate: F) -> Vec<AgentRecord>
    where
        F: Fn(&AgentRecord) -> bool,
    {
        self.agents_by_uuid
            .read()
            .await
            .values()
            .filter(|r| predicate(r))
            .cloned()
            .collect()
    }

    /// List alive agents
    pub async fn list_alive(&self) -> Vec<AgentRecord> {
        self.list_by_predicate(|r| r.is_alive()).await
    }

    /// List idle agents (available for work)
    pub async fn list_idle(&self) -> Vec<AgentRecord> {
        self.list_by_predicate(|r| r.is_idle()).await
    }

    /// List agents processing tasks
    pub async fn list_processing(&self) -> Vec<AgentRecord> {
        self.list_by_predicate(|r| r.is_processing()).await
    }

    /// Get agent summary for API responses
    pub async fn get_summary(&self, agent_uuid: &str) -> Option<AgentSummary> {
        let record = self.get_by_uuid(agent_uuid).await?;
        let is_alive = record.is_alive();
        let is_idle = record.is_idle();
        let is_processing = record.is_processing();
        Some(AgentSummary {
            agent_uuid: record.agent_uuid,
            agent_id: record.agent_id,
            state: record.state.state_name().to_string(),
            workspace_id: record.workspace_id,
            task_id: record.task_id,
            mcp_agent_id: record.mcp_agent_id,
            capabilities: record.capabilities,
            is_alive,
            is_idle,
            is_processing,
            last_heartbeat: record.last_heartbeat,
            state_changed_at: record.state_changed_at,
        })
    }

    /// List all agent summaries
    pub async fn list_summaries(&self) -> Vec<AgentSummary> {
        let agents = self.list_all().await;
        agents
            .into_iter()
            .map(|r| {
                let is_alive = r.is_alive();
                let is_idle = r.is_idle();
                let is_processing = r.is_processing();
                AgentSummary {
                    agent_uuid: r.agent_uuid,
                    agent_id: r.agent_id,
                    state: r.state.state_name().to_string(),
                    workspace_id: r.workspace_id,
                    task_id: r.task_id,
                    mcp_agent_id: r.mcp_agent_id,
                    capabilities: r.capabilities,
                    is_alive,
                    is_idle,
                    is_processing,
                    last_heartbeat: r.last_heartbeat,
                    state_changed_at: r.state_changed_at,
                }
            })
            .collect()
    }

    /// Get state history for an agent
    pub async fn get_state_history(
        &self,
        agent_uuid: &str,
    ) -> Option<Vec<ergatai_runtime::StateTransition>> {
        self.get_by_uuid(agent_uuid).await.map(|r| r.state_history)
    }

    /// Clean up stale agents (no heartbeat for N seconds)
    pub async fn cleanup_stale(&self, timeout_seconds: i64) -> Vec<String> {
        let now = Utc::now();
        let mut stale_uuids = Vec::new();

        let agents = self.agents_by_uuid.read().await;
        for (uuid, record) in agents.iter() {
            let elapsed = now.signed_duration_since(record.last_heartbeat);
            if elapsed.num_seconds() >= timeout_seconds && !record.is_alive() {
                stale_uuids.push(uuid.clone());
            }
        }
        drop(agents);

        // Remove stale agents
        for uuid in &stale_uuids {
            self.unregister(uuid).await;
            warn!(agent_uuid = %uuid, "Stale agent cleaned up");
        }

        stale_uuids
    }

    /// Count agents by state category
    pub async fn count_by_state(&self) -> AgentStateCounts {
        let agents = self.agents_by_uuid.read().await;
        let mut counts = AgentStateCounts::default();

        for record in agents.values() {
            counts.total += 1;
            if record.is_alive() {
                counts.alive += 1;
            } else {
                counts.terminal += 1;
            }
            if record.is_idle() {
                counts.idle += 1;
            }
            if record.is_processing() {
                counts.processing += 1;
            }
        }

        counts
    }
}

impl Default for UnifiedAgentRegistry {
    fn default() -> Self {
        Self::new()
    }
}

/// Agent state counts for monitoring
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct AgentStateCounts {
    pub total: usize,
    pub alive: usize,
    pub terminal: usize,
    pub idle: usize,
    pub processing: usize,
}

#[cfg(test)]
mod tests {
    use super::*;
    use ergatai_runtime::{
        ExitOutcome, RecordAgentHandle as AgentHandle, RecordWorkspaceHandle as WorkspaceHandle,
    };

    fn create_test_record(agent_uuid: &str, agent_id: &str) -> AgentRecord {
        AgentRecord::new(
            agent_uuid.to_string(),
            agent_id.to_string(),
            "ws-test".to_string(),
            AgentHandle {
                workspace: WorkspaceHandle {
                    id: "ws-test".to_string(),
                    backend: "test".to_string(),
                    metadata: HashMap::new(),
                },
                agent_id: agent_id.to_string(),
                process_id: Some("1234".to_string()),
                metadata: HashMap::new(),
            },
        )
    }

    #[tokio::test]
    async fn test_register_and_get() {
        let registry = UnifiedAgentRegistry::new();
        let record = create_test_record("uuid-1", "%1");

        registry.register(record.clone()).await;

        let retrieved = registry.get_by_uuid("uuid-1").await;
        assert!(retrieved.is_some());
        assert_eq!(retrieved.unwrap().agent_id, "%1");

        let by_agent_id = registry.get_by_agent_id("%1").await;
        assert!(by_agent_id.is_some());
        assert_eq!(by_agent_id.unwrap().agent_uuid, "uuid-1");
    }

    #[tokio::test]
    async fn test_unregister() {
        let registry = UnifiedAgentRegistry::new();
        let record = create_test_record("uuid-2", "%2");

        registry.register(record).await;
        assert!(registry.get_by_uuid("uuid-2").await.is_some());

        let removed = registry.unregister("uuid-2").await;
        assert!(removed.is_some());
        assert!(registry.get_by_uuid("uuid-2").await.is_none());
    }

    #[tokio::test]
    async fn test_mcp_id_binding() {
        let registry = UnifiedAgentRegistry::new();
        let record = create_test_record("uuid-3", "%3");

        registry.register(record).await;
        registry
            .set_mcp_agent_id("uuid-3", "opencode@abc".to_string())
            .await
            .unwrap();

        let by_mcp = registry.get_by_mcp_id("opencode@abc").await;
        assert!(by_mcp.is_some());
        assert_eq!(by_mcp.unwrap().agent_uuid, "uuid-3");
    }

    #[tokio::test]
    async fn test_list_alive() {
        let registry = UnifiedAgentRegistry::new();

        // Register two agents
        registry.register(create_test_record("uuid-5", "%5")).await;
        registry.register(create_test_record("uuid-6", "%6")).await;

        // Transition one to terminal state
        registry
            .transition_state(
                "uuid-5",
                AgentLifecycleState::Terminated {
                    outcome: ExitOutcome::Exited { exit_code: Some(0) },
                    terminated_at: Utc::now(),
                    duration_secs: 100,
                },
                None,
                serde_json::json!({}),
            )
            .await
            .unwrap();

        let alive = registry.list_alive().await;
        assert_eq!(alive.len(), 1);
        assert_eq!(alive[0].agent_uuid, "uuid-6");
    }

    #[tokio::test]
    async fn test_count_by_state() {
        let registry = UnifiedAgentRegistry::new();

        registry.register(create_test_record("uuid-7", "%7")).await;
        registry.register(create_test_record("uuid-8", "%8")).await;

        // Transition one to idle
        registry
            .transition_state(
                "uuid-7",
                AgentLifecycleState::Idle {
                    ready_since: Utc::now(),
                    capabilities: vec![],
                },
                None,
                serde_json::json!({}),
            )
            .await
            .unwrap();

        let counts = registry.count_by_state().await;
        assert_eq!(counts.total, 2);
        assert_eq!(counts.alive, 2);
        assert_eq!(counts.idle, 1);
    }

    /// MEDIUM #22 regression test: re-registering an agent with the same agent_id
    /// but a different UUID must clean up the old record to prevent orphaned entries.
    #[tokio::test]
    async fn test_register_cleans_stale_agent_id_index() {
        let registry = UnifiedAgentRegistry::new();

        // Register first agent with agent_id "%10"
        registry
            .register(create_test_record("uuid-old", "%10"))
            .await;
        assert!(registry.get_by_uuid("uuid-old").await.is_some());
        assert!(registry.get_by_agent_id("%10").await.is_some());

        // Re-register with same agent_id but different UUID
        registry
            .register(create_test_record("uuid-new", "%10"))
            .await;

        // New record should be accessible
        let by_id = registry.get_by_agent_id("%10").await;
        assert!(by_id.is_some());
        assert_eq!(by_id.unwrap().agent_uuid, "uuid-new");

        // Old record should be cleaned up (no orphan)
        let old = registry.get_by_uuid("uuid-old").await;
        assert!(
            old.is_none(),
            "Old record should be removed when agent_id is re-bound"
        );

        // Total count should be 1, not 2
        let all = registry.list_all().await;
        assert_eq!(all.len(), 1, "No orphaned records should remain");
    }

    /// MEDIUM #22 regression test: re-binding mcp_agent_id must clean up the old record.
    #[tokio::test]
    async fn test_register_cleans_stale_mcp_id_index() {
        let registry = UnifiedAgentRegistry::new();

        // Register first agent with mcp_agent_id
        let mut record1 = create_test_record("uuid-old", "%20");
        record1.mcp_agent_id = Some("opencode@abc".to_string());
        registry.register(record1).await;

        // Register second agent with same mcp_agent_id but different UUID
        let mut record2 = create_test_record("uuid-new", "%21");
        record2.mcp_agent_id = Some("opencode@abc".to_string());
        registry.register(record2).await;

        // New record should be accessible via mcp_id
        let by_mcp = registry.get_by_mcp_id("opencode@abc").await;
        assert!(by_mcp.is_some());
        assert_eq!(by_mcp.unwrap().agent_uuid, "uuid-new");

        // Old record should be cleaned up
        assert!(
            registry.get_by_uuid("uuid-old").await.is_none(),
            "Old record should be removed when mcp_agent_id is re-bound"
        );

        // Total count should be 1
        let all = registry.list_all().await;
        assert_eq!(all.len(), 1, "No orphaned records should remain");
    }
}
