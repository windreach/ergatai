import { MessageCircle } from "lucide-react";
import { useSessionStore } from "../../../core/workspace/sessionStore";

export function SessionList() {
  const sessions = useSessionStore((state) => state.sessions);
  const setActiveSession = useSessionStore((state) => state.setActiveSession);

  const handleSessionClick = (sessionId: string) => {
    setActiveSession(sessionId);
    // TODO: 切换到会话视图
    console.log("点击会话:", sessionId);
  };

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="flex items-center gap-2 px-3 py-2">
        <MessageCircle className="h-4 w-4 text-muted" />
        <span className="text-sm font-medium text-text">会话列表</span>
      </div>
      <div>
        {sessions.map((session) => (
          <button
            key={session.id}
            onClick={() => handleSessionClick(session.id)}
            className="flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-bg"
          >
            <div className="flex h-8 w-8 items-center justify-center rounded-full bg-primary/10">
              <MessageCircle className="h-4 w-4 text-primary" />
            </div>
            <div className="flex-1 min-w-0">
              <div className="truncate text-sm text-text">{session.agentName}</div>
              <div className="text-xs text-muted">
                {session.agentType} · {session.lastActive}
              </div>
            </div>
            {session.unread > 0 && (
              <div className="flex h-5 min-w-[20px] items-center justify-center rounded-full bg-primary px-1.5 text-xs font-medium text-white">
                {session.unread}
              </div>
            )}
          </button>
        ))}
      </div>
    </div>
  );
}
