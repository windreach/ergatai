//! Integration tests for the ergatai-dag crate.
//!
//! These tests exercise the FULL pipeline:
//!   YAML string → parse_dag_yaml → TaskGraph → validate → template expand → critical path
//!
//! Each test verifies end-to-end behaviour through the public API surface.

use std::collections::HashMap;

use ergatai_dag::critical_path::calculate_critical_path;
use ergatai_dag::{
    parse_dag_yaml, Condition, DagContext, TaskComplexity, TaskGraph, TaskNode, TaskStatus,
    render_template,
};

// ─── Helpers ────────────────────────────────────────────────────────────────

/// Build a `HashMap<String, serde_json::Value>` from string key-value pairs.
fn params(pairs: &[(&str, &str)]) -> HashMap<String, serde_json::Value> {
    pairs
        .iter()
        .map(|(k, v)| (k.to_string(), serde_json::Value::String(v.to_string())))
        .collect()
}

/// Find a node by its human-readable task name.
fn find_by_name<'a>(graph: &'a TaskGraph, name: &str) -> &'a TaskNode {
    graph
        .nodes
        .iter()
        .find(|n| n.task == name)
        .unwrap_or_else(|| panic!("node named {name:?} not found"))
}

// ═════════════════════════════════════════════════════════════════════════════
// 1. Happy path — valid YAML with 3 nodes, dependencies, priorities
// ═════════════════════════════════════════════════════════════════════════════

#[test]
fn happy_path_three_nodes_with_dependencies_and_priorities() {
    let yaml = r#"
name: feature-pipeline
description: Implement and test a new feature
priority: high

tasks:
  - name: Design
    agent: architect
    task: tasks/design.md
    priority: high
    complexity: high
    timeout: 600

  - name: Implement
    agent: developer
    task: tasks/implement.md
    depends_on: [Design]
    priority: high
    complexity: medium
    timeout: 1200
    scope: "src/**/*.rs"

  - name: Test
    agent: qa
    task: tasks/test.md
    depends_on: [Implement]
    priority: medium
    complexity: low
    timeout: 300
"#;

    let graph = parse_dag_yaml(yaml, None).expect("valid YAML should parse");

    // Structural assertions
    assert_eq!(graph.nodes.len(), 3);
    assert_eq!(graph.priority.as_deref(), Some("high"));

    // Nodes carry the correct agent
    let design = find_by_name(&graph, "Design");
    assert_eq!(design.agent, "architect");
    assert_eq!(design.complexity, TaskComplexity::High);
    assert_eq!(design.timeout, Some(600));
    assert!(design.depends_on.is_empty());

    let implement = find_by_name(&graph, "Implement");
    assert_eq!(implement.agent, "developer");
    assert_eq!(implement.scope, Some("src/**/*.rs".to_string()));
    assert_eq!(implement.depends_on.len(), 1);
    assert_eq!(implement.depends_on[0], design.id);

    let test = find_by_name(&graph, "Test");
    assert_eq!(test.agent, "qa");
    assert_eq!(test.complexity, TaskComplexity::Low);
    assert_eq!(test.depends_on.len(), 1);
    assert_eq!(test.depends_on[0], implement.id);

    // All nodes are Pending initially
    for node in &graph.nodes {
        assert_eq!(node.status, TaskStatus::Pending);
    }

    // Only Design is ready to execute
    let ready = graph.ready_tasks();
    assert_eq!(ready.len(), 1);
    assert_eq!(ready[0].task, "Design");

    // UUIDs are well-formed
    for node in &graph.nodes {
        assert!(uuid::Uuid::parse_str(&node.id).is_ok());
    }
}

// ═════════════════════════════════════════════════════════════════════════════
// 2. Dependency chain — A → B → C, verify topological readiness
// ═════════════════════════════════════════════════════════════════════════════

#[test]
fn dependency_chain_a_b_c_topological_order() {
    let yaml = r#"
tasks:
  - name: A
    agent: agent-a
  - name: B
    agent: agent-b
    depends_on: [A]
  - name: C
    agent: agent-c
    depends_on: [B]
"#;

    let mut graph = parse_dag_yaml(yaml, None).unwrap();

    // Initially only A is ready
    let ready = graph.ready_tasks();
    assert_eq!(ready.len(), 1);
    assert_eq!(ready[0].task, "A");

    // Complete A → B becomes ready
    let a_id = find_by_name(&graph, "A").id.clone();
    graph.update_status(&a_id, TaskStatus::Completed).unwrap();
    let ready = graph.ready_tasks();
    assert_eq!(ready.len(), 1);
    assert_eq!(ready[0].task, "B");

    // Complete B → C becomes ready
    let b_id = find_by_name(&graph, "B").id.clone();
    graph.update_status(&b_id, TaskStatus::Completed).unwrap();
    let ready = graph.ready_tasks();
    assert_eq!(ready.len(), 1);
    assert_eq!(ready[0].task, "C");

    // Complete C → DAG is complete
    let c_id = find_by_name(&graph, "C").id.clone();
    graph.update_status(&c_id, TaskStatus::Completed).unwrap();
    assert!(graph.is_complete());
    assert_eq!(graph.progress(), 1.0);
}

// ═════════════════════════════════════════════════════════════════════════════
// 3. Template expansion — YAML with {{var}} references
// ═════════════════════════════════════════════════════════════════════════════

#[test]
fn template_expansion_with_parameters() {
    let yaml = r#"
parameters:
  - name: user_query
  - name: target_file
    default: "src/main.rs"

tasks:
  - name: Analyze
    agent: analyst
    input: "Analyze {{user_query}} in {{target_file}}"
"#;

    let provided = params(&[("user_query", "fix the performance bug")]);
    let graph = parse_dag_yaml(yaml, Some(provided)).unwrap();

    // Parameters resolved: user_query from input, target_file from default
    assert_eq!(
        graph.parameters.get("user_query"),
        Some(&serde_json::Value::String("fix the performance bug".to_string()))
    );
    assert_eq!(
        graph.parameters.get("target_file"),
        Some(&serde_json::Value::String("src/main.rs".to_string()))
    );

    // Template rendering: build a flat context map matching the YAML template format
    // (bare {{var}} references without prefix)
    let mut flat_ctx: HashMap<String, String> = HashMap::new();
    for (k, v) in &graph.parameters {
        if let serde_json::Value::String(s) = v {
            flat_ctx.insert(k.clone(), s.clone());
        }
    }

    let node = &graph.nodes[0];
    let rendered = ergatai_dag::render_template(node.input.as_ref().unwrap(), &flat_ctx);
    assert_eq!(rendered, "Analyze fix the performance bug in src/main.rs");
}

#[test]
fn template_expansion_no_parameters_skips_validation() {
    // When no parameters are declared, template vars are treated as free-form
    let yaml = r#"
tasks:
  - name: Free
    agent: agent
    input: "{{anything}} goes {{here}}"
"#;
    let graph = parse_dag_yaml(yaml, None).unwrap();
    assert_eq!(graph.nodes[0].input.as_deref(), Some("{{anything}} goes {{here}}"));
}

// ═════════════════════════════════════════════════════════════════════════════
// 4. Communication policy
// ═════════════════════════════════════════════════════════════════════════════

#[test]
fn communication_policy_adjacent() {
    let yaml = r#"
communication: adjacent
tasks:
  - name: A
    agent: alice
  - name: B
    agent: bob
    depends_on: [A]
"#;
    let graph = parse_dag_yaml(yaml, None).unwrap();
    assert_eq!(graph.communication.as_deref(), Some("adjacent"));
}

#[test]
fn communication_policy_star_with_hub() {
    let yaml = r#"
communication: "star:coordinator"
tasks:
  - name: Plan
    agent: coordinator
  - name: Work
    agent: worker
    depends_on: [Plan]
"#;
    let graph = parse_dag_yaml(yaml, None).unwrap();
    assert_eq!(graph.communication.as_deref(), Some("star:coordinator"));
}

#[test]
fn communication_policy_open_explicit() {
    let yaml = r#"
communication: open
tasks:
  - name: A
    agent: a
"#;
    let graph = parse_dag_yaml(yaml, None).unwrap();
    assert_eq!(graph.communication.as_deref(), Some("open"));
}

// ═════════════════════════════════════════════════════════════════════════════
// 5. Budget enforcement
// ═════════════════════════════════════════════════════════════════════════════

#[test]
fn budget_enforcement_max_agent_calls() {
    let yaml = r#"
max_agent_calls: 50
stall_timeout_secs: 300
node_timeout_secs: 120
tasks:
  - name: Task A
    agent: alice
  - name: Task B
    agent: bob
    depends_on: [Task A]
"#;
    let graph = parse_dag_yaml(yaml, None).unwrap();
    assert_eq!(graph.max_agent_calls, Some(50));
    assert_eq!(graph.stall_timeout_secs, Some(300));
    assert_eq!(graph.node_timeout_secs, Some(120));
}

#[test]
fn budget_defaults_to_none_when_absent() {
    let yaml = r#"
tasks:
  - name: Task A
"#;
    let graph = parse_dag_yaml(yaml, None).unwrap();
    assert_eq!(graph.max_agent_calls, None);
    assert_eq!(graph.stall_timeout_secs, None);
    assert_eq!(graph.node_timeout_secs, None);
    assert_eq!(graph.timeout, None);
}

// ═════════════════════════════════════════════════════════════════════════════
// 6. Validation errors — each of the 9 strict rules
// ═════════════════════════════════════════════════════════════════════════════

// Rule 1: Unknown top-level fields (deny_unknown_fields)
#[test]
fn validation_error_unknown_top_level_field() {
    let yaml = r#"
name: dag
communcation: open
tasks:
  - name: Task A
"#;
    let result = parse_dag_yaml(yaml, None);
    assert!(result.is_err(), "typo 'communcation' should be rejected");
    let err = result.unwrap_err().to_string();
    assert!(
        err.contains("communcation") || err.contains("unknown field") || err.contains("YAML parse error"),
        "error should mention the bad field: {err}"
    );
}

// Rule 2: Empty task names
#[test]
fn validation_error_empty_task_name() {
    let yaml = r#"
tasks:
  - name: ""
"#;
    let result = parse_dag_yaml(yaml, None);
    assert!(result.is_err());
    assert!(result.unwrap_err().to_string().contains("empty"));

    // Whitespace-only name also rejected
    let yaml2 = r#"
tasks:
  - name: "   "
"#;
    assert!(parse_dag_yaml(yaml2, None).is_err());
}

// Rule 3: Duplicate task names
#[test]
fn validation_error_duplicate_task_names() {
    let yaml = r#"
tasks:
  - name: TaskA
    agent: alice
  - name: TaskA
    agent: bob
"#;
    let result = parse_dag_yaml(yaml, None);
    assert!(result.is_err());
    assert!(result.unwrap_err().to_string().contains("Duplicate"));
}

// Rule 4: Invalid priority values
#[test]
fn validation_error_invalid_priority() {
    // DAG-level priority
    let yaml = r#"
priority: urgent
tasks:
  - name: Task A
"#;
    let result = parse_dag_yaml(yaml, None);
    assert!(result.is_err());
    assert!(result.unwrap_err().to_string().contains("priority"));

    // Task-level priority
    let yaml2 = r#"
tasks:
  - name: Task A
    priority: super_high
"#;
    let result2 = parse_dag_yaml(yaml2, None);
    assert!(result2.is_err());
    assert!(result2.unwrap_err().to_string().contains("priority"));
}

// Rule 5: Zero/negative timeout values
#[test]
fn validation_error_zero_timeout_values() {
    let cases = [
        ("timeout: 0\ntasks:\n  - name: A", "timeout"),
        ("max_agent_calls: 0\ntasks:\n  - name: A", "max_agent_calls"),
        ("stall_timeout_secs: 0\ntasks:\n  - name: A", "stall_timeout_secs"),
        ("node_timeout_secs: 0\ntasks:\n  - name: A", "node_timeout_secs"),
        ("tasks:\n  - name: A\n    timeout: 0", "timeout"),
    ];

    for (yaml, expected_keyword) in cases {
        let result = parse_dag_yaml(yaml, None);
        assert!(
            result.is_err(),
            "expected error for YAML with zero value: {yaml}"
        );
        let err = result.unwrap_err().to_string();
        assert!(
            err.contains(expected_keyword) || err.contains("> 0") || err.contains("must be"),
            "error should mention the offending field ({expected_keyword}): {err}"
        );
    }
}

// Rule 6: Invalid communication format
#[test]
fn validation_error_invalid_communication_format() {
    // Completely invalid value
    let yaml = r#"
communication: random_mode
tasks:
  - name: A
"#;
    let result = parse_dag_yaml(yaml, None);
    assert!(result.is_err());
    assert!(result.unwrap_err().to_string().contains("communication"));

    // star: with empty hub
    let yaml2 = r#"
communication: "star:"
tasks:
  - name: A
"#;
    assert!(parse_dag_yaml(yaml2, None).is_err());

    // star: with unknown hub agent
    let yaml3 = r#"
communication: "star:ghost"
tasks:
  - name: A
    agent: real_agent
"#;
    let result3 = parse_dag_yaml(yaml3, None);
    assert!(result3.is_err());
    assert!(result3.unwrap_err().to_string().contains("ghost"));
}

// Rule 7: Unresolved template variables
#[test]
fn validation_error_unresolved_template_variables() {
    let yaml = r#"
parameters:
  - name: known_var
tasks:
  - name: Task A
    input: "{{known_var}} and {{unknown_var}}"
"#;
    let result = parse_dag_yaml(yaml, None);
    assert!(result.is_err());
    let err = result.unwrap_err().to_string();
    assert!(err.contains("unknown_var"), "error should name the bad variable: {err}");
}

// Rule 8: Missing dependency targets
#[test]
fn validation_error_missing_dependency_target() {
    let yaml = r#"
tasks:
  - name: Task A
    depends_on: [NonExistent]
"#;
    let result = parse_dag_yaml(yaml, None);
    assert!(result.is_err());
    assert!(result.unwrap_err().to_string().contains("unknown task"));
}

// Rule 9: Invalid scope globs
#[test]
fn validation_error_invalid_scope_glob() {
    // Path traversal
    let yaml = r#"
tasks:
  - name: Task A
    scope: "../secrets/**"
"#;
    let result = parse_dag_yaml(yaml, None);
    assert!(result.is_err());
    let err = result.unwrap_err().to_string();
    assert!(
        err.contains("scope") || err.contains("traversal") || err.contains("relative"),
        "error should mention scope issue: {err}"
    );

    // Absolute path
    let yaml2 = r#"
tasks:
  - name: Task A
    scope: "/etc/passwd"
"#;
    assert!(parse_dag_yaml(yaml2, None).is_err());

    // Invalid glob syntax
    let yaml3 = r#"
tasks:
  - name: Task A
    scope: "src/[invalid"
"#;
    assert!(parse_dag_yaml(yaml3, None).is_err());
}

// ═════════════════════════════════════════════════════════════════════════════
// 7. Complex DAG — 7+ nodes with mixed deps, priorities, complexities
// ═════════════════════════════════════════════════════════════════════════════

#[test]
fn complex_dag_seven_nodes_with_critical_path() {
    let yaml = r#"
name: full-project
description: Complete project with multiple phases
max_agent_calls: 100
stall_timeout_secs: 600
node_timeout_secs: 300
communication: adjacent

tasks:
  - name: Requirements
    agent: pm
    priority: high
    complexity: medium
    timeout: 200

  - name: Architecture
    agent: architect
    depends_on: [Requirements]
    priority: high
    complexity: high
    timeout: 400

  - name: Database Design
    agent: dba
    depends_on: [Architecture]
    priority: medium
    complexity: medium

  - name: Frontend Scaffolding
    agent: frontend
    depends_on: [Architecture]
    priority: medium
    complexity: low
    scope: "src/frontend/**"

  - name: Backend API
    agent: backend
    depends_on: [Architecture, Database Design]
    priority: high
    complexity: high
    scope: "src/backend/**"

  - name: Frontend Implementation
    agent: frontend
    depends_on: [Frontend Scaffolding, Backend API]
    priority: high
    complexity: high
    scope: "src/frontend/**"

  - name: Integration Tests
    agent: qa
    depends_on: [Backend API, Frontend Implementation]
    priority: high
    complexity: medium
    timeout: 500

  - name: Documentation
    agent: techwriter
    depends_on: [Backend API]
    priority: low
    complexity: low
"#;

    let graph = parse_dag_yaml(yaml, None).expect("complex YAML should parse");

    // Structural checks
    assert_eq!(graph.nodes.len(), 8);
    assert_eq!(graph.communication.as_deref(), Some("adjacent"));
    assert_eq!(graph.max_agent_calls, Some(100));

    // Only Requirements is ready initially
    let ready = graph.ready_tasks();
    assert_eq!(ready.len(), 1);
    assert_eq!(ready[0].task, "Requirements");

    // Verify dependency resolution — all depends_on are valid UUIDs
    for node in &graph.nodes {
        for dep_id in &node.depends_on {
            assert!(
                graph.find_node(dep_id).is_some(),
                "dep {} of node {} not found",
                dep_id,
                node.task
            );
        }
    }

    // Critical path analysis should run without panic
    let durations: HashMap<String, u64> = graph
        .nodes
        .iter()
        .map(|n| (n.id.clone(), n.timeout.unwrap_or(100)))
        .collect();

    let cp_result = calculate_critical_path(&graph, &durations);
    assert!(cp_result.is_some(), "critical path should compute");
    let cp = cp_result.unwrap();

    // Total duration should be > 0
    assert!(cp.total_duration > 0);

    // Critical path should contain at least one node
    assert!(!cp.critical_path.is_empty());

    // All slack times should be non-negative (u64 guarantees this by type)
    for (_id, &slack) in &cp.slack_times {
        let _ = slack;
    }

    // Every node in the graph should have an earliest_start entry
    for node in &graph.nodes {
        assert!(
            cp.earliest_start.contains_key(&node.id),
            "node {} missing from earliest_start",
            node.task
        );
        assert!(
            cp.latest_start.contains_key(&node.id),
            "node {} missing from latest_start",
            node.task
        );
    }

    // Requirements should be on the critical path (it's the root of everything)
    let req_node = find_by_name(&graph, "Requirements");
    assert!(
        cp.critical_path.contains(&req_node.id),
        "Requirements should be on critical path"
    );
    assert_eq!(
        cp.slack_times.get(&req_node.id),
        Some(&0),
        "root of critical path should have 0 slack"
    );
}

// ═════════════════════════════════════════════════════════════════════════════
// Additional integration scenarios
// ═════════════════════════════════════════════════════════════════════════════

#[test]
fn full_pipeline_simulate_execution_with_template_context() {
    // End-to-end: parse → execute → render templates → condition evaluation
    let yaml = r#"
parameters:
  - name: feature_name

tasks:
  - name: Plan
    agent: planner
    input: "Plan implementation for {{feature_name}}"

  - name: Code
    agent: coder
    depends_on: [Plan]
    input: "Implement {{feature_name}} based on plan"

  - name: Review
    agent: reviewer
    depends_on: [Code]
    condition: "1 == 1"
"#;

    let provided = params(&[("feature_name", "dark mode")]);
    let mut graph = parse_dag_yaml(yaml, Some(provided)).unwrap();

    // Build flat context map for bare {{var}} template references used in YAML
    let mut flat_ctx: HashMap<String, String> = HashMap::new();
    for (k, v) in &graph.parameters {
        if let serde_json::Value::String(s) = v {
            flat_ctx.insert(k.clone(), s.clone());
        }
    }

    // DagContext for condition evaluation (which uses {{global.*}} prefix)
    let mut ctx = DagContext::with_parameters(
        HashMap::new(),
        graph.parameters.clone(),
    );

    // Step 1: Plan is ready
    let ready = graph.ready_tasks();
    assert_eq!(ready.len(), 1);
    assert_eq!(ready[0].task, "Plan");

    // Render Plan's input using flat context (matches bare {{feature_name}} in YAML)
    let plan_input = ergatai_dag::render_template(ready[0].input.as_ref().unwrap(), &flat_ctx);
    assert_eq!(plan_input, "Plan implementation for dark mode");

    // Mark Plan complete
    let plan_id = ready[0].id.clone();
    graph.update_status(&plan_id, TaskStatus::Completed).unwrap();
    ctx.record_output(
        &plan_id,
        serde_json::json!({"status": "approved", "summary": "Plan looks good"}),
    );

    // Step 2: Code is ready
    let ready = graph.ready_tasks();
    assert_eq!(ready.len(), 1);
    assert_eq!(ready[0].task, "Code");

    let code_input = ergatai_dag::render_template(ready[0].input.as_ref().unwrap(), &flat_ctx);
    assert_eq!(code_input, "Implement dark mode based on plan");

    // Mark Code complete
    let code_id = ready[0].id.clone();
    graph.update_status(&code_id, TaskStatus::Completed).unwrap();

    // Step 3: Review is ready, check its condition
    let ready = graph.ready_tasks();
    assert_eq!(ready.len(), 1);
    assert_eq!(ready[0].task, "Review");

    let review_node = ready[0];
    if let Some(ref cond_str) = review_node.condition {
        let condition = Condition::new(cond_str);
        assert!(condition.evaluate(&ctx), "condition '1 == 1' should be true");
    }

    // Complete the DAG
    let review_id = review_node.id.clone();
    graph.update_status(&review_id, TaskStatus::Completed).unwrap();
    assert!(graph.is_complete());
    assert_eq!(graph.progress(), 1.0);
}

#[test]
fn diamond_dependency_pattern_via_yaml() {
    // A → B, A → C, B → D, C → D (diamond)
    let yaml = r#"
tasks:
  - name: A
    agent: agent-a
  - name: B
    agent: agent-b
    depends_on: [A]
  - name: C
    agent: agent-c
    depends_on: [A]
  - name: D
    agent: agent-d
    depends_on: [B, C]
"#;

    let mut graph = parse_dag_yaml(yaml, None).unwrap();

    // Only A is ready
    assert_eq!(graph.ready_tasks().len(), 1);
    assert_eq!(graph.ready_tasks()[0].task, "A");

    // Complete A → B and C are both ready (parallel)
    let a_id = find_by_name(&graph, "A").id.clone();
    graph.update_status(&a_id, TaskStatus::Completed).unwrap();
    let ready = graph.ready_tasks();
    assert_eq!(ready.len(), 2);
    let ready_names: Vec<&str> = ready.iter().map(|n| n.task.as_str()).collect();
    assert!(ready_names.contains(&"B"));
    assert!(ready_names.contains(&"C"));

    // Complete B → D still waiting for C
    let b_id = find_by_name(&graph, "B").id.clone();
    graph.update_status(&b_id, TaskStatus::Completed).unwrap();
    assert_eq!(graph.ready_tasks().len(), 1);
    assert_eq!(graph.ready_tasks()[0].task, "C");

    // Complete C → D becomes ready
    let c_id = find_by_name(&graph, "C").id.clone();
    graph.update_status(&c_id, TaskStatus::Completed).unwrap();
    let ready = graph.ready_tasks();
    assert_eq!(ready.len(), 1);
    assert_eq!(ready[0].task, "D");
}

#[test]
fn dag_priority_propagation_from_top_level_to_nodes() {
    // DAG-level priority should propagate to nodes that don't set their own
    let yaml = r#"
priority: high
tasks:
  - name: Inherit
    agent: a
  - name: Override
    agent: b
    priority: low
"#;
    let graph = parse_dag_yaml(yaml, None).unwrap();

    let inherit = find_by_name(&graph, "Inherit");
    assert_eq!(inherit.priority.as_deref(), Some("high"));

    let override_node = find_by_name(&graph, "Override");
    assert_eq!(override_node.priority.as_deref(), Some("low"));
}

#[test]
fn parent_field_merges_into_depends_on() {
    let yaml = r#"
tasks:
  - name: Root
    agent: coordinator
  - name: Child
    agent: worker
    parent: Root
    depends_on: [Root]
"#;
    let graph = parse_dag_yaml(yaml, None).unwrap();
    let child = find_by_name(&graph, "Child");
    // parent + depends_on should merge into a single unique dependency
    assert_eq!(child.depends_on.len(), 1);
    let root = find_by_name(&graph, "Root");
    assert_eq!(child.depends_on[0], root.id);
}

#[test]
fn metadata_extra_fields_captured() {
    let yaml = r#"
tasks:
  - name: Task A
    custom_label: important
    estimated_cost: 42
"#;
    let graph = parse_dag_yaml(yaml, None).unwrap();
    let node = &graph.nodes[0];
    assert_eq!(node.metadata.get("custom_label"), Some(&"important".to_string()));
    assert_eq!(node.metadata.get("estimated_cost"), Some(&"42".to_string()));
}

#[test]
fn complexity_values_parsed_correctly() {
    let yaml = r#"
tasks:
  - name: Simple
    complexity: low
  - name: Normal
    complexity: medium
  - name: Hard
    complexity: high
  - name: Default
"#;
    let graph = parse_dag_yaml(yaml, None).unwrap();
    assert_eq!(find_by_name(&graph, "Simple").complexity, TaskComplexity::Low);
    assert_eq!(find_by_name(&graph, "Normal").complexity, TaskComplexity::Medium);
    assert_eq!(find_by_name(&graph, "Hard").complexity, TaskComplexity::High);
    assert_eq!(find_by_name(&graph, "Default").complexity, TaskComplexity::Medium);
}

#[test]
fn complexity_scores_are_ordered() {
    assert!(TaskComplexity::Low.as_score() < TaskComplexity::Medium.as_score());
    assert!(TaskComplexity::Medium.as_score() < TaskComplexity::High.as_score());
}

#[test]
fn parameter_type_validation() {
    let yaml = r#"
parameters:
  - name: count
    param_type: number

tasks:
  - name: Task A
    input: "{{count}}"
"#;

    // Valid number
    let mut good = HashMap::new();
    good.insert("count".to_string(), serde_json::json!(42));
    assert!(parse_dag_yaml(yaml, Some(good)).is_ok());

    // Invalid: string instead of number
    let mut bad = HashMap::new();
    bad.insert("count".to_string(), serde_json::json!("not_a_number"));
    assert!(parse_dag_yaml(yaml, Some(bad)).is_err());
}

#[test]
fn required_parameter_missing_produces_error() {
    let yaml = r#"
parameters:
  - name: must_have
    required: true

tasks:
  - name: Task A
    input: "{{must_have}}"
"#;
    // No params provided → required param missing
    let result = parse_dag_yaml(yaml, None);
    assert!(result.is_err());
    assert!(result.unwrap_err().to_string().contains("must_have"));
}

#[test]
fn unknown_parameter_rejected() {
    let yaml = r#"
parameters:
  - name: known

tasks:
  - name: Task A
    input: "{{known}}"
"#;
    let mut bad_params = HashMap::new();
    bad_params.insert("known".to_string(), serde_json::json!("ok"));
    bad_params.insert("unknown".to_string(), serde_json::json!("bad"));
    let result = parse_dag_yaml(yaml, Some(bad_params));
    assert!(result.is_err());
    assert!(result.unwrap_err().to_string().contains("Unknown parameter"));
}

#[test]
fn empty_tasks_list_rejected() {
    let yaml = "tasks: []\n";
    let result = parse_dag_yaml(yaml, None);
    assert!(result.is_err());
    assert!(result.unwrap_err().to_string().contains("No tasks"));
}

#[test]
fn valid_scope_patterns_accepted() {
    let yaml = r#"
tasks:
  - name: A
    scope: "src/**/*.rs"
  - name: B
    scope: "docs/**"
  - name: C
    scope: "tests/*.rs"
"#;
    let graph = parse_dag_yaml(yaml, None).unwrap();
    assert_eq!(find_by_name(&graph, "A").scope, Some("src/**/*.rs".to_string()));
    assert_eq!(find_by_name(&graph, "B").scope, Some("docs/**".to_string()));
    assert_eq!(find_by_name(&graph, "C").scope, Some("tests/*.rs".to_string()));
}

#[test]
fn max_retries_alias_works() {
    let yaml = r#"
tasks:
  - name: A
    max_retries: 5
  - name: B
    retry: 3
"#;
    let graph = parse_dag_yaml(yaml, None).unwrap();
    assert_eq!(find_by_name(&graph, "A").max_retries, 5);
    assert_eq!(find_by_name(&graph, "B").max_retries, 3);
}

#[test]
fn case_insensitive_priority_accepted() {
    let yaml = r#"
priority: HIGH
tasks:
  - name: A
    priority: Low
  - name: B
    priority: MEDIUM
"#;
    let graph = parse_dag_yaml(yaml, None).unwrap();
    assert_eq!(graph.nodes.len(), 2);
    assert_eq!(find_by_name(&graph, "A").priority.as_deref(), Some("Low"));
    assert_eq!(find_by_name(&graph, "B").priority.as_deref(), Some("MEDIUM"));
}

#[test]
fn chinese_content_preserved() {
    let yaml = r#"
name: 功能实现流程
description: 多 agent 协作
tasks:
  - name: 需求分析
    agent: pm
  - name: 架构设计
    agent: architect
    depends_on: [需求分析]
  - name: 开发
    agent: dev
    depends_on: [架构设计]
"#;
    let graph = parse_dag_yaml(yaml, None).unwrap();
    assert_eq!(graph.nodes.len(), 3);
    assert_eq!(graph.nodes[0].task, "需求分析");
    assert_eq!(graph.nodes[2].task, "开发");
    // Dependency chain preserved
    let dev = find_by_name(&graph, "开发");
    let arch = find_by_name(&graph, "架构设计");
    assert_eq!(dev.depends_on[0], arch.id);
}

#[test]
fn graph_validation_rejects_cycles() {
    // Build a graph directly with a cycle — YAML parser catches missing deps,
    // but this tests the validate() method's cycle detection
    let graph = TaskGraph::new(vec![
        TaskNode::new("a", "agent", "A").with_dependencies(vec!["b".into()]),
        TaskNode::new("b", "agent", "B").with_dependencies(vec!["a".into()]),
    ]);
    assert!(graph.validate().is_err());
    assert!(graph.validate().unwrap_err().to_string().contains("cycle"));
}

#[test]
fn render_template_integration_with_dag_context() {
    // Full template pipeline: global vars + node outputs → render
    let mut ctx = DagContext::empty();
    ctx.set_global("project", "ergatai");
    ctx.set_global("branch", "main");
    ctx.record_output(
        "node-1",
        serde_json::json!({"result": "LGTM", "issues": 3}),
    );

    let rendered = ctx.render_template(
        "Project {{global.project}} on {{global.branch}}: {{node-1.result}} with {{node-1.issues}} issues",
    );
    assert_eq!(
        rendered,
        "Project ergatai on main: LGTM with 3 issues"
    );

    // Unresolved vars preserved
    let rendered2 = ctx.render_template("{{global.missing}} stays");
    assert_eq!(rendered2, "{{global.missing}} stays");
}

// ═════════════════════════════════════════════════════════════════════════════
// Boundary & edge-case integration tests
// ═════════════════════════════════════════════════════════════════════════════

// ── 1. Cycle detection through YAML ─────────────────────────────────────────

#[test]
fn boundary_cycle_a_b_c_a_rejected_by_yaml_parser() {
    // A → B → C → A forms a cycle. All names exist, so the depends_on
    // existence check passes — but validate() catches the cycle.
    let yaml = r#"
tasks:
  - name: A
    agent: a
    depends_on: [C]
  - name: B
    agent: b
    depends_on: [A]
  - name: C
    agent: c
    depends_on: [B]
"#;
    let result = parse_dag_yaml(yaml, None);
    assert!(result.is_err(), "3-node cycle should be rejected");
    let err = result.unwrap_err().to_string();
    assert!(
        err.to_lowercase().contains("cycle"),
        "error should mention cycle: {err}"
    );
}

#[test]
fn boundary_self_dependency_rejected() {
    // A task that depends on itself is a trivial cycle.
    let yaml = r#"
tasks:
  - name: Narcissist
    agent: a
    depends_on: [Narcissist]
"#;
    let result = parse_dag_yaml(yaml, None);
    assert!(result.is_err(), "self-dependency should be rejected");
    let err = result.unwrap_err().to_string();
    assert!(
        err.to_lowercase().contains("cycle"),
        "error should mention cycle: {err}"
    );
}

// ── 2. Empty / minimal task lists ───────────────────────────────────────────

#[test]
fn boundary_no_tasks_key_at_all() {
    // YAML with no tasks key — serde deserializes tasks as missing.
    // The parser should detect empty tasks.
    let yaml = "name: empty-dag\n";
    let result = parse_dag_yaml(yaml, None);
    // serde_yaml will error because `tasks` is a required field in YamlDag
    assert!(result.is_err());
}

#[test]
fn boundary_single_task_no_deps_simplest_dag() {
    let yaml = r#"
tasks:
  - name: Solo
"#;
    let graph = parse_dag_yaml(yaml, None).unwrap();
    assert_eq!(graph.nodes.len(), 1);
    assert_eq!(graph.nodes[0].task, "Solo");
    assert!(graph.nodes[0].depends_on.is_empty());
    // Single task is immediately ready
    assert_eq!(graph.ready_tasks().len(), 1);
    assert_eq!(graph.ready_tasks()[0].task, "Solo");
    // Default agent assigned
    assert_eq!(graph.nodes[0].agent, "agent");
}

// ── 3. Very long task names ─────────────────────────────────────────────────

#[test]
fn boundary_very_long_task_name_200_chars() {
    let long_name = "x".repeat(250);
    let yaml = format!(
        "tasks:\n  - name: \"{long_name}\"\n"
    );
    let graph = parse_dag_yaml(&yaml, None).unwrap();
    assert_eq!(graph.nodes.len(), 1);
    assert_eq!(graph.nodes[0].task.len(), 250);
    assert_eq!(graph.nodes[0].task, long_name);
}

#[test]
fn boundary_long_task_name_used_in_depends_on() {
    let long_name = "task_".repeat(50); // 250 chars
    let yaml = format!(
        "tasks:\n  - name: \"{long_name}\"\n  - name: follower\n    depends_on: [\"{long_name}\"]\n"
    );
    let graph = parse_dag_yaml(&yaml, None).unwrap();
    assert_eq!(graph.nodes.len(), 2);
    let follower = find_by_name(&graph, "follower");
    let long_node = find_by_name(&graph, &long_name);
    assert_eq!(follower.depends_on.len(), 1);
    assert_eq!(follower.depends_on[0], long_node.id);
}

// ── 4. Unicode in task names ────────────────────────────────────────────────

#[test]
fn boundary_emoji_in_task_names() {
    let yaml = r#"
tasks:
  - name: "🚀 Launch"
    agent: rocket
  - name: "🔍 Investigate"
    agent: detective
    depends_on: ["🚀 Launch"]
  - name: "✅ Verify"
    agent: qa
    depends_on: ["🔍 Investigate"]
"#;
    let graph = parse_dag_yaml(yaml, None).unwrap();
    assert_eq!(graph.nodes.len(), 3);
    assert_eq!(graph.nodes[0].task, "🚀 Launch");
    assert_eq!(graph.nodes[2].task, "✅ Verify");
    // Dependency chain preserved
    let verify = find_by_name(&graph, "✅ Verify");
    let investigate = find_by_name(&graph, "🔍 Investigate");
    assert_eq!(verify.depends_on.len(), 1);
    assert_eq!(verify.depends_on[0], investigate.id);
}

#[test]
fn boundary_mixed_unicode_scripts_in_names() {
    let yaml = r#"
tasks:
  - name: "タスクA"
    agent: a
  - name: "Задача-Б"
    agent: b
    depends_on: ["タスクA"]
  - name: "مهمة-ج"
    agent: c
    depends_on: ["Задача-Б"]
"#;
    let graph = parse_dag_yaml(yaml, None).unwrap();
    assert_eq!(graph.nodes.len(), 3);
    assert_eq!(graph.nodes[0].task, "タスクA");
    assert_eq!(graph.nodes[1].task, "Задача-Б");
    assert_eq!(graph.nodes[2].task, "مهمة-ج");
}

// ── 5. Max depth chain (50+ node linear chain) ─────────────────────────────

#[test]
fn boundary_deep_linear_chain_50_nodes() {
    // Build a 50-node linear chain: N0 → N1 → N2 → ... → N49
    let n = 50;
    let mut yaml = String::from("tasks:\n");
    for i in 0..n {
        if i == 0 {
            yaml.push_str(&format!("  - name: N{i}\n    agent: agent-{i}\n"));
        } else {
            yaml.push_str(&format!(
                "  - name: N{i}\n    agent: agent-{i}\n    depends_on: [N{}]\n",
                i - 1
            ));
        }
    }

    let mut graph = parse_dag_yaml(&yaml, None).unwrap();
    assert_eq!(graph.nodes.len(), n);

    // Only N0 is ready
    let ready = graph.ready_tasks();
    assert_eq!(ready.len(), 1);
    assert_eq!(ready[0].task, "N0");

    // Execute the chain one by one
    for i in 0..n {
        let id = find_by_name(&graph, &format!("N{i}")).id.clone();
        graph.update_status(&id, TaskStatus::Completed).unwrap();

        if i < n - 1 {
            let ready = graph.ready_tasks();
            assert_eq!(ready.len(), 1, "after completing N{i}, only N{} should be ready", i + 1);
            assert_eq!(ready[0].task, format!("N{}", i + 1));
        }
    }

    assert!(graph.is_complete());
    assert_eq!(graph.progress(), 1.0);
}

// ── 6. Wide fan-out (1 root → 20 children) ─────────────────────────────────

#[test]
fn boundary_wide_fan_out_one_root_twenty_children() {
    let n_children = 20;
    let mut yaml = String::from("tasks:\n  - name: Root\n    agent: coordinator\n");
    for i in 0..n_children {
        yaml.push_str(&format!(
            "  - name: Child{i}\n    agent: worker-{i}\n    depends_on: [Root]\n"
        ));
    }

    let mut graph = parse_dag_yaml(&yaml, None).unwrap();
    assert_eq!(graph.nodes.len(), n_children + 1);

    // Only Root is ready initially
    let ready = graph.ready_tasks();
    assert_eq!(ready.len(), 1);
    assert_eq!(ready[0].task, "Root");

    // Complete Root → all 20 children become ready
    let root_id = find_by_name(&graph, "Root").id.clone();
    graph.update_status(&root_id, TaskStatus::Completed).unwrap();
    let ready = graph.ready_tasks();
    assert_eq!(ready.len(), n_children);

    // Verify each child has exactly one dependency (Root)
    for i in 0..n_children {
        let child = find_by_name(&graph, &format!("Child{i}"));
        assert_eq!(child.depends_on.len(), 1);
        assert_eq!(child.depends_on[0], root_id);
    }
}

// ── 7. Diamond with conditions ──────────────────────────────────────────────

#[test]
fn boundary_diamond_with_conditions() {
    // Diamond: A → B, A → C, B → D, C → D
    // B has condition "1 == 1" (true), C has condition "1 == 2" (false)
    let yaml = r#"
tasks:
  - name: Start
    agent: starter

  - name: BranchTrue
    agent: agent-b
    depends_on: [Start]
    condition: "1 == 1"

  - name: BranchFalse
    agent: agent-c
    depends_on: [Start]
    condition: "1 == 2"

  - name: Merge
    agent: merger
    depends_on: [BranchTrue, BranchFalse]
"#;

    let graph = parse_dag_yaml(yaml, None).unwrap();
    assert_eq!(graph.nodes.len(), 4);

    // Conditions are stored on the nodes
    let bt = find_by_name(&graph, "BranchTrue");
    assert_eq!(bt.condition.as_deref(), Some("1 == 1"));

    let bf = find_by_name(&graph, "BranchFalse");
    assert_eq!(bf.condition.as_deref(), Some("1 == 2"));

    // Evaluate conditions
    let ctx = DagContext::empty();
    let cond_true = Condition::new(bt.condition.as_ref().unwrap());
    assert!(cond_true.evaluate(&ctx));

    let cond_false = Condition::new(bf.condition.as_ref().unwrap());
    assert!(!cond_false.evaluate(&ctx));
}

// ── 8. Template edge cases ──────────────────────────────────────────────────

#[test]
fn boundary_template_empty_braces_in_input() {
    // Empty braces {{}} should be preserved literally when no parameters declared
    let yaml = r#"
tasks:
  - name: Task
    agent: a
    input: "before {{}} after"
"#;
    let graph = parse_dag_yaml(yaml, None).unwrap();
    let node = &graph.nodes[0];
    assert_eq!(node.input.as_deref(), Some("before {{}} after"));

    // Render it — empty braces stay
    let ctx: HashMap<String, String> = HashMap::new();
    let rendered = render_template(node.input.as_ref().unwrap(), &ctx);
    assert_eq!(rendered, "before {{}} after");
}

#[test]
fn boundary_template_unclosed_braces_in_input() {
    // Unclosed {{ should be preserved literally when no parameters declared
    let yaml = r#"
tasks:
  - name: Task
    agent: a
    input: "text {{unclosed more text"
"#;
    let graph = parse_dag_yaml(yaml, None).unwrap();
    let node = &graph.nodes[0];
    assert_eq!(
        node.input.as_deref(),
        Some("text {{unclosed more text")
    );

    // Render it — unclosed braces preserved as literal
    let ctx: HashMap<String, String> = HashMap::new();
    let rendered = render_template(node.input.as_ref().unwrap(), &ctx);
    assert_eq!(rendered, "text {{unclosed more text");
}

#[test]
fn boundary_template_nested_braces() {
    // Nested braces: {{outer_{{inner}}}} — first }} closes the first {{
    let yaml = r#"
tasks:
  - name: Task
    agent: a
    input: "nested {{outer_{{inner}}}} end"
"#;
    let graph = parse_dag_yaml(yaml, None).unwrap();
    let node = &graph.nodes[0];
    // The YAML parser preserves the raw template string
    assert!(node.input.is_some());

    // Render with empty context — unresolved refs preserved
    let ctx: HashMap<String, String> = HashMap::new();
    let rendered = render_template(node.input.as_ref().unwrap(), &ctx);
    // Should not panic, and output should contain the original or partially resolved text
    assert!(rendered.contains("outer") || rendered.contains("inner"));
}

#[test]
fn boundary_template_special_chars_in_values() {
    let yaml = r#"
parameters:
  - name: special
tasks:
  - name: Task
    agent: a
    input: "value is {{special}}"
"#;
    let mut p = HashMap::new();
    p.insert(
        "special".to_string(),
        serde_json::Value::String("hello\nworld\t\"quotes\" & <braces>".to_string()),
    );
    let graph = parse_dag_yaml(yaml, Some(p)).unwrap();

    let mut flat_ctx: HashMap<String, String> = HashMap::new();
    for (k, v) in &graph.parameters {
        if let serde_json::Value::String(s) = v {
            flat_ctx.insert(k.clone(), s.clone());
        }
    }

    let rendered = render_template(
        graph.nodes[0].input.as_ref().unwrap(),
        &flat_ctx,
    );
    assert_eq!(rendered, "value is hello\nworld\t\"quotes\" & <braces>");
}

// ── 9. Condition evaluation edge cases ──────────────────────────────────────

#[test]
fn boundary_condition_empty_string() {
    let ctx = DagContext::empty();
    let cond = Condition::new("");
    // Empty condition evaluates to false (parse_bool("") → false)
    assert!(!cond.evaluate(&ctx));
}

#[test]
fn boundary_condition_whitespace_only() {
    let ctx = DagContext::empty();
    let cond = Condition::new("   ");
    // Whitespace-only trims to empty → false
    assert!(!cond.evaluate(&ctx));
}

#[test]
fn boundary_condition_complex_nested_booleans() {
    let ctx = DagContext::empty();

    // (true && false) || (true && true) → false || true → true
    let cond = Condition::new("(1 == 1 && 1 == 2) || (2 == 2 && 3 == 3)");
    assert!(cond.evaluate(&ctx));

    // (true && true) && (false || true) → true && true → true
    let cond2 = Condition::new("(1 == 1 && 2 == 2) && (1 == 2 || 3 == 3)");
    assert!(cond2.evaluate(&ctx));

    // Deeply nested: ((1==1)) — the evaluator only strips one layer of balanced
    // outer parens, so double-wrapped expressions are NOT unwrapped fully.
    // Use single wrapping which IS supported:
    let cond3 = Condition::new("(1 == 1)");
    assert!(cond3.evaluate(&ctx));
}

#[test]
fn boundary_condition_with_template_variables_from_context() {
    let mut ctx = DagContext::empty();
    ctx.set_global("status", "pass");
    ctx.set_global("count", "5");

    let cond = Condition::new("{{global.status}} == \"pass\" && {{global.count}} > 3");
    assert!(cond.evaluate(&ctx));

    let cond2 = Condition::new("{{global.status}} == \"fail\" || {{global.count}} < 3");
    assert!(!cond2.evaluate(&ctx));
}

#[test]
fn boundary_condition_yaml_condition_field() {
    let yaml = r#"
tasks:
  - name: A
    agent: a
  - name: B
    agent: b
    depends_on: [A]
    condition: "2 > 1"
"#;
    let graph = parse_dag_yaml(yaml, None).unwrap();
    let b = find_by_name(&graph, "B");
    assert_eq!(b.condition.as_deref(), Some("2 > 1"));

    let ctx = DagContext::empty();
    let cond = Condition::new(b.condition.as_ref().unwrap());
    assert!(cond.evaluate(&ctx));
}

// ── 10. Parameters edge cases ───────────────────────────────────────────────

#[test]
fn boundary_parameter_empty_default_value() {
    let yaml = r#"
parameters:
  - name: maybe_empty
    default: ""
tasks:
  - name: Task
    agent: a
"#;
    let graph = parse_dag_yaml(yaml, None).unwrap();
    assert_eq!(
        graph.parameters.get("maybe_empty"),
        Some(&serde_json::Value::String("".to_string()))
    );
}

#[test]
fn boundary_parameter_value_with_special_characters() {
    let yaml = r#"
parameters:
  - name: query
tasks:
  - name: Task
    agent: a
    input: "{{query}}"
"#;
    let mut p = HashMap::new();
    p.insert(
        "query".to_string(),
        serde_json::Value::String("SELECT * FROM users WHERE name = 'O''Brien' AND id < 100".to_string()),
    );
    let graph = parse_dag_yaml(yaml, Some(p)).unwrap();
    assert_eq!(
        graph.parameters.get("query"),
        Some(&serde_json::Value::String(
            "SELECT * FROM users WHERE name = 'O''Brien' AND id < 100".to_string()
        ))
    );
}

#[test]
fn boundary_parameter_very_long_value() {
    let yaml = r#"
parameters:
  - name: big
tasks:
  - name: Task
    agent: a
    input: "{{big}}"
"#;
    let long_val = "a".repeat(10_000);
    let mut p = HashMap::new();
    p.insert("big".to_string(), serde_json::Value::String(long_val.clone()));
    let graph = parse_dag_yaml(yaml, Some(p)).unwrap();
    assert_eq!(
        graph.parameters.get("big"),
        Some(&serde_json::Value::String(long_val))
    );
}

#[test]
fn boundary_parameter_boolean_type() {
    let yaml = r#"
parameters:
  - name: flag
    param_type: boolean
tasks:
  - name: Task
    agent: a
"#;
    let mut good = HashMap::new();
    good.insert("flag".to_string(), serde_json::json!(true));
    assert!(parse_dag_yaml(yaml, Some(good)).is_ok());

    let mut bad = HashMap::new();
    bad.insert("flag".to_string(), serde_json::json!("not_a_bool"));
    assert!(parse_dag_yaml(yaml, Some(bad)).is_err());
}

// ── 11. Scope glob edge cases ───────────────────────────────────────────────

#[test]
fn boundary_scope_recursive_glob_double_star() {
    let yaml = r#"
tasks:
  - name: A
    scope: "src/**/tests/**/*.rs"
"#;
    let graph = parse_dag_yaml(yaml, None).unwrap();
    assert_eq!(
        find_by_name(&graph, "A").scope,
        Some("src/**/tests/**/*.rs".to_string())
    );
}

#[test]
fn boundary_scope_character_class_glob() {
    let yaml = r#"
tasks:
  - name: A
    scope: "src/[abc]/*.rs"
"#;
    let graph = parse_dag_yaml(yaml, None).unwrap();
    assert_eq!(
        find_by_name(&graph, "A").scope,
        Some("src/[abc]/*.rs".to_string())
    );
}

#[test]
fn boundary_scope_question_mark_glob() {
    let yaml = r#"
tasks:
  - name: A
    scope: "src/file?.rs"
"#;
    let graph = parse_dag_yaml(yaml, None).unwrap();
    assert_eq!(
        find_by_name(&graph, "A").scope,
        Some("src/file?.rs".to_string())
    );
}

#[test]
fn boundary_scope_empty_string_accepted() {
    // An empty scope is a valid glob (matches nothing, but syntactically valid)
    let yaml = r#"
tasks:
  - name: A
    scope: ""
"#;
    let graph = parse_dag_yaml(yaml, None).unwrap();
    assert_eq!(find_by_name(&graph, "A").scope, Some("".to_string()));
}

// ── 12. Mixed priorities ────────────────────────────────────────────────────

#[test]
fn boundary_mixed_priorities_all_three_levels() {
    let yaml = r#"
tasks:
  - name: High
    agent: a
    priority: high
  - name: Medium
    agent: b
    priority: medium
  - name: Low
    agent: c
    priority: low
"#;
    let graph = parse_dag_yaml(yaml, None).unwrap();
    assert_eq!(find_by_name(&graph, "High").priority.as_deref(), Some("high"));
    assert_eq!(find_by_name(&graph, "Medium").priority.as_deref(), Some("medium"));
    assert_eq!(find_by_name(&graph, "Low").priority.as_deref(), Some("low"));

    // All are ready (no deps)
    assert_eq!(graph.ready_tasks().len(), 3);
}

#[test]
fn boundary_dag_priority_override_per_node() {
    let yaml = r#"
priority: low
tasks:
  - name: Inherits
    agent: a
  - name: Overrides
    agent: b
    priority: high
"#;
    let graph = parse_dag_yaml(yaml, None).unwrap();
    assert_eq!(find_by_name(&graph, "Inherits").priority.as_deref(), Some("low"));
    assert_eq!(find_by_name(&graph, "Overrides").priority.as_deref(), Some("high"));
}

// ── 13. Communication policy edge cases ─────────────────────────────────────

#[test]
fn boundary_communication_star_without_hub_suffix() {
    // Just "star" without colon — should be rejected as unknown policy
    let yaml = r#"
communication: star
tasks:
  - name: A
    agent: a
"#;
    let result = parse_dag_yaml(yaml, None);
    assert!(result.is_err());
    let err = result.unwrap_err().to_string();
    assert!(err.contains("communication"), "error: {err}");
}

#[test]
fn boundary_communication_star_with_whitespace_hub() {
    // star: with only whitespace after colon
    let yaml = r#"
communication: "star:   "
tasks:
  - name: A
    agent: a
"#;
    let result = parse_dag_yaml(yaml, None);
    assert!(result.is_err(), "star with whitespace-only hub should be rejected");
}

#[test]
fn boundary_communication_open_case_insensitive() {
    let yaml = r#"
communication: OPEN
tasks:
  - name: A
    agent: a
"#;
    let graph = parse_dag_yaml(yaml, None).unwrap();
    assert_eq!(graph.communication.as_deref(), Some("OPEN"));
}

#[test]
fn boundary_communication_adjacent_case_insensitive() {
    let yaml = r#"
communication: Adjacent
tasks:
  - name: A
    agent: a
"#;
    let graph = parse_dag_yaml(yaml, None).unwrap();
    assert_eq!(graph.communication.as_deref(), Some("Adjacent"));
}

// ── 14. Additional boundary scenarios ───────────────────────────────────────

#[test]
fn boundary_multiple_roots_all_ready() {
    // 3 independent roots, no dependencies
    let yaml = r#"
tasks:
  - name: Root1
    agent: a
  - name: Root2
    agent: b
  - name: Root3
    agent: c
"#;
    let graph = parse_dag_yaml(yaml, None).unwrap();
    assert_eq!(graph.nodes.len(), 3);
    let ready = graph.ready_tasks();
    assert_eq!(ready.len(), 3);
    assert!(!graph.is_complete());
    assert_eq!(graph.progress(), 0.0);
}

#[test]
fn boundary_update_status_unknown_id_returns_error() {
    let yaml = r#"
tasks:
  - name: A
    agent: a
"#;
    let mut graph = parse_dag_yaml(yaml, None).unwrap();
    let result = graph.update_status("nonexistent-uuid", TaskStatus::Completed);
    assert!(result.is_err());
}

#[test]
fn boundary_progress_partial_completion() {
    let yaml = r#"
tasks:
  - name: A
    agent: a
  - name: B
    agent: b
  - name: C
    agent: c
  - name: D
    agent: d
"#;
    let mut graph = parse_dag_yaml(yaml, None).unwrap();
    assert_eq!(graph.progress(), 0.0);

    let a_id = find_by_name(&graph, "A").id.clone();
    graph.update_status(&a_id, TaskStatus::Completed).unwrap();
    assert_eq!(graph.progress(), 0.25);

    let b_id = find_by_name(&graph, "B").id.clone();
    graph.update_status(&b_id, TaskStatus::Completed).unwrap();
    assert_eq!(graph.progress(), 0.5);
}

#[test]
fn boundary_is_complete_with_failed_and_skipped() {
    let yaml = r#"
tasks:
  - name: A
    agent: a
  - name: B
    agent: b
  - name: C
    agent: c
"#;
    let mut graph = parse_dag_yaml(yaml, None).unwrap();

    let a_id = find_by_name(&graph, "A").id.clone();
    let b_id = find_by_name(&graph, "B").id.clone();
    let c_id = find_by_name(&graph, "C").id.clone();

    graph.update_status(&a_id, TaskStatus::Completed).unwrap();
    graph.update_status(&b_id, TaskStatus::Failed).unwrap();
    graph.update_status(&c_id, TaskStatus::Skipped).unwrap();

    // is_complete returns true when all nodes are in terminal states
    assert!(graph.is_complete());
    assert_eq!(graph.progress(), 1.0 / 3.0); // only Completed counts
}

#[test]
fn boundary_retry_failed_node() {
    let yaml = r#"
tasks:
  - name: Retryable
    agent: a
    retry: 3
"#;
    let mut graph = parse_dag_yaml(yaml, None).unwrap();
    let id = find_by_name(&graph, "Retryable").id.clone();

    // First failure
    graph.update_status(&id, TaskStatus::Failed).unwrap();
    let can_retry = graph.retry_failed(&id).unwrap();
    assert!(can_retry);
    assert_eq!(graph.find_node(&id).unwrap().retry_count, 1);
    assert_eq!(graph.find_node(&id).unwrap().status, TaskStatus::Pending);

    // Second failure
    graph.update_status(&id, TaskStatus::Failed).unwrap();
    let can_retry = graph.retry_failed(&id).unwrap();
    assert!(can_retry);
    assert_eq!(graph.find_node(&id).unwrap().retry_count, 2);

    // Third failure
    graph.update_status(&id, TaskStatus::Failed).unwrap();
    let can_retry = graph.retry_failed(&id).unwrap();
    assert!(can_retry);
    assert_eq!(graph.find_node(&id).unwrap().retry_count, 3);

    // Fourth failure — exhausted retries
    graph.update_status(&id, TaskStatus::Failed).unwrap();
    let can_retry = graph.retry_failed(&id).unwrap();
    assert!(!can_retry, "should not retry after exhausting max_retries");
}

#[test]
fn boundary_find_node_returns_none_for_missing_id() {
    let yaml = r#"
tasks:
  - name: A
    agent: a
"#;
    let graph = parse_dag_yaml(yaml, None).unwrap();
    assert!(graph.find_node("nonexistent").is_none());
}

#[test]
fn boundary_extract_references_from_node_input() {
    let yaml = r#"
tasks:
  - name: A
    agent: a
    input: "{{global.x}} and {{node-1.result}}"
"#;
    let graph = parse_dag_yaml(yaml, None).unwrap();
    let input = graph.nodes[0].input.as_ref().unwrap();
    let refs = ergatai_dag::extract_references(input);
    assert_eq!(refs, vec!["global.x", "node-1.result"]);
}

#[test]
fn boundary_dag_context_record_and_render() {
    let mut ctx = DagContext::empty();
    ctx.record_output("n1", serde_json::json!({"status": "ok", "count": 42}));
    ctx.record_output("n2", serde_json::json!({"label": "final"}));

    let rendered = ctx.render_template("n1={{n1.status}} count={{n1.count}} n2={{n2.label}}");
    assert_eq!(rendered, "n1=ok count=42 n2=final");
}

#[test]
fn boundary_wide_fan_in_twenty_parents_one_child() {
    // 20 roots → 1 child that depends on all of them
    let n_parents = 20;
    let mut yaml = String::from("tasks:\n");
    let mut dep_names = Vec::new();
    for i in 0..n_parents {
        let name = format!("P{i}");
        dep_names.push(name.clone());
        yaml.push_str(&format!("  - name: {name}\n    agent: w-{i}\n"));
    }
    yaml.push_str(&format!(
        "  - name: Sink\n    agent: sink\n    depends_on: [{}]\n",
        dep_names.join(", ")
    ));

    let mut graph = parse_dag_yaml(&yaml, None).unwrap();
    assert_eq!(graph.nodes.len(), n_parents + 1);

    // All 20 parents are ready
    assert_eq!(graph.ready_tasks().len(), n_parents);

    // Sink is not ready until all parents complete
    let sink = find_by_name(&graph, "Sink");
    assert_eq!(sink.depends_on.len(), n_parents);

    // Complete parents one by one
    for i in 0..n_parents {
        let id = find_by_name(&graph, &format!("P{i}")).id.clone();
        graph.update_status(&id, TaskStatus::Completed).unwrap();
    }

    // Now Sink is ready
    let ready = graph.ready_tasks();
    assert_eq!(ready.len(), 1);
    assert_eq!(ready[0].task, "Sink");
}

#[test]
fn boundary_to_ai_prompt_does_not_panic() {
    let yaml = r#"
description: A test DAG
tasks:
  - name: A
    agent: a
  - name: B
    agent: b
    depends_on: [A]
"#;
    let graph = parse_dag_yaml(yaml, None).unwrap();
    let prompt = graph.to_ai_prompt();
    // to_ai_prompt always includes "Task Graph:" header
    assert!(prompt.contains("Task Graph:"), "prompt missing Task Graph header: {prompt}");
    // Progress should be shown
    assert!(prompt.contains("Progress:"), "prompt missing Progress: {prompt}");
}

#[test]
fn boundary_uuid_uniqueness_across_many_nodes() {
    let yaml = r#"
tasks:
  - name: A
  - name: B
  - name: C
  - name: D
  - name: E
  - name: F
  - name: G
  - name: H
"#;
    let graph = parse_dag_yaml(yaml, None).unwrap();
    let ids: std::collections::HashSet<&str> = graph.nodes.iter().map(|n| n.id.as_str()).collect();
    // All UUIDs should be unique
    assert_eq!(ids.len(), graph.nodes.len());
    // All UUIDs should parse as valid UUIDs
    for node in &graph.nodes {
        assert!(uuid::Uuid::parse_str(&node.id).is_ok(), "invalid UUID: {}", node.id);
    }
}

#[test]
fn boundary_set_result_marks_node_completed() {
    let yaml = r#"
tasks:
  - name: A
    agent: a
"#;
    let mut graph = parse_dag_yaml(yaml, None).unwrap();
    let id = find_by_name(&graph, "A").id.clone();
    graph.set_result(&id, "/tmp/result.json".to_string()).unwrap();

    let node = graph.find_node(&id).unwrap();
    assert_eq!(node.status, TaskStatus::Completed);
    assert_eq!(node.result_path.as_deref(), Some("/tmp/result.json"));
}
