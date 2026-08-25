//! Comprehensive reasoning state detector
//!
//! Combines multiple signals (network, output, etc.) to detect
//! whether an agent is currently reasoning (calling LLM API).

use super::network_monitor::ApiCallPattern;
use super::output_monitor::{IndicatorType, OutputMonitor, ReasoningIndicator};
use std::sync::Arc;
use tokio::sync::RwLock;

/// Comprehensive reasoning detector
pub struct ReasoningDetector {
    started_at: Arc<RwLock<Option<u64>>>,
}

impl ReasoningDetector {
    pub fn new() -> Self {
        Self {
            started_at: Arc::new(RwLock::new(None)),
        }
    }

    /// Detect reasoning state from output and API patterns
    pub async fn detect(&self, output: &[u8]) -> ReasoningState {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs();

        // Detect reasoning indicators from output
        let output_monitor = OutputMonitor::new();
        output_monitor.append(output).await;
        let indicators = output_monitor.detect_reasoning_indicators().await;

        // Calculate confidence from indicators
        let mut confidence = 0.0;
        let mut evidence = Vec::new();

        // Each indicator contributes to confidence
        for indicator in &indicators {
            let weight = match indicator.indicator_type {
                IndicatorType::ExplicitPrompt => 0.30, // Strong signal
                IndicatorType::Spinner => 0.25,
                IndicatorType::PausePattern => 0.20,
                IndicatorType::OutputFormat => 0.15,
            };

            confidence += indicator.confidence * weight;
            evidence.push(format!(
                "{} (confidence: {:.0}%)",
                indicator.pattern,
                indicator.confidence * 100.0
            ));
        }

        // Limit max confidence from output alone
        confidence = confidence.min(0.7);

        // Determine phase
        let phase = if confidence > 0.6 {
            ReasoningPhase::Reasoning
        } else if confidence > 0.3 {
            ReasoningPhase::LikelyReasoning
        } else if confidence > 0.1 {
            ReasoningPhase::PossiblyReasoning
        } else {
            // Check if we're responding (generating output)
            if output.len() > 100 && indicators.is_empty() {
                ReasoningPhase::Responding
            } else {
                ReasoningPhase::NotReasoning
            }
        };

        // Track started_at
        let started_at = if phase == ReasoningPhase::Reasoning
            || phase == ReasoningPhase::LikelyReasoning
        {
            let mut started = self.started_at.write().await;
            if started.is_none() {
                *started = Some(now);
            }
            started.unwrap()
        } else {
            let mut started = self.started_at.write().await;
            *started = None;
            now
        };

        let elapsed_ms = now.saturating_sub(started_at) * 1000;

        ReasoningState {
            phase,
            confidence,
            evidence,
            started_at,
            elapsed_ms,
        }
    }

    /// Detect reasoning state combining network and output signals
    pub async fn detect_with_network(
        &self,
        output: &[u8],
        api_pattern: &ApiCallPattern,
    ) -> ReasoningState {
        let mut state = self.detect(output).await;

        // Boost confidence if API call detected
        if let ApiCallPattern::Calling { .. } = api_pattern {
            state.confidence = (state.confidence + 0.3).min(1.0);
            state
                .evidence
                .push("API call detected (+30% confidence)".to_string());

            // Upgrade phase
            if state.confidence > 0.7 {
                state.phase = ReasoningPhase::Reasoning;
            } else if state.confidence > 0.4 {
                state.phase = ReasoningPhase::LikelyReasoning;
            }
        }

        state
    }
}

/// Reasoning state
#[derive(Debug, Clone)]
pub struct ReasoningState {
    pub phase: ReasoningPhase,
    pub confidence: f32,
    pub evidence: Vec<String>,
    pub started_at: u64,
    pub elapsed_ms: u64,
}

/// Reasoning phase
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ReasoningPhase {
    /// High confidence reasoning (>70%)
    Reasoning,
    /// Likely reasoning (40-70%)
    LikelyReasoning,
    /// Possibly reasoning (10-40%)
    PossiblyReasoning,
    /// Generating response (output streaming)
    Responding,
    /// Not reasoning
    NotReasoning,
}

impl ReasoningPhase {
    /// Get human-readable name
    pub fn name(&self) -> &'static str {
        match self {
            ReasoningPhase::Reasoning => "reasoning",
            ReasoningPhase::LikelyReasoning => "likely_reasoning",
            ReasoningPhase::PossiblyReasoning => "possibly_reasoning",
            ReasoningPhase::Responding => "responding",
            ReasoningPhase::NotReasoning => "not_reasoning",
        }
    }

    /// Check if actively reasoning
    pub fn is_reasoning(&self) -> bool {
        matches!(
            self,
            ReasoningPhase::Reasoning | ReasoningPhase::LikelyReasoning
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_detect_reasoning() {
        let detector = ReasoningDetector::new();
        let output = b"thinking... let me analyze this";

        let state = detector.detect(output).await;
        assert!(state.confidence > 0.0);
        assert!(!state.evidence.is_empty());
    }

    #[tokio::test]
    async fn test_detect_not_reasoning() {
        let detector = ReasoningDetector::new();
        // Need > 100 bytes to trigger the "Responding" branch — shorter output
        // is treated as not enough evidence to classify as active response.
        let output = b"Hello, how can I help you today? I'd be happy to assist with your questions. \
                       Here is a longer response to exceed the minimum byte threshold that the \
                       reasoning detector uses to distinguish between idle and actively responding.";

        let state = detector.detect(output).await;
        assert_eq!(state.phase, ReasoningPhase::Responding);
    }

    #[tokio::test]
    async fn test_detect_with_api_call() {
        let detector = ReasoningDetector::new();
        let output = b"Processing...";
        let api_pattern = ApiCallPattern::Calling {
            target: "104.18.7.184:443".parse().unwrap(),
            established_connections: 1,
        };

        let state = detector.detect_with_network(output, &api_pattern).await;
        assert!(state.confidence > 0.3);
        assert!(state.evidence.iter().any(|e| e.contains("API call")));
    }
}
