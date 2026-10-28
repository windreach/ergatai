import { useCallback, useEffect, useLayoutEffect, useState } from "react"
import { Chat, useChat, type UIMessage } from "@ai-sdk/react"
import { useSetAtom } from "jotai"
import { toast } from "sonner"
import { ErgataiChatTransport } from "../lib/ergatai-chat-transport"
import { useMessageQueueStore, EMPTY_QUEUE } from "../stores/message-queue-store"
import { syncMessagesWithStatusAtom } from "../stores/message-store"
import { useStreamingStatusStore } from "../stores/streaming-status-store"
import { clearConversationRuntimeCaches } from "../stores/conversation-runtime-cleanup"
import { trpc } from "@/lib/trpc"
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

  // Message queue
  const queue = useMessageQueueStore((s) => s.queues[runtimeConversationId] ?? EMPTY_QUEUE)
  const addToQueue = useMessageQueueStore((s) => s.addToQueue)
  const removeFromQueue = useMessageQueueStore((s) => s.removeFromQueue)

  // Map backend messages to UI messages
  // UIMessage<any> is used because the AI SDK's UIMessage type is generic over message
  // metadata/extra fields, which vary across different message types (text, images, files, custom parts)
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

  // Intentional no-op: backend owns message persistence via SSE-driven accumulation.
  // Kept as a hook point in case client-side persistence is re-introduced later.
  const noopPersist = useCallback((_latestMessages: UIMessage<any>[]) => {
    if (!backendConversationId || _latestMessages.length === 0) return
    console.debug(
      "[useChatInstance] Skipping client-side replace persistence; backend owns message persistence",
    )
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

    // Chat<any> is used because the AI SDK's Chat type is generic over message shape,
    // and our messages contain heterogeneous parts (text, images, files, custom metadata)
    return new Chat<any>({
      id: runtimeConversationId,
      messages: conversation.messages.map(mapMessage),
      transport,
      onError: (error) => {
        toast.error(error.message || "Failed to send message")
      },
      onFinish: () => {
        noopPersist(chat.messages)
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

  // A side chat can be attached to a backend conversation after the chat
  // snapshot has already loaded. Seed an empty local Chat instance once the
  // persisted messages become available, without overwriting an active turn.
  useEffect(() => {
    if (isStreaming || messages.length > 0 || conversation.messages.length === 0) {
      return
    }
    setMessages(conversation.messages.map(mapMessage))
  }, [conversation.messages, isStreaming, mapMessage, messages.length, setMessages])

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
          parts, // Store full parts array to preserve images/files/other content
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
  // Destructure specific primitive properties to avoid unnecessary re-creation
  // when transportConfig object reference changes
  const fromAgentId = transportConfig?.fromAgentId
  const sendAgentMessage = useCallback(
    (parts: UIMessage<any>["parts"]) => {
      if (!backendConversationId || !agentId || !fromAgentId) {
        toast.error("Agent-to-agent communication not configured.")
        return
      }

      void sendMessage({ role: "agent", parts })
    },
    [backendConversationId, agentId, fromAgentId, sendMessage]
  )

  const handleSendFromQueue = useCallback(
    (itemId: string) => {
      const item = queue.find((q) => q.id === itemId)
      if (!item) return
      removeFromQueue(runtimeConversationId, itemId)
      // Use stored parts if available (preserves images/files), otherwise reconstruct from message string
      const parts = item.parts && item.parts.length > 0
        ? item.parts
        : [{ type: "text", text: item.message }]
      void sendMessage({
        role: "user",
        parts,
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
    queue,
    handleSend,
    handleSendFromQueue,
    noopPersist,
  }
}
