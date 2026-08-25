//! Output processor — integrates completion detection, @mention extraction,
//! and message routing
//!
//! This is the main entry point for processing agent output. It:
//! 1. Buffers output and strips ANSI codes
//! 2. Detects @mention patterns
//! 3. Determines when output is complete
//! 4. Extracts message content
//! 5. Triggers routing to target agents

use std::sync::Arc;
use tokio::sync::{broadcast, RwLock};
use tracing::{debug, info, warn};

use super::completion_detector::{CompletionDetector, CompletionResult};
use super::network_monitor::NetworkMonitor;
use super::output_monitor::OutputMonitor;

/// Output processor for an agent
pub struct OutputProcessor {
    pid: u32,
    agent_id: String,

    // Monitors
    output_monitor: Arc<OutputMonitor>,
    network_monitor: Arc<NetworkMonitor>,
    completion_detector: Arc<CompletionDetector>,

    // State
    current_response: Arc<RwLock<ResponseBuffer>>,
    processed_bytes: Arc<RwLock<usize>>,

    // Event broadcast
    event_tx: broadcast::Sender<OutputEvent>,
}

#[derive(Debug, Clone)]
struct ResponseBuffer {
    raw_output: Vec<u8>,
    clean_text: String,
    mentions: Vec<String>,
    started_at: u64,
    is_complete: bool,
}

impl ResponseBuffer {
    fn new() -> Self {
        Self {
            raw_output: Vec::new(),
            clean_text: String::new(),
            mentions: Vec::new(),
            started_at: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_secs(),
            is_complete: false,
        }
    }

    fn append(&mut self, raw: &[u8], clean: &str) {
        self.raw_output.extend_from_slice(raw);
        self.clean_text.push_str(clean);
    }

    fn reset(&mut self) {
        self.raw_output.clear();
        self.clean_text.clear();
        self.mentions.clear();
        self.started_at = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs();
        self.is_complete = false;
    }
}

/// Output event
#[derive(Debug, Clone)]
pub enum OutputEvent {
    /// Output chunk received
    OutputReceived { bytes: usize, clean_text: String },

    /// @mention detected
    MentionDetected {
        target_agent: String,
        full_text: String,
    },

    /// Response complete
    ResponseComplete {
        full_text: String,
        mentions: Vec<String>,
        duration_ms: u64,
    },

    /// Processing started
    ProcessingStarted,

    /// Processing completed (reasoning done, generating response)
    ProcessingCompleted,
}

impl OutputProcessor {
    pub fn new(pid: u32, agent_id: String) -> Self {
        let (event_tx, _) = broadcast::channel(100);

        Self {
            pid,
            agent_id,
            output_monitor: Arc::new(OutputMonitor::new()),
            network_monitor: Arc::new(NetworkMonitor::new(pid)),
            completion_detector: Arc::new(CompletionDetector::new()),
            current_response: Arc::new(RwLock::new(ResponseBuffer::new())),
            processed_bytes: Arc::new(RwLock::new(0)),
            event_tx,
        }
    }

    /// Subscribe to output events
    pub fn subscribe(&self) -> broadcast::Receiver<OutputEvent> {
        self.event_tx.subscribe()
    }

    /// Process new output from PTY
    pub async fn process_output(&self, raw_output: &[u8]) {
        // Strip ANSI codes to get clean text
        let clean_text = strip_ansi_codes(raw_output);

        // Update monitors
        self.output_monitor.append(raw_output).await;
        self.completion_detector.on_output(raw_output).await;

        // Update current response buffer
        let mut response = self.current_response.write().await;
        response.append(raw_output, &clean_text);

        // Update processed bytes counter
        *self.processed_bytes.write().await += raw_output.len();

        // Broadcast output received event
        let _ = self.event_tx.send(OutputEvent::OutputReceived {
            bytes: raw_output.len(),
            clean_text: clean_text.clone(),
        });

        // Check for @mentions
        let mentions = extract_mentions(&clean_text);
        if !mentions.is_empty() {
            for mention in &mentions {
                if !response.mentions.contains(mention) {
                    response.mentions.push(mention.clone());

                    // Broadcast mention detected
                    let _ = self.event_tx.send(OutputEvent::MentionDetected {
                        target_agent: mention.clone(),
                        full_text: clean_text.clone(),
                    });

                    info!(
                        pid = self.pid,
                        from = self.agent_id,
                        to = mention,
                        "@mention detected in output"
                    );
                }
            }
        }

        // Check if response is complete
        let completion = self.completion_detector.is_complete().await;
        if let CompletionResult::Complete { confidence, reason } = completion {
            if confidence > 0.7 && !response.is_complete {
                response.is_complete = true;

                let duration_ms = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_secs()
                    .saturating_sub(response.started_at)
                    * 1000;

                info!(
                    pid = self.pid,
                    agent = self.agent_id,
                    confidence = confidence,
                    reason = reason,
                    mentions = response.mentions.len(),
                    "Response complete"
                );

                // Broadcast response complete
                let _ = self.event_tx.send(OutputEvent::ResponseComplete {
                    full_text: response.clean_text.clone(),
                    mentions: response.mentions.clone(),
                    duration_ms,
                });

                // Route messages to mentioned agents
                self.route_mentions(&response).await;

                // Reset for next response
                response.reset();
                self.completion_detector.reset().await;
            }
        }
    }

    /// Route @mentions to target agents
    async fn route_mentions(&self, response: &ResponseBuffer) {
        for target_agent in &response.mentions {
            // Extract message content (everything after @mention)
            let message = self.extract_message_for_agent(&response.clean_text, target_agent);

            // Route via NATS (using ergatai_collab)
            if let Err(e) = self
                .route_message_via_nats(target_agent, &message)
                .await
            {
                warn!(
                    pid = self.pid,
                    from = self.agent_id,
                    to = target_agent,
                    error = %e,
                    "Failed to route message"
                );
            } else {
                info!(
                    pid = self.pid,
                    from = self.agent_id,
                    to = target_agent,
                    message_len = message.len(),
                    "Message routed successfully"
                );
            }
        }
    }

    /// Route message via NATS
    async fn route_message_via_nats(
        &self,
        target_agent: &str,
        message: &str,
    ) -> Result<(), ergatai_error::ErgataiError> {
        // This will be implemented when integrating with ergatai_collab
        // For now, just log
        debug!(
            from = self.agent_id,
            to = target_agent,
            message = message,
            "Would route message via NATS"
        );
        Ok(())
    }

    /// Extract message content for a specific @mention
    fn extract_message_for_agent(&self, text: &str, target_agent: &str) -> String {
        // Find the @mention and extract everything after it until the next @mention or end
        let mention_pattern = format!("@{}", target_agent);

        if let Some(start_idx) = text.find(&mention_pattern) {
            let after_mention = &text[start_idx + mention_pattern.len()..];

            // Find the next @mention or end of text
            let next_mention_idx = after_mention
                .find('@')
                .map(|idx| idx)
                .unwrap_or(after_mention.len());

            let message = after_mention[..next_mention_idx].trim();
            message.to_string()
        } else {
            // No @mention found, return full text
            text.to_string()
        }
    }

    /// Get current response text
    pub async fn get_current_response(&self) -> String {
        self.current_response.read().await.clean_text.clone()
    }

    /// Get total processed bytes
    pub async fn get_processed_bytes(&self) -> usize {
        *self.processed_bytes.read().await
    }

    /// Update network status (call this periodically)
    pub async fn update_network_status(&self) {
        if let Err(e) = self.network_monitor.update().await {
            debug!(pid = self.pid, error = %e, "Failed to update network status");
        }

        let api_pattern = self.network_monitor.detect_api_call().await;
        let api_in_progress = matches!(
            api_pattern,
            super::network_monitor::ApiCallPattern::Calling { .. }
        );

        self.completion_detector
            .on_api_call_status(api_in_progress)
            .await;
    }
}

/// Strip ANSI escape codes from bytes
fn strip_ansi_codes(input: &[u8]) -> String {
    let text = String::from_utf8_lossy(input);

    // Simple ANSI stripping (remove escape sequences)
    let mut result = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();

    while let Some(c) = chars.next() {
        if c == '\x1b' {
            // Skip escape sequence
            if chars.peek() == Some(&'[') {
                chars.next(); // consume '['
                // Skip until we find a letter (the command)
                while let Some(&next) = chars.peek() {
                    chars.next();
                    if next.is_ascii_alphabetic() {
                        break;
                    }
                }
            }
        } else {
            result.push(c);
        }
    }

    result
}

/// Extract @mentions from text (simple implementation)
fn extract_mentions(text: &str) -> Vec<String> {
    let mut mentions = Vec::new();
    let mut chars = text.chars().peekable();

    while let Some(c) = chars.next() {
        if c == '@' {
            // Found @, now collect the agent name
            let mut name = String::new();
            while let Some(&next) = chars.peek() {
                if next.is_alphanumeric() || next == '_' || next == '-' {
                    name.push(next);
                    chars.next();
                } else {
                    break;
                }
            }
            if !name.is_empty() {
                mentions.push(name);
            }
        }
    }

    mentions
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_strip_ansi_codes() {
        let input = b"\x1b[31mRed text\x1b[0m";
        let result = strip_ansi_codes(input);
        assert_eq!(result, "Red text");
    }

    #[test]
    fn test_extract_mentions() {
        let text = "@agent2 hello @agent3 how are you?";
        let mentions = extract_mentions(text);
        assert_eq!(mentions, vec!["agent2", "agent3"]);
    }

    #[test]
    fn test_extract_message_for_agent() {
        let processor = OutputProcessor::new(12345, "agent1".to_string());

        let text = "@agent2 please review this code @agent3 can you help?";
        let message = processor.extract_message_for_agent(text, "agent2");
        assert_eq!(message, "please review this code");
    }

    #[tokio::test]
    async fn test_mention_detection() {
        let processor = OutputProcessor::new(12345, "agent1".to_string());

        processor
            .process_output(b"@agent2 hello, how are you?")
            .await;

        let response = processor.current_response.read().await;
        assert!(response.mentions.contains(&"agent2".to_string()));
    }
}
