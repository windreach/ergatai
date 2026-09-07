import { useState } from "react";
import { SearchBox } from "./SearchBox";
import { ModeTabs } from "./ModeTabs";
import { NewButton } from "./NewButton";
import { TaskList } from "./TaskList";
import { GroupList } from "./GroupList";
import { SessionList } from "./SessionList";
import { SettingsButton } from "./SettingsButton";

export function LeftPanel() {
  const [mode, setMode] = useState<"group" | "agent">("group");

  return (
    <div className="flex h-full w-[280px] flex-col border-r border-border-subtle bg-surface">
      {/* 搜索框 */}
      <SearchBox />

      {/* 模式切换 */}
      <ModeTabs mode={mode} onChange={setMode} />

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
