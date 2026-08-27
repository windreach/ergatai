//! Integration tests for State Channel feature
//!
//! Tests the complete flow: YAML parsing → TaskNode with state_schema → DagContext validation

use ergatai_dag::{parse_dag_yaml, StateChannel, StateField, StateValueType};
use serde_json::json;

#[test]
fn test_yaml_with_state_schema() {
    let yaml = r#"
name: test-dag
tasks:
  - name: review
    agent: reviewer
    task: tasks/review.md
    state_schema:
      name: review_state
      inputs:
        - name: code_path
          value_type: string
          required: true
      outputs:
        - name: review_result
          value_type: string
          required: true
        - name: issue_count
          value_type: number
          required: false
"#;

    let graph = parse_dag_yaml(yaml, None).expect("Failed to parse YAML");
    assert_eq!(graph.nodes.len(), 1);

    let node = &graph.nodes[0];
    // Node ID is a UUID generated from the task name, so just verify state_schema is present
    assert!(node.state_schema.is_some());

    let schema = node.state_schema.as_ref().unwrap();
    assert_eq!(schema.name, "review_state");
    assert_eq!(schema.inputs.len(), 1);
    assert_eq!(schema.outputs.len(), 2);

    // Verify input field
    let input = &schema.inputs[0];
    assert_eq!(input.name, "code_path");
    assert_eq!(input.value_type, StateValueType::String);
    assert!(input.required);

    // Verify output fields
    let output1 = &schema.outputs[0];
    assert_eq!(output1.name, "review_result");
    assert_eq!(output1.value_type, StateValueType::String);
    assert!(output1.required);

    let output2 = &schema.outputs[1];
    assert_eq!(output2.name, "issue_count");
    assert_eq!(output2.value_type, StateValueType::Number);
    assert!(!output2.required);
}

#[test]
fn test_yaml_without_state_schema_backward_compatible() {
    let yaml = r#"
name: test-dag
tasks:
  - name: simple-task
    agent: worker
    task: tasks/task.md
"#;

    let graph = parse_dag_yaml(yaml, None).expect("Failed to parse YAML");
    assert_eq!(graph.nodes.len(), 1);

    let node = &graph.nodes[0];
    assert!(node.state_schema.is_none()); // Should be None for backward compatibility
}

#[test]
fn test_state_channel_validate_outputs_success() {
    let channel = StateChannel {
        name: "test_channel".to_string(),
        inputs: vec![],
        outputs: vec![
            StateField {
                name: "result".to_string(),
                value_type: StateValueType::String,
                required: true,
                default: None,
                description: None,
            },
            StateField {
                name: "count".to_string(),
                value_type: StateValueType::Number,
                required: false,
                default: None,
                description: None,
            },
        ],
        merge_strategies: std::collections::HashMap::new(),
    };

    // Valid outputs
    let valid_outputs = json!({
        "result": "success",
        "count": 42
    });
    assert!(channel.validate_outputs(&valid_outputs).is_ok());

    // Missing optional field is OK
    let valid_outputs_optional_missing = json!({
        "result": "success"
    });
    assert!(channel.validate_outputs(&valid_outputs_optional_missing).is_ok());
}

#[test]
fn test_state_channel_validate_outputs_missing_required() {
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

    // Missing required field
    let invalid_outputs = json!({});
    let errors = channel.validate_outputs(&invalid_outputs).unwrap_err();
    assert_eq!(errors.len(), 1);
    assert!(errors[0].contains("missing required field"));
}

#[test]
fn test_state_channel_validate_outputs_wrong_type() {
    let channel = StateChannel {
        name: "test_channel".to_string(),
        inputs: vec![],
        outputs: vec![StateField {
            name: "count".to_string(),
            value_type: StateValueType::Number,
            required: true,
            default: None,
            description: None,
        }],
        merge_strategies: std::collections::HashMap::new(),
    };

    // Wrong type (string instead of number)
    let invalid_outputs = json!({
        "count": "not a number"
    });
    let errors = channel.validate_outputs(&invalid_outputs).unwrap_err();
    assert_eq!(errors.len(), 1);
    assert!(errors[0].contains("expected type"));
}

#[test]
fn test_dag_context_record_output_validated() {
    use ergatai_dag::DagContext;

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

    // Valid output
    let valid_outputs = json!({"result": "success"});
    assert!(ctx.record_output_validated("node-1", valid_outputs, &channel).is_ok());
    assert!(ctx.has_node_outputs("node-1"));

    // Invalid output (missing required field)
    let invalid_outputs = json!({});
    let errors = ctx.record_output_validated("node-2", invalid_outputs, &channel).unwrap_err();
    assert_eq!(errors.len(), 1);
    assert!(!ctx.has_node_outputs("node-2")); // Should not be recorded
}

#[test]
fn test_dag_context_merge_output_overwrite() {
    use ergatai_dag::{DagContext, MergeStrategy};

    let mut ctx = DagContext::empty();
    ctx.record_output("node", json!({"value": 1}));
    ctx.merge_output("node", json!({"value": 2}), &MergeStrategy::Overwrite);

    let got = ctx.get_node_outputs("node").unwrap();
    assert_eq!(got.get("value"), Some(&json!(2)));
}

#[test]
fn test_dag_context_merge_output_append() {
    use ergatai_dag::{DagContext, MergeStrategy};

    let mut ctx = DagContext::empty();
    ctx.record_output("node", json!([1, 2]));
    ctx.merge_output("node", json!([3, 4]), &MergeStrategy::Append);

    let got = ctx.get_node_outputs("node").unwrap();
    assert_eq!(got, &json!([1, 2, 3, 4]));
}

#[test]
fn test_dag_context_merge_output_max() {
    use ergatai_dag::{DagContext, MergeStrategy};

    let mut ctx = DagContext::empty();
    ctx.record_output("node", json!(10));
    ctx.merge_output("node", json!(20), &MergeStrategy::Max);

    let got = ctx.get_node_outputs("node").unwrap();
    assert_eq!(got, &json!(20));

    // Try smaller value - should keep max
    ctx.merge_output("node", json!(5), &MergeStrategy::Max);
    let got = ctx.get_node_outputs("node").unwrap();
    assert_eq!(got, &json!(20));
}

#[test]
fn test_dag_context_merge_output_min() {
    use ergatai_dag::{DagContext, MergeStrategy};

    let mut ctx = DagContext::empty();
    ctx.record_output("node", json!(10));
    ctx.merge_output("node", json!(5), &MergeStrategy::Min);

    let got = ctx.get_node_outputs("node").unwrap();
    assert_eq!(got, &json!(5));

    // Try larger value - should keep min
    ctx.merge_output("node", json!(20), &MergeStrategy::Min);
    let got = ctx.get_node_outputs("node").unwrap();
    assert_eq!(got, &json!(5));
}
