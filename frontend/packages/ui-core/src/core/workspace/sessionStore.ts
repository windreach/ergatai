import { create } from "zustand";

export interface AgentSession {
  id: string;
  agentName: string;
  agentType: string;
  preview: string;
  lastActive: string;
  unread: number;
}

interface AgentSessionState {
  sessions: AgentSession[];
  activeSessionId: string | null;
  setActiveSession: (id: string) => void;
  addSession: (session: Omit<AgentSession, "id" | "unread">) => string;
  updateSession: (id: string, updates: Partial<AgentSession>) => void;
  markAsRead: (id: string) => void;
  removeSession: (id: string) => void;
}

export const useAgentSessionStore = create<AgentSessionState>((set) => ({
  sessions: [
    // Mock data
    {
      id: "1",
      agentName: "Alice",
      agentType: "Claude",
      preview: "我已准备好继续分析上次的问题。",
      lastActive: "刚刚",
      unread: 0,
    },
    {
      id: "2",
      agentName: "Bob",
      agentType: "Codex",
      preview: "工作区已同步，可以发送任务。",
      lastActive: "5 分钟前",
      unread: 1,
    },
  ],
  activeSessionId: null,

  setActiveSession: (id) => set({ activeSessionId: id }),

  addSession: (session) => {
    const id = typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `session-${Date.now()}`;
    set((state) => ({
      sessions: [
        ...state.sessions,
        { ...session, id, unread: 0 },
      ],
    }));
    return id;
  },

  updateSession: (id, updates) =>
    set((state) => ({
      sessions: state.sessions.map((session) =>
        session.id === id ? { ...session, ...updates } : session
      ),
    })),

  markAsRead: (id) =>
    set((state) => ({
      sessions: state.sessions.map((session) =>
        session.id === id ? { ...session, unread: 0 } : session
      ),
    })),

  removeSession: (id) =>
    set((state) => {
      const sessions = state.sessions.filter((session) => session.id !== id);
      return {
        sessions,
        activeSessionId: state.activeSessionId === id ? sessions[0]?.id ?? null : state.activeSessionId,
      };
    }),
}));
