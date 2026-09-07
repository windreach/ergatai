import { Suspense, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { MessageCircle, Terminal, FolderOpen, CheckSquare, CircleDashed, Settings, PanelRightClose, Pin, PinOff, Plus, X, RefreshCw } from "lucide-react";
import { LazyChatPanel as DevelopedChatPanel } from "../../../panels/lazy-panels";
import { LazyTerminalPanel as DevelopedTerminalPanel } from "../../../panels/lazy-panels";
import { LazyFilesPanel as DevelopedFilesPanel } from "../../../panels/lazy-panels";
import { LazyReviewPanel as DevelopedReviewPanel } from "../../../panels/lazy-panels";
import { PlaceholderPanel } from "../../tabs/PlaceholderPanel";
import { AutomationSettingsPanel } from "./AutomationSettingsPanel";
import { usePanelAutomation, type PanelType } from "../../../core/workspace/panelAutomation";
import { ContextMenu } from "../../ui/ContextMenu";

interface RightPanelProps {
  isOpen?: boolean;
  onToggle?: () => void;
}

const panelComponents: Record<PanelType, () => React.ReactElement> = {
  chat: () => <DevelopedChatPanel />,
  terminal: () => <DevelopedTerminalPanel />,
  files: () => <DevelopedFilesPanel />,
  review: () => <DevelopedReviewPanel />,
  settings: () => <AutomationSettingsPanel />,
  placeholder: () => <PlaceholderPanel titleKey="tabs.placeholder" />,
};

const panelConfig: Record<PanelType, { icon: typeof MessageCircle; label: string }> = {
  chat: { icon: MessageCircle, label: "对话" },
  terminal: { icon: Terminal, label: "终端" },
  files: { icon: FolderOpen, label: "文件" },
  review: { icon: CheckSquare, label: "审查" },
  settings: { icon: Settings, label: "设置" },
  placeholder: { icon: CircleDashed, label: "占位" },
};

const newPanelTypes: PanelType[] = ["chat", "terminal", "files", "review", "placeholder"];

export function RightPanel({ isOpen = true, onToggle }: RightPanelProps) {
  const activePanel = usePanelAutomation((state) => state.activePanel);
  const openPanels = usePanelAutomation((state) => state.openPanels);
  const setActivePanel = usePanelAutomation((state) => state.setActivePanel);
  const closePanel = usePanelAutomation((state) => state.closePanel);
  const openPanel = usePanelAutomation((state) => state.openPanel);
  const [showNewMenu, setShowNewMenu] = useState(false);
  const [newMenuPosition, setNewMenuPosition] = useState<{ top: number; left: number }>({ top: 0, left: 0 });
  const [reloadTokens, setReloadTokens] = useState<Partial<Record<PanelType, number>>>({});
  const newMenuRef = useRef<HTMLDivElement>(null);
  const newMenuAnchorRef = useRef<HTMLDivElement>(null);

  // 固定标签
  const [pinnedPanels, setPinnedPanels] = useState<Set<PanelType>>(() => {
    try {
      const saved = localStorage.getItem("ergatai_pinned_panels");
      return saved ? new Set(JSON.parse(saved)) : new Set();
    } catch {
      return new Set();
    }
  });

  useEffect(() => {
    localStorage.setItem("ergatai_pinned_panels", JSON.stringify([...pinnedPanels]));
  }, [pinnedPanels]);

  useEffect(() => {
    const requested = new URLSearchParams(window.location.search).get("panel");
    const panel = requested;
    if (panel && panel in panelConfig) {
      openPanel(panel as PanelType, true);
    }
  }, [openPanel]);

  // 关闭新菜单外部点击
  useEffect(() => {
    if (!showNewMenu) return;
    const handleClick = (e: MouseEvent) => {
      const target = e.target as Node;
      const clickedInsideMenu = newMenuRef.current?.contains(target) ?? false;
      const clickedInsideAnchor = newMenuAnchorRef.current?.contains(target) ?? false;
      if (!clickedInsideMenu && !clickedInsideAnchor) {
        setShowNewMenu(false);
      }
    };
    const handleLayoutChange = () => {
      const rect = newMenuAnchorRef.current?.getBoundingClientRect();
      if (rect) {
        setNewMenuPosition({
          top: rect.bottom + 4,
          left: Math.max(12, Math.min(rect.left, window.innerWidth - 162)),
        });
      }
    };
    document.addEventListener("mousedown", handleClick);
    document.addEventListener("scroll", handleLayoutChange, true);
    window.addEventListener("resize", handleLayoutChange);
    return () => {
      document.removeEventListener("mousedown", handleClick);
      document.removeEventListener("scroll", handleLayoutChange, true);
      window.removeEventListener("resize", handleLayoutChange);
    };
  }, [showNewMenu]);

  // 键盘快捷键
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const isMac = navigator.platform.toLowerCase().includes("mac");
      const mod = isMac ? e.metaKey : e.ctrlKey;

      if (!mod) return;

      // Ctrl+W / Cmd+W: 关闭当前标签（如果非固定）
      if ((e.key === "w" || e.key === "W") && !e.shiftKey) {
        if (!pinnedPanels.has(activePanel)) {
          e.preventDefault();
          closePanel(activePanel);
        }
        return;
      }

      // Ctrl+Tab: 下一个标签
      if (e.key === "Tab" && !e.shiftKey) {
        e.preventDefault();
        const idx = openPanels.indexOf(activePanel);
        const next = openPanels[(idx + 1) % openPanels.length];
        if (next) setActivePanel(next);
        return;
      }

      // Ctrl+Shift+Tab: 上一个标签
      if (e.key === "Tab" && e.shiftKey) {
        e.preventDefault();
        const idx = openPanels.indexOf(activePanel);
        const prev = openPanels[(idx - 1 + openPanels.length) % openPanels.length];
        if (prev) setActivePanel(prev);
        return;
      }

      // Ctrl+T / Cmd+T: 打开新建菜单
      if (e.key === "t" || e.key === "T") {
        e.preventDefault();
        const rect = newMenuAnchorRef.current?.getBoundingClientRect();
        if (rect) {
          setNewMenuPosition({
            top: rect.bottom + 4,
            left: Math.max(12, Math.min(rect.left, window.innerWidth - 162)),
          });
        }
        setShowNewMenu(true);
        return;
      }

      // Ctrl+1-9 / Cmd+1-9: 切换到第 N 个标签
      const num = parseInt(e.key);
      if (num >= 1 && num <= 9) {
        e.preventDefault();
        const target = openPanels[num - 1];
        if (target) setActivePanel(target);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [activePanel, openPanels, setActivePanel, closePanel, pinnedPanels]);

  const togglePin = (panel: PanelType) => {
    setPinnedPanels((prev) => {
      const next = new Set(prev);
      if (next.has(panel)) next.delete(panel);
      else next.add(panel);
      return next;
    });
  };

  const handleTabClose = (panel: PanelType) => {
    if (pinnedPanels.has(panel)) return; // 固定标签不能关闭
    closePanel(panel);
  };

  const closeOtherTabs = (panel: PanelType) => {
    const toClose = openPanels.filter((p) => p !== panel && !pinnedPanels.has(p));
    toClose.forEach((p) => closePanel(p));
  };

  const closeRightTabs = (panel: PanelType) => {
    const idx = openPanels.indexOf(panel);
    const toClose = openPanels.slice(idx + 1).filter((p) => !pinnedPanels.has(p));
    toClose.forEach((p) => closePanel(p));
  };

  const reloadPanel = (panel: PanelType) => {
    setReloadTokens((current) => ({ ...current, [panel]: (current[panel] ?? 0) + 1 }));
  };

  const buildTabMenuItems = (panel: PanelType) => {
    const isPinned = pinnedPanels.has(panel);
    const idx = openPanels.indexOf(panel);
    const hasRightTabs = openPanels.slice(idx + 1).some((p) => !pinnedPanels.has(p));

    const items = [
      {
        label: isPinned ? "取消固定" : "固定标签",
        icon: isPinned ? <PinOff className="h-4 w-4" /> : <Pin className="h-4 w-4" />,
        onClick: () => togglePin(panel),
      },
      { label: "重新加载", icon: <RefreshCw className="h-4 w-4" />, onClick: () => reloadPanel(panel) },
      { separator: true as const, label: "", onClick: () => {} },
      {
        label: "关闭标签",
        icon: <X className="h-4 w-4" />,
        onClick: () => handleTabClose(panel),
      },
      {
        label: "关闭其他标签",
        onClick: () => closeOtherTabs(panel),
      },
    ];

    if (hasRightTabs) {
      items.push({
        label: "关闭右侧标签",
        onClick: () => closeRightTabs(panel),
      });
    }

    return items;
  };

  // 排序：固定标签在前
  const sortedPanels = [...openPanels].sort((a, b) => {
    const aPinned = pinnedPanels.has(a) ? 0 : 1;
    const bPinned = pinnedPanels.has(b) ? 0 : 1;
    return aPinned - bPinned;
  });

  if (!isOpen) {
    return (
      <div className="flex h-14 w-full flex-shrink-0 items-center justify-end border-b border-border-subtle bg-surface pr-3">
        <button
          type="button"
          onClick={onToggle}
          aria-label="切换工具面板"
          title="切换工具面板"
            className="flex h-8 w-8 items-center justify-center rounded-lg text-muted transition-colors hover:bg-bg hover:text-text"
        >
          <PanelRightClose className="h-4 w-4" />
        </button>
      </div>
    );
  }

  const ActiveComponent = panelComponents[activePanel];

  const toggleNewMenu = () => {
    if (showNewMenu) {
      setShowNewMenu(false);
      return;
    }

    const rect = newMenuAnchorRef.current?.getBoundingClientRect();
    if (rect) {
      setNewMenuPosition({
        top: rect.bottom + 4,
        left: Math.max(12, Math.min(rect.left, window.innerWidth - 162)),
      });
    }
    setShowNewMenu(true);
  };

  return (
    <div className="flex h-full w-full flex-col border-l border-border-subtle bg-surface">
      <div className="flex h-14 items-center gap-2 border-b border-border-subtle bg-bg px-3">
        <div className="flex min-w-0 items-center gap-1 overflow-x-auto">
          {sortedPanels.map((panel) => {
            const isPinned = pinnedPanels.has(panel);
            return (
              <ContextMenu key={panel} items={buildTabMenuItems(panel)}>
                <TabButton
                  panel={panel}
                  isActive={panel === activePanel}
                  isPinned={isPinned}
                  onClick={() => setActivePanel(panel)}
                  onClose={() => handleTabClose(panel)}
                  onPin={() => togglePin(panel)}
                />
              </ContextMenu>
            );
          })}

          <div ref={newMenuAnchorRef} className="relative flex-shrink-0">
            <button
              onClick={toggleNewMenu}
              className="flex h-9 w-9 items-center justify-center rounded-lg border border-transparent text-muted transition-colors hover:border-border-subtle hover:bg-surface hover:text-text"
              title="新建标签页 (Ctrl+T)"
            >
              <Plus className="h-4 w-4" />
            </button>
          </div>
        </div>
        {onToggle && (
          <button
            type="button"
            onClick={onToggle}
            aria-label="切换工具面板"
            title="切换工具面板"
            className="ml-auto flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg text-muted transition-colors hover:bg-bg hover:text-text"
          >
            <PanelRightClose className="h-4 w-4" />
          </button>
        )}
      </div>

      {showNewMenu && createPortal(
        <div
          ref={newMenuRef}
          className="fixed z-[999] min-w-[150px] overflow-hidden rounded-xl border border-border-subtle bg-surface py-1 shadow-lg animate-fade-in-up"
          style={{ top: newMenuPosition.top, left: newMenuPosition.left }}
        >
          {newPanelTypes
            .map((panel) => {
              const cfg = panelConfig[panel];
              const Icon = cfg.icon;
              return (
                <button
                  key={panel}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => {
                    openPanel(panel, true);
                    setShowNewMenu(false);
                  }}
                  className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-text transition-colors hover:bg-primary/10 hover:text-primary"
                >
                  <Icon className="h-4 w-4" />
                  <span>{cfg.label}面板</span>
                </button>
              );
            })}
        </div>,
        document.body,
      )}

      <div className="flex-1 overflow-hidden">
        <div key={`${activePanel}-${reloadTokens[activePanel] ?? 0}`} className="h-full">
          <Suspense fallback={<div className="h-full w-full bg-bg" />}>
            <ActiveComponent />
          </Suspense>
        </div>
      </div>
    </div>
  );

}

function TabButton({
  panel,
  isActive,
  isPinned,
  onClick,
  onClose,
  onPin,
}: {
  panel: PanelType;
  isActive: boolean;
  isPinned: boolean;
  onClick: () => void;
  onClose: () => void;
  onPin: () => void;
}) {
  const config = panelConfig[panel];
  const Icon = config.icon;

  return (
    <div
      className={`group flex h-9 min-w-fit items-center gap-1.5 rounded-lg border px-2.5 text-sm transition-colors ${
        isActive
          ? "border-primary/30 bg-primary/10 font-medium text-primary shadow-sm"
          : "border-transparent text-muted hover:border-border-subtle hover:bg-surface hover:text-text"
      } ${isPinned && !isActive ? "bg-primary/5" : ""}`}
    >
      <button onClick={onClick} className="flex items-center gap-1.5">
        {isPinned && <Pin className="h-3 w-3" />}
        <Icon className="h-4 w-4" />
        <span className="whitespace-nowrap">{config.label}</span>
      </button>
      {isPinned ? (
        <button
          onClick={onPin}
          className="ml-0.5 flex h-6 w-6 items-center justify-center rounded-md text-muted transition-colors hover:bg-surface hover:text-text"
          title="取消固定"
        >
          <PinOff className="h-3 w-3" />
        </button>
      ) : (
        <button
          onClick={onClose}
          className={`flex h-6 w-6 items-center justify-center rounded-md transition-colors ${
            isActive ? "text-primary hover:bg-surface hover:text-text" : "text-muted opacity-0 hover:bg-surface hover:text-text group-hover:opacity-100"
          }`}
          title="关闭"
        >
          <X className="h-3 w-3" />
        </button>
      )}
    </div>
  );
}
