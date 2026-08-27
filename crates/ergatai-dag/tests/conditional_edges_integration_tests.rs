//! Integration tests for Conditional Edges feature
//!
//! Tests the complete flow: YAML parsing → TaskNode with conditional_edges → DagContext evaluation

use ergatai_dag::{parse_dag_yaml, ConditionBranch, ConditionalEdge, DagContext};
use serde_json::json;

#[test]
fn test_yaml_with_conditional_edges() {
    let yaml = r#"
name: test-dag
tasks:
  - name: review
    agent: reviewer
    task: tasks/review.md

  - name: deploy-prod
    agent: deployer
    task: tasks/deploy-prod.md
    depends_on: [review]

  - name: deploy-staging
    agent: deployer
    task: tasks/deploy-staging.md
    depends_on: [review]

  - name: deploy
    agent: deployer
    task: tasks/deploy.md
    conditional_edges:
      name: deploy-decision
      branches:
        - condition: '{{review.status}} == "approved"'
          target: deploy-prod
        - condition: '{{review.status}} == "conditional"'
          target: deploy-staging
      default_target: deploy-staging
"#;

    let graph = parse_dag_yaml(yaml, None).expect("Failed to parse YAML");
    assert_eq!(graph.nodes.len(), 4);

    // Find the deploy node - it should have task="tasks/deploy.md"
    // But since UUIDs are used for IDs, we need to find by checking which node has conditional_edges
    let deploy_node = graph
        .nodes
        .iter()
        .find(|n| n.conditional_edges.is_some())
        .expect("deploy node with conditional_edges not found");

    assert!(deploy_node.conditional_edges.is_some());

    let cond_edges = deploy_node.conditional_edges.as_ref().unwrap();
    assert_eq!(cond_edges.name, "deploy-decision");
    assert_eq!(cond_edges.branches.len(), 2);
    assert_eq!(cond_edges.default_target, "deploy-staging");

    // Verify first branch
    assert_eq!(
        cond_edges.branches[0].condition,
        "{{review.status}} == \"approved\""
    );
    assert_eq!(cond_edges.branches[0].target, "deploy-prod");

    // Verify second branch
    assert_eq!(
        cond_edges.branches[1].condition,
        "{{review.status}} == \"conditional\""
    );
    assert_eq!(cond_edges.branches[1].target, "deploy-staging");
}

#[test]
fn test_yaml_without_conditional_edges_backward_compatible() {
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
    assert!(node.conditional_edges.is_none()); // Should be None for backward compatibility
}

#[test]
fn test_conditional_edge_evaluate_first_branch() {
    let mut ctx = DagContext::empty();

    // Set up context with review status = "approved"
    ctx.record_output(
        "review",
        json!({
            "status": "approved"
        }),
    );

    let cond_edges = ConditionalEdge {
        name: "deploy-decision".to_string(),
        branches: vec![
            ConditionBranch {
                condition: "{{review.status}} == \"approved\"".to_string(),
                target: "deploy-prod".to_string(),
            },
            ConditionBranch {
                condition: "{{review.status}} == \"conditional\"".to_string(),
                target: "deploy-staging".to_string(),
            },
        ],
        default_target: "deploy-staging".to_string(),
    };

    let selected = cond_edges.evaluate(&ctx);
    assert_eq!(selected, "deploy-prod");
}

#[test]
fn test_conditional_edge_evaluate_second_branch() {
    let mut ctx = DagContext::empty();

    // Set up context with review status = "conditional"
    ctx.record_output(
        "review",
        json!({
            "status": "conditional"
        }),
    );

    let cond_edges = ConditionalEdge {
        name: "deploy-decision".to_string(),
        branches: vec![
            ConditionBranch {
                condition: "{{review.status}} == \"approved\"".to_string(),
                target: "deploy-prod".to_string(),
            },
            ConditionBranch {
                condition: "{{review.status}} == \"conditional\"".to_string(),
                target: "deploy-staging".to_string(),
            },
        ],
        default_target: "deploy-staging".to_string(),
    };

    let selected = cond_edges.evaluate(&ctx);
    assert_eq!(selected, "deploy-staging");
}

#[test]
fn test_conditional_edge_evaluate_default_branch() {
    let mut ctx = DagContext::empty();

    // Set up context with review status = "rejected" (doesn't match any branch)
    ctx.record_output(
        "review",
        json!({
            "status": "rejected"
        }),
    );

    let cond_edges = ConditionalEdge {
        name: "deploy-decision".to_string(),
        branches: vec![
            ConditionBranch {
                condition: "{{review.status}} == \"approved\"".to_string(),
                target: "deploy-prod".to_string(),
            },
            ConditionBranch {
                condition: "{{review.status}} == \"conditional\"".to_string(),
                target: "deploy-staging".to_string(),
            },
        ],
        default_target: "skip-deploy".to_string(),
    };

    let selected = cond_edges.evaluate(&ctx);
    assert_eq!(selected, "skip-deploy"); // Should use default_target
}

#[test]
fn test_conditional_edge_with_numeric_comparison() {
    let mut ctx = DagContext::empty();

    // Set up context with issue count
    ctx.record_output(
        "review",
        json!({
            "issue_count": 5
        }),
    );

    let cond_edges = ConditionalEdge {
        name: "fix-decision".to_string(),
        branches: vec![
            ConditionBranch {
                condition: "{{review.issue_count}} > 10".to_string(),
                target: "major-refactor".to_string(),
            },
            ConditionBranch {
                condition: "{{review.issue_count}} > 0".to_string(),
                target: "minor-fixes".to_string(),
            },
        ],
        default_target: "no-fixes".to_string(),
    };

    let selected = cond_edges.evaluate(&ctx);
    assert_eq!(selected, "minor-fixes"); // 5 > 0 but not > 10
}

#[test]
fn test_conditional_edge_with_logical_operators() {
    let mut ctx = DagContext::empty();

    // Set up context with multiple conditions
    ctx.record_output(
        "review",
        json!({
            "status": "approved",
            "tests_passed": true
        }),
    );

    let cond_edges = ConditionalEdge {
        name: "deploy-decision".to_string(),
        branches: vec![ConditionBranch {
            condition: "{{review.status}} == \"approved\" && {{review.tests_passed}} == true"
                .to_string(),
            target: "deploy-prod".to_string(),
        }],
        default_target: "skip-deploy".to_string(),
    };

    let selected = cond_edges.evaluate(&ctx);
    assert_eq!(selected, "deploy-prod");
}
