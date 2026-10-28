//! Per-agent rate limiter for send_message.
//!
//! Uses a sliding-window counter keyed by runtime agent ID. The window
//! tracks `Instant` timestamps of recent sends; on each call, timestamps
//! older than 60s are evicted and the count is compared against the limit.
//!
//! # Concurrency
//!
//! `try_acquire()` performs check-and-record in a single atomic step under
//! one lock acquisition, closing the TOCTOU race that a split check/record
//! pair would have (two concurrent callers could both pass `check()` before
//! either called `record()`, exceeding the limit).
//!
//! # Memory
//!
//! Agent windows are never explicitly removed when an agent goes offline,
//! so a periodic self-sweep evicts stale entries every `SWEEP_INTERVAL`
//! calls to keep memory bounded.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

const DEFAULT_MESSAGES_PER_MINUTE: u64 = 60;
const WINDOW: Duration = Duration::from_secs(60);
/// Sweep the window map this often (by call count) to drop stale entries.
/// Keeps memory bounded when agents go offline and stop sending.
const SWEEP_INTERVAL: u64 = 100;

struct AgentWindow {
    timestamps: Vec<Instant>,
}

pub struct AgentRateLimiter {
    // std::sync::Mutex is fine here: the lock is held only for the duration
    // of `try_acquire()` (no `.await` inside), and the critical section is
    // O(n) in the window size (≤ limit_per_minute, typically 60).
    windows: Mutex<HashMap<String, AgentWindow>>,
    limit_per_minute: u64,
    /// Call counter used to trigger periodic stale-window sweeps.
    calls_since_sweep: AtomicU64,
}

static RATE_LIMITER: OnceLock<AgentRateLimiter> = OnceLock::new();

pub fn get_rate_limiter() -> &'static AgentRateLimiter {
    RATE_LIMITER.get_or_init(|| AgentRateLimiter {
        windows: Mutex::new(HashMap::new()),
        limit_per_minute: DEFAULT_MESSAGES_PER_MINUTE,
        calls_since_sweep: AtomicU64::new(0),
    })
}

#[derive(Debug)]
pub struct RateLimitError {
    pub agent_id: String,
    pub used: u64,
    pub limit: u64,
}

impl std::fmt::Display for RateLimitError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "rate limit exceeded for agent {}: {}/{} per minute",
            self.agent_id, self.used, self.limit
        )
    }
}

impl std::error::Error for RateLimitError {}

impl AgentRateLimiter {
    /// Atomically check the rate limit and reserve a slot if under the limit.
    ///
    /// Returns `Ok(())` and records the send if the agent is under the limit,
    /// or `Err` with the current count and the limit otherwise. Because check
    /// and record happen under a single lock acquisition, this is safe to call
    /// from concurrent tasks without risking limit overshoot.
    ///
    /// This is sync rather than async: the critical section contains no `.await`,
    /// so there is no reason to pay for `tokio::sync::Mutex`. Calling a short
    /// sync critical section from an async context is fine.
    pub fn try_acquire(&self, agent_id: &str) -> Result<(), RateLimitError> {
        let mut windows = self.windows.lock().unwrap_or_else(|e| e.into_inner());

        // Periodic sweep: evict windows with no fresh timestamps so offline
        // agents don't leak memory indefinitely. We do this inline (under the
        // same lock) rather than on a background task to keep the limiter
        // self-contained. Cost is O(num_agents) and runs every SWEEP_INTERVAL
        // calls, so amortized overhead is negligible.
        if self.calls_since_sweep.fetch_add(1, Ordering::Relaxed) % SWEEP_INTERVAL
            == SWEEP_INTERVAL - 1
        {
            let now = Instant::now();
            windows.retain(|_, w| {
                w.timestamps.retain(|t| now.duration_since(*t) < WINDOW);
                !w.timestamps.is_empty()
            });
        }

        let window = windows
            .entry(agent_id.to_string())
            .or_insert_with(|| AgentWindow {
                timestamps: Vec::new(),
            });
        let now = Instant::now();
        window
            .timestamps
            .retain(|t| now.duration_since(*t) < WINDOW);

        if window.timestamps.len() as u64 >= self.limit_per_minute {
            Err(RateLimitError {
                agent_id: agent_id.to_string(),
                used: window.timestamps.len() as u64,
                limit: self.limit_per_minute,
            })
        } else {
            window.timestamps.push(now);
            Ok(())
        }
    }

    /// Explicitly remove an agent's rate-limit window.
    ///
    /// Useful when an agent is pruned from the runtime registry (e.g. after
    /// consecutive unhealthy samples) — call this to drop its entry eagerly
    /// rather than waiting for the periodic sweep.
    pub fn remove_agent(&self, agent_id: &str) {
        self.windows
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(agent_id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rate_limiter_allows_under_limit() {
        let rl = AgentRateLimiter {
            windows: Mutex::new(HashMap::new()),
            limit_per_minute: 3,
            calls_since_sweep: AtomicU64::new(0),
        };
        for _ in 0..3 {
            rl.try_acquire("a").unwrap();
        }
        assert!(rl.try_acquire("a").is_err());
    }

    #[test]
    fn rate_limiter_is_per_agent() {
        let rl = AgentRateLimiter {
            windows: Mutex::new(HashMap::new()),
            limit_per_minute: 1,
            calls_since_sweep: AtomicU64::new(0),
        };
        rl.try_acquire("a").unwrap();
        assert!(rl.try_acquire("a").is_err());
        rl.try_acquire("b").unwrap(); // different agent, unaffected
    }

    #[test]
    fn remove_agent_clears_window() {
        let rl = AgentRateLimiter {
            windows: Mutex::new(HashMap::new()),
            limit_per_minute: 1,
            calls_since_sweep: AtomicU64::new(0),
        };
        rl.try_acquire("a").unwrap();
        assert!(rl.try_acquire("a").is_err());
        rl.remove_agent("a");
        // After removal, the agent should be able to send again.
        rl.try_acquire("a").unwrap();
    }

    #[test]
    fn try_acquire_is_atomic_under_contention() {
        // Regression test: concurrent callers must not both pass the limit.
        use std::sync::Arc;
        use std::thread;

        let rl = Arc::new(AgentRateLimiter {
            windows: Mutex::new(HashMap::new()),
            limit_per_minute: 1,
            calls_since_sweep: AtomicU64::new(0),
        });

        let handles: Vec<_> = (0..8)
            .map(|_| {
                let rl = Arc::clone(&rl);
                thread::spawn(move || rl.try_acquire("a"))
            })
            .collect();

        let outcomes: Vec<_> = handles.into_iter().map(|h| h.join().unwrap()).collect();
        let ok_count = outcomes.iter().filter(|r| r.is_ok()).count();
        // Exactly one thread should have won the slot.
        assert_eq!(
            ok_count, 1,
            "expected exactly 1 successful try_acquire under contention, got {ok_count}"
        );
    }

    #[test]
    fn rate_limit_error_display() {
        let err = RateLimitError {
            agent_id: "agent-123".to_string(),
            used: 60,
            limit: 60,
        };
        let msg = format!("{}", err);
        assert!(msg.contains("agent-123"));
        assert!(msg.contains("60/60"));
        assert!(msg.contains("per minute"));
    }

    #[test]
    fn sliding_window_expires_old_timestamps() {
        let rl = AgentRateLimiter {
            windows: Mutex::new(HashMap::new()),
            limit_per_minute: 2,
            calls_since_sweep: AtomicU64::new(0),
        };

        // Fill the window
        rl.try_acquire("a").unwrap();
        rl.try_acquire("a").unwrap();
        assert!(rl.try_acquire("a").is_err());

        // Manually age the timestamps to simulate time passing
        {
            let mut windows = rl.windows.lock().unwrap();
            if let Some(window) = windows.get_mut("a") {
                // Age all timestamps by 61 seconds (beyond the 60s window)
                for ts in window.timestamps.iter_mut() {
                    *ts = Instant::now() - Duration::from_secs(61);
                }
            }
        }

        // Now should be able to acquire again since old timestamps expired
        rl.try_acquire("a").unwrap();
    }

    #[test]
    fn sweep_removes_stale_agents() {
        let rl = AgentRateLimiter {
            windows: Mutex::new(HashMap::new()),
            limit_per_minute: 60,
            calls_since_sweep: AtomicU64::new(0),
        };

        // Add some agents with old timestamps
        for i in 0..5 {
            let agent_id = format!("agent-{}", i);
            rl.try_acquire(&agent_id).unwrap();

            // Age the timestamps
            let mut windows = rl.windows.lock().unwrap();
            if let Some(window) = windows.get_mut(&agent_id) {
                for ts in window.timestamps.iter_mut() {
                    *ts = Instant::now() - Duration::from_secs(120);
                }
            }
        }

        // Verify we have 5 agents
        {
            let windows = rl.windows.lock().unwrap();
            assert_eq!(windows.len(), 5);
        }

        // Trigger sweep by making SWEEP_INTERVAL calls
        for _ in 0..SWEEP_INTERVAL {
            let _ = rl.try_acquire("sweep-trigger");
        }

        // After sweep, stale agents should be removed
        let windows = rl.windows.lock().unwrap();
        // Only "sweep-trigger" should remain (others are stale)
        assert_eq!(windows.len(), 1);
        assert!(windows.contains_key("sweep-trigger"));
    }

    #[test]
    fn remove_nonexistent_agent_is_safe() {
        let rl = AgentRateLimiter {
            windows: Mutex::new(HashMap::new()),
            limit_per_minute: 60,
            calls_since_sweep: AtomicU64::new(0),
        };

        // Removing a non-existent agent should not panic
        rl.remove_agent("nonexistent");
    }

    #[test]
    fn concurrent_different_agents_no_contention() {
        use std::sync::Arc;
        use std::thread;

        let rl = Arc::new(AgentRateLimiter {
            windows: Mutex::new(HashMap::new()),
            limit_per_minute: 10,
            calls_since_sweep: AtomicU64::new(0),
        });

        // 10 different agents each making 5 requests
        let handles: Vec<_> = (0..10)
            .flat_map(|agent_idx| {
                let rl_clone = Arc::clone(&rl);
                (0..5).map(move |_| {
                    let rl = Arc::clone(&rl_clone);
                    let agent_id = format!("agent-{}", agent_idx);
                    thread::spawn(move || rl.try_acquire(&agent_id))
                })
            })
            .collect();

        let outcomes: Vec<_> = handles.into_iter().map(|h| h.join().unwrap()).collect();
        let ok_count = outcomes.iter().filter(|r| r.is_ok()).count();

        // All 50 requests should succeed (10 agents * 5 requests, limit is 10 per agent)
        assert_eq!(ok_count, 50);
    }

    #[test]
    fn error_contains_correct_counts() {
        let rl = AgentRateLimiter {
            windows: Mutex::new(HashMap::new()),
            limit_per_minute: 3,
            calls_since_sweep: AtomicU64::new(0),
        };

        // Use up the limit
        for _ in 0..3 {
            rl.try_acquire("test-agent").unwrap();
        }

        // Next attempt should fail with correct counts
        let err = rl.try_acquire("test-agent").unwrap_err();
        assert_eq!(err.agent_id, "test-agent");
        assert_eq!(err.used, 3);
        assert_eq!(err.limit, 3);
    }
}
