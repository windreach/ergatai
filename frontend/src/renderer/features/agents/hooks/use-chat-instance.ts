import { useCallback, useEffect, useLayoutEffect, useState } from "react"
import { Chat, useChat, type UIMessage } from "@ai-sdk/react"
import { useSetAtom } from "jotai"
import { toast } from "sonner"
import { ErgataiChatTransport } from "../lib/ergatai-chat-transport"
import { useMessageQueueStore, EMPTY_QUEUE } from "../stores/message-queue-store"
import { syncMessagesWithStatusAtom } from "../stores/message-store"
import { useStreamingStatusStore } from "../stores/streaming-status-store"
import { clearConversationRuntimeCaches } from "../stores/conversation-runtime-cleanup"
import { trpc, trpcClient } from "@/lib/trpc"
import type { ChatConversation, ChatMessage } from "@/features/details-sidebar/lib/chat-contract-api"

/**
 * Shared hook for managing Chat instances in both main chat and side chat.
 * Handles: Chat instance creation, message mapping, streaming state, queue, persistence.
 */
export function useChatInstance({
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

  const trpcUtils = trpc.useUtils()
  const [isPersistingMessages, setIsPersistingMessages] = useState(false)

  // Message queue
  const queue = useMessageQueueStore((s) => s.queues[runtimeConversationId] ?? EMPTY_QUEUE)
  const addToQueue = useMessageQueueStore((s) => s.addToQueue)
  const removeFromQueue = useMessageQueueStore((s) => s.removeFromQueue)

  // Map backend messages to UI messages
  const mapMessage = useCallback((message: ChatMessage): UIMessage<any> => {
    const parts = (message.parts?.length
      ? message.parts
      : [
          ...(message.images ?? []).map((image) => ({
            type: "data-image",
            data: {
              filename: image.filename,
              url: image.url,
              base64Data: image.base64Data,
              mediaType: image.mediaType,
            },
          })),
          { type: "text", text: message.content },
        ]) as UIMessage<any>["parts"]

    // Keep role as-is - "agent" stays "agent" so MessageRolePolicy.isInitiator() returns true
    const role = message.role as "user" | "assistant" | "agent"

    // Merge all metadata including new agent message fields
    const { messageType, ...restMetadata } = message.metadata || {}
    const mergedMetadata = {
      ...restMetadata,
      // 传递agent消息专用字段
      fromAgentId: message.fromAgentId,
      fromAgentName: message.fromAgentName,
      messageType: message.messageType,
      agentContent: message.content,  // Use content field from backend
      senderAgentId: message.senderAgentId,
      senderAgentName: message.senderAgentName,
    }

    return {
      id: message.id,
      role: role as UIMessage<any>["role"],
      metadata: mergedMetadata,
      parts,
    }
  }, [])

  // Persist messages to backend
  const persistMessages = useCallback((latestMessages: UIMessage<any>[]) => {
    if (!backendConversationId || latestMessages.length === 0) return

    // Backend no longer supports replacing messages
    // Messages are now managed through agent conversations
    console.warn("[useChatInstance] Message persistence disabled - backend endpoint removed")
    setIsPersistingMessages(false)
  }, [backendConversationId])

  // Create Chat instance with appropriate transport and initial messages
  const [chat] = useState(() => {
    const transport = transportConfig?.fromAgentId
      ? new ErgataiChatTransport({
          chatId,
          conversationId: backendConversationId ?? conversation.id,
          agentId: agentId ?? undefined,
          command: conversation.agent.id,
          mode: "agent",
          fromAgentId: transportConfig.fromAgentId,
          targetAgentCommand: transportConfig.targetAgentCommand,
          forceNewSession: transportConfig.forceNewSession,
          correlationId: transportConfig.correlationId,
        })
      : new ErgataiChatTransport({
          chatId,
          conversationId: backendConversationId ?? conversation.id,
          agentId: agentId ?? undefined,
          command: conversation.agent.id,
          mode: "agent",
        })

    return new Chat<any>({
      id: runtimeConversationId,
      messages: conversation.messages.map(mapMessage),
      transport,
      onError: (error) => {
        toast.error(error.message || "Failed to send message")
      },
      onFinish: () => {
        persistMessages(chat.messages)
      },
    })
  })

  const {
    messages,
    sendMessage,
    status,
    stop,
    setMessages,
  } = useChat({
    id: runtimeConversationId,
    chat,
    experimental_throttle: 50,
  })

  const isStreaming = status === "streaming" || status === "submitted"

  // Working state - whether the agent is producing output for THIS conversation
  // Note: This is now fully handled by the Chat status via Transport SSE.
  // No separate subscription needed - the complete rendering channel handles all agent output events.
  const agentWorking = false // Deprecated: kept for API compatibility, always false

  // Sync messages with store
  const syncMessages = useSetAtom(syncMessagesWithStatusAtom)
  const setStreamingStatus = useStreamingStatusStore((store) => store.setStatus)

  useLayoutEffect(() => {
    syncMessages({
      messages,
      status,
      conversationId: runtimeConversationId,
      updateGlobal: false,
    })
  }, [messages, status, runtimeConversationId, syncMessages])

  useEffect(() => {
    setStreamingStatus(runtimeConversationId, status as "ready" | "streaming" | "submitted" | "error")
  }, [runtimeConversationId, status, setStreamingStatus])

  // Cleanup
  useEffect(() => {
    return () => {
      clearConversationRuntimeCaches(runtimeConversationId)
    }
  }, [runtimeConversationId])

  // Send message handler
  const handleSend = useCallback(
    (parts: UIMessage<any>["parts"]) => {
      if (!backendConversationId || !agentId) {
        toast.error("Chat is not bound to a backend agent conversation.")
        return
      }

      if (isStreaming) {
        addToQueue(runtimeConversationId, {
          id: `queue_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`,
          message: parts.find((p) => p.type === "text")?.text || "",
          timestamp: new Date(),
          status: "pending",
        })
      } else {
        void sendMessage({ role: "user", parts })
      }
    },
    [agentId, backendConversationId, isStreaming, addToQueue, runtimeConversationId, sendMessage]
  )

  // Send message on behalf of an agent (agent-to-agent communication)
  const sendAgentMessage = useCallback(
    (parts: UIMessage<any>["parts"]) => {
      if (!backendConversationId || !agentId || !transportConfig?.fromAgentId) {
        toast.error("Agent-to-agent communication not configured.")
        return
      }

      void sendMessage({ role: "agent", parts })
    },
    [backendConversationId, agentId, transportConfig, sendMessage]
  )

  const handleSendFromQueue = useCallback(
    (itemId: string) => {
      const item = queue.find((q) => q.id === itemId)
      if (!item) return
      removeFromQueue(runtimeConversationId, itemId)
      void sendMessage({
        role: "user",
        parts: [{ type: "text", text: item.message }],
      })
    },
    [queue, removeFromQueue, runtimeConversationId, sendMessage]
  )

  return {
    chat,
    messages,
    sendMessage,
    sendAgentMessage,
    status,
    stop,
    setMessages,
    isStreaming,
    agentWorking,
    queue,
    handleSend,
    handleSendFromQueue,
    persistMessages,
  }
}
