import { useEffect, useCallback, useRef } from "react"
import { toast } from "sonner"


import type { Message } from "../stores/message-store"

interface UseForkConversationOptions {
  conversationId: string
  parentChatId: string | null
  isStreaming: boolean
  messages: Message[]
}

export function useForkConversation({
  conversationId: _conversationId,
  parentChatId: _parentChatId,
  isStreaming: _isStreaming,
  messages,

}: UseForkConversationOptions) {
  const isForkingRef = useRef(false)
  // Use ref to access latest messages without recreating callback
  const messagesForForkRef = useRef(messages)
  // react-doctor-disable-next-line no-ref-current-in-render
  messagesForForkRef.current = messages

  const handleForkFromMessage = useCallback(
    async (_messageId: string) => {
      // Backend no longer supports forking conversations
      console.warn("[use-fork-conversation] forkConversation is no longer supported")
      toast.error("Forking conversations is no longer supported")
    },
    [],
  )

  return {
    handleForkFromMessage,
    isForkingRef,
  }
}
