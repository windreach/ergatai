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

import { useCallback, useEffect, useMemo } from "react"
import { useChatInstance } from "../../agents/hooks/use-chat-instance"
import { useConversationInvocation, useSessionState } from "../../conversation/runtime/use-conversation-invocation"
import type { MessagePart } from "../../agents/stores/message-store"
import { getAdapterRegistry } from "../../conversation/runtime/runtime-adapter"
import { useRuntimeSessionSources } from "../../conversation/runtime/use-runtime-session-sources"
import { getConversationProjectionService } from "../../conversation/runtime/conversation-projection-service"
import { getMessageCorrelationService } from "../../conversation/runtime/message-correlation-service"
import type { ChatConversation } from "../lib/chat-contract-api"
import type { UIMessage } from "@ai-sdk/react"

const projectionService = getConversationProjectionService()

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
  conversation: ChatConversation & { messages?: any[] }
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

  // Use new invocation service for queue management
  const invocation = useConversationInvocation()

  // Get session state from new service
  const sessionState = useSessionState(runtimeConversationId)

  const persistedSessionMessages = useMemo(
    () => (conversation.messages ?? []).map((message) => projectionService.normalizeRawMessage(message)),
    [conversation.messages],
  )
  const localSessionMessages = useMemo(
    () => chatInstance.messages.map((message) => projectionService.normalizeRawMessage(message)),
    [chatInstance.messages],
  )

  // Backend live turns are visible while streaming, or before durable history
  // has loaded. Completed backend turns are reconciled through persisted data.
  const backendRuntimeEnabled =
    runtimeStatus === "streaming" || persistedSessionMessages.length === 0
  const backendRuntimeMessages = useMemo(
    () => (backendRuntimeEnabled ? runtimeMessages.map((message) => projectionService.normalizeRawMessage(message)) : []),
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

  // Phase 16: Register runtime adapter that delegates to existing Chat instance
  // This allows the service to leverage AI SDK's stream handling
  useEffect(() => {
    const adapter = {
      sendMessage: async ({
        role,
        parts,
        externalMessageId: providedExternalMessageId,
      }: {
        role: "user" | "agent"
        parts: any[]
        externalMessageId?: string
      }) => {
        // Delegate to existing Chat instance
        const message = await getMessageCorrelationService().createOptimisticMessage({
          role,
          parts,
          externalMessageId: providedExternalMessageId,
        })
        await chatInstance.sendMessage(message)
      },
      stop: async () => {
        // Delegate to existing Chat instance
        chatInstance.stop()
      },
    }

    // Register adapter for this conversation
    return getAdapterRegistry().register(runtimeConversationId, adapter)
  }, [runtimeConversationId, chatInstance])

  // Wrap send handler to use new service (FIXED: no longer delegates to old queue)
  const handleSend = useCallback(
    async (parts: UIMessage<any>["parts"]) => {
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
    ],
  )
}
