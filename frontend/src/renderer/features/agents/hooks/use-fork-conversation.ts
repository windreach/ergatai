import { useCallback, useRef } from "react"
import { toast } from "sonner"
import { trpcClient } from "../../../lib/trpc"
import { appStore } from "../../../lib/jotai-store"
import {
  conversationModeAtomFamily,
  conversationModelIdAtomFamily,
  conversationCodexModelIdAtomFamily,
  conversationCodexThinkingAtomFamily,
} from "../../../lib/atoms"
import { useAgentConversationStore } from "../stores/conversation-store"

interface UseForkConversationOptions {
  conversationId: string
  parentChatId: string | null
  isStreaming: boolean
  messages: any[]
  utils: any
}

export function useForkConversation({
  conversationId,
  parentChatId,
  isStreaming,
  messages,
  utils,
}: UseForkConversationOptions) {
  const isForkingRef = useRef(false)
  // Use ref to access latest messages without recreating callback
  const messagesForForkRef = useRef(messages)
  messagesForForkRef.current = messages

  const handleForkFromMessage = useCallback(
    async (messageId: string) => {
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
