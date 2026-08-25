//! Output completion detector
//!
//! Detects when an agent has finished generating a response by analyzing
//! multiple signals: output pause, cursor position, API call status, etc.

use std::sync::Arc;
use tokio::sync::RwLock;
use tracing::trace;

/// Output completion detector
pub struct CompletionDetector {
    state: Arc<RwLock<CompletionState>>,
    config: CompletionConfig,
}

#[derive(Debug, Clone)]
pub struct CompletionConfig {
    /// Time (ms) without output to consider "paused"
    pub pause_threshold_ms: u64,

    /// Minimum output length to consider a "response"
    pub min_response_length: usize,

    /// Patterns that indicate completion
    pub completion_patterns: Vec<String>,

    /// Patterns that indicate "still working"
    pub working_patterns: Vec<String>,
}

impl Default for CompletionConfig {
    fn default() -> Self {
        Self {
            pause_threshold_ms: 3000, // 3 seconds
            min_response_length: 20,
            completion_patterns: vec![
                // Common completion markers
                "Is there anything else".to_string(),
                "Let me know if".to_string(),
                "Feel free to".to_string(),
                // End of response indicators
                "\n> ".to_string(), // Prompt ready
                "\n$ ".to_string(), // Shell prompt
                "\n❯ ".to_string(), // Modern prompt
            ],
            working_patterns: vec![
                "thinking...".to_string(),
                "reasoning...".to_string(),
                "analyzing...".to_string(),
                "processing...".to_string(),
                "⠋".to_string(), // Spinner
                "⠙".to_string(),
                "⠹".to_string(),
            ],
        }
    }
}

#[derive(Debug, Clone)]
pub struct CompletionState {
    /// Last time output was received
    pub last_output_time: u64,

    /// Total output length in current "turn"
    pub output_length: usize,

    /// Whether we detected a completion marker
    pub completion_detected: bool,

    /// Whether we detected a "still working" pattern
    pub working_detected: bool,

    /// Whether API call is in progress
    pub api_call_in_progress: bool,

    /// Number of consecutive pauses
    pub pause_count: u32,
}

impl CompletionDetector {
    pub fn new() -> Self {
        Self {
            state: Arc::new(RwLock::new(CompletionState {
                last_output_time: 0,
                output_length: 0,
                completion_detected: false,
                working_detected: false,
                api_call_in_progress: false,
                pause_count: 0,
            })),
            config: CompletionConfig::default(),
        }
    }

    pub fn with_config(config: CompletionConfig) -> Self {
        Self {
            state: Arc::new(RwLock::new(CompletionState {
                last_output_time: 0,
                output_length: 0,
                completion_detected: false,
                working_detected: false,
                api_call_in_progress: false,
                pause_count: 0,
            })),
            config,
        }
    }

    /// Notify that output was received
    pub async fn on_output(&self, output: &[u8]) {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as u64;

        let mut state = self.state.write().await;
        state.last_output_time = now;
        state.output_length += output.len();

        let text = String::from_utf8_lossy(output);

        // Check for completion patterns
        for pattern in &self.config.completion_patterns {
            if text.contains(pattern) {
                state.completion_detected = true;
                trace!("Completion pattern detected: {}", pattern);
                break;
            }
        }

        // Check for working patterns
        for pattern in &self.config.working_patterns {
            if text.contains(pattern) {
                state.working_detected = true;
                trace!("Working pattern detected: {}", pattern);
                break;
            }
        }
    }

    /// Notify API call status
    pub async fn on_api_call_status(&self, in_progress: bool) {
        let mut state = self.state.write().await;
        state.api_call_in_progress = in_progress;
    }

    /// Check if response is complete
    pub async fn is_complete(&self) -> CompletionResult {
        let state = self.state.read().await;
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as u64;

        let time_since_output = now.saturating_sub(state.last_output_time);

        // Signal 1: API call in progress → not complete
        if state.api_call_in_progress {
            return CompletionResult::NotComplete {
                reason: "API call in progress".to_string(),
            };
        }

        // Signal 2: Completion pattern detected → complete
        // Checked BEFORE the working-pattern check because a completion marker
        // (e.g. "Is there anything else...") is strong evidence that the turn
        // finished, even if a working pattern ("thinking...") appeared earlier
        // in the same turn. Previously, working_detected short-circuited this
        // branch, causing a logic deadlock where the detector would never
        // declare completion once any "thinking..." was seen.
        if state.completion_detected && state.output_length >= self.config.min_response_length {
            return CompletionResult::Complete {
                confidence: 0.95,
                reason: "Completion pattern detected".to_string(),
            };
        }

        // Signal 3: Working pattern detected AND output still flowing → not complete
        // If output has paused longer than the pause threshold, treat working as
        // stale — the agent has either finished or is blocked, not actively working.
        if state.working_detected && time_since_output < self.config.pause_threshold_ms {
            return CompletionResult::NotComplete {
                reason: "Working pattern detected (output still flowing)".to_string(),
            };
        }

        // Signal 4: Long pause with sufficient output → likely complete
        if time_since_output > self.config.pause_threshold_ms
            && state.output_length >= self.config.min_response_length
        {
            return CompletionResult::Complete {
                confidence: 0.75,
                reason: format!(
                    "Pause detected ({}ms > {}ms threshold)",
                    time_since_output, self.config.pause_threshold_ms
                ),
            };
        }

        // Signal 5: Very long pause → probably complete (even with short output)
        if time_since_output > self.config.pause_threshold_ms * 2 {
            return CompletionResult::Complete {
                confidence: 0.60,
                reason: "Long pause detected".to_string(),
            };
        }

        // Default: not complete
        CompletionResult::NotComplete {
            reason: format!(
                "Waiting ({}ms since output, {} bytes)",
                time_since_output, state.output_length
            ),
        }
    }

    /// Reset state for new response
    pub async fn reset(&self) {
        let mut state = self.state.write().await;
        state.last_output_time = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as u64;
        state.output_length = 0;
        state.completion_detected = false;
        state.working_detected = false;
        state.api_call_in_progress = false;
        state.pause_count = 0;
    }
}

/// Completion detection result
#[derive(Debug, Clone)]
pub enum CompletionResult {
    /// Response appears complete
    Complete { confidence: f32, reason: String },

    /// Response not yet complete
    NotComplete { reason: String },
}

impl CompletionResult {
    /// Check if complete with high confidence
    pub fn is_complete(&self) -> bool {
        match self {
            CompletionResult::Complete { confidence, .. } => *confidence > 0.7,
            CompletionResult::NotComplete { .. } => false,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_completion_detection() {
        let detector = CompletionDetector::new();

        // Initially not complete (no output yet)
        let result = detector.is_complete().await;
        assert!(!result.is_complete());

        // Simulate output
        detector
            .on_output(b"Hello, I can help you with that.")
            .await;

        // Wait for pause threshold
        tokio::time::sleep(tokio::time::Duration::from_millis(100)).await;

        // Manually set last_output_time to past
        {
            let mut state = detector.state.write().await;
            state.last_output_time = 0;
        }

        // Now should be complete
        let result = detector.is_complete().await;
        assert!(result.is_complete());
    }

    #[tokio::test]
    async fn test_working_pattern_blocks_while_output_flowing() {
        let detector = CompletionDetector::new();

        // Output with working pattern
        detector.on_output(b"thinking... let me analyze").await;

        // last_output_time is NOW (output still flowing) — working pattern
        // should block completion because the agent is still actively producing.
        let result = detector.is_complete().await;
        assert!(
            !result.is_complete(),
            "working pattern should block completion while output is flowing"
        );
    }

    #[tokio::test]
    async fn test_working_pattern_stale_after_pause() {
        let detector = CompletionDetector::new();

        // Output with working pattern then long pause — working becomes stale.
        detector.on_output(b"thinking... let me analyze").await;
        detector
            .on_output(b"some more output to exceed min_response_length threshold for completion detection")
            .await;

        // Simulate long pause (well past pause_threshold_ms)
        {
            let mut state = detector.state.write().await;
            state.last_output_time = 0;
        }

        // After a long pause, stale working pattern should NOT block completion.
        // Completion still requires either a completion pattern or sufficient pause
        // with min_response_length. Here we have the long pause + enough bytes.
        let result = detector.is_complete().await;
        assert!(
            result.is_complete(),
            "stale working pattern should not block completion after pause"
        );
    }

    #[tokio::test]
    async fn test_api_call_blocks_completion() {
        let detector = CompletionDetector::new();

        // Output some text
        detector.on_output(b"Processing your request").await;

        // API call in progress
        detector.on_api_call_status(true).await;

        // Set time to past
        {
            let mut state = detector.state.write().await;
            state.last_output_time = 0;
        }

        // Should not be complete (API call in progress)
        let result = detector.is_complete().await;
        assert!(!result.is_complete());
    }
}
