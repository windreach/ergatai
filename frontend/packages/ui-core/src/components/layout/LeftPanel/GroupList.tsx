import { Users } from "lucide-react";
import { useGroupStore } from "../../../core/workspace/groupStore";

export function GroupList() {
  const groups = useGroupStore((state) => state.groups);
  const setActiveGroup = useGroupStore((state) => state.setActiveGroup);

  const handleGroupClick = (groupId: string) => {
    setActiveGroup(groupId);
    // TODO: 切换到群聊视图
    console.log("点击群聊:", groupId);
  };

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="flex items-center gap-2 px-3 py-2">
        <Users className="h-4 w-4 text-muted" />
        <span className="text-sm font-medium text-text">群聊列表</span>
      </div>
      <div>
        {groups.map((group) => (
          <button
            key={group.id}
            onClick={() => handleGroupClick(group.id)}
            className="flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-bg"
          >
            <div className="flex h-8 w-8 items-center justify-center rounded-full bg-primary/10">
              <Users className="h-4 w-4 text-primary" />
            </div>
            <div className="flex-1 min-w-0">
              <div className="truncate text-sm text-text">{group.name}</div>
              <div className="text-xs text-muted">
                {group.memberCount} 成员 · {group.lastActive}
              </div>
            </div>
            {group.unread > 0 && (
              <div className="flex h-5 min-w-[20px] items-center justify-center rounded-full bg-primary px-1.5 text-xs font-medium text-white">
                {group.unread}
              </div>
            )}
          </button>
        ))}
      </div>
    </div>
  );
}
