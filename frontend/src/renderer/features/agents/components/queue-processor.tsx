"use client"

import { useEffect, useRef } from "react"
import { toast } from "sonner"
import { useMessageQueueStore } from "../stores/message-queue-store"
import { useStreamingStatusStore } from "../stores/streaming-status-store"
import { useAgentConversationStore } from "../stores/conversation-store"
import { agentChatStore } from "../stores/agent-chat-store"
import { trackMessageSent } from "../../../lib/analytics"
import { appStore } from "../../../lib/jotai-store"
import { loadingConversationsAtom, setLoading, clearLoading } from "../atoms"
import { MENTION_PREFIXES } from "../mentions/agents-mentions-editor"
import { utf8ToBase64 } from "../utils/base64"
import type { AgentQueueItem } from "../lib/queue-utils"

// Delay between processing queue items (ms)
const QUEUE_PROCESS_DELAY = 1000

/**
 * Global queue processor component.
 *
 * This component runs at the app level (AgentsLayout) and processes
 * message queues for ALL conversations, regardless of which one is currently active.
 *
 * Key insight: Unlike the previous local useEffect in ChatViewInner which only
 * processed the currently active conversation's queue, this component listens to
 * ALL queues and streaming statuses globally.
 */
export function QueueProcessor() {
  // Track which conversations are currently being processed to avoid double-sends
  const processingRef = useRef<Set<string>>(new Set())
  // Track timers for cleanup
  const timersRef = useRef<Map<string, NodeJS.Timeout>>(new Map())

  useEffect(() => {
    // Function to process queue for a specific conversation
    const processQueue = async (conversationId: string) => {
      // Check if already processing this conversation
      if (processingRef.current.has(conversationId)) {
        return
      }

      // Check streaming status
      const status = useStreamingStatusStore.getState().getStatus(conversationId)
      if (status !== "ready") {
        return
      }

      // Get queue for this conversation
      const queue = useMessageQueueStore.getState().queues[conversationId] || []
      if (queue.length === 0) {
        return
      }

      // Get the Chat object from agentChatStore
      const chat = agentChatStore.get(conversationId)
      if (!chat) {
        return
      }

      // Mark as processing
      processingRef.current.add(conversationId)

      // Pop the first item from queue (atomic operation)
      const item = useMessageQueueStore.getState().popItem(conversationId, queue[0].id)
      if (!item) {
        processingRef.current.delete(conversationId)
        return
      }

      try {
        // Build message parts from queued item
        const parts: any[] = [
          ...(item.images || []).map((img) => ({
            type: "data-image" as const,
            data: {
              url: img.url,
              mediaType: img.mediaType,
              filename: img.filename,
              base64Data: img.base64Data,
            },
          })),
          ...(item.files || []).map((f) => ({
            type: "data-file" as const,
            data: {
              url: f.url,
              mediaType: f.mediaType,
              filename: f.filename,
              size: f.size,
            },
          })),
        ]

        // Expand text contexts, diff text contexts, and pasted texts as mention tokens
        let mentionPrefix = ""

        if (item.textContexts && item.textContexts.length > 0) {
          const quoteMentions = item.textContexts.map((tc) => {
            const preview = tc.text.slice(0, 50).replace(/[:\[\]]/g, "")
            const encodedText = utf8ToBase64(tc.text)
            return `@[${MENTION_PREFIXES.QUOTE}${preview}:${encodedText}]`
          })
          mentionPrefix += quoteMentions.join(" ") + " "
        }

        if (item.diffTextContexts && item.diffTextContexts.length > 0) {
          const diffMentions = item.diffTextContexts.map((dtc) => {
            const preview = dtc.text.slice(0, 50).replace(/[:\[\]]/g, "")
            const encodedText = utf8ToBase64(dtc.text)
            const lineNum = dtc.lineNumber || 0
            return `@[${MENTION_PREFIXES.DIFF}${dtc.filePath}:${lineNum}:${preview}:${encodedText}]`
          })
          mentionPrefix += diffMentions.join(" ") + " "
        }

        if (item.pastedTexts && item.pastedTexts.length > 0) {
          const pastedMentions = item.pastedTexts.map((pt) => {
            const sanitizedPreview = pt.preview.replace(/[:\[\]|]/g, "")
            return `@[${MENTION_PREFIXES.PASTED}${pt.size}:${sanitizedPreview}|${pt.filePath}]`
          })
          mentionPrefix += pastedMentions.join(" ") + " "
        }

        if (item.message || mentionPrefix) {
          parts.push({ type: "text", text: mentionPrefix + (item.message || "") })
        }

        // Get mode from conversation store for analytics
        const conversationMeta = useAgentConversationStore
          .getState()
          .allConversations.find((sc) => sc.id === conversationId)
        const mode = conversationMeta?.mode || "agent"

        // Track message sent
        trackMessageSent({
          workspaceId: conversationId,
          messageLength: item.message.length,
          mode,
        })

        // Update timestamps
        useAgentConversationStore.getState().updateConversationTimestamp(conversationId)

        // Set loading state for sidebar indicator
        const parentChatId = agentChatStore.getParentChatId(conversationId)
        if (parentChatId) {
          setLoading(
            (fn) => appStore.set(loadingConversationsAtom, fn(appStore.get(loadingConversationsAtom))),
            conversationId,
            parentChatId
          )
        }

        // Signal active-chat to scroll to bottom BEFORE sending so that
        // shouldAutoScrollRef is true for the entire streaming duration.
        // (sendMessage awaits the full stream, so placing this after would
        // only scroll after the response is complete.)
        useMessageQueueStore.getState().triggerQueueSent(conversationId)

        // Send message using Chat's sendMessage method
        await chat.sendMessage({ role: "user", parts })

      } catch (error) {
        console.error(`[QueueProcessor] Error processing queue:`, error)

        // Requeue the item at the front so it can be retried
        useMessageQueueStore.getState().prependItem(conversationId, item)

        // Set error status (will be cleared on next successful send or manual retry)
        useStreamingStatusStore.getState().setStatus(conversationId, "error")

        // Clear loading state since send failed
        clearLoading(
          (fn) => appStore.set(loadingConversationsAtom, fn(appStore.get(loadingConversationsAtom))),
          conversationId
        )

        // Notify user
        toast.error("Failed to send queued message. It will be retried.")
      } finally {
        processingRef.current.delete(conversationId)
        // Re-kick after releasing lock to avoid lost wakeups
        setTimeout(checkAllQueues, 0)
      }
    }

    // Schedule processing for a conversation with delay
    const scheduleProcessing = (conversationId: string) => {
      // Clear any existing timer for this conversation
      const existingTimer = timersRef.current.get(conversationId)
      if (existingTimer) {
        clearTimeout(existingTimer)
      }

      // Schedule new processing
      const timer = setTimeout(() => {
        timersRef.current.delete(conversationId)
        processQueue(conversationId)
      }, QUEUE_PROCESS_DELAY)

      timersRef.current.set(conversationId, timer)
    }

    // Check all queues and schedule processing for ready conversations
    function checkAllQueues() {
      const queues = useMessageQueueStore.getState().queues

      for (const conversationId of Object.keys(queues)) {
        const queue = queues[conversationId]
        if (!queue || queue.length === 0) continue

        const status = useStreamingStatusStore.getState().getStatus(conversationId)

        // Process when ready, or retry on error status
        if ((status === "ready" || status === "error") && !processingRef.current.has(conversationId)) {
          // If error status, clear it before retrying
          if (status === "error") {
            useStreamingStatusStore.getState().setStatus(conversationId, "ready")
          }
          scheduleProcessing(conversationId)
        }
      }
    }

    // Subscribe to queue changes with selector (requires subscribeWithSelector middleware)
    const unsubscribeQueue = useMessageQueueStore.subscribe(
      (state) => state.queues,
      () => checkAllQueues()
    )

    // Subscribe to streaming status changes with selector
    const unsubscribeStatus = useStreamingStatusStore.subscribe(
      (state) => state.statuses,
      () => checkAllQueues()
    )

    // Initial check
    checkAllQueues()

    // Cleanup
    return () => {
      unsubscribeQueue()
      unsubscribeStatus()

      // Clear all timers
      for (const timer of timersRef.current.values()) {
        clearTimeout(timer)
      }
      timersRef.current.clear()
    }
  }, [])

  // This component doesn't render anything
  return null
}
