//! Agent output accumulation and persistence.
//!
//! This module provides infrastructure for accumulating agent outputs (thinking, tool calls,
//! text chunks) during a turn and converting them to a storable format.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::{Mutex, RwLock};

/// Token representing a specific turn in a conversation.
///
/// This token must be passed to all output event operations to ensure events
/// are associated with the correct turn. This prevents stale events from a
/// previous turn from polluting a new turn's accumulator.
#[derive(Clone)]
pub struct TurnToken {
    pub conversation_id: String,
    pub generation: u64,
    pub accumulator: Arc<Mutex<TurnAccumulator>>,
}

/// Type alias for accumulator storage key: (conversation_id, generation)
type AccumulatorKey = (String, u64);

/// Type alias for accumulator storage value
type AccumulatorValue = Arc<Mutex<TurnAccumulator>>;

/// A single turn's output accumulator
///
/// Accumulates thinking blocks, tool calls, text chunks, and metadata during an agent turn.
///
/// # Thinking Buffer Invariant
///
/// Thinking deltas are buffered in `thinking_buffer` and merged into a single `ThinkingBlock`.
/// The buffer MUST be flushed (via `flush_thinking_buffer()`) before processing any non-thinking
/// event. All public event handlers (`accumulate_text`, `record_tool_call_start`, etc.) must
/// call `flush_thinking_buffer()` as their first operation after the `sealed` check.
///
/// Forgetting to flush will cause thinking data to be lost or incorrectly merged across events.
pub struct TurnAccumulator {
    pub conversation_id: i64,
    thinking: Vec<ThinkingBlock>,
    thinking_buffer: String, // Accumulates thinking text until a boundary
    thinking_start_timestamp: Option<u64>, // When the current thinking block started
    tool_calls: HashMap<String, ToolCallRecord>,
    text_chunks: Vec<TextChunk>,
    final_text: String,
    metadata: OutputMetadata,
    started_at: std::time::Instant,
    sealed: bool, // Once sealed, no more data can be added
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
    pub fn new(conversation_id: i64) -> Self {
        Self {
            conversation_id,
            thinking: Vec::new(),
            thinking_buffer: String::new(),
            thinking_start_timestamp: None,
            tool_calls: HashMap::new(),
            text_chunks: Vec::new(),
            final_text: String::new(),
            metadata: OutputMetadata::default(),
            started_at: std::time::Instant::now(),
            sealed: false,
        }
    }

    /// Check if the accumulator is sealed (no more data can be added)
    pub fn is_sealed(&self) -> bool {
        self.sealed
    }

    /// Seal the accumulator - prevents any further data accumulation
    /// This should be called before flush to prevent race conditions
    pub fn seal(&mut self) {
        self.sealed = true;
    }

    /// Accumulate text delta
    pub fn accumulate_text(&mut self, delta: &str) {
        if self.sealed {
            return; // Silently discard data after seal
        }
        // Flush any pending thinking before starting text accumulation
        self.flush_thinking_buffer();

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
    ///
    /// Thinking deltas are buffered and merged into a single thinking block.
    /// The buffer is flushed when a non-thinking event occurs (tool call, text, etc.).
    pub fn accumulate_thinking(&mut self, delta: &str) {
        if self.sealed {
            return; // Silently discard data after seal
        }

        // Record the start timestamp for the first delta in this thinking block
        if self.thinking_buffer.is_empty() {
            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or(std::time::Duration::from_secs(0))
                .as_secs();
            self.thinking_start_timestamp = Some(now);
        }

        self.thinking_buffer.push_str(delta);
    }

    /// Flush the thinking buffer to create a complete thinking block
    ///
    /// # Critical: When to Call
    ///
    /// This method MUST be called at the start of every non-thinking event handler
    /// (e.g., `accumulate_text`, `record_tool_call_start`, `record_tool_call_update`, etc.)
    /// to finalize the current thinking block before processing the next event.
    ///
    /// Forgetting to call this method will cause thinking data to be lost or incorrectly
    /// merged with subsequent thinking blocks.
    ///
    /// # Why This Matters
    ///
    /// Thinking deltas are buffered and merged into a single block. When a non-thinking
    /// event occurs, the buffer must be flushed to preserve the thinking boundary.
    /// Without flushing, thinking from different phases would be incorrectly combined.
    fn flush_thinking_buffer(&mut self) {
        if !self.thinking_buffer.is_empty() {
            let timestamp = self.thinking_start_timestamp.unwrap_or(0);
            self.thinking.push(ThinkingBlock {
                text: std::mem::take(&mut self.thinking_buffer),
                timestamp,
            });
            self.thinking_start_timestamp = None;
        }
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
        if self.sealed {
            return; // Silently discard data after seal
        }
        // Flush any pending thinking before recording the tool call
        self.flush_thinking_buffer();

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
        if self.sealed {
            return; // Silently discard data after seal
        }
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
        if self.sealed {
            return; // Silently discard data after seal
        }
        self.metadata.stop_reason = Some(reason);
    }

    /// Set session title
    pub fn set_session_title(&mut self, title: String) {
        if self.sealed {
            return; // Silently discard data after seal
        }
        self.metadata.session_title = Some(title);
    }

    /// Set token usage
    pub fn set_token_usage(&mut self, input: u64, output: u64) {
        self.metadata.total_tokens = Some(TokenUsage { input, output });
    }

    /// Convert to AgentOutputData (intermediate representation)
    pub fn into_output_data(mut self) -> AgentOutputData {
        // Flush any remaining thinking before converting
        self.flush_thinking_buffer();

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
}

/// Registry of active output accumulators
///
/// Uses generation-based keys to prevent stale events from polluting new turns.
/// Each conversation has a monotonically increasing generation counter.
pub struct OutputAccumulatorRegistry {
    /// Maps (conversation_id, generation) to accumulator
    accumulators: RwLock<HashMap<AccumulatorKey, AccumulatorValue>>,
    /// Current generation for each conversation
    generations: RwLock<HashMap<String, u64>>,
}

impl OutputAccumulatorRegistry {
    /// Create a new registry
    pub fn new() -> Self {
        Self {
            accumulators: RwLock::new(HashMap::new()),
            generations: RwLock::new(HashMap::new()),
        }
    }

    /// Begin a new turn for a conversation
    /// Creates a new accumulator for this turn with an incremented generation.
    /// Returns a TurnToken that must be used for all subsequent operations on this turn.
    ///
    /// Lock order: generations -> accumulators (to prevent deadlock with get_current_token)
    pub async fn begin_turn(&self, conversation_id: &str) -> TurnToken {
        // Lock generations first to maintain consistent lock order
        let mut generations = self.generations.write().await;

        // Increment generation for this conversation
        let generation = generations
            .entry(conversation_id.to_string())
            .and_modify(|g| *g += 1)
            .or_insert(1);
        let generation = *generation;

        // Now lock accumulators
        let mut accumulators = self.accumulators.write().await;

        let conv_id_i64 = ergatai_error::id::parse_to_i64(conversation_id).unwrap_or(0);
        let accumulator = Arc::new(Mutex::new(TurnAccumulator::new(conv_id_i64)));
        accumulators.insert(
            (conversation_id.to_string(), generation),
            accumulator.clone(),
        );

        TurnToken {
            conversation_id: conversation_id.to_string(),
            generation,
            accumulator,
        }
    }

    /// Get the accumulator for a specific turn token
    /// Returns None if the token is stale (generation mismatch) or no active turn exists.
    /// Validates that the token's generation matches the current generation for the conversation.
    pub async fn get(&self, token: &TurnToken) -> Option<Arc<Mutex<TurnAccumulator>>> {
        let generations = self.generations.read().await;

        // Check if this token's generation matches the current generation
        if let Some(&current_gen) = generations.get(&token.conversation_id) {
            if current_gen != token.generation {
                // Token is stale - this turn has been superseded
                return None;
            }
        } else {
            // No generation tracked for this conversation
            return None;
        }

        let accumulators = self.accumulators.read().await;
        accumulators
            .get(&(token.conversation_id.clone(), token.generation))
            .cloned()
    }

    /// Get a turn token for the current generation of a conversation
    /// This is used by notification handlers that need to send events but don't have the token.
    /// Returns None if no active turn exists for this conversation.
    pub async fn get_current_token(&self, conversation_id: &str) -> Option<TurnToken> {
        let generations = self.generations.read().await;
        let accumulators = self.accumulators.read().await;

        if let Some(&generation) = generations.get(conversation_id) {
            if let Some(accumulator) = accumulators.get(&(conversation_id.to_string(), generation))
            {
                return Some(TurnToken {
                    conversation_id: conversation_id.to_string(),
                    generation,
                    accumulator: accumulator.clone(),
                });
            }
        }
        None
    }

    /// Flush and remove an accumulator for a specific turn token
    pub async fn flush(&self, token: &TurnToken) -> Option<AgentOutputData> {
        let mut accumulators = self.accumulators.write().await;

        if let Some(accumulator) =
            accumulators.remove(&(token.conversation_id.clone(), token.generation))
        {
            let mut acc = accumulator.lock().await;
            // Seal the accumulator before extracting data to prevent race conditions
            acc.seal();
            let conv_id_i64 = ergatai_error::id::parse_to_i64(&token.conversation_id).unwrap_or(0);
            let data = std::mem::replace(&mut *acc, TurnAccumulator::new(conv_id_i64));
            Some(data.into_output_data())
        } else {
            None
        }
    }

    /// List all active conversation IDs
    pub async fn list_active(&self) -> Vec<String> {
        let accumulators = self.accumulators.read().await;
        accumulators
            .keys()
            .map(|(conv_id, _)| conv_id.clone())
            .collect()
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
