//! Agent state monitoring system
//!
//! Provides comprehensive monitoring of agent states including:
//! - Network traffic analysis (API call detection)
//! - Output pattern analysis (reasoning indicators)
//! - Output completion detection
//! - Process resource usage
//! - Comprehensive reasoning state detection
//! - @mention extraction and message routing

pub mod agent_state;
pub mod completion_detector;
pub mod network_monitor;
pub mod output_monitor;
pub mod output_processor;
pub mod reasoning_detector;

pub use agent_state::{AgentState, AgentStateMachine};
pub use completion_detector::{CompletionConfig, CompletionDetector, CompletionResult};
pub use network_monitor::{ApiCallPattern, NetworkMonitor};
pub use output_monitor::{IndicatorType, OutputMonitor, ReasoningIndicator};
pub use output_processor::{OutputEvent, OutputProcessor};
pub use reasoning_detector::{ReasoningDetector, ReasoningPhase, ReasoningState};
