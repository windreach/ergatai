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
import { getAdapterRegistry } from "../../conversation/runtime/runtime-adapter"
import { getRuntimeSessionStore } from "../../conversation/runtime/runtime-session-store"
import type { Message } from "../../agents/stores/message-store"
import type { ChatConversation } from "../lib/chat-contract-api"
import type { UIMessage } from "@ai-sdk/react"

function toSessionMessage(message: any): Message {
  const metadata = message.metadata
  const runtimeSequence = metadata?.runtimeSequence

  return {
    id: message.id,
    role: message.role,
    parts: message.parts ?? [],
    metadata,
    sequence: typeof runtimeSequence === "number" ? runtimeSequence : undefined,
    createdAt: message.createdAt ? new Date(message.createdAt) : undefined,
  }
}

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
  const sessionStore = getRuntimeSessionStore()

  // Wire the old local Chat instance into the unified runtime session cache.
  // This is the missing piece in the earlier migration: side chat used the
  // service for queue/status but bypassed `visibleMessages` for rendering.
  useEffect(() => {
    if (!runtimeConversationId) return
    sessionStore.ensureSession(runtimeConversationId)
  }, [runtimeConversationId, sessionStore])

  const persistedSessionMessages = useMemo(
    () => (conversation.messages ?? []).map(toSessionMessage),
    [conversation.messages],
  )

  useEffect(() => {
    if (!runtimeConversationId || persistedSessionMessages.length === 0) return
    sessionStore.setPersistedMessages(runtimeConversationId, persistedSessionMessages)
  }, [persistedSessionMessages, runtimeConversationId, sessionStore])

  const shouldAppendRuntimeMessages =
    runtimeStatus === "streaming" || persistedSessionMessages.length === 0

  const sessionRuntimeMessages = useMemo(() => {
    const localMessages = chatInstance.messages.map(toSessionMessage)
    const externalMessages = shouldAppendRuntimeMessages
      ? runtimeMessages.map(toSessionMessage)
      : []

    // Local messages override a persisted message with the same ID; external
    // runtime events are merged with local streaming by the session store.
    return [...externalMessages, ...localMessages]
  }, [chatInstance.messages, runtimeMessages, shouldAppendRuntimeMessages])

  useEffect(() => {
    if (!runtimeConversationId || sessionRuntimeMessages.length === 0) return
    sessionStore.setRuntimeMessages(runtimeConversationId, sessionRuntimeMessages)
  }, [runtimeConversationId, sessionRuntimeMessages, sessionStore])

  const visibleMessages =
    sessionState?.visibleMessages && sessionState.visibleMessages.length > 0
      ? sessionState.visibleMessages
      : chatInstance.messages

  // Phase 16: Register runtime adapter that delegates to existing Chat instance
  // This allows the service to leverage AI SDK's stream handling
  useEffect(() => {
    const adapter = {
      sendMessage: async ({ role, parts }: { role: "user" | "agent"; parts: any[] }) => {
        // Delegate to existing Chat instance
        if (role === "user") {
          // For user messages, use sendMessage
          await chatInstance.sendMessage({ role: "user", parts })
        } else {
          // For agent messages, use sendAgentMessage
          await chatInstance.sendAgentMessage(parts)
        }
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
        parts,
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
    ],
  )
}
