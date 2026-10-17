import { create } from "zustand"
import { subscribeWithSelector } from "zustand/middleware"

export type StreamingStatus = "ready" | "streaming" | "submitted" | "error"

interface StreamingStatusState {
  // Map: conversationId -> streaming status
  statuses: Record<string, StreamingStatus>

  // Actions
  setStatus: (conversationId: string, status: StreamingStatus) => void
  getStatus: (conversationId: string) => StreamingStatus
  isStreaming: (conversationId: string) => boolean
  clearStatus: (conversationId: string) => void

  // Get all conversations that are ready (not streaming)
  getReadyConversations: () => string[]
}

export const useStreamingStatusStore = create<StreamingStatusState>()(
  subscribeWithSelector((set, get) => ({
    statuses: {},

    setStatus: (conversationId, status) => {
      set((state) => ({
        statuses: {
          ...state.statuses,
          [conversationId]: status,
        },
      }))
    },

    getStatus: (conversationId) => {
      return get().statuses[conversationId] ?? "ready"
    },

    isStreaming: (conversationId) => {
      const status = get().statuses[conversationId] ?? "ready"
      return status === "streaming" || status === "submitted"
    },

    clearStatus: (conversationId) => {
      set((state) => {
        const newStatuses = { ...state.statuses }
        delete newStatuses[conversationId]
        return { statuses: newStatuses }
      })
    },

    getReadyConversations: () => {
      const { statuses } = get()
      return Object.entries(statuses)
        .filter(([_, status]) => status === "ready")
        .map(([conversationId]) => conversationId)
    },
  }))
)
