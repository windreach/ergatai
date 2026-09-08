import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  FolderOpen,
  Globe,
  MessageCircle,
  Plus,
  ShieldCheck,
  Terminal as TerminalIcon,
  X,
  type LucideIcon,
} from "lucide-react";

import { ErrorBoundary } from "../ErrorBoundary";
import { PlaceholderPanel } from "../tabs/PlaceholderPanel";
import { ChatPanel } from "../chat/ChatPanel";
import { LazyFilesPanel as FilesPanel } from "../../panels/lazy-panels";
import { LazyReviewPanel as ReviewPanel } from "../../panels/lazy-panels";
import { LazyTerminalPanel as TerminalPanel } from "../../panels/lazy-panels";
import { useToolPanelStore, type ToolPanelTab, type ToolPanelType } from "../../core/browser/store";
import { cn } from "../../lib/utils";

const panelIcons: Record<ToolPanelType, LucideIcon> = {
  terminal: TerminalIcon,
  browser: Globe,
  files: FolderOpen,
  review: ShieldCheck,
  sideChat: MessageCircle,
};

const newTabOptions: Array<{ type: ToolPanelType; singleInstance?: boolean }> = [
  { type: "sideChat", singleInstance: true },
  { type: "terminal" },
  { type: "browser" },
  { type: "files", singleInstance: true },
  { type: "review", singleInstance: true },
];

export function ToolWorkspace({ showTabBar = true }: { showTabBar?: boolean } = {}) {
  const { t } = useTranslation();
  const tabs = useToolPanelStore((state) => state.tabs);
  const activeTabId = useToolPanelStore((state) => state.activeTabId);
  const createPanel = useToolPanelStore((state) => state.createPanel);
  const closePanel = useToolPanelStore((state) => state.closePanel);
  const activatePanel = useToolPanelStore((state) => state.activatePanel);
  const [menuOpen, setMenuOpen] = useState(false);
  const [mountedTabIds, setMountedTabIds] = useState<string[]>(() => (
    activeTabId ? [activeTabId] : []
  ));
  const plusRef = useRef<HTMLDivElement>(null);
  const activeTab = tabs.find((tab) => tab.id === activeTabId);

  const visiblePanelIds = useMemo(() => {
    if (!activeTab || mountedTabIds.includes(activeTab.id)) return mountedTabIds;
    return [...mountedTabIds, activeTab.id];
  }, [activeTab, mountedTabIds]);

  const availableNewTabs = useMemo(() => (
    newTabOptions.filter((option) => (
      !option.singleInstance || !tabs.some((tab) => tab.type === option.type)
    ))
  ), [tabs]);

  useEffect(() => {
    if (!menuOpen) return;

    function handlePointerDown(event: PointerEvent) {
      if (!plusRef.current?.contains(event.target as Node)) {
        setMenuOpen(false);
      }
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setMenuOpen(false);
    }

    document.addEventListener("pointerdown", handlePointerDown, true);
    document.addEventListener("keydown", handleKeyDown, true);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown, true);
      document.removeEventListener("keydown", handleKeyDown, true);
    };
  }, [menuOpen]);

  function selectPanel(id: string) {
    setMountedTabIds((currentIds) => (
      currentIds.includes(id) ? currentIds : [...currentIds, id]
    ));
    activatePanel(id);
  }

  function startPanel(type: ToolPanelType) {
    createPanel(type);
    setMenuOpen(false);
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-bg">
      {showTabBar && (
        <div className="flex h-11 shrink-0 items-center gap-1 border-b border-border-subtle bg-surface px-2">
          <div className="flex min-w-0 items-center gap-1 overflow-x-auto">
            {tabs.map((tab) => {
              const active = tab.id === activeTabId;
              const Icon = panelIcons[tab.type];

              return (
                <div
                  key={tab.id}
                  className={cn(
                    "group flex h-8 shrink-0 items-center gap-2 rounded-lg border px-2 text-left text-[12px] transition-colors",
                    active
                      ? "border-accent/30 bg-bg text-text"
                      : "border-transparent text-muted hover:bg-hover hover:text-text",
                  )}
                >
                  <button
                    type="button"
                    onClick={() => selectPanel(tab.id)}
                    className="flex min-w-0 items-center gap-2"
                  >
                    <Icon
                      className={cn(
                        "h-3.5 w-3.5 shrink-0",
                        active ? "text-accent" : "text-faint",
                      )}
                    />
                    <span className="min-w-0 truncate">{t(`tabs.${tab.type}`)}</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => closePanel(tab.id)}
                    aria-label={t("panelBrowser.closeTab")}
                    title={t("panelBrowser.closeTab")}
                    className={cn(
                      "flex h-4 w-4 shrink-0 items-center justify-center rounded-sm text-muted transition-colors hover:bg-hover hover:text-text",
                      active ? "opacity-70" : "opacity-0 group-hover:opacity-70",
                    )}
                  >
                    <X className="h-3 w-3" />
                  </button>
                </div>
              );
            })}

            <div ref={plusRef} className="relative shrink-0 pl-1">
              <button
                type="button"
                onClick={() => setMenuOpen((open) => !open)}
                aria-label={t("panelBrowser.newTab")}
                title={t("panelBrowser.newTab")}
                aria-expanded={menuOpen}
                className="flex h-6 w-6 items-center justify-center rounded-md text-muted transition-colors hover:bg-hover hover:text-text"
              >
                <Plus className="h-3.5 w-3.5" />
              </button>
              {menuOpen && (
                <div className="absolute left-0 top-8 z-30 w-40 overflow-hidden rounded-xl border border-border-subtle bg-elevated p-1 shadow-lg">
                  {availableNewTabs.map((option) => (
                    <button
                      key={option.type}
                      type="button"
                      onClick={() => startPanel(option.type)}
                      className="flex h-8 w-full items-center gap-2 rounded-lg px-2 text-left text-[12px] text-text transition-colors hover:bg-hover"
                    >
                      {t(`tabs.${option.type}`)}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      <div className="relative min-h-0 flex-1 overflow-hidden">
        {activeTab ? (
          visiblePanelIds.map((panelId) => {
            const tab = tabs.find((item) => item.id === panelId);
            if (!tab) return null;
            const isActive = tab.id === activeTab.id;

            return (
              <div
                key={tab.id}
                hidden={!isActive}
                className="absolute inset-0 min-h-0 overflow-hidden"
              >
                <ErrorBoundary>
                  <Suspense fallback={<div className="h-full w-full bg-bg" />}>
                    <ToolPanelContent tab={tab} />
                  </Suspense>
                </ErrorBoundary>
              </div>
            );
          })
        ) : (
          <div className="flex h-full items-center justify-center px-6 text-center text-sm text-faint">
            {showTabBar ? t("toolWorkspace.empty") : t("shell.rightTools")}
          </div>
        )}
      </div>
    </div>
  );
}

function ToolPanelContent({ tab }: { tab: ToolPanelTab }) {
  if (tab.type === "terminal") {
    return <TerminalPanel />;
  }
  if (tab.type === "files") {
    return <FilesPanel />;
  }
  if (tab.type === "review") {
    return <ReviewPanel />;
  }
  if (tab.type === "sideChat") {
    return <ChatPanel key={tab.id} conversationId={tab.id} />;
  }
  return <PlaceholderPanel titleKey={`tabs.${tab.type}`} />;
}
