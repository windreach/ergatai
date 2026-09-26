//! Priority conversion utility.

/// Convert a priority string to a numeric value.
///
/// Returns `Some(3)` for "high", `Some(2)` for "medium", `Some(1)` for "low".
/// Returns `None` if the input is `None`. Unknown values default to `Some(2)` (medium).
pub fn priority_to_number(priority: &Option<String>) -> Option<u8> {
    priority.as_ref().map(|p| match p.to_lowercase().as_str() {
        "high" => 3,
        "medium" => 2,
        "low" => 1,
        _ => 2, // Default to medium
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_priority_none_returns_none() {
        assert_eq!(priority_to_number(&None), None);
    }

    #[test]
    fn test_priority_high() {
        assert_eq!(priority_to_number(&Some("high".to_string())), Some(3));
        assert_eq!(priority_to_number(&Some("HIGH".to_string())), Some(3));
        assert_eq!(priority_to_number(&Some("High".to_string())), Some(3));
    }

    #[test]
    fn test_priority_medium() {
        assert_eq!(priority_to_number(&Some("medium".to_string())), Some(2));
        assert_eq!(priority_to_number(&Some("MEDIUM".to_string())), Some(2));
    }

    #[test]
    fn test_priority_low() {
        assert_eq!(priority_to_number(&Some("low".to_string())), Some(1));
        assert_eq!(priority_to_number(&Some("LOW".to_string())), Some(1));
    }

    #[test]
    fn test_priority_unknown_defaults_to_medium() {
        assert_eq!(priority_to_number(&Some("unknown".to_string())), Some(2));
        assert_eq!(priority_to_number(&Some("".to_string())), Some(2));
        assert_eq!(priority_to_number(&Some("invalid".to_string())), Some(2));
    }
}
