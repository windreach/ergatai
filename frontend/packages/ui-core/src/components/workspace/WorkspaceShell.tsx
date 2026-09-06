import { useEffect } from "react";
import { Plus } from "lucide-react";
import { useTranslation } from "react-i18next";

import { ChatPanel } from "../tabs/ChatPanel";
import { AgentTab } from "./AgentTab";
import {
  useAgentTabStore,
} from "../../core/workspace/store";

export function WorkspaceShell() {
  const { t } = useTranslation();
  const tabs = useAgentTabStore((state) => state.tabs);
  const activeTabId = useAgentTabStore((state) => state.activeTabId);
  const createTab = useAgentTabStore((state) => state.createTab);
  const closeTab = useAgentTabStore((state) => state.closeTab);
  const activateTab = useAgentTabStore((state) => state.activateTab);
  const ensureActiveTab = useAgentTabStore((state) => state.ensureActiveTab);

  useEffect(() => {
    ensureActiveTab();
  }, [ensureActiveTab]);

  const activeTab = tabs.find((tab) => tab.id === activeTabId);

  return (
    <div className="flex h-full min-h-0 w-full overflow-hidden bg-bg text-text">
      <aside className="h-full w-[15%] shrink-0 bg-[#E8E8E8]" />

      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div className="flex h-11 shrink-0 items-center gap-0 border-b border-black/5 bg-[#EBEBEB] px-2">
          <div
            role="tablist"
            aria-label={t("workspace.tabList")}
            className="flex min-w-0 flex-1 items-center overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
          >
            {tabs.map((tab, index) => (
              <AgentTab
                key={tab.id}
                tab={{
                  id: tab.id,
                  name: tab.name.trim()
                    || t("workspace.defaultTitle", { index: index + 1 }),
                  status: tab.status,
                }}
                isActive={tab.id === activeTabId}
                closeLabel={t("workspace.closeTab")}
                onSelect={() => activateTab(tab.id)}
                onClose={() => closeTab(tab.id)}
                onDragStart={() => {}}
              />
            ))}
            <button
              type="button"
              onClick={() => createTab()}
              aria-label={t("workspace.newTab")}
              title={t("workspace.newTab")}
              className="ml-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-transparent text-[#3D3D3D]/70 transition-colors hover:bg-black/5 hover:text-[#1C1B1F]"
            >
              <Plus className="h-4 w-4" />
            </button>
          </div>
        </div>

        <main className="min-h-0 flex-1 bg-chat">
          {activeTab ? (
            <ChatPanel
              key={activeTab.conversationId}
              agentName={activeTab.name.trim() || t("workspace.defaultTitle", {
                index: tabs.findIndex((tab) => tab.id === activeTab.id) + 1,
              })}
              conversationId={activeTab.conversationId}
            />
          ) : (
            <div className="flex h-full items-center justify-center text-sm text-[#A6ADC8]">
              {t("common.emptyTabs")}
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
