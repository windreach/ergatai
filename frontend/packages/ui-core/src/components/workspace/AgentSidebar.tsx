import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Plus } from "lucide-react";

import { useSessionStore } from "../../core/session/store";
import { cn } from "../../lib/utils";

export function AgentSidebar() {
  const { t } = useTranslation();
  const sessions = useSessionStore((state) => state.sessions);
  const activeSessionId = useSessionStore((state) => state.activeSessionId);
  const createSession = useSessionStore((state) => state.createSession);
  const selectSession = useSessionStore((state) => state.selectSession);

  useEffect(() => {
    if (sessions.length > 0) return;
    createSession();
  }, [createSession, sessions.length]);

  return (
    <aside className="flex h-full min-h-0 flex-col border-r border-border-subtle bg-surface">
      <div className="flex h-11 shrink-0 items-center justify-between border-b border-border-subtle px-3">
        <span className="text-[13px] font-semibold text-text">{t("session.title")}</span>
        <button
          type="button"
          onClick={() => createSession()}
          aria-label={t("session.new")}
          title={t("session.new")}
          className="flex h-6 w-6 items-center justify-center rounded-md text-muted transition-colors hover:bg-hover hover:text-text"
        >
          <Plus className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {sessions.map((session, index) => {
          const active = session.id === activeSessionId;

          return (
            <button
              key={session.id}
              type="button"
              onClick={() => selectSession(session.id)}
              className={cn(
                "flex h-9 w-full items-center gap-2 rounded-lg px-2 text-left text-[12px] transition-colors",
                active ? "bg-hover text-text" : "text-muted hover:bg-hover hover:text-text",
              )}
            >
              <span className="min-w-0 flex-1 truncate">
                {session.title || t("session.defaultTitle", { index: index + 1 })}
              </span>
            </button>
          );
        })}
      </div>
    </aside>
  );
}
