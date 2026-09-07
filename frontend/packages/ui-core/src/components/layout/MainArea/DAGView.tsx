import { useCallback, useMemo } from "react";
import ReactFlow, {
  Node,
  Edge,
  useNodesState,
  useEdgesState,
  ControlPanel,
  Background,
  MarkerType,
} from "reactflow";
import "reactflow/dist/style.css";
import { useTaskStore } from "../../../core/workspace/taskStore";

// 定义任务节点类型
interface TaskNodeData {
  label: string;
  status: "pending" | "running" | "completed" | "failed";
  description?: string;
}

// 根据任务状态返回节点样式
const getNodeStyle = (status: TaskNodeData["status"]) => {
  const styles = {
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
  };
  return styles[status];
};

// 自定义任务节点组件
function TaskNode({ data }: { data: TaskNodeData }) {
  const style = getNodeStyle(data.status);

  return (
    <div
      style={{
        padding: "12px 16px",
        borderRadius: "8px",
        ...style,
        minWidth: "150px",
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
        }}
      >
        {data.status === "pending" && "待执行"}
        {data.status === "running" && "执行中..."}
        {data.status === "completed" && "已完成"}
        {data.status === "failed" && "失败"}
      </div>
    </div>
  );
}

// 节点类型映射
const nodeTypes = {
  task: TaskNode,
};

export function DAGView() {
  const tasks = useTaskStore((state) => state.tasks);

  // 将任务转换为 React Flow 节点
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
      },
    }));
  }, [tasks]);

  // 创建边（假设任务是顺序执行的）
  const initialEdges: Edge[] = useMemo(() => {
    const edges: Edge[] = [];
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
    return edges;
  }, [tasks]);

  const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges);

  // 当任务更新时，同步节点状态
  useMemo(() => {
    setNodes(initialNodes);
    setEdges(initialEdges);
  }, [initialNodes, initialEdges, setNodes, setEdges]);

  return (
    <div style={{ width: "100%", height: "100%" }}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        nodeTypes={nodeTypes}
        fitView
        attributionPosition="bottom-left"
      >
        <Background />
        <ControlPanel />
      </ReactFlow>
    </div>
  );
}
