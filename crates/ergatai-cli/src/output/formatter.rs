use crate::client::http::{
    AgentInfoResponse, LockContentionResponse,
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

        // Display friendly ID: mcp_agent_id > conversation_id > agent_id
        let display_id = a
            .mcp_agent_id
            .as_deref()
            .or(a.conversation_id.as_deref())
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::client::http::{AgentInfoResponse, StatusResponse, WorkspaceResponse};
    use ergatai_error::id::{format as format_id, generate, IdType};
    use std::collections::HashMap;

    fn make_workspace(id: &str, backend: &str) -> WorkspaceResponse {
        WorkspaceResponse {
            id: id.to_string(),
            backend: backend.to_string(),
            metadata: HashMap::new(),
            capture_thoughts: None,
        }
    }

    fn make_agent(agent_id: &str, workspace_id: &str, state: &str) -> AgentInfoResponse {
        AgentInfoResponse {
            agent_id: agent_id.to_string(),
            conversation_id: Some(format_id(generate(), IdType::Conversation)),
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
            session_title: None,
            session_id: None,
            stop_reason: None,
            continuation_count: 0,
            config_options: None,
            profile: None,
            capabilities: vec![],
            state_changed_at: "2024-01-01T00:00:00Z".to_string(),
            state_history: vec![],
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
            conversation_id: Some("cov-test".to_string()),
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
            session_title: None,
            session_id: None,
            stop_reason: None,
            continuation_count: 0,
            config_options: None,
            profile: None,
            capabilities: vec![],
            state_changed_at: "2024-06-15T12:30:00Z".to_string(),
            state_history: vec![],
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

    #[test]
    fn test_format_agents_table_empty_v2() {
        format_agents_table(&[]);
    }

    #[test]
    fn test_format_agents_table_single_running() {
        let agents = vec![make_agent("agent-1", "ws-1", "running")];
        format_agents_table(&agents);
    }

    #[test]
    fn test_format_agents_table_multiple_states() {
        let agents = vec![
            make_agent("agent-1", "ws-1", "running"),
            make_agent("agent-2", "ws-1", "idle"),
            make_agent("agent-3", "ws-1", "stopped"),
        ];
        format_agents_table(&agents);
    }

    #[test]
    fn test_format_agents_table_with_task_id() {
        let mut agent = make_agent("agent-1", "ws-1", "running");
        agent.task_id = Some("task-123".to_string());
        format_agents_table(&[agent]);
    }

    #[test]
    fn test_format_agents_table_with_profile() {
        let mut agent = make_agent("agent-1", "ws-1", "running");
        agent.profile = Some("default-profile".to_string());
        format_agents_table(&[agent]);
    }

    #[test]
    fn test_format_status_with_nats() {
        let status = StatusResponse {
            nats_initialized: true,
            nats_port: Some(4222),
            active_agents: 5,
        };
        format_status(&status);
    }

    #[test]
    fn test_format_status_without_nats() {
        let status = StatusResponse {
            nats_initialized: false,
            nats_port: None,
            active_agents: 0,
        };
        format_status(&status);
    }

    #[test]
    fn test_format_status_many_agents() {
        let status = StatusResponse {
            nats_initialized: true,
            nats_port: Some(4222),
            active_agents: 100,
        };
        format_status(&status);
    }

    #[test]
    fn test_format_locks_table_empty() {
        format_locks_table(&[]);
    }

    #[test]
    fn test_format_locks_table_single() {
        let lock = LockInfoResponse {
            id: "lock-1".to_string(),
            file_path: "/path/to/file.rs".to_string(),
            agent_id: "agent-1".to_string(),
            session_id: "session-1".to_string(),
            mode: "write".to_string(),
            scope: "exclusive".to_string(),
            created_at: "2024-01-01T12:00:00Z".to_string(),
            expires_at: "2024-01-01T12:30:45Z".to_string(),
            heartbeat_at: "2024-01-01T12:15:00Z".to_string(),
            status: "active".to_string(),
        };
        format_locks_table(&[lock]);
    }

    #[test]
    fn test_format_locks_table_multiple() {
        let locks = vec![
            LockInfoResponse {
                id: "lock-1".to_string(),
                file_path: "/path/to/file1.rs".to_string(),
                agent_id: "agent-1".to_string(),
                session_id: "session-1".to_string(),
                mode: "write".to_string(),
                scope: "exclusive".to_string(),
                created_at: "2024-01-01T12:00:00Z".to_string(),
                expires_at: "2024-01-01T12:30:45Z".to_string(),
                heartbeat_at: "2024-01-01T12:15:00Z".to_string(),
                status: "active".to_string(),
            },
            LockInfoResponse {
                id: "lock-2".to_string(),
                file_path: "/path/to/file2.rs".to_string(),
                agent_id: "agent-2".to_string(),
                session_id: "session-2".to_string(),
                mode: "read".to_string(),
                scope: "shared".to_string(),
                created_at: "2024-01-01T12:30:00Z".to_string(),
                expires_at: "2024-01-01T13:00:00Z".to_string(),
                heartbeat_at: "2024-01-01T12:45:00Z".to_string(),
                status: "pending".to_string(),
            },
        ];
        format_locks_table(&locks);
    }

    #[test]
    fn test_format_locks_table_short_expires() {
        let lock = LockInfoResponse {
            id: "lock-1".to_string(),
            file_path: "/path/to/file.rs".to_string(),
            agent_id: "agent-1".to_string(),
            session_id: "session-1".to_string(),
            mode: "write".to_string(),
            scope: "exclusive".to_string(),
            created_at: "2024-01-01T12:00:00Z".to_string(),
            expires_at: "short".to_string(),
            heartbeat_at: "2024-01-01T12:15:00Z".to_string(),
            status: "active".to_string(),
        };
        format_locks_table(&[lock]);
    }

    #[test]
    fn test_format_contention_table_empty() {
        format_contention_table(&[]);
    }

    #[test]
    fn test_format_contention_table_single() {
        let contention = LockContentionResponse {
            file_path: "/path/to/file.rs".to_string(),
            current_holder: "agent-1".to_string(),
            waiting_agents: vec!["agent-2".to_string(), "agent-3".to_string()],
            wait_time_secs: 30,
            conflict_count: 2,
        };
        format_contention_table(&[contention]);
    }

    #[test]
    fn test_format_contention_table_no_waiters() {
        let contention = LockContentionResponse {
            file_path: "/path/to/file.rs".to_string(),
            current_holder: "agent-1".to_string(),
            waiting_agents: vec![],
            wait_time_secs: 10,
            conflict_count: 0,
        };
        format_contention_table(&[contention]);
    }
}
