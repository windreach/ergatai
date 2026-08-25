//! Output pattern monitor for detecting reasoning indicators
//!
//! Analyzes agent output stream to detect reasoning patterns like
//! "thinking...", spinners, and output pauses.

use std::sync::Arc;
use tokio::sync::RwLock;

/// Output pattern monitor
pub struct OutputMonitor {
    buffer: Arc<RwLock<Vec<u8>>>,
    last_output_time: Arc<RwLock<u64>>,
}

impl OutputMonitor {
    pub fn new() -> Self {
        Self {
            buffer: Arc::new(RwLock::new(Vec::new())),
            last_output_time: Arc::new(RwLock::new(0)),
        }
    }

    /// Append output bytes to buffer
    pub async fn append(&self, bytes: &[u8]) {
        let mut buffer = self.buffer.write().await;
        buffer.extend_from_slice(bytes);

        // Keep buffer bounded (last 64KB)
        const MAX_BUFFER_SIZE: usize = 64 * 1024;
        if buffer.len() > MAX_BUFFER_SIZE {
            let drain_count = buffer.len() - MAX_BUFFER_SIZE;
            buffer.drain(0..drain_count);
        }

        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs();
        *self.last_output_time.write().await = now;
    }

    /// Get current output snapshot
    pub async fn snapshot(&self) -> Vec<u8> {
        self.buffer.read().await.clone()
    }

    /// Clear buffer
    pub async fn clear(&self) {
        self.buffer.write().await.clear();
    }

    /// Get time since last output (ms)
    pub async fn time_since_last_output(&self) -> u64 {
        let last = *self.last_output_time.read().await;
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs();
        now.saturating_sub(last) * 1000
    }

    /// Detect reasoning indicators in output
    pub async fn detect_reasoning_indicators(&self) -> Vec<ReasoningIndicator> {
        let buffer = self.buffer.read().await;
        let text = String::from_utf8_lossy(&buffer);
        let mut indicators = Vec::new();

        // Pattern 1: Explicit reasoning prompts
        let reasoning_keywords = [
            "thinking...",
            "reasoning...",
            "analyzing...",
            "processing...",
            "let me think",
            "considering",
            "evaluating",
            "calculating",
            "pondering",
        ];

        for keyword in &reasoning_keywords {
            if text.to_lowercase().contains(keyword) {
                indicators.push(ReasoningIndicator {
                    pattern: keyword.to_string(),
                    confidence: 0.85,
                    indicator_type: IndicatorType::ExplicitPrompt,
                });
            }
        }

        // Pattern 2: Spinner animations
        if self.detect_spinner(&text) {
            indicators.push(ReasoningIndicator {
                pattern: "spinner".to_string(),
                confidence: 0.75,
                indicator_type: IndicatorType::Spinner,
            });
        }

        // Pattern 3: Output pause (waiting for API)
        let time_since = self.time_since_last_output().await;
        if time_since > 2000 && buffer.len() > 0 {
            // More than 2 seconds without output
            indicators.push(ReasoningIndicator {
                pattern: "output_paused".to_string(),
                confidence: 0.65,
                indicator_type: IndicatorType::PausePattern,
            });
        }

        // Pattern 4: Markdown formatting (LLM output style)
        if self.detect_markdown(&text) {
            indicators.push(ReasoningIndicator {
                pattern: "markdown".to_string(),
                confidence: 0.70,
                indicator_type: IndicatorType::OutputFormat,
            });
        }

        indicators
    }

    /// Detect spinner animations
    fn detect_spinner(&self, text: &str) -> bool {
        let spinner_patterns = [
            "⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏", // Braille
            "◐", "◓", "◑", "◒", // Circle
            "█", "▓", "▒", "░", // Block
        ];

        spinner_patterns.iter().any(|p| text.contains(p))
    }

    /// Detect Markdown formatting
    fn detect_markdown(&self, text: &str) -> bool {
        let markdown_indicators = [
            ("^#", "heading"),
            ("^```", "code_block"),
            ("^\\s*[-*]\\s+", "list"),
            ("\\*\\*[^*]+\\*\\*", "bold"),
            ("`[^`]+`", "inline_code"),
        ];

        let match_count = markdown_indicators
            .iter()
            .filter(|(pattern, _)| {
                regex::Regex::new(pattern)
                    .map(|re| re.is_match(text))
                    .unwrap_or(false)
            })
            .count();

        match_count >= 2 // At least 2 Markdown features
    }
}

/// Reasoning indicator detected in output
#[derive(Debug, Clone)]
pub struct ReasoningIndicator {
    pub pattern: String,
    pub confidence: f32,
    pub indicator_type: IndicatorType,
}

/// Type of reasoning indicator
#[derive(Debug, Clone)]
pub enum IndicatorType {
    /// Explicit prompt like "thinking..."
    ExplicitPrompt,
    /// Spinner animation
    Spinner,
    /// Output pause pattern
    PausePattern,
    /// Output format (Markdown)
    OutputFormat,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_detect_reasoning_keywords() {
        let monitor = OutputMonitor::new();
        monitor.append(b"thinking...").await;

        let indicators = monitor.detect_reasoning_indicators().await;
        assert!(!indicators.is_empty());
        assert_eq!(indicators[0].pattern, "thinking...");
    }

    #[tokio::test]
    async fn test_detect_spinner() {
        let monitor = OutputMonitor::new();
        monitor.append("⠋⠙⠹⠸".as_bytes()).await;

        let indicators = monitor.detect_reasoning_indicators().await;
        assert!(indicators.iter().any(|i| i.pattern == "spinner"));
    }

    #[tokio::test]
    async fn test_detect_markdown() {
        let monitor = OutputMonitor::new();
        monitor.append(b"# Heading\n\n```rust\ncode\n```").await;

        let indicators = monitor.detect_reasoning_indicators().await;
        assert!(indicators.iter().any(|i| i.pattern == "markdown"));
    }
}
