import { useTranslation } from "react-i18next";

import { DockviewTabs } from "@/components/layout/DockviewTabsContainer";
import brandLogo from "@/assets/ergatai-logo.png";
import type { LayoutTabType } from "@/core/layout/model";
import type { UseLayoutStore } from "@/core/layout/store";

type TabType = LayoutTabType;

export function ConversationArea({ useStore }: { useStore: UseLayoutStore }) {
  const { t } = useTranslation();
  const open = useStore((state) => state.open);

  return (
    <DockviewTabs
      useStore={useStore}
      domain="conversation"
      ariaLabel={t("workspace.conversationArea")}
      titleForTab={(type) => t(`tabs.${type}`)}
      emptyLabel={t("workspace.emptyConversation")}
      emptyState={(createTab) => (
        <ConversationWelcome
          onStartChat={() => createTab("chat")}
          startLabel={t("workspace.startNewConversation")}
          welcomeLabel={t("common.welcome")}
        />
      )}
      newTabLabel={t("common.newTab")}
      newTabs={[{ type: "chat", label: t("common.newChatTab") }]}
      openNewTab={(type) => type === "chat"
        ? open("chat", { agentId: `chat-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` })
        : open(type)}
      groupWithLabel={t("common.groupWithTab")}
      ungroupLabel={t("common.ungroupTab")}
      tabGroupLabel={t("common.tabGroup")}
      closeTabLabel={t("common.closeTab")}
      renameGroupLabel={t("common.renameGroup")}
      groupColorLabel={t("common.groupColor")}
      collapseGroupLabel={t("common.collapseGroup")}
      expandGroupLabel={t("common.expandGroup")}
      closeGroupLabel={t("common.closeGroup")}
    />
  );
}

export function WorkspaceArea({ useStore }: { useStore: UseLayoutStore }) {
  const { t } = useTranslation();
  const open = useStore((state) => state.open);
  const workspaceOptions: { type: TabType; shortcut: string }[] = [
    { type: "review", shortcut: "Ctrl+Shift+G" },
    { type: "terminal", shortcut: "Ctrl+`" },
    { type: "browser", shortcut: "Ctrl+T" },
    { type: "files", shortcut: "Ctrl+P" },
  ];

  return (
    <DockviewTabs
      useStore={useStore}
      domain="workspace"
      ariaLabel={t("workspace.workspaceArea")}
      titleForTab={(type) => t(`tabs.${type}`)}
      emptyLabel={t("workspace.emptyWorkspace")}
      emptyState={(createTab) => (
        <WorkspaceAreaWelcome
          options={workspaceOptions}
          onCreate={createTab}
          titleForTab={(type) => t(`tabs.${type}`)}
        />
      )}
      newTabLabel={t("common.newTab")}
      newTabs={[
        { type: "terminal", label: t("tabs.terminal") },
        { type: "browser", label: t("tabs.browser") },
        { type: "files", label: t("tabs.files"), singleInstance: true },
        { type: "review", label: t("tabs.review"), singleInstance: true },
      ]}
      openNewTab={(type) => open(type, {
        singleInstance: type === "review" || type === "files",
      })}
      groupWithLabel={t("common.groupWithTab")}
      ungroupLabel={t("common.ungroupTab")}
      tabGroupLabel={t("common.tabGroup")}
      closeTabLabel={t("common.closeTab")}
      renameGroupLabel={t("common.renameGroup")}
      groupColorLabel={t("common.groupColor")}
      collapseGroupLabel={t("common.collapseGroup")}
      expandGroupLabel={t("common.expandGroup")}
      closeGroupLabel={t("common.closeGroup")}
    />
  );
}

function ConversationWelcome({ onStartChat, startLabel, welcomeLabel }: {
  onStartChat: () => void;
  startLabel: string;
  welcomeLabel: string;
}) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-7 text-center">
      <img
        src={brandLogo}
        alt=""
        aria-hidden="true"
        className="h-24 w-auto object-contain dark:invert"
      />
      <div className="space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight text-text">Egatai</h1>
        <p className="text-sm text-muted">{welcomeLabel}</p>
      </div>
      <button
        type="button"
        onClick={onStartChat}
        className="h-9 rounded-lg bg-accent px-4 text-[13px] font-medium text-on-accent transition-colors hover:bg-accent-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
      >
        {startLabel}
      </button>
    </div>
  );
}

interface WorkspaceAreaOption {
  type: TabType;
  shortcut: string;
}

function WorkspaceAreaWelcome({
  options,
  onCreate,
  titleForTab,
}: {
  options: WorkspaceAreaOption[];
  onCreate: (type: TabType) => void;
  titleForTab: (type: TabType) => string;
}) {
  return (
    <div className="w-full max-w-[320px] space-y-2.5">
      {options.map((option) => (
        <button
          key={option.type}
          type="button"
          onClick={() => onCreate(option.type)}
          aria-label={titleForTab(option.type)}
          title={titleForTab(option.type)}
          className="flex h-11 w-full items-center gap-3 rounded-xl border border-border-subtle bg-chat/70 px-3 text-left text-[13px] text-text transition-colors hover:bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
        >
          <span className="min-w-0 flex-1 truncate">{titleForTab(option.type)}</span>
          <kbd className="hidden shrink-0 rounded-md border border-border-subtle bg-elevated px-2 py-0.5 text-[11px] font-medium text-muted sm:block">
            {option.shortcut}
          </kbd>
        </button>
      ))}
    </div>
  );
}
