import { create } from "zustand";

export type WorkspaceMode = "group" | "agent";
export type WorkspaceView = "conversation" | "task-kanban" | "dag" | "empty";

interface WorkspaceState {
  mode: WorkspaceMode;
  activeView: WorkspaceView;
  selectedTaskId: string | null;
  selectedConversationId: string | null;
  searchQuery: string;

  setMode: (mode: WorkspaceMode) => void;
  setView: (view: WorkspaceView) => void;
  setSearchQuery: (searchQuery: string) => void;
  openConversation: (mode: WorkspaceMode, conversationId: string) => void;
  openTask: (taskId: string, view?: "task-kanban" | "dag") => void;
}

export const useWorkspaceStore = create<WorkspaceState>((set) => ({
  mode: "group",
  activeView: "conversation",
  selectedTaskId: null,
  selectedConversationId: null,
  searchQuery: "",

  setMode: (mode) => set({ mode }),

  setView: (activeView) => set({ activeView }),

  setSearchQuery: (searchQuery) => set({ searchQuery }),

  openConversation: (mode, conversationId) =>
    set({
      mode,
      activeView: "conversation",
      selectedConversationId: conversationId,
      selectedTaskId: null,
    }),

  openTask: (selectedTaskId, view = "task-kanban") =>
    set({ activeView: view, selectedTaskId }),
}));
