import { create } from "zustand";
import { persist } from "zustand/middleware";

import type { AgentTabStatus } from "../../components/workspace/AgentTab";

export type AgentTabId = string;
export type WorkspaceGroupId = string;

export interface AgentTab {
  id: AgentTabId;
  name: string;
  conversationId: string;
  createdAt: number;
  status: AgentTabStatus;
}

export interface WorkspaceGroup {
  id: WorkspaceGroupId;
  tabIds: AgentTabId[];
  colorIndex: number;
}

interface AgentTabState {
  tabs: AgentTab[];
  activeTabId: AgentTabId | null;
  groups: WorkspaceGroup[];
}

interface AgentTabActions {
  createTab: (name?: string) => AgentTabId;
  closeTab: (id: AgentTabId) => void;
  activateTab: (id: AgentTabId) => void;
  renameTab: (id: AgentTabId, name: string) => void;
  setAgentStatus: (id: AgentTabId, status: AgentTabStatus) => void;
  moveTabToGroup: (
    tabId: AgentTabId,
    targetTabId: AgentTabId,
    side: "before" | "after",
  ) => void;
  ensureActiveTab: () => void;
}

export type AgentTabStore = AgentTabState & AgentTabActions;

const groupColorCount = 6;

function createId(prefix: string) {
  const uniqueId = typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  return `${prefix}-${uniqueId}`;
}

function isAgentTab(value: unknown): value is AgentTab {
  if (typeof value !== "object" || value === null) return false;
  const tab = value as Record<string, unknown>;
  return typeof tab.id === "string"
    && tab.id.length > 0
    && typeof tab.name === "string"
    && typeof tab.conversationId === "string"
    && tab.conversationId.length > 0
    && typeof tab.createdAt === "number"
    && (tab.status === "active" || tab.status === "background" || tab.status === "hibernated");
}

function normalizeColorIndex(value: unknown) {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value % groupColorCount
    : 0;
}

function normalizeGroups(
  tabs: AgentTab[],
  persistedGroups: unknown,
): WorkspaceGroup[] {
  const groups: WorkspaceGroup[] = [];
  if (!Array.isArray(persistedGroups)) return groups;

  const validTabIds = new Set(tabs.map((tab) => tab.id));
  const groupedTabIds = new Set<AgentTabId>();

  for (const item of persistedGroups) {
    if (typeof item !== "object" || item === null) continue;
    const value = item as Record<string, unknown>;
    if (typeof value.id !== "string" || value.id.length === 0) continue;
    if (!Array.isArray(value.tabIds)) continue;

    const tabIds: AgentTabId[] = [];
    for (const tabId of value.tabIds) {
      if (
        typeof tabId !== "string"
        || tabId.length === 0
        || !validTabIds.has(tabId)
        || groupedTabIds.has(tabId)
      ) continue;

      groupedTabIds.add(tabId);
      tabIds.push(tabId);
    }

    if (tabIds.length < 2) continue;
    groups.push({
      id: value.id,
      tabIds,
      colorIndex: normalizeColorIndex(value.colorIndex),
    });
  }

  return groups;
}

function normalizeState(persisted: unknown, current: AgentTabState): AgentTabState {
  if (typeof persisted !== "object" || persisted === null) return current;
  const value = persisted as Record<string, unknown>;
  const tabs = Array.isArray(value.tabs) ? value.tabs.filter(isAgentTab) : [];
  const activeTabId = typeof value.activeTabId === "string"
    && tabs.some((tab) => tab.id === value.activeTabId)
    ? value.activeTabId
    : tabs[0]?.id ?? null;

  return {
    tabs,
    activeTabId,
    groups: normalizeGroups(tabs, value.groups),
  };
}

function withoutTab(groups: WorkspaceGroup[], tabId: AgentTabId) {
  return groups
    .map((group) => ({
      ...group,
      tabIds: group.tabIds.filter((id) => id !== tabId),
    }))
    .filter((group) => group.tabIds.length >= 2);
}

export const useAgentTabStore = create<AgentTabStore>()(persist((set, get) => ({
  tabs: [],
  activeTabId: null,
  groups: [],

  createTab: (name) => {
    const id = createId("agent");
    const tab: AgentTab = {
      id,
      name: name ?? "",
      conversationId: createId("conversation"),
      createdAt: Date.now(),
      status: "background",
    };

    set((state) => ({
      tabs: [...state.tabs, tab],
      activeTabId: id,
    }));
    return id;
  },

  closeTab: (id) =>
    set((state) => {
      const index = state.tabs.findIndex((tab) => tab.id === id);
      if (index === -1) return state;

      const sourceGroup = state.groups.find((group) => group.tabIds.includes(id));
      const tabs = state.tabs.filter((tab) => tab.id !== id);
      const groups = withoutTab(state.groups, id);
      const activeTabId = state.activeTabId === id
        ? sourceGroup?.tabIds.find((tabId) => tabId !== id)
          ?? tabs[Math.min(index, tabs.length - 1)]?.id
          ?? null
        : state.activeTabId;

      return { tabs, groups, activeTabId };
    }),

  activateTab: (id) =>
    set((state) => (
      state.tabs.some((tab) => tab.id === id)
        ? { ...state, activeTabId: id }
        : state
    )),

  renameTab: (id, name) =>
    set((state) => ({
      tabs: state.tabs.map((tab) => (
        tab.id === id ? { ...tab, name } : tab
      )),
    })),

  setAgentStatus: (id, status) =>
    set((state) => ({
      tabs: state.tabs.map((tab) => (
        tab.id === id ? { ...tab, status } : tab
      )),
    })),

  moveTabToGroup: (tabId, targetTabId, side) =>
    set((state) => {
      if (tabId === targetTabId) return state;
      if (!state.tabs.some((tab) => tab.id === tabId)) return state;
      if (!state.tabs.some((tab) => tab.id === targetTabId)) return state;

      const sourceGroup = state.groups.find((group) => group.tabIds.includes(tabId));
      const targetGroup = state.groups.find((group) => group.tabIds.includes(targetTabId));

      if (!targetGroup) {
        const groups = withoutTab(state.groups, tabId);
        const colorIndex = sourceGroup?.colorIndex ?? groups.length % groupColorCount;
        const tabIds = side === "before"
          ? [tabId, targetTabId]
          : [targetTabId, tabId];

        return {
          ...state,
          groups: [...groups, { id: createId("group"), tabIds, colorIndex }],
          activeTabId: tabId,
        };
      }

      const groups = sourceGroup?.id === targetGroup.id
        ? state.groups.map((group) => {
          if (group.id !== targetGroup.id) return group;

          const remainingTabIds = group.tabIds.filter((id) => id !== tabId);
          const targetIndex = remainingTabIds.indexOf(targetTabId);
          if (targetIndex === -1) return group;

          const insertIndex = side === "before" ? targetIndex : targetIndex + 1;
          const tabIds = [...remainingTabIds];
          tabIds.splice(insertIndex, 0, tabId);
          return { ...group, tabIds };
        })
        : withoutTab(state.groups, tabId).map((group) => {
          if (group.id !== targetGroup.id) return group;

          const targetIndex = group.tabIds.indexOf(targetTabId);
          const insertIndex = side === "before" ? targetIndex : targetIndex + 1;
          const tabIds = [...group.tabIds];
          tabIds.splice(insertIndex, 0, tabId);
          return { ...group, tabIds };
        });

      return { ...state, groups, activeTabId: tabId };
    }),

  ensureActiveTab: () => {
    if (get().tabs.length > 0) return;
    get().createTab();
  },
}), {
  name: "ergatai.agent-tabs",
  partialize: (state) => ({
    tabs: state.tabs,
    activeTabId: state.activeTabId,
    groups: state.groups,
  }),
  merge: (persisted, current) => ({
    ...current,
    ...normalizeState(persisted, current),
  }),
  version: 5,
  migrate: (persisted) => {
    const value = persisted as Record<string, unknown>;
    return {
      ...value,
      tabs: Array.isArray(value.tabs) ? value.tabs.filter(isAgentTab) : [],
      activeTabId: typeof value.activeTabId === "string" ? value.activeTabId : null,
      groups: [],
    };
  },
}));

// New stores for desktop layout
export { useTaskStore } from "./taskStore";
export type { Task, TaskStatus } from "./taskStore";

export { useGroupStore } from "./groupStore";
export type { Group } from "./groupStore";

export { useAgentSessionStore } from "./sessionStore";
export type { Session } from "./sessionStore";

