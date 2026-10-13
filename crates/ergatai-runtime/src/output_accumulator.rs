//! Agent output accumulation and persistence.
//!
//! This module provides infrastructure for accumulating agent outputs (thinking, tool calls,
//! text chunks) during a turn and converting them to a storable format.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::{Mutex, RwLock};

/// A single turn's output accumulator
///
/// Accumulates thinking blocks, tool calls, text chunks, and metadata during an agent turn.
pub struct TurnAccumulator {
    pub conversation_id: i64,
    pub sequence: i64,
    thinking: Vec<ThinkingBlock>,
    tool_calls: HashMap<String, ToolCallRecord>,
    text_chunks: Vec<TextChunk>,
    final_text: String,
    metadata: OutputMetadata,
    started_at: std::time::Instant,
}

/// A thinking block with timestamp
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ThinkingBlock {
    pub text: String,
    pub timestamp: u64,
}

/// A text chunk with timestamp
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TextChunk {
    pub text: String,
    pub timestamp: u64,
}

/// A tool call record with full lifecycle tracking
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolCallRecord {
    pub id: String,
    pub name: String,
    pub kind: Option<String>,
    pub input: serde_json::Value,
    pub output: Option<serde_json::Value>,
    pub status: String, // "pending" | "completed" | "failed"
    pub locations: Vec<ToolCallLocation>,
    pub started_at: u64,
    pub completed_at: Option<u64>,
    pub error: Option<String>,
}

/// File location associated with a tool call
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolCallLocation {
    pub path: String,
    pub line: Option<u64>,
}

/// Output metadata
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct OutputMetadata {
    pub stop_reason: Option<String>,
    pub session_title: Option<String>,
    pub duration_ms: Option<u64>,
    pub total_tokens: Option<TokenUsage>,
}

/// Token usage statistics
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TokenUsage {
    pub input: u64,
    pub output: u64,
}

/// Agent output data (intermediate representation before persistence)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentOutputData {
    pub conversation_id: i64,
    pub message_id: Option<i64>,
    pub sequence: i64,
    pub role: String,
    pub thinking: Option<String>,
    pub tool_calls: Option<String>,
    pub text_chunks: Option<String>,
    pub final_text: Option<String>,
    pub metadata: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

impl TurnAccumulator {
    /// Create a new turn accumulator
    pub fn new(conversation_id: i64, sequence: i64) -> Self {
        Self {
            conversation_id,
            sequence,
            thinking: Vec::new(),
            tool_calls: HashMap::new(),
            text_chunks: Vec::new(),
            final_text: String::new(),
            metadata: OutputMetadata::default(),
            started_at: std::time::Instant::now(),
        }
    }

    /// Accumulate text delta
    pub fn accumulate_text(&mut self, delta: &str) {
        // Use unwrap_or(0) to handle clock skew gracefully: if system time is before UNIX_EPOCH,
        // we use 0 rather than panicking. This is safe because timestamps are only used for ordering.
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or(std::time::Duration::from_secs(0))
            .as_secs();

        self.text_chunks.push(TextChunk {
            text: delta.to_string(),
            timestamp: now,
        });
        self.final_text.push_str(delta);
    }

    /// Accumulate thinking delta
    pub fn accumulate_thinking(&mut self, delta: &str) {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or(std::time::Duration::from_secs(0))
            .as_secs();

        self.thinking.push(ThinkingBlock {
            text: delta.to_string(),
            timestamp: now,
        });
    }

    /// Record tool call start
    pub fn record_tool_call_start(
        &mut self,
        id: String,
        name: String,
        kind: Option<String>,
        input: serde_json::Value,
        locations: Vec<ToolCallLocation>,
    ) {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or(std::time::Duration::from_secs(0))
            .as_secs();

        self.tool_calls.insert(
            id.clone(),
            ToolCallRecord {
                id,
                name,
                kind,
                input,
                output: None,
                status: "pending".to_string(),
                locations,
                started_at: now,
                completed_at: None,
                error: None,
            },
        );
    }

    /// Record tool call update (completion or failure)
    pub fn record_tool_call_update(
        &mut self,
        id: &str,
        output: Option<serde_json::Value>,
        status: String,
        error: Option<String>,
    ) {
        if let Some(tool_call) = self.tool_calls.get_mut(id) {
            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or(std::time::Duration::from_secs(0))
                .as_secs();

            tool_call.output = output;
            tool_call.status = status;
            tool_call.error = error;
            tool_call.completed_at = Some(now);
        }
    }

    /// Set stop reason
    pub fn set_stop_reason(&mut self, reason: String) {
        self.metadata.stop_reason = Some(reason);
    }

    /// Set session title
    pub fn set_session_title(&mut self, title: String) {
        self.metadata.session_title = Some(title);
    }

    /// Set token usage
    pub fn set_token_usage(&mut self, input: u64, output: u64) {
        self.metadata.total_tokens = Some(TokenUsage { input, output });
    }

    /// Convert to AgentOutputData (intermediate representation)
    pub fn into_output_data(self) -> AgentOutputData {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or(std::time::Duration::from_secs(0))
            .as_secs() as i64;

        let duration_ms = self.started_at.elapsed().as_millis() as u64;
        let mut metadata = self.metadata;
        metadata.duration_ms = Some(duration_ms);

        AgentOutputData {
            conversation_id: self.conversation_id,
            message_id: None,
            sequence: self.sequence,
            role: "assistant".to_string(),
            thinking: if self.thinking.is_empty() {
                None
            } else {
                Some(serde_json::to_string(&self.thinking).unwrap_or_default())
            },
            tool_calls: if self.tool_calls.is_empty() {
                None
            } else {
                let tool_calls_vec: Vec<_> = self.tool_calls.into_values().collect();
                Some(serde_json::to_string(&tool_calls_vec).unwrap_or_default())
            },
            text_chunks: if self.text_chunks.is_empty() {
                None
            } else {
                Some(serde_json::to_string(&self.text_chunks).unwrap_or_default())
            },
            final_text: if self.final_text.is_empty() {
                None
            } else {
                Some(self.final_text)
            },
            metadata: Some(serde_json::to_string(&metadata).unwrap_or_default()),
            created_at: now,
            updated_at: now,
        }
    }

    /// Get current snapshot (without consuming the accumulator)
    pub fn snapshot(&self) -> AgentOutputSnapshot {
        AgentOutputSnapshot {
            conversation_id: self.conversation_id.to_string(),
            sequence: self.sequence,
            thinking: self.thinking.clone(),
            tool_calls: self.tool_calls.values().cloned().collect(),
            text_chunks: self.text_chunks.clone(),
            final_text: self.final_text.clone(),
            metadata: self.metadata.clone(),
            elapsed_ms: self.started_at.elapsed().as_millis() as u64,
        }
    }
}

/// Snapshot of accumulated output (for real-time queries)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentOutputSnapshot {
    pub conversation_id: String,
    pub sequence: i64,
    pub thinking: Vec<ThinkingBlock>,
    pub tool_calls: Vec<ToolCallRecord>,
    pub text_chunks: Vec<TextChunk>,
    pub final_text: String,
    pub metadata: OutputMetadata,
    pub elapsed_ms: u64,
}

/// Registry of active output accumulators
pub struct OutputAccumulatorRegistry {
    accumulators: RwLock<HashMap<String, Arc<Mutex<TurnAccumulator>>>>,
}

impl OutputAccumulatorRegistry {
    /// Create a new registry
    pub fn new() -> Self {
        Self {
            accumulators: RwLock::new(HashMap::new()),
        }
    }

    /// Get or create an accumulator for a conversation
    pub async fn get_or_create(
        &self,
        conversation_id: &str,
        sequence: i64,
    ) -> Arc<Mutex<TurnAccumulator>> {
        let mut accumulators = self.accumulators.write().await;

        accumulators
            .entry(conversation_id.to_string())
            .or_insert_with(|| {
                let conv_id_i64 = conversation_id.parse::<i64>().unwrap_or(0);
                Arc::new(Mutex::new(TurnAccumulator::new(conv_id_i64, sequence)))
            })
            .clone()
    }

    /// Get an accumulator if it exists
    pub async fn get(&self, conversation_id: &str) -> Option<Arc<Mutex<TurnAccumulator>>> {
        let accumulators = self.accumulators.read().await;
        accumulators.get(conversation_id).cloned()
    }

    /// Flush and remove an accumulator (called when turn completes)
    pub async fn flush(&self, conversation_id: &str) -> Option<AgentOutputData> {
        let mut accumulators = self.accumulators.write().await;

        if let Some(accumulator) = accumulators.remove(conversation_id) {
            let mut acc = accumulator.lock().await;
            let sequence = acc.sequence;
            let conv_id_i64 = conversation_id.parse::<i64>().unwrap_or(0);
            let data = std::mem::replace(&mut *acc, TurnAccumulator::new(conv_id_i64, sequence));
            Some(data.into_output_data())
        } else {
            None
        }
    }

    /// List all active conversation IDs
    pub async fn list_active(&self) -> Vec<String> {
        let accumulators = self.accumulators.read().await;
        accumulators.keys().cloned().collect()
    }
}

impl Default for OutputAccumulatorRegistry {
    fn default() -> Self {
        Self::new()
    }
}

/// Global accumulator registry instance (transitional).
///
/// This allows the runtime to access the registry without requiring explicit
/// dependency injection through all call sites. The registry is set once during
/// application initialization.
static GLOBAL_ACCUMULATOR_REGISTRY: std::sync::OnceLock<Arc<OutputAccumulatorRegistry>> =
    std::sync::OnceLock::new();

/// Set the global accumulator registry.
///
/// This should be called once during application initialization.
pub fn set_global_accumulator_registry(registry: Arc<OutputAccumulatorRegistry>) {
    let _ = GLOBAL_ACCUMULATOR_REGISTRY.set(registry);
}

/// Get the global accumulator registry, if set.
pub fn get_global_accumulator_registry() -> Option<&'static Arc<OutputAccumulatorRegistry>> {
    GLOBAL_ACCUMULATOR_REGISTRY.get()
}

/// Type alias for the persistence callback function.
///
/// This callback is invoked when an agent turn completes and the accumulated
/// output needs to be persisted to the database. The callback receives the
/// conversation ID and the accumulated output data.
pub type PersistCallback = Box<
    dyn Fn(
            String,
            AgentOutputData,
        ) -> std::pin::Pin<
            Box<
                dyn std::future::Future<
                        Output = Result<(), Box<dyn std::error::Error + Send + Sync>>,
                    > + Send,
            >,
        > + Send
        + Sync,
>;

/// Global persistence callback.
///
/// This is set by ergatai-api during initialization to handle the actual
/// database persistence. The runtime calls this callback when a turn completes.
static GLOBAL_PERSIST_CALLBACK: std::sync::OnceLock<Arc<PersistCallback>> =
    std::sync::OnceLock::new();

/// Set the global persistence callback.
///
/// This should be called once during application initialization by ergatai-api.
pub fn set_global_persist_callback(callback: PersistCallback) {
    let _ = GLOBAL_PERSIST_CALLBACK.set(Arc::new(callback));
}

/// Get the global persistence callback, if set.
pub fn get_global_persist_callback() -> Option<&'static Arc<PersistCallback>> {
    GLOBAL_PERSIST_CALLBACK.get()
}
