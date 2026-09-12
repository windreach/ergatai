//! DAG service — 统一 DAG 提交、验证、状态查询、可视化、指标。
//!
//! 职责：
//! - 消除 REST (`lib.rs`) 和 MCP (`mcp/server.rs`) 之间重复的 DAG 逻辑。
//! - 统一 `graph_snapshot` JSON 解析（原先三处重复）。
//! - 集中 DAG 磁盘状态加载逻辑（`load_completed_dag_from_disk`）。
//! - 返回领域类型（非 JSON），由 handler 层负责 HTTP/RPC 格式化。

use std::collections::HashMap;
use std::path::PathBuf;

use anyhow::Result;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use ergatai_core::cross_agent::{
    get_dag_scheduler, get_dag_scheduler_by_id, list_dag_schedulers, set_dag_scheduler,
    DagScheduler,
};
use ergatai_core::orchestration::{parse_dag_auto, DagContext, TaskGraph, TaskStatus};

// ── 领域类型 ──────────────────────────────────────────────────────────

/// DAG 提交请求。
pub struct DagSubmitRequest {
    /// YAML DAG 定义。
    pub definition: String,
    /// 模板参数（可选）。
    pub parameters: Option<HashMap<String, Value>>,
    /// MCP-only: DagContext 变量（用于 `{{var}}` 模板展开）。
    pub context: Option<Value>,
    /// MCP-only: 提交者 agent_id（用于 submitter-is-worker 安全检查）。
    pub submitter_agent_id: Option<String>,
}

/// DAG 提交响应。
#[derive(Debug, Serialize)]
pub struct DagSubmitResponse {
    pub submitted_nodes: usize,
    pub progress: f64,
    pub graph_status: String,
}

/// DAG 状态信息（统一 REST + MCP 查询结果）。
#[derive(Debug, Serialize)]
pub struct DagStatusInfo {
    /// 是否有活跃的调度器。
    pub running: bool,
    /// 进度百分比（0-100）。
    pub progress: Option<f64>,
    /// 人类可读的状态摘要。
    pub status_prompt: Option<String>,
    /// 是否所有节点都已进入终态。
    pub is_complete: Option<bool>,
    /// 节点状态列表（running DAG 时）。
    pub nodes: Option<Vec<NodeStatusInfo>>,
    /// 协作会话信息（MeshPolicy + participants）。
    pub collaboration: Option<DagCollaborationInfo>,
    /// 进度明细（completed/running/failed/pending/total + percent）。
    pub progress_detail: Option<DagProgressDetail>,
    /// graph_snapshot 的 JSON 字符串（MCP 需要直接返回）。
    pub graph_snapshot: Option<String>,
}

/// 单个节点状态。
#[derive(Debug, Serialize)]
pub struct NodeStatusInfo {
    pub id: String,
    pub agent: String,
    pub task: String,
    pub status: String,
    pub depends_on: Vec<String>,
    pub output: Option<Value>,
}

/// 协作会话信息。
#[derive(Debug, Serialize, Deserialize)]
pub struct DagCollaborationInfo {
    pub dag_id: String,
    pub policy: String,
    pub participants: Vec<String>,
    pub participant_count: usize,
    pub created_at: String,
}

/// 进度明细（completed / running / failed / pending / total + percent）。
#[derive(Debug, Serialize)]
pub struct DagProgressDetail {
    pub completed: usize,
    pub running: usize,
    pub failed: usize,
    pub pending: usize,
    pub total: usize,
    pub percent: u32,
}

/// DAG 可视化节点（含布局坐标）。
#[derive(Debug, Serialize)]
pub struct DagVisualizationNode {
    pub id: String,
    pub agent: String,
    pub task: String,
    pub status: String,
    pub depends_on: Vec<String>,
    pub x: f32,
    pub y: f32,
    pub layer: u32,
}

/// DAG 边（依赖关系）。
#[derive(Debug, Serialize)]
pub struct DagEdge {
    pub from: String,
    pub to: String,
}

/// DAG 可视化结果。
#[derive(Debug, Serialize)]
pub struct DagVisualizationResult {
    pub dag_id: String,
    pub nodes: Vec<DagVisualizationNode>,
    pub edges: Vec<DagEdge>,
}

/// DAG 指标。
#[derive(Debug, Serialize)]
pub struct DagMetricsResult {
    pub total_nodes: u32,
    pub completed_nodes: u32,
    pub failed_nodes: u32,
    pub running_nodes: u32,
    pub pending_nodes: u32,
    pub avg_completion_time_secs: Option<f32>,
}

/// DAG 验证结果（dry-run）。
#[derive(Debug, Serialize)]
pub struct DagValidationResult {
    pub valid: bool,
    pub task_count: usize,
    pub agents: Vec<String>,
    pub communication: String,
    pub dag_timeout: Option<u64>,
    pub dag_max_agent_calls: Option<u64>,
    pub dag_stall_timeout_secs: Option<u64>,
    pub dag_node_timeout_secs: Option<u64>,
    pub tasks: Vec<DagTaskSummary>,
}

/// 单个任务摘要。
#[derive(Debug, Serialize)]
pub struct DagTaskSummary {
    pub name: String,
    pub agent: String,
    pub priority: String,
    pub complexity: String,
    pub depends_on_count: usize,
    pub timeout: Option<u64>,
    pub scope: Option<String>,
}

/// DAG 列表条目。
#[derive(Debug, Serialize)]
pub struct DagListEntry {
    pub dag_id: String,
    pub progress: f32,
    pub is_complete: bool,
    pub status_prompt: String,
}

// ── 公开服务函数 ──────────────────────────────────────────────────────

/// 提交 DAG（统一 REST + MCP 逻辑）。
///
/// 执行顺序：
/// 1. 检查是否有运行中的 DAG（若未完成则拒绝）。
/// 2. `parse_dag_auto()` 解析 YAML。
/// 3. submitter-is-worker 安全检查（仅当 `submitter_agent_id` 提供时）。
/// 4. 构建 `DagContext`（若提供 `context`）。
/// 5. `DagScheduler::with_context()` 创建调度器。
/// 6. `set_dag_scheduler()` + `start_event_listener()`。
/// 7. `submit_graph()`。
pub async fn submit_dag(req: DagSubmitRequest) -> Result<DagSubmitResponse> {
    // 1. 检查是否有运行中的 DAG
    if let Some(existing) = get_dag_scheduler() {
        if !existing.is_complete().await {
            anyhow::bail!("A DAG is already running. Wait for completion or check status.");
        }
    }

    // 2. 解析 YAML
    let graph = parse_dag_auto(&req.definition, req.parameters)
        .map_err(|e| anyhow::anyhow!("Failed to parse DAG definition: {}", e))?;

    // 3. submitter-is-worker 检查（MCP-only）
    if let Some(ref submitter_id) = req.submitter_agent_id {
        let runtime = crate::context::get_app_context().agent_runtime.clone();
        if let Some(runtime_id) = runtime.resolve_agent_id(submitter_id).await {
            let dag_agents: Vec<String> = graph.nodes.iter().map(|t| t.agent.clone()).collect();
            if dag_agents.contains(&runtime_id) {
                anyhow::bail!(
                    "DAG scheduler (agent '{}') cannot also be a task worker. \
                     The submitter must be a pure coordinator. \
                     Please assign tasks to other agents only.",
                    runtime_id
                );
            }
        }
    }

    // 4. 构建 DagContext
    let mut dag_context = DagContext::empty();
    if let Some(ctx_val) = &req.context {
        if let Some(vars) = ctx_val.as_object() {
            for (k, v) in vars {
                dag_context.set_global(k.clone(), v.as_str().unwrap_or_default().to_string());
            }
        }
    }

    // 5. 创建调度器
    let project_root = PathBuf::from(crate::get_app_state().default_cwd.clone());
    let scheduler = DagScheduler::with_context(project_root, graph, dag_context);

    // 6. 全局注册 + 启动事件监听
    set_dag_scheduler(scheduler.clone());
    scheduler.clone().start_event_listener();

    // 7. 提交图
    let submitted = scheduler
        .submit_graph()
        .await
        .map_err(|e| anyhow::anyhow!("Failed to submit DAG: {}", e))?;

    let progress = scheduler.progress().await as f64;
    let graph_status = scheduler.status_prompt().await;

    Ok(DagSubmitResponse {
        submitted_nodes: submitted.len(),
        progress,
        graph_status,
    })
}

/// 验证 DAG YAML（dry-run）。
///
/// 仅解析，不执行。返回摘要或第一个校验错误。
pub fn validate_dag(
    definition: &str,
    parameters: Option<HashMap<String, Value>>,
) -> Result<DagValidationResult> {
    let graph = parse_dag_auto(definition, parameters)
        .map_err(|e| anyhow::anyhow!("DAG validation failed: {}", e))?;

    let mut agents: Vec<String> = graph.nodes.iter().map(|n| n.agent.clone()).collect();
    agents.sort();
    agents.dedup();

    let tasks: Vec<DagTaskSummary> = graph
        .nodes
        .iter()
        .map(|n| DagTaskSummary {
            name: n.task.clone(),
            agent: n.agent.clone(),
            priority: n.priority.clone().unwrap_or_else(|| "medium".to_string()),
            complexity: format!("{:?}", n.complexity).to_lowercase(),
            depends_on_count: n.depends_on.len(),
            timeout: n.timeout,
            scope: n.scope.clone(),
        })
        .collect();

    Ok(DagValidationResult {
        valid: true,
        task_count: graph.nodes.len(),
        agents,
        communication: graph
            .communication
            .clone()
            .unwrap_or_else(|| "open".to_string()),
        dag_timeout: graph.timeout,
        dag_max_agent_calls: graph.max_agent_calls,
        dag_stall_timeout_secs: graph.stall_timeout_secs,
        dag_node_timeout_secs: graph.node_timeout_secs,
        tasks,
    })
}

/// 获取 DAG 完整状态。
///
/// `dag_id` 为 None 时查询当前活跃调度器；提供时按 ID 查找。
/// 如果调度器不存在，会尝试从磁盘加载已完成的 DAG。
pub async fn get_dag_status(dag_id: Option<&str>) -> DagStatusInfo {
    let scheduler: Option<DagScheduler> = if let Some(id) = dag_id {
        get_dag_scheduler_by_id(Some(id))
    } else {
        get_dag_scheduler()
    };

    let Some(scheduler) = scheduler else {
        // 尝试从磁盘加载已完成的 DAG
        if let Some(disk_info) = load_completed_dag_from_disk().await {
            return disk_info;
        }
        return DagStatusInfo {
            running: false,
            progress: None,
            status_prompt: None,
            is_complete: None,
            nodes: None,
            collaboration: None,
            progress_detail: None,
            graph_snapshot: None,
        };
    };

    let progress = scheduler.progress().await as f64;
    let status_prompt = scheduler.status_prompt().await;
    let is_complete = scheduler.is_complete().await;

    let nodes = parse_graph_nodes_from_snapshot(&scheduler).await;

    // 协作会话信息
    let collab = scheduler.collaboration().await;
    let collaboration = Some(DagCollaborationInfo {
        dag_id: collab.dag_id.clone(),
        policy: format!("{:?}", collab.policy),
        participants: collab.participants.iter().cloned().collect(),
        participant_count: collab.participants.len(),
        created_at: collab.created_at.to_string(),
    });

    // 进度明细
    let progress_detail = compute_progress_detail(&scheduler).await;

    // graph_snapshot 字符串
    let graph_snapshot = scheduler.graph_snapshot().await.ok();

    DagStatusInfo {
        running: true,
        progress: Some(progress),
        status_prompt: Some(status_prompt),
        is_complete: Some(is_complete),
        nodes: Some(nodes),
        collaboration,
        progress_detail: Some(progress_detail),
        graph_snapshot,
    }
}

/// 获取 DAG 可视化数据（含布局计算）。
pub async fn get_dag_visualization(dag_id: Option<&str>) -> DagVisualizationResult {
    let scheduler: Option<DagScheduler> = if let Some(id) = dag_id {
        get_dag_scheduler_by_id(Some(id))
    } else {
        get_dag_scheduler()
    };

    let Some(scheduler) = scheduler else {
        return DagVisualizationResult {
            dag_id: String::new(),
            nodes: Vec::new(),
            edges: Vec::new(),
        };
    };

    let resolved_dag_id = scheduler.dag_id().to_string();

    // 提取节点元组: (id, agent, task, status, depends_on)
    let nodes_raw = extract_raw_nodes(&scheduler).await;

    // BFS 拓扑排序计算 layers
    let node_layers = compute_layers(&nodes_raw);

    // 按 layer 分组
    let mut layer_groups: HashMap<u32, Vec<usize>> = HashMap::new();
    for (idx, (id, _, _, _, _)) in nodes_raw.iter().enumerate() {
        let layer = node_layers.get(id).copied().unwrap_or(0);
        layer_groups.entry(layer).or_default().push(idx);
    }

    // 计算坐标
    let layer_spacing = 150.0;
    let node_spacing = 100.0;
    let mut visualization_nodes = Vec::new();

    for (layer, indices) in &layer_groups {
        let layer_width = indices.len() as f32 * node_spacing;
        let start_x = -layer_width / 2.0 + node_spacing / 2.0;

        for (pos, idx) in indices.iter().enumerate() {
            let (id, agent, task, status, deps) = &nodes_raw[*idx];
            visualization_nodes.push(DagVisualizationNode {
                id: id.clone(),
                agent: agent.clone(),
                task: task.clone(),
                status: status.clone(),
                depends_on: deps.clone(),
                x: start_x + pos as f32 * node_spacing,
                y: *layer as f32 * layer_spacing,
                layer: *layer,
            });
        }
    }

    // 构建边
    let mut edges = Vec::new();
    for (id, _, _, _, deps) in &nodes_raw {
        for dep in deps {
            edges.push(DagEdge {
                from: dep.clone(),
                to: id.clone(),
            });
        }
    }

    DagVisualizationResult {
        dag_id: resolved_dag_id,
        nodes: visualization_nodes,
        edges,
    }
}

/// 获取 DAG 指标。
pub async fn get_dag_metrics(dag_id: Option<&str>) -> DagMetricsResult {
    let scheduler: Option<DagScheduler> = if let Some(id) = dag_id {
        get_dag_scheduler_by_id(Some(id))
    } else {
        get_dag_scheduler()
    };

    let Some(scheduler) = scheduler else {
        return DagMetricsResult {
            total_nodes: 0,
            completed_nodes: 0,
            failed_nodes: 0,
            running_nodes: 0,
            pending_nodes: 0,
            avg_completion_time_secs: None,
        };
    };

    let statuses = extract_statuses(&scheduler).await;

    let total_nodes = statuses.len() as u32;
    let completed_nodes = statuses
        .iter()
        .filter(|s| s.as_str() == "completed")
        .count() as u32;
    let failed_nodes = statuses.iter().filter(|s| s.as_str() == "failed").count() as u32;
    let running_nodes = statuses.iter().filter(|s| s.as_str() == "running").count() as u32;
    let pending_nodes = statuses.iter().filter(|s| s.as_str() == "pending").count() as u32;

    DagMetricsResult {
        total_nodes,
        completed_nodes,
        failed_nodes,
        running_nodes,
        pending_nodes,
        avg_completion_time_secs: None, // TODO: 从时间戳计算
    }
}

/// 列出所有 DAG。
pub async fn list_dags() -> Vec<DagListEntry> {
    let schedulers = list_dag_schedulers();
    let mut entries = Vec::new();

    for scheduler in schedulers {
        let progress = scheduler.progress().await;
        let is_complete = scheduler.is_complete().await;
        let status_prompt = scheduler.status_prompt().await;

        entries.push(DagListEntry {
            dag_id: scheduler.dag_id().to_string(),
            progress,
            is_complete,
            status_prompt,
        });
    }

    entries
}

/// 从磁盘加载已完成的 DAG 状态。
///
/// 扫描 `<project_root>/.ergatai/` 下最新的 `dag-state-*.json` 文件，
/// 若其 graph 显示所有节点处于终态则返回 completed 状态。
pub async fn load_completed_dag_from_disk() -> Option<DagStatusInfo> {
    let project_root = std::env::current_dir().ok()?;
    let ergatai_dir = project_root.join(".ergatai");

    // 收集 dag-state-*.json 文件
    let mut dag_files: Vec<PathBuf> = Vec::new();
    let mut entries = tokio::fs::read_dir(&ergatai_dir).await.ok()?;
    while let Ok(Some(entry)) = entries.next_entry().await {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) == Some("json")
            && path
                .file_name()
                .and_then(|n| n.to_str())
                .is_some_and(|n| n.starts_with("dag-state-"))
        {
            dag_files.push(path);
        }
    }

    if dag_files.is_empty() {
        // 兼容旧的单文件
        let legacy = ergatai_dir.join("dag-state.json");
        if legacy.exists() {
            dag_files.push(legacy);
        }
    }

    if dag_files.is_empty() {
        return None;
    }

    // 选择最近修改的文件
    let mut best: Option<(PathBuf, std::time::SystemTime)> = None;
    for path in &dag_files {
        if let Ok(meta) = tokio::fs::metadata(path).await {
            if let Ok(modified) = meta.modified() {
                if best.as_ref().is_none_or(|(_, t)| modified > *t) {
                    best = Some((path.clone(), modified));
                }
            }
        }
    }
    let (best_path, _) = best?;

    // 防止过大文件
    const MAX_DAG_STATE_SIZE: u64 = 10 * 1024 * 1024; // 10 MB
    if let Ok(meta) = tokio::fs::metadata(&best_path).await {
        if meta.len() > MAX_DAG_STATE_SIZE {
            tracing::warn!(
                path = %best_path.display(),
                size = meta.len(),
                limit = MAX_DAG_STATE_SIZE,
                "DAG state file exceeds size limit, skipping"
            );
            return None;
        }
    }

    let graph = TaskGraph::load_from_file(&best_path).await.ok()?;

    // 仅在所有节点终态时才报告 completed
    if !graph.is_complete() {
        return None;
    }

    let total = graph.nodes.len();
    let completed = graph
        .nodes
        .iter()
        .filter(|n| matches!(n.status, TaskStatus::Completed))
        .count();
    let failed = graph
        .nodes
        .iter()
        .filter(|n| matches!(n.status, TaskStatus::Failed))
        .count();
    let percent = if total > 0 {
        ((completed + failed) as f64 / total as f64 * 100.0)
            .round()
            .min(100.0) as u32
    } else {
        0
    };

    let dag_id = graph
        .dag_id
        .clone()
        .unwrap_or_else(|| "unknown".to_string());

    let nodes: Vec<NodeStatusInfo> = graph
        .nodes
        .iter()
        .map(|n| NodeStatusInfo {
            id: n.id.clone(),
            agent: n.agent.clone(),
            task: n.task.clone(),
            status: format!("{:?}", n.status),
            depends_on: n.depends_on.clone(),
            output: None,
        })
        .collect();

    // 加载协作元数据
    let collab_meta = DagScheduler::load_collaboration_meta(&project_root, &dag_id)
        .await
        .map(|v| {
            serde_json::from_value::<DagCollaborationInfo>(v).unwrap_or_else(|_| {
                DagCollaborationInfo {
                    dag_id: dag_id.clone(),
                    policy: "N/A".to_string(),
                    participants: Vec::new(),
                    participant_count: 0,
                    created_at: "N/A".to_string(),
                }
            })
        });

    Some(DagStatusInfo {
        running: false,
        progress: Some(percent as f64),
        status_prompt: Some("All nodes have reached a terminal state".to_string()),
        is_complete: Some(true),
        nodes: Some(nodes),
        collaboration: collab_meta,
        progress_detail: Some(DagProgressDetail {
            completed,
            running: 0,
            failed,
            pending: 0,
            total,
            percent,
        }),
        graph_snapshot: None,
    })
}

// ── 内部辅助函数 ──────────────────────────────────────────────────────

/// 从调度器的 graph_snapshot 解析节点列表（REST 用）。
async fn parse_graph_nodes_from_snapshot(scheduler: &DagScheduler) -> Vec<NodeStatusInfo> {
    let snapshot_json = match scheduler.graph_snapshot().await {
        Ok(s) => s,
        Err(_) => return Vec::new(),
    };

    let snapshot: Value = match serde_json::from_str(&snapshot_json) {
        Ok(v) => v,
        Err(_) => return Vec::new(),
    };

    let Some(nodes_array) = snapshot.get("nodes").and_then(|n| n.as_array()) else {
        return Vec::new();
    };

    nodes_array
        .iter()
        .filter_map(|node| {
            Some(NodeStatusInfo {
                id: node.get("id")?.as_str()?.to_string(),
                agent: node.get("agent")?.as_str()?.to_string(),
                task: node.get("task")?.as_str()?.to_string(),
                status: node.get("status")?.as_str()?.to_string(),
                depends_on: node
                    .get("depends_on")
                    .and_then(|d| d.as_array())
                    .map(|arr| {
                        arr.iter()
                            .filter_map(|v| v.as_str().map(String::from))
                            .collect()
                    })
                    .unwrap_or_default(),
                output: None,
            })
        })
        .collect()
}

/// 从调度器提取原始节点元组（可视化用）。
async fn extract_raw_nodes(
    scheduler: &DagScheduler,
) -> Vec<(String, String, String, String, Vec<String>)> {
    let snapshot_json = match scheduler.graph_snapshot().await {
        Ok(s) => s,
        Err(_) => return Vec::new(),
    };

    let snapshot: Value = match serde_json::from_str(&snapshot_json) {
        Ok(v) => v,
        Err(_) => return Vec::new(),
    };

    let Some(nodes_array) = snapshot.get("nodes").and_then(|n| n.as_array()) else {
        return Vec::new();
    };

    nodes_array
        .iter()
        .filter_map(|node| {
            Some((
                node.get("id")?.as_str()?.to_string(),
                node.get("agent")?.as_str()?.to_string(),
                node.get("task")?.as_str()?.to_string(),
                node.get("status")?.as_str()?.to_string(),
                node.get("depends_on")
                    .and_then(|d| d.as_array())
                    .map(|arr| {
                        arr.iter()
                            .filter_map(|v| v.as_str().map(String::from))
                            .collect::<Vec<String>>()
                    })
                    .unwrap_or_default(),
            ))
        })
        .collect()
}

/// 从调度器提取节点状态列表（指标用）。
async fn extract_statuses(scheduler: &DagScheduler) -> Vec<String> {
    let snapshot_json = match scheduler.graph_snapshot().await {
        Ok(s) => s,
        Err(_) => return Vec::new(),
    };

    let snapshot: Value = match serde_json::from_str(&snapshot_json) {
        Ok(v) => v,
        Err(_) => return Vec::new(),
    };

    let Some(nodes_array) = snapshot.get("nodes").and_then(|n| n.as_array()) else {
        return Vec::new();
    };

    nodes_array
        .iter()
        .filter_map(|node| node.get("status")?.as_str().map(|s| s.to_string()))
        .collect()
}

/// BFS 拓扑排序计算每个节点的 layer（根节点 layer=0）。
fn compute_layers(nodes: &[(String, String, String, String, Vec<String>)]) -> HashMap<String, u32> {
    let mut node_layers: HashMap<String, u32> = HashMap::new();
    let mut queue: std::collections::VecDeque<(String, u32)> = std::collections::VecDeque::new();

    // 找到根节点（无依赖）
    for (id, _, _, _, deps) in nodes {
        if deps.is_empty() {
            queue.push_back((id.clone(), 0));
        }
    }

    // BFS 分配 layers — FIFO 确保找到最短路径
    while let Some((id, layer)) = queue.pop_front() {
        if let Some(&existing_layer) = node_layers.get(&id) {
            if existing_layer <= layer {
                continue;
            }
        }
        node_layers.insert(id.clone(), layer);

        // 找依赖此节点的节点
        for (other_id, _, _, _, deps) in nodes {
            if deps.contains(&id) {
                queue.push_back((other_id.clone(), layer + 1));
            }
        }
    }

    node_layers
}

/// 计算调度器的进度明细。
async fn compute_progress_detail(scheduler: &DagScheduler) -> DagProgressDetail {
    let graph_arc = scheduler.graph();
    let graph = graph_arc.lock().await;
    let total = graph.nodes.len();
    let completed = graph
        .nodes
        .iter()
        .filter(|n| matches!(n.status, TaskStatus::Completed))
        .count();
    let running = graph
        .nodes
        .iter()
        .filter(|n| matches!(n.status, TaskStatus::Running))
        .count();
    let failed = graph
        .nodes
        .iter()
        .filter(|n| matches!(n.status, TaskStatus::Failed))
        .count();
    let pending = graph
        .nodes
        .iter()
        .filter(|n| matches!(n.status, TaskStatus::Pending))
        .count();
    let percent = if total > 0 {
        ((completed + failed) as f64 / total as f64 * 100.0)
            .round()
            .min(100.0) as u32
    } else {
        0
    };
    drop(graph);

    DagProgressDetail {
        completed,
        running,
        failed,
        pending,
        total,
        percent,
    }
}
