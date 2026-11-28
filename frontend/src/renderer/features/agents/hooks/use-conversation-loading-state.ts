import { useEffect } from "react"
import { useSetAtom } from "jotai"

import { clearLoading, loadingConversationsAtom, setLoading } from "../atoms"

/**
 * Keeps the global sidebar loading indicator in sync with a conversation.
 *
 * Streaming can outlive the chat pane (for example when switching workspaces
 * or when a background tab is evicted). Unmounting a pane is therefore not a
 * terminal event and must not clear the indicator. The transport's finish/error
 * callbacks and explicit stop/close actions own that cleanup.
 */
export function useConversationLoadingState({
  conversationId,
  parentChatId,
  isStreaming,
}: {
  conversationId: string
  parentChatId: string
  isStreaming: boolean
}) {
  const setLoadingConversations = useSetAtom(loadingConversationsAtom)

  useEffect(() => {
    if (!conversationId || !parentChatId) return

    if (isStreaming) {
      setLoading(setLoadingConversations, conversationId, parentChatId)
    } else {
      clearLoading(setLoadingConversations, conversationId)
    }
  }, [conversationId, parentChatId, isStreaming, setLoadingConversations])
}
