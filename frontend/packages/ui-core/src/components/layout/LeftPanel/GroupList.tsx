import { useState } from "react";
import { Users, Check, Volume2, VolumeX, Copy, ChevronDown, ChevronRight } from "lucide-react";
import { useGroupStore } from "../../../core/workspace/groupStore";
import { useWorkspaceStore } from "../../../core/workspace/workspaceStore";
import { ContextMenu } from "../../ui/ContextMenu";
import { matchesSearch } from "./search";

export function GroupList() {
  const [collapsed, setCollapsed] = useState(false);
  const groups = useGroupStore((state) => state.groups);
  const setActiveGroup = useGroupStore((state) => state.setActiveGroup);
  const markAsRead = useGroupStore((state) => state.markAsRead);
  const updateGroup = useGroupStore((state) => state.updateGroup);
  const activeGroupId = useGroupStore((state) => state.activeGroupId);
  const openConversation = useWorkspaceStore((state) => state.openConversation);
  const searchQuery = useWorkspaceStore((state) => state.searchQuery);

  const filteredGroups = groups.filter((group) => matchesSearch(searchQuery, {
    type: "group",
    text: [group.name, group.preview, group.members.join(" ")].join(" "),
    agent: group.members.join(" "),
    unread: group.unread,
    hasMention: group.preview.includes("@"),
  }));

  const handleGroupClick = (groupId: string) => {
    setActiveGroup(groupId);
    markAsRead(groupId);
    openConversation("group", `group-${groupId}`);
  };

  const buildMenuItems = (groupId: string) => {
    const group = groups.find((item) => item.id === groupId);
    const isMuted = Boolean(group?.muted);

    return [
    { label: "标记已读", icon: <Check className="h-4 w-4" />, onClick: () => markAsRead(groupId) },
    {
      label: isMuted ? "取消静音" : "静音",
      icon: isMuted ? <Volume2 className="h-4 w-4" /> : <VolumeX className="h-4 w-4" />,
      onClick: () => updateGroup(groupId, { muted: !isMuted }),
    },
    { label: "复制群 ID", icon: <Copy className="h-4 w-4" />, onClick: () => { void navigator.clipboard?.writeText(groupId); } },
    { separator: true as const, label: "", onClick: () => {} },
    ];
  };

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
        <Users className="h-4 w-4 text-muted" />
        <span className="text-sm font-medium text-text">群聊列表</span>
        <span className="ml-auto text-xs text-muted">{filteredGroups.length}</span>
      </button>
      {!collapsed && (
        <div className="max-h-[300px] overflow-y-auto">
          {filteredGroups.length ? (
            filteredGroups.map((group) => (
              <ContextMenu key={group.id} items={buildMenuItems(group.id)}>
                <button
                  onClick={() => handleGroupClick(group.id)}
                  className={`flex w-full items-center gap-2 px-3 py-2 pl-7 text-left transition-colors hover:bg-bg ${
                    activeGroupId === group.id ? "bg-primary/10" : ""
                  }`}
                >
                  <div className="flex h-8 w-8 items-center justify-center rounded-full bg-primary/10 text-[10px] font-medium text-primary">
                    {group.members.slice(0, 2).map((member) => member.slice(0, 1)).join("") || <Users className="h-4 w-4" />}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="truncate text-sm text-text">{group.name}</div>
                    <div className="text-xs text-muted">
                      <span className="block truncate">{group.preview}</span>
                      <span>{group.memberCount} 成员 · {group.lastActive}</span>
                    </div>
                  </div>
                  {group.unread > 0 && (
                    <div className="flex h-5 min-w-[20px] items-center justify-center rounded-full bg-primary px-1.5 text-xs font-medium text-white">
                      {group.unread}
                    </div>
                  )}
                  {group.muted && <VolumeX className="h-3.5 w-3.5 text-muted" />}
                </button>
              </ContextMenu>
            ))
          ) : (
            <p className="px-7 py-3 text-xs text-muted">没有匹配的群聊</p>
          )}
        </div>
      )}
    </div>
  );
}
