import { useMemo } from "react";
import {
  Ban,
  CheckCircle,
  Clock,
  List,
  Loader2,
  MessageCircle,
  Network,
  Pause,
  Square,
  Timer,
  XCircle,
} from "lucide-react";
import {
  useConversationStore,
} from "../../../core/workspace/conversationStore";
import { useGroupStore } from "../../../core/workspace/groupStore";
import { useAgentSessionStore } from "../../../core/workspace/sessionStore";
import { sortTasks, useTaskStore, type Task, type TaskPriority, type TaskStatus } from "../../../core/workspace/taskStore";
import { useWorkspaceStore } from "../../../core/workspace/workspaceStore";
import { ChatPanel as UnifiedChatPanel } from "../../chat/ChatPanel";
import { DAGView } from "./DAGView";


function statusMeta(status: TaskStatus) {
  const metadata: Record<TaskStatus, { label: string; className: string; icon: typeof Clock }> = {
    pending: { label: "待执行", className: "text-muted bg-muted/10", icon: Clock },
    queued: { label: "已排队", className: "text-yellow-600 bg-yellow-500/10", icon: Clock },
    running: { label: "执行中", className: "text-blue-600 bg-blue-500/10", icon: Loader2 },
    waiting: { label: "等待确认", className: "text-orange-600 bg-orange-500/10", icon: Timer },
    completed: { label: "已完成", className: "text-green-600 bg-green-500/10", icon: CheckCircle },
    failed: { label: "失败", className: "text-red-600 bg-red-500/10", icon: XCircle },
    cancelled: { label: "已取消", className: "text-gray-500 bg-gray-500/10", icon: Ban },
  };
  return metadata[status];
}

export function MainArea() {
  const activeView = useWorkspaceStore((state) => state.activeView);

  return (
    <div className="min-h-0 flex-1">
        {activeView === "conversation" && <ConversationView />}
        {activeView === "task-kanban" && <TaskKanbanView />}
        {activeView === "dag" && <DAGView />}
        {activeView === "empty" && <EmptyView />}
      </div>
  );
}

function ConversationView() {
  const mode = useWorkspaceStore((state) => state.mode);
  const selectedConversationId = useWorkspaceStore((state) => state.selectedConversationId);
  const conversations = useConversationStore((state) => state.conversations);
  const messages = useConversationStore((state) => state.messages);
  const activeGroupId = useGroupStore((state) => state.activeGroupId);
  const groups = useGroupStore((state) => state.groups);
  const activeSessionId = useAgentSessionStore((state) => state.activeSessionId);
  const sessions = useAgentSessionStore((state) => state.sessions);

  const fallbackId = mode === "group"
    ? `group-${activeGroupId ?? groups[0]?.id}`
    : `direct-${activeSessionId ?? sessions[0]?.id}`;
  const conversationId = selectedConversationId ?? fallbackId;
  const conversation = conversations.find((item) => item.id === conversationId);
  const conversationMessages = messages.filter((message) => message.conversationId === conversationId);

  if (!conversation) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <div className="max-w-sm text-center">
          <MessageCircle className="mx-auto mb-4 h-12 w-12 text-muted" />
          <h2 className="mb-2 text-lg font-medium text-text">选择对话</h2>
          <p className="text-sm text-muted">从左侧选择一个项目群或 Agent 会话，消息和任务活动会显示在这里。</p>
        </div>
      </div>
    );
  }

  const openTask = useWorkspaceStore((state) => state.openTask);
  const respondToApproval = useConversationStore((state) => state.respondToApproval);

  return (
    <UnifiedChatPanel
      mode="group"
      conversationId={conversation.id}
      conversationStore={{
        conversation,
        messages: conversationMessages,
        sendMessage: useConversationStore.getState().sendMessage,
      }}
      onTaskClick={openTask}
      onApprovalAction={(approvalId: string, action: 'approve' | 'reject') => {
        // TODO: 需要找到对应的 messageId
        respondToApproval('unknown', approvalId, action === 'approve');
      }}
      className="h-full"
    />
  );
}

function TaskKanbanView() {
  const storedTasks = useTaskStore((state) => state.tasks);
  const tasks = useMemo(
    () => sortTasks(storedTasks.filter((task) => !task.archived)),
    [storedTasks],
  );
  const selectedTaskId = useWorkspaceStore((state) => state.selectedTaskId);
  const selectedTask = tasks.find((task) => task.id === selectedTaskId);

  return (
    <div className="flex h-full min-h-0">
      <div className="min-w-0 flex-1 overflow-x-auto p-5">
        <div className="flex h-full min-w-[1000px] gap-4">
          <TaskColumn tasks={tasks} statuses={["pending", "queued"]} title="尚未开始" color="text-muted" />
          <TaskColumn tasks={tasks} statuses={["running", "waiting"]} title="进行中" color="text-blue-600" />
          <TaskColumn tasks={tasks} statuses={["completed"]} title="成功" color="text-green-600" />
          <TaskColumn tasks={tasks} statuses={["failed", "cancelled"]} title="失败" color="text-red-600" />
        </div>
      </div>
      {selectedTask && <TaskDetailPanel task={selectedTask} />}
    </div>
  );
}

function TaskColumn({
  tasks,
  statuses,
  title,
  color,
}: {
  tasks: Task[];
  statuses: TaskStatus[];
  title: string;
  color: string;
}) {
  const columnTasks = tasks.filter((task) => statuses.includes(task.status));

  return (
    <section className="flex min-w-[250px] flex-1 flex-col rounded-xl border border-border-subtle bg-surface">
      <header className="flex items-center justify-between border-b border-border-subtle px-4 py-3">
        <h3 className={`text-sm font-medium ${color}`}>{title}</h3>
        <span className="text-xs text-muted">{columnTasks.length}</span>
      </header>
      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-2">
        {columnTasks.map((task) => <TaskCard key={task.id} task={task} />)}
      </div>
    </section>
  );
}

function TaskCard({ task }: { task: Task }) {
  const selectedTaskId = useWorkspaceStore((state) => state.selectedTaskId);
  const openTask = useWorkspaceStore((state) => state.openTask);
  const meta = statusMeta(task.status);

  return (
    <button
      type="button"
      onClick={() => openTask(task.id)}
      className={`w-full rounded-lg border bg-bg p-3 text-left transition-colors hover:border-primary/50 ${
        selectedTaskId === task.id ? "border-primary" : "border-border-subtle"
      }`}
    >
      <div className="flex items-start justify-between gap-2">
        <p className="text-sm font-medium text-text">{task.title}</p>
        <PriorityBadge priority={task.priority} />
      </div>
      <div className="mt-2 flex items-center gap-2 text-xs text-muted">
        <meta.icon className={`h-3.5 w-3.5 ${task.status === "running" ? "animate-spin" : ""}`} />
        <span>{meta.label}</span>
        {typeof task.progress === "number" && <span>{task.progress}%</span>}
      </div>
      {task.assignee && <p className="mt-1 text-xs text-muted">{task.assignee.name}</p>}
    </button>
  );
}

function PriorityBadge({ priority }: { priority: TaskPriority }) {
  const labels = { urgent: "紧急", high: "高", medium: "中", low: "低" } as const;
  const colors = {
    urgent: "bg-red-500/10 text-red-600",
    high: "bg-orange-500/10 text-orange-600",
    medium: "bg-blue-500/10 text-blue-600",
    low: "bg-muted/10 text-muted",
  } as const;

  return <span className={`rounded px-1.5 py-0.5 text-xs font-medium ${colors[priority]}`}>{labels[priority]}</span>;
}

function TaskDetailPanel({ task }: { task: Task }) {
  const updateTask = useTaskStore((state) => state.updateTask);
  const setView = useWorkspaceStore((state) => state.setView);
  const meta = statusMeta(task.status);

  return (
    <aside className="flex h-full w-[360px] flex-shrink-0 flex-col border-l border-border-subtle bg-surface">
      <header className="border-b border-border-subtle px-4 py-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-medium text-text">任务详情</h3>
          <button type="button" onClick={() => setView("dag")} className="flex items-center gap-1 text-xs text-primary hover:underline">
            <Network className="h-3.5 w-3.5" />
            DAG
          </button>
        </div>
        <p className="mt-1 text-base font-medium text-text">{task.title}</p>
      </header>

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
        <div className="flex items-center gap-2">
          <span className={`flex items-center gap-1 rounded-full px-2 py-1 text-xs font-medium ${meta.className}`}>
            <meta.icon className={`h-3 w-3 ${task.status === "running" ? "animate-spin" : ""}`} />
            {meta.label}
          </span>
          {typeof task.progress === "number" && <span className="text-xs text-muted">进度 {task.progress}%</span>}
        </div>

        {task.description && <p className="text-sm text-text">{task.description}</p>}
        {task.statusSummary && (
          <div>
            <h4 className="mb-1 text-xs font-medium text-muted">当前状态</h4>
            <p className="text-sm text-text">{task.statusSummary}</p>
          </div>
        )}
        {task.assignee && (
          <div>
            <h4 className="mb-1 text-xs font-medium text-muted">负责人</h4>
            <p className="text-sm text-text">{task.assignee.name} · {task.assignee.type}</p>
          </div>
        )}
        {task.dependsOn?.length ? (
          <div>
            <h4 className="mb-1 text-xs font-medium text-muted">依赖</h4>
            <p className="font-mono text-xs text-text">{task.dependsOn.join(", ")}</p>
          </div>
        ) : null}
        {task.result?.summary && (
          <div>
            <h4 className="mb-1 text-xs font-medium text-muted">结果</h4>
            <p className="text-sm text-text">{task.result.summary}</p>
          </div>
        )}
      </div>

      <div className="flex flex-wrap gap-2 border-t border-border-subtle p-4">
        {(task.status === "running" || task.status === "waiting") && (
          <button
            type="button"
            onClick={() => updateTask(task.id, { status: "queued", statusSummary: "用户暂停了任务" })}
            className="flex items-center gap-1 rounded-md border border-border-subtle px-2.5 py-1 text-xs text-text hover:bg-bg"
          >
            <Pause className="h-3 w-3" />
            暂停
          </button>
        )}
        {task.status !== "completed" && task.status !== "cancelled" && (
          <button
            type="button"
            onClick={() => updateTask(task.id, { status: "cancelled", statusSummary: "用户取消了任务" })}
            className="flex items-center gap-1 rounded-md border border-red-500/30 px-2.5 py-1 text-xs text-red-500 hover:bg-red-500/10"
          >
            <Square className="h-3 w-3" />
            取消
          </button>
        )}
      </div>
    </aside>
  );
}

function EmptyView() {
  return (
    <div className="flex h-full items-center justify-center">
      <div className="text-center">
        <List className="mx-auto mb-4 h-14 w-14 text-muted" />
        <h3 className="mb-2 text-lg font-medium text-text">开始协作</h3>
        <p className="text-sm text-muted">选择一个群聊或会话，或从任务看板查看执行状态。</p>
      </div>
    </div>
  );
}
