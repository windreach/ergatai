//! DateTime parsing utilities shared across crates.

use chrono::{DateTime, Utc};

/// Strategy for handling datetime parsing errors.
pub enum OnErrorStrategy {
    /// Fall back to current time (log as warning).
    Now,
    /// Fall back to UNIX_EPOCH (log as error).
    Epoch,
}

/// Parse RFC3339 datetime string with configurable error handling.
///
/// # Arguments
/// * `s` - RFC3339 datetime string
/// * `strategy` - Fallback strategy on parse error
/// * `context` - Context information for logging (e.g., field name)
///
/// # Returns
/// Parsed `DateTime<Utc>` or fallback value based on strategy.
pub fn parse_rfc3339_datetime(s: &str, strategy: OnErrorStrategy, context: &str) -> DateTime<Utc> {
    match DateTime::parse_from_rfc3339(s) {
        Ok(dt) => dt.with_timezone(&Utc),
        Err(e) => match strategy {
            OnErrorStrategy::Now => {
                tracing::warn!(
                    error = %e,
                    context = context,
                    timestamp = s,
                    "Failed to parse timestamp, using current time"
                );
                Utc::now()
            }
            OnErrorStrategy::Epoch => {
                tracing::error!(
                    error = %e,
                    context = context,
                    timestamp = s,
                    "Invalid datetime, using UNIX_EPOCH (fail-safe: expired)"
                );
                DateTime::UNIX_EPOCH
            }
        },
    }
}
