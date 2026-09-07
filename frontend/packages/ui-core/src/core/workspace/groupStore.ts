import { create } from "zustand";

export interface Group {
  id: string;
  name: string;
  memberCount: number;
  lastActive: string;
  unread: number;
}

interface GroupState {
  groups: Group[];
  activeGroupId: string | null;
  setActiveGroup: (id: string) => void;
  addGroup: (group: Omit<Group, "id" | "unread">) => void;
  updateGroup: (id: string, updates: Partial<Group>) => void;
  markAsRead: (id: string) => void;
}

export const useGroupStore = create<GroupState>((set) => ({
  groups: [
    // Mock data
    {
      id: "1",
      name: "Auth 修复群",
      memberCount: 3,
      lastActive: "刚刚",
      unread: 2,
    },
    {
      id: "2",
      name: "前端重构",
      memberCount: 4,
      lastActive: "2 小时前",
      unread: 0,
    },
  ],
  activeGroupId: null,

  setActiveGroup: (id) => set({ activeGroupId: id }),

  addGroup: (group) =>
    set((state) => ({
      groups: [
        ...state.groups,
        { ...group, id: Date.now().toString(), unread: 0 },
      ],
    })),

  updateGroup: (id, updates) =>
    set((state) => ({
      groups: state.groups.map((group) =>
        group.id === id ? { ...group, ...updates } : group
      ),
    })),

  markAsRead: (id) =>
    set((state) => ({
      groups: state.groups.map((group) =>
        group.id === id ? { ...group, unread: 0 } : group
      ),
    })),
}));
