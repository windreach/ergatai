import { create } from "zustand";

// 扩展任务状态到 7 种
export type TaskStatus =
  | "pending"      // 待执行
  | "queued"       // 已排队
  | "running"      // 执行中
  | "waiting"      // 等待依赖/审批
  | "completed"    // 已完成
  | "failed"       // 失败
  | "cancelled";   // 已取消

// 任务优先级
export type TaskPriority = "low" | "medium" | "high" | "urgent";

// Agent 信息
export interface AgentInfo {
  id: string;
  name: string;
  type: string; // Claude, Codex, GPT-4, etc.
  avatar?: string;
}

// 任务来源
export type TaskSource =
  | { type: "group_chat"; conversationId: string; messageId: string }
  | { type: "agent_mode"; sessionId: string; parentAgentId: string }
  | { type: "dag"; dagId: string; nodeId: string }
  | { type: "manual"; userId: string };

// 任务结果
export interface TaskResult {
  summary: string;
  artifacts?: Artifact[];
  metrics?: TaskMetrics;
}

export interface Artifact {
  name: string;
  type: string;
  size?: number;
  url?: string;
}

export interface TaskMetrics {
  duration?: number; // 秒
  filesRead?: number;
  filesWritten?: number;
  toolCalls?: number;
}

// 扩展 Task 接口
export interface Task {
  id: string;
  title: string;
  status: TaskStatus;
  priority: TaskPriority;
  source: TaskSource;

  // 执行信息
  assignee?: AgentInfo;
  collaborators?: AgentInfo[];

  // 依赖关系
  dependsOn?: string[];
  blockedBy?: string[];

  // 时间信息
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
  estimatedDuration?: number; // 秒

  // 进度信息
  progress?: number; // 0-100
  statusSummary?: string; // 当前状态摘要

  // DAG 信息
  dagId?: string;
  dagNodeId?: string;

  // 结果
  result?: TaskResult;

  // 可选描述
  description?: string;

  // 归档后不再显示在默认任务列表和看板
  archived?: boolean;
}

interface TaskState {
  tasks: Task[];
  addTask: (task: Omit<Task, "id" | "createdAt" | "updatedAt"> & { id?: string }) => string;
  updateTask: (id: string, updates: Partial<Task>) => void;
  removeTask: (id: string) => void;
  getTasksByStatus: (status: TaskStatus) => Task[];
  getSortedTasks: () => Task[];
}

// 任务排序规则：运行中/等待中置顶，按更新时间排序
export function sortTasks(tasks: Task[]): Task[] {
  const statusPriority: Record<TaskStatus, number> = {
    running: 0,
    waiting: 1,
    queued: 2,
    pending: 3,
    completed: 4,
    failed: 5,
    cancelled: 6,
  };

  return [...tasks].sort((a, b) => {
    const priorityA = statusPriority[a.status];
    const priorityB = statusPriority[b.status];

    if (priorityA !== priorityB) {
      return priorityA - priorityB;
    }

    // 同状态按更新时间降序
    return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
  });
}

export const useTaskStore = create<TaskState>((set, get) => ({
  tasks: [
    // Mock data - 使用新的完整模型
    {
      id: "1",
      title: "修复登录超时",
      status: "running",
      priority: "high",
      source: { type: "group_chat", conversationId: "conv1", messageId: "msg1" },
      assignee: { id: "agent1", name: "Codex", type: "Codex" },
      progress: 60,
      statusSummary: "正在定位 refresh token 竞态条件",
      startedAt: new Date(Date.now() - 8 * 60 * 1000).toISOString(),
      createdAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
      updatedAt: new Date().toISOString(),
    },
    {
      id: "2",
      title: "审查代码变更",
      status: "waiting",
      priority: "medium",
      source: { type: "dag", dagId: "dag1", nodeId: "node2" },
      assignee: { id: "agent2", name: "Claude", type: "Claude" },
      dependsOn: ["1"],
      statusSummary: "等待前置任务完成",
      createdAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
      updatedAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
    },
    {
      id: "3",
      title: "分析问题",
      status: "completed",
      priority: "high",
      source: { type: "agent_mode", sessionId: "session1", parentAgentId: "agent1" },
      assignee: { id: "agent1", name: "Codex", type: "Codex" },
      progress: 100,
      statusSummary: "已定位问题根因",
      startedAt: new Date(Date.now() - 15 * 60 * 1000).toISOString(),
      completedAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
      createdAt: new Date(Date.now() - 20 * 60 * 1000).toISOString(),
      updatedAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
    },
  ],

  addTask: (task) => {
    const id = task.id ?? crypto.randomUUID();
    set((state) => ({
      tasks: [
        ...state.tasks,
        {
          ...task,
          id,
          archived: task.archived ?? false,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ],
    }));
    return id;
  },

  updateTask: (id, updates) =>
    set((state) => ({
      tasks: state.tasks.map((task) =>
        task.id === id
          ? { ...task, ...updates, updatedAt: new Date().toISOString() }
          : task
      ),
    })),

  removeTask: (id) =>
    set((state) => ({
      tasks: state.tasks.filter((task) => task.id !== id),
    })),

  getTasksByStatus: (status) => get().tasks.filter((task) => task.status === status && !task.archived),

  getSortedTasks: () => sortTasks(get().tasks.filter((task) => !task.archived)),
}));
