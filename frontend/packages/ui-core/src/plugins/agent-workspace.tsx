import { useCallback, useEffect, useState } from "react";
import { I18nextProvider } from "react-i18next";
import { useTranslation } from "react-i18next";
import { ChevronLeft, History, Plus, X } from "lucide-react";

import { ChatPanel } from "../components/chat/ChatPanel";
import i18n from "../i18n";
import type { ChatConversationSummary } from "@ergatai/platform-core";
import { listChatConversations } from "@ergatai/platform-core";
import "../styles.css";

interface AgentTab {
  id: string;
  title: string;
}

const tabsStorageKey = "ergatai.dockview.tabs";

function defaultTabs(): AgentTab[] {
  return [{ id: "default", title: "Agent 1" }];
}

function readTabs(): AgentTab[] {
  try {
    const stored = localStorage.getItem(tabsStorageKey);
    if (!stored) {
      return defaultTabs();
    }

    const parsed: unknown = JSON.parse(stored);
    if (!Array.isArray(parsed)) {
      return defaultTabs();
    }

    const tabs = parsed.filter((item): item is AgentTab => (
      typeof item === "object"
      && item !== null
      && typeof (item as AgentTab).id === "string"
      && typeof (item as AgentTab).title === "string"
    ));

    return tabs.length > 0 ? tabs : defaultTabs();
  } catch {
    return defaultTabs();
  }
}

function createTab(count: number): AgentTab {
  const uniqueId = typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;

  return { id: `agent-${uniqueId}`, title: `Agent ${count + 1}` };
}

export function AgentWorkspace() {
  const { t } = useTranslation();
  const [tabs, setTabs] = useState<AgentTab[]>(readTabs);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const [history, setHistory] = useState<ChatConversationSummary[]>([]);
  const [historyOpen, setHistoryOpen] = useState(true);
  const activeTab = tabs.find((tab) => tab.id === activeTabId) ?? tabs[0];

  const persistTabs = (nextTabs: AgentTab[]) => {
    localStorage.setItem(tabsStorageKey, JSON.stringify(nextTabs));
  };

  const refreshHistory = useCallback(() => {
    void listChatConversations()
      .then(setHistory)
      .catch(() => setHistory([]));
  }, []);

  useEffect(() => {
    refreshHistory();
  }, [refreshHistory]);

  const addTab = () => {
    const nextTabs = [...tabs, createTab(tabs.length)];
    setTabs(nextTabs);
    persistTabs(nextTabs);
    setActiveTabId(nextTabs.at(-1)?.id ?? null);
  };

  const closeTab = (tabId: string) => {
    const nextTabs = tabs.filter((tab) => tab.id !== tabId);
    setTabs(nextTabs);
    persistTabs(nextTabs);
  };

  const openHistoryConversation = (conversation: ChatConversationSummary) => {
    const nextTabs = tabs.some((tab) => tab.id === conversation.id)
      ? tabs.map((tab) => tab.id === conversation.id
          ? { ...tab, title: conversation.title }
          : tab)
      : [...tabs, { id: conversation.id, title: conversation.title }];

    setTabs(nextTabs);
    persistTabs(nextTabs);
    setActiveTabId(conversation.id);
  };

  return (
    <I18nextProvider i18n={i18n}>
      <div className="flex h-full w-full flex-col overflow-hidden bg-bg text-text">
        <header className="flex h-11 flex-shrink-0 items-center gap-1 overflow-x-auto border-b border-border-subtle bg-surface px-2">
          {tabs.map((tab) => {
            const active = tab.id === activeTab?.id;

            return (
              <div
                key={tab.id}
                className={`group flex h-8 flex-shrink-0 items-center gap-2 rounded-md px-3 text-[13px] transition-colors ${
                  active ? "bg-bg text-text" : "text-muted hover:bg-hover hover:text-text"
                }`}
              >
                <button
                  type="button"
                  onClick={() => setActiveTabId(tab.id)}
                  className="whitespace-nowrap"
                >
                  {tab.title}
                </button>
                <button
                  type="button"
                  onClick={() => closeTab(tab.id)}
                  aria-label={`关闭 ${tab.title}`}
                  className="rounded p-0.5 text-faint opacity-0 transition-opacity hover:text-text group-hover:opacity-100"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            );
          })}
        </header>

        <div className="flex min-h-0 flex-1">
          <aside
            aria-label={t("workspace.history")}
            className={`hidden flex-shrink-0 flex-col overflow-hidden border-r border-border-subtle bg-surface transition-[width] duration-200 ease-in-out md:flex ${
              historyOpen ? "w-60" : "w-12"
            }`}
          >
            <div className={`flex h-10 flex-shrink-0 items-center gap-2 border-b border-border-subtle px-3 text-[13px] text-muted transition-opacity duration-150 ${
              historyOpen ? "opacity-100" : "pointer-events-none opacity-0"
            }`}>
                <History className="h-4 w-4" />
                <span className="flex-1 truncate">{t("workspace.history")}</span>
            </div>
            <div className={historyOpen ? "p-2" : "flex justify-center p-2"}>
              <button
                type="button"
                onClick={addTab}
                aria-label={t("workspace.newConversation")}
                title={t("workspace.newConversation")}
                className={`flex flex-shrink-0 items-center rounded-md text-muted transition-colors hover:bg-hover hover:text-text ${
                  historyOpen
                    ? "w-full gap-2 border border-border px-2 py-2 text-[13px]"
                    : "h-8 w-8 justify-center"
                }`}
              >
                <Plus className="h-4 w-4" />
                {historyOpen && <span className="truncate">{t("workspace.newConversation")}</span>}
              </button>
            </div>
            <div className={`min-h-0 flex-1 overflow-y-auto p-2 transition-opacity duration-150 ${
              historyOpen ? "opacity-100" : "pointer-events-none opacity-0"
            }`}>
                {history.length === 0 ? (
                  <p className="px-2 py-3 text-[12px] text-muted">
                    {t("workspace.noHistory")}
                  </p>
                ) : (
                  history.map((conversation) => {
                    const active = conversation.id === activeTab?.id;

                    return (
                      <button
                        key={conversation.id}
                        type="button"
                        onClick={() => openHistoryConversation(conversation)}
                        className={`mb-1 w-full truncate rounded-md px-2 py-2 text-left text-[13px] transition-colors ${
                          active
                            ? "bg-bg text-text"
                            : "text-muted hover:bg-hover hover:text-text"
                        }`}
                      >
                        {conversation.title}
                      </button>
                    );
                  })
              )}
            </div>
          </aside>

          <main className="min-h-0 flex-1">
            {activeTab ? (
              <ChatPanel
                key={activeTab.id}
                conversationId={activeTab.id}
                agentName={activeTab.title}
                headerLeading={(
                  <button
                    type="button"
                    onClick={() => setHistoryOpen((open) => !open)}
                    aria-expanded={historyOpen}
                    aria-label={historyOpen ? t("workspace.collapseHistory") : t("workspace.expandHistory")}
                    title={historyOpen ? t("workspace.collapseHistory") : t("workspace.expandHistory")}
                    className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-md text-muted transition-colors hover:bg-hover hover:text-text"
                  >
                    <ChevronLeft className={`h-4 w-4 transition-transform duration-200 ease-in-out ${historyOpen ? "" : "rotate-180"}`} />
                  </button>
                )}
                onConversationSaved={refreshHistory}
                className="h-full"
              />
            ) : (
              <div className="flex h-full items-center justify-center text-sm text-muted">
                没有打开的 Agent
              </div>
            )}
          </main>
        </div>
      </div>
    </I18nextProvider>
  );
}
