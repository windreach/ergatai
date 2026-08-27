//! DAG execution context — tracks global variables and per-node outputs
//!
//! DagContext is the data store that powers the template engine.  When a DAG
//! starts, global variables are populated (e.g. `user_query`, `project_root`).
//! As nodes complete, their outputs are recorded.  Before a downstream node is
//! submitted, the scheduler calls `render_template()` on its input / task
//! description, and all `{{var}}` references are resolved from the context.

use std::collections::HashMap;
use std::path::Path;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tracing::debug;

use crate::state_channel::{MergeStrategy, StateChannel};
use crate::template::render_template;
use ergatai_error::ErgataiResult;

/// DAG execution context
///
/// Stores global variables (set once before DAG starts), DAG parameters,
/// and per-node outputs (recorded as each node completes).
/// Used to resolve `{{var}}` templates in downstream node inputs.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DagContext {
    /// Global variables available as `{{global.key}}`
    pub global_vars: HashMap<String, String>,

    /// DAG parameters available as `{{param.key}}`
    #[serde(default)]
    pub parameters: HashMap<String, Value>,

    /// Per-node outputs: `node_id → JSON value`
    /// Available as `{{node_id.key}}` (flattened for template rendering)
    #[serde(default)]
    node_outputs: HashMap<String, Value>,
}

impl DagContext {
    /// Create a new context with the given global variables
    pub fn new(global_vars: HashMap<String, String>) -> Self {
        Self {
            global_vars,
            parameters: HashMap::new(),
            node_outputs: HashMap::new(),
        }
    }

    /// Create a new context with global variables and parameters
    pub fn with_parameters(
        global_vars: HashMap<String, String>,
        parameters: HashMap<String, Value>,
    ) -> Self {
        Self {
            global_vars,
            parameters,
            node_outputs: HashMap::new(),
        }
    }

    /// Create an empty context (no globals, no parameters, no outputs)
    pub fn empty() -> Self {
        Self::new(HashMap::new())
    }

    // ── Global variables ──

    /// Set a global variable
    pub fn set_global(&mut self, key: impl Into<String>, value: impl Into<String>) {
        self.global_vars.insert(key.into(), value.into());
    }

    /// Get a global variable
    pub fn get_global(&self, key: &str) -> Option<&str> {
        self.global_vars.get(key).map(|s| s.as_str())
    }

    // ── Node outputs ──

    /// Record outputs from a completed node as a JSON value
    ///
    /// The value can be an object, array, or primitive. For template rendering,
    /// object keys are flattened as `{{node_id.key}}`.
    pub fn record_output(&mut self, node_id: impl Into<String>, outputs: Value) {
        let id = node_id.into();
        debug!(node_id = id, "Recording node outputs as JSON");
        self.node_outputs.insert(id, outputs);
    }

    /// Record outputs with schema validation
    ///
    /// Validates that the outputs conform to the StateChannel schema before recording.
    /// Returns an error if validation fails (missing required fields or type mismatches).
    ///
    /// # Example
    ///
    /// ```ignore
    /// let channel = StateChannel { /* ... */ };
    /// ctx.record_output_validated("node-1", outputs, &channel)?;
    /// ```
    pub fn record_output_validated(
        &mut self,
        node_id: impl Into<String>,
        outputs: Value,
        channel: &StateChannel,
    ) -> Result<(), Vec<String>> {
        channel.validate_outputs(&outputs)?;
        self.record_output(node_id, outputs);
        Ok(())
    }

    /// Merge outputs according to the specified strategy
    ///
    /// For `Overwrite`: replaces existing outputs (same as `record_output`).
    /// For `Append`: appends new values to existing array outputs.
    /// For `Max`/`Min`: takes the maximum/minimum numeric value.
    /// For `Reducer`: evaluates a custom merge expression (not yet implemented).
    pub fn merge_output(
        &mut self,
        node_id: impl Into<String>,
        outputs: Value,
        strategy: &MergeStrategy,
    ) {
        let id = node_id.into();

        match strategy {
            MergeStrategy::Overwrite => {
                debug!(node_id = %id, "Merging outputs (overwrite)");
                self.node_outputs.insert(id, outputs);
            }
            MergeStrategy::Append => {
                debug!(node_id = %id, "Merging outputs (append)");
                if let Some(existing) = self.node_outputs.get(&id) {
                    // If existing is an array, append new values
                    if let Value::Array(mut existing_arr) = existing.clone() {
                        if let Value::Array(new_arr) = outputs {
                            existing_arr.extend(new_arr);
                            self.node_outputs.insert(id, Value::Array(existing_arr));
                        } else {
                            // New value is not an array, just append it
                            existing_arr.push(outputs);
                            self.node_outputs.insert(id, Value::Array(existing_arr));
                        }
                    } else {
                        // Existing is not an array, convert to array and append
                        let mut new_arr = vec![existing.clone()];
                        if let Value::Array(arr) = outputs {
                            new_arr.extend(arr);
                        } else {
                            new_arr.push(outputs);
                        }
                        self.node_outputs.insert(id, Value::Array(new_arr));
                    }
                } else {
                    // No existing value, just record as array
                    let arr = if let Value::Array(a) = outputs {
                        a
                    } else {
                        vec![outputs]
                    };
                    self.node_outputs.insert(id, Value::Array(arr));
                }
            }
            MergeStrategy::Max => {
                debug!(node_id = %id, "Merging outputs (max)");
                if let Some(existing) = self.node_outputs.get(&id) {
                    if let (Some(existing_num), Some(new_num)) =
                        (existing.as_f64(), outputs.as_f64())
                    {
                        if new_num > existing_num {
                            self.node_outputs.insert(id, outputs);
                        }
                        // else keep existing
                    } else {
                        // Can't compare, overwrite
                        self.node_outputs.insert(id, outputs);
                    }
                } else {
                    self.node_outputs.insert(id, outputs);
                }
            }
            MergeStrategy::Min => {
                debug!(node_id = %id, "Merging outputs (min)");
                if let Some(existing) = self.node_outputs.get(&id) {
                    if let (Some(existing_num), Some(new_num)) =
                        (existing.as_f64(), outputs.as_f64())
                    {
                        if new_num < existing_num {
                            self.node_outputs.insert(id, outputs);
                        }
                        // else keep existing
                    } else {
                        // Can't compare, overwrite
                        self.node_outputs.insert(id, outputs);
                    }
                } else {
                    self.node_outputs.insert(id, outputs);
                }
            }
            MergeStrategy::Reducer { expr: _ } => {
                // TODO: Implement custom reducer expressions
                // For now, fall back to overwrite
                debug!(node_id = %id, "Merging outputs (reducer - not implemented, falling back to overwrite)");
                self.node_outputs.insert(id, outputs);
            }
        }
    }

    /// Get the outputs of a specific node as a JSON value
    pub fn get_node_outputs(&self, node_id: &str) -> Option<&Value> {
        self.node_outputs.get(node_id)
    }

    /// Check if outputs have been recorded for a node
    pub fn has_node_outputs(&self, node_id: &str) -> bool {
        self.node_outputs.contains_key(node_id)
    }

    // ── Template rendering ──

    /// Render a template string by resolving `{{var}}` references
    ///
    /// Builds a flat lookup map from both global vars and node outputs:
    /// - `global.user_query` → value from `self.global_vars["user_query"]`
    /// - `node_id.key`       → value from `self.node_outputs["node_id"]["key"]`
    ///
    /// Unknown references are preserved as-is (e.g. `{{missing}}` stays).
    pub fn render_template(&self, template: &str) -> String {
        let context = self.build_context_map();
        render_template(template, &context)
    }

    /// Build a flat `key → value` map from all sources
    ///
    /// Flattens JSON values from node_outputs and parameters into strings for template rendering.
    /// Objects are flattened as `node_id.key`, arrays and primitives are serialized to JSON strings.
    fn build_context_map(&self) -> HashMap<String, String> {
        let mut map = HashMap::with_capacity(
            self.global_vars.len() + self.parameters.len() + self.node_outputs.len() * 2, // rough estimate
        );

        // Global variables → `global.{key}`
        for (k, v) in &self.global_vars {
            map.insert(format!("global.{}", k), v.clone());
        }

        // DAG parameters → `param.{key}`
        for (k, v) in &self.parameters {
            Self::flatten_json_value(&mut map, &format!("param.{}", k), v);
        }

        // Node outputs → `{node_id}.{key}` (flattened from JSON)
        for (node_id, value) in &self.node_outputs {
            Self::flatten_json_value(&mut map, node_id, value);
        }

        map
    }

    /// Recursively flatten a JSON value into key-value pairs for template rendering
    fn flatten_json_value(map: &mut HashMap<String, String>, prefix: &str, value: &Value) {
        match value {
            Value::Object(obj) => {
                for (k, v) in obj {
                    let key = if prefix.is_empty() {
                        k.clone()
                    } else {
                        format!("{}.{}", prefix, k)
                    };
                    Self::flatten_json_value(map, &key, v);
                }
            }
            Value::Array(arr) => {
                // Serialize arrays as JSON strings
                map.insert(
                    prefix.to_string(),
                    serde_json::to_string(arr).unwrap_or_default(),
                );
            }
            Value::String(s) => {
                map.insert(prefix.to_string(), s.clone());
            }
            Value::Number(n) => {
                map.insert(prefix.to_string(), n.to_string());
            }
            Value::Bool(b) => {
                map.insert(prefix.to_string(), b.to_string());
            }
            Value::Null => {
                map.insert(prefix.to_string(), "null".to_string());
            }
        }
    }

    // ── Persistence ──

    /// Save context to a JSON file
    pub async fn save_to_file(&self, path: &Path) -> ErgataiResult<()> {
        let json = serde_json::to_string_pretty(self)?;
        tokio::fs::write(path, json).await?;
        Ok(())
    }

    /// Load context from a JSON file
    pub async fn load_from_file(path: &Path) -> ErgataiResult<Self> {
        let content = tokio::fs::read_to_string(path).await?;
        let ctx: Self = serde_json::from_str(&content)?;
        Ok(ctx)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn globals(pairs: &[(&str, &str)]) -> HashMap<String, String> {
        pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect()
    }

    /// Helper to create a JSON object Value from key-value pairs
    fn json_obj(pairs: &[(&str, &str)]) -> Value {
        let mut map = serde_json::Map::new();
        for (k, v) in pairs {
            map.insert(k.to_string(), Value::String(v.to_string()));
        }
        Value::Object(map)
    }

    // ── Global variables ──

    #[test]
    fn test_set_and_get_global() {
        let mut ctx = DagContext::empty();
        ctx.set_global("user_query", "fix the bug");
        assert_eq!(ctx.get_global("user_query"), Some("fix the bug"));
        assert_eq!(ctx.get_global("missing"), None);
    }

    #[test]
    fn test_new_with_globals() {
        let ctx = DagContext::new(globals(&[("project", "ergatai"), ("branch", "main")]));
        assert_eq!(ctx.get_global("project"), Some("ergatai"));
        assert_eq!(ctx.get_global("branch"), Some("main"));
    }

    // ── Node outputs ──

    #[test]
    fn test_record_and_get_outputs() {
        let mut ctx = DagContext::empty();

        let outputs = json_obj(&[("result", "LGTM"), ("issues", "3")]);
        ctx.record_output("node-a", outputs);

        let got = ctx.get_node_outputs("node-a").unwrap();
        if let Value::Object(obj) = got {
            assert_eq!(obj.get("result"), Some(&Value::String("LGTM".to_string())));
            assert_eq!(obj.get("issues"), Some(&Value::String("3".to_string())));
        } else {
            panic!("Expected Object");
        }
        assert!(ctx.has_node_outputs("node-a"));
        assert!(!ctx.has_node_outputs("node-b"));
    }

    // ── Template rendering ──

    #[test]
    fn test_render_global() {
        let ctx = DagContext::new(globals(&[("user_query", "fix bug")]));
        assert_eq!(
            ctx.render_template("Task: {{global.user_query}}"),
            "Task: fix bug"
        );
    }

    #[test]
    fn test_render_node_output() {
        let mut ctx = DagContext::empty();
        ctx.record_output("TaskA", json_obj(&[("review", "approved")]));

        assert_eq!(
            ctx.render_template("Result: {{TaskA.review}}"),
            "Result: approved"
        );
    }

    #[test]
    fn test_render_mixed() {
        let mut ctx = DagContext::new(globals(&[("project", "ergatai")]));
        ctx.record_output("n1", json_obj(&[("summary", "all tests pass")]));

        assert_eq!(
            ctx.render_template(
                "Project {{global.project}}: {{n1.summary}}, status: {{unknown.key}}"
            ),
            "Project ergatai: all tests pass, status: {{unknown.key}}"
        );
    }

    #[test]
    fn test_render_no_references() {
        let ctx = DagContext::empty();
        assert_eq!(ctx.render_template("plain text"), "plain text");
    }

    // ── Serialization roundtrip ──

    #[test]
    fn test_serde_roundtrip() {
        let mut ctx = DagContext::new(globals(&[("q", "hello")]));
        ctx.record_output("n1", json_obj(&[("k", "v")]));

        let json = serde_json::to_string(&ctx).unwrap();
        let restored: DagContext = serde_json::from_str(&json).unwrap();

        assert_eq!(restored.get_global("q"), Some("hello"));
        if let Some(Value::Object(obj)) = restored.get_node_outputs("n1") {
            assert_eq!(obj.get("k"), Some(&Value::String("v".to_string())));
        } else {
            panic!("Expected Object");
        }
    }

    // ── Additional tests ──

    #[test]
    fn test_overwrite_global() {
        let mut ctx = DagContext::empty();
        ctx.set_global("key", "value1");
        assert_eq!(ctx.get_global("key"), Some("value1"));
        ctx.set_global("key", "value2");
        assert_eq!(ctx.get_global("key"), Some("value2"));
    }

    #[test]
    fn test_empty_context() {
        let ctx = DagContext::empty();
        assert!(ctx.global_vars.is_empty());
        assert!(ctx.node_outputs.is_empty());
        assert_eq!(ctx.render_template("{{unknown}}"), "{{unknown}}");
    }

    #[test]
    fn test_record_output_overwrites() {
        let mut ctx = DagContext::empty();
        ctx.record_output("node", json_obj(&[("k", "v1")]));
        ctx.record_output("node", json_obj(&[("k", "v2")]));

        let got = ctx.get_node_outputs("node").unwrap();
        if let Value::Object(obj) = got {
            assert_eq!(obj.get("k"), Some(&Value::String("v2".to_string())));
        } else {
            panic!("Expected Object");
        }
    }

    #[test]
    fn test_nested_key_patterns_in_template() {
        let mut ctx = DagContext::empty();
        ctx.set_global("project.name", "ergatai");
        ctx.record_output("node.1", json_obj(&[("result.status", "ok")]));

        // Global with dot in key name
        assert_eq!(ctx.get_global("project.name"), Some("ergatai"));
    }

    #[test]
    fn test_context_clone() {
        let mut ctx = DagContext::new(globals(&[("q", "original")]));
        ctx.record_output("n1", json_obj(&[("k", "v")]));

        let cloned = ctx.clone();
        assert_eq!(cloned.get_global("q"), Some("original"));
        if let Some(Value::Object(obj)) = cloned.get_node_outputs("n1") {
            assert_eq!(obj.get("k"), Some(&Value::String("v".to_string())));
        } else {
            panic!("Expected Object");
        }
    }

    #[test]
    fn test_render_template_with_empty_global_vars() {
        let ctx = DagContext::empty();
        assert_eq!(
            ctx.render_template("{{global.missing}}"),
            "{{global.missing}}"
        );
    }

    #[test]
    fn test_has_node_outputs_false_when_missing() {
        let ctx = DagContext::empty();
        assert!(!ctx.has_node_outputs("nonexistent"));
    }

    #[test]
    fn test_render_template_multiple_node_outputs() {
        let mut ctx = DagContext::empty();
        ctx.record_output("TaskA", json_obj(&[("result", "A done")]));
        ctx.record_output("TaskB", json_obj(&[("result", "B done")]));

        let rendered = ctx.render_template("{{TaskA.result}} then {{TaskB.result}}");
        assert_eq!(rendered, "A done then B done");
    }

    #[test]
    fn test_build_context_map_keys() {
        let mut ctx = DagContext::new(globals(&[("q", "query")]));
        ctx.record_output("n1", json_obj(&[("k", "v")]));

        let map = ctx.build_context_map();
        assert_eq!(map.get("global.q"), Some(&"query".to_string()));
        assert_eq!(map.get("n1.k"), Some(&"v".to_string()));
    }

    #[test]
    fn test_record_output_empty_outputs() {
        let mut ctx = DagContext::empty();
        ctx.record_output("node", json_obj(&[]));
        assert!(ctx.has_node_outputs("node"));
        let got = ctx.get_node_outputs("node").unwrap();
        if let Value::Object(obj) = got {
            assert!(obj.is_empty());
        } else {
            panic!("Expected Object");
        }
    }

    #[test]
    fn test_multiple_globals_in_render() {
        let ctx = DagContext::new(globals(&[("a", "alpha"), ("b", "beta"), ("c", "gamma")]));
        let rendered = ctx.render_template("{{global.a}} {{global.b}} {{global.c}}");
        assert_eq!(rendered, "alpha beta gamma");
    }

    #[test]
    fn test_get_node_outputs_returns_none_when_missing() {
        let ctx = DagContext::empty();
        assert!(ctx.get_node_outputs("nonexistent").is_none());
    }

    #[test]
    fn test_render_template_preserves_literal_text() {
        let ctx = DagContext::new(globals(&[("x", "value")]));
        let rendered = ctx.render_template("before {{global.x}} after");
        assert_eq!(rendered, "before value after");
    }

    // ── State Channel validation tests ──

    #[test]
    fn test_record_output_validated_success() {
        use crate::state_channel::{StateField, StateValueType};

        let mut ctx = DagContext::empty();
        let channel = StateChannel {
            name: "test_channel".to_string(),
            inputs: vec![],
            outputs: vec![StateField {
                name: "result".to_string(),
                value_type: StateValueType::String,
                required: true,
                default: None,
                description: None,
            }],
            merge_strategies: std::collections::HashMap::new(),
        };

        let outputs = serde_json::json!({"result": "success"});
        assert!(ctx.record_output_validated("node-1", outputs, &channel).is_ok());
        assert!(ctx.has_node_outputs("node-1"));
    }

    #[test]
    fn test_record_output_validated_missing_required() {
        use crate::state_channel::{StateField, StateValueType};

        let mut ctx = DagContext::empty();
        let channel = StateChannel {
            name: "test_channel".to_string(),
            inputs: vec![],
            outputs: vec![StateField {
                name: "result".to_string(),
                value_type: StateValueType::String,
                required: true,
                default: None,
                description: None,
            }],
            merge_strategies: std::collections::HashMap::new(),
        };

        let outputs = serde_json::json!({});
        let errors = ctx.record_output_validated("node-1", outputs, &channel).unwrap_err();
        assert_eq!(errors.len(), 1);
        assert!(errors[0].contains("missing required field"));
    }

    #[test]
    fn test_merge_output_overwrite() {
        let mut ctx = DagContext::empty();
        ctx.record_output("node", serde_json::json!({"value": 1}));
        ctx.merge_output("node", serde_json::json!({"value": 2}), &MergeStrategy::Overwrite);

        let got = ctx.get_node_outputs("node").unwrap();
        assert_eq!(got.get("value"), Some(&serde_json::json!(2)));
    }

    #[test]
    fn test_merge_output_append() {
        let mut ctx = DagContext::empty();
        ctx.record_output("node", serde_json::json!([1, 2]));
        ctx.merge_output("node", serde_json::json!([3, 4]), &MergeStrategy::Append);

        let got = ctx.get_node_outputs("node").unwrap();
        assert_eq!(got, &serde_json::json!([1, 2, 3, 4]));
    }

    #[test]
    fn test_merge_output_max() {
        let mut ctx = DagContext::empty();
        ctx.record_output("node", serde_json::json!(10));
        ctx.merge_output("node", serde_json::json!(20), &MergeStrategy::Max);

        let got = ctx.get_node_outputs("node").unwrap();
        assert_eq!(got, &serde_json::json!(20));

        // Try smaller value
        ctx.merge_output("node", serde_json::json!(5), &MergeStrategy::Max);
        let got = ctx.get_node_outputs("node").unwrap();
        assert_eq!(got, &serde_json::json!(20)); // Should still be 20
    }

    #[test]
    fn test_merge_output_min() {
        let mut ctx = DagContext::empty();
        ctx.record_output("node", serde_json::json!(10));
        ctx.merge_output("node", serde_json::json!(5), &MergeStrategy::Min);

        let got = ctx.get_node_outputs("node").unwrap();
        assert_eq!(got, &serde_json::json!(5));

        // Try larger value
        ctx.merge_output("node", serde_json::json!(20), &MergeStrategy::Min);
        let got = ctx.get_node_outputs("node").unwrap();
        assert_eq!(got, &serde_json::json!(5)); // Should still be 5
    }
}
