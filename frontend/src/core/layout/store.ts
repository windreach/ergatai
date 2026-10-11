import { create } from "zustand";
import { persist } from "zustand/middleware";
import { normalizeLayoutState } from "@/core/layout/sanitize";
import {
  isTabAllowedInDomain,
  removePaneFromLayout,
  replacePaneInLayout,
  updatePaneRatio,
  type LayoutDomain,
  type LayoutState,
  type LayoutTabType,
  type Pane,
  type PaneNode,
  type PaneSplitDirection,
  type Tab,
  type TabGroupColor,
} from "@/core/layout/model";

export interface OpenTabOptions {
  agentId?: string;
  closable?: boolean;
  singleInstance?: boolean;
}

export interface LayoutActions {
  open: (type: LayoutTabType, opts?: OpenTabOptions) => string | null;
  close: (id: string) => void;
  activate: (id: string) => void;
  focusPane: (paneId: string) => void;
  splitPane: (direction: PaneSplitDirection) => string | null;
  closePane: (paneId: string) => void;
  moveTabToPane: (tabId: string, paneId: string, index?: number) => boolean;
  setPaneRatio: (splitId: string, ratio: number) => void;
  syncPanes: (
    panes: Array<Pick<Pane, "id" | "tabOrder" | "activeTabId">>,
    activePaneId?: string | null,
  ) => void;
  reorder: (fromId: string, toId: string) => void;
  groupTabs: (tabIds: string[], visualGroupId?: string) => string | null;
  ungroupTab: (tabId: string) => void;
  setTabGroupColor: (visualGroupId: string, groupColor: TabGroupColor) => void;
  reorderGroup: (visualGroupId: string, targetTabId: string) => void;
  setPaneLayout: (paneLayout: PaneNode | null) => void;
  setDockviewLayout: (dockviewLayout: unknown) => void;
}

export type LayoutStore = LayoutState & LayoutActions;

export type UseLayoutStore = ReturnType<typeof createLayoutStore>;

function createIdFactory(prefix: string) {
  return (suffix: string) => {
    const uniqueId = typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    return `${prefix}-${suffix}-${uniqueId}`;
  };
}

function clonePanes(panes: Pane[]): Pane[] {
  return panes.map((pane) => ({ ...pane, tabOrder: [...pane.tabOrder] }));
}

function withPane(
  panes: Pane[],
  paneId: string,
  updater: (pane: Pane) => Pane,
): Pane[] {
  return panes.map((pane) => (pane.id === paneId ? updater(pane) : pane));
}

function nextMruTab(pane: Pane, closedTabId: string): string | null {
  const remaining = pane.tabOrder.filter((tabId) => tabId !== closedTabId);
  return remaining[remaining.length - 1] ?? null;
}

function normalizePaneRatio(ratio: number): number {
  return Math.min(0.85, Math.max(0.15, ratio));
}

export function createLayoutStore({
  domain,
  idPrefix,
  storageKey,
}: {
  domain: LayoutDomain;
  idPrefix: string;
  storageKey: string;
}) {
  const createId = createIdFactory(idPrefix);

  return create<LayoutStore>()(persist((set, get) => ({
    domain,
    tabs: [],
    panes: [],
    activeTabId: null,
    activePaneId: null,
    paneLayout: null,
    dockviewLayout: null,

    open: (type, opts = {}) => {
      if (!isTabAllowedInDomain(domain, type)) return null;

      const existing = opts.singleInstance
        ? get().tabs.find((tab) => tab.type === type)
        : opts.agentId
          ? get().tabs.find((tab) => tab.type === type && tab.agentId === opts.agentId)
          : undefined;
      if (existing) {
        get().activate(existing.id);
        return existing.id;
      }

      const id = createId("tab");
      set((state) => {
        let panes = clonePanes(state.panes);
        let paneLayout = state.paneLayout;
        let activePaneId = state.activePaneId;
        let pane = panes.find((item) => item.id === activePaneId);

        if (!pane) {
          pane = { id: createId("pane"), tabOrder: [], activeTabId: null };
          panes = [pane, ...panes];
          paneLayout = { kind: "pane", id: pane.id };
          activePaneId = pane.id;
        }

        pane = {
          ...pane,
          tabOrder: [...pane.tabOrder, id],
          activeTabId: id,
        };
        panes = withPane(panes, pane.id, () => pane!);

        const tab: Tab = {
          id,
          type,
          agentId: opts.agentId ?? null,
          closable: opts.closable ?? true,
          paneId: pane.id,
        };

        return {
          tabs: [...state.tabs, tab],
          panes,
          paneLayout,
          activePaneId,
          activeTabId: id,
        };
      });
      return id;
    },

    close: (id) =>
      set((state) => {
        const tab = state.tabs.find((item) => item.id === id);
        if (!tab) return state;

        let tabs = state.tabs.filter((item) => item.id !== id);
        let panes = clonePanes(state.panes);
        let paneLayout = state.paneLayout;
        let activePaneId = state.activePaneId;
        const paneId = tab.paneId;
        const pane = panes.find((item) => item.id === paneId);

        if (tab.visualGroupId) {
          const previewTabs = tabs.map((item) => (item.id === id
            ? { ...item, visualGroupId: undefined, groupColor: undefined }
            : item));
          const remainingGroupTabs = previewTabs.filter((item) => item.visualGroupId === tab.visualGroupId);
          if (remainingGroupTabs.length <= 1) {
            tabs = previewTabs.map((item) => (item.visualGroupId === tab.visualGroupId
              ? { ...item, visualGroupId: undefined, groupColor: undefined }
              : item));
          }
        }

        if (pane) {
          const tabOrder = pane.tabOrder.filter((tabId) => tabId !== id);
          const nextActiveTabId = pane.activeTabId === id
            ? nextMruTab(pane, id)
            : pane.activeTabId;
          if (tabOrder.length === 0) {
            panes = panes.filter((item) => item.id !== pane.id);
            paneLayout = removePaneFromLayout(paneLayout, pane.id);
            if (activePaneId === pane.id) {
              activePaneId = panes[0]?.id ?? null;
            }
          } else {
            panes = withPane(panes, pane.id, () => ({
              ...pane,
              tabOrder,
              activeTabId: nextActiveTabId,
            }));
          }
        }

        if (state.activeTabId === id) {
          const activePane = panes.find((item) => item.id === activePaneId);
          const fallbackTabId = activePane?.activeTabId ?? tabs[tabs.length - 1]?.id ?? null;
          return {
            tabs,
            panes,
            paneLayout,
            activePaneId,
            activeTabId: fallbackTabId,
          };
        }

        return { tabs, panes, paneLayout, activePaneId };
      }),

    activate: (id) =>
      set((state) => {
        const tab = state.tabs.find((item) => item.id === id);
        if (!tab) return state;
        const paneId = tab.paneId;
        if (!paneId) return { activeTabId: id };
        return {
          activeTabId: id,
          activePaneId: paneId,
          panes: withPane(clonePanes(state.panes), paneId, (pane) => ({
            ...pane,
            activeTabId: id,
          })),
        };
      }),

    focusPane: (paneId) =>
      set((state) => {
        const pane = state.panes.find((item) => item.id === paneId);
        if (!pane) return state;
        return {
          activePaneId: paneId,
          activeTabId: pane.activeTabId,
        };
      }),

    splitPane: (direction) => {
      const state = get();
      const sourcePaneId = state.activePaneId ?? state.panes[0]?.id;
      if (!sourcePaneId) return null;

      const newPaneId = createId("pane");
      set((current) => {
        const sourceLeaf: PaneNode = { kind: "pane", id: sourcePaneId };
        const targetLeaf: PaneNode = { kind: "pane", id: newPaneId };
        const nextLayout: PaneNode = {
          kind: "split",
          id: createId("split"),
          direction,
          ratio: 0.5,
          children: direction === "horizontal" ? [sourceLeaf, targetLeaf] : [sourceLeaf, targetLeaf],
        };
        return {
          panes: [...clonePanes(current.panes), { id: newPaneId, tabOrder: [], activeTabId: null }],
          paneLayout: replacePaneInLayout(current.paneLayout, sourcePaneId, nextLayout),
          activePaneId: newPaneId,
        };
      });
      return newPaneId;
    },

    closePane: (paneId) =>
      set((state) => {
        const pane = state.panes.find((item) => item.id === paneId);
        if (!pane || state.panes.length <= 1) return state;
        const closedTabIds = new Set(pane.tabOrder);
        const tabs = state.tabs.filter((tab) => !closedTabIds.has(tab.id));
        const panes = state.panes.filter((item) => item.id !== paneId);
        const paneLayout = removePaneFromLayout(state.paneLayout, paneId);
        const activePaneId = state.activePaneId === paneId
          ? panes[0]?.id ?? null
          : state.activePaneId;
        const nextActivePane = panes.find((item) => item.id === activePaneId);
        return {
          tabs,
          panes,
          paneLayout,
          activePaneId,
          activeTabId: nextActivePane?.activeTabId ?? tabs[tabs.length - 1]?.id ?? null,
        };
      }),

    moveTabToPane: (tabId, paneId, index) => {
      let moved = false;
      set((state) => {
        const tab = state.tabs.find((item) => item.id === tabId);
        const targetPane = state.panes.find((item) => item.id === paneId);
        if (!tab || !targetPane || tab.paneId === paneId) return state;
        moved = true;

        let panes = clonePanes(state.panes);
        const sourcePane = panes.find((item) => item.id === tab.paneId);
        if (sourcePane) {
          const sourceOrder = sourcePane.tabOrder.filter((id) => id !== tabId);
          if (sourceOrder.length === 0) {
            panes = panes.filter((item) => item.id !== sourcePane.id);
          } else {
            panes = withPane(panes, sourcePane.id, (pane) => ({
              ...pane,
              tabOrder: sourceOrder,
              activeTabId: pane.activeTabId === tabId ? sourceOrder[sourceOrder.length - 1] : pane.activeTabId,
            }));
          }
        }

        const currentTarget = panes.find((item) => item.id === paneId)!;
        const targetOrder = currentTarget.tabOrder.filter((id) => id !== tabId);
        targetOrder.splice(Math.max(0, Math.min(index ?? targetOrder.length, targetOrder.length)), 0, tabId);
        panes = withPane(panes, paneId, (pane) => ({
          ...pane,
          tabOrder: targetOrder,
          activeTabId: tabId,
        }));

        return {
          tabs: state.tabs.map((item) => (item.id === tabId ? { ...item, paneId } : item)),
          panes,
          activePaneId: paneId,
          activeTabId: tabId,
        };
      });
      return moved;
    },

    setPaneRatio: (splitId, ratio) =>
      set((state) => ({
        paneLayout: updatePaneRatio(state.paneLayout, splitId, normalizePaneRatio(ratio)),
      })),

    syncPanes: (panes, activePaneId) =>
      set((state) => {
        const validPaneIds = new Set(panes.map((pane) => pane.id));
        const paneByTabId = new Map<string, { paneId: string; index: number; activeTabId: string | null }>();
        panes.forEach((pane) => {
          pane.tabOrder.forEach((tabId, index) => {
            paneByTabId.set(tabId, { paneId: pane.id, index, activeTabId: pane.activeTabId });
          });
        });

        const tabs = state.tabs
          .filter((tab) => !tab.paneId || validPaneIds.has(tab.paneId) || paneByTabId.has(tab.id))
          .map((tab) => {
            const placement = paneByTabId.get(tab.id);
            if (!placement) return tab;
            return tab.paneId === placement.paneId ? tab : { ...tab, paneId: placement.paneId };
          });
        const visibleTabIds = new Set(tabs.map((tab) => tab.id));
        const normalizedPanes = panes
          .map((pane) => ({
            ...pane,
            tabOrder: pane.tabOrder.filter((tabId) => visibleTabIds.has(tabId)),
          }))
          .filter((pane) => pane.tabOrder.length > 0);
        const resolvedActivePaneId = activePaneId && validPaneIds.has(activePaneId)
          ? activePaneId
          : normalizedPanes[0]?.id ?? null;
        const activePane = normalizedPanes.find((pane) => pane.id === resolvedActivePaneId);
        return {
          tabs,
          panes: normalizedPanes,
          activePaneId: resolvedActivePaneId,
          activeTabId: (activePane?.activeTabId ?? (visibleTabIds.has(state.activeTabId ?? "")
            ? state.activeTabId
            : tabs[tabs.length - 1]?.id ?? null)),
        };
      }),

    reorder: (fromId, toId) =>
      set((state) => {
        const sourceTab = state.tabs.find((tab) => tab.id === fromId);
        const targetTab = state.tabs.find((tab) => tab.id === toId);
        if (!sourceTab?.paneId || sourceTab.paneId !== targetTab?.paneId) return state;
        if (sourceTab.visualGroupId) return state;

        return {
          panes: withPane(clonePanes(state.panes), sourceTab.paneId, (pane) => {
            const tabOrder = [...pane.tabOrder];
            const fromIndex = tabOrder.indexOf(fromId);
            const toIndex = tabOrder.indexOf(toId);
            if (fromIndex === -1 || toIndex === -1 || fromIndex === toIndex) return pane;
            tabOrder.splice(fromIndex, 1);
            tabOrder.splice(toIndex - (fromIndex < toIndex ? 1 : 0), 0, fromId);
            return { ...pane, tabOrder };
          }),
        };
      }),

    groupTabs: (tabIds, visualGroupId) => {
      const state = get();
      const uniqueTabIds = [...new Set(tabIds)].filter((tabId) =>
        state.tabs.some((tab) => tab.id === tabId),
      );
      if (uniqueTabIds.length < 2) return null;

      const groupedTabs = state.tabs.filter((tab) => uniqueTabIds.includes(tab.id));
      const requestedGroup = visualGroupId ?? groupedTabs.find((tab) => tab.visualGroupId)?.visualGroupId;
      const nextGroupId = requestedGroup ?? createId("group");
      const nextGroupColor = groupedTabs.find((tab) =>
        tab.visualGroupId === nextGroupId && tab.groupColor,
      )?.groupColor ?? groupedTabs.find((tab) => tab.groupColor)?.groupColor
        ?? (Math.random() < 0.5 ? "blue" : "purple");

      set((current) => ({
        tabs: current.tabs.map((tab) => {
          if (uniqueTabIds.includes(tab.id)) {
            return { ...tab, visualGroupId: nextGroupId, groupColor: nextGroupColor };
          }
          if (tab.visualGroupId === nextGroupId) {
            return { ...tab, visualGroupId: undefined, groupColor: undefined };
          }
          return tab;
        }),
      }));
      return nextGroupId;
    },

    ungroupTab: (tabId) =>
      set((state) => {
        const tab = state.tabs.find((item) => item.id === tabId);
        if (!tab?.visualGroupId) return state;

        const visualGroupId = tab.visualGroupId;
        let tabs = state.tabs.map((item) => (item.id === tabId
          ? { ...item, visualGroupId: undefined, groupColor: undefined }
          : item));
        const remaining = tabs.filter((item) => item.visualGroupId === visualGroupId);
        if (remaining.length <= 1) {
          tabs = tabs.map((item) => (item.visualGroupId === visualGroupId
            ? { ...item, visualGroupId: undefined, groupColor: undefined }
            : item));
        }
        return { tabs };
      }),

    setTabGroupColor: (visualGroupId, groupColor) =>
      set((state) => ({
        tabs: state.tabs.map((tab) => (tab.visualGroupId === visualGroupId
          ? { ...tab, groupColor }
          : tab)),
      })),

    reorderGroup: (visualGroupId, targetTabId) =>
      set((state) => {
        const groupTabs = state.tabs.filter((tab) => tab.visualGroupId === visualGroupId);
        if (groupTabs.length < 2 || groupTabs.some((tab) => tab.id === targetTabId)) return state;

        const paneId = groupTabs[0]?.paneId;
        const pane = state.panes.find((item) => item.id === paneId);
        if (!paneId || !pane) return state;

        const targetIndex = pane.tabOrder.indexOf(targetTabId);
        if (targetIndex === -1) return state;
        const groupTabIds = new Set(groupTabs.map((tab) => tab.id));
        const withoutGroup = pane.tabOrder.filter((tabId) => !groupTabIds.has(tabId));
        const insertionIndex = Math.min(
          withoutGroup.indexOf(targetTabId) === -1 ? withoutGroup.length : withoutGroup.indexOf(targetTabId),
          withoutGroup.length,
        );
        const tabOrder = [...withoutGroup];
        tabOrder.splice(insertionIndex, 0, ...groupTabs.map((tab) => tab.id).filter((id) => pane.tabOrder.includes(id)));

        return {
          panes: withPane(clonePanes(state.panes), paneId, (item) => ({ ...item, tabOrder })),
        };
      }),

    setPaneLayout: (paneLayout) => set({ paneLayout }),
    setDockviewLayout: (dockviewLayout) => set({ dockviewLayout }),
  }), {
    name: storageKey,
    version: 3,
    partialize: (state) => ({
      tabs: state.tabs,
      panes: state.panes,
      activeTabId: state.activeTabId,
      activePaneId: state.activePaneId,
      paneLayout: state.paneLayout,
      dockviewLayout: state.dockviewLayout,
    }),
    merge: (persisted, current) => ({
      ...current,
      ...normalizeLayoutState(persisted, current, domain),
    }),
  }));
}
