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
import type { ChatConversation } from "../lib/chat-contract-api"
import type { UIMessage } from "@ai-sdk/react"

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
}: {
  conversation: ChatConversation & { messages?: any[] }
  chatId: string
  agentId?: string | null
  isActive?: boolean
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
