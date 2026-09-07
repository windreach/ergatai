import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  FolderOpen,
  Globe,
  ShieldCheck,
  Terminal as TerminalIcon,
  type LucideIcon,
} from "lucide-react";

import { AgentSidebar } from "./AgentSidebar";
import { ChatPanel } from "../tabs/ChatPanel";
import { ToolWorkspace } from "./ToolWorkspace";
import { useToolPanelStore, type ToolPanelType } from "../../core/browser/store";
import { useAgentTabStore } from "../../core/workspace/store";
import { useSessionStore } from "../../core/session/store";
import { cn } from "../../lib/utils";

type ToolRailType = Extract<ToolPanelType, "terminal" | "browser" | "files" | "review">;

const toolRailIcons: Record<ToolRailType, LucideIcon> = {
  terminal: TerminalIcon,
  browser: Globe,
  files: FolderOpen,
  review: ShieldCheck,
};

const toolRailTypes = [
  "terminal",
  "browser",
  "files",
  "review",
] as const satisfies ReadonlyArray<ToolRailType>;

export function WorkspaceShell() {
  const { t } = useTranslation();
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const activeAgent = useAgentTabStore((state) => state.tabs.find(
    (agent) => agent.id === state.activeTabId,
  ));
  const activeSession = useSessionStore((state) => state.sessions.find(
    (session) => session.id === state.activeSessionId,
  ));
  const tabs = useToolPanelStore((state) => state.tabs);
  const activeTabId = useToolPanelStore((state) => state.activeTabId);
  const createPanel = useToolPanelStore((state) => state.createPanel);
  const activatePanel = useToolPanelStore((state) => state.activatePanel);
  const activeTab = tabs.find((tab) => tab.id === activeTabId);
  const conversationId = activeAgent?.conversationId ?? activeSession?.id;

  function openToolPanel(type: ToolRailType) {
    const existingPanel = tabs.find((tab) => tab.type === type);

    if (existingPanel) {
      activatePanel(existingPanel.id);
      return;
    }

    createPanel(type);
  }

  return (
    <div className="flex h-full min-h-0 w-full overflow-hidden bg-bg text-text">
      <AgentSidebar
        collapsed={sidebarCollapsed}
        onToggle={() => setSidebarCollapsed((collapsed) => !collapsed)}
      />

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-11 shrink-0 border-b border-border-subtle bg-surface">
          <div className="flex w-60 shrink-0 items-center justify-center border-r border-border-subtle px-3">
            <span className="min-w-0 truncate text-[13px] font-medium text-text">
              {t("shell.chatGroup")}
            </span>
          </div>
          <div className="flex min-w-0 flex-1 items-center px-4">
            <span className="min-w-0 truncate text-[13px] text-muted">
              {t("shell.breadcrumb")}
            </span>
          </div>
        </header>

        <main className="min-h-0 flex-1 overflow-hidden">
          <ChatPanel
            key={conversationId}
            agentName={activeAgent?.name}
            conversationId={conversationId}
          />
        </main>
      </div>

      <div className="flex min-w-0 flex-1 border-l border-border-subtle">
        <nav
          aria-label={t("rightPanel.panel")}
          className="flex w-12 shrink-0 flex-col items-center gap-1 border-r border-border-subtle bg-surface py-3"
        >
          {toolRailTypes.map((type) => {
            const Icon = toolRailIcons[type];
            const active = activeTab?.type === type;

            return (
              <button
                key={type}
                type="button"
                onClick={() => openToolPanel(type)}
                aria-label={t(`rightPanel.${type}`)}
                aria-pressed={active}
                title={t(`rightPanel.${type}`)}
                className={cn(
                  "grid h-9 w-9 place-items-center rounded-lg transition-colors",
                  active ? "bg-accent-muted text-accent" : "text-muted hover:bg-hover hover:text-text",
                )}
              >
                <Icon className="h-4 w-4" />
              </button>
            );
          })}
        </nav>

        <section className="relative min-h-0 min-w-0 flex-1 overflow-hidden">
          <ToolWorkspace showTabBar={false} />
        </section>
      </div>
    </div>
  );
}
