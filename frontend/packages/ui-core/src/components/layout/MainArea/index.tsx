import { useState } from "react";
import { LayoutGrid, List, Network, MessageCircle } from "lucide-react";
import { useTaskStore, type TaskStatus } from "../../../core/workspace/taskStore";
import { DAGView } from "./DAGView";
import { usePanelTrigger } from "../../../core/workspace/panelAutomation";

type ViewType = "conversation" | "task-kanban" | "dag" | "empty";

interface MainAreaProps {
  currentView?: ViewType;
  onViewChange?: (view: ViewType) => void;
}

export function MainArea({ currentView = "empty", onViewChange }: MainAreaProps) {
  const [activeView, setActiveView] = useState<ViewType>(currentView);

  const handleViewChange = (view: ViewType) => {
    setActiveView(view);
    onViewChange?.(view);
  };

  return (
    <div className="flex flex-1 flex-col overflow-hidden bg-bg">
      {/* View Switcher */}
      <div className="flex items-center gap-1 border-b border-border-subtle bg-surface px-3 py-2">
        <ViewButton
          icon={MessageCircle}
          label="对话"
          isActive={activeView === "conversation"}
          onClick={() => handleViewChange("conversation")}
        />
        <ViewButton
          icon={LayoutGrid}
          label="任务"
          isActive={activeView === "task-kanban"}
          onClick={() => handleViewChange("task-kanban")}
        />
        <ViewButton
          icon={Network}
          label="DAG"
          isActive={activeView === "dag"}
          onClick={() => handleViewChange("dag")}
        />
      </div>

      {/* Content Area */}
      <div className="flex-1 overflow-auto">
        {activeView === "conversation" && <ConversationView />}
        {activeView === "task-kanban" && <TaskKanbanView />}
        {activeView === "dag" && <DAGView />}
        {activeView === "empty" && <EmptyView />}
      </div>
    </div>
  );
}

function ViewButton({
  icon: Icon,
  label,
  isActive,
  onClick,
}: {
  icon: typeof MessageCircle;
  label: string;
  isActive: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
        isActive
          ? "bg-primary/10 text-primary"
          : "text-muted hover:bg-bg hover:text-text"
      }`}
    >
      <Icon className="h-4 w-4" />
      <span>{label}</span>
    </button>
  );
}

function ConversationView() {
  return (
    <div className="flex h-full flex-col p-6">
      <h2 className="mb-4 text-lg font-medium text-text">对话视图</h2>
      <div className="flex-1 rounded-lg border border-border-subtle bg-surface p-4">
        <p className="text-sm text-muted">对话内容区域 - TODO</p>
        {/* TODO: 实现对话消息列表 */}
      </div>
    </div>
  );
}

function TaskKanbanView() {
  const tasks = useTaskStore((state) => state.tasks);
  const updateTask = useTaskStore((state) => state.updateTask);
  const { triggerTaskSelected } = usePanelTrigger();

  const columns = [
    { id: "pending" as const, title: "尚未开始", color: "text-muted" },
    { id: "running" as const, title: "进行中", color: "text-blue-500" },
    { id: "completed" as const, title: "成功", color: "text-green-500" },
    { id: "failed" as const, title: "失败", color: "text-red-500" },
  ];

  const getTasksByStatus = (status: TaskStatus) =>
    tasks.filter((task) => task.status === status);

  return (
    <div className="flex h-full gap-4 overflow-x-auto p-6">
      {columns.map((column) => (
        <div
          key={column.id}
          className="flex min-w-[280px] flex-col rounded-lg border border-border-subtle bg-surface"
        >
          <div className="flex items-center gap-2 border-b border-border-subtle px-4 py-3">
            <span className={`text-sm font-medium ${column.color}`}>
              {column.title}
            </span>
            <span className="text-xs text-muted">
              {getTasksByStatus(column.id).length}
            </span>
          </div>
          <div className="flex-1 overflow-y-auto p-2">
            {getTasksByStatus(column.id).map((task) => (
              <div
                key={task.id}
                className="mb-2 cursor-pointer rounded-md border border-border-subtle bg-bg p-3 transition-colors hover:border-primary/50"
                onClick={() => {
                  // 点击任务卡片时，自动触发打开文件面板
                  triggerTaskSelected(task.id);
                  console.log("点击任务卡片:", task.id);
                }}
              >
                <div className="text-sm text-text">{task.title}</div>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function EmptyView() {
  return (
    <div className="flex h-full items-center justify-center">
      <div className="text-center">
        <List className="mx-auto mb-4 h-16 w-16 text-muted" />
        <h3 className="mb-2 text-lg font-medium text-text">开始协作</h3>
        <p className="text-sm text-muted">
          选择一个群聊或会话，或创建新的任务
        </p>
      </div>
    </div>
  );
}
