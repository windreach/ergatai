import { create } from "zustand";

export interface Session {
  id: string;
  agentName: string;
  agentType: string;
  lastActive: string;
  unread: number;
}

interface SessionState {
  sessions: Session[];
  activeSessionId: string | null;
  setActiveSession: (id: string) => void;
  addSession: (session: Omit<Session, "id" | "unread">) => void;
  updateSession: (id: string, updates: Partial<Session>) => void;
  markAsRead: (id: string) => void;
}

export const useSessionStore = create<SessionState>((set) => ({
  sessions: [
    // Mock data
    {
      id: "1",
      agentName: "Alice",
      agentType: "Claude",
      lastActive: "刚刚",
      unread: 0,
    },
    {
      id: "2",
      agentName: "Bob",
      agentType: "Codex",
      lastActive: "5 分钟前",
      unread: 1,
    },
  ],
  activeSessionId: null,

  setActiveSession: (id) => set({ activeSessionId: id }),

  addSession: (session) =>
    set((state) => ({
      sessions: [
        ...state.sessions,
        { ...session, id: Date.now().toString(), unread: 0 },
      ],
    })),

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
}));
