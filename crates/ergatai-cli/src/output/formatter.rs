use crate::client::http::{
    AgentInfoResponse, DagInfoResponse, DagStatusResponse, LockContentionResponse,
    LockInfoResponse, StatusResponse, WorkspaceResponse,
};

fn truncate_str(s: &str, max_len: usize) -> String {
    if s.len() <= max_len {
        s.to_string()
    } else if max_len <= 3 {
        s[..max_len].to_string()
    } else {
        format!("{}...", &s[..max_len - 3])
    }
}

pub fn format_workspaces_table(workspaces: &[WorkspaceResponse]) {
    if workspaces.is_empty() {
        println!("No workspaces found");
        return;
    }

    println!("{:<40} {:<15} METADATA", "ID", "BACKEND");
    println!("{}", "-".repeat(70));

    for w in workspaces {
        let metadata = if w.metadata.is_empty() {
            "{}".to_string()
        } else {
            format!("{:?}", w.metadata)
        };
        let id_display = truncate_str(&w.id, 40);
        println!("{:<40} {:<15} {}", id_display, w.backend, metadata);
    }
}

pub fn format_agents_table(agents: &[AgentInfoResponse]) {
    if agents.is_empty() {
        println!("No agents found");
        return;
    }

    println!(
        "{:<30} {:<30} {:<10} {:<10} {:<20} LAST HEARTBEAT",
        "AGENT ID", "WORKSPACE", "STATE", "ALIVE", "TASK"
    );
    println!("{}", "-".repeat(130));

    for a in agents {
        let task_display = a.task_id.as_deref().unwrap_or("-");
        let heartbeat = if a.last_heartbeat.is_empty() {
            "-".to_string()
        } else if a.last_heartbeat.len() >= 19 && a.last_heartbeat.is_ascii() {
            // Extract time portion from RFC3339-like timestamp (bytes 11..19 = "HH:MM:SS")
            a.last_heartbeat[11..19].to_string()
        } else {
            a.last_heartbeat.clone()
        };

        // Display friendly ID: mcp_agent_id > stable_id > agent_id
        let display_id = a
            .mcp_agent_id
            .as_deref()
            .or(a.stable_id.as_deref())
            .unwrap_or(&a.agent_id);

        // Truncate long values to fit column width
        let workspace_display = truncate_str(&a.workspace_id, 30);
        let task_truncated = truncate_str(task_display, 20);

        println!(
            "{:<30} {:<30} {:<10} {:<10} {:<20} {}",
            display_id,
            workspace_display,
            a.state,
            if a.is_alive { "yes" } else { "no" },
            task_truncated,
            heartbeat,
        );
    }

    // Summary
    let total = agents.len();
    let alive = agents.iter().filter(|a| a.is_alive).count();
    let idle = agents.iter().filter(|a| a.is_idle).count();
    let processing = agents.iter().filter(|a| a.is_processing).count();
    println!();
    println!(
        "Total: {} | Alive: {} | Idle: {} | Processing: {}",
        total, alive, idle, processing
    );
}

pub fn format_status(status: &StatusResponse) {
    println!("Ergatai System Status");
    println!("{}", "=".repeat(50));
    println!();

    println!("NATS:");
    println!("  Initialized: {}", status.nats_initialized);
    if let Some(port) = status.nats_port {
        println!("  Port: {}", port);
    }
    println!();

    println!("Agents:");
    println!("  Active: {}", status.active_agents);
    println!();
}

pub fn format_locks_table(locks: &[LockInfoResponse]) {
    if locks.is_empty() {
        println!("No active locks found");
        return;
    }

    println!(
        "{:<40} {:<20} {:<10} {:<10} {:<15}",
        "FILE PATH", "AGENT", "MODE", "STATUS", "EXPIRES"
    );
    println!("{}", "-".repeat(100));

    for lock in locks {
        let expires = if lock.expires_at.len() >= 19 && lock.expires_at.is_ascii() {
            // Extract time portion from RFC3339 timestamp
            lock.expires_at[11..19].to_string()
        } else {
            lock.expires_at.clone()
        };

        println!(
            "{:<40} {:<20} {:<10} {:<10} {:<15}",
            lock.file_path, lock.agent_id, lock.mode, lock.status, expires,
        );
    }

    println!();
    println!("Total: {} active locks", locks.len());
}

pub fn format_contention_table(contentions: &[LockContentionResponse]) {
    if contentions.is_empty() {
        println!("No lock contention detected");
        return;
    }

    println!(
        "{:<40} {:<20} {:<10} {:<15}",
        "FILE PATH", "HOLDER", "WAITING", "WAIT TIME"
    );
    println!("{}", "-".repeat(90));

    for contention in contentions {
        let waiting = if contention.waiting_agents.is_empty() {
            "-".to_string()
        } else {
            format!("{} agents", contention.waiting_agents.len())
        };

        println!(
            "{:<40} {:<20} {:<10} {:<15}",
            contention.file_path,
            contention.current_holder,
            waiting,
            format!("{}s", contention.wait_time_secs),
        );
    }

    println!();
    println!("Total: {} contentions", contentions.len());
}

pub fn format_dags_table(dags: &[DagInfoResponse]) {
    if dags.is_empty() {
        println!("No DAGs found");
        return;
    }

    println!(
        "{:<50} {:<10} {:<15} {}",
        "DAG ID", "PROGRESS", "STATUS", "STATUS PROMPT"
    );
    println!("{}", "-".repeat(110));

    for dag in dags {
        let progress = format!("{:.1}%", dag.progress * 100.0);
        let status = if dag.is_complete {
            "Completed"
        } else {
            "Running"
        };
        let prompt = if dag.status_prompt.len() > 40 {
            format!("{}...", &dag.status_prompt[..37])
        } else {
            dag.status_prompt.clone()
        };
        let dag_id_display = truncate_str(&dag.dag_id, 50);

        println!(
            "{:<50} {:<10} {:<15} {}",
            dag_id_display, progress, status, prompt,
        );
    }

    println!();
    let running = dags.iter().filter(|d| !d.is_complete).count();
    let completed = dags.iter().filter(|d| d.is_complete).count();
    println!(
        "Total: {} DAGs | Running: {} | Completed: {}",
        dags.len(),
        running,
        completed
    );
}

pub fn format_dag_status(status: &DagStatusResponse) {
    if !status.running {
        println!("No DAG is currently running");
        return;
    }

    println!("DAG Status");
    println!("{}", "=".repeat(60));

    if let Some(progress) = status.progress {
        println!("Progress: {:.1}%", progress * 100.0);
    }

    if let Some(is_complete) = status.is_complete {
        println!(
            "Status: {}",
            if is_complete { "Completed" } else { "Running" }
        );
    }

    if let Some(prompt) = &status.status_prompt {
        println!("Message: {}", prompt);
    }

    if let Some(nodes) = &status.nodes {
        println!();
        println!("Nodes:");
        println!("{:<30} {:<20} {:<15} {}", "ID", "AGENT", "STATUS", "TASK");
        println!("{}", "-".repeat(80));

        for node in nodes {
            let task = if node.task.len() > 30 {
                format!("{}...", &node.task[..27])
            } else {
                node.task.clone()
            };

            println!(
                "{:<30} {:<20} {:<15} {}",
                node.id, node.agent, node.status, task,
            );
        }

        println!();
        let total = nodes.len();
        let completed = nodes.iter().filter(|n| n.status == "completed").count();
        let running = nodes.iter().filter(|n| n.status == "running").count();
        let pending = nodes.iter().filter(|n| n.status == "pending").count();
        println!(
            "Nodes: {} total | {} completed | {} running | {} pending",
            total, completed, running, pending
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::client::http::{AgentInfoResponse, StatusResponse, WorkspaceResponse};
    use std::collections::HashMap;

    fn make_workspace(id: &str, backend: &str) -> WorkspaceResponse {
        WorkspaceResponse {
            id: id.to_string(),
            backend: backend.to_string(),
            metadata: HashMap::new(),
        }
    }

    fn make_agent(agent_id: &str, workspace_id: &str, state: &str) -> AgentInfoResponse {
        AgentInfoResponse {
            agent_id: agent_id.to_string(),
            stable_id: Some(format!("agent-{}", agent_id)),
            agent_uuid: format!("uuid-{}", agent_id),
            workspace_id: workspace_id.to_string(),
            work_dir: format!("/workspace/{}", workspace_id),
            state: state.to_string(),
            lifecycle_state: state.to_string(),
            task_id: None,
            mcp_agent_id: None,
            is_alive: state == "running" || state == "idle" || state == "processing",
            is_idle: state == "idle",
            is_processing: state == "processing",
            created_at: "2024-01-01T00:00:00Z".to_string(),
            last_heartbeat: "2024-01-01T00:00:00Z".to_string(),
        }
    }

    #[test]
    fn test_format_workspaces_table_empty() {
        format_workspaces_table(&[]);
    }

    #[test]
    fn test_format_workspaces_table_single() {
        let workspaces = vec![make_workspace("ws-1", "local")];
        format_workspaces_table(&workspaces);
    }

    #[test]
    fn test_format_workspaces_table_multiple() {
        let workspaces = vec![
            make_workspace("ws-1", "local"),
            make_workspace("ws-2", "remote"),
            make_workspace("ws-3", "docker"),
        ];
        format_workspaces_table(&workspaces);
    }

    #[test]
    fn test_format_workspaces_table_with_metadata() {
        let mut ws = make_workspace("ws-meta", "local");
        ws.metadata.insert("key".to_string(), "value".to_string());
        format_workspaces_table(&[ws]);
    }

    #[test]
    fn test_format_agents_table_empty() {
        format_agents_table(&[]);
    }

    #[test]
    fn test_format_agents_table_single() {
        let agents = vec![make_agent("agent-1", "ws-1", "running")];
        format_agents_table(&agents);
    }

    #[test]
    fn test_format_agents_table_multiple() {
        let agents = vec![
            make_agent("agent-1", "ws-1", "running"),
            make_agent("agent-2", "ws-2", "stopped"),
            make_agent("agent-3", "ws-1", "pending"),
        ];
        format_agents_table(&agents);
    }

    #[test]
    fn test_format_status_basic() {
        let status = StatusResponse {
            nats_initialized: true,
            nats_port: Some(4222),
            active_agents: 3,
        };
        format_status(&status);
    }

    #[test]
    fn test_format_status_no_nats_port() {
        let status = StatusResponse {
            nats_initialized: false,
            nats_port: None,
            active_agents: 0,
        };
        format_status(&status);
    }

    #[test]
    fn test_workspace_metadata_empty_shows_empty_braces() {
        let ws = make_workspace("ws-empty-meta", "local");
        assert!(ws.metadata.is_empty());
        format_workspaces_table(&[ws]);
    }

    #[test]
    fn test_agent_created_at_displayed() {
        let agent = AgentInfoResponse {
            agent_id: "test-agent".to_string(),
            stable_id: Some("agent-test".to_string()),
            agent_uuid: "uuid-test".to_string(),
            workspace_id: "test-ws".to_string(),
            work_dir: "/workspace/test-ws".to_string(),
            state: "running".to_string(),
            lifecycle_state: "running".to_string(),
            task_id: None,
            mcp_agent_id: None,
            is_alive: true,
            is_idle: false,
            is_processing: false,
            created_at: "2024-06-15T12:30:00Z".to_string(),
            last_heartbeat: "2024-06-15T12:30:00Z".to_string(),
        };
        format_agents_table(&[agent]);
    }

    #[test]
    fn test_format_workspaces_table_long_ids() {
        let workspaces = vec![make_workspace(
            "very-long-workspace-identifier-that-exceeds-column-width",
            "local-backend-type",
        )];
        format_workspaces_table(&workspaces);
    }
}
