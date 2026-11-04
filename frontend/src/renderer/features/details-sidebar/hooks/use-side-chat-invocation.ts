/**
 * useSideChatInvocation Hook
 *
 * Bridge hook for migrating side chat to use ConversationInvocationService.
 * This hook provides a compatibility layer between the existing useChatInstance
 * and the new ConversationInvocationService.
 *
 * Phase 9: Progressive migration - uses new service for queue management,
 * while keeping useChatInstance for message rendering and streaming.
 *
 * Phase 15: Fixed dual queue issue.
 * - All send operations now use ConversationInvocationService
 * - Queue is managed exclusively by RuntimeSessionStore
 * - useChatInstance is only used for message rendering (messages, external messages)
 * - Removed delegation to old chatInstance.handleSend()
 *
 * Phase 16: Registered runtime adapter.
 * - The service now delegates to adapter for actual message sending
 * - Adapter uses existing Chat instance for stream handling
 * - This avoids reimplementing stream consumption logic
 */

import { useCallback, useEffect, useMemo, useRef } from "react"
import { useChatInstance } from "../../agents"
import type { MessagePart } from "../../agents"
import { useConversationInvocation, useSessionState } from "../../conversation"
import { useRuntimeSessionMessageProjection } from "../../conversation"
import { getAdapterRegistry } from "../../conversation"
import { useRuntimeSessionSources } from "../../conversation"
import { getConversationProjectionService } from "../../conversation"
import { getMessageCorrelationService } from "../../conversation"
import type { ChatConversation } from "../lib/chat-contract-api"
import type { UIMessage } from "@ai-sdk/react"
// Getter function instead of module-level constant to avoid forcing early initialization
// of the projection service. This allows the service to be lazily created on first use,
// which can help with module loading order and test isolation.
const getProjectionService = () => getConversationProjectionService()

/**
 * Side chat invocation hook.
 *
 * This hook bridges the existing useChatInstance with the new
 * ConversationInvocationService, allowing progressive migration.
 *
 * @param options - Hook options
 * @returns Chat instance with invocation API
 */
export function useSideChatInvocation({
  conversation,
  chatId,
  agentId,
  isActive = true,
  runtimeMessages = [],
  runtimeStatus,
}: {
  conversation: ChatConversation
  chatId: string
  agentId?: string | null
  isActive?: boolean
  runtimeMessages?: UIMessage[]
  runtimeStatus?: "idle" | "streaming" | "completed" | "error"
}) {
  const backendConversationId = conversation.backendConversationId
  const runtimeConversationId = backendConversationId ?? conversation.id

  // Use existing chat instance for message rendering and streaming
  const chatInstance = useChatInstance({
    conversation,
    chatId,
    agentId,
    isActive,
  })

  // Keep a stable ref to the latest chat instance so the adapter registration
  // effect does not re-run (and tear down the in-flight stream) on every render.
  const chatInstanceRef = useRef(chatInstance)
  chatInstanceRef.current = chatInstance

  // Use new invocation service for queue management
  const invocation = useConversationInvocation()

  // Get session state from new service
  const sessionState = useSessionState(runtimeConversationId)

  const persistedSessionMessages = useMemo(
    () => (conversation.messages ?? []).map((message) => getProjectionService().normalizeRawMessage(message, "persisted")),
    [conversation.messages],
  )
  const localSessionMessages = useMemo(
    () => chatInstance.messages.map((message) => getProjectionService().normalizeRawMessage(message, "local")),
    [chatInstance.messages],
  )

  // While the local transport is streaming the current turn, it is the freshest
  // view of that turn; clear the backend runtime projection to avoid
  // duplicate/flickering messages (mirrors the main-chat behavior).
  // Exception: when the local Chat has no messages yet (e.g. the side chat
  // was attached mid-turn), keep the backend runtime projection so the
  // in-progress reply stays visible instead of a blank pane.
  // Backend live turns are visible while streaming, or before durable history
  // has loaded. Completed backend turns are reconciled through persisted data.
  const localIsEmpty = localSessionMessages.length === 0
  const backendRuntimeEnabled =
    (localIsEmpty ||
      !(chatInstance.status === "streaming" || chatInstance.status === "submitted")) &&
    (runtimeStatus === "streaming" || persistedSessionMessages.length === 0)
  const backendRuntimeMessages = useMemo(
    () => (backendRuntimeEnabled ? runtimeMessages.map((message) => getProjectionService().normalizeRawMessage(message, "runtime")) : []),
    [backendRuntimeEnabled, runtimeMessages],
  )

  // Ingest raw sources only. RuntimeSessionStore owns the merged view.
  useRuntimeSessionSources({
    conversationId: runtimeConversationId,
    persistedMessages: persistedSessionMessages,
    localMessages: localSessionMessages,
    backendRuntimeMessages,
  })

  const visibleMessages =
    sessionState?.visibleMessages && sessionState.visibleMessages.length > 0
      ? sessionState.visibleMessages
      : chatInstance.messages

  const isLocalStreaming =
    chatInstance.status === "streaming" || chatInstance.status === "submitted"
  const isBackendStreaming =
    runtimeStatus === "streaming" || sessionState?.isStreaming === true
  const isStreaming = isLocalStreaming || isBackendStreaming

  // Externally started turns have no local useChat status transition.
  const streamingStatus = isLocalStreaming
    ? chatInstance.status
    : isStreaming
      ? "streaming"
      : chatInstance.status

  // Sync the merged visibleMessages (from projection service) to the Jotai store.
  // Centralized through the runtime message projection adapter to avoid
  // duplicated layout-effect sync logic across chat contexts.
  useRuntimeSessionMessageProjection({
    conversationId: runtimeConversationId,
    messages: visibleMessages,
    status: streamingStatus,
    updateGlobal: false,
  })
  // Phase 16: Register runtime adapter that delegates to existing Chat instance
  // This allows the service to leverage AI SDK's stream handling.
  // NOTE: Register only once per conversation. Depending on `chatInstance`
  // (which is a new object every render) would tear down and re-register the
  // adapter on every render, aborting in-flight streams and making the side
  // chat appear non-streaming.
  useEffect(() => {
    const adapter = {
      sendMessage: async ({
        role,
        parts,
        interrupt,
        correlationId,
        externalMessageId: providedExternalMessageId,
      }: {
        role: "user" | "agent"
        parts: MessagePart[]
        interrupt?: boolean
        correlationId?: string
        externalMessageId?: string
      }) => {
        // Delegate to existing Chat instance.
        // Keep parity with the main-chat adapter: carry interrupt and
        // correlationId in metadata so the transport can forward them.
        const ci = chatInstanceRef.current
        const message = await getMessageCorrelationService().createOptimisticMessage({
          role,
          parts,
          externalMessageId: providedExternalMessageId,
          metadata: {
            interrupt: interrupt ?? false,
            correlationId,
          },
        })
        await ci.sendMessage(message as unknown as Parameters<typeof ci.sendMessage>[0])
      },
      stop: async () => {
        // Delegate to existing Chat instance
        chatInstanceRef.current.stop()
      },
    }

    // Register adapter for this conversation
    return getAdapterRegistry().register(runtimeConversationId, adapter)
  }, [runtimeConversationId])

  // Wrap send handler to use new service (FIXED: no longer delegates to old queue)
  const handleSend = useCallback(
    async (parts: UIMessage["parts"]) => {
      // Use new ConversationInvocationService for sending
      // This ensures all messages go through the same queue system
      await invocation.send({
        conversation: {
          chatId,
          conversationId: runtimeConversationId,
          backendConversationId: conversation.backendConversationId,
          agentId,
          source: "side",
        },
        role: "user",
        parts: parts as MessagePart[],
      })
    },
    [invocation, chatId, runtimeConversationId, conversation.backendConversationId, agentId],
  )

  // Wrap send from queue to use new service
  const handleSendFromQueue = useCallback(
    async (itemId: string) => {
      // Use new service to send queued item
      await invocation.sendQueuedItem(runtimeConversationId, itemId)
    },
    [invocation, runtimeConversationId],
  )

  // Wrap stop handler to use new service
  // Phase 16: Only call invocation.stop(), which delegates to adapter
  // Don't call chatInstance.stop() directly to avoid double-stop
  const handleStop = useCallback(async () => {
    // Use new service to stop (delegates to adapter.stop())
    await invocation.stop({
      conversationId: runtimeConversationId,
      chatId,
    })
  }, [invocation, runtimeConversationId, chatId])

  // Return combined API
  return useMemo(
    () => ({
      // From existing chat instance
      ...chatInstance,

      // Unified view: persisted history + local stream + external runtime turn
      messages: visibleMessages,
      status: streamingStatus,
      isStreaming,

      // Overridden methods
      handleSend,
      handleSendFromQueue,
      stop: handleStop,

      // From new invocation service
      sessionState,
      invocationQueue: sessionState?.queue ?? [],

      // Conversation context
      conversationId: runtimeConversationId,
      chatId,
      agentId,
    }),
    [
      chatInstance,
      handleSend,
      handleSendFromQueue,
      handleStop,
      sessionState,
      runtimeConversationId,
      chatId,
      agentId,
      isStreaming,
      streamingStatus,
      visibleMessages,
    ],
  )
}
