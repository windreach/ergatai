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
  // Clear all statuses (call on app reset/logout to prevent unbounded growth)
  clearAllStatuses: () => void
}

export const useStreamingStatusStore = create<StreamingStatusState>()(
  subscribeWithSelector((set, get) => ({
    statuses: {},

    setStatus: (conversationId, status) => {
      if (status === "ready") {
        // Ready is the default state, no need to track explicitly
        set((state) => {
          const { [conversationId]: _, ...rest } = state.statuses
          return { statuses: rest }
        })
      } else {
        set((state) => ({
          statuses: { ...state.statuses, [conversationId]: status },
        }))
      }
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

    // Clear all statuses to prevent unbounded memory growth in long-running sessions
    clearAllStatuses: () => {
      set({ statuses: {} })
    },
  }))
)
