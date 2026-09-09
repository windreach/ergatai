import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { I18nextProvider } from "react-i18next";
import { useTranslation } from "react-i18next";
import { ChevronLeft, Plus, Search, X } from "lucide-react";
import { DockviewReact, type DockviewApi, type DockviewReadyEvent, type IDockviewHeaderActionsProps, type IDockviewPanelHeaderProps, type IDockviewPanelProps } from "dockview-react";
import "dockview-react/dist/styles/dockview.css";
import "./dockview-overrides.css";

import { ChatPanel } from "../components/chat/ChatPanel";
import i18n from "../i18n";
import type { ChatConversationSummary } from "@ergatai/platform-core";
import { fetchAgents, listChatConversations, seedMockConversations, type AgentSummary } from "@ergatai/platform-core";
import "../styles.css";

export interface ChatPanelParams {
  conversationId: string;
  agentName?: string;
  onConversationSaved: () => void;
}

function ChatDockPanel({ params, api }: IDockviewPanelProps) {
  const panelParams = params as ChatPanelParams;
  const { t } = useTranslation();
  const onToggle = useCallback(() => {
    api.group.api.setActive();
    document.dispatchEvent(new CustomEvent("ergatai:toggle-sidebar"));
  }, [api]);

  return (
    <ChatPanel
      conversationId={panelParams.conversationId}
      agentName={panelParams.agentName}
      headerLeading={(
        <button
          type="button"
          onClick={onToggle}
          aria-label={t("workspace.collapseHistory")}
          title={t("workspace.collapseHistory")}
          className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-md text-muted transition-colors hover:bg-hover hover:text-text"
        >
          <ChevronLeft className="h-4 w-4 transition-transform duration-200 ease-in-out" />
        </button>
      )}
      onConversationSaved={panelParams.onConversationSaved}
      className="h-full"
    />
  );
}

function generateId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function CustomTab({ api }: IDockviewPanelHeaderProps) {
  return (
    <div
      className={`
        group relative flex items-center h-[34px] px-3 min-w-[130px] max-w-[180px]
        rounded-lg cursor-pointer transition-all duration-150 select-none text-xs font-sans
        ${api.isActive
          ? 'bg-white text-gray-900 shadow-sm border border-gray-200/80 font-semibold'
          : 'bg-transparent text-gray-600 hover:bg-gray-200/50 hover:text-gray-900'
        }
      `}
    >
      <span className="truncate flex-1 font-medium tracking-tight">{api.title}</span>
      <button
        onClick={(e) => { e.stopPropagation(); api.close(); }}
        className="ml-2 p-0.5 rounded text-gray-400 hover:text-gray-700 hover:bg-gray-100 opacity-80 group-hover:opacity-100 transition-all"
        aria-label={`关闭 ${api.title}`}
      >
        <X className="w-3.5 h-3.5" />
      </button>
    </div>
  );
}

function TabBarActions({ containerApi }: IDockviewHeaderActionsProps) {
  const handleClick = () => {
    const count = containerApi.panels.length + 1;
    const id = generateId();
    const convId = generateId();
    const title = `Agent ${count}`;
    containerApi.addPanel({
      id,
      component: "chat",
      title,
      params: {
        conversationId: convId,
        agentName: title,
        onConversationSaved: () => {},
      },
    });
  };

  return (
    <button
      type="button"
      onClick={handleClick}
      aria-label="新建 Agent"
      className="flex h-6 w-6 items-center justify-center rounded text-muted transition-colors hover:bg-hover hover:text-text"
    >
      <Plus className="h-3.5 w-3.5" />
    </button>
  );
}

export function InitPage({ onSelect }: { onSelect: (agent: AgentSummary | null) => void }) {
  const { t } = useTranslation();
  const [agents, setAgents] = useState<AgentSummary[]>([]);

  useEffect(() => {
    void fetchAgents().then(setAgents).catch(() => setAgents([]));
  }, []);

  return (
    <I18nextProvider i18n={i18n}>
      <div className="flex min-h-full flex-col items-center justify-center bg-bg px-6 text-text">
        <h1 className="mb-2 text-3xl font-bold tracking-tight">Ergatai</h1>
        <p className="mb-10 text-sm text-muted">{t("init.subtitle")}</p>
        <div className="grid w-full max-w-2xl grid-cols-1 gap-3 sm:grid-cols-2 md:grid-cols-3">
          {agents.map((agent) => (
            <button
              key={agent.id}
              type="button"
              onClick={() => onSelect(agent)}
              className="group flex flex-col items-start gap-1.5 rounded-xl border border-border bg-surface p-4 text-left shadow-sm transition-all hover:border-accent hover:shadow-md"
            >
              <span className="flex items-center gap-2 text-[14px] font-medium text-text">
                <span className={`h-2 w-2 rounded-full ${agent.state === "running" ? "bg-success" : "bg-faint"}`} />
                {agent.name}
              </span>
              <span className="truncate text-[12px] text-faint">{agent.workDir}</span>
            </button>
          ))}
          <button
            type="button"
            onClick={() => onSelect(null)}
            className="flex flex-col items-center justify-center gap-1.5 rounded-xl border border-dashed border-border bg-transparent p-4 text-muted transition-colors hover:border-accent hover:text-accent"
          >
            <Plus className="h-5 w-5" />
            <span className="text-[13px]">{t("init.customAgent")}</span>
          </button>
        </div>
      </div>
    </I18nextProvider>
  );
}

export function App() {
  const [agent, setAgent] = useState<AgentSummary | null | undefined>(undefined);

  if (agent === undefined) {
    return <InitPage onSelect={setAgent} />;
  }

  return <AgentWorkspace initialAgent={agent} onExit={() => setAgent(undefined)} />;
}

export function AgentWorkspace({ initialAgent, onExit }: { initialAgent?: AgentSummary | null; onExit?: () => void }) {
  const { t } = useTranslation();
  const dockApiRef = useRef<DockviewApi | null>(null);
  const [history, setHistory] = useState<ChatConversationSummary[]>([]);
  const [historyOpen, setHistoryOpen] = useState(true);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);

  const refreshHistory = useCallback(() => {
    void seedMockConversations()
      .then(() => listChatConversations())
      .then(setHistory)
      .catch(() => setHistory([]));
  }, []);

  useEffect(() => {
    refreshHistory();
  }, [refreshHistory]);

  useEffect(() => {
    function onToggleSidebar() {
      setHistoryOpen((prev) => !prev);
    }
    document.addEventListener("ergatai:toggle-sidebar", onToggleSidebar);
    return () => document.removeEventListener("ergatai:toggle-sidebar", onToggleSidebar);
  }, []);

  const addChatPanel = useCallback((api: DockviewApi, title: string, conversationId?: string) => {
    const convId = conversationId ?? generateId();
    api.addPanel({
      id: `agent-${generateId()}`,
      component: "chat",
      title,
      params: {
        conversationId: convId,
        agentName: title,
        onConversationSaved: refreshHistory,
      } satisfies ChatPanelParams,
    });
  }, [refreshHistory]);

  const onReady = useCallback((event: DockviewReadyEvent) => {
    dockApiRef.current = event.api;
    event.api.onDidRemovePanel(() => {
      if (event.api.panels.length === 0) {
        onExit?.();
      }
    });
    const title = initialAgent?.name ?? "Agent 1";
    addChatPanel(event.api, title, generateId());
  }, [initialAgent, addChatPanel, onExit]);

  const startNewConversation = useCallback(() => {
    const api = dockApiRef.current;
    const active = api?.activePanel;
    if (!active) return;
    const params = active.params as ChatPanelParams;
    active.api.updateParameters({ ...params, conversationId: generateId() });
  }, []);

  const openHistoryConversation = useCallback((conversation: ChatConversationSummary) => {
    const api = dockApiRef.current;
    const active = api?.activePanel;
    if (!active) return;
    const params = active.params as ChatPanelParams;
    active.api.updateParameters({ ...params, conversationId: conversation.id });
  }, []);

  const filteredHistory = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    if (!query) return history;
    return history.filter((conversation) =>
      conversation.title.toLowerCase().includes(query)
    );
  }, [history, searchQuery]);

  const components = useMemo(() => ({
    chat: ChatDockPanel,
  }), []);

  return (
    <I18nextProvider i18n={i18n}>
      <div className="flex h-full w-full overflow-hidden bg-bg text-text">
        <aside
          aria-label={t("workspace.history")}
          className={`hidden flex-shrink-0 flex-col overflow-hidden border-r border-border-subtle bg-surface transition-[width] duration-200 ease-in-out md:flex ${
            historyOpen ? "w-60" : "w-0"
          }`}
        >
          <div className={`flex h-10 flex-shrink-0 items-center gap-1.5 border-b border-border-subtle px-3 text-[14px] font-semibold text-text transition-opacity duration-150 ${
            historyOpen ? "opacity-100" : "pointer-events-none opacity-0"
          }`}>
            <div className="flex h-5 w-5 items-center justify-center rounded bg-text text-[10px] font-bold text-bg">E</div>
            <span className="flex-1 truncate">Ergatai</span>
            <button type="button" onClick={() => setSearchOpen((prev) => !prev)} aria-label="搜索历史会话">
              <Search className="h-3.5 w-3.5 text-muted transition-colors hover:text-text" />
            </button>
          </div>
          <div className={historyOpen ? "p-2" : "hidden"}>
            <button
              type="button"
              onClick={startNewConversation}
              aria-label={t("workspace.newConversation")}
              title={t("workspace.newConversation")}
              className="flex w-full items-center gap-2 rounded-md border border-border px-2 py-2 text-[13px] text-muted transition-colors hover:bg-hover hover:text-text"
            >
              <Plus className="h-4 w-4" />
              <span className="truncate">{t("workspace.newConversation")}</span>
            </button>
          </div>
          <div className={`min-h-0 flex-1 overflow-y-auto p-2 transition-opacity duration-150 ${historyOpen ? "" : "hidden"} ${
            historyOpen ? "opacity-100" : "pointer-events-none opacity-0"
          }`}>
                {filteredHistory.length === 0 ? (
              <p className="px-2 py-3 text-[12px] text-muted">{t("workspace.noHistory")}</p>
            ) : (
              <>
                <p className="mb-1 px-2 pt-1 text-[11px] font-medium uppercase tracking-wide text-faint">{t("workspace.today")}</p>
                {filteredHistory.map((conversation) => (
                  <button
                    key={conversation.id}
                    type="button"
                    onClick={() => openHistoryConversation(conversation)}
                    className="mb-0.5 w-full truncate rounded-md px-2 py-2 text-left text-[13px] text-muted transition-colors hover:bg-hover hover:text-text"
                  >
                    {conversation.title}
                  </button>
                ))}
              </>
            )}
          </div>
        </aside>

        {searchOpen && (
          <div className="fixed inset-0 z-50" onClick={() => setSearchOpen(false)}>
            <div className="absolute left-[10px] top-[46px] w-56 rounded-xl border border-border bg-surface shadow-xl animate-fade-in overflow-hidden" onClick={(e) => e.stopPropagation()}>
              <div className="flex items-center gap-1.5 border-b border-border-subtle px-3 py-2">
                <Search className="h-3.5 w-3.5 shrink-0 text-faint" />
                <input
                  autoFocus
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Escape") setSearchOpen(false); }}
                  placeholder="搜索会话…"
                  className="w-full bg-transparent text-[13px] text-text placeholder:text-faint focus:outline-none"
                />
                {searchQuery && (
                  <button type="button" onClick={() => setSearchQuery("")} className="text-faint hover:text-text">
                    <X className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
              <div className="max-h-64 overflow-y-auto py-1">
                {filteredHistory.length === 0 ? (
                  <p className="px-3 py-2 text-[12px] text-faint">无匹配结果</p>
                ) : (
                  filteredHistory.map((conversation) => (
                    <button
                      key={conversation.id}
                      type="button"
                      onClick={() => { openHistoryConversation(conversation); setSearchOpen(false); setSearchQuery(""); }}
                      className="flex w-full items-center gap-2 px-3 py-1.5 text-[13px] text-muted transition-colors hover:bg-hover hover:text-text"
                    >
                      <span className="truncate text-left">{conversation.title}</span>
                    </button>
                  ))
                )}
              </div>
            </div>
          </div>
        )}

        <main className="relative min-h-0 min-w-0 flex-1">
          <DockviewReact
            components={components}
            defaultTabComponent={CustomTab}
            disableTabsOverflowList
            rightHeaderActionsComponent={TabBarActions}
            onReady={onReady}
            className="h-full w-full dockview-theme-light"
          />
        </main>
      </div>
    </I18nextProvider>
  );
}
