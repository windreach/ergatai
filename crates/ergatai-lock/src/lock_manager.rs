//! SQLite-based file lock manager.
//!
//! Uses BEGIN IMMEDIATE + unique index constraints for atomicity.
//! WAL mode enabled for concurrent read performance.

use chrono::{DateTime, Utc};
use ergatai_error::ErgataiError;
use parking_lot::Mutex;
use rusqlite::{params, Connection};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::oneshot;
use tracing::{debug, info, warn};

use super::audit::AuditManager;
use super::snapshot::SnapshotManager;
use super::token::{FileLock, FileMode, FileToken, SystemToken, TokenId, TokenStatus};

/// RAII guard for SQLite transactions.
///
/// Automatically rolls back if not explicitly committed. This prevents
/// database lock leaks when panics or early returns skip manual ROLLBACK calls.
///
/// # Usage
/// ```ignore
/// let tx = TransactionGuard::begin(&conn)?;
/// // ... perform operations ...
/// tx.commit()?; // If omitted or if panic occurs, ROLLBACK runs on drop.
/// ```
pub(super) struct TransactionGuard<'a> {
    conn: &'a rusqlite::Connection,
    committed: bool,
}

impl<'a> TransactionGuard<'a> {
    /// Begin a new IMMEDIATE transaction.
    pub(super) fn begin(conn: &'a rusqlite::Connection) -> Result<Self, rusqlite::Error> {
        conn.execute_batch("BEGIN IMMEDIATE")?;
        Ok(Self {
            conn,
            committed: false,
        })
    }

    /// Commit the transaction. Consumes the guard so Drop will not roll back.
    pub(super) fn commit(mut self) -> Result<(), rusqlite::Error> {
        self.conn.execute_batch("COMMIT")?;
        self.committed = true;
        Ok(())
    }
}

impl<'a> Drop for TransactionGuard<'a> {
    fn drop(&mut self) {
        if !self.committed {
            // Best-effort rollback; log warning if it fails (connection may already be broken).
            if let Err(e) = self.conn.execute_batch("ROLLBACK") {
                warn!(
                    "Transaction ROLLBACK failed (connection may be broken): {}",
                    e
                );
            }
        }
    }
}

/// Maximum number of active file locks a single agent can hold simultaneously.
///
/// Prevents a single agent from monopolizing file locks and blocking other agents.
/// This limit applies to both explicit lock requests and auto-acquired locks.
/// When the limit is reached, further lock acquisitions will fail with
/// `ErgataiError::ResourceLimitExceeded`.
const MAX_LOCKS_PER_AGENT: usize = 50;


/// File lock manager backed by SQLite.
///
/// Thread-safe via internal Mutex. All operations use BEGIN IMMEDIATE for atomicity.
///
/// # SAFETY: std::sync::Mutex in async context (M13)
/// This struct uses `std::sync::Mutex` (not `tokio::sync::Mutex`) for `conn`,
/// `waiters`, `retry_tracker`, etc. This is intentional because:
/// - All critical sections are short and contain NO `.await` points
/// - `std::sync::Mutex` has lower overhead than `tokio::sync::Mutex`
/// - No guard is ever held across an `.await` boundary
///
/// **INVARIANT**: Never extend a MutexGuard to include an `.await`. If you need
/// to call an async function while holding data from a guard, clone the data first,
/// drop the guard, then await.
// L1 fix: type aliases for complex nested types
type FileWaiters = HashMap<String, Vec<oneshot::Sender<Result<(), String>>>>;

pub struct FileLockManager {
    /// SQLite connection (wrapped in Mutex for thread safety).
    conn: Arc<Mutex<Connection>>,
    /// Project root directory (for path canonicalization).
    project_root: PathBuf,
    /// Cached canonical project root (M2 fix: avoid repeated I/O).
    project_root_canonical: PathBuf,
    /// Waiters for READ_LATEST (file_path → list of notification channels).
    waiters: Arc<Mutex<FileWaiters>>,
    /// Number of currently active ACP sessions (sessions holding system tokens).
    ///
    /// Updated by `register_session` / `unregister_session` from the ACP session
    /// lifecycle. Read lock-free via `Ordering::Relaxed`.
    active_session_count: Arc<AtomicUsize>,




    /// In-memory cache of active WRITE locks for fast fanotify decision path.
    ///
    /// Key: normalized file path
    /// Value: [`LockCacheEntry`] — either a known lock holder, or a "known unlocked"
    /// entry with a timestamp (negative cache).
    ///
    /// This cache is updated whenever a WRITE lock is acquired or released.
    /// The fanotify decision path checks this cache first to avoid database access
    /// for the common case (unlocked files). Falls back to database query on cache miss
    /// or stale entry. Negative entries are honored for `LOCK_CACHE_NEGATIVE_TTL` to
    /// avoid hammering SQLite on every `open()` of an unlocked file.
    active_write_locks_cache: Arc<parking_lot::RwLock<HashMap<String, LockCacheEntry>>>,
}

/// TTL for negative ("known unlocked") cache entries. 50ms is short enough to
/// react quickly to new lock acquisitions (the acquire path always invalidates
/// any stale negative entry before inserting the positive one), but long enough
/// to absorb bursts of `open()` calls on unlocked files.
const LOCK_CACHE_NEGATIVE_TTL: Duration = Duration::from_millis(50);

/// Entry in [`FileLockManager::active_write_locks_cache`].
///
/// Either a known WRITE lock holder (positive) or a "known unlocked" marker
/// with a timestamp (negative). Negative entries let the fanotify hot path
/// skip SQLite for unlocked files — the dominant case under normal workloads.
#[derive(Debug, Clone)]
enum LockCacheEntry {
    /// A WRITE lock is currently held by (agent_id, session_id).
    Locked {
        agent_id: String,
        session_id: String,
    },
    /// No WRITE lock was observed at `observed_at`. Valid until
    /// `observed_at + LOCK_CACHE_NEGATIVE_TTL`.
    Unlocked { observed_at: Instant },
}

impl FileLockManager {
    /// Create a new lock manager with the given database path.
    ///
    /// Enables WAL mode and creates tables if they don't exist.
    /// Optionally accepts a NATS client for multi-agent approval flow.
    pub fn new(
        db_path: &Path,
        project_root: PathBuf,
    ) -> Result<Self, ErgataiError> {
        info!("Initializing FileLockManager at {:?}", db_path);

        let conn = Connection::open(db_path)
            .map_err(|e| ErgataiError::internal(format!("Failed to open lock database: {}", e)))?;

        // Enable WAL mode for better concurrent performance (C3 fix)
        conn.execute_batch(
            "
            PRAGMA journal_mode=WAL;
            PRAGMA synchronous=NORMAL;
            PRAGMA cache_size=-64000;
            PRAGMA foreign_keys=ON;
            PRAGMA wal_autocheckpoint=100;
            ",
        )
        .map_err(|e| ErgataiError::internal(format!("Failed to set pragmas: {}", e)))?;

        // Verify WAL mode was actually enabled (PRAGMA may silently fail on some filesystems)
        let journal_mode: String = conn
            .query_row("PRAGMA journal_mode", [], |row| row.get(0))
            .map_err(|e| ErgataiError::internal(format!("Failed to query journal mode: {}", e)))?;
        if journal_mode.to_lowercase() != "wal" {
            return Err(ErgataiError::internal(format!(
                "Failed to enable WAL journal mode (current: {}). \
                 Concurrent read/write performance may be degraded.",
                journal_mode
            )));
        }

        // Create tables
        Self::create_tables(&conn)?;

        // Cache canonical project root (M2 fix: avoid repeated I/O)
        let project_root_canonical = project_root.canonicalize().map_err(|e| {
            ErgataiError::internal(format!("Failed to canonicalize project root: {}", e))
        })?;

        let manager = Self {
            conn: Arc::new(Mutex::new(conn)),
            project_root,
            project_root_canonical,
            waiters: Arc::new(Mutex::new(HashMap::new())),
            active_session_count: Arc::new(AtomicUsize::new(0)),
            active_write_locks_cache: Arc::new(parking_lot::RwLock::new(HashMap::new())),
        };

        // Start background task to periodically clean up stale cache entries.
        // Without this, the cache would grow unboundedly as new file paths are accessed,
        // since negative entries are only removed on re-access.
        manager.start_cache_cleanup_task();

        // Expire any stale locks left over from previous runs whose expires_at
        // has passed. This is critical for auto-acquired locks (FileSystemWatcher)
        // which have no system_token and thus can't be cleaned up by the watchdog's
        // token-heartbeat path.
        if let Ok(n) = manager.expire_stale_locks() {
            if n > 0 {
                info!(count = n, "Expired stale locks from previous runs at startup");
            }
        }

        Ok(manager)
    }

    /// Get the project root directory this manager was initialized with.
    pub fn project_root(&self) -> &Path {
        &self.project_root
    }

    /// Count the number of active locks held by a specific agent.
    ///
    /// Used to enforce the per-agent lock limit (`MAX_LOCKS_PER_AGENT`).
    /// Returns the count of locks with status='ACTIVE' for the given agent_id.
    #[cfg(test)]
    fn count_active_locks_by_agent(&self, agent_id: &str) -> Result<usize, ErgataiError> {
        let conn = self.conn.lock();
        Self::count_active_locks_by_agent_with_conn(&conn, agent_id)
    }

    /// Count active locks for an agent using an already-locked connection.
    ///
    /// This avoids re-acquiring the mutex when the caller already holds it
    /// (e.g., inside a transaction in `auto_acquire_write_lock`).
    fn count_active_locks_by_agent_with_conn(
        conn: &rusqlite::Connection,
        agent_id: &str,
    ) -> Result<usize, ErgataiError> {
        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM file_locks WHERE agent_id = ?1 AND status = 'ACTIVE'",
                params![agent_id],
                |row| row.get(0),
            )
            .map_err(|e| ErgataiError::internal(format!("Failed to count agent locks: {}", e)))?;
        Ok(count as usize)
    }

    /// Check if an agent has reached the per-agent lock limit.
    ///
    /// Returns `Ok(())` if the agent can acquire more locks, or
    /// `Err(ErgataiError::ResourceLimitExceeded)` if the limit is reached.
    #[cfg(test)]
    fn check_agent_lock_limit(&self, agent_id: &str) -> Result<(), ErgataiError> {
        let count = self.count_active_locks_by_agent(agent_id)?;
        Self::check_agent_lock_limit_with_count(agent_id, count)
    }

    /// Check lock limit using a pre-fetched count (avoids re-locking the connection).
    fn check_agent_lock_limit_with_count(agent_id: &str, count: usize) -> Result<(), ErgataiError> {
        if count >= MAX_LOCKS_PER_AGENT {
            warn!(
                agent_id = %agent_id,
                lock_count = count,
                limit = MAX_LOCKS_PER_AGENT,
                "Agent reached per-agent lock limit"
            );
            return Err(ErgataiError::ResourceLimitExceeded {
                resource: "file_locks".to_string(),
                limit: MAX_LOCKS_PER_AGENT as u64,
                current: count as u64,
            });
        }
        Ok(())
    }

    /// Start a background task that periodically cleans up stale cache entries.
    ///
    /// The `active_write_locks_cache` grows unboundedly without periodic cleanup:
    /// negative entries (Unlocked) are only removed on re-access, so file paths
    /// that are accessed once and never again would accumulate forever. This task
    /// runs every 60 seconds and removes all expired negative entries.
    ///
    /// Positive entries (Locked) are never removed by this task — they are only
    /// invalidated when the corresponding lock is explicitly released or expires.
    ///
    /// If called outside a Tokio runtime context (e.g., in synchronous tests),
    /// the task is silently skipped — the cache will still work correctly,
    /// just without periodic cleanup.
    fn start_cache_cleanup_task(&self) {
        // Check if we're in a Tokio runtime context. If not (e.g., synchronous tests),
        // skip spawning the background task. The cache will still function correctly,
        // it just won't have periodic cleanup in that scenario.
        let handle = match tokio::runtime::Handle::try_current() {
            Ok(h) => h,
            Err(_) => {
                debug!("No Tokio runtime available; skipping cache cleanup task");
                return;
            }
        };

        let cache = self.active_write_locks_cache.clone();
        handle.spawn(async move {
            loop {
                tokio::time::sleep(Duration::from_secs(60)).await;
                let now = Instant::now();
                let mut guard = cache.write();
                let before = guard.len();
                guard.retain(|_, entry| match entry {
                    LockCacheEntry::Locked { .. } => true, // Keep active locks
                    LockCacheEntry::Unlocked { observed_at } => {
                        // Remove if older than the negative TTL
                        now.duration_since(*observed_at) < LOCK_CACHE_NEGATIVE_TTL
                    }
                });
                let removed = before.saturating_sub(guard.len());
                if removed > 0 {
                    debug!(
                        removed = removed,
                        remaining = guard.len(),
                        "Cache cleanup: removed stale negative entries"
                    );
                }
            }
        });
    }

    /// Create the lock database tables.
    fn create_tables(conn: &Connection) -> Result<(), ErgataiError> {
        conn.execute_batch(
            "
            -- System tokens (agent admission)
            CREATE TABLE IF NOT EXISTS system_tokens (
                id TEXT PRIMARY KEY,
                agent_id TEXT NOT NULL,
                session_id TEXT NOT NULL UNIQUE,
                project_root TEXT NOT NULL,
                issued_at TEXT NOT NULL,
                expires_at TEXT NOT NULL,
                heartbeat_interval_secs INTEGER NOT NULL,
                heartbeat_at TEXT NOT NULL,
                status TEXT NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_system_tokens_session
                ON system_tokens(session_id);

            -- File locks
            CREATE TABLE IF NOT EXISTS file_locks (
                id TEXT PRIMARY KEY,
                file_path TEXT NOT NULL,
                agent_id TEXT NOT NULL,
                session_id TEXT NOT NULL,
                mode TEXT NOT NULL,
                scope TEXT,
                token_id TEXT NOT NULL,
                reason TEXT,
                approved_by TEXT,
                created_at TEXT NOT NULL,
                expires_at TEXT NOT NULL,
                heartbeat_interval_secs INTEGER NOT NULL,
                heartbeat_at TEXT NOT NULL,
                status TEXT NOT NULL,
                updated_at TEXT,
                priority INTEGER
            );

            -- Migration: drop the old write-only index if it exists, then create
            -- the combined write+admin index. `CREATE INDEX IF NOT EXISTS` alone
            -- would silently skip creation if the old index still exists under a
            -- different name (HIGH #5 fix).
            DROP INDEX IF EXISTS idx_file_locks_write_unique;

            -- Unique constraint: only one WRITE or ADMIN lock per file (enforced at DB level)
            CREATE UNIQUE INDEX IF NOT EXISTS idx_file_locks_write_admin_unique
                ON file_locks(file_path)
                WHERE mode IN ('WRITE', 'ADMIN') AND status = 'ACTIVE';

            CREATE INDEX IF NOT EXISTS idx_file_locks_path
                ON file_locks(file_path);
            CREATE INDEX IF NOT EXISTS idx_file_locks_agent
                ON file_locks(agent_id, session_id);

            -- Audit log
            CREATE TABLE IF NOT EXISTS audit_log (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                timestamp TEXT NOT NULL,
                agent_id TEXT NOT NULL,
                session_id TEXT NOT NULL,
                action TEXT NOT NULL,
                file_path TEXT,
                mode TEXT,
                reason TEXT,
                details TEXT
            );

            CREATE INDEX IF NOT EXISTS idx_audit_log_time
                ON audit_log(timestamp);
            CREATE INDEX IF NOT EXISTS idx_audit_log_agent
                ON audit_log(agent_id);

            -- File snapshots (for READ_HISTORY and rollback)
            CREATE TABLE IF NOT EXISTS snapshots (
                id TEXT PRIMARY KEY,
                file_path TEXT NOT NULL,
                git_hash TEXT NOT NULL,
                created_at TEXT NOT NULL,
                created_by TEXT NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_snapshots_path
                ON snapshots(file_path);
            CREATE INDEX IF NOT EXISTS idx_snapshots_time
                ON snapshots(created_at);

            -- File tokens (per-operation tokens linked to a system token)
            CREATE TABLE IF NOT EXISTS file_tokens (
                id TEXT PRIMARY KEY,
                agent_id TEXT NOT NULL,
                session_id TEXT NOT NULL,
                system_token_id TEXT NOT NULL,
                scope TEXT NOT NULL,
                mode TEXT NOT NULL,
                reason TEXT,
                approved_by TEXT,
                issued_at TEXT NOT NULL,
                expires_at TEXT NOT NULL,
                heartbeat_interval_secs INTEGER NOT NULL,
                heartbeat_at TEXT NOT NULL,
                status TEXT NOT NULL,
                priority INTEGER,
                FOREIGN KEY (system_token_id) REFERENCES system_tokens(id)
            );

            CREATE INDEX IF NOT EXISTS idx_file_tokens_session
                ON file_tokens(session_id, status);
            CREATE INDEX IF NOT EXISTS idx_file_tokens_agent
                ON file_tokens(agent_id, status);
            ",
        )
        .map_err(|e| ErgataiError::internal(format!("Failed to create tables: {}", e)))?;

        Ok(())
    }

    /// Register a new system token.
    pub fn register_system_token(&self, token: &SystemToken) -> Result<(), ErgataiError> {
        let conn = self.conn.lock();

        conn.execute(
            "INSERT INTO system_tokens (
                id, agent_id, session_id, project_root,
                issued_at, expires_at, heartbeat_interval_secs, heartbeat_at, status
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                token.id.as_str(),
                token.agent_id,
                token.session_id,
                token.project_root,
                token.issued_at.to_rfc3339(),
                token.expires_at.to_rfc3339(),
                token.heartbeat_interval_secs as i64,
                token.heartbeat_at.to_rfc3339(),
                token.status.to_string(),
            ],
        )
        .map_err(|e| ErgataiError::internal(format!("Failed to insert system token: {}", e)))?;

        // Register the session to update active_session_count for single-agent detection
        self.register_session_with_id(&token.session_id);

        debug!(
            "Registered system token {} for agent {}",
            token.id, token.agent_id
        );
        Ok(())
    }

    /// Atomically get an existing system token by session_id, or register a new one.
    ///
    /// This eliminates the TOCTOU race in `server.rs::request_file_access` where:
    /// 1. `register_system_token()` fails with UNIQUE constraint on session_id
    /// 2. Between the failure and the subsequent `get_system_token()` call, the
    ///    existing token could be expired/cleaned up by the watchdog
    /// 3. `get_system_token()` then returns None, breaking the FK reference
    ///
    /// Both the lookup and the insert happen under a single `Mutex` acquisition,
    /// so no other task (including the watchdog) can expire the token between steps.
    ///
    /// Returns the `TokenId` of the existing or newly registered token.
    ///
    /// **Note**: This method only increments `active_session_count` when creating
    /// a NEW token. If an existing ACTIVE token is found, the count is unchanged
    /// (the session was already counted when the token was first registered).
    pub fn get_or_register_system_token(
        &self,
        token: &SystemToken,
    ) -> Result<TokenId, ErgataiError> {
        let conn = self.conn.lock();

        // 1. Try to find an existing ACTIVE token for this session
        let existing: Option<TokenId> = conn
            .query_row(
                "SELECT id FROM system_tokens WHERE session_id = ?1 AND status = 'ACTIVE'",
                params![token.session_id],
                |row| row.get::<_, String>(0).map(TokenId::from_string),
            )
            .ok();

        if let Some(id) = existing {
            // Session already has an active token — reuse it.
            // Do NOT call register_session_with_id here because the session
            // was already counted when the token was first registered.
            // Calling it again would inflate active_session_count.
            return Ok(id);
        }

        // 2. No active token — insert a new one (still under the same lock)
        conn.execute(
            "INSERT INTO system_tokens (
                id, agent_id, session_id, project_root,
                issued_at, expires_at, heartbeat_interval_secs, heartbeat_at, status
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                token.id.as_str(),
                token.agent_id,
                token.session_id,
                token.project_root,
                token.issued_at.to_rfc3339(),
                token.expires_at.to_rfc3339(),
                token.heartbeat_interval_secs as i64,
                token.heartbeat_at.to_rfc3339(),
                token.status.to_string(),
            ],
        )
        .map_err(|e| ErgataiError::internal(format!("Failed to insert system token: {}", e)))?;

        let new_id = token.id.clone();
        drop(conn);

        // Register the session to update active_session_count (only for NEW tokens)
        self.register_session_with_id(&token.session_id);

        debug!(
            "Registered new system token {} for agent {} (via get_or_register)",
            new_id, token.agent_id
        );
        Ok(new_id)
    }

    /// Get a system token by session ID.
    pub fn get_system_token(&self, session_id: &str) -> Result<Option<SystemToken>, ErgataiError> {
        let conn = self.conn.lock();

        let mut stmt = conn
            .prepare(
                "SELECT id, agent_id, session_id, project_root,
                        issued_at, expires_at, heartbeat_interval_secs, heartbeat_at, status
                 FROM system_tokens
                 WHERE session_id = ?1",
            )
            .map_err(|e| ErgataiError::internal(format!("Failed to prepare query: {}", e)))?;

        let result = match stmt.query_row(params![session_id], |row| {
            Ok(SystemToken {
                id: TokenId::from_string(row.get(0)?),
                agent_id: row.get(1)?,
                session_id: row.get(2)?,
                project_root: row.get(3)?,
                issued_at: DateTime::parse_from_rfc3339(&row.get::<_, String>(4)?)
                    .map_err(|e| {
                        rusqlite::Error::FromSqlConversionFailure(
                            0,
                            rusqlite::types::Type::Text,
                            Box::new(e),
                        )
                    })?
                    .with_timezone(&Utc),
                expires_at: DateTime::parse_from_rfc3339(&row.get::<_, String>(5)?)
                    .map_err(|e| {
                        rusqlite::Error::FromSqlConversionFailure(
                            0,
                            rusqlite::types::Type::Text,
                            Box::new(e),
                        )
                    })?
                    .with_timezone(&Utc),
                heartbeat_interval_secs: u64::try_from(row.get::<_, i64>(6)?).unwrap_or(30),
                heartbeat_at: DateTime::parse_from_rfc3339(&row.get::<_, String>(7)?)
                    .map_err(|e| {
                        rusqlite::Error::FromSqlConversionFailure(
                            0,
                            rusqlite::types::Type::Text,
                            Box::new(e),
                        )
                    })?
                    .with_timezone(&Utc),
                status: match row.get::<_, String>(8)?.as_str() {
                    "ACTIVE" => TokenStatus::Active,
                    "EXPIRED" => TokenStatus::Expired,
                    _ => TokenStatus::Expired,
                },
            })
        }) {
            Ok(token) => Some(token),
            Err(rusqlite::Error::QueryReturnedNoRows) => None,
            Err(e) => {
                return Err(ErgataiError::internal(format!(
                    "Failed to query token by session: {}",
                    e
                )));
            }
        };

        Ok(result)
    }


    /// Check whether a specific agent currently holds an active WRITE lock on a file.
    ///
    /// Uses the in-memory cache first (fast path), falls back to SQLite.
    /// Returns `true` only if the exact `(agent_id, session_id)` pair holds the lock —
    /// if a *different* agent holds the lock, returns `false`.
    ///
    /// # Arguments
    /// * `file_path` — file path (relative to project root)
    /// * `agent_id` — agent identifier to check
    /// * `session_id` — session identifier to check
    pub async fn has_write_lock(
        &self,
        file_path: &str,
        agent_id: &str,
        session_id: &str,
    ) -> Result<bool, ErgataiError> {
        let normalized_path = self.validate_and_normalize_path(file_path)?;

        // Fast path: in-memory cache
        {
            let cache = self.active_write_locks_cache.read();
            if let Some(LockCacheEntry::Locked {
                agent_id: cached_agent,
                session_id: cached_session,
            }) = cache.get(&normalized_path)
            {
                return Ok(cached_agent == agent_id && cached_session == session_id);
            }
        }

        // Slow path: database query (use try_lock to avoid deadlock)
        let conn = match self.conn.try_lock() {
            Some(guard) => guard,
            None => {
                debug!(
                    path = %normalized_path,
                    "has_write_lock: SQLite mutex busy, failing open"
                );
                return Ok(false);
            }
        };

        match conn.query_row(
            "SELECT agent_id, session_id FROM file_locks
             WHERE file_path = ?1 AND mode = 'WRITE' AND status = 'ACTIVE'
             LIMIT 1",
            params![normalized_path],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        ) {
            Ok((holder_agent, holder_session)) => {
                // Update cache on hit
                drop(conn);
                let mut cache = self.active_write_locks_cache.write();
                cache.insert(
                    normalized_path,
                    LockCacheEntry::Locked {
                        agent_id: holder_agent.clone(),
                        session_id: holder_session.clone(),
                    },
                );
                Ok(holder_agent == agent_id && holder_session == session_id)
            }
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(false),
            Err(e) => Err(ErgataiError::internal(format!(
                "Failed to query WRITE lock status: {}",
                e
            ))),
        }
    }

    /// Automatically acquire a WRITE lock on first file modification.
    ///
    /// Called by the fanotify event loop when a `FAN_MODIFY` event is detected.
    /// Captures the current file content as a Git snapshot (pre-modification baseline),
    /// then inserts a WRITE lock record directly — no conflict check, since this is
    /// the *first* modification by this agent.
    ///
    /// # Arguments
    /// * `file_path` — file path (relative to project root)
    /// * `agent_id` — agent that performed the modification
    /// * `session_id` — session of the agent
    /// * `project_id` — project identifier (used to locate the SnapshotManager)
    pub async fn auto_acquire_write_lock(
        &self,
        file_path: &str,
        agent_id: &str,
        session_id: &str,
        project_id: &str,
    ) -> Result<(), ErgataiError> {
        let normalized_path = self.validate_and_normalize_path(file_path)?;

        // Step 1: Create a Git snapshot of the file *before* modification.
        // This captures the pre-write baseline so other agents can read it later.
        // Best-effort: if the snapshot manager isn't initialized for this project
        // (e.g. tests, or project not yet registered), skip the snapshot and
        // still create the lock.
        let snapshot_hash = match crate::manager::get_snapshot_manager(project_id).await {
            Ok(snapshot_mgr) => {
                let hash = snapshot_mgr
                    .create_snapshot(&normalized_path, agent_id)
                    .unwrap_or_default();
                if !hash.is_empty() {
                    let conn = self.conn.lock();
                    let _ = SnapshotManager::store_snapshot_record(
                        &conn,
                        &normalized_path,
                        &hash,
                        agent_id,
                    );
                }
                hash
            }
            Err(_) => {
                tracing::debug!(
                    project_id,
                    file_path = %normalized_path,
                    "snapshot manager not available, skipping snapshot"
                );
                String::new()
            }
        };

        // Step 2: Insert a WRITE lock record directly (no conflict check).
        //
        // Rationale: this is triggered by the *first* FAN_MODIFY from this agent,
        // meaning no WRITE lock existed for this file when the modification started.
        // The unique index on (file_path, mode=WRITE) in SQLite will still prevent
        // a race if two agents modify simultaneously — one will succeed, the other
        // will get a UNIQUE constraint violation, which we log and ignore (the
        // second agent's lock will be picked up by the normal acquire_lock path).
        let now = Utc::now();
        let ttl_secs = 3600u64; // 1 hour default TTL for auto-acquired locks
                                // Checked conversion: ttl_secs as i64 would silently overflow if > i64::MAX,
                                // causing chrono::Duration::seconds() to panic with a negative value.
        let ttl_i64 = i64::try_from(ttl_secs).unwrap_or(i64::MAX);
        let expires_at = now + chrono::Duration::seconds(ttl_i64);

        let conn = self.conn.lock();

        // Check per-agent lock limit using the already-held connection to avoid
        // deadlock (re-acquiring the mutex would panic / block).
        let active_count = Self::count_active_locks_by_agent_with_conn(&conn, agent_id)?;
        Self::check_agent_lock_limit_with_count(agent_id, active_count)?;

        // Begin IMMEDIATE transaction for atomicity
        let tx = TransactionGuard::begin(&conn)
            .map_err(|e| ErgataiError::internal(format!("Failed to begin transaction: {}", e)))?;

        let lock_id = uuid::Uuid::new_v4().to_string();
        let token_id = TokenId::new().to_string();

        let insert_result = conn.execute(
            "INSERT INTO file_locks (
                id, file_path, agent_id, session_id, mode, scope, token_id,
                reason, approved_by, created_at, expires_at,
                heartbeat_interval_secs, heartbeat_at, status, priority
            ) VALUES (?1, ?2, ?3, ?4, 'WRITE', '**', ?5, ?6, 'system-auto', ?7, ?8, ?9, ?10, 'ACTIVE', ?11)",
            params![
                lock_id,
                normalized_path,
                agent_id,
                session_id,
                token_id,
                format!("auto-acquired on FAN_MODIFY (snapshot: {})", snapshot_hash),
                now.to_rfc3339(),
                expires_at.to_rfc3339(),
                60i64, // heartbeat_interval_secs
                now.to_rfc3339(),
                2i64,  // priority: medium
            ],
        );

        match insert_result {
            Ok(_) => {
                // Audit log
                conn.execute(
                    "INSERT INTO audit_log (timestamp, agent_id, session_id, action, file_path, mode, reason)
                     VALUES (?1, ?2, ?3, 'LOCK_ACQUIRED_AUTO', ?4, 'WRITE', ?5)",
                    params![
                        now.to_rfc3339(),
                        agent_id,
                        session_id,
                        normalized_path,
                        format!("auto-write (snapshot: {})", snapshot_hash),
                    ],
                )
                .map_err(|e| {
                    ErgataiError::internal(format!("Failed to log auto-acquire audit: {}", e))
                })?;

                // Update in-memory cache before commit
                {
                    let mut cache = self.active_write_locks_cache.write();
                    cache.insert(
                        normalized_path.clone(),
                        LockCacheEntry::Locked {
                            agent_id: agent_id.to_string(),
                            session_id: session_id.to_string(),
                        },
                    );
                }

                tx.commit().map_err(|e| {
                    ErgataiError::internal(format!("Failed to commit auto-acquire: {}", e))
                })?;

                info!(
                    file_path = %normalized_path,
                    agent_id = %agent_id,
                    snapshot_hash = %snapshot_hash,
                    lock_id = %lock_id,
                    "Auto-acquired WRITE lock on FAN_MODIFY"
                );

                Ok(())
            }
            Err(e) if e.to_string().contains("UNIQUE constraint failed") => {
                // Another agent already has a WRITE lock — this is a race.
                // Roll back and log; the other agent's lock is authoritative.
                drop(tx); // rollback via Drop
                debug!(
                    file_path = %normalized_path,
                    agent_id = %agent_id,
                    "Auto-acquire raced with existing WRITE lock, skipping"
                );
                Ok(())
            }
            Err(e) => {
                drop(tx); // rollback via Drop
                Err(ErgataiError::internal(format!(
                    "Failed to auto-acquire WRITE lock on {}: {}",
                    normalized_path, e
                )))
            }
        }
    }

    /// Look up the latest Git snapshot hash for a file.
    ///
    /// Queries the `snapshots` table for the most recent entry matching
    /// the given (already-normalized) file path. Returns `None` if no
    /// snapshot exists.
    ///
    /// Used by the IPC server to answer `check_lock` queries from the
    /// LD_PRELOAD library — when a file is locked, the reader needs the
    /// snapshot hash to fetch the pre-write content.
    pub fn get_latest_snapshot_hash(
        &self,
        normalized_path: &str,
    ) -> Result<Option<String>, ErgataiError> {
        let conn = match self.conn.try_lock() {
            Some(guard) => guard,
            None => {
                debug!(
                    path = normalized_path,
                    "get_latest_snapshot_hash: SQLite mutex busy, returning None"
                );
                return Ok(None);
            }
        };

        SnapshotManager::get_latest_snapshot(&conn, normalized_path)
    }



    /// Check if a file is locked for writing.
    pub fn is_file_locked(&self, file_path: &str) -> Result<bool, ErgataiError> {
        let normalized_path = self.validate_and_normalize_path(file_path)?;

        let conn = self.conn.lock();

        let is_locked: bool = conn
            .query_row(
                "SELECT COUNT(*) > 0 FROM file_locks
                 WHERE file_path = ?1 AND mode = 'WRITE' AND status = 'ACTIVE'",
                params![normalized_path],
                |row| row.get(0),
            )
            .map_err(|e| ErgataiError::internal(format!("Failed to query lock: {}", e)))?;

        Ok(is_locked)
    }

    /// Get the holder of an active WRITE lock on `file_path`.
    ///
    /// Returns `(agent_id, session_id)` if a WRITE or ADMIN lock exists,
    /// `None` if the file is not locked. Used by the fanotify enforcer to
    /// decide whether a caller is the lock holder.
    pub fn get_write_lock_holder(
        &self,
        file_path: &str,
    ) -> Result<Option<(String, String)>, ErgataiError> {
        let normalized_path = self.validate_and_normalize_path(file_path)?;

        let conn = self.conn.lock();

        match conn.query_row(
            "SELECT agent_id, session_id FROM file_locks
             WHERE file_path = ?1 AND mode = 'WRITE' AND status = 'ACTIVE'
             LIMIT 1",
            params![normalized_path],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        ) {
            Ok(pair) => Ok(Some(pair)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(ErgataiError::internal(format!(
                "Failed to query lock holder: {}",
                e
            ))),
        }
    }

    /// Check file lock status and get holder info in a single query.
    ///
    /// This is an optimized method for the fanotify decision path that combines
    /// `is_file_locked()` and `get_write_lock_holder()` into a single database
    /// query, reducing mutex acquisitions from 2 to 1.
    ///
    /// Uses an in-memory cache (positive + negative entries) as a fast path to
    /// avoid database access for the common cases (unlocked files, or a stable
    /// lock holder). Falls back to database query on cache miss or stale entry.
    ///
    /// # Deadlock resistance
    ///
    /// The SQLite fallback uses `try_lock()`. If the connection mutex is held
    /// by another task (e.g., a concurrent `acquire_lock`), we fail open
    /// immediately instead of blocking. This is critical for the fanotify hot
    /// path: blocking here would stall the event loop, which in stalls the
    /// kernel's `open()` queue.
    ///
    /// Returns `(is_locked, holder_info)` where `holder_info` is `Some((agent_id, session_id))`
    /// if the file is locked, `None` otherwise.
    pub fn check_file_lock_status(
        &self,
        file_path: &str,
    ) -> Result<(bool, Option<(String, String)>), ErgataiError> {
        let normalized_path = self.validate_and_normalize_path(file_path)?;
        self.check_file_lock_status_normalized(&normalized_path)
    }

    /// Fast variant of [`Self::check_file_lock_status`] that skips the (expensive)
    /// `canonicalize()` call. Use this when the caller already has a
    /// properly-normalized path — e.g., the fanotify enforcer, which derives
    /// the relative path via `readlink /proc/self/fd/{fd}` + `strip_prefix`.
    ///
    /// Same deadlock-resistant semantics as the canonical variant.
    pub fn check_file_lock_status_fast(
        &self,
        normalized_path: &str,
    ) -> Result<(bool, Option<(String, String)>), ErgataiError> {
        self.check_file_lock_status_normalized(normalized_path)
    }

    /// Shared implementation for the two `check_file_lock_status` entry points.
    ///
    /// Invariants on `normalized_path`: it must already be relative to the project
    /// root, with symlinks resolved. Both callers guarantee this (one via
    /// `validate_and_normalize_path`, the other via `readlink + strip_prefix`).
    fn check_file_lock_status_normalized(
        &self,
        normalized_path: &str,
    ) -> Result<(bool, Option<(String, String)>), ErgataiError> {
        let now = Instant::now();

        // Fast path: check the in-memory cache first (no database access).
        //
        // Both positive (Locked) and negative (Unlocked-within-TTL) entries are
        // honored. Negative entries bound the DB load from bursts of open() calls
        // on unlocked files — the dominant case under normal workloads.
        //
        // Use read() lock for lookups — only the stale-entry removal path needs
        // write(). This avoids serializing all fanotify decisions across tokio
        // worker threads on a single write lock.
        {
            let cache = self.active_write_locks_cache.read();
            if let Some(entry) = cache.get(normalized_path) {
                match entry {
                    LockCacheEntry::Locked {
                        agent_id,
                        session_id,
                    } => {
                        return Ok((true, Some((agent_id.clone(), session_id.clone()))));
                    }
                    LockCacheEntry::Unlocked { observed_at }
                        if now.duration_since(*observed_at) < LOCK_CACHE_NEGATIVE_TTL =>
                    {
                        return Ok((false, None));
                    }
                    _ => {
                        // Stale negative entry or other — drop read lock, then
                        // acquire write lock to remove it. Fall through to DB refresh.
                    }
                }
            }
        }
        // If we reach here with a stale negative entry, remove it under write lock.
        {
            let mut cache = self.active_write_locks_cache.write();
            if let Some(LockCacheEntry::Unlocked { observed_at }) = cache.get(normalized_path) {
                if now.duration_since(*observed_at) >= LOCK_CACHE_NEGATIVE_TTL {
                    cache.remove(normalized_path);
                }
            }
        }

        // Cache miss / stale — query the database.
        //
        // IMPORTANT: use try_lock(), NOT lock(). The fanotify decision runs on a
        // tokio worker (via block_in_place); blocking on the SQLite mutex here
        // would deadlock if another task holds it. On contention we fail open —
        // a missed denial is far less harmful than a system-wide deadlock.
        let conn = match self.conn.try_lock() {
            Some(guard) => guard,
            None => {
                debug!(
                    path = normalized_path,
                    "fanotify: SQLite mutex busy, failing open to prevent deadlock"
                );
                return Ok((false, None));
            }
        };

        match conn.query_row(
            "SELECT agent_id, session_id FROM file_locks
             WHERE file_path = ?1 AND mode = 'WRITE' AND status = 'ACTIVE'
             LIMIT 1",
            params![normalized_path],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        ) {
            Ok((agent_id, session_id)) => {
                // Update cache on database hit
                drop(conn);
                let mut cache = self.active_write_locks_cache.write();
                cache.insert(
                    normalized_path.to_string(),
                    LockCacheEntry::Locked {
                        agent_id: agent_id.clone(),
                        session_id: session_id.clone(),
                    },
                );
                Ok((true, Some((agent_id, session_id))))
            }
            Err(rusqlite::Error::QueryReturnedNoRows) => {
                // Cache the negative result so the next open() of this same file
                // within LOCK_CACHE_NEGATIVE_TTL avoids the DB entirely.
                drop(conn);
                let mut cache = self.active_write_locks_cache.write();
                cache.insert(
                    normalized_path.to_string(),
                    LockCacheEntry::Unlocked { observed_at: now },
                );
                Ok((false, None))
            }
            Err(e) => Err(ErgataiError::internal(format!(
                "Failed to query lock status: {}",
                e
            ))),
        }
    }

    /// Record a kernel-enforced violation with known agent identity.
    ///
    /// Called by the fanotify `Enforcer` when it denies a file access.
    /// Unlike `record_violation`, this records the actual caller agent
    /// (if resolved) and the lock holder for audit purposes.
    pub fn record_enforced_violation(
        &self,
        file_path: &str,
        caller_agent: Option<&str>,
        holder_agent: Option<&str>,
    ) -> Result<(), ErgataiError> {
        let normalized_path = self
            .validate_and_normalize_path(file_path)
            .unwrap_or_else(|_| file_path.to_string());

        let agent_id = caller_agent.unwrap_or("unknown");
        let reason = match holder_agent {
            Some(h) => format!(
                "kernel-enforced: blocked access to {} locked by {}",
                normalized_path, h
            ),
            None => "kernel-enforced: blocked access".to_string(),
        };

        self.log_audit(
            agent_id,
            "unknown", // session_id not resolved at this layer
            "enforced_violation",
            Some(&normalized_path),
            Some("WRITE"),
            Some(&reason),
        )
    }

    /// Record a file access violation in the audit log.
    ///
    /// Called by `FileSystemWatcher` when a file modification is detected
    /// without a corresponding active lock. The agent/session are recorded
    /// as "unknown" since the watcher cannot identify the modifier.
    pub fn record_violation(&self, file_path: &str, action: &str) -> Result<(), ErgataiError> {
        let normalized_path = self
            .validate_and_normalize_path(file_path)
            .unwrap_or_else(|_| file_path.to_string());

        // Delegate to the shared audit logging method
        self.log_audit(
            "unknown",
            "unknown",
            action,
            Some(&normalized_path),
            None,
            Some(action),
        )
    }

    /// Update heartbeat for a token.
    ///
    /// M3 fix: Uses transaction to ensure atomicity across both tables.
    pub fn update_heartbeat(&self, token_id: &str) -> Result<(), ErgataiError> {
        let now = Utc::now().to_rfc3339();

        let conn = self.conn.lock();

        // Use transaction for atomicity (M3 fix)
        let tx = TransactionGuard::begin(&conn)
            .map_err(|e| ErgataiError::internal(format!("Failed to begin transaction: {}", e)))?;

        // Update in both tables (system_tokens and file_locks)
        conn.execute(
            "UPDATE system_tokens SET heartbeat_at = ?1 WHERE id = ?2",
            params![now, token_id],
        )
        .map_err(|e| {
            ErgataiError::internal(format!("Failed to update system_tokens heartbeat: {}", e))
        })?;

        conn.execute(
            "UPDATE file_locks SET heartbeat_at = ?1 WHERE token_id = ?2",
            params![now, token_id],
        )
        .map_err(|e| {
            ErgataiError::internal(format!("Failed to update file_locks heartbeat: {}", e))
        })?;

        tx.commit().map_err(|e| {
            ErgataiError::internal(format!("Failed to commit heartbeat update: {}", e))
        })?;

        debug!("Updated heartbeat for token {}", token_id);
        Ok(())
    }

    /// Validate and normalize a file path (H2 fix).
    ///
    /// - Canonicalizes the path (resolves symlinks, .., etc.)
    /// - Ensures it's within project root
    /// - Returns relative path from project root
    /// - M2 fix: Uses cached project_root_canonical to avoid repeated I/O
    ///
    /// Use this for WRITE operations where symlink safety is critical.
    fn validate_and_normalize_path(&self, file_path: &str) -> Result<String, ErgataiError> {
        let full_path = self.project_root.join(file_path);

        // Try to canonicalize the full path first
        let canonical = match full_path.canonicalize() {
            Ok(path) => path,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                // File doesn't exist yet - normalize parent directory and append filename
                let parent = full_path
                    .parent()
                    .ok_or_else(|| ErgataiError::InvalidPath("Path has no parent".to_string()))?;
                let filename = full_path
                    .file_name()
                    .ok_or_else(|| ErgataiError::InvalidPath("Path has no filename".to_string()))?;

                // Canonicalize parent (must exist)
                let canonical_parent = parent.canonicalize().map_err(|e| {
                    ErgataiError::InvalidPath(format!(
                        "Failed to canonicalize parent path {}: {}",
                        parent.display(),
                        e
                    ))
                })?;

                // Join with filename
                canonical_parent.join(filename)
            }
            Err(e) => {
                return Err(ErgataiError::InvalidPath(format!(
                    "Failed to canonicalize path {}: {}",
                    file_path, e
                )));
            }
        };

        // Use cached project_root_canonical (M2 fix: avoid repeated canonicalize)
        if !canonical.starts_with(&self.project_root_canonical) {
            return Err(ErgataiError::PermissionDenied(format!(
                "Path {} escapes project root",
                file_path
            )));
        }

        // Return relative path from project root
        let relative = canonical
            .strip_prefix(&self.project_root_canonical)
            .map_err(|e| {
                ErgataiError::internal(format!("Failed to compute relative path: {}", e))
            })?;

        // Convert to string (use forward slashes even on Windows)
        // L10 fix: use fold to avoid intermediate Vec allocation
        let path_str = relative
            .components()
            .map(|c| c.as_os_str().to_string_lossy())
            .fold(String::new(), |mut acc, part| {
                if !acc.is_empty() {
                    acc.push('/');
                }
                acc.push_str(&part);
                acc
            });

        Ok(path_str)
    }

    /// Validate that a scope pattern does not match more than `max_scope_size` files.
    ///
    /// Walks the project root and counts files matching the glob pattern. If the
    /// count exceeds the configured limit (default 1000), returns an error.
    /// This prevents overly broad scopes (e.g., `**`) from granting implicit
    /// access to the entire project.
    ///
    /// Optimization: for scopes that are a specific file path (no glob characters),
    /// the count is trivially 1, so we skip the filesystem walk.
    fn validate_scope_size(&self, scope: &str) -> Result<(), ErgataiError> {
        // Fast path: if the scope has no glob characters, it's a single file
        if !scope.contains('*') && !scope.contains('?') && !scope.contains('[') {
            return Ok(());
        }

        // Default limit (if no config manager is available)
        let max_files: u64 = 1000;

        // Validate pattern syntax first (glob::glob below re-parses, but we want
        // to catch invalid patterns here with a clear error message)
        let _validated_pattern = glob::Pattern::new(scope).map_err(|e| {
            ErgataiError::InvalidArgument(format!("Invalid scope glob pattern '{}': {}", scope, e))
        })?;

        let mut count: u64 = 0;
        let walker = glob::glob(self.project_root.join(scope).to_string_lossy().as_ref())
            .map_err(|e| ErgataiError::internal(format!("Failed to read glob pattern: {}", e)))?;

        for entry in walker {
            if entry.is_ok() {
                count += 1;
                if count > max_files {
                    return Err(ErgataiError::PermissionDenied(format!(
                        "Scope '{}' matches more than {} files (limit exceeded). Use a narrower scope.",
                        scope, max_files
                    )));
                }
            }
        }

        debug!(scope = scope, file_count = count, "Scope size validated");
        Ok(())
    }

    /// Log an action to the audit log.
    pub fn log_audit(
        &self,
        agent_id: &str,
        session_id: &str,
        action: &str,
        file_path: Option<&str>,
        mode: Option<&str>,
        reason: Option<&str>,
    ) -> Result<(), ErgataiError> {
        let conn = self.conn.lock();

        let now = Utc::now().to_rfc3339();

        conn.execute(
            "INSERT INTO audit_log (timestamp, agent_id, session_id, action, file_path, mode, reason)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![now, agent_id, session_id, action, file_path, mode, reason],
        )
        .map_err(|e| ErgataiError::internal(format!("Failed to log audit: {}", e)))?;

        Ok(())
    }

    /// Clean up old audit log entries (M5 fix).
    ///
    /// Removes entries older than the specified number of days.
    /// Returns the number of entries deleted.
    pub fn cleanup_old_audit_logs(&self, days_to_keep: u32) -> Result<usize, ErgataiError> {
        let conn = self.conn.lock();

        let cutoff = Utc::now() - chrono::Duration::days(days_to_keep as i64);
        let deleted = conn
            .execute(
                "DELETE FROM audit_log WHERE timestamp < ?1",
                params![cutoff.to_rfc3339()],
            )
            .map_err(|e| ErgataiError::internal(format!("Failed to cleanup audit log: {}", e)))?;

        info!(
            "Cleaned up {} old audit log entries (older than {} days)",
            deleted, days_to_keep
        );
        Ok(deleted)
    }

    /// Expire stale file locks whose `expires_at` has passed.
    ///
    /// This is a safety net for locks that have no associated `system_token`
    /// (e.g. auto-acquired locks from the FileSystemWatcher) and therefore
    /// cannot be expired by the normal watchdog token-heartbeat path.
    ///
    /// Returns the number of locks expired.
    pub fn expire_stale_locks(&self) -> Result<usize, ErgataiError> {
        let conn = self.conn.lock();
        let now = Utc::now().to_rfc3339();

        let expired = conn
            .execute(
                "UPDATE file_locks SET status = 'EXPIRED', updated_at = ?1
                 WHERE status = 'ACTIVE' AND expires_at < ?1",
                params![now],
            )
            .map_err(|e| {
                ErgataiError::internal(format!("Failed to expire stale locks: {}", e))
            })?;

        if expired > 0 {
            info!(
                count = expired,
                "Expired stale file locks (past expires_at)"
            );
        }

        Ok(expired)
    }

    /// Expire a specific lock by token_id and file_path.
    ///
    /// Used by the watchdog to reclaim locks when tokens expire or ACP disconnects.
    /// Unlike the old `release_lock`, this does NOT publish NATS notifications
    /// (the NATS approval flow has been removed). The caller is responsible for
    /// broadcasting file.error events if needed.
    pub fn expire_lock(&self, token_id: &str, file_path: &str) -> Result<(), ErgataiError> {
        let normalized_path = self.validate_and_normalize_path(file_path)?;
        let conn = self.conn.lock();

        let tx = TransactionGuard::begin(&conn)
            .map_err(|e| ErgataiError::internal(format!("Failed to begin transaction: {}", e)))?;

        // Get lock info for audit
        let lock_info: Option<(String, String, String)> = match conn.query_row(
            "SELECT agent_id, session_id, mode FROM file_locks
             WHERE token_id = ?1 AND file_path = ?2 AND status = 'ACTIVE'",
            params![token_id, normalized_path],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        ) {
            Ok(info) => Some(info),
            Err(rusqlite::Error::QueryReturnedNoRows) => None,
            Err(e) => {
                return Err(ErgataiError::internal(format!(
                    "Failed to query lock info for expiry: {}",
                    e
                )));
            }
        };

        if let Some((agent_id, session_id, mode)) = lock_info {
            let now = Utc::now().to_rfc3339();
            conn.execute(
                "UPDATE file_locks SET status = 'EXPIRED', updated_at = ?1
                 WHERE token_id = ?2 AND file_path = ?3",
                params![now, token_id, normalized_path],
            )
            .map_err(|e| {
                ErgataiError::internal(format!("Failed to expire lock: {}", e))
            })?;

            // Audit log
            conn.execute(
                "INSERT INTO audit_log (timestamp, agent_id, session_id, action, file_path, mode, reason)
                 VALUES (?1, ?2, ?3, 'LOCK_EXPIRED', ?4, ?5, ?6)",
                params![now, agent_id, session_id, normalized_path, mode, "watchdog-reclaim"],
            )
            .map_err(|e| {
                ErgataiError::internal(format!("Failed to log audit: {}", e))
            })?;

            // Invalidate cache
            if mode == "WRITE" || mode == "ADMIN" {
                let mut cache = self.active_write_locks_cache.write();
                cache.remove(&normalized_path);
            }

            tx.commit()
                .map_err(|e| ErgataiError::internal(format!("Failed to commit: {}", e)))?;

            info!(token_id = token_id, file_path = %normalized_path, "Expired lock via watchdog");
            Ok(())
        } else {
            debug!(token_id = token_id, file_path = %normalized_path, "No active lock to expire");
            Ok(())
        }
    }

    // ============================================================
    // Phase 5: Watchdog support methods
    // ============================================================

    /// Get all active tokens (for watchdog monitoring).
    ///
    /// Returns all tokens with status "ACTIVE".
    pub fn get_active_tokens(&self) -> Result<Vec<SystemToken>, ErgataiError> {
        let conn = self.conn.lock();

        let mut stmt = conn
            .prepare(
                "SELECT id, agent_id, session_id, project_root, issued_at, expires_at,
                        heartbeat_interval_secs, heartbeat_at, status
                 FROM system_tokens
                 WHERE status = 'ACTIVE'",
            )
            .map_err(|e| ErgataiError::internal(format!("Failed to prepare statement: {}", e)))?;

        let tokens = stmt
            .query_map([], |row| {
                Ok(SystemToken {
                    id: TokenId::from_string(row.get(0)?),
                    agent_id: row.get(1)?,
                    session_id: row.get(2)?,
                    project_root: row.get(3)?,
                    issued_at: DateTime::parse_from_rfc3339(&row.get::<_, String>(4)?)
                        .map_err(|e| {
                            rusqlite::Error::FromSqlConversionFailure(
                                0,
                                rusqlite::types::Type::Text,
                                Box::new(e),
                            )
                        })?
                        .with_timezone(&Utc),
                    expires_at: DateTime::parse_from_rfc3339(&row.get::<_, String>(5)?)
                        .map_err(|e| {
                            rusqlite::Error::FromSqlConversionFailure(
                                0,
                                rusqlite::types::Type::Text,
                                Box::new(e),
                            )
                        })?
                        .with_timezone(&Utc),
                    heartbeat_interval_secs: u64::try_from(row.get::<_, i64>(6)?).unwrap_or(30),
                    heartbeat_at: DateTime::parse_from_rfc3339(&row.get::<_, String>(7)?)
                        .map_err(|e| {
                            rusqlite::Error::FromSqlConversionFailure(
                                0,
                                rusqlite::types::Type::Text,
                                Box::new(e),
                            )
                        })?
                        .with_timezone(&Utc),
                    status: match row.get::<_, String>(8)?.as_str() {
                        "ACTIVE" => TokenStatus::Active,
                        "EXPIRED" => TokenStatus::Expired,
                        _ => TokenStatus::Expired,
                    },
                })
            })
            .map_err(|e| ErgataiError::internal(format!("Failed to query tokens: {}", e)))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| ErgataiError::internal(format!("Failed to collect tokens: {}", e)))?;

        Ok(tokens)
    }

    /// Get all tokens for a session (for ACP disconnect handling).
    pub fn get_tokens_by_session(
        &self,
        session_id: &str,
    ) -> Result<Vec<SystemToken>, ErgataiError> {
        let conn = self.conn.lock();

        let mut stmt = conn
            .prepare(
                "SELECT id, agent_id, session_id, project_root, issued_at, expires_at,
                        heartbeat_interval_secs, heartbeat_at, status
                 FROM system_tokens
                 WHERE session_id = ?1",
            )
            .map_err(|e| ErgataiError::internal(format!("Failed to prepare statement: {}", e)))?;

        let tokens = stmt
            .query_map(params![session_id], |row| {
                Ok(SystemToken {
                    id: TokenId::from_string(row.get(0)?),
                    agent_id: row.get(1)?,
                    session_id: row.get(2)?,
                    project_root: row.get(3)?,
                    issued_at: DateTime::parse_from_rfc3339(&row.get::<_, String>(4)?)
                        .map_err(|e| {
                            rusqlite::Error::FromSqlConversionFailure(
                                0,
                                rusqlite::types::Type::Text,
                                Box::new(e),
                            )
                        })?
                        .with_timezone(&Utc),
                    expires_at: DateTime::parse_from_rfc3339(&row.get::<_, String>(5)?)
                        .map_err(|e| {
                            rusqlite::Error::FromSqlConversionFailure(
                                0,
                                rusqlite::types::Type::Text,
                                Box::new(e),
                            )
                        })?
                        .with_timezone(&Utc),
                    heartbeat_interval_secs: u64::try_from(row.get::<_, i64>(6)?).unwrap_or(30),
                    heartbeat_at: DateTime::parse_from_rfc3339(&row.get::<_, String>(7)?)
                        .map_err(|e| {
                            rusqlite::Error::FromSqlConversionFailure(
                                0,
                                rusqlite::types::Type::Text,
                                Box::new(e),
                            )
                        })?
                        .with_timezone(&Utc),
                    status: match row.get::<_, String>(8)?.as_str() {
                        "ACTIVE" => TokenStatus::Active,
                        "EXPIRED" => TokenStatus::Expired,
                        _ => TokenStatus::Expired,
                    },
                })
            })
            .map_err(|e| ErgataiError::internal(format!("Failed to query tokens: {}", e)))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| ErgataiError::internal(format!("Failed to collect tokens: {}", e)))?;

        Ok(tokens)
    }

    /// Get all locks held by a token (for reclaim on timeout).
    pub fn get_locks_by_token(&self, token_id: &str) -> Result<Vec<FileLock>, ErgataiError> {
        let conn = self.conn.lock();

        let mut stmt = conn
            .prepare(
                "SELECT id, file_path, agent_id, session_id, mode, scope, token_id,
                        reason, approved_by, created_at, expires_at, heartbeat_interval_secs,
                        heartbeat_at, status
                 FROM file_locks
                 WHERE token_id = ?1 AND status = 'ACTIVE'",
            )
            .map_err(|e| ErgataiError::internal(format!("Failed to prepare statement: {}", e)))?;

        let locks = stmt
            .query_map(params![token_id], |row| {
                Ok(FileLock {
                    id: row.get(0)?,
                    file_path: row.get(1)?,
                    agent_id: row.get(2)?,
                    session_id: row.get(3)?,
                    mode: match row.get::<_, String>(4)?.as_str() {
                        "WRITE" => FileMode::Write,
                        _ => FileMode::Read,
                    },
                    scope: row.get(5)?,
                    token_id: TokenId::from_string(row.get(6)?),
                    reason: row.get(7)?,
                    approved_by: row.get(8)?,
                    created_at: DateTime::parse_from_rfc3339(&row.get::<_, String>(9)?)
                        .map_err(|e| {
                            rusqlite::Error::FromSqlConversionFailure(
                                0,
                                rusqlite::types::Type::Text,
                                Box::new(e),
                            )
                        })?
                        .with_timezone(&Utc),
                    expires_at: DateTime::parse_from_rfc3339(&row.get::<_, String>(10)?)
                        .map_err(|e| {
                            rusqlite::Error::FromSqlConversionFailure(
                                0,
                                rusqlite::types::Type::Text,
                                Box::new(e),
                            )
                        })?
                        .with_timezone(&Utc),
                    heartbeat_interval_secs: u64::try_from(row.get::<_, i64>(11)?).unwrap_or(30),
                    heartbeat_at: DateTime::parse_from_rfc3339(&row.get::<_, String>(12)?)
                        .map_err(|e| {
                            rusqlite::Error::FromSqlConversionFailure(
                                0,
                                rusqlite::types::Type::Text,
                                Box::new(e),
                            )
                        })?
                        .with_timezone(&Utc),
                    status: match row.get::<_, String>(13)?.as_str() {
                        "ACTIVE" => TokenStatus::Active,
                        "EXPIRED" => TokenStatus::Expired,
                        _ => TokenStatus::Expired,
                    },
                })
            })
            .map_err(|e| ErgataiError::internal(format!("Failed to query locks: {}", e)))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| ErgataiError::internal(format!("Failed to collect locks: {}", e)))?;

        Ok(locks)
    }

    /// Get all active locks for a session (for ACP disconnect reclaim).
    ///
    /// Unlike `get_locks_by_token` which queries by file_token_id,
    /// this queries by session_id — which is what the watchdog needs
    /// when reclaiming all locks for a disconnected agent session.
    pub fn get_locks_by_session(&self, session_id: &str) -> Result<Vec<FileLock>, ErgataiError> {
        let conn = self.conn.lock();

        let mut stmt = conn
            .prepare(
                "SELECT id, file_path, agent_id, session_id, mode, scope, token_id,
                        reason, approved_by, created_at, expires_at, heartbeat_interval_secs,
                        heartbeat_at, status
                 FROM file_locks
                 WHERE session_id = ?1 AND status = 'ACTIVE'",
            )
            .map_err(|e| ErgataiError::internal(format!("Failed to prepare statement: {}", e)))?;

        let locks = stmt
            .query_map(params![session_id], parse_file_lock_row)
            .map_err(|e| ErgataiError::internal(format!("Failed to query locks: {}", e)))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| ErgataiError::internal(format!("Failed to collect locks: {}", e)))?;

        Ok(locks)
    }

    /// Get an AuditManager sharing this manager's database connection.
    ///
    /// Useful for querying audit log entries after lock operations without
    /// requiring a separate connection.
    pub fn audit_manager(&self) -> AuditManager {
        AuditManager::new(
            Arc::clone(&self.conn),
            self.project_root.to_string_lossy().to_string(),
        )
    }

    /// Test helper: Set heartbeat to a past time for testing timeout scenarios
    #[cfg(test)]
    pub fn set_heartbeat_past(&self, token_id: &str, seconds_ago: i64) -> Result<(), ErgataiError> {
        let conn = self.conn.lock();

        // Use strftime to format as RFC3339 (ISO 8601 with timezone)
        conn.execute(
            "UPDATE system_tokens SET heartbeat_at = strftime('%Y-%m-%dT%H:%M:%S+00:00', 'now', ?1) WHERE id = ?2",
            rusqlite::params![format!("-{} seconds", seconds_ago), token_id],
        )
        .map_err(|e| ErgataiError::internal(format!("Failed to update heartbeat: {}", e)))?;

        Ok(())
    }

    /// Get all file tokens for a given system token ID
    pub fn get_file_tokens_by_system_token(
        &self,
        system_token_id: &str,
    ) -> Result<Vec<FileToken>, ErgataiError> {
        let conn = self.conn.lock();

        let mut stmt = conn
            .prepare(
                "SELECT id, agent_id, session_id, system_token_id, scope, mode, reason,
                        approved_by, issued_at, expires_at, heartbeat_interval_secs,
                        heartbeat_at, status
                 FROM file_tokens
                 WHERE system_token_id = ?1 AND status = 'ACTIVE'",
            )
            .map_err(|e| ErgataiError::internal(format!("Failed to prepare query: {}", e)))?;

        let tokens = stmt
            .query_map(params![system_token_id], |row| {
                Ok(FileToken {
                    id: TokenId::from_string(row.get::<_, String>(0)?),
                    agent_id: row.get::<_, String>(1)?,
                    session_id: row.get::<_, String>(2)?,
                    system_token_id: TokenId::from_string(row.get::<_, String>(3)?),
                    scope: row.get::<_, String>(4)?,
                    mode: parse_file_mode(&row.get::<_, String>(5)?),
                    reason: row.get::<_, Option<String>>(6)?,
                    approved_by: row.get::<_, String>(7)?,
                    issued_at: parse_datetime(&row.get::<_, String>(8)?),
                    expires_at: parse_datetime(&row.get::<_, String>(9)?),
                    heartbeat_interval_secs: u64::try_from(row.get::<_, i64>(10)?).unwrap_or(30),
                    heartbeat_at: parse_datetime(&row.get::<_, String>(11)?),
                    status: parse_token_status(&row.get::<_, String>(12)?),
                    priority: None,
                })
            })
            .map_err(|e| ErgataiError::internal(format!("Failed to query file tokens: {}", e)))?;

        let mut result = Vec::new();
        for token in tokens {
            result.push(token.map_err(|e| {
                ErgataiError::internal(format!("Failed to parse file token: {}", e))
            })?);
        }

        Ok(result)
    }

    /// Get all active file locks
    ///
    /// Returns a list of all currently active file locks across all agents.
    pub fn get_all_active_locks(&self) -> Result<Vec<FileLock>, ErgataiError> {
        let conn = self.conn.lock();

        let mut stmt = conn
            .prepare(
                "SELECT id, file_path, agent_id, session_id, mode, scope, token_id,
                        reason, approved_by, created_at, expires_at, heartbeat_interval_secs,
                        heartbeat_at, status
                 FROM file_locks
                 WHERE status = 'ACTIVE'",
            )
            .map_err(|e| ErgataiError::internal(format!("Failed to prepare query: {}", e)))?;

        let locks = stmt
            .query_map(params![], parse_file_lock_row)
            .map_err(|e| ErgataiError::internal(format!("Failed to query locks: {}", e)))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| ErgataiError::internal(format!("Failed to collect locks: {}", e)))?;

        Ok(locks)
    }

    /// Check if an agent has any audit log entries within a time range.
    ///
    /// Used as a sanity check to detect "hallucinating agents" — agents that claim
    /// completion but didn't actually modify any files (no lock history).
    ///
    /// # Arguments
    /// * `agent_id` - The agent identifier to check
    /// * `since` - Only count entries after this timestamp
    ///
    /// # Returns
    /// `true` if the agent has at least one audit log entry in the time range
    pub fn has_agent_activity_since(
        &self,
        agent_id: &str,
        since: DateTime<Utc>,
    ) -> Result<bool, ErgataiError> {
        let conn = self.conn.lock();

        let mut stmt = conn
            .prepare(
                "SELECT COUNT(*) FROM audit_log
                 WHERE agent_id = ?1 AND timestamp >= ?2",
            )
            .map_err(|e| ErgataiError::internal(format!("Failed to prepare query: {}", e)))?;

        let count: i64 = stmt
            .query_row(params![agent_id, since.to_rfc3339()], |row| row.get(0))
            .map_err(|e| ErgataiError::internal(format!("Failed to query audit log: {}", e)))?;

        Ok(count > 0)
    }

    /// Mark a token as expired (for watchdog timeout handling).
    pub fn expire_token(&self, token_id: &str) -> Result<(), ErgataiError> {
        let conn = self.conn.lock();

        // Get the session_id before expiring so we can unregister the session
        let session_id: Option<String> = conn
            .query_row(
                "SELECT session_id FROM system_tokens WHERE id = ?1",
                params![token_id],
                |row| row.get(0),
            )
            .ok();

        conn.execute(
            "UPDATE system_tokens SET status = 'EXPIRED' WHERE id = ?1",
            params![token_id],
        )
        .map_err(|e| ErgataiError::internal(format!("Failed to expire token: {}", e)))?;

        // Unregister the session if we found it.
        // Use the _locked variant because we already hold conn — calling the
        // regular unregister_session_with_id would deadlock on conn.lock().
        if let Some(sid) = session_id {
            self.unregister_session_with_id_locked(&conn, &sid);
        }

        info!("Token {} marked as expired", token_id);
        Ok(())
    }

    /// Find an active FileToken by session_id.
    ///
    /// Returns the most recently issued active FileToken for the given session.
    pub fn find_active_file_token_by_session(
        &self,
        session_id: &str,
    ) -> Result<FileToken, ErgataiError> {
        let conn = self.conn.lock();

        let mut stmt = conn
            .prepare(
                "SELECT id, agent_id, session_id, system_token_id, scope, mode, reason,
                        approved_by, issued_at, expires_at, heartbeat_interval_secs,
                        heartbeat_at, status, priority
                 FROM file_tokens
                 WHERE session_id = ?1 AND status = 'ACTIVE'
                 ORDER BY issued_at DESC
                 LIMIT 1",
            )
            .map_err(|e| ErgataiError::internal(format!("Failed to prepare query: {}", e)))?;

        let token = stmt
            .query_row(params![session_id], |row| {
                Ok(FileToken {
                    id: TokenId::from_string(row.get::<_, String>(0)?),
                    agent_id: row.get::<_, String>(1)?,
                    session_id: row.get::<_, String>(2)?,
                    system_token_id: TokenId::from_string(row.get::<_, String>(3)?),
                    scope: row.get::<_, String>(4)?,
                    mode: parse_file_mode(&row.get::<_, String>(5)?),
                    reason: row.get::<_, Option<String>>(6)?,
                    approved_by: row.get::<_, String>(7)?,
                    issued_at: parse_datetime(&row.get::<_, String>(8)?),
                    expires_at: parse_datetime(&row.get::<_, String>(9)?),
                    heartbeat_interval_secs: row.get::<_, u64>(10)?,
                    heartbeat_at: parse_datetime(&row.get::<_, String>(11)?),
                    status: parse_token_status(&row.get::<_, String>(12)?),
                    // SAFETY: priority is stored as i64 (SQLite INTEGER) but must fit u8 (0-255).
                    // Values outside u8 range are clamped to None to prevent silent truncation
                    // from `as u8` which would wrap 256 → 0, -1 → 255, etc.
                    priority: row
                        .get::<_, Option<i64>>(13)?
                        .and_then(|p| u8::try_from(p).ok()),
                })
            })
            .map_err(|e| ErgataiError::NotFound(format!("FileToken not found: {}", e)))?;

        Ok(token)
    }

    /// Find an active SystemToken by session_id.
    ///
    /// Returns the most recently issued active SystemToken for the given session.
    pub fn find_active_system_token_by_session(
        &self,
        session_id: &str,
    ) -> Result<SystemToken, ErgataiError> {
        let conn = self.conn.lock();

        let mut stmt = conn
            .prepare(
                "SELECT id, agent_id, session_id, project_root, issued_at, expires_at,
                        heartbeat_interval_secs, heartbeat_at, status
                 FROM system_tokens
                 WHERE session_id = ?1 AND status = 'ACTIVE'
                 ORDER BY issued_at DESC
                 LIMIT 1",
            )
            .map_err(|e| ErgataiError::internal(format!("Failed to prepare query: {}", e)))?;

        let token = stmt
            .query_row(params![session_id], |row| {
                Ok(SystemToken {
                    id: TokenId::from_string(row.get::<_, String>(0)?),
                    agent_id: row.get::<_, String>(1)?,
                    session_id: row.get::<_, String>(2)?,
                    project_root: row.get::<_, String>(3)?,
                    issued_at: parse_datetime(&row.get::<_, String>(4)?),
                    expires_at: parse_datetime(&row.get::<_, String>(5)?),
                    heartbeat_interval_secs: row.get::<_, u64>(6)?,
                    heartbeat_at: parse_datetime(&row.get::<_, String>(7)?),
                    status: parse_token_status(&row.get::<_, String>(8)?),
                })
            })
            .map_err(|e| ErgataiError::NotFound(format!("SystemToken not found: {}", e)))?;

        Ok(token)
    }

    /// Register a FileToken in the database.
    pub fn register_file_token(&self, token: &FileToken) -> Result<(), ErgataiError> {
        // Validate scope size (M9 fix): count matching files and reject if over limit
        self.validate_scope_size(&token.scope)?;

        let conn = self.conn.lock();

        conn.execute(
            "INSERT INTO file_tokens (
                id, agent_id, session_id, system_token_id, scope, mode, reason,
                approved_by, issued_at, expires_at, heartbeat_interval_secs,
                heartbeat_at, status, priority
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
            params![
                token.id.to_string(),
                token.agent_id,
                token.session_id,
                token.system_token_id.to_string(),
                token.scope,
                format!("{:?}", token.mode),
                token.reason,
                token.approved_by,
                token.issued_at.to_rfc3339(),
                token.expires_at.to_rfc3339(),
                token.heartbeat_interval_secs,
                token.heartbeat_at.to_rfc3339(),
                token.status.to_string(),
                token.priority.map(|p| p as i64),
            ],
        )
        .map_err(|e| ErgataiError::internal(format!("Failed to register file token: {}", e)))?;

        info!(
            "FileToken {} registered for agent {}",
            token.id, token.agent_id
        );
        Ok(())
    }

    /// Find an active FileToken by token_id.
    pub fn find_active_file_token_by_id(&self, token_id: &str) -> Result<FileToken, ErgataiError> {
        let conn = self.conn.lock();

        let mut stmt = conn
            .prepare(
                "SELECT id, agent_id, session_id, system_token_id, scope, mode, reason,
                        approved_by, issued_at, expires_at, heartbeat_interval_secs,
                        heartbeat_at, status, priority
                 FROM file_tokens
                 WHERE id = ?1 AND status = 'ACTIVE'",
            )
            .map_err(|e| ErgataiError::internal(format!("Failed to prepare query: {}", e)))?;

        let token = stmt
            .query_row(params![token_id], |row| {
                Ok(FileToken {
                    id: TokenId::from_string(row.get::<_, String>(0)?),
                    agent_id: row.get::<_, String>(1)?,
                    session_id: row.get::<_, String>(2)?,
                    system_token_id: TokenId::from_string(row.get::<_, String>(3)?),
                    scope: row.get::<_, String>(4)?,
                    mode: parse_file_mode(&row.get::<_, String>(5)?),
                    reason: row.get::<_, Option<String>>(6)?,
                    approved_by: row.get::<_, String>(7)?,
                    issued_at: parse_datetime(&row.get::<_, String>(8)?),
                    expires_at: parse_datetime(&row.get::<_, String>(9)?),
                    heartbeat_interval_secs: row.get::<_, u64>(10)?,
                    heartbeat_at: parse_datetime(&row.get::<_, String>(11)?),
                    status: parse_token_status(&row.get::<_, String>(12)?),
                    // SAFETY: priority is stored as i64 (SQLite INTEGER) but must fit u8 (0-255).
                    // Values outside u8 range are clamped to None to prevent silent truncation
                    // from `as u8` which would wrap 256 → 0, -1 → 255, etc.
                    priority: row
                        .get::<_, Option<i64>>(13)?
                        .and_then(|p| u8::try_from(p).ok()),
                })
            })
            .map_err(|e| ErgataiError::NotFound(format!("FileToken not found: {}", e)))?;

        Ok(token)
    }

    /// Add a waiter for READ_LATEST (file_path → notification channel).
    ///
    /// Returns a receiver that will be notified when the file is ready or has an error.
    pub async fn add_waiter(
        &self,
        file_path: &str,
    ) -> Result<oneshot::Receiver<Result<(), String>>, ErgataiError> {
        let (tx, rx) = oneshot::channel();
        let mut waiters = self.waiters.lock();
        // Prune dead senders (where the receiver was dropped, e.g. agent crashed)
        // before adding a new one. Without this, entries accumulate when waiters
        // time out or disconnect before the file operation completes.
        let entry = waiters.entry(file_path.to_string()).or_default();
        entry.retain(|tx| !tx.is_closed());
        entry.push(tx);
        debug!("Added waiter for file {}", file_path);
        Ok(rx)
    }

    /// Notify waiters that a file is ready (WRITE completed).
    pub async fn notify_file_ready(&self, file_path: &str) -> Result<(), ErgataiError> {
        let mut waiters = self.waiters.lock();
        if let Some(waiters_list) = waiters.remove(file_path) {
            info!(
                "Notifying {} waiters that file {} is ready",
                waiters_list.len(),
                file_path
            );
            for tx in waiters_list {
                if tx.send(Ok(())).is_err() {
                    warn!("Waiter for file {} already dropped", file_path);
                }
            }
        }
        Ok(())
    }

    /// Notify waiters that a file has an error (writer crashed).
    pub async fn notify_file_error(
        &self,
        file_path: &str,
        reason: &str,
    ) -> Result<(), ErgataiError> {
        let mut waiters = self.waiters.lock();
        if let Some(waiters_list) = waiters.remove(file_path) {
            warn!(
                "Notifying {} waiters that file {} has error: {}",
                waiters_list.len(),
                file_path,
                reason
            );
            let error_msg = reason.to_string();
            for tx in waiters_list {
                if tx.send(Err(error_msg.clone())).is_err() {
                    warn!("Waiter for file {} already dropped", file_path);
                }
            }
        }
        Ok(())
    }

    /// Check if a file is locked for writing.
    pub fn is_file_locked_for_write(&self, file_path: &str) -> Result<bool, ErgataiError> {
        // Normalize path to match database storage format
        let normalized_path = self.validate_and_normalize_path(file_path)?;

        let conn = self.conn.lock();

        let has_lock: bool = conn
            .query_row(
                "SELECT COUNT(*) > 0 FROM file_locks
                 WHERE file_path = ?1 AND mode = 'WRITE' AND status = 'ACTIVE'",
                params![normalized_path],
                |row| row.get(0),
            )
            .map_err(|e| ErgataiError::internal(format!("Failed to check lock: {}", e)))?;

        Ok(has_lock)
    }

    /// Read the latest version of a file (READ_LATEST semantics).
    ///
    /// Waits for any pending WRITE to complete or fail before reading.
    /// Returns the file content as bytes.
    ///
    /// Read the latest content of a file, waiting for any pending WRITE to complete.
    ///
    /// Waits for any pending WRITE to complete or fail before reading.
    /// Returns the file content as bytes.
    ///
    /// # Safety Note
    /// This method does NOT hold the waiters lock while checking the lock state,
    /// because `is_file_locked_for_write` acquires `conn` lock. Holding `waiters`
    /// while acquiring `conn` would create a lock ordering inversion with
    /// `release_lock` (which does `conn` → `waiters`), causing deadlock.
    ///
    /// There is a minor TOCTOU race: if WRITE completes between the check and
    /// waiter registration, the waiter blocks up to 30s timeout. This is safe
    /// (not a deadlock) and rare in practice.
    pub async fn read_latest(&self, file_path: &str) -> Result<Vec<u8>, ErgataiError> {
        // Validate and normalize path to prevent path traversal attacks
        let normalized_path = self.validate_and_normalize_path(file_path)?;

        // Check if file is locked for WRITE (acquires/releases conn lock)
        if self.is_file_locked_for_write(&normalized_path)? {
            // Register waiter (acquires waiters lock — no conn lock held, avoids deadlock)
            let rx = self.add_waiter(&normalized_path).await?;
            // Wait for notification or timeout (30 seconds)
            match tokio::time::timeout(std::time::Duration::from_secs(30), rx).await {
                Ok(Ok(Ok(()))) => {
                    // File is ready, proceed to read
                    debug!("File {} is ready, reading", normalized_path);
                }
                Ok(Ok(Err(reason))) => {
                    // File has error
                    return Err(ErgataiError::internal(format!(
                        "File {} has error: {}",
                        normalized_path, reason
                    )));
                }
                Ok(Err(_)) => {
                    // Channel closed (sender dropped)
                    return Err(ErgataiError::internal(format!(
                        "Waiter channel closed for file {}",
                        normalized_path
                    )));
                }
                Err(_) => {
                    // Timeout
                    return Err(ErgataiError::internal(format!(
                        "Timeout waiting for file {} to become ready",
                        normalized_path
                    )));
                }
            }
        }

        // Read the file using normalized path
        let full_path = self.project_root.join(&normalized_path);
        tokio::fs::read(&full_path).await.map_err(|e| {
            ErgataiError::internal(format!("Failed to read file {}: {}", normalized_path, e))
        })
    }

    // ─── Single-agent mode detection ─────────────────────────────────────

    /// Register a new active ACP session.
    ///
    /// Called when an ACP session is created (system token issued).
    /// Updates the active session count.
    pub fn register_session(&self) {
        let prev = self.active_session_count.fetch_add(1, Ordering::Relaxed);
        info!(
            prev_count = prev,
            new_count = prev + 1,
            "ACP session registered"
        );
    }

    /// Register a specific session by ID.
    pub fn register_session_with_id(&self, _session_id: &str) {
        self.register_session();
    }

    /// Unregister an active ACP session.
    ///
    /// Called when an ACP session ends (system token revoked or expired).
    /// Updates the active session count.
    pub fn unregister_session(&self) {
        // Use fetch_update for atomic saturating subtract (prevents lost-update race with fetch_add)
        let prev = self
            .active_session_count
            .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |val| {
                Some(val.saturating_sub(1))
            })
            .unwrap_or(0);
        let new = prev.saturating_sub(1);
        info!(
            prev_count = prev,
            new_count = new,
            "ACP session unregistered"
        );
    }

    /// Unregister a specific session by ID.
    pub fn unregister_session_with_id(&self, _session_id: &str) {
        self.unregister_session();
    }

    /// Variant of `unregister_session_with_id` for callers that already hold `conn`.
    ///
    /// Calling the regular `unregister_session_with_id` while holding `conn` would
    /// deadlock because `Mutex<Connection>` is not reentrant.
    pub fn unregister_session_with_id_locked(&self, _conn: &Connection, _session_id: &str) {
        self.unregister_session();
    }

    /// Get the current active session count (for diagnostics).
    pub fn active_session_count(&self) -> usize {
        self.active_session_count.load(Ordering::Relaxed)
    }
}

// Helper functions for parsing database values

fn parse_file_mode(s: &str) -> FileMode {
    // L9 fix: use eq_ignore_ascii_case to avoid allocation from to_uppercase()
    if s.eq_ignore_ascii_case("READ") {
        FileMode::Read
    } else if s.eq_ignore_ascii_case("WRITE") {
        FileMode::Write
    } else if s.eq_ignore_ascii_case("ADMIN") {
        FileMode::Admin
    } else {
        tracing::warn!(
            mode = s,
            "Unknown file mode in DB, defaulting to Read (least privilege)"
        );
        FileMode::Read
    }
}

fn parse_token_status(s: &str) -> TokenStatus {
    if s.eq_ignore_ascii_case("ACTIVE") {
        TokenStatus::Active
    } else if s.eq_ignore_ascii_case("EXPIRED") {
        TokenStatus::Expired
    } else {
        tracing::warn!(
            status = s,
            "Unknown token status in DB, defaulting to Expired (fail-safe)"
        );
        TokenStatus::Expired
    }
}

fn parse_datetime(s: &str) -> DateTime<Utc> {
    match DateTime::parse_from_rfc3339(s) {
        Ok(dt) => dt.with_timezone(&Utc),
        Err(e) => {
            tracing::error!(raw = s, error = %e, "Invalid datetime in DB, using UNIX_EPOCH (fail-safe: expired)");
            DateTime::UNIX_EPOCH
        }
    }
}

/// Parse a database row into a FileLock struct.
/// Used by both `get_locks_by_token` and `get_locks_by_session`.
fn parse_file_lock_row(row: &rusqlite::Row) -> rusqlite::Result<FileLock> {
    Ok(FileLock {
        id: row.get(0)?,
        file_path: row.get(1)?,
        agent_id: row.get(2)?,
        session_id: row.get(3)?,
        mode: match row.get::<_, String>(4)?.as_str() {
            "WRITE" => FileMode::Write,
            _ => FileMode::Read,
        },
        scope: row.get(5)?,
        token_id: TokenId::from_string(row.get(6)?),
        reason: row.get(7)?,
        approved_by: row.get(8)?,
        created_at: DateTime::parse_from_rfc3339(&row.get::<_, String>(9)?)
            .map_err(|e| {
                rusqlite::Error::FromSqlConversionFailure(
                    0,
                    rusqlite::types::Type::Text,
                    Box::new(e),
                )
            })?
            .with_timezone(&Utc),
        expires_at: DateTime::parse_from_rfc3339(&row.get::<_, String>(10)?)
            .map_err(|e| {
                rusqlite::Error::FromSqlConversionFailure(
                    0,
                    rusqlite::types::Type::Text,
                    Box::new(e),
                )
            })?
            .with_timezone(&Utc),
        heartbeat_interval_secs: row.get::<_, i64>(11)? as u64,
        heartbeat_at: DateTime::parse_from_rfc3339(&row.get::<_, String>(12)?)
            .map_err(|e| {
                rusqlite::Error::FromSqlConversionFailure(
                    0,
                    rusqlite::types::Type::Text,
                    Box::new(e),
                )
            })?
            .with_timezone(&Utc),
        status: match row.get::<_, String>(13)?.as_str() {
            "ACTIVE" => TokenStatus::Active,
            "EXPIRED" => TokenStatus::Expired,
            _ => TokenStatus::Expired,
        },
    })
}

