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

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Datelike;

    #[test]
    fn test_parse_valid_datetime() {
        let result = parse_rfc3339_datetime("2024-01-15T10:30:00Z", OnErrorStrategy::Now, "test");
        assert_eq!(result.year(), 2024);
        assert_eq!(result.month(), 1);
        assert_eq!(result.day(), 15);
    }

    #[test]
    fn test_parse_invalid_datetime_current_time() {
        let before = Utc::now();
        let result = parse_rfc3339_datetime("invalid-datetime", OnErrorStrategy::Now, "test");
        let after = Utc::now();

        // Should return current time (within a reasonable range)
        assert!(result >= before && result <= after);
    }

    #[test]
    fn test_parse_invalid_datetime_epoch() {
        let result = parse_rfc3339_datetime("invalid-datetime", OnErrorStrategy::Epoch, "test");

        // Should return UNIX_EPOCH
        assert_eq!(result, DateTime::UNIX_EPOCH);
    }

    #[test]
    fn test_parse_datetime_with_timezone() {
        let result =
            parse_rfc3339_datetime("2024-01-15T10:30:00+08:00", OnErrorStrategy::Now, "test");
        assert_eq!(result.year(), 2024);
    }
}
