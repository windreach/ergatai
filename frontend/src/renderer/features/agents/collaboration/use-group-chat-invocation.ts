/**
 * useGroupChatInvocation Hook
 *
 * Bridge hook for migrating group chat to use ConversationInvocationService.
 * This hook provides a compatibility layer between the existing useChatInstance
 * and the new ConversationInvocationService.
 *
 * Phase 11: Progressive migration - uses new service for queue management,
 * while keeping useChatInstance for message rendering and streaming.
 *
 * Group chat is more complex than side/main chat because:
 * - Multiple agents participate in the same conversation
 * - Messages can be routed to different agents based on mentions or context
 * - Each agent has its own runtime status and conversation binding
 * - Group context (agents, isGroupChat) must be preserved across the migration
 */

import { useCallback, useEffect, useMemo, useRef } from "react"
import { useChatInstance } from "../hooks/use-chat-instance"
import { useConversationInvocation, useSessionState } from "../../conversation"
import { getAdapterRegistry } from "../../conversation"
import { getMessageCorrelationService } from "../../conversation"
import type { MessagePart } from "../stores/message-store"
import { useGroupChat } from "./group-chat-context"
import type { ChatConversation } from "@/features/details-sidebar"
import type { UIMessage } from "@ai-sdk/react"

/**
 * Group chat invocation hook.
 *
 * This hook bridges the existing useChatInstance with the new
 * ConversationInvocationService, allowing progressive migration.
 *
 * Group-specific features:
 * - Multi-agent context: Preserves group agents list and group chat flag
 * - Agent routing: Supports sending messages to specific agents via mentions
 * - Participant tracking: Integrates with group runtime status tracking
 *
 * @param options - Hook options
 * @returns Chat instance with invocation API and group context
 *
 * @example
 * ```tsx
 * function GroupChatView({ conversation, chatId }) {
 *   const groupInvocation = useGroupChatInvocation({
 *     conversation,
 *     chatId,
 *     agentId: null, // Group chat doesn't have a single agent
 *     isActive: true,
 *   })
 *
 *   const { agents, isGroupChat } = groupInvocation.groupContext
 *
 *   return (
 *     <div>
 *       {agents.map(agent => (
 *         <AgentStatus key={agent.id} agent={agent} />
 *       ))}
 *       <ChatMessages messages={groupInvocation.messages} />
 *       <ChatInput onSend={groupInvocation.handleSend} />
 *     </div>
 *   )
 * }
 * ```
 */
export function useGroupChatInvocation({
  conversation,
  chatId,
  agentId,
  isActive = true,
  transportConfig,
  onMessagePersisted,
}: {
  conversation: ChatConversation
  chatId: string
  agentId?: string | null
  isActive?: boolean
  transportConfig?: {
    fromAgentId?: string
    targetAgentCommand?: string
    forceNewSession?: boolean
    correlationId?: string
  }
  onMessagePersisted?: () => void
}) {
  const backendConversationId = conversation.backendConversationId
  const runtimeConversationId = backendConversationId ?? conversation.id

  // Get group context - this is what makes group chat special
  const groupContext = useGroupChat()

  // Use existing chat instance for message rendering and streaming
  const chatInstance = useChatInstance({
    conversation,
    chatId,
    agentId,
    isActive,
    transportConfig,
    onMessagePersisted,
  })

  // Keep a stable ref to the latest chat instance so the adapter registration
  // effect does not re-run (and tear down the in-flight stream) on every render.
  const chatInstanceRef = useRef(chatInstance)
  chatInstanceRef.current = chatInstance

  // Use new invocation service for queue management
  const invocation = useConversationInvocation()

  // Phase 11: Register runtime adapter that delegates to existing Chat instance
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
        // IMPORTANT: await the stop() call to ensure the stream is fully stopped
        // before returning to the caller (conversation-invocation-service)
        await chatInstanceRef.current.stop()
      },
    }

    return getAdapterRegistry().register(runtimeConversationId, adapter)
  }, [runtimeConversationId])

  // Get session state from new service
  const sessionState = useSessionState(runtimeConversationId)

  // Wrap send handler to use new service
  // Phase 11: Route messages through ConversationInvocationService
  const handleSend = useCallback(
    async (parts: UIMessage["parts"]) => {
      await invocation.send({
        conversation: {
          chatId,
          conversationId: runtimeConversationId,
          backendConversationId: conversation.backendConversationId,
          agentId,
          source: "group",
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
      try {
        // Use new service to send queued item
        await invocation.sendQueuedItem(runtimeConversationId, itemId)
      } catch (error) {
        console.error('[GroupChat] Send from queue failed:', error)
      }
    },
    [invocation, runtimeConversationId],
  )

  // Wrap stop handler to use new service
  const handleStop = useCallback(async () => {
    // Extract all agent IDs from group context for backend cancel API
    const agentIds = groupContext.agents.map((agent) => agent.id)

    try {
      // Use new service to stop with all participating agents
      await invocation.stop({
        conversationId: runtimeConversationId,
        chatId,
        agentIds, // Pass all agent IDs to cancel backend processing for each
      })
    } catch (error) {
      console.error('[GroupChat] Stop failed:', error)
    } finally {
      // Also stop the chat instance - always execute even if invocation.stop() throws
      chatInstance.stop()
    }
  }, [invocation, runtimeConversationId, chatId, chatInstance, groupContext.agents])

  // Group-specific: Send message to a specific agent in the group
  // This is useful for @mention routing and direct agent communication
  const sendToAgent = useCallback(
    async (targetAgentId: string, parts: UIMessage["parts"]) => {
      const targetAgent = groupContext.agents.find((agent) => agent.id === targetAgentId)
      if (!targetAgent) {
        console.error(`[useGroupChatInvocation] Agent ${targetAgentId} not found in group`)
        return
      }

      await invocation.send({
        conversation: {
          chatId,
          conversationId: runtimeConversationId,
          backendConversationId: conversation.backendConversationId,
          agentId: targetAgentId,
          source: "group",
        },
        role: "user",
        parts: parts as MessagePart[],
        transportOverrides: {
          command: targetAgentId,
        },
      })
    },
    [invocation, chatId, runtimeConversationId, conversation.backendConversationId, groupContext.agents],
  )

  // Group-specific: Broadcast message to all agents in the group
  // This is useful for system-wide notifications or group commands
  const broadcastToGroup = useCallback(
    async (parts: UIMessage["parts"]) => {
      if (groupContext.agents.length === 0) {
        console.warn("[useGroupChatInvocation] No agents in group to broadcast to")
        return
      }

      await Promise.all(
        groupContext.agents.map((agent) =>
          invocation.send({
            conversation: {
              chatId,
              conversationId: runtimeConversationId,
              backendConversationId: conversation.backendConversationId,
              agentId: agent.id,
              source: "group",
            },
            role: "user",
            parts: parts as MessagePart[],
            transportOverrides: {
              command: agent.id,
            },
          }).catch((error) => {
            console.error(`[useGroupChatInvocation] Broadcast to ${agent.id} failed:`, error)
          }),
        ),
      )
    },
    [invocation, chatId, runtimeConversationId, conversation.backendConversationId, groupContext.agents],
  )

  // Return combined API with group context
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

      // Group-specific context and methods
      groupContext,
      sendToAgent,
      broadcastToGroup,

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
      groupContext,
      sendToAgent,
      broadcastToGroup,
      runtimeConversationId,
      chatId,
      agentId,
    ],
  )
}
