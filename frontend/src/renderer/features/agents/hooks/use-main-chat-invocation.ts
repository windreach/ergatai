/**
 * useMainChatInvocation Hook
 *
 * Bridge hook for migrating main chat to use ConversationInvocationService.
 * This hook provides a compatibility layer between the existing Chat instance
 * and the new ConversationInvocationService.
 *
 * Phase 10: Progressive migration - uses the invocation service for queue
 * management and the RuntimeSessionStore for merged message rendering.
 *
 * Phase 16: Fixed duplicate Chat instance issue and registered runtime adapter.
 * - Now accepts an existing chat instance instead of creating a new one
 * - Registers adapter to delegate message sending to existing Chat
 * - Bridges raw message sources into the runtime store, which owns merging
 * - Does not create duplicate Chat/transport state
 */

import { useCallback, useEffect, useMemo, useRef } from "react"
import { useConversationInvocation, useSessionState } from "../../conversation/runtime/use-conversation-invocation"
import { getAdapterRegistry, type AdapterState } from "../../conversation/runtime/runtime-adapter"
import type { ConversationStatus } from "../../conversation/runtime/contracts"
import { useRuntimeSessionSources } from "../../conversation/runtime/use-runtime-session-sources"
import { getConversationProjectionService } from "../../conversation/runtime/conversation-projection-service"
import { getMessageCorrelationService } from "../../conversation/runtime/message-correlation-service"
import { trpc } from "../../../lib/trpc"
import type { MessagePart } from "../stores/message-store"
import type { AgentQueueItem, QueuedTextContext, QueuedDiffTextContext, QueuedPastedText } from "../lib/queue-utils"
import { MENTION_PREFIXES } from "../../mentions/types"
import { utf8ToBase64 } from "../utils/base64"
import type { ChatConversation } from "@/features/details-sidebar/lib/chat-contract-api"

/**
 * Raw message shape from various sources (backend API, Chat instance, etc.).
 * These are normalized by ConversationProjectionService before ingestion.
 * TODO: Replace with proper API response types once backend typing is standardized.
 */
type RawMessage = Record<string, unknown> & {
  id: string
  role: string
  parts?: unknown[]
  metadata?: Record<string, unknown>
  sequence?: number
  turnId?: string | null
  createdAt?: string | number | Date
}

const EMPTY_PERSISTED_MESSAGES: RawMessage[] = []
const projectionService = getConversationProjectionService()

/**
 * Chat instance API (subset of Chat interface we need).
 */
export interface ChatInstanceAPI {
  sendMessage?: (message: { id?: string; role: "user" | "agent" | "assistant"; parts: MessagePart[]; metadata?: Record<string, unknown> } & { interrupt?: boolean }) => void | Promise<void>
  stop?: () => void
  messages?: RawMessage[]
  status?: string
  queue?: AgentQueueItem[]
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
  persistedMessages,
  runtimeMessages = [],
  existingChat,
}: {
  conversation: ChatConversation & { messages?: RawMessage[] }
  chatId: string
  agentId?: string | null
  isActive?: boolean
  /** Durable messages from the chat snapshot, separate from local streaming. */
  persistedMessages?: RawMessage[]
  /** Live output events for turns started by the backend scheduler. */
  runtimeMessages?: RawMessage[]
  /** Existing Chat instance to avoid creating duplicate */
  existingChat?: ChatInstanceAPI
}) {
  const backendConversationId = conversation.backendConversationId
  const runtimeConversationId = backendConversationId ?? conversation.id

  // Use new invocation service for queue management
  const invocation = useConversationInvocation()

  // Get session state from new service
  const sessionState = useSessionState(runtimeConversationId)
  const trpcUtils = trpc.useUtils()
  const reconciledRuntimeTurnsRef = useRef<Set<string>>(new Set())

  const safePersistedMessages = persistedMessages ?? EMPTY_PERSISTED_MESSAGES
  const persistedSessionMessages = useMemo(
    () => safePersistedMessages.map((message) => projectionService.normalizeRawMessage(message)),
    [safePersistedMessages],
  )

  const rawLocalMessages = existingChat?.messages ?? []
  const isLocalStreaming =
    existingChat?.status === "streaming" || existingChat?.status === "submitted"
  const localSessionMessages = useMemo(
    () => rawLocalMessages.map((message) => projectionService.normalizeRawMessage(message)),
    [rawLocalMessages],
  )

  // While the local transport streams the current turn, clear the backend
  // preview source. Local Chat is the freshest view of that same turn.
  const backendRuntimeMessages = useMemo(
    () => (isLocalStreaming ? [] : runtimeMessages.map((message) => projectionService.normalizeRawMessage(message))),
    [isLocalStreaming, runtimeMessages],
  )

  // The hook only ingests raw sources. RuntimeSessionStore owns merging and
  // produces the stable visibleMessages snapshot consumed by the UI.
  useRuntimeSessionSources({
    conversationId: runtimeConversationId,
    persistedMessages: persistedSessionMessages,
    localMessages: localSessionMessages,
    backendRuntimeMessages,
  })

  /**
   * Backend turns are persisted independently of the AI SDK Chat transport.
   * As soon as a runtime projection completes, refresh the durable snapshot so
   * a later `TurnStarted` can discard that runtime projection without losing
   * the canonical message.
   */
  useEffect(() => {
    if (!chatId || !runtimeConversationId || isLocalStreaming) return

    const completedRuntimeMessage = [...runtimeMessages]
      .reverse()
      .find((message) => message.metadata?.runtimeStatus === "completed")
    if (!completedRuntimeMessage) return

    const metadata = completedRuntimeMessage.metadata as {
      turnId?: unknown
      runtimeSequence?: unknown
    }
    const turnId = typeof metadata.turnId === "string" ? metadata.turnId : completedRuntimeMessage.id
    const runtimeSequence = typeof metadata.runtimeSequence === "number"
      ? metadata.runtimeSequence
      : 0
    const reconcileKey = `${runtimeConversationId}:${turnId}:${runtimeSequence}`
    if (reconciledRuntimeTurnsRef.current.has(reconcileKey)) return
    reconciledRuntimeTurnsRef.current.add(reconcileKey)

    void Promise.all([
      trpcUtils.chats.get.invalidate({ id: chatId }),
      trpcUtils.ergatai.listConversationMessages.invalidate({
        conversationId: runtimeConversationId,
      }),
    ])
  }, [
    chatId,
    isLocalStreaming,
    runtimeConversationId,
    runtimeMessages,
    trpcUtils,
  ])

  const visibleMessages =
    sessionState?.visibleMessages && sessionState.visibleMessages.length > 0
      ? sessionState.visibleMessages
      : rawLocalMessages

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
      sendMessage: async ({ role, parts, interrupt, correlationId, externalMessageId }: { role: "user" | "agent"; parts: MessagePart[]; interrupt?: boolean; correlationId?: string; externalMessageId?: string }) => {
        // Delegate to existing Chat instance
        // Phase 19: Pass interrupt flag and correlationId via message metadata
        if (existingChat.sendMessage) {
          const message = await getMessageCorrelationService().createOptimisticMessage({
            role,
            parts,
            externalMessageId,
            metadata: {
              interrupt: interrupt ?? false,
              correlationId,
            },
          })
          await existingChat.sendMessage(message)
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
            (m: RawMessage) => (m as Record<string, unknown>).isStreaming || m.role === "assistant"
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
    async (parts: MessagePart[]) => {
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
          transportOverrides: undefined,
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
    async (parts: MessagePart[]) => {
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
        transportOverrides: undefined,
      })
    },
    [invocation, chatId, runtimeConversationId, conversation.backendConversationId, agentId],
  )

  // Phase 17: Service-based enqueue function for useMessageSending
  // This unifies the queue system - all queue operations go through service
  const serviceEnqueue = useCallback(
    async (item: AgentQueueItem) => {
      // Convert AgentQueueItem to ConversationSendMessageInput
      // Build parts from queue item (images, files, textContexts, etc.)
      const parts: MessagePart[] = []

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
        const quoteMentions = item.textContexts.map((tc: QueuedTextContext) => {
          const text = tc.text || "" // defensive default
          const preview = text.slice(0, 50).replace(/[:\[\]]/g, "")
          const encodedText = utf8ToBase64(text)
          return `@[${MENTION_PREFIXES.QUOTE}${preview}:${encodedText}]`
        })
        mentionPrefix += quoteMentions.join(" ") + " "
      }

      // Convert diffTextContexts to mention tokens
      if (item.diffTextContexts && item.diffTextContexts.length > 0) {
        const diffMentions = item.diffTextContexts.map((dtc: QueuedDiffTextContext) => {
          const text = dtc.text || "" // defensive default
          const preview = text.slice(0, 50).replace(/[:\[\]]/g, "")
          const encodedText = utf8ToBase64(text)
          const lineNum = dtc.lineNumber || 0
          return `@[${MENTION_PREFIXES.DIFF}${dtc.filePath}:${lineNum}:${preview}:${encodedText}]`
        })
        mentionPrefix += diffMentions.join(" ") + " "
      }

      // Convert pastedTexts to mention tokens
      if (item.pastedTexts && item.pastedTexts.length > 0) {
        const pastedMentions = item.pastedTexts.map((pt: QueuedPastedText) => {
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
        transportOverrides: undefined,
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

      // Main chat now renders through the same merged runtime view as side chat.
      messages: visibleMessages,

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
      visibleMessages,
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
