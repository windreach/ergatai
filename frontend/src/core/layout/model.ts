export type LayoutDomain = "conversation" | "workspace";

export const layoutDomains: LayoutDomain[] = ["conversation", "workspace"];

export type LayoutTabType = "chat" | "terminal" | "browser" | "files" | "review";

export const layoutTabTypes: LayoutTabType[] = [
  "chat",
  "terminal",
  "browser",
  "files",
  "review",
];

export const domainTabTypes: Record<LayoutDomain, LayoutTabType[]> = {
  conversation: ["chat"],
  workspace: ["terminal", "browser", "files", "review"],
};

export type TabGroupColor = "blue" | "purple";

export const tabGroupColors: TabGroupColor[] = ["blue", "purple"];

export type PaneSplitDirection = "horizontal" | "vertical";

export const paneSplitDirections: PaneSplitDirection[] = ["horizontal", "vertical"];

export type PaneNode =
  | { kind: "pane"; id: string }
  | {
    kind: "split";
    id: string;
    direction: PaneSplitDirection;
    ratio?: number;
    children: [PaneNode, PaneNode];
  };

export interface Pane {
  id: string;
  tabOrder: string[];
  activeTabId: string | null;
}

export interface Tab {
  id: string;
  type: LayoutTabType;
  agentId: string | null;
  closable: boolean;
  paneId?: string;
  visualGroupId?: string;
  groupColor?: TabGroupColor;
}

export interface LayoutState {
  domain: LayoutDomain;
  tabs: Tab[];
  panes: Pane[];
  activeTabId: string | null;
  activePaneId: string | null;
  paneLayout: PaneNode | null;
  dockviewLayout: unknown;
}

export function isLayoutDomain(value: unknown): value is LayoutDomain {
  return typeof value === "string" && layoutDomains.includes(value as LayoutDomain);
}

export function isLayoutTabType(value: unknown): value is LayoutTabType {
  return typeof value === "string" && layoutTabTypes.includes(value as LayoutTabType);
}

export function isTabAllowedInDomain(domain: LayoutDomain, type: LayoutTabType): boolean {
  return domainTabTypes[domain].includes(type);
}

export function paneIdsInLayout(layout: PaneNode | null): string[] {
  if (!layout) return [];
  if (layout.kind === "pane") return [layout.id];
  return [...paneIdsInLayout(layout.children[0]), ...paneIdsInLayout(layout.children[1])];
}

export function replacePaneInLayout(
  layout: PaneNode | null,
  paneId: string,
  replacement: PaneNode,
): PaneNode | null {
  if (!layout) return null;
  if (layout.kind === "pane") {
    return layout.id === paneId ? replacement : layout;
  }
  return {
    ...layout,
    children: [
      replacePaneInLayout(layout.children[0], paneId, replacement) as PaneNode,
      replacePaneInLayout(layout.children[1], paneId, replacement) as PaneNode,
    ],
  };
}

export function updatePaneRatio(
  layout: PaneNode | null,
  splitId: string,
  ratio: number,
): PaneNode | null {
  if (!layout || layout.kind === "pane") return layout;
  if (layout.id === splitId) return { ...layout, ratio };
  return {
    ...layout,
    children: [
      updatePaneRatio(layout.children[0], splitId, ratio) as PaneNode,
      updatePaneRatio(layout.children[1], splitId, ratio) as PaneNode,
    ],
  };
}

export function removePaneFromLayout(layout: PaneNode | null, paneId: string): PaneNode | null {
  if (!layout) return null;
  if (layout.kind === "pane") {
    return layout.id === paneId ? null : layout;
  }
  const first = removePaneFromLayout(layout.children[0], paneId);
  const second = removePaneFromLayout(layout.children[1], paneId);
  if (!first) return second;
  if (!second) return first;
  return { ...layout, children: [first, second] };
}
