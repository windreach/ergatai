import { useState } from "react";
import { Check, MessageCircle, Trash2, Copy, ChevronDown, ChevronRight } from "lucide-react";
import { useAgentSessionStore } from "../../../core/workspace/sessionStore";
import { useWorkspaceStore } from "../../../core/workspace/workspaceStore";
import { ContextMenu } from "../../ui/ContextMenu";
import { matchesSearch } from "./search";

export function SessionList() {
  const [collapsed, setCollapsed] = useState(false);
  const sessions = useAgentSessionStore((state) => state.sessions);
  const setActiveSession = useAgentSessionStore((state) => state.setActiveSession);
  const markAsRead = useAgentSessionStore((state) => state.markAsRead);
  const activeSessionId = useAgentSessionStore((state) => state.activeSessionId);
  const removeSession = useAgentSessionStore((state) => state.removeSession);
  const openConversation = useWorkspaceStore((state) => state.openConversation);
  const searchQuery = useWorkspaceStore((state) => state.searchQuery);

  const filteredSessions = sessions.filter((session) => matchesSearch(searchQuery, {
    type: "session",
    text: [session.agentName, session.agentType, session.preview].join(" "),
    agent: `${session.agentName} ${session.agentType}`,
    unread: session.unread,
    hasMention: session.preview.includes("@"),
  }));

  const handleSessionClick = (sessionId: string) => {
    setActiveSession(sessionId);
    markAsRead(sessionId);
    openConversation("agent", `direct-${sessionId}`);
  };

  const buildMenuItems = (sessionId: string) => [
    { label: "标记已读", icon: <Check className="h-4 w-4" />, onClick: () => markAsRead(sessionId) },
    { label: "复制会话 ID", icon: <Copy className="h-4 w-4" />, onClick: () => { void navigator.clipboard?.writeText(sessionId); } },
    { separator: true as const, label: "", onClick: () => {} },
    { label: "删除会话", icon: <Trash2 className="h-4 w-4" />, danger: true, onClick: () => removeSession(sessionId) },
  ];

  return (
    <div className="flex-1 overflow-y-auto">
      <button
        onClick={() => setCollapsed(!collapsed)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-bg"
      >
        {collapsed ? (
          <ChevronRight className="h-4 w-4 text-muted" />
        ) : (
          <ChevronDown className="h-4 w-4 text-muted" />
        )}
        <MessageCircle className="h-4 w-4 text-muted" />
        <span className="text-sm font-medium text-text">会话列表</span>
        <span className="ml-auto text-xs text-muted">{filteredSessions.length}</span>
      </button>
      {!collapsed && (
        <div className="max-h-[300px] overflow-y-auto">
          {filteredSessions.length ? (
            filteredSessions.map((session) => (
              <ContextMenu key={session.id} items={buildMenuItems(session.id)}>
                <button
                  onClick={() => handleSessionClick(session.id)}
                  className={`flex w-full items-center gap-2 px-3 py-2 pl-7 text-left transition-colors hover:bg-bg ${
                    activeSessionId === session.id ? "bg-primary/10" : ""
                  }`}
                >
                  <div className="flex h-8 w-8 items-center justify-center rounded-full bg-primary/10">
                    <MessageCircle className="h-4 w-4 text-primary" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="truncate text-sm text-text">{session.agentName}</div>
                    <div className="text-xs text-muted">
                      <span className="block truncate">{session.preview}</span>
                      <span>{session.agentType} · {session.lastActive}</span>
                    </div>
                  </div>
                  {session.unread > 0 && (
                    <div className="flex h-5 min-w-[20px] items-center justify-center rounded-full bg-primary px-1.5 text-xs font-medium text-white">
                      {session.unread}
                    </div>
                  )}
                </button>
              </ContextMenu>
            ))
          ) : (
            <p className="px-7 py-3 text-xs text-muted">没有匹配的会话</p>
          )}
        </div>
      )}
    </div>
  );
}
