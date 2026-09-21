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
//! If extraction fails, falls back to post-facto detection via FileSystemWatcher.
//!
//! # Core Components
//!
//! - **SystemToken**: Session-level authorization, used by Watchdog for heartbeat timeout detection
//! - **SQLite WAL**: High-concurrency lock management
//! - **Git COW snapshots**: Copy-on-Write for TOCTOU prevention
//! - **Watchdog**: Token expiration and heartbeat monitoring
//! - **FileSystemWatcher**: Cross-platform file modification detection (fallback path)
//! - **flock(2)**: Kernel-level advisory locking for cooperative process mutual exclusion
//!
//! # ⚠️ Deprecated Components
//!
//! - **`enforcer` module**: Linux fanotify-based kernel enforcement — **deprecated**,
//!   code preserved for reference. Use ACP pre-emptive locking instead.
//! - **`init_file_access_with_enforcer`**: Use `init_file_access()` instead.
//! - **`FileToken`**: Superseded by `file_locks` table — the lock record itself
//!   serves as the permission proof. No code validates FileToken.

pub mod audit;
pub mod config;
/// ⚠️ DEPRECATED: fanotify enforcer — preserved for reference, not used in production.
pub mod enforcer;
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
pub mod watcher;

pub use audit::{AuditEntry, AuditManager, FileAccessStats, SecurityReport};
pub use config::{ConfigManager, FileAccessConfig};
/// ⚠️ DEPRECATED: fanotify enforcer types — preserved for reference.
#[deprecated(
    since = "0.2.0",
    note = "fanotify enforcer is deprecated; use ACP pre-emptive locking instead"
)]
pub use enforcer::{Decision, DecisionEngine, Enforcer, EnforcerConfig};
pub use file_events_consumer::{FileEvent, FileEventsConsumer};
pub use ipc_server::{start_ipc_server, IpcServerHandle};
pub use lock_manager::FileLockManager;
pub use lock_mode::LockModeManager;
/// ⚠️ Note: `init_file_access_with_enforcer` and `get_enforcer` are deprecated.
#[allow(deprecated)] // Re-exporting deprecated items for backward compatibility
pub use manager::{
    get_enforcer, get_lock_manager, get_snapshot_manager, get_watchdog, init_file_access,
    init_file_access_with_enforcer, register_workspace_for_project, shutdown_file_access,
    unregister_workspace_for_project,
};
pub use monitor::FileMonitor;
pub use performance::{AsyncLockQueue, AsyncLockRequest, BatchOperations, LockCache};
pub use pid_resolver::{CallbackPidResolver, NoopPidResolver, PidResolver};
pub use priority::priority_to_number;
pub use renewal::RenewalManager;
pub use snapshot::SnapshotManager;
pub use token::{FileLock, FileMode, FileToken, SystemToken, TokenId, TokenStatus};
pub use watchdog::{Watchdog, WatchdogConfig};
pub use watcher::FileSystemWatcher;
