import { ListChecks, Circle, Clock, CheckCircle, XCircle } from "lucide-react";
import { useTaskStore, type TaskStatus } from "../../../core/workspace/taskStore";

function StatusIcon({ status }: { status: TaskStatus }) {
  const icons = {
    pending: <Circle className="h-4 w-4 text-muted" />,
    running: <Circle className="h-4 w-4 animate-pulse text-blue-500" />,
    completed: <CheckCircle className="h-4 w-4 text-green-500" />,
    failed: <XCircle className="h-4 w-4 text-red-500" />,
  };
  return icons[status];
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
  const tasks = useTaskStore((state) => state.tasks);
  const updateTask = useTaskStore((state) => state.updateTask);

  const handleTaskClick = (taskId: string) => {
    // TODO: 切换到任务详情视图
    console.log("点击任务:", taskId);
  };

  return (
    <div className="border-b border-border-subtle">
      <div className="flex items-center gap-2 px-3 py-2">
        <ListChecks className="h-4 w-4 text-muted" />
        <span className="text-sm font-medium text-text">任务</span>
        <span className="ml-auto text-xs text-muted">{tasks.length}</span>
      </div>
      <div className="max-h-[200px] overflow-y-auto">
        {tasks.map((task) => (
          <button
            key={task.id}
            onClick={() => handleTaskClick(task.id)}
            className="flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-bg"
          >
            <StatusIcon status={task.status} />
            <div className="flex-1 min-w-0">
              <div className="truncate text-sm text-text">{task.title}</div>
              <div className="text-xs text-muted">{formatTime(task.updatedAt)}</div>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}
