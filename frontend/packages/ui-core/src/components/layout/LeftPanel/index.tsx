import { Boxes, LayoutGrid, MessageCircle, Network, PanelLeftClose, Plus, Settings, User, Users } from "lucide-react";
import { usePanelAutomation } from "../../../core/workspace/panelAutomation";
import { useWorkspaceStore } from "../../../core/workspace/workspaceStore";
import { SearchBox } from "./SearchBox";
import { ModeTabs } from "./ModeTabs";
import { NewButton, createNewConversation } from "./NewButton";
import { TaskList } from "./TaskList";
import { GroupList } from "./GroupList";
import { SessionList } from "./SessionList";
import { SettingsButton } from "./SettingsButton";

interface LeftPanelProps {
  isOpen?: boolean;
  onToggle?: () => void;
}

export function LeftPanel({ isOpen = true, onToggle }: LeftPanelProps) {
  const mode = useWorkspaceStore((state) => state.mode);
  const setMode = useWorkspaceStore((state) => state.setMode);
  const activeView = useWorkspaceStore((state) => state.activeView);
  const setView = useWorkspaceStore((state) => state.setView);

  if (!isOpen) {
    return (
      <aside className="flex h-full w-14 flex-col items-center border-r border-border-subtle bg-surface">
        <div className="flex h-14 w-full flex-shrink-0 items-center justify-end border-b border-border-subtle pr-3">
          <button
            type="button"
            onClick={onToggle}
            aria-label="切换侧边栏"
            title="切换侧边栏"
            className="flex h-8 w-8 items-center justify-center rounded-lg text-muted transition-colors hover:bg-bg hover:text-text"
          >
            <PanelLeftClose className="h-4 w-4" />
          </button>
        </div>

        <div className="flex w-full flex-col items-center gap-2 pt-3">
          <RailButton
            icon={mode === "group" ? Users : User}
            label={mode === "group" ? "切换到 Agent 模式" : "切换到群聊模式"}
            isActive
            onClick={() => setMode(mode === "group" ? "agent" : "group")}
          />

          <div className="my-1 h-px w-6 bg-border-subtle" />

          <RailButton icon={MessageCircle} label="切换到对话视图" isActive={activeView === "conversation"} onClick={() => setView("conversation")} />
          <RailButton icon={LayoutGrid} label="切换到任务视图" isActive={activeView === "task-kanban"} onClick={() => setView("task-kanban")} />
          <RailButton icon={Network} label="切换到 DAG 视图" isActive={activeView === "dag"} onClick={() => setView("dag")} />

          <RailButton icon={Plus} label={mode === "group" ? "新建群聊" : "新建会话"} onClick={() => createNewConversation(mode)} />
        </div>

        <div className="mt-auto pb-3">
          <RailButton icon={Settings} label="打开设置" onClick={() => usePanelAutomation.getState().openPanel("settings", true)} />
        </div>
      </aside>
    );
  }

  return (
    <div className="flex h-full w-full flex-col border-r border-border-subtle bg-surface">
      <header className="flex h-14 flex-shrink-0 items-center justify-between gap-2 border-b border-border-subtle px-3">
        <div className="flex min-w-0 items-center gap-2">
          <span aria-label="Ergatai" className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <Boxes className="h-4 w-4" />
          </span>
          <span className="truncate text-sm font-semibold text-text">Ergatai</span>
        </div>
        <button
          type="button"
          onClick={onToggle}
          aria-label="切换侧边栏"
          title="切换侧边栏"
          className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg text-muted transition-colors hover:bg-bg hover:text-text"
        >
          <PanelLeftClose className="h-4 w-4" />
        </button>
      </header>

      <SearchBox />

      <ModeTabs mode={mode} onChange={setMode} />

      {/* 视图切换 */}
      <nav aria-label="主区视图切换" className="space-y-1 border-b border-border-subtle p-3 pt-2">
        <ViewShortcut
          icon={MessageCircle}
          label="对话"
          isActive={activeView === "conversation"}
          onClick={() => setView("conversation")}
        />
        <ViewShortcut
          icon={LayoutGrid}
          label="任务"
          isActive={activeView === "task-kanban"}
          onClick={() => setView("task-kanban")}
        />
        <ViewShortcut
          icon={Network}
          label="DAG"
          isActive={activeView === "dag"}
          onClick={() => setView("dag")}
        />
      </nav>

      {/* 新建按钮 */}
      <NewButton mode={mode} />

      {/* 任务列表 */}
      <TaskList />

      {/* 根据模式显示不同列表 */}
      {mode === "group" ? <GroupList /> : <SessionList />}

      {/* 底部设置 */}
      <div className="mt-auto border-t border-border-subtle">
        <SettingsButton />
      </div>
    </div>
  );
}

function ViewShortcut({
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
      type="button"
      onClick={onClick}
      aria-label={`切换到${label}视图`}
      className={`flex h-9 w-full items-center gap-2 rounded-lg px-3 text-sm font-medium transition-colors ${
        isActive
          ? "bg-primary/10 text-primary"
          : "border-transparent text-muted hover:bg-bg hover:text-text"
      }`}
    >
      <Icon className="h-4 w-4" />
      <span>{label}</span>
    </button>
  );
}

function RailButton({
  icon: Icon,
  label,
  isActive = false,
  onClick,
}: {
  icon: typeof MessageCircle;
  label: string;
  isActive?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className={`flex h-9 w-9 items-center justify-center rounded-lg transition-colors ${
        isActive
          ? "bg-primary/10 text-primary"
          : "text-muted hover:bg-bg hover:text-text"
      }`}
    >
      <Icon className="h-4 w-4" />
    </button>
  );
}
