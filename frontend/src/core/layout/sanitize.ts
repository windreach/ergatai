import {
  isTabAllowedInDomain,
  isLayoutDomain,
  isLayoutTabType,
  tabGroupColors,
  type LayoutDomain,
  type LayoutState,
  type LayoutTabType,
  type Pane,
  type PaneNode,
  type Tab,
} from "@/core/layout/model";

interface LegacyTab extends Omit<Tab, "visualGroupId"> {
  groupId?: string;
  visualGroupId?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isPane(value: unknown): value is Pane {
  if (!isRecord(value) || typeof value.id !== "string" || value.id.length === 0) return false;
  if (!Array.isArray(value.tabOrder) || value.tabOrder.some((id) => typeof id !== "string")) return false;
  return value.activeTabId === null || typeof value.activeTabId === "string";
}

function buildBalancedPaneLayout(paneIds: string[]): PaneNode | null {
  if (paneIds.length === 0) return null;
  if (paneIds.length === 1) return { kind: "pane", id: paneIds[0] };

  const middle = Math.ceil(paneIds.length / 2);
  const first = buildBalancedPaneLayout(paneIds.slice(0, middle));
  const second = buildBalancedPaneLayout(paneIds.slice(middle));
  if (!first || !second) return null;

  return {
    kind: "split",
    id: `recovered-split-${first.kind === "pane" ? first.id : first.id}-${second.kind === "pane" ? second.id : second.id}`,
    direction: "horizontal",
    ratio: 0.5,
    children: [first, second],
  };
}

function createRecoveredPane(index: number): Pane {
  return {
    id: `recovered-pane-${index + 1}`,
    tabOrder: [],
    activeTabId: null,
  };
}

export function normalizeLayoutState(
  persistedState: unknown,
  currentState: LayoutState,
  domain: LayoutDomain,
): LayoutState {
  if (!isRecord(persistedState) || !isLayoutDomain(domain)) return currentState;

  const persistedTabs = Array.isArray(persistedState.tabs) ? persistedState.tabs as LegacyTab[] : [];
  const tabs: Tab[] = [];
  const seenTabIds = new Set<string>();

  persistedTabs.forEach((item) => {
    if (
      !isRecord(item)
      || typeof item.id !== "string"
      || item.id.length === 0
      || seenTabIds.has(item.id)
      || !isLayoutTabType(item.type)
      || !isTabAllowedInDomain(domain, item.type as LayoutTabType)
      || (item.agentId !== null && typeof item.agentId !== "string")
      || typeof item.closable !== "boolean"
    ) {
      return;
    }

    seenTabIds.add(item.id);
    tabs.push({
      id: item.id,
      type: item.type,
      agentId: item.agentId ?? null,
      closable: item.closable,
      ...(typeof item.paneId === "string" ? { paneId: item.paneId } : {}),
      ...(typeof item.visualGroupId === "string"
        ? { visualGroupId: item.visualGroupId }
        : typeof item.groupId === "string"
          ? { visualGroupId: item.groupId }
          : {}),
      ...(item.groupColor !== undefined && tabGroupColors.includes(item.groupColor as NonNullable<Tab["groupColor"]>)
        ? { groupColor: item.groupColor as Tab["groupColor"] }
        : {}),
    });
  });

  const persistedPanes = Array.isArray(persistedState.panes) ? persistedState.panes : [];
  let panes = persistedPanes.filter(isPane).map((pane) => ({
    ...pane,
    tabOrder: [...new Set(pane.tabOrder)].filter((tabId) => seenTabIds.has(tabId)),
  }));

  if (panes.length === 0 && tabs.length > 0) {
    panes = [{
      ...createRecoveredPane(0),
      tabOrder: tabs.map((tab) => tab.id),
      activeTabId: tabs[tabs.length - 1]?.id ?? null,
    }];
  }

  const tabIds = new Set(tabs.map((tab) => tab.id));
  panes = panes
    .map((pane, index) => ({
      ...pane,
      id: pane.id || `recovered-pane-${index + 1}`,
      activeTabId: pane.activeTabId && tabIds.has(pane.activeTabId) ? pane.activeTabId : pane.tabOrder.at(-1) ?? null,
    }))
    .filter((pane) => pane.tabOrder.length > 0);

  const placedTabIds = new Set(panes.flatMap((pane) => pane.tabOrder));
  const unplacedTabs = tabs.filter((tab) => !placedTabIds.has(tab.id));
  if (unplacedTabs.length > 0) {
    if (panes.length === 0) panes = [createRecoveredPane(0)];
    const lastPane = panes[panes.length - 1];
    lastPane.tabOrder.push(...unplacedTabs.map((tab) => tab.id));
    lastPane.activeTabId ??= unplacedTabs.at(-1)?.id ?? null;
  }

  const paneByTabId = new Map<string, string>();
  panes.forEach((pane) => {
    pane.tabOrder.forEach((tabId) => paneByTabId.set(tabId, pane.id));
  });
  const normalizedTabs = tabs.map((tab) => ({ ...tab, paneId: paneByTabId.get(tab.id) }));

  const persistedActiveTabId = persistedState.activeTabId;
  const activeTabId = typeof persistedActiveTabId === "string" && tabIds.has(persistedActiveTabId)
    ? persistedActiveTabId
    : tabs.at(-1)?.id ?? null;
  const persistedActivePaneId = persistedState.activePaneId;
  const activePane = typeof persistedActivePaneId === "string"
    ? panes.find((pane) => pane.id === persistedActivePaneId)
    : undefined;
  const resolvedActivePaneId = activePane?.id ?? panes.find((pane) => pane.activeTabId === activeTabId)?.id ?? panes[0]?.id ?? null;

  const persistedLayout = persistedState.paneLayout;
  const paneLayout = Array.isArray(persistedLayout) || isRecord(persistedLayout)
    ? buildBalancedPaneLayout(panes.map((pane) => pane.id))
    : buildBalancedPaneLayout(panes.map((pane) => pane.id));

  const persistedDockviewLayout = persistedState.dockviewLayout;
  const dockviewLayout = isRecord(persistedDockviewLayout)
    && isRecord(persistedDockviewLayout.grid)
    && isRecord(persistedDockviewLayout.panels)
    ? persistedDockviewLayout
    : null;

  return {
    ...currentState,
    tabs: normalizedTabs,
    panes,
    activeTabId,
    activePaneId: resolvedActivePaneId,
    paneLayout,
    dockviewLayout,
  };
}
