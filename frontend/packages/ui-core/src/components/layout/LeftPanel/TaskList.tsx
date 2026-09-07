import { useState } from "react";
import { Archive, ListChecks, Circle, Clock, CheckCircle, XCircle, Loader2, Timer, Ban, ChevronDown, ChevronRight, Eye, LayoutGrid, Network, Trash2 } from "lucide-react";
import { useTaskStore, type TaskStatus } from "../../../core/workspace/taskStore";
import { useWorkspaceStore } from "../../../core/workspace/workspaceStore";
import { ContextMenu } from "../../ui/ContextMenu";
import { matchesSearch } from "./search";

function StatusIcon({ status }: { status: TaskStatus }) {
  const icons: Record<TaskStatus, React.ReactElement> = {
    pending: <Circle className="h-4 w-4 text-muted" />,
    queued: <Clock className="h-4 w-4 text-yellow-500" />,
    running: <Loader2 className="h-4 w-4 animate-spin text-blue-500" />,
    waiting: <Timer className="h-4 w-4 text-yellow-500" />,
    completed: <CheckCircle className="h-4 w-4 text-green-500" />,
    failed: <XCircle className="h-4 w-4 text-red-500" />,
    cancelled: <Ban className="h-4 w-4 text-gray-400" />,
  };
  return icons[status] || icons.pending;
}

function formatTime(dateString: string): string {
  const date = new Date(dateString);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMins / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffMins < 1) return "刚刚";
  if (diffMins < 60) return `${diffMins} 分钟前`;
  if (diffHours < 24) return `${diffHours} 小时前`;
  if (diffDays < 7) return `${diffDays} 天前`;
  return date.toLocaleDateString("zh-CN");
}

export function TaskList() {
  const [collapsed, setCollapsed] = useState(false);
  const getSortedTasks = useTaskStore((state) => state.getSortedTasks);
  const removeTask = useTaskStore((state) => state.removeTask);
  const updateTask = useTaskStore((state) => state.updateTask);
  const openTask = useWorkspaceStore((state) => state.openTask);
  const searchQuery = useWorkspaceStore((state) => state.searchQuery);
  const tasks = getSortedTasks().filter((task) => matchesSearch(searchQuery, {
    type: "task",
    text: [task.title, task.description, task.statusSummary, task.assignee?.name]
      .filter(Boolean)
      .join(" "),
    agent: task.assignee?.name,
    status: task.status,
    hasMention: [task.title, task.description].some((value) => value?.includes("@")),
  }));

  const handleTaskClick = (taskId: string) => {
    openTask(taskId, "task-kanban");
  };

  const buildMenuItems = (taskId: string) => [
    { label: "查看详情", icon: <Eye className="h-4 w-4" />, onClick: () => openTask(taskId, "task-kanban") },
    { label: "查看看板", icon: <LayoutGrid className="h-4 w-4" />, onClick: () => openTask(taskId, "task-kanban") },
    { label: "查看 DAG", icon: <Network className="h-4 w-4" />, onClick: () => openTask(taskId, "dag") },
    { separator: true as const, label: "", onClick: () => {} },
    { label: "归档", icon: <Archive className="h-4 w-4" />, onClick: () => updateTask(taskId, { archived: true }) },
    { label: "删除", icon: <Trash2 className="h-4 w-4" />, onClick: () => removeTask(taskId) },
  ];

  return (
    <div className="border-b border-border-subtle">
      <button
        onClick={() => setCollapsed(!collapsed)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-bg"
      >
        {collapsed ? (
          <ChevronRight className="h-4 w-4 text-muted" />
        ) : (
          <ChevronDown className="h-4 w-4 text-muted" />
        )}
        <ListChecks className="h-4 w-4 text-muted" />
        <span className="text-sm font-medium text-text">任务</span>
        <span className="ml-auto text-xs text-muted">{tasks.length}</span>
      </button>
      {!collapsed && (
        <div className="max-h-[200px] overflow-y-auto">
          {tasks.length ? (
            tasks.map((task) => (
              <ContextMenu key={task.id} items={buildMenuItems(task.id)}>
                <button
                  onClick={() => handleTaskClick(task.id)}
                  className="flex w-full items-center gap-2 px-3 py-2 pl-7 text-left transition-colors hover:bg-bg"
                >
                  <StatusIcon status={task.status} />
                  <div className="flex-1 min-w-0">
                    <div className="truncate text-sm text-text">{task.title}</div>
                    <div className="text-xs text-muted">{formatTime(task.updatedAt)}</div>
                  </div>
                </button>
              </ContextMenu>
            ))
          ) : (
            <p className="px-7 py-3 text-xs text-muted">没有匹配的任务</p>
          )}
        </div>
      )}
    </div>
  );
}
