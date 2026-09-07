import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import {
  Ban,
  CheckCircle,
  Clock,
  FileDiff,
  List,
  Loader2,
  MessageCircle,
  Network,
  Pause,
  Send,
  ShieldCheck,
  Square,
  Timer,
  Users,
  XCircle,
} from "lucide-react";
import {
  useConversationStore,
  type ActivityCard,
  type ApprovalCard,
  type Conversation,
  type ConversationMessage,
  type ConversationMessagePart,
} from "../../../core/workspace/conversationStore";
import { useGroupStore } from "../../../core/workspace/groupStore";
import { useSessionStore } from "../../../core/workspace/sessionStore";
import { sortTasks, useTaskStore, type Task, type TaskPriority, type TaskStatus } from "../../../core/workspace/taskStore";
import { usePanelTrigger } from "../../../core/workspace/panelAutomation";
import { useWorkspaceStore } from "../../../core/workspace/workspaceStore";
import { DAGView } from "./DAGView";

function formatTime(value: string) {
  return new Date(value).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
}

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
  const activeSessionId = useSessionStore((state) => state.activeSessionId);
  const sessions = useSessionStore((state) => state.sessions);

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

  return <ConversationSurface conversation={conversation} messages={conversationMessages} />;
}

function ConversationSurface({
  conversation,
  messages,
}: {
  conversation: Conversation;
  messages: ConversationMessage[];
}) {
  const [input, setInput] = useState("");
  const bottomRef = useRef<HTMLDivElement>(null);
  const sendMessage = useConversationStore((state) => state.sendMessage);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [messages.length]);

  const submit = () => {
    if (!input.trim()) return;
    sendMessage(conversation.id, input);
    setInput("");
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  };

  return (
    <div className="flex h-full flex-col">
      <header className="flex h-14 items-center gap-3 border-b border-border-subtle bg-surface px-5">
        <div className="flex h-9 w-9 items-center justify-center rounded-full bg-primary/10 text-primary">
          {conversation.kind === "group" ? <Users className="h-4 w-4" /> : <MessageCircle className="h-4 w-4" />}
        </div>
        <div>
          <h2 className="text-sm font-medium text-text">{conversation.title}</h2>
          <p className="text-xs text-muted">
            {conversation.members.length} 名成员 · {conversation.members.filter((member) => member.kind === "agent").length} 个 Agent
          </p>
        </div>
      </header>

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4">
        {messages.map((message) => <MessageBubble key={message.id} message={message} />)}
        <div ref={bottomRef} />
      </div>

      <div className="border-t border-border-subtle bg-surface p-4">
        <div className="rounded-xl border border-border-subtle bg-bg p-3">
          <textarea
            value={input}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="输入消息，使用 @Agent 触发任务..."
            className="min-h-[68px] w-full resize-none bg-transparent text-sm text-text placeholder:text-muted focus:outline-none"
          />
          <div className="flex items-center justify-between">
            <p className="text-xs text-muted">Enter 发送 · Shift + Enter 换行</p>
            <button
              type="button"
              onClick={submit}
              disabled={!input.trim()}
              className="flex h-9 items-center gap-2 rounded-lg bg-primary px-4 text-sm font-medium text-white transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Send className="h-4 w-4" />
              发送
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function MessageBubble({ message }: { message: ConversationMessage }) {
  if (message.senderKind === "system") {
    return (
      <div className="flex justify-center">
        <span className="rounded-full bg-bg px-3 py-1 text-xs text-muted">{renderPlainText(message.parts)}</span>
      </div>
    );
  }

  const isUser = message.senderKind === "user";

  return (
    <article className={`flex gap-3 ${isUser ? "flex-row-reverse" : ""}`}>
      <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-medium text-primary">
        {message.senderName.slice(0, 1)}
      </div>
      <div className={`min-w-0 max-w-[min(760px,88%)] ${isUser ? "text-right" : ""}`}>
        <div className={`mb-1 flex items-center gap-2 text-xs text-muted ${isUser ? "justify-end" : ""}`}>
          <span className="font-medium text-text">{message.senderName}</span>
          <span>{formatTime(message.createdAt)}</span>
        </div>
        <div className="space-y-2 text-left">
          {message.parts.map((part, index) => <MessagePart key={`${message.id}-${index}`} part={part} />)}
        </div>
      </div>
    </article>
  );
}

function MessagePart({ part }: { part: ConversationMessagePart }) {
  const openTask = useWorkspaceStore((state) => state.openTask);
  const { triggerTerminalCommand } = usePanelTrigger();

  if (part.type === "text") {
    return <p className="text-sm leading-relaxed text-text">{part.content}</p>;
  }

  if (part.type === "mention") {
    return (
      <span className="mr-1 inline-flex rounded bg-primary/10 px-1.5 py-0.5 text-sm font-medium text-primary">
        @{part.displayName}
      </span>
    );
  }

  if (part.type === "task_ref") {
    return (
      <button
        type="button"
        onClick={() => openTask(part.taskId)}
        className="block w-fit rounded-lg border border-border-subtle bg-surface px-3 py-2 text-left text-sm text-text transition-colors hover:border-primary/50"
      >
        <span className="text-xs text-muted">关联任务</span>
        <span className="block font-medium">{part.title}</span>
      </button>
    );
  }

  if (part.type === "activity_card") {
    return (
      <div className="space-y-2">
        <ActivityCardView activity={part.activity} />
        <div className="flex flex-wrap gap-2">
          {part.activity.toolCalls.map((toolCall) => (
            <button
              key={toolCall}
              type="button"
              onClick={() => triggerTerminalCommand(toolCall)}
              className="rounded-md border border-border-subtle bg-surface px-2 py-1 font-mono text-xs text-text transition-colors hover:border-primary/50"
            >
              {toolCall}
            </button>
          ))}
        </div>
      </div>
    );
  }

  if (part.type === "approval") {
    return <ApprovalCardView approval={part.approval} />;
  }

  if (part.type === "artifact") {
    const Icon = part.kind === "diff" ? FileDiff : Clock;
    return (
      <span
        className="flex w-fit items-center gap-2 rounded-lg border border-border-subtle bg-surface px-3 py-2 text-sm text-text"
      >
        <Icon className="h-4 w-4 text-primary" />
        {part.label}
        <span className="text-xs text-muted">{part.kind}</span>
      </span>
    );
  }

  return null;
}

function renderPlainText(parts: ConversationMessagePart[]) {
  return parts.map((part) => {
    if (part.type === "text") return part.content;
    if (part.type === "mention") return `@${part.displayName}`;
    if (part.type === "system_notice") return part.content;
    return "";
  }).join("");
}

function ActivityCardView({ activity }: { activity: ActivityCard }) {
  const task = useTaskStore((state) => state.tasks.find((item) => item.id === activity.taskId));
  const cancelAgentRun = useConversationStore((state) => state.cancelAgentRun);
  const openTask = useWorkspaceStore((state) => state.openTask);
  const derivedStatus = task?.status;
  const state = derivedStatus === "pending" ? activity.state : derivedStatus ?? activity.state;
  const meta = statusMeta(state);
  const StatusIcon = meta.icon;

  return (
    <section className="w-full max-w-[680px] overflow-hidden rounded-xl border border-border-subtle bg-surface">
      <div className="flex items-center justify-between gap-3 border-b border-border-subtle px-4 py-3">
        <div className="flex items-center gap-2">
          <StatusIcon className={`h-4 w-4 ${state === "running" ? "animate-spin" : ""} ${meta.className.split(" ")[0]}`} />
          <h3 className="text-sm font-medium text-text">{activity.agentName} · 活动卡</h3>
        </div>
        <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${meta.className}`}>{meta.label}</span>
      </div>

      <div className="space-y-3 px-4 py-3">
        <p className="text-sm text-text">{activity.summary}</p>
        <div className="grid gap-3 md:grid-cols-2">
          <div>
            <h4 className="mb-1 text-xs font-medium text-muted">执行步骤</h4>
            <ol className="space-y-1 text-xs text-text">
              {activity.steps.map((step) => (
                <li key={step} className="flex gap-2"><span className="text-muted">·</span><span>{step}</span></li>
              ))}
            </ol>
          </div>
          <div>
            <h4 className="mb-1 text-xs font-medium text-muted">工具调用</h4>
            {activity.toolCalls.length ? (
              <ul className="space-y-1 font-mono text-xs text-text">
                {activity.toolCalls.map((call) => <li key={call}>{call}</li>)}
              </ul>
            ) : (
              <p className="text-xs text-muted">暂无工具调用</p>
            )}
          </div>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2 border-t border-border-subtle px-4 py-2">
        <button type="button" onClick={() => openTask(activity.taskId)} className="rounded-md px-2 py-1 text-xs font-medium text-primary hover:bg-primary/10">
          详情
        </button>
        {(state === "running" || state === "waiting" || state === "queued") && (
          <button
            type="button"
            onClick={() => cancelAgentRun(activity.runId)}
            className="rounded-md px-2 py-1 text-xs text-muted hover:bg-bg hover:text-red-500"
          >
            停止
          </button>
        )}
      </div>
    </section>
  );
}

function ApprovalCardView({ approval }: { approval: ApprovalCard }) {
  const respondToApproval = useConversationStore((state) => state.respondToApproval);
  const messages = useConversationStore((state) => state.messages);
  const openTask = useWorkspaceStore((state) => state.openTask);
  const { triggerApprovalRequest } = usePanelTrigger();
  const automationRef = useRef<string | null>(null);
  const messageId = messages.find((message) =>
    message.parts.some((part) => part.type === "approval" && part.approval.approvalId === approval.approvalId),
  )?.id;

  useEffect(() => {
    if (approval.state !== "pending") return;
    if (automationRef.current === approval.approvalId) return;

    automationRef.current = approval.approvalId;
    triggerApprovalRequest(approval.approvalId, approval.filePath);
  }, [approval.approvalId, approval.filePath, approval.state, triggerApprovalRequest]);

  return (
    <section className="w-full max-w-[520px] rounded-xl border border-orange-500/30 bg-orange-500/5">
      <div className="flex items-center gap-2 px-4 py-3">
        <ShieldCheck className="h-4 w-4 text-orange-600" />
        <h3 className="text-sm font-medium text-text">审批请求</h3>
        <span className="rounded-full bg-orange-500/10 px-2 py-0.5 text-xs text-orange-600">
          {approval.state === "pending" ? "待处理" : approval.state === "approved" ? "已批准" : "已拒绝"}
        </span>
      </div>
      <div className="px-4 pb-3">
        <p className="text-sm font-medium text-text">{approval.title}</p>
        <p className="mt-1 text-xs text-muted">{approval.reason}</p>
      </div>
      <div className="flex gap-2 px-4 pb-3">
        <button type="button" onClick={() => openTask(approval.taskId)} className="rounded-md border border-border-subtle px-2.5 py-1 text-xs text-text hover:bg-bg">
          详情
        </button>
        {approval.state === "pending" && messageId && (
          <>
            <button
              type="button"
              onClick={() => respondToApproval(messageId, approval.approvalId, true)}
              className="rounded-md bg-primary px-2.5 py-1 text-xs font-medium text-white hover:bg-primary/90"
            >
              批准
            </button>
            <button
              type="button"
              onClick={() => respondToApproval(messageId, approval.approvalId, false)}
              className="rounded-md border border-red-500/30 px-2.5 py-1 text-xs text-red-500 hover:bg-red-500/10"
            >
              拒绝
            </button>
          </>
        )}
      </div>
    </section>
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
