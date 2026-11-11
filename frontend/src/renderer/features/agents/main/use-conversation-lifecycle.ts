"use client"

import { useEffect } from "react"
import { useAgentConversationStore } from "../stores/conversation-store"
import { useStreamingStatusStore } from "../stores/streaming-status-store"
import { useMessageQueueStore } from "../stores/message-queue-store"
import { clearRuntimeCachesForConversation } from "./active-chat-helpers"

const mountedChatViewInnerCounts = new Map<string, number>()
const pendingConversationCleanupTimers = new Map<string, ReturnType<typeof setTimeout>>()

/**
 * Shared lifecycle helper for a conversation pane.
 *
 * Tracks how many panes are mounted for a conversation and, when the last one
 * unmounts, schedules a deferred cleanup of runtime caches (unless the
 * conversation is still active, streaming, or has queued messages).
 *
 * Extracted so both main and side conversations share one implementation
 * instead of duplicating the mount-count / cleanup-timer logic.
 */
export function useConversationLifecycle(conversationId: string) {
  useEffect(() => {
    const prevCount = mountedChatViewInnerCounts.get(conversationId) ?? 0
    const nextCount = prevCount + 1
    mountedChatViewInnerCounts.set(conversationId, nextCount)

    const pendingCleanup = pendingConversationCleanupTimers.get(conversationId)
    if (pendingCleanup) {
      clearTimeout(pendingCleanup)
      pendingConversationCleanupTimers.delete(conversationId)
    }

    return () => {
      const currentCount = mountedChatViewInnerCounts.get(conversationId) ?? 0
      const remainingCount = Math.max(0, currentCount - 1)
      if (remainingCount === 0) {
        mountedChatViewInnerCounts.delete(conversationId)
      } else {
        mountedChatViewInnerCounts.set(conversationId, remainingCount)
      }

      if (remainingCount > 0) {
        return
      }

      const existingTimeoutId = pendingConversationCleanupTimers.get(conversationId)
      if (existingTimeoutId) {
        clearTimeout(existingTimeoutId)
      }

      const timeoutId = setTimeout(() => {
        pendingConversationCleanupTimers.delete(conversationId)
        const mountedCountNow = mountedChatViewInnerCounts.get(conversationId) ?? 0

        if (mountedCountNow > 0) {
          return
        }

        const currentConversationState = useAgentConversationStore.getState()
        if (currentConversationState.activeConversationId === conversationId) return
        if (useStreamingStatusStore.getState().isStreaming(conversationId)) return
        if ((useMessageQueueStore.getState().queues[conversationId]?.length ?? 0) > 0) return

        clearRuntimeCachesForConversation(conversationId)
      }, 100)

      pendingConversationCleanupTimers.set(conversationId, timeoutId)
    }
  }, [conversationId])
}