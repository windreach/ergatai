// Cross-Agent Communication Module
// File-based collaboration system for multi-agent coordination

pub mod agent_launcher;
pub mod dag_scheduler; // DAG-based scheduler
pub mod plan_watcher;
pub mod result_monitor; // fanotify-based result file integrity monitor (FAN_CLOSE_WRITE)
pub mod task_coordinator;
pub mod task_scheduler; // Agent-to-agent message routing via NATS
pub mod timeout_tier; // Three-stage node timeout escalation (warn → escalate → fail)

pub use agent_launcher::{AgentLauncher, AgentSessionStatus, RunningAgent};
pub use dag_scheduler::{
    clear_dag_scheduler, clear_dag_scheduler_by_id, get_dag_scheduler, get_dag_scheduler_by_id,
    list_dag_schedulers, set_dag_scheduler, DagScheduler,
};
pub use plan_watcher::PollingWatcher;
pub use task_coordinator::TaskCoordinator;
pub use task_scheduler::{
    global_scheduler, AgentAvailability, PendingTask, ScheduleStrategy, TaskScheduler,
};
