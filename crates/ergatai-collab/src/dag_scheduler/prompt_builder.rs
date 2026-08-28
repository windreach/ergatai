//! Prompt construction for DAG node execution.
//!
//! Builds the markdown plan file that gets written to `.ergatai/.dag-plans/{node_id}.md`
//! and read by the agent as its task document. This includes:
//!
//! - `generate_node_plan`: the top-level plan file (calls the two helpers below)
//! - `build_upstream_context_block`: markdown sections for upstream dependency outputs
//! - `build_dag_overview_block`: participants, topology, agent's position
//!
//! These methods are pure readers of `graph`, `context`, and `project_root` —
//! they don't mutate scheduler state.

use ergatai_dag::{TaskNode, TaskStatus};
use ergatai_error::ErgataiResult;

use super::DagScheduler;

impl DagScheduler {
    /// Generate the plan file for a node.
    ///
    /// This is where data flow happens: we read the task document (if present),
    /// render all `{{var}}` templates against the current `DagContext` (global
    /// vars + upstream outputs), and include upstream dependency context so the
    /// agent can see what previous nodes produced.
    pub(super) async fn generate_node_plan(
        &self,
        node: &TaskNode,
    ) -> ErgataiResult<std::path::PathBuf> {
        let plan_dir = self.project_root.join(".ergatai").join(".dag-plans");
        tokio::fs::create_dir_all(&plan_dir).await?;

        let plan_file = plan_dir.join(format!("{}.md", node.id));

        // 1. Render the node's input template (if any)
        let rendered_input = if let Some(ref input_tmpl) = node.input {
            let ctx = self.context.lock().await;
            Some(ctx.render_template(input_tmpl))
        } else {
            None
        };

        // 2. Read upstream dependency outputs from the context
        let upstream_context = self.build_upstream_context_block(node).await;

        // 2b. Build DAG overview (participants, topology, policy, agent position)
        let dag_overview = self.build_dag_overview_block(node).await;

        // 2c. Build expected_outputs line (if declared)
        let expected_outputs_line = if node.expected_outputs.is_empty() {
            String::new()
        } else {
            let descs: Vec<String> = node
                .expected_outputs
                .iter()
                .map(|(k, v)| format!("{} ({})", k, v))
                .collect();
            format!("- **Expected Outputs**: {}", descs.join(", "))
        };

        // 2d. Build retry context (if this is a retry attempt)
        let retry_context = if node.retry_count > 0 {
            if let Some(last_error) = node.metadata.get("last_error") {
                format!(
                    "\n## ⚠️ Previous Attempt Failed (retry {}/{})\n\n\
                     **Error**: {}\n\n\
                     Please investigate the cause of the previous failure before retrying.\n",
                    node.retry_count, node.max_retries, last_error
                )
            } else {
                String::new()
            }
        } else {
            String::new()
        };

        // 3. Resolve task description:
        //    - If `task` field exists in YAML, it's stored in metadata["task_path"]
        //    - Try to read it as a file path first
        //    - If file read fails, treat it as inline text description
        //    - If `task` field doesn't exist, use task name
        tracing::info!(
            node_id = %node.id,
            has_task_path = node.metadata.contains_key("task_path"),
            task_path_preview = node.metadata.get("task_path").map(|s| s.chars().take(50).collect::<String>()),
            "Resolving task description"
        );
        let task_description = if let Some(task_value) = node.metadata.get("task_path") {
            // Try as file path first.
            //
            // SECURITY: task_value comes from untrusted YAML metadata submitted by
            // agents. A malicious agent could set `task: "../../../etc/passwd"` to
            // read arbitrary files via the scheduler (whose PID is auto-allowed by
            // the fanotify enforcer). Canonicalize and verify containment before
            // reading. If the file doesn't exist or escapes project_root, fall
            // through to the inline-description treatment.
            let full_path = self.project_root.join(task_value);
            let safe_path: Option<std::path::PathBuf> = match tokio::fs::canonicalize(&full_path)
                .await
            {
                Ok(resolved) => {
                    let canonical_root = tokio::fs::canonicalize(&self.project_root).await.ok();
                    match canonical_root {
                        Some(root) if resolved.starts_with(&root) => Some(resolved),
                        Some(root) => {
                            tracing::warn!(
                                node_id = %node.id,
                                task_path = %task_value,
                                resolved = %resolved.display(),
                                root = %root.display(),
                                "Task path escapes project_root — rejected, treating as inline description"
                            );
                            None
                        }
                        None => {
                            // Can't resolve root — treat as inline to be safe
                            None
                        }
                    }
                }
                Err(_) => {
                    // File doesn't exist — fall through to inline treatment
                    None
                }
            };

            if let Some(path) = safe_path {
                tracing::info!(
                    node_id = %node.id,
                    full_path = %path.display(),
                    "Attempting to read task file"
                );
                match tokio::fs::read_to_string(&path).await {
                    Ok(content) => {
                        tracing::info!(
                            node_id = %node.id,
                            task_path = %task_value,
                            "Read task description from file ({}B)",
                            content.len()
                        );
                        content
                    }
                    Err(e) => {
                        tracing::info!(
                            node_id = %node.id,
                            error = %e,
                            "Task field treated as inline description ({}B)",
                            task_value.len()
                        );
                        task_value.clone()
                    }
                }
            } else {
                // Canonicalization failed (file doesn't exist) or path escaped root
                tracing::info!(
                    node_id = %node.id,
                    "Task field treated as inline description ({}B)",
                    task_value.len()
                );
                task_value.clone()
            }
        } else {
            // No task field - use task name
            tracing::info!(
                node_id = %node.id,
                "No task_path in metadata, using task name"
            );
            node.task.clone()
        };

        // 4. Build the plan content
        // Use the SAME result path convention as TaskCoordinator::get_result_path()
        // so the agent-exit watcher finds the result file when checking RunningAgent.result_file.
        // Path: .ergatai/.plan/results/{node_id}-{agent_name}.md
        let result_path = format!(".ergatai/.plan/results/{}-{}.md", node.id, node.agent);
        let content = format!(
            r#"# Task: {}

### @{} - {}
- **Objective**: {}
- **Type**: {}
- **Result**: {}
{}
{}
{}
{}

{}

## Detailed Description

{}
"#,
            node.task,
            node.agent,
            node.id,
            node.task,
            "CreateNew",
            result_path,
            rendered_input
                .as_ref()
                .map(|s| format!("- **Input**: {}", s))
                .unwrap_or_default(),
            upstream_context,
            expected_outputs_line,
            retry_context,
            dag_overview,
            task_description,
        );

        tokio::fs::write(&plan_file, content).await?;

        // Create results directory (matching TaskCoordinator's path convention)
        let results_dir = self
            .project_root
            .join(".ergatai")
            .join(".plan")
            .join("results");
        tokio::fs::create_dir_all(&results_dir).await?;

        Ok(plan_file)
    }

    /// Build a markdown block describing upstream node outputs and status.
    ///
    /// For each dependency, render a section showing:
    /// - Completed: structured outputs (if any) + output warnings
    /// - Failed: error text from metadata["last_error"]
    /// - Skipped: skip reason from metadata["skipped_reason"]
    pub(super) async fn build_upstream_context_block(&self, node: &TaskNode) -> String {
        if node.depends_on.is_empty() {
            return String::new();
        }

        let graph = self.graph.lock().await;
        let ctx = self.context.lock().await;

        // Pre-allocate for header + upstream dependencies
        let mut lines = Vec::with_capacity(2 + node.depends_on.len());
        lines.push(String::new());
        lines.push("### Upstream Context".to_string());

        for dep_id in &node.depends_on {
            let dep_node = graph.find_node(dep_id);
            let dep_name = dep_node.as_ref().map(|n| n.task.as_str()).unwrap_or(dep_id);

            // Check node status first for failed/skipped visibility
            let status = dep_node
                .map(|n| n.status.clone())
                .unwrap_or(TaskStatus::Completed);
            match status {
                TaskStatus::Failed => {
                    let error_text = dep_node
                        .and_then(|n| n.metadata.get("last_error"))
                        .map(|e| format!(" — Error: {}", e))
                        .unwrap_or_default();
                    lines.push(format!(
                        "\n**{}** ({}) — ❌ FAILED{}",
                        dep_name, dep_id, error_text
                    ));
                    continue;
                }
                TaskStatus::Skipped => {
                    let reason = dep_node
                        .and_then(|n| n.metadata.get("skipped_reason"))
                        .map(|r| format!(" — {}", r))
                        .unwrap_or_default();
                    lines.push(format!(
                        "\n**{}** ({}) — ⏭️ SKIPPED{}",
                        dep_name, dep_id, reason
                    ));
                    continue;
                }
                _ => {} // Completed or other — show outputs below
            }

            if let Some(outputs) = ctx.get_node_outputs(dep_id) {
                // Check if the JSON value is a non-empty object
                let is_non_empty_object =
                    matches!(outputs, serde_json::Value::Object(obj) if !obj.is_empty());

                if is_non_empty_object {
                    lines.push(format!("\n**{}** ({}) outputs:", dep_name, dep_id));
                    if let serde_json::Value::Object(obj) = outputs {
                        for (k, v) in obj {
                            lines.push(format!("  - {}: {}", k, v));
                        }
                    }
                } else {
                    lines.push(format!(
                        "\n**{}** ({}) — completed (no outputs recorded)",
                        dep_name, dep_id
                    ));
                }
            } else {
                lines.push(format!("\n**{}** ({}) — completed", dep_name, dep_id));
            }

            // Show output warnings (missing expected_outputs keys)
            if let Some(warning) = dep_node.and_then(|n| n.metadata.get("output_warnings")) {
                lines.push(format!("  - ⚠️ {}", warning));
            }
        }

        lines.join("\n")
    }

    /// Build a markdown block giving the agent a full DAG overview.
    ///
    /// Includes: all participants and roles, dependency topology,
    /// and the current agent's position in the graph.
    pub(super) async fn build_dag_overview_block(&self, current_node: &TaskNode) -> String {
        let graph = self.graph.lock().await;

        let mut lines = Vec::new();
        lines.push("## DAG Overview".to_string());
        lines.push(String::new());

        // 1. Participants
        lines.push("### Participants".to_string());
        for node in &graph.nodes {
            let is_you = node.agent == current_node.agent;
            let marker = if is_you { " ← **YOU**" } else { "" };
            lines.push(format!("- **@{}** — {}{}", node.agent, node.task, marker));
        }
        lines.push(String::new());

        // 2. Dependency topology
        lines.push("### Dependency Graph".to_string());
        for node in &graph.nodes {
            if node.depends_on.is_empty() {
                lines.push(format!("- **{}** → (root node, no dependencies)", node.id));
            } else {
                let deps = node.depends_on.join(", ");
                lines.push(format!("- **{}** → depends on: {}", node.id, deps));
            }
        }
        lines.push(String::new());

        // 3. Current agent's position
        lines.push("### Your Position".to_string());
        lines.push(format!("- **Your agent**: @{}", current_node.agent));
        lines.push(format!("- **Your task**: {}", current_node.task));
        if !current_node.depends_on.is_empty() {
            lines.push(format!(
                "- **You depend on**: {}",
                current_node.depends_on.join(", ")
            ));
        } else {
            lines.push(
                "- **You are a root node** (no dependencies, can start immediately)".to_string(),
            );
        }
        let downstream: Vec<&str> = graph
            .nodes
            .iter()
            .filter(|n| n.depends_on.contains(&current_node.id))
            .map(|n| n.id.as_str())
            .collect();
        if downstream.is_empty() {
            lines.push("- **Downstream**: none (you are a leaf node)".to_string());
        } else {
            lines.push(format!("- **Downstream**: {}", downstream.join(", ")));
        }

        lines.join("\n")
    }
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use ergatai_dag::{TaskGraph, TaskNode, TaskStatus};

    use super::super::DagScheduler;

    #[tokio::test]
    async fn test_build_upstream_context_block_empty_when_no_deps() {
        let graph = TaskGraph::new(vec![TaskNode::new("n1", "a", "A")]);
        let scheduler = DagScheduler::new(PathBuf::from("/tmp/upstream-empty"), graph);
        let node = scheduler
            .graph
            .lock()
            .await
            .find_node("n1")
            .unwrap()
            .clone();
        let block = scheduler.build_upstream_context_block(&node).await;
        assert!(block.is_empty());
    }

    #[tokio::test]
    async fn test_build_upstream_context_block_shows_outputs() {
        let graph = TaskGraph::new(vec![
            TaskNode::new("n1", "a", "A"),
            TaskNode::new("n2", "a", "B").with_dependencies(vec!["n1".into()]),
        ]);
        let scheduler = DagScheduler::new(PathBuf::from("/tmp/upstream"), graph);
        let mut outputs = serde_json::Map::new();
        outputs.insert(
            "key1".to_string(),
            serde_json::Value::String("value1".to_string()),
        );
        scheduler
            .record_outputs("n1", serde_json::Value::Object(outputs))
            .await;

        let node = scheduler
            .graph
            .lock()
            .await
            .find_node("n2")
            .unwrap()
            .clone();
        let block = scheduler.build_upstream_context_block(&node).await;
        assert!(block.contains("Upstream Context"));
        assert!(block.contains("key1"));
        assert!(block.contains("value1"));
    }

    #[tokio::test]
    async fn test_build_dag_overview_block_single_node() {
        let mut node = TaskNode::new("n1", "agent-a", "Solo task");
        node.id = "n1".to_string();
        let graph = TaskGraph::new(vec![node.clone()]);
        let scheduler = DagScheduler::new(PathBuf::from("/tmp"), graph);
        let overview = scheduler.build_dag_overview_block(&node).await;

        assert!(overview.contains("## DAG Overview"));
        assert!(overview.contains("### Participants"));
        assert!(overview.contains("@agent-a"));
        assert!(overview.contains("← **YOU**"));
        assert!(overview.contains("### Dependency Graph"));
        assert!(overview.contains("root node, no dependencies"));
        assert!(overview.contains("### Your Position"));
        assert!(overview.contains("root node"));
        assert!(overview.contains("leaf node"));
    }

    #[tokio::test]
    async fn test_build_dag_overview_block_multi_node() {
        let n1 = TaskNode::new("n1", "agent-a", "Backend API");
        let n2 = TaskNode::new("n2", "agent-b", "Frontend UI").with_dependencies(vec!["n1".into()]);
        let n3 = TaskNode::new("n3", "agent-c", "Integration tests")
            .with_dependencies(vec!["n1".into()]);
        let graph = TaskGraph::new(vec![n1.clone(), n2.clone(), n3.clone()]);
        let scheduler = DagScheduler::new(PathBuf::from("/tmp"), graph);

        // Check n1's perspective: root, downstream = n2, n3
        let overview_n1 = scheduler.build_dag_overview_block(&n1).await;
        assert!(overview_n1.contains("@agent-a"));
        assert!(overview_n1.contains("← **YOU**"));
        assert!(overview_n1.contains("root node"));
        assert!(overview_n1.contains("Downstream"));
        // n1 should NOT be marked YOU for the other agents
        let you_count = overview_n1.matches("← **YOU**").count();
        assert_eq!(you_count, 1, "Only the current agent should be marked YOU");

        // Check n2's perspective: depends on n1, leaf
        let overview_n2 = scheduler.build_dag_overview_block(&n2).await;
        assert!(overview_n2.contains("@agent-b"));
        assert!(overview_n2.contains("You depend on"));
        assert!(overview_n2.contains("leaf node"));

        // Check n3's perspective
        let overview_n3 = scheduler.build_dag_overview_block(&n3).await;
        assert!(overview_n3.contains("@agent-c"));
    }

    #[tokio::test]
    async fn test_upstream_context_shows_failed_node() {
        let n1 = TaskNode::new("n1", "agent-a", "Backend");
        let n2 = TaskNode::new("n2", "agent-b", "Frontend").with_dependencies(vec!["n1".into()]);
        let mut graph = TaskGraph::new(vec![n1.clone(), n2.clone()]);

        // Simulate n1 failed with error
        graph.find_node_mut("n1").unwrap().status = TaskStatus::Failed;
        graph
            .find_node_mut("n1")
            .unwrap()
            .metadata
            .insert("last_error".to_string(), "segfault in parser".to_string());

        let scheduler = DagScheduler::new(PathBuf::from("/tmp"), graph);
        let ctx = scheduler.build_upstream_context_block(&n2).await;

        assert!(
            ctx.contains("❌ FAILED"),
            "Should show FAILED marker: {}",
            ctx
        );
        assert!(
            ctx.contains("segfault in parser"),
            "Should show error text: {}",
            ctx
        );
    }

    #[tokio::test]
    async fn test_upstream_context_shows_skipped_node() {
        let n1 = TaskNode::new("n1", "agent-a", "Backend");
        let n2 = TaskNode::new("n2", "agent-b", "Frontend").with_dependencies(vec!["n1".into()]);
        let mut graph = TaskGraph::new(vec![n1.clone(), n2.clone()]);

        // Simulate n1 skipped
        graph.find_node_mut("n1").unwrap().status = TaskStatus::Skipped;
        graph.find_node_mut("n1").unwrap().metadata.insert(
            "skipped_reason".to_string(),
            "Upstream node 'n0' failed".to_string(),
        );

        let scheduler = DagScheduler::new(PathBuf::from("/tmp"), graph);
        let ctx = scheduler.build_upstream_context_block(&n2).await;

        assert!(
            ctx.contains("⏭️ SKIPPED"),
            "Should show SKIPPED marker: {}",
            ctx
        );
        assert!(ctx.contains("n0"), "Should show skip reason: {}", ctx);
    }

    #[tokio::test]
    async fn test_upstream_context_shows_output_warnings() {
        let n1 = TaskNode::new("n1", "agent-a", "Backend");
        let n2 = TaskNode::new("n2", "agent-b", "Frontend").with_dependencies(vec!["n1".into()]);
        let mut graph = TaskGraph::new(vec![n1.clone(), n2.clone()]);

        // n1 completed but with output warnings
        graph.find_node_mut("n1").unwrap().status = TaskStatus::Completed;
        graph.find_node_mut("n1").unwrap().metadata.insert(
            "output_warnings".to_string(),
            "missing keys: api_endpoint, schema_file".to_string(),
        );

        let scheduler = DagScheduler::new(PathBuf::from("/tmp"), graph);

        // Also record some outputs so it takes the "completed" path
        scheduler
            .record_outputs("n1", serde_json::json!({"partial_key": "value"}))
            .await;

        let ctx = scheduler.build_upstream_context_block(&n2).await;
        assert!(ctx.contains("⚠️"), "Should show warning marker: {}", ctx);
        assert!(
            ctx.contains("missing keys"),
            "Should show warning text: {}",
            ctx
        );
    }

    #[tokio::test]
    async fn test_result_validation_missing_keys() {
        let mut n1 = TaskNode::new("n1", "agent-a", "Backend");
        n1.expected_outputs = std::collections::HashMap::from([
            ("api_endpoint".to_string(), "The API endpoint".to_string()),
            ("schema_file".to_string(), "Schema file path".to_string()),
        ]);
        let graph = TaskGraph::new(vec![n1]);
        let scheduler = DagScheduler::new(PathBuf::from("/tmp"), graph);

        // Simulate handle_dag_event validation: only one of two keys present
        {
            let mut g = scheduler.graph.lock().await;
            let node = g.find_node_mut("n1").unwrap();
            let json_val = serde_json::json!({"api_endpoint": "/api/v1"});
            let actual_keys: std::collections::HashSet<&String> =
                json_val.as_object().map(|o| o.keys().collect()).unwrap();
            let missing: Vec<&String> = node
                .expected_outputs
                .keys()
                .filter(|k| !actual_keys.contains(k))
                .collect();
            assert_eq!(missing.len(), 1);
            assert_eq!(missing[0], "schema_file");
        }
    }
}
