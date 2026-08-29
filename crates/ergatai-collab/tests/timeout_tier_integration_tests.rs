//! Integration tests for the three-stage timeout escalation system.
//!
//! These tests cover TimeoutTier (Warn → Escalate → Fail) used by DagScheduler.
//! The complexity-based timeout scaling has been removed — node timeouts are now
//! used directly (per-node override → DAG default → DEFAULT_NODE_TIMEOUT_SECS).

use ergatai_collab::timeout_tier::TimeoutTier;

// ── TimeoutTier fraction values ──────────────────────────────────────

#[test]
fn warn_fraction_is_half() {
    assert!((TimeoutTier::Warn.fraction() - 0.5).abs() < f64::EPSILON);
}

#[test]
fn escalate_fraction_is_eighty_percent() {
    assert!((TimeoutTier::Escalate.fraction() - 0.8).abs() < f64::EPSILON);
}

#[test]
fn fail_fraction_is_one() {
    assert!((TimeoutTier::Fail.fraction() - 1.0).abs() < f64::EPSILON);
}

// ── deadline_from_now ────────────────────────────────────────────────

#[test]
fn deadline_gaps_match_fractions_for_100s() {
    let (warn_at, escalate_at, fail_at) = TimeoutTier::deadline_from_now(100);
    let now = std::time::Instant::now();

    let warn_gap = warn_at.duration_since(now).as_secs_f64();
    let escalate_gap = escalate_at.duration_since(now).as_secs_f64();
    let fail_gap = fail_at.duration_since(now).as_secs_f64();

    assert!((warn_gap - 50.0).abs() < 1.5, "warn gap was {warn_gap}");
    assert!(
        (escalate_gap - 80.0).abs() < 1.5,
        "escalate gap was {escalate_gap}"
    );
    assert!((fail_gap - 100.0).abs() < 1.5, "fail gap was {fail_gap}");
}

#[test]
fn deadline_from_now_with_1_second_timeout() {
    let (warn_at, escalate_at, fail_at) = TimeoutTier::deadline_from_now(1);
    let now = std::time::Instant::now();

    let warn_gap = warn_at.duration_since(now).as_secs_f64();
    let escalate_gap = escalate_at.duration_since(now).as_secs_f64();
    let fail_gap = fail_at.duration_since(now).as_secs_f64();

    assert!(warn_gap < escalate_gap);
    assert!(escalate_gap < fail_gap);
    assert!(fail_gap < 2.0);
}

#[test]
fn deadline_from_now_with_zero_timeout() {
    let (warn_at, _escalate_at, fail_at) = TimeoutTier::deadline_from_now(0);
    let now = std::time::Instant::now();

    let warn_gap = warn_at.duration_since(now).as_secs_f64();
    let fail_gap = fail_at.duration_since(now).as_secs_f64();

    assert!(warn_gap < 0.1, "zero timeout warn should be immediate");
    assert!(fail_gap < 0.1, "zero timeout fail should be immediate");
}

#[test]
fn deadline_from_now_with_large_timeout() {
    let (warn_at, _escalate_at, fail_at) = TimeoutTier::deadline_from_now(3600);
    let now = std::time::Instant::now();

    let warn_gap = warn_at.duration_since(now).as_secs();
    let fail_gap = fail_at.duration_since(now).as_secs();

    assert!((1798..=1802).contains(&warn_gap));
    assert!((3598..=3602).contains(&fail_gap));
}

#[test]
fn deadlines_are_strictly_ordered_for_any_positive_timeout() {
    for timeout in [1, 5, 10, 60, 300, 3600] {
        let (warn_at, escalate_at, fail_at) = TimeoutTier::deadline_from_now(timeout);
        assert!(warn_at < escalate_at, "timeout={timeout}");
        assert!(escalate_at < fail_at, "timeout={timeout}");
    }
}

// ── Tier determination (simulated watcher logic) ─────────────────────

/// Simulate the timeout watcher's tier selection given elapsed time.
fn tier_at(elapsed_secs: f64, total_timeout_secs: u64) -> TimeoutTier {
    let total = total_timeout_secs as f64;
    if elapsed_secs >= total * TimeoutTier::Fail.fraction() {
        TimeoutTier::Fail
    } else if elapsed_secs >= total * TimeoutTier::Escalate.fraction() {
        TimeoutTier::Escalate
    } else {
        TimeoutTier::Warn
    }
}

#[test]
fn tier_progression_for_100s_timeout() {
    assert_eq!(tier_at(49.9, 100), TimeoutTier::Warn);
    assert_eq!(tier_at(50.0, 100), TimeoutTier::Warn);
    assert_eq!(tier_at(79.9, 100), TimeoutTier::Warn);
    assert_eq!(tier_at(80.0, 100), TimeoutTier::Escalate);
    assert_eq!(tier_at(99.9, 100), TimeoutTier::Escalate);
    assert_eq!(tier_at(100.0, 100), TimeoutTier::Fail);
    assert_eq!(tier_at(200.0, 100), TimeoutTier::Fail);
}

#[test]
fn tier_boundaries_are_exact() {
    assert_eq!(tier_at(50.0, 100), TimeoutTier::Warn);
    assert_eq!(tier_at(80.0, 100), TimeoutTier::Escalate);
    assert_eq!(tier_at(100.0, 100), TimeoutTier::Fail);
}
