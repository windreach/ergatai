import { create } from "zustand";

export interface Group {
  id: string;
  name: string;
  members: string[];
  memberCount: number;
  preview: string;
  lastActive: string;
  unread: number;
  muted?: boolean;
}

interface GroupState {
  groups: Group[];
  activeGroupId: string | null;
  setActiveGroup: (id: string) => void;
  addGroup: (group: Omit<Group, "id" | "unread">) => string;
  updateGroup: (id: string, updates: Partial<Group>) => void;
  markAsRead: (id: string) => void;
}

export const useGroupStore = create<GroupState>((set) => ({
  groups: [
    // Mock data
    {
      id: "1",
      name: "Auth 修复群",
      members: ["你", "Codex", "Claude"],
      memberCount: 3,
      preview: "Claude 请求确认写入 3 个文件",
      lastActive: "刚刚",
      unread: 2,
    },
    {
      id: "2",
      name: "前端重构",
      members: ["你", "Codex", "Claude", "Gemini"],
      memberCount: 4,
      preview: "组件目录结构已经整理完成",
      lastActive: "2 小时前",
      unread: 0,
    },
  ],
  activeGroupId: null,

  setActiveGroup: (id) => set({ activeGroupId: id }),

  addGroup: (group) => {
    const id = typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `group-${Date.now()}`;
    set((state) => ({
      groups: [
        ...state.groups,
        { ...group, id, unread: 0, muted: false },
      ],
    }));
    return id;
  },

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
