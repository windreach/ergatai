//! Background task that monitors agent activity and auto-suspends idle agents.
//!
//! This module provides a background monitoring task that periodically checks
//! agent activity and automatically suspends agents that have been idle for
//! more than a configured threshold (default: 10 minutes).

use std::sync::Arc;
use std::time::Duration;
use tokio_util::sync::CancellationToken;
use tracing::{debug, info, warn};

use crate::runtime::AgentRuntime;
use crate::suspend_store::SuspendReason;

/// Idle timeout before auto-suspending an agent (10 minutes)
const IDLE_TIMEOUT_SECS: u64 = 600;

/// How often to check agent activity (every 30 seconds)
const CHECK_INTERVAL_SECS: u64 = 30;

/// Spawn the activity monitor background task.
///
/// This task runs in the background and periodically checks all running agents.
/// If an agent has been idle (no output/heartbeat) for more than `IDLE_TIMEOUT_SECS`,
/// it is automatically suspended.
///
/// # Arguments
/// * `runtime` - The agent runtime to monitor
/// * `shutdown_token` - Cancellation token for graceful shutdown
///
/// # Returns
/// A `JoinHandle` for the spawned task
pub fn spawn_activity_monitor(
    runtime: Arc<AgentRuntime>,
    shutdown_token: CancellationToken,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        info!("Activity monitor started");

        loop {
            tokio::select! {
                _ = tokio::time::sleep(Duration::from_secs(CHECK_INTERVAL_SECS)) => {
                    check_and_suspend_idle_agents(&runtime).await;
                }
                _ = shutdown_token.cancelled() => {
                    info!("Activity monitor shutting down");
                    break;
                }
            }
        }

        info!("Activity monitor stopped");
    })
}

/// Check all running agents and suspend idle ones.
///
/// Iterates through all agents in the runtime, checks if they are in the
/// `Idle` state, and calculates how long they have been idle based on
/// their `last_heartbeat` timestamp. If the idle time exceeds `IDLE_TIMEOUT_SECS`,
/// the agent is suspended with reason `SuspendReason::Idle`.
async fn check_and_suspend_idle_agents(runtime: &AgentRuntime) {
    let agents = runtime.list_agents().await;
    let now = chrono::Utc::now();

    for agent in agents {
        // Only check agents in Idle state (not busy processing tasks)
        if !matches!(
            agent.lifecycle,
            crate::agent_lifecycle::AgentLifecycleState::Idle { .. }
        ) {
            continue;
        }

        // Calculate idle duration from last_heartbeat
        let idle_duration = now.signed_duration_since(agent.last_heartbeat);
        // Guard against negative durations (clock skew, NTP step) — clamp to 0
        let idle_secs = idle_duration.num_seconds().max(0) as u64;

        // If idle for more than 10 minutes, auto-suspend
        if idle_secs > IDLE_TIMEOUT_SECS {
            info!(
                agent_id = %agent.agent_id,
                idle_secs = idle_secs,
                "Auto-suspending idle agent"
            );

            if let Err(e) = runtime
                .suspend_agent(&agent.agent_id, SuspendReason::Idle)
                .await
            {
                warn!(
                    agent_id = %agent.agent_id,
                    error = %e,
                    "Failed to auto-suspend idle agent"
                );
            }
        } else {
            debug!(
                agent_id = %agent.agent_id,
                idle_secs = idle_secs,
                "Agent activity check"
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_idle_timeout_constant() {
        assert_eq!(IDLE_TIMEOUT_SECS, 600);
    }

    #[test]
    fn test_check_interval_constant() {
        assert_eq!(CHECK_INTERVAL_SECS, 30);
    }
}
