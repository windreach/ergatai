import { create } from "zustand";
import { persist } from "zustand/middleware";

export type ToolPanelType = "terminal" | "browser" | "files" | "review" | "sideChat";

export interface ToolPanelTab {
  id: string;
  type: ToolPanelType;
}

interface ToolPanelState {
  tabs: ToolPanelTab[];
  activeTabId: string | null;
}

interface ToolPanelActions {
  createPanel: (type: ToolPanelType) => string;
  closePanel: (id: string) => void;
  activatePanel: (id: string) => void;
}

export type ToolPanelStore = ToolPanelState & ToolPanelActions;

const singleInstanceTypes = new Set<ToolPanelType>(["files", "review", "sideChat"]);

function createId(prefix: string) {
  const uniqueId = typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  return `${prefix}-${uniqueId}`;
}

function isToolPanelType(value: unknown): value is ToolPanelType {
  return value === "terminal"
    || value === "browser"
    || value === "files"
    || value === "review"
    || value === "sideChat";
}

function isToolPanelTab(value: unknown): value is ToolPanelTab {
  if (typeof value !== "object" || value === null) return false;
  const tab = value as Record<string, unknown>;
  return typeof tab.id === "string"
    && tab.id.length > 0
    && isToolPanelType(tab.type);
}

function normalizeState(persisted: unknown, current: ToolPanelState): ToolPanelState {
  if (typeof persisted !== "object" || persisted === null) return current;
  const value = persisted as Record<string, unknown>;
  const tabs = Array.isArray(value.tabs) ? value.tabs.filter(isToolPanelTab) : [];
  const activeTabId = typeof value.activeTabId === "string"
    && tabs.some((tab) => tab.id === value.activeTabId)
    ? value.activeTabId
    : tabs[0]?.id ?? null;
  return { tabs, activeTabId };
}

export const useToolPanelStore = create<ToolPanelStore>()(persist((set, get) => ({
  tabs: [],
  activeTabId: null,

  createPanel: (type) => {
    if (singleInstanceTypes.has(type)) {
      const existing = get().tabs.find((tab) => tab.type === type);
      if (existing) {
        get().activatePanel(existing.id);
        return existing.id;
      }
    }

    const id = createId("tool");
    set((state) => ({
      tabs: [...state.tabs, { id, type }],
      activeTabId: id,
    }));
    return id;
  },

  closePanel: (id) =>
    set((state) => {
      const index = state.tabs.findIndex((tab) => tab.id === id);
      if (index === -1) return state;
      const tabs = state.tabs.filter((tab) => tab.id !== id);
      const activeTabId = state.activeTabId === id
        ? tabs[Math.min(index, tabs.length - 1)]?.id ?? null
        : state.activeTabId;
      return { tabs, activeTabId };
    }),

  activatePanel: (id) =>
    set((state) => (state.tabs.some((tab) => tab.id === id)
      ? { ...state, activeTabId: id }
      : state)),
}), {
  name: "ergatai.tool-panels",
  version: 1,
  partialize: (state) => ({
    tabs: state.tabs,
    activeTabId: state.activeTabId,
  }),
  merge: (persisted, current) => ({
    ...current,
    ...normalizeState(persisted, current),
  }),
}));
