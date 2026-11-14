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

            CREATE TABLE IF NOT EXISTS conversation_turns (
                conversation_id TEXT NOT NULL,
                turn_id TEXT NOT NULL,
                started_at_ms INTEGER NOT NULL,
                updated_at_ms INTEGER NOT NULL,
                completed_at_ms INTEGER,
                status TEXT NOT NULL,
                stop_reason TEXT,
                event_count INTEGER NOT NULL DEFAULT 0,
                PRIMARY KEY (conversation_id, turn_id)
            );

            CREATE INDEX IF NOT EXISTS idx_conversation_turns_started
                ON conversation_turns(conversation_id, started_at_ms);
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

    /// A process restart cannot resume an in-memory streaming turn. Persisted
    /// `streaming` rows from the previous process are therefore stale and must
    /// not be replayed as if the agent were still generating.
    fn recover_stale_streaming(&self) {
        let Ok(mut conn) = self.conn.lock() else {
            return;
        };
        let Ok(transaction) = conn.transaction() else {
            warn!("Failed to start stale streaming runtime recovery transaction");
            return;
        };

        let state_result = transaction.execute(
            "UPDATE conversation_runtime_state
             SET status = 'idle', turn_id = NULL
             WHERE status = 'streaming'",
            [],
        );
        let turns_result = transaction.execute(
            "UPDATE conversation_turns
             SET status = 'completed',
                 stop_reason = COALESCE(stop_reason, 'recovered_by_restart'),
                 completed_at_ms = COALESCE(completed_at_ms, updated_at_ms)
             WHERE status = 'streaming' AND completed_at_ms IS NULL",
            [],
        );

        if let (Ok(state_rows), Ok(turn_rows)) = (state_result, turns_result) {
            if state_rows > 0 || turn_rows > 0 {
                tracing::info!(
                    state_rows,
                    turn_rows,
                    "Recovered stale streaming conversation runtime state"
                );
            }
        }

        if let Err(error) = transaction.commit() {
            warn!(error = %error, "Failed to commit stale streaming runtime recovery");
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

            let turn_status = if matches!(
                record.event.event,
                AgentOutputEvent::Done { .. } | AgentOutputEvent::Error { .. }
            ) {
                record.status
            } else {
                RuntimeStatus::Streaming
            };
            let stop_reason = match &record.event.event {
                AgentOutputEvent::Done { stop_reason, .. } => Some(stop_reason.clone()),
                _ => None,
            };
            if let Err(error) = transaction.execute(
                "INSERT INTO conversation_turns
                 (conversation_id, turn_id, started_at_ms, updated_at_ms, completed_at_ms,
                  status, stop_reason, event_count)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 1)
                 ON CONFLICT(conversation_id, turn_id) DO UPDATE SET
                   event_count = conversation_turns.event_count + 1,
                   updated_at_ms = excluded.updated_at_ms,
                   status = CASE
                     WHEN excluded.status = 'streaming' THEN conversation_turns.status
                     ELSE excluded.status
                   END,
                   completed_at_ms = CASE
                     WHEN excluded.status IN ('completed', 'error') THEN excluded.updated_at_ms
                     ELSE conversation_turns.completed_at_ms
                   END,
                   stop_reason = COALESCE(excluded.stop_reason, conversation_turns.stop_reason)",
                params![
                    record.event.conversation_id,
                    record.event.turn_id,
                    record.started_at_ms.unwrap_or(record.event.timestamp_ms),
                    record.updated_at_ms.unwrap_or(record.event.timestamp_ms),
                    if matches!(turn_status, RuntimeStatus::Completed | RuntimeStatus::Error) {
                        Some(record.updated_at_ms.unwrap_or(record.event.timestamp_ms))
                    } else {
                        None
                    },
                    turn_status.as_str(),
                    stop_reason,
                ],
            ) {
                warn!(error = %error, "Failed to persist conversation turn");
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
        if let Some(event_log) = event_log.as_ref() {
            event_log.recover_stale_streaming();
        }
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
        // Validate conversation_id to prevent silent pollution of the runtime cache
        // with events keyed by invalid or empty IDs.
        if conversation_id.is_empty() {
            warn!("ingest called with empty conversation_id; dropping event");
            return;
        }
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

        // Turn boundaries are explicit: only TurnStarted (or a durable
        // user/request message) opens a new turn. Finished turns keep their
        // events; late events are appended to them instead of reopening a
        // phantom streaming turn. Durable conversation messages must not reset
        // an active/completed turn; they are appended to the runtime log so a
        // UI attached to the conversation can render them immediately.
        //
        // Metadata-only events (context usage, session title updates, agent
        // status/stderr lines) never constitute a new turn and must not flip a
        // completed turn back into the streaming state, even when they arrive
        // late (e.g. a title/status update published after the turn already
        // finished).
        let is_metadata_only_event = matches!(
            event,
            AgentOutputEvent::ContextUsage { .. }
                | AgentOutputEvent::SessionTitleUpdate { .. }
                | AgentOutputEvent::Status { .. }
        );
        if let AgentOutputEvent::TurnStarted { turn_id, .. } = &event {
            // TurnStarted is the authoritative boundary emitted by the
            // accumulator. Use its ID verbatim so persisted messages can be
            // joined with this runtime timeline without timestamp guessing.
            runtime.events.clear();
            runtime.turn_id = Some(turn_id.clone());
            runtime.started_at_ms = Some(now);
            runtime.status = RuntimeStatus::Streaming;
        } else if let Some((message_id, _, _)) = durable_message {
            if durable_starts_work
                && matches!(
                    runtime.status,
                    RuntimeStatus::Completed | RuntimeStatus::Error
                )
            {
                // A durable user/request message is the boundary of a new
                // logical turn. Keep it in the hot cache so the request and its
                // generated reply stream in the same runtime window.
                runtime.events.clear();
                runtime.turn_id = Some(format!("message-{}-{}", message_id, runtime.next_sequence));
                runtime.started_at_ms = Some(now);
                runtime.status = RuntimeStatus::Streaming;
            } else if runtime.status == RuntimeStatus::Idle {
                runtime.turn_id = Some(format!("message-{}-{}", message_id, runtime.next_sequence));
                runtime.started_at_ms = Some(now);
                if durable_starts_work {
                    runtime.status = RuntimeStatus::Streaming;
                }
            }
            // Non-starting durable messages (assistant/broadcast copies) are
            // appended to the current turn. They must not reset a completed
            // turn's live projection while its canonical copy is still being
            // fetched and persisted.
        } else if !is_metadata_only_event && runtime.status == RuntimeStatus::Idle {
            // No explicit TurnStarted yet (legacy/out-of-turn producer): the
            // first content event opens the turn. Finished turns do not reopen
            // from stray content: a new turn must be announced by TurnStarted
            // or by a durable starting message above. This prevents a late
            // text/tool/stderr event from racing with Done and leaving a
            // phantom streaming turn behind.
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

    #[test]
    fn recovers_stale_streaming_state() {
        let path = std::env::temp_dir().join(format!(
            "ergatai-runtime-stale-{}-{}.db",
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

        log.recover_stale_streaming();
        let state = log.load_state("conv_1").expect("persisted state");
        assert_eq!(state.status, RuntimeStatus::Idle);
        assert_eq!(state.turn_id, None);

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
    async fn durable_broadcast_after_done_does_not_reset_completed_turn() {
        let store = ConversationRuntimeStore::ephemeral();
        store
            .ingest("conv_1".to_string(), test_agent_event("answer"))
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
        let completed_turn_id = store
            .snapshot("conv_1", None)
            .await
            .turn_id
            .expect("turn id");

        store
            .ingest(
                "conv_1".to_string(),
                AgentOutputEvent::ConversationMessage {
                    message_id: "msg_broadcast".to_string(),
                    role: "agent".to_string(),
                    message_type: Some("broadcast".to_string()),
                    content: "peer update".to_string(),
                    parts: None,
                    metadata: None,
                    timestamp_ms: 1_000,
                    sender_agent_id: Some("agent_1".to_string()),
                    sender_agent_name: Some("Claude Code".to_string()),
                },
            )
            .await;

        let snapshot = store.snapshot("conv_1", None).await;
        assert_eq!(snapshot.status, RuntimeStatus::Completed);
        assert_eq!(
            snapshot.turn_id.as_deref(),
            Some(completed_turn_id.as_str())
        );
        assert_eq!(snapshot.events.len(), 3);
        assert!(matches!(
            snapshot.events.last().expect("event").event,
            AgentOutputEvent::ConversationMessage { ref message_id, .. }
                if message_id == "msg_broadcast"
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

    #[tokio::test]
    async fn context_usage_does_not_restart_a_completed_turn() {
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
                AgentOutputEvent::ContextUsage {
                    used: 100,
                    size: 200,
                    input_tokens: None,
                    output_tokens: None,
                    total_tokens: None,
                    cached_input_tokens: None,
                    cache_write_input_tokens: None,
                    reasoning_output_tokens: None,
                    model_usage: None,
                },
            )
            .await;

        let snapshot = store.snapshot("conv_1", None).await;
        assert_eq!(snapshot.status, RuntimeStatus::Completed);
        assert!(snapshot.turn_id.is_some());
        assert_eq!(snapshot.events.len(), 2);
        assert!(matches!(
            snapshot.events.last().expect("event").event,
            AgentOutputEvent::ContextUsage { .. }
        ));
    }

    #[tokio::test]
    async fn status_line_does_not_restart_a_completed_turn() {
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
        let completed_turn_id = store
            .snapshot("conv_1", None)
            .await
            .turn_id
            .expect("turn id");

        // ACP agents can emit a late stderr line (e.g. idle-compaction) right
        // after the prompt response. It is diagnostic metadata, not a new turn.
        store
            .ingest(
                "conv_1".to_string(),
                AgentOutputEvent::Status {
                    message: "[idle-compaction] skip: cache TTL is unknown".to_string(),
                },
            )
            .await;

        let snapshot = store.snapshot("conv_1", None).await;
        assert_eq!(snapshot.status, RuntimeStatus::Completed);
        assert_eq!(
            snapshot.turn_id.as_deref(),
            Some(completed_turn_id.as_str())
        );
        assert_eq!(snapshot.events.len(), 2);
        assert!(matches!(
            snapshot.events.last().expect("event").event,
            AgentOutputEvent::Status { .. }
        ));
    }

    #[tokio::test]
    async fn late_text_does_not_restart_a_completed_turn() {
        let store = ConversationRuntimeStore::ephemeral();
        store
            .ingest("conv_1".to_string(), test_agent_event("answer"))
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
        let completed_turn_id = store
            .snapshot("conv_1", None)
            .await
            .turn_id
            .expect("turn id");

        // A notification handler can publish a content delta after the prompt
        // response won the race. It belongs to the finished turn, not a new one.
        store
            .ingest("conv_1".to_string(), test_agent_event("late delta"))
            .await;

        let snapshot = store.snapshot("conv_1", None).await;
        assert_eq!(snapshot.status, RuntimeStatus::Completed);
        assert_eq!(
            snapshot.turn_id.as_deref(),
            Some(completed_turn_id.as_str())
        );
        assert_eq!(snapshot.events.len(), 3);
        assert!(matches!(
            snapshot.events.last().expect("event").event,
            AgentOutputEvent::Text { .. }
        ));
    }

    #[tokio::test]
    async fn turn_started_opens_a_new_turn_after_completion() {
        let store = ConversationRuntimeStore::ephemeral();
        store
            .ingest("conv_1".to_string(), test_agent_event("first"))
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

        store
            .ingest(
                "conv_1".to_string(),
                AgentOutputEvent::TurnStarted {
                    role: "assistant".to_string(),
                    turn_id: "turn_2".to_string(),
                },
            )
            .await;

        let snapshot = store.snapshot("conv_1", None).await;
        assert_eq!(snapshot.status, RuntimeStatus::Streaming);
        assert_eq!(snapshot.turn_id.as_deref(), Some("turn_2"));
        assert_eq!(snapshot.events.len(), 1);
        assert!(matches!(
            snapshot.events[0].event,
            AgentOutputEvent::TurnStarted { ref turn_id, .. } if turn_id == "turn_2"
        ));
    }

    #[tokio::test]
    async fn session_title_update_does_not_restart_a_completed_turn() {
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
                AgentOutputEvent::SessionTitleUpdate {
                    role: "assistant".to_string(),
                    title: "New title".to_string(),
                },
            )
            .await;

        let snapshot = store.snapshot("conv_1", None).await;
        assert_eq!(snapshot.status, RuntimeStatus::Completed);
        assert!(snapshot.turn_id.is_some());
        assert_eq!(snapshot.events.len(), 2);
        assert!(matches!(
            snapshot.events.last().expect("event").event,
            AgentOutputEvent::SessionTitleUpdate { .. }
        ));
    }
}
