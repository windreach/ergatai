//! Agent state machine and state definitions
//!
//! Tracks the complete lifecycle and current state of an agent process.

use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::{broadcast, RwLock};
use tracing::info;

use super::network_monitor::{ApiCallPattern, NetworkMonitor};
use super::output_monitor::OutputMonitor;
use super::reasoning_detector::{ReasoningDetector, ReasoningPhase};

/// Complete agent state
#[derive(Debug, Clone, PartialEq)]
pub enum AgentState {
    /// Agent is starting up
    Starting,

    /// Agent is idle, waiting for input
    Idle,

    /// Agent is reasoning (calling LLM API)
    Reasoning {
        started_at: u64,
        elapsed_ms: u64,
        confidence: f32,
    },

    /// Agent is executing a tool
    ToolExecuting {
        tool_name: String,
        started_at: u64,
    },

    /// Agent is reading a file
    FileReading {
        path: PathBuf,
        started_at: u64,
    },

    /// Agent is writing a file
    FileWriting {
        path: PathBuf,
        started_at: u64,
    },

    /// Agent is executing a shell command
    CommandExecuting {
        command: String,
        started_at: u64,
    },

    /// Agent is generating a response (streaming output)
    Responding {
        started_at: u64,
        tokens_estimate: u64,
    },

    /// Agent encountered an error
    Error {
        message: String,
        recoverable: bool,
    },

    /// Agent has stopped
    Stopped {
        exit_code: Option<i32>,
    },
}

impl AgentState {
    /// Check if state is active (agent is doing something)
    pub fn is_active(&self) -> bool {
        matches!(
            self,
            AgentState::Reasoning { .. }
                | AgentState::ToolExecuting { .. }
                | AgentState::FileReading { .. }
                | AgentState::FileWriting { .. }
                | AgentState::CommandExecuting { .. }
                | AgentState::Responding { .. }
        )
    }

    /// Check if state is waiting for input
    pub fn is_idle(&self) -> bool {
        matches!(self, AgentState::Idle)
    }

    /// Get state name for logging
    pub fn name(&self) -> &'static str {
        match self {
            AgentState::Starting => "starting",
            AgentState::Idle => "idle",
            AgentState::Reasoning { .. } => "reasoning",
            AgentState::ToolExecuting { .. } => "tool_executing",
            AgentState::FileReading { .. } => "file_reading",
            AgentState::FileWriting { .. } => "file_writing",
            AgentState::CommandExecuting { .. } => "command_executing",
            AgentState::Responding { .. } => "responding",
            AgentState::Error { .. } => "error",
            AgentState::Stopped { .. } => "stopped",
        }
    }
}

/// State machine for tracking agent state transitions
pub struct AgentStateMachine {
    pid: u32,
    current_state: Arc<RwLock<AgentState>>,
    state_history: Arc<RwLock<VecDeque<StateTransition>>>,

    // Monitors
    network_monitor: Arc<NetworkMonitor>,
    output_monitor: Arc<OutputMonitor>,
    reasoning_detector: Arc<ReasoningDetector>,

    // State change broadcast
    state_tx: broadcast::Sender<AgentState>,

    // Configuration
    history_capacity: usize,
}

#[derive(Debug, Clone)]
pub struct StateTransition {
    pub from: AgentState,
    pub to: AgentState,
    pub timestamp: u64,
    pub reason: String,
}

impl AgentStateMachine {
    pub fn new(pid: u32) -> Self {
        let (state_tx, _) = broadcast::channel(100);

        Self {
            pid,
            current_state: Arc::new(RwLock::new(AgentState::Starting)),
            state_history: Arc::new(RwLock::new(VecDeque::new())),
            network_monitor: Arc::new(NetworkMonitor::new(pid)),
            output_monitor: Arc::new(OutputMonitor::new()),
            reasoning_detector: Arc::new(ReasoningDetector::new()),
            state_tx,
            history_capacity: 100,
        }
    }

    /// Get current state
    pub async fn current_state(&self) -> AgentState {
        self.current_state.read().await.clone()
    }

    /// Subscribe to state changes
    pub fn subscribe(&self) -> broadcast::Receiver<AgentState> {
        self.state_tx.subscribe()
    }

    /// Get state history
    pub async fn history(&self) -> Vec<StateTransition> {
        self.state_history.read().await.iter().cloned().collect()
    }

    /// Update state based on monitoring data
    pub async fn update(&self) -> Result<(), std::io::Error> {
        // Update all monitors
        self.network_monitor.update().await?;
        let output = self.output_monitor.snapshot().await;

        // Detect reasoning state
        let reasoning_state = self.reasoning_detector.detect(&output).await;
        let api_pattern = self.network_monitor.detect_api_call().await;

        // Determine new state
        let new_state = self.infer_state(&reasoning_state, &api_pattern).await;

        // Update if changed
        let mut current = self.current_state.write().await;
        if *current != new_state {
            let old_state = current.clone();

            info!(
                pid = self.pid,
                from = old_state.name(),
                to = new_state.name(),
                "Agent state transition"
            );

            // Record transition
            let transition = StateTransition {
                from: old_state,
                to: new_state.clone(),
                timestamp: std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_secs(),
                reason: self.transition_reason(&new_state),
            };

            let mut history = self.state_history.write().await;
            if history.len() >= self.history_capacity {
                history.pop_front();
            }
            history.push_back(transition);

            // Update current state
            *current = new_state.clone();

            // Broadcast
            let _ = self.state_tx.send(new_state);
        }

        Ok(())
    }

    /// Infer state from monitoring signals
    async fn infer_state(
        &self,
        reasoning_state: &super::reasoning_detector::ReasoningState,
        api_pattern: &ApiCallPattern,
    ) -> AgentState {
        let output = self.output_monitor.snapshot().await;

        // Priority 1: API call detected (strongest signal for reasoning)
        if let ApiCallPattern::Calling { .. } = api_pattern {
            if reasoning_state.phase != ReasoningPhase::NotReasoning {
                return AgentState::Reasoning {
                    started_at: reasoning_state.started_at,
                    elapsed_ms: reasoning_state.elapsed_ms,
                    confidence: reasoning_state.confidence,
                };
            }
        }

        // Priority 2: Output pattern detection
        if reasoning_state.phase == ReasoningPhase::Reasoning {
            return AgentState::Reasoning {
                started_at: reasoning_state.started_at,
                elapsed_ms: reasoning_state.elapsed_ms,
                confidence: reasoning_state.confidence,
            };
        }

        // Priority 3: Tool execution detection
        if let Some(tool) = self.detect_tool_execution(&output) {
            return AgentState::ToolExecuting {
                tool_name: tool,
                started_at: std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_secs(),
            };
        }

        // Priority 4: File operations
        if let Some(file_op) = self.detect_file_operation(&output) {
            return match file_op.0 {
                FileOperationType::Read => AgentState::FileReading {
                    path: file_op.1,
                    started_at: std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .unwrap()
                        .as_secs(),
                },
                FileOperationType::Write => AgentState::FileWriting {
                    path: file_op.1,
                    started_at: std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .unwrap()
                        .as_secs(),
                },
            };
        }

        // Priority 5: Command execution
        if let Some(cmd) = self.detect_command_execution(&output) {
            return AgentState::CommandExecuting {
                command: cmd,
                started_at: std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_secs(),
            };
        }

        // Priority 6: Responding (generating output)
        if reasoning_state.phase == ReasoningPhase::Responding {
            return AgentState::Responding {
                started_at: reasoning_state.started_at,
                tokens_estimate: 0, // TODO: estimate from output length
            };
        }

        // Default: idle
        AgentState::Idle
    }

    /// Get reason for state transition
    fn transition_reason(&self, new_state: &AgentState) -> String {
        match new_state {
            AgentState::Reasoning { confidence, .. } => {
                format!("API call detected (confidence: {:.0}%)", confidence * 100.0)
            }
            AgentState::ToolExecuting { tool_name, .. } => {
                format!("Tool execution detected: {}", tool_name)
            }
            AgentState::FileReading { path, .. } => {
                format!("File read detected: {}", path.display())
            }
            AgentState::FileWriting { path, .. } => {
                format!("File write detected: {}", path.display())
            }
            AgentState::CommandExecuting { command, .. } => {
                format!("Command execution detected: {}", command)
            }
            AgentState::Responding { .. } => "Response generation detected".to_string(),
            AgentState::Idle => "No active operations".to_string(),
            AgentState::Error { message, .. } => format!("Error: {}", message),
            AgentState::Stopped { exit_code } => {
                format!("Process stopped (exit code: {:?})", exit_code)
            }
            AgentState::Starting => "Initial state".to_string(),
        }
    }

    /// Detect tool execution from output
    fn detect_tool_execution(&self, output: &[u8]) -> Option<String> {
        let text = String::from_utf8_lossy(output);

        // Common tool execution patterns
        let patterns = [
            r"\[Tool:\s*(\w+)\]",
            r"Calling tool:\s*(\w+)",
            r"Using tool:\s*(\w+)",
            r"Executing\s+(\w+)\s+tool",
        ];

        for pattern in &patterns {
            if let Ok(regex) = regex::Regex::new(pattern) {
                if let Some(caps) = regex.captures(&text) {
                    if let Some(m) = caps.get(1) {
                        return Some(m.as_str().to_string());
                    }
                }
            }
        }

        None
    }

    /// Detect file operations from output
    fn detect_file_operation(&self, output: &[u8]) -> Option<(FileOperationType, PathBuf)> {
        let text = String::from_utf8_lossy(output);

        // File read patterns
        let read_patterns = [
            r"Reading file:\s*(.+)",
            r"Opening\s+(.+)\s+for reading",
            r"Loading\s+(.+)",
        ];

        for pattern in &read_patterns {
            if let Ok(regex) = regex::Regex::new(pattern) {
                if let Some(caps) = regex.captures(&text) {
                    if let Some(m) = caps.get(1) {
                        return Some((FileOperationType::Read, PathBuf::from(m.as_str().trim())));
                    }
                }
            }
        }

        // File write patterns
        let write_patterns = [
            r"Writing to:\s*(.+)",
            r"Saving\s+(.+)",
            r"Creating file:\s*(.+)",
        ];

        for pattern in &write_patterns {
            if let Ok(regex) = regex::Regex::new(pattern) {
                if let Some(caps) = regex.captures(&text) {
                    if let Some(m) = caps.get(1) {
                        return Some((FileOperationType::Write, PathBuf::from(m.as_str().trim())));
                    }
                }
            }
        }

        None
    }

    /// Detect command execution from output
    fn detect_command_execution(&self, output: &[u8]) -> Option<String> {
        let text = String::from_utf8_lossy(output);

        // Command execution patterns
        let patterns = [
            r"Executing command:\s*(.+)",
            r"Running:\s*(.+)",
            r"\$\s+(.+)", // Shell prompt pattern
        ];

        for pattern in &patterns {
            if let Ok(regex) = regex::Regex::new(pattern) {
                if let Some(caps) = regex.captures(&text) {
                    if let Some(m) = caps.get(1) {
                        let cmd = m.as_str().trim();
                        if !cmd.is_empty() && cmd.len() < 200 {
                            return Some(cmd.to_string());
                        }
                    }
                }
            }
        }

        None
    }
}

#[derive(Debug, Clone, PartialEq)]
enum FileOperationType {
    Read,
    Write,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_state_names() {
        assert_eq!(AgentState::Idle.name(), "idle");
        assert_eq!(AgentState::Starting.name(), "starting");
    }

    #[test]
    fn test_is_active() {
        assert!(!AgentState::Idle.is_active());
        assert!(AgentState::Reasoning {
            started_at: 0,
            elapsed_ms: 0,
            confidence: 0.9,
        }
        .is_active());
    }
}
