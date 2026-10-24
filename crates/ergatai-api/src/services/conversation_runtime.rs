//! In-memory runtime cache for active agent conversations.
//!
//! The database stores durable, completed logical messages. Agent turns also
//! emit many short-lived deltas (text/thinking/tool events) that must remain
//! visible while the turn is running. This cache captures those events as they
//! are published on the conversation NATS subject so a UI can attach, detach,
//! and reattach without losing the active turn.

use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use ergatai_nats::connection::subjects;
use ergatai_nats::ConversationMessagePayload;
use ergatai_runtime::AgentOutputEvent;
use futures::StreamExt;
use rusqlite::{params, Connection, OptionalExtension};
use serde::Deserialize;
use serde::Serialize;
use tokio::sync::{broadcast, mpsc, RwLock};
use tracing::{debug, error, warn};

const CONVERSATION_SUBJECT_PREFIX: &str = "ergatai.conversation.message.";
const MAX_EVENTS_PER_CONVERSATION: usize = 2_000;
const COMPLETED_RETENTION: Duration = Duration::from_secs(15 * 60);
const EVENT_LOG_RETENTION: Duration = Duration::from_secs(24 * 60 * 60);
const BROADCAST_CAPACITY: usize = 2_048;
const EVENT_FLUSH_INTERVAL: Duration = Duration::from_millis(50);

fn runtime_epoch() -> String {
    static EPOCH: OnceLock<String> = OnceLock::new();
    EPOCH
        .get_or_init(|| {
            let nanos = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos();
            format!("boot-{nanos}")
        })
        .clone()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeEvent {
    pub conversation_id: String,
    pub turn_id: String,
    pub sequence: u64,
    pub timestamp_ms: i64,
    pub event: AgentOutputEvent,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RuntimeStatus {
    #[default]
    Idle,
    Streaming,
    Completed,
    Error,
}

impl RuntimeStatus {
    fn as_str(self) -> &'static str {
        match self {
            Self::Idle => "idle",
            Self::Streaming => "streaming",
            Self::Completed => "completed",
            Self::Error => "error",
        }
    }

    fn from_str(value: &str) -> Self {
        match value {
            "streaming" => Self::Streaming,
            "completed" => Self::Completed,
            "error" => Self::Error,
            _ => Self::Idle,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationRuntimeSnapshot {
    pub epoch: String,
    pub conversation_id: String,
    pub status: RuntimeStatus,
    pub turn_id: Option<String>,
    pub last_sequence: u64,
    pub first_sequence: Option<u64>,
    pub events: Vec<RuntimeEvent>,
    pub started_at_ms: Option<i64>,
    pub updated_at_ms: Option<i64>,
}

#[derive(Debug, Default)]
struct ConversationRuntime {
    status: RuntimeStatus,
    turn_id: Option<String>,
    next_sequence: u64,
    events: VecDeque<RuntimeEvent>,
    started_at_ms: Option<i64>,
    updated_at_ms: Option<i64>,
}

fn timestamp_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

// ── Durable event log ────────────────────────────────────────────────────────

struct EventLog {
    conn: Mutex<Connection>,
    queue: mpsc::UnboundedSender<PersistedRuntimeRecord>,
    receiver: Mutex<Option<mpsc::UnboundedReceiver<PersistedRuntimeRecord>>>,
}

#[derive(Debug, Clone)]
struct PersistedRuntimeState {
    last_sequence: u64,
    status: RuntimeStatus,
    turn_id: Option<String>,
    started_at_ms: Option<i64>,
    updated_at_ms: Option<i64>,
}

#[derive(Debug, Clone)]
struct PersistedRuntimeRecord {
    event: RuntimeEvent,
    status: RuntimeStatus,
    started_at_ms: Option<i64>,
    updated_at_ms: Option<i64>,
}

impl EventLog {
    fn open() -> rusqlite::Result<Self> {
        let dir = ergatai_runtime::dirs::user_data_dir();
        std::fs::create_dir_all(&dir)
            .map_err(|error| rusqlite::Error::ToSqlConversionFailure(Box::new(error)))?;
        Self::open_at(dir.join("conversation_runtime_events.db"))
    }

    fn open_at(path: std::path::PathBuf) -> rusqlite::Result<Self> {
        let conn = Connection::open(path)?;
        conn.execute_batch(
            r#"
            PRAGMA journal_mode=WAL;
            PRAGMA synchronous=NORMAL;

            CREATE TABLE IF NOT EXISTS conversation_runtime_events (
                conversation_id TEXT NOT NULL,
                turn_id TEXT NOT NULL,
                sequence INTEGER NOT NULL,
                timestamp_ms INTEGER NOT NULL,
                event TEXT NOT NULL,
                PRIMARY KEY (conversation_id, sequence)
            );

            CREATE INDEX IF NOT EXISTS idx_conversation_runtime_events_turn
                ON conversation_runtime_events(conversation_id, turn_id, sequence);

            CREATE TABLE IF NOT EXISTS conversation_runtime_state (
                conversation_id TEXT PRIMARY KEY,
                turn_id TEXT,
                last_sequence INTEGER NOT NULL,
                status TEXT NOT NULL,
                started_at_ms INTEGER,
                updated_at_ms INTEGER
            );
            "#,
        )?;
        let (queue, receiver) = mpsc::unbounded_channel();
        Ok(Self {
            conn: Mutex::new(conn),
            queue,
            receiver: Mutex::new(Some(receiver)),
        })
    }

    fn load_state(&self, conversation_id: &str) -> Option<PersistedRuntimeState> {
        let conn = self.conn.lock().ok()?;
        match conn
            .query_row(
                "SELECT last_sequence, status, turn_id, started_at_ms, updated_at_ms
                 FROM conversation_runtime_state WHERE conversation_id = ?1",
                params![conversation_id],
                |row| {
                    Ok(PersistedRuntimeState {
                        last_sequence: row.get::<_, i64>(0)?.max(0) as u64,
                        status: RuntimeStatus::from_str(&row.get::<_, String>(1)?),
                        turn_id: row.get(2)?,
                        started_at_ms: row.get(3)?,
                        updated_at_ms: row.get(4)?,
                    })
                },
            )
            .optional()
        {
            Ok(state) => state,
            Err(error) => {
                warn!(
                    error = %error,
                    conversation_id = conversation_id,
                    "Failed to load persisted conversation runtime state"
                );
                None
            }
        }
    }

    fn enqueue(&self, record: PersistedRuntimeRecord) {
        if let Err(error) = self.queue.send(record) {
            warn!(error = %error, "Failed to queue conversation runtime event");
        }
    }

    fn flush_pending(&self) {
        // Lock the receiver and drain all available records in one critical section.
        // This is safer than taking the receiver out, as it prevents losing the receiver
        // on panic and avoids race conditions with concurrent flush calls.
        let records = {
            let Ok(mut guard) = self.receiver.lock() else {
                return;
            };
            let Some(receiver) = guard.as_mut() else {
                return;
            };

            let mut records = Vec::new();
            while let Ok(record) = receiver.try_recv() {
                records.push(record);
            }
            records
        }; // Lock released here

        if !records.is_empty() {
            self.append_batch(records);
        }
    }

    fn append_batch(&self, records: Vec<PersistedRuntimeRecord>) {
        let Ok(mut guard) = self.conn.lock() else {
            return;
        };
        let Ok(transaction) = guard.transaction() else {
            return;
        };

        let mut final_states: HashMap<String, PersistedRuntimeState> = HashMap::new();
        for record in records {
            let Ok(event_json) = serde_json::to_string(&record.event) else {
                continue;
            };
            if let Err(error) = transaction.execute(
                "INSERT OR IGNORE INTO conversation_runtime_events
                 (conversation_id, turn_id, sequence, timestamp_ms, event)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                params![
                    record.event.conversation_id,
                    record.event.turn_id,
                    record.event.sequence as i64,
                    record.event.timestamp_ms,
                    event_json
                ],
            ) {
                warn!(error = %error, "Failed to persist conversation runtime event");
                continue;
            }

            final_states.insert(
                record.event.conversation_id.clone(),
                PersistedRuntimeState {
                    last_sequence: record.event.sequence,
                    status: record.status,
                    turn_id: Some(record.event.turn_id),
                    started_at_ms: record.started_at_ms,
                    updated_at_ms: record.updated_at_ms,
                },
            );
        }

        for (conversation_id, state) in final_states {
            if let Err(error) = transaction.execute(
                "INSERT INTO conversation_runtime_state
                 (conversation_id, turn_id, last_sequence, status, started_at_ms, updated_at_ms)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)
                 ON CONFLICT(conversation_id) DO UPDATE SET
                   turn_id = excluded.turn_id,
                   last_sequence = excluded.last_sequence,
                   status = excluded.status,
                   started_at_ms = excluded.started_at_ms,
                   updated_at_ms = excluded.updated_at_ms",
                params![
                    conversation_id,
                    state.turn_id,
                    state.last_sequence as i64,
                    state.status.as_str(),
                    state.started_at_ms,
                    state.updated_at_ms
                ],
            ) {
                warn!(error = %error, "Failed to persist conversation runtime state");
            }
        }

        if let Err(error) = transaction.commit() {
            warn!(error = %error, "Failed to commit conversation runtime batch");
        }
    }

    fn list(&self, conversation_id: &str, after_sequence: Option<u64>) -> Vec<RuntimeEvent> {
        let Ok(conn) = self.conn.lock() else {
            return Vec::new();
        };
        let mut stmt = match conn.prepare(
            "SELECT event FROM conversation_runtime_events
             WHERE conversation_id = ?1 AND sequence > ?2
             ORDER BY sequence ASC LIMIT 5000",
        ) {
            Ok(stmt) => stmt,
            Err(error) => {
                warn!(error = %error, "Failed to prepare conversation runtime replay");
                return Vec::new();
            }
        };
        let rows = stmt.query_map(
            params![conversation_id, after_sequence.unwrap_or(0) as i64],
            |row| row.get::<_, String>(0),
        );
        let Ok(rows) = rows else {
            return Vec::new();
        };
        rows.filter_map(Result::ok)
            .filter_map(|json| serde_json::from_str::<RuntimeEvent>(&json).ok())
            .collect()
    }

    fn cleanup(&self) {
        let cutoff = timestamp_ms() - EVENT_LOG_RETENTION.as_millis() as i64;
        let Ok(guard) = self.conn.lock() else {
            return;
        };
        if let Err(error) = guard.execute(
            "DELETE FROM conversation_runtime_events WHERE timestamp_ms < ?1",
            params![cutoff],
        ) {
            warn!(error = %error, "Failed to clean up conversation runtime events");
        }
        if let Err(error) = guard.execute(
            "DELETE FROM conversation_runtime_state WHERE updated_at_ms < ?1",
            params![cutoff],
        ) {
            warn!(error = %error, "Failed to clean up conversation runtime state");
        }
    }
}

#[derive(Clone)]
pub struct ConversationRuntimeStore {
    conversations: Arc<RwLock<HashMap<String, ConversationRuntime>>>,
    events: broadcast::Sender<RuntimeEvent>,
    event_log: Option<Arc<EventLog>>,
}

impl ConversationRuntimeStore {
    pub fn new() -> Self {
        let event_log = EventLog::open()
            .map(Arc::new)
            .inspect_err(
                |error| warn!(error = %error, "Failed to open conversation runtime event log"),
            )
            .ok();
        Self::with_event_log(event_log)
    }

    fn with_event_log(event_log: Option<Arc<EventLog>>) -> Self {
        let (events, _) = broadcast::channel(BROADCAST_CAPACITY);
        Self {
            conversations: Arc::new(RwLock::new(HashMap::new())),
            events,
            event_log,
        }
    }

    #[cfg(test)]
    fn ephemeral() -> Self {
        Self::with_event_log(None)
    }

    pub async fn ingest(&self, conversation_id: String, event: AgentOutputEvent) {
        if matches!(event, AgentOutputEvent::ConversationId { .. }) {
            return;
        }
        let durable_message = match &event {
            AgentOutputEvent::ConversationMessage {
                message_id,
                role,
                message_type,
                ..
            } => Some((message_id.clone(), role.clone(), message_type.clone())),
            _ => None,
        };
        let durable_starts_work =
            durable_message
                .as_ref()
                .is_some_and(|(_, role, message_type)| {
                    role == "user"
                        || (role == "agent" && message_type.as_deref() == Some("request"))
                });

        let now = timestamp_ms();
        let mut conversations = self.conversations.write().await;
        let runtime = conversations.entry(conversation_id.clone()).or_default();

        // Restore the monotonic cursor and active turn after a process restart.
        if runtime.next_sequence == 0 && runtime.turn_id.is_none() {
            if let Some(event_log) = self.event_log.as_ref() {
                if let Some(persisted) = event_log.load_state(&conversation_id) {
                    runtime.next_sequence = persisted.last_sequence + 1;
                    runtime.status = persisted.status;
                    runtime.turn_id = persisted.turn_id;
                    runtime.started_at_ms = persisted.started_at_ms;
                    runtime.updated_at_ms = persisted.updated_at_ms;
                }
            }
        }

        // A runtime event after a completed turn starts a new turn. Old turn
        // events are already durable in the messages table and do not need to
        // remain in the hot cache. Durable conversation messages must not reset
        // an active/completed turn; they are appended to the runtime log so a
        // UI attached to the conversation can render them immediately.
        if let Some((message_id, _, _)) = durable_message {
            if matches!(
                runtime.status,
                RuntimeStatus::Completed | RuntimeStatus::Error
            ) {
                // A durable message is the boundary of a new logical turn. Keep
                // it in the hot cache so request and generated reply stream in
                // the same runtime window.
                runtime.events.clear();
                runtime.turn_id = Some(format!("message-{}-{}", message_id, runtime.next_sequence));
                runtime.started_at_ms = Some(now);
                runtime.status = if durable_starts_work {
                    RuntimeStatus::Streaming
                } else {
                    RuntimeStatus::Completed
                };
            } else if runtime.status == RuntimeStatus::Idle {
                runtime.turn_id = Some(format!("message-{}-{}", message_id, runtime.next_sequence));
                runtime.started_at_ms = Some(now);
                if durable_starts_work {
                    runtime.status = RuntimeStatus::Streaming;
                }
            }
        } else if !matches!(
            runtime.status,
            RuntimeStatus::Idle | RuntimeStatus::Streaming
        ) {
            runtime.events.clear();
            runtime.turn_id = Some(format!(
                "turn-{}-{}",
                runtime_epoch(),
                runtime.next_sequence
            ));
            runtime.started_at_ms = Some(now);
            runtime.status = RuntimeStatus::Streaming;
        } else if runtime.status == RuntimeStatus::Idle {
            runtime.status = RuntimeStatus::Streaming;
            runtime.turn_id = Some(format!(
                "turn-{}-{}",
                runtime_epoch(),
                runtime.next_sequence
            ));
            runtime.started_at_ms = Some(now);
        }
        let turn_id = runtime
            .turn_id
            .clone()
            .unwrap_or_else(|| format!("turn-{}-{}", runtime_epoch(), runtime.next_sequence));

        let runtime_event = RuntimeEvent {
            conversation_id: conversation_id.clone(),
            turn_id,
            sequence: runtime.next_sequence,
            timestamp_ms: now,
            event,
        };
        runtime.next_sequence += 1;
        runtime.updated_at_ms = Some(now);

        if matches!(
            runtime_event.event,
            AgentOutputEvent::Done { .. } | AgentOutputEvent::Error { .. }
        ) {
            runtime.status = if matches!(runtime_event.event, AgentOutputEvent::Error { .. }) {
                RuntimeStatus::Error
            } else {
                RuntimeStatus::Completed
            };
        }

        runtime.events.push_back(runtime_event.clone());
        while runtime.events.len() > MAX_EVENTS_PER_CONVERSATION {
            runtime.events.pop_front();
        }
        if let Some(event_log) = self.event_log.as_ref() {
            event_log.enqueue(PersistedRuntimeRecord {
                event: runtime_event.clone(),
                status: runtime.status,
                started_at_ms: runtime.started_at_ms,
                updated_at_ms: runtime.updated_at_ms,
            });
            if !matches!(
                runtime.status,
                RuntimeStatus::Streaming | RuntimeStatus::Idle
            ) {
                event_log.flush_pending();
            }
        }
        drop(conversations);

        let _ = self.events.send(runtime_event);
    }

    pub async fn snapshot(
        &self,
        conversation_id: &str,
        after_sequence: Option<u64>,
    ) -> ConversationRuntimeSnapshot {
        let conversations = self.conversations.read().await;
        let Some(runtime) = conversations.get(conversation_id) else {
            if let Some(event_log) = self.event_log.as_ref() {
                if let Some(persisted) = event_log.load_state(conversation_id) {
                    let events = event_log.list(conversation_id, after_sequence);
                    let first_sequence = events.first().map(|event| event.sequence);
                    return ConversationRuntimeSnapshot {
                        epoch: runtime_epoch(),
                        conversation_id: conversation_id.to_string(),
                        status: persisted.status,
                        turn_id: persisted.turn_id,
                        last_sequence: persisted.last_sequence,
                        first_sequence,
                        events,
                        started_at_ms: persisted.started_at_ms,
                        updated_at_ms: persisted.updated_at_ms,
                    };
                }
            }
            return ConversationRuntimeSnapshot {
                epoch: runtime_epoch(),
                conversation_id: conversation_id.to_string(),
                status: RuntimeStatus::Idle,
                turn_id: None,
                last_sequence: 0,
                first_sequence: None,
                events: Vec::new(),
                started_at_ms: None,
                updated_at_ms: None,
            };
        };

        let first_sequence = runtime
            .events
            .front()
            .map(|event| event.sequence)
            .or(runtime.first_sequence_placeholder());
        let events = runtime
            .events
            .iter()
            .filter(|event| after_sequence.is_none_or(|after| event.sequence > after))
            .cloned()
            .collect();

        ConversationRuntimeSnapshot {
            epoch: runtime_epoch(),
            conversation_id: conversation_id.to_string(),
            status: runtime.status,
            turn_id: runtime.turn_id.clone(),
            last_sequence: runtime
                .events
                .back()
                .map(|event| event.sequence)
                .unwrap_or(runtime.next_sequence.saturating_sub(1)),
            first_sequence,
            events,
            started_at_ms: runtime.started_at_ms,
            updated_at_ms: runtime.updated_at_ms,
        }
    }

    pub fn subscribe(&self) -> broadcast::Receiver<RuntimeEvent> {
        self.events.subscribe()
    }

    pub async fn cleanup(&self) {
        let cutoff = timestamp_ms() - COMPLETED_RETENTION.as_millis() as i64;
        let mut conversations = self.conversations.write().await;
        conversations.retain(|_, runtime| {
            matches!(runtime.status, RuntimeStatus::Streaming)
                || runtime
                    .updated_at_ms
                    .is_some_and(|updated_at| updated_at >= cutoff)
        });
        if let Some(event_log) = self.event_log.as_ref() {
            event_log.flush_pending();
            event_log.cleanup();
        }
    }
}

impl Default for ConversationRuntimeStore {
    fn default() -> Self {
        Self::new()
    }
}

impl ConversationRuntime {
    // Snapshot first_sequence is derived from the retained queue. Keeping a
    // separate placeholder is unnecessary today, but this helper documents the
    // invariant that a cleared queue means no replayable events remain.
    fn first_sequence_placeholder(&self) -> Option<u64> {
        if self.events.is_empty() && self.status == RuntimeStatus::Streaming {
            Some(self.next_sequence)
        } else {
            None
        }
    }
}

static RUNTIME_STORE: OnceLock<ConversationRuntimeStore> = OnceLock::new();

pub fn runtime_store() -> Option<&'static ConversationRuntimeStore> {
    RUNTIME_STORE.get()
}

pub async fn start(conn: ergatai_nats::NatsConnection) {
    let store = ConversationRuntimeStore::new();
    let subject = subjects::all_conversation_messages();
    let subscriber = match conn.subscribe(subject).await {
        Ok(subscriber) => subscriber,
        Err(error) => {
            warn!(error = %error, "Failed to subscribe to conversation runtime events");
            return;
        }
    };

    if RUNTIME_STORE.set(store.clone()).is_err() {
        warn!("Conversation runtime store already initialized");
        return;
    }

    if let Some(event_log) = store.event_log.clone() {
        tokio::spawn(async move {
            let mut interval = tokio::time::interval(EVENT_FLUSH_INTERVAL);
            loop {
                interval.tick().await;
                event_log.flush_pending();
            }
        });
    }

    let cleanup_store = store.clone();
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_secs(300));
        loop {
            interval.tick().await;
            cleanup_store.cleanup().await;
        }
    });

    let mut subscriber = subscriber;
    while let Some(message) = subscriber.next().await {
        let Some(conversation_id) = message
            .subject
            .as_str()
            .strip_prefix(CONVERSATION_SUBJECT_PREFIX)
            .map(str::to_owned)
        else {
            continue;
        };

        match serde_json::from_slice::<AgentOutputEvent>(&message.payload) {
            Ok(event) => store.ingest(conversation_id, event).await,
            Err(agent_event_error) => {
                match serde_json::from_slice::<ConversationMessagePayload>(&message.payload) {
                    Ok(payload) => {
                        if payload.conversation_id.encode() != conversation_id {
                            debug!(
                                expected_conversation_id = %conversation_id,
                                actual_conversation_id = %payload.conversation_id,
                                "Ignoring conversation message from another conversation"
                            );
                            continue;
                        }
                        let message_type = payload
                            .metadata
                            .as_ref()
                            .and_then(|metadata| metadata.get("messageType"))
                            .and_then(serde_json::Value::as_str)
                            .map(str::to_string);
                        store
                            .ingest(
                                conversation_id,
                                AgentOutputEvent::ConversationMessage {
                                    message_id: payload.message_id.encode(),
                                    role: payload.role,
                                    message_type,
                                    content: payload.content,
                                    parts: payload.parts,
                                    metadata: payload.metadata,
                                    timestamp_ms: payload.timestamp.saturating_mul(1_000),
                                    sender_agent_id: payload.sender_agent_id.map(|id| id.encode()),
                                    sender_agent_name: payload.sender_agent_name,
                                },
                            )
                            .await;
                    }
                    Err(error) => debug!(
                        subject = %message.subject,
                        agent_event_error = %agent_event_error,
                        error = %error,
                        "Ignoring non-runtime payload on conversation subject"
                    ),
                }
            }
        }
    }

    // Subscriber loop exited - this indicates a critical problem (network error, subscription revoked, etc.)
    // RUNTIME_STORE remains set but will no longer receive updates, serving stale data indefinitely.
    // Operators must restart the service to restore functionality.
    error!(
        "Conversation runtime subscriber exited unexpectedly. \
         Runtime cache will no longer receive updates and will serve stale data. \
         Restart the service to restore functionality."
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_agent_event(delta: &str) -> AgentOutputEvent {
        AgentOutputEvent::Text {
            role: "assistant".to_string(),
            delta: delta.to_string(),
        }
    }

    fn test_runtime_event(
        conversation_id: &str,
        turn_id: &str,
        sequence: u64,
        delta: &str,
    ) -> RuntimeEvent {
        RuntimeEvent {
            conversation_id: conversation_id.to_string(),
            turn_id: turn_id.to_string(),
            sequence,
            timestamp_ms: timestamp_ms(),
            event: test_agent_event(delta),
        }
    }

    #[test]
    fn persists_and_replays_runtime_events() {
        let path = std::env::temp_dir().join(format!(
            "ergatai-runtime-events-{}-{}.db",
            std::process::id(),
            timestamp_ms()
        ));
        let log = EventLog::open_at(path.clone()).expect("open event log");
        let events = [
            test_runtime_event("conv_1", "turn_1", 0, "a"),
            test_runtime_event("conv_1", "turn_1", 1, "b"),
        ];
        log.append_batch(
            events
                .iter()
                .map(|event| PersistedRuntimeRecord {
                    event: event.clone(),
                    status: RuntimeStatus::Streaming,
                    started_at_ms: Some(1),
                    updated_at_ms: Some(2),
                })
                .collect(),
        );

        let state = log.load_state("conv_1").expect("persisted state");
        assert_eq!(state.last_sequence, 1);
        assert_eq!(state.turn_id.as_deref(), Some("turn_1"));
        let replay = log.list("conv_1", Some(0));
        assert_eq!(replay.len(), 1);
        assert_eq!(replay[0].sequence, 1);

        drop(log);
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(path.with_extension("db-wal"));
        let _ = std::fs::remove_file(path.with_extension("db-shm"));
    }

    #[tokio::test]
    async fn tracks_active_turn_events() {
        let store = ConversationRuntimeStore::ephemeral();
        store
            .ingest("conv_1".to_string(), test_agent_event("he"))
            .await;
        store
            .ingest("conv_1".to_string(), test_agent_event("llo"))
            .await;

        let snapshot = store.snapshot("conv_1", None).await;
        assert_eq!(snapshot.status, RuntimeStatus::Streaming);
        assert_eq!(snapshot.last_sequence, 1);
        assert_eq!(snapshot.events.len(), 2);

        let tail = store.snapshot("conv_1", Some(0)).await;
        assert_eq!(tail.events.len(), 1);
        assert_eq!(tail.events[0].sequence, 1);
    }

    #[tokio::test]
    async fn tracks_durable_assistant_messages_without_resetting_streaming_turn() {
        let store = ConversationRuntimeStore::ephemeral();
        store
            .ingest("conv_1".to_string(), test_agent_event("working"))
            .await;
        store
            .ingest(
                "conv_1".to_string(),
                AgentOutputEvent::ConversationMessage {
                    message_id: "msg_1".to_string(),
                    role: "agent".to_string(),
                    message_type: Some("broadcast".to_string()),
                    content: "hello".to_string(),
                    parts: Some(serde_json::json!([{ "type": "text", "text": "hello" }])),
                    metadata: Some(serde_json::json!({ "senderAgentName": "Claude Code" })),
                    timestamp_ms: 1_000,
                    sender_agent_id: Some("agent_1".to_string()),
                    sender_agent_name: Some("Claude Code".to_string()),
                },
            )
            .await;
        store
            .ingest(
                "conv_1".to_string(),
                AgentOutputEvent::Done {
                    role: "assistant".to_string(),
                    stop_reason: "end_turn".to_string(),
                },
            )
            .await;

        let snapshot = store.snapshot("conv_1", None).await;
        assert_eq!(snapshot.status, RuntimeStatus::Completed);
        assert_eq!(snapshot.events.len(), 3);
        assert!(matches!(
            snapshot.events[1].event,
            AgentOutputEvent::ConversationMessage { ref message_id, ref role, .. }
                if message_id == "msg_1" && role == "agent"
        ));
    }

    #[tokio::test]
    async fn starts_new_runtime_turn_for_agent_request() {
        let store = ConversationRuntimeStore::ephemeral();
        store
            .ingest(
                "conv_1".to_string(),
                AgentOutputEvent::Done {
                    role: "assistant".to_string(),
                    stop_reason: "end_turn".to_string(),
                },
            )
            .await;

        store
            .ingest(
                "conv_1".to_string(),
                AgentOutputEvent::ConversationMessage {
                    message_id: "msg_request".to_string(),
                    role: "agent".to_string(),
                    message_type: Some("request".to_string()),
                    content: "please help".to_string(),
                    parts: None,
                    metadata: None,
                    timestamp_ms: 1_000,
                    sender_agent_id: Some("agent_1".to_string()),
                    sender_agent_name: Some("Claude Code".to_string()),
                },
            )
            .await;

        let snapshot = store.snapshot("conv_1", None).await;
        assert_eq!(snapshot.status, RuntimeStatus::Streaming);
        assert_eq!(snapshot.events.len(), 1);
        assert!(matches!(
            snapshot.events.last().expect("event").event,
            AgentOutputEvent::ConversationMessage { ref message_type, .. }
                if message_type.as_deref() == Some("request")
        ));
    }
}
