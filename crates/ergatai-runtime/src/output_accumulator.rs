//! Agent output accumulation and persistence.
//!
//! This module provides infrastructure for accumulating agent outputs (thinking, tool calls,
//! text chunks) during a turn and converting them to a storable format.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::{Mutex, RwLock};

use ergatai_error::id::{format, generate, IdType};

/// Token representing a specific turn in a conversation.
///
/// This token must be passed to all output event operations to ensure events
/// are associated with the correct turn. This prevents stale events from a
/// previous turn from polluting a new turn's accumulator.
#[derive(Clone)]
pub struct TurnToken {
    pub conversation_id: String,
    pub generation: u64,
    /// Stable identifier shared by runtime events and the persisted projection.
    pub turn_id: String,
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
    pub turn_id: String,
    /// Delivery context attached by the message layer before injection. This
    /// lets a persisted output turn be correlated with the inbound request that
    /// caused it.
    context: TurnContext,
    thinking: Vec<ThinkingBlock>,
    thinking_buffer: String, // Accumulates thinking text until a boundary
    thinking_start_timestamp: Option<u64>, // When the current thinking block started
    tool_calls: HashMap<String, ToolCallRecord>,
    timeline: Vec<OutputTimelineItem>,
    timeline_tool_positions: HashMap<String, usize>,
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

/// Chronological output item. The legacy separate thinking/tool/text arrays
/// cannot preserve interleaving when an agent alternates thinking, tool calls,
/// and text. Persistence uses this timeline when available.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum OutputTimelineItem {
    Thinking {
        text: String,
        timestamp: u64,
    },
    ToolCall {
        id: String,
        name: String,
        kind: Option<String>,
        input: Box<serde_json::Value>,
        output: Box<Option<serde_json::Value>>,
        status: String,
        #[serde(default)]
        locations: Vec<ToolCallLocation>,
        started_at: u64,
        completed_at: Option<u64>,
        error: Option<String>,
    },
    Text {
        text: String,
        timestamp: u64,
    },
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
    /// ACP context window usage snapshot (from UsageUpdate)
    pub context_used: Option<u64>,
    pub context_window: Option<u64>,
}

/// Delivery context for an incoming prompt.
///
/// This is intentionally decoupled from agent-visible message content. Agents do
/// not need to echo these IDs; the transport owns request/output correlation.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct TurnContext {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reply_to_message_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub correlation_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_conversation_id: Option<String>,
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
    /// Stable execution-turn identifier shared with runtime events and
    /// message projections.
    pub turn_id: String,
    pub message_id: Option<i64>,
    pub role: String,
    /// Runtime ID of the agent that produced this turn. Populated by the
    /// backend at flush time and resolved to a stable binding ID during
    /// persistence.
    #[serde(default)]
    pub sender_agent_id: Option<String>,
    /// Human-readable agent profile/binding name, if known at flush time.
    #[serde(default)]
    pub sender_agent_name: Option<String>,
    /// Stable semantic type for normal agent turns. Inter-agent envelope
    /// messages use "request"/"response"/"broadcast" instead.
    #[serde(default)]
    pub message_type: Option<String>,
    /// ID of the inbound inter-agent request that caused this turn, when known.
    #[serde(default)]
    pub reply_to_message_id: Option<String>,
    /// Delivery correlation ID for request/output/response grouping.
    #[serde(default)]
    pub correlation_id: Option<String>,
    /// Conversation from which the triggering request originated, when known.
    #[serde(default)]
    pub source_conversation_id: Option<String>,
    pub thinking: Option<String>,
    pub tool_calls: Option<String>,
    pub text_chunks: Option<String>,
    pub timeline: Option<String>,
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
            turn_id: format(generate(), IdType::Turn),
            context: TurnContext::default(),
            thinking: Vec::new(),
            thinking_buffer: String::new(),
            thinking_start_timestamp: None,
            tool_calls: HashMap::new(),
            timeline: Vec::new(),
            timeline_tool_positions: HashMap::new(),
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
        self.timeline.push(OutputTimelineItem::Text {
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
            let text = std::mem::take(&mut self.thinking_buffer);
            self.thinking.push(ThinkingBlock {
                text: text.clone(),
                timestamp,
            });
            self.timeline
                .push(OutputTimelineItem::Thinking { text, timestamp });
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
                id: id.clone(),
                name: name.clone(),
                kind: kind.clone(),
                input: input.clone(),
                output: None,
                status: "pending".to_string(),
                locations: locations.clone(),
                started_at: now,
                completed_at: None,
                error: None,
            },
        );

        if let Some(position) = self.timeline_tool_positions.get(&id).copied() {
            if let Some(OutputTimelineItem::ToolCall {
                kind: existing_kind,
                input: existing_input,
                locations: existing_locations,
                started_at: existing_started_at,
                ..
            }) = self.timeline.get_mut(position)
            {
                *existing_kind = kind;
                **existing_input = input.clone();
                *existing_locations = locations;
                *existing_started_at = now;
            }
        } else {
            self.timeline_tool_positions
                .insert(id.clone(), self.timeline.len());
            self.timeline.push(OutputTimelineItem::ToolCall {
                id,
                name,
                kind,
                input: Box::new(input),
                output: Box::new(None),
                status: "pending".to_string(),
                locations,
                started_at: now,
                completed_at: None,
                error: None,
            });
        }
    }

    /// Record tool call update (completion or failure)
    pub fn record_tool_call_update(
        &mut self,
        id: &str,
        input: Option<serde_json::Value>,
        output: Option<serde_json::Value>,
        status: String,
        error: Option<String>,
    ) {
        if self.sealed {
            return; // Silently discard data after seal
        }
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or(std::time::Duration::from_secs(0))
            .as_secs();
        if let Some(tool_call) = self.tool_calls.get_mut(id) {
            if let Some(ref input) = input {
                tool_call.input = input.clone();
            }
            tool_call.output = output.clone();
            tool_call.status = status.clone();
            tool_call.error = error.clone();
            tool_call.completed_at = Some(now);
        }

        if let Some(position) = self.timeline_tool_positions.get(id).copied() {
            if let Some(OutputTimelineItem::ToolCall {
                input: timeline_input,
                output: timeline_output,
                status: timeline_status,
                completed_at: timeline_completed_at,
                error: timeline_error,
                ..
            }) = self.timeline.get_mut(position)
            {
                if let Some(input) = input {
                    **timeline_input = input.clone();
                }
                **timeline_output = output;
                *timeline_status = status;
                *timeline_completed_at = Some(now);
                *timeline_error = error;
            }
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

    /// Set ACP context window usage snapshot
    pub fn set_context_usage(&mut self, used: u64, window: u64) {
        self.metadata.context_used = Some(used);
        self.metadata.context_window = Some(window);
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
            turn_id: self.turn_id,
            message_id: None,
            role: "assistant".to_string(),
            sender_agent_id: None,
            sender_agent_name: None,
            message_type: Some("agent_output".to_string()),
            reply_to_message_id: self.context.reply_to_message_id,
            correlation_id: self.context.correlation_id,
            source_conversation_id: self.context.source_conversation_id,
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
            timeline: if self.timeline.is_empty() {
                None
            } else {
                Some(serde_json::to_string(&self.timeline).unwrap_or_default())
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
    /// One-shot delivery context consumed by the next `begin_turn` call for a
    /// conversation. This avoids changing every backend command/trait signature.
    pending_contexts: RwLock<HashMap<String, TurnContext>>,
}

impl OutputAccumulatorRegistry {
    /// Create a new registry
    pub fn new() -> Self {
        Self {
            accumulators: RwLock::new(HashMap::new()),
            generations: RwLock::new(HashMap::new()),
            pending_contexts: RwLock::new(HashMap::new()),
        }
    }

    /// Attach correlation metadata to the next turn started for a conversation.
    pub async fn set_pending_turn_context(&self, conversation_id: &str, context: TurnContext) {
        self.pending_contexts
            .write()
            .await
            .insert(conversation_id.to_string(), context);
    }

    /// Clear any pending turn context for a conversation.
    ///
    /// This should be called when message injection fails after setting the context,
    /// to prevent stale metadata from leaking into the next turn.
    pub async fn clear_pending_turn_context(&self, conversation_id: &str) {
        self.pending_contexts.write().await.remove(conversation_id);
    }

    /// Begin a new turn for a conversation
    /// Creates a new accumulator for this turn with an incremented generation.
    /// Returns a TurnToken that must be used for all subsequent operations on this turn.
    ///
    /// Lock order: generations -> accumulators (to prevent deadlock with get_current_token)
    pub async fn begin_turn(&self, conversation_id: &str) -> TurnToken {
        // Lock generations first to maintain consistent lock order
        let mut generations = self.generations.write().await;
        let context = self.pending_contexts.write().await.remove(conversation_id);

        // Get the previous generation before incrementing
        let prev_generation = generations.get(conversation_id).copied();

        // Increment generation for this conversation
        let generation = generations
            .entry(conversation_id.to_string())
            .and_modify(|g| *g += 1)
            .or_insert(1);
        let generation = *generation;

        // Now lock accumulators
        let mut accumulators = self.accumulators.write().await;

        // Clean up the previous generation's accumulator to prevent memory leak
        if let Some(prev_gen) = prev_generation {
            if let Some(_old_accumulator) =
                accumulators.remove(&(conversation_id.to_string(), prev_gen))
            {
                // The old accumulator is dropped here. The caller should have called flush()
                // before starting a new turn. If they didn't, the data is lost - this is
                // acceptable because the turn was abandoned or crashed.
                tracing::debug!(
                    conversation_id = %conversation_id,
                    generation = prev_gen,
                    "Cleaned up previous generation's accumulator"
                );
            }
        }

        let conv_id_i64 = ergatai_error::id::parse_to_i64(conversation_id).unwrap_or(0);
        let mut accumulator_data = TurnAccumulator::new(conv_id_i64);
        accumulator_data.context = context.unwrap_or_default();
        let turn_id = accumulator_data.turn_id.clone();
        let accumulator = Arc::new(Mutex::new(accumulator_data));
        accumulators.insert(
            (conversation_id.to_string(), generation),
            accumulator.clone(),
        );

        TurnToken {
            conversation_id: conversation_id.to_string(),
            generation,
            turn_id,
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
                let turn_id = accumulator.lock().await.turn_id.clone();
                return Some(TurnToken {
                    conversation_id: conversation_id.to_string(),
                    generation,
                    turn_id,
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

#[cfg(test)]
mod tests {
    use super::*;

    fn create_test_accumulator() -> TurnAccumulator {
        TurnAccumulator::new(12345)
    }

    #[test]
    fn test_turn_accumulator_creation() {
        let acc = create_test_accumulator();
        assert_eq!(acc.conversation_id, 12345);
        assert!(acc.thinking.is_empty());
        assert!(acc.thinking_buffer.is_empty());
        assert!(acc.tool_calls.is_empty());
        assert!(acc.text_chunks.is_empty());
        assert!(acc.final_text.is_empty());
        assert!(!acc.sealed);
    }

    #[test]
    fn test_accumulate_thinking() {
        let mut acc = create_test_accumulator();

        acc.accumulate_thinking("Thinking part 1");
        acc.accumulate_thinking(" Thinking part 2");

        // Should be in buffer, not yet flushed
        assert_eq!(acc.thinking_buffer, "Thinking part 1 Thinking part 2");
        assert!(acc.thinking.is_empty());
    }

    #[test]
    fn test_accumulate_text() {
        let mut acc = create_test_accumulator();

        acc.accumulate_text("Hello");
        acc.accumulate_text(" World");

        assert_eq!(acc.final_text, "Hello World");
    }

    #[test]
    fn test_record_tool_call_start() {
        let mut acc = create_test_accumulator();

        acc.record_tool_call_start(
            "tool-1".to_string(),
            "edit_file".to_string(),
            Some("write".to_string()),
            serde_json::json!({"path": "test.rs"}),
            vec![],
        );

        assert_eq!(acc.tool_calls.len(), 1);
        let tool = acc.tool_calls.get("tool-1").unwrap();
        assert_eq!(tool.name, "edit_file");
        assert_eq!(tool.kind, Some("write".to_string()));
        assert_eq!(tool.status, "pending");
    }

    #[test]
    fn test_record_tool_call_update() {
        let mut acc = create_test_accumulator();

        acc.record_tool_call_start(
            "tool-1".to_string(),
            "edit_file".to_string(),
            None,
            serde_json::json!({}),
            vec![],
        );

        acc.record_tool_call_update(
            "tool-1",
            None,
            Some(serde_json::json!({"success": true})),
            "completed".to_string(),
            None,
        );

        let tool = acc.tool_calls.get("tool-1").unwrap();
        assert_eq!(tool.status, "completed");
        assert!(tool.output.is_some());
        assert!(tool.error.is_none());
    }

    #[test]
    fn test_record_tool_call_failed() {
        let mut acc = create_test_accumulator();

        acc.record_tool_call_start(
            "tool-1".to_string(),
            "edit_file".to_string(),
            None,
            serde_json::json!({}),
            vec![],
        );

        acc.record_tool_call_update(
            "tool-1",
            None,
            None,
            "failed".to_string(),
            Some("File not found".to_string()),
        );

        let tool = acc.tool_calls.get("tool-1").unwrap();
        assert_eq!(tool.status, "failed");
        assert_eq!(tool.error, Some("File not found".to_string()));
    }

    #[test]
    fn test_record_tool_call_update_nonexistent() {
        let mut acc = create_test_accumulator();

        // Updating a non-existent tool call should not panic
        acc.record_tool_call_update("nonexistent", None, None, "completed".to_string(), None);

        assert!(acc.tool_calls.is_empty());
    }

    #[test]
    fn test_timeline_preserves_interleaving_and_tool_update() {
        let mut acc = create_test_accumulator();

        acc.accumulate_thinking("before tool");
        acc.record_tool_call_start(
            "tool-1".to_string(),
            "send_message".to_string(),
            None,
            serde_json::json!({}),
            vec![],
        );
        acc.record_tool_call_update(
            "tool-1",
            Some(serde_json::json!({"message": "hello"})),
            Some(serde_json::json!({"status": "queued"})),
            "completed".to_string(),
            None,
        );
        acc.accumulate_thinking("after tool");
        acc.accumulate_text("final");

        let output = acc.into_output_data();
        let timeline = serde_json::from_str::<Vec<serde_json::Value>>(
            output.timeline.as_deref().unwrap_or_default(),
        )
        .unwrap();

        let types: Vec<&str> = timeline
            .iter()
            .map(|item| {
                item.get("type")
                    .and_then(serde_json::Value::as_str)
                    .unwrap()
            })
            .collect();
        assert_eq!(types, ["thinking", "tool_call", "thinking", "text"]);

        let tool = &timeline[1];
        assert_eq!(
            tool.get("input"),
            Some(&serde_json::json!({"message": "hello"}))
        );
        assert_eq!(
            tool.get("output"),
            Some(&serde_json::json!({"status": "queued"}))
        );
    }

    #[test]
    fn test_set_metadata() {
        let mut acc = create_test_accumulator();

        acc.set_stop_reason("end_turn".to_string());
        acc.set_session_title("Test Session".to_string());

        assert_eq!(acc.metadata.stop_reason, Some("end_turn".to_string()));
        assert_eq!(acc.metadata.session_title, Some("Test Session".to_string()));
    }

    #[test]
    fn test_seal_accumulator() {
        let mut acc = create_test_accumulator();

        acc.accumulate_text("Some text");
        acc.seal();

        assert!(acc.sealed);

        // Further operations should be no-ops after sealing
        acc.accumulate_text("More text");
        assert_eq!(acc.final_text, "Some text");
    }

    #[test]
    fn test_seal_prevents_further_accumulation() {
        let mut acc = create_test_accumulator();

        acc.accumulate_text("Some text");
        acc.seal();

        assert!(acc.is_sealed());

        // Further operations should be no-ops after sealing
        acc.accumulate_text("More text");
        assert_eq!(acc.final_text, "Some text");
    }

    #[test]
    fn test_into_output_data_flushes_thinking() {
        let mut acc = create_test_accumulator();

        acc.accumulate_thinking("Unflushed thinking");

        // Before into_output_data, thinking is in buffer
        assert_eq!(acc.thinking_buffer, "Unflushed thinking");

        let output = acc.into_output_data();

        // After into_output_data, thinking should be flushed and in output
        assert!(output.thinking.is_some());
        assert!(output.thinking.unwrap().contains("Unflushed thinking"));
    }

    #[test]
    fn test_into_output_data() {
        let mut acc = create_test_accumulator();

        acc.accumulate_thinking("Thinking");
        acc.accumulate_text("Response text");
        acc.record_tool_call_start(
            "tool-1".to_string(),
            "edit".to_string(),
            None,
            serde_json::json!({}),
            vec![],
        );
        acc.set_stop_reason("end_turn".to_string());

        let output = acc.into_output_data();

        assert_eq!(output.conversation_id, 12345);
        assert_eq!(output.final_text, Some("Response text".to_string()));
        assert!(output.thinking.is_some());
        assert!(output.tool_calls.is_some());
        assert!(output.metadata.as_ref().unwrap().contains("end_turn"));
    }

    #[test]
    fn test_token_usage_tracking() {
        let mut acc = create_test_accumulator();

        acc.set_token_usage(100, 50);

        assert_eq!(acc.metadata.total_tokens.as_ref().unwrap().input, 100);
        assert_eq!(acc.metadata.total_tokens.as_ref().unwrap().output, 50);
    }

    #[test]
    fn test_multiple_thinking_blocks() {
        let mut acc = create_test_accumulator();

        acc.accumulate_thinking("First thinking");
        acc.accumulate_text("Text between thinking");

        acc.accumulate_thinking("Second thinking");
        acc.accumulate_text("More text");

        let output = acc.into_output_data();
        // Thinking should be Some (JSON string containing both blocks)
        assert!(output.thinking.is_some());
        let thinking_json = output.thinking.unwrap();
        // Should contain both thinking blocks
        assert!(thinking_json.contains("First thinking"));
        assert!(thinking_json.contains("Second thinking"));
    }

    #[test]
    fn test_text_auto_flushes_thinking() {
        let mut acc = create_test_accumulator();

        acc.accumulate_thinking("Thinking");

        // Accumulating text should auto-flush thinking buffer
        acc.accumulate_text("Response");

        assert!(acc.thinking_buffer.is_empty());
        assert_eq!(acc.thinking.len(), 1);
        assert_eq!(acc.final_text, "Response");
    }

    #[test]
    fn test_tool_call_auto_flushes_thinking() {
        let mut acc = create_test_accumulator();

        acc.accumulate_thinking("Thinking");

        // Recording tool call should auto-flush thinking buffer
        acc.record_tool_call_start(
            "tool-1".to_string(),
            "edit".to_string(),
            None,
            serde_json::json!({}),
            vec![],
        );

        assert!(acc.thinking_buffer.is_empty());
        assert_eq!(acc.thinking.len(), 1);
    }

    #[tokio::test]
    async fn test_pending_turn_context_is_consumed_once() {
        let registry = OutputAccumulatorRegistry::new();
        registry
            .set_pending_turn_context(
                "conv_1",
                TurnContext {
                    reply_to_message_id: Some("msg_request".to_string()),
                    correlation_id: Some("corr_1".to_string()),
                    source_conversation_id: Some("conv_host".to_string()),
                },
            )
            .await;

        let token = registry.begin_turn("conv_1").await;
        let output = registry.flush(&token).await.unwrap();
        assert_eq!(output.reply_to_message_id.as_deref(), Some("msg_request"));
        assert_eq!(output.correlation_id.as_deref(), Some("corr_1"));
        assert_eq!(output.source_conversation_id.as_deref(), Some("conv_host"));

        let token = registry.begin_turn("conv_1").await;
        let output = registry.flush(&token).await.unwrap();
        assert!(output.reply_to_message_id.is_none());
        assert!(output.correlation_id.is_none());
        assert!(output.source_conversation_id.is_none());
    }
}
