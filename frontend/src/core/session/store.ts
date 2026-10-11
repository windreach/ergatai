import { create } from "zustand";
import { persist } from "zustand/middleware";

export interface ConversationSession {
  id: string;
  title: string;
  createdAt: number;
}

interface SessionState {
  sessions: ConversationSession[];
  activeSessionId: string | null;
}

interface SessionActions {
  createSession: () => string;
  selectSession: (id: string) => void;
}

export type SessionStore = SessionState & SessionActions;

function createId(prefix: string) {
  const uniqueId = typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  return `${prefix}-${uniqueId}`;
}

function isSession(value: unknown): value is ConversationSession {
  if (typeof value !== "object" || value === null) return false;
  const session = value as Record<string, unknown>;
  return typeof session.id === "string"
    && session.id.length > 0
    && typeof session.title === "string"
    && typeof session.createdAt === "number";
}

function normalizeState(persisted: unknown, current: SessionState): SessionState {
  if (typeof persisted !== "object" || persisted === null) return current;
  const value = persisted as Record<string, unknown>;
  const sessions = Array.isArray(value.sessions) ? value.sessions.filter(isSession) : [];
  const activeSessionId = typeof value.activeSessionId === "string"
    && sessions.some((session) => session.id === value.activeSessionId)
    ? value.activeSessionId
    : sessions[0]?.id ?? null;
  return { sessions, activeSessionId };
}

export const useSessionStore = create<SessionStore>()(persist((set) => ({
  sessions: [],
  activeSessionId: null,

  createSession: () => {
    const session: ConversationSession = {
      id: createId("conversation"),
      title: "",
      createdAt: Date.now(),
    };
    set((state) => ({
      sessions: [...state.sessions, session],
      activeSessionId: session.id,
    }));
    return session.id;
  },

  selectSession: (id) =>
    set((state) => (state.sessions.some((session) => session.id === id)
      ? { ...state, activeSessionId: id }
      : state)),
}), {
  name: "ergatai.conversation-sessions",
  version: 1,
  partialize: (state) => ({
    sessions: state.sessions,
    activeSessionId: state.activeSessionId,
  }),
  merge: (persisted, current) => ({
    ...current,
    ...normalizeState(persisted, current),
  }),
}));
