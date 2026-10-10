//! File access control module.
//!
//! Provides zero-trust file access control for multi-agent collaboration.
//!
//! # Lock Acquisition
//!
//! File locks are **pre-emptively acquired** during ACP permission approval:
//!
//! 1. **Permission approved** → `try_acquire_write_lock_preemptive()` binds:
//!    - **Snapshot lock**: pre-modification baseline (for rollback if agent bypasses permission)
//!    - **flock(2)**: kernel-level advisory lock (blocks cooperative Edit/Delete/Move tools)
//! 2. **Tool starts** → `renew_lock_on_tool_start()` extends TTL
//! 3. **Tool completes** → `release_lock_on_tool_complete()` releases lock + flock
//!
//! For Bash commands, `bash_path_extractor` statically extracts write targets.
//!
//! # Core Components
//!
//! - **SystemToken**: Session-level authorization, used by Watchdog for heartbeat timeout detection
//! - **SQLite WAL**: High-concurrency lock management
//! - **Git COW snapshots**: Copy-on-Write for TOCTOU prevention
//! - **Watchdog**: Token expiration and heartbeat monitoring
//! - **flock(2)**: Kernel-level advisory locking for cooperative process mutual exclusion

pub mod audit;
pub mod config;
pub mod file_events_consumer;
pub mod ipc_server;
pub mod lock_manager;
pub mod lock_mode;
pub mod manager;
pub mod monitor;
pub mod performance;
pub mod pid_resolver;
pub mod priority;
pub mod renewal;
pub mod sensitive_paths;
pub mod snapshot;
pub mod token;
pub mod watchdog;

pub use audit::{AuditEntry, AuditManager, FileAccessStats, SecurityReport};
pub use config::{ConfigManager, FileAccessConfig};
pub use file_events_consumer::{FileEvent, FileEventsConsumer};
pub use ipc_server::{start_ipc_server, IpcServerHandle};
pub use lock_manager::FileLockManager;
pub use lock_mode::LockModeManager;
pub use manager::{
    get_lock_manager, get_snapshot_manager, get_watchdog, init_file_access,
    register_workspace_for_project, shutdown_file_access, unregister_workspace_for_project,
};
pub use monitor::FileMonitor;
pub use performance::{AsyncLockQueue, AsyncLockRequest, BatchOperations, LockCache};
pub use pid_resolver::{CallbackPidResolver, NoopPidResolver, PidResolver};
pub use priority::priority_to_number;
pub use renewal::RenewalManager;
pub use snapshot::SnapshotManager;
pub use token::{FileLock, FileMode, FileToken, SystemToken, TokenId, TokenStatus};
pub use watchdog::{Watchdog, WatchdogConfig};
