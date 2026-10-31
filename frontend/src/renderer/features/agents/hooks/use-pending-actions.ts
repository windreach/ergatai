import { useEffect } from "react"
import { useAtom } from "jotai"
import type { CreateUIMessage, UIMessage } from "@ai-sdk/react"
import {
  pendingPrMessageAtom,
  pendingReviewMessageAtom,
  pendingConflictResolutionMessageAtom,
  pendingAuthRetryMessageAtom,
  isCreatingPrAtom,
} from "../atoms"
import { useAgentConversationStore } from "../stores/conversation-store"
import { getMessageCorrelationService } from "@/features/conversation/runtime/message-correlation-service"

interface UsePendingActionsOptions {
  conversationId: string
  isStreaming: boolean
  sendMessage: (message: CreateUIMessage<UIMessage>) => void
}

export function usePendingActions({
  conversationId,
  isStreaming,
  sendMessage,
}: UsePendingActionsOptions) {
  const [pendingPrMessage, setPendingPrMessage] = useAtom(pendingPrMessageAtom)
  const [pendingReviewMessage, setPendingReviewMessage] = useAtom(
    pendingReviewMessageAtom,
  )
  const [pendingConflictMessage, setPendingConflictMessage] = useAtom(
    pendingConflictResolutionMessageAtom,
  )
  const [pendingAuthRetry, setPendingAuthRetry] = useAtom(pendingAuthRetryMessageAtom)
  const [isCreatingPr, setIsCreatingPr] = useAtom(isCreatingPrAtom)

  const sendCorrelatedMessage = async (
    parts: CreateUIMessage<UIMessage>["parts"],
  ) => {
    const message = await getMessageCorrelationService().createOptimisticMessage({
      role: "user",
      parts: parts as any,
    })
    sendMessage(message as CreateUIMessage<UIMessage>)
  }

  // Watch for pending PR message and send it
  useEffect(() => {
    if (pendingPrMessage?.conversationId === conversationId && !isStreaming) {
      setPendingPrMessage(null)

      void sendCorrelatedMessage([{ type: "text", text: pendingPrMessage.message }])

      setIsCreatingPr(false)

      const store = useAgentConversationStore.getState()
      store.addToOpenConversations(conversationId)
      store.setActiveConversation(conversationId)
    }
  }, [pendingPrMessage, isStreaming, sendMessage, setPendingPrMessage, setIsCreatingPr, conversationId])

  // Watch for pending Review message and send it
  useEffect(() => {
    if (pendingReviewMessage?.conversationId === conversationId && !isStreaming) {
      setPendingReviewMessage(null)

      void sendCorrelatedMessage([{ type: "text", text: pendingReviewMessage.message }])
    }
  }, [pendingReviewMessage, isStreaming, sendMessage, setPendingReviewMessage, conversationId])

  // Watch for pending conflict resolution message and send it
  useEffect(() => {
    if (pendingConflictMessage?.conversationId === conversationId && !isStreaming) {
      setPendingConflictMessage(null)

      void sendCorrelatedMessage([{ type: "text", text: pendingConflictMessage.message }])
    }
  }, [pendingConflictMessage, isStreaming, sendMessage, setPendingConflictMessage, conversationId])

  return {
    isCreatingPr,
    setIsCreatingPr,
    pendingAuthRetry,
    setPendingAuthRetry,
  }
}
