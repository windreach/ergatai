import { create } from "zustand"
import { subscribeWithSelector } from "zustand/middleware"
import type { AgentQueueItem } from "../lib/queue-utils"
import { removeQueueItem } from "../lib/queue-utils"

// Empty array constant to avoid creating new arrays on each call
// Exported for use in selectors to maintain stable reference
export const EMPTY_QUEUE: AgentQueueItem[] = []

interface MessageQueueState {
  // Map: conversationId -> queue items
  queues: Record<string, AgentQueueItem[]>

  // Map: conversationId -> counter incremented each time QueueProcessor auto-sends a message.
  // Used by active-chat to trigger scroll-to-bottom when a queued message is sent.
  queueSentTriggers: Record<string, number>

  // Actions
  addToQueue: (conversationId: string, item: AgentQueueItem) => void
  removeFromQueue: (conversationId: string, itemId: string) => void
  getQueue: (conversationId: string) => AgentQueueItem[]
  getNextItem: (conversationId: string) => AgentQueueItem | null
  clearQueue: (conversationId: string) => void
  // Returns and removes the item from queue (atomic operation)
  popItem: (conversationId: string, itemId: string) => AgentQueueItem | null
  // Add item to front of queue (for error recovery)
  prependItem: (conversationId: string, item: AgentQueueItem) => void
  // Signal that a queued message was auto-sent (for scroll triggering)
  triggerQueueSent: (conversationId: string) => void
  // Remove all state for a conversation (call on conversation close/delete to prevent unbounded growth)
  removeConversation: (conversationId: string) => void
}

export const useMessageQueueStore = create<MessageQueueState>()(
  subscribeWithSelector((set, get) => ({
    queues: {},
    queueSentTriggers: {},

  addToQueue: (conversationId, item) => {
    set((state) => ({
      queues: {
        ...state.queues,
        [conversationId]: [...(state.queues[conversationId] || []), item],
      },
    }))
  },

  removeFromQueue: (conversationId, itemId) => {
    set((state) => {
      const currentQueue = state.queues[conversationId] || []
      return {
        queues: {
          ...state.queues,
          [conversationId]: removeQueueItem(currentQueue, itemId),
        },
      }
    })
  },

  getQueue: (conversationId) => {
    return get().queues[conversationId] ?? EMPTY_QUEUE
  },

  getNextItem: (conversationId) => {
    const queue = get().queues[conversationId] || []
    return queue.find((item) => item.status === "pending") || null
  },

  clearQueue: (conversationId) => {
    set((state) => ({
      queues: {
        ...state.queues,
        [conversationId]: [],
      },
    }))
  },

  // Atomic pop: find and remove in single set() call to prevent race conditions
  popItem: (conversationId, itemId) => {
    const currentQueue = get().queues[conversationId] || []
    const foundItem = currentQueue.find((i) => i.id === itemId) || null
    if (!foundItem) return null
    set({
      queues: {
        ...get().queues,
        [conversationId]: currentQueue.filter((i) => i.id !== itemId),
      },
    })
    return foundItem
  },

  // Add item to front of queue (used for error recovery - requeue failed items)
  prependItem: (conversationId, item) => {
    set((state) => ({
      queues: {
        ...state.queues,
        [conversationId]: [item, ...(state.queues[conversationId] || [])],
      },
    }))
  },

  triggerQueueSent: (conversationId) => {
    set((state) => ({
      queueSentTriggers: {
        ...state.queueSentTriggers,
        [conversationId]: (state.queueSentTriggers[conversationId] || 0) + 1,
      },
    }))
  },

  // Remove all state for a conversation to prevent unbounded memory growth
  // in long-running sessions with many conversations.
  removeConversation: (conversationId) => {
    set((state) => {
      const newQueues = { ...state.queues }
      const newSentTriggers = { ...state.queueSentTriggers }
      delete newQueues[conversationId]
      delete newSentTriggers[conversationId]
      return {
        queues: newQueues,
        queueSentTriggers: newSentTriggers,
      }
    })
  },
})))
