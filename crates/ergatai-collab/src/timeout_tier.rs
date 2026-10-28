//! Three-stage node timeout escalation.
//!
//! A node's timeout budget is split into three tiers:
//!   - Warn      (50%): informational, logged at WARN level.
//!   - Escalate  (80%): logged at ERROR level so operators notice.
//!   - Fail     (100%): node is marked Failed with a `timeout_error`
//!     metadata entry, and `on_node_failed` is invoked.
//!
//! Only the Fail tier mutates node state; the first two are observability signals.
//!
//! NOTE: The three-stage escalation is currently unused by the watchdog (which
//! is being refactored to idle-based detection). The module is kept as a future
//! extension point.
#![allow(dead_code)]

/// Tier of node-timeout escalation.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TimeoutTier {
    /// 50% of node timeout elapsed — informational warning.
    Warn,
    /// 80% of node timeout elapsed — escalated, logged at WARN level.
    Escalate,
    /// 100% of node timeout elapsed — node failed.
    Fail,
}

impl TimeoutTier {
    /// Fraction of total timeout at which this tier fires.
    pub fn fraction(&self) -> f64 {
        match self {
            TimeoutTier::Warn => 0.5,
            TimeoutTier::Escalate => 0.8,
            TimeoutTier::Fail => 1.0,
        }
    }

    /// Compute the three absolute deadlines (warn, escalate, fail) from now.
    pub fn deadline_from_now(
        total_timeout_secs: u64,
    ) -> (std::time::Instant, std::time::Instant, std::time::Instant) {
        let now = std::time::Instant::now();
        let total = std::time::Duration::from_secs(total_timeout_secs);
        (
            now + total.mul_f64(Self::Warn.fraction()),
            now + total.mul_f64(Self::Escalate.fraction()),
            now + total,
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fractions_are_ordered() {
        assert!(TimeoutTier::Warn.fraction() < TimeoutTier::Escalate.fraction());
        assert!(TimeoutTier::Escalate.fraction() < TimeoutTier::Fail.fraction());
    }

    #[test]
    fn deadline_from_now_orders_warn_before_escalate_before_fail() {
        let (warn_at, escalate_at, fail_at) = TimeoutTier::deadline_from_now(10);
        assert!(warn_at < escalate_at);
        assert!(escalate_at < fail_at);
        // Fail deadline should be ~10s in the future.
        let remaining = fail_at.duration_since(std::time::Instant::now());
        assert!(remaining.as_secs() >= 9 && remaining.as_secs() <= 11);
    }

    #[test]
    fn warn_fraction_is_half() {
        assert_eq!(TimeoutTier::Warn.fraction(), 0.5);
    }

    #[test]
    fn escalate_fraction_is_eighty_percent() {
        assert_eq!(TimeoutTier::Escalate.fraction(), 0.8);
    }

    #[test]
    fn fail_fraction_is_full() {
        assert_eq!(TimeoutTier::Fail.fraction(), 1.0);
    }

    #[test]
    fn deadline_from_now_with_zero_timeout() {
        let (warn_at, escalate_at, fail_at) = TimeoutTier::deadline_from_now(0);
        // All deadlines should be essentially now
        let now = std::time::Instant::now();
        assert!(warn_at <= now);
        assert!(escalate_at <= now);
        assert!(fail_at <= now);
    }

    #[test]
    fn deadline_from_now_with_large_timeout() {
        let (warn_at, escalate_at, fail_at) = TimeoutTier::deadline_from_now(1000);
        let now = std::time::Instant::now();

        // Warn should be ~500s in future
        let warn_remaining = warn_at.duration_since(now).as_secs();
        assert!((495..=505).contains(&warn_remaining));

        // Escalate should be ~800s in future
        let escalate_remaining = escalate_at.duration_since(now).as_secs();
        assert!((795..=805).contains(&escalate_remaining));

        // Fail should be ~1000s in future
        let fail_remaining = fail_at.duration_since(now).as_secs();
        assert!((995..=1005).contains(&fail_remaining));
    }

    #[test]
    fn timeout_tier_equality() {
        assert_eq!(TimeoutTier::Warn, TimeoutTier::Warn);
        assert_eq!(TimeoutTier::Escalate, TimeoutTier::Escalate);
        assert_eq!(TimeoutTier::Fail, TimeoutTier::Fail);
        assert_ne!(TimeoutTier::Warn, TimeoutTier::Escalate);
        assert_ne!(TimeoutTier::Escalate, TimeoutTier::Fail);
    }

    #[test]
    fn timeout_tier_clone() {
        let tier = TimeoutTier::Warn;
        let cloned = tier;
        assert_eq!(tier, cloned);
    }

    #[test]
    fn timeout_tier_debug() {
        let debug_str = format!("{:?}", TimeoutTier::Warn);
        assert_eq!(debug_str, "Warn");

        let debug_str = format!("{:?}", TimeoutTier::Escalate);
        assert_eq!(debug_str, "Escalate");

        let debug_str = format!("{:?}", TimeoutTier::Fail);
        assert_eq!(debug_str, "Fail");
    }
}
