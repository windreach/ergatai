/**
 * useMainChatInvocation Hook
 *
 * Bridge hook for migrating main chat to use ConversationInvocationService.
 * This hook provides a compatibility layer between the existing Chat instance
 * and the new ConversationInvocationService.
 *
 * Phase 10: Progressive migration - uses new service for queue management,
 * while keeping existing Chat instance for message rendering and streaming.
 *
 * Phase 16: Fixed duplicate Chat instance issue and registered runtime adapter.
 * - Now accepts an existing chat instance instead of creating a new one
 * - Registers adapter to delegate message sending to existing Chat
 * - Only manages queue and session state via new service
 * - Does not create duplicate Chat/transport state
 */

import { useCallback, useEffect, useMemo } from "react"
import { useConversationInvocation, useSessionState } from "../../conversation/runtime/use-conversation-invocation"
import { getAdapterRegistry, type AdapterState } from "../../conversation/runtime/runtime-adapter"
import type { ConversationStatus } from "../../conversation/runtime/contracts"
import { MENTION_PREFIXES } from "../../mentions/types"
import { utf8ToBase64 } from "../utils/base64"
import type { ChatConversation } from "@/features/details-sidebar/lib/chat-contract-api"

/**
 * Chat instance API (subset of Chat interface we need).
 */
export interface ChatInstanceAPI {
  sendMessage?: (message: any & { interrupt?: boolean }) => void | Promise<void>
  stop?: () => void
  messages?: any[]
  status?: string
  queue?: any[]
}

/**
 * Main chat invocation hook.
 *
 * This hook bridges an existing Chat instance with the new
 * ConversationInvocationService, allowing progressive migration.
 *
 * @param options - Hook options including existing chat instance
 * @returns Combined API with session state and queue
 */
export function useMainChatInvocation({
  conversation,
  chatId,
  agentId,
  isActive = true,
  existingChat,
}: {
  conversation: ChatConversation & { messages?: any[] }
  chatId: string
  agentId?: string | null
  isActive?: boolean
  /** Existing Chat instance to avoid creating duplicate */
  existingChat?: ChatInstanceAPI
}) {
  const backendConversationId = conversation.backendConversationId
  const runtimeConversationId = backendConversationId ?? conversation.id

  // Use new invocation service for queue management
  const invocation = useConversationInvocation()

  // Get session state from new service
  const sessionState = useSessionState(runtimeConversationId)

  // Phase 16: Register runtime adapter that delegates to existing Chat instance
  // This allows the service to leverage AI SDK's stream handling
  // Phase 18: Added subscribe() to synchronize adapter state with service
  useEffect(() => {
    if (!existingChat) return

    // Map Chat status to ConversationStatus
    const mapChatStatus = (chatStatus?: string): ConversationStatus => {
      switch (chatStatus) {
        case "submitted":
        case "streaming":
          return "streaming"
        case "ready":
          return "ready"
        case "error":
          return "error"
        case "loading":
          return "loading"
        default:
          return "idle"
      }
    }

    const adapter = {
      sendMessage: async ({ role, parts, interrupt, correlationId }: { role: "user" | "agent"; parts: any[]; interrupt?: boolean; correlationId?: string }) => {
        // Delegate to existing Chat instance
        // Phase 19: Pass interrupt flag and correlationId via message metadata
        if (existingChat.sendMessage) {
          await existingChat.sendMessage({
            role: "user",
            parts,
            // Pass interrupt and correlationId via metadata so transport can extract them
            metadata: {
              interrupt: interrupt ?? false,
              correlationId: correlationId,
            }
          })
        }
      },
      stop: async () => {
        // Delegate to existing Chat instance
        if (existingChat.stop) {
          existingChat.stop()
        }
      },
      subscribe: (listener: (state: AdapterState) => void) => {
        // Synchronize Chat status with service state
        // This is called when adapter state changes
        const syncState = () => {
          const status = mapChatStatus(existingChat.status)
          const streamingMessage = existingChat.messages?.findLast(
            (m: any) => m.isStreaming || m.role === "assistant"
          )

          listener({
            status,
            isStreaming: status === "streaming",
            streamingMessageId: streamingMessage?.id ?? null,
          })
        }

        // Initial sync
        syncState()

        // Poll for status changes (Chat doesn't provide event-based updates)
        // TODO: Replace with event-based subscription when Chat API supports it
        // Increased interval to 500ms to reduce CPU usage with many conversations
        const intervalId = setInterval(syncState, 500)

        return () => clearInterval(intervalId)
      },
    }

    // Register adapter for this conversation
    return getAdapterRegistry().register(runtimeConversationId, adapter)
  }, [runtimeConversationId, existingChat])

  // Wrap send handler - use service for sending
  // Phase 16: Now uses invocation.send() which goes through service -> adapter -> Chat
  const handleSend = useCallback(
    async (parts: any) => {
      try {
        await invocation.send({
          conversation: {
            chatId,
            conversationId: runtimeConversationId,
            backendConversationId: conversation.backendConversationId,
            agentId,
            source: "main",
          },
          role: "user",
          parts,
        })
      } catch (error) {
        console.error("[useMainChatInvocation] Failed to send message:", error)
        throw error
      }
    },
    [invocation, chatId, runtimeConversationId, conversation.backendConversationId, agentId],
  )

  // Wrap send from queue to use new service
  const handleSendFromQueue = useCallback(
    async (itemId: string) => {
      try {
        await invocation.sendQueuedItem(runtimeConversationId, itemId)
      } catch (error) {
        console.error("[useMainChatInvocation] Failed to send queued item:", error)
        throw error
      }
    },
    [invocation, runtimeConversationId],
  )

  // Phase 17: Service-based send function for useMessageSending
  // This unifies the queue system - all sends go through service
  const serviceSend = useCallback(
    async (parts: any[]) => {
      await invocation.send({
        conversation: {
          chatId,
          conversationId: runtimeConversationId,
          backendConversationId: conversation.backendConversationId,
          agentId,
          source: "main",
        },
        role: "user",
        parts,
      })
    },
    [invocation, chatId, runtimeConversationId, conversation.backendConversationId, agentId],
  )

  // Phase 17: Service-based enqueue function for useMessageSending
  // This unifies the queue system - all queue operations go through service
  const serviceEnqueue = useCallback(
    async (item: any) => {
      // Convert AgentQueueItem to ConversationSendMessageInput
      // Build parts from queue item (images, files, textContexts, etc.)
      const parts: any[] = []

      // Add images
      if (item.images && item.images.length > 0) {
        for (const img of item.images) {
          parts.push({
            type: "data-image",
            data: {
              url: img.url,
              mediaType: img.mediaType,
              filename: img.filename,
              base64Data: img.base64Data,
            },
          })
        }
      }

      // Add files
      if (item.files && item.files.length > 0) {
        for (const f of item.files) {
          parts.push({
            type: "data-file",
            data: {
              url: f.url,
              mediaType: f.mediaType,
              filename: f.filename,
              size: f.size,
            },
          })
        }
      }

      // Add text contexts as mention tokens (same logic as handleSendFromQueue)
      let mentionPrefix = ""

      // Convert textContexts to mention tokens
      if (item.textContexts && item.textContexts.length > 0) {
        const quoteMentions = item.textContexts.map((tc: any) => {
          const text = tc.text || "" // defensive default
          const preview = (tc.preview || text.slice(0, 50)).replace(/[:\[\]]/g, "")
          const encodedText = utf8ToBase64(text)
          return `@[${MENTION_PREFIXES.QUOTE}${preview}:${encodedText}]`
        })
        mentionPrefix += quoteMentions.join(" ") + " "
      }

      // Convert diffTextContexts to mention tokens
      if (item.diffTextContexts && item.diffTextContexts.length > 0) {
        const diffMentions = item.diffTextContexts.map((dtc: any) => {
          const text = dtc.text || "" // defensive default
          const preview = (dtc.preview || text.slice(0, 50)).replace(/[:\[\]]/g, "")
          const encodedText = utf8ToBase64(text)
          const lineNum = dtc.lineNumber || 0
          return `@[${MENTION_PREFIXES.DIFF}${dtc.filePath}:${lineNum}:${preview}:${encodedText}]`
        })
        mentionPrefix += diffMentions.join(" ") + " "
      }

      // Convert pastedTexts to mention tokens
      if (item.pastedTexts && item.pastedTexts.length > 0) {
        const pastedMentions = item.pastedTexts.map((pt: any) => {
          const preview = pt.preview || "" // defensive default
          const sanitizedPreview = preview.replace(/[:\[\]|]/g, "")
          const prefix = pt.kind === "chatHistory" ? MENTION_PREFIXES.CHAT_HISTORY : MENTION_PREFIXES.PASTED
          return `@[${prefix}${pt.size}:${sanitizedPreview}|${pt.filePath}]`
        })
        mentionPrefix += pastedMentions.join(" ") + " "
      }

      // Add text (message with mention prefix if any)
      if (item.message || mentionPrefix) {
        parts.push({ type: "text", text: mentionPrefix + (item.message || "") })
      }

      await invocation.enqueue({
        conversation: {
          chatId,
          conversationId: runtimeConversationId,
          backendConversationId: conversation.backendConversationId,
          agentId,
          source: "main",
        },
        role: "user",
        parts,
        // Removed originalQueueItem - all data is now in parts
      })
    },
    [invocation, chatId, runtimeConversationId, conversation.backendConversationId, agentId],
  )

  // Wrap stop handler to use new service
  // Phase 16: Only call invocation.stop(), which delegates to adapter
  // Phase 18: Also passes agentId to call backend cancel API
  // Don't call existingChat.stop() directly to avoid double-stop
  const handleStop = useCallback(async () => {
    // Use new service to stop (delegates to adapter.stop() + calls backend cancel API)
    await invocation.stop({
      conversationId: runtimeConversationId,
      chatId,
      agentId, // Pass agentId to call backend cancel API
    })
  }, [invocation, runtimeConversationId, chatId, agentId])

  // Return combined API
  return useMemo(
    () => ({
      // From existing chat instance (if provided)
      ...existingChat,

      // Overridden methods
      handleSend,
      handleSendFromQueue,
      stop: handleStop,

      // From new invocation service
      sessionState,
      invocationQueue: sessionState?.queue ?? [],
      removeQueuedItem: invocation.removeQueuedItem,

      // Phase 17: Service-based sending for useMessageSending (unified queue system)
      service: {
        send: serviceSend,
        enqueue: serviceEnqueue,
        sendQueuedItem: invocation.sendQueuedItem.bind(null, runtimeConversationId),
      },

      // Conversation context
      conversationId: runtimeConversationId,
      chatId,
      agentId,
    }),
    [
      existingChat,
      handleSend,
      handleSendFromQueue,
      handleStop,
      sessionState,
      invocation.removeQueuedItem,
      serviceSend,
      serviceEnqueue,
      runtimeConversationId,
      chatId,
      agentId,
    ],
  )
}
