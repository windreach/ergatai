import { useEffect } from "react"
import { useSetAtom } from "jotai"

import { agentChatStore } from "../stores/agent-chat-store"
import { setLoading, clearLoading } from "../atoms"
import { pendingPlanApprovalsAtom } from "../atoms"

export function useActiveChatEffects({
  conversationId,
  isStreaming,
  isRuntimeStreaming,
  messages,
  pendingInitialPrompt,
  setPendingInitialPrompt,
  conversationRuntime,
  setLoadingConversations,
}: {
  conversationId: string
  isStreaming: boolean
  isRuntimeStreaming: boolean
  messages: any[]
  pendingInitialPrompt: any
  setPendingInitialPrompt: (v: any) => void
  conversationRuntime: any
  setLoadingConversations: any
}) {
  useEffect(() => {
    if (
      !pendingInitialPrompt ||
      pendingInitialPrompt.status === "completed" ||
      pendingInitialPrompt.status === "failed"
    ) {
      return
    }

    if (
      isRuntimeStreaming ||
      messages.some((message: any) => message.role === "assistant")
    ) {
      setPendingInitialPrompt(null)
    }
  }, [isRuntimeStreaming, messages, pendingInitialPrompt, setPendingInitialPrompt])

  useEffect(() => {
    const storedParentChatId = agentChatStore.getParentChatId(conversationId)
    if (!storedParentChatId) return

    const isBackendStreaming = conversationRuntime?.status === "streaming"

    if (isStreaming || isBackendStreaming) {
      setLoading(setLoadingConversations, conversationId, storedParentChatId)
    } else {
      clearLoading(setLoadingConversations, conversationId)
    }
  }, [isStreaming, conversationRuntime?.status, conversationId, setLoadingConversations])

  const setPendingPlanApprovals = useSetAtom(pendingPlanApprovalsAtom)

  useEffect(() => {
    return () => {
      setPendingPlanApprovals((prev: Map<string, string>) => {
        if (prev.has(conversationId)) {
          const newMap = new Map(prev)
          newMap.delete(conversationId)
          return newMap
        }
        return prev
      })
    }
  }, [conversationId, setPendingPlanApprovals])
}
