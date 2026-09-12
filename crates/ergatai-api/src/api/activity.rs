//! Activity feed — real-time event stream for dashboard
//!
//! Subscribes to NATS events and exposes them via SSE for the web dashboard.

use std::sync::Arc;
use std::time::Duration;

use chrono::{DateTime, Utc};
use futures::StreamExt;
use serde::{Deserialize, Serialize};
use tokio::sync::broadcast;
use tracing::{debug, error, info};

use ergatai_nats::events::AgentMessagePayload;

/// Activity event types
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ActivityEvent {
    AgentMessage {
        from_agent: String,
        to_agent: String,
        content_preview: String,
        message_type: String,
    },
    AgentLifecycle {
        agent_id: String,
        state: String,
        workspace_id: Option<String>,
    },
    LockAcquired {
        agent_id: String,
        file_path: String,
        mode: String,
    },
    LockReleased {
        agent_id: String,
        file_path: String,
    },
    DagNodeComplete {
        dag_id: String,
        node_id: String,
        agent_id: String,
    },
    DagNodeFailed {
        dag_id: String,
        node_id: String,
        agent_id: String,
        error: String,
    },
    DagComplete {
        dag_id: String,
    },
    DagNodeWarned {
        dag_id: String,
        node_id: String,
        message: String,
    },
    DagNodeEscalated {
        dag_id: String,
        node_id: String,
        message: String,
    },
}

/// Activity event with metadata
#[derive(Debug, Clone, Serialize)]
pub struct ActivityEntry {
    pub id: String,
    pub timestamp: DateTime<Utc>,
    pub event: ActivityEvent,
}

/// Activity feed service
pub struct ActivityFeed {
    sender: broadcast::Sender<ActivityEntry>,
    history: Arc<tokio::sync::RwLock<Vec<ActivityEntry>>>,
    max_history: usize,
}

impl ActivityFeed {
    /// Create a new activity feed
    pub fn new(max_history: usize) -> Self {
        let (sender, _) = broadcast::channel(1000);
        Self {
            sender,
            history: Arc::new(tokio::sync::RwLock::new(Vec::with_capacity(max_history))),
            max_history,
        }
    }

    /// Record an event
    pub async fn record(&self, event: ActivityEvent) {
        let entry = ActivityEntry {
            id: uuid::Uuid::new_v4().to_string(),
            timestamp: Utc::now(),
            event,
        };

        // Add to history
        {
            let mut history = self.history.write().await;
            history.push(entry.clone());
            if history.len() > self.max_history {
                history.remove(0);
            }
        }

        // Broadcast to subscribers
        let _ = self.sender.send(entry);
    }

    /// Get recent events
    pub async fn recent(&self, limit: usize) -> Vec<ActivityEntry> {
        let history = self.history.read().await;
        history.iter().rev().take(limit).cloned().collect()
    }

    /// Subscribe to new events
    pub fn subscribe(&self) -> broadcast::Receiver<ActivityEntry> {
        self.sender.subscribe()
    }

    /// Start NATS event consumers
    pub async fn start_nats_consumers(self: Arc<Self>) -> anyhow::Result<()> {
        info!("Starting activity feed NATS consumers");

        // Subscribe to agent messages
        let self_clone = Arc::clone(&self);
        tokio::spawn(async move {
            if let Err(e) = self_clone.consume_agent_messages().await {
                error!("Agent message consumer failed: {}", e);
            }
        });

        // Subscribe to DAG events
        let self_clone = Arc::clone(&self);
        tokio::spawn(async move {
            if let Err(e) = self_clone.consume_dag_events().await {
                error!("DAG event consumer failed: {}", e);
            }
        });

        Ok(())
    }

    async fn consume_agent_messages(&self) -> anyhow::Result<()> {
        // Wait for NATS to be ready
        tokio::time::sleep(Duration::from_secs(2)).await;

        let connection = match crate::context::try_get_app_context() {
            Some(ctx) => ctx.nats_connection.clone(),
            None => None,
        }
        .ok_or_else(|| anyhow::anyhow!("NATS not initialized"))?;

        let mut subscriber = connection
            .client()
            .subscribe::<String>("ergatai.agent.message.*".to_string())
            .await?;

        info!("Activity feed: listening for agent messages");

        while let Some(msg) = subscriber.next().await {
            if let Ok(payload) = serde_json::from_slice::<AgentMessagePayload>(&msg.payload) {
                let content_preview = if payload.content.len() > 100 {
                    format!("{}...", &payload.content[..100])
                } else {
                    payload.content.clone()
                };

                self.record(ActivityEvent::AgentMessage {
                    from_agent: payload.from_agent.clone(),
                    to_agent: payload.to_agent.clone(),
                    content_preview,
                    message_type: "message".to_string(),
                })
                .await;

                debug!("Activity feed: recorded agent message");
            }
        }

        Ok(())
    }

    async fn consume_dag_events(&self) -> anyhow::Result<()> {
        // Wait for NATS to be ready
        tokio::time::sleep(Duration::from_secs(2)).await;

        let connection = match crate::context::try_get_app_context() {
            Some(ctx) => ctx.nats_connection.clone(),
            None => None,
        }
        .ok_or_else(|| anyhow::anyhow!("NATS not initialized"))?;

        // Subscribe to all DAG events
        let mut subscriber = connection
            .client()
            .subscribe::<String>("ergatai.dag.*".to_string())
            .await?;

        info!("Activity feed: listening for DAG events");

        while let Some(msg) = subscriber.next().await {
            let subject = msg.subject.as_str();

            if subject.starts_with("ergatai.dag.node.complete.") {
                if let Ok(payload) = serde_json::from_slice::<serde_json::Value>(&msg.payload) {
                    if let (Some(dag_id), Some(node_id), Some(agent_id)) = (
                        payload.get("dag_id").and_then(|v| v.as_str()),
                        payload.get("node_id").and_then(|v| v.as_str()),
                        payload.get("agent_id").and_then(|v| v.as_str()),
                    ) {
                        self.record(ActivityEvent::DagNodeComplete {
                            dag_id: dag_id.to_string(),
                            node_id: node_id.to_string(),
                            agent_id: agent_id.to_string(),
                        })
                        .await;
                    }
                }
            } else if subject.starts_with("ergatai.dag.node.failed.") {
                if let Ok(payload) = serde_json::from_slice::<serde_json::Value>(&msg.payload) {
                    if let (Some(dag_id), Some(node_id), Some(agent_id)) = (
                        payload.get("dag_id").and_then(|v| v.as_str()),
                        payload.get("node_id").and_then(|v| v.as_str()),
                        payload.get("agent_id").and_then(|v| v.as_str()),
                    ) {
                        let error = payload
                            .get("error")
                            .and_then(|v| v.as_str())
                            .unwrap_or("unknown")
                            .to_string();

                        self.record(ActivityEvent::DagNodeFailed {
                            dag_id: dag_id.to_string(),
                            node_id: node_id.to_string(),
                            agent_id: agent_id.to_string(),
                            error,
                        })
                        .await;
                    }
                }
            } else if subject.starts_with("ergatai.dag.complete.") {
                if let Ok(payload) = serde_json::from_slice::<serde_json::Value>(&msg.payload) {
                    if let Some(dag_id) = payload.get("dag_id").and_then(|v| v.as_str()) {
                        self.record(ActivityEvent::DagComplete {
                            dag_id: dag_id.to_string(),
                        })
                        .await;
                    }
                }
            }
        }

        Ok(())
    }
}

// Global activity feed instance
static ACTIVITY_FEED: std::sync::OnceLock<Arc<ActivityFeed>> = std::sync::OnceLock::new();

/// Initialize the global activity feed
pub fn init_activity_feed() -> Arc<ActivityFeed> {
    ACTIVITY_FEED
        .get_or_init(|| Arc::new(ActivityFeed::new(50)))
        .clone()
}

/// Get the global activity feed
pub fn get_activity_feed() -> Option<Arc<ActivityFeed>> {
    ACTIVITY_FEED.get().cloned()
}
