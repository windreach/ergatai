import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  ChevronDown,
  ChevronsLeft,
  ChevronsRight,
  MessageSquare,
  Plus,
  Sparkles,
} from "lucide-react";

import { useSessionStore } from "../../core/session/store";
import { useAgentTabStore } from "../../core/workspace/store";
import { cn } from "../../lib/utils";
import logoUrl from "../../assets/ergatai-logo.png";

interface AgentSidebarProps {
  collapsed: boolean;
  onToggle: () => void;
}

export function AgentSidebar({ collapsed, onToggle }: AgentSidebarProps) {
  const { t } = useTranslation();
  const sessions = useSessionStore((state) => state.sessions);
  const activeSessionId = useSessionStore((state) => state.activeSessionId);
  const createSession = useSessionStore((state) => state.createSession);
  const selectSession = useSessionStore((state) => state.selectSession);
  const agents = useAgentTabStore((state) => state.tabs);
  const activeAgentId = useAgentTabStore((state) => state.activeTabId);
  const createAgent = useAgentTabStore((state) => state.createTab);
  const ensureAgent = useAgentTabStore((state) => state.ensureActiveTab);
  const selectAgent = useAgentTabStore((state) => state.activateTab);
  const [chatsOpen, setChatsOpen] = useState(true);
  const [agentsOpen, setAgentsOpen] = useState(true);

  useEffect(() => {
    ensureAgent();
  }, [ensureAgent]);

  useEffect(() => {
    if (sessions.length > 0) return;
    createSession();
  }, [createSession, sessions.length]);

  if (collapsed) {
    return (
      <aside className="flex h-full w-12 shrink-0 flex-col items-center border-r border-border-subtle bg-surface py-2">
        <button
          type="button"
          onClick={onToggle}
          aria-label={t("sidebar.expand")}
          title={t("sidebar.expand")}
          className="grid h-8 w-8 place-items-center rounded-lg text-muted transition-colors hover:bg-hover hover:text-text"
        >
          <ChevronsRight className="h-4 w-4" />
        </button>
        <div className="mt-4 grid h-8 w-8 place-items-center rounded-lg bg-hover">
          <img src={logoUrl} alt={t("sidebar.brand")} className="h-5 w-5 object-contain" />
        </div>
      </aside>
    );
  }

  return (
    <aside className="flex h-full w-60 shrink-0 flex-col border-r border-border-subtle bg-surface">
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border-subtle px-3">
        <img src={logoUrl} alt={t("sidebar.brand")} className="h-6 w-6 object-contain" />
        <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-text">
          {t("sidebar.brand")}
        </span>
        <button
          type="button"
          onClick={onToggle}
          aria-label={t("sidebar.collapse")}
          title={t("sidebar.collapse")}
          className="grid h-6 w-6 place-items-center rounded-md text-muted transition-colors hover:bg-hover hover:text-text"
        >
          <ChevronsLeft className="h-4 w-4" />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-3">
        <button
          type="button"
          onClick={() => createAgent()}
          className="flex h-10 w-full items-center justify-center gap-2 rounded-xl border border-border bg-bg text-[13px] text-text transition-colors hover:bg-hover"
        >
          <Plus className="h-4 w-4" />
          {t("shell.addAgent")}
        </button>

        <SectionHeader
          label={t("shell.groupDropdown")}
          open={chatsOpen}
          onClick={() => setChatsOpen((open) => !open)}
        />
        {chatsOpen && (
          <div className="space-y-1 pb-2">
            {sessions.map((session, index) => {
              const active = session.id === activeSessionId;

              return (
                <button
                  key={session.id}
                  type="button"
                  onClick={() => selectSession(session.id)}
                  className={cn(
                    "flex h-10 w-full items-center gap-2 rounded-xl border border-border-subtle bg-bg px-3 text-left text-[12px] transition-colors",
                    active ? "border-accent/40 bg-hover text-text" : "text-muted hover:bg-hover hover:text-text",
                  )}
                >
                  <MessageSquare className="h-3.5 w-3.5 shrink-0" />
                  <span className="min-w-0 flex-1 truncate">
                    {session.title || t("shell.chatRecord", { index: index + 1 })}
                  </span>
                </button>
              );
            })}
          </div>
        )}

        <SectionHeader
          label={t("shell.agentDropdown")}
          open={agentsOpen}
          onClick={() => setAgentsOpen((open) => !open)}
        />
        {agentsOpen && (
          <div className="space-y-1">
            {agents.map((agent, index) => {
              const active = agent.id === activeAgentId;

              return (
                <button
                  key={agent.id}
                  type="button"
                  onClick={() => selectAgent(agent.id)}
                  className={cn(
                    "flex h-10 w-full items-center gap-2 rounded-xl border border-border-subtle bg-bg px-3 text-left text-[12px] transition-colors",
                    active ? "border-accent/40 bg-hover text-text" : "text-muted hover:bg-hover hover:text-text",
                  )}
                >
                  <Sparkles className="h-3.5 w-3.5 shrink-0" />
                  <span className="min-w-0 flex-1 truncate">
                    {agent.name || t("shell.agent", { index: index + 1 })}
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </aside>
  );
}

function SectionHeader({
  label,
  open,
  onClick,
}: {
  label: string;
  open: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-expanded={open}
      className="mt-3 flex h-8 w-full items-center gap-1 rounded-lg px-1 text-left text-[12px] text-muted transition-colors hover:bg-hover hover:text-text"
    >
      <ChevronDown
        className={cn("h-3.5 w-3.5 shrink-0 transition-transform", !open && "-rotate-90")}
      />
      <span className="min-w-0 truncate">{label}</span>
    </button>
  );
}
