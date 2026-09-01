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
