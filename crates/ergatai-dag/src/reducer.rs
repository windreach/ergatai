//! Reducer expression evaluator for DAG merge strategies.
//!
//! Uses the `evalexpr` crate for expression evaluation with `existing` and `new` variables.
//!
//! ## Supported Operations
//! - Arithmetic: `+`, `-`, `*`, `/`, `%`
//! - Comparison: `==`, `!=`, `<`, `>`, `<=`, `>=`
//! - Logical: `&&`, `||`, `!`
//! - Built-in functions: `max()`, `min()`, `abs()`, `ceil()`, `floor()`, `round()`
//!
//! ## Examples
//! ```text
//! existing + new          — add numbers
//! max(existing, new)      — take larger value
//! existing * 0.7 + new * 0.3  — weighted average
//! ```

use serde_json::Value;
use std::fmt;

use evalexpr::{eval_with_context, ContextWithMutableVariables, HashMapContext, Value as EvalexprValue};

/// Error during reducer expression evaluation.
#[derive(Debug, Clone)]
pub struct ReducerError {
    pub message: String,
}

impl fmt::Display for ReducerError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "reducer error: {}", self.message)
    }
}

impl std::error::Error for ReducerError {}

/// Evaluate a reducer expression with `existing` and `new` values.
pub fn evaluate(expr: &str, existing: &Value, new: &Value) -> Result<Value, ReducerError> {
    let mut context = HashMapContext::new();

    // Convert JSON values to evalexpr values and bind them
    let existing_eval = json_to_evalexpr(existing).map_err(|e| ReducerError {
        message: format!(
            "Failed to convert 'existing' value '{}' for expression '{}': {}",
            existing, expr, e
        ),
    })?;
    let new_eval = json_to_evalexpr(new).map_err(|e| ReducerError {
        message: format!(
            "Failed to convert 'new' value '{}' for expression '{}': {}",
            new, expr, e
        ),
    })?;

    context
        .set_value("existing".into(), existing_eval)
        .map_err(|e| ReducerError {
            message: format!("failed to bind 'existing': {e}"),
        })?;
    context
        .set_value("new".into(), new_eval)
        .map_err(|e| ReducerError {
            message: format!("failed to bind 'new': {e}"),
        })?;

    // Evaluate the expression
    let result = eval_with_context(expr, &context).map_err(|e| ReducerError {
        message: format!(
            "Failed to evaluate '{}' (existing: {}, new: {}): {}",
            expr, existing, new, e
        ),
    })?;

    // Convert back to JSON
    evalexpr_to_json(result)
}

/// Convert serde_json::Value to evalexpr::Value
fn json_to_evalexpr(val: &Value) -> Result<EvalexprValue, ReducerError> {
    match val {
        Value::Null => Ok(EvalexprValue::Empty),
        Value::Bool(b) => Ok(EvalexprValue::Boolean(*b)),
        Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                Ok(EvalexprValue::Int(i))
            } else if let Some(f) = n.as_f64() {
                Ok(EvalexprValue::Float(f))
            } else {
                Err(ReducerError {
                    message: "unsupported number type".to_string(),
                })
            }
        }
        Value::String(s) => Ok(EvalexprValue::String(s.clone())),
        Value::Array(_) | Value::Object(_) => Err(ReducerError {
            message: "arrays and objects are not supported in reducer expressions".to_string(),
        }),
    }
}

/// Convert evalexpr::Value to serde_json::Value
fn evalexpr_to_json(val: EvalexprValue) -> Result<Value, ReducerError> {
    match val {
        EvalexprValue::Empty => Ok(Value::Null),
        EvalexprValue::Boolean(b) => Ok(Value::Bool(b)),
        EvalexprValue::Int(i) => Ok(Value::Number(serde_json::Number::from(i))),
        EvalexprValue::Float(f) => {
            // Use epsilon comparison for the fractional part to handle
            // floating-point precision issues (e.g., 3.0000000000000004
            // from arithmetic should still be treated as integer 3).
            const EPSILON: f64 = 1e-9;
            if f.abs().fract() < EPSILON
                && f.is_finite()
                && f >= i64::MIN as f64
                && f <= i64::MAX as f64
            {
                Ok(Value::Number(serde_json::Number::from(f as i64)))
            } else {
                serde_json::Number::from_f64(f)
                    .map(Value::Number)
                    .ok_or_else(|| ReducerError {
                        message: "failed to convert float to JSON number".to_string(),
                    })
            }
        }
        EvalexprValue::String(s) => Ok(Value::String(s)),
        EvalexprValue::Tuple(_) => Err(ReducerError {
            message: "tuples are not supported in reducer results".to_string(),
        }),
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn test_number_addition() {
        let result = evaluate("existing + new", &json!(3), &json!(5)).unwrap();
        assert_eq!(result, json!(8));
    }

    #[test]
    fn test_arithmetic_precedence() {
        let result = evaluate("existing * 2 + new", &json!(3), &json!(4)).unwrap();
        assert_eq!(result, json!(10));
    }

    #[test]
    fn test_parentheses() {
        let result = evaluate("(existing + new) * 2", &json!(3), &json!(4)).unwrap();
        assert_eq!(result, json!(14));
    }

    #[test]
    fn test_max_function() {
        let result = evaluate("max(existing, new)", &json!(10), &json!(5)).unwrap();
        assert_eq!(result, json!(10));
    }

    #[test]
    fn test_min_function() {
        let result = evaluate("min(existing, new)", &json!(10), &json!(5)).unwrap();
        assert_eq!(result, json!(5));
    }

    #[test]
    fn test_weighted_average() {
        // existing * 0.7 + new * 0.3
        let result = evaluate("existing * 0.7 + new * 0.3", &json!(100), &json!(50)).unwrap();
        // 100 * 0.7 + 50 * 0.3 = 70 + 15 = 85
        assert_eq!(result, json!(85));
    }

    #[test]
    fn test_comparison() {
        let result = evaluate("existing > new", &json!(10), &json!(5)).unwrap();
        assert_eq!(result, json!(true));
    }

    #[test]
    fn test_integer_result() {
        let result = evaluate("existing + new", &json!(1), &json!(2)).unwrap();
        assert_eq!(result, json!(3));
        assert!(result.as_i64().is_some());
    }

    #[test]
    fn test_modulo() {
        let result = evaluate("existing % new", &json!(10), &json!(3)).unwrap();
        assert_eq!(result, json!(1));
    }

    #[test]
    fn test_invalid_expression() {
        let result = evaluate("invalid syntax !!!", &json!(1), &json!(2));
        assert!(result.is_err());
    }

    #[test]
    fn test_unknown_variable() {
        let result = evaluate("foo + 1", &json!(1), &json!(2));
        assert!(result.is_err());
    }

    #[test]
    fn test_null_handling() {
        let result = evaluate("existing + new", &json!(null), &json!(5));
        // evalexpr doesn't support null arithmetic
        assert!(result.is_err());
    }
}
