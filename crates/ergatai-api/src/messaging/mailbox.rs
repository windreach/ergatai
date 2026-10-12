//! Mailbox abstraction layer — explicit per-agent message tracking
//!
//! Provides a high-level view of pending messages for each agent,
//! enabling better observability and management of agent communication.
//!
//! ## Architecture
//!
//! ```text
//! NATS JetStream (AGENT_MESSAGES stream)
//!   ↓
//! MessageDeliveryConsumer
//!   ↓
//! MailboxManager (tracks pending messages per agent)
//!   ↓
//! AgentMailbox (per-agent state: pending count, oldest age, recent messages)
//! ```
//!
//! ## Features
//!
//! - **Pending message tracking**: Count and age of undelivered messages
//! - **Recent message history**: Last N messages delivered to agent
//! - **Mailbox state API**: Query mailbox status via REST
//! - **Automatic cleanup**: Expire old messages from history

use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use parking_lot::RwLock;
use serde::{Deserialize, Serialize};
use tracing::{debug, info};

/// Maximum number of recent messages to track per agent
const MAX_RECENT_MESSAGES: usize = 50;

/// Maximum age of recent messages to retain (1 hour)
const MAX_RECENT_MESSAGE_AGE: Duration = Duration::from_secs(3600);

/// Mailbox status for an agent
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentMailbox {
    /// Agent ID
    pub agent_id: String,
    /// Number of pending messages (in NATS queue, not yet delivered)
    pub pending_count: u64,
    /// Age of oldest pending message in seconds (None if no pending messages)
    pub oldest_pending_age_secs: Option<u64>,
    /// Recent delivered messages (last N)
    pub recent_messages: Vec<DeliveredMessage>,
    /// Total messages delivered to this agent
    pub total_delivered: u64,
    /// Total messages failed to deliver
    pub total_failed: u64,
    /// Last activity timestamp (Unix epoch seconds)
    pub last_activity_at: Option<u64>,
}

/// A recently delivered message
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeliveredMessage {
    /// Message ID (UUID)
    pub message_id: String,
    /// Sender agent ID
    pub from: String,
    /// Message type (request/response/broadcast)
    pub message_type: String,
    /// Delivery timestamp (Unix epoch seconds)
    pub delivered_at: u64,
    /// Time spent in queue before delivery (milliseconds)
    pub queue_time_ms: u64,
}

/// Mailbox status summary for listing all agents
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MailboxSummary {
    /// Total number of agents with mailboxes
    pub total_agents: usize,
    /// Total pending messages across all agents
    pub total_pending: u64,
    /// Total delivered messages across all agents
    pub total_delivered: u64,
    /// Agents with pending messages
    pub agents_with_pending: usize,
}

/// Per-agent mailbox state (internal)
struct MailboxState {
    /// Pending message count (incremented on NATS publish, decremented on delivery)
    pending_count: AtomicU64,
    /// Timestamp of oldest pending message (Unix epoch seconds)
    oldest_pending_at: RwLock<Option<u64>>,
    /// Recent delivered messages (FIFO queue)
    recent_messages: RwLock<VecDeque<DeliveredMessage>>,
    /// Total delivered counter
    total_delivered: AtomicU64,
    /// Total failed counter
    total_failed: AtomicU64,
    /// Last activity timestamp
    last_activity_at: RwLock<Option<u64>>,
}

impl MailboxState {
    fn new() -> Self {
        Self {
            pending_count: AtomicU64::new(0),
            oldest_pending_at: RwLock::new(None),
            recent_messages: RwLock::new(VecDeque::new()),
            total_delivered: AtomicU64::new(0),
            total_failed: AtomicU64::new(0),
            last_activity_at: RwLock::new(None),
        }
    }

    fn increment_pending(&self, message_timestamp: u64) {
        self.pending_count.fetch_add(1, Ordering::SeqCst);

        // Update oldest pending timestamp if this is older
        let mut oldest = self.oldest_pending_at.write();
        if oldest.is_none() || message_timestamp < oldest.unwrap() {
            *oldest = Some(message_timestamp);
        }

        // Update last activity
        *self.last_activity_at.write() = Some(message_timestamp);
    }

    fn decrement_pending(&self) {
        let prev = self.pending_count.fetch_sub(1, Ordering::SeqCst);
        if prev == 0 {
            // Underflow protection: reset to 0
            self.pending_count.store(0, Ordering::SeqCst);
        }

        // If no more pending, clear oldest timestamp
        if self.pending_count.load(Ordering::SeqCst) == 0 {
            *self.oldest_pending_at.write() = None;
        }
    }

    fn record_delivery(&self, message: DeliveredMessage) {
        self.total_delivered.fetch_add(1, Ordering::SeqCst);

        let mut recent = self.recent_messages.write();
        recent.push_back(message);

        // Evict old messages
        while recent.len() > MAX_RECENT_MESSAGES {
            recent.pop_front();
        }

        // Evict messages older than MAX_RECENT_MESSAGE_AGE
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();
        recent.retain(|msg| now.saturating_sub(msg.delivered_at) < MAX_RECENT_MESSAGE_AGE.as_secs());

        // Update last activity
        *self.last_activity_at.write() = Some(
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs(),
        );
    }

    fn record_failure(&self) {
        self.total_failed.fetch_add(1, Ordering::SeqCst);
    }

    fn to_mailbox(&self, agent_id: &str) -> AgentMailbox {
        let pending_count = self.pending_count.load(Ordering::SeqCst);
        let oldest_pending_at = *self.oldest_pending_at.read();

        let oldest_pending_age_secs = oldest_pending_at.map(|ts| {
            let now = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs();
            now.saturating_sub(ts)
        });

        let recent_messages = self.recent_messages.read().iter().cloned().collect();

        AgentMailbox {
            agent_id: agent_id.to_string(),
            pending_count,
            oldest_pending_age_secs,
            recent_messages,
            total_delivered: self.total_delivered.load(Ordering::SeqCst),
            total_failed: self.total_failed.load(Ordering::SeqCst),
            last_activity_at: *self.last_activity_at.read(),
        }
    }
}

/// Global mailbox manager — tracks all agent mailboxes
pub struct MailboxManager {
    /// agent_id -> MailboxState
    mailboxes: RwLock<HashMap<String, Arc<MailboxState>>>,
}

impl MailboxManager {
    /// Create a new mailbox manager
    pub fn new() -> Self {
        Self {
            mailboxes: RwLock::new(HashMap::new()),
        }
    }

    /// Get or create mailbox state for an agent
    fn get_or_create(&self, agent_id: &str) -> Arc<MailboxState> {
        let mailboxes = self.mailboxes.read();
        if let Some(state) = mailboxes.get(agent_id) {
            return state.clone();
        }
        drop(mailboxes);

        // Create new mailbox state
        let mut mailboxes = self.mailboxes.write();
        mailboxes
            .entry(agent_id.to_string())
            .or_insert_with(|| Arc::new(MailboxState::new()))
            .clone()
    }

    /// Increment pending message count for an agent
    pub fn increment_pending(&self, agent_id: &str, message_timestamp: u64) {
        let state = self.get_or_create(agent_id);
        state.increment_pending(message_timestamp);
        debug!(agent_id, "Incremented pending message count");
    }

    /// Decrement pending message count for an agent (called after successful delivery)
    pub fn decrement_pending(&self, agent_id: &str) {
        if let Some(state) = self.mailboxes.read().get(agent_id) {
            state.decrement_pending();
            debug!(agent_id, "Decremented pending message count");
        }
    }

    /// Record successful message delivery.
    ///
    /// This also decrements the pending message count for the agent (equivalent
    /// to calling `decrement_pending` separately). Callers should NOT also call
    /// `decrement_pending` after this method, or the counter will underflow.
    pub fn record_delivery(
        &self,
        agent_id: &str,
        message_id: String,
        from: String,
        message_type: String,
        queue_time_ms: u64,
    ) {
        let state = self.get_or_create(agent_id);
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();

        let delivered = DeliveredMessage {
            message_id,
            from,
            message_type,
            delivered_at: now,
            queue_time_ms,
        };

        state.record_delivery(delivered);
        state.decrement_pending(); // Also decrement pending count

        info!(agent_id, "Recorded message delivery");
    }

    /// Record failed message delivery
    pub fn record_failure(&self, agent_id: &str) {
        if let Some(state) = self.mailboxes.read().get(agent_id) {
            state.record_failure();
            debug!(agent_id, "Recorded message delivery failure");
        }
    }

    /// Get mailbox state for an agent
    pub fn get_mailbox(&self, agent_id: &str) -> Option<AgentMailbox> {
        self.mailboxes
            .read()
            .get(agent_id)
            .map(|state| state.to_mailbox(agent_id))
    }

    /// List all mailboxes
    pub fn list_mailboxes(&self) -> Vec<AgentMailbox> {
        self.mailboxes
            .read()
            .iter()
            .map(|(agent_id, state)| state.to_mailbox(agent_id))
            .collect()
    }

    /// Get summary of all mailboxes
    pub fn get_summary(&self) -> MailboxSummary {
        let mailboxes = self.mailboxes.read();

        let total_agents = mailboxes.len();
        let mut total_pending = 0u64;
        let mut total_delivered = 0u64;
        let mut agents_with_pending = 0;

        for state in mailboxes.values() {
            let pending = state.pending_count.load(Ordering::SeqCst);
            let delivered = state.total_delivered.load(Ordering::SeqCst);

            total_pending += pending;
            total_delivered += delivered;

            if pending > 0 {
                agents_with_pending += 1;
            }
        }

        MailboxSummary {
            total_agents,
            total_pending,
            total_delivered,
            agents_with_pending,
        }
    }

    /// Clear mailbox for an agent (reset all counters and history)
    pub fn clear_mailbox(&self, agent_id: &str) {
        let mailboxes = self.mailboxes.write();
        if let Some(state) = mailboxes.get(agent_id) {
            state.pending_count.store(0, Ordering::SeqCst);
            *state.oldest_pending_at.write() = None;
            state.recent_messages.write().clear();
            state.total_delivered.store(0, Ordering::SeqCst);
            state.total_failed.store(0, Ordering::SeqCst);
            *state.last_activity_at.write() = None;
            info!(agent_id, "Cleared mailbox");
        }
    }

    /// Remove mailbox for an agent (called when agent is removed)
    pub fn remove_mailbox(&self, agent_id: &str) {
        let mut mailboxes = self.mailboxes.write();
        if mailboxes.remove(agent_id).is_some() {
            info!(agent_id, "Removed mailbox");
        }
    }
}

impl Default for MailboxManager {
    fn default() -> Self {
        Self::new()
    }
}

// Global mailbox manager instance
static MAILBOX_MANAGER: std::sync::OnceLock<Arc<MailboxManager>> = std::sync::OnceLock::new();

/// Initialize the global mailbox manager
pub fn init_mailbox_manager() -> Arc<MailboxManager> {
    MAILBOX_MANAGER
        .get_or_init(|| Arc::new(MailboxManager::new()))
        .clone()
}

/// Get the global mailbox manager
pub fn get_mailbox_manager() -> Option<Arc<MailboxManager>> {
    MAILBOX_MANAGER.get().cloned()
}
