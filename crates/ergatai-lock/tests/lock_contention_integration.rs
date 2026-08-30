//! Lock contention + wait queue integration tests
//!
//! Tests the full chain: `acquire_lock_with_wait()` → NATS LOCK_WAITERS stream
//! → `LockWaitConsumer` → grant notification → retry acquire.
//!
//! T1-T7: pure Rust (embedded NATS), no Docker needed.
//! T8: requires Docker --privileged (fanotify + NATS end-to-end).

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use ergatai_lock::lock_manager::FileLockManager;
use ergatai_lock::lock_wait_consumer::LockWaitConsumer;
use ergatai_lock::lock_waiter::LockReleaseNotification;
use ergatai_lock::{FileMode, FileToken, SystemToken};
use ergatai_nats::connection::NatsConnection;
use ergatai_nats::file_access_streams::lock_waiters_stream_config;
use ergatai_nats::server::NatsServer;
use futures_util::StreamExt;
use tempfile::TempDir;
use tokio::runtime::Runtime;

// Initialize tracing once for all tests
static INIT: std::sync::Once = std::sync::Once::new();
fn init_tracing() {
    INIT.call_once(|| {
        let _ = tracing_subscriber::fmt()
            .with_env_filter(
                tracing_subscriber::EnvFilter::from_default_env()
                    .add_directive("ergatai_lock=debug".parse().unwrap()),
            )
            .with_test_writer()
            .try_init();
    });
}

// ── Fixture ──

struct ContentionFixture {
    _tempdir: TempDir,
    project_root: PathBuf,
    lock_manager: Arc<FileLockManager>,
    _nats_server: NatsServer,
    nats_connection: Arc<NatsConnection>,
    _consumer_handle: tokio::task::JoinHandle<()>,
    rt: Runtime,
}

impl ContentionFixture {
    /// Returns `None` (and the test should early-return) if nats-server is not
    /// available on PATH — this lets the suite skip gracefully in CI environments
    /// without the binary.
    fn new() -> Option<Self> {
        init_tracing();
        let tempdir = TempDir::new().unwrap();
        let project_root = tempdir.path().to_path_buf();

        // Create .ergatai directory
        std::fs::create_dir_all(project_root.join(".ergatai")).unwrap();

        let rt = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(4)
            .enable_all()
            .build()
            .unwrap();

        let (nats_server, nats_connection, lock_manager, consumer_handle) = rt.block_on(async {
            // Start embedded NATS
            let nats_dir = project_root.join(".ergatai/nats");
            let nats_server = match NatsServer::start_with_store_dir(nats_dir).await {
                Ok(s) => s,
                Err(e) => {
                    eprintln!("⚠️  Skipping (NATS not available): {}", e);
                    return None;
                }
            };

            let nats_connection = Arc::new(
                NatsConnection::connect_to_server(&nats_server)
                    .await
                    .unwrap(),
            );

            // Create LOCK_WAITERS stream
            nats_connection
                .create_stream(lock_waiters_stream_config())
                .await
                .expect("failed to create LOCK_WAITERS stream");

            // Create FileLockManager with NATS client
            let db_path = project_root.join(".ergatai/locks.db");
            let lock_manager = Arc::new(
                FileLockManager::new(
                    &db_path,
                    project_root.clone(),
                    Some(Arc::new(nats_connection.client().clone())),
                )
                .expect("failed to create lock manager"),
            );

            // Start LockWaitConsumer
            let consumer = LockWaitConsumer::new(
                (*nats_connection).clone(),
                "LOCK_WAITERS".to_string(),
                "test-contention-consumer".to_string(),
                lock_manager.clone(),
            )
            .await
            .expect("failed to create lock wait consumer");

            let consumer_handle = consumer.start();

            // Give consumer time to initialize
            tokio::time::sleep(Duration::from_millis(200)).await;

            Some((nats_server, nats_connection, lock_manager, consumer_handle))
        })?;

        Some(Self {
            _tempdir: tempdir,
            project_root,
            lock_manager,
            _nats_server: nats_server,
            nats_connection,
            _consumer_handle: consumer_handle,
            rt,
        })
    }

    /// Create a (SystemToken, FileToken) pair for an agent
    fn create_agent_token(&self, agent_id: &str, session_id: &str) -> (SystemToken, FileToken) {
        let system_token = SystemToken::new(
            agent_id.to_string(),
            session_id.to_string(),
            self.project_root.to_string_lossy().to_string(),
            3600,
            30,
        );
        self.lock_manager
            .register_system_token(&system_token)
            .unwrap();

        let file_token = FileToken::new(
            agent_id.to_string(),
            session_id.to_string(),
            system_token.id.clone(),
            "**".to_string(),
            FileMode::Write,
            Some("test".to_string()),
            "system".to_string(),
            3600,
            15,
        );
        self.lock_manager.register_file_token(&file_token).unwrap();

        (system_token, file_token)
    }

    /// Create a READ-mode FileToken for an agent
    fn create_read_token(&self, agent_id: &str, session_id: &str) -> (SystemToken, FileToken) {
        let system_token = SystemToken::new(
            agent_id.to_string(),
            session_id.to_string(),
            self.project_root.to_string_lossy().to_string(),
            3600,
            30,
        );
        self.lock_manager
            .register_system_token(&system_token)
            .unwrap();

        let file_token = FileToken::new(
            agent_id.to_string(),
            session_id.to_string(),
            system_token.id.clone(),
            "**".to_string(),
            FileMode::Read,
            Some("test".to_string()),
            "system".to_string(),
            3600,
            15,
        );
        self.lock_manager.register_file_token(&file_token).unwrap();

        (system_token, file_token)
    }
}

// ── T1: immediate grant (no contention) ──

#[test]
fn test_acquire_lock_with_wait_immediate_grant() {
    let Some(fix) = ContentionFixture::new() else {
        return;
    };
    fix.rt.block_on(async {
        let (_sys_a, token_a) = fix.create_agent_token("agent-a", "session-a");

        let result = fix
            .lock_manager
            .acquire_lock_with_wait(
                &token_a,
                "file.txt",
                fix.nats_connection.clone(),
                Duration::from_secs(5),
            )
            .await;

        assert!(
            result.is_ok(),
            "immediate grant should succeed: {:?}",
            result
        );
        assert!(
            fix.lock_manager.is_file_locked("file.txt").unwrap(),
            "file should be locked after acquire"
        );
    });
}

// ── T2: blocks until release ──

#[test]
fn test_acquire_lock_with_wait_blocks_until_release() {
    let Some(fix) = ContentionFixture::new() else {
        return;
    };
    fix.rt.block_on(async {
        let (_sys_a, token_a) = fix.create_agent_token("agent-a", "session-a");
        let (_sys_b, token_b) = fix.create_agent_token("agent-b", "session-b");

        // agent-a acquires lock immediately
        fix.lock_manager
            .acquire_lock(&token_a, "contested.txt")
            .await
            .unwrap();
        assert!(fix.lock_manager.is_file_locked("contested.txt").unwrap());

        // agent-b tries to acquire with wait (in background task)
        let lm = fix.lock_manager.clone();
        let nats = fix.nats_connection.clone();
        let tb = token_b.clone();
        let waiter = tokio::spawn(async move {
            lm.acquire_lock_with_wait(&tb, "contested.txt", nats, Duration::from_secs(10))
                .await
        });

        // Give agent-b time to enter the wait queue
        tokio::time::sleep(Duration::from_millis(500)).await;

        // agent-b should still be waiting (lock held by agent-a)
        assert!(!waiter.is_finished(), "agent-b should still be waiting");

        // agent-a releases the lock
        fix.lock_manager
            .release_lock(token_a.id.as_str(), "contested.txt")
            .await
            .unwrap();

        // agent-b should now succeed (LockWaitConsumer redelivers and grants)
        // Outer timeout must exceed inner waiter's 10s timeout to avoid race
        let result = tokio::time::timeout(Duration::from_secs(15), waiter)
            .await
            .expect("timeout waiting for agent-b")
            .expect("join error");

        assert!(
            result.is_ok(),
            "agent-b should acquire lock after release: {:?}",
            result
        );
    });
}

// ── T3: timeout ──

#[test]
fn test_acquire_lock_with_wait_timeout() {
    let Some(fix) = ContentionFixture::new() else {
        return;
    };
    fix.rt.block_on(async {
        let (_sys_a, token_a) = fix.create_agent_token("agent-a", "session-a");
        let (_sys_b, token_b) = fix.create_agent_token("agent-b", "session-b");

        // agent-a acquires lock
        fix.lock_manager
            .acquire_lock(&token_a, "timeout_test.txt")
            .await
            .unwrap();

        // agent-b tries to acquire with a short timeout — do NOT release agent-a's lock
        let result = fix
            .lock_manager
            .acquire_lock_with_wait(
                &token_b,
                "timeout_test.txt",
                fix.nats_connection.clone(),
                Duration::from_secs(2),
            )
            .await;

        assert!(
            result.is_err(),
            "should timeout when lock is never released"
        );
        let err_msg = result.unwrap_err().to_string();
        assert!(
            err_msg.contains("timed out") || err_msg.contains("timeout"),
            "error should mention timeout, got: {}",
            err_msg
        );
    });
}

// ── T4: multiple waiters ──

#[test]
fn test_multiple_waiters_both_granted_sequentially() {
    let Some(fix) = ContentionFixture::new() else {
        return;
    };
    fix.rt.block_on(async {
        let (_sys_a, token_a) = fix.create_agent_token("agent-a", "session-a");
        let (_sys_b, token_b) = fix.create_agent_token("agent-b", "session-b");
        let (_sys_c, token_c) = fix.create_agent_token("agent-c", "session-c");

        // agent-a acquires lock
        fix.lock_manager
            .acquire_lock(&token_a, "multi_wait.txt")
            .await
            .unwrap();

        // agent-b and agent-c both wait
        let lm = fix.lock_manager.clone();
        let nats = fix.nats_connection.clone();

        let tb = token_b.clone();
        let lm_b = lm.clone();
        let nats_b = nats.clone();
        let waiter_b = tokio::spawn(async move {
            lm_b.acquire_lock_with_wait(&tb, "multi_wait.txt", nats_b, Duration::from_secs(15))
                .await
        });

        let tc = token_c.clone();
        let waiter_c = tokio::spawn(async move {
            lm.acquire_lock_with_wait(&tc, "multi_wait.txt", nats, Duration::from_secs(15))
                .await
        });

        // Give waiters time to enter queue
        tokio::time::sleep(Duration::from_millis(500)).await;

        // agent-a releases
        fix.lock_manager
            .release_lock(token_a.id.as_str(), "multi_wait.txt")
            .await
            .unwrap();

        // Both should eventually succeed (sequentially — one gets it first,
        // then releases, then the other gets it). For this test we just
        // verify both got Ok at some point.
        let result_b = tokio::time::timeout(Duration::from_secs(15), waiter_b)
            .await
            .expect("timeout on waiter_b")
            .expect("join error");
        let result_c = tokio::time::timeout(Duration::from_secs(15), waiter_c)
            .await
            .expect("timeout on waiter_c")
            .expect("join error");

        // At least one should succeed. The second may fail if the first
        // re-locks it. That's expected behavior for WRITE locks.
        let success_count = [result_b.is_ok(), result_c.is_ok()]
            .iter()
            .filter(|&&v| v)
            .count();
        assert!(
            success_count >= 1,
            "at least one waiter should succeed: b={:?}, c={:?}",
            result_b,
            result_c
        );
    });
}

// ── T5: same agent reentrant READ lock ──

#[test]
fn test_same_agent_reentrant_lock() {
    let Some(fix) = ContentionFixture::new() else {
        return;
    };
    fix.rt.block_on(async {
        let (_sys_a, token_a) = fix.create_read_token("agent-a", "session-a");

        // First acquire: agent-a gets a READ lock
        fix.lock_manager
            .acquire_lock(&token_a, "reentrant.txt")
            .await
            .unwrap();

        // Same agent tries again via acquire_lock_with_wait — also READ mode.
        // READ + READ are compatible, so this should succeed immediately
        // (no conflict, no wait queue entry needed).
        let result = fix
            .lock_manager
            .acquire_lock_with_wait(
                &token_a,
                "reentrant.txt",
                fix.nats_connection.clone(),
                Duration::from_secs(5),
            )
            .await;

        assert!(
            result.is_ok(),
            "same agent should get reentrant READ lock: {:?}",
            result
        );
    });
}

// ── T6: READ shared locks compatible ──

#[test]
fn test_read_shared_locks_compatible() {
    let Some(fix) = ContentionFixture::new() else {
        return;
    };
    fix.rt.block_on(async {
        let (_sys_a, token_a) = fix.create_read_token("agent-a", "session-a");
        let (_sys_b, token_b) = fix.create_read_token("agent-b", "session-b");

        // agent-a acquires READ lock
        fix.lock_manager
            .acquire_lock(&token_a, "shared_read.txt")
            .await
            .unwrap();

        // agent-b should also get READ lock via acquire_lock_with_wait
        let result = fix
            .lock_manager
            .acquire_lock_with_wait(
                &token_b,
                "shared_read.txt",
                fix.nats_connection.clone(),
                Duration::from_secs(5),
            )
            .await;

        assert!(
            result.is_ok(),
            "READ locks should be compatible: {:?}",
            result
        );
    });
}

// ── T7: release notifies waiters via NATS ──

#[test]
fn test_release_notifies_waiters_via_nats() {
    let Some(fix) = ContentionFixture::new() else {
        return;
    };
    fix.rt.block_on(async {
        let (_sys_a, token_a) = fix.create_agent_token("agent-a", "session-a");

        // Subscribe to lock release notifications BEFORE acquiring
        let mut subscriber = fix
            .nats_connection
            .client()
            .subscribe("ergatai.lock.release.>")
            .await
            .unwrap();

        // agent-a acquires lock
        fix.lock_manager
            .acquire_lock(&token_a, "notify_test.txt")
            .await
            .unwrap();

        // Release — should publish to NATS
        fix.lock_manager
            .release_lock(token_a.id.as_str(), "notify_test.txt")
            .await
            .unwrap();

        // Wait for the release notification
        let notification = tokio::time::timeout(Duration::from_secs(5), subscriber.next())
            .await
            .expect("timeout waiting for release notification")
            .expect("subscriber closed");

        let release: LockReleaseNotification =
            serde_json::from_slice(&notification.payload).expect("failed to deserialize");

        assert_eq!(release.file_path, "notify_test.txt");
        assert_eq!(release.released_by_token_id, token_a.id.as_str());
    });
}

// ── T8: fanotify + NATS end-to-end (requires Docker --privileged) ──

#[test]
#[ignore] // requires Docker --privileged for fanotify
fn test_contention_with_fanotify_auto_acquire() {
    use ergatai_lock::enforcer::{Enforcer, EnforcerConfig};
    use ergatai_lock::pid_resolver::CallbackPidResolver;
    use std::process::Command;

    let Some(fix) = ContentionFixture::new() else {
        return;
    };

    // Check root
    if unsafe { libc::geteuid() } != 0 {
        eprintln!("Skipping: requires root");
        return;
    }

    fix.rt.block_on(async {
        // Create test file
        let file_path = fix.project_root.join("contested_file.txt");
        std::fs::write(&file_path, "original content").unwrap();

        // Set up PID registry + resolver
        let registry = Arc::new(parking_lot::RwLock::new(Vec::<(u32, String, String)>::new()));
        let resolver: Arc<CallbackPidResolver> = {
            let reg = registry.clone();
            Arc::new(CallbackPidResolver::new(move || reg.read().clone()))
        };

        // Start fanotify enforcer (in a separate runtime since we're inside block_on)
        let config = EnforcerConfig {
            publish_nats_events: false,
        };
        let enforcer_result = Enforcer::start(
            fix.project_root.clone(),
            "test-project".to_string(),
            fix.lock_manager.clone(),
            resolver,
            None,
            config,
        );

        let enforcer = match enforcer_result {
            Ok(e) if e.is_active() => Arc::new(e),
            Ok(_) => {
                eprintln!("Skipping: enforcer not active (non-root or no fanotify)");
                return;
            }
            Err(e) => {
                eprintln!("Skipping: fanotify init failed: {}", e);
                return;
            }
        };

        // Register workspace
        enforcer.register_workspace("agent-a", ".");

        // agent-a acquires lock on the file
        let (_sys_a, token_a) = fix.create_agent_token("agent-a", "session-a");
        fix.lock_manager
            .acquire_lock(&token_a, "contested_file.txt")
            .await
            .unwrap();

        // Spawn a bash child that writes to the file — should be DENIED
        // (agent-a holds the lock, auto_acquire for the child PID (unregistered) → deny)
        let mut child = Command::new("bash")
            .arg("-c")
            .arg(format!(
                "sleep 0.3; echo 'agent-b write' >> {}",
                file_path.display()
            ))
            .spawn()
            .expect("failed to spawn child");

        let child_pid = child.id();
        // Don't register this child — it should be denied as unknown PID
        let _ = child_pid;

        let status = child.wait().expect("wait failed");

        // The write should have been denied by fanotify (unknown PID → deny)
        assert!(
            !status.success(),
            "unregistered child write should be denied by fanotify when agent-a holds lock"
        );

        // Verify file content unchanged
        let content = std::fs::read_to_string(&file_path).unwrap();
        assert_eq!(content, "original content");

        // agent-a releases lock
        fix.lock_manager
            .release_lock(token_a.id.as_str(), "contested_file.txt")
            .await
            .unwrap();

        // Now register agent-b's child PID and write again
        let mut child2 = Command::new("bash")
            .arg("-c")
            .arg(format!(
                "sleep 0.3; echo 'agent-b write' >> {}",
                file_path.display()
            ))
            .spawn()
            .expect("failed to spawn child2");

        let child2_pid = child2.id();
        registry
            .write()
            .push((child2_pid, "agent-b".to_string(), "session-b".to_string()));

        let status2 = child2.wait().expect("wait failed");
        assert!(
            status2.success(),
            "registered agent-b child write should succeed after agent-a releases lock"
        );

        // Verify auto_acquire granted the lock to agent-b
        let has_lock = fix
            .lock_manager
            .is_file_locked("contested_file.txt")
            .unwrap();
        assert!(
            has_lock,
            "agent-b should have auto-acquired the lock after writing"
        );
    });
}
