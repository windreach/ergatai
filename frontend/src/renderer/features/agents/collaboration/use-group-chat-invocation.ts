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

import { useCallback, useMemo } from "react"
import { useChatInstance } from "../hooks/use-chat-instance"
import { useConversationInvocation, useSessionState } from "../../conversation/runtime/use-conversation-invocation"
import { useGroupChat } from "./group-chat-context"
import type { ChatConversation } from "@/features/details-sidebar/lib/chat-contract-api"
import type { UIMessage } from "@ai-sdk/react"
import type { CoreAgentOption } from "../lib/agent-contract-api"

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
  conversation: ChatConversation & { messages?: any[] }
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

  // Use new invocation service for queue management
  const invocation = useConversationInvocation()

  // Get session state from new service
  const sessionState = useSessionState(runtimeConversationId)

  // Wrap send handler to use new service
  // For group chat, we may need to route messages to specific agents
  const handleSend = useCallback(
    async (parts: UIMessage<any>["parts"]) => {
      // For now, delegate to existing chat instance
      // Future: Replace with invocation.send() with agent routing logic
      //
      // Group chat routing logic (Phase 11+):
      // 1. Parse @mentions from message text
      // 2. Determine target agent(s) from mentions
      // 3. If no mentions, use supervisor agent or broadcast to all
      // 4. Call invocation.send() with appropriate agent routing metadata
      chatInstance.handleSend(parts)
    },
    [chatInstance],
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
    async (targetAgentId: string, parts: UIMessage<any>["parts"]) => {
      // Phase 11: Implement agent-specific routing
      // For now, this is a placeholder for future implementation
      //
      // Implementation plan:
      // 1. Find target agent in groupContext.agents
      // 2. Construct transport config with target agent command
      // 3. Call invocation.send() with agent routing metadata
      //
      // Example:
      // const targetAgent = groupContext.agents.find(a => a.id === targetAgentId)
      // if (!targetAgent) {
      //   console.error(`Agent ${targetAgentId} not found in group`)
      //   return
      // }
      // await invocation.send({
      //   conversation: { chatId, conversationId: runtimeConversationId, source: "group" },
      //   role: "user",
      //   parts,
      //   metadata: { targetAgentCommand: targetAgent.id }
      // })

      console.warn(
        "[useGroupChatInvocation] sendToAgent not yet implemented in Phase 11",
        { targetAgentId, parts },
      )
    },
    [groupContext.agents],
  )

  // Group-specific: Broadcast message to all agents in the group
  // This is useful for system-wide notifications or group commands
  const broadcastToGroup = useCallback(
    async (parts: UIMessage<any>["parts"]) => {
      // Phase 11: Implement broadcast logic
      // For now, this is a placeholder for future implementation
      //
      // Implementation plan:
      // 1. Iterate through groupContext.agents
      // 2. Send message to each agent (possibly in parallel)
      // 3. Handle partial failures gracefully
      //
      // Example:
      // await Promise.all(
      //   groupContext.agents.map(agent =>
      //     invocation.send({
      //       conversation: { chatId, conversationId: runtimeConversationId, source: "group" },
      //       role: "user",
      //       parts,
      //       metadata: { broadcast: true }
      //     })
      //   )
      // )

      console.warn(
        "[useGroupChatInvocation] broadcastToGroup not yet implemented in Phase 11",
        { parts },
      )
    },
    [groupContext.agents],
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
