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
import { useConversationInvocation, useSessionState } from "../../conversation"
import { useRuntimeSessionMessageProjection } from "../../conversation"
import { getAdapterRegistry, type AdapterState } from "../../conversation"
import type { ConversationStatus } from "../../conversation"
import type { ConversationSource } from "../../conversation"
import { useRuntimeSessionSources } from "../../conversation"
import { getConversationProjectionService } from "../../conversation"
import { getMessageCorrelationService } from "../../conversation"
import { trpc } from "../../../lib/trpc"
import type { MessagePart } from "../stores/message-store"
import type { AgentQueueItem, QueuedTextContext, QueuedDiffTextContext, QueuedPastedText } from "../lib/queue-utils"
import { MENTION_PREFIXES } from "../../mentions"
import { utf8ToBase64 } from "../utils/base64"
import type { ChatConversation } from "@/features/details-sidebar"
import { buildQuoteMentionToken, buildDiffMentionToken, buildPastedMentionToken } from "../mentions/mentions-utils"

/**
 * Raw message shape from various sources (backend API, Chat instance, etc.).
 * These are normalized by ConversationProjectionService before ingestion.
 * TODO: Replace with proper API response types once backend typing is standardized.
 */
export type RawMessage = Record<string, unknown> & {
  id: string
  role: string
  parts?: unknown[]
  metadata?: Record<string, unknown>
  sequence?: number
  turnId?: string | null
  createdAt?: string | number | Date
}

const EMPTY_PERSISTED_MESSAGES: RawMessage[] = []
// Getter function instead of module-level constant to avoid forcing early initialization
// of the projection service. This allows the service to be lazily created on first use,
// which can help with module loading order and test isolation.
const getProjectionService = () => getConversationProjectionService()

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
  resolverAgentId,
  stopAgentId,
  isActive: _isActive = true,
  persistedMessages,
  persistedMessagesLoading,
  runtimeMessages = [],
  existingChat,
  runtimeStatus,
  source,
}: {
  conversation: ChatConversation & { messages?: RawMessage[] }
  chatId: string
  resolverAgentId?: string | null
  /** Agent ID used only for backend cancel on stop; defaults to resolverAgentId */
  stopAgentId?: string | null
  isActive?: boolean
  /** Durable messages from the chat snapshot, separate from local streaming. */
  persistedMessages?: RawMessage[]
  /** True while the durable chat snapshot has not finished loading. */
  persistedMessagesLoading?: boolean
  /** Live output events for turns started by the backend scheduler. */
  runtimeMessages?: RawMessage[]
  /** Existing Chat instance to avoid creating duplicate */
  existingChat?: ChatInstanceAPI
  /** Backend runtime status for turns started outside the local Chat transport. */
  runtimeStatus?: string
  /** Source pane type for invocation context. Defaults to "main". */
  source?: ConversationSource
}) {
  const backendConversationId = conversation.backendConversationId
  const runtimeConversationId = backendConversationId ?? conversation.id
  const invocationSource = source ?? "main"

  // Use new invocation service for queue management
  const invocation = useConversationInvocation()

  // Get session state from new service
  const sessionState = useSessionState(runtimeConversationId)
  const trpcUtils = trpc.useUtils()
  const reconciledRuntimeTurnsRef = useRef<Set<string>>(new Set())

  const safePersistedMessages = persistedMessages ?? EMPTY_PERSISTED_MESSAGES
  const persistedSessionMessages = useMemo(
    () => safePersistedMessages.map((message) => getProjectionService().normalizeRawMessage(message, "persisted")),
    [safePersistedMessages],
  )

  const rawLocalMessages = useMemo(() => existingChat?.messages ?? [], [existingChat?.messages])
  const isLocalStreaming =
    existingChat?.status === "streaming" || existingChat?.status === "submitted"
  const localSessionMessages = useMemo(
    () => rawLocalMessages.map((message) => getProjectionService().normalizeRawMessage(message, "local")),
    [rawLocalMessages],
  )

  // While the local transport streams the current turn, clear the backend
  // preview source. Local Chat is the freshest view of that same turn.
  // On reload, a terminal runtime snapshot can arrive before the durable
  // snapshot. Suppressing that terminal preview prevents a one-render flash
  // of the previous turn; an active streaming turn is still shown immediately.
  const shouldDeferTerminalRuntimePreview =
    !isLocalStreaming &&
    runtimeStatus !== "streaming" &&
    persistedMessagesLoading === true &&
    runtimeMessages.length > 0
  const existingRuntimeMessages = sessionState?.runtimeMessages
  const backendRuntimeMessages = useMemo(
    () => {
      if (isLocalStreaming || shouldDeferTerminalRuntimePreview) return []
      const next = runtimeMessages.map((message) =>
        getProjectionService().normalizeRawMessage(message, "runtime"),
      )
      // A new backend turn begins with `turn_started`, which has no
      // renderable content yet. `buildRuntimeMessages` therefore returns an
      // empty array for one frame. Keep the previous turn's live projection
      // until the new turn emits thinking/tool/text; otherwise the assistant
      // answer disappears and then reappears (visible flash). The store prunes
      // these messages as soon as their canonical copies are persisted.
      if (
        next.length === 0 &&
        runtimeStatus === "streaming" &&
        existingRuntimeMessages?.length
      ) {
        return existingRuntimeMessages
      }
      return next
    },
    [
      isLocalStreaming,
      shouldDeferTerminalRuntimePreview,
      runtimeMessages,
      runtimeStatus,
      existingRuntimeMessages,
    ],
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
      : localSessionMessages

  // Sync the merged visibleMessages (from projection service) to the Jotai store.
  // Centralized through the runtime message projection adapter to avoid
  // duplicated layout-effect sync logic across chat contexts.
  const mapChatStatus = (chatStatus?: string): string => {
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
        return "ready"
    }
  }
  const isLocalStreamingForStatus =
    existingChat?.status === "streaming" || existingChat?.status === "submitted"
  const isBackendStreamingForStatus =
    runtimeStatus === "streaming" || sessionState?.isStreaming === true
  const computedStatus =
    !isLocalStreamingForStatus && isBackendStreamingForStatus
      ? "streaming"
      : mapChatStatus(existingChat?.status)
  useRuntimeSessionMessageProjection({
    conversationId: runtimeConversationId,
    messages: visibleMessages,
    status: computedStatus,
    updateGlobal: false,
  })
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
        // IMPORTANT: await the stop() call to ensure the stream is fully stopped
        // before returning to the caller (conversation-invocation-service)
        if (existingChat.stop) {
          await existingChat.stop()
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
            agentId: resolverAgentId,
            source: invocationSource,
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
    [invocation, chatId, runtimeConversationId, conversation.backendConversationId, resolverAgentId, invocationSource],
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
          agentId: resolverAgentId,
          source: invocationSource,
        },
        role: "user",
        parts,
        transportOverrides: undefined,
      })
    },
    [invocation, chatId, runtimeConversationId, conversation.backendConversationId, resolverAgentId, invocationSource],
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
          return buildQuoteMentionToken(preview, encodedText)
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
          return buildDiffMentionToken(dtc.filePath, lineNum, preview, encodedText)
        })
        mentionPrefix += diffMentions.join(" ") + " "
      }

      // Convert pastedTexts to mention tokens
      if (item.pastedTexts && item.pastedTexts.length > 0) {
        const pastedMentions = item.pastedTexts.map((pt: QueuedPastedText) => {
          const preview = pt.preview || "" // defensive default
          const sanitizedPreview = preview.replace(/[:\[\]|]/g, "")
          const prefix = pt.kind === "chatHistory" ? MENTION_PREFIXES.CHAT_HISTORY : MENTION_PREFIXES.PASTED
          return buildPastedMentionToken(prefix, pt.size, sanitizedPreview, pt.filePath)
        })
        mentionPrefix += pastedMentions.join(" ") + " "
      }

      // Add text (message with mention prefix if unknown)
      if (item.message || mentionPrefix) {
        parts.push({ type: "text", text: mentionPrefix + (item.message || "") })
      }

      await invocation.enqueue({
        conversation: {
          chatId,
          conversationId: runtimeConversationId,
          backendConversationId: conversation.backendConversationId,
          agentId: resolverAgentId,
          source: invocationSource,
        },
        role: "user",
        parts,
        transportOverrides: undefined,
      })
    },
    [invocation, chatId, runtimeConversationId, conversation.backendConversationId, resolverAgentId, invocationSource],
  )

  // Wrap stop handler to use new service
  // Phase 16: Only call invocation.stop(), which delegates to adapter
  // Phase 18: Also passes resolverAgentId to call backend cancel API
  // Don't call existingChat.stop() directly to avoid double-stop
  const handleStop = useCallback(async () => {
    // Use new service to stop (delegates to adapter.stop() + calls backend cancel API)
    await invocation.stop({
      conversationId: runtimeConversationId,
      chatId,
      agentId: stopAgentId ?? resolverAgentId,
    })
  }, [invocation, runtimeConversationId, chatId, resolverAgentId, stopAgentId])

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
      resolverAgentId,
    }),
    [
      existingChat,
      visibleMessages,
      handleSend,
      handleSendFromQueue,
      handleStop,
      sessionState,
      invocation.removeQueuedItem,
      invocation.sendQueuedItem,
      serviceSend,
      serviceEnqueue,
      runtimeConversationId,
      chatId,
      resolverAgentId,
    ],
  )
}
