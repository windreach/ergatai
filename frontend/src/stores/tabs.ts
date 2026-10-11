import type { LayoutTabType } from "@/core/layout/model";

export {
  domainTabTypes,
  isTabAllowedInDomain,
  layoutDomains,
  layoutTabTypes,
  paneSplitDirections,
  tabGroupColors,
  type LayoutDomain,
  type LayoutState,
  type LayoutTabType,
  type Pane,
  type PaneNode,
  type PaneSplitDirection,
  type Tab,
  type TabGroupColor,
} from "@/core/layout/model";
export type { LayoutStore, OpenTabOptions, UseLayoutStore } from "@/core/layout/store";

export type TabType = LayoutTabType;

export function tabTitleKey(type: TabType): string {
  return `tabs.${type}`;
}
