//! Integration tests for critical path calculation
//!
//! Tests various DAG topologies to ensure the Critical Path Method (CPM)
//! correctly identifies the longest execution path and calculates slack times.

use std::collections::HashMap;

use ergatai_dag::critical_path::{adjust_priority_with_critical_path, calculate_critical_path};
use ergatai_dag::dag_topology::{TaskComplexity, TaskGraph, TaskNode, TaskStatus};

/// Helper: create a TaskNode with default values
fn node(id: &str) -> TaskNode {
    TaskNode::new(id, "agent", format!("Task {}", id))
}

/// Helper: create a TaskNode with dependencies
fn node_with_deps(id: &str, deps: Vec<&str>) -> TaskNode {
    TaskNode::new(id, "agent", format!("Task {}", id))
        .with_dependencies(deps.into_iter().map(String::from).collect())
}

// ============================================================================
// Test 1: Linear chain (A→B→C→D)
// ============================================================================

#[test]
fn test_linear_chain_critical_path() {
    // Graph: A → B → C → D
    // Durations: A=5, B=10, C=3, D=7
    // Critical path: A → B → C → D (total: 25s)
    // All nodes have slack=0 (all on critical path)

    let graph = TaskGraph::new(vec![
        node("A"),
        node_with_deps("B", vec!["A"]),
        node_with_deps("C", vec!["B"]),
        node_with_deps("D", vec!["C"]),
    ]);

    let mut durations = HashMap::new();
    durations.insert("A".to_string(), 5);
    durations.insert("B".to_string(), 10);
    durations.insert("C".to_string(), 3);
    durations.insert("D".to_string(), 7);

    let result = calculate_critical_path(&graph, &durations).unwrap();

    // Total duration should be sum of all: 5+10+3+7 = 25
    assert_eq!(result.total_duration, 25);

    // All nodes should be on critical path
    assert_eq!(result.critical_path.len(), 4);
    assert!(result.critical_path.contains(&"A".to_string()));
    assert!(result.critical_path.contains(&"B".to_string()));
    assert!(result.critical_path.contains(&"C".to_string()));
    assert!(result.critical_path.contains(&"D".to_string()));

    // All nodes should have slack=0
    assert_eq!(result.slack_times.get("A"), Some(&0));
    assert_eq!(result.slack_times.get("B"), Some(&0));
    assert_eq!(result.slack_times.get("C"), Some(&0));
    assert_eq!(result.slack_times.get("D"), Some(&0));

    // Verify earliest start times
    assert_eq!(result.earliest_start.get("A"), Some(&0));
    assert_eq!(result.earliest_start.get("B"), Some(&5)); // after A (5)
    assert_eq!(result.earliest_start.get("C"), Some(&15)); // after A+B (5+10)
    assert_eq!(result.earliest_start.get("D"), Some(&18)); // after A+B+C (5+10+3)
}

// ============================================================================
// Test 2: Diamond graph (A→B,C; B,C→D)
// ============================================================================

#[test]
fn test_diamond_graph_heavier_left_branch() {
    // Graph:
    //     A
    //    / \
    //   B   C
    //    \ /
    //     D
    //
    // Durations: A=5, B=20, C=10, D=5
    // Critical path: A → B → D (total: 30s)
    // C has slack = 10s (can be delayed by 10s without affecting total)

    let graph = TaskGraph::new(vec![
        node("A"),
        node_with_deps("B", vec!["A"]),
        node_with_deps("C", vec!["A"]),
        node_with_deps("D", vec!["B", "C"]),
    ]);

    let mut durations = HashMap::new();
    durations.insert("A".to_string(), 5);
    durations.insert("B".to_string(), 20);
    durations.insert("C".to_string(), 10);
    durations.insert("D".to_string(), 5);

    let result = calculate_critical_path(&graph, &durations).unwrap();

    // Total duration: A(5) + B(20) + D(5) = 30
    assert_eq!(result.total_duration, 30);

    // Critical path should include A, B, D (not C)
    assert_eq!(result.critical_path.len(), 3);
    assert!(result.critical_path.contains(&"A".to_string()));
    assert!(result.critical_path.contains(&"B".to_string()));
    assert!(result.critical_path.contains(&"D".to_string()));
    assert!(!result.critical_path.contains(&"C".to_string()));

    // C should have slack = 10
    // C EST = 5 (after A), LST = 15 (D starts at 25, C takes 10, so latest start = 15)
    // Slack = LST - EST = 15 - 5 = 10
    assert_eq!(result.slack_times.get("C"), Some(&10));

    // Critical path nodes should have slack=0
    assert_eq!(result.slack_times.get("A"), Some(&0));
    assert_eq!(result.slack_times.get("B"), Some(&0));
    assert_eq!(result.slack_times.get("D"), Some(&0));
}

#[test]
fn test_diamond_graph_heavier_right_branch() {
    // Same diamond but C is heavier than B
    // Durations: A=5, B=10, C=20, D=5
    // Critical path: A → C → D (total: 30s)
    // B has slack = 10s

    let graph = TaskGraph::new(vec![
        node("A"),
        node_with_deps("B", vec!["A"]),
        node_with_deps("C", vec!["A"]),
        node_with_deps("D", vec!["B", "C"]),
    ]);

    let mut durations = HashMap::new();
    durations.insert("A".to_string(), 5);
    durations.insert("B".to_string(), 10);
    durations.insert("C".to_string(), 20);
    durations.insert("D".to_string(), 5);

    let result = calculate_critical_path(&graph, &durations).unwrap();

    assert_eq!(result.total_duration, 30);

    // Critical path should include A, C, D (not B)
    assert!(result.critical_path.contains(&"A".to_string()));
    assert!(!result.critical_path.contains(&"B".to_string()));
    assert!(result.critical_path.contains(&"C".to_string()));
    assert!(result.critical_path.contains(&"D".to_string()));

    // B should have slack = 10
    assert_eq!(result.slack_times.get("B"), Some(&10));
}

// ============================================================================
// Test 3: Parallel independent paths
// ============================================================================

#[test]
fn test_parallel_independent_paths() {
    // Graph: A→B and C→D (no dependencies between them)
    // Path 1: A(5) → B(10) = 15s total
    // Path 2: C(3) → D(7) = 10s total
    // Critical path: A → B (longer path, total: 15s)
    // C and D have slack = 5s

    let graph = TaskGraph::new(vec![
        node("A"),
        node_with_deps("B", vec!["A"]),
        node("C"),
        node_with_deps("D", vec!["C"]),
    ]);

    let mut durations = HashMap::new();
    durations.insert("A".to_string(), 5);
    durations.insert("B".to_string(), 10);
    durations.insert("C".to_string(), 3);
    durations.insert("D".to_string(), 7);

    let result = calculate_critical_path(&graph, &durations).unwrap();

    // Total duration should be max(15, 10) = 15
    assert_eq!(result.total_duration, 15);

    // Critical path should be A → B
    assert_eq!(result.critical_path.len(), 2);
    assert!(result.critical_path.contains(&"A".to_string()));
    assert!(result.critical_path.contains(&"B".to_string()));

    // C and D should have slack = 5
    // C: EST=0, LST=5, slack=5
    // D: EST=3, LST=8, slack=5
    assert_eq!(result.slack_times.get("C"), Some(&5));
    assert_eq!(result.slack_times.get("D"), Some(&5));
}

#[test]
fn test_parallel_paths_equal_length() {
    // Graph: A→B and C→D (no dependencies)
    // Path 1: A(5) → B(10) = 15s total
    // Path 2: C(5) → D(10) = 15s total
    // Both paths are critical (tie-breaking scenario)

    let graph = TaskGraph::new(vec![
        node("A"),
        node_with_deps("B", vec!["A"]),
        node("C"),
        node_with_deps("D", vec!["C"]),
    ]);

    let mut durations = HashMap::new();
    durations.insert("A".to_string(), 5);
    durations.insert("B".to_string(), 10);
    durations.insert("C".to_string(), 5);
    durations.insert("D".to_string(), 10);

    let result = calculate_critical_path(&graph, &durations).unwrap();

    // Total duration should be 15 (both paths)
    assert_eq!(result.total_duration, 15);

    // All nodes should be on critical path (all have slack=0)
    assert_eq!(result.critical_path.len(), 4);
    assert!(result.critical_path.contains(&"A".to_string()));
    assert!(result.critical_path.contains(&"B".to_string()));
    assert!(result.critical_path.contains(&"C".to_string()));
    assert!(result.critical_path.contains(&"D".to_string()));

    // All nodes should have slack=0
    assert_eq!(result.slack_times.get("A"), Some(&0));
    assert_eq!(result.slack_times.get("B"), Some(&0));
    assert_eq!(result.slack_times.get("C"), Some(&0));
    assert_eq!(result.slack_times.get("D"), Some(&0));
}

// ============================================================================
// Test 4: Single node
// ============================================================================

#[test]
fn test_single_node_graph() {
    // Graph: just node A
    // Duration: A=10
    // Critical path: A (total: 10s)

    let graph = TaskGraph::new(vec![node("A")]);

    let mut durations = HashMap::new();
    durations.insert("A".to_string(), 10);

    let result = calculate_critical_path(&graph, &durations).unwrap();

    assert_eq!(result.total_duration, 10);
    assert_eq!(result.critical_path.len(), 1);
    assert!(result.critical_path.contains(&"A".to_string()));
    assert_eq!(result.slack_times.get("A"), Some(&0));
    assert_eq!(result.earliest_start.get("A"), Some(&0));
    assert_eq!(result.latest_start.get("A"), Some(&0));
}

// ============================================================================
// Test 5: Wide fan-out (A→B,C,D,E,F)
// ============================================================================

#[test]
fn test_wide_fan_out_one_heavy_branch() {
    // Graph: A → B, C, D, E, F (A fans out to 5 nodes)
    // Durations: A=5, B=3, C=3, D=20, E=3, F=3
    // Critical path: A → D (total: 25s)
    // B, C, E, F all have slack = 17s

    let graph = TaskGraph::new(vec![
        node("A"),
        node_with_deps("B", vec!["A"]),
        node_with_deps("C", vec!["A"]),
        node_with_deps("D", vec!["A"]),
        node_with_deps("E", vec!["A"]),
        node_with_deps("F", vec!["A"]),
    ]);

    let mut durations = HashMap::new();
    durations.insert("A".to_string(), 5);
    durations.insert("B".to_string(), 3);
    durations.insert("C".to_string(), 3);
    durations.insert("D".to_string(), 20);
    durations.insert("E".to_string(), 3);
    durations.insert("F".to_string(), 3);

    let result = calculate_critical_path(&graph, &durations).unwrap();

    // Total duration: A(5) + D(20) = 25
    assert_eq!(result.total_duration, 25);

    // Critical path should be A → D
    assert_eq!(result.critical_path.len(), 2);
    assert!(result.critical_path.contains(&"A".to_string()));
    assert!(result.critical_path.contains(&"D".to_string()));

    // B, C, E, F should all have slack = 17
    // They can all start at EST=5, but latest start = 22 (since D finishes at 25)
    // LST = 22, EST = 5, slack = 17
    assert_eq!(result.slack_times.get("B"), Some(&17));
    assert_eq!(result.slack_times.get("C"), Some(&17));
    assert_eq!(result.slack_times.get("E"), Some(&17));
    assert_eq!(result.slack_times.get("F"), Some(&17));
}

#[test]
fn test_wide_fan_out_all_equal() {
    // Graph: A → B, C, D, E (all branches equal weight)
    // Durations: A=5, B=10, C=10, D=10, E=10
    // All paths A→X have same duration (15s)
    // All nodes are critical

    let graph = TaskGraph::new(vec![
        node("A"),
        node_with_deps("B", vec!["A"]),
        node_with_deps("C", vec!["A"]),
        node_with_deps("D", vec!["A"]),
        node_with_deps("E", vec!["A"]),
    ]);

    let mut durations = HashMap::new();
    durations.insert("A".to_string(), 5);
    durations.insert("B".to_string(), 10);
    durations.insert("C".to_string(), 10);
    durations.insert("D".to_string(), 10);
    durations.insert("E".to_string(), 10);

    let result = calculate_critical_path(&graph, &durations).unwrap();

    assert_eq!(result.total_duration, 15);

    // All nodes should be on critical path
    assert_eq!(result.critical_path.len(), 5);
    assert!(result.critical_path.contains(&"A".to_string()));
    assert!(result.critical_path.contains(&"B".to_string()));
    assert!(result.critical_path.contains(&"C".to_string()));
    assert!(result.critical_path.contains(&"D".to_string()));
    assert!(result.critical_path.contains(&"E".to_string()));

    // All slack should be 0
    for node_id in ["A", "B", "C", "D", "E"] {
        assert_eq!(result.slack_times.get(node_id), Some(&0));
    }
}

// ============================================================================
// Test 6: Tie-breaking scenarios
// ============================================================================

#[test]
fn test_tie_breaking_two_equal_paths() {
    // Already tested in test_parallel_paths_equal_length
    // This adds another scenario: diamond with equal branches

    let graph = TaskGraph::new(vec![
        node("A"),
        node_with_deps("B", vec!["A"]),
        node_with_deps("C", vec!["A"]),
        node_with_deps("D", vec!["B", "C"]),
    ]);

    let mut durations = HashMap::new();
    durations.insert("A".to_string(), 5);
    durations.insert("B".to_string(), 10);
    durations.insert("C".to_string(), 10);
    durations.insert("D".to_string(), 5);

    let result = calculate_critical_path(&graph, &durations).unwrap();

    // Total: 20s (both paths equal)
    assert_eq!(result.total_duration, 20);

    // All nodes should be on critical path (all slack=0)
    assert_eq!(result.critical_path.len(), 4);

    // All slack should be 0
    assert_eq!(result.slack_times.get("B"), Some(&0));
    assert_eq!(result.slack_times.get("C"), Some(&0));
}

#[test]
fn test_tie_breaking_with_multiple_paths() {
    // More complex: 3 independent paths, 2 are equal length
    // Path 1: A→B (15s)
    // Path 2: C→D (15s)
    // Path 3: E→F (10s)

    let graph = TaskGraph::new(vec![
        node("A"),
        node_with_deps("B", vec!["A"]),
        node("C"),
        node_with_deps("D", vec!["C"]),
        node("E"),
        node_with_deps("F", vec!["E"]),
    ]);

    let mut durations = HashMap::new();
    durations.insert("A".to_string(), 5);
    durations.insert("B".to_string(), 10);
    durations.insert("C".to_string(), 5);
    durations.insert("D".to_string(), 10);
    durations.insert("E".to_string(), 3);
    durations.insert("F".to_string(), 7);

    let result = calculate_critical_path(&graph, &durations).unwrap();

    // Total duration should be 15 (max of all paths)
    assert_eq!(result.total_duration, 15);

    // Path 1 and Path 2 should be critical
    assert!(result.critical_path.contains(&"A".to_string()));
    assert!(result.critical_path.contains(&"B".to_string()));
    assert!(result.critical_path.contains(&"C".to_string()));
    assert!(result.critical_path.contains(&"D".to_string()));

    // Path 3 should have slack
    // E: EST=0, LST=5, slack=5
    // F: EST=3, LST=8, slack=5
    assert_eq!(result.slack_times.get("E"), Some(&5));
    assert_eq!(result.slack_times.get("F"), Some(&5));
}

// ============================================================================
// Test 7: adjust_priority_with_critical_path
// ============================================================================

#[test]
fn test_adjust_priority_critical_path_nodes() {
    // Nodes on critical path should get +10 priority boost

    let graph = TaskGraph::new(vec![
        node("A"),
        node_with_deps("B", vec!["A"]),
        node_with_deps("C", vec!["A"]),
        node_with_deps("D", vec!["B", "C"]),
    ]);

    let mut durations = HashMap::new();
    durations.insert("A".to_string(), 5);
    durations.insert("B".to_string(), 20);
    durations.insert("C".to_string(), 10);
    durations.insert("D".to_string(), 5);

    let result = calculate_critical_path(&graph, &durations).unwrap();

    let base_priority = 5;

    // A is on critical path: 5 + 10 = 15
    let node_a = graph.nodes.iter().find(|n| n.id == "A").unwrap();
    let adjusted_a = adjust_priority_with_critical_path(node_a, &result, base_priority);
    assert_eq!(adjusted_a, 15);

    // B is on critical path: 5 + 10 = 15
    let node_b = graph.nodes.iter().find(|n| n.id == "B").unwrap();
    let adjusted_b = adjust_priority_with_critical_path(node_b, &result, base_priority);
    assert_eq!(adjusted_b, 15);

    // D is on critical path: 5 + 10 = 15
    let node_d = graph.nodes.iter().find(|n| n.id == "D").unwrap();
    let adjusted_d = adjust_priority_with_critical_path(node_d, &result, base_priority);
    assert_eq!(adjusted_d, 15);
}

#[test]
fn test_adjust_priority_non_critical_path_nodes() {
    // Nodes NOT on critical path get priority based on slack:
    // - slack=0 → +10 (shouldn't happen for non-critical, but test the logic)
    // - slack<10 → +5
    // - slack>=10 → +0

    let graph = TaskGraph::new(vec![
        node("A"),
        node_with_deps("B", vec!["A"]),
        node_with_deps("C", vec!["A"]),
        node_with_deps("D", vec!["B", "C"]),
    ]);

    let mut durations = HashMap::new();
    durations.insert("A".to_string(), 5);
    durations.insert("B".to_string(), 20);
    durations.insert("C".to_string(), 10);
    durations.insert("D".to_string(), 5);

    let result = calculate_critical_path(&graph, &durations).unwrap();

    let base_priority = 5;

    // C is NOT on critical path, slack=10
    // slack >= 10 → +0, so adjusted = 5
    let node_c = graph.nodes.iter().find(|n| n.id == "C").unwrap();
    let adjusted_c = adjust_priority_with_critical_path(node_c, &result, base_priority);
    assert_eq!(adjusted_c, 5);
}

#[test]
fn test_adjust_priority_slack_thresholds() {
    // Test the three slack thresholds:
    // - slack=0 → +10
    // - slack<10 → +5
    // - slack>=10 → +0

    // Create a graph where we can control slack values
    let graph = TaskGraph::new(vec![
        node("A"),
        node_with_deps("B", vec!["A"]),
        node_with_deps("C", vec!["A"]),
        node_with_deps("D", vec!["B"]),
    ]);

    // Path A→B→D: 5+15+5 = 25s
    // Path A→C: 5+5 = 10s
    // C has slack = 25 - 10 = 15s (>= 10, so +0)

    let mut durations = HashMap::new();
    durations.insert("A".to_string(), 5);
    durations.insert("B".to_string(), 15);
    durations.insert("C".to_string(), 5);
    durations.insert("D".to_string(), 5);

    let result = calculate_critical_path(&graph, &durations).unwrap();

    let base_priority = 10;

    // A, B, D are critical (slack=0): 10 + 10 = 20
    let node_a = graph.nodes.iter().find(|n| n.id == "A").unwrap();
    assert_eq!(
        adjust_priority_with_critical_path(node_a, &result, base_priority),
        20
    );

    let node_b = graph.nodes.iter().find(|n| n.id == "B").unwrap();
    assert_eq!(
        adjust_priority_with_critical_path(node_b, &result, base_priority),
        20
    );

    let node_d = graph.nodes.iter().find(|n| n.id == "D").unwrap();
    assert_eq!(
        adjust_priority_with_critical_path(node_d, &result, base_priority),
        20
    );

    // C has slack=15 (>= 10): 10 + 0 = 10
    let node_c = graph.nodes.iter().find(|n| n.id == "C").unwrap();
    assert_eq!(
        adjust_priority_with_critical_path(node_c, &result, base_priority),
        10
    );
}

#[test]
fn test_adjust_priority_slack_less_than_10() {
    // Test slack < 10 case: should get +5

    let graph = TaskGraph::new(vec![
        node("A"),
        node_with_deps("B", vec!["A"]),
        node_with_deps("C", vec!["A"]),
        node_with_deps("D", vec!["B", "C"]),
    ]);

    // Path A→B→D: 5+10+5 = 20s
    // Path A→C→D: 5+5+5 = 15s
    // C has slack = 20 - 15 = 5s (< 10, so +5)

    let mut durations = HashMap::new();
    durations.insert("A".to_string(), 5);
    durations.insert("B".to_string(), 10);
    durations.insert("C".to_string(), 5);
    durations.insert("D".to_string(), 5);

    let result = calculate_critical_path(&graph, &durations).unwrap();

    let base_priority = 5;

    // C has slack=5 (< 10): 5 + 5 = 10
    let node_c = graph.nodes.iter().find(|n| n.id == "C").unwrap();
    let adjusted_c = adjust_priority_with_critical_path(node_c, &result, base_priority);
    assert_eq!(adjusted_c, 10);
}

// ============================================================================
// Test 8: Edge cases
// ============================================================================

#[test]
fn test_empty_graph_returns_none() {
    let graph = TaskGraph::new(vec![]);
    let durations = HashMap::new();

    let result = calculate_critical_path(&graph, &durations);

    assert!(result.is_none());
}

#[test]
fn test_skipped_nodes_excluded_from_critical_path() {
    // Graph: A → B → D, A → C → D
    // C is skipped
    // Critical path should be A → B → D (skipping C)

    let mut graph = TaskGraph::new(vec![
        node("A"),
        node_with_deps("B", vec!["A"]),
        node_with_deps("C", vec!["A"]),
        node_with_deps("D", vec!["B", "C"]),
    ]);

    // Mark C as skipped
    graph.update_status("C", TaskStatus::Skipped).unwrap();

    let mut durations = HashMap::new();
    durations.insert("A".to_string(), 5);
    durations.insert("B".to_string(), 10);
    durations.insert("C".to_string(), 20); // Would be critical if not skipped
    durations.insert("D".to_string(), 5);

    let result = calculate_critical_path(&graph, &durations).unwrap();

    // Total duration: A(5) + B(10) + D(5) = 20
    assert_eq!(result.total_duration, 20);

    // Critical path should not include C (it's skipped)
    assert!(!result.critical_path.contains(&"C".to_string()));
    assert!(result.critical_path.contains(&"A".to_string()));
    assert!(result.critical_path.contains(&"B".to_string()));
    assert!(result.critical_path.contains(&"D".to_string()));
}

#[test]
fn test_default_duration_when_not_specified() {
    // When a node's duration is not in the map, it defaults to 10s

    let graph = TaskGraph::new(vec![node("A"), node_with_deps("B", vec!["A"])]);

    let mut durations = HashMap::new();
    durations.insert("A".to_string(), 5);
    // B's duration not specified, should default to 10

    let result = calculate_critical_path(&graph, &durations).unwrap();

    // Total: A(5) + B(10) = 15
    assert_eq!(result.total_duration, 15);
}

#[test]
fn test_complex_multi_level_dag() {
    // More complex DAG with multiple levels:
    //        A
    //       / \
    //      B   C
    //     /|   |\
    //    D E   F G
    //     \|   |/
    //      H   I
    //       \ /
    //        J
    //
    // Critical path should be the longest path through this DAG

    let graph = TaskGraph::new(vec![
        node("A"),
        node_with_deps("B", vec!["A"]),
        node_with_deps("C", vec!["A"]),
        node_with_deps("D", vec!["B"]),
        node_with_deps("E", vec!["B"]),
        node_with_deps("F", vec!["C"]),
        node_with_deps("G", vec!["C"]),
        node_with_deps("H", vec!["D", "E"]),
        node_with_deps("I", vec!["F", "G"]),
        node_with_deps("J", vec!["H", "I"]),
    ]);

    let mut durations = HashMap::new();
    durations.insert("A".to_string(), 5);
    durations.insert("B".to_string(), 10);
    durations.insert("C".to_string(), 3);
    durations.insert("D".to_string(), 8);
    durations.insert("E".to_string(), 2);
    durations.insert("F".to_string(), 15);
    durations.insert("G".to_string(), 5);
    durations.insert("H".to_string(), 7);
    durations.insert("I".to_string(), 10);
    durations.insert("J".to_string(), 5);

    let result = calculate_critical_path(&graph, &durations).unwrap();

    // Path through B-D-H: 5+10+8+7+5 = 35
    // Path through B-E-H: 5+10+2+7+5 = 29
    // Path through C-F-I: 5+3+15+10+5 = 38
    // Path through C-G-I: 5+3+5+10+5 = 28
    // Critical path should be A→C→F→I→J (38s)

    assert_eq!(result.total_duration, 38);
    assert!(result.critical_path.contains(&"A".to_string()));
    assert!(result.critical_path.contains(&"C".to_string()));
    assert!(result.critical_path.contains(&"F".to_string()));
    assert!(result.critical_path.contains(&"I".to_string()));
    assert!(result.critical_path.contains(&"J".to_string()));

    // B, D, E, G, H should not be on critical path
    assert!(!result.critical_path.contains(&"B".to_string()));
    assert!(!result.critical_path.contains(&"D".to_string()));
    assert!(!result.critical_path.contains(&"E".to_string()));
    assert!(!result.critical_path.contains(&"G".to_string()));
    assert!(!result.critical_path.contains(&"H".to_string()));
}
