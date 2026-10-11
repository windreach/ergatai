import { create } from "zustand";
import { persist } from "zustand/middleware";

import { createLayoutStore } from "@/core/layout/store";
import type { UseLayoutStore } from "@/core/layout/store";
import type { LayoutDomain } from "@/core/layout/model";

export interface WorkspaceRuntimeTab {
  id: string;
  title: string;
  createdAt: number;
}

interface RuntimeState {
  workspaces: WorkspaceRuntimeTab[];
  activeWorkspaceId: string | null;
}

interface RuntimeActions {
  createWorkspace: () => string;
  closeWorkspace: (id: string) => boolean;
  activateWorkspace: (id: string) => void;
  renameWorkspace: (id: string, title: string) => void;
}

export type RuntimeStore = RuntimeState & RuntimeActions;

function createId(prefix: string) {
  const uniqueId = typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  return `${prefix}-${uniqueId}`;
}

function isWorkspace(value: unknown): value is WorkspaceRuntimeTab {
  if (typeof value !== "object" || value === null) return false;
  const workspace = value as Record<string, unknown>;
  return typeof workspace.id === "string"
    && workspace.id.length > 0
    && typeof workspace.title === "string"
    && typeof workspace.createdAt === "number"
    && Number.isFinite(workspace.createdAt);
}

function normalizeRuntimeState(persisted: unknown, current: RuntimeState): RuntimeState {
  if (typeof persisted !== "object" || persisted === null) return current;
  const value = persisted as Record<string, unknown>;
  const workspaces = Array.isArray(value.workspaces) ? value.workspaces.filter(isWorkspace) : [];
  const activeWorkspaceId = typeof value.activeWorkspaceId === "string"
    && workspaces.some((workspace) => workspace.id === value.activeWorkspaceId)
    ? value.activeWorkspaceId
    : workspaces[0]?.id ?? null;
  return { workspaces, activeWorkspaceId };
}

export const useRuntimeWorkspaceStore = create<RuntimeStore>()(persist((set, get) => ({
  workspaces: [],
  activeWorkspaceId: null,

  createWorkspace: () => {
    const workspace: WorkspaceRuntimeTab = {
      id: createId("ws"),
      title: "",
      createdAt: Date.now(),
    };
    set((state) => ({
      workspaces: [...state.workspaces, workspace],
      activeWorkspaceId: workspace.id,
    }));
    return workspace.id;
  },

  closeWorkspace: (id) =>
  {
    const state = get();
    if (state.workspaces.length <= 1) return false;
    const index = state.workspaces.findIndex((workspace) => workspace.id === id);
    if (index === -1) return false;
    const workspaces = state.workspaces.filter((workspace) => workspace.id !== id);
    const activeWorkspaceId = state.activeWorkspaceId === id
        ? workspaces[Math.min(index, workspaces.length - 1)].id
        : state.activeWorkspaceId;
    set({ workspaces, activeWorkspaceId });
    return true;
  },

  activateWorkspace: (id) =>
    set((state) => (state.workspaces.some((workspace) => workspace.id === id)
      ? { ...state, activeWorkspaceId: id }
      : state)),

  renameWorkspace: (id, title) =>
    set((state) => ({
      workspaces: state.workspaces.map((workspace) => (workspace.id === id
        ? { ...workspace, title: title.trim() || workspace.title }
        : workspace)),
    })),
}), {
  name: "ergatai.runtime.workspaces",
  version: 1,
  partialize: (state) => ({
    workspaces: state.workspaces,
    activeWorkspaceId: state.activeWorkspaceId,
  }),
  merge: (persisted, current) => ({
    ...current,
    ...normalizeRuntimeState(persisted, current),
  }),
}));

type DomainStores = Record<LayoutDomain, UseLayoutStore>;
const domainStoreRegistry = new Map<string, DomainStores>();

export function getWorkspaceDomainStores(workspaceId: string): DomainStores {
  const existing = domainStoreRegistry.get(workspaceId);
  if (existing) return existing;

  const stores: DomainStores = {
    conversation: createLayoutStore({
      domain: "conversation",
      idPrefix: `${workspaceId}-conversation`,
      storageKey: `ergatai.workspace.${workspaceId}.conversation`,
    }),
    workspace: createLayoutStore({
      domain: "workspace",
      idPrefix: `${workspaceId}-workspace`,
      storageKey: `ergatai.workspace.${workspaceId}.workspace`,
    }),
  };
  domainStoreRegistry.set(workspaceId, stores);
  return stores;
}

export function removeWorkspaceDomainStores(workspaceId: string) {
  domainStoreRegistry.delete(workspaceId);
}
