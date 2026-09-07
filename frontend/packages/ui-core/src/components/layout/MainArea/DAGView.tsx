import { useCallback, useEffect, useMemo, useState, type CSSProperties } from "react";
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  MarkerType,
  useNodesState,
  useEdgesState,
  type Node,
  type Edge,
  type NodeMouseHandler,
  type EdgeMouseHandler,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { X, User, Clock, CheckCircle, XCircle, Loader2, Timer, Circle, Ban } from "lucide-react";
import { useTaskStore, type TaskStatus, type Task } from "../../../core/workspace/taskStore";

interface TaskNodeData {
  [key: string]: unknown;
  label: string;
  status: TaskStatus;
  description?: string;
  taskId: string;
}

const getNodeStyle = (status: TaskStatus) => {
  const styles: Record<TaskStatus, CSSProperties> = {
    pending: {
      background: "#f5f5f5",
      border: "2px solid #d9d9d9",
      color: "#666",
    },
    running: {
      background: "#e6f7ff",
      border: "2px solid #1890ff",
      color: "#1890ff",
    },
    completed: {
      background: "#f6ffed",
      border: "2px solid #52c41a",
      color: "#52c41a",
    },
    failed: {
      background: "#fff2f0",
      border: "2px solid #ff4d4f",
      color: "#ff4d4f",
    },
    queued: {
      background: "#fffbe6",
      border: "2px solid #faad14",
      color: "#faad14",
    },
    waiting: {
      background: "#fff7e6",
      border: "2px solid #fa8c16",
      color: "#fa8c16",
    },
    cancelled: {
      background: "#fafafa",
      border: "2px solid #bfbfbf",
      color: "#8c8c8c",
    },
  };
  return styles[status];
};

const statusLabels: Record<TaskStatus, string> = {
  pending: "待执行",
  queued: "已排队",
  running: "执行中...",
  waiting: "等待中",
  completed: "已完成",
  failed: "失败",
  cancelled: "已取消",
};

const StatusIcon = ({ status, className = "h-3.5 w-3.5" }: { status: TaskStatus; className?: string }) => {
  const icons: Record<TaskStatus, React.ReactElement> = {
    pending: <Circle className={className} />,
    queued: <Clock className={className} />,
    running: <Loader2 className={`${className} animate-spin`} />,
    waiting: <Timer className={className} />,
    completed: <CheckCircle className={className} />,
    failed: <XCircle className={className} />,
    cancelled: <Ban className={className} />,
  };
  return icons[status] || icons.pending;
};

function TaskNode({ data }: { data: TaskNodeData }) {
  const style = getNodeStyle(data.status);

  return (
    <div
      style={{
        padding: "12px 16px",
        borderRadius: "8px",
        ...style,
        minWidth: "150px",
        cursor: "pointer",
      }}
    >
      <div style={{ fontWeight: "bold", marginBottom: "4px" }}>{data.label}</div>
      {data.description && (
        <div style={{ fontSize: "12px", opacity: 0.8 }}>{data.description}</div>
      )}
      <div
        style={{
          fontSize: "11px",
          marginTop: "6px",
          opacity: 0.7,
          display: "flex",
          alignItems: "center",
          gap: "4px",
        }}
      >
        <StatusIcon status={data.status} className="h-3 w-3" />
        <span>{statusLabels[data.status]}</span>
      </div>
    </div>
  );
}

const nodeTypes = {
  task: TaskNode,
};

interface DetailState {
  type: "node" | "edge";
  id: string;
}

export function DAGView() {
  const tasks = useTaskStore((state) => state.tasks);
  const [detail, setDetail] = useState<DetailState | null>(null);

  const initialNodes: Node<TaskNodeData>[] = useMemo(() => {
    return tasks.map((task, index) => ({
      id: task.id,
      type: "task",
      position: {
        x: 250 * (index % 3),
        y: 150 * Math.floor(index / 3),
      },
      data: {
        label: task.title,
        status: task.status,
        description: task.description,
        taskId: task.id,
      },
    }));
  }, [tasks]);

  const initialEdges: Edge[] = useMemo(() => {
    const edges: Edge[] = [];

    for (const task of tasks) {
      if (task.dependsOn && task.dependsOn.length > 0) {
        for (const dep of task.dependsOn) {
          const depTask = tasks.find((t) => t.id === dep);
          if (depTask) {
            edges.push({
              id: `e${dep}-${task.id}`,
              source: dep,
              target: task.id,
              type: "smoothstep",
              markerEnd: {
                type: MarkerType.ArrowClosed,
              },
              style: {
                strokeWidth: 2,
                stroke: "#b1b1b7",
              },
              label: "依赖",
            });
          }
        }
      }
    }

    if (edges.length === 0) {
      for (let i = 0; i < tasks.length - 1; i++) {
        edges.push({
          id: `e${tasks[i].id}-${tasks[i + 1].id}`,
          source: tasks[i].id,
          target: tasks[i + 1].id,
          type: "smoothstep",
          markerEnd: {
            type: MarkerType.ArrowClosed,
          },
          style: {
            strokeWidth: 2,
            stroke: "#b1b1b7",
          },
        });
      }
    }
    return edges;
  }, [tasks]);

  const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges);

  useEffect(() => {
    setNodes(initialNodes);
    setEdges(initialEdges);
  }, [initialNodes, initialEdges, setNodes, setEdges]);

  useEffect(() => {
    if (detail?.type === "node") {
      setNodes((nds) =>
        nds.map((n) => ({
          ...n,
          style: {
            ...n.style,
            boxShadow: n.id === detail.id ? "0 0 0 3px #1890ff" : undefined,
          },
        }))
      );
    }
  }, [detail, setNodes]);

  const handleNodeClick: NodeMouseHandler = useCallback((_, node) => {
    setDetail({ type: "node", id: node.id });
  }, []);

  const handleEdgeClick: EdgeMouseHandler = useCallback((_, edge) => {
    setDetail({ type: "edge", id: edge.id });
  }, []);

  const handleExport = () => {
    const data = {
      nodes: initialNodes,
      edges: initialEdges,
      exportedAt: new Date().toISOString(),
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `dag-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const selectedTask = detail?.type === "node" ? tasks.find((t) => t.id === detail.id) : null;
  const selectedEdge = detail?.type === "edge"
    ? initialEdges.find((e) => e.id === detail.id)
    : null;
  const sourceTask = selectedEdge ? tasks.find((t) => t.id === selectedEdge.source) : null;
  const targetTask = selectedEdge ? tasks.find((t) => t.id === selectedEdge.target) : null;

  return (
    <div style={{ width: "100%", height: "100%", position: "relative" }}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeClick={handleNodeClick}
        onEdgeClick={handleEdgeClick}
        nodeTypes={nodeTypes}
        fitView
        attributionPosition="bottom-left"
      >
        <Background />
        <Controls />
        <MiniMap
          nodeStrokeColor={(n) => {
            const status = (n.data as TaskNodeData)?.status;
            if (!status) return "#999";
            const colors: Record<TaskStatus, string> = {
              pending: "#d9d9d9",
              queued: "#faad14",
              running: "#1890ff",
              waiting: "#fa8c16",
              completed: "#52c41a",
              failed: "#ff4d4f",
              cancelled: "#bfbfbf",
            };
            return colors[status];
          }}
        />
      </ReactFlow>

      <div className="absolute right-4 top-4 z-10 flex gap-2">
        <button
          onClick={handleExport}
          className="rounded bg-surface px-3 py-1.5 text-xs text-text shadow hover:bg-bg"
        >
          导出 JSON
        </button>
      </div>

      {detail && (
        <div className="absolute right-0 top-0 z-20 flex h-full w-[280px] flex-col border-l border-border-subtle bg-surface shadow-lg">
          <div className="flex items-center justify-between border-b border-border-subtle px-3 py-2">
            <h3 className="text-sm font-medium text-text">
              {detail.type === "node" ? "节点详情" : "依赖关系"}
            </h3>
            <button
              onClick={() => setDetail(null)}
              className="text-muted hover:text-text"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
          <div className="flex-1 overflow-y-auto p-3">
            {selectedTask && <TaskDetailPanel task={selectedTask} />}
            {selectedEdge && sourceTask && targetTask && (
              <EdgeDetailPanel edge={selectedEdge} source={sourceTask} target={targetTask} />
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function TaskDetailPanel({ task }: { task: Task }) {
  return (
    <div className="space-y-3">
      <div>
        <div className="text-xs text-muted">任务名称</div>
        <div className="text-sm font-medium text-text">{task.title}</div>
      </div>

      <div>
        <div className="text-xs text-muted">状态</div>
        <div className="flex items-center gap-1.5 text-sm text-text">
          <StatusIcon status={task.status} />
          <span>{statusLabels[task.status]}</span>
        </div>
      </div>

      <div>
        <div className="text-xs text-muted">优先级</div>
        <div className="text-sm text-text">{task.priority}</div>
      </div>

      {task.assignee && (
        <div>
          <div className="mb-1 text-xs text-muted">执行者</div>
          <div className="flex items-center gap-1.5 text-sm text-text">
            <User className="h-3.5 w-3.5" />
            <span>{task.assignee.name}</span>
            <span className="text-xs text-muted">({task.assignee.type})</span>
          </div>
        </div>
      )}

      {task.collaborators && task.collaborators.length > 0 && (
        <div>
          <div className="mb-1 text-xs text-muted">协作者</div>
          <div className="space-y-1">
            {task.collaborators.map((c) => (
              <div key={c.id} className="flex items-center gap-1.5 text-sm text-text">
                <User className="h-3.5 w-3.5" />
                <span>{c.name}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {task.description && (
        <div>
          <div className="mb-1 text-xs text-muted">描述</div>
          <div className="text-sm text-text">{task.description}</div>
        </div>
      )}

      {task.dependsOn && task.dependsOn.length > 0 && (
        <div>
          <div className="mb-1 text-xs text-muted">依赖</div>
          <div className="space-y-1">
            {task.dependsOn.map((id) => (
              <div key={id} className="text-xs text-muted">
                {id}
              </div>
            ))}
          </div>
        </div>
      )}

      {task.statusSummary && (
        <div>
          <div className="mb-1 text-xs text-muted">状态摘要</div>
          <div className="text-sm text-text">{task.statusSummary}</div>
        </div>
      )}

      <div>
        <div className="text-xs text-muted">时间</div>
        <div className="text-xs text-muted">
          创建: {new Date(task.createdAt).toLocaleString("zh-CN")}
        </div>
        <div className="text-xs text-muted">
          更新: {new Date(task.updatedAt).toLocaleString("zh-CN")}
        </div>
        {task.completedAt && (
          <div className="text-xs text-muted">
            完成: {new Date(task.completedAt).toLocaleString("zh-CN")}
          </div>
        )}
      </div>
    </div>
  );
}

function EdgeDetailPanel({
  edge,
  source,
  target,
}: {
  edge: Edge;
  source: Task;
  target: Task;
}) {
  return (
    <div className="space-y-3">
      <div>
        <div className="text-xs text-muted">关系</div>
        <div className="text-sm font-medium text-text">
          {source.title} → {target.title}
        </div>
      </div>

      <div>
        <div className="text-xs text-muted">类型</div>
        <div className="text-sm text-text">{edge.label || "顺序执行"}</div>
      </div>

      <div>
        <div className="mb-1 text-xs text-muted">上游任务</div>
        <div className="rounded bg-bg p-2">
          <div className="flex items-center gap-1.5">
            <StatusIcon status={source.status} />
            <span className="text-sm text-text">{source.title}</span>
          </div>
          <div className="mt-1 text-xs text-muted">{statusLabels[source.status]}</div>
        </div>
      </div>

      <div>
        <div className="mb-1 text-xs text-muted">下游任务</div>
        <div className="rounded bg-bg p-2">
          <div className="flex items-center gap-1.5">
            <StatusIcon status={target.status} />
            <span className="text-sm text-text">{target.title}</span>
          </div>
          <div className="mt-1 text-xs text-muted">{statusLabels[target.status]}</div>
        </div>
      </div>
    </div>
  );
}
